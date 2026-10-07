import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// A protocol fixture, not a dsh process. Tests own and close this server.
export async function dshServer(mode: 'ok' | 'html' | 'bad-ready' | 'bad-list' = 'ok', autoComplete = true) {
  const token = randomUUID(), calls: string[] = [];
  const sessions = new Map<string, { sessionId: string; cwd: string; running: boolean }>();
  const follows = new Map<string, { ws: WebSocket; streamId: string }[]>();
  const hostStreams = new Map<WebSocket, string>();
  const permissions = new Map<string, any>();
  const prompts: any[] = [], pending = new Map<string, any[]>(), histories = new Map<string, any[]>();
  const controls = new Map<WebSocket, string>();
  let authCount = 0, connectionCount = 0;
  const send = (ws: WebSocket, streamId: string, value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'item', streamId, value })); };
  const queue = (id: string) => (pending.get(id) || []).map(r => ({ id: r.requestId, rpcId: r.requestId, message: { content: r.content } }));
  function publishQueue(id: string) { for (const [ws, streamId] of controls) send(ws, streamId, { type: 'queue', sessionId: id, items: queue(id) }); }
  function status(id: string, running: boolean) {
    sessions.get(id)!.running = running;
    for (const [ws, streamId] of hostStreams) send(ws, streamId, { type: 'emit', event: 'api-session/status', args: [id, running] });
  }
  function completeNext(id: string, text = 'DSH_EXTERNAL_OK') {
    const request = pending.get(id)?.shift(); if (!request) return;
    publishQueue(id);
    const history = histories.get(id) || [], turn = history.length + 1;
    const events = [
      { type: 'turn/start', data: { turn } },
      { type: 'user/message', data: { source: { kind: 'user', rpcId: request.requestId }, content: request.content } },
      { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
    ];
    for (const event of events) {
      const record = { type: 'event', event: { ...event, seq: history.length, time: Date.now() } }; history.push(record);
      for (const stream of follows.get(id) || []) send(stream.ws, stream.streamId, record);
    }
    histories.set(id, history); status(id, !!pending.get(id)?.length);
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>unrelated application</html>'); return; }
    if (url.pathname === '/') {
      authCount++;
      if (url.searchParams.get('token') !== token) { res.writeHead(401); res.end(); return; }
      res.writeHead(303, { Location: '/', 'Set-Cookie': 'dsh-test=authorized; HttpOnly; Path=/' }); res.end(); return;
    }
    if (req.headers.cookie !== 'dsh-test=authorized') { res.writeHead(401); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body), method = url.pathname.slice('/api/'.length), request = rpc.payload.args.request;
    calls.push(method);
    let value: any = {};
    if (method === 'session/list') value = mode === 'bad-list' ? { unexpected: true } : { items: [...sessions.values()] };
    if (method === 'session/create') {
      const sessionId = randomUUID(); sessions.set(sessionId, { sessionId, cwd: request.cwd, running: false }); value = { sessionId };
    }
    if (method === 'session/prompt') {
      prompts.push(request); pending.set(request.sessionId, [...pending.get(request.sessionId) || [], request]);
      status(request.sessionId, true); publishQueue(request.sessionId);
      if (autoComplete) setTimeout(() => completeNext(request.sessionId), 30);
    }
    if (method === 'session/updateQueue') { pending.set(request.sessionId, (pending.get(request.sessionId) || []).filter(r => r.requestId !== request.itemId)); publishQueue(request.sessionId); }
    if (method === 'session/cancel') status(request.sessionId, false);
    if (method === 'session/page') value = { records: (histories.get(request.address.sessionId) || []).filter(r => r.event.seq < request.beforeSeq), hasMore: false };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/remote.mux' || req.headers.cookie !== 'dsh-test=authorized') { socket.destroy(); return; }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    connectionCount++;
    ws.on('close', () => { hostStreams.delete(ws); controls.delete(ws); });
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'cancel') {
        for (const [id, streams] of follows) follows.set(id, streams.filter(s => s.ws !== ws || s.streamId !== frame.streamId));
        if (controls.get(ws) === frame.streamId) controls.delete(ws);
        return;
      }
      if (frame.type !== 'open') return;
      if (frame.endpoint === '$events') {
        hostStreams.set(ws, frame.streamId); send(ws, frame.streamId, mode === 'bad-ready' ? { type: 'ready', clientId: 5 } : { type: 'ready', clientId: randomUUID(), host: { home: 'C:\\test-dsh-home' } });
        for (const pending of permissions.values()) send(ws, frame.streamId, pending);
      }
      if (frame.endpoint === 'session/control') { controls.set(ws, frame.streamId); send(ws, frame.streamId, { type: 'baseline', value: { queues: Object.fromEntries([...sessions.keys()].map(id => [id, queue(id)])), jobs: {} } }); }
      if (frame.endpoint === 'session/follow') {
        const id = frame.payload.args.request.address.sessionId;
        follows.set(id, [...follows.get(id) || [], { ws, streamId: frame.streamId }]);
        send(ws, frame.streamId, { type: 'snapshot', records: histories.get(id) || [], hasMore: false, cursor: (histories.get(id)?.length || 0) - 1 });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const base = `http://127.0.0.1:${port}`, url = `${base}/?token=${token}`;
  return {
    url, base, token, calls, sessions, permissions, prompts, completeNext,
    get authCount() { return authCount; }, get connectionCount() { return connectionCount; },
    dropConnections() { for (const ws of sockets.clients) ws.terminate(); },
    async close() { for (const ws of sockets.clients) ws.terminate(); sockets.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}
