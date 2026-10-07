import { MAX_REPLY_AUDIO_SAMPLES } from '../shared/audio-limits';

class SoulCapture extends AudioWorkletProcessor {
  constructor() { super(); this.phase = 0; this.previous = 0; this.chunk = new Int16Array(320); this.index = 0; this.energy = 0; this.muted = false; this.port.onmessage = e => { this.muted = !!e.data.muted; }; }
  process(inputs) {
    const input = inputs[0]?.[0]; if (!input) return true;
    const step = sampleRate / 16000;
    for (let i = 0; i < input.length; i++) {
      const v = this.muted ? 0 : input[i];
      while (this.phase <= 1) {
        const sample = this.previous + (v - this.previous) * this.phase;
        this.chunk[this.index++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767))); this.energy += sample * sample;
        if (this.index === 320) { const data = this.chunk.buffer; this.port.postMessage({ data, speaking: !this.muted && Math.sqrt(this.energy / 320) > .018 }, [data]); this.chunk = new Int16Array(320); this.index = 0; this.energy = 0; }
        this.phase += step;
      }
      this.phase -= 1; this.previous = v;
    }
    return true;
  }
}
class SoulPlayer extends AudioWorkletProcessor {
  constructor() {
    super(); this.capacity = MAX_REPLY_AUDIO_SAMPLES; this.ring = new Float32Array(this.capacity); this.reset(); this.tick = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.type === 'begin') { this.reset(); this.call = m.call; this.generation = m.generation; this.credit = m.video ? 0 : Infinity; return; }
      // Main advances the generation before sending an interrupt. Clear the old
      // ring before the ordinary same-generation data guard can discard it.
      if (m.type === 'interrupt') {
        if (m.call !== this.call || m.generation < this.generation) return;
        this.reset(); this.call = m.call; this.generation = m.generation; return;
      }
      if (m.call !== this.call || m.generation !== this.generation) return;
      if (m.type === 'audio') {
        const pcm = new Int16Array(m.data); if (this.written - this.position + pcm.length > this.capacity) { this.report('overflow'); return; }
        for (const v of pcm) this.ring[this.written++ % this.capacity] = v / 32768;
      }
      if (m.type === 'credit') this.credit = Math.max(this.credit, m.samples);
      if (m.type === 'fallback') this.credit = Infinity;
      if (m.type === 'end') this.ended = true;
    };
  }
  reset() { this.call = ''; this.generation = 0; this.written = 0; this.position = 0; this.credit = 0; this.ended = false; this.started = false; this.finished = false; }
  report(type) { this.port.postMessage({ type, call: this.call, generation: this.generation, samples: Math.floor(this.position), buffered: Math.max(0, this.written - this.position), written: this.written }); }
  process(inputs, outputs) {
    const out = outputs[0]?.[0]; if (!out) return true;
    const ratio = 24000 / sampleRate;
    for (let i = 0; i < out.length; i++) {
      if (this.position < this.written && this.position < this.credit) {
        if (!this.started) { this.started = true; this.report('started'); }
        const p = Math.floor(this.position), f = this.position - p;
        const a = this.ring[p % this.capacity], b = this.ring[Math.min(p + 1, this.written - 1) % this.capacity];
        out[i] = a + (b - a) * f; this.position = Math.min(this.position + ratio, this.written);
      } else out[i] = 0;
    }
    if (++this.tick % 12 === 0 && this.call) this.report('progress');
    if (this.ended && this.position >= this.written && !this.finished) { this.finished = true; this.report('ended'); }
    return true;
  }
}
registerProcessor('soul-capture', SoulCapture);
registerProcessor('soul-player', SoulPlayer);
