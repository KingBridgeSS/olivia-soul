import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
await build({ entryPoints: ['tests/smoke.ts'], outfile: '.cache/smoke-runner.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], target: 'node24' });
const child = spawn(require('electron'), ['.', '--smoke', ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code || 0; });
