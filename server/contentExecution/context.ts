import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DataStore } from '../storage/datastore.js';
import {
  acquireDurableOperationLease,
  releaseDurableOperationLease,
  type DurableOperationLease,
} from '../runtime/durableLease.js';

export const CONTENT_EXECUTION_JOB_COLLECTION = 'content_execution_jobs';

export type ContentProviderReceiptState =
  | 'submitting'
  | 'accepted'
  | 'completed'
  | 'failed'
  | 'unknown';

export interface ContentProviderReceipt {
  provider: string;
  requestId: string;
  state: ContentProviderReceiptState;
  providerTaskId: string | null;
  metadata: Record<string, unknown>;
  firstRecordedAt: string;
  updatedAt: string;
}

function mergeReceiptState(
  previous: ContentProviderReceiptState | undefined,
  next: ContentProviderReceiptState,
): ContentProviderReceiptState {
  if (!previous) return next;
  if (previous === 'completed' || next === 'completed') return 'completed';
  if (previous === 'failed') return 'failed';
  if (next === 'failed') return 'failed';
  if (previous === 'accepted' && next === 'submitting') return 'accepted';
  if (previous === 'unknown' && next === 'submitting') return 'unknown';
  return next;
}

async function acquireReceiptWriteLease(input: {
  current: ContentExecutionContextValue;
  tenantId: string;
  provider: string;
  requestId: string;
}): Promise<DurableOperationLease> {
  const subjectId = createHash('sha256')
    .update(`${input.current.jobId}\0${input.provider}\0${input.requestId}`)
    .digest('hex');
  const ownerId = `receipt-${process.pid}-${randomUUID()}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const lease = await acquireDurableOperationLease({
      dataStore: input.current.dataStore,
      tenantId: input.tenantId,
      scope: 'content_provider_receipt',
      subjectId,
      ownerId,
      leaseDurationMs: 30_000,
      reclaimGraceMs: 5_000,
    });
    if (lease) return lease;
    await delay(Math.min(250, 20 + attempt * 10));
  }
  throw new Error('content_provider_receipt_write_busy');
}

export interface ContentExecutionCheckpoint<T = unknown> {
  version: string;
  inputHash: string;
  payload: T;
  updatedAt: string;
}

export type ContentExecutionCheckpoints = Record<string, ContentExecutionCheckpoint>;

interface ContentExecutionContextValue {
  dataStore: DataStore;
  jobId: string;
  expectedWorkerId: string | null;
  expectedAttempt: number | null;
  executionStillOwned: (() => boolean) | null;
  receipts: ContentProviderReceipt[];
  checkpoints: ContentExecutionCheckpoints;
  writeChain: Promise<void>;
}

const executionContext = new AsyncLocalStorage<ContentExecutionContextValue>();

function compact(value: unknown, max = 240): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) throw new Error('content_provider_receipt_metadata_too_large');
  return JSON.parse(serialized) as Record<string, unknown>;
}

function checkpointKey(value: unknown): string {
  const key = compact(value, 80);
  if (!/^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(key)) {
    throw new Error('content_execution_checkpoint_key_invalid');
  }
  return key;
}

function safeCheckpointPayload<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('content_execution_checkpoint_payload_invalid');
  // A frozen 37-shot social executor binding contains the reviewed director
  // plan, per-shot candidates and supply contract. Keep one checkpoint within
  // the same durable 4 MiB envelope enforced for the complete checkpoint map.
  if (Buffer.byteLength(serialized, 'utf8') > 4_194_304) {
    throw new Error('content_execution_checkpoint_payload_too_large');
  }
  return JSON.parse(serialized) as T;
}

export function parseContentExecutionCheckpoints(value: unknown): ContentExecutionCheckpoints {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const checkpoints: ContentExecutionCheckpoints = {};
  for (const [rawKey, item] of Object.entries(value)) {
    let key: string;
    try { key = checkpointKey(rawKey); }
    catch { continue; }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const version = compact(row.version, 40);
    const inputHash = compact(row.inputHash, 240);
    const updatedAt = compact(row.updatedAt, 40);
    if (!version || !inputHash || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) continue;
    try {
      checkpoints[key] = {
        version,
        inputHash,
        payload: safeCheckpointPayload(row.payload),
        updatedAt: new Date(updatedAt).toISOString(),
      };
    } catch {
      // A corrupt/oversized checkpoint must never prevent the durable job from
      // being claimed. The stage will be recomputed and replace it.
    }
  }
  return checkpoints;
}

export function parseContentProviderReceipts(value: unknown): ContentProviderReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const provider = compact(row.provider, 80);
    const requestId = compact(row.requestId, 240);
    const state = compact(row.state, 20) as ContentProviderReceiptState;
    if (!provider || !requestId || !['submitting', 'accepted', 'completed', 'failed', 'unknown'].includes(state)) return [];
    return [{
      provider,
      requestId,
      state,
      providerTaskId: compact(row.providerTaskId, 240) || null,
      metadata: safeMetadata(row.metadata),
      firstRecordedAt: compact(row.firstRecordedAt, 40) || new Date(0).toISOString(),
      updatedAt: compact(row.updatedAt, 40) || new Date(0).toISOString(),
    }];
  });
}

export async function runWithContentExecutionContext<T>(input: {
  dataStore: DataStore;
  jobId: string;
  providerReceipts?: unknown;
  checkpoints?: unknown;
  expectedWorkerId?: string;
  expectedAttempt?: number;
  executionStillOwned?: () => boolean;
  action: () => Promise<T>;
}): Promise<T> {
  const value: ContentExecutionContextValue = {
    dataStore: input.dataStore,
    jobId: input.jobId,
    expectedWorkerId: compact(input.expectedWorkerId, 240) || null,
    expectedAttempt: Number.isSafeInteger(input.expectedAttempt) ? Number(input.expectedAttempt) : null,
    executionStillOwned: input.executionStillOwned ?? null,
    receipts: parseContentProviderReceipts(input.providerReceipts),
    checkpoints: parseContentExecutionCheckpoints(input.checkpoints),
    writeChain: Promise.resolve(),
  };
  return executionContext.run(value, input.action);
}

export class ContentExecutionStoppedError extends Error {
  readonly code = 'content_execution_stopped';
  constructor() { super('content_execution_stopped:任务已暂停或撤回，不再提交新的生产工作'); }
}

/** Root order fence also applies to a completed original with active repairs.
 * Call only before new work, never before saving an already-issued receipt. */
export async function assertSocialContentOrderActive(dataStore: DataStore, tenantId: string, taskId: string): Promise<void> {
  const parse = (value: unknown): Record<string, unknown> | null => {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw new ContentExecutionStoppedError(); } }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  };
  const read = async (id: string) => {
    const rows = await dataStore.list<Record<string, unknown>>('starter_social_content_tasks', { where: { tenant_id: tenantId, task_id: id }, perPage: 2 });
    if (rows.totalItems > 1) throw new ContentExecutionStoppedError();
    return rows.items[0];
  };
  const stopped = (row: Record<string, unknown> | undefined, binding: Record<string, unknown> | null) => {
    if (binding?.cancellation || binding?.replacedByContentId || binding?.supersededByContentId || ['cancelled', 'cancelling'].includes(String(row?.status)))
      throw new ContentExecutionStoppedError();
  };
  const row = await read(taskId), binding = parse(row?.content_order);
  stopped(row, binding);
  if (binding?.contentId && binding.contentId !== taskId) {
    const root = await read(String(binding.contentId)), order = parse(root?.content_order);
    if (!root || !order || order.contentId !== binding.contentId || order.budgetTaskId !== binding.budgetTaskId)
      throw new ContentExecutionStoppedError();
    stopped(root, order);
  }
}

/** Graph persistence is asynchronous; require its durable context before any
 * node can submit work, rather than discovering a missing context on save. */
export async function assertCurrentContentExecutionJobContext(jobId: string): Promise<void> {
  const current = executionContext.getStore();
  if (!current || current.jobId !== jobId) throw new Error('content_graph_job_context_required');
  await assertContentExecutionOwnership(current);
}

async function assertContentExecutionOwnership(current: ContentExecutionContextValue): Promise<Record<string, unknown> | null> {
  if (!current.expectedWorkerId) return null;
  if (current.executionStillOwned && !current.executionStillOwned()) throw new ContentExecutionStoppedError();
  const job = await current.dataStore.getById<Record<string, unknown>>(CONTENT_EXECUTION_JOB_COLLECTION, current.jobId);
  if (!job
    || compact(job.worker_id, 240) !== current.expectedWorkerId
    || (current.expectedAttempt !== null && Number(job.attempt) !== current.expectedAttempt)) {
    throw new ContentExecutionStoppedError();
  }
  return job;
}

/** Stop at stage/submission boundaries while allowing already accepted receipts to be saved. */
export async function assertCurrentContentExecutionActive(): Promise<void> {
  const current = executionContext.getStore();
  if (!current) return;
  const job = await assertContentExecutionOwnership(current)
    ?? await current.dataStore.getById<Record<string, unknown>>(CONTENT_EXECUTION_JOB_COLLECTION, current.jobId);
  if (!job || job.id !== current.jobId || !compact(job.tenant_id) || !compact(job.run_id) || !['queued', 'running', 'retry_wait', 'reconciling'].includes(String(job.status))) throw new ContentExecutionStoppedError();
  await assertSocialContentOrderActive(current.dataStore, String(job.tenant_id), String(job.task_id));
  const run = await current.dataStore.getById<Record<string, unknown>>('workflow_runs', String(job.run_id || ''));
  if (!run
    || run.id !== job.run_id
    || run.tenant_id !== job.tenant_id
    || ['paused', 'pausing', 'waiting_human', 'cancelling', 'cancelled', 'failed', 'completed', 'succeeded', 'dead_letter'].includes(String(run.status))
    || String(run.current_controller || '') === 'human') throw new ContentExecutionStoppedError();
}

export function currentContentProviderReceipt(input: {
  provider: string;
  requestId: string;
}): ContentProviderReceipt | null {
  const current = executionContext.getStore();
  if (!current) return null;
  return current.receipts.find(item => item.provider === input.provider && item.requestId === input.requestId) ?? null;
}

/** Compact read-only projection used by durable node evidence. Provider
 * receipt writes remain owned by recordCurrentContentProviderReceipt. */
export function currentContentProviderReceipts(): ContentProviderReceipt[] {
  const current = executionContext.getStore();
  return current ? structuredClone(current.receipts) : [];
}

/**
 * Read a durable stage checkpoint only when its schema version and exact input
 * fingerprint still match. Callers therefore cannot accidentally reuse an
 * analysis after the source material, product, script or plan changed.
 */
export function readCurrentContentExecutionCheckpoint<T>(input: {
  stage: string;
  version: string;
  inputHash: string;
}): T | null {
  const current = executionContext.getStore();
  if (!current) return null;
  const stage = checkpointKey(input.stage);
  const checkpoint = current.checkpoints[stage];
  if (!checkpoint
    || checkpoint.version !== compact(input.version, 40)
    || checkpoint.inputHash !== compact(input.inputHash, 240)) return null;
  return safeCheckpointPayload(checkpoint.payload) as T;
}

/**
 * Persist structured intermediate work on the existing durable job. This is
 * deliberately separate from transient media files: analyses, narration
 * timing and shot/material mappings survive process loss, while render bytes
 * continue to use the repository's durable media store.
 */
export async function recordCurrentContentExecutionCheckpoint<T>(input: {
  stage: string;
  version: string;
  inputHash: string;
  payload: T;
}): Promise<void> {
  const current = executionContext.getStore();
  if (!current) return;
  const stage = checkpointKey(input.stage);
  const version = compact(input.version, 40);
  const inputHash = compact(input.inputHash, 240);
  if (!version || !inputHash) throw new Error('content_execution_checkpoint_identity_invalid');
  const now = new Date().toISOString();
  current.checkpoints = {
    ...current.checkpoints,
    [stage]: {
      version,
      inputHash,
      payload: safeCheckpointPayload(input.payload),
      updatedAt: now,
    },
  };
  const serialized = JSON.stringify(current.checkpoints);
  if (Buffer.byteLength(serialized, 'utf8') > 4_194_304) {
    throw new Error('content_execution_checkpoints_too_large');
  }
  current.writeChain = current.writeChain.then(async () => {
    await assertContentExecutionOwnership(current);
    const updated = await current.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, current.jobId, {
      checkpoints: current.checkpoints,
      updated_at: now,
    });
    if (!updated) throw new Error('content_execution_checkpoint_persist_failed');
  });
  await current.writeChain;
}

/**
 * Persist a paid-provider handoff before the caller continues. This is the
 * write-ahead receipt used after worker restarts: a submitted request is
 * reconciled from its provider id or saved result and is never blindly sent
 * again.
 */
export async function recordCurrentContentProviderReceipt(input: {
  provider: string;
  requestId: string;
  state: ContentProviderReceiptState;
  providerTaskId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const current = executionContext.getStore();
  if (!current) return;
  if (input.state === 'submitting') await assertCurrentContentExecutionActive();
  const provider = compact(input.provider, 80);
  const requestId = compact(input.requestId, 240);
  if (!provider || !requestId) throw new Error('content_provider_receipt_identity_invalid');
  const providerTaskId = compact(input.providerTaskId, 240) || null;
  const metadata = safeMetadata(input.metadata);
  const now = new Date().toISOString();
  current.writeChain = current.writeChain.then(async () => {
    const initialJob = await current.dataStore.getById<Record<string, unknown>>(
      CONTENT_EXECUTION_JOB_COLLECTION,
      current.jobId,
    );
    const tenantId = compact(initialJob?.tenant_id, 200);
    if (!tenantId) throw new Error('content_provider_receipt_job_missing');
    const lease = await acquireReceiptWriteLease({ current, tenantId, provider, requestId });
    try {
      // Merge this receipt into the latest persisted array while holding an
      // independent receipt lease. An old worker may still report an accepted
      // provider task after losing its execution lease, but can no longer
      // overwrite receipts written by the successor worker.
      const latestJob = await current.dataStore.getById<Record<string, unknown>>(
        CONTENT_EXECUTION_JOB_COLLECTION,
        current.jobId,
      );
      if (!latestJob || compact(latestJob.tenant_id, 200) !== tenantId) {
        throw new Error('content_provider_receipt_job_missing');
      }
      const latestReceipts = parseContentProviderReceipts(latestJob.provider_receipts);
      const prior = latestReceipts.find(item => item.provider === provider && item.requestId === requestId);
      const receipt: ContentProviderReceipt = {
        provider,
        requestId,
        state: mergeReceiptState(prior?.state, input.state),
        providerTaskId: providerTaskId ?? prior?.providerTaskId ?? null,
        metadata: { ...(prior?.metadata ?? {}), ...metadata },
        firstRecordedAt: prior?.firstRecordedAt ?? now,
        updatedAt: now,
      };
      const mergedReceipts = [
        ...latestReceipts.filter(item => !(item.provider === provider && item.requestId === requestId)),
        receipt,
      ];
      const aggregateState = mergedReceipts.some(item => ['submitting', 'accepted', 'unknown'].includes(item.state))
        ? 'accepted'
        : mergedReceipts.some(item => item.state === 'completed') ? 'completed'
          : mergedReceipts.some(item => item.state === 'failed') ? 'failed' : 'none';
      const updated = await current.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, current.jobId, {
        provider_state: aggregateState,
        provider_receipts: mergedReceipts,
        updated_at: now,
      });
      if (!updated) throw new Error('content_provider_receipt_persist_failed');
      current.receipts = mergedReceipts;
    } finally {
      await releaseDurableOperationLease({ dataStore: current.dataStore, lease }).catch(() => undefined);
    }
  });
  await current.writeChain;
}
