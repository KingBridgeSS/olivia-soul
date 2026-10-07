// Opt-in packaged lifecycle test against the user's already running dsh.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { DshRemote } from '../src/main/dsh-remote';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.resolve('.cache/package-task-'));
fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ micMuted: true, speakerMuted: true, gpuEnabled: false }));
const env = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  const url = parseEnv(fs.readFileSync('.env', 'utf8')).dsh_url!, remote = new DshRemote(new URL(url).origin);
  const marker = `SOUL_EXIT_${Date.now()}`;
  const options = { executablePath: path.resolve('release/win-unpacked/Olivia Soul.exe'), args: [`--user-data-dir=${dir}`, '--import-env', path.resolve('.env')], env };
  let sessionId = '';
  await remote.authenticate(url); await remote.connect();
  try {
    const instance = await electron.launch(options);
    try {
      const page = await instance.firstWindow();
      await page.locator('#call').click(); await page.waitForFunction(() => document.getElementById('call')?.title.includes('正在聆听'));
      await page.evaluate(marker => window.soul.text(`新建电脑测试任务：${marker}，使用 pwsh 执行 Start-Sleep -Seconds 60，不修改文件。`), marker);
      const until = Date.now() + 45000;
      while (!sessionId) {
        const list = await remote.call('session/list', {});
        const own = list.items.find((s: any) => s.running && s.title?.includes(marker));
        if (own) sessionId = own.sessionId;
        if (Date.now() > until) throw new Error('Packaged task submission timeout');
        await pause(100);
      }
      const state = await page.evaluate(() => window.soul.state()); assert.equal(state.tasks.length, 1);
      assert.equal(fs.existsSync(path.join(dir, 'tasks.json')), false);
    } finally { await instance.close(); }
    const list = await remote.call('session/list', {});
    assert.equal(list.items.find((s: any) => s.sessionId === sessionId)?.running, false);
    console.log('EXIT_CANCELS_TASK_WITHOUT_STOPPING_DSH');
    const restarted = await electron.launch({ ...options, args: [`--user-data-dir=${dir}`] });
    try {
      const page = await restarted.firstWindow(), state = await page.evaluate(() => window.soul.state());
      assert.deepEqual(state.tasks, []); assert.equal(state.connected, false);
      assert.equal(fs.existsSync(path.join(dir, 'tasks.json')), false);
      console.log('RESTART_HAS_NO_TASK_HISTORY');
    } finally { await restarted.close(); }
  } finally { remote.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
