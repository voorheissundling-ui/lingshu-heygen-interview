/** 面试阅读注释：真实持久化内容队列：租约、重试与执行结算。生产执行端口由调用方注入；本题仅注入受控本地执行，未证明真实供应商准备就绪。 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { currentDataAuthority, runWithDataAuthority, type DataAuthority } from '../storage/dataAuthority.js';
import type { DataStore } from '../storage/datastore.js';
import {
  acquireDurableOperationLease,
  releaseDurableOperationLease,
  renewDurableOperationLease,
  type DurableOperationLease,
} from '../runtime/durableLease.js';
import {
  CONTENT_EXECUTION_JOB_COLLECTION,
  runWithContentExecutionContext,
} from './context.js';
import { classifyContentExecutionFailure, type ContentExecutionRetryDecision } from './retryPolicy.js';
import {
  ACTIVE_STATUSES,
  CLAIMABLE_STATUSES,
  dateText,
  footageRevisionNeedsAdmission,
  hasCompleteFootageRevisionProductionAdmission,
  jobFromRow,
  listAll,
  requiredIdentity,
  text,
  type ContentExecutionJob,
  type ContentExecutionJobStatus,
  type ContentExecutionLimit,
  type ContentExecutionLimitScope,
  type JobRow,
} from './durableQueueRecords.js';
import { contentExecutionDefaults, listContentExecutionLimits } from './durableQueueAdmission.js';

export {
  hasCompleteFootageRevisionProductionAdmission,
  type ContentExecutionJob,
  type ContentExecutionJobStatus,
  type ContentExecutionLimit,
  type ContentExecutionLimitScope,
} from './durableQueueRecords.js';
export {
  bindPristineContentExecutionCheckpoint,
  bindPristineContentExecutionCheckpoints,
  refreshUnspentContentExecutionCheckpoint,
} from './durableQueueCheckpoints.js';
export {
  CONTENT_EXECUTION_LIMIT_COLLECTION,
  contentExecutionDefaults,
  listContentExecutionLimits,
  listContentExecutionJobs,
  setContentExecutionLimit,
  admitContentExecutionJob,
  stageBlockedFootageRevisionJob,
} from './durableQueueAdmission.js';


async function readSchedulerJobs(dataStore: DataStore): Promise<ContentExecutionJob[]> {
  const statuses: ContentExecutionJobStatus[] = ['running', 'queued', 'retry_wait', 'reconciling'];
  const rows = (await Promise.all(statuses.map(status => listAll<JobRow>(
    dataStore,
    CONTENT_EXECUTION_JOB_COLLECTION,
    { where: { status }, sort: 'created_at' },
  )))).flat();
  return rows.map(jobFromRow);
}

function isDue(job: ContentExecutionJob, now: Date): boolean {
  return !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now.getTime();
}

function hasProviderWork(job: ContentExecutionJob): boolean {
  return job.providerReceipts.some(receipt => ['submitting', 'accepted', 'unknown'].includes(receipt.state));
}

/** Persistent group fence, independent of the root's historical completion
 * status. Legacy non-content jobs are deliberately left on their own gates. */
async function contentOrderCancelled(dataStore: DataStore, job: ContentExecutionJob): Promise<boolean> {
  const rows = await dataStore.list<Record<string, unknown>>('starter_social_content_tasks', {
    where: { tenant_id: job.tenantId, task_id: job.taskId }, perPage: 2,
  });
  if (rows.totalItems > 1) throw new Error('content_execution_order_identity_ambiguous');
  const task = rows.items[0];
  const parse = (raw: unknown): Record<string, unknown> | null => {
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { throw new Error('content_execution_order_identity_invalid'); } }
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  };
  const binding = parse(task?.content_order);
  // A same-task footage revision has a new run pointer but its paid plan is
  // only frozen, not admitted to a worker. Never claim a generic queued/retry
  // job for that run (including after a restart or manual retry).
  const brief = parse(task?.brief);
  const rawFootageRevision = brief?._productFootageRevision;
  const footageRevision = parse(rawFootageRevision);
  if (rawFootageRevision && !footageRevision) throw new Error('content_execution_revision_identity_invalid');
  if (footageRevision && job.runId !== footageRevision.sourceRunId
    && !hasCompleteFootageRevisionProductionAdmission(job, footageRevision)) return true;
  const stopped = (row: Record<string, unknown> | undefined, order: Record<string, unknown> | null) =>
    Boolean(order?.cancellation || order?.replacedByContentId || order?.supersededByContentId
      || ['cancelled', 'cancelling'].includes(String(row?.status)));
  if (stopped(task, binding)) return true;
  if (binding?.contentId && binding.contentId !== job.taskId) {
    const roots = await dataStore.list<Record<string, unknown>>('starter_social_content_tasks', {
      where: { tenant_id: job.tenantId, task_id: String(binding.contentId) }, perPage: 2,
    });
    if (roots.totalItems !== 1 || roots.items.length !== 1) throw new Error('content_execution_order_root_missing');
    const root = roots.items[0], rootBinding = parse(root.content_order);
    if (!rootBinding || rootBinding.contentId !== binding.contentId || rootBinding.budgetTaskId !== binding.budgetTaskId)
      throw new Error('content_execution_order_identity_invalid');
    return stopped(root, rootBinding);
  }
  return false;
}

