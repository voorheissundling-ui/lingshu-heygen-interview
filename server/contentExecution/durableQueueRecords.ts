import { createHash } from 'node:crypto';
import type { DataStore, ListQuery } from '../storage/datastore.js';
import {
  CONTENT_EXECUTION_JOB_COLLECTION,
  parseContentExecutionCheckpoints,
  parseContentProviderReceipts,
  type ContentExecutionCheckpoints,
  type ContentProviderReceipt,
} from './context.js';

export type ContentExecutionJobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'reconciling'
  | 'blocked'
  | 'paused'
  | 'succeeded'
  | 'cancelled'
  | 'dead_letter';

export type ContentExecutionLimitScope = 'tenant' | 'account' | 'task_type';

export interface ContentExecutionJob {
  id: string;
  tenantId: string;
  jobKey: string;
  taskId: string;
  runId: string;
  userId: string;
  accountId: string;
  taskType: string;
  status: ContentExecutionJobStatus;
  attempt: number;
  reconciliationAttempt: number;
  nextAttemptAt: string | null;
  workerId: string | null;
  leaseExpiresAt: string | null;
  retryClass: string | null;
  lastError: string | null;
  providerState: string;
  providerReceipts: ContentProviderReceipt[];
  checkpoints: ContentExecutionCheckpoints;
  createdAt: string;
  updatedAt: string;
  lastStartedAt: string | null;
  completedAt: string | null;
}

export interface ContentExecutionLimit {
  id: string;
  tenantId: string;
  scope: ContentExecutionLimitScope;
  scopeKey: string;
  maxRunning: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type JobRow = Record<string, unknown> & { id: string };
export type LimitRow = Record<string, unknown> & { id: string };

export const ACTIVE_STATUSES = new Set<ContentExecutionJobStatus>(['running']);
export const CLAIMABLE_STATUSES = ['queued', 'retry_wait', 'reconciling'] as const;
const SAFE_IDENTITY = /^[a-zA-Z0-9._:@-]{1,240}$/;

export function text(value: unknown, max = 1000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

export function dateText(value: unknown): string | null {
  const raw = text(value, 80);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
}

export function requiredIdentity(value: unknown, field: string): string {
  const normalized = text(value, 240);
  if (!SAFE_IDENTITY.test(normalized)) throw new Error(`content_execution_${field}_invalid`);
  return normalized;
}

export function stableId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 15);
}

/** Generic admission/retry is never the authority for a frozen same-task
 * footage revision. The revision admission must first bind current-window
 * evidence, new approval and the original-ledger paid plan before the existing
 * production worker may claim that run. */
export async function footageRevisionNeedsAdmission(dataStore: DataStore, tenantId: string,
  taskId: string, runId: string, job?: ContentExecutionJob): Promise<boolean> {
  const rows = await dataStore.list<Record<string, unknown>>('starter_social_content_tasks', {
    where: { tenant_id: tenantId, task_id: taskId }, perPage: 2,
  });
  if (rows.totalItems > 1 || rows.items.length > 1) throw new Error('content_execution_order_identity_ambiguous');
  const raw = rows.items[0]?.brief;
  let brief: unknown = raw;
  if (typeof brief === 'string') {
    try { brief = JSON.parse(brief); } catch { throw new Error('content_execution_revision_identity_invalid'); }
  }
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) return false;
  const marker = (brief as Record<string, unknown>)._productFootageRevision;
  if (!marker) return false;
  if (typeof marker !== 'object' || Array.isArray(marker)) throw new Error('content_execution_revision_identity_invalid');
  return runId !== (marker as Record<string, unknown>).sourceRunId
    && (!job || !hasCompleteFootageRevisionProductionAdmission(job, marker as Record<string, unknown>));
}

/** The revision exception is deliberately data-only so the generic durable
 * queue can verify it without depending on the Starter198 production module.
 * It is not a second worker lane: a complete checkpoint merely admits the
 * frozen revision run back into the existing content-production worker. */
