import {weeklyScopeMatches,type WeeklyScanScope} from './weeklyScanScope.js';
import type { WeeklyExecutionTask } from '../../shared/contracts/socialProgram.js';
import type { DataStore, Record_ } from '../storage/datastore.js';
import { getWeeklyExecutionTaskRow, withWeeklyExecutionTaskMutation, writeWeeklyExecutionTask, listWeeklyExecutionTasks, WEEKLY_EXECUTION_TASKS, type WeeklyExecutionTaskRow } from '../socialPrograms/executionTasks.js';
import { assessWeeklyRecovery, type WeeklyRecoveryInput } from '../socialPrograms/weeklyRecoveryAssessment.js';
import { SocialProgramError } from '../socialPrograms/service.js';
import { PACKAGES, type PackageRow } from '../socialPrograms/weeklyOperatingPackageSupport.js';
import { scheduleHash } from '../socialPrograms/weeklyScheduleSnapshots.js';
import { acquireDurableOperationLease, releaseDurableOperationLease } from './durableLease.js';
import {readIndependentAdmission} from '../socialPrograms/weeklyIndependentAdmission.js';

export const WEEKLY_DEADLINE_ASSESSMENTS = 'social_weekly_deadline_assessments';
export interface DeadlineRecoveryScope { tenantId: string; programId: string; packageId: string; packageVersion: number }
/** A port must read current budget, concurrency and work windows; frozen estimates are not fresh capacity. */
export type DeadlineRecoveryEvidenceReader = (scope: DeadlineRecoveryScope, tasks: WeeklyExecutionTask[], now: Date) => Promise<Pick<WeeklyRecoveryInput, 'constraints' | 'resources' | 'remainingBudgetCny'> | null>;
export function weeklyDeadlineTriggers(tasks: WeeklyExecutionTask[], now: Date) {
  return tasks.filter(task => !['succeeded', 'cancelled'].includes(task.status)).flatMap(task => {
    const dueAt = task.schedule.latestFinishAt || task.schedule.estimatedFinishAt;
    const due = Date.parse(dueAt || '');
    if (!Number.isFinite(due)) return [];
    const start = Date.parse(task.schedule.latestStartAt || '');
    const duration = task.schedule.estimatedDurationMinutes;
    const overdue = now.getTime() > due;
    const insufficient = Number.isFinite(start) && now.getTime() > start
      || Number.isFinite(duration) && duration >= 0 && now.getTime() + duration * 60_000 > due;
    return overdue || insufficient ? [{ taskId: task.taskId, dueAt, reason: overdue ? 'deadline_overdue' : 'remaining_time_insufficient' }] : [];
  });
}

