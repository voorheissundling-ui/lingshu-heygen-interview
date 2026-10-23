import type { DataStore } from '../storage/datastore.js';
import path from 'node:path';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import { tenantAssetRelativePath } from '../lib/assetAccess.js';
import { materialAssetObjectKey } from '../storage/materialAssets.js';
import type { SocialImageCreationTask, SocialImageOutputNode } from '../../shared/contracts/socialImageCreation.js';
import { SOCIAL_IMAGE_TASKS_COLLECTION } from './socialImageTask.js';

type StoredTask = { id: string; tenant_id: string; spec: { socialImageTask?: SocialImageCreationTask } };

/** Generic task PATCH may only append a fresh queued unit, never rewrite receipts. */
export function socialImageQueuedJobIssue(task: SocialImageCreationTask, proposed: SocialImageCreationTask['generationJobs']): string | null {
  if (!Array.isArray(proposed) || proposed.length !== task.generationJobs.length + 1) return 'social_image_job_append_only';
  if (JSON.stringify(proposed.slice(0, -1)) !== JSON.stringify(task.generationJobs)) return 'social_image_job_history_immutable';
  if (task.generationJobs.some(item => ['queued', 'running', 'outcome_unknown'].includes(item.status) && !item.outputNodeIds.length)) return 'social_image_prior_paid_job_unresolved';
  const job = proposed.at(-1)!;
  if (!job.id || !job.idempotencyKey || job.status !== 'queued' || job.attempt !== 0 || job.outputNodeIds.length || job.inputHash
    || job.planVersion !== undefined || job.unitIndex !== undefined || job.plannedInputHash
    || task.generationJobs.some(item => item.id === job.id || item.idempotencyKey === job.idempotencyKey)) return 'social_image_new_job_invalid';
  return null;
}

export class SocialImagePaidJobError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Stable authenticated media path; signed URLs expire and must not enter task history. */
export function socialImageOwnedMaterialUrl(material: MaterialRecord, tenantId: string): string {
  const file = String(material.file || '');
  const objectKey = String(material.objectKey || '');
  if (file && file !== tenantAssetRelativePath(tenantId, path.basename(file))) {
    throw new SocialImagePaidJobError('social_image_material_locator_invalid');
  }
  if (objectKey && objectKey !== materialAssetObjectKey(tenantId, path.basename(objectKey))) {
    throw new SocialImagePaidJobError('social_image_material_locator_invalid');
  }
  if (objectKey) return `/api/overseas/studio/private-assets/materials/${path.basename(objectKey)}`;
  if (file) return `/media/${file}`;
  throw new SocialImagePaidJobError('social_image_material_locator_missing');
}

export async function requireSocialImageAtomicStore(store: DataStore): Promise<void> {
  const supported = store.supportsAtomicCompareAndSwapFor
    ? await store.supportsAtomicCompareAndSwapFor(SOCIAL_IMAGE_TASKS_COLLECTION)
    : await store.supportsAtomicCompareAndSwap?.();
  if (!store.compareAndSwap || supported !== true) {
    throw new SocialImagePaidJobError('social_image_atomic_store_required');
  }
}

async function taskRow(store: DataStore, tenantId: string, taskId: string): Promise<{ row: StoredTask; task: SocialImageCreationTask }> {
  const row = await store.getById<StoredTask>(SOCIAL_IMAGE_TASKS_COLLECTION, taskId);
  const task = row?.spec?.socialImageTask;
  if (!row || row.tenant_id !== tenantId || !task || task.contentMode !== 'image') {
    throw new SocialImagePaidJobError('social_image_task_missing');
  }
  return { row, task };
}

async function saveTask(store: DataStore, row: StoredTask, task: SocialImageCreationTask): Promise<boolean> {
  return store.compareAndSwap!(SOCIAL_IMAGE_TASKS_COLLECTION, row.id,
    { tenant_id: row.tenant_id, spec: row.spec },
    { spec: { ...row.spec, socialImageTask: task }, status: task.status === 'approved' ? 'done' : 'draft', updated_at: task.updatedAt });
}

function advance(task: SocialImageCreationTask, patch: Partial<SocialImageCreationTask>): SocialImageCreationTask {
  return { ...task, ...patch, version: task.version + 1, publishable: false, updatedAt: new Date().toISOString() };
}

/** A paid unit is write-ahead claimed exactly once. No atomic CAS means no call. */
export async function claimSocialImagePaidJob(input: {
  store: DataStore; tenantId: string; taskId: string; jobId: string; idempotencyKey: string; inputHash: string;
}): Promise<SocialImageCreationTask> {
  await requireSocialImageAtomicStore(input.store);
  if (!/^[a-f0-9]{64}$/.test(input.inputHash) || !input.idempotencyKey.trim()) {
    throw new SocialImagePaidJobError('social_image_paid_job_identity_invalid');
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { row, task } = await taskRow(input.store, input.tenantId, input.taskId);
    if (task.imageType === 'carousel' || task.imageType === 'gif_poster') {
      throw new SocialImagePaidJobError('social_image_multi_output_not_ready');
    }
    const job = task.generationJobs.find(item => item.id === input.jobId && item.idempotencyKey === input.idempotencyKey);
    if (!job) throw new SocialImagePaidJobError('social_image_paid_job_missing');
    if (job.status !== 'queued') throw new SocialImagePaidJobError('social_image_paid_job_already_started');
    if (task.generationJobs.some(item => item.id !== job.id && ['queued', 'running', 'outcome_unknown'].includes(item.status) && !item.outputNodeIds.length)) {
      throw new SocialImagePaidJobError('social_image_prior_paid_job_unresolved');
    }
    const next = advance(task, { status: 'generating', step: 'generate', generationJobs: task.generationJobs.map(item =>
      item.id === job.id ? { ...item, status: 'running', inputHash: input.inputHash, attempt: item.attempt + 1, updatedAt: new Date().toISOString() } : item),
    });
    if (await saveTask(input.store, row, next)) return next;
  }
  throw new SocialImagePaidJobError('social_image_paid_job_claim_conflict');
}

