import {INITIAL_CAPACITY_SCHEDULE_REQUIRED} from './weeklyInitialScheduleGate.js';
import {normalizeCustomerTaskDependencies} from './customerTaskDependencies.js';
import {createWeeklyExecutionContinuationService} from './weeklyExecutionContinuations.js';
import {withExecutionPackageGate,assertExecutionPackageGate,executionPackageFrozen} from './weeklyExecutionGate.js';
import {applyFrozenWeeklySchedule,scheduleHash} from './weeklyScheduleSnapshots.js';
import type {WeeklyScheduledPackage} from '../../shared/contracts/socialWeeklyScheduleRevision.js';
import { applyStoredPublicationRecoveryDeadlines } from './publicationDeadlines.js';
import { reconcileWeeklyCancellation } from './weeklyCancellation.js';
import { randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import {
  WEEKLY_EXECUTION_TASK_STATUSES,
  WEEKLY_OPERATING_WORKFLOW_KINDS,
  type VersionedSocialRef,
  type WeeklyBusinessContentDispatch,
  type WeeklyExecutionStatusSummary,
  type WeeklyExecutionTask,
  type WeeklyProductionStepKind,
  type WeeklyResponsibleActor,
  type WeeklyExecutionTaskStatus,
  type WeeklyOperatingPackage,
  type WeeklyOperatingWorkflow,
  type WeeklyOperatingWorkflowKind,
} from '../../shared/contracts/socialProgram.js';
import { SocialProgramError } from './service.js';
import { createStarter198Repository } from '../starter198/repository.js';
import { socialJson } from '../starter198/socialContentValidation.js';
import { validateContentArtifact } from '../runtime/socialWeeklyResultValidation.js';
import { decideSocialContentArtifact } from '../starter198/socialContentOutputs.js';
import {ensureWeeklyTaskWorkspaces} from './weeklyTaskWorkspaces.js';
import {
  acquireDurableOperationLease,
  releaseDurableOperationLease,
  type DurableOperationLease,
} from '../runtime/durableLease.js';

export const WEEKLY_EXECUTION_TASKS = 'social_weekly_execution_tasks';
export const SOCIAL_WEEKLY_EXECUTION_LEASE_SCOPE = 'social-weekly-execution';
const SOCIAL_WEEKLY_EXECUTION_MUTATION_SCOPE = 'social-weekly-execution-mutation';
const SOCIAL_WEEKLY_EXECUTION_PACKAGE_SCOPE = 'social-weekly-execution-package';

export type WeeklyExecutionTaskRow = {
  id: string;
  tenant_id: string;
  program_id: string;
  package_id: string;
  package_version: number;
  task_id: string;
  workflow_kind: WeeklyOperatingWorkflowKind;
  status: WeeklyExecutionTaskStatus;
  idempotency_key: string;
  next_attempt_at: string;
  payload: WeeklyExecutionTask;
  created_at: string;
  updated_at: string;
};


function normalizeExecutionTask(task: WeeklyExecutionTask): WeeklyExecutionTask {
  if (task.schedule) {
    return normalizeCustomerTaskDependencies(task);
  }
  const legacy = task as WeeklyExecutionTask & { schedule?: WeeklyExecutionTask['schedule'] };
  const mapping: Record<WeeklyOperatingWorkflowKind, { stepKind: WeeklyProductionStepKind; responsibleActor: WeeklyResponsibleActor; duration: number }> = {
    readiness: { stepKind: 'business_outline', responsibleActor: 'business_agent', duration: 15 },
    discovery: { stepKind: 'benchmark_collection', responsibleActor: 'director_agent', duration: 60 },
    directing: { stepKind: 'director_analysis', responsibleActor: 'director_agent', duration: 45 },
    content: { stepKind: 'video_generation', responsibleActor: 'content_agent', duration: 180 },
    publishing: { stepKind: 'publishing', responsibleActor: 'publishing_agent', duration: 10 },
    engagement: { stepKind: 'performance_monitoring', responsibleActor: 'business_agent', duration: 60 },
    review: { stepKind: 'weekly_review', responsibleActor: 'business_agent', duration: 45 },
  };
  const value = mapping[task.workflowKind];
  const start = task.createdAt;
  return {
    ...legacy,
    schedule: {
      stepKind: value.stepKind,
      responsibleActor: value.responsibleActor,
      estimatedDurationMinutes: value.duration,
      estimatedStartAt: start,
      estimatedFinishAt: new Date(Date.parse(start) + value.duration * 60_000).toISOString(),
      actualStartedAt: null,
      actualFinishedAt: null,
    },
  };
}

function emptyCounts(): Record<WeeklyExecutionTaskStatus, number> {
  return Object.fromEntries(WEEKLY_EXECUTION_TASK_STATUSES.map(status => [status, 0])) as Record<WeeklyExecutionTaskStatus, number>;
}

function workflowStatus(tasks: WeeklyExecutionTask[]): WeeklyOperatingWorkflow['status'] {
  if (tasks.length && tasks.every(task => task.status === 'cancelled')) return 'cancelled';
  if (tasks.length && tasks.every(task => task.status === 'succeeded' || task.status === 'cancelled')) return 'completed';
  // A workflow fans out into independently executable publication items. One
  // item's terminal/blocking state must remain visible in blockingReasons, but
  // must not project the whole workflow as stopped while a sibling can still
  // run. This is the package-level expression of ADR-026; task dependencies
  // remain the authority for which exact descendants are blocked.
  const hasRunnableOrProgress = tasks.some(task =>
    ['queued', 'leased'].includes(task.status)
    || (task.status === 'pending_activation' && !task.ownBlockingReasons.length));
  if (hasRunnableOrProgress) return 'in_progress';
  if (tasks.some(task => task.status === 'dead_letter' || task.status === 'blocked' || task.ownBlockingReasons.length)) return 'blocked';
  return 'planned';
}

export function summarizeWeeklyExecutionTasks(tasks: WeeklyExecutionTask[], refreshedAt = new Date().toISOString()): WeeklyExecutionStatusSummary {
  const byStatus = emptyCounts();
  for (const task of tasks) byStatus[task.status] += 1;
  const byWorkflow = Object.fromEntries(WEEKLY_OPERATING_WORKFLOW_KINDS.map(kind => [
    kind,
    workflowStatus(tasks.filter(task => task.workflowKind === kind)),
  ])) as WeeklyExecutionStatusSummary['byWorkflow'];
  return { total: tasks.length, byStatus, byWorkflow, refreshedAt };
}

export function projectWeeklyExecution(
  pkg: WeeklyOperatingPackage,
  tasks: WeeklyExecutionTask[],
  refreshedAt?: string,
): WeeklyOperatingPackage {
  const stableRefresh = refreshedAt ?? tasks.reduce(
    (latest, task) => task.updatedAt > latest ? task.updatedAt : latest,
    pkg.updatedAt,
  );
  const summary = summarizeWeeklyExecutionTasks(tasks, stableRefresh);
  const workflows = WEEKLY_OPERATING_WORKFLOW_KINDS.map(kind => {
    const matching = tasks.filter(task => task.workflowKind === kind);
    const existing = pkg.workflows.find(workflow => workflow.kind === kind);
    return {
      kind,
      status: summary.byWorkflow[kind],
      // Keep the seven stable summary references for R1/read-model compatibility;
      // executionTaskRefs is the explicit fan-out surface for workers.
      taskRefs: existing?.taskRefs ?? [],
      blockingReasons: [...new Set(matching.flatMap(task => [
        ...task.ownBlockingReasons,
        ...task.inheritedBlockingTaskIds.map(id => `upstream:${id}`),
        ...(task.status === 'dead_letter' && task.lastError ? [`dead_letter:${task.lastError.code}`] : []),
      ]))],
    };
  });
  return {
    ...pkg,
    workflows,
    executionTaskRefs: tasks.map(task => ({ type: 'weekly_execution_task', id: task.taskId, version: 1 })),
    executionSummary: summary,
  };
}

import { planWeeklyExecutionTasks } from './weeklyExecutionPlanner.js';
export { planWeeklyExecutionTasks } from './weeklyExecutionPlanner.js';

function rowData(task: WeeklyExecutionTask): Record<string, unknown> {
  return {
    tenant_id: task.tenantId,
    program_id: task.programId,
    package_id: task.packageId,
    package_version: task.packageVersion,
    task_id: task.taskId,
    workflow_kind: task.workflowKind,
    status: task.status,
    idempotency_key: task.idempotencyKey,
    next_attempt_at: task.nextAttemptAt ?? '',
    payload: task,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function durableLease(task: WeeklyExecutionTask): DurableOperationLease | null {
  return task.lease ? {
    id: task.lease.leaseId,
    tenantId: task.tenantId,
    scope: SOCIAL_WEEKLY_EXECUTION_LEASE_SCOPE,
    subjectId: task.taskId,
    token: task.lease.token,
    ownerId: task.lease.workerId,
    acquiredAt: task.lease.acquiredAt,
    expiresAt: task.lease.expiresAt,
  } : null;
}

export async function listWeeklyExecutionTasks(
  dataStore: DataStore,
  tenantId: string,
  programId: string,
  packageId: string,
  packageVersion: number,
): Promise<WeeklyExecutionTask[]> {
  const tasks:WeeklyExecutionTask[]=[],seen=new Set<string>();let total:number|undefined;
  for(let page=1;;page++){
    const result=await dataStore.list<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS,{where:{tenant_id:tenantId,program_id:programId,package_id:packageId,package_version:packageVersion},sort:'created_at,id',page,perPage:500});
    if(!Number.isSafeInteger(result.totalItems)||result.totalItems<0||!Number.isSafeInteger(result.totalPages)||total!==undefined&&total!==result.totalItems)throw new SocialProgramError('weekly_execution_task_pagination_invalid',409,'实际任务图分页发生变化，请重新读取。');total=result.totalItems;
    for(const row of result.items){if(seen.has(row.id))throw new SocialProgramError('weekly_execution_task_pagination_duplicate',409,'实际任务图分页重复。');seen.add(row.id);tasks.push(normalizeExecutionTask(row.payload));}
    if(page>=result.totalPages){if(tasks.length!==result.totalItems)throw new SocialProgramError('weekly_execution_task_pagination_truncated',409,'实际任务图分页不完整。');return tasks;}
    if(!result.items.length)throw new SocialProgramError('weekly_execution_task_pagination_truncated',409,'实际任务图分页不完整。');
  }
}

export async function materializeWeeklyExecutionTasks(
  dataStore: DataStore,
  tenantId: string,
  pkg: WeeklyOperatingPackage,
): Promise<WeeklyExecutionTask[]> {
  return withExecutionPackageGate(dataStore,{tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version},async assert=>{
  if(await executionPackageFrozen(dataStore,{tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version}))throw new SocialProgramError('weekly_execution_package_frozen',409,'原周版本已冻结，不能新增执行任务。');
  const planned = await applyStoredPublicationRecoveryDeadlines(dataStore,tenantId,pkg,await applyFrozenWeeklySchedule(dataStore,tenantId,pkg,planWeeklyExecutionTasks(tenantId, pkg, pkg.createdAt)));
  const existing = await listWeeklyExecutionTasks(dataStore, tenantId, pkg.programId, pkg.packageId, pkg.version);
  const stripContinuation=(t:WeeklyExecutionTask)=>{const inputSnapshot={...t.inputSnapshot};delete inputSnapshot.weeklyContinuationRef;return {...t,inputSnapshot,upstreamVersionRefs:t.upstreamVersionRefs.filter(ref=>ref.type!=='weekly_execution_continuation')};};
  const finishContinuations=async()=>{
    const service=createWeeklyExecutionContinuationService(dataStore);
    for(const plannedTask of planned.filter(t=>Boolean(t.inputSnapshot.weeklyContinuationPending))){
      const record=await service.ensureForTarget({tenantId,programId:pkg.programId,packageId:pkg.packageId,targetVersion:pkg.version,targetTaskId:plannedTask.taskId});
      if(!record)throw new SocialProgramError('weekly_execution_continuation_missing',409,'真实承接凭据缺失，未启动新生产。');
      const row=await getWeeklyExecutionTaskRow(dataStore,tenantId,plannedTask.taskId),actual=row.payload;
      const ref=actual.inputSnapshot.weeklyContinuationRef;
      const refs=actual.upstreamVersionRefs.filter(r=>r.type==='weekly_execution_continuation');
      if(ref||refs.length){if(scheduleHash(ref)!==scheduleHash(record.ref)||refs.length!==1||scheduleHash(refs[0])!==scheduleHash(record.ref))throw new SocialProgramError('weekly_execution_continuation_ref_changed',409,'承接引用与真实冻结凭据不一致。');continue;}
      await assert();await writeWeeklyExecutionTask(dataStore,row,{...actual,inputSnapshot:{...actual.inputSnapshot,weeklyContinuationRef:record.ref},upstreamVersionRefs:[...actual.upstreamVersionRefs,record.ref]});
    }
    const tasks=await listWeeklyExecutionTasks(dataStore,tenantId,pkg.programId,pkg.packageId,pkg.version);
    await ensureWeeklyTaskWorkspaces(dataStore,tasks);
    return tasks;
  };
  if (existing.length && ((pkg as WeeklyScheduledPackage).scheduleRevisionRef || (pkg as WeeklyOperatingPackage&{templateApplicationRef?:VersionedSocialRef}).templateApplicationRef)) {
    const expectedByKey=new Map(planned.map(t=>[t.idempotencyKey,t]));
    if(existing.length>planned.length||new Set(existing.map(t=>t.idempotencyKey)).size!==existing.length||existing.some(t=>{const expected=expectedByKey.get(t.idempotencyKey);return !expected||scheduleHash(stripContinuation(t))!==scheduleHash(expected);} ))throw new SocialProgramError('weekly_schedule_existing_task_mismatch',409,'冻结倒排已有任务不一致，不能覆盖已运行工作。');
    for(const task of planned.filter(t=>!existing.some(old=>old.idempotencyKey===t.idempotencyKey))){await assert();const row=await dataStore.create<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS,rowData(task));if(!row)throw new SocialProgramError('weekly_schedule_resume_storage_failed',503,'未完成的新草稿任务仍需恢复。');}
    return finishContinuations();
  }
  if (existing.length) {
    const expected = new Set(planned.map(item => item.idempotencyKey));
    if (existing.length !== planned.length || existing.some(item => !expected.has(item.idempotencyKey)||scheduleHash(item.dependsOnTaskIds)!==scheduleHash(planned.find(p=>p.idempotencyKey===item.idempotencyKey)!.dependsOnTaskIds))) {
      throw new SocialProgramError('weekly_execution_task_integrity_violation', 409, '周包执行任务集与当前版本不一致。');
    }
    const {refreshWeeklyPublicationRecoveryTaskSchedules}=await import('./weeklyPublicationRecoverySchedule.js');
    const recovered=await refreshWeeklyPublicationRecoveryTaskSchedules(dataStore,tenantId,pkg);
    await ensureWeeklyTaskWorkspaces(dataStore,recovered);
    return recovered;
  }
  const created: WeeklyExecutionTaskRow[] = [];
  try {
    for (const task of planned) {
      await assert();const row = await dataStore.create<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, rowData(task));
      if (!row) throw new Error('create returned null');
      created.push(row);
    }
  } catch {
    if(!(pkg as WeeklyOperatingPackage&{templateApplicationRef?:VersionedSocialRef}).templateApplicationRef)for (const row of created) await dataStore.delete(WEEKLY_EXECUTION_TASKS, row.id);
    throw new SocialProgramError('weekly_execution_task_storage_unavailable', 503, '周包执行任务暂时无法保存。');
  }
  return finishContinuations();
  });
}

