import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseCommands } from '../src/shared/commands';
import type { runSmoke } from './smoke';

// Live Aliyun probe: force one invalid argument before the production handler.
export async function toolErrorSmoke(ctx: Parameters<typeof runSmoke>[0]) {
  const { cloud, tasks, window } = ctx;
  const trace: any[] = [];
  let injectedError: string | undefined;
  let interruptOnError = false;
  const wait = async (fn: () => boolean, label: string, ms = 45000) => {
    const until = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > until) throw new Error(`Timeout: ${label}`);
      await new Promise(r => setTimeout(r, 100));
    }
  };
  cloud.prependListener('event', o => {
    if (o.extra_info?.commands) {
      const commands = JSON.parse(o.extra_info.commands);
      if (injectedError) {
        const c = commands.find((c: any) => injectedError === 'continue_missing_id' ? c.name === 'computer_task' : c.name === 'get_task');
        if (c) {
          if (injectedError !== 'unknown_id') {
            if (Array.isArray(c.params)) c.params = c.params.filter((p: any) => p.name !== 'task_id');
            else { c.params = { ...c.params }; delete c.params.task_id; }
          }
          else if (Array.isArray(c.params)) c.params = [...c.params.filter((p: any) => p.name !== 'task_id'), { name: 'task_id', value: 'nonexistent-task-id' }];
          else c.params = { ...c.params, task_id: 'nonexistent-task-id' };
          o.extra_info.commands = JSON.stringify(commands);
          trace.push({ direction: 'injection', reason: injectedError });
          if (injectedError !== 'always_missing_id') injectedError = undefined;
        }
      }
      trace.push({ direction: 'commands', commands });
    }
    if (['RespondingContent', 'RespondingEnded', 'DialogStateChanged', 'Error'].includes(o.event)) trace.push({ direction: 'incoming', ...o });
  });
  const respond = cloud.respond.bind(cloud);
  cloud.respond = (text, results, type) => {
    trace.push({ direction: 'outgoing', text, results, type });
    respond(text, results, type);
    if (interruptOnError && results?.some((r: any) => !r.invoke_result.structuredContent.success)) {
      interruptOnError = false;
      queueMicrotask(() => { void ctx.sendText('不用继续查询了。只回复 USER_OVERRIDE_OK，不调用任何工具。').catch(e => trace.push({ error: e.message })); });
    }
  };
  ctx.storage.savePreferences({ ...ctx.storage.preferences, gpuEnabled: false, micMuted: true, speakerMuted: true });
  try {
    await window.webContents.executeJavaScript('window.soulSmoke.connect()', true);
    const submitted = await tasks.execute({ id: randomUUID(), name: 'computer_task', action: 'start', goal: '这是只读联调测试，请按照上下文的要求回复。', context: '只回复 ERROR_RECOVERY_FIXTURE_OK，不调用任何工具。' }, cloud.call);
    assert.equal(submitted.success, true);
    const task = tasks.records.at(-1)!;
    await wait(() => task.status === 'completed', 'fixture completion');
    for (const scenario of process.argv.includes('--query-only') ? [] : ['missing_id', 'unknown_id']) {
      await wait(() => cloud.state === 'Listening', 'listening');
      const cut = trace.length;
      injectedError = scenario;
      await ctx.sendText(`请调用 get_task 查询任务 ${task.id} 的执行结果。如果查询失败，请先调用 list_tasks 找到本次通话唯一的任务，再调用 get_task 查询它。回复简短。`);
      await wait(() => trace.slice(cut).some(e => e.direction === 'outgoing' && e.results?.some((r: any) => r.invoke_result.structuredContent.success === false)), 'error sent');
      await wait(() => trace.slice(cut).some(e => e.direction === 'outgoing' && e.results?.some((r: any) => r.invoke_result.structuredContent.success && r.invoke_result.content.text.includes('ERROR_RECOVERY_FIXTURE_OK'))), 'automatic correction succeeds', 90000);
      await wait(() => trace.slice(cut).some(e => e.event === 'RespondingContent' && e.text?.includes('ERROR_RECOVERY_FIXTURE_OK')), 'corrected result response', 90000);
      await wait(() => cloud.state === 'Listening', 'corrected response playback', 90000);
      await new Promise(r => setTimeout(r, 6000));
      await wait(() => cloud.state === 'Listening', 'correction settled', 90000);
      const calls = trace.slice(cut).filter(e => e.direction === 'commands').flatMap(e => e.commands);
      console.log('ERROR_RECOVERY_OBSERVATION', JSON.stringify({ scenario, tools: calls.map(c => c.name), corrected: calls.filter(c => c.name === 'get_task').length > 1 }));
      assert.ok(calls.filter(c => c.name === 'get_task').length > 1);
    }
    const cut = trace.length;
    await ctx.sendText('请先调用 list_tasks 找到本次通话唯一的电脑任务，然后调用 get_task 查看它的完整执行结果。回复简短。');
    await wait(() => trace.slice(cut).some(e => e.direction === 'outgoing' && e.results?.some((r: any) => r.invoke_result.structuredContent.success && r.invoke_result.content.text.includes('ERROR_RECOVERY_FIXTURE_OK'))), 'automatic query chain succeeds', 90000);
    await wait(() => trace.slice(cut).some(e => e.event === 'RespondingContent' && e.text?.includes('ERROR_RECOVERY_FIXTURE_OK')), 'query chain response', 90000);
    await wait(() => cloud.state === 'Listening', 'list response playback', 90000);
    await new Promise(r => setTimeout(r, 4000));
    console.log('QUERY_CHAIN_OBSERVATION', JSON.stringify({ batches: trace.slice(cut).filter(e => e.direction === 'commands').map(e => e.commands.map((c: any) => c.name)) }));
    await new Promise(r => setTimeout(r, 6000));
    await wait(() => cloud.state === 'Listening', 'query chain settled', 90000);
    if (!process.argv.includes('--query-only')) {
      injectedError = 'continue_missing_id';
      const continueCut = trace.length;
      await ctx.sendText(`请调用 computer_task 的 continue 给任务 ${task.id} 追加要求：只回复 CONTINUE_RECOVERY_OK，不调用任何工具。`);
      await wait(() => task.runs.length === 2, 'corrected continuation accepted', 90000);
      await wait(() => task.status === 'completed' && task.runs[1].response.includes('CONTINUE_RECOVERY_OK'), 'corrected continuation completed', 90000);
      await wait(() => trace.slice(continueCut).some(e => e.direction === 'outgoing' && e.text?.includes('执行结果通知')), 'continuation completion notification', 90000);
      await wait(() => cloud.state === 'Listening', 'continuation playback', 90000);
      assert.equal(task.runs.length, 2, 'continuation submitted exactly once');
      console.log('CONTINUATION_RECOVERY_VERIFIED');
      injectedError = 'always_missing_id';
      interruptOnError = true;
      const interruptCut = trace.length;
      await ctx.sendText(`请调用 get_task 查看任务 ${task.id} 的完整结果。`);
      await wait(() => trace.slice(interruptCut).some(e => e.event === 'RespondingContent' && e.text?.includes('USER_OVERRIDE_OK')), 'new user request supersedes correction', 90000);
      await wait(() => cloud.state === 'Listening', 'new request playback', 90000);
      await new Promise(r => setTimeout(r, 3000));
      assert.ok(!trace.slice(interruptCut).some(e => e.direction === 'outgoing' && e.text?.startsWith('以下 JSON 是当前用户请求及工具执行记录')));
      console.log('LIVE_NEW_REQUEST_STOPS_CORRECTION_VERIFIED');
      const limitCut = trace.length;
      await ctx.sendText(`请调用 get_task 查看任务 ${task.id} 的完整结果。`);
      await wait(() => {
        const recent = trace.slice(limitCut);
        if (!recent.some(e => e.direction === 'outgoing' && e.results)) return false;
        const last = recent.length - 1 - recent.slice().reverse().findIndex(e => e.direction === 'outgoing');
        // The model may stop before the cap, or answer on the final allowed decision.
        return !recent[last].results && recent.slice(last + 1).some(e => e.event === 'RespondingContent' && e.finished && e.text && !JSON.parse(e.extra_info?.commands || '[]').length);
      }, 'correction produces a final answer within the round limit', 90000);
      await wait(() => cloud.state === 'Listening', 'limit playback', 90000);
      await new Promise(r => setTimeout(r, 6000));
      const callbacks = trace.slice(limitCut).filter(e => e.direction === 'outgoing' && e.results);
      assert.ok(callbacks.length <= 5); // Four executed batches, optionally one rejected excess batch.
      if (callbacks.length === 5) assert.ok(callbacks[4].results.every((r: any) => !r.invoke_result.structuredContent.success && r.invoke_result.content.text.includes('未执行')));
      console.log('LIVE_RETRY_LIMIT_VERIFIED');
    }
    if (process.argv.includes('--two-step')) {
      injectedError = undefined;
      // A fresh dialogue prevents earlier query fixtures being mistaken for step one.
      await ctx.stopCall(); await window.webContents.executeJavaScript('window.soulSmoke.connect()', true);
      // This checks tool orchestration, not extraction of a coding-task goal.
      // Keep the real dsh executor a no-op even when Aliyun reduces the goal to a marker.
      ctx.setCommandOverride(c => {
        if (c.name === 'computer_task' && c.action === 'start') c.context += '\n这是只读联调夹具。不要调用任何工具，不要读写文件，不要询问用户。直接回复 goal 中的 TWO_STEP_FIRST_OK 或 TWO_STEP_SECOND_OK 标记，然后结束。';
        return false;
      });
      const cut = trace.length, count = tasks.records.length;
      await ctx.sendText('我要创建两个全新的独立电脑任务 A 和 B，不使用此前任何任务。A 的目标是只回复 TWO_STEP_FIRST_OK；B 的目标是只回复 TWO_STEP_SECOND_OK，且 B 的 context 必须包含 A 的真实 task_id。当前这一轮只允许调用一次 computer_task(action=start) 创建 A，不能同批创建 B，也不能为 B 猜测或填写占位 ID。等 A 的工具回执返回 task_id 后，再在下一轮创建 B。两个任务都不调用工具、不读写文件，不必等待 A 执行完成。');
      await wait(() => tasks.records.length >= count + 2, 'second task submitted after first receipt', 90000);
      const [first, second] = tasks.records.slice(count);
      const calls = trace.slice(cut).filter(e => e.direction === 'commands').flatMap(e => parseCommands(JSON.stringify(e.commands))).filter(c => c.name === 'computer_task' && c.action === 'start');
      assert.equal(calls.length, 2);
      assert.ok(calls[1].context.includes(first.id), 'second step uses the real ID from the first receipt');
      const receipt = trace.slice(cut).findIndex(e => e.direction === 'outgoing' && e.results?.some((r: any) => r.command_request_id === calls[0].id));
      const secondCall = trace.slice(cut).findIndex(e => e.direction === 'commands' && e.commands.some((c: any) => c.command_request_id === calls[1].id));
      assert.ok(receipt >= 0 && secondCall > receipt, 'second tool call follows the first tool result');
      await wait(() => [first, second].every(t => t.status === 'completed'), 'both background tasks complete', 90000);
      await wait(() => [first, second].every(t => trace.slice(cut).some(e => e.direction === 'outgoing' && e.text?.startsWith('这是已登记电脑任务的执行结果通知') && e.text.includes(t.id))), 'independent completion notifications', 90000);
      await wait(() => cloud.state === 'Listening', 'two-step notifications played');
      assert.equal(tasks.records.length, count + 2);
      console.log('TWO_STEP_ACCEPTANCE_CONTINUES_VERIFIED');
    }
    for (const e of trace.filter(e => e.direction === 'commands' && e.commands.length > 1)) {
      const ids = e.commands.map((c: any) => c.command_request_id);
      const callbacks = trace.filter(e => e.direction === 'outgoing' && e.results?.some((r: any) => ids.includes(r.command_request_id)));
      assert.equal(callbacks.length, 1, 'all results from one batch share a callback');
      assert.deepEqual(callbacks[0].results.map((r: any) => r.command_request_id).sort(), ids.sort());
    }
  } finally {
    ctx.setCommandOverride();
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync(`test-results/${process.argv.includes('--query-only') ? 'query-chain' : 'tool-error'}-smoke.json`, JSON.stringify(trace, null, 2));
  }
  await ctx.shutdown();
}