/** Associate an already persisted tenant-owned material with the claimed unit. */
export async function completeSocialImagePaidJob(input: {
  store: DataStore; tenantId: string; taskId: string; jobId: string; inputHash: string;
  output: SocialImageOutputNode; provider: string;
}): Promise<SocialImageCreationTask> {
  await requireSocialImageAtomicStore(input.store);
  if (!input.output.materialId || !input.output.mediaUrl) throw new SocialImagePaidJobError('social_image_output_not_durable');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { row, task } = await taskRow(input.store, input.tenantId, input.taskId);
    const job = task.generationJobs.find(item => item.id === input.jobId);
    if (!job || job.inputHash !== input.inputHash) throw new SocialImagePaidJobError('social_image_paid_job_input_changed');
    if (job.planVersion !== undefined) {
      const unit = task.renderPlan?.units.find(item => item.jobId === job.id);
      if (!unit || task.renderPlan?.version !== job.planVersion || unit.index !== job.unitIndex
        || unit.plannedInputHash !== job.plannedInputHash || unit.idempotencyKey !== job.idempotencyKey
        || input.output.role !== unit.role || input.output.label !== unit.label) {
        throw new SocialImagePaidJobError('social_image_planned_unit_output_invalid');
      }
    }
    if (job.outputNodeIds.length) {
      const recorded = task.outputs.find(item => job.outputNodeIds.includes(item.id));
      if (recorded?.materialId === input.output.materialId) return task;
      throw new SocialImagePaidJobError('social_image_paid_job_output_conflict');
    }
    if (!['running', 'outcome_unknown'].includes(job.status)) throw new SocialImagePaidJobError('social_image_paid_job_not_claimed');
    const next = advance(task, {
      status: 'review_required', step: 'review',
      outputs: [...task.outputs.map(item => item.role === input.output.role && item.label === input.output.label
        ? { ...item, state: 'superseded' as const } : item), input.output],
      repairInstructions: task.repairInstructions.map(item => item.status === 'pending'
        ? { ...item, status: 'completed' as const, toVersion: input.output.version } : item),
      generationJobs: task.generationJobs.map(item => item.id === job.id
        ? { ...item, status: 'quality_checking', provider: input.provider, outputNodeIds: [input.output.id], updatedAt: new Date().toISOString() }
        : item),
    });
    if (await saveTask(input.store, row, next)) return next;
  }
  throw new SocialImagePaidJobError('social_image_paid_job_output_conflict');
}

/** Never turn an uncertain provider outcome into a retryable failure. */
export async function markSocialImagePaidJobUnknown(input: {
  store: DataStore; tenantId: string; taskId: string; jobId: string; inputHash: string; error: string;
}): Promise<SocialImageCreationTask> {
  await requireSocialImageAtomicStore(input.store);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { row, task } = await taskRow(input.store, input.tenantId, input.taskId);
    const job = task.generationJobs.find(item => item.id === input.jobId);
    if (!job || job.inputHash !== input.inputHash) throw new SocialImagePaidJobError('social_image_paid_job_input_changed');
    if (job.outputNodeIds.length || job.status === 'outcome_unknown') return task;
    if (job.status !== 'running') throw new SocialImagePaidJobError('social_image_paid_job_not_claimed');
    const next = advance(task, { status: 'blocked', generationJobs: task.generationJobs.map(item =>
      item.id === job.id ? { ...item, status: 'outcome_unknown', error: input.error.slice(0, 500), updatedAt: new Date().toISOString() } : item),
    });
    if (await saveTask(input.store, row, next)) return next;
  }
  throw new SocialImagePaidJobError('social_image_paid_job_unknown_conflict');
}

/** Only call when no paid task was accepted: preflight denial or a definitive provider rejection. */
export async function markSocialImagePaidJobNotSubmitted(input: {
  store: DataStore; tenantId: string; taskId: string; jobId: string; inputHash: string; reason: string;
}): Promise<SocialImageCreationTask> {
  await requireSocialImageAtomicStore(input.store);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { row, task } = await taskRow(input.store, input.tenantId, input.taskId);
    const job = task.generationJobs.find(item => item.id === input.jobId);
    if (!job || job.inputHash !== input.inputHash) throw new SocialImagePaidJobError('social_image_paid_job_input_changed');
    if (job.status === 'failed') return task;
    if (job.status !== 'running' || job.outputNodeIds.length) throw new SocialImagePaidJobError('social_image_paid_job_not_claimed');
    const next = advance(task, { status: 'planned', generationJobs: task.generationJobs.map(item =>
      item.id === job.id ? { ...item, status: 'failed', error: input.reason.slice(0, 500), updatedAt: new Date().toISOString() } : item),
    });
    if (await saveTask(input.store, row, next)) return next;
  }
  throw new SocialImagePaidJobError('social_image_paid_job_release_conflict');
}

/** Preserve uncertainty unless the provider explicitly rejected the request. */
export async function recordSocialImagePaidJobFailure(input: {
  store: DataStore; tenantId: string; taskId: string; jobId: string; inputHash: string;
  error: string; definitiveRejection: boolean;
}): Promise<SocialImageCreationTask> {
  const { definitiveRejection, ...job } = input;
  return definitiveRejection
    ? markSocialImagePaidJobNotSubmitted({ ...job, reason: input.error })
    : markSocialImagePaidJobUnknown(job);
}
