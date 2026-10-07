import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DshHost } from '../src/main/dsh-host';
import { parseDshUrl } from '../src/main/dsh-config';
import { Tasks } from '../src/main/tasks';
import type { Preferences } from '../src/shared/types';
import type { TaskRecord } from '../src/main/task-state';
import { dshServer } from './helpers/dsh-server';

test('validates the configured URL without disclosing its token', () => {
  for (const value of ['', 'invalid', 'http://127.0.0.1:8766/', 'http://127.0.0.1:8766/?token=这里填启动时输出的token',
    'http://example.com/?token=SECRET', 'http://user:SECRET@localhost/?token=SECRET', 'http://localhost/api?token=SECRET',
    'http://localhost/?token=SECRET&token=SECRET', 'http://localhost/?token=SECRET#fragment']) {
    assert.throws(() => parseDshUrl(value), (error: Error) => !error.message.includes('SECRET'));
  }
  assert.equal(parseDshUrl('http://127.0.0.1:8766/?token=valid-token').origin, 'http://127.0.0.1:8766');
});

test('missing external server fails rather than launching a replacement', async () => {
  const server = await dshServer(); await server.close();
  const host = new DshHost(() => server.url);
  await assert.rejects(host.ensure(), /请先自行启动 dsh/);
  host.disconnect();
  await assert.rejects(fetch(server.base));
});

test('rejects invalid credentials, an unrelated HTTP service and incompatible Remote responses', async t => {
  for (const mode of ['ok', 'html', 'bad-ready', 'bad-list'] as const) {
    await t.test(mode, async () => {
      const server = await dshServer(mode);
      const host = new DshHost(() => mode === 'ok' ? `${server.base}/?token=wrong-token` : server.url);
      try { await assert.rejects(host.ensure(), (error: Error) => /认证失败|协议检查失败/.test(error.message) && !error.message.includes(server.token)); }
      finally { host.disconnect(); await server.close(); }
    });
  }
});

test('authenticates once for concurrent callers; disconnect leaves the external service alive', async () => {
  const server = await dshServer(); const host = new DshHost(() => server.url);
  try {
    const [a, b] = await Promise.all([host.ensure(), host.ensure()]); assert.equal(a, b);
    assert.equal(await host.browserUrl(), server.url); assert.equal(server.authCount, 1);
    assert.equal(server.connectionCount, 1); assert.deepEqual(server.calls, ['session/list']);
    assert.ok(!host.identity.includes(server.token));
    host.disconnect();
    assert.equal((await fetch(server.url, { redirect: 'manual' })).status, 303);
    await host.ensure(); assert.equal(server.connectionCount, 2);
  } finally { host.disconnect(); await server.close(); }
});

test('task API keeps cwd, recovers a dropped connection, and never resubmits a prompt', async () => {
  const server = await dshServer(); const host = new DshHost(() => server.url);
  const preferences = { dshBaseUrl: server.base, dshCwd: process.cwd() } as Preferences;
  const tasks = new Tasks(host, () => preferences);
  try {
    await tasks.ensure();
    tasks.beginCall('test-call');
    const finished = once(tasks, 'finished');
    assert.equal((await tasks.execute({ id: 'one', name: 'computer_task', action: 'start', goal: 'test', context: '' }, 'test-call')).success, true);
    await finished;
    assert.equal(tasks.records.at(-1)?.status, 'completed'); assert.equal(tasks.records.at(-1)?.runs.at(-1)?.response, 'DSH_EXTERNAL_OK');
    assert.equal(server.sessions.get(tasks.records.at(-1)!.sessionId)?.cwd, process.cwd());
    const recovered = once(tasks, 'connection-restored'); server.dropConnections(); await recovered;
    assert.equal(server.calls.filter(v => v === 'session/prompt').length, 1);
    await tasks.shutdown();
    assert.equal((await fetch(server.url, { redirect: 'manual' })).status, 303);
  } finally { await tasks.shutdown(); await server.close(); }
});

test('retains approvals received during startup preflight', async () => {
  const server = await dshServer();
  server.permissions.set('approval', { type: 'waterfall', eventId: 'approval', agentId: 'owned', event: 'approval/request', args: [] });
  const host = new DshHost(() => server.url);
  try {
    await host.ensure();
    assert.equal(host.remote?.pendingPermissions.size, 1);
    assert.ok(!server.calls.includes('$events/result')); assert.ok(!server.calls.includes('session/prompt'));
  } finally { host.disconnect(); await server.close(); }
});
