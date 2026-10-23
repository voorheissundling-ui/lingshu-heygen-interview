import type { MaterialSegment } from './studioApi';

export function usableEvidenceSegment(segment: MaterialSegment, duration: number): boolean {
  return Number.isFinite(segment.start) && Number.isFinite(segment.end)
    && segment.start >= 0 && segment.end <= duration && segment.end - segment.start >= 0.5
    && segment.quality >= 55 && segment.confidence >= 0.5
    && (!segment.needsReview || segment.manualConfirmed === true)
    && Boolean(segment.action?.trim())
    && !/未见|未观察|没有|未发生|无法确认|未展示|\b(?:not|no|without|unclear)\b/i.test(segment.action);
}

function terms(text: string): Set<string> {
  const result = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fff]+/g) || []) {
    if (/^[a-z]/.test(token)) result.add(token);
    else for (let i = 0; i < token.length - 1; i++) result.add(token.slice(i, i + 2));
  }
  return result;
}

/** Conservative lexical candidate selection, not a claim of visual understanding. */
export function matchEvidenceSegment(
  clip: { type: string; duration: number; segments?: MaterialSegment[] },
  slot: { detail: string; start: number; end: number },
) {
  if (clip.type !== 'video') return null;
  const action = slot.detail.match(/(?:^|\n)画面[：:]([^\n]+)/)?.[1] || slot.detail;
  const wanted = terms(action);
  const target = slot.end - slot.start;
  if (!Number.isFinite(target) || target <= 0) return null;
  const candidates = (clip.segments || []).filter(segment =>
    usableEvidenceSegment(segment, clip.duration) && segment.end - segment.start >= target,
  ).map(segment => {
    const observed = terms(`${segment.subject.join(' ')} ${segment.action}`);
    const hits = [...observed].filter(term => wanted.has(term)).length;
    const actionHits = [...terms(segment.action)].filter(term => wanted.has(term)).length;
    return { segment, hits, actionHits, score: hits / Math.max(1, observed.size) };
  }).filter(item => item.hits >= 2 && item.actionHits >= 1 && item.score >= 0.25)
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.segment.start - b.segment.start);
  const best = candidates[0];
  if (!best) return null;
  return { segmentId: best.segment.id, trimStart: best.segment.start,
    trimEnd: +(best.segment.start + target).toFixed(3), targetDuration: target,
    speed: 1, evidence: best.segment.action };
}
