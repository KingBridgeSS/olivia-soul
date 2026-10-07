import assert from 'node:assert/strict';
import { initTracing, startRequestTrace, shutdownTracing } from '../../src/main/tracing';
import { runToolLoop } from '../../src/main/tool-flow';

process.env.LANGFUSE_ENABLED = 'true';
process.env.LANGFUSE_BASE_URL = 'http://127.0.0.1:1';
process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
async function main() {
  assert.equal(initTracing(), true);
  const trace = startRequestTrace('offline-test', 'list', 'text');
  assert.ok(trace);
  let executions = 0;
  await runToolLoop([{ id: 'one', name: 'list_tasks', command: { id: 'one', name: 'list_tasks', goal: '', context: '' } }], {
    trace, execute: async () => { executions++; return { success: true, text: '[]' }; },
    submit: async () => {}, next: async () => [], finish: async () => {},
  }, new AbortController().signal);
  trace.end();
  assert.equal(executions, 1);
  await shutdownTracing();
  console.log('OUTAGE_OK');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
