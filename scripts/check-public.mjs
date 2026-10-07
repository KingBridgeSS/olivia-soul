import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const ignored = new Set(['.git', 'node_modules', 'dist', 'release', '.cache', 'test-results']);
function walk(dir = '.') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? ignored.has(e.name) ? [] : walk(p) : [p.replaceAll('\\', '/')];
  });
}
let files;
try { files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); }
catch { files = walk().filter(f => !/(^|\/)\.env(?:\.|$)/.test(f) || f.endsWith('.env.example')); }
const issues = [];
for (const file of files) {
  if (/^(localdocs|\.scan)\//.test(file) || /(^|\/)\.env$|\.(pem|key|p12|pfx)$/.test(file)) issues.push(`${file}: private file`);
  if (!fs.existsSync(file) || /\.(png|mp4)$/.test(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const checks = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['credential-shaped value', /\b(?:LTAI[A-Za-z0-9]{12,}|sk-[a-f0-9]{32}|sk-lf-[a-f0-9-]{36})\b/],
    ['personal deployment', /(?:10\.101\.168\.123|[Cc]:[\\/]Users[\\/]KingB|\/data\/cwq|cwq@|buptgpuserver|D:[\\/]coding[\\/]2026fall)/],
  ];
  // Keep pattern source from matching its own deliberately encoded examples.
  if (file !== 'scripts/check-public.mjs') for (const [label, re] of checks) if (re.test(text)) issues.push(`${file}: ${label}`);
  if (file.endsWith('.env.example')) {
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (/^(key|app_id|workspace_id|.*ACCESS_KEY.*|.*SECRET.*|.*SECURITY_TOKEN.*|LANGFUSE_PUBLIC_KEY)$/.test(key) && value) issues.push(`${file}: ${key} must be empty`);
    }
  }
}
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`Public file checks passed (${files.length} files; heuristic scan, not a security audit).`);
