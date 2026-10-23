import type { DataStore, Record_ } from '../storage/datastore.js';
import type { WeeklyExecutionTask } from '../../shared/contracts/socialProgram.js';
import { readIndependentAdmission } from '../socialPrograms/weeklyIndependentAdmission.js';
import { readWeeklyAutomaticPreproductionAdmission } from '../socialPrograms/weeklyAutomaticSchedule.js';
import { readWeeklyPreproductionExecutionGate,type WeeklyExactSettlementPortsForRun } from './weeklyPreproductionProducer.js';
import { supplementConsumerHash } from '../socialPrograms/weeklySupplementRequests.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';
import { withWeeklyExecutionTaskMutation, writeWeeklyExecutionTask, recomputePackageExecution, WEEKLY_EXECUTION_TASKS, type WeeklyExecutionTaskRow } from '../socialPrograms/executionTasks.js';
import { weeklyScopeMatches, type WeeklyScanScope } from './weeklyScanScope.js';

export const PREPRODUCTION_RECOVERIES = 'social_weekly_independent_preproduction_recoveries';
export const READONLY_PLANNING_GATES = new Set(['business_goal_unavailable', 'capacity_plan_unavailable', 'automation_policy_unavailable', 'business_dispatch_required', 'weekly_initial_capacity_schedule_required']);

/** Only reconciles already-produced, validated prerequisites. This cannot grant
 * factual, provider, financial, publication or customer-message authority. */
export async function runWeeklyIndependentPreproductionRecovery(input: { store: DataStore; now?: Date; scope?: WeeklyScanScope; exactAnalysisPortsForRun?:WeeklyExactSettlementPortsForRun }) {
  const report = { recovered: 0, skipped: 0, failed: 0, failures: [] as Array<{ taskId: string; code: string }> };
  const rows: WeeklyExecutionTaskRow[] = [];
  const where: Record<string,string|number> = input.scope ? {tenant_id:input.scope.tenantId,program_id:input.scope.programId,package_id:input.scope.packageId,package_version:input.scope.packageVersion} : {};
  for (let page = 1; ; page++) {
    const batch = await input.store.list<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, { where, page, perPage: 500, sort: 'id' });
    rows.push(...batch.items);
    if (page >= batch.totalPages) { if (rows.length !== batch.totalItems) throw Error('weekly_preproduction_recovery_scan_incomplete'); break; }
    if (!batch.items.length) throw Error('weekly_preproduction_recovery_scan_incomplete');
  }
  for (const row of rows) {
    const seed = row.payload;
    if (!weeklyScopeMatches(input.scope, seed) || !['business_outline', 'benchmark_collection'].includes(seed.schedule.stepKind) || !seed.ownBlockingReasons.some(code => READONLY_PLANNING_GATES.has(code))) continue;
    try {
      const recovered = await withWeeklyExecutionTaskMutation(input.store, seed.tenantId, seed.taskId, async () => {
        const current = await input.store.getById<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, row.id);
        if (!current || current.task_id !== seed.taskId) throw Error('weekly_preproduction_recovery_task_changed');
        const task = current.payload;
        if (task.packageVersion !== seed.packageVersion || task.lease || !['blocked', 'queued', 'pending_activation'].includes(task.status)) return false;
        const now = (input.now ?? new Date()).toISOString();
        const independent = await readIndependentAdmission(input.store, task);
        const automatic = await readWeeklyAutomaticPreproductionAdmission(input.store, task, now);
        const produced = await readWeeklyPreproductionExecutionGate(input.store, task, input.exactAnalysisPortsForRun);
        if (!independent || !automatic?.eligible || !produced.ready || !produced.resultRefs.length) return false;
        const removed = task.ownBlockingReasons.filter(code => READONLY_PLANNING_GATES.has(code));
        if (!removed.length) return false;
        const evidence = { schema: 'weekly-independent-preproduction-recovery.v1', scope: { tenantId: task.tenantId, programId: task.programId, packageId: task.packageId, packageVersion: task.packageVersion }, taskId: task.taskId, consumerInputHash: supplementConsumerHash(task), originalOwnReasons: task.ownBlockingReasons, removedReasons: removed, resultRefs: produced.resultRefs, automaticReceipt: automatic, independentAdmission: independent, authorizePublishing: false, authorizeMessaging: false };
        const id = socialRequestHash(evidence).slice(0, 32), existing = await input.store.getById<Record_>(PREPRODUCTION_RECOVERIES, id);
        if (existing && socialRequestHash(existing.payload) !== socialRequestHash(evidence)) throw Error('weekly_preproduction_recovery_receipt_conflict');
        if (!existing && !await input.store.create(PREPRODUCTION_RECOVERIES, { id, tenant_id: task.tenantId, program_id: task.programId, package_id: task.packageId, package_version: task.packageVersion, task_id: task.taskId, content_hash: socialRequestHash(evidence), recovered_at: now, payload: evidence })) throw Error('weekly_preproduction_recovery_receipt_write_failed');
        const next: WeeklyExecutionTask = { ...task, ownBlockingReasons: task.ownBlockingReasons.filter(code => !READONLY_PLANNING_GATES.has(code)), ...(task.lastError && removed.includes(task.lastError.code) ? { lastError: null } : {}), updatedAt: now };
        await writeWeeklyExecutionTask(input.store, current, next);
        await recomputePackageExecution(input.store, task.tenantId, task.programId, task.packageId, task.packageVersion, now);
        return true;
      });
      if (recovered) report.recovered++; else report.skipped++;
    } catch (error) { report.failed++; report.failures.push({ taskId: seed.taskId, code: error instanceof Error ? error.message : 'weekly_preproduction_recovery_failed' }); }
  }
  return report;
}
