import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ToolImage } from './tool-image';
import { MEMORY_USER } from '../shared/memory';
import { MAX_UPSTREAM_AUDIO_BYTES } from '../shared/audio-limits';
export interface AliyunConfig { appId: string; key: string; workspaceId: string; voiceId?: string; userId?: string }
export class AliyunClient extends EventEmitter {
  socket?: WebSocket; call = ''; dialog = ''; state = 'Disconnected'; ready = false;
  private heartbeat?: NodeJS.Timeout; private silence?: NodeJS.Timeout; private lastAudio = 0;
  private stopping = false;
  private pendingAudioBytes = 0;
  private disconnectReason?: Error;
  async connect(config: AliyunConfig) {
    const userId = config.userId ?? MEMORY_USER;
    if (!userId.trim() || userId.length > 36) throw new Error('用户 ID 应为 1–36 个字符');
    if (this.socket) throw new Error('通话已存在');
    this.call = randomUUID(); this.dialog = ''; this.ready = false; this.stopping = false; this.state = 'Connecting';
    this.pendingAudioBytes = 0; this.disconnectReason = undefined;
    const ws = this.socket = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/inference', { headers: { Authorization: `Bearer ${config.key}` }, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    ws.on('message', (data, binary) => {
      if (this.socket !== ws) return;
      if (binary) { this.emit('audio', Buffer.from(data as Buffer)); return; }
      try {
        const msg = JSON.parse(data.toString()); const o = msg.payload?.output;
        if (msg.header?.event === 'task-failed') { const error = new Error(`阿里云：${msg.header.error_code || 'task-failed'}${msg.header.error_message ? `：${msg.header.error_message}` : ''}`); this.emit('fault', error.message); this.close(error); return; }
        if (!o) return;
        this.diagnostic('received', o.event, o);
        if (o.event === 'Started') this.dialog = o.dialog_id;
        if (o.event === 'DialogStateChanged' && !this.stopping) { this.state = o.state; if (o.state === 'Listening') this.ready = true; }
        this.emit('event', o);
        if (o.event === 'Stopped') ws.close();
      } catch { this.emit('fault', '阿里云消息格式无效'); }
    });
    ws.on('error', () => { this.disconnectReason ??= new Error('阿里云连接失败，请检查网络和凭据'); this.emit('fault', this.disconnectReason.message); });
    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      const error = this.disconnectReason || (!this.stopping ? new Error(`阿里云连接已断开（WebSocket ${code}）${reason.length ? `：${reason.toString().slice(0, 200)}` : ''}`) : undefined);
      this.cleanup(); this.emit('disconnected', error);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('阿里云启动超时')); this.close(); }, 25000);
      const finish = (error?: Error) => { clearTimeout(timer); this.off('event', onEvent); this.off('disconnected', onClose); error ? reject(error) : resolve(); };
      const onEvent = (o: any) => { if (o.event === 'DialogStateChanged' && o.state === 'Listening') finish(); };
      const onClose = () => finish(new Error('阿里云连接关闭'));
      this.on('event', onEvent); this.once('disconnected', onClose);
      ws.once('open', () => {
        if (this.stopping) { ws.terminate(); return; }
        ws.send(JSON.stringify({ header: { action: 'run-task', task_id: this.call, streaming: 'duplex' }, payload: {
          task_group: 'aigc', task: 'multimodal-generation', function: 'generation', model: 'multimodal-dialog',
          input: { directive: 'Start', workspace_id: config.workspaceId, app_id: config.appId },
          parameters: { upstream: { type: 'AudioOnly', mode: 'duplex', sample_rate: 16000 }, downstream: { sample_rate: 24000, format: 'pcm', ...(config.voiceId ? { voice: config.voiceId } : {}) }, client_info: { user_id: userId, device: { uuid: randomUUID() } } }
        } }));
        this.heartbeat = setInterval(() => { if (this.dialog) this.directive('HeartBeat'); }, 15000);
        this.silence = setInterval(() => { if (this.ready && Date.now() - this.lastAudio > 120) this.sendAudio(Buffer.alloc(3200), true); }, 100);
      });
    });
  }
  sendAudio(pcm: Uint8Array, synthetic = false) {
    if (this.stopping || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    if (pcm.byteLength > 6400 || pcm.byteLength % 2) return;
    // WebSocket.bufferedAmount also includes screenshot JSON. Only pending PCM
    // counts toward the audio backlog; an image upload must not hang up a call.
    if (this.pendingAudioBytes + pcm.byteLength > MAX_UPSTREAM_AUDIO_BYTES) {
      const error = new Error('上行音频拥塞，通话已结束'); this.emit('fault', error.message); this.close(error); return;
    }
    const ws = this.socket, bytes = pcm.byteLength;
    this.pendingAudioBytes += bytes;
    ws.send(pcm, error => {
      if (this.socket !== ws) return;
      this.pendingAudioBytes = Math.max(0, this.pendingAudioBytes - bytes);
      if (error && !this.stopping) { const failure = new Error('阿里云音频发送失败'); this.emit('fault', failure.message); this.close(failure); }
    });
    if (!synthetic) this.lastAudio = Date.now();
  }
  directive(directive: string, input: object = {}, parameters?: object) {
    if (this.stopping || this.socket?.readyState !== WebSocket.OPEN) return;
    if (directive === 'Stop') this.stopSending();
    const message = JSON.stringify({ header: { action: directive === 'Stop' ? 'finish-task' : 'continue-task', task_id: this.call, streaming: 'duplex' }, payload: { input: { directive, dialog_id: this.dialog, ...input }, ...(parameters ? { parameters } : {}) } });
    if (Buffer.byteLength(message, 'utf8') >= 256 * 1024) throw new Error('消息或图片过大，未发送。请缩短请求后重试。');
    this.socket.send(message);
    this.diagnostic('sent', directive);
  }
  private diagnostic(direction: 'received' | 'sent', event: string, output: any = {}) {
    if (!['Started', 'Stopped', 'SpeechStarted', 'SpeechEnded', 'SpeechContent', 'RespondingStarted', 'RespondingContent', 'RespondingEnded',
      'DialogStateChanged', 'RequestAccepted', 'Error', 'RequestToRespond', 'RequestToSpeak', 'LocalRespondingStarted', 'LocalRespondingEnded', 'Stop'].includes(event)) return;
    if (event === 'SpeechContent' && !output.finished) return;
    // Only protocol metadata, never prompts, tool payloads, credentials or media.
    try { this.emit('diagnostic', { direction, event, callId: this.call, dialogId: output.dialog_id || this.dialog,
      roundId: output.round_id, llmRequestId: output.llm_request_id, state: output.state,
      finished: output.finished, finishReason: output.finish_reason, textLength: output.text?.length, spokenLength: output.spoken?.length,
      errorCode: output.error_code, errorName: output.error_name }); } catch { /* Diagnostics must not affect transport. */ }
  }
  respond(text: string, results?: object[], type: 'prompt' | 'transcript' = 'prompt', images?: ToolImage[]) {
    this.directive('RequestToRespond', { type, text }, results || images?.length ? {
      ...(results ? { biz_params: { command_results: results } } : {}),
      ...(images?.length ? { images } : {}),
    } : undefined);
  }
  async stop() {
    const ws = this.socket; if (!ws) return;
    const closed = new Promise<void>(resolve => { const t = setTimeout(() => { ws.terminate(); resolve(); }, 1800); ws.once('close', () => { clearTimeout(t); resolve(); }); });
    if (ws.readyState === WebSocket.OPEN && this.dialog) this.directive('Stop');
    else this.close();
    await closed;
    if (this.socket === ws) this.cleanup();
  }
  private stopSending() { this.stopping = true; this.ready = false; clearInterval(this.heartbeat); clearInterval(this.silence); }
  close(reason?: Error) { this.disconnectReason ??= reason; this.stopSending(); this.socket?.terminate(); }
  private cleanup() { this.stopSending(); this.socket = undefined; this.pendingAudioBytes = 0; this.state = 'Disconnected'; }
}
