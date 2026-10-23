import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import {createWeeklyPlanningAuthority} from './planningAuthority.js';
import {withExecutionPackageGate,executionPackageFrozen} from './weeklyExecutionGate.js';
import {readIndependentAdmission} from './weeklyIndependentAdmission.js';
import {readWeeklyAutomationTemplate} from './weeklyAutomationTemplate.js';
import {latestPackageRow} from './weeklyOperatingPackageSupport.js';
import {listWeeklyExecutionTasks,recomputePackageExecution,getWeeklyExecutionTaskRow,writeWeeklyExecutionTask,applyBusinessDispatchToExecutionTasks} from './executionTasks.js';
import {createWeeklyExecutionContinuationService} from './weeklyExecutionContinuations.js';
import {buildWeeklyProductionScopeCapacity,persistWeeklyProductionScopeCapacity,readWeeklyProductionScopeCapacity,WEEKLY_PRODUCTION_SCOPE_CAPACITIES,type ProductionScopeCapacity} from './weeklyProductionScopeCapacity.js';
import {buildWeeklyProductionPlanningAuthority,persistWeeklyProductionPlanningAuthority,readWeeklyProductionPlanningAuthority} from './weeklyProductionPlanningAuthority.js';
import {readWeeklyExistingFactSource} from './weeklyExistingFactSource.js';
import {createSocialOperatingRepository} from '../socialOperating/repository.js';
import {listContentExecutionLimits} from '../contentExecution/durableQueue.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {verifiedWeeklyPlanningTemplateAdoption} from './weeklyPlanningTemplateAdoption.js';
import {INITIAL_CAPACITY_SCHEDULE_REQUIRED} from './weeklyInitialScheduleGate.js';
import {SocialProgramError} from './service.js';
import type {WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
import {weeklyContinuationInputHash} from './weeklyExecutionContinuations.js';
type Scope={tenantId:string;programId:string;packageId:string;packageVersion:number};
export const WEEKLY_AUTOMATIC_PRODUCTION_INTENTS='social_weekly_automatic_production_intents';
export interface WeeklyAutomaticProductionIntent {intentId:string;scope:Scope;source:'automatic_template';templateVersion:'weekly-automation.v3';adoptedAt:string;userApproval:null;actorUserId:string;planningAdoptionHash:string;productionAuthorityProofId:string;capacityProofId:string;dispatchHash:string;selectedPublicationTaskIds:string[];authorizesPublishing:false;authorizesContentAcceptance:false;authorizesCustomerMessages:false;}
function fail(code:string):never{throw new SocialProgramError(code,409,code);}
/** Finish a previously persisted intent as well as a fresh one. The proof
 * reader checks every frozen assignment and the complete current task graph;
 * an arbitrary dispatch item is not necessarily a canonical production task. */
export async function completeWeeklyAutomaticProductionPreparation(store:DataStore,a:{scope:Scope;pkg:WeeklyOperatingPackage;planning:Awaited<ReturnType<ReturnType<typeof createWeeklyPlanningAuthority>['get']>>;intent:WeeklyAutomaticProductionIntent;now:string}){
 const {scope:s,pkg,planning,intent,now}=a;
 return withExecutionPackageGate(store,s,async assert=>{
 if(planning.status!=='dispatched'||!planning.dispatch||socialRequestHash(intent.scope)!==socialRequestHash(s)||intent.dispatchHash!==socialRequestHash(planning.dispatch)||intent.source!=='automatic_template'||intent.templateVersion!=='weekly-automation.v3'||intent.userApproval!==null||intent.authorizesPublishing!==false||intent.authorizesContentAcceptance!==false||intent.authorizesCustomerMessages!==false||socialRequestHash(intent.selectedPublicationTaskIds)!==socialRequestHash(planning.dispatch.scheduleItems.map(item=>item.publicationTaskId)))return false;
 const tasks=await listWeeklyExecutionTasks(store,s.tenantId,s.programId,s.packageId,s.packageVersion);
 // A dispatch may list a platform adaptation first. Read the frozen proof's
 // own first assignment as an index; the reader below verifies its full hash,
 // scope, graph and queue limits before that index is trusted for any write.
 const proofRow=await store.getById<Record_>(WEEKLY_PRODUCTION_SCOPE_CAPACITIES,intent.capacityProofId);
 const firstAssignment=(proofRow?.payload as ProductionScopeCapacity|undefined)?.assignments?.[0];
 const capacity=firstAssignment?await readWeeklyProductionScopeCapacity(store,{proofId:intent.capacityProofId,pkg,tasks,planning,taskId:firstAssignment.taskId,now}):null;
 if(!capacity||capacity.proof.assignments.length===0)return false;
 const byId=new Map(tasks.map(task=>[task.taskId,task]));
 if(byId.size!==tasks.length||capacity.proof.assignments.some(assignment=>!byId.has(assignment.taskId)))return false;
 for(const assignment of capacity.proof.assignments){
  const task=byId.get(assignment.taskId)!;if(task.status==='succeeded')continue;
  const row=await getWeeklyExecutionTaskRow(store,s.tenantId,task.taskId);
  if(weeklyContinuationInputHash(row.payload)!==assignment.inputHash)fail('weekly_automatic_capacity_changed_requires_reconciliation');
  const next={...row.payload,ownBlockingReasons:row.payload.ownBlockingReasons.filter(code=>code!==INITIAL_CAPACITY_SCHEDULE_REQUIRED&&code!=='business_dispatch_required')};
  if(socialRequestHash(row.payload)!==socialRequestHash(next)){await assert();await writeWeeklyExecutionTask(store,row,next);}
 }
 await assert();await recomputePackageExecution(store,s.tenantId,s.programId,s.packageId,s.packageVersion,now,true);
 return true;
 });
}
export async function readWeeklyAutomaticProductionIntent(store:DataStore,s:Scope,pkg:WeeklyOperatingPackage,publicationTaskId:string){
 const planning=await createWeeklyPlanningAuthority(store).get(s.tenantId,s.programId,s.packageId,s.packageVersion);
 const adoption=verifiedWeeklyPlanningTemplateAdoption(planning);if(!adoption||planning.status!=='dispatched'||!planning.dispatch)return null;
 const id=socialRequestHash([s,adoption.recordHash]),row=await store.getById<Record_>(WEEKLY_AUTOMATIC_PRODUCTION_INTENTS,id),intent=row?.payload as WeeklyAutomaticProductionIntent|undefined;
 if(!row||!intent||row.tenant_id!==s.tenantId||row.program_id!==s.programId||row.package_id!==s.packageId||row.package_version!==s.packageVersion||row.content_hash!==socialRequestHash(intent)||intent.intentId!==id||socialRequestHash(intent.scope)!==socialRequestHash(s)||intent.planningAdoptionHash!==adoption.recordHash||intent.dispatchHash!==socialRequestHash(planning.dispatch)||!intent.selectedPublicationTaskIds.includes(publicationTaskId)||intent.userApproval!==null||intent.authorizesPublishing!==false||intent.authorizesContentAcceptance!==false||intent.authorizesCustomerMessages!==false)return null;
 const authority=await readWeeklyProductionPlanningAuthority(store,{tenantId:s.tenantId,pkg,planning,proofId:intent.productionAuthorityProofId});
 return authority?{intent,authority,planning}:null;
}
/** A production-only intent is not a capacity grant by itself. Re-read the
 * complete durable graph and queue limits at every real executor admission;
 * a stale, missing or not-yet-eligible proof cannot start paid work. */
export async function readWeeklyAutomaticProductionCapacity(store:DataStore,a:{intent:WeeklyAutomaticProductionIntent;pkg:WeeklyOperatingPackage;planning:Awaited<ReturnType<ReturnType<typeof createWeeklyPlanningAuthority>['get']>>;task:WeeklyExecutionTask;now:string}){
 const task=a.task,s={tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion};
 if(socialRequestHash(a.intent.scope)!==socialRequestHash(s)||a.pkg.programId!==s.programId||a.pkg.packageId!==s.packageId||a.pkg.version!==s.packageVersion||!a.intent.capacityProofId)return null;
 const tasks=await listWeeklyExecutionTasks(store,s.tenantId,s.programId,s.packageId,s.packageVersion);
 const persisted=tasks.find(item=>item.taskId===task.taskId);
 if(!persisted||weeklyContinuationInputHash(persisted)!==weeklyContinuationInputHash(task))return null;
 return readWeeklyProductionScopeCapacity(store,{proofId:a.intent.capacityProofId,pkg:a.pkg,tasks,planning:a.planning,taskId:task.taskId,now:a.now});
}
/** Product-owned continuation after actual analyzed supply, not a manual task
 * state patch. Missing analyses or inputs are left untouched; scope/fees/rights
 * must be verified again by the real production adapter before any enqueue. */
export async function prepareWeeklyAutomaticProductionPlanning(store:DataStore,s:Scope,now=new Date().toISOString()){
 return withExecutionPackageGate(store,s,async assert=>{
  const admission=await readIndependentAdmission(store,s),template=await readWeeklyAutomationTemplate(store,s);
  if(!admission||template?.template.version!=='weekly-automation.v3')return {status:'not_ready' as const,code:'weekly_automatic_production_opt_in_required'};
  const row=await latestPackageRow(store,s.tenantId,s.programId,s.packageId);
  if(!row||row.payload.version!==s.packageVersion||!['draft','active'].includes(row.payload.status)||await executionPackageFrozen(store,s))return {status:'not_ready' as const,code:'weekly_automatic_production_scope_stale'};
  const pkg=row.payload,planner=createWeeklyPlanningAuthority(store);let plan=await planner.get(s.tenantId,s.programId,s.packageId,s.packageVersion);
  if(plan.userConfirmation)return {status:'not_ready' as const,code:'weekly_existing_manual_planning_preserved'};
  if(!plan.detailedSchedule?.coverage||!['awaiting_confirmation','confirmed','dispatched'].includes(plan.status))return {status:'not_ready' as const,code:'weekly_actual_analysis_and_schedule_required'};
  if(plan.status==='dispatched'&&plan.automaticTemplateAdoption){
   const first=plan.dispatch?.scheduleItems[0]?.publicationTaskId;
   if(!first)return {status:'not_ready' as const,code:'weekly_automatic_dispatch_empty'};
   const existing=await readWeeklyAutomaticProductionIntent(store,s,pkg,first);
   if(existing){
    if(await completeWeeklyAutomaticProductionPreparation(store,{scope:s,pkg,planning:plan,intent:existing.intent,now}))return {status:'prepared' as const,intent:existing.intent,fullWeeklyPackageActivated:false as const};
    return {status:'not_ready' as const,code:'weekly_automatic_capacity_changed_requires_reconciliation'};
   }
  }
  const source=await readWeeklyExistingFactSource(store,s.tenantId),tasks=await listWeeklyExecutionTasks(store,s.tenantId,s.programId,s.packageId,s.packageVersion);
  const outline=tasks.filter(t=>t.schedule.stepKind==='business_outline'&&t.status==='succeeded');
  if(outline.length!==1)return {status:'not_ready' as const,code:'weekly_real_outline_required'};
  const goalRef=outline[0].resultRefs.find(ref=>ref.type==='business_content_goal');if(!goalRef)return {status:'not_ready' as const,code:'weekly_real_goal_evidence_required'};
  const goal=await createSocialOperatingRepository(store).getGoal(s.tenantId,s.programId,goalRef.id,goalRef.version);if(!goal)return {status:'not_ready' as const,code:'weekly_real_goal_evidence_required'};
  // Existing result validation proves real completed ancestors; no timestamp or
  // status is converted to a delivery merely to make capacity appear feasible.
  const evidence=await createWeeklyExecutionContinuationService(store).derivePlannerEvidence(s,now),verifiedCompletedTaskIds=new Set(Object.keys(evidence.completedEvidence));
  const limits=await listContentExecutionLimits(store,s.tenantId),selection=plan.detailedSchedule.coverage.selectedSlotIds;
  if(plan.status==='awaiting_confirmation')plan=await planner.confirmAutomaticTemplate({...s,actorUserId:admission.actorUserId,expectedPlanningVersion:plan.version,selectedSlotIds:selection,now:new Date(now)});
  const production=buildWeeklyProductionPlanningAuthority({tenantId:s.tenantId,pkg,planning:plan,goal,factSourceRef:source.ref,factSourceHash:source.sourceHash,now});
  // Capacity is checked before dispatch. The second proof binds the real
  // dispatch metadata written onto task inputs, without changing task identity.
  buildWeeklyProductionScopeCapacity({pkg,tasks,planning:plan,selectedSlotIds:selection,now,limits,verifiedCompletedTaskIds});
  if(plan.status==='confirmed')plan=await planner.dispatch({...s,actor:'business_agent',expectedPlanningVersion:plan.version,selectedSlotIds:selection,now:new Date(now)});
  if(!plan.dispatch)fail('weekly_automatic_real_dispatch_missing');
  await assert();await applyBusinessDispatchToExecutionTasks(store,s.tenantId,s.programId,s.packageId,s.packageVersion,plan.dispatch!,now);
  const actual=await listWeeklyExecutionTasks(store,s.tenantId,s.programId,s.packageId,s.packageVersion),capacity=buildWeeklyProductionScopeCapacity({pkg,tasks:actual,planning:plan,selectedSlotIds:selection,now,limits,verifiedCompletedTaskIds});
  await persistWeeklyProductionPlanningAuthority(store,production);await persistWeeklyProductionScopeCapacity(store,capacity);
  const adoption=verifiedWeeklyPlanningTemplateAdoption(plan)!;
  const intentId=socialRequestHash([s,adoption.recordHash]),intent:WeeklyAutomaticProductionIntent={intentId,scope:s,source:'automatic_template',templateVersion:'weekly-automation.v3',adoptedAt:now,userApproval:null,actorUserId:admission.actorUserId,planningAdoptionHash:adoption.recordHash,productionAuthorityProofId:production.proofId,capacityProofId:capacity.proofId,dispatchHash:socialRequestHash(plan.dispatch),selectedPublicationTaskIds:plan.dispatch!.scheduleItems.map(i=>i.publicationTaskId),authorizesPublishing:false,authorizesContentAcceptance:false,authorizesCustomerMessages:false};
  const old=await store.getById<Record_>(WEEKLY_AUTOMATIC_PRODUCTION_INTENTS,intentId);
  if(old){if(old.content_hash!==socialRequestHash(old.payload)||old.content_hash!==socialRequestHash(intent))fail('weekly_automatic_production_intent_invalid');}
  else if(!await store.create(WEEKLY_AUTOMATIC_PRODUCTION_INTENTS,{id:intentId,tenant_id:s.tenantId,program_id:s.programId,package_id:s.packageId,package_version:s.packageVersion,payload:intent,content_hash:socialRequestHash(intent)}))fail('weekly_automatic_production_intent_write_failed');
  if(!await completeWeeklyAutomaticProductionPreparation(store,{scope:s,pkg,planning:plan,intent,now}))fail('weekly_automatic_capacity_changed_requires_reconciliation');
  return {status:'prepared' as const,intent,fullWeeklyPackageActivated:false as const};
 });
}
