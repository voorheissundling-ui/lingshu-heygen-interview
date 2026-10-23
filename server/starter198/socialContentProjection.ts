import {
  SOCIAL_CONTENT_TASK_STATUSES,
  type SocialContentTaskStatus,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { parseSocialTaskBrief, parseSocialTaskThemeSelection, requireSocialTask, socialTaskReadiness, socialTaskSource } from './socialContentRecords.js';
import { SocialContentWorkflowError, socialText } from './socialContentValidation.js';
import {
  advisoryMaterialRequirements,
  materialReadiness,
  parseStoredMaterialRequirements,
  recomputeMaterialRequirements,
} from './socialContentThemes.js';

const PROGRESS_RANK: Partial<Record<SocialContentTaskStatus, number>> = {
  draft: 0,
  needs_input: 0,
  plan_review: 1,
  producing: 2,
  asset_review: 3,
  packaging: 4,
  delivered: 5,
  awaiting_publish: 6,
  awaiting_metrics: 7,
  reviewed: 8,
};

async function count(input: {
  repository: Starter198Repository;
  tenantId: string;
  collection: Parameters<Starter198Repository['list']>[0];
  where: Record<string, string | number | boolean>;
}): Promise<number> {
  const result = await input.repository.list(input.collection, input.tenantId, {
    where: input.where,
    page: 1,
    perPage: 1,
  });
  if (!Number.isSafeInteger(result.totalItems) || result.totalItems < 0) {
    throw new SocialContentWorkflowError('social_content_projection_integrity_violation', 503);
  }
  return result.totalItems;
}

function laterStatus(current: SocialContentTaskStatus, candidate: SocialContentTaskStatus): SocialContentTaskStatus {
  const currentRank = PROGRESS_RANK[current];
  const candidateRank = PROGRESS_RANK[candidate];
  if (currentRank === undefined || candidateRank === undefined) return candidate;
  return currentRank >= candidateRank ? current : candidate;
}

function nextVersion(task: StarterRecord): string {
  const current = Number(task.version);
  if (!Number.isSafeInteger(current) || current < 1) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  return String(current + 1);
}

export async function readSocialContentSourceCoverage(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
}): Promise<{ total: number; knowledge: number; material: number }> {
  const where = { task_id: input.taskId, status: 'active' };
  const [total, knowledge, materials] = await Promise.all([
    count({ ...input, collection: STARTER_COLLECTIONS.socialTaskSources, where }),
    count({ ...input, collection: STARTER_COLLECTIONS.socialTaskSources, where: { ...where, source_kind: 'knowledge' } }),
    count({ ...input, collection: STARTER_COLLECTIONS.socialTaskSources, where: { ...where, source_kind: 'material' } }),
  ]);
  // A text_note is user-authored task context, not authenticated enterprise
  // knowledge and not source material. It remains in total for lineage/capacity,
  // but must never make either readiness gate pass.
  // Reference links may guide writing, but they are not production-ready
  // source material and cannot unlock content generation by themselves.
  const coverage = { total, knowledge, material: materials };
  if (coverage.total < coverage.knowledge + coverage.material) {
    throw new SocialContentWorkflowError('social_content_projection_integrity_violation', 503);
  }
  return coverage;
}

/**
 * Repair denormalized task counters from immutable child rows. This is called
 * both on the first write and during recovery, so A → B → replay(A) can never
 * increment a counter twice or regress a later workflow status.
 */