function effectiveLimit(
  limits: ContentExecutionLimit[],
  scope: ContentExecutionLimitScope,
  key: string,
  fallback: number,
): number {
  return limits.find(item => item.scope === scope && item.scopeKey === key)?.maxRunning
    ?? limits.find(item => item.scope === scope && item.scopeKey === '*')?.maxRunning
    ?? fallback;
}

function canRun(job: ContentExecutionJob, running: ContentExecutionJob[], limits: ContentExecutionLimit[], env: NodeJS.ProcessEnv): boolean {
  const defaults = contentExecutionDefaults(env);
  const tenantRunning = running.filter(item => item.tenantId === job.tenantId);
  if (tenantRunning.length >= effectiveLimit(limits, 'tenant', '*', defaults.tenantMaxRunning)) return false;
  if (tenantRunning.filter(item => item.accountId === job.accountId).length
    >= effectiveLimit(limits, 'account', job.accountId, defaults.accountMaxRunning)) return false;
  if (tenantRunning.filter(item => item.taskType === job.taskType).length
    >= effectiveLimit(limits, 'task_type', job.taskType, defaults.taskTypeMaxRunning)) return false;
  return true;
}

function localHostPrefix(): string {
  return os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
}

/**
 * Extracts the PID from a worker id written by this host
 * (`<host>-<pid>-<uuid>`). The UUID must be matched as a whole: a looser
 * `[0-9a-f-]{20,}` tail lets the greedy host group swallow part of a UUID
 * whose first segment is all digits, so the same-host check fails and a dead
 * worker's job is never recovered.
 */
