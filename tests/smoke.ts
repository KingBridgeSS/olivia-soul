import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import type { AliyunClient } from '../src/main/aliyun';
import type { Tasks } from '../src/main/tasks';
import type { Storage } from '../src/main/storage';
import type { ComputerCommand } from '../src/shared/types';
import { commandResult } from '../src/shared/commands';
import { DshRemote } from '../src/main/dsh-remote';
import { randomUUID } from 'node:crypto';
import { multiTaskSmoke } from './multi-task-smoke';
import { toolErrorSmoke } from './tool-error-smoke';
import { screenshotCallSmoke } from './screenshot-call-smoke';
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function runSmoke(ctx: { window: BrowserWindow; cloud: AliyunClient; tasks: Tasks; storage: Storage; sendText(s: string): Promise<void>; startCall(): Promise<void>; stopCall(): Promise<void>; shutdown(): Promise<void>; setCommandOverride(f?: (c: ComputerCommand) => boolean): void }) {
  const { window, cloud } = ctx;
  fs.mkdirSync('test-results', { recursive: true });
  const records: any[] = [];
  let videoCaptured = false;
  cloud.on('event', o => {
    if (o.event !== 'RespondingStarted' || videoCaptured) return;
    void (async () => {
      for (let i = 0; i < 40 && !videoCaptured && !window.isDestroyed(); i++) {
        await delay(100);
        if (await window.webContents.executeJavaScript('document.querySelector(".portrait").dataset.mode === "speaking"')) { videoCaptured = true; fs.writeFileSync('test-results/gpu-playing.png', (await window.webContents.capturePage()).toPNG()); console.log('GPU_DISPLAY_VERIFIED'); break; }
      }
    })().catch(() => {});
  });
  cloud.on('event', o => { const v = { event: o.event, state: o.state, text: o.text, finished: o.finished, commands: !!o.extra_info?.commands }; records.push(v); console.log(JSON.stringify(v)); });
  window.webContents.on('console-message', details => { if (details.level === 'error') console.log('RENDERER_ERROR', details.message); });
  const waitFor = async (fn: () => boolean, label: string, ms = 25000) => { const until = Date.now() + ms; while (!fn()) { if (Date.now() > until) throw new Error(`Timeout: ${label}`); await delay(100); } };
  await delay(600);
  fs.writeFileSync('test-results/desktop.png', (await window.webContents.capturePage()).toPNG());
  console.log('SMOKE_WINDOW_READY');
  if (process.argv.includes('--ui-only')) { await ctx.shutdown(); return; }
  if (process.argv.includes('--screenshot-call')) { await screenshotCallSmoke(ctx); return; }
  if (process.argv.includes('--multi-task')) { await multiTaskSmoke(ctx); return; }
  if (process.argv.includes('--tool-errors')) { await toolErrorSmoke(ctx); return; }
  if (process.argv.includes('--permissions')) {
    const fixture = path.resolve('.cache/e2e-fixture'); fs.mkdirSync(fixture, { recursive: true });
    ctx.storage.savePreferences({ ...ctx.storage.preferences, dshCwd: fixture, micMuted: true });
    const c = { id: randomUUID(), name: 'computer_task' as const, action: 'start' as const, goal: '这是用户交互联调。必须调用 ask_user_question 工具询问：选择测试颜色？提供 WHITE_OK 和 BLUE 两个选择。在用户回答前不要结束任务。收到回答后只回复选择的内容，不做任何文件操作。', context: '' };
    await ctx.startCall();
    await ctx.tasks.execute(c, cloud.call); const t = ctx.tasks.records.at(-1)!;
    await waitFor(() => t.status === 'waiting_permission', 'pending without browser', 45000);
    await delay(2000); if (t.status !== 'waiting_permission') throw new Error('Pending request settled without browser');
    console.log('PENDING_WITHOUT_BROWSER_VERIFIED');
    const browser = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'soul-dsh-permissions' } });
    try {
      await browser.loadURL(await ctx.tasks.host.browserUrl()); await delay(5000);
      await browser.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('[role="treeitem"]')].find(e=>e.textContent?.trim()==='Ungrouped');if(e?.getAttribute('aria-expanded')==='false')e.click();})()`); await delay(500);
      await browser.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('span')].find(e=>e.children.length===0&&e.textContent?.includes('[Soul]')&&e.textContent?.includes('这是用户交互联调'));e?.click();})()`); await delay(2500);
      console.log('PERMISSION_UI', await browser.webContents.executeJavaScript('document.body.innerText'));
      console.log('PERMISSION_CONTROLS', await browser.webContents.executeJavaScript(`JSON.stringify([...document.querySelectorAll('button,input,textarea,[role="radio"],[role="checkbox"]')].map(e=>({tag:e.tagName,role:e.getAttribute('role'),text:e.textContent?.trim(),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder')})))`));
      fs.writeFileSync('test-results/permission-pending.png', (await browser.webContents.capturePage()).toPNG());
      await browser.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button,label,[role="radio"]')].find(e=>e.textContent?.includes('WHITE_OK'));e?.click();})()`); await delay(500);
      await browser.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>/^(Submit|Confirm|提交|确认|Send)$/.test(e.textContent?.trim()||''));e?.click();})()`);
      await waitFor(() => t.status === 'completed', 'browser answer resumes task', 25000);
      if (!t.detail.includes('WHITE_OK')) throw new Error('Browser answer not consumed');
      console.log('LATE_BROWSER_ANSWER_VERIFIED');
    } finally { browser.destroy(); }
    await ctx.shutdown(); return;
  }
  if (process.argv.includes('--behaviour')) {
    const fixture = path.resolve('.cache/e2e-fixture'); fs.mkdirSync(fixture, { recursive: true });
    ctx.storage.savePreferences({ ...ctx.storage.preferences, dshCwd: fixture, micMuted: true });
    await ctx.tasks.ensure();
    await window.webContents.executeJavaScript('window.soulSmoke.connect()', true);
    await ctx.sendText('请执行一个电脑测试任务：使用 pwsh 执行 Start-Sleep -Seconds 40，执行结束后再汇报真实结果。不要修改任何文件。');
    await waitFor(() => !!ctx.tasks.records.at(-1)?.runs.length && ctx.tasks.records.at(-1)?.status === 'running', 'long task submitted', 40000);
    const long = ctx.tasks.records.at(-1)!; await waitFor(() => long.runs[0].consumed, 'long request consumed');
    await ctx.sendText('任务继续执行，我们聊一下。请只回复：我在这里。不要调用电脑工具。');
    await waitFor(() => records.some(v => v.event === 'RespondingContent' && v.text?.includes('我在这里')), 'chat during task');
    if (!long.running) throw new Error('Long task did not overlap chat');
    console.log('BACKGROUND_CHAT_VERIFIED');
    await waitFor(() => cloud.state === 'Listening', 'chat playback');
    await waitFor(() => records.some(v => v.event === 'RespondingContent' && /已接收|后台|执行中|正在执行|还在|尚未完成/.test(v.text || '')), 'two phase acceptance', 45000);
    if (!long.running) throw new Error('Acceptance arrived after completion');
    const acceptanceCut = records.length;
    await waitFor(() => long.status === 'completed', 'long completion', 65000);
    await waitFor(() => records.slice(acceptanceCut).some(v => v.event === 'RespondingContent' && /完成|结束|成功/.test(v.text || '') && !/完成后|已接收/.test(v.text || '')), 'independent completion report', 30000);
    await waitFor(() => cloud.state === 'Listening', 'completion playback');
    console.log('TWO_PHASE_VERIFIED');
    const c = { id: randomUUID(), name: 'computer_task' as const, action: 'start' as const, goal: '使用 pwsh 执行 Start-Sleep -Seconds 25，然后只回复 CANCEL_TEST_DONE。不要修改文件。', context: '' };
    await ctx.tasks.execute(c, cloud.call); const t = ctx.tasks.records.at(-1)!;
    await waitFor(() => t.runs[0].consumed && !!t.running, 'cancel task running');
    const browserRemote = new DshRemote(ctx.storage.preferences.dshBaseUrl); await browserRemote.authenticate(ctx.storage.dshUrl); await browserRemote.connect();
    const humanId = randomUUID();
    await browserRemote.call('session/prompt', { sessionId: t.sessionId, requestId: humanId, mode: 'queue', content: [{ type: 'text', text: '这是浏览器中的人工补充。只回复 BROWSER_KEEP_OK，不调用工具。' }] });
    await waitFor(() => t.manual && t.queue.some(v => v.rpcId === humanId), 'manual input observed');
    await ctx.tasks.cancel(t.id);
    await waitFor(() => !t.running && t.status === 'cancelled', 'cancel settled', 30000);
    if (!t.queue.some(v => v.rpcId === humanId)) throw new Error('Browser input was not preserved');
    await browserRemote.call('session/prompt', { sessionId: t.sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '继续处理保留的人工消息，只回复 BROWSER_KEEP_OK，不调用工具。' }] });
    await waitFor(() => !t.running && t.queue.length === 0, 'browser resumes retained input', 45000);
    const history: any[] = []; const unfollow = browserRemote.subscribe('session/follow', { address: { kind: 'session', sessionId: t.sessionId }, maxMessages: 30 }, f => { if (f.type === 'snapshot') history.push(...f.records); });
    await waitFor(() => history.some(v => v.event?.type === 'user/message' && v.event.data.source?.rpcId === humanId), 'browser input retained in history');
    console.log(JSON.stringify({ manualIntervention: t.manual, cancelStatus: t.status, browserInputPreserved: true })); unfollow(); browserRemote.close();
    const continuation = { id: randomUUID(), name: 'computer_task' as const, action: 'continue' as const, taskId: t.id, goal: '只回复 SOUL_RESUME_OK，不调用工具。', context: '' };
    await ctx.tasks.execute(continuation, cloud.call); const requestId = t.runs.at(-1)!.requestId;
    ctx.tasks.host.remote!.socket!.terminate();
    await waitFor(() => !!ctx.tasks.host.remote?.clientId, 'automatic reconnect', 20000);
    await waitFor(() => t.status === 'completed', 'continued task after reconnect', 35000);
    await ctx.tasks.execute(continuation, cloud.call);
    const verify: any[] = []; const off = ctx.tasks.host.remote!.subscribe('session/follow', { address: { kind: 'session', sessionId: t.sessionId }, maxMessages: 30 }, f => { if (f.type === 'snapshot') verify.push(...f.records); });
    await waitFor(() => verify.length > 0, 'reconnect history');
    const count = verify.filter(v => v.event?.type === 'user/message' && v.event.data.source?.rpcId === requestId).length;
    if (count !== 1 || t.manual || !t.detail.includes('SOUL_RESUME_OK')) throw new Error('Reconnect / dedup verification failed');
    off(); console.log(JSON.stringify({ reconnectVerified: true, durablePromptCount: count, explicitContinueRestoresControl: true }));
    await ctx.stopCall(); fs.writeFileSync('test-results/behaviour-events.json', JSON.stringify(records, null, 2));
    console.log('BEHAVIOUR_COMPLETED'); await ctx.shutdown(); return;
  }
  if (process.argv.includes('--dsh-ui')) {
    const fixture = path.resolve('.cache/e2e-fixture'); fs.mkdirSync(fixture, { recursive: true });
    ctx.storage.savePreferences({ ...ctx.storage.preferences, dshCwd: fixture });
    const browser = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'soul-dsh-smoke' } });
    await browser.loadURL(await ctx.tasks.host.browserUrl()); await delay(3500);
    console.log(await browser.webContents.executeJavaScript(`JSON.stringify([...document.querySelectorAll('button,[role="button"]')].map(e=>({tag:e.tagName,text:e.textContent?.trim().slice(0,80),label:e.getAttribute('aria-label'),title:e.getAttribute('title')})))`));
    console.log(await browser.webContents.executeJavaScript(`JSON.stringify([...document.querySelectorAll('*')].filter(e=>e.textContent?.trim()==='Ungrouped').slice(-3).map(e=>e.outerHTML.slice(0,1500)))`));
    await browser.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('*')].filter(e=>e.textContent?.trim()==='Ungrouped').at(-1);e?.click();})()`); await delay(1000);
    console.log('EXPANDED_BODY', await browser.webContents.executeJavaScript('document.body.innerText'));
    fs.writeFileSync('test-results/dsh-expanded.png', (await browser.webContents.capturePage()).toPNG());
    browser.destroy(); await ctx.shutdown(); return;
  }
  if (process.argv.includes('--e2e')) {
    const fixture = path.resolve('.cache/e2e-fixture'); fs.mkdirSync(fixture, { recursive: true });
    ctx.storage.savePreferences({ ...ctx.storage.preferences, dshCwd: fixture, micMuted: true });
    await window.webContents.executeJavaScript('window.soulSmoke.connect()', true);
    const name = `proof-${Date.now()}.txt`;
    const previousSession = ctx.tasks.records.at(-1)?.sessionId;
    await ctx.sendText(`请在电脑任务当前工作目录创建 ${name}，内容为 SOUL_E2E_OK。只操作这个测试文件，完成后读取文件核对结果。`);
    await waitFor(() => !!ctx.tasks.records.at(-1)?.runs.length && ctx.tasks.records.at(-1)?.sessionId !== previousSession, 'task submitted', 40000);
    const first = ctx.tasks.records.at(-1)!;
    console.log(JSON.stringify({ taskSubmitted: true, title: first.title, status: first.status }));
    const browser = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'soul-dsh-smoke' } });
    try {
      await browser.loadURL(await ctx.tasks.host.browserUrl());
      await delay(5000);
      await browser.webContents.executeJavaScript(`(()=>{const e=[...document.querySelectorAll('[role="treeitem"]')].find(e=>e.textContent?.trim()==='Ungrouped');if(e?.getAttribute('aria-expanded')==='false')e.click();})()`); await delay(500);
      await browser.webContents.executeJavaScript(`(()=>{const name=${JSON.stringify(name)};const e=[...document.querySelectorAll('span')].find(e=>e.children.length===0&&e.textContent?.includes('[Soul]')&&e.textContent?.includes(name));e?.click();})()`); await delay(1000);
      const body: string = await browser.webContents.executeJavaScript('document.body.innerText');
      if (!body.includes(name)) throw new Error('Same Host Web UI does not show the Soul task');
      console.log(JSON.stringify({ webUiLoaded: body.length > 100, webUiShowsSoul: body.includes('[Soul]') || body.includes(name), bodyPreview: body.slice(0, 1000) }));
      fs.writeFileSync('test-results/dsh-web.png', (await browser.webContents.capturePage()).toPNG());
      await waitFor(() => ['completed', 'failed', 'cancelled', 'unknown', 'waiting_permission'].includes(first.status), 'file task result', 90000);
      console.log(JSON.stringify({ taskStatus: first.status, detail: first.detail, manual: first.manual }));
      if (first.status !== 'completed') throw new Error(`File task ${first.status}: ${first.detail}`);
      if (fs.readFileSync(path.join(fixture, name), 'utf8').trim() !== 'SOUL_E2E_OK') throw new Error('File verification failed');
      await waitFor(() => records.some(v => v.event === 'RespondingContent' && !!v.text && !v.commands), 'cloud task result', 35000);
      await waitFor(() => cloud.state === 'Listening', 'task result playback', 35000);
      fs.writeFileSync('test-results/e2e-desktop.png', (await window.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ fileVerified: true, taskCompleted: true, cloudResultReturned: true }));
    } finally { browser.destroy(); }
    await ctx.stopCall(); fs.writeFileSync('test-results/e2e-events.json', JSON.stringify(records, null, 2));
    console.log('E2E_COMPLETED'); await ctx.shutdown(); return;
  }
  // Production renderer plays actual PCM through its AudioContext. No synthetic LocalResponding events.
  await window.webContents.executeJavaScript('window.soulSmoke.connect()', true);
  let command: ComputerCommand | undefined;
  ctx.setCommandOverride(c => { command = c; return true; });
  await ctx.sendText('电脑任务现在执行到哪里了？请调用电脑任务工具查询状态。');
  await waitFor(() => !!command, 'command'); await waitFor(() => cloud.state === 'Listening', 'command Listening');
  const started = Date.now();
  await ctx.sendText('先聊点别的。只说一句晚上好，不要调用电脑工具。');
  await waitFor(() => cloud.state === 'Responding', 'chat response'); await waitFor(() => cloud.state === 'Listening', 'actual playback ended');
  await ctx.sendText('请用三句话描述安静的夜晚，不要调用电脑工具。');
  await waitFor(() => cloud.state === 'Responding', 'second chat');
  await ctx.sendText('先停一下，只说：听到了。');
  await waitFor(() => records.some(v => v.text?.includes('听到了') && v.event === 'RespondingContent'), 'text interruption');
  await waitFor(() => cloud.state === 'Listening', 'interrupt playback ended');
  while (Date.now() - started < 35000) await delay(250);
  const held = command!;
  const before = records.length;
  cloud.respond('', [commandResult(held.id, '延迟状态查询结果：当前没有正在执行的电脑任务。', true)]);
  await waitFor(() => records.slice(before).some(v => v.event === 'RespondingContent' && v.text), 'delayed result response');
  await waitFor(() => cloud.state === 'Listening', 'delayed result playback');
  console.log(JSON.stringify({ delayedResultSeconds: (Date.now() - started) / 1000, multiTurnChat: true, textInterruption: true, delayedText: records.slice(before).filter(v => v.event === 'RespondingContent').at(-1)?.text }));
  ctx.setCommandOverride();
  await ctx.stopCall();
  fs.writeFileSync('test-results/cloud-electron.json', JSON.stringify(records, null, 2));
  fs.writeFileSync('test-results/desktop-connected.png', (await window.webContents.capturePage()).toPNG());
  console.log('SMOKE_COMPLETED'); await ctx.shutdown();
}
