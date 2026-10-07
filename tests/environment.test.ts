import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvironment } from '../src/main/environment';

test('environment overrides optional files without erasing values with undefined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olivia-env-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'key=file-value\napp_id=file-app\n');
    assert.deepEqual(readEnvironment(file, { key: 'process-value', app_id: undefined }), { key: 'process-value', app_id: 'file-app' });
    assert.deepEqual(readEnvironment(path.join(dir, 'absent'), { key: 'process-value' }), { key: 'process-value' });
    assert.deepEqual(readEnvironment(undefined, {}), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