export function hasCompleteFootageRevisionProductionAdmission(
  job: ContentExecutionJob,
  marker: Record<string, unknown>,
): boolean {
  const checkpoint = job.checkpoints['social.footage_revision_worker_admission'];
  const payload = checkpoint?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const admission = payload as Record<string, unknown>;
  const recordHash = text(admission.recordHash, 64);
  const sha256 = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const approvalBindings = admission.approvalBindings;
  const revision = marker.revision && typeof marker.revision === 'object' && !Array.isArray(marker.revision)
    ? marker.revision as Record<string, unknown> : null;
  const revisedPlanHash = marker.revisedPlanHash ?? revision?.revisedPlanHash;
  if (!/^[a-f0-9]{64}$/.test(recordHash) || checkpoint.version !== '1'
    || checkpoint.inputHash !== recordHash
    || admission.schemaVersion !== 'social-product-footage-revision-worker-admission.v1'
    || admission.tenantId !== job.tenantId || admission.taskId !== job.taskId
    || admission.runId !== job.runId
    || admission.workerLane !== 'social_content_production'
    || admission.planHash !== revisedPlanHash
    || !sha256(admission.guardHash) || !sha256(admission.paidPlanFreezeHash)
    || !sha256(admission.canonicalPlanHash) || !sha256(admission.planHash)
    || !Array.isArray(approvalBindings) || !approvalBindings.length
    || approvalBindings.some(binding => !binding || typeof binding !== 'object' || Array.isArray(binding)
      || !text((binding as Record<string, unknown>).groupId)
      || !sha256((binding as Record<string, unknown>).approvalRecordHash)
      || !sha256((binding as Record<string, unknown>).decisionRecordHash)
      || !sha256((binding as Record<string, unknown>).assetProvenanceHash))
    || typeof admission.admittedAt !== 'string' || !Number.isFinite(Date.parse(admission.admittedAt))) return false;
  const { recordHash: _recordHash, ...body } = admission;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex') === recordHash;
}

export function jobFromRow(row: JobRow): ContentExecutionJob {
  const status = text(row.status, 40) as ContentExecutionJobStatus;
  if (!row.id || !['queued', 'running', 'retry_wait', 'reconciling', 'blocked', 'paused', 'succeeded', 'cancelled', 'dead_letter'].includes(status)) {
    throw new Error('content_execution_job_record_invalid');
  }
  return {
    id: row.id,
    tenantId: requiredIdentity(row.tenant_id, 'tenant'),
    jobKey: requiredIdentity(row.job_key, 'job_key'),
    taskId: requiredIdentity(row.task_id, 'task'),
    runId: requiredIdentity(row.run_id, 'run'),
    userId: requiredIdentity(row.user_id, 'user'),
    accountId: requiredIdentity(row.account_id, 'account'),
    taskType: requiredIdentity(row.task_type, 'task_type'),
    status,
    attempt: integer(row.attempt),
    reconciliationAttempt: integer(row.reconciliation_attempt),
    nextAttemptAt: dateText(row.next_attempt_at),
    workerId: text(row.worker_id, 240) || null,
    leaseExpiresAt: dateText(row.lease_expires_at),
    retryClass: text(row.retry_class, 80) || null,
    lastError: text(row.last_error, 2000) || null,
    providerState: text(row.provider_state, 40) || 'none',
    providerReceipts: parseContentProviderReceipts(row.provider_receipts),
    checkpoints: parseContentExecutionCheckpoints(row.checkpoints),
    createdAt: dateText(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: dateText(row.updated_at) ?? new Date(0).toISOString(),
    lastStartedAt: dateText(row.last_started_at),
    completedAt: dateText(row.completed_at),
  };
}

export function limitFromRow(row: LimitRow): ContentExecutionLimit {
  const scope = text(row.limit_scope, 40) as ContentExecutionLimitScope;
  if (!row.id || !['tenant', 'account', 'task_type'].includes(scope)) throw new Error('content_execution_limit_record_invalid');
  const maxRunning = integer(row.max_running);
  if (maxRunning < 1 || maxRunning > 100) throw new Error('content_execution_limit_record_invalid');
  return {
    id: row.id,
    tenantId: requiredIdentity(row.tenant_id, 'tenant'),
    scope,
    scopeKey: row.scope_key === '*' ? '*' : requiredIdentity(row.scope_key, 'scope_key'),
    maxRunning,
    updatedBy: text(row.updated_by, 240),
    createdAt: dateText(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: dateText(row.updated_at) ?? new Date(0).toISOString(),
  };
}

export async function listAll<T extends { id: string }>(dataStore: DataStore, collection: string, query: ListQuery = {}): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await dataStore.list<T>(collection, { ...query, page, perPage: 500 });
    rows.push(...result.items);
    if (page >= Math.max(1, result.totalPages)) break;
    if (page === 100) throw new Error(`content_execution_${collection}_scan_limit_exceeded`);
  }
  return rows;
}

