import {INITIAL_CAPACITY_SCHEDULE_REQUIRED} from './weeklyInitialScheduleGate.js';
import type {WeeklyQueueSchedulingEvidence} from './weeklyQueueSchedulingEvidence.js';
import { publicationInstant } from './publicationDeadlines.js';
import type { WeeklyRecoveryInput } from './weeklyRecoveryAssessment.js';
import { weeklyReviewWindowBounds } from '../socialReview/weeklyReviewTiming.js';
import {createHash} from 'node:crypto';
import type {WeeklyExecutionTask,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';

type VerifiedWorkBase={taskFingerprint:string;verifiedAt:string;actualStartedAt:string};
export interface BackwardCompletedEvidence extends VerifiedWorkBase {actualFinishedAt:string;resultRefs:VersionedSocialRef[];}
export interface BackwardObservedReservation extends VerifiedWorkBase {leaseId:string;leaseTokenHash:string;leaseExpiresAt:string;expectedFinishAt:string;resourceKey:string;remainingCostCny:number;}
const stable=(value:unknown):string=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stable(item)}`).join(',')}}`:JSON.stringify(value);
/** Binds internal, freshly validated receipts to the complete stored task; not client authorization. */
export const backwardTaskEvidenceFingerprint=(task:WeeklyExecutionTask):string=>createHash('sha256').update(stable(task)).digest('hex');

export type WeeklyBackwardScheduleInput = Pick<WeeklyRecoveryInput, 'tasks' | 'now' | 'constraints' | 'resources' | 'remainingBudgetCny'> & {
  /** Explicit operating deadlines, never inferred from old forward estimates. */
  operationalDeadlines?:Record<string,string>;
  /** Read from the stored package by the caller, never accepted as client authority. */
  frozenOperationalWeek?:{weekStart:string;weekEnd:string};
  /** Internal only: caller must verify live outputs / durable leases under its shared source gate. */
  completedEvidence?:Record<string,BackwardCompletedEvidence>;
  observedReservations?:Record<string,BackwardObservedReservation>;
  /** Server-read independent queue dimensions, never client free-slot assumptions. */
  queueCapacityEvidence?:WeeklyQueueSchedulingEvidence;
  /** Server-derived from verified new_planned graph bindings only. This is a
   * future review assumption, never authority to clear the stored task gate. */
  conditionalPlanningGateTaskIds?:string[];
};
import type { WeeklyBackwardSchedule } from '../../shared/contracts/socialWeeklyCapacity.js';
export type { WeeklyBackwardSchedule } from '../../shared/contracts/socialWeeklyCapacity.js';
const instant = (value: string): number => {
  const parsed = publicationInstant(value);
  if (parsed === null) throw new Error('Invalid precise backward scheduling timestamp');
  return parsed;
};

