import type {DataStore, Record_} from '../storage/datastore.js';
import type {WeeklyProductionRepairCase} from '../../shared/contracts/weeklyProductionRepairCase.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import {createWeeklyProductionRepairCaseService, WEEKLY_PRODUCTION_REPAIR_CASES} from './weeklyProductionRepairCases.js';
import {withWeeklyProductionAdmissionGuard} from './weeklyCancellation.js';
import {socialJson, socialObject, socialRequestHash} from '../starter198/socialContentValidation.js';
import {organizationRoleOrNull} from '../lib/organizationRole.js';
import {SocialProgramError} from './service.js';

export const WEEKLY_CREATIVE_REPAIR_CONFIGURATIONS='social_weekly_creative_repair_configurations';
export interface CreativeRepairConfiguration {
  type:'weekly_creative_repair_configuration';version:1;tenantId:string;caseId:string;
  parentArtifactHash:string;decisionOperationId:string;feedbackHash:string;
  revisionScope:string;estimatedDurationMinutes:number;maximumCostCny:number;deadlineAt:string;
  ownerUserId:string;reviewerUserId:string;confirmedBy:string;confirmedAt:string;recordHash:string;
}
function fail(code:string,status=409):never{throw new SocialProgramError(`weekly_creative_repair_${code}`,status,'创意修订范围或原始反馈已变化，请重新核验。');}
export function createWeeklyCreativeRepairConfigurationService(store:DataStore,clock:()=>Date=()=>new Date()){
 const cases=createWeeklyProductionRepairCaseService(store,clock);
 async function read(tenantId:string,caseId:string){const rows=await store.list<Record_>(WEEKLY_CREATIVE_REPAIR_CONFIGURATIONS,{where:{tenant_id:tenantId,case_id:caseId},perPage:2});if(rows.totalItems!==rows.items.length||rows.items.length>1)fail('ambiguous',503);if(!rows.items.length)return null;const row=rows.items[0]!,value=socialObject(socialJson(row.payload)) as unknown as CreativeRepairConfiguration;if(!value||row.content_hash!==socialRequestHash(value))fail('corrupt',503);const{recordHash,...body}=value;if(recordHash!==socialRequestHash(body)||value.tenantId!==tenantId||value.caseId!==caseId)fail('corrupt',503);return value;}
 async function source(item:WeeklyProductionRepairCase,actor:string){
  if(item.kind!=='creative_revision'||item.trigger.type!=='user_changes_requested')fail('kind_invalid');
  if(actor!==item.ownerUserId&&actor!==item.reviewerUserId)fail('actor_forbidden',403);
  const users=await store.getById<Record_>('users',actor),role=organizationRoleOrNull(users?.role);if(!users||users.tenantId!==item.tenantId||users.disabled===true||users.active===false||['disabled','suspended'].includes(String(users.status))||!role||!['social_operator','admin','super_admin'].includes(role))fail('actor_forbidden',403);
  const packages=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:item.tenantId,program_id:item.programId,package_id:item.packageId,version:item.packageVersion},perPage:2});if(packages.totalItems!==1||packages.items.length!==1)fail('package_changed');const pkg=packages.items[0]!.payload as WeeklyOperatingPackage;if(pkg.status!=='active'||pkg.executionGraphVersion!==3)fail('package_changed');
  const publications=pkg.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId===item.publicationTaskId);if(publications.length!==1||Date.parse(publications[0]!.publishWindow ?? '')!==Date.parse(item.affectedPublishWindow))fail('publication_changed');
  const tasks=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:item.tenantId,task_id:item.parent.taskId},perPage:2});
  const task=tasks.items[0];if(tasks.totalItems!==1||tasks.items.length!==1||!task||task.run_id!==item.parent.runId||task.weekly_plan_id!==item.packageId)fail('parent_changed');
  const parents=await store.list<Record_>('starter_social_content_artifacts',{where:{tenant_id:item.tenantId,task_id:item.parent.taskId,artifact_id:item.parent.artifactRef.id},perPage:2});if(parents.totalItems!==1||parents.items.length!==1)fail('parent_changed');const parent=parents.items[0]!,content=socialObject(socialJson(parent.content));if(!content||parent.content_hash!==item.parent.artifactHash||parent.content_hash!==socialRequestHash({resourceRef:parent.resource_ref,content})||parent.status!=='changes_requested'||parent.last_operation_id!==item.trigger.operationId)fail('parent_changed');
  const operations=await store.list<Record_>('starter_social_content_operations',{where:{tenant_id:item.tenantId,operation_id:item.trigger.operationId},perPage:2});
  const operation=operations.items[0];
  if(operations.totalItems!==1||operations.items.length!==1||!operation||operation.operation!=='decide_social_content_artifact'||operation.target_id!==item.parent.taskId||operation.request_hash!==item.trigger.operationRequestHash||!['processing','succeeded'].includes(String(operation.status))||Number(String(parent.version).replace(/^v/,''))!==item.trigger.artifactDecisionVersion||socialRequestHash(item.trigger.note)!==item.trigger.noteHash)fail('feedback_changed');
  return item.trigger;
 }
 async function applyConfiguration(item:WeeklyProductionRepairCase,configuration:CreativeRepairConfiguration,assert:()=>Promise<void>){
  const rows=await store.list<Record_>(WEEKLY_PRODUCTION_REPAIR_CASES,{where:{tenant_id:item.tenantId,case_id:item.caseId},perPage:2});
  if(rows.totalItems!==1||rows.items.length!==1||rows.items[0]!.content_hash!==socialRequestHash(item))fail('case_changed');
  const{recordHash,...caseBody}=item,updatedBody={...caseBody,estimatedDurationMinutes:configuration.estimatedDurationMinutes,maximumCostCny:configuration.maximumCostCny,deadlineAt:configuration.deadlineAt,configurationGaps:[],state:'awaiting_capacity' as const,updatedAt:clock().toISOString()},updated={...updatedBody,recordHash:socialRequestHash(updatedBody)};
  await assert();if(!await store.update(WEEKLY_PRODUCTION_REPAIR_CASES,rows.items[0]!.id,{state:updated.state,content_hash:socialRequestHash(updated),payload:updated}))fail('case_save_failed',503);
 }
 return{read,async configure(tenantId:string,actor:string,caseId:string,input:{expectedCaseHash:string;revisionScope:string;estimatedDurationMinutes:number;maximumCostCny:number;deadlineAt:string}){
  const initial=await cases.read(tenantId,caseId);
  return withWeeklyProductionAdmissionGuard({dataStore:store,tenantId,packageId:initial.packageId,packageVersion:initial.packageVersion,action:async assert=>{
   const item=await cases.read(tenantId,caseId),trigger=await source(item,actor);
   if(typeof input.revisionScope!=='string'||input.revisionScope!==input.revisionScope.trim()||!input.revisionScope||input.revisionScope.length>4000||!Number.isSafeInteger(input.estimatedDurationMinutes)||input.estimatedDurationMinutes<1||input.estimatedDurationMinutes>1440||!Number.isFinite(input.maximumCostCny)||input.maximumCostCny<0||!Number.isFinite(Date.parse(input.deadlineAt)))fail('input_invalid',400);
   const deadlineAt=new Date(input.deadlineAt).toISOString(),now=clock();
   const body={type:'weekly_creative_repair_configuration' as const,version:1 as const,tenantId,caseId,parentArtifactHash:item.parent.artifactHash,decisionOperationId:trigger.operationId,feedbackHash:trigger.noteHash,revisionScope:input.revisionScope,estimatedDurationMinutes:input.estimatedDurationMinutes,maximumCostCny:input.maximumCostCny,deadlineAt,ownerUserId:item.ownerUserId,reviewerUserId:item.reviewerUserId,confirmedBy:actor};
   const existing=await read(tenantId,caseId);if(existing){const{confirmedAt,recordHash,...old}=existing;if(socialRequestHash(old)!==socialRequestHash(body))fail('immutable');
    if(item.state==='awaiting_configuration'&&!item.execution)await applyConfiguration(item,existing,assert);
    return existing;}

   if(Date.parse(deadlineAt)>=Date.parse(item.affectedPublishWindow)||now.getTime()+input.estimatedDurationMinutes*60000>=Date.parse(deadlineAt))fail('deadline_invalid');
   if(item.recordHash!==input.expectedCaseHash||item.state!=='awaiting_configuration'||item.execution)fail('version_conflict');
   const value={...body,confirmedAt:now.toISOString()},configuration={...value,recordHash:socialRequestHash(value)};
   const rows=await store.list<Record_>(WEEKLY_PRODUCTION_REPAIR_CASES,{where:{tenant_id:tenantId,case_id:caseId},perPage:2});if(rows.totalItems!==1||rows.items.length!==1)fail('case_changed');
   await assert();const saved=await store.create(WEEKLY_CREATIVE_REPAIR_CONFIGURATIONS,{id:socialRequestHash([tenantId,caseId]).slice(0,15),tenant_id:tenantId,case_id:caseId,content_hash:socialRequestHash(configuration),payload:configuration});if(!saved)fail('save_failed',503);
   await applyConfiguration(item,configuration,assert);
   return configuration;
  }});
 }};
}
