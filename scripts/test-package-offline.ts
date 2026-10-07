// Packaging checks with fake credentials and a local dsh protocol fixture.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { _electron as electron, chromium } from 'playwright-core';
import { dshServer } from '../tests/helpers/dsh-server';

const env = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
for (const key of ['app_id', 'key', 'workspace_id', 'voice_id', 'user_id', 'dsh_url', 'gpu_enabled', 'gpu_url', 'dsh_cwd']) delete env[key];
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  const server = await dshServer();
  fs.mkdirSync('.cache', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('.cache/package-offline-'));
  const config = path.join(dir, 'config.env');
  fs.writeFileSync(config, `app_id=fake-app\nkey=fake-key\nworkspace_id=fake-space\ndsh_url=${server.url}\ngpu_enabled=false\n`);
  try {
    const unpacked = path.resolve('release/win-unpacked/Olivia Soul.exe');
    for (const importing of [true, false]) {
      const app = await electron.launch({ executablePath: unpacked, args: [`--user-data-dir=${dir}`, ...(importing ? ['--import-env', config] : [])], env });
      try {
        const page = await app.firstWindow();
        const state = await page.evaluate(() => window.soul.state());
        assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
        assert.equal(state.configured, true); assert.equal(state.connected, false);
        assert.equal(state.preferences.gpuEnabled, false);
        assert.equal(state.preferences.dshBaseUrl, server.base);
        assert.ok(!JSON.stringify(state).includes(server.token));
        assert.equal(await page.title(), 'Olivia Soul');
      } finally { await app.close(); }
    }
    assert.ok(!fs.readFileSync(path.join(dir, 'dsh.json'), 'utf8').includes(server.token));
    if (process.argv.includes('--unpacked-only')) {
      console.log('Unpacked import/restart, encrypted config and dsh isolation passed.');
      return;
    }
    const listener = net.createServer();
    await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(r => listener.close(() => r()));
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    const child = spawn(path.resolve(`release/Olivia-Soul-${version}-win-x64.exe`), [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`], { env, windowsHide: true, stdio: 'ignore' });
    let childError: Error | undefined; child.on('error', e => { childError = e; });
    try {
      const deadline = Date.now() + 60000;
      for (;;) {
        if (childError) throw childError;
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
        if (Date.now() > deadline) throw new Error('Portable extraction/start timeout');
        await wait(300);
      }
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        let page = browser.contexts()[0].pages().find(p => p.url().startsWith('file:'));
        while (!page && Date.now() < deadline) { await wait(100); page = browser.contexts()[0].pages().find(p => p.url().startsWith('file:')); }
        assert.ok(page); await page.waitForFunction(() => !!window.soul);
        const state = await page.evaluate(() => window.soul.state());
        assert.equal(state.preferences.gpuEnabled, false); assert.equal(state.configured, true);
        await (await browser.newBrowserCDPSession()).send('Browser.close').catch(() => {});
      } finally { await browser.close().catch(() => {}); }
    } finally {
      await wait(1200);
      if (child.exitCode === null && child.pid) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    assert.equal((await fetch(server.url, { redirect: 'manual' })).status, 303);
    console.log('Unpacked import/restart, encrypted config, portable extraction and external dsh survival passed; no cloud/GPU calls.');
  } finally { await server.close(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
