import type { WeeklyExecutionTask } from '../../shared/contracts/socialProgram.js';

import type { RecoveryResource, RecoveryTaskConstraint } from '../../shared/contracts/socialWeeklyCapacity.js';
export type { RecoveryResource, RecoveryTaskConstraint } from '../../shared/contracts/socialWeeklyCapacity.js';
export interface WeeklyRecoveryInput {
  tasks: WeeklyExecutionTask[];
  changedTaskIds: string[];
  now: string;
  constraints: Record<string, RecoveryTaskConstraint>;
  resources: Record<string, RecoveryResource>;
  remainingBudgetCny: number;
}
export interface WeeklyRecoveryAssessment {
  affectedTaskIds: string[];
  affectedPublicationIds: string[];
  forecast: Array<{ taskId: string; startAt: string | null; finishAt: string | null; reasons: string[] }>;
  publications: Array<{ publicationId: string; taskId: string; affected: boolean; conditionallyReachable: boolean; reasons: string[] }>;
  targetPublicationCount: number;
  conditionallyReachableCount: number;
  publicationGap: number;
  reservedCostCny: number;
  confirmationRequired: boolean;
  proposedActions: Array<'resolve_inputs' | 'confirm_capacity_or_window_revision' | 'confirm_budget_revision'>;
  /** A forecast is neither approval nor an applied revision, and never changes reference quotas. */
  revisionApplied: false;
}
const instant = (value: string): number => {
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('Recovery timestamps require an explicit timezone');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid recovery timestamp');
  return result;
};
const terminalFailure = (task: WeeklyExecutionTask) => task.status === 'cancelled' || task.status === 'dead_letter';