async function taskRows(dataStore: DataStore, tenantId: string, taskIds: string[]): Promise<WeeklyExecutionTaskRow[]> {
  const rows: WeeklyExecutionTaskRow[] = [];
  for (const taskId of taskIds) {
    const result = await dataStore.list<WeeklyExecutionTaskRow>(WEEKLY_EXECUTION_TASKS, {
      where: { tenant_id: tenantId, task_id: taskId }, page: 1, perPage: 2,
    });
    if (result.items.length !== 1) throw new SocialProgramError('weekly_execution_task_not_found', 404, '周包执行任务不存在。');
    const row = result.items[0]!;
    rows.push({ ...row, payload: normalizeExecutionTask(row.payload) });
  }
  return rows;
}

export async function getWeeklyExecutionTaskRow(
  dataStore: DataStore,
  tenantId: string,
  taskId: string,
): Promise<WeeklyExecutionTaskRow> {
  return (await taskRows(dataStore, tenantId, [taskId]))[0]!;
}

/** Serialize state transitions across API processes and worker processes. */
export async function withWeeklyExecutionTaskMutation<T>(dataStore:DataStore,tenantId:string,taskId:string,operation:()=>Promise<T>,mode:'mutation'|'claim'|'settlement'|'cancellation'='mutation'):Promise<T>{
 const initial=await getWeeklyExecutionTaskRow(dataStore,tenantId,taskId);const scope={tenantId,programId:initial.payload.programId,packageId:initial.payload.packageId,packageVersion:initial.payload.packageVersion};
 return withExecutionPackageGate(dataStore,scope,async assert=>{
  const frozen=await executionPackageFrozen(dataStore,scope);if(frozen){const current=await getWeeklyExecutionTaskRow(dataStore,tenantId,taskId);if(mode!=='cancellation'&&(mode!=='settlement'||current.payload.status!=='leased'))throw new SocialProgramError('weekly_execution_package_frozen',409,'原周版本已冻结，不再接受新领取或状态编排。');}
  const lease=await acquireDurableOperationLease({dataStore,tenantId,scope:SOCIAL_WEEKLY_EXECUTION_MUTATION_SCOPE,subjectId:taskId,ownerId:`mutation-${randomUUID()}`,leaseDurationMs:30000});if(!lease)throw new SocialProgramError('weekly_execution_task_busy',409,'执行任务正在发生状态变更，请重试。');
  try{await assert();return await operation();}finally{await releaseDurableOperationLease({dataStore,lease});}
 });
}

