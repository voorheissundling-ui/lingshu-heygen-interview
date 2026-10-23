import type { VideoAiAnalysis } from '../types/index.js';

export type ReferenceFrameSamplingProfile = 'coarse' | 'talking_head_dense';
export interface ReferenceFrameSamplingRange { startSeconds: number; endSeconds: number }

const timeRange = (value: unknown): ReferenceFrameSamplingRange | null => {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?$/i);
  if (!match) return null;
  const startSeconds = Number(match[1]);
  const endSeconds = Number(match[2]);
  return Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds
    ? { startSeconds, endSeconds } : null;
};

/**
 * Frame density is a consequence of an observed material classification.  A
 * person merely appearing in factory/product/D2C footage is not enough to pay
 * for (or infer motion from) presenter-level temporal sampling.
 */
export function referenceFrameSamplingProfile(
  analysis: Pick<VideoAiAnalysis, 'scriptDetails15s'> | null | undefined,
): ReferenceFrameSamplingProfile {
  return (analysis?.scriptDetails15s || []).some(shot => shot.materialType === 'talking_head')
    ? 'talking_head_dense'
    : 'coarse';
}

export function requiresPresenterDenseSampling(
  analysis: Pick<VideoAiAnalysis, 'scriptDetails15s'> | null | undefined,
): boolean {
  return referenceFrameSamplingProfile(analysis) === 'talking_head_dense';
}

/** Exact preliminary presenter intervals; non-presenter windows never enter pass two. */
export function presenterDenseSamplingRanges(
  analysis: Pick<VideoAiAnalysis, 'scriptDetails15s'> | null | undefined,
  durationSeconds: number,
): ReferenceFrameSamplingRange[] {
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : Number.POSITIVE_INFINITY;
  const ranges = (analysis?.scriptDetails15s ?? [])
    .filter(shot => shot.materialType === 'talking_head')
    .map(shot => timeRange(shot.time))
    .filter((range): range is ReferenceFrameSamplingRange => Boolean(range))
    .map(range => ({ startSeconds: Math.max(0, range.startSeconds), endSeconds: Math.min(duration, range.endSeconds) }))
    .filter(range => range.endSeconds > range.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: ReferenceFrameSamplingRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.startSeconds <= previous.endSeconds) previous.endSeconds = Math.max(previous.endSeconds, range.endSeconds);
    else merged.push({ ...range });
  }
  return merged;
}
