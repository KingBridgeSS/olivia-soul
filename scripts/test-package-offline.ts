// Packaging checks with fake credentials and a local dsh protocol fixture.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { _electron as electron, chromium } from 'playwright-core';
import WebSocket from 'ws';
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
      console.log(`Launching unpacked app (${importing ? 'import' : 'restart'}).`);
      const app = await electron.launch({ executablePath: unpacked, args: [`--user-data-dir=${dir}`, ...(importing ? ['--import-env', config] : [])], env });
      const appProcess = app.process();
      try {
        const page = await app.firstWindow();
        const state = await page.evaluate(() => window.soul.state());
        assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
        assert.equal(state.configured, true); assert.equal(state.connected, false);
        assert.equal(state.preferences.gpuEnabled, false);
        assert.equal(state.preferences.dshBaseUrl, server.base);
        assert.ok(!JSON.stringify(state).includes(server.token));
        assert.equal(await page.title(), 'Olivia Soul');
        console.log('Packaged window state verified.');
      } finally {
        await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 100); });
        const deadline = Date.now() + 10000;
        while (appProcess.exitCode === null && appProcess.signalCode === null && Date.now() < deadline) await wait(100);
        if (appProcess.exitCode === null && appProcess.signalCode === null) { appProcess.kill(); throw new Error('Packaged app failed to quit'); }
        await Promise.race([app.close().catch(() => {}), wait(1000)]);
      }
    }
    console.log('Packaged import and encrypted restart passed.');
    assert.ok(!fs.readFileSync(path.join(dir, 'dsh.json'), 'utf8').includes(server.token));
    if (process.argv.includes('--unpacked-only')) {
      console.log('Unpacked import/restart, encrypted config and dsh isolation passed.');
      return;
    }
    const listener = net.createServer();
    await new Promise<void>(r => listener.listen(0, '127.0.0.1', r));
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(r => listener.close(() => r()));
    const inspectListener = net.createServer();
    await new Promise<void>(r => inspectListener.listen(0, '127.0.0.1', r));
    const inspectPort = (inspectListener.address() as net.AddressInfo).port;
    await new Promise<void>(r => inspectListener.close(() => r()));
    const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    const child = spawn(path.resolve(`release/Olivia-Soul-${version}-win-x64.exe`), [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectPort}`], { env, windowsHide: true, stdio: 'ignore' });
    let childError: Error | undefined; child.on('error', e => { childError = e; });
    try {
      const deadline = Date.now() + 60000;
      for (;;) {
        if (childError) throw childError;
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
        if (Date.now() > deadline) throw new Error('Portable extraction/start timeout');
        await wait(300);
      }
      console.log('Portable extracted; connecting to its local debugger.');
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        let page = browser.contexts()[0].pages().find(p => p.url().startsWith('file:'));
        while (!page && Date.now() < deadline) { await wait(100); page = browser.contexts()[0].pages().find(p => p.url().startsWith('file:')); }
        assert.ok(page); await page.waitForFunction(() => !!window.soul);
        const state = await page.evaluate(() => window.soul.state());
        assert.equal(state.preferences.gpuEnabled, false); assert.equal(state.configured, true);
        console.log('Portable window and configuration passed.');
        // Request the native app.quit path; closing a window only hides this tray app.
        const targets: any[] = await (await fetch(`http://127.0.0.1:${inspectPort}/json/list`)).json();
        const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { ws.terminate(); reject(new Error('Native quit debugger timeout')); }, 10000);
          ws.once('error', e => { clearTimeout(timer); reject(e); });
          ws.once('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'setTimeout(() => require("electron").app.quit(), 100)' } })));
          ws.on('message', data => { const result = JSON.parse(data.toString()); if (result.id === 1) { clearTimeout(timer); ws.close(); result.result?.exceptionDetails ? reject(new Error('Native quit evaluation failed')) : resolve(); } });
        });
      } finally { await Promise.race([browser.close().catch(() => {}), wait(3000)]); }
    } finally {
      await wait(1200);
      if (child.exitCode === null && child.pid) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    assert.equal((await fetch(server.url, { redirect: 'manual' })).status, 303);
    console.log('Unpacked import/restart, encrypted config, portable extraction and external dsh survival passed; no cloud/GPU calls.');
  } finally { await server.close(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
