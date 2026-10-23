import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import type {Starter198Repository} from '../starter198/repository.js';
import type {WeeklyOwnedProductIdentityPorts} from './weeklyOwnedProductIdentityDemand.js';
import {readWeeklyCreativeRepairExecutionLineage,WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS} from './weeklyCreativeRepairExecutionGraph.js';
import {resolveWeeklyCreativeRepairAuthority} from './weeklyCreativeRepairAuthority.js';
import {socialJson,socialObject,socialRequestHash,SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
import {readSocialTaskDetail} from '../starter198/socialContentRecords.js';
import {readWeeklyPreSupplyHandoff} from '../starter198/socialWeeklyPreSupplyHandoff.js';
import {readContentExecutionJob,type ContentExecutionJob} from '../contentExecution/durableQueue.js';
import type {WeeklyExecutionAdapterResult} from './socialWeeklyExecutionAdapter.js';
import {assertWeeklyCreativeRepairCtaAdmission} from './weeklyCreativeRepairCtaAdmission.js';

export const WEEKLY_CREATIVE_REPAIR_STAGE_EVIDENCE='social_weekly_creative_repair_stage_evidence';
const fail=(code:string):never=>{throw new SocialContentWorkflowError(code,409);};
/** Terminal producer states must not leave the weekly repair stage polling forever. */
export function weeklyCreativeRepairAssetJobDisposition(job:Pick<ContentExecutionJob,'status'|'retryClass'|'lastError'>):WeeklyExecutionAdapterResult|null{
 if(job.status==='succeeded')return null;
 if(['blocked','paused','cancelled','dead_letter'].includes(job.status))return{status:'blocked',code:job.retryClass||`content_execution_${job.status}`,message:job.lastError||'创意返工后台生产已停止，需要核验原作业后继续。'};
 return{status:'pending',code:job.status==='reconciling'?'provider_reconciliation':'weekly_creative_repair_asset_execution_pending',message:job.status==='reconciling'?'供应商结果未知，等待原作业对账；不得重新付费提交。':'创意返工资产仍在真实生产。',retryDelayMs:1000};
}
function verifiedStage(row:Record_|undefined,task:WeeklyExecutionTask){
 const lineage=readWeeklyCreativeRepairExecutionLineage(task),payload=socialObject(socialJson(row?.payload));
 const {recordHash,...body}=payload??{};
 if(!row||!lineage||!payload||recordHash!==socialRequestHash(body)||row.content_hash!==recordHash||row.tenant_id!==task.tenantId||row.task_id!==task.taskId||row.case_id!==lineage.caseId||row.step!==task.schedule.stepKind||payload.schemaVersion!=='weekly-creative-repair-stage-evidence.v1'||payload.tenantId!==task.tenantId||payload.taskId!==task.taskId||payload.caseId!==lineage.caseId||payload.lineageHash!==lineage.recordHash||payload.step!==task.schedule.stepKind||typeof payload.observationHash!=='string'||!/^[a-f0-9]{64}$/.test(payload.observationHash)||typeof payload.createdAt!=='string'||!Number.isFinite(Date.parse(payload.createdAt))||(payload.previousEvidenceHash!==null&&(typeof payload.previousEvidenceHash!=='string'||!/^[a-f0-9]{64}$/.test(payload.previousEvidenceHash))))return fail('weekly_creative_repair_execution_evidence_invalid');
 return payload;
}
/** A lost lease retries the original durable observation without inventing a new timestamp. */
export async function persistWeeklyCreativeRepairStageEvidence(input:{store:DataStore;task:WeeklyExecutionTask;observationHash:string;previousEvidenceHash:string|null;now:Date;assertAdmission:()=>Promise<void>}){
 const lineage=readWeeklyCreativeRepairExecutionLineage(input.task);if(!lineage)return fail('weekly_creative_repair_execution_lineage_required');
 if(!/^[a-f0-9]{64}$/.test(input.observationHash)||(input.previousEvidenceHash!==null&&!/^[a-f0-9]{64}$/.test(input.previousEvidenceHash)))return fail('weekly_creative_repair_execution_evidence_invalid');
 await input.assertAdmission();
 const existing=await input.store.list<Record_>(WEEKLY_CREATIVE_REPAIR_STAGE_EVIDENCE,{where:{tenant_id:input.task.tenantId,task_id:input.task.taskId},perPage:2});
 if(existing.totalItems){if(existing.totalItems!==1||existing.items.length!==1)return fail('weekly_creative_repair_execution_evidence_changed');const prior=verifiedStage(existing.items[0],input.task);if(prior.observationHash!==input.observationHash||prior.previousEvidenceHash!==input.previousEvidenceHash)return fail('weekly_creative_repair_execution_evidence_changed');}
 else{
  const body={schemaVersion:'weekly-creative-repair-stage-evidence.v1',tenantId:input.task.tenantId,caseId:lineage.caseId,taskId:input.task.taskId,step:input.task.schedule.stepKind,lineageHash:lineage.recordHash,previousEvidenceHash:input.previousEvidenceHash,observationHash:input.observationHash,createdAt:input.now.toISOString()},evidence={...body,recordHash:socialRequestHash(body)};
  let persisted:Record_|null=null;
  try{persisted=await input.store.create<Record_>(WEEKLY_CREATIVE_REPAIR_STAGE_EVIDENCE,{id:socialRequestHash([input.task.tenantId,input.task.taskId]).slice(0,15),tenant_id:input.task.tenantId,task_id:input.task.taskId,case_id:lineage.caseId,step:input.task.schedule.stepKind,content_hash:evidence.recordHash,payload:evidence});}catch{/* A competing writer or unknown storage result is read back, never rewritten. */}
  if(!persisted){const raced=await input.store.list<Record_>(WEEKLY_CREATIVE_REPAIR_STAGE_EVIDENCE,{where:{tenant_id:input.task.tenantId,task_id:input.task.taskId},perPage:2});if(raced.totalItems!==1||raced.items.length!==1)return fail('weekly_creative_repair_execution_evidence_save_failed');const prior=verifiedStage(raced.items[0],input.task);if(prior.observationHash!==input.observationHash||prior.previousEvidenceHash!==input.previousEvidenceHash)return fail('weekly_creative_repair_execution_evidence_changed');}

 }
 return [{type:'weekly_creative_repair_stage_evidence',id:input.task.taskId,version:1}];
}
export async function executeWeeklyCreativeRepairStage(input:{store:DataStore;repository:Starter198Repository;task:WeeklyExecutionTask;now:Date;ownedProductIdentity?:Omit<WeeklyOwnedProductIdentityPorts,'repository'>;assertAdmission:()=>Promise<void>}):Promise<WeeklyExecutionAdapterResult>{
 const lineage=readWeeklyCreativeRepairExecutionLineage(input.task);if(!lineage)return fail('weekly_creative_repair_execution_lineage_required');
 const rows=await input.store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:input.task.tenantId,task_id:lineage.childTaskId},perPage:2}),row=rows.items[0];if(rows.totalItems!==1||rows.items.length!==1||!row)return fail('weekly_creative_repair_execution_child_missing');const authority=await resolveWeeklyCreativeRepairAuthority({store:input.store,tenantId:input.task.tenantId,task:row,now:input.now});if(!authority||authority.proof.caseId!==lineage.caseId||authority.proof.caseRequestHash!==lineage.caseRequestHash||authority.configuration.recordHash!==lineage.configurationHash||authority.proof.originalAuthorityHash!==lineage.authorityHash||authority.bindingKey!==lineage.childBindingKey||input.task.subjectId!==lineage.childTaskId||input.task.publicationTaskId!==`creative-repair:${lineage.caseId}`)return fail('weekly_creative_repair_execution_authority_changed');
 await assertWeeklyCreativeRepairCtaAdmission({store:input.store,tenantId:input.task.tenantId,programId:input.task.programId,packageId:input.task.packageId,packageVersion:input.task.packageVersion,publicationTaskId:lineage.originalPublicationTaskId,inheritedCallToAction:socialObject(socialJson(row.brief))?.callToAction});
 const detail=await readSocialTaskDetail({repository:input.repository,tenantId:input.task.tenantId,taskId:lineage.childTaskId});if(!detail?.runId)return fail('weekly_creative_repair_execution_run_missing');
 const step=input.task.schedule.stepKind;if(!WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS.includes(step as any))return fail('weekly_creative_repair_execution_step_invalid');let observationHash:string;
 if(step==='material_preparation'||step==='material_readiness'){if(!input.ownedProductIdentity)return fail('weekly_owned_product_identity_verification_required');const {assessWeeklyOwnedProductIdentity}=await import('./weeklyOwnedProductIdentityDemand.js');const assessment=await assessWeeklyOwnedProductIdentity(input.store,{tenantId:input.task.tenantId,programId:input.task.programId,packageId:input.task.packageId,packageVersion:input.task.packageVersion,publicationTaskId:lineage.originalPublicationTaskId,contentTaskId:lineage.childTaskId},{...input.ownedProductIdentity,repository:input.repository});if(assessment.status!=='ready'||!assessment.materials.length)return fail(assessment.gaps[0]??'weekly_owned_product_identity_verification_required');observationHash=socialRequestHash({requirementHash:assessment.requirementHash,materials:assessment.materials});}
 else if(step==='script'){const baseline=socialObject(socialJson(row.script_baseline));if(!baseline)return fail('weekly_creative_repair_script_missing');observationHash=socialRequestHash(baseline);}
 else if(step==='storyboard'){const handoff=await readWeeklyPreSupplyHandoff(input.repository,input.task.tenantId,lineage.childTaskId);if(!handoff)return fail('weekly_creative_repair_storyboard_missing');observationHash=handoff.recordHash;}
 else {const job=await readContentExecutionJob(input.store,input.task.tenantId,lineage.childTaskId,detail.runId);if(!job)return fail('weekly_creative_repair_execution_job_missing');if(job.status==='paused'&&job.retryClass==='weekly_production_waiting_asset_claim'){const {resumeWeeklyProductionAssetStage}=await import('../starter198/socialWeeklyProductionStageResume.js');await resumeWeeklyProductionAssetStage({repository:input.repository,assetTask:input.task,contentTaskId:lineage.childTaskId,now:input.now,assertAdmission:input.assertAdmission,validationPorts:{ownedProductIdentity:input.ownedProductIdentity?{...input.ownedProductIdentity,repository:input.repository}:undefined}});return{status:'pending',code:'weekly_creative_repair_asset_execution_pending',message:'创意返工资产任务已恢复原生产作业。',retryDelayMs:1000};}const disposition=weeklyCreativeRepairAssetJobDisposition(job);if(disposition)return disposition;const artifacts=await input.store.list<Record_>('starter_social_content_artifacts',{where:{tenant_id:input.task.tenantId,task_id:lineage.childTaskId},perPage:100});if(!artifacts.items.length)return fail('weekly_creative_repair_artifact_missing');observationHash=socialRequestHash(artifacts.items.map(item=>[item.artifact_id,item.content_hash,item.version]));}
 const previous=input.task.dependsOnTaskIds[0]??null;
 if(input.task.dependsOnTaskIds.length>1)return fail('weekly_creative_repair_execution_predecessor_missing');
 const previousRow=previous?await input.store.list<Record_>(WEEKLY_CREATIVE_REPAIR_STAGE_EVIDENCE,{where:{tenant_id:input.task.tenantId,task_id:previous},perPage:2}):null;
 if(previous&&(previousRow?.totalItems!==1||previousRow.items.length!==1))return fail('weekly_creative_repair_execution_predecessor_missing');
 if(previous){const index=WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS.indexOf(input.task.schedule.stepKind as typeof WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS[number]);if(index<1)return fail('weekly_creative_repair_execution_predecessor_missing');verifiedStage(previousRow!.items[0],{...input.task,taskId:previous,schedule:{...input.task.schedule,stepKind:WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS[index-1]!}});}
 return {status:'succeeded',resultRefs:await persistWeeklyCreativeRepairStageEvidence({...input,observationHash,previousEvidenceHash:previousRow?.items[0]?.content_hash as string??null})};
}

