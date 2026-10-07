import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type { AliyunClient } from '../src/main/aliyun';
import type { Tasks } from '../src/main/tasks';
import type { Storage } from '../src/main/storage';
import { parseCommands } from '../src/shared/commands';
export async function multiTaskSmoke(ctx: { window: BrowserWindow; cloud: AliyunClient; tasks: Tasks; storage: Storage; sendText(s: string): Promise<void>; stopCall(): Promise<void>; shutdown(): Promise<void> }) {
  const { cloud, tasks, window } = ctx, events: any[] = [], commands: any[] = [];
  ctx.storage.savePreferences({ ...ctx.storage.preferences, gpuEnabled: false, micMuted: true, speakerMuted: true });
  cloud.on('event', o => { events.push({ event: o.event, text: o.text, state: o.state, finished: o.finished }); commands.push(...parseCommands(o.extra_info?.commands)); });
  const wait = async (fn: () => boolean, label: string, ms = 45000) => {
    const until = Date.now() + ms;
    while (!fn()) { if (Date.now() > until) throw new Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 100)); }
  };
  const ask = async (text: string, predicate: () => boolean, label: string) => {
    await wait(() => cloud.state === 'Listening', 'listening'); await ctx.sendText(text); await wait(predicate, label);
  };
  try {
    await window.webContents.executeJavaScript('window.soulSmoke.connect()', true);
    await ask('新建一个独立电脑测试任务，名称甲：使用 pwsh 执行 Start-Sleep -Seconds 30，然后回复 TASK_ALPHA_OK。不修改文件。请调用 computer_task 的 start。', () => tasks.records.length === 1 && tasks.records[0].runs.length === 1, 'first task');
    const a = tasks.records[0];
    await wait(() => events.some(e => e.event === 'RespondingContent' && e.text === '请求已接收，执行结束后我会告诉你结果。'), 'fixed acceptance');
    await ask('再新建一个独立电脑测试任务乙：不要调用任何工具，只回复 TASK_BETA_OK。请调用 computer_task 的 start，不要追加到甲。', () => tasks.records.length === 2 && tasks.records[1].runs.length === 1, 'second task');
    const b = tasks.records[1];
    assert.notEqual(a.sessionId, b.sessionId); assert.notEqual(a.status, 'completed');
    console.log('REAL_CONCURRENT_TASKS_ACCEPTED');
    await ask(`调用 computer_task 给任务 ${a.id} 追加一个要求：只回复 TASK_ALPHA_CONTINUED，不调用工具。统一排队执行。`, () => a.runs.length === 2, 'queued continuation');
    assert.equal(a.manual, false);
    await ask('请调用 list_tasks，告诉我本次通话有哪些电脑任务。', () => commands.some(c => c.name === 'list_tasks'), 'list_tasks');
    await ask(`请调用 get_task 查看任务 ${b.id} 的目标和结果。`, () => commands.some(c => c.name === 'get_task' && c.taskId === b.id), 'get_task');
    await wait(() => a.status === 'completed' && b.status === 'completed', 'both tasks completed', 90000);
    assert.equal(a.runs.length, 2); assert.match(a.runs[0].response, /TASK_ALPHA_OK/); assert.match(a.runs[1].response, /TASK_ALPHA_CONTINUED/); assert.match(b.runs[0].response, /TASK_BETA_OK/);
    await wait(() => events.some(e => e.event === 'SpeechContent' && e.text?.includes('执行结果通知') && e.text.includes('TASK_ALPHA_CONTINUED')), 'completion notification sent', 120000);
    await wait(() => cloud.state === 'Listening', 'final playback');
    const detail = await tasks.execute({ name: 'get_task', id: randomUUID(), taskId: a.id, goal: '', context: '' }, cloud.call);
    assert.equal(JSON.parse(detail.text).requests.length, 2);
    console.log('REAL_QUEUE_QUERY_AND_REPORTS_VERIFIED');
    const ending = await tasks.execute({ name: 'computer_task', action: 'start', id: randomUUID(), goal: '执行 pwsh Start-Sleep -Seconds 30，不修改文件。', context: '' }, cloud.call);
    assert.equal(ending.success, true);
    const last = tasks.records.at(-1)!;
    await wait(() => !!last.running && last.runs[0].consumed, 'task running before hangup');
    await ctx.stopCall(); assert.deepEqual(tasks.records, []);
    const sessions = await tasks.host.remote!.call('session/list', {});
    assert.equal(sessions.items.find((s: any) => s.sessionId === last.sessionId)?.running, false);
    console.log('REAL_HANGUP_CANCELS_AND_CLEARS_VERIFIED');
  } finally {
    fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/multi-task-smoke.json', JSON.stringify({ events, commands }, null, 2));
  }
  await ctx.shutdown();
}
