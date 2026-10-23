import type { VideoAiAnalysis } from '../types/index.js';
import { parseAnalysisTimeRange } from '../lib/videoAnalysisCodec.js';

/** Pure frame selection and timeline projections for exact video analysis. */
export function selectFramesForPhysicalCuts<T extends { timeLabel: string }>(
  frames: T[], cuts: number[], start: number, end: number, limit: number,
): T[] {
  if (frames.length <= limit) return frames;
  const boundaries = [start, ...cuts.filter(cut => cut > start && cut < end), end];
  const required: T[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index]!, to = boundaries[index + 1]!;
    if (to - from < 0.35 || to - from > 2.5) continue;
    const middle = (from + to) / 2;
    const candidate = frames.filter(frame => {
      const time = qwenFrameSeconds(frame.timeLabel);
      return time >= from && time < to;
    }).sort((a, b) => Math.abs(qwenFrameSeconds(a.timeLabel) - middle) - Math.abs(qwenFrameSeconds(b.timeLabel) - middle))[0];
    if (candidate && !required.includes(candidate)) required.push(candidate);
  }
  const available = frames.filter(frame => !required.includes(frame));
  const room = Math.max(0, limit - required.length);
  const context = available.length <= room ? available : Array.from({ length: room }, (_, index) =>
    available[Math.round(index * (available.length - 1) / Math.max(1, room - 1))]!);
  return [...required.slice(0, limit), ...context].sort((a, b) => qwenFrameSeconds(a.timeLabel) - qwenFrameSeconds(b.timeLabel));
}

export function qwenFrameSeconds(label: string): number {
  const value = Number.parseFloat(String(label || '').replace(/s$/i, ''));
  return Number.isFinite(value) ? value : 0;
}

export function shiftedTimelineLabel(label: string, offset: number, localDuration: number): string {
  const range = parseAnalysisTimeRange(String(label || ''));
  const localStart = Math.max(0, Math.min(localDuration, range?.start || 0));
  const localEnd = Math.max(localStart, Math.min(localDuration, range?.end || localStart));
  const fmt = (value: number) => value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return `${fmt(localStart + offset)}s–${fmt(localEnd + offset)}s`;
}

/** Qwen receives short observation windows for accuracy. Those windows are
 * evidence beats, not physical edits. Only an observed scene cut may start a
 * new shot; chunk edges and the four-second sampling cadence cannot. */
export function groupExactObservationWindows(analysis: VideoAiAnalysis, sceneCuts: number[]): VideoAiAnalysis {
  const source = analysis.scriptDetails15s || [];
  if (source.length < 2) return analysis;
  const rows = source.map(detail => ({ detail, range: parseAnalysisTimeRange(String(detail.time || detail.timestamp || '')) }))
    .filter((row): row is { detail: NonNullable<VideoAiAnalysis['scriptDetails15s']>[number]; range: { start: number; end: number } } => Boolean(row.range))
    .sort((a, b) => a.range.start - b.range.start);
  if (rows.length !== source.length) return analysis;
  if (!sceneCuts.length) return {
    ...analysis,
    scriptDetails15s: rows.map(row => ({ ...row.detail, analysisGranularity: 'observation_window', needsReview: true })),
  } as VideoAiAnalysis;
  const groups: typeof rows[] = [];
  let current: typeof rows = [];
  for (const row of rows) {
    const previous = current.at(-1);
    const boundary = row.range.start;
    // Boundaries are rounded to centiseconds on both sides. A wider tolerance
    // mistakes nearby 12-second model chunk edges for physical scene cuts.
    const hasObservedCut = previous && sceneCuts.some(cut => Math.abs(cut - boundary) <= 0.03);
    if (hasObservedCut && current.length) { groups.push(current); current = []; }
    current.push(row);
  }
  if (current.length) groups.push(current);
  const uniqueText = (values: Array<string | undefined>) => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].join('；');
  const grouped = groups.map(group => {
    const first = group[0]!.detail;
    const last = group.at(-1)!.detail;
    return {
      ...first,
      time: `${group[0]!.range.start.toFixed(2)}s–${group.at(-1)!.range.end.toFixed(2)}s`,
      visual: uniqueText(group.map(row => row.detail.visual)),
      dialogue: uniqueText(group.map(row => row.detail.dialogue)),
      purpose: uniqueText(group.map(row => row.detail.purpose)),
      materialType: group.every(row => row.detail.materialType === first.materialType) ? first.materialType : 'unknown',
      narrativeRole: group.every(row => row.detail.narrativeRole === first.narrativeRole) ? first.narrativeRole : 'unknown',
      classificationEvidence: uniqueText(group.map(row => row.detail.classificationEvidence)),
      observedFacts: uniqueText(group.map(row => row.detail.observedFacts)),
      inferredIntent: uniqueText(group.map(row => row.detail.inferredIntent)),
      transitionToNext: last.transitionToNext,
      endState: last.endState,
      needsReview: group.some(row => row.detail.needsReview === true || row.detail.materialType !== first.materialType || row.detail.narrativeRole !== first.narrativeRole),
      analysisGranularity: 'scene_cut_estimated',
      beats: group.flatMap(row => row.detail.beats?.length ? row.detail.beats : [{
        time: `${row.range.start.toFixed(2)}s–${row.range.end.toFixed(2)}s`,
        action: row.detail.visual,
        dialogue: row.detail.dialogue,
        onScreenText: row.detail.onScreenText,
      }]),
    };
  });
  return { ...analysis, scriptDetails15s: grouped } as VideoAiAnalysis;
}

/** Gemini returns semantic beats which may span several physical edits. Exact
 * production needs those edits as independent shots so extraction, routing and
 * validation never treat a multi-cut montage as one continuous camera take. */
export function splitExactGeminiShotsAtSceneCuts(analysis: VideoAiAnalysis, sceneCuts: number[]): VideoAiAnalysis {
  const rows = analysis.scriptDetails15s || [];
  if (!rows.length || !sceneCuts.length) return analysis;
  const split = rows.flatMap(detail => {
    const range = parseAnalysisTimeRange(String(detail.time || detail.timestamp || ''));
    if (!range) return [detail];
    const boundaries = [range.start, ...sceneCuts.filter(cut => cut > range.start + 0.08 && cut < range.end - 0.08), range.end]
      .sort((a, b) => a - b);
    const compact: number[] = [];
    for (const value of boundaries) {
      if (!compact.length || value - compact.at(-1)! >= 0.12) compact.push(value);
      else compact[compact.length - 1] = value;
    }
    if (compact.length < 3) return [detail];
    return compact.slice(0, -1).map((start, index) => {
      const end = compact[index + 1]!;
      const fmt = (value: number) => value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
      const beats = detail.beats?.filter(beat => {
        const beatRange = parseAnalysisTimeRange(String(beat.time || ''));
        return !beatRange || (beatRange.start < end && beatRange.end > start);
      });
      return {
        ...detail,
        time: `${fmt(start)}s–${fmt(end)}s`,
        ...(beats?.length ? { beats } : {}),
        analysisGranularity: 'physical_scene_cut',
      };
    });
  });
  return { ...analysis, scriptDetails15s: split } as VideoAiAnalysis;
}
