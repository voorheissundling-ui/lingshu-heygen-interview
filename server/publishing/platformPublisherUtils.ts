import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function publishError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeVideoPath(input: string): string {
  const raw = input.trim();
  return raw.startsWith('file://') ? fileURLToPath(raw) : path.resolve(raw);
}

export function parsePublishingTags(tags: unknown, description: string): string[] {
  if (Array.isArray(tags)) return tags.map(String).map(item => item.replace(/^#/, '').trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(/[\s,，]+/).map(item => item.replace(/^#/, '').trim()).filter(Boolean);
  return Array.from(description.matchAll(/#([\p{L}\p{N}_-]+)/gu)).map(match => match[1]);
}

export function publishingAccountStatus(error: any): number {
  return Number(error?.statusCode || error?.response?.status || 500) || 500;
}
