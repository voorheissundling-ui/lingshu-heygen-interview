import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyAgentPlanningState,WeeklyExecutionTask,WeeklyOperatingPackage,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import {WEEKLY_AUTOMATION_TEMPLATE as template} from '../../shared/weeklyAutomationTemplate.js';
import {naturalWeek} from '../../shared/naturalWeek.js';
import {listContentExecutionLimits,type ContentExecutionLimit} from '../contentExecution/durableQueue.js';
import {canonicalWeeklyProductionPublication} from '../runtime/weeklyContentProductionIdentity.js';
import {weeklyContinuationInputHash} from './weeklyExecutionContinuations.js';
import {hasWeeklyInitialExecution} from './weeklyInitialExecution.js';
import {scheduleHash} from './weeklyScheduleSnapshots.js';
import {SocialProgramError} from './service.js';
import {verifiedWeeklyPlanningTemplateAdoption} from './weeklyPlanningTemplateAdoption.js';

export const WEEKLY_PRODUCTION_SCOPE_CAPACITIES='social_weekly_production_scope_capacities';
const BUDGET_POLICY_VERSION='weekly-per-film-10.v1' as const;
const allowed=new Set(['business_outline','benchmark_collection','benchmark_scoring','director_analysis','business_schedule','material_preparation','material_readiness','script','storyboard','asset_generation','video_generation','quality_check']);
const production=new Set(['material_preparation','material_readiness','script','storyboard','asset_generation','video_generation','quality_check']);
const fail=(code:string):never=>{throw new SocialProgramError(code,409,code);};
export interface ProductionScopeCapacity {
 proofId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 source:'automatic_template';templateVersion:string;adoptedAt:string;userApproval:null;
 budgetPolicyVersion:typeof BUDGET_POLICY_VERSION;
 selectedSlotIds:string[];selectedPublicationTaskIds:string[];planningRef:VersionedSocialRef;
 detailedScheduleHash:string;planningAdoptionHash:string;queueLimitsHash:string;packageProductionHash:string;
 concurrency:number;reservedBudgetCny:number;perFilmIncludingRevisionsMaxCny:10;
 authorizesPublishing:false;authorizesAcceptance:false;authorizesCustomerMessages:false;
 assignments:Array<{taskId:string;inputHash:string;dependencies:string[];estimatedDurationMinutes:number;startAt:string;finishAt:string;lane:number;motherContentId:string|null;reservedCny:number;mode:'planned'|'verified_completed';resultHash:string|null}>;
}
export interface ProductionScopeCapacityInput {
 pkg:WeeklyOperatingPackage;tasks:WeeklyExecutionTask[];planning:WeeklyAgentPlanningState;
 selectedSlotIds:string[];now:string;limits:ContentExecutionLimit[];
 /** Produced by the existing result validator/continuation service, never by UI. */
 verifiedCompletedTaskIds:ReadonlySet<string>;
}
const productionPackageHash=(p:WeeklyOperatingPackage)=>scheduleHash({programId:p.programId,packageId:p.packageId,version:p.version,weekStart:p.weekStart,weekEnd:p.weekEnd,productionIdentityVersion:p.socialContentPackage.productionIdentityVersion,publicationTasks:p.socialContentPackage.publicationTasks.map(({status,...v})=>v),weeklyBudgetCny:p.socialContentPackage.weeklyBudgetCny});
function queueCapacity(limits:ContentExecutionLimit[],tenantId:string){
 const relevant=limits.filter(l=>l.tenantId===tenantId&&(l.scope==='tenant'&&l.scopeKey==='*'||l.scope==='task_type'&&l.scopeKey==='social_content_weekly'));
 if(relevant.length!==2||!relevant.some(l=>l.scope==='tenant')||!relevant.some(l=>l.scope==='task_type')||relevant.some(l=>!Number.isInteger(l.maxRunning)||l.maxRunning<1||l.maxRunning>3))fail('weekly_production_scope_queue_limits_required');
 return {concurrency:Math.min(...relevant.map(l=>l.maxRunning)),hash:scheduleHash(relevant.map(l=>({id:l.id,tenantId:l.tenantId,scope:l.scope,scopeKey:l.scopeKey,maxRunning:l.maxRunning})).sort((a,b)=>a.id.localeCompare(b.id)))};
}

