import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { AliyunClient, type AliyunConfig } from '../src/main/aliyun';
import { AliyunTurns } from '../src/main/aliyun-turn';
import { runToolLoop } from '../src/main/tool-flow';
import { parseCommandBatch, toolNames } from '../src/shared/commands';
import { imageInfo, withoutImage } from '../src/main/tool-image';
import type { ComputerCommand } from '../src/shared/types';
import type { CommandOutcome } from '../src/main/tasks';
import { startRequestTrace } from '../src/main/tracing';

export interface FixtureTask { id: string; title: string; status: string; goal?: string; result?: string }
export interface ScenarioInput {
  tasks?: FixtureTask[];
  messages: string[];
  failure?: 'unknown_submission';
  screenshots?: ('a' | 'b' | 'failure')[];
}
export interface ExpectedCall { name: ComputerCommand['name']; action?: ComputerCommand['action']; taskId?: string; goalIncludes?: string[] }
export interface Expectation { required: ExpectedCall[]; noTools?: boolean; forbiddenActions?: string[]; maxMutations?: number; manualReview?: string; maxScreenshots?: number; replyIncludes?: string[]; replyExcludes?: string[] }
export interface Scenario { id: string; input: ScenarioInput; expectedOutput: Expectation; metadata: { category: string } }
export interface EvalTurn { text: string; reply: string; calls: ComputerCommand[]; results: CommandOutcome[]; parseIssues: string[] }
export interface ScenarioOutput { turns: EvalTurn[]; tasks: FixtureTask[]; transportError?: string }

// Deliberately a small, stateful fake. These calls never reach dsh or the filesystem.
export class FakeTasks {
  records: FixtureTask[];
  private requests = new Map<string, { goal: string; context: string; status: string; result: string }[]>();
  private results = new Map<string, CommandOutcome>();
  constructor(input: ScenarioInput) {
    this.records = structuredClone(input.tasks || []);
    for (const t of this.records) this.requests.set(t.id, [{ goal: t.goal || t.title, context: '', status: t.status, result: t.result || '' }]);
    this.failure = input.failure;
  }
  private failure?: ScenarioInput['failure'];
  async execute(c: ComputerCommand): Promise<CommandOutcome> {
    if (this.results.has(c.id)) return this.results.get(c.id)!;
    const ok = (v: unknown): CommandOutcome => ({ success: true, text: JSON.stringify(v) });
    let t = this.records.find(t => t.id === c.taskId), outcome: CommandOutcome;
    if (c.name === 'list_tasks') outcome = ok(this.records.map(t => ({ task_id: t.id, title: t.title, status: t.status })));
    else if ((c.name === 'get_task' || c.action !== 'start') && !t) outcome = { success: false, retryable: true, text: '本次通话没有该 task_id，请先调用 list_tasks' };
    else if (c.name === 'get_task') outcome = ok({ task_id: t!.id, title: t!.title, status: t!.status, requests: this.requests.get(t!.id) });
    else if (c.action === 'cancel') { t!.status = 'cancelled'; outcome = ok({ task_id: t!.id, status: t!.status }); }
    else {
      if (c.action === 'start') {
        t = { id: randomUUID(), title: c.goal.slice(0, 80), goal: c.goal, status: 'running' };
        this.records.push(t); this.requests.set(t.id, []);
      }
      t!.status = this.failure ? 'unknown' : 'running';
      this.requests.get(t!.id)!.push({ goal: c.goal, context: c.context, status: t!.status, result: '' });
      outcome = this.failure
        ? { success: false, text: JSON.stringify({ task_id: t!.id, message: '提交结果未能确认，请查询任务状态；不会自动重发' }) }
        : ok({ task_id: t!.id, accepted: true, message: '请求已接收，已加入后台执行队列。这只表示提交成功，不表示任务完成；执行结束后会另行汇报。' });
    }
    this.results.set(c.id, outcome); return outcome;
  }
}

