import type { VideoAiAnalysis } from '../types/index.js';
import { parseAnalysisTimeRange } from '../lib/videoAnalysisCodec.js';

export interface HookMotionEvidence {
  observations: Array<{ time: number; visibleState: string; confidence: number }>;
  transitions: Array<{ from: number; to: number; action: string; evidence: string; confidence: number }>;
  uncertainties: string[];
}

function openingHookMotionReviewReasons(evidence: HookMotionEvidence): string[] {
  const observations = evidence.observations.filter(item =>
    item.time >= 0 && item.time <= 1 && item.visibleState.trim() && item.confidence >= 0.65
  ).sort((a, b) => a.time - b.time);
  const transitions = evidence.transitions.filter(item =>
    item.from >= 0 && item.to <= 1 && item.to > item.from &&
    item.action.trim() && item.evidence.trim() && item.confidence >= 0.7 &&
    observations.some(observation => Math.abs(observation.time - item.from) <= 0.45) &&
    observations.some(observation => Math.abs(observation.time - item.to) <= 0.45)
  ).sort((a, b) => a.from - b.from);
  const reasons: string[] = [];
  if (observations.length < 3 || (observations.at(-1)?.time || 0) - (observations[0]?.time || 0) < 0.5) {
    reasons.push('opening_hook_insufficient_temporal_observations');
  }
  if (transitions.length < 2) reasons.push('opening_hook_motion_incomplete');
  return reasons;
}

/** Re-evaluate persisted evidence when admission rules improve, without making
 * another provider call or changing the observed action description. */
export function reconcileStoredOpeningHookMotionEvidence(analysis: VideoAiAnalysis): VideoAiAnalysis {
  const index = firstSubstantiveOpeningShot(analysis);
  if (index < 0) return analysis;
  const rows = [...(analysis.scriptDetails15s || [])];
  const row = rows[index]!;
  const raw = row.hookMotionEvidence as HookMotionEvidence | undefined;
  if (!raw || !Array.isArray(raw.observations) || !Array.isArray(raw.transitions) || !Array.isArray(raw.uncertainties)) return analysis;
  const reasons = openingHookMotionReviewReasons(raw);
  rows[index] = { ...row, needsReview: reasons.length ? true : false,
    hookMotionEvidence: { ...raw, status: reasons.length ? 'needs_review' : 'verified' } };
  return { ...analysis, scriptDetails15s: rows };
}

/** Locate the visual carrier of the first-second action hook. A cover flash
 * shorter than 0.2 s is retained on the timeline but is never the carrier. */
export function firstSubstantiveOpeningShot(analysis: VideoAiAnalysis): number {
  return (analysis.scriptDetails15s || []).findIndex(row => {
    const range = parseAnalysisTimeRange(String(row.time || row.timestamp || ''));
    return Boolean(range && range.start < 1 && range.end > 0 && range.end - range.start >= 0.2);
  });
}

/** Only independently observed time-ordered transitions can enrich a hook.
 * Uncertain observations stop automatic director-to-content admission. */
export function applyOpeningHookMotionEvidence(analysis: VideoAiAnalysis, evidence: HookMotionEvidence): {
  analysis: VideoAiAnalysis;
  reviewReasons: string[];
} {
  const index = firstSubstantiveOpeningShot(analysis);
  if (index < 0) return { analysis, reviewReasons: ['opening_hook_no_substantive_shot'] };
  const rows = [...(analysis.scriptDetails15s || [])];
  const row = rows[index]!;
  const observations = evidence.observations.filter(item =>
    item.time >= 0 && item.time <= 1 && item.visibleState.trim() && item.confidence >= 0.65
  ).sort((a, b) => a.time - b.time);
  const transitions = evidence.transitions.filter(item =>
    item.from >= 0 && item.to <= 1 && item.to > item.from &&
    item.action.trim() && item.evidence.trim() && item.confidence >= 0.7 &&
    observations.some(observation => Math.abs(observation.time - item.from) <= 0.45) &&
    observations.some(observation => Math.abs(observation.time - item.to) <= 0.45)
  ).sort((a, b) => a.from - b.from);
  const reasons = openingHookMotionReviewReasons({ observations, transitions, uncertainties: evidence.uncertainties });
  // Keep model uncertainties in the audit payload, but do not let a naming
  // uncertainty (for example, whether an observed hand shape should be called
  // a "knock") override enough independently timed visual transitions. The
  // executable description below uses only observed actions, never the
  // uncertain interpretation. Missing temporal evidence is still blocking via
  // the two checks above.
  const motion = transitions.map(item => item.action).join('，');
  const updated = {
    ...row,
    // Preserve the original model description for review, append only the
    // independent observations with traceable time points.
    visual: motion ? `${row.visual || ''}；逐帧动作：${motion}`.replace(/^；/, '') : row.visual,
    beats: transitions.length ? transitions.map(item => ({
      time: `${item.from.toFixed(2)}-${item.to.toFixed(2)}s`, action: item.action,
    })) : row.beats,
    needsReview: Boolean(row.needsReview || reasons.length),
    hookMotionEvidence: { observations, transitions, uncertainties: evidence.uncertainties,
      status: reasons.length ? 'needs_review' as const : 'verified' as const },
  };
  rows[index] = updated;
  return { analysis: { ...analysis, scriptDetails15s: rows }, reviewReasons: reasons };
}
