import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AliyunClient } from '../src/main/aliyun';
import { MAX_UPSTREAM_AUDIO_BYTES } from '../src/shared/audio-limits';

test('image bytes use parameters.images alongside native receipts, never text or custom history', () => {
  const { cloud, sent } = setup();
  const images = [{ type: 'base64' as const, value: 'cGljdHVyZQ==' }];
  cloud.respond('看图回答', [{ command_request_id: 'id' }], 'prompt', images);
  const { payload } = JSON.parse(sent[0] as string);
  assert.equal(payload.input.text, '看图回答');
  assert.deepEqual(payload.parameters.images, images);
  assert.deepEqual(payload.parameters.biz_params.command_results, [{ command_request_id: 'id' }]);
  assert.equal(payload.parameters.history, undefined);
  cloud.respond('普通聊天');
  assert.equal(JSON.parse(sent[1] as string).payload.parameters, undefined);
});

function setup(deferAudio = false) {
  const sent: (string | Uint8Array)[] = [];
  const audioCallbacks: ((error?: Error) => void)[] = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number, bufferedAmount: 0,
    send: (data: string | Uint8Array, callback?: (error?: Error) => void) => {
      sent.push(data);
      if (callback) { if (deferAudio) audioCallbacks.push(callback); else callback(); }
    },
    terminate: () => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); },
  });
  const cloud = new AliyunClient();
  cloud.socket = ws as unknown as WebSocket;
  cloud.call = 'call'; cloud.dialog = 'dialog'; cloud.ready = true;
  return { cloud, ws, sent, audioCallbacks };
}

test('wire diagnostics follow actual sends, omit payloads and cannot disrupt the transport', () => {
  const { cloud, ws, sent } = setup();
  const events: any[] = [];
  cloud.on('diagnostic', event => { events.push(event); assert.ok(sent.length > 0); });
  cloud.respond('private prompt', [{ result: 'private tool result' }], 'prompt', [{ type: 'base64', value: 'private image' }]);
  cloud.directive('LocalRespondingEnded');
  cloud.directive('HeartBeat');
  assert.deepEqual(events.map(e => [e.direction, e.event, e.callId, e.dialogId]), [
    ['sent', 'RequestToRespond', 'call', 'dialog'], ['sent', 'LocalRespondingEnded', 'call', 'dialog'],
  ]);
  assert.ok(!JSON.stringify(events).includes('private'));
  cloud.on('diagnostic', () => { throw new Error('telemetry failed'); });
  assert.doesNotThrow(() => cloud.directive('RequestToSpeak'));
  assert.equal(JSON.parse(sent.at(-1) as string).payload.input.directive, 'RequestToSpeak');
  ws.readyState = WebSocket.CLOSED;
  const count = events.length;
  cloud.directive('LocalRespondingEnded');
  assert.equal(events.length, count);
});

test('a buffered screenshot does not count as congested audio or hang up the call', () => {
  const { cloud, ws, sent } = setup();
  const faults: string[] = []; cloud.on('fault', s => faults.push(s));
  cloud.respond('看图回答', undefined, 'prompt', [{ type: 'base64', value: Buffer.alloc(120 * 1024).toString('base64') }]);
  // Simulate several image requests still queued on the shared connection.
  ws.bufferedAmount = 10 * Buffer.byteLength(sent[0] as string);
  assert.ok(ws.bufferedAmount > MAX_UPSTREAM_AUDIO_BYTES);
  for (let i = 0; i < 100; i++) cloud.sendAudio(Buffer.alloc(3200), i % 2 === 0);
  assert.equal(sent.length, 101);
  assert.equal(cloud.ready, true); assert.equal(ws.readyState, WebSocket.OPEN);
  assert.deepEqual(faults, []);
});

