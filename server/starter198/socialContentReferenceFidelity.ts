import type { SocialReferenceVideoAnalysis, SocialReplicationScriptVersion } from '../../shared/contracts/socialContentWorkflow.js';

/** Only floating-point/serialization drift is allowed; budget and narration cannot retime slots. */
export const SOCIAL_REFERENCE_FIDELITY_TIMING_TOLERANCE_SECONDS = 0.05;

export function socialReferenceFidelityFailures(input: {
  referenceAnalysis: SocialReferenceVideoAnalysis | null | undefined;
  replicationScript: SocialReplicationScriptVersion | null | undefined;
}): string[] {
  const failures: string[] = [];
  const reference = input.referenceAnalysis;
  const script = input.replicationScript;
  if (!reference) failures.push('reference_fidelity:missing_reference_analysis');
  if (!script) failures.push('reference_fidelity:missing_replication_script');
  if (!reference || !script) return failures;
  const tolerance = SOCIAL_REFERENCE_FIDELITY_TIMING_TOLERANCE_SECONDS;
  const validInterval = (shot: { startSeconds: number; endSeconds: number }) =>
    Number.isFinite(shot.startSeconds) && Number.isFinite(shot.endSeconds)
    && shot.startSeconds >= 0 && shot.endSeconds > shot.startSeconds;
  const differs = (a: number, b: number) => Math.abs(a - b) > tolerance + Number.EPSILON;
  if (reference.status !== 'ready') failures.push('reference_fidelity:reference_not_ready');
  if (script.referenceAnalysisId !== reference.analysisId) failures.push('reference_fidelity:analysis_identity_mismatch');
  if (!Number.isFinite(reference.durationSeconds) || (reference.durationSeconds ?? 0) <= 0) {
    failures.push('reference_fidelity:missing_reference_duration');
  }
  if (!reference.shots.length) failures.push('reference_fidelity:missing_reference_shots');
  if (script.shots.length < reference.shots.length) failures.push('reference_fidelity:shot_count_mismatch');
  const referenceIds = new Set<string>();
  reference.shots.forEach((shot, index) => {
    if (!shot.shotId || referenceIds.has(shot.shotId)) failures.push(`reference_fidelity:invalid_reference_identity:${index}`);
    referenceIds.add(shot.shotId);
    if (!validInterval(shot)) failures.push(`reference_fidelity:invalid_reference_interval:${index}`);
    const previousEnd = index ? reference.shots[index - 1]!.endSeconds : 0;
    if (differs(shot.startSeconds, previousEnd)) failures.push(`reference_fidelity:reference_timeline_gap_or_overlap:${index}`);
  });
  if (reference.shots.length && reference.durationSeconds != null
    && differs(reference.shots.at(-1)!.endSeconds, reference.durationSeconds)) {
    failures.push('reference_fidelity:reference_duration_coverage_mismatch');
  }
  const scriptIds = new Set<string>();
  const boundReferenceIds = new Set<string>();
  const referenceById = new Map(reference.shots.map(shot => [shot.shotId, shot]));
  let previousReferenceIndex = -1;
  script.shots.forEach((shot, index) => {
    if (!shot.shotId || scriptIds.has(shot.shotId)) failures.push(`reference_fidelity:invalid_script_identity:${index}`);
    scriptIds.add(shot.shotId);
    if (!validInterval(shot)) failures.push(`reference_fidelity:invalid_script_interval:${index}`);
    if (shot.scriptOrigin === 'budget_semantic_revision') failures.push(`reference_fidelity:semantic_compression_forbidden:${index}`);
    if (shot.referenceShotIds && (shot.referenceShotIds.length !== 1 || shot.referenceShotIds[0] !== shot.referenceShotId)) {
      failures.push(`reference_fidelity:many_to_one_or_conflicting_binding:${index}`);
    }
    if (!shot.referenceShotId) failures.push(`reference_fidelity:missing_or_repeated_binding:${index}`);
    if (shot.referenceShotId) boundReferenceIds.add(shot.referenceShotId);
    const expected = shot.referenceShotId ? referenceById.get(shot.referenceShotId) : undefined;
    const referenceIndex = shot.referenceShotId ? reference.shots.findIndex(item => item.shotId === shot.referenceShotId) : -1;
    if (!expected || referenceIndex < previousReferenceIndex) failures.push(`reference_fidelity:slot_identity_or_order_mismatch:${index}`);
    previousReferenceIndex = Math.max(previousReferenceIndex, referenceIndex);
    if (expected && (shot.startSeconds < expected.startSeconds - tolerance || shot.endSeconds > expected.endSeconds + tolerance)) {
      failures.push(`reference_fidelity:slot_timing_mismatch:${index}`);
    }
  });
  for (const expected of reference.shots) {
    const children = script.shots.filter(shot => shot.referenceShotId === expected.shotId)
      .sort((left, right) => left.startSeconds - right.startSeconds);
    if (!children.length) continue;
    if (differs(children[0]!.startSeconds, expected.startSeconds)
      || differs(children.at(-1)!.endSeconds, expected.endSeconds)
      || children.some((child, index) => index > 0 && differs(child.startSeconds, children[index - 1]!.endSeconds))) {
      failures.push(`reference_fidelity:slot_timing_mismatch:${expected.shotId}`);
    }
  }
  if (reference.shots.some(shot => !boundReferenceIds.has(shot.shotId))) failures.push('reference_fidelity:reference_slots_omitted');
  if (!script.shots.length || (reference.durationSeconds != null && differs(script.shots.at(-1)!.endSeconds, reference.durationSeconds))) {
    failures.push('reference_fidelity:script_total_duration_mismatch');
  }
  return failures;
}
