import { readEnvironment } from './environment';
import { createHash } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { startObservation, propagateAttributes, type LangfuseSpan, type LangfuseGeneration } from '@langfuse/tracing';
import { taskToolSchema } from '../shared/task-tools';
import type { ParsedCommand } from '../shared/commands';
import type { ToolStep } from './tool-flow';
import { imageInfo, withoutImage, type ToolImage } from './tool-image';

let sdk: NodeSDK | undefined;
let enabled = false;
let settings: Record<string, string | undefined> = {};
const schemaHash = createHash('sha256').update(JSON.stringify(taskToolSchema)).digest('hex').slice(0, 16);

// Manual instrumentation only: no HTTP auto-instrumentation or separate collector.
export function initTracing(envFile?: string): boolean {
  if (sdk) return enabled;
  try { settings = readEnvironment(envFile); }
  catch { console.warn('[Langfuse] 配置读取失败，应用继续运行。'); return false; }
  if (settings.LANGFUSE_ENABLED !== 'true') return false;
  if (!settings.LANGFUSE_BASE_URL || !settings.LANGFUSE_PUBLIC_KEY || !settings.LANGFUSE_SECRET_KEY) {
    console.warn('[Langfuse] 未启用：请配置 BASE_URL、PUBLIC_KEY、SECRET_KEY。');
    return false;
  }
  try {
    const base = new URL(settings.LANGFUSE_BASE_URL);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid URL');
    const secrets = [settings.key, settings.LANGFUSE_SECRET_KEY, settings.ALIBABA_CLOUD_ACCESS_KEY_ID, settings.ALIBABA_CLOUD_ACCESS_KEY_SECRET, settings.ALIBABA_CLOUD_SECURITY_TOKEN];
    if (settings.dsh_url) { try { secrets.push(new URL(settings.dsh_url).searchParams.get('token') || undefined); } catch {} }
    sdk = new NodeSDK({
      serviceName: 'olivia-soul', autoDetectResources: false,
      spanProcessors: [new LangfuseSpanProcessor({
        baseUrl: settings.LANGFUSE_BASE_URL, publicKey: settings.LANGFUSE_PUBLIC_KEY, secretKey: settings.LANGFUSE_SECRET_KEY,
        environment: settings.LANGFUSE_TRACING_ENVIRONMENT || 'development', release: settings.LANGFUSE_RELEASE,
        exportMode: 'batched', flushInterval: 3, timeout: 3, mediaUploadEnabled: false,
        mask: ({ data }) => redact(data, secrets),
      })],
    });
    sdk.start(); enabled = true;
    console.info('[Langfuse] tracing enabled');
  } catch { console.warn('[Langfuse] 初始化失败，应用继续运行。'); }
  return enabled;
}

export function redact(data: unknown, secrets: (string | undefined)[]): unknown {
  if (typeof data === 'string') {
    for (const secret of secrets) if (secret) data = (data as string).split(secret).join('[REDACTED]');
    return (data as string).replace(/([?&]token=)[^\s&"\\]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(data)) return data.map(v => redact(v, secrets));
  if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data).map(([k, v]) =>
    [k, /^(authorization|secret|api_key|key|token|password|.*access_key.*|.*security_token.*|.*secret_key.*)$/i.test(k) ? '[REDACTED]' : redact(v, secrets)]));
  return data;
}

export async function shutdownTracing() {
  if (!sdk) return;
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([sdk.shutdown(), new Promise<void>(r => { timer = setTimeout(r, 4000); })]); }
  catch { console.warn('[Langfuse] 刷新失败，部分追踪可能未保存。'); }
  finally { clearTimeout(timer); enabled = false; }
}

// Telemetry must never change tool execution or the audio state machine.
function safely<T>(fn: () => T): T | undefined { try { return fn(); } catch { return undefined; } }

export function startRequestTrace(call: string, text: string, source: 'voice' | 'text' | 'notification' | 'eval' | 'voice-diagnostics', metadata: Record<string, unknown> = {}) {
  if (!enabled) return undefined;
  return safely(() => {
    // App requests start independent traces; evaluations remain children of the SDK's experiment item.
    const name = source === 'notification' ? 'task.notification' : source === 'voice-diagnostics' ? 'soul.voice' : 'soul.request';
    return context.with(source === 'eval' ? context.active() : ROOT_CONTEXT, () =>
      propagateAttributes({ sessionId: call, traceName: name }, () =>
        new RequestTrace(startObservation(name, {
          input: { text, source }, metadata: { callId: call, schemaHash, cloudVersion: settings.SOUL_CLOUD_VERSION || 'unrecorded', ...metadata },
        }))));
  });
}

