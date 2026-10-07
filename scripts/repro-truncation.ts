// Independent diagnostic: no imports from Soul's transport, queue, tracing or player.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const option = (name: string, fallback = '') => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sessionId = option('--session');
const mode = option('--mode', 'replay');
const turn = Number(option('--turn', '16'));
const historyCount = Number(option('--history-count', String(turn - 1)));
const env = { ...parseEnv(fs.readFileSync('.env', 'utf8')), ...process.env };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
type Pair = { input: string; output: string };

async function readSession(): Promise<Pair[]> {
  if (!sessionId) throw new Error('Pass --session LANGFUSE_SESSION_ID and --mode replay|history|control; --turn is 1-based.');
  const params = new URLSearchParams({ fields: 'core,basic,io', limit: '1000',
    filter: JSON.stringify([{ type: 'string', column: 'sessionId', operator: '=', value: sessionId }]) });
  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${env.LANGFUSE_BASE_URL}/api/public/v2/observations?${params}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64')}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Langfuse HTTP ${res.status}`);
    const body: any = await res.json(); rows.push(...body.data); cursor = body.meta?.cursor;
  } while (cursor);
  const decode = (v: any) => typeof v === 'string' ? JSON.parse(v) : v;
  return rows.filter(r => r.name === 'soul.request').sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map(r => ({ input: decode(r.input).text, output: decode(r.output).text }));
}

async function run(pairs: Pair[]) {
  if (!['replay', 'history', 'control'].includes(mode) || !pairs.length || !pairs[turn - 1] || !Number.isInteger(historyCount) || historyCount < 0 || historyCount >= turn) throw new Error('Invalid mode, turn, history count, or empty session');
  const call = randomUUID(), user = option('--user', `diag-${randomUUID().slice(0, 24)}`);
  const dir = path.join('test-results', `truncation-${mode}-${turn}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'wire.jsonl');
  const log = (record: object) => fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
  const summary: any = { sourceSession: sessionId, mode, turn, historyCount: mode === 'history' ? historyCount : 0, call, user, playback: '24kHz simulated sink, real-time consumption, no microphone', rounds: [] };
  fs.writeFileSync(path.join(dir, 'source.json'), JSON.stringify(pairs, null, 2));
  let dialog = '', state = '', ready = false, fatal: Error | undefined, stopping = false, round = 0;
  let bytes = 0, played = 0, firstAudioAt = 0, audioEnded = false, localEnded = false;
  let content: any[] = [], sentAt = 0;
  const ws = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/inference', {
    headers: { Authorization: `Bearer ${env.key}` }, handshakeTimeout: 15000,
  });
  const send = (directive: string, input: object = {}, parameters?: object) => {
    const message = { header: { action: directive === 'Start' ? 'run-task' : directive === 'Stop' ? 'finish-task' : 'continue-task', task_id: call, streaming: 'duplex' },
      payload: { ...(directive === 'Start' ? { task_group: 'aigc', task: 'multimodal-generation', function: 'generation', model: 'multimodal-dialog' } : {}),
        input: { directive, ...(dialog ? { dialog_id: dialog } : {}), ...input }, ...(parameters ? { parameters } : {}) } };
    ws.send(JSON.stringify(message));
    if (directive !== 'HeartBeat') log({ round, direction: 'sent', message });
  };
  ws.on('open', () => send('Start', { app_id: env.app_id, workspace_id: env.workspace_id }, {
    upstream: { type: 'AudioOnly', mode: 'duplex', sample_rate: 16000 },
    downstream: { sample_rate: 24000, audio_format: 'pcm', ...(env.voice_id ? { voice: env.voice_id } : {}) },
    client_info: { user_id: user, device: { uuid: randomUUID() } },
  }));
  ws.on('message', (data, binary) => {
    if (binary) {
      bytes += data instanceof ArrayBuffer ? data.byteLength : Array.isArray(data) ? Buffer.concat(data).length : data.length;
      if (!firstAudioAt) { firstAudioAt = performance.now(); send('LocalRespondingStarted'); }
      return;
    }
    const message = JSON.parse(data.toString()), o = message.payload?.output;
    if (o?.event !== 'HeartBeat') log({ round, direction: 'received', message });
    if (message.header?.event === 'task-failed') fatal = new Error(`Cloud task-failed: ${message.header.error_code}`);
    if (o?.event === 'Error' && o.error_code !== 451 && o.error_name !== 'NoSpeechRecognized') fatal = new Error(`Cloud Error: ${o.error_name}`);
    if (o?.event === 'Started') { dialog = o.dialog_id; summary.dialog = dialog; }
    if (o?.event === 'DialogStateChanged') { state = o.state; if (state === 'Listening') ready = true; }
    if (o?.event === 'RespondingContent') content.push({ receivedAfterMs: Date.now() - sentAt, ...o });
    if (o?.event === 'RespondingEnded') { audioEnded = true; log({ round, audioBytes: bytes }); }
  });
  ws.on('error', e => { fatal = e; });
  ws.on('close', code => { if (!stopping) fatal = new Error(`Unexpected close ${code}`); });
  const silence = setInterval(() => { if (ready && ws.readyState === WebSocket.OPEN && !stopping) ws.send(Buffer.alloc(3200)); }, 100);
  const heartbeat = setInterval(() => { if (dialog && ws.readyState === WebSocket.OPEN && !stopping) send('HeartBeat'); }, 15000);
  // Consume exactly the received PCM, then acknowledge playback. No early stop or RequestToSpeak.
  const sink = setInterval(() => {
    if (firstAudioAt) played = Math.min(bytes, Math.floor((performance.now() - firstAudioAt) * 48 / 2) * 2);
    if (audioEnded && played >= bytes && !localEnded && ws.readyState === WebSocket.OPEN) {
      localEnded = true; log({ round, playbackEnded: true, audioBytes: bytes, playedBytes: played }); send('LocalRespondingEnded');
    }
  }, 20);
  const until = async (test: () => boolean, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (!test()) { if (fatal) throw fatal; if (Date.now() > deadline) throw new Error('Timed out waiting for cloud/audio completion'); await pause(20); }
    if (fatal) throw fatal;
  };
  try {
    await until(() => state === 'Listening', 25000);
    const queries = mode === 'replay' ? pairs : [pairs[turn - 1]];
    for (const pair of queries) {
      round++; bytes = 0; played = 0; firstAudioAt = 0; audioEnded = false; localEnded = false; content = [];
      const history = mode === 'history' ? pairs.slice(0, historyCount).flatMap(p => [{ role: 'user', content: p.input }, { role: 'assistant', content: p.output }]) : undefined;
      sentAt = Date.now();
      send('RequestToRespond', { type: 'prompt', text: pair.input }, history ? { history } : undefined);
      await until(() => localEnded && state === 'Listening');
      const result = { round, input: pair.input, response: content.at(-1), contentEvents: content.length, audioSeconds: bytes / 48000, playedBytes: played, audioBytes: bytes };
      summary.rounds.push(result); console.log(JSON.stringify(result));
      fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
      await pause(600);
    }
  } catch (e) { summary.error = e instanceof Error ? e.message : String(e); throw e; }
  finally {
    stopping = true; clearInterval(silence); clearInterval(heartbeat); clearInterval(sink);
    if (ws.readyState === WebSocket.OPEN) { send('Stop'); ws.close(); }
    else ws.terminate();
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`Artifacts: ${path.resolve(dir)}`);
  }
}
readSession().then(run).catch(e => { console.error(e.message); process.exitCode = 1; });
