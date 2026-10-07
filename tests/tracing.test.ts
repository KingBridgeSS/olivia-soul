import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import { RequestTrace, redact } from '../src/main/tracing';
import { AliyunTurns } from '../src/main/aliyun-turn';
import { runToolLoop } from '../src/main/tool-flow';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('explicit parentage survives interleaved callbacks; muted commands are retained and spans end once', async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  setLangfuseTracerProvider(provider); t.after(() => provider.shutdown());
  const request = new RequestTrace(startObservation('request'));
  const unrelated = new RequestTrace(startObservation('notification'));
  const cloud = { call: 'call', ready: true, state: 'Listening', respond() {}, directive() {} };
  const turns = new AliyunTurns(cloud);
  const pending = turns.request({ call: 'call', text: '任务', user: true, trace: request });
  turns.pump(true);
  const raw = JSON.stringify([{ name: 'list_tasks', command_request_id: 'cmd', params: {} }]);
  turns.event({ event: 'RespondingContent', text: '', extra_info: { commands: raw }, finished: false, round_id: 'r1' });
  turns.event({ event: 'RespondingContent', text: '', extra_info: { commands: raw }, finished: true, round_id: 'r1' });
  const commands = await pending;
  turns.event({ event: 'DialogStateChanged', state: 'Listening' });
  await runToolLoop(commands, { trace: request, execute: async () => ({ success: true, text: '[]' }), submit: async () => {}, next: async () => [], finish: async () => {} }, new AbortController().signal);
  const callback = turns.request({ call: 'call', text: '', quiet: true, results: [], trace: request });
  // Date mocking is unnecessary: this is the real transport throttle.
  await new Promise(r => setTimeout(r, 510)); turns.pump(true);
  turns.event({ event: 'RespondingContent', text: 'internal', extra_info: { commands: '{broken' }, finished: true });
  turns.event({ event: 'DialogStateChanged', state: 'Listening' }); await callback;
  unrelated.end(); request.end(); request.end();
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.filter(s => s.name === 'aliyun.decision').length, 1);
  for (const s of spans.filter(s => s.name.startsWith('aliyun.') || s.name === 'list_tasks')) {
    assert.equal(s.parentSpanContext?.spanId, request.span.id);
    assert.equal(s.spanContext().traceId, request.traceId);
    assert.notEqual(s.spanContext().traceId, unrelated.traceId);
  }
  const decoded = (name: string) => JSON.parse(String(spans.find(s => s.name === name)!.attributes['langfuse.observation.output']));
  assert.deepEqual(decoded('aliyun.decision').rawCommands, [raw]);
  assert.deepEqual(decoded('aliyun.command_results').parseIssues, ['commands JSON 无效']);
  assert.equal(decoded('request').text, ''); // Muted callback is not the user's final answer.
  assert.equal(decoded('request').tools[0].entry.id, 'cmd');
});

test('aborted queued requests close their observation without sending', async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  setLangfuseTracerProvider(provider); t.after(() => provider.shutdown());
  const request = new RequestTrace(startObservation('request'));
  let sent = 0;
  const turns = new AliyunTurns({ call: 'call', ready: true, state: 'Listening', respond: () => { sent++; }, directive() {} });
  const controller = new AbortController();
  const pending = turns.request({ call: 'call', text: 'old', signal: controller.signal, trace: request });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected; turns.pump(true); request.end(controller.signal.reason);
  assert.equal(sent, 0);
  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 2);
  assert.equal(spans.find(s => s.name === 'aliyun.decision')?.attributes['langfuse.observation.level'], 'WARNING');
});

test('export masking removes configured secrets and credential fields while retaining arguments', () => {
  assert.deepEqual(redact({ text: 'my-secret http://localhost/?token=abc', goal: 'report.txt', authorization: 'Bearer other', nested: [{ key: 'key' }] }, ['my-secret']),
    { text: '[REDACTED] http://localhost/?token=[REDACTED]', goal: 'report.txt', authorization: '[REDACTED]', nested: [{ key: '[REDACTED]' }] });
});

