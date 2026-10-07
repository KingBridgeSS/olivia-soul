import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeTasks, runScenario, scoreScenario, validateScenario, type ScenarioOutput } from '../scripts/eval-tools-lib';
import { AliyunClient } from '../src/main/aliyun';
import type { ComputerCommand } from '../src/shared/types';

test('seed scenarios are valid, distinct and include negative/multiturn cases', () => {
  const cases = JSON.parse(fs.readFileSync('evals/tool-cases.json', 'utf8'));
  cases.forEach(validateScenario);
  assert.equal(cases.length, 30); assert.equal(new Set(cases.map((c: any) => c.id)).size, 30);
  assert.ok(cases.some((c: any) => c.expectedOutput.noTools));
  assert.ok(cases.some((c: any) => c.input.messages.length > 1));
  assert.throws(() => validateScenario({ ...cases[0], expectedOutput: { required: [], maxMutations: -1 } }), /Invalid expectation/);
});

test('screenshot cases validate and scoring rejects duplicate captures and stale answers', () => {
  const cases = JSON.parse(fs.readFileSync('evals/screenshot-cases.json', 'utf8'));
  cases.forEach(validateScenario); assert.equal(cases.length, 6);
  const output: ScenarioOutput = { tasks: [], turns: [{ text: '再看看', reply: 'MAPLE-284 HTTP 200',
    calls: [{ id: 'new', name: 'take_screenshot', goal: '', context: '' }], results: [{ success: true, text: '{}' }], parseIssues: [] }] };
  const expected = cases.find((s: any) => s.id === 'screen-refresh').expectedOutput;
  assert.ok(scoreScenario(output, expected).every(s => s.value === 1));
  output.turns[0].reply = 'ORBIT-731 HTTP 502';
  assert.equal(scoreScenario(output, expected).find(s => s.name === 'reply_content')?.value, 0);
  output.turns[0].calls.push({ ...output.turns[0].calls[0], id: 'duplicate' });
  assert.equal(scoreScenario(output, expected).find(s => s.name === 'tool_correct')?.value, 0);
});

test('fake tools maintain IDs, previous requests and idempotent starts; unknown submission is not completion', async () => {
  const tasks = new FakeTasks({ messages: ['test'] });
  const start: ComputerCommand = { name: 'computer_task', action: 'start', id: 'c1', goal: 'work', context: 'constraint' };
  const result = await tasks.execute(start), id = JSON.parse(result.text).task_id;
  assert.equal(JSON.parse(result.text).accepted, true);
  assert.deepEqual(await tasks.execute(start), result); assert.equal(tasks.records.length, 1);
  await tasks.execute({ ...start, id: 'c2', action: 'continue', taskId: id, goal: 'more' });
  const details = await tasks.execute({ name: 'get_task', id: 'c3', taskId: id, goal: '', context: '' });
  assert.equal(JSON.parse(details.text).requests.length, 2);
  const unknown = await tasks.execute({ ...start, id: 'c4', action: 'cancel', taskId: 'bad-id' });
  assert.equal(unknown.retryable, true);
  const failure = new FakeTasks({ messages: ['test'], failure: 'unknown_submission' });
  assert.equal((await failure.execute(start)).success, false);
  assert.equal(failure.records[0].status, 'unknown');
});

test('scoring catches no-tool errors, wrong IDs, missing constraints and repeated side effects', () => {
  const call: ComputerCommand = { name: 'computer_task', id: '1', action: 'continue', taskId: 'correct', goal: '保留 JPG', context: '' };
  const output: ScenarioOutput = { turns: [{ text: 'test', reply: 'ok', calls: [call], results: [{ success: true, text: 'accepted' }], parseIssues: [] }], tasks: [] };
  const expectation = { required: [{ name: 'computer_task' as const, action: 'continue' as const, taskId: 'correct', goalIncludes: ['JPG'] }] };
  const correct = () => scoreScenario(output, expectation).find(s => s.name === 'tool_correct')?.value;
  assert.equal(correct(), 1);
  output.turns[0].results[0] = { success: false, retryable: true, text: '任务不存在' }; assert.equal(correct(), 0);
  output.turns[0].results[0] = { success: true, text: 'accepted' };
  call.taskId = 'wrong'; assert.equal(correct(), 0); call.taskId = 'correct';
  call.goal = '丢失约束'; assert.equal(correct(), 0); call.goal = 'JPG';
  output.turns[0].calls.push({ ...call, id: '2' }); assert.equal(correct(), 0);
  assert.equal(scoreScenario(output, { required: [], noTools: true }).at(-1)?.value, 0);
  output.turns[0].calls = []; output.turns[0].parseIssues = ['未知工具名称'];
  assert.equal(scoreScenario(output, { required: [], noTools: true }).at(-1)?.value, 0);
  output.transportError = 'timeout';
  assert.deepEqual(scoreScenario(output, expectation).map(s => [s.name, s.value]), [['run_completed', 0]]);
});

class ScriptedCloud extends AliyunClient {
  sent: string[] = [];
  async connect() { this.call = 'test-call'; this.ready = true; this.state = 'Listening'; }
  respond(text: string, results?: object[]) {
    this.sent.push(text); this.state = 'Thinking';
    setTimeout(() => {
      const commands = !results && !text.includes('tool_results')
        ? JSON.stringify([{ name: 'list_tasks', command_request_id: `c${this.sent.length}`, params: {} }]) : undefined;
      this.emit('event', { event: 'RespondingContent', text: commands ? '' : '没有任务', extra_info: { commands }, finished: true });
      this.emit('event', { event: 'RespondingEnded' });
    }, 5);
  }
  directive(name: string) {
    if (name === 'LocalRespondingEnded' || name === 'RequestToSpeak') {
      this.state = 'Listening'; this.emit('event', { event: 'DialogStateChanged', state: 'Listening' });
    }
  }
  async stop() { this.ready = false; this.state = 'Disconnected'; this.emit('disconnected'); }
}

test('headless runner settles result callbacks and completes a real tool loop without dsh', async () => {
  const cloud = new ScriptedCloud();
  const result = await runScenario({ messages: ['有哪些任务？'] }, { appId: '', key: '', workspaceId: '' }, cloud, 5000);
  assert.equal(result.transportError, undefined);
  assert.equal(result.turns[0].calls[0].name, 'list_tasks');
  assert.equal(cloud.sent.length, 3); // user -> native result -> continuation
  assert.equal(result.turns[0].reply, '没有任务');
  assert.equal(cloud.ready, false);
});

test('runner timeout releases a pending cloud turn and does not label it as a tool decision failure', async () => {
  const cloud = new ScriptedCloud(); cloud.respond = () => { cloud.state = 'Thinking'; };
  const result = await runScenario({ messages: ['test'] }, { appId: '', key: '', workspaceId: '' }, cloud, 100);
  assert.match(result.transportError || '', /timeout/);
  assert.equal(cloud.ready, false);
});
