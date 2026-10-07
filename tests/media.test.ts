import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { MAX_REPLY_AUDIO_SAMPLES } from '../src/shared/audio-limits';
const worklet = buildSync({ entryPoints: ['src/renderer/audio-worklet.js'], bundle: true, platform: 'browser', target: 'chrome140', write: false }).outputFiles[0].text;
function fixture() {
  const classes: Record<string, any> = {}, messages: any[] = [];
  const context = vm.createContext({ sampleRate: 48000, AudioWorkletProcessor: class { port = { onmessage: undefined as any, postMessage: (m: any) => messages.push(m) }; }, registerProcessor: (name: string, clazz: any) => { classes[name] = clazz; } });
  vm.runInContext(worklet, context);
  const player = new classes['soul-player']();
  const send = (m: any) => player.port.onmessage({ data: m });
  const tick = (n: number) => { for (let i = 0; i < n; i++) player.process([], [[new Float32Array(128)]]); };
  return { player, send, tick, messages, classes };
}
test('video credit gates actual audio samples, fallback releases playback', () => { const { player, send, tick, messages } = fixture(); const id = { call: 'c', generation: 1 }; send({ type: 'begin', ...id, video: true }); send({ type: 'audio', ...id, data: new Int16Array(2400).fill(1000).buffer }); tick(10); assert.equal(player.position, 0); assert.equal(messages.filter(m => m.type === 'started').length, 0); send({ type: 'credit', ...id, samples: 960 }); tick(30); assert.equal(player.position, 960); send({ type: 'fallback', ...id }); send({ type: 'end', ...id }); tick(40); assert.equal(player.position, 2400); assert.equal(messages.filter(m => m.type === 'started').length, 1); assert.equal(messages.filter(m => m.type === 'ended').length, 1); });
test('new generation discards old PCM, credits and end markers', () => { const { player, send, tick } = fixture(); send({ type: 'begin', call: 'c', generation: 2, video: true }); for (const type of ['audio', 'end', 'fallback', 'credit']) send({ type, call: 'c', generation: 1, samples: 10000, data: new Int16Array(2400).buffer }); tick(20); assert.equal(player.written, 0); assert.equal(player.position, 0); assert.equal(player.ended, false); });
test('540-second backlog fits exactly; one extra sample is rejected without growing the ring', () => {
  const { player, send, messages } = fixture(), id = { call: 'c', generation: 1 };
  send({ type: 'begin', ...id, video: true });
  send({ type: 'audio', ...id, data: new Int16Array(24000 * 540).fill(8192).buffer });
  assert.equal(player.written, MAX_REPLY_AUDIO_SAMPLES);
  assert.equal(player.ring.length, 24000 * 540);
  assert.ok(!messages.some(m => m.type === 'overflow'));
  send({ type: 'audio', ...id, data: new Int16Array([16384]).buffer });
  assert.equal(messages.at(-1).type, 'overflow');
  assert.equal(player.written, MAX_REPLY_AUDIO_SAMPLES);
  assert.equal(player.ring[0], .25);
  assert.equal(player.ring.length, MAX_REPLY_AUDIO_SAMPLES);
});

test('a ten-minute reply plays through ring reuse, then interrupt discards the old backlog', () => {
  const { player, send, tick, messages } = fixture(), id = { call: 'c', generation: 1 };
  send({ type: 'begin', ...id, video: false });
  send({ type: 'audio', ...id, data: new Int16Array(MAX_REPLY_AUDIO_SAMPLES).fill(8192).buffer });
  tick(375 * 60); // 48 kHz / 128 output samples per render quantum: play one minute.
  assert.equal(player.position, 24000 * 60);
  send({ type: 'audio', ...id, data: new Int16Array(24000 * 60).fill(16384).buffer });
  assert.equal(player.written - player.position, MAX_REPLY_AUDIO_SAMPLES);
  tick(375 * 480);
  const out = new Float32Array(128); player.process([], [[out]]);
  assert.ok(out.every(v => v === .5), 'wrapped samples retain the newly queued audio');
  send({ type: 'end', ...id }); tick(375 * 60);
  assert.equal(player.position, 24000 * 600);
  assert.equal(messages.filter(m => m.type === 'ended').length, 1);
  assert.ok(!messages.some(m => m.type === 'overflow'));
  send({ type: 'begin', call: 'c', generation: 2, video: false });
  send({ type: 'audio', call: 'c', generation: 2, data: new Int16Array(24000 * 90).fill(8192).buffer });
  send({ type: 'interrupt', call: 'c', generation: 2 }); tick(2);
  assert.equal(player.written, 0); assert.equal(player.position, 0);
  player.process([], [[out]]); assert.ok(out.every(v => v === 0));
});
test('muted capture sends zeros and cannot report speech', () => { const { classes, messages } = fixture(); const capture = new classes['soul-capture'](); capture.port.onmessage({ data: { muted: true } }); for (let i = 0; i < 50; i++) capture.process([[new Float32Array(128).fill(.8)]]); assert.ok(messages.length > 0); assert.ok(messages.every(m => m.speaking === false && new Int16Array(m.data).every(v => v === 0))); });

test('an interrupt with the next generation clears audio and cannot cancel a newer reply later', () => {
  const { player, send, tick } = fixture();
  send({ type: 'begin', call: 'c', generation: 1, video: false });
  send({ type: 'audio', call: 'c', generation: 1, data: new Int16Array(24000).fill(8192).buffer }); tick(2);
  send({ type: 'interrupt', call: 'c', generation: 2 });
  send({ type: 'audio', call: 'c', generation: 1, data: new Int16Array(24000).fill(8192).buffer });
  tick(2); assert.equal(player.position, 0); assert.equal(player.written, 0);
  send({ type: 'begin', call: 'c', generation: 3, video: false });
  send({ type: 'audio', call: 'c', generation: 3, data: new Int16Array(24000).fill(8192).buffer });
  send({ type: 'interrupt', call: 'c', generation: 2 }); tick(2);
  assert.equal(player.generation, 3); assert.ok(player.position > 0);
});
