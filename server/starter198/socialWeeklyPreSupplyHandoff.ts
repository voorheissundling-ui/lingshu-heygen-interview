import type {Starter198Repository} from './repository.js';
import type {SocialContentTaskDetail} from '../../shared/contracts/socialContentWorkflow.js';
import {readSocialTaskDetail,requireSocialTask} from './socialContentRecords.js';
import {readWeeklyReplicationAuthority} from './socialWeeklyReplicationAuthority.js';
import {parseStoredSocialScriptBaseline} from './socialContentScriptBaseline.js';
import {socialJson,socialObject,socialRequestHash,SocialContentWorkflowError} from './socialContentValidation.js';
import {withWeeklyProductionAdmissionGuard} from '../socialPrograms/weeklyCancellation.js';
import {publicationInstant} from '../socialPrograms/publicationDeadlines.js';

export interface WeeklyPreSupplyHandoff {
 schemaVersion:'weekly-pre-supply-handoff.v1';tenantId:string;taskId:string;runId:string;
 programId:string;packageId:string;packageVersion:number;publicationTaskId:string;
 baseline:NonNullable<ReturnType<typeof parseStoredSocialScriptBaseline>>;
 replicationAuthorityHash:string;scheduledTaskVersion:string;directorBrief:NonNullable<SocialContentTaskDetail['agentWorkflow']>['directorBrief'];
 executionPlan:NonNullable<SocialContentTaskDetail['agentWorkflow']>['executionPlan'];
 directorReview:NonNullable<SocialContentTaskDetail['agentWorkflow']>['executionPlanReview'];
 templateIntention?:{structure:import('../../shared/socialContentTemplateStructure.js').ContentTemplateStructureConstraint;pace:string;voiceSpeed:number;pauseStyle:string};
 assetAvailability:'planned_not_generated';createdAt:string;recordHash:string;
}
function fail():never{throw new SocialContentWorkflowError('weekly_pre_supply_handoff_unverified',409);}
/** This is an intention lock, never the post-supply director plan or an asset receipt. */
export async function readWeeklyPreSupplyHandoff(repository:Starter198Repository,tenantId:string,taskId:string):Promise<WeeklyPreSupplyHandoff|null>{
 const row=await requireSocialTask({repository,tenantId,taskId});if(!row.run_id||!repository.dataStore)return null;
 const run=await repository.dataStore.getById<Record<string,unknown>>('workflow_runs',String(row.run_id));
 const context=socialObject(socialJson(run?.starter_context)),raw=context?.weeklyPreSupplyHandoff;if(!raw)return null;
 const value=socialObject(raw) as unknown as WeeklyPreSupplyHandoff;if(!value||!socialObject(value.directorReview)||!socialObject(value.directorBrief)||!socialObject(value.executionPlan)||!parseStoredSocialScriptBaseline(value.baseline)||typeof value.createdAt!=='string'||publicationInstant(value.createdAt)===null)return fail();
 const {recordHash,...body}=value;
 const proof=await readWeeklyReplicationAuthority(repository,row),baseline=parseStoredSocialScriptBaseline(row.script_baseline);
 if(!proof||!baseline||!run||run.tenant_id!==tenantId||context?.socialTaskId!==taskId||['cancelled','failed','dead_letter'].includes(String(run.status))
 ||recordHash!==socialRequestHash(body)||value.schemaVersion!=='weekly-pre-supply-handoff.v1'||value.tenantId!==tenantId||value.taskId!==taskId||value.runId!==row.run_id
 ||value.programId!==proof.programId||value.packageId!==proof.packageId||value.packageVersion!==proof.packageVersion||value.publicationTaskId!==proof.publicationTaskId
 ||value.replicationAuthorityHash!==proof.recordHash||socialRequestHash(value.baseline)!==socialRequestHash(baseline)
 ||value.assetAvailability!=='planned_not_generated'||value.directorReview.approved!==true
 ||value.scheduledTaskVersion!==String(row.version)||value.directorBrief.replicationJobRef?.replicationJobId!==proof.job.replicationJobId
 ||value.directorBrief.replicationJobRef.version!==value.scheduledTaskVersion||value.directorBrief.replicationJobRef.factorSpecVersion!==value.scheduledTaskVersion
 ||value.directorBrief.accountPlaybookRef?.id!==proof.context.accountPlaybookRef?.id||value.directorBrief.accountPlaybookRef?.version!==proof.context.accountPlaybookRef?.version
 ||value.executionPlan.directorBriefId!==value.directorBrief.directorBriefId||value.executionPlan.directorBriefVersion!==value.directorBrief.version
 ||value.directorReview.directorBriefId!==value.directorBrief.directorBriefId||value.directorReview.directorBriefVersion!==value.directorBrief.version
 ||value.directorReview.executionPlanId!==value.executionPlan.executionPlanId||value.directorReview.executionPlanVersion!==value.executionPlan.version
 ||!Array.isArray(value.executionPlan.scenes)||!value.executionPlan.scenes.length||!Array.isArray(value.directorBrief.scenes)||value.executionPlan.scenes.length!==value.directorBrief.scenes.length
 )return fail();
 return value;
}
export async function freezeWeeklyPreSupplyHandoff(input:{repository:Starter198Repository;tenantId:string;taskId:string;runId:string;detail:SocialContentTaskDetail;baseline:NonNullable<ReturnType<typeof parseStoredSocialScriptBaseline>>}):Promise<WeeklyPreSupplyHandoff|null>{
 const row=await requireSocialTask(input),brief=socialObject(socialJson(row.brief)),authority=socialObject(brief?._weeklyAuthority),pkg=socialObject(authority?.weeklyPackage);
 const rowHash=socialRequestHash(row);
 if(Number(pkg?.executionGraphVersion??1)<2)return null;
 const existing=await readWeeklyPreSupplyHandoff(input.repository,input.tenantId,input.taskId);if(existing)return existing;
 const proof=await readWeeklyReplicationAuthority(input.repository,row),workflow=input.detail.agentWorkflow;if(!proof||!workflow||!workflow.executionPlanReview.approved||row.run_id!==input.runId||!input.repository.dataStore)return fail();
 const actual=await readSocialTaskDetail({repository:input.repository,tenantId:input.tenantId,taskId:input.taskId});
 if(!actual?.agentWorkflow||socialRequestHash(actual.agentWorkflow.directorBrief)!==socialRequestHash(workflow.directorBrief)||socialRequestHash(actual.agentWorkflow.executionPlan)!==socialRequestHash(workflow.executionPlan)||socialRequestHash(actual.agentWorkflow.executionPlanReview)!==socialRequestHash(workflow.executionPlanReview))throw new SocialContentWorkflowError('weekly_pre_supply_workflow_changed',409);
 const run=await input.repository.dataStore.getById<Record<string,unknown>>('workflow_runs',input.runId),context=socialObject(socialJson(run?.starter_context));
 if(!run||run.tenant_id!==input.tenantId||run.status!=='running'||!context||context.socialTaskId!==input.taskId)return fail();
 const contextHash=socialRequestHash(context);
 const c=input.baseline.contentTemplateStructure;
 const templateIntention=c?{structure:structuredClone(c),pace:c.pace,voiceSpeed:c.voiceSpeed,pauseStyle:c.pauseStyle}:undefined;
 const body={...(templateIntention?{templateIntention}:{}),schemaVersion:'weekly-pre-supply-handoff.v1' as const,tenantId:input.tenantId,taskId:input.taskId,runId:input.runId,programId:proof.programId,packageId:proof.packageId,packageVersion:proof.packageVersion,publicationTaskId:proof.publicationTaskId,baseline:structuredClone(input.baseline),replicationAuthorityHash:proof.recordHash,scheduledTaskVersion:String(row.version),directorBrief:structuredClone(workflow.directorBrief),executionPlan:structuredClone(workflow.executionPlan),directorReview:structuredClone(workflow.executionPlanReview),assetAvailability:'planned_not_generated' as const,createdAt:new Date().toISOString()};
 const handoff={...body,recordHash:socialRequestHash(body)};
 await withWeeklyProductionAdmissionGuard({dataStore:input.repository.dataStore,tenantId:input.tenantId,packageId:proof.packageId,packageVersion:proof.packageVersion,action:async assert=>{
  const fresh=await input.repository.dataStore!.getById<Record<string,unknown>>('workflow_runs',input.runId),current=await requireSocialTask(input);
  if(!fresh||fresh.tenant_id!==input.tenantId||fresh.status!=='running'||socialRequestHash(socialJson(fresh.starter_context))!==contextHash||socialRequestHash(current)!==rowHash)return fail();
  await assert();if(!await input.repository.dataStore!.update('workflow_runs',input.runId,{starter_context:{...context,weeklyPreSupplyHandoff:handoff}}))return fail();await assert();
 }});
 return readWeeklyPreSupplyHandoff(input.repository,input.tenantId,input.taskId);
}

