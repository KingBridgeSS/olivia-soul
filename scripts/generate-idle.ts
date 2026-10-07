import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import WebSocket from 'ws';

// Offline asset generation only: synthetic silence, no dialogue or microphone.
// Acknowledged frames have been consumed by the encoder, not played by a device.
// The application's real-time GPU progress continues to use its audio clock.
const blocks = 68, blockSamples = 23040, fps = 25, totalFrames = blocks * 24;
const directory = path.resolve(`.cache/idle-generation-${Date.now()}`);
const raw = path.join(directory, 'generated.mp4'), looped = path.join(directory, 'idle.mp4');
const url = process.env.SOUL_IDLE_GPU_URL || 'http://127.0.0.1:8765';
function probe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,nb_frames,avg_frame_rate:format=duration,size', '-of', 'json', file], { encoding: 'utf8', windowsHide: true }));
}
async function main() {
  const health: any = await (await fetch(new URL('/health', url), { signal: AbortSignal.timeout(10000) })).json();
  if (!health.ready || health.busy) throw Error('GPU 服务尚未就绪或正在使用，未生成或替换素材。');
  fs.mkdirSync(directory, { recursive: true });
  const encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'mjpeg', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', raw], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let encoderError = '', frames = 0;
  encoder.stderr.on('data', b => { encoderError = (encoderError + b.toString()).slice(-4000); });
  const encoded = new Promise<void>((resolve, reject) => { encoder.on('error', reject); encoder.on('close', code => code === 0 ? resolve() : reject(Error(`Idle encoder failed: ${encoderError || code}`))); });
  void encoded.catch(() => {});
  const endpoint = new URL('/stream', url); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(endpoint, { handshakeTimeout: 10000, maxPayload: 2 * 1024 * 1024 });
  const send = (data: string | Buffer) => new Promise<void>((resolve, reject) => socket.send(data, error => error ? reject(error) : resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Idle generation timed out')), 180000);
      const fail = (error: Error) => { clearTimeout(timeout); reject(error); };
      encoder.stdin.on('error', fail); void encoded.catch(fail);
      socket.on('error', fail);
      socket.on('close', () => { if (frames !== totalFrames) fail(Error(`GPU stream ended after ${frames}/${totalFrames} frames`)); });
      socket.on('message', (data, binary) => {
        if (!binary) {
          const event = JSON.parse(data.toString());
          if (event.type === 'unavailable') { fail(Error('GPU 被占用，未替换素材。')); return; }
          if (event.type === 'ready') void (async () => {
            await send(JSON.stringify({ type: 'begin', generation: 1 }));
            for (let block = 0; block < blocks; block++) {
              const packet = Buffer.alloc(blockSamples * 2 + 4); packet.writeUInt32LE(1, 0);
              await send(packet); // Bound the outbound socket queue to one silence block.
            }
            await send(JSON.stringify({ type: 'end', generation: 1 }));
          })().catch(fail);
          return;
        }
        const frame = Buffer.from(data as Buffer);
        if (frame.length < 8 || frame.readUInt32LE(0) !== 1 || frame.readUInt32LE(4) !== frames) { fail(Error('Unexpected GPU frame sequence')); return; }
        if (!encoder.stdin.write(frame.subarray(8))) {
          socket.pause(); encoder.stdin.once('drain', () => socket.resume());
        }
        frames++;
        if (frames % 24 === 0) socket.send(JSON.stringify({ type: 'progress', generation: 1, samples: frames * 960 }));
        if (frames % 240 === 0) console.log(JSON.stringify({ generatedSeconds: frames / fps, targetSeconds: totalFrames / fps }));
        if (frames === totalFrames) { clearTimeout(timeout); encoder.stdin.end(); socket.close(); resolve(); }
      });
    });
    await encoded;
    const source = probe(raw);
    if (Number(source.streams[0]?.nb_frames) !== totalFrames) throw Error('Generated frame count mismatch');
    // Circular 0.48-second blend: tail -> head, followed by the next head frame
    // at the loop boundary. The remaining 64.8 seconds play forward normally.
    const overlap = 12, tail = totalFrames - overlap;
    const filter = `[0:v]split=3[m][t][h];[m]trim=start_frame=${overlap}:end_frame=${tail},setpts=PTS-STARTPTS[middle];[t]trim=start_frame=${tail},setpts=PTS-STARTPTS[tail];[h]trim=end_frame=${overlap},setpts=PTS-STARTPTS[head];[tail][head]blend=all_expr='A*(1-min(T/0.44,1))+B*min(T/0.44,1)':shortest=1[seam];[middle][seam]concat=n=2:v=1:a=0,format=yuv420p,setpts=N/(25*TB)[out]`;
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', raw, '-filter_complex', filter, '-map', '[out]', '-an', '-r', '25', '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-movflags', '+faststart', looped], { windowsHide: true, timeout: 120000 });
    const output = probe(looped), video = output.streams.find((s: any) => s.codec_type === 'video');
    if (Number(output.format.duration) < 60 || Number(video?.nb_frames) !== totalFrames - overlap || output.streams.length !== 1 || video.width !== 512 || video.height !== 512) throw Error('Idle video validation failed');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-xerror', '-i', looped, '-f', 'null', '-'], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
    const target = path.resolve('assets/idle.mp4');
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(directory, 'previous-idle.mp4'));
    fs.copyFileSync(looped, target);
    fs.mkdirSync('test-results', { recursive: true });
    const report = { source: 'Existing GPU model, newly generated continuous synthetic silence', generatedFrames: frames, generatedSeconds: totalFrames / fps, loopBlendFrames: overlap, video: output, target, intermediateDirectory: directory };
    fs.writeFileSync('test-results/idle-generation.json', JSON.stringify(report, null, 2));
    console.log('IDLE_GENERATED', JSON.stringify({ seconds: Number(output.format.duration), frames: Number(video.nb_frames), bytes: Number(output.format.size), audioTracks: 0 }));
  } finally { socket.terminate(); encoder.stdin.destroy(); if (encoder.exitCode === null) encoder.kill(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
