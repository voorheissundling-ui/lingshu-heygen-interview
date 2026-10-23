/** 面试阅读注释：真实周消费者：领取、续租、延后、失败及完成。complete会再次核验持久化结果；调用方不能只写succeeded。 */
import {mayReconcileExistingWeeklyPlanning} from './socialWeeklyPlanningReconciliation.js';
import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';
import type { DataStore } from '../storage/datastore.js';
import type {
  VersionedSocialRef,
  WeeklyExecutionTask,
  WeeklyOperatingWorkflowKind,
} from '../../shared/contracts/socialProgram.js';
import {
  acquireDurableOperationLease,
  assertDurableOperationLease,
  releaseDurableOperationLease,
  renewDurableOperationLease,
  type DurableOperationLease,
} from './durableLease.js';
import {
  getWeeklyExecutionTaskRow,
  recomputePackageExecution,
  SOCIAL_WEEKLY_EXECUTION_LEASE_SCOPE,
  WEEKLY_EXECUTION_TASKS,
  withWeeklyExecutionTaskMutation,
  writeWeeklyExecutionTask,
  type WeeklyExecutionTaskRow,
} from '../socialPrograms/executionTasks.js';
import { validateWeeklyExecutionResults,type WeeklyExecutionResultValidationPorts } from './socialWeeklyResultValidation.js';
import { SocialProgramError } from '../socialPrograms/service.js';

export interface WeeklyExecutionClaim {
  task: WeeklyExecutionTask;
  lease: DurableOperationLease;
}

function sameLease(task: WeeklyExecutionTask, lease: DurableOperationLease): boolean {
  return task.lease?.leaseId === lease.id
    && task.lease.token === lease.token
    && task.lease.workerId === lease.ownerId
    && task.lease.expiresAt === lease.expiresAt;
}

export function compareWeeklyExecutionUrgency(left: WeeklyExecutionTask, right: WeeklyExecutionTask): number {
  const deadline = (task: WeeklyExecutionTask) => {
    const value = Date.parse(task.schedule?.latestStartAt || '');
    return Number.isFinite(value) ? value : Infinity;
  };
  const a = deadline(left), b = deadline(right);
  if (a !== b) return a < b ? -1 : 1;
  return left.createdAt.localeCompare(right.createdAt) || left.taskId.localeCompare(right.taskId);
}

async function candidates(dataStore: DataStore, tenantId: string): Promise<WeeklyExecutionTaskRow[]> {
  const all = async (status: string) => {
    const rows: WeeklyExecutionTaskRow[] = [];
    for (let page = 1; ; page += 1) {
      const result = await dataStore.list<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, {
        where: { tenant_id: tenantId, status }, sort: 'created_at', page, perPage: 500,
      });
      rows.push(...result.items.filter(row => row.tenant_id === tenantId && row.payload.tenantId === tenantId));
      if (page >= result.totalPages || !result.items.length) return rows;
    }
  };
  const [queued, leased] = await Promise.all([all('queued'), all('leased')]);
  return [...queued, ...leased].sort((left, right) => compareWeeklyExecutionUrgency(left.payload, right.payload));
}

/**
 * Storage-backed consumer port only. It intentionally has no discovery,
 * generation, production or publishing adapter; callers execute the claimed
 * snapshot and return versioned result references through complete().
 */
