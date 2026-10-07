import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { CloudAdmin, environment } from './cloud-api';
import { runScenario, scoreScenario, validateScenario, type Scenario } from './eval-tools-lib';
import { initTracing, shutdownTracing } from '../src/main/tracing';
import Client from '@alicloud/sfmmultimodalapp20250909';
import { memoryConfig, runMemory } from '../src/main/memory';

async function main() {
  const phase = process.argv[2];
  if (!phase || !/^[a-z0-9-]+$/.test(phase)) throw new Error('用法：npx tsx scripts/probe-memory-routing.ts 标签 [用例JSON路径]');
  loadEnvFile('.env');
  const e = { ...environment(), ...process.env };
  const detail = await new CloudAdmin().call('mmcAppService/detail', { mmcAppQueryDTO: { appId: e.app_id } });
  const caseFile = process.argv[3] || 'evals/memory-routing-cases.json';
  const cases: Scenario[] = JSON.parse(fs.readFileSync(caseFile, 'utf8')); cases.forEach(validateScenario);
  const config = { appId: e.app_id!, key: e.key!, workspaceId: e.workspace_id!, voiceId: e.voice_id };
  process.env.LANGFUSE_TRACING_ENVIRONMENT = 'evaluation';
  process.env.LANGFUSE_RELEASE = `memory-routing-${phase}-v${detail.publishVersion}`;
  process.env.SOUL_CLOUD_VERSION = String(detail.publishVersion);
  const tracing = initTracing();
  const memory = new Client(memoryConfig(e));
  const report: any = { phase, caseFile, version: detail.publishVersion, startedAt: new Date().toISOString(), tracing, cases: [] };
  fs.mkdirSync('test-results', { recursive: true });
  const outputPath = `test-results/memory-routing-${phase}.json`;
  if (fs.existsSync(outputPath)) throw new Error(`报告已存在：${outputPath}`);
  const save = () => fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  try {
    for (const c of cases) {
      const user = `soul-eval-${randomUUID().slice(0, 24)}`;
      console.log(`Running ${phase}: ${c.id} (${user})`);
      const output = await runScenario(c.input, { ...config, userId: user });
      const scores = scoreScenario(output, c.expectedOutput);
      if (c.expectedOutput.noTools) scores.push({ name: 'no_tools_all_turns', value: Number(!output.transportError && output.turns.every(t => !t.calls.length && !t.parseIssues.length)), dataType: 'BOOLEAN', comment: '记忆场景检查每轮，避免首轮误调被末轮正确回答掩盖' });
      report.cases.push({ id: c.id, user, completedAt: new Date().toISOString(), output, scores }); save();
      console.log(JSON.stringify({ id: c.id, passed: scores.every(s => s.value === 1), calls: output.turns.flatMap(t => t.calls.map(c => c.name)), reply: output.turns.at(-1)?.reply, transportError: output.transportError }));
    }
    report.memories = [];
    for (const c of report.cases.filter((c: any) => ['interview-1', 'preference', 'remember-plan'].includes(c.id))) {
      for (const project of ['observation_project', 'profile_project'] as const) {
        try { report.memories.push({ id: c.id, user: c.user, checkedAt: new Date().toISOString(), result: await runMemory(memory, config, { command: 'list', project, page: 1, user: c.user }) }); }
        catch (e) { report.memories.push({ id: c.id, project, error: (e as Error).message }); }
      }
    }
    save(); console.log(`Saved ${outputPath}`);
  } finally { await shutdownTracing(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