export async function writeWeeklyExecutionTask(dataStore:DataStore,row:WeeklyExecutionTaskRow,task:WeeklyExecutionTask):Promise<void>{
 if(task.taskId!==row.payload.taskId||task.tenantId!==row.payload.tenantId||task.programId!==row.payload.programId||task.packageId!==row.payload.packageId||task.packageVersion!==row.payload.packageVersion||task.idempotencyKey!==row.payload.idempotencyKey)throw new SocialProgramError('weekly_execution_task_authority_mutation',409,'执行状态更新不能改变任务归属。');
 const scope={tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion};
 if(!await assertExecutionPackageGate(dataStore,scope))return withExecutionPackageGate(dataStore,scope,async assert=>{if(await executionPackageFrozen(dataStore,scope))throw new SocialProgramError('weekly_execution_package_frozen',409,'原周版本已冻结。');await assert();await writeWeeklyExecutionTask(dataStore,row,task);});
 if(!await dataStore.update(WEEKLY_EXECUTION_TASKS,row.id,rowData(task)))throw new SocialProgramError('weekly_execution_task_storage_unavailable',503,'周包执行任务暂时无法更新。');
}

function recompute(tasks: WeeklyExecutionTask[], now: string, activatePending: boolean): WeeklyExecutionTask[] {
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  return tasks.map(task => {
    if (['succeeded', 'cancelled', 'dead_letter', 'leased'].includes(task.status)) return task;
    if (task.status === 'pending_activation' && !activatePending) return task;
    const inherited = task.dependsOnTaskIds.filter(id => byId.get(id)?.status !== 'succeeded');
    const status: WeeklyExecutionTaskStatus = task.ownBlockingReasons.length || inherited.length ? 'blocked' : 'queued';
    if(status===task.status&&inherited.length===task.inheritedBlockingTaskIds.length&&inherited.every((id,index)=>id===task.inheritedBlockingTaskIds[index]))return task;
    return { ...task, status, inheritedBlockingTaskIds: inherited, updatedAt: now };
  });
}

