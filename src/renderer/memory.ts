import { icon } from './icons';
import type { MemoryNode, MemoryProject, MemoryRequest } from '../shared/memory';

export function setupMemory(beforeOpen: () => void) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = el('memory'), editor = el<HTMLFormElement>('memory-editor');
  const content = el<HTMLTextAreaElement>('memory-content'), projectSelect = el<HTMLSelectElement>('memory-project');
  let project: MemoryProject = 'observation_project', page = 1, total = 0, nodes: MemoryNode[] = [];
  let busy = false, loaded = false, editing: string | undefined, confirming: string | undefined;
  el('memory-toggle').innerHTML = icon('memory'); el('memory-back').innerHTML = icon('back');
  function message(text = '', failed = false) {
    el('memory-message').textContent = text; el('memory-message').hidden = !text;
    el('memory-message').classList.toggle('failed', failed);
  }
  function controls() {
    panel.setAttribute('aria-busy', String(busy));
    for (const button of panel.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy;
    projectSelect.disabled = busy || !editor.hidden;
    content.disabled = busy;
    el<HTMLButtonElement>('memory-refresh').disabled = busy || !editor.hidden;
    el<HTMLButtonElement>('memory-add').disabled = busy || !editor.hidden || !loaded;
    el<HTMLButtonElement>('memory-prev').disabled = busy || !editor.hidden || !loaded || page <= 1;
    el<HTMLButtonElement>('memory-next').disabled = busy || !editor.hidden || !loaded || page * 20 >= total;
    for (const button of el('memory-list').querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy || !editor.hidden;
  }
  function show(open: boolean) {
    if (busy && !open) return;
    if (open) beforeOpen();
    panel.hidden = !open;
    panel.closest('main')!.classList.toggle('memory-open', open);
    el('memory-toggle').setAttribute('aria-expanded', String(open));
    for (const id of ['task-toggle', 'settings-toggle', 'text-toggle']) el<HTMLButtonElement>(id).disabled = open;
    if (open) {
      if (editor.hidden) void load();
      else { window.soul.focusInput(); content.focus(); }
    } else el('memory-toggle').focus();
  }
  function startEdit(node?: MemoryNode) {
    editing = node?.memoryNodeId; confirming = undefined; renderList();
    editor.hidden = false; content.value = node?.content || '';
    el('memory-editor-label').textContent = node ? '编辑记忆' : `新增${project === 'profile_project' ? '画像记忆' : '记忆片段'}`;
    message(); controls(); panel.scrollTop = 0; window.soul.focusInput(); content.focus();
  }
  function closeEditor() { editor.hidden = true; editing = undefined; content.value = ''; controls(); }
  function renderList() {
    const list = el('memory-list'); list.replaceChildren();
    if (loaded && !nodes.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '暂无记忆，可以手动新增。'; list.append(p); }
    for (const node of nodes) {
      const row = document.createElement('article'); row.className = 'memory-item';
      const text = document.createElement('p'); text.textContent = node.content; row.append(text);
      const actions = document.createElement('div'); actions.className = 'memory-actions';
      function button(label: string, click: () => void) { const b = document.createElement('button'); b.textContent = label; b.onclick = click; actions.append(b); }
      if (confirming === node.memoryNodeId) {
        const hint = document.createElement('span'); hint.textContent = '删除这条记忆？'; actions.append(hint);
        button('取消', () => { confirming = undefined; renderList(); controls(); });
        button('确认删除', () => void mutate({ command: 'delete', id: node.memoryNodeId }, '已删除'));
      } else {
        button('编辑', () => startEdit(node));
        button('删除', () => { confirming = node.memoryNodeId; renderList(); controls(); });
      }
      row.append(actions); list.append(row);
    }
    el('memory-count').textContent = loaded ? `${page} / ${Math.max(1, Math.ceil(total / 20))} 页 · ${total} 条` : '';
  }
  async function fetchList() {
    const result = await window.soul.memory({ command: 'list', project, page });
    const data = result.data, count = Number(data?.total);
    if (!Array.isArray(data?.memoryNodes) || data?.total === undefined || !Number.isSafeInteger(count) || count < 0 || data.memoryNodes.some(n => !n.memoryNodeId || typeof n.content !== 'string')) throw new Error('记忆列表返回不完整，请刷新重试');
    total = count;
    if (page > Math.max(1, Math.ceil(total / 20))) { page = Math.max(1, Math.ceil(total / 20)); return fetchList(); }
    nodes = data.memoryNodes; loaded = true; confirming = undefined; renderList();
  }
  async function fetchProfile() {
    if (!el<HTMLDetailsElement>('memory-profile').open) return;
    const container = el('memory-profile-content'); container.textContent = '正在加载…';
    try {
      const result = await window.soul.memory({ command: 'profile' });
      if (!Array.isArray(result.data?.attributes)) throw new Error('用户画像返回不完整');
      container.replaceChildren();
      for (const attribute of result.data.attributes) {
        const p = document.createElement('p'); p.textContent = `${attribute.name || '未命名'}：${attribute.value || '暂无'}`; container.append(p);
      }
      if (!result.data.attributes.length) container.textContent = '暂无用户画像';
    } catch (e) { container.textContent = cleanError(e); }
  }
  function cleanError(e: unknown) { return (e instanceof Error ? e.message : '操作失败').replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  async function load() {
    if (busy) return;
    busy = true; message('正在加载…'); controls();
    try { await fetchList(); message(); await fetchProfile(); }
    catch (e) { loaded = false; nodes = []; renderList(); message(cleanError(e), true); }
    finally { busy = false; controls(); }
  }
  async function mutate(request: MemoryRequest, success: string) {
    if (busy) return;
    busy = true; controls(); message('正在保存…');
    try {
      await window.soul.memory(request);
      closeEditor(); confirming = undefined; message(success);
      try { await fetchList(); await fetchProfile(); }
      catch (e) { loaded = false; nodes = []; renderList(); message(`${success}，但刷新失败：${cleanError(e)}`, true); }
    } catch (e) { message(`${cleanError(e)}；如请求超时，请先刷新核对，避免重复提交。`, true); }
    finally { busy = false; controls(); }
  }
  el('memory-toggle').onclick = () => show(panel.hidden === true);
  el('memory-back').onclick = () => show(false);
  el('memory-refresh').onclick = () => void load();
  el('memory-add').onclick = () => startEdit();
  el('memory-cancel').onclick = () => { closeEditor(); message(); };
  content.onpointerdown = () => window.soul.focusInput();
  editor.onsubmit = event => {
    event.preventDefault();
    if (!content.value.trim()) { message('记忆内容不能为空', true); return; }
    void mutate(editing ? { command: 'update', id: editing, content: content.value.trim() } : { command: 'create', project, content: content.value.trim() }, editing ? '已保存' : '已新增');
  };
  projectSelect.onchange = () => { project = projectSelect.value as MemoryProject; page = 1; loaded = false; nodes = []; renderList(); void load(); };
  el('memory-prev').onclick = () => { page--; void load(); };
  el('memory-next').onclick = () => { page++; void load(); };
  el('memory-profile').ontoggle = () => { if (!busy) void fetchProfile(); };
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || panel.hidden || busy) return;
    if (!editor.hidden) { closeEditor(); message(); }
    else if (confirming) { confirming = undefined; renderList(); controls(); }
    else show(false);
    event.preventDefault();
  });
}
