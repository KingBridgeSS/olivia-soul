import fs from 'node:fs';
import { parseEnv } from 'node:util';

// Defined process variables override optional file values.
export function readEnvironment(file?: string, overrides: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const values = file && fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  return { ...values, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) };
}