export async function reconcileSocialContentTask(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  userId: string;
  operationId: string;
  preferredStatus?: SocialContentTaskStatus;
  enforceReadiness?: boolean;
  now?: Date;
}): Promise<StarterRecord> {
  const task = await requireSocialTask(input);
  const where = { task_id: input.taskId };
  const [
    coverage,
    sourceRows,
    artifactRows,
    approvedArtifactCount,
    deliveryPackageCount,
    publicationCount,
    metricSubmissionCount,
  ] = await Promise.all([
    readSocialContentSourceCoverage(input),
    input.repository.list(STARTER_COLLECTIONS.socialTaskSources, input.tenantId, {
      where: { ...where, status: 'active' }, sort: 'created_at', perPage: 500,
    }),
    input.repository.list(STARTER_COLLECTIONS.socialContentArtifacts, input.tenantId, {
      where, sort: 'created_at', perPage: 500,
    }),
    count({ ...input, collection: STARTER_COLLECTIONS.socialContentArtifacts, where: { ...where, status: 'approved' } }),
    count({ ...input, collection: STARTER_COLLECTIONS.socialDeliveryPackages, where }),
    count({ ...input, collection: STARTER_COLLECTIONS.socialPublications, where }),
    count({ ...input, collection: STARTER_COLLECTIONS.socialMetricSubmissions, where }),
  ]);
  const brief = parseSocialTaskBrief(task.brief);
  if (sourceRows.totalItems !== sourceRows.items.length) {
    throw new SocialContentWorkflowError('social_content_task_children_truncated', 503);
  }
  if (artifactRows.totalItems !== artifactRows.items.length) {
    throw new SocialContentWorkflowError('social_content_task_children_truncated', 503);
  }
  const artifactCount = artifactRows.totalItems;
  const actionableArtifactCount = artifactRows.items.filter(item => (
    !['changes_requested', 'superseded'].includes(socialText(item.status))
  )).length;
  const currentRequirements = parseStoredMaterialRequirements(task.material_requirements);
  const advisoryRequirements = advisoryMaterialRequirements(currentRequirements);
  const recalculatedRequirements = advisoryRequirements.length
    ? recomputeMaterialRequirements(advisoryRequirements, sourceRows.items.map(socialTaskSource), (input.now ?? new Date()).toISOString())
    : advisoryRequirements;
  const requirementState = (items: typeof currentRequirements) => items.map(item => ({
    requirementId: item.requirementId,
    required: item.required,
    status: item.status,
    matchedSourceIds: item.matchedSourceIds,
    confidence: item.confidence,
    reason: item.reason,
    ruleVersion: item.ruleVersion,
  }));
  const requirementsChanged = JSON.stringify(requirementState(currentRequirements)) !== JSON.stringify(requirementState(recalculatedRequirements));
  const nextRequirements = requirementsChanged ? recalculatedRequirements : currentRequirements;
  const theme = parseSocialTaskThemeSelection(task.theme_selection);
  const currentStatus = socialText(task.status) as SocialContentTaskStatus;
  if (!SOCIAL_CONTENT_TASK_STATUSES.includes(currentStatus)) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  const readiness = socialTaskReadiness(brief, coverage, theme ? {
    theme,
    materialReadiness: materialReadiness(nextRequirements),
  } : undefined);
  let status = currentStatus;
  if (currentStatus === 'cancelling' || currentStatus === 'cancelled') {
    // Re-reading historical artifacts or missing inputs must never resurrect cancelled work.
    status = currentStatus;
  } else if (input.enforceReadiness && !readiness.complete) {
    status = 'needs_input';
  } else {
    let candidate = input.preferredStatus;
    if (publicationCount > 0) candidate = 'awaiting_metrics';
    else if (deliveryPackageCount > 0) candidate = 'delivered';
    else if (actionableArtifactCount > 0) candidate = 'asset_review';
    else if (readiness.complete && ['draft', 'needs_input'].includes(status)) candidate = 'plan_review';
    if (candidate) status = laterStatus(status, candidate);
  }
  const projection = {
    source_count: coverage.total,
    knowledge_source_count: coverage.knowledge,
    material_source_count: coverage.material,
    artifact_count: artifactCount,
    approved_artifact_count: approvedArtifactCount,
    delivery_package_count: deliveryPackageCount,
    publication_count: publicationCount,
    metric_submission_count: metricSubmissionCount,
    status,
    ...(requirementsChanged ? { material_requirements: nextRequirements } : {}),
  };
  const changed = requirementsChanged || Object.entries(projection)
    .filter(([key]) => key !== 'material_requirements')
    .some(([key, value]) => String(task[key] ?? '') !== String(value));
  if (!changed) return task;
  await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, task.id, {
    ...projection,
    version: nextVersion(task),
    last_operation_id: input.operationId,
    updated_by: input.userId,
    updated_at: (input.now ?? new Date()).toISOString(),
  });
  return requireSocialTask(input);
}
