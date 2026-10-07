import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readEnvironment } from './environment';
import { safeStorage } from 'electron';
import type { AliyunConfig } from './aliyun';
import { parseDshUrl } from './dsh-config';
import type { Preferences } from '../shared/types';
export function atomicWrite(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export class Storage {
  cloud: AliyunConfig = { appId: '', key: '', workspaceId: '' };
  memoryEnv: Record<string, string | undefined> = {};
  dshUrl = '';
  preferences: Preferences = { gpuUrl: 'http://127.0.0.1:8765', gpuEnabled: false, dshBaseUrl: '', dshCwd: path.join(os.homedir(), 'Documents'), alwaysOnTop: true, micMuted: false, speakerMuted: false, inputDevice: '', outputDevice: '' };
  constructor(readonly dir: string, devRoot?: string) {
    const prefs = this.read('preferences.json');
    if (prefs) for (const key of Object.keys(this.preferences) as (keyof Preferences)[]) {
      if (key !== 'dshBaseUrl' && typeof prefs[key] === typeof this.preferences[key]) (this.preferences as any)[key] = prefs[key];
    }
    const dsh = this.readSecret('dsh.json');
    if (typeof dsh?.url === 'string') { this.dshUrl = dsh.url; this.preferences.dshBaseUrl = parseDshUrl(dsh.url).origin; }
    const cloud = this.readSecret('cloud.json'); if (cloud) this.cloud = cloud;
    if (devRoot && fs.existsSync(path.join(devRoot, '.env'))) this.importEnv(path.join(devRoot, '.env'), false);
    else if (process.env.app_id && process.env.key && process.env.workspace_id && process.env.dsh_url) this.applyEnv(readEnvironment(), false);
    if (!fs.existsSync(this.preferences.dshCwd)) this.preferences.dshCwd = os.homedir();
  }
  read(name: string): any { try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return undefined; } }
  write(name: string, value: unknown) { atomicWrite(path.join(this.dir, name), value); }
  readSecret(name: string): any { const data = this.read(name); if (!data) return; if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 密钥保护不可用'); return JSON.parse(safeStorage.decryptString(Buffer.from(data.encrypted, 'base64'))); }
  writeSecret(name: string, value: unknown) { if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 密钥保护不可用'); this.write(name, { encrypted: safeStorage.encryptString(JSON.stringify(value)).toString('base64') }); }
  importEnv(file: string, persist = true) {
    this.applyEnv(readEnvironment(file), persist);
  }
  private applyEnv(e: Record<string, string | undefined>, persist: boolean) {
    if (![e.key, e.app_id, e.workspace_id].every(v => typeof v === 'string' && v.trim())) throw new Error('配置需要小写 app_id、key、workspace_id');
    const cloud = { appId: e.app_id!, key: e.key!, workspaceId: e.workspace_id!, voiceId: e.voice_id || undefined, userId: e.user_id || undefined };
    const p = { ...this.preferences };
    if (e.gpu_url) p.gpuUrl = e.gpu_url;
    if (e.gpu_enabled) {
      if (!['true', 'false'].includes(e.gpu_enabled)) throw new Error('gpu_enabled 必须是 true 或 false');
      p.gpuEnabled = e.gpu_enabled === 'true';
    }
    if (e.user_id && (!e.user_id.trim() || e.user_id.length > 36)) throw new Error('user_id 应为 1–36 个字符');
    const dshUrl = parseDshUrl(e.dsh_url ?? this.dshUrl).href;
    p.dshBaseUrl = new URL(dshUrl).origin;
    if (e.dsh_cwd) p.dshCwd = e.dsh_cwd;
    else if (!fs.existsSync(p.dshCwd)) p.dshCwd = os.homedir();
    this.validate(p);
    if (persist) { this.writeSecret('cloud.json', cloud); this.writeSecret('dsh.json', { url: dshUrl }); this.write('preferences.json', p); }
    this.cloud = cloud; this.dshUrl = dshUrl; this.preferences = p;
    // Development-only management credentials; never persisted or sent to the renderer.
    this.memoryEnv = Object.fromEntries(['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'].map(key => [key, process.env[key] ?? e[key]]));
  }
  validate(p: Preferences) {
    const u = new URL(p.gpuUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('GPU 地址无效');
    if (!path.isAbsolute(p.dshCwd) || !fs.existsSync(p.dshCwd) || !fs.statSync(p.dshCwd).isDirectory()) throw new Error('dsh 工作目录必须是已存在的绝对路径');
  }
  savePreferences(p: Preferences) { this.validate(p); if (p.dshBaseUrl !== this.preferences.dshBaseUrl) throw new Error('请通过导入 .env 修改 dsh_url'); this.preferences = p; this.write('preferences.json', p); }
}