export function localWorkerPid(workerId: string): number | null {
  const match = /^(.+)-(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    .exec(workerId || '');
  if (!match || match[1] !== localHostPrefix()) return null;
  const pid = Number(match[2]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function recoverAbandonedJobs(dataStore: DataStore, jobs: ContentExecutionJob[], now: Date): Promise<void> {
  for (const job of jobs) {
    if (job.status !== 'running' || !job.leaseExpiresAt) continue;
    const pid = localWorkerPid(job.workerId || '');
    let localOwnerAlive = true;
    if (pid !== null) {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') localOwnerAlive = false; }
    }
    if (Date.parse(job.leaseExpiresAt) > now.getTime() && localOwnerAlive) continue;
    const reconcile = hasProviderWork(job);
    await dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, {
      status: reconcile ? 'reconciling' : 'retry_wait',
      retry_class: reconcile ? 'provider_reconciliation' : 'system_fault',
      next_attempt_at: now.toISOString(),
      worker_id: '', lease_expires_at: '',
      last_error: reconcile ? 'worker_interrupted_after_provider_handoff' : 'worker_interrupted_before_provider_handoff',
      updated_at: now.toISOString(),
    });
    if (!localOwnerAlive) {
      const leases = await dataStore.list<Record<string, unknown>>('durable_operation_leases', {
        where: { tenant_id: job.tenantId, lease_scope: 'content_execution_job', subject_id: job.id }, perPage: 2,
      });
      for (const lease of leases.items) {
        if (String(lease.owner_id || '') === job.workerId) await dataStore.delete('durable_operation_leases', String(lease.id));
      }
    }
  }
}

async function claimNextJob(input: {
  dataStore: DataStore;
  workerId: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  allowedJobIds?: ReadonlySet<string>;
}): Promise<{ job: ContentExecutionJob; lease: DurableOperationLease } | null> {
  if (input.allowedJobIds?.size === 0) return null;
  const defaults = contentExecutionDefaults(input.env);
  const schedulerLease = await acquireDurableOperationLease({
    dataStore: input.dataStore, tenantId: '__system__', scope: 'content_queue_scheduler',
    subjectId: 'global', ownerId: input.workerId, now: input.now, leaseDurationMs: 60_000, reclaimGraceMs: 5_000,
  });
  if (!schedulerLease) return null;
  try {
    let jobs = await readSchedulerJobs(input.dataStore);
    await recoverAbandonedJobs(input.dataStore, jobs.filter(job => !input.allowedJobIds || input.allowedJobIds.has(job.id)), input.now);
    jobs = await readSchedulerJobs(input.dataStore);
    const running = jobs.filter(job => ACTIVE_STATUSES.has(job.status));
    const allTenantIds = [...new Set(jobs.map(job => job.tenantId))];
    const limits = (await Promise.all(allTenantIds.map(tenantId => listContentExecutionLimits(input.dataStore, tenantId)))).flat();
    const candidates = jobs.filter(job => (!input.allowedJobIds || input.allowedJobIds.has(job.id)) && CLAIMABLE_STATUSES.includes(job.status as typeof CLAIMABLE_STATUSES[number]) && isDue(job, input.now));
    candidates.sort((left, right) => {
      const leftRunning = running.filter(item => item.tenantId === left.tenantId).length;
      const rightRunning = running.filter(item => item.tenantId === right.tenantId).length;
      return leftRunning - rightRunning
        || Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.id.localeCompare(right.id);
    });
    for (const candidate of candidates) {
      // The same scheduler lock is used by cancellation. Check the durable
      // root fence before any claim; unknown provider receipts stay untouched.
      try { if (await contentOrderCancelled(input.dataStore, candidate)) continue; }
      catch (error) {
        // Corrupt/ambiguous lineage is fail-closed for this branch, not a
        // reason to starve unrelated executable content in the same pool.
        console.error('[content-execution] order claim blocked', { jobId: candidate.id,
          error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!canRun(candidate, running, limits.filter(item => item.tenantId === candidate.tenantId), input.env)) continue;
      const priorLeases = await input.dataStore.list<Record<string, unknown>>('durable_operation_leases', {
        where: { tenant_id: candidate.tenantId, lease_scope: 'content_execution_job', subject_id: candidate.id }, perPage: 2,
      });
      for (const prior of priorLeases.items) {
        const pid = localWorkerPid(String(prior.owner_id || ''));
        if (pid === null) continue;
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') await input.dataStore.delete('durable_operation_leases', String(prior.id));
        }
      }
      const lease = await acquireDurableOperationLease({
        dataStore: input.dataStore, tenantId: candidate.tenantId, scope: 'content_execution_job',
        subjectId: candidate.id, ownerId: input.workerId, now: input.now,
        leaseDurationMs: defaults.leaseDurationMs, reclaimGraceMs: 5_000,
      });
      if (!lease) continue;
      const leaseExpiresAt = new Date(input.now.getTime() + defaults.leaseDurationMs).toISOString();
      const claimed = await input.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, candidate.id, {
        status: 'running', attempt: candidate.attempt + 1,
        reconciliation_attempt: candidate.status === 'reconciling' ? candidate.reconciliationAttempt + 1 : candidate.reconciliationAttempt,
        worker_id: input.workerId, lease_expires_at: leaseExpiresAt,
        last_started_at: input.now.toISOString(), updated_at: input.now.toISOString(),
      });
      if (!claimed) {
        await releaseDurableOperationLease({ dataStore: input.dataStore, lease }).catch(() => undefined);
        throw new Error('content_execution_job_claim_failed');
      }
      const row = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, candidate.id);
      if (!row) throw new Error('content_execution_job_claim_readback_failed');
      return { job: jobFromRow(row), lease };
    }
    return null;
  } finally {
    await releaseDurableOperationLease({ dataStore: input.dataStore, lease: schedulerLease });
  }
}

function sameClaim(current: ContentExecutionJob, claimed: ContentExecutionJob): boolean {
  return current.workerId === claimed.workerId && current.attempt === claimed.attempt;
}

async function withSettlementControl<T>(dataStore: DataStore, job: ContentExecutionJob, action: () => Promise<T>): Promise<T> {
  const lease = await acquireDurableOperationLease({ dataStore, tenantId: job.tenantId, subjectId: job.id,
    scope: 'content_execution_control', ownerId: `content-settle:${randomUUID()}`, leaseDurationMs: 30_000 });
  if (!lease) throw new Error('content_execution_job_control_busy');
  try { return await action(); }
  finally { await releaseDurableOperationLease({ dataStore, lease }).catch(() => undefined); }
}

async function finishSucceeded(dataStore: DataStore, job: ContentExecutionJob, now: Date): Promise<boolean> {
  return withSettlementControl(dataStore, job, () => finishSucceededUnderControl(dataStore, job, now));
}
async function finishSucceededUnderControl(dataStore: DataStore, job: ContentExecutionJob, now: Date): Promise<boolean> {
  const currentRow = await dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, job.id);
  const current = currentRow ? jobFromRow(currentRow) : job;
  if (!sameClaim(current, job)) return false;
  if (current.status === 'paused' || current.status === 'cancelled' || await contentOrderCancelled(dataStore, current)) {
    if (!await dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, {
      worker_id: '', lease_expires_at: '', updated_at: now.toISOString(),
    })) throw new Error('content_execution_job_control_settlement_failed');
    return false;
  }
  if (!await dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, {
    status: 'succeeded', next_attempt_at: '', worker_id: '', lease_expires_at: '', retry_class: '', last_error: '',
    completed_at: now.toISOString(), updated_at: now.toISOString(),
  })) throw new Error('content_execution_job_completion_failed');
  return true;
}

