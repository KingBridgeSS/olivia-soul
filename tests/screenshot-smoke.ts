import { app, BrowserWindow, screen, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadEnvFile } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { takeScreenshot } from '../src/main/screenshot';
import { AliyunClient } from '../src/main/aliyun';
import { AliyunTurns } from '../src/main/aliyun-turn';
import { runToolLoop } from '../src/main/tool-flow';
import type { CommandOutcome } from '../src/main/tasks';
import { withoutImage } from '../src/main/tool-image';
import { initTracing, shutdownTracing, startRequestTrace } from '../src/main/tracing';

// A brief, controlled full-screen fixture verifies the real Windows capture and upload path.
async function main() {
  loadEnvFile('.env'); initTracing();
  await app.whenReady();
  const window = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, frame: false, show: false, fullscreen: true,
    alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const controller = new AbortController(), cloud = new AliyunClient(), turns = new AliyunTurns(cloud);
  const timeout = setTimeout(() => controller.abort(new Error('Screenshot smoke timeout')), 60000);
  const pump = setInterval(() => turns.pump(!controller.signal.aborted), 50);
  let reply = '', captures = 0, screenshot: CommandOutcome | undefined;
  cloud.on('fault', s => controller.abort(new Error(s)));
  cloud.on('event', o => {
    const muted = turns.muted;
    turns.event(o);
    if (o.event === 'RespondingContent' && !muted) reply = o.text || reply;
    if (o.event === 'RespondingEnded') cloud.directive('LocalRespondingEnded');
  });
  controller.signal.addEventListener('abort', () => turns.reset(controller.signal.reason), { once: true });
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:#b5efcf;font:48px Arial;padding:100px"><h1>SCREEN-946</h1><p>Desktop capture check</p></body>'));
    window.setAlwaysOnTop(true, 'screen-saver'); window.show(); window.moveTop();
    await cloud.connect({ appId: process.env.app_id!, key: process.env.key!, workspaceId: process.env.workspace_id!, voiceId: process.env.voice_id });
    const text = '看看我的主屏幕，读出画面中的编号，并说出背景颜色。', trace = startRequestTrace(cloud.call, text, 'eval');
    try {
      const calls = await turns.request({ call: cloud.call, text, user: true, signal: controller.signal, trace });
      await runToolLoop(calls, turns.toolTurn(cloud.call, text, controller.signal, async command => {
        assert.equal(command.name, 'take_screenshot', 'Only the local screenshot tool should be called');
        captures++;
        window.setAlwaysOnTop(true, 'screen-saver'); window.show(); window.moveTop(); window.focus();
        try {
          await delay(1200, undefined, { signal: controller.signal });
          screenshot = await takeScreenshot(controller.signal);
          assert.ok(screenshot.image); assert.ok(JSON.parse(screenshot.text).width >= 1000);
          // Check the fixture's top-left background before uploading; a covered test window is not a valid fixture.
          const bitmap = nativeImage.createFromBuffer(Buffer.from(screenshot.image.value, 'base64')).toBitmap();
          assert.ok(Math.abs(bitmap[0] - 207) < 12 && Math.abs(bitmap[1] - 239) < 12 && Math.abs(bitmap[2] - 181) < 12,
            '测试页被其他窗口遮挡，未上传桌面图片');
          fs.mkdirSync('test-results', { recursive: true });
          fs.writeFileSync('test-results/screenshot-smoke.jpg', Buffer.from(screenshot.image.value, 'base64'));
          return screenshot;
        } finally { window.hide(); }
      }, trace), controller.signal);
    }
    catch (e) { trace?.end(e); throw e; }
    finally { trace?.end(); }
    assert.ok(screenshot); assert.equal(captures, 1);
    const result = { ...withoutImage(screenshot), captures, reply, passed: /SCREEN[\s-]*946/i.test(reply) };
    fs.writeFileSync('test-results/screenshot-smoke.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    assert.ok(result.passed, 'Cloud must read the actual captured desktop');
  } finally {
    clearTimeout(timeout); clearInterval(pump); turns.reset(); window.destroy(); await cloud.stop(); await shutdownTracing();
  }
}
// Closing the test window must not bypass the asynchronous cleanup.
app.on('window-all-closed', () => {});
main().then(() => app.exit(0), e => { console.error(e.message); app.exit(1); });
