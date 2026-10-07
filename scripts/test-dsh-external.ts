// Electron lifecycle checks against a local protocol fixture; no dsh/model is launched.
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { dshServer } from '../tests/helpers/dsh-server';

const root = process.cwd(), exe = path.join(root, 'node_modules/electron/dist/electron.exe');
const env = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync('.cache', { recursive: true });
const runDir = fs.mkdtempSync(path.join(root, '.cache/external-dsh-'));
function fixture(name: string, url: string) {
  const dir = path.join(runDir, name); fs.mkdirSync(dir);
  const config = path.join(dir, 'config.env'), bootstrap = path.join(dir, 'bootstrap.cjs'), result = path.join(dir, 'result.json');
  fs.writeFileSync(config, `app_id=test-app\nkey=test-key\nworkspace_id=test-workspace\ndsh_url=${url}\ndsh_cwd=${root.replaceAll('\\', '/')}\ngpu_enabled=false\n`);
  fs.writeFileSync(bootstrap, `
    const fs = require('node:fs');
    const {app, dialog, BrowserWindow} = require('electron');
    const report = {dialogs: [], processCalls: []};
    const save = () => fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify(report));
    dialog.showErrorBox = (title, message) => { report.dialogs.push({title, message}); save(); };
    const exit = app.exit.bind(app);
    app.exit = code => { report.exitCode = code; report.windows = BrowserWindow.getAllWindows().length; save(); exit(code); };
    const cp = require('node:child_process');
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
      cp[name] = () => { report.processCalls.push(name); save(); throw new Error('Unexpected child process operation'); };
    }
    require(${JSON.stringify(path.join(root, 'dist/main/index.cjs'))});
  `);
  return { dir, config, bootstrap, result, args: [bootstrap, `--user-data-dir=${dir}`, '--import-env', config] };
}
async function failedStartup(name: string, url: string, expected: RegExp) {
  const f = fixture(name, url);
  const child = spawn(exe, f.args, { env, windowsHide: true, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${name} did not exit`)); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 1);
  const report = JSON.parse(fs.readFileSync(f.result, 'utf8'));
  assert.equal(report.dialogs.length, 1); assert.match(report.dialogs[0].message, expected);
  assert.equal(report.windows, 0); assert.deepEqual(report.processCalls, []);
  const token = new URL(url || 'http://localhost/').searchParams.get('token');
  if (token) assert.ok(!JSON.stringify(report).includes(token));
  console.log(`${name}: error dialog, exit 1, no window or child process`);
}
async function main() {
  await failedStartup('missing-url', '', /dsh_url/);
  await failedStartup('placeholder', 'http://127.0.0.1:8766/?token=这里填启动时输出的token', /占位/);
  const offline = await dshServer(); await offline.close();
  await failedStartup('offline', offline.url, /请先自行启动/);
  const html = await dshServer('html');
  try { await failedStartup('unrelated-service', html.url, /认证失败/); } finally { await html.close(); }
  const malformed = await dshServer('bad-ready');
  try { await failedStartup('incompatible-service', malformed.url, /协议检查失败/); } finally { await malformed.close(); }
  const server = await dshServer();
  try {
    await failedStartup('wrong-token', `${server.base}/?token=wrong-token`, /认证失败/);
    const f = fixture('connected', server.url);
    // Old installation records must not restore a launcher or expose old options.
    fs.writeFileSync(path.join(f.dir, 'preferences.json'), JSON.stringify({ dshEntry: 'missing-node', dshPort: 1, dshHome: 'missing-home', dshProfile: 'old', dshUrl: server.url }));
    fs.writeFileSync(path.join(f.dir, 'host.json'), JSON.stringify({ encrypted: 'stale-invalid-record' }));
    const app = await electron.launch({ executablePath: exe, args: f.args, env });
    try {
      const page = await app.firstWindow(); const state = await page.evaluate(() => window.soul.state());
      assert.equal(state.preferences.dshBaseUrl, server.base);
      assert.equal(path.resolve(state.preferences.dshCwd), root);
      assert.equal('dshPort' in state.preferences, false); assert.ok(!JSON.stringify(state).includes(server.token));
      assert.ok(server.calls.includes('session/list')); assert.equal(server.calls.includes('session/prompt'), false);
      assert.ok(!fs.readFileSync(path.join(f.dir, 'dsh.json'), 'utf8').includes(server.token));
      assert.ok(!fs.readFileSync(path.join(f.dir, 'preferences.json'), 'utf8').includes(server.token));
      assert.equal(fs.existsSync(path.join(f.dir, 'host-runner.cjs')), false);
      await app.evaluate(({ shell }) => { shell.openExternal = async url => { (globalThis as any).__opened = new URL(url).origin; }; });
      await page.locator('#dsh').click();
      for (let i = 0; i < 50 && !await app.evaluate(() => (globalThis as any).__opened); i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(await app.evaluate(() => (globalThis as any).__opened), server.base);
      await page.locator('#settings-toggle').click();
      await page.waitForFunction(base => (document.getElementById('dsh-url') as HTMLInputElement)?.value === base, server.base);
      assert.equal(await page.locator('#dsh-url').inputValue(), server.base);
      assert.equal(await page.locator('#dsh-url').getAttribute('readonly'), '');
      assert.equal(await page.locator('#dsh-entry,#dsh-home,#dsh-profile,#dsh-port').count(), 0);
      const restored = server.connectionCount;
      server.dropConnections();
      await page.waitForFunction(() => document.getElementById('error')?.textContent?.includes('dsh 连接中断'));
      await page.waitForFunction(() => !document.getElementById('error')?.textContent?.includes('dsh 连接中断'), undefined, { timeout: 15000 });
      assert.ok(server.connectionCount > restored);
    } finally { await app.close(); }
    const report = JSON.parse(fs.readFileSync(f.result, 'utf8'));
    assert.deepEqual(report.processCalls, []); assert.deepEqual(report.dialogs, []);
    assert.equal((await fetch(server.url, { redirect: 'manual' })).status, 303);
    // Packaged-style restart: load encrypted dsh.json without another .env import.
    const restarted = await electron.launch({ executablePath: exe, args: [f.bootstrap, `--user-data-dir=${f.dir}`, '--import-env'], env });
    try { const page = await restarted.firstWindow(); assert.equal((await page.evaluate(() => window.soul.state())).preferences.dshBaseUrl, server.base); }
    finally { await restarted.close(); }
    console.log('connected: startup preflight, terminal, secret storage, reconnect, external Host survival and restart passed');
  } finally { await server.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
