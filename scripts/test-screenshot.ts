import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

async function main() {
  await build({ entryPoints: ['tests/screenshot-smoke.ts'], outfile: '.cache/screenshot-smoke.cjs', bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(createRequire(import.meta.url)('electron'), ['.cache/screenshot-smoke.cjs'],
    { env, windowsHide: true, timeout: 90000 });
  console.log(result.stdout);
}
main().catch(e => { console.error([e.stdout, e.stderr].filter(Boolean).join('\n') || e.message); process.exitCode = 1; });
