import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { GpuClient } from '../src/main/gpu';
const dir = path.resolve('.cache/package-userdata'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ micMuted: true, speakerMuted: true }));
const env = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const exe = path.resolve('release/win-unpacked/Olivia Soul.exe');
async function launch(importConfig: boolean) {
  return electron.launch({ executablePath: exe, args: [`--user-data-dir=${dir}`, ...(importConfig ? ['--import-env', path.resolve('.env')] : [])], env, timeout: 30000 });
}
async function main() {
  let app = await launch(true); let page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.waitForFunction(() => !!(window as any).soul);
    const info = await app.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, dir: app.getPath('userData'), focused: BrowserWindow.getAllWindows()[0].isFocused(), throttle: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling() }));
    assert.ok(info.packaged); assert.equal(info.dir.toLowerCase(), dir.toLowerCase()); assert.equal(info.throttle, false);
    const state = await page.evaluate(() => (window as any).soul.state()); assert.ok(state.configured); assert.equal(state.connected, false);
    const credentials = parseEnv(fs.readFileSync('.env', 'utf8'));
    const rendererState = JSON.stringify(state), stored = fs.readFileSync(path.join(dir, 'cloud.json'), 'utf8');
    for (const key of ['key', 'app_id', 'workspace_id']) { assert.ok(!rendererState.includes(credentials[key]!)); assert.ok(!stored.includes(credentials[key]!)); }
    assert.ok(JSON.parse(stored).encrypted); assert.equal(await page.evaluate(() => typeof (window as any).require), 'undefined');
    await page.screenshot({ path: 'test-results/package-white.png' });
    for (const id of ['call','mic','speaker','hide','settings-toggle','text-toggle','dsh']) { const e = page.locator('#'+id); assert.ok(await e.getAttribute('aria-label')); assert.ok(await e.locator('svg').count()); const b = await e.boundingBox(); assert.ok(b && b.y+b.height <= (await page.evaluate(()=>innerHeight))+1, `${id} clipped`); }
    console.log('PACKAGED_STARTUP_ENCRYPTION_UI_VERIFIED', JSON.stringify({ focusedOnLaunch: info.focused }));
    if (process.argv.includes('--ui-only')) return;
    // Observe the real browser audio graph without sending synthetic playback events.
    await page.evaluate(() => {
      const w = window as any; w.__events = []; w.__tracks = []; w.__states = []; w.soul.onState((s:any)=>w.__states.push({cloud:s.cloud,connected:s.connected,error:s.error}));
      const Audio = window.AudioContext; w.AudioContext = class extends Audio { constructor(o: any) { super(o); w.__audio = this; } };
      const Worklet = window.AudioWorkletNode; w.AudioWorkletNode = class extends Worklet { constructor(c: AudioContext,n:string,o:any) { super(c,n,o); this.port.addEventListener('message',e=>{if(e.data.type)w.__events.push(e.data)}); this.port.start(); } };
      const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async constraints => { const s = await get(constraints); w.__tracks.push(...s.getTracks()); return s; };
    });
    await page.locator('#call').click(); await page.waitForFunction(() => document.getElementById('call')?.title.includes('正在聆听'), { timeout: 30000 });
    assert.equal(await page.evaluate(() => (window as any).__tracks.every((t:MediaStreamTrack)=>!t.enabled)), true);
    await page.evaluate(() => (window as any).soul.text('请用两句话描述安静的房间，不要调用电脑工具。'));
    await page.waitForFunction(() => (window as any).__events.some((e:any)=>e.type==='started'), { timeout: 30000 });
    const cut = await page.evaluate(() => (window as any).__events.length);
    await page.evaluate(() => (window as any).soul.hide());
    await delay(1200);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    const health:any = await (await fetch('http://127.0.0.1:8765/health')).json(); assert.equal(health.busy, false);
    await page.waitForFunction((n:number)=>(window as any).__events.slice(n).some((e:any)=>e.type==='progress'&&e.samples>0), cut, { timeout: 15000 });
    await page.waitForFunction(() => (window as any).__events.some((e:any)=>e.type==='ended'), { timeout: 30000 });
    assert.equal((await page.evaluate(() => (window as any).soul.state())).connected, true);
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], '')); await delay(1000);
    await page.waitForFunction(() => document.getElementById('call')?.title.includes('数字人就绪'), { timeout: 15000 });
    console.log('HIDE_AUDIO_CONTINUES_GPU_RELEASE_RESTORE_VERIFIED');
    await page.locator('#call').click();
    await page.waitForFunction(() => (window as any).__audio.state==='closed'&&(window as any).__tracks.every((t:MediaStreamTrack)=>t.readyState==='ended'));
    console.log('REAL_MIC_MUTE_AND_DEVICE_RELEASE_VERIFIED');
    const busy = new GpuClient(); busy.on('fallback',()=>{}); await busy.connect('http://127.0.0.1:8765');
    try {
      await page.locator('#call').click();
      await page.waitForFunction(() => document.getElementById('call')?.title.includes('正在聆听') && document.getElementById('call')?.title.includes('待机画面'), { timeout: 30000 });
      const before = await page.evaluate(() => (window as any).__events.length);
      await page.evaluate(() => (window as any).soul.text('请只说一句：语音正常。不要调用电脑工具。'));
      await page.waitForFunction((n:number)=>(window as any).__events.slice(n).some((e:any)=>e.type==='ended'), before, { timeout: 30000 });
      console.log('GPU_BUSY_STATIC_VOICE_VERIFIED');
      await page.locator('#call').click();
    } finally { busy.close(); }
    assert.deepEqual(errors, []);
  } catch (e) { console.log('PACKAGE_DIAGNOSTICS', await page.evaluate(() => ({states:(window as any).__states?.slice(-8),error:document.getElementById('error')?.textContent}))); throw e; } finally { await app.close(); }
  app = await launch(false); page = await app.firstWindow();
  try { const s = await page.evaluate(() => (window as any).soul.state()); assert.ok(s.configured); assert.equal(s.connected, false); console.log('PACKAGED_RESTART_ENCRYPTED_CONFIG_VERIFIED'); }
  finally { await app.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
