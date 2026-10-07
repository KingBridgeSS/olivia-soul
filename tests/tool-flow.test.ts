import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandBatch } from '../src/shared/commands';
import { runToolLoop, MAX_TOOL_ROUNDS, type ToolTurn, type ToolStep } from '../src/main/tool-flow';
const batch = (...commands: object[]) => parseCommandBatch(JSON.stringify(commands));
const command = (id: string, name: string, params = {}) => ({ command_request_id: id, name, params });
const signal = () => new AbortController().signal;
function harness(overrides: Partial<ToolTurn> = {}) {
  const submitted: ToolStep[][] = [], finished: string[] = [], executed: string[] = [];
  const turn: ToolTurn = {
    execute: async c => { executed.push(c.id); return { success: true, text: c.id }; },
    submit: async steps => { submitted.push(steps); },
    next: async () => [],
    finish: async text => { finished.push(text); },
    ...overrides,
  };
  return { turn, submitted, finished, executed };
}

test('list -> get uses the returned ID and ends on a response without tools', async () => {
  const h = harness({
    execute: async c => ({ success: true, text: c.name === 'list_tasks' ? '[{"task_id":"real-id"}]' : '完整结果' }),
    next: async history => {
      if (history.length === 1) {
        const id = JSON.parse(history[0].outcome.text)[0].task_id;
        return batch(command('get', 'get_task', { task_id: id }));
      }
      assert.equal(history[1].outcome.text, '完整结果');
      return [];
    },
  });
  await runToolLoop(batch(command('list', 'list_tasks')), h.turn, signal());
  assert.equal(h.submitted.length, 2);
  assert.equal(h.submitted[1][0].entry.command?.taskId, 'real-id');
  assert.deepEqual(h.finished, []);
});

test('one malformed tool preserves valid peer results for correction', async () => {
  const h = harness({ next: async history => {
    if (history.length > 2) return [];
    assert.deepEqual(history.map(s => s.outcome.success), [true, false]);
    assert.match(history[1].outcome.text, /缺少 task_id/);
    return batch(command('corrected', 'get_task', { task_id: 'real-id' }));
  } });
  await runToolLoop(batch(command('list', 'list_tasks'), command('invalid', 'get_task')), h.turn, signal());
  assert.deepEqual(h.executed, ['list', 'corrected']);
  assert.equal(h.submitted[0].length, 2);
});

test('accepted tasks can be followed by distinct starts and continuations', async () => {
  const calls = [
    command('first', 'computer_task', { action: 'start', goal: 'first task' }),
    command('second', 'computer_task', { action: 'start', goal: 'second task' }),
    command('append-one', 'computer_task', { action: 'continue', task_id: 'a', goal: 'first addition' }),
    command('append-two', 'computer_task', { action: 'continue', task_id: 'a', goal: 'second addition' }),
  ];
  const h = harness({ next: async history => history.length < calls.length ? batch(calls[history.length]) : [] });
  await runToolLoop(batch(calls[0]), h.turn, signal());
  assert.deepEqual(h.executed, ['first', 'second', 'append-one', 'append-two']);
  assert.deepEqual(h.finished, []);
});

test('only identical call IDs reuse results; fresh queries read fresh state', async () => {
  let round = 0;
  const h = harness({ next: async () => ++round === 1
    ? batch(command('same', 'get_task', { task_id: 'a' }))
    : round === 2 ? batch(command('fresh', 'get_task', { task_id: 'a' })) : [] });
  await runToolLoop(batch(command('same', 'get_task', { task_id: 'a' })), h.turn, signal());
  assert.deepEqual(h.executed, ['same', 'fresh']);
  assert.equal(h.submitted.length, 3);
});

test('uncertain submission stops automatic retries and remaining batch actions', async () => {
  const h = harness({
    execute: async () => ({ success: false, text: '提交结果未能确认' }),
    next: async () => { assert.fail('must not ask for another decision'); },
  });
  await runToolLoop(batch(command('start', 'computer_task', { action: 'start', goal: 'work' }), command('later', 'list_tasks')), h.turn, signal());
  assert.match(h.submitted[0][1].outcome.text, /未执行/);
  assert.match(h.finished[0], /停止自动重试/);
});

test('round limit permits a final answer but rejects further tool calls', async () => {
  let round = 0;
  const h = harness({ next: async (_history, allowed) => {
    round++;
    assert.equal(allowed, round < MAX_TOOL_ROUNDS);
    return batch(command(`extra-${round}`, 'list_tasks'));
  } });
  await runToolLoop(batch(command('first', 'list_tasks')), h.turn, signal());
  assert.equal(h.executed.length, MAX_TOOL_ROUNDS);
  assert.equal(h.submitted.at(-1)![0].outcome.success, false);
  assert.match(h.finished[0], /轮数上限/);
});

test('interruption settles the running tool but prevents later tools and rounds', async () => {
  const controller = new AbortController();
  const h = harness({
    execute: async () => { controller.abort(); return { success: true, text: 'accepted' }; },
    next: async () => { assert.fail('cancelled request must not continue'); },
  });
  await runToolLoop(batch(command('one', 'list_tasks'), command('two', 'get_task', { task_id: 'a' })), h.turn, controller.signal);
  assert.deepEqual(h.submitted[0].map(s => s.outcome.success), [true, false]);
  assert.match(h.submitted[0][1].outcome.text, /未执行/);
  assert.deepEqual(h.finished, []);
});
