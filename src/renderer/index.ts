import { icon } from './icons';
import type { Preferences, SoulState } from '../shared/types';
import { MediaEngine } from './media';
import { AvatarView } from './avatar';
import { setupMemory } from './memory';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: SoulState, pending = false, taskOpen = false, seenTaskUpdate = '', selectedTask = '';
function button(id: string, glyph: Parameters<typeof icon>[0], label: string) { const e = el(id); e.innerHTML = icon(glyph); e.title = label; e.setAttribute('aria-label', label); }
button('settings-toggle', 'settings', '设置'); button('hide', 'hide', '收起到托盘');
button('task-toggle', 'task', '电脑任务'); button('task-close', 'close', '收起任务');
button('text-toggle', 'keyboard', '文字输入'); button('dsh', 'terminal', '打开 dsh');
button('cancel', 'stop', '停止当前任务'); button('task-open', 'open', '在 dsh 中查看任务');
button('send', 'send', '发送消息');
function error(message: string) { el('error').textContent = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); el('error').hidden = !message; }
const avatar = new AvatarView(el<HTMLCanvasElement>('video'), el<HTMLVideoElement>('idle'));
const media = new MediaEngine(el<HTMLCanvasElement>('video'), el('portrait'), error, avatar);
const offVisibility = window.soul.onVisibility(visible => avatar.setVisible(visible));
window.addEventListener('beforeunload', () => { offVisibility(); avatar.dispose(); });
const states: Record<string, string> = { Disconnected: '未接通', Connecting: '连接中', Listening: '正在聆听', Thinking: '想一想', Responding: '正在回应' };
const statuses: Record<string, string> = { running: '后台执行中', waiting_permission: '等待你处理', cancelling: '正在取消', completed: '任务已完成', failed: '执行失败', cancelled: '任务已停止', unknown: '需要核对' };
function renderTask() {
  const task = state.tasks.find(t => t.id === selectedTask) || state.tasks.at(-1);
  selectedTask = task?.id || '';
  const select = el<HTMLSelectElement>('task-select');
  const options = state.tasks.map(t => ({ id: t.id, label: `${t.title} · ${statuses[t.status]}` }));
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map(t => new Option(t.label, t.id)));
    select.dataset.options = signature;
  }
  select.value = selectedTask; select.hidden = !task;
  const changed = state.tasks.filter(t => ['waiting_permission', 'unknown', 'completed', 'failed', 'cancelled'].includes(t.status));
  const update = changed.length ? JSON.stringify(changed.map(t => [t.id, t.status, t.detail])) : '';
  if (taskOpen) seenTaskUpdate = update;
  const unread = !!update && update !== seenTaskUpdate;
  el('task-toggle').classList.toggle('unread', unread);
  el('task-toggle').title = unread ? '电脑任务 · 有更新' : '电脑任务';
  el('task-toggle').setAttribute('aria-label', el('task-toggle').title);
  el('task-toggle').setAttribute('aria-expanded', String(taskOpen));
  el('task').hidden = !taskOpen;
  el('task-empty').hidden = !!task; el('task-content').hidden = !task;
  if (task) {
    el('task-status').textContent = statuses[task.status]; el('task-title').textContent = task.title;
    el('task-detail').textContent = task.detail;
    el<HTMLButtonElement>('cancel').disabled = ['completed', 'cancelled', 'failed', 'cancelling'].includes(task.status);
  }
}
function setTaskOpen(open: boolean, restoreFocus = false) {
  taskOpen = open;
  if (open) { el('settings').hidden = true; el('settings-toggle').setAttribute('aria-expanded', 'false'); }
  renderTask();
  if (open) el('task').focus(); else if (restoreFocus) el('task-toggle').focus();
}
function render(s: SoulState) {
  const wasConnected = state?.connected; state = s;
  button('call', s.connected ? 'hangup' : 'phone', pending ? '请稍候…' : s.connected ? '结束通话' : '开始通话'); el('call').classList.toggle('connected', s.connected);
  el('call').title += ` · ${states[s.cloud] || s.cloud} · ${s.video.replaceAll('静态画面', '待机画面').replaceAll('静态待机', '待机')}`;
  el<HTMLButtonElement>('call').disabled = pending;
  button('mic', s.preferences.micMuted ? 'micOff' : 'mic', s.preferences.micMuted ? '打开麦克风' : '关闭麦克风'); el('mic').setAttribute('aria-pressed', String(!s.preferences.micMuted)); el('mic').classList.toggle('muted', s.preferences.micMuted);
  button('speaker', s.preferences.speakerMuted ? 'speakerOff' : 'speaker', s.preferences.speakerMuted ? '打开扬声器' : '静音扬声器'); el('speaker').setAttribute('aria-pressed', String(!s.preferences.speakerMuted)); el('speaker').classList.toggle('muted', s.preferences.speakerMuted);
  el('heard').textContent = s.heard; el('heard').title = s.heard;
  el('subtitle').textContent = s.subtitle;
  el('subtitle').title = s.subtitle;
  el('conversation').classList.toggle('empty', !s.heard && !s.subtitle);
  renderTask();
  error(s.error || '');
  if (wasConnected && !s.connected) void media.stop();
}
async function action(fn: () => Promise<unknown>) { try { error(''); await fn(); } catch (e: any) { error(e.message || '操作失败'); } }
async function connect(microphone = true) { if (!state.configured) { await window.soul.importConfig(); state = await window.soul.state(); if (!state.configured) return; } await media.start(state.preferences, microphone); try { await window.soul.start(); } catch (e) { await media.stop(); throw e; } }
el('call').onclick = () => action(async () => { pending = true; render(state); try { if (state.connected) { await window.soul.stop(); await media.stop(); } else await connect(); } finally { pending = false; render(await window.soul.state()); } });
el('mic').onclick = () => action(async () => { const p = { ...state.preferences, micMuted: !state.preferences.micMuted }; await window.soul.savePreferences(p); await media.preferences(p); });
el('speaker').onclick = () => action(async () => { const p = { ...state.preferences, speakerMuted: !state.preferences.speakerMuted }; await window.soul.savePreferences(p); await media.preferences(p); });
el('hide').onclick = () => window.soul.hide();
el('dsh').onclick = el('task-open').onclick = () => action(() => window.soul.openDsh());
el('cancel').onclick = () => action(() => window.soul.cancel(selectedTask));
el('task-select').onchange = () => { selectedTask = el<HTMLSelectElement>('task-select').value; renderTask(); };
el('task-toggle').onclick = () => setTaskOpen(!taskOpen, taskOpen);
el('task-close').onclick = () => setTaskOpen(false, true);
document.addEventListener('pointerdown', event => { if (taskOpen && !el('task').contains(event.target as Node) && !el('task-toggle').contains(event.target as Node)) setTaskOpen(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && taskOpen) { setTaskOpen(false, true); event.preventDefault(); } });
el('import').onclick = () => action(() => window.soul.importConfig());
el('text-toggle').onclick = () => { el('text-form').hidden = !el('text-form').hidden; if (!el('text-form').hidden) { window.soul.focusInput(); el('text').focus(); } };
el('text').onpointerdown = () => window.soul.focusInput();
el<HTMLFormElement>('text-form').onsubmit = event => { event.preventDefault(); void action(async () => { const input = el<HTMLTextAreaElement>('text'); const text = input.value.trim(); if (!text) return; if (!state.connected) await connect(); await window.soul.text(text); input.value = ''; el('text-form').hidden = true; }); };
const fields: Record<string, keyof Preferences> = { 'gpu-url': 'gpuUrl', 'dsh-cwd': 'dshCwd', 'input-device': 'inputDevice', 'output-device': 'outputDevice' };
el('settings-toggle').onclick = () => action(async () => {
  el('settings').hidden = !el('settings').hidden;
  el('settings-toggle').setAttribute('aria-expanded', String(!el('settings').hidden));
  if (!el('settings').hidden) {
    setTaskOpen(false);
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [id, kind] of [['input-device', 'audioinput'], ['output-device', 'audiooutput']]) { const select = el<HTMLSelectElement>(id); select.replaceChildren(new Option('系统默认', '')); for (const d of devices.filter(d => d.kind === kind)) select.add(new Option(d.label || `设备 ${select.options.length}`, d.deviceId)); }
    for (const [id, key] of Object.entries(fields)) el<HTMLInputElement>(id).value = String(state.preferences[key]);
    el<HTMLInputElement>('dsh-url').value = state.preferences.dshBaseUrl;
    el<HTMLInputElement>('top').checked = state.preferences.alwaysOnTop; el<HTMLInputElement>('gpu-enabled').checked = state.preferences.gpuEnabled;
    el('settings').scrollTop = 0;
  }
});
el('save').onclick = () => action(async () => { const p = { ...state.preferences }; for (const [id, key] of Object.entries(fields)) (p as any)[key] = el<HTMLInputElement>(id).value.trim(); p.alwaysOnTop = el<HTMLInputElement>('top').checked; p.gpuEnabled = el<HTMLInputElement>('gpu-enabled').checked; await window.soul.savePreferences(p); await media.preferences(p); el('settings').hidden = true; el('settings-toggle').setAttribute('aria-expanded', 'false'); });
window.soul.onState(render); window.soul.onMedia(m => media.receive(m));
setupMemory(() => {
  setTaskOpen(false);
  el('settings').hidden = true; el('settings-toggle').setAttribute('aria-expanded', 'false');
  el('text-form').hidden = true;
});
void window.soul.state().then(render);
// Exposes no credentials or node access; used only by the explicit development smoke runner.
if (new URLSearchParams(location.search).has('smoke')) (window as any).soulSmoke = { connect: () => connect(false), stop: () => media.stop() };
