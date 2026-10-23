import type {
  CreateSocialArtifactInput,
  CreateSocialDeliveryPackageInput,
  DecideSocialArtifactBatchInput,
  DecideSocialArtifactInput,
  RegisterSocialPublicationInput,
  SocialContentArtifact,
  SocialContentTaskDetail,
  SocialDeliveryPackage,
  SocialMetricSubmission,
  SocialPublicationRecord,
  SubmitSocialMetricsInput,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import {
  findSocialRecord,
  readSocialTaskDetail,
  requireSocialTask,
  socialArtifact,
  socialDeliveryPackage,
  socialMetricSubmission,
  socialPublication,
  socialTaskReadiness,
  socialTaskSummary,
} from './socialContentRecords.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialPublicId,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';
import { requireOwnedSocialFileRef, type SocialContentBackendFilePort } from './socialContentFiles.js';
import { assertSocialTaskChildCapacity } from './socialContentLimits.js';
import { store } from '../storage/index.js';
import { verifiedStudioGenerationFromSpec } from '../lib/studioGenerationVerification.js';
import {
  readSocialContentSourceCoverage,
  reconcileSocialContentTask,
} from './socialContentProjection.js';
import {
  parseSocialDeliveryManifest,
  type SocialDeliveryManifest,
} from './socialDeliveryArchive.js';
import { resolveSelectedPackages } from './socialWorkPackages.js';
import {
  resolveSocialArtifactMedia,
  socialArtifactMediaDescriptor,
  socialArtifactMediaFamily,
} from './socialArtifactMedia.js';
import type { SocialContentAccessResolver } from './socialContentAccess.js';
import type { Starter198OrchestratorQueuePort } from './runtimePorts.js';
import { startSocialContentTask } from './socialContentTasks.js';

export const OUTPUT_EDITABLE_STATES = new Set(['producing', 'asset_review', 'attention']);
export const MAX_SOCIAL_DELIVERY_MANIFEST_BYTES = 2 * 1024 * 1024;

export async function assertStudioSocialArtifactGeneration(
  tenantId: string,
  kind: string,
  contentValue: unknown,
): Promise<void> {
  const content = socialObject(socialJson(contentValue)) || {};
  if (!/^studio_/i.test(socialText(content.sourceKey))) return;
  const projectId = socialText(content.projectId);
  const expectedKind = kind === 'image_post' ? 'poster' : 'script';
  if (!projectId || socialText(content.generationKind) !== expectedKind) {
    throw new SocialContentWorkflowError('social_artifact_generation_metadata_invalid', 409);
  }
  let project: Record<string, unknown> | null;
  try {
    project = await store.getById<Record<string, unknown>>('studio_projects', projectId);
  } catch {
    throw new SocialContentWorkflowError('social_artifact_generation_verification_unavailable', 503);
  }
  if (!project || socialText(project.tenant_id) !== tenantId) {
    throw new SocialContentWorkflowError('social_artifact_generation_project_not_found', 404);
  }
  if (!verifiedStudioGenerationFromSpec(project.spec, content).ok) {
    throw new SocialContentWorkflowError('social_artifact_generation_unverified', 409);
  }
}

export function nextVersion(value: unknown, code: string): string {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new SocialContentWorkflowError(code, 503);
  return String(parsed + 1);
}

export function assertTaskVersion(record: StarterRecord, expected: string): void {
  if (socialText(record.version) !== expected) {
    throw new SocialContentWorkflowError('social_content_task_version_conflict', 409);
  }
}

export async function byOperation(input: {
  repository: Starter198Repository;
  collection: Parameters<Starter198Repository['list']>[0];
  tenantId: string;
  operationId: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(input.collection, input.tenantId, {
    where: { created_operation_id: input.operationId }, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_output_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

async function hasRevisionReplacement(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  artifactIds: string[];
}): Promise<boolean> {
  const parentIds = new Set(input.artifactIds);
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentArtifacts, input.tenantId, {
    where: { task_id: input.taskId }, sort: 'created_at', perPage: 500,
  });
  if (result.totalItems !== result.items.length) {
    throw new SocialContentWorkflowError('social_content_task_children_truncated', 503);
  }
  return result.items.some(record => parentIds.has(socialText(record.parent_artifact_id))
    && socialText(record.status) !== 'superseded');
}

async function existingRevisionStart(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  idempotencyKey: string;
  taskVersion: string;
}): Promise<{ operationId: string; expectedVersion: string } | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentOperations, input.tenantId, {
    where: { idempotency_key: input.idempotencyKey },
    perPage: 2,
  });
  if (result.totalItems !== result.items.length || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
  }
  const operation = result.items[0];
  if (!operation) return null;
  if (socialText(operation.operation) !== 'start_social_content_task'
    || socialText(operation.target_id) !== input.taskId
    || socialText(operation.created_by) !== input.userId
    || !socialText(operation.operation_id)) {
    throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
  }
  const receipt = socialObject(socialJson(operation.result));
  let expectedVersion = socialText(receipt?.expectedVersion);
  // Processing receipts created before expectedVersion was persisted can be
  // recovered by matching a small bounded window of earlier task versions.
  // Old retry code could add an extra reset version before noticing the
  // processing child operation, so checking only current/current-1 is not
  // sufficient for those already-interrupted records.
  if (!expectedVersion) {
    const current = Number(input.taskVersion);
    const candidates = Number.isSafeInteger(current) && current > 0
      ? Array.from({ length: Math.min(current, 32) }, (_, index) => String(current - index))
      : [];
    expectedVersion = candidates.find(candidate => socialRequestHash({ expectedVersion: candidate })
      === socialText(operation.request_hash)) ?? '';
  }
  if (!expectedVersion
    || socialRequestHash({ expectedVersion }) !== socialText(operation.request_hash)) {
    throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
  }
  return { operationId: socialText(operation.operation_id), expectedVersion };
}

