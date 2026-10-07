import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AliyunTurns, isNoSpeechRecognized } from '../src/main/aliyun-turn';
import { commandResult, parseCommandBatch } from '../src/shared/commands';

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const sent: { text: string; results?: object[]; type?: string }[] = [], directives: string[] = [];
  const cloud = { call: 'call', ready: true, state: 'Listening',
    respond: (text: string, results?: object[], type?: 'prompt' | 'transcript') => { sent.push({ text, results, type }); },
    directive: (name: string) => { directives.push(name); },
  };
  const turns = new AliyunTurns(cloud);
  const event = (o: any) => { if (o.event === 'DialogStateChanged') cloud.state = o.state; turns.event(o); };
  const listening = () => event({ event: 'DialogStateChanged', state: 'Listening' });
  const pump = () => { t.mock.timers.tick(600); turns.pump(true); };
  return { cloud, turns, sent, directives, event, listening, pump };
}
const commands = (id: string) => JSON.stringify([{ command_request_id: id, name: 'list_tasks', params: {} }]);

test('a locally rejected send releases its waiter and allows the next request', async t => {
  const h = setup(t), respond = h.cloud.respond;
  h.cloud.respond = () => { throw new Error('消息或图片过大'); };
  const first = h.turns.request({ call: 'call', text: 'oversized' });
  const rejected = assert.rejects(first, /消息或图片过大/);
  h.pump(); await rejected;
  assert.equal(h.cloud.ready, true); assert.equal(h.sent.length, 0);
  h.cloud.respond = respond;
  const next = h.turns.request({ call: 'call', text: '继续' });
  h.pump(); assert.equal(h.sent[0].text, '继续');
  h.event({ event: 'RespondingContent', finished: true }); await next;
});

test('only the recoverable no-speech error is classified by code or name', () => {
  for (const detail of [{ error_code: 451 }, { error_code: '451' }, { error_name: 'NoSpeechRecognized' }]) {
    assert.equal(isNoSpeechRecognized({ event: 'Error', ...detail }), true);
    assert.equal(isNoSpeechRecognized({ event: 'RespondingContent', ...detail }), false);
  }
  assert.equal(isNoSpeechRecognized({ event: 'Error', error_code: 500, error_name: 'InternalAsrError' }), false);
  assert.equal(isNoSpeechRecognized({ event: 'Error', error_code: 425, error_name: 'NoInputAudioError' }), false);
});

test('no-speech errors preserve the current tool response and queued notification', async t => {
  const h = setup(t), controller = new AbortController();
  const response = h.turns.request({ call: 'call', text: 'list', user: true, signal: controller.signal });
  const notification = h.turns.request({ call: 'call', text: 'background finished' });
  h.pump();
  h.event({ event: 'RespondingContent', extra_info: { commands: commands('one') }, finished: false });
  let settled = false;
  void response.then(() => { settled = true; }, () => { settled = true; });
  for (const detail of [{ error_code: 451 }, { error_code: '451' }, { error_name: 'NoSpeechRecognized' }]) {
    h.event({ event: 'Error', round_id: 'unrelated-round', ...detail });
  }
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(controller.signal.aborted, false);
  h.pump(); assert.equal(h.sent.length, 1);
  h.event({ event: 'RespondingContent', extra_info: { commands: commands('two') }, finished: true });
  assert.deepEqual((await response).map(c => c.id), ['one', 'two']);
  h.listening(); h.pump();
  assert.equal(h.sent[1].text, 'background finished');
  h.event({ event: 'RespondingContent', finished: true });
  await notification;
});

test('a voice waiter still settles on Listening after an empty ASR turn', async t => {
  const h = setup(t), controller = new AbortController();
  const voice = h.turns.listen('call', controller.signal);
  h.event({ event: 'Error', error_code: 451, error_name: 'NoSpeechRecognized' });
  h.listening();
  assert.deepEqual(await voice, []);
  assert.equal(controller.signal.aborted, false);
  const next = h.turns.request({ call: 'call', text: 'next' });
  h.pump(); assert.equal(h.sent[0].text, 'next');
  h.event({ event: 'RespondingContent', finished: true });
  await next;
});

