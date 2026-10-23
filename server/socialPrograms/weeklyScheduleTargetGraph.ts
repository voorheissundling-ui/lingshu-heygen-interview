import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {WeeklyScheduleCapacityInput,WeeklyScheduleTargetGraph} from '../../shared/contracts/socialWeeklyScheduleRevision.js';
import {scheduleHash,scheduleTaskSignature,scheduleTargetGraphFingerprint} from './weeklyScheduleSnapshots.js';
import {weeklyContinuationInputHash} from './weeklyExecutionContinuations.js';
import {backwardTaskEvidenceFingerprint,type BackwardCompletedEvidence,type BackwardObservedReservation} from './weeklyBackwardSchedule.js';
import {SocialProgramError} from './service.js';
function fail(code:string):never{throw new SocialProgramError(code,409,'目标版本任务图与真实来源不能安全对应。');}
export function buildWeeklyScheduleTargetGraph(source:WeeklyOperatingPackage,sourceTasks:WeeklyExecutionTask[],target:WeeklyOperatingPackage,targetTasks:WeeklyExecutionTask[]):WeeklyScheduleTargetGraph {
 if(!sourceTasks.length||!targetTasks.length)fail('weekly_schedule_target_graph_empty');
 const tenantId=sourceTasks[0]!.tenantId;if(!tenantId||!source.programId||!source.packageId||target.programId!==source.programId||target.packageId!==source.packageId||!Number.isSafeInteger(source.version)||source.version<1||target.version!==source.version+1||target.previousVersion!==source.version||![source.executionGraphVersion??1,target.executionGraphVersion??1].every(v=>Number.isSafeInteger(v)&&v>=1&&v<=3)||(target.executionGraphVersion??1)<(source.executionGraphVersion??1)||sourceTasks.some(t=>t.tenantId!==tenantId||t.programId!==source.programId||t.packageId!==source.packageId||t.packageVersion!==source.version)||targetTasks.some(t=>t.tenantId!==tenantId||t.programId!==target.programId||t.packageId!==target.packageId||t.packageVersion!==target.version))fail('weekly_schedule_target_graph_scope_invalid');
 const sourceBySignature=new Map(sourceTasks.map(t=>[scheduleTaskSignature(t),t])),targetById=new Map(targetTasks.map(t=>[t.taskId,t]));
 if(sourceBySignature.size!==sourceTasks.length||targetById.size!==targetTasks.length||new Set(targetTasks.map(scheduleTaskSignature)).size!==targetTasks.length)fail('weekly_schedule_task_mapping_ambiguous');
 const bindings=targetTasks.map(t=>{const signature=scheduleTaskSignature(t),old=sourceBySignature.get(signature);return {planningTaskId:old?.taskId??t.taskId,targetTaskId:t.taskId,sourceTaskId:old?.taskId??null,signature,origin:old?'existing_source' as const:'new_planned' as const};});
 if(sourceTasks.some(t=>!bindings.some(b=>b.sourceTaskId===t.taskId))||new Set(bindings.map(b=>b.planningTaskId)).size!==bindings.length)fail('weekly_schedule_target_graph_dropped_source_task');
 const bindingByTarget=new Map(bindings.map(b=>[b.targetTaskId,b]));
 const tasks=targetTasks.map(t=>{const binding=bindingByTarget.get(t.taskId)!,old=sourceBySignature.get(binding.signature);return {...(old??t),taskId:binding.planningTaskId,packageVersion:source.version,dependsOnTaskIds:t.dependsOnTaskIds.map(id=>bindingByTarget.get(id)?.planningTaskId??fail('weekly_schedule_target_dependency_missing')),schedule:{...t.schedule,actualStartedAt:old?.schedule.actualStartedAt??null,actualFinishedAt:old?.schedule.actualFinishedAt??null}};});
 const targetGraphHash=scheduleTargetGraphFingerprint(target,targetTasks,weeklyContinuationInputHash);
 return {tenantId:sourceTasks[0]!.tenantId,programId:source.programId,packageId:source.packageId,sourceVersion:source.version,targetVersion:target.version,executionGraphVersion:target.executionGraphVersion??1,targetGraphHash,tasks,bindings};
}
export function mapWeeklyScheduleCapacity(capacity:WeeklyScheduleCapacityInput,graph:WeeklyScheduleTargetGraph):WeeklyScheduleCapacityInput{
 const remap=<T>(values:Record<string,T>)=>{const out:Record<string,T>={};for(const [id,value]of Object.entries(values)){const binding=graph.bindings.find(b=>b.planningTaskId===id||b.targetTaskId===id);if(!binding)fail('weekly_schedule_foreign_constraint');if(binding.planningTaskId in out&&scheduleHash(out[binding.planningTaskId])!==scheduleHash(value))fail('weekly_schedule_constraint_mapping_conflict');out[binding.planningTaskId]=value;}return out;};
 return {...capacity,constraints:remap(capacity.constraints??{}),...(capacity.operationalDeadlines?{operationalDeadlines:remap(capacity.operationalDeadlines)}:{})};
}
export function mapWeeklyScheduleWorkEvidence(graph:WeeklyScheduleTargetGraph,sourceTasks:WeeklyExecutionTask[],targetTasks:WeeklyExecutionTask[],evidence:{completedEvidence:Record<string,BackwardCompletedEvidence>;observedReservations:Record<string,BackwardObservedReservation>}){
 const completedEvidence:Record<string,BackwardCompletedEvidence>={},observedReservations:Record<string,BackwardObservedReservation>={};
 for(const binding of graph.bindings){if(!binding.sourceTaskId)continue;const source=sourceTasks.find(t=>t.taskId===binding.sourceTaskId)!,target=targetTasks.find(t=>t.taskId===binding.targetTaskId)!,projected=graph.tasks.find(t=>t.taskId===binding.planningTaskId)!;
 const compatible=weeklyContinuationInputHash(source)===weeklyContinuationInputHash(target)&&source.dependsOnTaskIds.length===target.dependsOnTaskIds.length&&source.dependsOnTaskIds.every((id,index)=>{const old=sourceTasks.find(t=>t.taskId===id),fresh=targetTasks.find(t=>t.taskId===target.dependsOnTaskIds[index]);return old&&fresh&&scheduleTaskSignature(old)===scheduleTaskSignature(fresh)&&weeklyContinuationInputHash(old)===weeklyContinuationInputHash(fresh);});
 if(!compatible)continue;
 const done=evidence.completedEvidence[source.taskId];if(done)completedEvidence[projected.taskId]={...done,taskFingerprint:backwardTaskEvidenceFingerprint(projected)};
 const running=evidence.observedReservations[source.taskId];if(running)observedReservations[projected.taskId]={...running,taskFingerprint:backwardTaskEvidenceFingerprint(projected)};
 }
 return {completedEvidence,observedReservations};
}
