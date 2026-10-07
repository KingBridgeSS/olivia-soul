import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Tasks } from '../src/main/tasks';
import { DshHost } from '../src/main/dsh-host';
import type { Preferences, ComputerCommand } from '../src/shared/types';
import { dshServer } from './helpers/dsh-server';
const command = (id: string, action: 'start' | 'continue' | 'cancel' = 'start', taskId?: string): ComputerCommand => ({ name: 'computer_task', id, action, taskId, goal: id, context: '' });
async function waitFor(fn: () => boolean) { const until = Date.now() + 6000; while (!fn()) { if (Date.now() > until) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } }
test('multiple tasks, queued continuation, out-of-order completion, querying and deduplication', async () => {
  const server = await dshServer('ok', false), host = new DshHost(() => server.url), tasks = new Tasks(host, () => ({ dshCwd: process.cwd() } as Preferences));
  const reports: any[] = []; tasks.on('finished', (t, r) => reports.push([t.id, r.goal, r.response]));
  tasks.beginCall('call');
  try {
    const results = await Promise.all([tasks.execute(command('a'), 'call'), tasks.execute(command('b'), 'call')]);
    assert.ok(results.every(r => r.success)); assert.equal(tasks.records.length, 2);
    const [a, b] = tasks.records;
    assert.notEqual(a.sessionId, b.sessionId); assert.equal(server.sessions.get(a.sessionId)?.running, true);
    assert.equal((await tasks.execute(command('a2', 'continue', a.id), 'call')).success, true);
    assert.equal(a.runs.length, 2); assert.equal(a.manual, false); assert.ok(server.prompts.every(p => p.mode === 'queue'));
    assert.equal((await tasks.execute(command('a2', 'continue', a.id), 'call')).success, true);
    assert.equal(server.prompts.length, 3);
    server.completeNext(b.sessionId, 'B done'); await waitFor(() => b.status === 'completed');
    server.completeNext(a.sessionId, 'A first'); server.completeNext(a.sessionId, 'A second'); await waitFor(() => a.status === 'completed');
    assert.deepEqual(reports, [[b.id, 'b', 'B done'], [a.id, 'a', 'A first'], [a.id, 'a2', 'A second']]);
    const list = await tasks.execute({ name: 'list_tasks', id: 'list', goal: '', context: '' }, 'call');
    assert.equal(JSON.parse(list.text).length, 2);
    const detail = await tasks.execute({ name: 'get_task', id: 'get', taskId: a.id, goal: '', context: '' }, 'call');
    assert.deepEqual(JSON.parse(detail.text).requests.map((r: any) => r.result), ['A first', 'A second']);
    assert.equal((await tasks.execute(command('foreign', 'continue', 'foreign'), 'call')).success, false);
    await tasks.execute(command('again', 'continue', b.id), 'call'); assert.equal(b.runs.length, 2);
    server.completeNext(b.sessionId, 'B continued'); await waitFor(() => b.status === 'completed');
    const restored = once(tasks, 'connection-restored'); server.dropConnections(); await restored;
    assert.equal(reports.length, 4); assert.equal(server.prompts.length, 4);
    await tasks.endCall(); assert.deepEqual(tasks.records, []);
    tasks.beginCall('next');
    assert.equal((await tasks.execute(command('old', 'continue', a.id), 'next')).success, false);
  } finally { await tasks.shutdown(); await server.close(); }
});
test('hangup and exit cancel every active task and clear records without stopping dsh', async () => {
  const server = await dshServer('ok', false), host = new DshHost(() => server.url), tasks = new Tasks(host, () => ({ dshCwd: process.cwd() } as Preferences));
  try {
    tasks.beginCall('call'); await tasks.execute(command('a'), 'call'); await tasks.execute(command('b'), 'call');
    await tasks.execute(command('append', 'continue', tasks.records[0].id), 'call');
    await tasks.endCall(); assert.equal(server.calls.filter(c => c === 'session/cancel').length, 2);
    assert.ok([...server.sessions.values()].every(s => !s.running)); assert.equal(tasks.records.length, 0);
    tasks.beginCall('next'); await tasks.execute(command('c'), 'next'); await tasks.shutdown();
    assert.equal(server.calls.filter(c => c === 'session/cancel').length, 3); assert.equal(tasks.records.length, 0);
    assert.equal((await fetch(server.url, { redirect: 'manual' })).status, 303);
  } finally { await tasks.shutdown(); await server.close(); }
});
test('hangup racing with creation cannot submit work into the next call', async () => {
  const server = await dshServer('ok', false), host = new DshHost(() => server.url), tasks = new Tasks(host, () => ({ dshCwd: process.cwd() } as Preferences));
  try {
    tasks.beginCall('call'); const pending = tasks.execute(command('a'), 'call'); await tasks.endCall();
    assert.equal((await pending).success, false); assert.equal(server.prompts.length, 0); assert.equal(tasks.records.length, 0);
  } finally { await tasks.shutdown(); await server.close(); }
});

test('new input cancels a queued submission without cancelling an accepted background task', async () => {
  const server = await dshServer('ok', false), host = new DshHost(() => server.url), tasks = new Tasks(host, () => ({ dshCwd: process.cwd() } as Preferences));
  try {
    tasks.beginCall('call');
    const accepted = tasks.execute(command('keep-running'), 'call');
    const controller = new AbortController();
    const pending = tasks.execute(command('not-started'), 'call', controller.signal);
    controller.abort();
    assert.equal((await accepted).success, true);
    assert.equal((await pending).success, false);
    assert.equal(server.prompts.length, 1);
    assert.equal(tasks.records.length, 1);
    assert.equal(server.sessions.get(tasks.records[0].sessionId)?.running, true);
  } finally { await tasks.shutdown(); await server.close(); }
});
