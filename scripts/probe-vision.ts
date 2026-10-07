import fs from 'node:fs';
import { loadEnvFile } from 'node:process';
import { AliyunClient } from '../src/main/aliyun';
import { AliyunTurns } from '../src/main/aliyun-turn';
import { imageInfo } from '../src/main/tool-image';
import { initTracing, shutdownTracing, startRequestTrace } from '../src/main/tracing';

// A fixed image proves visual input works before configuring the screenshot tool.
async function main() {
  loadEnvFile('.env'); initTracing();
  const cloud = new AliyunClient(), turns = new AliyunTurns(cloud), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Vision probe timeout')), 60000);
  const pump = setInterval(() => turns.pump(!controller.signal.aborted), 50);
  let reply = '';
  cloud.on('fault', s => controller.abort(new Error(s)));
  cloud.on('event', o => {
    turns.event(o);
    if (o.event === 'RespondingContent') reply = o.text || reply;
    if (o.event === 'RespondingEnded') cloud.directive('LocalRespondingEnded');
  });
  controller.signal.addEventListener('abort', () => turns.reset(controller.signal.reason), { once: true });
  try {
    await cloud.connect({ appId: process.env.app_id!, key: process.env.key!, workspaceId: process.env.workspace_id!, voiceId: process.env.voice_id });
    const image = { type: 'base64' as const, value: fs.readFileSync('evals/fixtures/screen-a.png').toString('base64') };
    const text = '请读出图片里的编号和 HTTP 状态码，并说出背景颜色。';
    const trace = startRequestTrace(cloud.call, text, 'eval');
    try {
      const calls = await turns.request({ call: cloud.call, text, images: [image], user: true, signal: controller.signal, trace });
      const result = { reply, calls, image: imageInfo(image), passed: /ORBIT[\s-]*731/i.test(reply) && reply.includes('502') };
      fs.mkdirSync('test-results', { recursive: true });
      fs.writeFileSync('test-results/vision-probe.json', JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 1;
    } catch (e) { trace?.end(e); throw e; }
    finally { trace?.end(); }
  } finally { clearTimeout(timer); clearInterval(pump); turns.reset(); await cloud.stop(); await shutdownTracing(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
