import fs from 'node:fs';
import path from 'node:path';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

export type StudioRenderTimelineSource = {
  url?: string | null;
  trimStart?: number;
  speed?: number;
  targetStart?: number;
  targetDuration?: number;
  type?: string;
};

export function localStudioMediaPath(value: unknown, mediaRoot: string): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) pathname = new URL(raw).pathname;
  } catch { return null; }
  if (!pathname.startsWith('/media/')) return null;
  let relative: string;
  try { relative = decodeURIComponent(pathname.slice('/media/'.length)); } catch { return null; }
  const root = path.resolve(mediaRoot);
  const candidate = path.resolve(root, relative);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) return null;
  if (!VIDEO_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch { return null; }
}

export function eligibleStudioEmphasisSource(input: {
  timeline: StudioRenderTimelineSource[];
  durationSeconds: number;
  mediaRoot: string;
}): string | null {
  if (input.timeline.length !== 1 || !(input.durationSeconds > 0)) return null;
  const clip = input.timeline[0]!;
  if (clip.type && clip.type !== 'video') return null;
  if (Math.abs(Number(clip.trimStart) || 0) > .05) return null;
  if (Math.abs((Number(clip.speed) || 1) - 1) > .001) return null;
  if (Math.abs(Number(clip.targetStart) || 0) > .05) return null;
  if (Number.isFinite(clip.targetDuration) && Math.abs(Number(clip.targetDuration) - input.durationSeconds) > .1) return null;
  return localStudioMediaPath(clip.url, input.mediaRoot);
}