export function createSocialWeeklyExecutionWorker(dataStore: DataStore,validationPorts:WeeklyExecutionResultValidationPorts={}) {
  async function currentClaim(claim: WeeklyExecutionClaim, now: Date): Promise<WeeklyExecutionTaskRow> {
    await assertDurableOperationLease({ dataStore, lease: claim.lease, now, minimumRemainingMs: 1 });
    const row = await getWeeklyExecutionTaskRow(dataStore, claim.task.tenantId, claim.task.taskId);
    if (row.payload.status !== 'leased' || !sameLease(row.payload, claim.lease)) {
      throw new SocialProgramError('weekly_execution_lease_lost', 409, '执行任务租约已丢失。');
    }
    return row;
  }

  async function recompute(task: WeeklyExecutionTask, now: Date) {
    await recomputePackageExecution(
      dataStore, task.tenantId, task.programId, task.packageId, task.packageVersion, now.toISOString(), true,
    );
  }

  return {
    async claimNext(input: {
      tenantId: string;
      workerId: string;
      kinds?: WeeklyOperatingWorkflowKind[];
      now?: Date;
      leaseDurationMs?: number;
      reclaimGraceMs?: number;
      scope?:WeeklyScanScope;
    }): Promise<WeeklyExecutionClaim | null> {
      const now = input.now ?? new Date();
      let examined=0;
      for (const row of await candidates(dataStore, input.tenantId)) {
        if(++examined%32===0)await new Promise<void>(resolve=>setImmediate(resolve));
        const task = row.payload;
        if(!weeklyScopeMatches(input.scope,task))continue;
        if (input.kinds?.length && !input.kinds.includes(task.workflowKind)) continue;
        if (task.schedule?.responsibleActor === 'user') continue;
        if (task.status === 'queued' && Date.parse(task.schedule?.estimatedStartAt || '') > now.getTime() && !await mayReconcileExistingWeeklyPlanning(dataStore,task,now,validationPorts)) continue;
        if (task.status === 'queued' && task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now.getTime()) continue;
        if (task.status === 'leased' && task.lease && Date.parse(task.lease.expiresAt) > now.getTime()) continue;
        const lease = await acquireDurableOperationLease({
          dataStore,
          tenantId: input.tenantId,
          scope: SOCIAL_WEEKLY_EXECUTION_LEASE_SCOPE,
          subjectId: task.taskId,
          ownerId: input.workerId,
          now,
          leaseDurationMs: input.leaseDurationMs,
          reclaimGraceMs: input.reclaimGraceMs,
        });
        if (!lease) continue;
        try {
          const claimed = await withWeeklyExecutionTaskMutation(dataStore, input.tenantId, task.taskId, async () => {
            const latest = await getWeeklyExecutionTaskRow(dataStore, input.tenantId, task.taskId);
            if(!weeklyScopeMatches(input.scope,latest.payload))return null;
            if (!['queued', 'leased'].includes(latest.payload.status)) return null;
            if (latest.payload.schedule.responsibleActor === 'user' || latest.payload.ownBlockingReasons.length || latest.payload.inheritedBlockingTaskIds.length) return null;
            if (latest.payload.status === 'queued' && Date.parse(latest.payload.nextAttemptAt || '') > now.getTime()) return null;
            if (latest.payload.status === 'queued' && Date.parse(latest.payload.schedule.estimatedStartAt || '') > now.getTime() && !await mayReconcileExistingWeeklyPlanning(dataStore,latest.payload,now,validationPorts)) return null;
            for (const dependencyId of latest.payload.dependsOnTaskIds) {
              let dependency: WeeklyExecutionTask;
              try { dependency = (await getWeeklyExecutionTaskRow(dataStore, input.tenantId, dependencyId)).payload; }
              catch (error) { if (error instanceof SocialProgramError && error.code === 'weekly_execution_task_not_found') return null; throw error; }
              if (dependency.tenantId !== input.tenantId || dependency.taskId !== dependencyId || dependency.programId !== latest.payload.programId || dependency.packageId !== latest.payload.packageId || dependency.packageVersion !== latest.payload.packageVersion || dependency.status !== 'succeeded') return null;
            }
            const next: WeeklyExecutionTask = {
              ...latest.payload,
              status: 'leased',
              attempt: latest.payload.attempt + 1,
              nextAttemptAt: null,
              lease: {
                leaseId: lease.id,
                token: lease.token,
                workerId: lease.ownerId,
                acquiredAt: lease.acquiredAt,
                expiresAt: lease.expiresAt,
              },
              lastError: latest.payload.status === 'leased' ? {
                code: 'lease_expired', message: '上一个 Worker 租约过期，任务已被重新领取。', retryable: true, occurredAt: now.toISOString(),
              } : latest.payload.lastError,
              schedule: { ...latest.payload.schedule, actualStartedAt: latest.payload.schedule.actualStartedAt ?? now.toISOString() },
              updatedAt: now.toISOString(),
            };
            await writeWeeklyExecutionTask(dataStore, latest, next);
            return next;
          },'claim');
          if (!claimed) {
            await releaseDurableOperationLease({ dataStore, lease });
            continue;
          }
          return { task: claimed, lease };
        } catch (error) {
          await releaseDurableOperationLease({ dataStore, lease });
          if(error instanceof SocialProgramError&&['weekly_execution_package_frozen','weekly_execution_package_gate_busy'].includes(error.code))continue;
          throw error;
        }
      }
      return null;
    },

    async renew(claim: WeeklyExecutionClaim, input: { now?: Date; leaseDurationMs?: number } = {}): Promise<WeeklyExecutionClaim> {
      const now = input.now ?? new Date();
      return withWeeklyExecutionTaskMutation(dataStore, claim.task.tenantId, claim.task.taskId, async () => {
        const row = await currentClaim(claim, now);
        const lease = await renewDurableOperationLease({ dataStore, lease: claim.lease, now, leaseDurationMs: input.leaseDurationMs });
        const task: WeeklyExecutionTask = {
          ...row.payload,
          lease: { ...row.payload.lease!, expiresAt: lease.expiresAt },
          updatedAt: now.toISOString(),
        };
        await writeWeeklyExecutionTask(dataStore, row, task);
        return { task, lease };
      },'settlement');
    },

    async complete(claim: WeeklyExecutionClaim, resultRefs: VersionedSocialRef[], now = new Date()): Promise<WeeklyExecutionTask> {
      const task = await withWeeklyExecutionTaskMutation(dataStore, claim.task.tenantId, claim.task.taskId, async () => {
        const row = await currentClaim(claim, now);
        const validationStartedAt = Date.now();
        await validateWeeklyExecutionResults(dataStore, row.payload, resultRefs, now,validationPorts);
        await currentClaim(claim, new Date(now.getTime() + Math.max(0, Date.now() - validationStartedAt)));
        const next: WeeklyExecutionTask = {
          ...row.payload, status: 'succeeded', resultRefs: structuredClone(resultRefs), lease: null, productionProgress: null, lastError: null,
          nextAttemptAt: null,
          schedule: { ...row.payload.schedule, actualStartedAt: row.payload.schedule.actualStartedAt ?? now.toISOString(), actualFinishedAt: now.toISOString() },
          updatedAt: now.toISOString(),
        };
        await writeWeeklyExecutionTask(dataStore, row, next);
        return next;
      },'settlement');
      await releaseDurableOperationLease({ dataStore, lease: claim.lease });
      await recompute(task, now);
      return task;
    },

    async defer(claim: WeeklyExecutionClaim, input: { code: string; message: string; retryDelayMs?: number; progress?: WeeklyExecutionTask['productionProgress']; blockingReason?: string; now?: Date }): Promise<WeeklyExecutionTask> {
      const now = input.now ?? new Date();
      const task = await withWeeklyExecutionTaskMutation(dataStore, claim.task.tenantId, claim.task.taskId, async () => {
        const row = await currentClaim(claim, now);
        const blocked = Boolean(input.blockingReason);
        const next: WeeklyExecutionTask = {
          ...row.payload, productionProgress: input.progress ?? row.payload.productionProgress, status: blocked ? 'blocked' : 'queued', lease: null,
          attempt: Math.max(0, row.payload.attempt - 1),
          nextAttemptAt: blocked ? null : new Date(now.getTime() + Math.max(1000, Math.min(input.retryDelayMs ?? 30_000, 86_400_000))).toISOString(),
          ownBlockingReasons: blocked ? [...new Set([...row.payload.ownBlockingReasons, input.blockingReason!])] : row.payload.ownBlockingReasons,
          lastError: { code: input.code, message: input.message, retryable: !blocked, occurredAt: now.toISOString() },
          updatedAt: now.toISOString(),
        };
        await writeWeeklyExecutionTask(dataStore, row, next);
        return next;
      },'settlement');
      await releaseDurableOperationLease({ dataStore, lease: claim.lease });
      await recompute(task, now);
      return task;
    },

    async fail(claim: WeeklyExecutionClaim, input: {
      code: string;
      message: string;
      retryable: boolean;
      retryDelayMs?: number;
      now?: Date;
    }): Promise<WeeklyExecutionTask> {
      const now = input.now ?? new Date();
      const code = input.code.trim().slice(0, 120) || 'worker_failed';
      const balanceFailure = /balance|insufficient[_-]?fund|余额不足/i.test(code);
      const contentRejection = /content[_-]?(rejected|refused)|policy[_-]?rejection|内容拒绝/i.test(code);
      const networkFailure = /network|timeout|timed[_-]?out|econn|429|rate[_-]?limit/i.test(code);
      const systemFailure = /system|internal|5\d\d|provider[_-]?unavailable/i.test(code);
      const delay = Math.min(Math.max(Math.floor(input.retryDelayMs ?? (networkFailure ? 30_000 * Math.max(1, claim.task.attempt) : systemFailure ? 60_000 : 30_000)), 0), 24 * 60 * 60_000);
      const task = await withWeeklyExecutionTaskMutation(dataStore, claim.task.tenantId, claim.task.taskId, async () => {
        const row = await currentClaim(claim, now);
        const requiresUserAction = balanceFailure || contentRejection;
        const retry = !requiresUserAction && (networkFailure || systemFailure || input.retryable) && row.payload.attempt < row.payload.maxAttempts;
        const next: WeeklyExecutionTask = {
          ...row.payload,
          status: requiresUserAction ? 'blocked' : retry ? 'queued' : 'dead_letter',
          lease: null,
          nextAttemptAt: retry ? new Date(now.getTime() + delay).toISOString() : null,
          ownBlockingReasons: requiresUserAction
            ? [...new Set([...row.payload.ownBlockingReasons, balanceFailure ? 'balance_insufficient' : 'content_rejected_review_required'])]
            : row.payload.ownBlockingReasons,
          lastError: {
            code,
            message: input.message.trim().slice(0, 2_000) || '执行失败。',
            retryable: retry,
            occurredAt: now.toISOString(),
          },
          schedule: { ...row.payload.schedule, actualFinishedAt: null },
          updatedAt: now.toISOString(),
        };
        await writeWeeklyExecutionTask(dataStore, row, next);
        return next;
      },'settlement');
      await releaseDurableOperationLease({ dataStore, lease: claim.lease });
      await recompute(task, now);
      return task;
    },
  };
}
