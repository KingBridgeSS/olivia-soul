import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = process.argv[2] || 'up';
if (!['up', 'stop', 'status', 'logs'].includes(action)) throw new Error('Use up, stop, status or logs');
const localEnv = path.join(root, 'infra/langfuse/.env');
if (action === 'up') {
  if (!fs.existsSync(localEnv)) {
    const secrets = Object.fromEntries(['POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD', 'REDIS_AUTH', 'MINIO_ROOT_PASSWORD', 'SALT', 'ENCRYPTION_KEY', 'NEXTAUTH_SECRET', 'LANGFUSE_USER_PASSWORD'].map(k => [k, randomBytes(32).toString('hex')]));
    const config = { ...secrets, LANGFUSE_PUBLIC_KEY: `pk-lf-${randomUUID()}`, LANGFUSE_SECRET_KEY: `sk-lf-${randomUUID()}`,
      LANGFUSE_USER_EMAIL: 'soul@localhost.local' };
    fs.writeFileSync(localEnv, Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  }
  const credentials = parseEnv(fs.readFileSync(localEnv, 'utf8'));
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, '.cache/langfuse-login.txt'),
    `Local Langfuse: http://localhost:3300\nEmail: ${credentials.LANGFUSE_USER_EMAIL}\nPassword: ${credentials.LANGFUSE_USER_PASSWORD}\nProject: Soul Tools\n`, { mode: 0o600 });
  const appEnv = path.join(root, '.env');
  let appText = fs.existsSync(appEnv) ? fs.readFileSync(appEnv, 'utf8') : '';
  const existing = parseEnv(appText);
  const defaults = { LANGFUSE_ENABLED: 'true', LANGFUSE_BASE_URL: 'http://localhost:3300', LANGFUSE_PUBLIC_KEY: credentials.LANGFUSE_PUBLIC_KEY,
    LANGFUSE_SECRET_KEY: credentials.LANGFUSE_SECRET_KEY, LANGFUSE_TRACING_ENVIRONMENT: 'development', SOUL_CLOUD_VERSION: 'baseline-unrecorded' };
  const local = !existing.LANGFUSE_BASE_URL || existing.LANGFUSE_BASE_URL === defaults.LANGFUSE_BASE_URL;
  if (local) {
    const firstSetup = !existing.LANGFUSE_PUBLIC_KEY || !existing.LANGFUSE_SECRET_KEY;
    for (const [key, value] of Object.entries(defaults)) {
      if (existing[key] && !(key === 'LANGFUSE_ENABLED' && firstSetup)) continue;
      const pattern = new RegExp(`^${key}=.*$`, 'm');
      appText = pattern.test(appText) ? appText.replace(pattern, `${key}=${value}`) : `${appText.trimEnd()}\n${key}=${value}\n`;
    }
    fs.writeFileSync(appEnv, appText);
  } else console.log('Existing remote LANGFUSE_BASE_URL preserved; configure .env manually to use this local instance.');
  console.log('UI: http://localhost:3300 | Login credentials: .cache/langfuse-login.txt');
}
const windows = process.platform === 'win32';
const compose = ['compose', '-p', 'soul-langfuse', '--env-file', 'infra/langfuse/.env', '-f', 'infra/langfuse/compose.yaml',
  ...(windows ? ['-f', 'infra/langfuse/compose.wsl.yaml'] : []),
  ...({ up: ['up', '-d'], stop: ['stop'], status: ['ps'], logs: ['logs', '--tail', '60', 'web', 'worker'] }[action])];
const wslRoot = windows ? execFileSync('wsl', ['--exec', 'wslpath', '-a', root], { encoding: 'utf8', windowsHide: true }).trim() : root;
const child = spawn(windows ? 'wsl' : 'docker', windows ? ['--cd', wslRoot, '--exec', 'docker', ...compose] : compose,
  { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
