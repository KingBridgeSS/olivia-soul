import { spawn } from 'node:child_process';
import fs from 'node:fs';
async function run() {
  if (!fs.existsSync('.env')) throw new Error('需要根目录 .env');
  const modes = process.argv.slice(2);
  for (const mode of modes.length ? modes : ['--ui-only', '--e2e', '--behaviour', '--permissions']) {
    console.log(`Integration ${mode}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/launch-smoke.mjs', mode], { stdio: 'inherit', windowsHide: true });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${mode} failed (${code})`)));
    });
  }
}
run().catch(e => { console.error(e.message); process.exitCode = 1; });