/** Production-only forward capacity, not a replacement for the complete weekly
 * schedule or a provider quote. Nothing here completes a task or grants rights.
 * Previously started production requires separate reconciled continuation: we
 * never turn its costs, unknown receipts or remaining work into zero. */
export function buildWeeklyProductionScopeCapacity(a:ProductionScopeCapacityInput):ProductionScopeCapacity {
 const {pkg,tasks,planning}=a,now=Date.parse(a.now),week=naturalWeek(a.now);
 if(['superseded','retired'].includes(pkg.status))fail('weekly_production_scope_package_inactive');
 if(!Number.isFinite(now)||pkg.weekStart!==week.start||pkg.weekEnd!==week.end)fail('weekly_production_scope_current_natural_week_required');
 if(pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1')fail('weekly_production_scope_shared_identity_required');
 const detail=planning.detailedSchedule;
 if(!detail||planning.packageId!==pkg.packageId||planning.packageVersion!==pkg.version||planning.programId!==pkg.programId)return fail('weekly_production_scope_detailed_analysis_required');
 const adoption=verifiedWeeklyPlanningTemplateAdoption(planning);
 if(!adoption||!['confirmed','dispatched'].includes(planning.status))return fail('weekly_production_scope_template_adoption_required');
 const selected=[...new Set(a.selectedSlotIds)].sort();
 if(!selected.length||selected.length!==a.selectedSlotIds.length||selected.some(id=>!adoption.selectedSlotIds.includes(id)))fail('weekly_production_scope_selection_invalid');
 const items=detail.items.filter(i=>selected.includes(i.slotId));
 if(selected.some(id=>!items.some(i=>i.slotId===id))||items.some(i=>i.directorAnalysisRef?.type!=='weekly_director_analysis'||i.directorAnalysisRef.version!==1||!planning.directorAnalyses.some(d=>d.analysisId===i.directorAnalysisRef.id&&d.packageId===pkg.packageId&&d.packageVersion===pkg.version&&d.slotId===i.slotId)))fail('weekly_production_scope_actual_analysis_required');
 const publications=[...new Set(items.map(i=>canonicalWeeklyProductionPublication(pkg,i.publicationTaskId).publicationTaskId))].sort();
 const roots=new Set(publications.map(id=>canonicalWeeklyProductionPublication(pkg,id).motherContentId!));
 if(roots.size>template.originalVideosPerWeek)fail('weekly_production_scope_original_quota_exceeded');
 const scope={tenantId:tasks[0]?.tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version};
 if(!scope.tenantId||tasks.some(t=>t.tenantId!==scope.tenantId||t.programId!==scope.programId||t.packageId!==scope.packageId||t.packageVersion!==scope.packageVersion))fail('weekly_production_scope_task_identity_invalid');
 const byId=new Map(tasks.map(t=>[t.taskId,t]));if(byId.size!==tasks.length)fail('weekly_production_scope_duplicate_task');
 const required=new Set<string>();
 function include(id:string){if(required.has(id))return;const task=byId.get(id);if(!task)fail('weekly_production_scope_dependency_missing');if(!allowed.has(task!.schedule.stepKind))fail('weekly_production_scope_external_dependency_required');required.add(id);for(const dependency of task!.dependsOnTaskIds)include(dependency);}
 for(const id of publications){const quality=tasks.filter(t=>t.publicationTaskId===id&&t.schedule.stepKind==='quality_check');if(quality.length!==1)fail('weekly_production_scope_quality_node_required');include(quality[0]!.taskId);}
 // An older sibling platform node is not a new free production just because
 // the canonical node's dependency closure no longer includes it.
 for(const task of tasks){const pub=pkg.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===task.publicationTaskId);if(pub?.motherContentId&&roots.has(pub.motherContentId)&&production.has(task.schedule.stepKind)&&hasWeeklyInitialExecution(task))fail('weekly_production_scope_existing_work_requires_reconciliation');}
 const queue=queueCapacity(a.limits,scope.tenantId),lanes=Array(queue.concurrency).fill(now) as number[];
 const configuredPerItem=pkg.socialContentPackage.perItemBudgetCny;
 if(configuredPerItem!==null&&configuredPerItem!==undefined&&(!Number.isFinite(configuredPerItem)||configuredPerItem<0))fail('weekly_production_scope_item_budget_invalid');
 const perFilmBudgetCny=Math.min(template.perFinishedVideoMaxCny,configuredPerItem??template.perFinishedVideoMaxCny);
 if(tasks.some(task=>production.has(task.schedule.stepKind)&&task.budget.category==='production'&&task.budget.limitCny!==null&&task.budget.limitCny>perFilmBudgetCny))fail('weekly_production_scope_task_budget_exceeds_item_limit');
 const end=Date.parse(`${pkg.weekEnd}T23:59:59+08:00`),assignments:ProductionScopeCapacity['assignments']=[],done=new Map<string,number>(),pending=new Set(required),reserved=new Set<string>();
 const window=(instant:number,duration:number)=>{let start=instant;while(start<=end){const day=new Date(start+8*3600000).toISOString().slice(0,10),earliest=Date.parse(`${day}T06:00:00+08:00`),midnight=Date.parse(`${day}T00:00:00+08:00`)+86400000;start=Math.max(start,earliest);if(start+duration<=midnight&&start+duration<=end)return start;start=midnight;}return fail('weekly_production_scope_capacity_infeasible');};
 while(pending.size){let advanced=false;for(const id of [...pending].sort()){
  const task=byId.get(id)!;if(task.dependsOnTaskIds.some(dep=>!done.has(dep)))continue;
  if(['cancelled','failed','dead_letter','running'].includes(task.status)||task.lease)fail('weekly_production_scope_existing_work_requires_reconciliation');
  const completed=task.status==='succeeded'&&a.verifiedCompletedTaskIds.has(id)&&!production.has(task.schedule.stepKind);
  if(hasWeeklyInitialExecution(task)&&!completed)fail('weekly_production_scope_existing_work_requires_reconciliation');
  if(completed&&(!task.resultRefs.length||!task.schedule.actualFinishedAt))fail('weekly_production_scope_completion_unverified');
  const minutes=task.schedule.estimatedDurationMinutes;if(!Number.isFinite(minutes)||minutes<=0)fail('weekly_production_scope_duration_required');
  const publication=task.publicationTaskId?pkg.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===task.publicationTaskId):null;
  const day=typeof task.inputSnapshot.rollingDate==='string'?task.inputSnapshot.rollingDate:publication?.publishWindow?.slice(0,10)??pkg.weekStart;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day<pkg.weekStart||day>pkg.weekEnd)fail('weekly_production_scope_day_invalid');
  const dependencyFinish=Math.max(now,...task.dependsOnTaskIds.map(dep=>done.get(dep)!));
  const lane=lanes.indexOf(Math.min(...lanes));
  const start=completed?Date.parse(task.schedule.actualFinishedAt!):window(Math.max(dependencyFinish,lanes[lane]!,Date.parse(`${day}T06:00:00+08:00`)),minutes*60000),finish=completed?start:start+minutes*60000;
  if(!Number.isFinite(start))fail('weekly_production_scope_completion_unverified');
  const root=publication?.motherContentId??null;
  let reservedCny=0;if(task.schedule.stepKind==='video_generation'){if(!root)fail('weekly_production_scope_production_root_missing');if(!reserved.has(root!)){reserved.add(root!);reservedCny=perFilmBudgetCny;}}
  assignments.push({taskId:id,inputHash:weeklyContinuationInputHash(task),dependencies:[...task.dependsOnTaskIds],estimatedDurationMinutes:minutes,startAt:new Date(start).toISOString(),finishAt:new Date(finish).toISOString(),lane,motherContentId:root,reservedCny,mode:completed?'verified_completed':'planned',resultHash:completed?scheduleHash(task.resultRefs):null});
  if(!completed)lanes[lane]=finish;done.set(id,finish);pending.delete(id);advanced=true;
 }if(!advanced)fail('weekly_production_scope_dependency_cycle');}
 if(reserved.size!==roots.size)fail('weekly_production_scope_generation_node_required');
 const reservedBudgetCny=reserved.size*perFilmBudgetCny;
 if(!Number.isFinite(pkg.socialContentPackage.weeklyBudgetCny)||pkg.socialContentPackage.weeklyBudgetCny!<reservedBudgetCny)fail('weekly_production_scope_budget_insufficient');
 const body={...scope,source:'automatic_template' as const,templateVersion:template.version,budgetPolicyVersion:BUDGET_POLICY_VERSION,adoptedAt:a.now,userApproval:null,selectedSlotIds:selected,selectedPublicationTaskIds:publications,planningRef:detail.ref,detailedScheduleHash:scheduleHash(detail),planningAdoptionHash:adoption.recordHash,queueLimitsHash:queue.hash,packageProductionHash:productionPackageHash(pkg),concurrency:queue.concurrency,reservedBudgetCny,perFilmIncludingRevisionsMaxCny:10 as const,authorizesPublishing:false as const,authorizesAcceptance:false as const,authorizesCustomerMessages:false as const,assignments};
 return {...body,tenantId:scope.tenantId,proofId:scheduleHash(body)};
}