async function finishFailed(input: {
  dataStore: DataStore;
  job: ContentExecutionJob;
  error: unknown;
  now: Date;
  env: NodeJS.ProcessEnv;
}): Promise<{ decision: ContentExecutionRetryDecision; settled: boolean }> {
  return withSettlementControl(input.dataStore, input.job, () => finishFailedUnderControl(input));
}
async function finishFailedUnderControl(input: {
  dataStore: DataStore; job: ContentExecutionJob; error: unknown; now: Date; env: NodeJS.ProcessEnv;
}): Promise<{ decision: ContentExecutionRetryDecision; settled: boolean }> {
  const currentRow = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, input.job.id);
  const current = currentRow ? jobFromRow(currentRow) : input.job;
  if (!sameClaim(current, input.job)) {
    return {
      decision: classifyContentExecutionFailure(input.error, {
        attempt: input.job.attempt,
        hasUnsettledProviderReceipt: hasProviderWork(input.job),
        env: input.env,
      }),
      settled: false,
    };
  }
  if (current.status === 'paused' || current.status === 'cancelled' || await contentOrderCancelled(input.dataStore, current)) {
    await input.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, current.id, {
      worker_id: '', lease_expires_at: '', updated_at: input.now.toISOString(),
    });
    return { settled: false, decision: {
      failureClass: 'system_fault', disposition: 'block', retryDelayMs: null,
      maxAttempts: 1, publicReason: current.status === 'paused' ? '任务已暂停' : '任务已取消',
    } };
  }
  const providerPending = hasProviderWork(current);
  const reconcileAttempt = Math.max(1, current.reconciliationAttempt);
  const decision = classifyContentExecutionFailure(input.error, {
    attempt: providerPending ? reconcileAttempt : current.attempt,
    hasUnsettledProviderReceipt: providerPending, env: input.env,
  });
  const status: ContentExecutionJobStatus = decision.disposition === 'retry'
    ? 'retry_wait' : decision.disposition === 'reconcile' ? 'reconciling' : 'blocked';
  const nextAttemptAt = decision.retryDelayMs === null ? '' : new Date(input.now.getTime() + decision.retryDelayMs).toISOString();
  const errorText = String(input.error instanceof Error ? input.error.message : input.error || 'content_execution_failed').slice(0, 2000);
  if (!await input.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, current.id, {
    status, retry_class: decision.failureClass, next_attempt_at: nextAttemptAt,
    reconciliation_attempt: providerPending ? reconcileAttempt : current.reconciliationAttempt,
    worker_id: '', lease_expires_at: '', last_error: errorText, updated_at: input.now.toISOString(),
  })) throw new Error('content_execution_job_failure_persist_failed');
  return { decision, settled: true };
}

