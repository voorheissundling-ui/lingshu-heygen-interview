import { socialObject, socialJson, socialText } from './socialContentValidation.js';
import { hasKnownFinalMediaCoverageFailure } from './socialFinalPrivacyCoverage.js';
import { hasKnownCaptionMaskFailure } from './socialCaptionMaskFrameAudit.js';
import { hasKnownFinalSensitiveFrameFailure } from './socialFinalSensitiveFrameAudit.js';

const object = (value: unknown) => socialObject(socialJson(value)) ?? {};
const emptyFailures = (value: unknown) => Array.isArray(value) && value.length === 0;

/** A subjective factor may remain for the final human review. Missing identity,
 * rights, account/fact or timeline evidence is never converted into that case. */
export function socialReplicationHardQualityFailures(rawEvaluation: unknown): string[] {
  if (rawEvaluation == null) return [];
  const evaluation = object(rawEvaluation);
  const failures: string[] = [];
  if (!['passed', 'review_required'].includes(socialText(evaluation.status))
    || !emptyFailures(object(evaluation.directorDecision).failedCriteria)) failures.push('reference_hard_blocker');
  const required = ['identityReplacement', 'unauthorizedReuseRisk', 'originalityDifference', 'accountAndFactFit'];
  if (required.some(key => !['passed', 'not_applicable'].includes(socialText(object(evaluation[key]).status))))
    failures.push('reference_identity_rights_fact_unverified');
  if (!['passed', 'review_required'].includes(socialText(object(evaluation.viralFactorFidelity).status)))
    failures.push('reference_factor_evidence_invalid');
  const timeline = object(evaluation.referenceTimelineAudit);
  if (timeline.fullCoverageValidated !== true || !Number.isSafeInteger(timeline.referenceShotCount)
    || Number(timeline.referenceShotCount) < 1 || timeline.outputShotCount !== timeline.referenceShotCount)
    failures.push('reference_timeline_unverified');
  return failures;
}

/** A rendered file is not an internally accepted film. This is the boundary
 * between the recoverable quality node and the final human-review interrupt. */
export function socialContentGraphQualityFailures(rawContent: unknown): string[] {
  const content = object(rawContent);
  const result = object(content.productionResult);
  const technical = object(result.technicalReview);
  const creative = object(result.creativeReview);
  const report = object(content.technicalQualityReport);
  const visual = object(report.visual);
  const scenes = object(report.scenes);
  const audio = object(report.audio);
  const probe = object(report.mediaHardProbe);
  const render = object(content.render);
  const review = object(content.review);
  const delivery = object(content.delivery);
  const media = object(object(content.mediaStorage).video);
  const source = object(content.productionWorkspaceSource);
  const failures: string[] = [];
  // A viral-replication artifact must carry the independent reference audit.
  // The generic helper permits null for non-replication productions, but
  // absence cannot mean success for a frozen replication run.
  if (socialText(source.creationMode) === 'viral_replication' && content.replicationEvaluation == null)
    failures.push('reference_evaluation_missing');
  if (content.workflowSchema !== 'social-content.auto-production.v3'
    || source.type !== 'actual_social_render' || !socialText(source.runId)
    || !/^[a-f0-9]{64}$/.test(socialText(source.outputSha256))
    || source.outputSha256 !== media.sha256 || !socialText(media.fileId)) failures.push('media_lineage_unverified');
  if (technical.approved !== true || !emptyFailures(technical.failures)
    || report.schemaVersion !== 'initial-scene-quality.v1'
    || visual.passed !== true || !emptyFailures(visual.failures)
    || scenes.passed !== true || !emptyFailures(scenes.issues)
    || !Number.isSafeInteger(scenes.checkedScenes) || Number(scenes.checkedScenes) < 1
    || audio.ok !== true || audio.error !== null
    || render.completed !== true || render.qualityPassed !== true || render.audioDecoded !== true) failures.push('technical_quality_unverified');
  // A later aggregate review cannot erase a defect measured on the frozen film.
  // An unknown probe is not a positive G4 finding; it remains governed by the
  // independent scene/quality admissions rather than being treated as a pass here.
  if (probe.version === 'scene-media-hard-probe.v1') {
    const probedScenes = Array.isArray(probe.scenes) ? probe.scenes.map(object) : [];
    if (probe.formatPassed === false || probe.container === 'unknown'
      || (typeof probe.videoCodec === 'string' && probe.videoCodec !== 'h264')
      || (typeof probe.audioCodec === 'string' && probe.audioCodec !== 'aac')
      || object(probe.captionTimeline).status === 'invalid'
      || object(probe.captionSpeechAlignment).status === 'mismatch'
      || object(probe.fullFrozenAudioIdentity).status === 'failed'
      || hasKnownFinalSensitiveFrameFailure(probe.finalSensitiveFrameAudit, probe.mediaSha256)
      || object(probe.sensitiveFrozenSpeechEvidence).status === 'hit'
      || hasKnownCaptionMaskFailure(probe.captionMaskAudit)
      || hasKnownFinalMediaCoverageFailure(probe.finalPrivacyCoverage)
      || probedScenes.some(scene => scene.durationPassed === false
        || scene.audioWindowDecoded === false
        || object(scene.audioIdentity).status === 'failed'
        || object(scene.sensitiveScreenEvidence).status === 'hit'))
      failures.push('measured_media_hard_failure');
  }
  if (creative.approved !== true || !emptyFailures(creative.failedCriteria)) failures.push('creative_quality_unverified');
  failures.push(...socialReplicationHardQualityFailures(content.replicationEvaluation));
  if (review.automatedChecksPassed !== true || review.technicalChecksPassed !== true
    || review.creativeChecksPassed !== true || delivery.status !== 'publish_candidate'
    || review.state !== 'requires_user_approval') failures.push('review_admission_unverified');
  return failures;
}

export function assertSocialContentGraphQuality(rawContent: unknown): void {
  const failures = socialContentGraphQualityFailures(rawContent);
  if (failures.length) throw new Error(`social_graph_quality_failed:${failures.join(',')}`);
}
