import { desktopCapturer, nativeImage, screen } from 'electron';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import type { runSmoke } from './smoke';

// Real application IPC, UI, tool loop and Aliyun. Substitute only desktop capture
// with a known image, so this test never uploads the user's actual screen.
export async function screenshotCallSmoke(ctx: Parameters<typeof runSmoke>[0]) {
  const { window, cloud, storage } = ctx;
  const waitFor = async (fn: () => Promise<boolean>, label: string) => {
    const end = Date.now() + 45000;
    while (!await fn()) { if (Date.now() > end) throw new Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 100)); }
  };
  // Actual detailed pixels, not compressible JPEG padding: the screenshot
  // encoder must shrink this image while keeping the known text legible.
  const bitmap = randomFillSync(Buffer.alloc(1920 * 1080 * 4));
  for (let i = 3; i < bitmap.length; i += 4) bitmap[i] = 255;
  const center = nativeImage.createFromPath('evals/fixtures/screen-a.png').resize({ width: 1280, height: 720 }).toBitmap();
  for (let y = 0; y < 720; y++) center.copy(bitmap, ((y + 180) * 1920 + 320) * 4, y * 1280 * 4, (y + 1) * 1280 * 4);
  const thumbnail = nativeImage.createFromBitmap(bitmap, { width: 1920, height: 1080 });
  const originalBytes = thumbnail.toJPEG(75).length;
  assert.ok(originalBytes > 262144);
  const originalCapture = desktopCapturer.getSources, originalRespond = cloud.respond;
  let captures = 0, bufferedOnUpload = 0, imageBytes = 0;
  desktopCapturer.getSources = async () => {
    captures++;
    return [{ display_id: String(screen.getPrimaryDisplay().id), thumbnail }] as any;
  };
  cloud.respond = function (...args) {
    originalRespond.apply(this, args);
    if (args[3]?.length) {
      imageBytes = Buffer.from(args[3][0].value, 'base64').length;
      assert.ok(imageBytes <= 120 * 1024);
      bufferedOnUpload = this.socket?.bufferedAmount || 0;
      this.sendAudio(Buffer.alloc(3200)); // Audio arriving while the image is queued.
    }
  };
  const state = () => window.webContents.executeJavaScript('window.soul.state()');
  try {
    storage.savePreferences({ ...storage.preferences, micMuted: true, speakerMuted: true, gpuEnabled: false });
    await state(); // Publish preferences before renderer starts its media engine.
    await window.webContents.executeJavaScript('window.soulSmoke.connect()', true);
    const text = '请截图查看主屏幕，读出图片里的编号和 HTTP 状态码。';
    await window.webContents.executeJavaScript(`document.getElementById('text-form').hidden = false; document.getElementById('text').value = ${JSON.stringify(text)}; document.getElementById('text-form').requestSubmit();`, true);
    await waitFor(async () => await window.webContents.executeJavaScript(`(() => {
      const heard = document.getElementById('heard'), r = heard.getBoundingClientRect();
      return heard.textContent === ${JSON.stringify(text)} && document.getElementById('text').value === '' &&
        document.getElementById('text-form').hidden && getComputedStyle(heard).visibility === 'visible' &&
        document.elementFromPoint(r.x + 5, r.y + r.height / 2) === heard;
    })()`), 'typed message visible and not covered');
    await waitFor(async () => {
      const s = await state(); assert.equal(s.connected, true, s.error);
      return /ORBIT[\s-]*731/i.test(s.subtitle) && s.subtitle.includes('502');
    }, 'image answer');
    assert.equal(captures, 1); assert.ok(imageBytes > 0 && imageBytes < originalBytes);
    const first = await state();
    await waitFor(async () => (await state()).cloud === 'Listening', 'listening after screenshot');
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/screenshot-call.png', (await window.webContents.capturePage()).toPNG());
    await ctx.sendText('接下来不要调用工具，只回复：连接正常。');
    await waitFor(async () => {
      const s = await state(); assert.equal(s.connected, true, s.error); return s.subtitle.includes('连接正常');
    }, 'follow-up on the same call');
    // A transport failure must remain an error in UI/trace, not a generic abort.
    await ctx.sendText('断线诊断检查');
    cloud.close(new Error('测试连接中断'));
    await waitFor(async () => { const s = await state(); return !s.connected && s.error === '测试连接中断'; }, 'disconnect reason');
    const result = { callId: cloud.call, originalBytes, imageBytes, bufferedOnUpload, captures, reply: first.subtitle,
      typedMessageVisible: true, followupConnected: true, disconnectReasonPreserved: true };
    fs.writeFileSync('test-results/screenshot-call.json', JSON.stringify(result, null, 2));
    console.log('SCREENSHOT_CALL_VERIFIED', JSON.stringify(result));
  } finally { desktopCapturer.getSources = originalCapture; cloud.respond = originalRespond; }
  await ctx.shutdown();
}