export interface DurableContentExecutionWorkerOptions {
  /** Trusted worker scope; empty means execute and recover no jobs. */
  allowedJobIds?: string[];
  dataAuthority?: DataAuthority;
  dataStore: DataStore;
  execute(job: ContentExecutionJob): Promise<void>;
  onSucceeded?(job: ContentExecutionJob): Promise<void>;
  onRetry?(job: ContentExecutionJob, error: unknown, decision: ContentExecutionRetryDecision): Promise<void>;
  onBlocked?(job: ContentExecutionJob, error: unknown, decision: ContentExecutionRetryDecision): Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export class DurableContentExecutionWorker {
  private readonly env: NodeJS.ProcessEnv;
  private readonly workerId: string;
  private readonly allowedJobIds: ReadonlySet<string> | undefined;
  private readonly active = new Map<string, Promise<void>>();
  private draining = false;
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly options: DurableContentExecutionWorkerOptions) {
    if (options.allowedJobIds?.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim())) {
      throw new Error('invalid_content_execution_allowed_job_ids');
    }
    this.allowedJobIds = options.allowedJobIds === undefined ? undefined : new Set(options.allowedJobIds);
    this.env = options.env ?? process.env;
    this.workerId = `${os.hostname().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)}-${process.pid}-${randomUUID()}`;
  }

  start(): void {
    if (this.interval) return;
    const { pollIntervalMs } = contentExecutionDefaults(this.env);
    this.interval = setInterval(() => void this.drain(), pollIntervalMs);
    this.interval.unref?.();
    void this.drain();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  isLocallyActive(tenantId: string, taskId: string): boolean {
    return [...this.active.keys()].some(key => key.startsWith(`${tenantId}\0${taskId}\0`));
  }

  async drain(): Promise<void> {
    // Pin the complete claim/execution lifecycle, including retries and callbacks,
    // so a local list cannot be followed by a remote lookup or mutation.
    if (this.options.dataAuthority && currentDataAuthority() !== this.options.dataAuthority) {
      return runWithDataAuthority(this.options.dataAuthority, () => this.drain());
    }
    if (this.draining) return;
    this.draining = true;
    try {
      const concurrency = contentExecutionDefaults(this.env).workerConcurrency;
      while (this.active.size < concurrency) {
        const claimed = await claimNextJob({
          dataStore: this.options.dataStore, workerId: this.workerId, env: this.env,
          now: this.options.now?.() ?? new Date(), allowedJobIds: this.allowedJobIds,
        });
        if (!claimed) break;
        const key = `${claimed.job.tenantId}\0${claimed.job.taskId}\0${claimed.job.id}`;
        const execution = this.runClaimed(claimed.job, claimed.lease)
          .catch(error => console.error('[content-execution] claimed job failed to settle', {
            jobId: claimed.job.id, error: error instanceof Error ? error.message : String(error),
          }))
          .finally(() => {
            this.active.delete(key);
            setImmediate(() => void this.drain());
          });
        this.active.set(key, execution);
      }
    } catch (error) {
      console.error('[content-execution] queue drain failed', error instanceof Error ? error.message : error);
    } finally {
      this.draining = false;
    }
  }

  private async runClaimed(job: ContentExecutionJob, initialLease: DurableOperationLease): Promise<void> {
    const defaults = contentExecutionDefaults(this.env);
    let lease = initialLease;
    let leaseOwned = true;
    const renewEveryMs = Math.max(30_000, Math.floor(defaults.leaseDurationMs / 3));
    const renewal = setInterval(() => {
      void renewDurableOperationLease({
        dataStore: this.options.dataStore, lease, leaseDurationMs: defaults.leaseDurationMs,
      }).then(async renewed => {
        lease = renewed;
        if (!await this.options.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, {
          lease_expires_at: renewed.expiresAt, updated_at: new Date().toISOString(),
        })) throw new Error('content_execution_job_lease_update_failed');
      }).catch(error => {
        leaseOwned = false;
        console.error('[content-execution] lease renewal failed; fenced worker will stop at the next boundary', {
          jobId: job.id, error: error instanceof Error ? error.message : String(error),
        });
      });
    }, renewEveryMs);
    renewal.unref?.();
    try {
      await runWithContentExecutionContext({
        dataStore: this.options.dataStore,
        jobId: job.id,
        providerReceipts: job.providerReceipts,
        checkpoints: job.checkpoints,
        expectedWorkerId: job.workerId ?? undefined,
        expectedAttempt: job.attempt,
        executionStillOwned: () => leaseOwned,
        action: () => this.options.execute(job),
      });
      if (!leaseOwned) throw new Error('content_execution_worker_lease_lost');
      const settled = await finishSucceeded(this.options.dataStore, job, this.options.now?.() ?? new Date());
      // Execution is already durably successful. A completion projection or
      // notification failure must not put paid production back in the queue.
      // Domain recovery reconciles its saved output without executing again.
      if (settled) {
        try {
          await this.options.onSucceeded?.(job);
        } catch (error) {
          console.error('[content-execution] success callback requires reconciliation', {
            jobId: job.id, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      const failed = await finishFailed({
        dataStore: this.options.dataStore, job, error,
        now: this.options.now?.() ?? new Date(), env: this.env,
      });
      if (failed.settled) {
        if (failed.decision.disposition === 'block') await this.options.onBlocked?.(job, error, failed.decision);
        else await this.options.onRetry?.(job, error, failed.decision);
      }
    } finally {
      leaseOwned = false;
      clearInterval(renewal);
      await releaseDurableOperationLease({ dataStore: this.options.dataStore, lease }).catch(() => undefined);
    }
  }
}

export async function readContentExecutionJob(
  dataStore: DataStore,
  tenantId: string,
  taskId: string,
  runId: string,
): Promise<ContentExecutionJob | null> {
  const rows = await dataStore.list<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, {
    where: { tenant_id: tenantId, task_id: taskId, run_id: runId }, perPage: 2,
  });
  if (rows.totalItems > 1 || rows.items.length > 1) throw new Error('content_execution_job_integrity_violation');
  return rows.items[0] ? jobFromRow(rows.items[0]) : null;
}

export type ContentExecutionControlAction = 'pause' | 'cancel' | 'resume' | 'retry';

/** A later rights/visual review cannot add evidence to an already frozen plan.
 * Keep this deliberately narrow: older jobs without a readable frozen plan
 * retain their existing recovery path, while an explicitly unbound footage
 * segment needs a formal task/run revision rather than a same-run retry. */
function frozenProductFootageRevisionRequired(job: ContentExecutionJob): boolean {
  if (!job.lastError?.includes('product_footage_shot_review_required')) return false;
  const payload = job.checkpoints['social.executor']?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const binding = payload as Record<string, unknown>;
  const object = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const frozen = object(binding.frozenPlan);
  const approved = object(binding.approvedContext);
  const supply = object(approved?.assetSupplyPlan);
  const shots = Array.isArray(supply?.shots) ? supply.shots : [];
  const segments = [frozen?.selectedMaterialSegment, ...shots.map(shot => object(shot)?.selectedMaterialSegment)];
  return segments.some(segment => {
    const selected = object(segment);
    return selected && typeof selected.sourceRef === 'string' && selected.sourceRef.length > 0
      && !object(selected.footageEvidence);
  });
}
export type ContentExecutionPauseOrigin =
  | 'manual'
  | 'workflow_review'
  | 'workflow_run_pause'
  | 'workflow_handoff';

export interface ContentExecutionRunControlResult {
  runId: string;
  affectedJobIds: string[];
  preservedJobIds: string[];
  terminalJobIds: string[];
}

/**
 * Applies customer-visible controls to the durable job itself. A running paid
 * provider call cannot always be interrupted, so pause/cancel prevents later
 * queue stages from being claimed and finish handlers preserve that decision.
 * Resuming the same job keeps its provider receipts and idempotency identity.
 */
async function applyContentExecutionControl(input: {
  dataStore: DataStore;
  tenantId: string;
  jobId: string;
  action: ContentExecutionControlAction;
  /** Server-owned review waits may auto-resume; a customer pause never may. */
  pauseOrigin?: ContentExecutionPauseOrigin;
  now?: Date;
}): Promise<ContentExecutionJob> {
  const tenantId = requiredIdentity(input.tenantId, 'tenant');
  const jobId = requiredIdentity(input.jobId, 'job');
  const row = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, jobId);
  if (!row) throw new Error('content_execution_job_not_found');
  const current = jobFromRow(row);
  if (current.tenantId !== tenantId) throw new Error('content_execution_job_not_found');
  if (input.action === 'resume' || input.action === 'retry') {
    if (await footageRevisionNeedsAdmission(input.dataStore, tenantId, current.taskId, current.runId, current))
      throw new Error('content_execution_footage_revision_admission_required');
    const tasks = await input.dataStore.list<Record<string, unknown>>('starter_social_content_tasks', {
      where: { tenant_id: tenantId, task_id: current.taskId }, perPage: 2,
    });
    if (tasks.totalItems > 1) throw new Error('content_execution_order_identity_ambiguous');
    const task = tasks.items[0];
    let binding = task?.content_order;
    if (typeof binding === 'string') { try { binding = JSON.parse(binding); } catch { throw new Error('content_execution_order_identity_invalid'); } }
    if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
      const order = binding as Record<string, unknown>;
      if (order.cancellation || order.replacedByContentId || order.supersededByContentId || ['cancelled','cancelling'].includes(String(task?.status)))
        throw new Error('content_execution_order_cancelled_or_replaced');
      if (order.contentId && order.contentId !== current.taskId) {
        const roots = await input.dataStore.list<Record<string, unknown>>('starter_social_content_tasks', {
          where: { tenant_id: tenantId, task_id: String(order.contentId) }, perPage: 2,
        });
        if (roots.totalItems !== 1 || roots.items.length !== 1) throw new Error('content_execution_order_root_missing');
        const root = roots.items[0];
        let rootOrder = root.content_order;
        if (typeof rootOrder === 'string') { try { rootOrder = JSON.parse(rootOrder); } catch { throw new Error('content_execution_order_identity_invalid'); } }
        const rootBinding = rootOrder as Record<string, unknown> | null;
        if (!rootBinding || rootBinding.contentId !== order.contentId || rootBinding.budgetTaskId !== order.budgetTaskId)
          throw new Error('content_execution_order_identity_invalid');
        if (rootBinding.cancellation || rootBinding.replacedByContentId || ['cancelled','cancelling'].includes(String(root.status)))
          throw new Error('content_execution_order_cancelled_or_replaced');
      }
      if (order.programId && order.originWeek && order.contentId) {
        const pools = await input.dataStore.list<Record<string, unknown>>('social_content_creation_quotas', {
          where: { tenant_id: tenantId, program_id: String(order.programId), week_start: String(order.originWeek) }, perPage: 2,
        });
        if (pools.totalItems !== 1 || pools.items.length !== 1) throw new Error('content_execution_order_quota_missing');
        const payload = pools.items[0].payload as { orders?: Record<string, { state?: string }> } | undefined;
        const reservation = payload?.orders?.[String(order.contentId)];
        if (!reservation || ['planned','released'].includes(String(reservation.state))) throw new Error('content_execution_order_not_reserved');
      }
    }
  }
  const now = (input.now ?? new Date()).toISOString();
  let patch: Record<string, unknown>;
  if (input.action === 'pause') {
    if (['succeeded', 'cancelled'].includes(current.status)) throw new Error('content_execution_job_not_pauseable');
    const origin = input.pauseOrigin ?? 'manual';
    const priorOrigin = (current.checkpoints['runtime.pause']?.payload as { origin?: string } | undefined)?.origin;
    // An existing pause belongs to the controller that created it. Automated
    // run/handoff controls must never relabel a customer pause (or each other),
    // otherwise a later resume could restart work the customer still expects
    // to remain stopped. The explicit per-job customer pause remains the sole
    // exception: it may replace an automated review wait.
    if (current.status === 'paused' && origin !== 'manual' && priorOrigin !== origin) return current;
    if (current.status === 'paused' && priorOrigin === origin) return current;
    patch = { status: 'paused', next_attempt_at: '', updated_at: now, checkpoints: {
      ...current.checkpoints,
      'runtime.pause': { version: '1', inputHash: current.id, payload: { origin }, updatedAt: now },
    } };
  } else if (input.action === 'cancel') {
    if (current.status === 'succeeded') throw new Error('content_execution_job_not_cancellable');
    if (current.status === 'cancelled') return current;
    patch = { status: 'cancelled', next_attempt_at: '', completed_at: now, updated_at: now };
  } else if (input.action === 'resume') {
    // Browser double-clicks and retried HTTP responses are expected. If the
    // first request already moved this exact durable job back into an active
    // state, the replay is a successful no-op rather than a second execution.
    if (['queued', 'running', 'retry_wait', 'reconciling'].includes(current.status)) return current;
    if (!['paused', 'cancelled'].includes(current.status)) throw new Error('content_execution_job_not_resumable');
    // A pause stops later stages; the original external call must settle first.
    // An expired lease cannot prove that an in-flight provider call has stopped.
    if (current.workerId !== null || current.leaseExpiresAt !== null) throw new Error('content_execution_original_worker_not_settled');
    const reconcile = hasProviderWork(current);
    patch = {
      status: reconcile ? 'reconciling' : 'queued',
      retry_class: reconcile ? 'provider_reconciliation' : '',
      next_attempt_at: now, worker_id: '', lease_expires_at: '', completed_at: '', updated_at: now,
    };
  } else {
    if (['queued', 'running', 'retry_wait', 'reconciling'].includes(current.status)) return current;
    if (!['blocked', 'dead_letter'].includes(current.status)) throw new Error('content_execution_job_not_retryable');
    if (!hasProviderWork(current) && frozenProductFootageRevisionRequired(current))
      throw new Error('content_execution_frozen_footage_revision_required');
    const reconcile = hasProviderWork(current);
    patch = {
      status: reconcile ? 'reconciling' : 'queued',
      retry_class: reconcile ? 'provider_reconciliation' : '',
      next_attempt_at: now, worker_id: '', lease_expires_at: '', last_error: '', completed_at: '',
      ...(reconcile ? {} : { attempt: 0, reconciliation_attempt: 0 }),
      checkpoints: {
        ...current.checkpoints,
        'runtime.retry': {
          version: '1', inputHash: current.id,
          payload: { action: 'retry', fromStatus: current.status }, updatedAt: now,
        },
      },
      updated_at: now,
    };
  }
  if (!await input.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, current.id, patch)) {
    throw new Error('content_execution_job_control_failed');
  }
  const saved = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, current.id);
  if (!saved) throw new Error('content_execution_job_control_readback_failed');
  return jobFromRow(saved);
}

