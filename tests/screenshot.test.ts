import test from 'node:test';
import assert from 'node:assert/strict';
import { AliyunTurns } from '../src/main/aliyun-turn';
import { parseCommandBatch } from '../src/shared/commands';
import { runToolLoop, type ToolStep } from '../src/main/tool-flow';
import type { ToolImage } from '../src/main/tool-image';

const entry = (id: string) => parseCommandBatch(JSON.stringify([{ name: 'take_screenshot', command_request_id: id, params: [] }]))[0];
const step = (id: string, value: string): ToolStep => ({ entry: entry(id), outcome: { success: true, text: '{"width":1280}', image: { type: 'base64', value } } });

test('screenshot bytes skip the quiet receipt and only the latest image accompanies the answer', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const sent: { text: string; results?: object[]; images?: ToolImage[] }[] = [];
  const turns = new AliyunTurns({ call: 'call', ready: true, state: 'Listening',
    respond: (text, results, _type, images) => { sent.push({ text, results, images }); }, directive() {} });
  const turn = turns.toolTurn('call', '再看看', new AbortController().signal, async () => { throw new Error('unused'); });
  const history = [step('old', 'old-image'), step('new', 'new-image')];
  const receipt = turn.submit([history[1]]);
  turns.pump(true);
  assert.equal(sent[0].images, undefined);
  assert.ok(!JSON.stringify(sent[0]).includes('new-image'));
  turns.event({ event: 'DialogStateChanged', state: 'Listening' }); await receipt;
  const next = turn.next(history, true);
  t.mock.timers.tick(600); turns.pump(true);
  assert.deepEqual(sent[1].images, [history[1].outcome.image]);
  assert.ok(!sent[1].text.includes('new-image'));
  turns.event({ event: 'RespondingContent', finished: true }); await next;
});

test('interrupt during capture settles a text receipt without uploading or continuing', async () => {
  const controller = new AbortController(); let captures = 0, decisions = 0;
  let receipts: ToolStep[] = [];
  const calls = [entry('id')];
  await runToolLoop(calls, {
    execute: async () => { captures++; controller.abort(); return step('id', 'bytes').outcome; },
    submit: async steps => { receipts = steps; },
    next: async () => { decisions++; return []; }, finish: async () => {},
  }, controller.signal);
  assert.equal(captures, 1); assert.equal(decisions, 0);
  assert.equal(receipts[0].entry.id, 'id');
});

test('queued image answer is discarded on interruption or hangup', async () => {
  for (const hangup of [false, true]) {
    let sent = 0;
    const turns = new AliyunTurns({ call: 'call', ready: true, state: 'Listening', respond: () => { sent++; }, directive() {} });
    const controller = new AbortController();
    const turn = turns.toolTurn('call', '看看', controller.signal, async () => { throw new Error('unused'); });
    const next = turn.next([step('id', 'bytes')], true);
    const rejected = assert.rejects(next, { name: 'AbortError' });
    if (hangup) turns.reset(); else controller.abort();
    await rejected; turns.pump(true);
    assert.equal(sent, 0);
  }
});

test('failed refresh and a new unrelated request never reuse the previous screenshot', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const sent: (ToolImage[] | undefined)[] = [];
  const turns = new AliyunTurns({ call: 'call', ready: true, state: 'Listening',
    respond: (_text, _results, _type, images) => { sent.push(images); }, directive() {} });
  const turn = turns.toolTurn('call', '再看看', new AbortController().signal, async () => { throw new Error('unused'); });
  const next = turn.next([step('old', 'old-image'), { entry: entry('failed'), outcome: { success: false, text: '截图失败' } }], false);
  turns.pump(true); assert.equal(sent[0], undefined);
  turns.event({ event: 'DialogStateChanged', state: 'Listening' }); await next;
  const chat = turns.request({ call: 'call', text: '你好', user: true });
  t.mock.timers.tick(600); turns.pump(true); assert.equal(sent[1], undefined);
  turns.event({ event: 'RespondingContent', finished: true }); await chat;
});

test('repeated cloud call IDs capture once; a failed capture stops the loop', async () => {
  let captures = 0, rounds = 0, finishes = 0;
  await runToolLoop([entry('id')], {
    execute: async () => { captures++; return step('id', 'bytes').outcome; },
    submit: async () => {}, next: async () => ++rounds === 1 ? [entry('id')] : [], finish: async () => {},
  }, new AbortController().signal);
  assert.equal(captures, 1);
  await runToolLoop([entry('failed')], {
    execute: async () => { throw new Error('截图失败'); }, submit: async steps => assert.equal(steps[0].outcome.success, false),
    next: async () => { throw new Error('must not retry'); }, finish: async text => { finishes++; assert.match(text, /截图失败/); },
  }, new AbortController().signal);
  assert.equal(finishes, 1);
});