/** Creates a durable evaluation of the original task graph; never revises dates or dispatches paid work. */
export async function runWeeklyDeadlineRecoveryScan(input: { dataStore: DataStore; now?: Date; scope?:WeeklyScanScope; readEvidence?: DeadlineRecoveryEvidenceReader }) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid deadline scan clock');
  const scopes = new Map<string, DeadlineRecoveryScope>();
  for (const status of ['queued', 'leased', 'blocked', 'dead_letter']) {
    for (let page = 1; ; page++) {
      const rows = await input.dataStore.list<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, { where: { status }, page, perPage: 500 });
      for (const row of rows.items) {
        const task = row.payload;
        if(!weeklyScopeMatches(input.scope,task))continue;
        if (!task || row.status !== task.status || !task.tenantId || !task.programId || !task.packageId || !Number.isInteger(task.packageVersion) || task.packageVersion < 1 || row.tenant_id !== task.tenantId || row.program_id !== task.programId || row.package_id !== task.packageId || row.package_version !== task.packageVersion) continue;
        const scope = { tenantId: task.tenantId, programId: task.programId, packageId: task.packageId, packageVersion: task.packageVersion };
        scopes.set(scheduleHash(scope), scope);
      }
      if (page >= rows.totalPages || !rows.items.length) break;
    }
  }
  async function projectAssessment(payload: NonNullable<WeeklyExecutionTask['deadlineRecovery']>, scope: DeadlineRecoveryScope, affected: Set<string>) {
    for (const taskId of affected) await withWeeklyExecutionTaskMutation(input.dataStore, scope.tenantId, taskId, async () => {
      const row = await getWeeklyExecutionTaskRow(input.dataStore, scope.tenantId, taskId);
      if (row.payload.programId !== scope.programId || row.payload.packageId !== scope.packageId || row.payload.packageVersion !== scope.packageVersion) throw new Error('Deadline projection scope changed');
      if (row.payload.deadlineRecovery?.assessmentId === payload.assessmentId) return;
      await writeWeeklyExecutionTask(input.dataStore, row, { ...row.payload, deadlineRecovery: { assessmentId: payload.assessmentId, assessedAt: payload.assessedAt, status: payload.status, blockingReasons: payload.blockingReasons, affectedPublicationIds: payload.affectedPublicationIds } });
    }).catch(error => { if (!(error instanceof SocialProgramError) || !['weekly_execution_package_frozen', 'weekly_execution_package_gate_busy'].includes(error.code)) throw error; });
  }
  const report = { evaluated: 0, created: 0, evidenceRequired: 0 };
  for (const [scopeKey, scope] of scopes) {
    const packages = await input.dataStore.list<PackageRow>(PACKAGES, { where: { tenant_id: scope.tenantId, program_id: scope.programId, package_id: scope.packageId, version: scope.packageVersion }, perPage: 2 });
    const pkg = packages.items[0]?.payload;
    if (packages.totalItems !== 1 || !pkg || pkg.programId !== scope.programId || pkg.packageId !== scope.packageId || pkg.version !== scope.packageVersion || !['active', 'draft'].includes(pkg.status)) continue;
    // Independent channel checks do not turn an unconfirmed content estimate
    // into a committed production calendar. Reassessing/projecting all 327
    // nodes on every preflight both invents an execution reservation and
    // monopolizes the local JSON store. Full/frozen schedules retain recovery.
    if(pkg.status==='draft'&&!('scheduleRevisionRef' in pkg)&&await readIndependentAdmission(input.dataStore,scope))continue;
    const lease = await acquireDurableOperationLease({ dataStore: input.dataStore, tenantId: scope.tenantId, scope: 'weekly-deadline-assessment', subjectId: scopeKey, ownerId: 'deadline-scan', now, leaseDurationMs: 120_000 });
    if (!lease) continue;
    try {
      const tasks = await listWeeklyExecutionTasks(input.dataStore, scope.tenantId, scope.programId, scope.packageId, scope.packageVersion);
      if (tasks.some(task => task.tenantId !== scope.tenantId || task.programId !== scope.programId || task.packageId !== scope.packageId || task.packageVersion !== scope.packageVersion)) throw new Error('Mixed deadline assessment scope');
      const triggers = weeklyDeadlineTriggers(tasks, now);
      if (!triggers.length) continue;
      report.evaluated++;
      const changedTaskIds = triggers.map(trigger => trigger.taskId);
      const affected = new Set(changedTaskIds);
      for (let pass = 0; pass < tasks.length; pass++) for (const task of tasks) if (task.dependsOnTaskIds.some(id => affected.has(id))) affected.add(task.taskId);
      const evidence = await input.readEvidence?.(scope, tasks, now);
      // No inferred zero budget or invented provider slots when real evidence is absent.
      const assessment = evidence ? assessWeeklyRecovery({ ...evidence, tasks, changedTaskIds, now: now.toISOString() }) : null;
      const evidenceHash = scheduleHash({ scope, triggers, tasks: tasks.map(task => ({ taskId: task.taskId, status: task.status, dependsOnTaskIds: task.dependsOnTaskIds, schedule: task.schedule, ownBlockingReasons: task.ownBlockingReasons, resultRefs: task.resultRefs })), evidence: evidence ?? null });
      const existing = await input.dataStore.list<Record_>(WEEKLY_DEADLINE_ASSESSMENTS, { where: { tenant_id: scope.tenantId, evidence_hash: evidenceHash }, perPage: 2 });
      if (existing.totalItems > 1 || existing.items.some(row => { const saved = row.payload as Record<string, unknown> | undefined; return !saved || row.tenant_id !== scope.tenantId || row.program_id !== scope.programId || row.package_id !== scope.packageId || row.package_version !== scope.packageVersion || row.evidence_hash !== evidenceHash || row.content_hash !== scheduleHash(saved) || saved.tenantId !== scope.tenantId || saved.programId !== scope.programId || saved.packageId !== scope.packageId || saved.packageVersion !== scope.packageVersion || saved.assessmentId !== `wda_${evidenceHash.slice(0, 24)}` || !['evaluated', 'blocked'].includes(String(saved.status)) || !Array.isArray(saved.blockingReasons) || !Array.isArray(saved.affectedPublicationIds); })) throw new Error('Invalid stored deadline assessment');
      if (!assessment) report.evidenceRequired++;
      if (existing.items.length) {
        await projectAssessment(existing.items[0]!.payload as { assessmentId: string; assessedAt: string; status: 'evaluated' | 'blocked'; blockingReasons: string[]; affectedPublicationIds: string[] }, scope, affected);
        continue;
      }
      const payload = { assessmentId: `wda_${evidenceHash.slice(0, 24)}`, ...scope, responsibleActor: 'business_agent', assessedAt: now.toISOString(), triggers, affectedTaskIds: [...affected].sort(), affectedPublicationIds: [...new Set(tasks.filter(task => affected.has(task.taskId) && task.publicationTaskId).map(task => task.publicationTaskId!))].sort(), status: assessment ? 'evaluated' as const : 'blocked' as const, blockingReasons: assessment ? [] : ['fresh_remaining_budget_capacity_work_windows_required'], assessment, revisionApplied: false, originalDeadlines: tasks.map(task => ({ taskId: task.taskId, latestFinishAt: task.schedule.latestFinishAt ?? null, estimatedFinishAt: task.schedule.estimatedFinishAt })) };
      const saved = await input.dataStore.create(WEEKLY_DEADLINE_ASSESSMENTS, { tenant_id: scope.tenantId, program_id: scope.programId, package_id: scope.packageId, package_version: scope.packageVersion, assessment_id: payload.assessmentId, evidence_hash: evidenceHash, content_hash: scheduleHash(payload), payload });
      if (!saved) throw new Error('Deadline assessment storage failed');
      report.created++;
      await projectAssessment(payload, scope, affected);
    } finally { await releaseDurableOperationLease({ dataStore: input.dataStore, lease }); }
  }
  return report;
}