/** The caller holds the existing authenticated package gate and validates the
 * actual planning analyses before persisting; this module never invents them. */
export async function persistWeeklyProductionScopeCapacity(store:DataStore,proof:ProductionScopeCapacity){
 const {proofId,...body}=proof;if(scheduleHash(body)!==proofId||proof.budgetPolicyVersion!==BUDGET_POLICY_VERSION||proof.reservedBudgetCny!==proof.assignments.reduce((sum,item)=>sum+item.reservedCny,0)||proof.assignments.some(item=>item.reservedCny<0||item.reservedCny>template.perFinishedVideoMaxCny))fail('weekly_production_scope_proof_invalid');
 const existing=await store.getById<Record_>(WEEKLY_PRODUCTION_SCOPE_CAPACITIES,proofId);
 if(existing){if(existing.content_hash!==scheduleHash(proof)||scheduleHash(existing.payload)!==scheduleHash(proof))fail('weekly_production_scope_proof_corrupt');return proof;}
 const saved=await store.create(WEEKLY_PRODUCTION_SCOPE_CAPACITIES,{id:proofId,tenant_id:proof.tenantId,program_id:proof.programId,package_id:proof.packageId,package_version:proof.packageVersion,payload:proof,content_hash:scheduleHash(proof)});
 if(!saved)fail('weekly_production_scope_proof_write_failed');return proof;
}

