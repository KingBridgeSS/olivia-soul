import type { TaskStatus, TaskView } from '../shared/types';
import { createHash } from 'node:crypto';
export const contentHash = (content: any[]) => createHash('sha256').update(JSON.stringify(content)).digest('hex');
export const active = (s: TaskStatus) => ['running', 'waiting_permission', 'cancelling', 'unknown'].includes(s);
export interface TaskRun {
  requestId: string; commandKey: string; goal: string; context: string; created: number; promptHash: string;
  status: TaskStatus; consumed: boolean; turn?: number; endReason?: string; response: string;
  manual: boolean; cancelRequested: boolean; reported: boolean;
}
export interface TaskRecord extends TaskView {
  call: string; sessionId: string; host: string; cwd: string; created: number; seq: number;
  currentTurn?: number; running?: boolean; runs: TaskRun[];
  queue: { id: string; rpcId?: string; edited?: boolean }[]; jobs: { id: string; status: string }[];
}
export function foldEvent(t: TaskRecord, e: any) {
  if (e.seq <= t.seq) return;
  t.seq = e.seq;
  if (t.status === 'waiting_permission' && ['tool/result', 'assistant/message', 'request/context'].includes(e.type)) {
    t.status = 'running'; t.detail = '交互已处理，正在继续执行';
  }
  if (e.type === 'turn/start') t.currentTurn = e.data.turn;
  if (e.type === 'user/message') {
    const run = t.runs.find(v => v.requestId === e.data.source?.rpcId);
    if (run) {
      run.consumed = true; run.turn = t.currentTurn;
      if (contentHash(e.data.content || []) !== run.promptHash) run.manual = t.manual = true;
    } else if (e.data.source?.kind === 'user' && e.time >= t.created) {
      t.manual = true;
      for (const r of t.runs.filter(r => active(r.status))) r.manual = true;
    }
  }
  const runs = t.runs.filter(r => r.consumed && r.turn === e.data.turn && active(r.status));
  if (e.type === 'assistant/message') {
    const text = e.data.message?.content?.filter((v: any) => v.type === 'text').map((v: any) => v.text).join('\n');
    for (const r of runs) if (text && !r.manual) r.response = text.slice(0, 12000);
  }
  if (e.type === 'turn/end') for (const r of runs) r.endReason = e.data.reason?.kind || 'unknown';
  settle(t);
}
export function setQueue(t: TaskRecord, queue: any[]) {
  t.queue = queue.map(v => {
    const r = t.runs.find(r => r.requestId === v.rpcId);
    return { id: v.id, rpcId: v.rpcId, edited: !!(r && v.message?.content && contentHash(v.message.content) !== r.promptHash) };
  });
  for (const item of t.queue) {
    const r = t.runs.find(r => r.requestId === item.rpcId);
    if (item.edited && r) r.manual = true;
    if (item.edited || item.rpcId && !r) t.manual = true;
  }
  settle(t);
}
export function settle(t: TaskRecord) {
  const idle = t.running === false && !t.jobs.some(j => ['running', 'stopping'].includes(j.status));
  if (idle) for (const r of t.runs.filter(r => active(r.status))) {
    if (t.queue.some(q => q.rpcId === r.requestId)) continue;
    if (r.cancelRequested && (!r.consumed || r.endReason)) r.status = 'cancelled';
    else if (r.consumed && r.endReason) {
      r.status = r.manual ? 'failed' : r.endReason === 'completed' ? 'completed' : ['cancelled', 'aborted'].includes(r.endReason) ? 'cancelled' : 'failed';
      if (r.manual) r.response = '原请求已在 dsh 中由人工修改或接手，无法确认原目标的执行结果。';
    }
  }
  const pending = t.runs.filter(r => active(r.status));
  if (pending.length) {
    t.status = pending.some(r => r.cancelRequested) ? 'cancelling' : pending.some(r => r.status === 'unknown' || r.manual) ? 'unknown' : t.status === 'waiting_permission' ? 'waiting_permission' : 'running';
    t.detail = t.status === 'unknown' ? '执行状态需要在 dsh 中核对；不会自动重发' : t.status === 'cancelling' ? '正在取消任务' : t.status === 'waiting_permission' ? '需要在 dsh 中回答问题或处理权限请求' : `后台执行中，尚有 ${pending.length} 项请求`;
  } else if (t.runs.length) {
    const last = t.runs.at(-1)!;
    t.status = last.status;
    t.detail = last.status === 'completed' ? last.response || '执行轮次已结束，请在 dsh 中查看结果' : last.status === 'cancelled' ? '任务已停止；已执行的操作不会撤销' : last.response || `任务结束：${last.endReason || last.status}`;
  }
}
export function queueItemsToRemove(t: TaskRecord) {
  return t.queue.filter(q => t.runs.some(r => r.requestId === q.rpcId) && !q.edited).map(q => q.id);
}