export async function validateWeeklyCreativeRepairStageEvidence(store:DataStore,task:WeeklyExecutionTask,refs:VersionedSocialRef[]){
 const lineage=readWeeklyCreativeRepairExecutionLineage(task);if(!lineage||refs.length!==1||refs[0]?.type!=='weekly_creative_repair_stage_evidence'||refs[0].id!==task.taskId||refs[0].version!==1)return fail('weekly_creative_repair_execution_evidence_invalid');
 const rows=await store.list<Record_>(WEEKLY_CREATIVE_REPAIR_STAGE_EVIDENCE,{where:{tenant_id:task.tenantId,task_id:task.taskId},perPage:2});if(rows.totalItems!==1||rows.items.length!==1)return fail('weekly_creative_repair_execution_evidence_invalid');
 const payload=verifiedStage(rows.items[0],task),previous=task.dependsOnTaskIds[0]??null;
 if(task.dependsOnTaskIds.length>1)return fail('weekly_creative_repair_execution_evidence_invalid');
 if(!previous){if(payload.previousEvidenceHash!==null)return fail('weekly_creative_repair_execution_evidence_invalid');return;}
 const prior=await store.list<Record_>(WEEKLY_CREATIVE_REPAIR_STAGE_EVIDENCE,{where:{tenant_id:task.tenantId,task_id:previous},perPage:2}),index=WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS.indexOf(task.schedule.stepKind as typeof WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS[number]);
 if(index<1||prior.totalItems!==1||prior.items.length!==1)return fail('weekly_creative_repair_execution_predecessor_missing');
 verifiedStage(prior.items[0],{...task,taskId:previous,schedule:{...task.schedule,stepKind:WEEKLY_CREATIVE_REPAIR_EXECUTION_STEPS[index-1]!}});
 if(payload.previousEvidenceHash!==prior.items[0]!.content_hash)return fail('weekly_creative_repair_execution_evidence_changed');
}
