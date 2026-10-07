import type { ParsedCommand } from '../shared/commands';
import type { ComputerCommand } from '../shared/types';
import type { CommandOutcome } from './tasks';
import type { RequestTrace } from './tracing';

export const MAX_TOOL_ROUNDS = 8;
export const TOOL_LIMIT = '工具调用已达到本次请求的轮数上限，已停止继续尝试。请补充要操作的任务或具体要求。';
export type ToolStep = { entry: ParsedCommand; outcome: CommandOutcome };
export interface ToolTurn {
  trace?: RequestTrace;
  execute(command: ComputerCommand): Promise<CommandOutcome>;
  submit(steps: ToolStep[]): Promise<void>;
  next(history: ToolStep[], allowMoreTools: boolean): Promise<ParsedCommand[]>;
  finish(text: string): Promise<void>;
}

// Only coordinates tool calls. A computer_task receipt does not wait for dsh completion.
export async function runToolLoop(calls: ParsedCommand[], turn: ToolTurn, signal: AbortSignal) {
  const history: ToolStep[] = [], results = new Map<string, CommandOutcome>();
  for (let round = 0; calls.length && round < MAX_TOOL_ROUNDS; round++) {
    if (signal.aborted) return;
    const steps: ToolStep[] = [];
    let fatal: CommandOutcome | undefined;
    for (const entry of calls) {
      let outcome = results.get(entry.id);
      const observation = turn.trace?.tool(entry, round + 1, !!outcome);
      if (!outcome) {
        if (signal.aborted || fatal) outcome = { success: false, text: '本次请求已停止，此指令未执行' };
        else if (!entry.command) outcome = { success: false, text: `未执行：${entry.error}`, retryable: true };
        else {
          try { outcome = await turn.execute(entry.command); }
          catch (e) { outcome = { success: false, text: e instanceof Error ? e.message : '工具执行失败' }; }
        }
        results.set(entry.id, outcome);
      }
      if (!outcome.success && !outcome.retryable) fatal ??= outcome;
      steps.push({ entry, outcome });
      turn.trace?.step({ entry, outcome }, observation);
    }
    history.push(...steps);
    // Even after interruption, settle already-issued calls in the original cloud session.
    await turn.submit(steps);
    if (signal.aborted) return;
    if (fatal) {
      await turn.finish(`本次请求未能确认完成，已停止自动重试。${fatal.text}`);
      return;
    }
    calls = await turn.next(history, round + 1 < MAX_TOOL_ROUNDS);
  }
  if (!signal.aborted && calls.length) {
    turn.trace?.event('tool.round_limit', { limit: MAX_TOOL_ROUNDS, rejectedCommands: calls });
    await turn.submit(calls.map(entry => ({ entry, outcome: { success: false, text: `未执行：${TOOL_LIMIT}` } })));
    if (!signal.aborted) await turn.finish(TOOL_LIMIT);
  }
}
