import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  acquireDurableOperationLease,
  assertDurableOperationLease,
  releaseDurableOperationLease,
  type DurableOperationLease,
} from '../runtime/durableLease.js';
import type { DataStore } from '../storage/datastore.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialPublicId,
  socialText,
} from './socialContentValidation.js';

type OperationRecord = StarterRecord & {
  operation_id?: unknown;
  idempotency_key?: unknown;
  request_hash?: unknown;
  operation?: unknown;
  target_id?: unknown;
  status?: unknown;
  result?: unknown;
  error_code?: unknown;
  http_status?: unknown;
};

interface HeldMutationScope {
  lease: DurableOperationLease | null;
  dataStore: DataStore | undefined;
}

const heldMutationScopes = new AsyncLocalStorage<ReadonlyMap<string, HeldMutationScope>>();

/**
 * Start deferred work without inheriting a request's subject lease. AsyncLocalStorage
 * otherwise carries the already-released lease into setImmediate/Promise callbacks,
 * causing the background worker to mistake it for a live nested mutation.
 */
export function runOutsideSocialContentMutationScope<T>(action: () => T): T {
  return heldMutationScopes.run(new Map<string, HeldMutationScope>(), action);
}

function mutationScopeKey(tenantId: string, subjectId: string): string {
  return JSON.stringify([tenantId, subjectId]);
}