export async function recomputePackageExecution(
  dataStore: DataStore,
  tenantId: string,
  programId: string,
  packageId: string,
  packageVersion: number,
  now = new Date().toISOString(),
  activatePending = true,
): Promise<WeeklyExecutionTask[]> {
  return withExecutionPackageGate(dataStore,{tenantId,programId,packageId,packageVersion},async()=>{
  if(await executionPackageFrozen(dataStore,{tenantId,programId,packageId,packageVersion}))return listWeeklyExecutionTasks(dataStore,tenantId,programId,packageId,packageVersion);
  let lease: DurableOperationLease | null = null;
  for (let attempt = 0; attempt < 40 && !lease; attempt += 1) {
    lease = await acquireDurableOperationLease({
      dataStore,
      tenantId,
      scope: SOCIAL_WEEKLY_EXECUTION_PACKAGE_SCOPE,
      subjectId: `${packageId}:${packageVersion}`,
      ownerId: `aggregate-${randomUUID()}`,
      leaseDurationMs: 30_000,
    });
    if (!lease) await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!lease) throw new SocialProgramError('weekly_execution_package_busy', 409, '周包执行状态正在聚合，请重试。');
  try {
    const current = await listWeeklyExecutionTasks(dataStore, tenantId, programId, packageId, packageVersion);
    // Recompute never changes succeeded membership. Every dependency therefore
    // sees the same completion set; one pass suffices, regardless of DAG order.
    // Preserve timestamps on unchanged nodes to avoid rewriting the full graph
    // on each worker settlement (327 local JSON writes per task previously).
    const next = recompute(current, now, activatePending);
    const changed = next.filter((task, index) => JSON.stringify(task) !== JSON.stringify(current[index]));
    if (changed.length) {
      const rows = await taskRows(dataStore, tenantId, changed.map(task => task.taskId));
      for (let index = 0; index < changed.length; index += 1) await writeWeeklyExecutionTask(dataStore, rows[index]!, changed[index]!);
    }
    return next;
  } finally {
    await releaseDurableOperationLease({ dataStore, lease });
  }
  });
}