test('collects streamed tool batches once and only resolves on the completed response', async t => {
  const h = setup(t);
  const response = h.turns.request({ call: 'call', text: 'list', user: true });
  h.turns.pump(false); assert.equal(h.sent.length, 0);
  h.pump();
  let resolved = false; void response.then(() => { resolved = true; });
  h.event({ event: 'RespondingContent', extra_info: { commands: commands('one') }, finished: false });
  await Promise.resolve(); assert.equal(resolved, false);
  h.event({ event: 'RespondingContent', extra_info: { commands: commands('one') }, finished: false });
  h.event({ event: 'RespondingContent', extra_info: { commands: commands('two') }, finished: true });
  assert.deepEqual((await response).map(c => c.id), ['one', 'two']);
});

test('native result acknowledgement is muted and settled before the next decision', async t => {
  const h = setup(t), controller = new AbortController();
  const turn = h.turns.toolTurn('call', '查询任务', controller.signal, async () => ({ success: true, text: '[]' }));
  const step = { entry: { id: 'id', name: 'list_tasks' as const }, outcome: { success: true, text: '[]' } };
  const operation = (async () => { await turn.submit([step]); return turn.next([step], false); })();
  const notification = h.turns.request({ call: 'call', text: 'background finished', afterCommand: 'call:id' });
  h.pump();
  assert.equal(h.turns.muted, true);
  h.event({ event: 'RespondingContent', finished: true, extra_info: { commands: commands('ignored') } });
  h.event({ event: 'RespondingStarted' });
  assert.deepEqual(h.directives, ['RequestToSpeak']);
  h.pump(); assert.equal(h.sent.length, 1);
  h.listening(); await Promise.resolve(); await Promise.resolve();
  h.pump();
  assert.equal(h.sent.length, 2);
  assert.equal(JSON.parse(h.sent[1].text.split('\n')[1]).tools_allowed, false);
  assert.equal(h.turns.muted, false);
  h.event({ event: 'RespondingContent', finished: true, text: '没有任务' });
  assert.deepEqual(await operation, []);
  h.listening(); h.pump();
  assert.equal(h.sent[2].text, 'background finished');
  h.event({ event: 'RespondingContent', finished: true });
  await notification;
});

test('task notifications and user requests cannot steal a tool response', async t => {
  const h = setup(t);
  const result = h.turns.request({ call: 'call', text: '', quiet: true, results: [commandResult('id', 'accepted', true)] });
  const notification = h.turns.request({ call: 'call', text: 'task finished', afterCommand: 'call:id' });
  const user = h.turns.request({ call: 'call', text: 'new question', user: true });
  h.pump(); assert.ok(h.sent[0].results);
  h.listening(); await result;
  h.pump(); assert.equal(h.sent[1].text, 'new question');
  h.event({ event: 'RespondingContent', finished: true, extra_info: { commands: commands('user-tool') } });
  assert.equal((await user)[0].id, 'user-tool');
  h.pump(); assert.equal(h.sent.length, 2); // Still waiting for playback/Listening.
  h.listening(); h.pump(); assert.equal(h.sent[2].text, 'task finished');
  h.event({ event: 'RespondingContent', finished: true });
  assert.deepEqual(await notification, []);
});

test('aborting a queued decision removes it while already-issued results can still settle', async t => {
  const h = setup(t), controller = new AbortController();
  const next = h.turns.request({ call: 'call', text: 'old decision', signal: controller.signal });
  const rejected = assert.rejects(next, { name: 'AbortError' });
  controller.abort(); await rejected;
  const result = h.turns.request({ call: 'call', text: '', quiet: true, results: [commandResult('old', 'accepted', true)] });
  h.pump(); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].text, '');
  h.listening(); await result;
  h.pump(); assert.equal(h.sent.length, 1);
});

