import { DshRemote } from './dsh-remote';
import { parseDshUrl } from './dsh-config';

// Connection ownership only. The user owns the external dsh process.
export class DshHost {
  remote?: DshRemote;
  private opening?: Promise<DshRemote>;
  private pending?: DshRemote;
  private launchUrl = '';
  private generation = 0;
  identity = '';
  constructor(private configuredUrl: () => string) {}
  ensure() { return this.opening ||= this.open().finally(() => { this.opening = undefined; }); }
  private async open() {
    const url = parseDshUrl(this.configuredUrl());
    if (this.remote?.clientId && this.launchUrl === url.href) return this.remote;
    this.remote?.close();
    const generation = this.generation;
    const remote = this.pending = new DshRemote(url.origin);
    remote.on('fault', () => {});
    let phase = 'authentication';
    try {
      await remote.authenticate(url.href);
      phase = 'protocol';
      await remote.connect();
      const list = await remote.call('session/list', {});
      if (!remote.clientId || !remote.home || !Array.isArray(list?.items) || list.items.some((item: any) => typeof item?.sessionId !== 'string')) throw new Error('Invalid dsh Remote response');
      if (generation !== this.generation) throw new Error('Connection superseded');
      this.identity = JSON.stringify([url.origin, remote.home.toLowerCase().replaceAll('\\', '/').replace(/\/$/, '')]);
      this.launchUrl = url.href; this.remote = remote;
      return remote;
    } catch (error: any) {
      remote.close();
      // Never surface a server-supplied message or the authenticated URL.
      if (phase === 'authentication') {
        if (error.code === 'DSH_AUTH') throw new Error('dsh 认证失败：地址上的服务可能不是 dsh Web，或 token 已失效。请将 dsh 本次启动输出的完整 URL（含 token）填入 .env 的 dsh_url，然后重新启动 Soul。');
        throw new Error(`无法连接 dsh Web（${url.origin}）：请先自行启动 dsh，并检查 dsh_url。Soul 不会启动 dsh 进程。`);
      }
      throw new Error(`dsh Web 协议检查失败（${url.origin}）：服务不是兼容的 dsh Web、尚未就绪或连接已中断。请检查服务后重新启动 Soul。`);
    } finally { if (this.pending === remote) this.pending = undefined; }
  }
  async browserUrl() { await this.ensure(); return this.launchUrl; }
  disconnect() { this.generation++; this.pending?.close(); this.remote?.close(); this.remote = undefined; }
}