/** Called by the original durable job, before any asset supplier. Returning
 * true means the pipeline must return without finishing the run or the job. */
export async function pauseWeeklyPreSupplyStage(repository:Starter198Repository,handoff:WeeklyPreSupplyHandoff,validationPorts:import('../runtime/socialWeeklyResultValidation.js').WeeklyExecutionResultValidationPorts={}):Promise<boolean>{
 const store=repository.dataStore;if(!store)return fail();
 return withWeeklyProductionAdmissionGuard({dataStore:store,tenantId:handoff.tenantId,packageId:handoff.packageId,packageVersion:handoff.packageVersion,action:async assert=>{
  const jobs=await store.list<Record<string,unknown>>('content_execution_jobs',{where:{tenant_id:handoff.tenantId,task_id:handoff.taskId,run_id:handoff.runId},perPage:2});
  if(jobs.totalItems!==1||jobs.items.length!==1)return fail();const job=jobs.items[0]!;
  const checkpoint=socialObject(socialJson(job.checkpoint))??{},stage=socialObject(checkpoint.weeklyStage);
  if(stage){if(stage.runId!==handoff.runId||stage.taskId!==handoff.taskId||stage.handoffHash!==handoff.recordHash)return fail();if(stage.stage==='assets_authorized'){const {assertWeeklyProductionAssetAuthorization}=await import('./socialWeeklyProductionStageResume.js');await assertWeeklyProductionAssetAuthorization(repository,handoff,new Date(),validationPorts);return false;}if(stage.stage!=='waiting_asset_claim')return fail();}
  if(job.status==='paused'&&stage?.stage==='waiting_asset_claim')return true;
  if(job.status!=='running')return fail();
  const checkpointHash=socialRequestHash(job.checkpoint??{});
  const rows=await store.list<Record<string,unknown>>('social_weekly_execution_tasks',{where:{tenant_id:handoff.tenantId,program_id:handoff.programId,package_id:handoff.packageId,package_version:handoff.packageVersion},perPage:500});if(rows.totalItems!==rows.items.length)return fail();
  let tasks=rows.items.map(row=>({row,value:socialObject(socialJson(row.payload))})).filter(value=>value.value?.publicationTaskId===handoff.publicationTaskId);
  const content=await requireSocialTask({repository,tenantId:handoff.tenantId,taskId:handoff.taskId}),{resolveWeeklyCreativeRepairAuthority}=await import('../runtime/weeklyCreativeRepairAuthority.js'),creative=await resolveWeeklyCreativeRepairAuthority({store,tenantId:handoff.tenantId,task:content});
  if(creative){const {readWeeklyCreativeRepairExecutionLineage}=await import('../runtime/weeklyCreativeRepairExecutionGraph.js');tasks=rows.items.map(row=>({row,value:socialObject(socialJson(row.payload))})).filter(({value})=>{try{return readWeeklyCreativeRepairExecutionLineage(value as unknown as import('../../shared/contracts/socialProgram.js').WeeklyExecutionTask)?.caseId===creative.proof.caseId;}catch{return false;}});}
  const select=(kind:string)=>{const selected=tasks.filter(item=>socialObject(item.value?.schedule)?.stepKind===kind);if(selected.length!==1||selected[0]!.row.task_id!==selected[0]!.value?.taskId)return fail();return String(selected[0]!.value!.taskId);};
  const weeklyStage={schemaVersion:'weekly-production-stage.v1',stage:'waiting_asset_claim',runId:handoff.runId,taskId:handoff.taskId,handoffHash:handoff.recordHash,assetTaskId:select('asset_generation'),materialTaskId:select('material_readiness')};
  const fresh=await store.getById<Record<string,unknown>>('content_execution_jobs',String(job.id));if(!fresh||fresh.status!=='running'||fresh.tenant_id!==handoff.tenantId||fresh.task_id!==handoff.taskId||fresh.run_id!==handoff.runId||socialRequestHash(fresh.checkpoint??{})!==checkpointHash)return fail();
  await assert();if(!await store.update('content_execution_jobs',String(job.id),{status:'paused',checkpoint:{...checkpoint,weeklyStage},retry_class:'weekly_production_waiting_asset_claim',last_error:'分镜意图已冻结，等待本周素材二次核验及资产任务领取。',updated_at:new Date().toISOString()}))return fail();return true;
 }});
}
