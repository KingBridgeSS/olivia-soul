import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommands, commandResult } from '../src/shared/commands';
test('uses documented commands string and parameter array, ignoring arbitrary tool names', () => { const list = parseCommands(JSON.stringify([{ name: 'other', command_request_id: 'ignored', params: [] }, { name: 'computer_task', command_request_id: 'id', params: [{ name: 'action', value: 'start' }, { name: 'goal', value: 'Write fixture' }, { name: 'session_id', value: 'foreign' }] }])); assert.deepEqual(list, [{ id: 'id', name: 'computer_task', taskId: undefined, action: 'start', goal: 'Write fixture', context: '' }]); });
test('rejects unsupported actions and missing task goals', () => { for (const params of [{ action: 'shell', goal: 'cmd' }, { action: 'start' }]) assert.throws(() => parseCommands(JSON.stringify([{ name: 'computer_task', command_request_id: 'id', params }]))); assert.deepEqual(parseCommands('{'), []); });
test('result preserves command identity and explicit failure semantics', () => { assert.deepEqual(commandResult('original', 'Denied', false), { command_request_id: 'original', invoke_result: { content: { type: 'text', text: 'Denied' }, structuredContent: { success: false } } }); });
test('query tools and target IDs are parsed, while legacy status and missing IDs are rejected', () => {
  const commands = parseCommands(JSON.stringify([
    { name: 'list_tasks', command_request_id: 'l', params: [] },
    { name: 'get_task', command_request_id: 'g', params: { task_id: 'a' } },
    { name: 'computer_task', command_request_id: 'c', params: { action: 'continue', task_id: 'a', goal: 'append' } }
  ]));
  assert.deepEqual(commands.map(c => [c.name, c.taskId]), [['list_tasks', undefined], ['get_task', 'a'], ['computer_task', 'a']]);
  for (const params of [{ action: 'status' }, { action: 'cancel' }, { action: 'continue', goal: 'append' }]) {
    assert.throws(() => parseCommands(JSON.stringify([{ name: 'computer_task', command_request_id: 'bad', params }])));
  }
});