export function validateScenario(value: unknown): asserts value is Scenario {
  const v = value as Scenario;
  if (!v || typeof v.id !== 'string' || !v.id || !Array.isArray(v.input?.messages) || !v.input.messages.length ||
      !v.input.messages.every(s => typeof s === 'string' && s.trim().length > 0 && s.length <= 12000) ||
      !Array.isArray(v.expectedOutput?.required) || !v.metadata?.category) throw new Error('Invalid scenario: id, input.messages, expectedOutput.required, metadata.category are required');
  if (v.input.tasks && (!Array.isArray(v.input.tasks) || v.input.tasks.some(t => !t || ![t.id, t.title, t.status].every(s => typeof s === 'string' && s.length)))) throw new Error(`Invalid tasks: ${v.id}`);
  if (v.input.tasks && new Set(v.input.tasks.map(t => t.id)).size !== v.input.tasks.length) throw new Error(`Duplicate task IDs: ${v.id}`);
  if (v.input.failure && v.input.failure !== 'unknown_submission') throw new Error(`Invalid failure fixture: ${v.id}`);
  if (v.input.screenshots && (!Array.isArray(v.input.screenshots) || v.input.screenshots.length !== v.input.messages.length ||
      !v.input.screenshots.every(s => ['a', 'b', 'failure'].includes(s)))) throw new Error(`Invalid screenshot fixtures: ${v.id}`);
  const e = v.expectedOutput;
  if ((e.maxScreenshots !== undefined && (!Number.isInteger(e.maxScreenshots) || e.maxScreenshots < 0)) ||
      [e.replyIncludes, e.replyExcludes].some(v => v !== undefined && (!Array.isArray(v) || !v.every(s => typeof s === 'string' && s.length)))) throw new Error(`Invalid screenshot expectation: ${v.id}`);
  if ((e.noTools !== undefined && typeof e.noTools !== 'boolean') || (e.noTools && e.required.length) ||
      (e.maxMutations !== undefined && (!Number.isInteger(e.maxMutations) || e.maxMutations < 0)) ||
      (e.forbiddenActions && (!Array.isArray(e.forbiddenActions) || !e.forbiddenActions.every(a => ['start', 'continue', 'cancel'].includes(a))))) throw new Error(`Invalid expectation: ${v.id}`);
  for (const c of v.expectedOutput.required) {
    if (!c || !toolNames.includes(c.name) ||
        (c.taskId !== undefined && (typeof c.taskId !== 'string' || !c.taskId)) ||
        (c.name === 'computer_task' && !['start', 'continue', 'cancel'].includes(c.action || '')) ||
        (c.goalIncludes && (!Array.isArray(c.goalIncludes) || !c.goalIncludes.every(s => typeof s === 'string' && s.length)))) throw new Error(`Invalid expected call: ${v.id}`);
  }
}

export async function runScenario(input: ScenarioInput, config: AliyunConfig, cloud = new AliyunClient(), timeoutMs = 120000): Promise<ScenarioOutput> {
  const tasks = new FakeTasks(input), turns = new AliyunTurns(cloud), controller = new AbortController();
  const output: ScenarioOutput = { turns: [], tasks: tasks.records };
  const deadline = setTimeout(() => controller.abort(new Error('Scenario timeout')), timeoutMs);
  let current: EvalTurn | undefined;
  let closing = false;
  const fail = (error: Error) => { if (!closing) { controller.abort(error); turns.reset(error); } };
  const onAbort = () => turns.reset(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort);
  const onFault = (s: string) => fail(new Error(s));
  const onDisconnect = () => fail(new Error('Cloud disconnected'));
  const onEvent = (o: any) => {
    const muted = turns.muted;
    turns.event(o);
    if (o.event === 'Error') fail(new Error(`Aliyun: ${o.error_name || 'Error'}`));
    if (current && o.event === 'RespondingContent' && !muted) {
      current.reply = o.text ?? current.reply;
      parseCommandBatch(o.extra_info?.commands, reason => current!.parseIssues.push(reason));
    }
    // Headless evaluation drains audio instead of playing it; acknowledge the protocol boundary.
    if (o.event === 'RespondingEnded') cloud.directive('LocalRespondingEnded');
  };
  cloud.on('event', onEvent); cloud.on('fault', onFault); cloud.on('disconnected', onDisconnect);
  const pump = setInterval(() => turns.pump(!controller.signal.aborted), 50);
  try {
    await cloud.connect(config);
    for (const text of input.messages) {
      while (cloud.state !== 'Listening') { controller.signal.throwIfAborted(); await delay(50, undefined, { signal: controller.signal }); }
      controller.signal.throwIfAborted();
      current = { text, reply: '', calls: [], results: [], parseIssues: [] }; output.turns.push(current);
      const trace = startRequestTrace(cloud.call, text, 'eval', { tasks: structuredClone(tasks.records) });
      try {
        const first = await turns.request({ call: cloud.call, text, user: true, signal: controller.signal, trace });
        const turn = turns.toolTurn(cloud.call, text, controller.signal, async c => {
          current!.calls.push(c);
          const result = c.name === 'take_screenshot'
            ? fixtureScreenshot(input.screenshots?.[output.turns.length - 1]) : await tasks.execute(c);
          current!.results.push(withoutImage(result)); return result;
        }, trace);
        await runToolLoop(first, turn, controller.signal);
        controller.signal.throwIfAborted();
      } catch (e) { trace?.end(e); throw e; }
      finally { trace?.end(); }
      // Native callbacks and playback completion must settle before starting another user turn.
      while (cloud.state !== 'Listening') { controller.signal.throwIfAborted(); await delay(50, undefined, { signal: controller.signal }); }
    }
  } catch (e) { output.transportError = e instanceof Error ? e.message : String(e); }
  finally {
    closing = true; clearTimeout(deadline); clearInterval(pump); turns.reset();
    controller.signal.removeEventListener('abort', onAbort);
    await cloud.stop();
    cloud.off('event', onEvent); cloud.off('fault', onFault); cloud.off('disconnected', onDisconnect);
  }
  return output;
}

