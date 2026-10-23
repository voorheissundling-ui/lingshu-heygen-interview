import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { CONTENT_EXECUTION_JOB_COLLECTION, parseContentExecutionCheckpoints, type ContentExecutionCheckpoints } from './context.js';
import { footageRevisionNeedsAdmission, integer, jobFromRow, limitFromRow, listAll, requiredIdentity, stableId, type ContentExecutionJob, type ContentExecutionLimit, type ContentExecutionLimitScope, type JobRow, type LimitRow } from './durableQueueRecords.js';

export const CONTENT_EXECUTION_LIMIT_COLLECTION = 'content_execution_limits';

export function contentExecutionDefaults(env: NodeJS.ProcessEnv = process.env) {
  const bounded = (value: unknown, fallback: number) => Math.min(Math.max(integer(value, fallback), 1), 100);
  return {
    // One shared production pool, not one pool per business Agent. Explicit
    // customer limits and environment overrides remain authoritative.
    tenantMaxRunning: bounded(env.CONTENT_MAX_RUNNING_PER_TENANT, 3),
    accountMaxRunning: bounded(env.CONTENT_MAX_RUNNING_PER_ACCOUNT, 1),
    taskTypeMaxRunning: bounded(env.CONTENT_MAX_RUNNING_PER_TASK_TYPE, 3),
    workerConcurrency: bounded(env.CONTENT_EXECUTION_WORKER_CONCURRENCY, 3),
    pollIntervalMs: Math.min(Math.max(integer(env.CONTENT_EXECUTION_POLL_INTERVAL_MS, 2_000), 250), 60_000),
    leaseDurationMs: Math.min(Math.max(integer(env.CONTENT_EXECUTION_LEASE_MS, 30 * 60_000), 60_000), 2 * 60 * 60_000),
  };
}

export async function listContentExecutionLimits(dataStore: DataStore, tenantId: string): Promise<ContentExecutionLimit[]> {
  requiredIdentity(tenantId, 'tenant');
  return (await listAll<LimitRow>(dataStore, CONTENT_EXECUTION_LIMIT_COLLECTION, {
    where: { tenant_id: tenantId }, sort: 'limit_scope,scope_key',
  })).map(limitFromRow);
}

/**
 * Tenant-scoped read model for customer-facing queue observability.
 *
 * Worker identifiers, provider receipts and raw error messages stay on the
 * internal job record. Callers must deliberately project only public fields.
 */
export async function listContentExecutionJobs(
  dataStore: DataStore,
  tenantId: string,
): Promise<ContentExecutionJob[]> {
  requiredIdentity(tenantId, 'tenant');
  return (await listAll<JobRow>(dataStore, CONTENT_EXECUTION_JOB_COLLECTION, {
    where: { tenant_id: tenantId }, sort: '-updated_at',
  })).map(jobFromRow);
}

export async function setContentExecutionLimit(input: {
  dataStore: DataStore;
  tenantId: string;
  scope: ContentExecutionLimitScope;
  scopeKey: string;
  maxRunning: number | null;
  updatedBy: string;
  now?: Date;
}): Promise<ContentExecutionLimit | null> {
  const tenantId = requiredIdentity(input.tenantId, 'tenant');
  const scopeKey = input.scopeKey === '*' ? '*' : requiredIdentity(input.scopeKey, 'scope_key');
  const updatedBy = requiredIdentity(input.updatedBy, 'updated_by');
  if (!['tenant', 'account', 'task_type'].includes(input.scope)) throw new Error('content_execution_limit_scope_invalid');
  if (input.scope === 'tenant' && scopeKey !== '*') throw new Error('content_execution_tenant_limit_key_invalid');
  const id = stableId('content-limit', tenantId, input.scope, scopeKey);
  const existing = await input.dataStore.getById<LimitRow>(CONTENT_EXECUTION_LIMIT_COLLECTION, id);
  if (input.maxRunning === null) {
    if (existing && !await input.dataStore.delete(CONTENT_EXECUTION_LIMIT_COLLECTION, id)) {
      throw new Error('content_execution_limit_delete_failed');
    }
    return null;
  }
  const maxRunning = integer(input.maxRunning);
  if (maxRunning < 1 || maxRunning > 100) throw new Error('content_execution_limit_value_invalid');
  const now = (input.now ?? new Date()).toISOString();
  if (existing) {
    const updated = await input.dataStore.update(CONTENT_EXECUTION_LIMIT_COLLECTION, id, {
      tenant_id: tenantId, limit_scope: input.scope, scope_key: scopeKey,
      max_running: maxRunning, updated_by: updatedBy, updated_at: now,
    });
    if (!updated) throw new Error('content_execution_limit_update_failed');
  } else {
    const created = await input.dataStore.create<LimitRow>(CONTENT_EXECUTION_LIMIT_COLLECTION, {
      id, tenant_id: tenantId, limit_scope: input.scope, scope_key: scopeKey,
      max_running: maxRunning, updated_by: updatedBy, created_at: now, updated_at: now,
    });
    if (!created) throw new Error('content_execution_limit_create_failed');
  }
  const saved = await input.dataStore.getById<LimitRow>(CONTENT_EXECUTION_LIMIT_COLLECTION, id);
  if (!saved) throw new Error('content_execution_limit_readback_failed');
  return limitFromRow(saved);
}

