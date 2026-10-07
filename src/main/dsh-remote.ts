import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
// Reviewed against the generated Typert Remote descriptors in 0.1.5-alpha.1.
export const DSH_VERSION = '0.1.5-alpha.1';
const noArguments = new Set(['session/control', 'session/modelCatalog']);
export class DshRemote extends EventEmitter {
  socket?: WebSocket; cookie = ''; clientId = ''; home = ''; generation = 0;
  readonly pendingPermissions = new Map<string, any>();
  private streams = new Map<string, { next: (v: any) => void; fail: (e: Error) => void }>();
  private ping?: NodeJS.Timeout;
  constructor(readonly base: string) { super(); const u = new URL(base); if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.protocol !== 'http:') throw new Error('dsh 仅支持本机 loopback HTTP'); }
  async authenticate(launchUrl: string) {
    const u = new URL(launchUrl); if (u.origin !== this.base) throw new Error('dsh Host 地址不匹配');
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (r.status !== 303) throw Object.assign(new Error('dsh Host 身份或 token 不匹配'), { code: 'DSH_AUTH' });
    this.cookie = r.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
    if (!this.cookie) throw Object.assign(new Error('dsh 未返回认证 cookie'), { code: 'DSH_AUTH' });
  }
  private args(endpoint: string, request?: object) { return noArguments.has(endpoint) || endpoint === '$events' ? {} : endpoint === 'session/list' ? { _request: request || {} } : endpoint === '$events/result' ? request : { request: request || {} }; }
  async call(endpoint: string, request?: object): Promise<any> {
    const rpcId = randomUUID();
    const r = await fetch(`${this.base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: this.base, Cookie: this.cookie }, body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: this.args(endpoint, request) } }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`dsh HTTP ${r.status}`);
    const j: any = await r.json(); if (j.type !== 'server-response' || j.rpcId !== rpcId) throw new Error('dsh RPC 响应身份无效');
    if (!j.result?.ok) throw Object.assign(new Error(j.result?.error?.message || 'dsh 请求失败'), { code: j.result?.error?.code });
    return j.result.value;
  }
  async connect() {
    this.close(); const gen = ++this.generation;
    const ws = this.socket = new WebSocket(`${this.base.replace('http:', 'ws:')}/api/remote.mux`, { headers: { Cookie: this.cookie, Origin: this.base }, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 });
    ws.on('message', data => {
      if (gen !== this.generation) return;
      try { const m = JSON.parse(data.toString()), stream = this.streams.get(m.streamId); if (!stream) return;
        if (m.type === 'item') stream.next(m.value);
        else { stream.fail(new Error(m.error?.message || 'dsh 事件流已结束')); this.streams.delete(m.streamId); }
      } catch { this.emit('fault', 'dsh 事件格式无效'); }
    });
    ws.on('error', () => this.emit('fault', 'dsh Remote 连接失败'));
    ws.on('close', () => { if (gen !== this.generation) return; clearInterval(this.ping); this.clientId = ''; for (const s of this.streams.values()) s.fail(new Error('dsh Remote 已断开')); this.streams.clear(); this.emit('disconnected'); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    this.ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 15000);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dsh Host 事件未就绪')), 10000);
      this.subscribe('$events', undefined, frame => {
        if (frame.type === 'ready') {
          clearTimeout(timer);
          if (typeof frame.clientId !== 'string' || !frame.clientId || typeof frame.host?.home !== 'string' || !frame.host.home) { reject(new Error('dsh ready 响应无效')); return; }
          this.clientId = frame.clientId; this.home = frame.host.home; this.emit('ready', frame.host); resolve();
        }
        else if (frame.type === 'waterfall') {
          // Do not resolve this waterfall. A Web UI joining later must still be
          // able to receive and answer the pending question. `next` would settle
          // it immediately when Soul is the only connected client.
          this.pendingPermissions.set(frame.eventId, frame); this.emit('permission', frame);
        } else if (frame.type === 'cancel') { this.pendingPermissions.delete(frame.eventId); this.emit('permission-end', frame); }
        else if (frame.type === 'emit') this.emit('host-event', frame.event, frame.args);
      }, e => { clearTimeout(timer); reject(e); });
    });
  }
  subscribe(endpoint: string, request: object | undefined, next: (v: any) => void, fail: (e: Error) => void = () => {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('dsh 尚未连接');
    const streamId = randomUUID(); this.streams.set(streamId, { next, fail });
    this.socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: this.args(endpoint, request) } }));
    return () => { this.streams.delete(streamId); if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId })); };
  }
  close() { this.generation++; clearInterval(this.ping); for (const stream of this.streams.values()) stream.fail(new Error('dsh Remote 已关闭')); this.streams.clear(); this.pendingPermissions.clear(); this.socket?.terminate(); this.socket = undefined; this.clientId = ''; }
}
