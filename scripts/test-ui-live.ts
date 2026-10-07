import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

async function main() {
  const health: any = await (await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(5000) })).json();
  assert.ok(health.ready && !health.busy, 'GPU must be ready and unused for this live test');
  const dir = path.resolve(`.cache/ui-live-${process.pid}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ micMuted: true, speakerMuted: true, gpuEnabled: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${dir}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env });
  const page = await app.firstWindow(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.waitForFunction(() => !!window.soul);
    await page.evaluate(() => {
      const w = window as any; w.__rounds = []; w.__fallbacks = [];
      window.soul.onMedia(m => {
        if (m.type === 'begin') w.__rounds.push({ generation: m.generation, video: m.video, frames: 0, lastIndex: -1 });
        const r = w.__rounds.find((r: any) => r.generation === m.generation);
        if (r && m.type === 'frame') { r.frames++; r.lastIndex = m.index; }
        if (m.type === 'fallback') w.__fallbacks.push(m.generation);
      });
      const Native = window.AudioWorkletNode;
      w.AudioWorkletNode = class extends Native { constructor(c: AudioContext, n: string, o: any) { super(c, n, o); this.port.addEventListener('message', e => { const r = w.__rounds.find((r: any) => r.generation === e.data.generation); if (r && e.data.type === 'ended') { r.ended = true; r.samples = e.data.samples; } }); this.port.start(); } };
    });
    await page.locator('#call').click();
    await page.waitForFunction(() => document.getElementById('call')?.title.includes('正在聆听') && document.getElementById('call')?.title.includes('数字人就绪'), undefined, { timeout: 30000 });
    assert.equal(await page.locator('.portrait').getAttribute('data-mode'), 'idle');
    await page.evaluate(() => window.soul.text('请只说下面这段话，不要调用电脑工具：窗外的风很轻，桌上的热茶慢慢升起白雾。我们可以慢慢聊，等这句话说完，我会安静地陪着你。'));
    await page.waitForFunction(() => document.querySelector('.portrait')?.getAttribute('data-mode') === 'speaking', undefined, { timeout: 30000 });
    await page.screenshot({ path: 'test-results/ui-live-speaking.png' });
    await page.waitForFunction(() => (window as any).__rounds.some((r: any) => r.ended), undefined, { timeout: 60000 });
    const round = await page.evaluate(() => (window as any).__rounds.find((r: any) => r.ended));
    assert.ok(round.video && round.samples > 24000 && round.lastIndex >= Math.ceil(round.samples / 960) - 1);
    assert.equal(await page.evaluate(() => (window as any).__fallbacks.length), 0);
    await page.waitForFunction(() => document.querySelector('.portrait')?.getAttribute('data-mode') === 'idle' && getComputedStyle(document.getElementById('video')!).opacity === '0');
    assert.equal(await page.evaluate(() => (document.getElementById('idle') as HTMLVideoElement).paused), false);
    await page.screenshot({ path: 'test-results/ui-live-ended.png' });
    await page.evaluate(() => window.soul.hide());
    await page.waitForFunction(() => (document.getElementById('idle') as HTMLVideoElement).paused);
    const released: any = await (await fetch('http://127.0.0.1:8765/health')).json(); assert.equal(released.busy, false);
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], ''));
    await page.waitForFunction(() => !(document.getElementById('idle') as HTMLVideoElement).paused);
    await page.locator('#call').click();
    await page.waitForFunction(() => !document.getElementById('call')?.classList.contains('connected'));
    assert.equal(await page.locator('.portrait').getAttribute('data-mode'), 'idle');
    assert.deepEqual(errors, []);
    fs.writeFileSync('test-results/ui-live.json', JSON.stringify({ ...round, audioSeconds: round.samples / 24000, idleAfterActualAudioEnd: true, hiddenIdlePaused: true, hiddenGpuReleased: true, idleAfterHangup: true }, null, 2));
    console.log('LIVE_CLOUD_GPU_AUDIO_TO_IDLE_VERIFIED', JSON.stringify(round));
  } finally { await app.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
