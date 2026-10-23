import { randomUUID } from 'node:crypto';
import { acquireDurableOperationLease, releaseDurableOperationLease, type DurableOperationLease } from '../runtime/durableLease.js';
import type { Starter198Repository } from './repository.js';
import { SocialContentWorkflowError } from './socialContentValidation.js';

export const MAX_CONCURRENT_SOCIAL_CONTENT_UPLOADS = 16;
const UPLOAD_POOL_TENANT = 'starter198-social-upload-pool';

async function acquireUploadLease(input: {
  repository: Starter198Repository;
  tenantId: string;
  scope: string;
  subjectId: string;
  ownerId: string;
}): Promise<DurableOperationLease | null> {
  if (!input.repository.dataStore) {
    if (process.env.NODE_ENV === 'production') {
      throw new SocialContentWorkflowError('social_content_upload_admission_unavailable', 503);
    }
    return null;
  }
  try {
    return await acquireDurableOperationLease({
      dataStore: input.repository.dataStore,
      tenantId: input.tenantId,
      scope: input.scope,
      subjectId: input.subjectId,
      ownerId: input.ownerId,
      leaseDurationMs: 15 * 60_000,
    });
  } catch {
    throw new SocialContentWorkflowError('social_content_upload_admission_unavailable', 503);
  }
}

/** Database-backed admission protects every process, not just one Node worker. */
export async function withSocialContentUploadAdmission<T>(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  action: () => Promise<T>;
}): Promise<T> {
  if (!input.repository.dataStore) {
    if (process.env.NODE_ENV === 'production') {
      throw new SocialContentWorkflowError('social_content_upload_admission_unavailable', 503);
    }
    return input.action();
  }
  const ownerId = `social-upload:${process.pid}:${randomUUID()}`;
  let poolLease: DurableOperationLease | null = null;
  let taskLease: DurableOperationLease | null = null;
  try {
    for (let index = 0; index < MAX_CONCURRENT_SOCIAL_CONTENT_UPLOADS; index += 1) {
      poolLease = await acquireUploadLease({
        repository: input.repository,
        tenantId: UPLOAD_POOL_TENANT,
        scope: 'starter-social-upload-pool',
        subjectId: `slot-${index}`,
        ownerId,
      });
      if (poolLease) break;
    }
    if (!poolLease) throw new SocialContentWorkflowError('social_content_upload_busy', 429);
    taskLease = await acquireUploadLease({
      repository: input.repository,
      tenantId: input.tenantId,
      scope: 'starter-social-upload-task',
      subjectId: input.taskId,
      ownerId,
    });
    if (!taskLease) throw new SocialContentWorkflowError('social_content_task_upload_busy', 429);
    return await input.action();
  } finally {
    if (taskLease) await releaseDurableOperationLease({ dataStore: input.repository.dataStore, lease: taskLease }).catch(() => undefined);
    if (poolLease) await releaseDurableOperationLease({ dataStore: input.repository.dataStore, lease: poolLease }).catch(() => undefined);
  }
}