export async function admitContentExecutionJob(input: {
  dataStore: DataStore;
  tenantId: string;
  userId: string;
  taskId: string;
  runId: string;
  accountId?: string | null;
  taskType: string;
  /** Creation-only state; replay never changes the already chosen executor. */
  initialCheckpoints?: ContentExecutionCheckpoints;
  now?: Date;
}): Promise<ContentExecutionJob> {
  const tenantId = requiredIdentity(input.tenantId, 'tenant');
  const userId = requiredIdentity(input.userId, 'user');
  const taskId = requiredIdentity(input.taskId, 'task');
  const runId = requiredIdentity(input.runId, 'run');
  const accountId = requiredIdentity(input.accountId || '_unassigned', 'account');
  const taskType = requiredIdentity(input.taskType, 'task_type');
  if (await footageRevisionNeedsAdmission(input.dataStore, tenantId, taskId, runId))
    throw new Error('content_execution_footage_revision_admission_required');
  const jobKey = createHash('sha256').update([tenantId, taskId, runId, taskType].join('\0')).digest('hex');
  const id = stableId('content-job', jobKey);
  const existing = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, id);
  if (existing) {
    const parsed = jobFromRow(existing);
    if (parsed.jobKey !== jobKey || parsed.tenantId !== tenantId || parsed.taskId !== taskId || parsed.runId !== runId) {
      throw new Error('content_execution_job_id_collision');
    }
    return parsed;
  }
  const now = (input.now ?? new Date()).toISOString();
  const created = await input.dataStore.create<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, {
    id, tenant_id: tenantId, job_key: jobKey, task_id: taskId, run_id: runId, user_id: userId,
    account_id: accountId, task_type: taskType, status: 'queued', attempt: 0,
    reconciliation_attempt: 0, next_attempt_at: now, worker_id: '', lease_expires_at: '',
    retry_class: '', last_error: '', provider_state: 'none', provider_receipts: [],
    checkpoints: parseContentExecutionCheckpoints(input.initialCheckpoints),
    created_at: now, updated_at: now, last_started_at: '', completed_at: '',
  });
  if (!created) {
    const raced = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, id);
    if (raced) return jobFromRow(raced);
    throw new Error('content_execution_job_create_failed');
  }
  return jobFromRow(created);
}

/** Stage an independently verified same-task revision in the existing queue
 * identity, but leave it unclaimable. A later, separate first-frame/paid
 * admission must change its state; generic retry/resume remains fenced. */
export async function stageBlockedFootageRevisionJob(input: {
  dataStore: DataStore; tenantId: string; taskId: string; runId: string;
  userId: string; accountId?: string | null; taskType: string;
  checkpoints: ContentExecutionCheckpoints; assertAuthority: () => Promise<void>;
  now?: Date;
}): Promise<ContentExecutionJob> {
  const tenantId = requiredIdentity(input.tenantId, 'tenant');
  const taskId = requiredIdentity(input.taskId, 'task');
  const runId = requiredIdentity(input.runId, 'run');
  const userId = requiredIdentity(input.userId, 'user');
  const accountId = requiredIdentity(input.accountId || '_unassigned', 'account');
  const taskType = requiredIdentity(input.taskType, 'task_type');
  if (!await footageRevisionNeedsAdmission(input.dataStore, tenantId, taskId, runId))
    throw new Error('content_execution_footage_revision_identity_missing');
  const checkpoints = parseContentExecutionCheckpoints(input.checkpoints);
  const identity = (value: ContentExecutionCheckpoints) => JSON.stringify(Object.entries(value)
    .map(([key, checkpoint]) => [key, checkpoint.version, checkpoint.inputHash, checkpoint.payload])
    .sort(([left], [right]) => String(left).localeCompare(String(right))));
  if ((checkpoints['social.executor']?.payload as { executor?: unknown } | undefined)?.executor !== 'langgraph'
    || !checkpoints['social.executor']?.inputHash || !checkpoints['content.production_bridge'])
    throw new Error('content_execution_footage_revision_checkpoint_invalid');
  await input.assertAuthority();
  const jobKey = createHash('sha256').update([tenantId, taskId, runId, taskType].join('\0')).digest('hex');
  const id = stableId('content-job', jobKey);
  const now = (input.now ?? new Date()).toISOString();
  const existing = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, id);
  if (existing) {
    const parsed = jobFromRow(existing);
    if (parsed.jobKey !== jobKey || parsed.tenantId !== tenantId || parsed.taskId !== taskId
      || parsed.runId !== runId || parsed.status !== 'blocked'
      || parsed.providerState !== 'none' || parsed.providerReceipts.length
      || identity(parsed.checkpoints) !== identity(checkpoints))
      throw new Error('content_execution_footage_revision_stage_conflict');
    await input.assertAuthority();
    return parsed;
  }
  const created = await input.dataStore.create<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, {
    id, tenant_id: tenantId, job_key: jobKey, task_id: taskId, run_id: runId, user_id: userId,
    account_id: accountId, task_type: taskType, status: 'blocked', attempt: 0,
    reconciliation_attempt: 0, next_attempt_at: '', worker_id: '', lease_expires_at: '',
    retry_class: '', last_error: 'product_footage_revision_new_first_frame_approval_required',
    provider_state: 'none', provider_receipts: [], checkpoints,
    created_at: now, updated_at: now, last_started_at: '', completed_at: '',
  }).catch(async error => {
    const raced = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, id);
    if (raced) return raced;
    throw error;
  });
  if (!created) throw new Error('content_execution_footage_revision_stage_failed');
  const staged = jobFromRow(created);
  if (staged.status !== 'blocked' || staged.jobKey !== jobKey
    || identity(staged.checkpoints) !== identity(checkpoints))
    throw new Error('content_execution_footage_revision_stage_conflict');
  await input.assertAuthority();
  return staged;
}