/**
 * Turn an accepted review rejection into a fresh automatic production run.
 * The outer decision receipt remains the audit authority; this deterministic
 * nested start receipt makes recovery safe if the process stops between the
 * artifact decision, task reset and queue admission.
 */
export async function scheduleSocialArtifactRevision(input: {
  repository: Starter198Repository;
  orchestratorQueue?: Starter198OrchestratorQueuePort;
  tenantId: string;
  userId: string;
  taskId: string;
  idempotencyKey: string;
  operationId: string;
  artifactIds: string[];
  now?: Date;
}): Promise<SocialContentTaskDetail> {
  if (!input.orchestratorQueue) {
    throw new SocialContentWorkflowError('social_content_orchestrator_not_configured', 503);
  }
  if (await hasRevisionReplacement(input)) {
    const completed = await readSocialTaskDetail(input);
    if (!completed) throw new SocialContentWorkflowError('social_content_task_not_found', 404);
    return completed;
  }
  let task = await requireSocialTask(input);
  // A prior recovery may already have admitted this exact revision. Never
  // create a second run while its worker is active.
  if (socialText(task.status) === 'producing' && socialText(task.run_id)) {
    const running = await readSocialTaskDetail(input);
    if (!running) throw new SocialContentWorkflowError('social_content_task_not_found', 404);
    return running;
  }
  const resetMarker = `${input.operationId}:revision-ready`;
  const startIdempotencyKey = `social-revision-start:${input.operationId}`;
  const priorStart = await existingRevisionStart({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.taskId,
    idempotencyKey: startIdempotencyKey,
    taskVersion: socialText(task.version),
  });
  if (!priorStart && socialText(task.last_operation_id) !== resetMarker) {
    if (!['asset_review', 'attention', 'paused'].includes(socialText(task.status))) {
      throw new SocialContentWorkflowError('social_content_revision_not_startable', 409);
    }
    await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, task.id, {
      status: 'attention',
      run_id: '',
      orchestrator_item_id: '',
      version: nextVersion(task.version, 'social_content_task_record_invalid'),
      last_operation_id: resetMarker,
      updated_by: input.userId,
      updated_at: (input.now ?? new Date()).toISOString(),
    });
    task = await requireSocialTask(input);
  }
  if (priorStart
    && ![resetMarker, `${priorStart.operationId}:prestart`, priorStart.operationId]
      .includes(socialText(task.last_operation_id))) {
    throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
  }
  return startSocialContentTask({
    repository: input.repository,
    orchestratorQueue: input.orchestratorQueue,
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.taskId,
    expectedVersion: priorStart?.expectedVersion ?? socialText(task.version),
    idempotencyKey: startIdempotencyKey,
    now: input.now,
  });
}