/** Serialize customer controls and automated review waits so a review pause
 * cannot overwrite a concurrent explicit customer pause. */
export async function controlContentExecutionJob(input: Parameters<typeof applyContentExecutionControl>[0]): Promise<ContentExecutionJob> {
  const lease = await acquireDurableOperationLease({ dataStore: input.dataStore,
    tenantId: requiredIdentity(input.tenantId, 'tenant'), subjectId: requiredIdentity(input.jobId, 'job'),
    scope: 'content_execution_control', ownerId: `content-control:${randomUUID()}`, leaseDurationMs: 30_000 });
  if (!lease) throw new Error('content_execution_job_control_busy');
  try { return await applyContentExecutionControl(input); }
  finally { await releaseDurableOperationLease({ dataStore: input.dataStore, lease }).catch(() => undefined); }
}

function pauseOrigin(job: ContentExecutionJob): string {
  return String((job.checkpoints['runtime.pause']?.payload as { origin?: unknown } | undefined)?.origin || '');
}

async function jobsForRun(input: {
  dataStore: DataStore;
  tenantId: string;
  runId: string;
}): Promise<ContentExecutionJob[]> {
  const tenantId = requiredIdentity(input.tenantId, 'tenant');
  const runId = requiredIdentity(input.runId, 'run');
  return (await listAll<JobRow>(input.dataStore, CONTENT_EXECUTION_JOB_COLLECTION, {
    where: { tenant_id: tenantId, run_id: runId }, sort: 'created_at',
  })).map(jobFromRow);
}

