import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright-core';
import { dshServer } from '../tests/helpers/dsh-server';

const root = process.cwd(), exe = path.join(root, 'node_modules/electron/dist/electron.exe');
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
// Never let a developer's core credentials override the fake configuration.
for (const key of ['app_id', 'key', 'workspace_id', 'voice_id', 'user_id', 'dsh_url', 'gpu_enabled', 'gpu_url', 'dsh_cwd']) delete env[key];
fs.mkdirSync('.cache', { recursive: true });
const run = fs.mkdtempSync(path.join(root, '.cache/first-run-'));
function fixture(name: string, config?: string) {
  const dir = path.join(run, name); fs.mkdirSync(dir);
  const report = path.join(dir, 'report.json'), bootstrap = path.join(dir, 'bootstrap.cjs');
  fs.writeFileSync(bootstrap, `
    const fs = require('node:fs');
    const { app, dialog, BrowserWindow } = require('electron');
    const report = { prompts: 0, errors: [] };
    dialog.showOpenDialog = async () => { report.prompts++; return ${JSON.stringify(config ? { canceled: false, filePaths: [config] } : { canceled: true, filePaths: [] })}; };
    dialog.showErrorBox = (_title, message) => report.errors.push(message);
    const exit = app.exit.bind(app);
    app.exit = code => { report.code = code; report.windows = BrowserWindow.getAllWindows().length; fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(report)); exit(code); };
    require(${JSON.stringify(path.join(root, 'dist/main/index.cjs'))});
  `);
  return { dir, report, bootstrap, args: [bootstrap, `--user-data-dir=${dir}`, '--import-env'] };
}
async function main() {
  const cancel = fixture('cancel');
  const child = spawn(exe, cancel.args, { env, windowsHide: true, stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('First-run cancellation did not exit')); }, 15000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', c => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(cancel.report, 'utf8')), { prompts: 1, errors: [], code: 0, windows: 0 });
  const server = await dshServer();
  try {
    const config = path.join(run, 'config.env');
    fs.writeFileSync(config, `app_id=fake-app\nkey=fake-key\nworkspace_id=fake-workspace\ndsh_url=${server.url}\nuser_id=amadeus-soul\n`);
    const accept = fixture('accept', config);
    // The dangling --import-env marks this as a packaged-style start; the dialog supplies the actual file.
    const app = await electron.launch({ executablePath: exe, args: [accept.bootstrap, `--user-data-dir=${accept.dir}`, '--import-env'], env });
    try {
      const page = await app.firstWindow();
      const state = await page.evaluate(() => window.soul.state());
      assert.equal(state.configured, true); assert.equal(state.preferences.gpuEnabled, false);
      assert.equal(state.preferences.dshBaseUrl, server.base);
      assert.ok(!JSON.stringify(state).includes(server.token));
      const stored = JSON.parse(fs.readFileSync(path.join(accept.dir, 'cloud.json'), 'utf8'));
      const user = await app.evaluate(({ safeStorage }, encoded) => JSON.parse(safeStorage.decryptString(Buffer.from(encoded, 'base64'))).userId, stored.encrypted);
      assert.equal(user, 'amadeus-soul');
      assert.equal(await app.evaluate(({ app }) => app.getName()), 'olivia-soul');
    } finally { await app.close(); }
    assert.equal(JSON.parse(fs.readFileSync(accept.report, 'utf8')).prompts, 1);
  } finally { await server.close(); }
  console.log('First-run cancel/import, default no-GPU, legacy memory identity and credential isolation passed.');
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
