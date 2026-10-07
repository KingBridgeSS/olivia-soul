import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CloudAdmin, environment } from './cloud-api';
import { taskTools, taskToolSchema } from '../src/shared/task-tools';

async function configure() {
  for (const tool of taskTools) assert.ok(tool.description.length <= 256, `${tool.name}: 云端工具描述最多 256 个字符`);
  fs.mkdirSync('docs', { recursive: true });
  fs.writeFileSync('docs/computer-task.json', JSON.stringify(taskToolSchema, null, 2) + '\n');
  if (process.argv.includes('--schema-only')) return;
  const api = new CloudAdmin(), e = environment(), appId = e.app_id;
  const detail = () => api.call('mmcAppService/detail', { mmcAppQueryDTO: { appId } });
  const bindings = () => api.call('mmcAppBindService/queryBinding', { appBindQueryDTO: { appId } });
  const before = await detail(); assert.equal(before.workspaceId, e.workspace_id);
  const fingerprint = (v: any) => createHash('sha256').update(JSON.stringify([v.prompt, v.modelConfig, v.conversationConfig, v.appConfig])).digest('hex');
  const hash = fingerprint(before);
  const list = await api.call('mmcDomainService/paging', { domainQueryDTO: { source: 'MULTI_MODAL', appId, domainName: 'olivia_soul', pageNo: 1, pageSize: 100 } });
  let domain = list.data.find((v: any) => v.domainName === 'olivia_soul');
  if (!domain) domain = await api.call('mmcDomainService/save', { mmDomainInfoDTO: { source: 'MULTI_MODAL', appId, domainName: 'olivia_soul', description: 'Olivia Soul 桌面电脑任务' } });
  const getTools = () => api.call('mmcToolService/paging', { toolQueryDTO: { source: 'MULTI_MODAL', appId, domainId: domain.id, pageNo: 1, pageSize: 999 } });
  const existing = (await getTools()).data;
  await api.call('mmcToolService/saveBatch', { mmToolInfoDTOList: taskTools.map(tool => ({ ...existing.find((v: any) => v.name === tool.name), ...tool, source: 'MULTI_MODAL', appId, domainId: domain.id })) });
  const saved = (await getTools()).data;
  const selected = taskTools.map(tool => {
    const item = saved.find((v: any) => v.name === tool.name); assert.ok(item?.toolId, `Missing tool: ${tool.name}`);
    assert.deepEqual(item.params.map((p: any) => [p.name, p.required]), tool.params.map(p => [p.name, p.required]), `Schema mismatch: ${tool.name}`);
    return { toolCode: item.toolId, issuerConfig: { instruction: tool.name, replyMode: 'ON_EXECUTION_RESULT' } };
  });
  const bind = await bindings(), config = structuredClone(bind.config);
  const current = config.domains.find((v: any) => v.type === 'CUSTOM' && v.domainId === domain.id);
  const domainBinding = { ...current, domainId: domain.id, domainCode: domain.domainCode, domainName: 'olivia_soul', type: 'CUSTOM', tools: [...(current?.tools || []).filter((v: any) => !selected.some(s => s.toolCode === v.toolCode)), ...selected] };
  config.domains = [...config.domains.filter((v: any) => !(v.type === 'CUSTOM' && v.domainId === domain.id)), domainBinding];
  await api.call('mmcAppBindService/binding', { appBindingRequest: { ...config, appId } });
  assert.equal(fingerprint(await detail()), hash, 'Existing app configuration changed');
  await api.call('mmcPublishService/publishApp', { publishRequest: { appId, description: `Soul tools: ${taskTools.map(t => t.name).join(', ')}` } });
  const after = await detail(), check = await bindings();
  assert.equal(fingerprint(after), hash);
  for (const s of selected) assert.ok(check.config.domains.some((d: any) => d.domainId === domain.id && d.tools.some((t: any) => t.toolCode === s.toolCode)));
  console.log(JSON.stringify({ configured: true, published: true, tools: taskTools.map(t => t.name), appName: after.appName, version: after.publishVersion, existingSettingsPreserved: true }));
}
configure().catch(e => { console.error(e.message); process.exitCode = 1; });
