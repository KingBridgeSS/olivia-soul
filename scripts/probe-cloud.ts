import fs from 'node:fs';
import { AliyunClient } from '../src/main/aliyun';
import { commandResult } from '../src/shared/commands';
import { environment } from './cloud-api';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function run() {
  const e = environment(), a = new AliyunClient(), records: any[] = [];
  let command: any, bytes = 0;
  a.on('fault', s => console.log('FAULT', s));
  a.on('audio', b => { bytes += b.length; });
  a.on('event', o => {
    const v: any = { event: o.event, state: o.state, text: o.text, finished: o.finished };
    if (o.extra_info?.commands) { const list = JSON.parse(o.extra_info.commands); command = list.find((v: any) => v.name === 'list_tasks'); v.commands = list.map((c: any) => ({ name: c.name, hasRequestId: !!c.command_request_id, params: c.params })); }
    records.push(v); console.log(JSON.stringify(v));
  });
  try {
    await a.connect({ appId: e.app_id!, key: e.key!, workspaceId: e.workspace_id!, voiceId: e.voice_id });
    a.respond('本次通话有哪些电脑任务？请调用 list_tasks 查询。');
    for (let i = 0; i < 100 && !command; i++) await delay(200);
    if (!command) throw new Error('No custom command received');
    console.log(JSON.stringify({ commandReceived: true, state: a.state }));
    await delay(1200);
    a.respond('', [commandResult(command.command_request_id, '当前没有正在执行的电脑任务。这是电脑任务状态查询的真实结果。', true)]);
    await delay(6000);
    console.log(JSON.stringify({ audioBytes: bytes, finalState: a.state }));
  } finally { await a.stop(); fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/cloud-probe.json', JSON.stringify(records, null, 2)); }
}
run().catch(e => { console.error(e.message); process.exitCode = 1; });