test('Listening without final text is incomplete; a final text event retains the cloud finish reason', async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  setLangfuseTracerProvider(provider); t.after(() => provider.shutdown());
  for (const final of [false, true]) {
    const request = new RequestTrace(startObservation(final ? 'complete' : 'partial'));
    const turns = new AliyunTurns({ call: 'call', ready: true, state: 'Listening', respond() {}, directive() {} });
    const pending = turns.listen('call', new AbortController().signal, request);
    turns.event({ event: 'RespondingContent', text: '抱歉', spoken: '抱歉', finished: final,
      ...(final ? { finish_reason: 'stop' } : {}), round_id: 'r1', llm_request_id: 'llm1' });
    turns.event({ event: 'DialogStateChanged', state: 'Listening' });
    await pending; request.end();
    const spans = exporter.getFinishedSpans().filter(s => s.spanContext().traceId === request.traceId);
    const decision = spans.find(s => s.name === 'aliyun.decision')!;
    const root = spans.find(s => s.name === (final ? 'complete' : 'partial'))!;
    assert.equal(decision.attributes['langfuse.observation.metadata.endReason'], final ? 'text-finished' : 'listening');
    assert.equal(decision.attributes['langfuse.observation.metadata.finished'], String(final));
    assert.equal(decision.attributes['langfuse.observation.metadata.responseFinished'], String(final));
    if (final) assert.equal(decision.attributes['langfuse.observation.metadata.finishReason'], 'stop');
    assert.equal(root.attributes['langfuse.observation.metadata.outcome'], final ? 'completed' : 'incomplete');
    assert.equal(decision.attributes['langfuse.observation.level'], final ? 'DEFAULT' : 'WARNING');
    assert.equal(spans.filter(s => s.name === 'aliyun.decision').length, 1);
  }
});

test('call diagnostics retain late playback and interruption events after the request ended', async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  setLangfuseTracerProvider(provider); t.after(() => provider.shutdown());
  const call = new RequestTrace(startObservation('soul.voice'));
  const request = new RequestTrace(startObservation('soul.request'));
  request.end();
  for (const [i, name] of ['aliyun.RespondingEnded', 'playback.ended', 'aliyun.LocalRespondingEnded', 'aliyun.DialogStateChanged', 'aliyun.SpeechStarted', 'playback.interrupt'].entries()) {
    call.event(name, { sequence: i + 1, at: new Date().toISOString(), requestTraceId: request.traceId });
  }
  call.end();
  const events = exporter.getFinishedSpans().filter(s => s.parentSpanContext?.spanId === call.span.id);
  assert.equal(events.length, 6);
  assert.deepEqual(events.map(s => Number(s.attributes['langfuse.observation.metadata.sequence'])), [1, 2, 3, 4, 5, 6]);
  for (const event of events) {
    assert.equal(event.spanContext().traceId, call.traceId);
    assert.equal(event.attributes['langfuse.observation.metadata.requestTraceId'], request.traceId);
  }
});

test('empty Listening is incomplete for a user decision, but silent receipts are not false alarms', async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  setLangfuseTracerProvider(provider); t.after(() => provider.shutdown());
  for (const quiet of [false, true]) {
    const request = new RequestTrace(startObservation('request'));
    const turns = new AliyunTurns({ call: 'call', ready: true, state: 'Listening', respond() {}, directive() {} });
    const pending = turns.request({ call: 'call', text: '', quiet, trace: request, ...(quiet ? { results: [] } : {}) });
    turns.pump(true);
    turns.event({ event: 'DialogStateChanged', state: 'Listening' });
    await pending; request.end();
    const spans = exporter.getFinishedSpans().filter(s => s.spanContext().traceId === request.traceId);
    const decision = spans.find(s => s.name.startsWith('aliyun.'))!;
    assert.equal(decision.attributes['langfuse.observation.metadata.finished'], undefined);
    assert.equal(decision.attributes['langfuse.observation.metadata.endReason'], 'listening');
    assert.equal(decision.attributes['langfuse.observation.level'], quiet ? 'DEFAULT' : 'WARNING');
    assert.equal(spans.find(s => s.name === 'request')!.attributes['langfuse.observation.metadata.outcome'], quiet ? 'completed' : 'incomplete');
  }
});

test('tool, decision and root spans contain image metadata without image bytes', async t => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  setLangfuseTracerProvider(provider); t.after(() => provider.shutdown());
  const request = new RequestTrace(startObservation('request'));
  const image = { type: 'base64' as const, value: Buffer.from('private screenshot bytes').toString('base64') };
  const entry = { id: 'screen', name: 'take_screenshot' as const };
  request.step({ entry, outcome: { success: true, text: '{"width":1280}', image } }, request.tool(entry, 1, false));
  request.decision({ text: '看图', images: [image] })?.end('response-complete');
  request.end();
  const data = JSON.stringify(exporter.getFinishedSpans().map(s => s.attributes));
  assert.ok(data.includes('sha256')); assert.ok(data.includes('1280'));
  assert.ok(!data.includes(image.value)); assert.ok(!data.includes('private screenshot bytes'));
});

test('unreachable Langfuse does not prevent tool execution or bounded shutdown', async () => {
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/helpers/tracing-outage.ts'], { timeout: 12000, windowsHide: true });
  assert.match(result.stdout, /OUTAGE_OK/);
});