/**
 * Stop every non-terminal production job owned by one workflow run. The run
 * lifecycle lock is held by the caller; individual durable-job leases fence a
 * concurrent worker/control request. Replays are safe and repair a partial
 * prior attempt without changing terminal jobs or a differently owned pause.
 */
export async function pauseContentExecutionJobsForRun(input: {
  dataStore: DataStore;
  tenantId: string;
  runId: string;
  origin: Exclude<ContentExecutionPauseOrigin, 'manual' | 'workflow_review'>;
  now?: Date;
}): Promise<ContentExecutionRunControlResult> {
  const jobs = await jobsForRun(input);
  const affectedJobIds: string[] = [];
  const preservedJobIds: string[] = [];
  const terminalJobIds: string[] = [];
  for (const job of jobs) {
    if (['succeeded', 'cancelled', 'dead_letter'].includes(job.status)) {
      terminalJobIds.push(job.id);
      continue;
    }
    // A domain blocker is not an actively executing queue state. Relabeling
    // it as a lifecycle pause would let a later run resume turn it into queued
    // work and bypass the original input/budget/policy blocker.
    if (job.status === 'blocked') {
      preservedJobIds.push(job.id);
      continue;
    }
    if (job.status === 'paused' && pauseOrigin(job) !== input.origin) {
      preservedJobIds.push(job.id);
      continue;
    }
    await controlContentExecutionJob({
      dataStore: input.dataStore,
      tenantId: input.tenantId,
      jobId: job.id,
      action: 'pause',
      pauseOrigin: input.origin,
      now: input.now,
    });
    affectedJobIds.push(job.id);
  }
  return { runId: input.runId, affectedJobIds, preservedJobIds, terminalJobIds };
}