/** Deterministic conservative capacity forecast. It does not persist tasks or approve human work. */
export function assessWeeklyRecovery(input: WeeklyRecoveryInput): WeeklyRecoveryAssessment {
  const now = instant(input.now);
  if (!Number.isFinite(input.remainingBudgetCny) || input.remainingBudgetCny < 0) throw new Error('Invalid remaining budget');
  const byId = new Map(input.tasks.map(task => [task.taskId, task]));
  if (byId.size !== input.tasks.length) throw new Error('Duplicate recovery task identity');
  const identities = new Set(input.tasks.map(task => JSON.stringify([task.tenantId,task.programId,task.packageId,task.packageVersion])));
  if (identities.size > 1 || input.tasks.some(task=>!task.tenantId || !task.programId || !task.packageId || !Number.isInteger(task.packageVersion))) throw new Error('Mixed or missing recovery authority identity');
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Recovery dependency cycle');
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error('Missing recovery dependency');
    visiting.add(id); task.dependsOnTaskIds.forEach(visit); visiting.delete(id); visited.add(id);
  };
  input.tasks.forEach(task => visit(task.taskId));
  const publicationIds = input.tasks.filter(task=>task.schedule.stepKind==='publishing' && task.publicationTaskId).map(task=>task.publicationTaskId);
  if (new Set(publicationIds).size !== publicationIds.length) throw new Error('Duplicate recovery publication identity');
  const affected = new Set<string>();
  input.changedTaskIds.forEach(id => { if (!byId.has(id)) throw new Error('Unknown changed task'); affected.add(id); });
  for (let pass = 0; pass < input.tasks.length; pass++) {
    for (const task of input.tasks) if (task.dependsOnTaskIds.some(id => affected.has(id))) affected.add(task.taskId);
  }
  const calendars = new Map<string, Array<Array<[number, number]>>>();
  const windows = new Map<string, Array<[number, number]>>();
  for (const [key, resource] of Object.entries(input.resources)) {
    if (!Number.isInteger(resource.concurrency) || resource.concurrency < 1) throw new Error('Invalid resource concurrency');
    const ranges = resource.workingWindows.map(window => [instant(window.startAt), instant(window.finishAt)] as [number, number]).sort((a,b)=>a[0]-b[0]);
    if (ranges.some((range,index)=>range[1] <= range[0] || index > 0 && range[0] < ranges[index-1]![1])) throw new Error('Invalid or overlapping work windows');
    calendars.set(key, Array.from({length:resource.concurrency},()=>[])); windows.set(key,ranges);
  }
  const forecasts = new Map<string, { taskId: string; startAt: string|null; finishAt: string|null; reasons: string[] }>();
  let reservedCostCny = 0;
  const pending = [...input.tasks];
  // Completed work consumes no remaining budget/capacity; remaining work retains all dependencies.
  while (pending.length) {
    const eligible = pending.filter(task=>task.dependsOnTaskIds.every(id=>forecasts.has(id))).sort((a,b)=>
      (a.status === 'leased' ? -1 : 0) - (b.status === 'leased' ? -1 : 0) ||
      (a.schedule.latestStartAt ? instant(a.schedule.latestStartAt) : Infinity) - (b.schedule.latestStartAt ? instant(b.schedule.latestStartAt) : Infinity) || a.taskId.localeCompare(b.taskId));
    const task = eligible[0]!;
    pending.splice(pending.indexOf(task),1);
    const row = { taskId: task.taskId, startAt:null as string|null, finishAt:null as string|null, reasons:[] as string[] };
    forecasts.set(task.taskId,row);
    if (task.status === 'succeeded') { row.finishAt = input.now; continue; }
    if (terminalFailure(task)) { row.reasons.push('task_requires_explicit_recovery'); continue; }
    if (task.ownBlockingReasons?.length) { row.reasons.push(...task.ownBlockingReasons); continue; }
    if (task.status === 'blocked' && !task.inheritedBlockingTaskIds?.length) { row.reasons.push('blocking_state_requires_verification'); continue; }
    if (task.dependsOnTaskIds.some(id=>forecasts.get(id)!.finishAt === null)) { row.reasons.push('dependency_unavailable'); continue; }
    const constraint = input.constraints[task.taskId];
    if (!constraint) { row.reasons.push('remaining_work_evidence_required'); continue; }
    if ([constraint.remainingMinutes,constraint.remainingCostCny,constraint.bufferMinutes].some(value=>!Number.isFinite(value)||value<0)) throw new Error('Invalid remaining work constraint');
    if (constraint.unresolvedReasons?.length) { row.reasons.push(...constraint.unresolvedReasons); continue; }
    const slots = calendars.get(constraint.resourceKey), ranges = windows.get(constraint.resourceKey);
    if (!slots || !ranges) { row.reasons.push('resource_capacity_evidence_required'); continue; }
    if (reservedCostCny + constraint.remainingCostCny > input.remainingBudgetCny) { row.reasons.push('remaining_budget_insufficient'); continue; }
    const ready = Math.max(now,instant(constraint.availableAt),...task.dependsOnTaskIds.map(id=>instant(forecasts.get(id)!.finishAt!)));
    const duration = (constraint.remainingMinutes + constraint.bufferMinutes)*60_000;
    let best: { start:number; finish:number; slot:Array<[number,number]> } | null = null;
    for (const slot of slots) for (const [open,close] of ranges) {
      let start = Math.max(ready,open);
      for (const [busyStart,busyFinish] of slot) {
        if (start + duration <= busyStart) break;
        if (start < busyFinish && start + duration > busyStart) start = busyFinish;
      }
      if (start + duration <= close && (!best || start < best.start)) best = {start,finish:start+duration,slot};
    }
    if (!best) { row.reasons.push('work_window_or_capacity_insufficient'); continue; }
    best.slot.push([best.start,best.finish]); best.slot.sort((a,b)=>a[0]-b[0]);
    reservedCostCny += constraint.remainingCostCny;
    row.startAt = new Date(best.start).toISOString(); row.finishAt = new Date(best.finish).toISOString();
    if (!task.schedule.latestFinishAt) row.reasons.push('precise_deadline_required');
    else if (best.finish > instant(task.schedule.latestFinishAt)) row.reasons.push('publication_deadline_at_risk');
    if (task.schedule.responsibleActor === 'user') row.reasons.push('human_completion_not_verified');
  }
  const publications = input.tasks.filter(task=>task.schedule.stepKind === 'publishing' && task.publicationTaskId).map(task=> {
    const ancestors = new Set<string>();
    const collect = (id:string)=> { if (ancestors.has(id)) return; ancestors.add(id); byId.get(id)!.dependsOnTaskIds.forEach(collect); };
    collect(task.taskId);
    const reasons = [...new Set([...ancestors].flatMap(id=>forecasts.get(id)!.reasons))];
    const blockers = reasons.filter(reason=>reason !== 'human_completion_not_verified');
    return {publicationId:task.publicationTaskId!,taskId:task.taskId,affected:affected.has(task.taskId),conditionallyReachable:blockers.length===0,reasons};
  });
  const reasons = [...forecasts.values()].flatMap(row=>row.reasons);
  const actions: WeeklyRecoveryAssessment['proposedActions'] = [];
  if (reasons.some(reason=>['dependency_unavailable','remaining_work_evidence_required','resource_capacity_evidence_required','task_requires_explicit_recovery','blocking_state_requires_verification'].includes(reason)) || input.tasks.some(task=>task.status!=='succeeded' && task.ownBlockingReasons?.length) || Object.values(input.constraints).some(c=>c.unresolvedReasons?.length)) actions.push('resolve_inputs');
  if (reasons.some(reason=>['publication_deadline_at_risk','work_window_or_capacity_insufficient','precise_deadline_required'].includes(reason))) actions.push('confirm_capacity_or_window_revision');
  if (reasons.includes('remaining_budget_insufficient')) actions.push('confirm_budget_revision');
  const reachable = publications.filter(publication=>publication.conditionallyReachable).length;
  return {affectedTaskIds:[...affected].sort(),affectedPublicationIds:[...new Set(publications.filter(p=>p.affected).map(p=>p.publicationId))].sort(),forecast:[...forecasts.values()],publications,targetPublicationCount:publications.length,conditionallyReachableCount:reachable,publicationGap:publications.length-reachable,reservedCostCny,confirmationRequired:actions.length>0 || reasons.includes('human_completion_not_verified'),proposedActions:actions,revisionApplied:false};
}
