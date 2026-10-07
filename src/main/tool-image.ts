import { createHash } from 'node:crypto';

// Images stay separate from tool text/history so they cannot become prompt text or telemetry.
export interface ToolImage { type: 'base64'; value: string }
export function imageInfo(image: ToolImage) {
  const bytes = Buffer.from(image.value, 'base64');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
export function withoutImage<T extends { image?: ToolImage }>(value: T): Omit<T, 'image'> {
  const { image, ...rest } = value;
  return rest;
}