/**
 * Resume only jobs paused by the matching run-level control. A preflight over
 * every candidate prevents a half-resume while an original paid worker is
 * still settling. Provider receipts, checkpoints and the durable job identity
 * are preserved by controlContentExecutionJob.
 */
export async function resumeContentExecutionJobsForRun(input: {
  dataStore: DataStore;
  tenantId: string;
  runId: string;
  origin: Exclude<ContentExecutionPauseOrigin, 'manual' | 'workflow_review'>;
  now?: Date;
}): Promise<ContentExecutionRunControlResult> {
  const jobs = await jobsForRun(input);
  const candidates = jobs.filter(job => job.status === 'paused' && pauseOrigin(job) === input.origin);
  if (candidates.some(job => job.workerId !== null || job.leaseExpiresAt !== null)) {
    throw new Error('content_execution_original_worker_not_settled');
  }
  const affectedJobIds: string[] = [];
  for (const job of candidates) {
    await controlContentExecutionJob({
      dataStore: input.dataStore,
      tenantId: input.tenantId,
      jobId: job.id,
      action: 'resume',
      now: input.now,
    });
    affectedJobIds.push(job.id);
  }
  return {
    runId: input.runId,
    affectedJobIds,
    preservedJobIds: jobs.filter(job => job.status === 'paused' && pauseOrigin(job) !== input.origin).map(job => job.id),
    terminalJobIds: jobs.filter(job => ['succeeded', 'cancelled', 'dead_letter'].includes(job.status)).map(job => job.id),
  };
}

/** Attach a frozen executor binding to a historic job only while there is
 * durable proof that execution has never crossed a provider or checkpoint
 * boundary. This is intentionally narrower than normal checkpoint writes:
 * it cannot migrate a partially executed job. */