export async function activateWeeklyExecutionTasks(
  dataStore: DataStore,
  tenantId: string,
  pkg: WeeklyOperatingPackage,
  now = new Date().toISOString(),
): Promise<WeeklyExecutionTask[]> {
  return recomputePackageExecution(dataStore, tenantId, pkg.programId, pkg.packageId, pkg.version, now, true);
}

export async function applyBusinessDispatchToExecutionTasks(
  dataStore: DataStore,
  tenantId: string,
  programId: string,
  packageId: string,
  packageVersion: number,
  dispatch: WeeklyBusinessContentDispatch,
  now = new Date().toISOString(),
): Promise<WeeklyExecutionTask[]> {
  if (dispatch.issuedBy !== 'business_agent' || dispatch.assignedTo !== 'content_agent') {
    throw new SocialProgramError('business_dispatch_authority_required', 403, '内容任务只能由经营 Agent 派给内容 Agent。');
  }
  const tasks = await listWeeklyExecutionTasks(dataStore, tenantId, programId, packageId, packageVersion);
  const targets = tasks.filter(task => task.schedule.stepKind === 'material_readiness' && (!dispatch.coverage || dispatch.scheduleItems.some(item => item.publicationTaskId === task.publicationTaskId)));
  for (const target of targets) {
    await withWeeklyExecutionTaskMutation(dataStore, tenantId, target.taskId, async () => {
      const row = await getWeeklyExecutionTaskRow(dataStore, tenantId, target.taskId);
      const detailedScheduleItem = dispatch.scheduleItems.find(item => item.publicationTaskId === row.payload.publicationTaskId);
      if (!detailedScheduleItem) throw new SocialProgramError('business_dispatch_lineage_invalid', 409, '经营派单缺少对应的逐条内容排期。');
      const next: WeeklyExecutionTask = {
        ...row.payload,
        ownBlockingReasons: row.payload.ownBlockingReasons.filter(reason => reason !== 'business_dispatch_required'),
        upstreamVersionRefs: [...row.payload.upstreamVersionRefs, { type: 'business_content_dispatch', id: dispatch.dispatchId, version: 1 }],
        inputSnapshot: { ...row.payload.inputSnapshot, dispatchRef: { type: 'business_content_dispatch', id: dispatch.dispatchId, version: 1 }, detailedScheduleItem: structuredClone(detailedScheduleItem) },
        updatedAt: now,
      };
      await writeWeeklyExecutionTask(dataStore, row, next);
    });
  }
  return recomputePackageExecution(dataStore, tenantId, programId, packageId, packageVersion, now, true);
}

