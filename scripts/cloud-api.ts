import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readEnvironment } from '../src/main/environment';
export function environment() { return readEnvironment('.env'); }
export class CloudAdmin {
  private config = JSON.parse(fs.readFileSync(path.join(process.env.BAILIAN_CONFIG_DIR || path.join(os.homedir(), '.bailian'), 'config.json'), 'utf8'));
  async call(name: string, data: object): Promise<any> {
    if (!this.config.access_token) throw new Error('需要 bl auth login --console');
    const api = `zeldaHttp.xiaomiMultiModal./api/${name}`;
    const cornerstoneParam = { protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm', switchUserType: 3, consoleSite: 'BAILIAN_ALIYUN', ...(this.config.console_switch_agent ? { switchAgent: this.config.console_switch_agent } : {}) };
    const r = await fetch(`https://bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(api)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${this.config.access_token}` },
      body: new URLSearchParams({ params: JSON.stringify({ Api: api, V: '1.0', Data: { ...data, cornerstoneParam } }), region: this.config.console_region || 'cn-beijing' }), signal: AbortSignal.timeout(30000)
    });
    const j: any = await r.json(), inner = j.data?.DataV2?.data;
    if (!r.ok || !j.data?.success || !inner?.success) throw new Error(`Cloud ${name}: ${j.data?.errorCode || inner?.code || r.status} ${inner?.message || ''}`);
    return inner.data;
  }
}
