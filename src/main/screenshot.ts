import { desktopCapturer, screen } from 'electron';
import { performance } from 'node:perf_hooks';
import type { CommandOutcome } from './tasks';
import { imageInfo, type ToolImage } from './tool-image';

export async function takeScreenshot(signal: AbortSignal): Promise<CommandOutcome> {
  signal.throwIfAborted();
  const started = performance.now(), display = screen.getPrimaryDisplay();
  const scale = Math.min(display.scaleFactor, 1920 / Math.max(display.size.width, display.size.height));
  const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false,
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } });
  signal.throwIfAborted();
  const source = sources.find(s => s.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error('未能获取主屏幕截图，请确认桌面可用后重试。');
  // Use Electron's encoder; 120 KiB becomes 160 KiB of Base64, leaving room
  // for text and JSON inside the server's 256 KiB frame limit.
  let thumbnail = source.thumbnail, jpeg = thumbnail.toJPEG(75);
  for (let attempt = 0; jpeg.length > 120 * 1024 && attempt < 10; attempt++) {
    signal.throwIfAborted();
    thumbnail = thumbnail.resize({ width: Math.max(1, Math.floor(thumbnail.getSize().width * 0.8)) });
    jpeg = thumbnail.toJPEG(75);
  }
  if (jpeg.length > 120 * 1024) throw new Error('截图压缩后仍过大，请简化屏幕内容后重试。');
  const image: ToolImage = { type: 'base64', value: jpeg.toString('base64') };
  const { width, height } = thumbnail.getSize();
  return { success: true, image, text: JSON.stringify({ screenshot: '当前主屏幕', width, height,
    capturedAt: new Date().toISOString(), captureMs: Math.round(performance.now() - started), ...imageInfo(image) }) };
}
