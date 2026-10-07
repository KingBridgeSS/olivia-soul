import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ComputerCommand, Preferences } from '../shared/types';
import { DshHost } from './dsh-host';
import { DshRemote } from './dsh-remote';
import { active, foldEvent, setQueue, settle, queueItemsToRemove, contentHash, type TaskRecord, type TaskRun } from './task-state';
export interface CommandOutcome { success: boolean; text: string; retryable?: boolean; image?: import('./tool-image').ToolImage }
export class Tasks extends EventEmitter {
  records: TaskRecord[] = [];
  private remote?: DshRemote;
  private release: (() => void)[] = [];
  private follows = new Map<string, () => void>();
  private retry?: NodeJS.Timeout;
  private attaching?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private results = new Map<string, CommandOutcome>();
  private call = '';
  private closing = false;
  private ending?: Promise<void>;
  constructor(readonly host: DshHost, private preferences: () => Preferences) { super(); }
  private needsCancellation(t: TaskRecord) { return active(t.status) || t.running === true || t.queue.some(q => t.runs.some(r => r.requestId === q.rpcId)) || t.jobs.some(j => ['running', 'stopping'].includes(j.status)); }
  get hasActive() { return this.records.some(t => this.needsCancellation(t)); }
  beginCall(call: string) {
    if (this.call || this.ending || this.records.length) throw new Error('上次通话的任务尚未清理');
    this.call = call;
  }
  private changed(t: TaskRecord, fn: () => void) {
    if (!this.records.includes(t)) return;
    fn(); this.emit('change', t);
    for (const run of t.runs) if (!active(run.status) && !run.reported) {
      run.reported = true;
      if (this.call === t.call) this.emit('finished', t, { ...run });
    }
  }
  private owned(id: string) { return this.records.find(t => t.sessionId === id && t.host === this.host.identity); }
  async ensure() {
    const r = await this.host.ensure();
    if (r === this.remote) return this.attaching;
    this.remote = r;
    this.attaching = this.attach(r).catch(e => {
      if (this.remote === r) { this.detach(); this.remote = undefined; r.close(); }
      throw e;
    }).finally(() => { this.attaching = undefined; });
    return this.attaching;
  }
  private detach() {
    this.release.splice(0).forEach(f => f());
    for (const f of this.follows.values()) f();
    this.follows.clear();
  }
  private async attach(r: DshRemote) {
    this.detach();
    const hostEvent = (event: string, args: any[]) => {
      if (r !== this.remote) return;
      const t = this.owned(args?.[0]); if (!t) return;
      if (event === 'api-session/status') this.changed(t, () => { t.running = args[1]; settle(t); });
      if (event === 'api-session/error') this.changed(t, () => {
        for (const run of t.runs.filter(v => active(v.status))) { run.status = 'failed'; run.response = String(args[1]).slice(0, 500); }
        settle(t);
      });
    };
    const permission = (f: any) => {
      const t = this.owned(f.agentId); if (!t || r !== this.remote) return;
      this.changed(t, () => { t.status = 'waiting_permission'; t.detail = '需要在 dsh 中回答问题或处理权限请求'; });
    };
    const disconnected = () => {
      if (r !== this.remote || this.closing) return;
      for (const t of this.records.filter(t => active(t.status))) this.changed(t, () => {
        t.running = undefined;
        for (const run of t.runs.filter(v => active(v.status))) run.status = 'unknown';
        settle(t);
      });
      this.remote = undefined;
      this.emit('connection-error', 'dsh 连接中断：正在重连；任务可能仍在执行，不会自动重发。');
      const reconnect = () => { if (!this.closing) void this.ensure().catch(() => { this.retry = setTimeout(reconnect, 5000); }); };
      this.retry = setTimeout(reconnect, 2000);
    };
    r.on('host-event', hostEvent); r.on('permission', permission); r.on('disconnected', disconnected);
    this.release.push(() => { r.off('host-event', hostEvent); r.off('permission', permission); r.off('disconnected', disconnected); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dsh control 基线超时')), 10000);
      this.release.push(r.subscribe('session/control', undefined, f => {
        if (r !== this.remote) return;
        if (f.type === 'baseline') {
          for (const t of this.records.filter(t => t.host === this.host.identity)) {
            // Do not settle against the previous connection's running value.
            t.running = undefined; setQueue(t, f.value.queues[t.sessionId] || []); t.jobs = f.value.jobs[t.sessionId] || [];
          }
          clearTimeout(timer); resolve();
        } else if (f.type === 'queue' || f.type === 'jobs') {
          const t = this.owned(f.sessionId); if (!t) return;
          this.changed(t, () => { if (f.type === 'queue') setQueue(t, f.items); else { t.jobs = f.jobs; settle(t); } });
        }
      }, e => { clearTimeout(timer); reject(e); }));
    });
    const list = await r.call('session/list', {});
    for (const t of this.records.filter(t => t.host === this.host.identity)) {
      t.running = list.items.find((v: any) => v.sessionId === t.sessionId)?.running;
      await this.follow(t, r);
      this.changed(t, () => {
        for (const run of t.runs) if (run.status === 'unknown' && !run.manual && (run.consumed || t.queue.some(q => q.rpcId === run.requestId))) run.status = 'running';
        settle(t);
      });
    }
    for (const frame of r.pendingPermissions.values()) permission(frame);
    this.emit('connection-restored');
  }
  private async follow(t: TaskRecord, r: DshRemote) {
    if (this.follows.has(t.id)) return;
    await new Promise<void>((resolve, reject) => {
      let snapshot = false; const pending: any[] = [];
      const timer = setTimeout(() => reject(new Error('dsh history 基线超时')), 15000);
      const fail = (e: Error) => { clearTimeout(timer); reject(e); };
      this.follows.set(t.id, r.subscribe('session/follow', { address: { kind: 'session', sessionId: t.sessionId }, maxMessages: 20 }, f => {
        if (r !== this.remote || !this.records.includes(t)) return;
        if (f.type === 'snapshot') {
          void (async () => {
            let entries = f.records, more = f.hasMore;
            while (more && entries.length && entries[0].event.seq > t.seq + 1) {
              const page = await r.call('session/page', { address: { kind: 'session', sessionId: t.sessionId }, throughSeq: f.cursor, beforeSeq: entries[0].event.seq, maxMessages: 40 });
              if (!page.records?.length) break;
              entries = [...page.records, ...entries]; more = page.hasMore;
            }
            if (r !== this.remote) throw new Error('dsh 连接已更换');
            this.changed(t, () => { for (const v of [...entries, ...pending]) if (v.type === 'event') foldEvent(t, v.event); });
            snapshot = true; clearTimeout(timer); resolve();
          })().catch(fail);
        } else if (f.type === 'event') {
          if (!snapshot) { if (pending.length > 10000) { fail(new Error('dsh 恢复事件过多')); return; } pending.push(f); }
          else this.changed(t, () => foldEvent(t, f.event));
        }
      }, fail));
    });
  }
  execute(c: ComputerCommand, call: string, signal?: AbortSignal): Promise<CommandOutcome> {
    const job = this.serial.then(async () => {
      if (!call || call !== this.call || this.closing) return { success: false, text: '通话已结束' };
      const key = `${call}:${c.id}`;
      if (this.results.has(key)) return this.results.get(key)!;
      if (signal?.aborted) return { success: false, text: '本次请求已停止，此指令未执行' };
      const result = await this.perform(c, call, key, signal).catch((e: Error) => ({ success: false, text: e.message }));
      this.results.set(key, result); return result;
    });
    this.serial = job.catch(() => {}); return job;
  }
  private async perform(c: ComputerCommand, call: string, key: string, signal?: AbortSignal): Promise<CommandOutcome> {
    const ok = (v: unknown) => ({ success: true, text: JSON.stringify(v) });
    if (c.name === 'list_tasks') return ok(this.records.map(t => ({ task_id: t.id, title: t.title, status: t.status })));
    let t = this.records.find(t => t.id === c.taskId);
    if ((c.name === 'get_task' || c.action !== 'start') && !t) return { success: false, text: '本次通话没有该 task_id，请先调用 list_tasks', retryable: true };
    if (c.name === 'get_task') return ok({ task_id: t!.id, title: t!.title, status: t!.status, detail: t!.detail, requests: t!.runs.map(r => ({ goal: r.goal, context: r.context, status: r.status, result: r.response })) });
    if (c.action === 'cancel') { await this.cancel(t!.id); return ok({ task_id: t!.id, status: t!.status, detail: t!.detail }); }
    await this.ensure(); const r = this.remote!;
    if (call !== this.call) return { success: false, text: '通话已结束' };
    signal?.throwIfAborted();
    if (c.action === 'start') {
      const { sessionId } = await r.call('session/create', { cwd: this.preferences().dshCwd });
      t = { id: randomUUID(), call, sessionId, host: this.host.identity, cwd: this.preferences().dshCwd, created: Date.now(), seq: -1, title: c.goal.slice(0, 80), status: 'running', detail: '正在登记任务', manual: false, runs: [], queue: [], jobs: [], running: false };
      this.records.push(t); this.emit('change', t);
      try { await r.call('session/rename', { sessionId, title: `[Soul] ${t.title}` }); await this.follow(t, r); }
      catch (e) { t.status = 'failed'; t.detail = '任务初始化失败，尚未提交执行'; this.emit('change', t); throw e; }
    }
    t = t!;
    if (call !== this.call) return { success: false, text: '通话已结束' };
    if (signal?.aborted) {
      if (c.action === 'start') this.changed(t, () => { t.status = 'cancelled'; t.detail = '用户已发起新请求，未提交执行'; });
      return { success: false, text: '本次请求已停止，此指令未执行' };
    }
    if (t.host !== this.host.identity) return { success: false, text: '任务属于不同的 dsh Host' };
    if (t.status === 'cancelling') return { success: false, text: '任务正在取消，请等待结束后再继续' };
    if (t.manual && (t.running || t.queue.length)) return { success: false, text: '任务已在 dsh 中人工接手，请先在 dsh 中处理完当前输入' };
    const content = [{ type: 'text', text: `${c.goal}${c.context ? `\n必要上下文和约束：${c.context}` : ''}\n请核对实际结果后简洁汇报。需要用户决定的问题请通过 dsh 的交互工具询问。` }];
    const run: TaskRun = { requestId: randomUUID(), commandKey: key, goal: c.goal, context: c.context, created: Date.now(), promptHash: contentHash(content), status: 'running', consumed: false, response: '', manual: false, cancelRequested: false, reported: false };
    t.runs.push(run); t.manual = false; t.status = 'running'; t.detail = '正在提交请求'; this.emit('change', t);
    try {
      await r.call('session/prompt', { sessionId: t.sessionId, requestId: run.requestId, mode: 'queue', clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, content });
      this.changed(t, () => settle(t));
      return ok({ task_id: t.id, accepted: true, message: '请求已接收，已加入后台执行队列。这只表示提交成功，不表示任务完成；执行结束后会另行汇报。' });
    } catch {
      this.changed(t, () => { if (!run.consumed) run.status = 'unknown'; settle(t); });
      return { success: false, text: JSON.stringify({ task_id: t.id, message: '提交结果未能确认，请查询任务状态；不会自动重发' }) };
    }
  }
  async cancel(id: string) {
    const t = this.records.find(t => t.id === id);
    if (!t) throw new Error('本次通话没有该任务');
    if (!this.needsCancellation(t)) return;
    await this.ensure();
    if (t.host !== this.host.identity) throw new Error('当前 Host 与任务归属不符');
    this.changed(t, () => {
      for (const run of t.runs.filter(r => active(r.status))) run.cancelRequested = true;
      t.status = 'cancelling'; t.detail = '正在取消任务';
    });
    for (const itemId of queueItemsToRemove(t)) {
      try { await this.remote!.call('session/updateQueue', { sessionId: t.sessionId, itemId, action: { kind: 'remove' } }); }
      catch (e: any) { if (e.code !== 'session/queue-item-not-found') throw e; }
    }
    await this.remote!.call('session/cancel', { sessionId: t.sessionId });
    this.changed(t, () => { settle(t); if (!t.runs.length && t.running === false) { t.status = 'cancelled'; t.detail = '任务已取消'; } });
    const until = Date.now() + 8000;
    while (this.needsCancellation(t) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 100));
    if (this.needsCancellation(t)) throw new Error(`任务 ${t.title} 的取消尚未确认，请在 dsh 中查看`);
  }
  endCall(): Promise<void> {
    if (this.ending) return this.ending;
    this.call = ''; // Prevent in-flight creation from submitting after hangup.
    this.ending = (async () => {
      await this.serial;
      const outcomes = await Promise.allSettled(this.records.filter(t => this.needsCancellation(t)).map(t => this.cancel(t.id)));
      for (const f of this.follows.values()) f();
      this.follows.clear(); this.records = []; this.results.clear(); this.emit('change');
      const failures = outcomes.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length) throw new Error(`有 ${failures.length} 个任务取消未确认，请在 dsh 中查看。`);
    })().finally(() => { this.ending = undefined; });
    return this.ending;
  }
  async shutdown() {
    this.closing = true; clearTimeout(this.retry);
    try { await this.endCall(); }
    finally { this.detach(); this.host.disconnect(); }
  }
}
