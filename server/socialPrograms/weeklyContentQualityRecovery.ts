import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialDirectorG5Scope} from '../../shared/contracts/socialDirectorG5Review.js';
import type {WeeklyExecutionTask,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import type {WeeklyContentQualityRecoveryContext,WeeklyContentQualityRecoveryConsumer,WeeklyContentQualityRecoveryReceipt,WeeklyContentQualityRecoveryRead} from '../../shared/contracts/weeklyContentQualityRecovery.js';
import {SocialProgramError} from './service.js';
import {socialObject,socialJson,socialRequestHash} from '../starter198/socialContentValidation.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';
import {resolveSceneCacheSourceRun} from '../starter198/socialContentSceneCacheSource.js';
import {createStarter198Repository} from '../starter198/repository.js';
import {assertNoFrozenTechnicalFailure,readVerifiedWeeklyContentQualityAudit} from '../runtime/weeklyContentQualityAudit.js';
import {getWeeklyExecutionTaskRow,withWeeklyExecutionTaskMutation,writeWeeklyExecutionTask,recomputePackageExecution} from './executionTasks.js';
import {executionPackageFrozen} from './weeklyExecutionGate.js';
import {withWeeklyProductionAdmissionGuard,readWeeklyCancellationReceipt} from './weeklyCancellation.js';
export const WEEKLY_QUALITY_REVIEW_BLOCK='weekly_production_quality_review_required';
export const WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK='weekly_quality_audit_actual_repair_required';
const object=(v:unknown)=>socialObject(socialJson(v))??{};
function check(v:unknown,code:string):asserts v {if(!v)throw new SocialProgramError(`weekly_quality_recovery_${code}`,409,'原周任务或成片审核证据不满足恢复条件。');}
async function actor(store:DataStore,tenantId:string,userId:string){const u=await store.getById<Record_>('users',userId),role=organizationRoleOrNull(u?.role);check(u?.tenantId===tenantId&&role&&['admin','super_admin','social_operator'].includes(role)&&u.disabled!==true&&u.active!==false&&!['disabled','suspended'].includes(String(u.status)),'actor_forbidden');return role;}
async function rows(store:DataStore,collection:string,where:Record<string,string|number>){const r=await store.list<Record_>(collection,{where,perPage:1000});check(r.totalItems===r.items.length&&r.items.every(row=>Object.entries(where).every(([k,v])=>row[k]===v)),'source_incomplete');return r.items;}
async function one(store:DataStore,collection:string,where:Record<string,string|number>){const r=await rows(store,collection,where);check(r.length===1,'source_ambiguous');return r[0]!;}
function receipts(task:WeeklyExecutionTask){const history=task.qualityRecoveries??[];check(Array.isArray(history)&&history.length<=100,'history_invalid');for(const receipt of history){const {recordHash,...body}=receipt;check(['expectedContextHash','sourceHash','auditSourceHash','g5ReceiptHash','g5ReviewHash','recordHash'].every(key=>typeof receipt[key as keyof WeeklyContentQualityRecoveryReceipt]==='string'&&/^[a-f0-9]{64}$/.test(String(receipt[key as keyof WeeklyContentQualityRecoveryReceipt])))&&typeof receipt.requestId==='string'&&/^[A-Za-z0-9_-]{16,160}$/.test(receipt.requestId)&&typeof receipt.taskId==='string'&&typeof receipt.runId==='string'&&typeof receipt.artifactId==='string'&&receipt.artifactRef?.type==='starter_social_content_artifact'&&receipt.artifactRef.id===receipt.artifactId&&Number.isSafeInteger(receipt.artifactRef.version)&&Number(receipt.artifactRef.version)>0,'receipt_corrupt');check(!receipt.clearedBlocker||[WEEKLY_QUALITY_REVIEW_BLOCK,WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK].includes(receipt.clearedBlocker),'receipt_corrupt');check(recordHash===socialRequestHash(body)&&receipt.executionTaskId===task.taskId&&receipt.tenantId===task.tenantId&&receipt.programId===task.programId&&receipt.packageId===task.packageId&&receipt.packageVersion===task.packageVersion&&receipt.publicationTaskId===task.publicationTaskId,'receipt_corrupt');}check(new Set(history.map(r=>r.requestId)).size===history.length,'receipt_ambiguous');return history;}
const errorGap=(error:unknown)=>({code:error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error?error.message:'weekly_quality_recovery_evidence_unavailable',message:'当前成片尚缺同源 G4/G5 审核或原周执行条件，请先处理对应缺口。'});
export function createWeeklyContentQualityRecoveryService(store:DataStore){
 async function source(a:SocialDirectorG5Scope,userId:string){
  const role=await actor(store,a.tenantId,userId),artifact=await one(store,'starter_social_content_artifacts',{tenant_id:a.tenantId,task_id:a.taskId,artifact_id:a.artifactId});
  const content=object(artifact.content),artifactVersion=Number(String(artifact.version).replace(/^v/,''));check(Number.isSafeInteger(artifactVersion)&&artifactVersion>0&&artifact.artifact_kind==='short_video'&&artifact.origin==='agent'&&artifact.content_hash===socialRequestHash({resourceRef:artifact.resource_ref,content}),'artifact_changed');
  const task=await one(store,'starter_social_content_tasks',{tenant_id:a.tenantId,task_id:a.taskId}),brief=object(task.brief),authority=object(brief._weeklyAuthority),week=object(authority.weeklyPackage),publication=object(authority.publicationTask);
  check(typeof week.programId==='string'&&typeof week.packageId==='string'&&Number.isSafeInteger(week.version)&&typeof publication.publicationTaskId==='string'&&object(brief.programRef).id===week.programId&&task.weekly_plan_id===week.packageId&&task.create_idempotency_key===`weekly-production:${week.packageId}:${week.version}:${publication.publicationTaskId}`,'binding_changed');
  const scope={tenantId:a.tenantId,programId:week.programId as string,packageId:week.packageId as string,packageVersion:week.version as number};
  const history=await rows(store,'social_weekly_operating_packages',{tenant_id:a.tenantId,program_id:scope.programId,package_id:scope.packageId});const current=history.filter(r=>r.version===scope.packageVersion);check(current.length===1,'package_missing');const pkg=object(current[0]!.payload),pack=object(pkg.socialContentPackage);check(pkg.programId===scope.programId&&pkg.packageId===scope.packageId&&pkg.version===scope.packageVersion,'package_changed');
  const actualPublications=Array.isArray(pack.publicationTasks)?pack.publicationTasks.map(object).filter(p=>p.publicationTaskId===publication.publicationTaskId):[];check(actualPublications.length===1&&actualPublications[0]!.accountId===publication.accountId&&actualPublications[0]!.platform===publication.platform,'publication_changed');
  const actualRun=await resolveSceneCacheSourceRun(createStarter198Repository(store),{tenantId:a.tenantId,taskId:a.taskId,parentArtifactId:a.artifactId});check(actualRun===a.runId,'run_changed');
  const artifactRef:VersionedSocialRef={type:'starter_social_content_artifact',id:a.artifactId,version:artifactVersion};
  const sourceHash=socialRequestHash({scope:a,artifactHash:artifact.content_hash,fileRef:artifact.resource_ref,weeklyScope:scope,publicationTaskId:publication.publicationTaskId});
  let admissionGap:ReturnType<typeof errorGap>|null=null;
  if(pkg.status!=='active'||history.some(r=>!Number.isSafeInteger(r.version)||Number(r.version)>scope.packageVersion)||await executionPackageFrozen(store,scope)||await readWeeklyCancellationReceipt({dataStore:store,...scope}))admissionGap={code:'weekly_quality_recovery_package_inactive',message:'原周包已停用、撤回或被新版本取代，不能恢复原任务。'};
  const canManage=['admin','super_admin'].includes(role)||task.created_by===userId;
  const taskRows=await rows(store,'social_weekly_execution_tasks',{tenant_id:a.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion});
  const allTasks=taskRows.map(row=>{const t=row.payload as WeeklyExecutionTask;check(t&&t.taskId===row.task_id&&t.tenantId===scope.tenantId&&t.programId===scope.programId&&t.packageId===scope.packageId&&t.packageVersion===scope.packageVersion,'consumer_changed');return t;});const consumers=allTasks.filter(t=>t.publicationTaskId===publication.publicationTaskId&&t.workflowKind==='content'&&['quality_check','rework'].includes(t.schedule.stepKind));
  check(new Set(consumers.map(t=>t.taskId)).size===consumers.length,'consumer_ambiguous');return {scope,a,artifact,content,artifactRef,sourceHash,consumers,allTasks,canManage,admissionGap};
 }
 async function repairParent(s:Awaited<ReturnType<typeof source>>){
  const lineage=object(s.content.sceneRework),parentId=String(s.artifact.parent_artifact_id||'');
  check(parentId&&lineage.parentArtifactId===parentId&&typeof lineage.parentArtifactHash==='string'&&lineage.sourceRunId&&lineage.executionRunId===s.a.runId,'repair_artifact_required');
  const parent=await one(store,'starter_social_content_artifacts',{tenant_id:s.a.tenantId,task_id:s.a.taskId,artifact_id:parentId}),parentContent=object(parent.content);
  check(parent.content_hash===lineage.parentArtifactHash&&parent.content_hash===socialRequestHash({resourceRef:parent.resource_ref,content:parentContent}),'repair_parent_changed');
  let actualFailure=false;try{assertNoFrozenTechnicalFailure(parentContent);}catch(error){actualFailure=error instanceof SocialProgramError&&error.code==='weekly_quality_audit_actual_repair_required';}
  check(actualFailure,'repair_parent_not_failed');
  const version=Number(String(parent.version).replace(/^v/,''));check(Number.isSafeInteger(version)&&version>0,'repair_parent_changed');
  return {type:'starter_social_content_artifact',id:parentId,version} as VersionedSocialRef;
 }
 async function consumer(s:Awaited<ReturnType<typeof source>>,task:WeeklyExecutionTask){
  let audit:Awaited<ReturnType<typeof readVerifiedWeeklyContentQualityAudit>>|null=null,gap=s.admissionGap,repairParentArtifactRef:VersionedSocialRef|null=null;
  const clearBlocker=task.ownBlockingReasons.includes(WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK)?WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK:task.ownBlockingReasons.includes(WEEKLY_QUALITY_REVIEW_BLOCK)?WEEKLY_QUALITY_REVIEW_BLOCK:null;
  if(clearBlocker===WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK){try{repairParentArtifactRef=await repairParent(s);}catch(error){gap=errorGap(error);}}
  if(!gap)try{audit=await readVerifiedWeeklyContentQualityAudit(store,task,s.artifactRef);}catch(error){gap=errorGap(error);}
  if(!s.canManage)gap={code:'weekly_quality_recovery_actor_forbidden',message:'请由原生产负责人或管理员恢复原周任务。'};
  if(task.lease)gap={code:'weekly_quality_recovery_task_leased',message:'原任务仍有执行租约，不能同时恢复。'};
  if(task.status!=='blocked'||!clearBlocker)gap??={code:'weekly_quality_recovery_not_blocked',message:'该任务没有待恢复的质量审核阻塞，保留当前实际状态。'};
  const recoveries=receipts(task),contextHash=socialRequestHash({scope:s.a,sourceHash:s.sourceHash,artifactRef:s.artifactRef,repairParentArtifactRef,clearBlocker,task:{id:task.taskId,status:task.status,own:task.ownBlockingReasons,inherited:task.inheritedBlockingTaskIds,input:task.inputSnapshot,idempotencyKey:task.idempotencyKey,attempt:task.attempt,lease:task.lease},audit,gap});
  const item:WeeklyContentQualityRecoveryConsumer={executionTaskId:task.taskId,...s.scope,publicationTaskId:task.publicationTaskId!,stepKind:task.schedule.stepKind as 'quality_check'|'rework',status:task.status,ownBlockingReasons:task.ownBlockingReasons,inheritedBlockingTaskIds:task.inheritedBlockingTaskIds,contextHash,resumeAvailable:!!audit&&!gap,gap,recoveries};return {item,audit};
 }
 async function context(a:SocialDirectorG5Scope,userId:string):Promise<WeeklyContentQualityRecoveryContext>{const s=await source(a,userId),consumers=[];for(const task of s.consumers)consumers.push((await consumer(s,task)).item);return {...a,artifactRef:s.artifactRef,artifactHash:String(s.artifact.content_hash),sourceHash:s.sourceHash,consumers};}
 async function read(a:SocialDirectorG5Scope,userId:string,executionTaskId:string,requestId:string):Promise<WeeklyContentQualityRecoveryRead>{const s=await source(a,userId),task=s.consumers.find(t=>t.taskId===executionTaskId);check(task,'consumer_missing');const receipt=receipts(task).find(r=>r.requestId===requestId)??null;const live=await consumer(s,task),cleared=receipt?.clearedBlocker??WEEKLY_QUALITY_REVIEW_BLOCK;let currentRepairParent:VersionedSocialRef|null=null;if(cleared===WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK)try{currentRepairParent=await repairParent(s);}catch{/* A changed repair chain is reported as unverified, never recovered again. */}return {item:receipt,task,currentSourceVerified:!!receipt&&!s.admissionGap&&receipt.sourceHash===s.sourceHash&&socialRequestHash(receipt.repairParentArtifactRef??null)===socialRequestHash(currentRepairParent)&&receipt.auditSourceHash===live.audit?.sourceHash&&receipt.g5ReceiptHash===live.audit?.receiptHash&&receipt.g5ReviewHash===live.audit?.reviewHash};}
 return {context,read,
 async resume(a:SocialDirectorG5Scope,userId:string,input:{executionTaskId:string;requestId:string;expectedContextHash:string}){
  check(/^[A-Za-z0-9_-]{16,160}$/.test(input.requestId)&&/^[a-f0-9]{64}$/.test(input.expectedContextHash),'input_invalid');
  const initial=await source(a,userId);check(initial.consumers.some(t=>t.taskId===input.executionTaskId),'consumer_missing');
  return withWeeklyProductionAdmissionGuard({dataStore:store,tenantId:a.tenantId,packageId:initial.scope.packageId,packageVersion:initial.scope.packageVersion,action:async assert=>withWeeklyExecutionTaskMutation(store,a.tenantId,input.executionTaskId,async()=>{
   const s=await source(a,userId),task=s.consumers.find(t=>t.taskId===input.executionTaskId);check(task&&s.canManage,'consumer_forbidden');const history=receipts(task),prior=history.find(r=>r.requestId===input.requestId);
   if(prior){check(prior.expectedContextHash===input.expectedContextHash&&prior.recoveredBy===userId,'request_conflict');return read(a,userId,input.executionTaskId,input.requestId);}
   const live=await consumer(s,task);check(live.item.contextHash===input.expectedContextHash,'context_changed');check(live.item.resumeAvailable&&live.audit,'evidence_not_ready');check(history.length<100,'history_full');await assert();
   const clearBlocker:'weekly_quality_audit_actual_repair_required'|'weekly_production_quality_review_required'=task.ownBlockingReasons.includes(WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK)?WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK:WEEKLY_QUALITY_REVIEW_BLOCK;
   const repairParentArtifactRef=clearBlocker===WEEKLY_QUALITY_ACTUAL_REPAIR_BLOCK?await repairParent(s):null;
   const now=new Date().toISOString(),body={...a,...s.scope,executionTaskId:task.taskId,publicationTaskId:task.publicationTaskId!,requestId:input.requestId,expectedContextHash:input.expectedContextHash,sourceHash:s.sourceHash,artifactRef:s.artifactRef,g5ReceiptId:live.audit.receiptId,g5ReviewId:live.audit.reviewId,auditSourceHash:live.audit.sourceHash,g5ReceiptHash:live.audit.receiptHash,g5ReviewHash:live.audit.reviewHash,clearedBlocker:clearBlocker,repairParentArtifactRef,recoveredBy:userId,recoveredAt:now};
   const receipt:WeeklyContentQualityRecoveryReceipt={...body,recordHash:socialRequestHash(body)},row=await getWeeklyExecutionTaskRow(store,a.tenantId,task.taskId);
   check(socialRequestHash(row.payload)===socialRequestHash(task),'consumer_changed');
   const remaining=task.ownBlockingReasons.filter(r=>r!==clearBlocker),inherited=task.dependsOnTaskIds.filter(id=>s.allTasks.find(t=>t.taskId===id)?.status!=='succeeded');
   await writeWeeklyExecutionTask(store,row,{...task,status:remaining.length||inherited.length?'blocked':'queued',inheritedBlockingTaskIds:inherited,ownBlockingReasons:remaining,lastError:task.lastError?.code===clearBlocker?null:task.lastError,qualityRecoveries:[...history,receipt],nextAttemptAt:now,updatedAt:now});
   await recomputePackageExecution(store,a.tenantId,s.scope.programId,s.scope.packageId,s.scope.packageVersion,now,false);return read(a,userId,task.taskId,input.requestId);
  })});
 }
 };
}
