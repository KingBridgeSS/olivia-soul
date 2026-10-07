import test from 'node:test';
import assert from 'node:assert/strict';
import { foldEvent, setQueue, settle, queueItemsToRemove, contentHash, type TaskRecord, type TaskRun } from '../src/main/task-state';
function run(id = 'request'): TaskRun { return { requestId: id, commandKey: id, goal: id, context: '', created: 100, promptHash: contentHash([]), consumed: false, response: '', manual: false, reported: false, cancelRequested: false, status: 'running' }; }
function task(): TaskRecord { return { id: 'task', call: 'call', sessionId: 'session', host: 'host', cwd: 'C:/fixture', created: 100, seq: -1, title: 'test', status: 'running', detail: '', manual: false, runs: [run()], queue: [], jobs: [], running: false }; }
const event = (t: TaskRecord, type: string, data: any) => foldEvent(t, { seq: t.seq + 1, type, data, time: 101 + t.seq });
function turn(t: TaskRecord, number: number, request: string, response: string) {
  event(t, 'turn/start', { turn: number });
  event(t, 'user/message', { source: { kind: 'user', rpcId: request } });
  event(t, 'assistant/message', { turn: number, message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: response }] } });
  event(t, 'turn/end', { turn: number, reason: { kind: 'completed' } });
}
test('idle or unrelated end cannot complete an unconsumed request', () => {
  const t = task(); settle(t); event(t, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(t.status, 'running');
});
test('completion requires own consumed request, matching turn end and idle jobs', () => {
  const t = task(); t.running = true; turn(t, 1, 'request', 'verified');
  assert.equal(t.status, 'running'); t.running = false; t.jobs = [{ id: 'job', status: 'running' }]; settle(t);
  assert.equal(t.status, 'running'); t.jobs = []; settle(t);
  assert.equal(t.status, 'completed'); assert.equal(t.runs[0].response, 'verified');
});
test('queued continuations retain separate requirements and results without manual takeover', () => {
  const t = task(); t.running = true; t.runs.push(run('second'));
  setQueue(t, [{ id: 'q2', rpcId: 'second' }]); turn(t, 1, 'request', 'first result');
  assert.equal(t.manual, false); assert.equal(t.status, 'running');
  setQueue(t, []); turn(t, 2, 'second', 'second result'); t.running = false; settle(t);
  assert.equal(t.status, 'completed'); assert.deepEqual(t.runs.map(r => r.response), ['first result', 'second result']);
  const seq = t.seq;
  foldEvent(t, { seq: 0, type: 'turn/start', data: { turn: 99 } });
  assert.equal(t.seq, seq); assert.equal(t.currentTurn, 2);
});
test('a continuation after completion does not modify the previous result', () => {
  const t = task(); turn(t, 1, 'request', 'original'); t.runs.push(run('next')); settle(t);
  assert.equal(t.status, 'running'); turn(t, 2, 'next', 'revision');
  assert.deepEqual(t.runs.map(r => [r.status, r.response]), [['completed', 'original'], ['completed', 'revision']]);
});
test('manual and edited input never becomes the original tool result', () => {
  const t = task(); t.running = true;
  event(t, 'turn/start', { turn: 1 }); event(t, 'user/message', { source: { kind: 'user', rpcId: 'request' } });
  event(t, 'user/message', { source: { kind: 'user', rpcId: 'browser' } });
  event(t, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'human result' }] } });
  event(t, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); t.running = false; settle(t);
  assert.equal(t.status, 'failed'); assert.ok(!t.runs[0].response.includes('human result'));
  setQueue(t, [{ id: 'edited', rpcId: 'request', message: { content: [{ type: 'text', text: 'edited' }] } }, { id: 'human', rpcId: 'browser' }]);
  assert.deepEqual(queueItemsToRemove(t), []);
});
test('cancel removes all owned queued requests while preserving foreign input', () => {
  const t = task(); t.runs.push(run('second'));
  setQueue(t, [{ id: 'q1', rpcId: 'request' }, { id: 'q2', rpcId: 'second' }, { id: 'human', rpcId: 'browser' }]);
  assert.deepEqual(queueItemsToRemove(t), ['q1', 'q2']);
  for (const r of t.runs) r.cancelRequested = true;
  setQueue(t, [{ id: 'human', rpcId: 'browser' }]);
  assert.equal(t.status, 'cancelled');
});
test('disconnected status cannot confirm completion and plugin context is not human input', () => {
  const t = task(); t.running = undefined;
  event(t, 'user/message', { source: { kind: 'plugin', plugin: 'system-prompt' } });
  turn(t, 1, 'request', 'done'); assert.equal(t.manual, false); assert.equal(t.status, 'running');
});