export function scoreScenario(output: ScenarioOutput, expected: Expectation) {
  const score = (name: string, pass: boolean, comment: string) => ({ name, value: Number(pass), dataType: 'BOOLEAN' as const, comment });
  if (output.transportError) return [score('run_completed', false, output.transportError)];
  const last = output.turns.at(-1);
  if (!last) return [score('run_completed', false, 'No evaluated turn')];
  const calls = last.calls, issues = last.parseIssues;
  const matches = (c: ComputerCommand, e: ExpectedCall, args: boolean) => c.name === e.name && (!e.action || c.action === e.action) &&
    (!args || ((!e.taskId || c.taskId === e.taskId) && (!e.goalIncludes || e.goalIncludes.every(s => `${c.goal}\n${c.context}`.includes(s)))));
  const matchAll = (args: boolean) => {
    const available = [...calls];
    return expected.required.every(e => { const at = available.findIndex(c => matches(c, e, args)); if (at < 0) return false; available.splice(at, 1); return true; });
  };
  const mutations = calls.filter(c => c.name === 'computer_task');
  const max = expected.maxMutations ?? expected.required.filter(c => c.name === 'computer_task').length;
  const forbidden = mutations.some(c => expected.forbiddenActions?.includes(c.action!));
  const screenshotCount = calls.filter(c => c.name === 'take_screenshot').length;
  const selection = expected.noTools ? calls.length === 0 && issues.length === 0 : matchAll(false) && mutations.length <= max && !forbidden &&
    screenshotCount <= (expected.maxScreenshots ?? expected.required.filter(c => c.name === 'take_screenshot').length);
  const args = matchAll(true) && issues.length === 0 && !last.results.some(r => !r.success && r.retryable);
  return [score('run_completed', true, '真实云端请求正常结束；仅最后一条用户消息参与工具评分'),
    score('tool_selection', selection, `actual=${calls.map(c => `${c.name}:${c.action || ''}`).join(',') || 'none'}`),
    score('arguments_valid', args, issues.join('; ') || '按 taskId 和 goalIncludes 检查；自由语义与回复需人工评分'),
    score('tool_correct', selection && args, expected.manualReview || '规则评分，不代表完整语义正确'),
    ...(expected.replyIncludes || expected.replyExcludes ? [score('reply_content',
      (expected.replyIncludes || []).every(s => last.reply.includes(s)) && (expected.replyExcludes || []).every(s => !last.reply.includes(s)),
      '固定图片事实/失败提示的字符串检查；完整语义仍需人工评分')] : [])];
}

function fixtureScreenshot(fixture: 'a' | 'b' | 'failure' | undefined): CommandOutcome {
  if (!fixture || fixture === 'failure') return { success: false, text: '未能获取主屏幕截图，请确认桌面可用后重试。' };
  const image = { type: 'base64' as const, value: fs.readFileSync(`evals/fixtures/screen-${fixture}.png`).toString('base64') };
  return { success: true, image, text: JSON.stringify({ screenshot: '当前主屏幕', width: 1280, height: 720, ...imageInfo(image) }) };
}