export async function cancelWeeklyExecutionTasks(
  dataStore: DataStore,
  tenantId: string,
  programId: string,
  packageId: string,
  packageVersion: number,
  reason: string,
  now = new Date().toISOString(),
): Promise<WeeklyExecutionTask[]> {
  const current = await listWeeklyExecutionTasks(dataStore, tenantId, programId, packageId, packageVersion);
  await reconcileWeeklyCancellation({
    dataStore, tenantId, programId, packageId, packageVersion, reason, now,
    cancelPending: async () => {
  for (const candidate of current.filter(task => !['succeeded', 'cancelled'].includes(task.status))) {
    await withWeeklyExecutionTaskMutation(dataStore, tenantId, candidate.taskId, async () => {
      const row = await getWeeklyExecutionTaskRow(dataStore, tenantId, candidate.taskId);
      if (['succeeded', 'cancelled'].includes(row.payload.status)) return;
      const priorLease = durableLease(row.payload);
      await writeWeeklyExecutionTask(dataStore, row, {
        ...row.payload, status: 'cancelled', cancelReason: reason, lease: null, updatedAt: now,
      });
      if (priorLease) await releaseDurableOperationLease({ dataStore, lease: priorLease });
    },'cancellation');
  }
    },
  });
  return listWeeklyExecutionTasks(dataStore, tenantId, programId, packageId, packageVersion);
}

