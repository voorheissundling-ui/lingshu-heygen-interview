import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';

const run = promisify(execFile);
export const STUDIO_SHOT_ANALYZER_VERSION = 'ffmpeg-scene.v1';
export type StudioShotWindow = { id: string; startMs: number; endMs: number; confidence: number; source: 'ffmpeg_scene' | 'storyboard' | 'fallback' };
export type StoryboardWindow = { startMs?: unknown; endMs?: unknown; targetStart?: unknown; targetEnd?: unknown; targetDuration?: unknown };

const finite = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export function parseFfmpegSceneCutTimes(stderr: string): number[] {
  const values = [
    ...String(stderr || '').matchAll(/(?:pts_time:|lavfi\.scene_score[^\n]*?pts_time[:=])\s*([0-9]+(?:\.[0-9]+)?)/g),
  ].map(match => Number(match[1])).filter(value => Number.isFinite(value) && value > 0);
  return [...new Set(values.map(value => Math.round(value * 1_000)))].sort((left, right) => left - right);
}

export function shotWindowsFromCuts(cutTimesMs: number[], durationMs: number, minimumGapMs = 280): StudioShotWindow[] {
  const duration = Math.max(0, Math.round(finite(durationMs, 0)));
  if (!duration) return [];
  const cuts = cutTimesMs.map(value => Math.round(finite(value, -1)))
    .filter(value => value > 0 && value < duration).sort((left, right) => left - right);
  const merged: number[] = [];
  for (const cut of cuts) {
    const previous = merged.at(-1);
    if (previous !== undefined && cut - previous < minimumGapMs) merged[merged.length - 1] = Math.round((previous + cut) / 2);
    else merged.push(cut);
  }
  return [0, ...merged, duration].slice(0, -1).map((startMs, index, boundaries) => ({
    id: `shot-${index + 1}`,
    startMs,
    endMs: index + 1 < boundaries.length ? boundaries[index + 1]! : duration,
    confidence: .9,
    source: 'ffmpeg_scene',
  }));
}

export function storyboardShotWindows(value: unknown, durationMs: number): StudioShotWindow[] {
  const duration = Math.max(0, Math.round(finite(durationMs, 0)));
  if (!Array.isArray(value) || !duration) return [];
  let cursor = 0;
  const windows = value.slice(0, 240).flatMap((raw, index) => {
    const shot = raw && typeof raw === 'object' ? raw as StoryboardWindow : {};
    const startMs = clamp(Math.round(shot.startMs !== undefined ? finite(shot.startMs, cursor)
      : finite(shot.targetStart, cursor / 1_000) * 1_000), 0, duration);
    const guessedEnd = startMs + Math.round(finite(shot.targetDuration, 2) * 1_000);
    const endMs = clamp(Math.round(shot.endMs !== undefined ? finite(shot.endMs, guessedEnd)
      : shot.targetEnd !== undefined ? finite(shot.targetEnd, guessedEnd / 1_000) * 1_000 : guessedEnd), startMs, duration);
    cursor = endMs;
    return endMs > startMs ? [{ id: `shot-${index + 1}`, startMs, endMs, confidence: .62, source: 'storyboard' as const }] : [];
  });
  return windows;
}

export async function detectStudioShotWindows(input: {
  sourcePath: string;
  durationMs: number;
  storyboard?: unknown;
  threshold?: number;
  ffmpegPath?: string | null;
  execute?: (file: string, args: string[]) => Promise<{ stderr: string }>;
}): Promise<StudioShotWindow[]> {
  const duration = Math.max(0, Math.round(finite(input.durationMs, 0)));
  const fallback = storyboardShotWindows(input.storyboard, duration);
  if (!duration) return [];
  const ffmpeg = input.ffmpegPath === undefined ? ffmpegStatic : input.ffmpegPath;
  if (!ffmpeg || !input.sourcePath) return fallback.length ? fallback : [{ id: 'shot-1', startMs: 0, endMs: duration, confidence: 0, source: 'fallback' }];
  try {
    const threshold = clamp(finite(input.threshold, .28), .05, .95);
    const args = ['-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-i', input.sourcePath,
      '-map', '0:v:0', '-vf', `select='gt(scene,${threshold.toFixed(2)})',showinfo`, '-an', '-f', 'null', '-'];
    const result = input.execute ? await input.execute(ffmpeg, args) : await run(ffmpeg, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const cuts = parseFfmpegSceneCutTimes(result.stderr);
    return cuts.length ? shotWindowsFromCuts(cuts, duration) : fallback.length ? fallback
      : [{ id: 'shot-1', startMs: 0, endMs: duration, confidence: .35, source: 'fallback' }];
  } catch {
    return fallback.length ? fallback : [{ id: 'shot-1', startMs: 0, endMs: duration, confidence: 0, source: 'fallback' }];
  }
}
