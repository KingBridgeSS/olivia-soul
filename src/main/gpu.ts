import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
export class GpuClient extends EventEmitter {
  socket?: WebSocket; ready = false; generation = 0;
  async connect(base: string) {
    this.close();
    const u = new URL('/stream', base); u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = this.socket = new WebSocket(u, { handshakeTimeout: 3000, maxPayload: 2 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      let connected = false;
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('数字人连接超时')); }, 3500);
      const fail = () => { clearTimeout(timer); reject(new Error('数字人不可用')); };
      ws.on('error', fail);
      ws.on('close', () => {
        fail();
        if (ws === this.socket) { this.socket = undefined; this.ready = false; if (connected) this.emit('fallback', 'connection-closed'); }
      });
      ws.on('message', (data, binary) => {
        if (ws !== this.socket) return;
        if (binary) { const b = Buffer.from(data as Buffer); if (b.length > 8 && b.readUInt32LE(0) === this.generation) this.emit('frame', { generation: this.generation, index: b.readUInt32LE(4), data: b.subarray(8) }); return; }
        try { const m = JSON.parse(data.toString()); if (m.type === 'ready') { connected = true; this.ready = true; clearTimeout(timer); resolve(); } else if (m.type === 'unavailable') { this.close(); fail(); } } catch { this.close(); fail(); }
      });
    });
  }
  private send(m: object) { if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(m)); }
  begin(generation: number) { this.generation = generation; this.send({ type: 'begin', generation }); }
  audio(data: Uint8Array) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount + data.byteLength > 48000 * 5) { this.close(); this.emit('fallback', 'upload-backlog'); return; }
    const packet = Buffer.allocUnsafe(data.byteLength + 4); packet.writeUInt32LE(this.generation, 0); packet.set(data, 4); this.socket.send(packet);
  }
  end() { this.send({ type: 'end', generation: this.generation }); }
  progress(samples: number) { this.send({ type: 'progress', generation: this.generation, samples }); }
  interrupt() { this.send({ type: 'interrupt' }); }
  close() { const ws = this.socket; this.socket = undefined; this.ready = false; ws?.terminate(); }
}