export function createWeeklyExecutionTaskService(dataStore: DataStore) {
  async function mutate(tenantId: string, programId: string, packageId: string, taskId: string, action: (task: WeeklyExecutionTask, now: string) => WeeklyExecutionTask | Promise<WeeklyExecutionTask>) {
    return withWeeklyExecutionTaskMutation(dataStore, tenantId, taskId, async () => {
      const [row] = await taskRows(dataStore, tenantId, [taskId]);
      if (row.payload.programId !== programId || row.payload.packageId !== packageId) {
        throw new SocialProgramError('weekly_execution_task_not_found', 404, '周包执行任务不存在。');
      }
      const now = new Date().toISOString();
      const next = await action(row.payload, now);
      await writeWeeklyExecutionTask(dataStore, row, next);
      const priorLease = durableLease(row.payload);
      if (priorLease && !next.lease) await releaseDurableOperationLease({ dataStore, lease: priorLease });
      return recomputePackageExecution(dataStore, tenantId, next.programId, next.packageId, next.packageVersion, now, true);
    });
  }
  return {
    list: (tenantId: string, programId: string, packageId: string, packageVersion: number) => (
      listWeeklyExecutionTasks(dataStore, tenantId, programId, packageId, packageVersion)
    ),
    async block(tenantId: string, programId: string, packageId: string, taskId: string, reason: string) {
      const normalized = reason.trim();
      if (!normalized) throw new SocialProgramError('weekly_execution_block_reason_required', 400, '阻塞必须提供原因。');
      return mutate(tenantId, programId, packageId, taskId, (task, now) => {
        if (['succeeded', 'cancelled', 'dead_letter'].includes(task.status)) throw new SocialProgramError('weekly_execution_task_terminal', 409, '终态任务不能阻塞。');
        return { ...task, status: 'blocked', ownBlockingReasons: [...new Set([...task.ownBlockingReasons, normalized])], lease: null, updatedAt: now };
      });
    },
    async unblock(tenantId: string, programId: string, packageId: string, taskId: string, reason?: string) {
      return mutate(tenantId, programId, packageId, taskId, (task, now) => {
        if (['succeeded', 'cancelled', 'dead_letter'].includes(task.status)) throw new SocialProgramError('weekly_execution_task_terminal', 409, '终态任务不能解除阻塞。');
        return {
          ...task,
          ownBlockingReasons: task.ownBlockingReasons.filter(item => item===INITIAL_CAPACITY_SCHEDULE_REQUIRED || (reason ? item!==reason : false)),
          ...(reason && task.lastError?.code === reason ? { lastError: null } : {}),
          updatedAt: now,
        };
      });
    },
    async cancel(tenantId: string, programId: string, packageId: string, taskId: string, reason: string) {
      return mutate(tenantId, programId, packageId, taskId, (task, now) => {
        if (task.status === 'succeeded') throw new SocialProgramError('weekly_execution_task_terminal', 409, '已成功任务不能取消。');
        return { ...task, status: 'cancelled', cancelReason: reason.trim() || 'cancelled', lease: null, updatedAt: now };
      });
    },
    async recoverDeadLetter(tenantId: string, programId: string, packageId: string, taskId: string) {
      return mutate(tenantId, programId, packageId, taskId, (task, now) => {
        if (task.status !== 'dead_letter') throw new SocialProgramError('weekly_execution_task_not_dead_letter', 409, '只能恢复死信任务。');
        return {
          ...task, status: 'queued', maxAttempts: Math.max(task.maxAttempts, task.attempt + 1),
          nextAttemptAt: null, lease: null, recoveredFromDeadLetterAt: now, updatedAt: now,
        };
      });
    },
    async approve(tenantId: string, programId: string, packageId: string, taskId: string, userId: string, expectedArtifactRef?:VersionedSocialRef) {
      return mutate(tenantId, programId, packageId, taskId, async (task, now) => {
        if (task.schedule.stepKind !== 'user_approval' || task.schedule.responsibleActor !== 'user') {
          throw new SocialProgramError('weekly_execution_task_not_user_approval', 409, '该节点不是用户审批节点。');
        }
        if (task.inheritedBlockingTaskIds.length) throw new SocialProgramError('weekly_execution_upstream_incomplete', 409, '上游生产步骤尚未完成。');
        if (['cancelled', 'dead_letter'].includes(task.status)) throw new SocialProgramError('weekly_execution_task_terminal', 409, '终态任务不能审批。');
        const { resolveWeeklyCreativeRepairApprovalEvidence } = await import('./weeklyCreativeRepairApprovalEvidence.js');
        const creativeRepair = await resolveWeeklyCreativeRepairApprovalEvidence(dataStore, task);
        if (creativeRepair && creativeRepair.caseItem.approvalTaskId !== task.taskId) {
          throw new SocialProgramError('weekly_creative_repair_approval_scope_changed', 409, '修订证据不属于当前审批任务。');
        }
        if (creativeRepair && task.ownBlockingReasons.length) throw new SocialProgramError('weekly_execution_upstream_incomplete', 409, '当前修订审批仍有未解除的阻断。');
        if (task.status === 'succeeded') {
          if (creativeRepair && (creativeRepair.artifact.status !== 'approved' || !task.resultRefs.some(ref =>
            ref.type === 'starter_social_content_artifact' && ref.id === creativeRepair.artifactRef.id && ref.version === creativeRepair.artifactRef.version))) {
            throw new SocialProgramError('weekly_creative_repair_approval_artifact_changed', 409, '已验收修订成片的身份或版本发生变化。');
          }
          return task;
        }
        const approvalDependencies = await taskRows(dataStore, tenantId, task.dependsOnTaskIds);
        if (approvalDependencies.length !== task.dependsOnTaskIds.length || approvalDependencies.some(row => row.payload.programId !== task.programId || row.payload.packageId !== task.packageId || row.payload.packageVersion !== task.packageVersion || row.payload.status !== 'succeeded')) {
          throw new SocialProgramError('weekly_execution_upstream_incomplete', 409, '本周真实前置任务尚未完成，不能验收。');
        }
        if (task.status === 'pending_activation') throw new SocialProgramError('weekly_execution_package_not_active', 409, '草案尚未启用，不能绕过前置任务验收。');
        if (task.inputSnapshot.inventoryReuseRef) {
          const actualDependencies = await taskRows(dataStore, tenantId, task.dependsOnTaskIds);
          if (actualDependencies.length !== task.dependsOnTaskIds.length || actualDependencies.some(row => row.payload.programId !== task.programId || row.payload.packageId !== task.packageId || row.payload.packageVersion !== task.packageVersion || row.payload.status !== 'succeeded')) {
            throw new SocialProgramError('weekly_execution_upstream_incomplete', 409, '本周真实前置任务尚未完成，不能验收库存。');
          }
          const { createInventoryUserApproval } = await import('../runtime/weeklyInventoryApprovalEvidence.js');
          const receipt = await createInventoryUserApproval(dataStore, task, userId, now);
          return { ...task, ...receipt, status: 'succeeded', schedule: { ...task.schedule, actualStartedAt: task.schedule.actualStartedAt ?? now, actualFinishedAt: now }, updatedAt: now };
        }
        const {resolveWeeklyProductionRow,currentSharedWeeklyArtifactRef}=await import('../runtime/weeklyContentProductionIdentity.js');
        const productionScope={tenantId,programId:task.programId,packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId!};
        const binding = creativeRepair?.contentTask ?? await resolveWeeklyProductionRow(dataStore,productionScope);
        if (!binding || binding.weekly_plan_id !== packageId) {
          throw new SocialProgramError('weekly_production_binding_required', 409, '尚未取得本条内容的真实生产身份，不能验收。');
        }
        const upstreamArtifactRefs = approvalDependencies.flatMap(row => row.payload.resultRefs)
          .filter(ref => ref.type === 'starter_social_content_artifact');
        const uniqueArtifactRefs = [...new Map(upstreamArtifactRefs.map(ref => [`${ref.id}:${ref.version}`, ref])).values()];
        if (!creativeRepair && uniqueArtifactRefs.length !== 1) {
          throw new SocialProgramError('weekly_production_approval_artifact_required', 409, '上游质检与返工任务没有唯一绑定同一条待验收成片。');
        }
        // A resolved revision has its own independent G4/G5 evidence. Preserve the
        // original quality task history and select the child only from sealed server records.
        const upstreamArtifactRef = creativeRepair?.artifactRef ?? await currentSharedWeeklyArtifactRef(dataStore,productionScope,uniqueArtifactRefs[0]!);
        if(expectedArtifactRef&&(expectedArtifactRef.type!=='starter_social_content_artifact'||expectedArtifactRef.id!==upstreamArtifactRef.id||expectedArtifactRef.version!==upstreamArtifactRef.version))throw new SocialProgramError('weekly_production_approval_artifact_changed',409,'预览成片与当前待验收版本不一致，请重新预览后验收。');
        const artifacts = await dataStore.list<any>('starter_social_content_artifacts', {
          where: { tenant_id: tenantId, task_id: String(binding.task_id), artifact_id: upstreamArtifactRef.id }, page: 1, perPage: 2,
        });
        const artifact = artifacts.totalItems === 1 ? { ...artifacts.items[0], content: socialJson(artifacts.items[0]?.content) } : null;
        if (artifact && Number(String(artifact.version).replace(/^v/, '')) !== upstreamArtifactRef.version) {
          throw new SocialProgramError('weekly_production_approval_artifact_changed', 409, '上游已核验成片版本发生变化，请重新完成对应质量任务。');
        }
        if (!artifact || !['review_required', 'approved'].includes(artifact.status)) {
          throw new SocialProgramError('weekly_production_artifact_not_reviewable', 409, '真实成片尚未就绪或质量检查未通过。');
        }
        await validateContentArtifact(dataStore, { ...task, workflowKind: 'content', schedule: { ...task.schedule, stepKind: 'quality_check' } }, {
          type: 'starter_social_content_artifact', id: artifact.artifact_id, version: Number(String(artifact.version).replace(/^v/, '')),
        });
        const sharedOriginal=(socialJson(binding.brief) as any)?._weeklyAuthority?.weeklyPackage?.socialContentPackage?.productionIdentityVersion==='shared-original.v1';
        const accepted = sharedOriginal&&artifact.status==='approved'&&!creativeRepair?{artifact:{artifactId:artifact.artifact_id,version:artifact.version}}:await decideSocialContentArtifact({
          repository: createStarter198Repository(dataStore), tenantId, userId,
          taskId: String(binding.task_id), artifactId: artifact.artifact_id,
          idempotencyKey: `weekly-content-approval:${task.taskId}:${artifact.artifact_id}`,
          value: { decision: 'approved', expectedVersion: creativeRepair
            ? `${String(artifact.version).startsWith('v') ? 'v' : ''}${creativeRepair.audit.childArtifactRef.version}`
            : String(artifact.version), note: '用户在周工作台确认本条真实成片' },
          now: new Date(now),
        });
        return {
          ...task,
          status: 'succeeded',
          resultRefs: [
            { type: 'user_content_approval', id: `${task.taskId}:${userId}`, version: 1 },
            { type: 'starter_social_content_artifact', id: accepted.artifact.artifactId, version: Number(String(accepted.artifact.version).replace(/^v/, '')) },
          ],
          schedule: { ...task.schedule, actualStartedAt: task.schedule.actualStartedAt ?? now, actualFinishedAt: now },
          updatedAt: now,
        };
      });
    },
  };
}
