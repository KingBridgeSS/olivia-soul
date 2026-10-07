import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, shell, screen, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { Storage } from './storage';
import MemoryClient from '@alicloud/sfmmultimodalapp20250909';
import { memoryConfig, runMemory } from './memory';
import { MEMORY_USER, type MemoryRequest } from '../shared/memory';
import { AliyunClient } from './aliyun';
import { GpuClient } from './gpu';
import { DshHost } from './dsh-host';
import { Tasks } from './tasks';
import type { ParsedCommand } from '../shared/commands';
import { runToolLoop } from './tool-flow';
import { takeScreenshot } from './screenshot';
import { AliyunTurns, isNoSpeechRecognized } from './aliyun-turn';
import { initTracing, shutdownTracing, startRequestTrace, type RequestTrace } from './tracing';
import type { TaskRecord, TaskRun } from './task-state';
import { MAX_REPLY_AUDIO_SAMPLES } from '../shared/audio-limits';
import type { ComputerCommand, Media, Playback, Preferences, SoulState } from '../shared/types';
const smoke = !app.isPackaged && process.argv.includes('--smoke');
app.setName('olivia-soul');
const dataDir = process.argv.find(v => v.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
if (dataDir) app.setPath('userData', path.resolve(dataDir));
if (smoke) app.setPath('userData', path.join(process.cwd(), '.cache/smoke-userdata'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) app.exit(0);
let quitting = false, exitStatus = 0, window: BrowserWindow, tray: Tray, storage: Storage, tasks: Tasks, host: DshHost;
const cloud = new AliyunClient(), gpu = new GpuClient();
let state: SoulState, generation = 0, videoNonce = 0, mediaActive = false, playing = false, videoGeneration = false, speakingUntil = 0;
let gpuConnecting = false, gpuRetry: NodeJS.Timeout | undefined, gpuRetryDelay = 2000;
let receivedSamples = 0, playedSamples = 0, commandOverride: ((c: ComputerCommand) => boolean) | undefined;
const turns = new AliyunTurns(cloud);
let endingCall: Promise<void> | undefined;
const commandTraces = new Map<string, string>();
let voiceTrace: RequestTrace | undefined, voiceSequence = 0;
let userRequest: { text: string; controller: AbortController; trace?: RequestTrace } | undefined;
function voiceDiagnostic(name: string, metadata: Record<string, unknown> = {}) {
  voiceTrace?.event(name, { at: new Date().toISOString(), sequence: ++voiceSequence, callId: cloud.call,
    dialogId: cloud.dialog, cloudState: cloud.state, generation, playing, mediaActive, muted: turns.muted,
    receivedSamples, playedSamples, micMuted: storage.preferences.micMuted, requestTraceId: userRequest?.trace?.traceId, ...metadata });
}
function newRequest(text: string, source: 'text' | 'voice' = 'text') {
  userRequest?.controller.abort(new DOMException('已被新的用户请求替代', 'AbortError'));
  const controller = new AbortController();
  const trace = startRequestTrace(cloud.call, text, source, { tasks: tasks.records.map(t => ({ id: t.id, title: t.title, status: t.status })) });
  controller.signal.addEventListener('abort', () => trace?.end(controller.signal.reason), { once: true });
  voiceDiagnostic('request.attached', { requestTraceId: trace?.traceId, source });
  return userRequest = { text, controller, trace };
}
async function answer(request: NonNullable<typeof userRequest>, first: Promise<ParsedCommand[]>) {
  const call = cloud.call, signal = request.controller.signal;
  const filter = (calls: ParsedCommand[]) => calls.filter(c => !c.command || !commandOverride?.(c.command));
  try {
    const calls = filter(await first);
    if (!calls.length || signal.aborted) return;
    const turn = turns.toolTurn(call, request.text, signal, c => {
      if (c.name === 'take_screenshot') return takeScreenshot(signal);
      if (request.trace) commandTraces.set(`${call}:${c.id}`, request.trace.traceId);
      return tasks.execute(c, call, signal);
    }, request.trace);
    const next = turn.next;
    turn.next = async (...args) => filter(await next(...args));
    await runToolLoop(calls, turn, signal);
  } catch (e) {
    request.trace?.end(e);
    if (!signal.aborted && state.connected && call === cloud.call && !(e instanceof Error && e.name === 'AbortError')) fault(e instanceof Error ? e.message : '工具交互失败');
  } finally { request.trace?.end(signal.aborted ? signal.reason : undefined); }
}
function update() { if (!state || !window || window.isDestroyed()) return; state.cloud = cloud.state; state.preferences = storage.preferences; state.configured = !!storage.cloud.key; state.tasks = tasks.records.map(t => ({ id: t.id, title: t.title, detail: t.detail, status: t.status, manual: t.manual })); window.webContents.send('soul:state', state); }
function fault(message: string) { state.error = message; update(); }
function media(m: Omit<Media, 'call' | 'generation'> | any) { if (!window.isDestroyed()) window.webContents.send('soul:media', { ...m, call: cloud.call, generation }); }
function interrupt(reason: string) {
  voiceDiagnostic('playback.interrupt', { reason });
  if (playing) cloud.directive('LocalRespondingEnded');
  playing = false; mediaActive = false; gpu.interrupt(); generation++; media({ type: 'interrupt' });
}
function begin() {
  if (mediaActive) interrupt('new-response'); generation++; mediaActive = true; playing = false;
  receivedSamples = 0; playedSamples = 0;
  videoGeneration = gpu.ready && window.isVisible();
  if (videoGeneration) state.video = '数字人就绪';
  if (videoGeneration) gpu.begin(generation);
  media({ type: 'begin', video: videoGeneration });
}
function wantsGpu() { return state?.connected && storage.preferences.gpuEnabled && !window.isDestroyed() && window.isVisible(); }
function clearGpuRetry() { clearTimeout(gpuRetry); gpuRetry = undefined; }
function scheduleGpuRetry() {
  if (!wantsGpu() || gpuRetry || gpu.ready) return;
  gpuRetry = setTimeout(() => { gpuRetry = undefined; void connectGpu(); }, gpuRetryDelay);
  gpuRetry.unref(); gpuRetryDelay = Math.min(gpuRetryDelay * 2, 30000);
}
function fallback(reason = 'connection-unavailable') {
  videoNonce++; videoGeneration = false; gpu.close();
  state.video = state.connected ? '静态画面 · 语音继续' : '静态待机';
  // Bounded metadata only: no audio, frames, credentials or dialogue content.
  try { const saved = storage.read('video-diagnostics.json')?.events; const recent = Array.isArray(saved) ? saved : []; storage.write('video-diagnostics.json', { events: [...recent.slice(-49), { time: new Date().toISOString(), reason, generation, receivedSamples, playedSamples }] }); } catch { /* Diagnostics must not interrupt audio playback. */ }
  media({ type: 'fallback' }); update(); scheduleGpuRetry();
}
async function connectGpu() {
  if (!wantsGpu() || gpuConnecting || gpu.ready) return;
  clearGpuRetry(); gpuConnecting = true; const nonce = ++videoNonce;
  state.video = mediaActive ? '静态画面 · 正在重连' : '连接数字人'; update();
  try {
    await gpu.connect(storage.preferences.gpuUrl);
    if (nonce !== videoNonce || !wantsGpu()) { if (!wantsGpu()) gpu.close(); return; }
    gpuRetryDelay = 2000; state.video = mediaActive ? '下次回复恢复视频' : '数字人就绪'; update();
  } catch { if (nonce === videoNonce) fallback(); }
  finally { gpuConnecting = false; if (wantsGpu() && !gpu.ready) scheduleGpuRetry(); }
}
const pump = setInterval(() => turns.pump(state?.connected && !playing && Date.now() >= speakingUntil), 100); pump.unref();
// A separate trace lasts for the whole call: playback often ends after the request span.
cloud.on('diagnostic', o => voiceDiagnostic(`aliyun.${o.event}`, o));
cloud.on('event', o => {
  if (!state?.connected) return;
  if (isNoSpeechRecognized(o)) {
    // Keep only recent metadata; an empty ASR turn must not cancel another request.
    try {
      const saved = storage.read('voice-diagnostics.json')?.events;
      const recent = Array.isArray(saved) ? saved : [];
      storage.write('voice-diagnostics.json', { events: [...recent.slice(-49), {
        time: new Date().toISOString(), task_id: cloud.call, dialog_id: o.dialog_id || cloud.dialog,
        round_id: o.round_id, llm_request_id: o.llm_request_id, error_code: o.error_code, error_name: o.error_name,
        state: cloud.state, micMuted: storage.preferences.micMuted,
      }] });
    } catch { /* Diagnostics must not interrupt the call. */ }
    return;
  }
  const muted = turns.muted;
  turns.event(o);
  if (o.event === 'Error') { const error = new Error(`阿里云：${o.error_name || '请求失败'}`); userRequest?.controller.abort(error); fault(error.message); }
  if (o.event === 'SpeechStarted') { userRequest?.controller.abort(new DOMException('检测到新的语音输入（SpeechStarted）', 'AbortError')); userRequest = undefined; turns.interrupt(); speakingUntil = Date.now() + 600; interrupt('speech-started'); }
  if (o.event === 'SpeechContent' && (!turns.internalPrompt || o.text !== turns.internalPrompt)) {
    state.heard = o.text || '';
    if (!o.finished) speakingUntil = Date.now() + 600;
    else if (o.text && (!userRequest || userRequest.text !== o.text)) {
      const request = newRequest(o.text, 'voice');
      void answer(request, turns.listen(cloud.call, request.controller.signal, request.trace, o.text));
    }
  }
  if (muted && ['RespondingContent', 'RespondingStarted', 'RespondingEnded'].includes(o.event)) return;
  if (o.event === 'RespondingContent') state.subtitle = o.text || state.subtitle;
  if (o.event === 'RespondingStarted') begin();
  if (o.event === 'RespondingEnded') { if (mediaActive) { media({ type: 'end' }); if (videoGeneration) gpu.end(); } }
  update();
});
cloud.on('audio', (data: Buffer) => {
  if (!mediaActive || turns.muted) return;
  receivedSamples += data.length / 2;
  if (receivedSamples - playedSamples > MAX_REPLY_AUDIO_SAMPLES) { interrupt('main-audio-overflow'); cloud.directive('RequestToSpeak'); fault('回复音频缓存已满，已停止本次播放；后台任务继续'); return; }
  media({ type: 'audio', data: new Uint8Array(data) }); if (videoGeneration) gpu.audio(data);
});
cloud.on('fault', fault);
cloud.on('disconnected', (error?: Error) => { if (state) { if (error) fault(error.message); void stopCall(error).catch(e => fault(e.message)); } });
gpu.on('frame', f => { if (mediaActive && videoGeneration && f.generation === generation) media({ type: 'frame', index: f.index, data: new Uint8Array(f.data) }); });
gpu.on('fallback', fallback);
async function startCall() {
  if (endingCall) await endingCall;
  if (state.connected) return;
  state.error = ''; state.subtitle = ''; state.heard = '';
  userRequest?.controller.abort(); userRequest = undefined; turns.reset();
  state.connected = true; update();
  void connectGpu();
  try {
    const connecting = cloud.connect(storage.cloud);
    voiceSequence = 0; voiceTrace = startRequestTrace(cloud.call, '', 'voice-diagnostics');
    voiceDiagnostic('call.connecting');
    tasks.beginCall(cloud.call); await connecting; update();
  }
  catch (e) { await stopCall(); throw e; }
}
function stopCall(reason: Error = new DOMException('通话已结束', 'AbortError')): Promise<void> {
  if (endingCall) return endingCall;
  state.connected = false; videoNonce++; clearGpuRetry(); interrupt('call-ended'); gpu.close();
  userRequest?.controller.abort(reason); userRequest = undefined; turns.reset(reason);
  state.video = '静态待机'; update();
  endingCall = Promise.resolve().then(async () => {
    const outcomes = await Promise.allSettled([cloud.stop(), tasks.endCall()]);
    update();
    const failure = outcomes.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) throw failure.reason;
  }).finally(() => {
    voiceDiagnostic('call.ended', { reason: reason.message });
    voiceTrace?.end(reason.name === 'AbortError' ? undefined : reason); voiceTrace = undefined;
    endingCall = undefined; commandTraces.clear();
  });
  return endingCall;
}
async function sendText(text: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw new Error('文字消息无效');
  if (!cloud.ready) throw new Error('请先开始通话');
  state.error = '';
  const request = newRequest(text.trim());
  state.heard = request.text; state.subtitle = ''; update();
  void answer(request, turns.request({ call: cloud.call, text: request.text, user: true, signal: request.controller.signal, trace: request.trace }));
  if (cloud.state !== 'Listening') { interrupt('user-text'); cloud.directive('RequestToSpeak'); }
}
function show() { window.showInactive(); if (state.connected && !gpu.ready) void connectGpu(); }
function hide() { window.hide(); clearGpuRetry(); fallback('hidden'); }
async function shutdown() { if (quitting) return; quitting = true; try { if (state) await stopCall(); } catch (e: any) { console.error(e.message); } try { await tasks?.shutdown(); } catch (e: any) { console.error(e.message); } host?.disconnect(); clearInterval(pump); tray?.destroy(); await shutdownTracing(); app.exit(exitStatus); }
void app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../..');
  initTracing(app.isPackaged ? undefined : path.join(root, '.env'));
  const importAt = process.argv.indexOf('--import-env');
  storage = new Storage(app.getPath('userData'), app.isPackaged || importAt >= 0 ? undefined : root);
  if (importAt >= 0 && process.argv[importAt + 1]) storage.importEnv(path.resolve(process.argv[importAt + 1]));
  if (!storage.cloud.key || !storage.dshUrl) {
    const result = await dialog.showOpenDialog({ title: '首次使用：选择已填写的 Olivia Soul .env 配置', properties: ['openFile', 'showHiddenFiles'] });
    if (result.canceled || !result.filePaths[0]) { app.exit(0); return; }
    storage.importEnv(result.filePaths[0]);
  }
  host = new DshHost(() => storage.dshUrl);
  // Do not show a usable application until the user-managed dsh passes auth
  // and Remote API checks. No CLI discovery or process launch is involved.
  await host.ensure();
  tasks = new Tasks(host, () => storage.preferences);
  state = { connected: false, cloud: 'Disconnected', video: '静态待机', subtitle: '', heard: '', tasks: [], configured: !!storage.cloud.key, preferences: storage.preferences };
  tasks.on('connection-error', message => fault(message));
  tasks.on('connection-restored', () => { if (state.error?.startsWith('dsh 连接中断')) { state.error = ''; update(); } });
  await tasks.ensure();
  tasks.on('change', update);
  tasks.on('finished', (t: TaskRecord, run: TaskRun) => {
    if (!state.connected || t.call !== cloud.call) return;
    const text = `这是已登记电脑任务的执行结果通知，不是新任务，不要再次调用电脑工具。\n${JSON.stringify({ task_id: t.id, title: t.title, goal: run.goal, status: run.status, result: run.response || run.endReason || run.status })}\n请按当前人设简洁告诉用户本次请求的结果。completed 表示本次执行已结束；是否达成目标以执行端汇报为准。`;
    const trace = startRequestTrace(t.call, text, 'notification', { sourceTraceId: commandTraces.get(run.commandKey), taskId: t.id, dshSessionId: t.sessionId, runId: run.requestId });
    void turns.request({ call: t.call, afterCommand: run.commandKey, text, trace }).catch(e => {
      trace?.end(e);
      if (state.connected && t.call === cloud.call && e.name !== 'AbortError') fault(e.message);
    }).finally(() => trace?.end());
  });
  const bounds = storage.read('window.json'), area = screen.getPrimaryDisplay().workArea;
  let xy = { x: area.x + area.width - 360, y: area.y + Math.max(0, area.height - 600) };
  if (bounds && screen.getAllDisplays().some(d => bounds.x >= d.workArea.x && bounds.x < d.workArea.x + d.workArea.width - 80 && bounds.y >= d.workArea.y && bounds.y < d.workArea.y + d.workArea.height - 80)) xy = { x: bounds.x, y: bounds.y };
  window = new BrowserWindow({ ...xy, width: 320, height: 505, minWidth: 280, minHeight: 360, frame: false, transparent: true, backgroundColor: '#00000000', thickFrame: false, resizable: true, alwaysOnTop: storage.preferences.alwaysOnTop, show: false, skipTaskbar: true, hasShadow: true, webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', e => e.preventDefault());
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(wc === window.webContents && permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => wc === window.webContents && permission === 'media');
  window.on('close', e => { if (!quitting) { e.preventDefault(); hide(); } });
  // Background throttling is disabled for audio, so report native visibility explicitly.
  window.on('hide', () => window.webContents.send('soul:visibility', false));
  window.on('show', () => window.webContents.send('soul:visibility', true));
  let moveTimer: NodeJS.Timeout; window.on('moved', () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => storage.write('window.json', window.getBounds()), 300); });
  window.webContents.on('render-process-gone', () => { void stopCall().catch(e => fault(e.message)); });
  const valid = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => { if (e.sender !== window.webContents || e.senderFrame !== window.webContents.mainFrame) throw new Error('IPC 来源无效'); };
  const handle = (name: string, fn: (...args: any[]) => any) => ipcMain.handle(`soul:${name}`, async (e, ...args) => { valid(e); try { return await fn(...args); } catch (error: any) { throw new Error(error.message || '操作失败'); } });
  handle('state', () => { update(); return state; }); handle('start', startCall); handle('stop', stopCall); handle('text', sendText); handle('cancel', (id: string) => tasks.cancel(id));
  handle('memory', (request: MemoryRequest) => {
    if (app.isPackaged) throw new Error('记忆管理暂仅支持 npm start 开发运行');
    const { appId, workspaceId } = storage.cloud;
    const api = new MemoryClient(memoryConfig({ ...storage.memoryEnv, app_id: appId, workspace_id: workspaceId }));
    return runMemory(api, { appId, workspaceId }, { ...request, user: storage.cloud.userId || MEMORY_USER });
  });
  handle('dsh', async () => { state.error = ''; update(); await tasks.ensure(); await shell.openExternal(await host.browserUrl()); update(); });
  handle('import', async () => {
    if (state.connected || endingCall || tasks.hasActive) throw new Error('请先结束通话及活动电脑任务再导入配置；更新 token 也可修改 .env 后重启 Soul');
    const result = await dialog.showOpenDialog(window, { title: '导入 Olivia Soul 配置', properties: ['openFile', 'showHiddenFiles'] });
    if (!result.canceled && result.filePaths[0]) {
      storage.importEnv(result.filePaths[0]); host.disconnect(); update();
      await tasks.ensure(); state.error = ''; update();
    }
  });
  handle('preferences', (raw: Preferences) => {
    const p = Object.fromEntries(Object.keys(storage.preferences).map(k => [k, (raw as any)?.[k]])) as unknown as Preferences;
    for (const k of Object.keys(storage.preferences)) if (typeof (p as any)[k] !== typeof (storage.preferences as any)[k]) throw new Error('设置格式无效');
    const connection = ['dshCwd', 'gpuUrl', 'inputDevice'];
    const changed = connection.some(k => (p as any)[k] !== (storage.preferences as any)[k]);
    if (changed && (state.connected || endingCall || tasks.hasActive)) throw new Error('请在通话及活动电脑任务结束后更改连接设置');
    storage.savePreferences(p); window.setAlwaysOnTop(p.alwaysOnTop);
    if (!p.gpuEnabled) { clearGpuRetry(); fallback('disabled'); } else if (state.connected && !gpu.ready) void connectGpu();
    state.error = ''; update();
  });
  ipcMain.on('soul:hide', e => { valid(e); hide(); }); ipcMain.on('soul:focus', e => { valid(e); window.focus(); });
  ipcMain.on('soul:audio', (e, data, speaking) => { valid(e); if (!(data instanceof ArrayBuffer) || data.byteLength > 6400 || data.byteLength % 2) return; if (speaking === true && !storage.preferences.micMuted) speakingUntil = Date.now() + 700; cloud.sendAudio(storage.preferences.micMuted ? Buffer.alloc(data.byteLength) : new Uint8Array(data)); });
  ipcMain.on('soul:playback', (e, m: Playback) => {
    valid(e); if (!m || m.call !== cloud.call || m.generation !== generation || !Number.isFinite(m.samples) || m.samples < 0) return;
    playedSamples = Math.max(playedSamples, Math.min(receivedSamples, m.samples));
    if (m.type === 'started' || m.type === 'ended' || m.type === 'overflow') voiceDiagnostic(`playback.${m.type}`, { samples: m.samples });
    if (m.type === 'started' && !playing) { playing = true; cloud.directive('LocalRespondingStarted'); }
    if (m.type === 'ended') { if (playing) cloud.directive('LocalRespondingEnded'); playing = false; mediaActive = false; }
    if (m.type === 'progress' && videoGeneration) gpu.progress(Math.floor(playedSamples));
    if (m.type === 'fallback') fallback(['queue-overflow', 'first-frame-timeout', 'video-stall', 'decode-error'].includes(m.reason || '') ? m.reason : 'renderer-fallback');
    if (m.type === 'overflow') { interrupt('renderer-audio-overflow'); cloud.directive('RequestToSpeak'); fault('回复音频过长，已停止本次播放；后台任务继续'); }
  });
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../renderer/logo.png')).resize({ width: 20, height: 20 }));
  tray.setToolTip('Olivia Soul'); tray.setContextMenu(Menu.buildFromTemplate([{ label: '显示桌宠', click: show }, { label: '收起桌宠', click: hide }, { label: '结束通话', click: () => { void stopCall().catch(e => fault(e.message)); } }, { type: 'separator' }, { label: '退出', click: () => { void shutdown(); } }])); tray.on('double-click', show);
  await window.loadFile(path.join(__dirname, '../renderer/index.html'), smoke ? { query: { smoke: '1' } } : {});
  show(); update();
  if (smoke) {
    const { runSmoke } = require(path.resolve('.cache/smoke-runner.cjs')) as typeof import('../../tests/smoke');
    void runSmoke({ window, cloud, tasks, storage, sendText, startCall, stopCall, shutdown, setCommandOverride: f => { commandOverride = f; } }).catch(async e => { exitStatus = 1; console.error('SMOKE_FAILED', e.message); fs.mkdirSync('test-results', { recursive: true }); fs.writeFileSync('test-results/smoke-error.txt', e.stack || e.message); await shutdown(); });
  }
}).catch(async (e: any) => { host?.disconnect(); dialog.showErrorBox('Olivia Soul 启动失败', e.message || '应用启动失败'); await shutdownTracing(); app.exit(1); });
app.on('second-instance', () => { if (window) show(); });
app.on('before-quit', e => { if (!quitting && tasks) { e.preventDefault(); void shutdown(); } });
app.on('window-all-closed', () => {});
