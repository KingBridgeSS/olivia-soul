// Opt-in live check. Connects to the user's dsh_url; never launches/stops dsh.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import { DshHost } from '../src/main/dsh-host';
import { Tasks } from '../src/main/tasks';
import type { Preferences } from '../src/shared/types';

async function run() {
  const config = parseEnv(fs.readFileSync('.env', 'utf8'));
  const host = new DshHost(() => config.dsh_url || '');
  const preferences = { dshCwd: path.resolve(config.dsh_cwd || process.cwd()) } as Preferences;
  const tasks = new Tasks(host, () => preferences);
  tasks.beginCall('external-dsh-probe');
  try {
    await tasks.ensure();
    console.log('EXTERNAL_DSH_AUTH_AND_BASELINES_VERIFIED');
    const result = await tasks.execute({ id: randomUUID(), name: 'computer_task', action: 'start', context: '',
      goal: '这是 Soul 外部 dsh 连接回归测试。不要调用工具，不要读写文件，只回复：DSH_EXTERNAL_OK。'
    }, 'external-dsh-probe');
    assert.equal(result.success, true, result.text);
    const deadline = Date.now() + 90000;
    while (!['completed', 'failed', 'cancelled'].includes(tasks.records.at(-1)?.status || '')) {
      if (Date.now() > deadline) throw new Error('External dsh task timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(tasks.records.at(-1)?.status, 'completed', tasks.records.at(-1)?.detail || 'Missing task');
    assert.match(tasks.records.at(-1)?.runs.at(-1)?.response || '', /DSH_EXTERNAL_OK/);
    const list = await host.remote!.call('session/list', {});
    const session = list.items.find((v: any) => v.sessionId === tasks.records.at(-1)!.sessionId);
    assert.equal(path.resolve(session.cwd), preferences.dshCwd);
    console.log('EXTERNAL_DSH_TASK_COMPLETED_WITH_CONFIGURED_CWD');
  } finally { await tasks.shutdown(); }
  // The user-managed service must still be usable after Soul closes its connection.
  try { await host.ensure(); console.log('EXTERNAL_DSH_REMAINS_RUNNING'); }
  finally { host.disconnect(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
