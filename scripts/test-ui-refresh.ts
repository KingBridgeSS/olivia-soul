import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = path.resolve(`.cache/ui-refresh-${process.pid}`);
fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync('test-results', { recursive: true });
fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ micMuted: true, speakerMuted: true, gpuEnabled: false }));
const env = Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${dir}`, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env });
  const page = await app.firstWindow(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.waitForFunction(() => !!window.soul);
    const initial = await page.evaluate(() => window.soul.state());
    // Test-only handlers: no cloud call, GPU connection, dsh task or external browser.
    await app.evaluate(({ ipcMain, BrowserWindow }, initial) => {
      const t = (globalThis as any).__ui = { state: initial, cancels: 0, opens: 0, cancelledId: '' };
      for (const name of ['state', 'start', 'stop', 'cancel', 'dsh']) ipcMain.removeHandler(`soul:${name}`);
      ipcMain.handle('soul:state', () => t.state);
      ipcMain.handle('soul:start', () => { t.state = { ...t.state, connected: true, cloud: 'Listening', video: '数字人就绪' }; BrowserWindow.getAllWindows()[0].webContents.send('soul:state', t.state); });
      ipcMain.handle('soul:stop', () => { t.state = { ...t.state, connected: false, cloud: 'Disconnected' }; BrowserWindow.getAllWindows()[0].webContents.send('soul:state', t.state); });
      ipcMain.handle('soul:cancel', (_, id) => { t.cancels++; t.cancelledId = id; }); ipcMain.handle('soul:dsh', () => { t.opens++; });
    }, initial);
    const emitState = async (state: any) => { await app.evaluate(({ BrowserWindow }, state) => { (globalThis as any).__ui.state = state; BrowserWindow.getAllWindows()[0].webContents.send('soul:state', state); }, state); await pause(80); };
    await page.waitForFunction(() => document.querySelector('.portrait')?.getAttribute('data-mode') === 'idle' && !(document.getElementById('idle') as HTMLVideoElement).paused);
    assert.equal(await page.locator('#conversation').isVisible(), false);
    assert.equal(await page.locator('#connection, #video-status').count(), 0);
    assert.equal(await page.locator('#text').getAttribute('placeholder'), null);
    // No brand wording anywhere in the window, and the caption slot exists from the first paint.
    assert.equal(await page.locator('.brand').count(), 0);
    assert.doesNotMatch(await page.locator('main').innerText(), /Amadeus|Soul/i);
    // Default window size, and a width-limited portrait that ignores leftover vertical space.
    const launch = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, ratio: devicePixelRatio, portrait: document.querySelector('.portrait')!.getBoundingClientRect().width }));
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
    console.log('DEFAULT_WINDOW_AND_PORTRAIT_SIZE', JSON.stringify({ size, ...launch }));
    // Windows grid rounding leaves fractional CSS pixels here, so allow one pixel of slack.
    assert.equal(size[0], 320); assert.ok(size[1] >= 505 && size[1] <= 512, `window size ${size}`);
    assert.equal(launch.w, 320); assert.ok(launch.h >= 505, `content height ${launch.h}`);
    assert.ok(Math.abs(launch.portrait - 294) <= 1, `portrait width ${launch.portrait}`);
    assert.equal(await page.evaluate(() => document.getElementById('conversation')!.getBoundingClientRect().height), 65);
    await page.screenshot({ path: 'test-results/ui-idle.png', omitBackground: true });
    if (process.argv.includes('--full-idle')) {
      const duration = await page.evaluate(() => { const idle = document.getElementById('idle') as HTMLVideoElement; idle.currentTime = 0; return idle.duration; });
      assert.ok(duration >= 60); const started = Date.now(); let peak = 0, looped = false, lastLog = 0;
      while (Date.now() - started < (duration + 20) * 1000) {
        const playback = await page.evaluate(() => { const v = document.getElementById('idle') as HTMLVideoElement; return { time: v.currentTime, paused: v.paused, error: v.error?.code, decoded: v.getVideoPlaybackQuality().totalVideoFrames }; });
        assert.equal(playback.paused, false); assert.equal(playback.error, undefined);
        if (peak >= duration - 1 && playback.time < 1) { looped = true; break; }
        peak = Math.max(peak, playback.time);
        if (peak - lastLog >= 20) { lastLog = peak; console.log('IDLE_PLAYBACK_SECONDS', peak.toFixed(1)); }
        await pause(200);
      }
      assert.ok(looped && peak >= 60, 'full idle clip must play and loop at normal speed');
      fs.writeFileSync('test-results/idle-playback.json', JSON.stringify({ duration, fullLoop: true, observedSeconds: peak, wallSeconds: (Date.now() - started) / 1000 }, null, 2));
    }
    await page.evaluate(() => { const idle = document.getElementById('idle') as HTMLVideoElement; idle.currentTime = idle.duration - .15; });
    await page.waitForFunction(() => (document.getElementById('idle') as HTMLVideoElement).currentTime < 2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide()); await pause(300);
    assert.equal(await page.evaluate(() => (document.getElementById('idle') as HTMLVideoElement).paused), true);
    const stopped = await page.evaluate(() => (document.getElementById('idle') as HTMLVideoElement).currentTime); await pause(300);
    assert.equal(await page.evaluate(() => (document.getElementById('idle') as HTMLVideoElement).currentTime), stopped);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.waitForFunction(() => !(document.getElementById('idle') as HTMLVideoElement).paused);
    console.log('LOCAL_IDLE_LOOP_HIDE_RESUME_VERIFIED');

    await page.locator('#task-toggle').click(); assert.ok(await page.locator('#task-empty').isVisible()); await page.keyboard.press('Escape');
    const task = { id: 'ui-fixture', title: '整理项目资料', detail: '正在检查文件目录。', status: 'running', manual: false };
    await emitState({ ...initial, tasks: [task, { ...task, id: 'second-task', title: '第二项任务' }] }); assert.equal(await page.locator('#task').isVisible(), false);
    const before = await page.locator('.portrait').boundingBox();
    await page.locator('#task-toggle').click(); assert.deepEqual(await page.locator('.portrait').boundingBox(), before);
    assert.equal(await page.locator('#task-select option').count(), 2);
    await page.locator('#task-select').selectOption(task.id);
    await page.locator('#cancel').click(); await page.locator('#task-open').click();
    assert.deepEqual(await app.evaluate(() => ({ cancels: (globalThis as any).__ui.cancels, opens: (globalThis as any).__ui.opens })), { cancels: 1, opens: 1 });
    assert.equal(await app.evaluate(() => (globalThis as any).__ui.cancelledId), task.id);
    await page.locator('#task-close').click();
    const completed = { ...initial, tasks: [{ ...task, status: 'completed', detail: '项目资料已经整理完成。' }] };
    await emitState(completed); assert.equal(await page.locator('#task').isVisible(), false); assert.ok(await page.locator('#task-toggle').evaluate(e => e.classList.contains('unread')));
    await page.locator('#task-toggle').click(); assert.equal(await page.locator('#cancel').isDisabled(), true);
    await page.screenshot({ path: 'test-results/ui-task.png', omitBackground: true });
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#task-toggle').evaluate(e => e.classList.contains('unread')), false);
    await emitState(completed); assert.equal(await page.locator('#task-toggle').evaluate(e => e.classList.contains('unread')), false);
    await page.locator('#task-toggle').click(); await page.locator('#settings-toggle').click(); assert.equal(await page.locator('#task').isVisible(), false);
    await page.locator('#task-toggle').click(); assert.equal(await page.locator('#settings').isVisible(), false);
    await page.locator('#text-toggle').click(); assert.equal(await page.locator('#task').isVisible(), false); await page.locator('#text-toggle').click();
    await page.locator('#dsh').click(); assert.equal(await app.evaluate(() => (globalThis as any).__ui.opens), 2);
    for (const size of [[280, 360], [320, 440], [400, 500]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), size);
      await emitState({ ...initial, heard: '', subtitle: '', error: '' });
      const empty = await page.locator('.portrait').boundingBox();
      await emitState({ ...initial, heard: '用户的真实提问', subtitle: '这是保留的真实回复字幕。'.repeat(8), error: '测试错误提示', tasks: [{ ...task, detail: '很长的任务结果。'.repeat(200) }] });
      assert.deepEqual(await page.locator('.portrait').boundingBox(), empty, `portrait moved at ${size[0]}x${size[1]}`);
      await page.locator('#task-toggle').click();
      const layout = await page.evaluate(() => ({ height: innerHeight, scroll: document.documentElement.scrollHeight, buttons: ['call', 'mic', 'speaker', 'task-toggle', 'text-toggle', 'dsh'].map(id => { const r = document.getElementById(id)!.getBoundingClientRect(); return r.bottom <= innerHeight && r.right <= innerWidth && r.top >= 0; }) }));
      assert.equal(layout.height, layout.scroll); assert.ok(layout.buttons.every(Boolean));
      await page.keyboard.press('Escape');
    }
    console.log('TASK_POPOVER_BADGE_ACTIONS_COMPACT_LAYOUT_VERIFIED');
    // Spoken text, error messages and the text form must neither resize nor move the portrait.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(320, 505));
    await emitState({ ...initial, heard: '', subtitle: '' });
    const idlePortrait = await page.locator('.portrait').boundingBox();
    await emitState({ ...initial, heard: '用户的真实提问', subtitle: '这是保留的真实回复字幕。'.repeat(8), error: '测试错误提示' });
    assert.deepEqual(await page.locator('.portrait').boundingBox(), idlePortrait);
    assert.equal(await page.evaluate(() => document.getElementById('conversation')!.getBoundingClientRect().height), 65);
    await page.locator('#text-toggle').click();
    assert.deepEqual(await page.locator('.portrait').boundingBox(), idlePortrait);
    await page.locator('#text-toggle').click();
    await emitState({ ...initial, heard: '', subtitle: '', error: '' });
    assert.deepEqual(await page.locator('.portrait').boundingBox(), idlePortrait);
    console.log('FIXED_PORTRAIT_AND_CAPTION_SLOT_VERIFIED');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(320, 440)); await emitState(initial);

    await page.evaluate(() => {
      const w = window as any; w.__playback = [];
      const Native = window.AudioWorkletNode;
      w.AudioWorkletNode = class extends Native { constructor(c: AudioContext, n: string, o: any) { super(c, n, o); this.port.addEventListener('message', e => w.__playback.push(e.data)); this.port.start(); } };
    });
    await page.locator('#call').click();
    await page.waitForFunction(() => document.getElementById('call')?.classList.contains('connected'));
    const jpeg = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 512; c.getContext('2d')!.drawImage(document.getElementById('idle') as HTMLVideoElement, 0, 0, 512, 512); return c.toDataURL('image/jpeg', .8).split(',')[1]; });
    const reply = async (generation: number, seconds: number) => app.evaluate(({ BrowserWindow }, data) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents, id = { call: 'ui-audio', generation: data.generation };
      wc.send('soul:media', { type: 'begin', ...id, video: true });
      wc.send('soul:media', { type: 'audio', ...id, data: new Uint8Array(data.seconds * 48000) });
      for (let index = 0; index < data.seconds * 25; index++) wc.send('soul:media', { type: 'frame', ...id, index, data: new Uint8Array(Buffer.from(data.jpeg, 'base64')) });
      wc.send('soul:media', { type: 'end', ...id });
    }, { generation, seconds, jpeg });
    await reply(1, 2);
    await page.waitForFunction(() => document.querySelector('.portrait')?.getAttribute('data-mode') === 'speaking'); await pause(350);
    assert.equal(await page.evaluate(() => (document.getElementById('idle') as HTMLVideoElement).paused), true);
    assert.equal(await page.evaluate(() => (window as any).__playback.some((m: any) => m.generation === 1 && m.type === 'ended')), false);
    await page.waitForFunction(() => (window as any).__playback.some((m: any) => m.generation === 1 && m.type === 'ended'));
    await page.waitForFunction(() => document.querySelector('.portrait')?.getAttribute('data-mode') === 'idle'); await pause(300);
    assert.equal(await page.locator('#video').evaluate(e => getComputedStyle(e).opacity), '0');
    assert.equal(await page.evaluate(() => (document.getElementById('idle') as HTMLVideoElement).paused), false);
    await reply(2, 3); await page.waitForFunction(() => document.querySelector('.portrait')?.getAttribute('data-mode') === 'speaking');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('soul:media', { type: 'interrupt', call: 'ui-audio', generation: 3 }));
    await pause(150); const cut = await page.evaluate(() => (window as any).__playback.length); await pause(200);
    assert.equal(await page.evaluate(n => (window as any).__playback.slice(n).some((m: any) => m.generation === 2 && m.samples > 0), cut), false, 'interrupted audio must not keep playing');
    assert.equal(await page.locator('.portrait').getAttribute('data-mode'), 'idle');
    await page.locator('#call').click();
    await page.evaluate(() => { const idle = document.getElementById('idle') as HTMLVideoElement; idle.src = './missing-idle-test.mp4'; idle.load(); });
    await page.waitForFunction(() => document.querySelector('.portrait')?.getAttribute('data-mode') === 'static');
    assert.deepEqual(errors, []);
    console.log('AUDIO_END_CROSSFADE_INTERRUPT_STATIC_FALLBACK_VERIFIED');
    fs.writeFileSync('test-results/ui-refresh.json', JSON.stringify({ localIdle: true, hiddenPause: true, taskPopover: true, taskActions: true, layouts: true, actualAudioClock: true, interruptedAudioCleared: true, missingIdleFallback: true }, null, 2));
  } catch (e) { console.log('UI_DIAGNOSTICS', await page.evaluate(() => ({ errors: document.getElementById('error')?.textContent, mode: document.querySelector('.portrait')?.getAttribute('data-mode'), playback: (window as any).__playback?.slice(-4) }))); await page.screenshot({ path: 'test-results/ui-refresh-failure.png' }).catch(() => {}); throw e; }
  finally { await app.close(); }
}
main().catch(e => { console.error(e.stack); process.exitCode = 1; });
