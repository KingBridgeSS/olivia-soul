import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Client from '@alicloud/sfmmultimodalapp20250909';
import { memoryConfig, parseMemoryArgs, runMemory } from '../scripts/memory';

test('invalid deletion targets and options are rejected before connecting', () => {
  for (const args of [['delete'], ['delete', '*'], ['delete', 'a', 'b'], ['list', '--page', '0'], ['list', '--page', 'NaN'], ['delete', 'a', '--project', 'profile'], ['list', '--user', ''], ['list', '--unknown']]) {
    assert.throws(() => parseMemoryArgs(args));
  }
  assert.equal(parseMemoryArgs(['--help']), undefined);
  for (const args of [['create'], ['create', ' '], ['create', 'a', 'b'], ['create', 'a', '--page', '1'], ['create', 'a', '--project', 'unknown'], ['update'], ['update', '*', 'text'], ['update', 'a'], ['update', 'a', '  '], ['update', 'a', 'one', 'two'], ['update', 'a', 'text', '--page', '1']]) {
    assert.throws(() => parseMemoryArgs(args));
  }
  assert.throws(() => memoryConfig({ app_id: 'app', workspace_id: 'ws', key: 'voice-key' }), /RAM AccessKey/);
});

test('official SDK sends scoped list/profile/create/delete/update requests and surfaces service failures', async () => {
  const received: { action: string; query: URLSearchParams }[] = [];
  let reject = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const action = String(req.headers['x-acs-action'] || url.searchParams.get('Action'));
    received.push({ action, query: url.searchParams });
    assert.equal(req.method, 'POST');
    assert.ok(req.headers.authorization || url.searchParams.get('Signature'), 'request should be signed by SDK');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reject ? { Success: false, Code: 'Forbidden', RequestId: 'failed-request' } : {
      Success: true, RequestId: 'test-request', Data: action === 'QueryMemoryList'
        ? { MemoryNodes: [{ MemoryNodeId: 'test-node', Content: '测试记忆' }], Total: '21', PageNum: '2', PageSize: '20' }
        : action === 'QueryUserProfile' ? { Name: 'profile', Attributes: [{ Id: 'nickname', Name: '昵称', Value: '测试用户' }] }
        : action === 'CreateMemory' ? { MemoryNodes: [{ MemoryNodeId: 'new-node', Content: '新增记忆', Event: 'ADD' }] } : {},
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as import('node:net').AddressInfo;
    const config = memoryConfig({ app_id: 'app', workspace_id: 'ws', ALIBABA_CLOUD_ACCESS_KEY_ID: 'test-ak', ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-secret' });
    config.endpoint = `127.0.0.1:${address.port}`;
    config.protocol = 'http';
    const api = new Client(config), scope = { appId: 'test-app', workspaceId: 'test-workspace' };
    // IPC callers bypass the CLI parser, so the shared service must reject invalid writes too.
    for (const options of [
      { command: 'create', project: 'observation_project', content: ' ' },
      { command: 'create', project: 'unknown', content: 'text' },
      { command: 'update', id: '*', content: 'text' },
      { command: 'delete', id: '' },
      { command: 'list', project: 'observation_project', page: 0 },
    ]) await assert.rejects(runMemory(api, scope, { ...options, user: 'test-user' } as any));
    assert.equal(received.length, 0);
    const list = await runMemory(api, scope, parseMemoryArgs(['list', '--page', '2', '--user', 'test-user'])!);
    assert.equal((list as any).data.memoryNodes[0].content, '测试记忆');
    assert.equal(received[0].query.get('PageNumber'), '2');
    assert.equal(received[0].query.get('ProjectId'), 'observation_project');
    await runMemory(api, scope, parseMemoryArgs(['list', '--project', 'profile', '--user', 'test-user'])!);
    assert.equal(received[1].query.get('ProjectId'), 'profile_project');
    const profile = await runMemory(api, scope, parseMemoryArgs(['profile', '--user', 'test-user'])!);
    assert.equal((profile as any).data.attributes[0].value, '测试用户');
    const deleted = await runMemory(api, scope, parseMemoryArgs(['delete', 'test-node', '--user', 'test-user'])!);
    assert.equal((deleted as any).deleted, 'test-node');
    assert.equal(received[3].action, 'DeleteMemory');
    assert.equal(received[3].query.get('MemoryNodeId'), 'test-node');
    const content = '用户就读于东京大学，英文名 University of Tokyo。\n保留第二行 & 引号 "test"';
    const updated = await runMemory(api, scope, parseMemoryArgs(['update', 'test-node', content, '--user', 'test-user'])!);
    assert.equal((updated as any).updated, 'test-node');
    assert.equal((updated as any).content, content);
    assert.equal(received[4].action, 'UpdateMemory');
    assert.equal(received[4].query.get('MemoryNodeId'), 'test-node');
    assert.equal(received[4].query.get('Content'), content);
    for (const project of ['observation', 'profile']) {
      const created = await runMemory(api, scope, parseMemoryArgs(['create', content, '--project', project, '--user', 'test-user'])!);
      assert.equal(created.data?.memoryNodes?.[0].memoryNodeId, 'new-node');
      const request = received.at(-1)!;
      assert.equal(request.action, 'CreateMemory');
      assert.equal(request.query.get('Content'), content);
      assert.equal(request.query.get('ProjectId'), `${project}_project`);
      assert.equal(request.query.get('AutoUpdate'), 'false');
      assert.equal(request.query.get('ExpirationTime'), '-1');
    }
    for (const { query } of received) {
      assert.equal(query.get('UserDefinedId'), 'test-user');
      assert.equal(query.get('AppId'), 'test-app');
      assert.equal(query.get('WorkspaceId'), 'test-workspace');
    }
    reject = true;
    await assert.rejects(runMemory(api, scope, parseMemoryArgs(['delete', 'test-node'])!), /Forbidden.*failed-request/);
    await assert.rejects(runMemory(api, scope, parseMemoryArgs(['update', 'test-node', '新内容'])!), /Forbidden.*failed-request/);
    await assert.rejects(runMemory(api, scope, parseMemoryArgs(['create', '新内容'])!), /Forbidden.*failed-request/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('SDK errors do not expose signed URLs or secrets', async () => {
  const api = { queryMemoryList: async () => { throw Object.assign(new Error('https://example/?Signature=secret'), { code: 'InvalidAccessKeyId' }); } } as unknown as Client;
  await assert.rejects(runMemory(api, { appId: 'app', workspaceId: 'ws' }, parseMemoryArgs([])!), error => {
    assert.match(String(error), /InvalidAccessKeyId/);
    assert.doesNotMatch(String(error), /Signature|secret/);
    return true;
  });
});
