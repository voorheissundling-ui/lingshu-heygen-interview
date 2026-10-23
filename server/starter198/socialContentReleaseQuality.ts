import type { SocialContentTaskBrief } from '../../shared/contracts/socialContentWorkflow.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonempty = (value: unknown) => Array.isArray(value) && value.length > 0;

export interface SocialContentReleaseQualityInput {
  tenantId?: string;
  brief: SocialContentTaskBrief;
  content: unknown;
  mode: 'human' | 'managed';
}

/** Human review may judge subjective fidelity, never missing identity, rights,
 * enterprise-fact, timeline, technical or budget evidence. */
export function inspectSocialContentReleaseQuality(input: SocialContentReleaseQualityInput): {
  approved: boolean; applicable: boolean; failures: string[];
} {
  const content = object(input.content);
  const applicable = content.workflowSchema === 'social-content.auto-production.v3'
    && input.brief.referenceMode === 'single_source_fidelity';
  if (!applicable) return { approved: true, applicable: false, failures: [] };
  const failures: string[] = [];
  const result = object(content.productionResult), technical = object(result.technicalReview);
  const creative = object(result.creativeReview), render = object(content.render);
  if (technical.approved === false || nonempty(technical.failures)
    || render.qualityPassed === false || render.audioDecoded === false || render.completed === false) failures.push('technical_failed');
  if (nonempty(creative.failedCriteria)) failures.push('creative_failed');
  if (!Object.keys(technical).length || !Object.keys(creative).length) failures.push('quality_evidence_missing');
  const replication = object(content.replicationEvaluation);
  if (!['passed', 'review_required'].includes(String(replication.status))
    || !['passed', 'review_required'].includes(String(object(replication.viralFactorFidelity).status)))
    failures.push('reference_fidelity_evidence_missing_or_failed');
  const timeline = object(replication.referenceTimelineAudit);
  if (timeline.fullCoverageValidated !== true || !Number.isInteger(timeline.referenceShotCount)
    || Number(timeline.referenceShotCount) < 1 || timeline.outputShotCount !== timeline.referenceShotCount
    || !amount(timeline.referenceDurationSeconds) || timeline.referenceDurationSeconds <= 0) failures.push('reference_timeline_incomplete');
  const dimensions = ['viralFactorFidelity', 'identityReplacement', 'originalityDifference', 'unauthorizedReuseRisk', 'accountAndFactFit'];
  if (!['passed', 'not_applicable'].includes(String(object(replication.identityReplacement).status))) failures.push('identity_evidence_incomplete');
  if (['originalityDifference', 'unauthorizedReuseRisk', 'accountAndFactFit']
    .some(key => !['passed', 'not_applicable'].includes(String(object(replication[key]).status))))
    failures.push('rights_or_enterprise_fact_evidence_incomplete');
  if (dimensions.some(key => !['passed', 'not_applicable', 'review_required', 'failed'].includes(String(object(replication[key]).status)))) failures.push('replication_evidence_missing');
  if (dimensions.some(key => object(replication[key]).status === 'failed')
    || object(replication.directorDecision).status === 'changes_required'
    || nonempty(object(replication.directorDecision).failedCriteria)) failures.push('replication_failed');
  const cost = object(content.costSummary), limit = input.brief.perItemBudgetCny;
  const internalBudgetExempt = isInternalBudgetExemptTenant(input.tenantId);
  const estimated = cost.estimatedBeforeGenerationCny;
  const recorded = [cost.recordedProviderCostCny, cost.recordedProviderEstimatedCostCny].filter(amount);
  const invalidRecorded = [cost.recordedProviderCostCny, cost.recordedProviderEstimatedCostCny]
    .some(value => value != null && !amount(value));
  if ((!internalBudgetExempt && !amount(limit)) || !amount(estimated) || !recorded.length || invalidRecorded || cost.currency !== 'CNY') failures.push('budget_evidence_missing');
  else if (!internalBudgetExempt && amount(limit)
    && [estimated, ...recorded].some(value => value > limit + 1e-6)) failures.push('budget_exceeded');
  if (input.mode === 'managed' && (technical.approved !== true || creative.approved !== true
    || render.completed !== true || render.qualityPassed !== true || render.audioDecoded !== true
    || replication.status !== 'passed'
    || dimensions.some(key => !['passed', 'not_applicable'].includes(String(object(replication[key]).status))))) failures.push('managed_quality_incomplete');
  return { approved: failures.length === 0, applicable: true, failures };
}

export function assertSocialContentReleaseQuality(input: SocialContentReleaseQualityInput): void {
  const review = inspectSocialContentReleaseQuality(input);
  if (!review.approved) throw new Error(`social_artifact_release_quality_failed:${review.failures.join(',')}`);
}