test('30 seconds of unflushed PCM fits, draining restores capacity, and overflow closes the call', () => {
  const { cloud, ws, audioCallbacks } = setup(true);
  const faults: string[] = []; cloud.on('fault', s => faults.push(s));
  // Each packet is 100 ms at 16 kHz mono PCM16; 300 packets are 30 seconds.
  for (let i = 0; i < 300; i++) cloud.sendAudio(Buffer.alloc(3200), i % 2 === 0);
  assert.equal(ws.readyState, WebSocket.OPEN);
  audioCallbacks.shift()!();
  cloud.sendAudio(Buffer.alloc(3200));
  assert.equal(ws.readyState, WebSocket.OPEN);
  cloud.sendAudio(Buffer.alloc(3200));
  assert.equal(ws.readyState, WebSocket.CLOSED);
  assert.deepEqual(faults, ['上行音频拥塞，通话已结束']);
});

test('audio write failure closes the connection with a visible error', () => {
  const { cloud, ws, audioCallbacks } = setup(true);
  const faults: string[] = []; cloud.on('fault', s => faults.push(s));
  cloud.sendAudio(Buffer.alloc(3200));
  audioCallbacks.shift()!(new Error('write failed'));
  assert.equal(ws.readyState, WebSocket.CLOSED);
  assert.deepEqual(faults, ['阿里云音频发送失败']);
});

test('oversized UTF-8 or image messages are rejected before sending without closing the call', () => {
  const { cloud, ws, sent } = setup();
  assert.throws(() => cloud.respond('汉'.repeat(90000)), /消息或图片过大/);
  assert.throws(() => cloud.respond('看图', undefined, 'prompt', [{ type: 'base64', value: Buffer.alloc(330000).toString('base64') }]), /消息或图片过大/);
  assert.equal(sent.length, 0); assert.equal(ws.readyState, WebSocket.OPEN);
  cloud.respond('继续聊天'); assert.equal(sent.length, 1);
});

test('Stop is the final upstream message, including late audio, tools and playback events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { cloud, ws, sent } = setup();
  let timerCalls = 0;
  Object.assign(cloud, {
    heartbeat: setInterval(() => { timerCalls++; cloud.directive('HeartBeat'); }, 100),
    silence: setInterval(() => { timerCalls++; cloud.sendAudio(Buffer.alloc(3200), true); }, 100),
  });
  cloud.sendAudio(Buffer.alloc(3200));
  cloud.respond('before stop');
  const stopping = cloud.stop();
  assert.equal(cloud.ready, false);
  cloud.sendAudio(Buffer.alloc(3200));
  cloud.sendAudio(Buffer.alloc(3200), true);
  cloud.directive('HeartBeat');
  cloud.directive('LocalRespondingEnded');
  cloud.respond('', [{ command_request_id: 'tool', result: 'done' }]);
  cloud.directive('Stop');
  t.mock.timers.tick(1000);
  assert.equal(timerCalls, 0);
  assert.equal(sent.length, 3);
  const stop = JSON.parse(sent[2] as string);
  assert.equal(stop.header.action, 'finish-task');
  assert.deepEqual(stop.payload.input, { directive: 'Stop', dialog_id: 'dialog' });
  ws.terminate();
  await stopping;
  assert.equal(cloud.socket, undefined);
});

test('concurrent stops send Stop once and both wait for the close timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cloud, ws, sent } = setup();
  let finished = 0;
  const first = cloud.stop().then(() => { finished++; });
  const second = cloud.stop().then(() => { finished++; });
  await Promise.resolve();
  assert.equal(finished, 0);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1800);
  await Promise.all([first, second]);
  assert.equal(finished, 2);
  assert.equal(ws.readyState, WebSocket.CLOSED);
  assert.equal(cloud.state, 'Disconnected');
});

test('hangup before dialog startup closes without sending an invalid Stop', async () => {
  const { cloud, ws, sent } = setup();
  cloud.dialog = '';
  await cloud.stop();
  assert.deepEqual(sent, []);
  assert.equal(ws.readyState, WebSocket.CLOSED);
  assert.equal(cloud.ready, false);
});