export class RequestTrace {
  private traceContext = context.active();
  private ended = false;
  private text = '';
  private steps: ToolStep[] = [];
  private completion?: { endReason: string; responseFinished: boolean };
  constructor(readonly span: LangfuseSpan) {}
  get traceId() { return this.span.traceId; }
  decision(input: { text: string; results?: unknown; type?: string; quiet?: boolean; images?: ToolImage[] }, voice = false) {
    return safely(() => context.with(this.traceContext, () => {
      const attrs = { input: { text: input.text, commandResults: input.results, type: input.type || 'prompt',
        ...(input.images?.length ? { images: input.images.map(imageInfo) } : {}) }, metadata: { voice, quiet: !!input.quiet } };
      const span = input.results || input.type === 'transcript'
        ? this.span.startObservation(input.results ? 'aliyun.command_results' : 'aliyun.speak', attrs)
        : this.span.startObservation('aliyun.decision', attrs, { asType: 'generation' });
      return new DecisionTrace(this, span, !!input.quiet, input.type === 'transcript');
    }));
  }
  tool(entry: ParsedCommand, round: number, reused: boolean) {
    return safely(() => context.with(this.traceContext, () => this.span.startObservation(entry.name, {
      input: entry.arguments, metadata: { commandRequestId: entry.id, round, reused },
    }, { asType: 'tool' })));
  }
  step(step: ToolStep, observation?: ReturnType<RequestTrace['tool']>) {
    safely(() => {
      const outcome = withoutImage(step.outcome);
      this.steps.push({ ...step, outcome });
      observation?.update({ output: outcome, level: step.outcome.success ? 'DEFAULT' : 'WARNING' });
      observation?.end();
    });
  }
  response(text: string) { this.text = text; }
  decisionEnded(endReason: string, responseFinished: boolean) { this.completion = { endReason, responseFinished }; }
  event(name: string, metadata: Record<string, unknown>) {
    safely(() => context.with(this.traceContext, () => { this.span.startObservation(name, { metadata }, { asType: 'event' }); }));
  }
  end(error?: unknown) {
    if (this.ended) return;
    this.ended = true;
    safely(() => {
      const aborted = error instanceof Error && error.name === 'AbortError';
      const incomplete = this.completion?.endReason === 'listening' && !this.completion.responseFinished;
      this.span.update({ output: { text: this.text, tools: this.steps },
        metadata: { ...this.completion, outcome: error ? aborted ? 'interrupted' : 'error' : incomplete ? 'incomplete' : 'completed' },
        level: error ? aborted ? 'WARNING' : 'ERROR' : incomplete ? 'WARNING' : 'DEFAULT', statusMessage: error instanceof Error ? error.message : undefined });
      this.span.end();
    });
  }
}

export class DecisionTrace {
  private ended = false;
  private queued = Date.now();
  private text = '';
  private spoken = '';
  private raw = new Set<string>();
  private issues = new Set<string>();
  private truncated = false;
  private finished?: boolean;
  private finishReason?: string;
  private responseFinished = false;
  constructor(private request: RequestTrace, private span: LangfuseSpan | LangfuseGeneration, private quiet: boolean, private scripted: boolean) {}
  sent() { safely(() => this.span.update({ metadata: { queueMs: Date.now() - this.queued, sentAt: new Date().toISOString() } })); }
  issue(reason: string) { if (this.issues.size < 32) this.issues.add(reason); }
  event(o: any, muted: boolean) {
    if (this.ended) return;
    safely(() => {
      if (o.event !== 'RespondingContent') return;
      if (typeof o.finished === 'boolean') this.finished = o.finished;
      if (typeof o.finish_reason === 'string') this.finishReason = o.finish_reason;
      this.responseFinished ||= o.finished === true;
      this.text = o.text ?? this.text; this.spoken = o.spoken ?? this.spoken;
      const raw = o.extra_info?.commands;
      if (typeof raw === 'string' && !this.raw.has(raw)) {
        if (this.raw.size < 16) this.raw.add(raw.slice(0, 64000)); else this.truncated = true;
        if (raw.length > 64000) this.truncated = true;
      }
      this.span.update({ metadata: { dialogId: o.dialog_id, roundId: o.round_id, llmRequestId: o.llm_request_id, muted, scripted: this.scripted } });
      if (!muted && !this.quiet) this.request.response(this.text);
    });
  }
  end(reason: string, error?: Error) {
    if (this.ended) return;
    this.ended = true;
    safely(() => {
      if (!this.quiet) this.request.decisionEnded(reason, this.responseFinished);
      const incomplete = reason === 'listening' && !this.responseFinished && !this.quiet;
      this.span.update({ output: { text: this.text, spoken: this.spoken, rawCommands: [...this.raw], parseIssues: [...this.issues], rawTruncated: this.truncated },
        metadata: { endReason: reason, finished: this.finished, finishReason: this.finishReason, responseFinished: this.responseFinished },
        level: error ? error.name === 'AbortError' ? 'WARNING' : 'ERROR' : incomplete || this.issues.size ? 'WARNING' : 'DEFAULT', statusMessage: error?.message });
      this.span.end();
    });
  }
}
