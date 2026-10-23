import type {DataStore,Record_} from '../storage/datastore.js';
import {resolveWeeklyProductionRow} from '../runtime/weeklyContentProductionIdentity.js';
import type {WeeklyAgentPlanningState,WeeklyExecutionTask,WeeklyOperatingPackage,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import {publicationInstant} from './publicationDeadlines.js';
import {socialJson,socialObject} from '../starter198/socialContentValidation.js';
import {weeklyScriptEvidence} from '../runtime/socialWeeklyScriptEvidence.js';
import {weeklyStoryboardEvidence} from '../runtime/socialWeeklyStoryboardEvidence.js';
import {readVerifiedNoSharedMaterialDemand} from '../runtime/socialWeeklyOriginalRunMaterialDemand.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {readWeeklyOriginalRunSettlementProof} from '../runtime/weeklyOriginalRunSettlementProof.js';
export interface ContinuationProductionObservation {status:'ready'|'pending'|'blocked';resultRefs:VersionedSocialRef[];observedCompletedAt?:string;code:string;}
/** Reads original persisted production only. No provider, starter, lease or mutation API is available here. */
export async function observeWeeklyContinuationProduction(store:DataStore,task:WeeklyExecutionTask,now:string,validate:(task:WeeklyExecutionTask,refs:VersionedSocialRef[],at:string)=>Promise<void>):Promise<ContinuationProductionObservation>{
 const out=(status:ContinuationProductionObservation['status'],code:string):ContinuationProductionObservation=>({status,code,resultRefs:[]});
 if(publicationInstant(now)===null)return out('blocked','weekly_continuation_observation_time_invalid');
 if(!(task.workflowKind==='content'||task.workflowKind==='directing'&&['script','storyboard'].includes(task.schedule.stepKind))||!task.publicationTaskId||publicationInstant(task.schedule.actualStartedAt??'')===null)return out('blocked','weekly_continuation_original_production_identity_required');
 const row=await resolveWeeklyProductionRow(store,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId}).catch(()=>null);
 if(!row)return out('blocked','weekly_continuation_original_production_missing');
 const brief=socialObject(socialJson(row.brief)),authority=socialObject(brief?._weeklyAuthority),pkg=socialObject(authority?.weeklyPackage);
 if(socialObject(brief?.programRef)?.id!==task.programId||pkg?.packageId!==task.packageId||pkg.version!==task.packageVersion||pkg.programId!==task.programId||row.task_id!==task.productionProgress?.contentTaskId||row.run_id!==task.productionProgress?.runId||!row.run_id)return out('blocked','weekly_continuation_original_production_identity_invalid');
 // After the original natural week, quality/rework may only observe the
 // already-started original run. A paused graph-review job is expected at
 // waiting_review; it is not permission to restart production in a new week.
 if(['quality_check','rework'].includes(task.schedule.stepKind)){
  const packages=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion},perPage:2});
  if(packages.totalItems!==1||packages.items.length!==1)return out('blocked','weekly_continuation_original_package_missing');
  const original=packages.items[0]!.payload as WeeklyOperatingPackage;
  if(packages.items[0]!.tenant_id!==task.tenantId||packages.items[0]!.program_id!==task.programId||packages.items[0]!.package_id!==task.packageId||packages.items[0]!.version!==task.packageVersion||original.packageId!==task.packageId||original.programId!==task.programId||original.version!==task.packageVersion||!original.weekEnd)return out('blocked','weekly_continuation_original_package_invalid');
  const weekEnd=Date.parse(`${original.weekEnd}T23:59:59.999+08:00`);
  if(!Number.isFinite(weekEnd))return out('blocked','weekly_continuation_original_package_invalid');
  if(Date.parse(now)>weekEnd){
   const plans=await store.list<Record_>('social_weekly_agent_planning',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion},sort:'-planning_version',perPage:2});
   if(!plans.items.length||plans.items.length>1&&plans.items[0]!.planning_version===plans.items[1]!.planning_version)return out('blocked','weekly_continuation_original_planning_ambiguous');
   const planning=plans.items[0]!.payload as WeeklyAgentPlanningState;
   if(plans.items[0]!.tenant_id!==task.tenantId||plans.items[0]!.program_id!==task.programId||plans.items[0]!.package_id!==task.packageId||plans.items[0]!.package_version!==task.packageVersion||plans.items[0]!.planning_version!==planning.version||planning.programId!==task.programId||planning.packageId!==task.packageId||planning.packageVersion!==task.packageVersion)return out('blocked','weekly_continuation_original_planning_invalid');
   const proof=await readWeeklyOriginalRunSettlementProof({store,task,pkg:original,planning,now});
   if(!proof||proof.contentTaskId!==row.task_id||proof.runId!==row.run_id)return out('blocked','weekly_continuation_original_settlement_unverified');
   // The settlement reader proves the original graph/quality chain; the
   // task-level validator additionally checks canonical shared-result and
   // continuation constraints before this observer may return a result ref.
   try{await validate(task,[proof.artifactRef],now);}catch{return out('blocked','weekly_continuation_original_step_unverified');}
   return {status:'ready',code:'weekly_continuation_original_run_settled',resultRefs:[proof.artifactRef],observedCompletedAt:proof.artifactCompletedAt};
  }
 }
 const run=await store.getById<Record_>('workflow_runs',String(row.run_id));
 if(!run||run.tenant_id!==task.tenantId)return out('blocked','weekly_continuation_original_run_missing');
 if(['cancelled','failed','dead_letter'].includes(String(run.status))||['cancelled','attention','needs_input','paused'].includes(String(row.status)))return out('blocked','weekly_continuation_original_production_requires_action');
 const job=await readContentExecutionJob(store,task.tenantId,String(row.task_id),String(row.run_id));
 if(job&&['blocked','paused','cancelled','dead_letter'].includes(job.status))return out('blocked','weekly_continuation_original_job_requires_action');
 if(job?.status==='reconciling')return out('pending','weekly_continuation_original_provider_reconciling');
 const checked=async(ref:VersionedSocialRef,completedAt?:string):Promise<ContinuationProductionObservation>=>{if(completedAt&&(publicationInstant(completedAt)===null||Date.parse(completedAt)<Date.parse(task.schedule.actualStartedAt!)||Date.parse(completedAt)>Date.parse(now)))return out('blocked','weekly_continuation_actual_completion_time_invalid');try{await validate(task,[ref],now);}catch{return out('blocked','weekly_continuation_original_step_unverified');}return {status:'ready',code:'weekly_continuation_original_step_verified',resultRefs:[ref],...(completedAt?{observedCompletedAt:completedAt}:{})};};
 if(task.schedule.stepKind==='script'||task.schedule.stepKind==='storyboard'){const selected=socialObject(authority?.referenceSelection)?.selected;const candidateIds=Array.isArray(selected)?selected.flatMap(v=>{const id=socialObject(v)?.candidateId;return typeof id==='string'&&id?[id]:[];}):[];let ref:VersionedSocialRef|null=null;try{ref=task.schedule.stepKind==='script'?weeklyScriptEvidence(row,candidateIds):weeklyStoryboardEvidence(row,candidateIds);}catch{return out('blocked','weekly_continuation_locked_handoff_drift');}if(!ref)return out('pending','weekly_continuation_original_locked_handoff_pending');const payload=socialObject(socialJson(task.schedule.stepKind==='script'?row.script_baseline:row.director_plan));return checked(ref,typeof payload?.lockedAt==='string'?payload.lockedAt:undefined);}
 if(task.schedule.stepKind==='material_readiness'){const weekly=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion},perPage:2});if(weekly.totalItems!==1||weekly.items.length!==1)return out('blocked','weekly_continuation_original_material_scope_missing');const pack=socialObject(weekly.items[0]!.payload),publications=socialObject(pack?.socialContentPackage)?.publicationTasks;const matches=Array.isArray(publications)?publications.map(socialObject).filter(p=>p?.publicationTaskId===task.publicationTaskId):[];if(matches.length!==1||!matches[0])return out('blocked','weekly_continuation_original_material_publication_missing');const publication=matches[0];if(publication.materialRequirement){const version=Number(String(row.version).replace(/^v/,''));if(!Number.isSafeInteger(version)||version<1)return out('blocked','weekly_continuation_original_material_version_invalid');return checked({type:'starter_social_content_task',id:String(row.task_id),version});}const demand=await readVerifiedNoSharedMaterialDemand(store,row,{tenantId:task.tenantId,taskId:String(row.task_id),programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId,accountId:typeof publication.accountId==='string'?publication.accountId:undefined,factRefs:publication.factRefs as VersionedSocialRef[]});if(!demand)return out('blocked','weekly_continuation_original_material_demand_unverified');return checked({type:'starter_social_content_material_demand',id:String(row.task_id),version:demand.version});}
 if(!['asset_generation','video_generation','quality_check','rework'].includes(task.schedule.stepKind))return out('blocked','weekly_continuation_readonly_step_evidence_unsupported');
 const artifacts:Record_[]=[];let page=1,totalPages=1,totalItems:number|null=null;const seen=new Set<string>();
 do{const batch=await store.list<Record_>('starter_social_content_artifacts',{where:{tenant_id:task.tenantId,task_id:String(row.task_id)},page,perPage:500});if(!Number.isSafeInteger(batch.totalPages)||batch.totalPages<0||batch.totalPages>100)return out('blocked','weekly_continuation_artifact_graph_incomplete');if(totalItems!==null&&totalItems!==batch.totalItems)return out('blocked','weekly_continuation_artifact_graph_changed');totalItems=batch.totalItems;totalPages=batch.totalPages;for(const artifact of batch.items){if(seen.has(artifact.id))return out('blocked','weekly_continuation_artifact_graph_duplicate');seen.add(artifact.id);artifacts.push(artifact);}page++;}while(page<=totalPages);
 if(totalItems!==artifacts.length)return out('blocked','weekly_continuation_artifact_graph_incomplete');
 const candidates=artifacts.filter(a=>a.artifact_kind==='short_video'&&a.origin==='agent'&&['draft','review_required','approved'].includes(String(a.status))).sort((a,b)=>Date.parse(String(b.created_at))-Date.parse(String(a.created_at)));
 for(const artifact of candidates){const content=socialObject(socialJson(artifact.content));if(socialObject(content?.render)?.completed!==true)continue;const v=Number(String(artifact.version).replace(/^v/,'')),completed=String(artifact.created_at);if(!Number.isSafeInteger(v)||v<1||publicationInstant(completed)===null||Date.parse(completed)<Date.parse(task.schedule.actualStartedAt!)||Date.parse(completed)>Date.parse(now))return out('blocked','weekly_continuation_actual_completion_time_invalid');const ref:VersionedSocialRef={type:'starter_social_content_artifact',id:String(artifact.artifact_id),version:v};try{await validate(task,[ref],now);}catch{return out('blocked','weekly_continuation_original_artifact_unverified');}return {status:'ready',code:'weekly_continuation_original_artifact_verified',resultRefs:[ref],observedCompletedAt:completed};}
 if(['completed','succeeded'].includes(String(run.status)))return out('blocked','weekly_continuation_completed_run_missing_step_artifact');
 return out('pending','weekly_continuation_original_production_in_progress');
}
