import type { WeeklyExecutionTask, SocialWeeklyPublicationTask } from '../../shared/contracts/socialProgram.js';
import { SocialProgramError } from './service.js';
import type {DataStore} from '../storage/datastore.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';

export function publicationInstant(window: string | null | undefined): number | null {
  if (!window || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(window)) return null;
  const [year, month, day] = window.slice(0,10).split('-').map(Number);
  const date = new Date(Date.UTC(year!, month!-1, day!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth()+1 !== month || date.getUTCDate() !== day) return null;
  const clock = window.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/)!;
  if (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] ?? 0) > 59) return null;
  const instant = Date.parse(window);
  return Number.isFinite(instant) ? instant : null;
}

/** The downstream production brief must finish before publication, too. Unknown
 * publication instants remain unknown rather than falling back to week end. */
export function publicationPreparationDeadline(window: string | null | undefined): string | null {
  const instant = publicationInstant(window);
  return instant === null ? null : new Date(instant - 30 * 60_000).toISOString();
}

/** Freeze production authority on the preceding day; this is deliberately
 * stricter than the rolling acceptance buffer used by execution scheduling. */
export function publicationProductionDeadline(window: string | null | undefined): string | null {
  const instant = publicationInstant(window);
  return instant === null ? null : new Date(instant - 86_400_000).toISOString();
}

/** Attach latest feasible deadlines without disguising forward-plan capacity or elapsed time. */
export function applyPublicationDeadlines(tasks: WeeklyExecutionTask[], publications: SocialWeeklyPublicationTask[]): WeeklyExecutionTask[] {
  const latestFinish = new Map<string, number>();
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  if (byId.size !== tasks.length) throw new SocialProgramError('weekly_execution_duplicate_task', 409, '执行排期存在重复任务身份。');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: WeeklyExecutionTask) => {
    if (visited.has(task.taskId)) return;
    if (visiting.has(task.taskId)) throw new SocialProgramError('weekly_execution_dependency_cycle', 409, '执行排期存在循环依赖，无法计算前置截止。');
    visiting.add(task.taskId);
    for (const id of task.dependsOnTaskIds) {
      const parent = byId.get(id);
      if (!parent) throw new SocialProgramError('weekly_execution_dependency_missing', 409, '执行排期引用了不存在的前置任务。');
      visit(parent);
    }
    visiting.delete(task.taskId); visited.add(task.taskId);
  };
  tasks.forEach(visit);
  const invalid = new Set<string>();
  const setEarlier = (id: string, deadline: number) => latestFinish.set(id, Math.min(latestFinish.get(id) ?? Infinity, deadline));
  // Always-on customer work has its own operating-day boundary, not a content
  // delivery dependency. Without it these independent leaf tasks make capacity
  // confirmation impossible (precise_deadline_required).
  for(const task of tasks){
    if(!['customer_channel_readiness','customer_inquiry_handoff'].includes(task.schedule.stepKind))continue;
    const day=task.inputSnapshot?.calendarAssignmentDate;
    if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))continue;
    const start=publicationInstant(`${day}T00:00:00+08:00`);
    if(start!==null)setEarlier(task.taskId,start+24*60*60_000);
  }
  for (const publication of publications) {
    const publishing = tasks.find(task => task.publicationTaskId === publication.publicationTaskId && task.schedule.stepKind === 'publishing');
    if (!publishing) continue;
    const instant = publicationInstant(publication.publishWindow);
    // Date ranges and timestamps without a zone are not precise publish instants.
    if (instant === null) {
      // Every prerequisite needs a precise target before its deadline can be trusted.
      const pending = [publishing.taskId];
      while (pending.length) {
        const id = pending.pop()!;
        if (invalid.has(id)) continue;
        invalid.add(id);
        pending.push(...(byId.get(id)?.dependsOnTaskIds ?? []));
      }
      continue;
    }
    setEarlier(publishing.taskId, instant + publishing.schedule.estimatedDurationMinutes * 60_000);
    // Daily rolling production keeps the final acceptance buffer explicit
    // without forcing every item to be completed on the preceding day.
    for (const parent of publishing.dependsOnTaskIds) setEarlier(parent, instant - 30 * 60_000);
  }
  // Iterate independently of input order; each predecessor must finish before successor starts.
  for (let pass = 0; pass < tasks.length; pass++) {
    let changed = false;
    for (const [id, finish] of [...latestFinish]) {
      const task = byId.get(id);
      if (!task || task.schedule.stepKind === 'publishing') continue;
      const start = finish - task.schedule.estimatedDurationMinutes * 60_000;
      for (const parent of task.dependsOnTaskIds) {
        if (start < (latestFinish.get(parent) ?? Infinity)) { setEarlier(parent, start); changed = true; }
      }
    }
    if (!changed) break;
  }
  return tasks.map(task => {
    const finish = latestFinish.get(task.taskId);
    const issues: string[] = [];
    if (invalid.has(task.taskId)) issues.push('precise_publish_time_required');
    if (finish !== undefined && Date.parse(task.schedule.estimatedFinishAt) > finish) issues.push('publication_deadline_at_risk');
    return { ...task, schedule: { ...task.schedule,
      latestFinishAt: finish === undefined ? null : new Date(finish).toISOString(),
      latestStartAt: finish === undefined ? null : new Date(finish - task.schedule.estimatedDurationMinutes * 60_000).toISOString(),
      planningRisks: issues,
    } };
  });
}

