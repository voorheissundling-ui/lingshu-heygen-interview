import fs from 'node:fs';
import path from 'node:path';
import type { PublishPlatform } from '../lib/publishHistory.js';

export type UnifiedPublishPreflightInput = {
  platform: PublishPlatform;
  title: string;
  description?: string;
  tags?: unknown;
  videoPath?: string;
  videoUrl?: string;
  imagePaths?: string[];
};

export type UnifiedPublishPreflightResult = {
  ok: boolean;
  mediaKind: 'video' | 'image' | 'none';
  normalizedTags: string[];
  errors: string[];
};

function tags(value: unknown, body: string): string[] {
  const values = Array.isArray(value) ? value.map(String)
    : typeof value === 'string' ? value.split(/[\s,，]+/)
      : [...body.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map(match => match[1]);
  return [...new Set(values.map(item => item.replace(/^#+/, '').trim()).filter(Boolean))];
}

export function unifiedPublishPreflight(input: UnifiedPublishPreflightInput): UnifiedPublishPreflightResult {
  const body = String(input.description || '').trim();
  const normalizedTags = tags(input.tags, body);
  const imagePaths = [...new Set((input.imagePaths ?? []).map(item => path.resolve(item)).filter(Boolean))];
  const hasVideo = Boolean(input.videoPath?.trim() || input.videoUrl?.trim());
  const mediaKind = hasVideo ? 'video' : imagePaths.length ? 'image' : 'none';
  const errors: string[] = [];
  if (!input.title.trim()) errors.push('发布标题不能为空');
  if (!body) errors.push('统一发布文案不能为空');
  if (body.length > 2_200) errors.push('统一发布文案超过跨平台安全上限 2200 字符');
  if (normalizedTags.length > 5) errors.push('统一 Tag 最多 5 个');
  if (normalizedTags.some(tag => tag.length > 50)) errors.push('单个 Tag 最多 50 个字符');
  if (mediaKind === 'none') errors.push('发布前必须绑定视频或图片产物');
  if (hasVideo && imagePaths.length) errors.push('一次发布只能选择视频或图片，不能混用两种主媒体');
  if (imagePaths.length > 9) errors.push('统一图文发布最多 9 张图片');
  for (const imagePath of imagePaths) {
    if (!['.jpg', '.jpeg', '.png'].includes(path.extname(imagePath).toLowerCase())) errors.push(`图片格式不支持：${path.basename(imagePath)}`);
    else if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) errors.push(`图片文件不存在：${path.basename(imagePath)}`);
    else if (fs.statSync(imagePath).size > 8 * 1024 * 1024) errors.push(`图片超过 8MB：${path.basename(imagePath)}`);
  }
  return { ok: errors.length === 0, mediaKind, normalizedTags, errors };
}

export function assertUnifiedPublishPreflight(input: UnifiedPublishPreflightInput): UnifiedPublishPreflightResult {
  const result = unifiedPublishPreflight(input);
  if (!result.ok) throw Object.assign(new Error(result.errors.join('；')), { statusCode: 422, code: 'unified_publish_preflight_failed' });
  return result;
}
