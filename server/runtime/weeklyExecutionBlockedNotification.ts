import type { DataStore } from '../storage/datastore.js';
import type { WeeklyExecutionTask } from '../../shared/contracts/socialProgram.js';
import { enqueueAgentNotificationDomainEvent } from '../notifications/agentNotificationOutbox.js';
import { WEEKLY_EXECUTION_TASKS, type WeeklyExecutionTaskRow } from '../socialPrograms/executionTasks.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';
import { weeklyScopeMatches, type WeeklyScanScope } from './weeklyScanScope.js';

export interface WeeklyBlockedNotificationProjectionResult {
  inspected: number;
  enqueued: number;
  failed: number;
}

function notificationEventId(task: WeeklyExecutionTask): string {
  return `weekly-execution-blocked:${socialRequestHash({
    tenantId: task.tenantId,
    programId: task.programId,
    packageId: task.packageId,
    packageVersion: task.packageVersion,
    taskId: task.taskId,
    code: task.lastError?.code,
    updatedAt: task.updatedAt,
  }).slice(0, 32)}`;
}

/**
 * Recoverable projection only. The execution task is already durably blocked
 * before this runs, so notification storage can never authorize, resume or
 * roll back business execution.
 */
export async function projectWeeklyBlockedTaskNotifications(input: {
  store: DataStore;
  scope?: WeeklyScanScope;
}): Promise<WeeklyBlockedNotificationProjectionResult> {
  const result: WeeklyBlockedNotificationProjectionResult = { inspected: 0, enqueued: 0, failed: 0 };
  for (let page = 1; ; page += 1) {
    const rows = await input.store.list<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, {
      where: { status: 'blocked' }, sort: 'updated_at', page, perPage: 500,
    });
    for (const row of rows.items) {
      const task = row.payload;
      if (row.tenant_id !== task?.tenantId || task.status !== 'blocked' || !weeklyScopeMatches(input.scope, task)) continue;
      // Descendants blocked only by their parent do not create alert storms.
      // A worker-owned exact gap has both a durable reason and lastError.
      const code = task.lastError?.code?.trim();
      if (!code || !task.ownBlockingReasons.includes(code)) continue;
      result.inspected += 1;
      try {
        await enqueueAgentNotificationDomainEvent({
          eventId: notificationEventId(task),
          kind: 'weekly_execution.blocked',
          tenantId: task.tenantId,
          programId: task.programId,
          packageId: task.packageId,
          packageVersion: task.packageVersion,
          taskId: task.taskId,
          entityId: task.taskId,
          title: '本周任务需要你处理',
          summary: task.lastError?.message?.trim() || `任务因 ${code} 暂停，请进入原任务详情处理。`,
          sourceAgent: '周任务执行器',
          changes: [{ field: 'executionStatus', label: '任务状态', before: 'running', after: { status: 'blocked', code } }],
          occurredAt: task.updatedAt,
        }, input.store);
        result.enqueued += 1;
      } catch {
        // A later scan replays the same deterministic event into the outbox.
        result.failed += 1;
      }
    }
    if (page >= rows.totalPages || !rows.items.length) break;
  }
  return result;
}