/** Only distribution deadlines use a recovery window. Original publication
 * dates remain the identity for collection, production, assignments and costs. */
export async function applyStoredPublicationRecoveryDeadlines(store:DataStore,tenantId:string,pkg:WeeklyOperatingPackage,tasks:WeeklyExecutionTask[]):Promise<WeeklyExecutionTask[]>{
 const {resolveWeeklyPublicationSchedule}=await import('./weeklyPublicationRecoverySchedule.js');
 const resolved=await Promise.all(pkg.socialContentPackage.publicationTasks.map(async pub=>({pub,schedule:await resolveWeeklyPublicationSchedule(store,tenantId,pkg,pub)})));
 if(!resolved.some(row=>row.schedule.recoveryRef))return tasks;
 const bound=await store.list<{id:string;task_id?:string}>('social_weekly_preproduction_jobs',{where:{tenant_id:tenantId,program_id:pkg.programId,package_id:pkg.packageId,package_version:pkg.version},perPage:1000});
 if(bound.totalItems!==bound.items.length)throw new SocialProgramError('weekly_publication_recovery_preproduction_scan_truncated',409,'已有采集绑定无法完整核验。');
 const boundIds=new Set(bound.items.map(row=>row.task_id));
 const projected=applyPublicationDeadlines(tasks,resolved.map(({pub,schedule})=>({...pub,publishWindow:schedule.plannedSendAt})));
 return projected.map(task=>{
  const original=tasks.find(t=>t.taskId===task.taskId)!;
  // Never reinterpret actual timestamps, leases, work or receipt history.
  if(boundIds.has(original.taskId)||original.attempt||original.lease||original.resultRefs.length||original.schedule.actualStartedAt||original.schedule.actualFinishedAt||original.productionProgress)return original;
  const recovery=resolved.find(row=>row.pub.publicationTaskId===task.publicationTaskId)?.schedule;
  if(task.schedule.stepKind!=='publishing'||!recovery?.recoveryRef||!recovery.plannedSendAt)return task;
  const start=publicationInstant(recovery.plannedSendAt)!;
  return {...task,inputSnapshot:{...task.inputSnapshot,publicationRecoveryScheduleRef:recovery.recoveryRef},upstreamVersionRefs:[...task.upstreamVersionRefs.filter(ref=>ref.type!=='weekly_publication_recovery_schedule'),recovery.recoveryRef],nextAttemptAt:new Date(start).toISOString(),schedule:{...task.schedule,estimatedStartAt:new Date(start).toISOString(),estimatedFinishAt:new Date(start+task.schedule.estimatedDurationMinutes*60000).toISOString()}};
 });
}