test('voice attaches to the existing response; abort, error and hangup release waiters', async t => {
  const h = setup(t), controller = new AbortController();
  const voice = h.turns.listen('call', controller.signal);
  h.pump(); assert.equal(h.sent.length, 0);
  const aborted = assert.rejects(voice, { name: 'AbortError' });
  controller.abort(); await aborted;
  assert.equal(h.turns.muted, true);
  h.turns.interrupt();
  const pending = h.turns.request({ call: 'call', text: 'pending' });
  const failed = assert.rejects(pending, /cloud-error/);
  h.pump();
  h.event({ event: 'Error', error_name: 'cloud-error' }); await failed;
  const queued = h.turns.request({ call: 'call', text: 'queued' });
  const ended = assert.rejects(queued, { name: 'AbortError' });
  h.turns.reset(); await ended;
  h.cloud.call = 'new-call';
  await assert.rejects(h.turns.request({ call: 'call', text: 'stale' }), /通话已结束/);
});

test('an unrelated response error does not strand a later background completion', async t => {
  const h = setup(t);
  const receipt = h.turns.request({ call: 'call', text: '', quiet: true, results: [commandResult('task', 'accepted', true)] });
  h.pump(); h.listening(); await receipt;
  const chat = h.turns.request({ call: 'call', text: 'chat' });
  const rejected = assert.rejects(chat, /error/);
  h.pump(); h.event({ event: 'Error', error_name: 'error' }); await rejected;
  const completion = h.turns.request({ call: 'call', text: 'completed', afterCommand: 'call:task' });
  h.listening(); h.pump(); assert.equal(h.sent.at(-1)?.text, 'completed');
  h.event({ event: 'RespondingContent', finished: true }); await completion;
});

test('continuation preserves wire arguments, call identity, structured output and failed calls', async t => {
  const h = setup(t);
  const entries = parseCommandBatch(JSON.stringify([
    { command_request_id: 'list', name: 'list_tasks', params: [] },
    { command_request_id: 'get', name: 'get_task', params: [{ name: 'task_id', value: 'real-id' }] },
    { command_request_id: 'bad', name: 'computer_task', params: { action: 'continue', goal: '追加要求' } },
    { command_request_id: 'long', name: 'get_task', params: { task_id: 'large-result' } },
  ]));
  const outputs = ['[{"task_id":"real-id"}]', '{"status":"completed","result":"ok"}', '未执行：缺少 task_id', 'x'.repeat(6001)];
  const turn = h.turns.toolTurn('call', '先查询，再追加', new AbortController().signal, async () => { throw new Error('not executing'); });
  const next = turn.next(entries.map((entry, i) => ({ entry, outcome: { success: i !== 2, text: outputs[i] } })), true);
  h.pump();
  const payload = JSON.parse(h.sent[0].text.split('\n')[1]);
  assert.equal(payload.request, '先查询，再追加');
  assert.equal(payload.tools_allowed, true);
  assert.deepEqual(payload.tool_results, [
    { call_id: 'list', name: 'list_tasks', arguments: {}, output: [{ task_id: 'real-id' }], is_error: false },
    { call_id: 'get', name: 'get_task', arguments: { task_id: 'real-id' }, output: { status: 'completed', result: 'ok' }, is_error: false },
    { call_id: 'bad', name: 'computer_task', arguments: { action: 'continue', goal: '追加要求' }, output: '未执行：缺少 task_id', is_error: true },
    { call_id: 'long', name: 'get_task', arguments: { task_id: 'large-result' }, output: { text: 'x'.repeat(6000), truncated: true }, is_error: false },
  ]);
  h.event({ event: 'RespondingContent', finished: true }); await next;
});
