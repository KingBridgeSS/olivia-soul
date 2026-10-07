import type { ComputerCommand } from './types';
export const actions = ['start', 'continue', 'cancel'] as const;
export const toolNames = ['computer_task', 'list_tasks', 'get_task', 'take_screenshot'] as const;
export interface ParsedCommand { id: string; name: ComputerCommand['name']; arguments?: unknown; command?: ComputerCommand; error?: string }
export function parseCommandBatch(raw: unknown, issue?: (reason: string) => void): ParsedCommand[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'string' || raw.length > 64000) { issue?.('commands 类型无效或超过 64000 字符'); return []; }
  let list: unknown; try { list = JSON.parse(raw); } catch { issue?.('commands JSON 无效'); return []; }
  if (!Array.isArray(list)) { issue?.('commands 不是数组'); return []; }
  if (list.length > 8) issue?.('单批超过 8 条，后续指令被忽略');
  return list.slice(0, 8).filter(c => {
    if (!c || !toolNames.includes(c.name)) { issue?.('未知工具名称'); return false; }
    if (typeof c.command_request_id !== 'string' || !c.command_request_id.length || c.command_request_id.length > 1024) { issue?.('command_request_id 无效'); return false; }
    return true;
  }).map(c => {
    const args = Array.isArray(c.params) && c.params.every((p: any) => p && typeof p.name === 'string')
      ? Object.fromEntries(c.params.map((p: any) => [p.name, p.value])) : c.params ?? {};
    const entry = { id: c.command_request_id, name: c.name, arguments: args };
    try { return { ...entry, command: parseCommands(JSON.stringify([c]))[0] }; }
    catch (e) { const error = e instanceof Error ? e.message : '工具参数无效'; issue?.(error); return { ...entry, error }; }
  });
}
export function parseCommands(raw: unknown): ComputerCommand[] {
  if (typeof raw !== 'string' || raw.length > 64000) return [];
  let list: unknown; try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).filter((c: any) => c && toolNames.includes(c.name) && typeof c.command_request_id === 'string')
    .map(c => {
      const p: Record<string, unknown> = Array.isArray(c.params) ? Object.fromEntries(c.params.map((v: any) => [v.name, v.value])) : c.params || {};
      const action = p.action;
      if (!c.command_request_id || c.command_request_id.length > 1024) throw new Error('指令 ID 无效');
      if (c.name === 'computer_task' && !actions.includes(action as any)) throw new Error('电脑指令 action 无效');
      const taskId = typeof p.task_id === 'string' ? p.task_id.trim() : undefined;
      if ((c.name === 'get_task' || c.name === 'computer_task' && action !== 'start') && !taskId) throw new Error('缺少 task_id，请先用 list_tasks 查询');
      if (taskId && taskId.length > 100) throw new Error('task_id 无效');
      const goal = typeof p.goal === 'string' ? p.goal.trim() : '';
      if (c.name === 'computer_task' && ['start', 'continue'].includes(action as string) && !goal) throw new Error('电脑任务缺少目标');
      if (goal.length > 12000 || (typeof p.context === 'string' && p.context.length > 12000)) throw new Error('电脑任务过长');
      return { id: c.command_request_id, name: c.name, action: c.name === 'computer_task' ? action : undefined, taskId, goal, context: typeof p.context === 'string' ? p.context : '' } as ComputerCommand;
    });
}
export function commandResult(id: string, text: string, success: boolean) {
  return { command_request_id: id, invoke_result: { content: { type: 'text', text }, structuredContent: { success } } };
}
