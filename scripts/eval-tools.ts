import fs from 'node:fs';
import { loadEnvFile } from 'node:process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LangfuseClient } from '@langfuse/client';
import { initTracing, shutdownTracing } from '../src/main/tracing';
import { taskToolSchema } from '../src/shared/task-tools';
import { runScenario, scoreScenario, validateScenario, type Scenario, type ScenarioInput, type Expectation } from './eval-tools-lib';

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => { const at = args.indexOf(name); if (at < 0) return fallback; if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing ${name}`); return args[at + 1]; };
  const seed = JSON.parse(fs.readFileSync(option('--file', 'evals/tool-cases.json'), 'utf8')) as Scenario[];
  seed.forEach(validateScenario);
  if (new Set(seed.map(s => s.id)).size !== seed.length) throw new Error('Duplicate scenario IDs');
  if (args.includes('--check')) { console.log(`Validated ${seed.length} scenarios; no API calls.`); return; }
  if (fs.existsSync('.env')) loadEnvFile('.env');
  if (!process.env.LANGFUSE_BASE_URL || !process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) throw new Error('请先 npm run langfuse:up，或在 .env 配置 Langfuse');
  const client = new LangfuseClient({ baseUrl: process.env.LANGFUSE_BASE_URL, publicKey: process.env.LANGFUSE_PUBLIC_KEY, secretKey: process.env.LANGFUSE_SECRET_KEY });
  const datasetName = option('--dataset', 'soul-tool-calling-v1');
  try {
    if (args.includes('--seed')) {
      const configs = await client.api.scoreConfigs.get();
      for (const [name, description] of Object.entries({ tool_correct_manual: '人工判断工具选择、目标任务、参数及用户约束是否正确', reply_correct: '人工判断回复是否忠实于工具结果，尤其是 accepted 不等于 completed' })) {
        if (!configs.data.some(c => c.name === name && !c.isArchived)) await client.api.scoreConfigs.create({ name, dataType: 'BOOLEAN', description });
      }
      await client.api.datasets.create({ name: datasetName, description: 'Soul 工具决策基线；真实阿里云 + 内存任务表；最后一条消息参与评分。' });
      for (const s of seed) await client.dataset.createItem({ id: createHash('sha256').update(`${datasetName}:${s.id}`).digest('hex'), datasetName,
        input: s.input, expectedOutput: s.expectedOutput, metadata: { ...s.metadata, caseId: s.id } });
      console.log(`Imported ${seed.length} cases into ${datasetName}.`); return;
    }
    const config = { appId: process.env.app_id || '', key: process.env.key || '', workspaceId: process.env.workspace_id || '', voiceId: process.env.voice_id };
    if (!config.appId || !config.key || !config.workspaceId) throw new Error('.env 缺少阿里云 app_id/key/workspace_id');
    process.env.LANGFUSE_ENABLED = 'true'; process.env.LANGFUSE_TRACING_ENVIRONMENT = 'evaluation';
    let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(); } catch {}
    if (!initTracing()) throw new Error('Langfuse tracing initialization failed');
    const dataset = await client.dataset.get(datasetName);
    let items = dataset.items.filter(i => i.status === 'ACTIVE').map(i => ({ ...i, metadata: i.metadata as Record<string, unknown> | undefined }));
    const caseId = option('--case', '');
    if (caseId) items = items.filter(i => i.metadata?.caseId === caseId);
    const limit = Number(option('--limit', String(items.length)));
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
    items = items.slice(0, limit);
    if (!items.length) throw new Error('No matching dataset cases');
    for (const item of items) validateScenario({ id: item.id, input: item.input, expectedOutput: item.expectedOutput, metadata: { category: item.metadata?.category || 'manual' } });
    console.log(`Running ${items.length} cases sequentially against Aliyun; dsh is not used.`);
    const result = await client.experiment.run({ name: option('--name', 'baseline'), data: items, maxConcurrency: 1,
      metadata: { commit, cloudVersion: process.env.SOUL_CLOUD_VERSION || 'unrecorded', schemaHash: createHash('sha256').update(JSON.stringify(taskToolSchema)).digest('hex'),
        codeHash: createHash('sha256').update(['src/main/aliyun.ts', 'src/main/aliyun-turn.ts', 'src/main/tool-flow.ts', 'src/main/tool-image.ts', 'src/shared/commands.ts', 'scripts/eval-tools-lib.ts', 'scripts/eval-tools.ts'].map(p => fs.readFileSync(p, 'utf8')).join('\n')).digest('hex'),
        ...(items.some(i => (i.input as ScenarioInput).screenshots) ? { fixtureHash: createHash('sha256').update(fs.readFileSync('evals/fixtures/screen-a.png')).update(fs.readFileSync('evals/fixtures/screen-b.png')).digest('hex') } : {}),
        datasetHash: createHash('sha256').update(JSON.stringify(items.map(i => [i.input, i.expectedOutput]))).digest('hex'), mode: 'text-with-fake-tools' },
      task: async ({ input, metadata }) => { console.log(`Case: ${(metadata as Record<string, unknown> | undefined)?.caseId || 'manual'}`); return runScenario(input as ScenarioInput, config); },
      evaluators: [async ({ output, expectedOutput }) => scoreScenario(output, expectedOutput as Expectation)],
    });
    const report = await result.format({ includeItemResults: true });
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync(`test-results/eval-${option('--name', 'baseline').replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`, report);
    fs.writeFileSync(`test-results/eval-${option('--name', 'baseline').replace(/[^a-zA-Z0-9_-]/g, '_')}.json`, JSON.stringify(result.itemResults, null, 2));
    console.log(report);
  } finally { await client.flush(); await shutdownTracing(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
