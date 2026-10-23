import type { SocialContentTaskBrief } from '../../shared/contracts/socialContentWorkflow.js';
import { inspectSocialContentReleaseQuality } from './socialContentReleaseQuality.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only the trusted worker can submit evidence for automatic acceptance.
 * Managed creation does not grant permission to publish on any account. */
export function socialManagedArtifactReview(input: {
  tenantId?: string;
  brief: SocialContentTaskBrief;
  trustedAgentOrigin?: boolean;
  origin: string;
  kind: string;
  resourceRef?: string | null;
  content: unknown;
}): { approved: boolean; reason: string } {
  if (input.brief.managementMode !== 'one_click_managed') return { approved: false, reason: 'assisted_review' };
  if (!input.trustedAgentOrigin || input.origin !== 'agent' || input.kind !== 'short_video') {
    return { approved: false, reason: 'trusted_worker_required' };
  }
  const content = object(input.content);
  if (!inspectSocialContentReleaseQuality({ tenantId: input.tenantId, brief: input.brief, content, mode: 'managed' }).approved) {
    return { approved: false, reason: 'release_quality_evidence_incomplete_or_failed' };
  }
  const result = object(content.productionResult);
  const technical = object(result.technicalReview);
  const creative = object(result.creativeReview);
  const render = object(content.render);
  const replication = content.replicationEvaluation == null ? null : object(content.replicationEvaluation);
  const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
  if (content.workflowSchema !== 'social-content.auto-production.v3'
    || !input.resourceRef || result.artifactResourceRef !== input.resourceRef
    || !result.executionPlanReviewId || !result.creativeReviewId
    || technical.approved !== true || !empty(technical.failures)
    || !Number.isInteger(technical.checkedScenes) || Number(technical.checkedScenes) < 1
    || creative.approved !== true || creative.reviewedBy !== 'director_agent' || !empty(creative.failedCriteria)
    || render.completed !== true || render.qualityPassed !== true || render.audioDecoded !== true
    || (replication && replication.status !== 'passed')) {
    return { approved: false, reason: 'automatic_acceptance_evidence_incomplete' };
  }
  return { approved: true, reason: 'technical_and_director_review_passed' };
}
