import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { generateNotices } from './generate-notices.mjs';
const results = await Promise.all([
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24', metafile: true }),
  build({ entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24', metafile: true }),
  build({ entryPoints: ['src/renderer/index.ts'], outfile: 'dist/renderer/index.js', bundle: true, platform: 'browser', target: 'chrome140', metafile: true }),
  build({ entryPoints: ['src/renderer/audio-worklet.js'], outfile: 'dist/renderer/audio-worklet.js', bundle: true, platform: 'browser', target: 'chrome140', metafile: true })
]);
await generateNotices(results);
await fs.rm('dist/main/host-runner.cjs', { force: true });
for (const file of ['index.html', 'style.css']) await fs.copyFile(`src/renderer/${file}`, `dist/renderer/${file}`);
await fs.copyFile('assets/portrait.png', 'dist/renderer/portrait.png');
await fs.copyFile('assets/logo.png', 'dist/renderer/logo.png');
try { await fs.copyFile('assets/idle.mp4', 'dist/renderer/idle.mp4'); }
catch (error) { if (error.code !== 'ENOENT') throw error; await fs.rm('dist/renderer/idle.mp4', { force: true }); }