async function operationByKey(
  repository: Starter198Repository,
  tenantId: string,
  idempotencyKey: string,
): Promise<OperationRecord | null> {
  const result = await repository.list(STARTER_COLLECTIONS.socialContentOperations, tenantId, {
    where: { idempotency_key: idempotencyKey },
    perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
  }
  return result.items[0] as OperationRecord | undefined ?? null;
}

function validateReplay(record: OperationRecord, input: {
  requestHash: string;
  operation: string;
  targetId: string;
}): void {
  if (socialText(record.request_hash) !== input.requestHash
    || socialText(record.operation) !== input.operation
    || socialText(record.target_id) !== input.targetId) {
    throw new SocialContentWorkflowError('social_content_idempotency_conflict', 409);
  }
}

function assertCompletedReceipt(record: OperationRecord): boolean {
  if (socialText(record.status) !== 'succeeded') return false;
  const parsed = socialJson(record.result);
  const receipt = socialObject(parsed);
  if (!receipt
    || receipt.schemaVersion !== 'social-content.operation-result.v1'
    || socialText(receipt.operationId) !== socialText(record.operation_id)
    || socialText(receipt.targetId) !== socialText(record.target_id)) {
    throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
  }
  return true;
}

function repeatedFailure(record: OperationRecord): never {
  const status = Number(record.http_status);
  const code = socialText(record.error_code);
  throw new SocialContentWorkflowError(
    code || 'social_content_operation_failed',
    Number.isInteger(status) && status >= 400 && status <= 599 ? status : 409,
  );
}

async function acquireMutationLease(input: {
  repository: Starter198Repository;
  tenantId: string;
  subjectId: string;
}) {
  if (!input.repository.dataStore) {
    if (process.env.NODE_ENV === 'production') {
      throw new SocialContentWorkflowError('social_content_mutation_unavailable', 503);
    }
    return null;
  }
  try {
    const lease = await acquireDurableOperationLease({
      dataStore: input.repository.dataStore,
      tenantId: input.tenantId,
      scope: 'starter-social-content',
      subjectId: input.subjectId,
      ownerId: `social-content:${process.pid}:${randomUUID()}`,
      leaseDurationMs: 5 * 60_000,
    });
    if (!lease) throw new SocialContentWorkflowError('social_content_mutation_busy', 409);
    await assertDurableOperationLease({ dataStore: input.repository.dataStore, lease, minimumRemainingMs: 1_000 });
    return lease;
  } catch (error) {
    if (error instanceof SocialContentWorkflowError) throw error;
    throw new SocialContentWorkflowError('social_content_mutation_unavailable', 503);
  }
}

/**
 * Serializes every mutation of one social-content subject across processes.
 * Nested scheduling work for the same subject reuses the lease already held by
 * executeSocialContentMutation, so the durable task marker and operation receipt
 * form one recoverable protocol without deadlocking on a second lease claim.
 */
export async function withSocialContentSubjectLease<T>(input: {
  repository: Starter198Repository;
  tenantId: string;
  subjectId: string;
  action: () => Promise<T>;
}): Promise<T> {
  const scopeKey = mutationScopeKey(input.tenantId, input.subjectId);
  const current = heldMutationScopes.getStore()?.get(scopeKey);
  if (current) {
    if (current.dataStore !== input.repository.dataStore) {
      throw new SocialContentWorkflowError('social_content_mutation_unavailable', 503);
    }
    return input.action();
  }
  const lease = await acquireMutationLease(input);
  try {
    const inherited = heldMutationScopes.getStore() ?? new Map<string, HeldMutationScope>();
    return await heldMutationScopes.run(new Map([
      ...inherited,
      [scopeKey, { lease, dataStore: input.repository.dataStore }],
    ]), input.action);
  } finally {
    if (lease && input.repository.dataStore) {
      await releaseDurableOperationLease({ dataStore: input.repository.dataStore, lease }).catch(() => undefined);
    }
  }
}

/** Re-check the exact immutable lease generation immediately before a commit. */
export async function assertSocialContentSubjectLease(input: {
  repository: Starter198Repository;
  tenantId: string;
  subjectId: string;
}): Promise<void> {
  const scopeKey = mutationScopeKey(input.tenantId, input.subjectId);
  const scopes = heldMutationScopes.getStore();
  if (!scopes?.has(scopeKey)) {
    throw new SocialContentWorkflowError('social_content_mutation_unavailable', 503);
  }
  const held = scopes.get(scopeKey);
  if (!held || held.dataStore !== input.repository.dataStore) {
    throw new SocialContentWorkflowError('social_content_mutation_unavailable', 503);
  }
  const lease = held.lease;
  if (!lease || !held.dataStore) {
    if (process.env.NODE_ENV === 'production') {
      throw new SocialContentWorkflowError('social_content_mutation_unavailable', 503);
    }
    return;
  }
  try {
    await assertDurableOperationLease({
      dataStore: held.dataStore,
      lease,
      minimumRemainingMs: 1_000,
    });
  } catch {
    throw new SocialContentWorkflowError('social_content_mutation_unavailable', 503);
  }
}

/**
 * Execute an idempotent mutation behind the cross-process database lease. The
 * operation row is the replay authority; domain actions additionally persist
 * the operation id on changed records so an interrupted finalization can be
 * recovered without applying a mutation twice.
 */
export async function executeSocialContentMutation<T extends Record<string, unknown>>(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  idempotencyKey: string;
  requestHash: string;
  operation: string;
  targetId: string;
  /** Minimal immutable data needed to resume a processing operation safely. */
  processingReceipt?: Record<string, unknown>;
  action: (operationId: string, recovering: boolean) => Promise<T>;
  /** Rebuild a replay response from canonical domain records, never an expanding audit blob. */
  replay: (operationId: string) => Promise<T>;
  now?: Date;
}): Promise<{ value: T; repeated: boolean }> {
  return withSocialContentSubjectLease({
    repository: input.repository,
    tenantId: input.tenantId,
    subjectId: input.targetId || input.idempotencyKey,
    action: async () => {
      let record = await operationByKey(input.repository, input.tenantId, input.idempotencyKey);
      if (record) {
        validateReplay(record, input);
        if (assertCompletedReceipt(record)) {
          return { value: await input.replay(socialText(record.operation_id)), repeated: true };
        }
        if (socialText(record.status) === 'failed') repeatedFailure(record);
        if (socialText(record.status) !== 'processing' || !socialText(record.operation_id)) {
          throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
        }
      } else {
        const timestamp = (input.now ?? new Date()).toISOString();
        const operationId = socialPublicId('socialop');
        try {
          record = await input.repository.create(STARTER_COLLECTIONS.socialContentOperations, input.tenantId, {
            operation_id: operationId,
            idempotency_key: input.idempotencyKey,
            request_hash: input.requestHash,
            operation: input.operation,
            target_id: input.targetId,
            status: 'processing',
            // PocketBase treats an empty object as blank for a required JSON
            // field. Persist a non-empty processing receipt so the first real
            // mutation can be created instead of failing before domain work.
            result: {
              ...(input.processingReceipt ?? {}),
              schemaVersion: 'social-content.operation-processing.v1',
              operationId,
              targetId: input.targetId,
            },
            error_code: '',
            http_status: 0,
            created_by: input.userId,
            created_at: timestamp,
            updated_at: timestamp,
          });
        } catch {
          record = await operationByKey(input.repository, input.tenantId, input.idempotencyKey);
          if (!record) throw new SocialContentWorkflowError('social_content_operation_unavailable', 503);
          validateReplay(record, input);
          if (assertCompletedReceipt(record)) {
            return { value: await input.replay(socialText(record.operation_id)), repeated: true };
          }
        }
      }

      if (socialText(record.status) === 'failed') repeatedFailure(record);
      if (socialText(record.status) !== 'processing' || !socialText(record.operation_id)) {
        throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
      }
      const operationId = socialText(record.operation_id);
      try {
        const value = await input.action(operationId, socialText(record.status) === 'processing');
        await assertSocialContentSubjectLease({
          repository: input.repository,
          tenantId: input.tenantId,
          subjectId: input.targetId || input.idempotencyKey,
        });
        const updatedAt = (input.now ?? new Date()).toISOString();
        await input.repository.update(STARTER_COLLECTIONS.socialContentOperations, input.tenantId, record.id, {
          status: 'succeeded',
          result: {
            schemaVersion: 'social-content.operation-result.v1',
            operationId,
            targetId: input.targetId,
          },
          http_status: 200,
          error_code: '',
          updated_at: updatedAt,
        });
        return { value, repeated: false };
      } catch (error) {
        if (error instanceof SocialContentWorkflowError && error.status < 500) {
          await input.repository.update(STARTER_COLLECTIONS.socialContentOperations, input.tenantId, record.id, {
            status: 'failed',
            error_code: error.code,
            http_status: error.status,
            updated_at: (input.now ?? new Date()).toISOString(),
          }).catch(() => undefined);
        }
        throw error;
      }
    },
  });
}