/** Conservative, non-preemptive reverse allocation; suggestions never mutate or approve work. */
export function planWeeklyBackwardSchedule(input: WeeklyBackwardScheduleInput): WeeklyBackwardSchedule {
  const now = instant(input.now);
  if (!Number.isFinite(input.remainingBudgetCny) || input.remainingBudgetCny < 0) throw new Error('Invalid backward scheduling budget');
  const tasks = new Map(input.tasks.map(task => [task.taskId, task]));
  if(!tasks.size)throw Error('Backward scheduling tasks required');
  if (tasks.size !== input.tasks.length) throw new Error('Duplicate backward scheduling task');
  const scopes = new Set(input.tasks.map(task => JSON.stringify([task.tenantId, task.programId, task.packageId, task.packageVersion])));
  if (scopes.size > 1 || input.tasks.some(task => !task.tenantId || !task.programId || !task.packageId || !Number.isInteger(task.packageVersion) || task.packageVersion < 1)) throw new Error('Mixed or missing backward scheduling authority');
  const operationalDeadlines=new Map<string,number>(),crossWeekOperationalTaskIds:string[]=[];
  for(const [id,deadline] of Object.entries(input.operationalDeadlines??{})) {
    const task=tasks.get(id),week=input.frozenOperationalWeek;
    if(!task||!['business_schedule','performance_monitoring','weekly_review','template_extraction','template_performance_validation'].includes(task.schedule.stepKind))throw Error('Operational deadline requires an actual monitoring, planning or review task');
    if(!week||!/^\d{4}-\d{2}-\d{2}$/.test(week.weekStart)||!/^\d{4}-\d{2}-\d{2}$/.test(week.weekEnd)||publicationInstant(`${week.weekStart}T00:00:00Z`)===null||publicationInstant(`${week.weekEnd}T00:00:00Z`)===null||week.weekStart>week.weekEnd)throw Error('Frozen operational week evidence required');
    const parsed=instant(deadline),localDate=deadline.slice(0,10);
    if(localDate<week.weekStart)throw Error('Operational deadline precedes frozen week in its explicit timezone');
    if(localDate>week.weekEnd)crossWeekOperationalTaskIds.push(id);
    operationalDeadlines.set(id,parsed);
  }
  const ownDeadline=(id:string)=>{const task=tasks.get(id)!;return Math.min(task.schedule.latestFinishAt?instant(task.schedule.latestFinishAt):Infinity,operationalDeadlines.get(id)??Infinity);};
  const children = new Map(input.tasks.map(task => [task.taskId, [] as string[]]));
  for (const task of input.tasks) for (const parent of task.dependsOnTaskIds) {
    if (!tasks.has(parent)) throw new Error('Missing backward scheduling dependency');
    children.get(parent)!.push(task.taskId);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Backward scheduling dependency cycle');
    if (visited.has(id)) return;
    visiting.add(id); tasks.get(id)!.dependsOnTaskIds.forEach(visit); visiting.delete(id); visited.add(id);
  };
  input.tasks.forEach(task => visit(task.taskId));
  // Do not smooth a successor onto an early, quiet day that is earlier than
  // the fastest possible completion of its prerequisite chain. This lower
  // bound is conservative; resource collisions are still checked below.
  const earliestFinishMemo=new Map<string,number>();
  const earliestPossibleFinish=(id:string):number=>{const cached=earliestFinishMemo.get(id);if(cached!==undefined)return cached;const task=tasks.get(id)!,constraint=input.constraints[id];let start=Math.max(now,constraint?instant(constraint.availableAt):now,...task.dependsOnTaskIds.map(earliestPossibleFinish));if(task.inputSnapshot?.rollingCadence==='daily_incremental')start=Math.max(start,instant(task.schedule.estimatedStartAt));if(task.schedule.stepKind==='weekly_review'&&input.frozenOperationalWeek)start=Math.max(start,instant(weeklyReviewWindowBounds(input.frozenOperationalWeek).endsAt));const duration=constraint?(constraint.remainingMinutes+constraint.bufferMinutes)*60000:task.schedule.estimatedDurationMinutes*60000;const finish=start+duration;earliestFinishMemo.set(id,finish);return finish;};
  input.tasks.forEach(task=>earliestPossibleFinish(task.taskId));
  const publishing = input.tasks.filter(task => task.schedule.stepKind === 'publishing' && task.publicationTaskId);
  if (new Set(publishing.map(task => task.publicationTaskId)).size !== publishing.length) throw new Error('Duplicate backward scheduling publication');
  const windows = new Map<string, Array<[number, number,string]>>();
  const slots = new Map<string, Array<Array<[number, number]>>>();
  for (const [key, resource] of Object.entries(input.resources)) {
    if (!Number.isInteger(resource.concurrency) || resource.concurrency < 1) throw new Error('Invalid backward resource concurrency');
    const ranges = resource.workingWindows.map(window => [instant(window.startAt), instant(window.finishAt),window.startAt.slice(0,10)] as [number,number,string]).sort((a,b) => a[0]-b[0]);
    if (ranges.some((range,index) => range[1] <= range[0] || index > 0 && range[0] < ranges[index-1]![1])) throw new Error('Invalid or overlapping backward work windows');
    windows.set(key,ranges); slots.set(key,Array.from({length:resource.concurrency},()=>[]));
  }
  const vector=input.queueCapacityEvidence;
  if(vector&&(instant(vector.verifiedAt)!==now||! /^[a-f0-9]{64}$/.test(vector.configurationHash)||! /^[a-f0-9]{64}$/.test(vector.inputEvidenceHash)||Object.keys(vector.tasks).some(id=>!tasks.has(id))||Object.values(vector.pools).some(p=>!Number.isSafeInteger(p.concurrency)||p.concurrency<1)))throw Error('Invalid internal queue capacity evidence');
  const vectorIntervals=new Map<string,Array<{start:number;finish:number;subject:string}>>(Object.keys(vector?.pools??{}).map(key=>[key,[]]));
  // A resource may be a pool with explicit concurrency, but one named Agent
  // cannot be split over several arbitrary resource keys. Otherwise callers
  // could manufacture parallel capacity merely by adding calendar columns.
  const resourceByActor=new Map<WeeklyExecutionTask['schedule']['responsibleActor'],string>();
  for(const task of input.tasks){const key=input.constraints[task.taskId]?.resourceKey;if(!key)continue;const current=resourceByActor.get(task.schedule.responsibleActor);if(current&&current!==key)throw Error('One backward scheduling Agent requires one capacity resource');resourceByActor.set(task.schedule.responsibleActor,key);}
  const vectorFits=(taskId:string,start:number,finish:number)=>{const mapping=vector?.tasks[taskId];if(!mapping)return true;return mapping.resourceKeys.every(key=>{const pool=vector!.pools[key],intervals=vectorIntervals.get(key);if(!pool||!intervals)return false;const own=intervals.filter(x=>x.subject===mapping.productionSubjectId),begin=Math.min(start,...own.map(x=>x.start)),end=Math.max(finish,...own.map(x=>x.finish));const points=[begin,...intervals.filter(x=>x.start<end&&x.finish>begin).map(x=>Math.max(begin,x.start))];return points.every(at=>new Set([...intervals.filter(x=>x.start<=at&&x.finish>at).map(x=>x.subject),mapping.productionSubjectId!]).size<=pool.concurrency);});};
  const assignments = new Map<string, WeeklyBackwardSchedule['assignments'][number]>();
  const agentDailyLoad=new Map<string,{responsibleActor:WeeklyExecutionTask['schedule']['responsibleActor'];localDate:string;plannedMinutes:number;taskIds:string[]}>();
  const loadKey=(actor:WeeklyExecutionTask['schedule']['responsibleActor'],localDate:string)=>`${actor}:${localDate}`;
  const reserveLoad=(task:WeeklyExecutionTask,localDate:string,minutes:number)=>{const key=loadKey(task.schedule.responsibleActor,localDate),row=agentDailyLoad.get(key)??{responsibleActor:task.schedule.responsibleActor,localDate,plannedMinutes:0,taskIds:[]};row.plannedMinutes+=minutes;row.taskIds.push(task.taskId);agentDailyLoad.set(key,row);};
  const pending = [...input.tasks];
  let reservedCostCny = 0;
  const liveReservations=new Map<string,{evidence:BackwardObservedReservation;reasons:string[]}>();
  let unresolvedRunningCommitment=false;
  for(const id of [...Object.keys(input.completedEvidence??{}),...Object.keys(input.observedReservations??{})])if(!tasks.has(id))throw Error('Foreign internal backward work evidence');
  if(Object.keys(input.completedEvidence??{}).some(id=>tasks.get(id)!.status!=='succeeded')||Object.keys(input.observedReservations??{}).some(id=>tasks.get(id)!.status!=='leased'))throw Error('Internal backward work evidence status mismatch');
  // Already-running work owns its observed slot before any unstarted work can reserve capacity.
  for(const task of input.tasks.filter(task=>task.status==='leased')) {
    const evidence=input.observedReservations?.[task.taskId],constraint=input.constraints[task.taskId];
    if(!evidence){unresolvedRunningCommitment=true;continue;}
    const reasons:string[]=[];
    if(evidence.taskFingerprint!==backwardTaskEvidenceFingerprint(task)||instant(evidence.verifiedAt)!==now||!task.lease||evidence.leaseId!==task.lease.leaseId||evidence.leaseTokenHash!==createHash('sha256').update(task.lease.token).digest('hex')||evidence.leaseExpiresAt!==task.lease.expiresAt||instant(evidence.leaseExpiresAt)<=now||evidence.actualStartedAt!==task.schedule.actualStartedAt||instant(evidence.actualStartedAt)>now||instant(evidence.expectedFinishAt)<now) {unresolvedRunningCommitment=true;liveReservations.set(task.taskId,{evidence,reasons:['running_observation_invalid_or_stale']});continue;}
    if(!constraint||!evidence.resourceKey?.trim()||constraint.resourceKey!==evidence.resourceKey||!Number.isFinite(evidence.remainingCostCny)||evidence.remainingCostCny<0){unresolvedRunningCommitment=true;liveReservations.set(task.taskId,{evidence,reasons:['remaining_work_evidence_required']});continue;}
    if([constraint.remainingMinutes,constraint.bufferMinutes,constraint.remainingCostCny].some(value=>!Number.isFinite(value)||value<0))throw Error('Invalid running remaining work');
    if(instant(constraint.availableAt)>now||instant(evidence.expectedFinishAt)<now+(constraint.remainingMinutes+constraint.bufferMinutes)*60000)reasons.push('running_constraint_conflicts_with_observation');
    if(constraint.remainingCostCny<evidence.remainingCostCny)reasons.push('running_remaining_cost_understated');
    if(constraint.unresolvedReasons?.length)reasons.push(...constraint.unresolvedReasons);
    if(task.ownBlockingReasons?.length)reasons.push(...task.ownBlockingReasons);
    const calendars=slots.get(evidence.resourceKey),ranges=windows.get(evidence.resourceKey),finish=instant(evidence.expectedFinishAt);
    const slot=calendars?.find(slot=>slot.every(([start,end])=>finish<=start||now>=end));
    if(!slot||!ranges?.some(([start,end])=>start<=now&&end>=finish)){unresolvedRunningCommitment=true;reasons.push('observed_running_capacity_conflict');}
    else {slot.push([now,finish]);reserveLoad(task,new Date(now).toISOString().slice(0,10),Math.max(0,(finish-now)/60000));}
    reservedCostCny+=Math.max(constraint.remainingCostCny,evidence.remainingCostCny);
    if(reservedCostCny>input.remainingBudgetCny)reasons.push('remaining_budget_insufficient');
    if(finish>instant(evidence.leaseExpiresAt))reasons.push('running_lease_renewal_required');
    liveReservations.set(task.taskId,{evidence,reasons});
  }
  while (pending.length) {
    const eligible = pending.filter(task => children.get(task.taskId)!.every(id => assignments.has(id))).sort((a,b) =>
      ownDeadline(a.taskId)-ownDeadline(b.taskId) || a.taskId.localeCompare(b.taskId));
    const task = eligible[0]!; pending.splice(pending.indexOf(task),1);
    const constraint = input.constraints[task.taskId];
    const row:WeeklyBackwardSchedule['assignments'][number] = {taskId:task.taskId,startAt:null,finishAt:null,resourceKey:constraint?.resourceKey ?? null,reasons:[],mode:'unavailable'};
    assignments.set(task.taskId,row);
    if (task.status === 'succeeded') {
      const evidence=input.completedEvidence?.[task.taskId];
      if(!evidence||!task.schedule.actualStartedAt||!task.schedule.actualFinishedAt||!task.resultRefs?.length){row.reasons.push('completed_output_and_time_evidence_required');continue;}
      if(evidence.taskFingerprint!==backwardTaskEvidenceFingerprint(task)||instant(evidence.verifiedAt)!==now||evidence.actualStartedAt!==task.schedule.actualStartedAt||evidence.actualFinishedAt!==task.schedule.actualFinishedAt||instant(evidence.actualStartedAt)>instant(evidence.actualFinishedAt)||instant(evidence.actualFinishedAt)>now||stable(evidence.resultRefs)!==stable(task.resultRefs)||evidence.resultRefs.some(ref=>!ref.type||!ref.id||!Number.isSafeInteger(ref.version)||ref.version<1)){row.reasons.push('completed_work_evidence_invalid_or_stale');continue;}
      row.startAt=evidence.actualStartedAt;row.finishAt=evidence.actualFinishedAt;row.mode='completed_verified';continue;
    }
    if (task.schedule.responsibleActor === 'user') row.reasons.push('human_completion_not_verified');
    if (task.status === 'leased') {
      const observed=liveReservations.get(task.taskId);if(!observed){row.reasons.push('running_work_requires_observed_reservation');continue;}
      row.reasons.push(...observed.reasons);
      if(!row.reasons.some(reason=>!['human_completion_not_verified','running_lease_renewal_required'].includes(reason))){row.startAt=observed.evidence.actualStartedAt;row.finishAt=observed.evidence.expectedFinishAt;row.resourceKey=observed.evidence.resourceKey;row.mode='running_reserved';}
      continue;
    }
    if(task.schedule.actualStartedAt||task.resultRefs?.length||task.productionProgress?.runId){row.reasons.push('started_work_requires_verified_continuation');continue;}
    const queueMapping=vector?.tasks[task.taskId];
    if(queueMapping){if(queueMapping.taskFingerprint!==backwardTaskEvidenceFingerprint(task)){row.reasons.push('queue_task_evidence_changed');continue;}if(queueMapping.reasons.length){row.reasons.push(...queueMapping.reasons);continue;}if(!queueMapping.productionSubjectId||queueMapping.resourceKeys.length!==3||new Set(queueMapping.resourceKeys).size!==3||queueMapping.resourceKeys.some(key=>!vector!.pools[key])){row.reasons.push('queue_resource_vector_incomplete');continue;}if(queueMapping.resourceKeys.some(key=>vector!.pools[key]!.unknownRunningOccupation)){row.reasons.push('queue_running_finish_and_cost_unverified');continue;}}
    if(unresolvedRunningCommitment){row.reasons.push('running_commitment_evidence_required');continue;}
    if (task.status === 'cancelled' || task.status === 'dead_letter') { row.reasons.push('task_requires_explicit_recovery'); continue; }
    // Capacity confirmation is the purpose of this forecast; its own admission
    // blocker remains on the stored task until the resulting snapshot is applied.
    const futurePlanningReview=input.conditionalPlanningGateTaskIds?.includes(task.taskId)&&task.schedule.stepKind==='material_readiness'&&task.schedule.responsibleActor==='content_agent'&&task.ownBlockingReasons?.includes('business_dispatch_required')&&task.ownBlockingReasons.every(reason=>reason==='business_dispatch_required'||reason===INITIAL_CAPACITY_SCHEDULE_REQUIRED)&&!task.lease&&!task.attempt;
    if(futurePlanningReview)row.reasons.push('business_dispatch_review_required');
    const unresolvedOwnReasons=task.ownBlockingReasons?.filter(reason=>reason!==INITIAL_CAPACITY_SCHEDULE_REQUIRED&&!(futurePlanningReview&&reason==='business_dispatch_required'))??[];
    if (unresolvedOwnReasons.length) { row.reasons.push(...unresolvedOwnReasons); continue; }
    if (task.status === 'blocked' && !task.inheritedBlockingTaskIds?.length && !task.ownBlockingReasons?.includes(INITIAL_CAPACITY_SCHEDULE_REQUIRED)&&!futurePlanningReview) { row.reasons.push('blocking_state_requires_verification'); continue; }
    if(['performance_monitoring','weekly_review','template_extraction','template_performance_validation'].includes(task.schedule.stepKind)&&!task.schedule.latestFinishAt&&!operationalDeadlines.has(task.taskId)){row.reasons.push('operational_deadline_required');continue;}
    if (!constraint) { row.reasons.push('remaining_work_evidence_required'); continue; }
    if ([constraint.remainingMinutes,constraint.bufferMinutes,constraint.remainingCostCny].some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid backward remaining work');
    if (constraint.unresolvedReasons?.length) { row.reasons.push(...constraint.unresolvedReasons); continue; }
    const successors = children.get(task.taskId)!.map(id => assignments.get(id)!);
    if (successors.some(child => child.startAt === null)) { row.reasons.push('consumer_schedule_unavailable'); continue; }
    if (!Number.isFinite(ownDeadline(task.taskId)) && !successors.length) { row.reasons.push('precise_deadline_required'); continue; }
    const deadline = Math.min(ownDeadline(task.taskId),...successors.map(child => instant(child.startAt!)));
    if(task.schedule.stepKind==='weekly_review'&&!input.frozenOperationalWeek){row.reasons.push('weekly_review_window_evidence_required');continue;}
    const reviewAvailableAt=task.schedule.stepKind==='weekly_review'?instant(weeklyReviewWindowBounds(input.frozenOperationalWeek!).endsAt):-Infinity;
    const earliest = Math.max(now,instant(constraint.availableAt),reviewAvailableAt,...task.dependsOnTaskIds.map(earliestPossibleFinish));
    const duration = (constraint.remainingMinutes+constraint.bufferMinutes)*60_000;
    if(task.schedule.stepKind==='weekly_review'&&deadline<reviewAvailableAt+duration){row.reasons.push('weekly_review_window_still_open');continue;}
    const calendars = slots.get(constraint.resourceKey), ranges = windows.get(constraint.resourceKey);
    if (!calendars || !ranges) { row.reasons.push('resource_capacity_evidence_required'); continue; }
    if (reservedCostCny+constraint.remainingCostCny > input.remainingBudgetCny) { row.reasons.push('remaining_budget_insufficient'); continue; }
    let best: {start:number;finish:number;slot:Array<[number,number]>;localDate:string;resultingLoad:number}|null=null;
    for (const slot of calendars) for (const [open,close,localDate] of ranges) {
      const finishes=[Math.min(deadline,close),...slot.map(([start])=>start),...(queueMapping?.resourceKeys.flatMap(key=>vectorIntervals.get(key)!.map(x=>x.start))??[])];
      for(const finish of finishes){const start=finish-duration;
       if(finish>Math.min(deadline,close)||start<Math.max(open,earliest)||!slot.every(([a,b])=>finish<=a||start>=b)||!vectorFits(task.taskId,start,finish))continue;
       const resultingLoad=(agentDailyLoad.get(loadKey(task.schedule.responsibleActor,localDate))?.plannedMinutes??0)+duration/60000;
       if(!best||resultingLoad<best.resultingLoad||resultingLoad===best.resultingLoad&&finish>best.finish)best={start,finish,slot,localDate,resultingLoad};
      }
    }
    if (task.schedule.stepKind === 'publishing') {
      best=null;
      if (!task.schedule.latestStartAt) { row.reasons.push('precise_publish_time_required'); continue; }
      const start=instant(task.schedule.latestStartAt),finish=start+duration;
      for(const slot of calendars){const range=ranges.find(([open,close])=>start>=open&&finish<=close);if(start>=earliest&&finish<=deadline&&range&&slot.every(([busyStart,busyFinish])=>finish<=busyStart||start>=busyFinish)){const localDate=range[2];best={start,finish,slot,localDate,resultingLoad:(agentDailyLoad.get(loadKey(task.schedule.responsibleActor,localDate))?.plannedMinutes??0)+duration/60000};break;}}
    }
    if (!best) { row.reasons.push('work_window_or_capacity_insufficient'); continue; }
    if(queueMapping)for(const key of queueMapping.resourceKeys){const rows=vectorIntervals.get(key)!,own=rows.filter(x=>x.subject===queueMapping.productionSubjectId);vectorIntervals.set(key,[...rows.filter(x=>x.subject!==queueMapping.productionSubjectId),{start:Math.min(best.start,...own.map(x=>x.start)),finish:Math.max(best.finish,...own.map(x=>x.finish)),subject:queueMapping.productionSubjectId!}]);}
    best.slot.push([best.start,best.finish]);reserveLoad(task,best.localDate,duration/60000); reservedCostCny+=constraint.remainingCostCny;
    row.startAt=new Date(best.start).toISOString(); row.finishAt=new Date(best.finish).toISOString();row.mode='planned';
  }
  for(const task of input.tasks){const row=assignments.get(task.taskId)!;if(row.startAt&&task.dependsOnTaskIds.some(id=>{const parent=assignments.get(id)!;return parent.finishAt&&instant(parent.finishAt)>instant(row.startAt!);})){row.reasons.push('dependency_finish_after_consumer_start');}}
  // A successor's reservation is only conditionally reachable when every prerequisite fits.
  const publications = publishing.map(task => {
    const ancestors=new Set<string>();
    const collect=(id:string)=>{if(ancestors.has(id))return;ancestors.add(id);tasks.get(id)!.dependsOnTaskIds.forEach(collect);}; collect(task.taskId);
    const reasons=[...new Set([...ancestors].flatMap(id=>assignments.get(id)!.reasons))];
    return {publicationId:task.publicationTaskId!,conditionallyReachable:reasons.every(reason=>['human_completion_not_verified','running_lease_renewal_required','business_dispatch_review_required'].includes(reason)),reasons};
  });
  const reachable=publications.filter(publication=>publication.conditionallyReachable).length;
  const unscheduledTaskIds=[...assignments.values()].filter(row=>!row.startAt||!row.finishAt||row.reasons.some(reason=>!['human_completion_not_verified','running_lease_renewal_required','business_dispatch_review_required'].includes(reason))).map(row=>row.taskId);
  return {...(vector?{queueConfigurationHash:vector.configurationHash,queueCapacityEvidenceHash:vector.inputEvidenceHash}:{}),assignments:[...assignments.values()],publications,targetPublicationCount:publications.length,conditionallyReachableCount:reachable,publicationGap:publications.length-reachable,reservedCostCny,confirmationRequired:input.tasks.some(task=>task.status!=='succeeded'),fullGraphConditionallyReachable:unscheduledTaskIds.length===0,unscheduledTaskIds,crossWeekOperationalTaskIds:crossWeekOperationalTaskIds.sort(),agentDailyLoads:[...agentDailyLoad.values()].sort((a,b)=>a.responsibleActor.localeCompare(b.responsibleActor)||a.localDate.localeCompare(b.localDate)),revisionApplied:false};
}