/** Fresh executor read: exact package, selection, planning inputs and durable
 * limits must still match. Dependencies, factual/asset rights and original cost
 * ledgers remain mandatory executor gates after this capacity-only admission. */
export async function readWeeklyProductionScopeCapacity(store:DataStore,a:{proofId:string;pkg:WeeklyOperatingPackage;tasks:WeeklyExecutionTask[];planning:WeeklyAgentPlanningState;taskId:string;now:string}){
 const row=await store.getById<Record_>(WEEKLY_PRODUCTION_SCOPE_CAPACITIES,a.proofId),proof=row?.payload as ProductionScopeCapacity|undefined;
 if(!row||!proof||row.content_hash!==scheduleHash(proof))return null;
 const {proofId,...body}=proof;
 if(proofId!==a.proofId||scheduleHash(body)!==proofId||proof.source!=='automatic_template'||proof.templateVersion!==template.version||proof.budgetPolicyVersion!==BUDGET_POLICY_VERSION||proof.perFilmIncludingRevisionsMaxCny!==template.perFinishedVideoMaxCny||proof.reservedBudgetCny!==proof.assignments.reduce((sum,item)=>sum+item.reservedCny,0)||proof.assignments.some(item=>item.reservedCny<0||item.reservedCny>template.perFinishedVideoMaxCny)||proof.userApproval!==null||proof.authorizesPublishing!==false||proof.authorizesAcceptance!==false||proof.authorizesCustomerMessages!==false)return null;
 const task=a.tasks.find(t=>t.taskId===a.taskId),assignment=proof.assignments.find(t=>t.taskId===a.taskId),week=naturalWeek(a.now);
 if(['superseded','retired'].includes(a.pkg.status))return null;
 const adoption=verifiedWeeklyPlanningTemplateAdoption(a.planning);if(!adoption||adoption.recordHash!==proof.planningAdoptionHash||!['confirmed','dispatched'].includes(a.planning.status))return null;
 if(!task||!assignment||task.tenantId!==proof.tenantId||a.pkg.programId!==proof.programId||a.pkg.packageId!==proof.packageId||a.pkg.version!==proof.packageVersion||a.pkg.weekStart!==week.start||a.pkg.weekEnd!==week.end||productionPackageHash(a.pkg)!==proof.packageProductionHash||scheduleHash(a.planning.detailedSchedule)!==proof.detailedScheduleHash)return null;
 // The proof covers one canonical production closure, but an older platform
 // sibling may still execute after it was signed. Its spend is not included in
 // the reserved ten-yuan mother-film slot, so reconcile before any new work.
 const assigned=new Set(proof.assignments.map(entry=>entry.taskId));
 const selectedMothers=new Set(proof.assignments.filter(entry=>entry.reservedCny>0).map(entry=>entry.motherContentId));
 if(a.tasks.some(current=>{if(assigned.has(current.taskId)||!production.has(current.schedule.stepKind)||!hasWeeklyInitialExecution(current))return false;
  const publication=a.pkg.socialContentPackage.publicationTasks.find(item=>item.publicationTaskId===current.publicationTaskId);
  return publication?.motherContentId&&selectedMothers.has(publication.motherContentId);
 }))return null;
 if(!allowed.has(task.schedule.stepKind)||proof.assignments.some(entry=>{const current=a.tasks.find(t=>t.taskId===entry.taskId);return !current||current.tenantId!==proof.tenantId||current.packageVersion!==proof.packageVersion||weeklyContinuationInputHash(current)!==entry.inputHash||current.schedule.estimatedDurationMinutes!==entry.estimatedDurationMinutes||scheduleHash(current.dependsOnTaskIds)!==scheduleHash(entry.dependencies)||['cancelled','dead_letter'].includes(current.status)||entry.mode==='verified_completed'&&(current.status!=='succeeded'||scheduleHash(current.resultRefs)!==entry.resultHash||Date.parse(current.schedule.actualFinishedAt??'')!==Date.parse(entry.finishAt));}))return null;
 const queue=queueCapacity(await listContentExecutionLimits(store,proof.tenantId),proof.tenantId);if(queue.hash!==proof.queueLimitsHash||queue.concurrency!==proof.concurrency)return null;
 return {proof,assignment,eligible:Date.parse(a.now)>=Date.parse(assignment.startAt)&&Date.parse(a.now)<=Date.parse(`${a.pkg.weekEnd}T23:59:59+08:00`),authority:'production_capacity_only' as const};
}
