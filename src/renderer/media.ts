import type { Media, Playback, Preferences } from '../shared/types';
import { FRAME_SAMPLES, MAX_VIDEO_FRAMES } from '../shared/video-limits';
import type { AvatarView } from './avatar';
export class MediaEngine {
  private context?: AudioContext; private player?: AudioWorkletNode; private capture?: AudioWorkletNode; private microphone?: MediaStream;
  private gain?: GainNode; private identity = { call: '', generation: 0 }; private video = false;
  private frames: { index: number; bitmap: ImageBitmap }[] = []; private decode: { index: number; data: Uint8Array; revision: number }[] = [];
  private decoding = false; private revision = 0; private samples = 0; private firstAudioAt = 0; private lastProgress = 0; private began = false; private ended = false;
  private timer?: ReturnType<typeof setInterval>; private can: CanvasRenderingContext2D;
  constructor(private canvas: HTMLCanvasElement, private fallbackImage: HTMLElement, private fault: (s: string) => void, private avatar?: AvatarView) { this.can = canvas.getContext('2d')!; }
  async start(p: Preferences, microphone = true) {
    await this.stop();
    const context = this.context = new AudioContext({ latencyHint: 'interactive' });
    await context.audioWorklet.addModule(new URL('./audio-worklet.js', location.href));
    this.player = new AudioWorkletNode(context, 'soul-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.gain = context.createGain(); this.gain.gain.value = p.speakerMuted ? 0 : 1; this.player.connect(this.gain).connect(context.destination);
    this.player.port.onmessage = e => {
      const m = e.data; if (m.call !== this.identity.call || m.generation !== this.identity.generation) return;
      if (m.samples !== this.samples) { this.samples = m.samples; this.lastProgress = performance.now(); }
      if (m.type === 'started') this.began = true;
      if (m.type === 'ended') { this.ended = true; this.showStatic(); }
      if (m.type === 'overflow') this.fault('回复音频缓存已满，已中止本次播放');
      window.soul.playback(m as Playback); this.draw();
    };
    if (microphone) {
      try {
        this.microphone = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: p.inputDevice ? { exact: p.inputDevice } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
        this.capture = new AudioWorkletNode(context, 'soul-capture');
        const zero = context.createGain(); zero.gain.value = 0;
        context.createMediaStreamSource(this.microphone).connect(this.capture).connect(zero).connect(context.destination);
        this.capture.port.onmessage = e => window.soul.audio(e.data.data, e.data.speaking);
      } catch { await this.stop(); throw new Error('无法打开麦克风，请检查 Windows 麦克风权限或输入设备'); }
    }
    await this.preferences(p); await context.resume();
    this.timer = setInterval(() => {
      if (!this.video || !this.firstAudioAt || this.ended) return;
      const now = performance.now();
      if (!this.began && now - this.firstAudioAt > 6000) this.fallback(true, 'first-frame-timeout');
      else if (this.began && now - this.lastProgress > 2500) this.fallback(true, 'video-stall');
    }, 100);
  }
  async preferences(p: Preferences) {
    if (this.gain) this.gain.gain.value = p.speakerMuted ? 0 : 1;
    this.microphone?.getAudioTracks().forEach(t => { t.enabled = !p.micMuted; }); this.capture?.port.postMessage({ muted: p.micMuted });
    if (this.context && 'setSinkId' in this.context) { try { await (this.context as any).setSinkId(p.outputDevice || ''); } catch { this.fault('无法切换扬声器设备'); } }
  }
  receive(m: Media) {
    if (m.type === 'begin' || m.type === 'interrupt') {
      this.clear(); this.identity = { call: m.call, generation: m.generation }; this.video = m.type === 'begin' && m.video;
      this.player?.port.postMessage(m); return;
    }
    if (m.call !== this.identity.call || m.generation !== this.identity.generation) return;
    if (m.type === 'audio') {
      if (!this.firstAudioAt) { this.firstAudioAt = performance.now(); this.lastProgress = this.firstAudioAt; }
      const data = m.data.slice().buffer; this.player?.port.postMessage({ ...m, data }, [data]);
    }
    if (m.type === 'frame' && this.video) {
      if (this.decode.length + this.frames.length + Number(this.decoding) >= MAX_VIDEO_FRAMES) { this.fallback(true, 'queue-overflow'); return; }
      this.decode.push({ index: m.index, data: m.data, revision: this.revision }); void this.decodeNext();
    }
    if (m.type === 'end') this.player?.port.postMessage(m);
    if (m.type === 'fallback') this.fallback(false);
  }
  private async decodeNext() {
    if (this.decoding) return; this.decoding = true;
    try {
      while (this.decode.length) {
        const f = this.decode.shift()!;
        const bitmap = await createImageBitmap(new Blob([f.data.slice().buffer], { type: 'image/jpeg' }));
        if (f.revision !== this.revision || !this.video) { bitmap.close(); continue; }
        this.frames.push({ index: f.index, bitmap });
        this.player?.port.postMessage({ type: 'credit', ...this.identity, samples: (f.index + 1) * FRAME_SAMPLES }); this.draw();
      }
    } catch { this.fallback(true, 'decode-error'); } finally { this.decoding = false; }
  }
  private draw() {
    if (!this.video || !this.frames.length || this.ended) return;
    const target = Math.floor(this.samples / FRAME_SAMPLES);
    while (this.frames.length > 1 && this.frames[1].index <= target) this.frames.shift()!.bitmap.close();
    const f = this.frames[0]; if (f.index > target) return;
    this.can.drawImage(f.bitmap, 0, 0, 512, 512);
    if (this.avatar) this.avatar.showSpeaking();
    else { this.canvas.hidden = false; this.fallbackImage.hidden = true; }
  }
  private showStatic() { if (this.avatar) this.avatar.showIdle(); else { this.canvas.hidden = true; this.fallbackImage.hidden = false; } }
  private clear() { this.revision++; this.frames.splice(0).forEach(f => f.bitmap.close()); this.decode.length = 0; this.samples = 0; this.firstAudioAt = 0; this.began = false; this.ended = false; this.showStatic(); }
  private fallback(notify = true, reason?: Playback['reason']) { if (!this.video) return; this.video = false; this.revision++; this.frames.splice(0).forEach(f => f.bitmap.close()); this.decode.length = 0; this.showStatic(); this.player?.port.postMessage({ type: 'fallback', ...this.identity }); if (notify) window.soul.playback({ type: 'fallback', ...this.identity, samples: this.samples, reason }); }
  async stop() { clearInterval(this.timer); this.clear(); this.microphone?.getTracks().forEach(t => t.stop()); this.microphone = undefined; this.capture?.disconnect(); this.player?.disconnect(); this.capture = undefined; this.player = undefined; const c = this.context; this.context = undefined; if (c && c.state !== 'closed') await c.close(); }
}
