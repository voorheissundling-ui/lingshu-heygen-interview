import type {Starter198Repository,StarterRecord} from './repository.js';
import {STARTER_COLLECTIONS} from './repository.js';
import {socialJson,socialObject,socialRequestHash,socialText,SocialContentWorkflowError} from './socialContentValidation.js';
import {resolveWeeklyCreativeRepairAuthority} from '../runtime/weeklyCreativeRepairAuthority.js';
import {shanghaiNaturalWeek} from '../socialPrograms/contentCreationQuota.js';
import {readPreparedSocialProductAssetFallback} from './socialContentProductAssetRevisionPrepare.js';
import {socialContentQueueItemId} from './socialContentScheduler.js';

export interface SocialContentCostLineage {
 schemaVersion:'social-content-cost-lineage.v1';executionTaskId:string;contentId:string;budgetTaskId:string;
 parentTaskId:string|null;programId:string|null;originWeek:string|null;
 kind:'original'|'in_place_revision'|'creative_repair';lineageHash:string;
 originalMaximumCny:number|null;maximumAdditionalCostCny:number|null;
}
const fail=(code:string):never=>{throw new SocialContentWorkflowError(`social_content_cost_lineage_${code}`,409);};
/** A prepared backup image is a revision of the existing task and ledger, not
 * an original-content order. No provider or queue authority is returned. */
export async function resolvePreparedProductAssetCostLineage(input:Parameters<typeof readPreparedSocialProductAssetFallback>[0]){
 const prepared=await readPreparedSocialProductAssetFallback(input);
 const store=input.repository.dataStore;
 if(!store)return fail('store_required');
 const rows=await input.repository.list(STARTER_COLLECTIONS.socialContentTasks,input.tenantId,{where:{task_id:input.taskId},perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)return fail('task_missing_or_ambiguous');
 const task=rows.items[0],brief=socialObject(socialJson(task.brief)),binding=socialObject(socialJson(task.content_order));
 if(brief?._weeklyCreativeRepairProof||brief?._productionRevision||binding?.schemaVersion!=='social-content-order.v1'
  ||binding.contentId!==input.taskId||binding.budgetTaskId!==input.taskId||!socialText(binding.programId)
  ||!socialText(binding.originWeek)||binding.cancellation||binding.replacedByContentId||binding.supersededByContentId
  ||['cancelled','cancelling'].includes(socialText(task.status)))return fail('original_binding_invalid');
 const sourceDispatches=[binding.dispatch,...(Array.isArray(binding.dispatchHistory)?binding.dispatchHistory:[])]
  .map(socialObject).filter((item):item is Record<string,unknown>=>Boolean(item))
  .filter(item=>socialContentQueueItemId(socialObject(item.queueRequest) as any)===socialText(task.orchestrator_item_id));
 if(sourceDispatches.length!==1)return fail('original_dispatch_invalid');
 const dispatch=sourceDispatches[0],queue=socialObject(dispatch.queueRequest);
 if(!dispatch||!queue||dispatch.schemaVersion!=='social-content-dispatch.v1'
  ||socialRequestHash((({requestHash,...body})=>body)(dispatch))!==dispatch.requestHash
  ||queue.tenantId!==input.tenantId||queue.commandId!==dispatch.commandId
  ||socialObject(queue.subject)?.id!==input.taskId||queue.workflowScope!=='social_content')return fail('original_dispatch_invalid');
 const operations=await input.repository.list(STARTER_COLLECTIONS.socialContentOperations,input.tenantId,
  {where:{operation_id:String(dispatch.commandId)},perPage:2});
 const operation=operations.items[0];
 if(operations.totalItems!==1||operations.items.length!==1||operation.operation!=='start_social_content_task'
  ||operation.target_id!==input.taskId||operation.created_by!==dispatch.userId
  ||operation.idempotency_key!==dispatch.idempotencyKey
  ||operation.request_hash!==socialRequestHash({expectedVersion:dispatch.expectedVersion})
  ||!['processing','succeeded'].includes(socialText(operation.status)))
  return fail('original_operation_invalid');
 const run=await input.repository.get(STARTER_COLLECTIONS.runs,input.tenantId,input.sourceRunId);
 const context=socialObject(socialJson(run?.starter_context));
 if(!run||run.tenant_id!==input.tenantId||!['failed','cancelled','completed','succeeded'].includes(socialText(run.status))
  ||context?.schemaVersion!=='starter-social-content.auto-execution.v1'||context.socialTaskId!==input.taskId
  ||socialText(task.run_id)!==input.sourceRunId)return fail('source_run_invalid');
 const jobs=await store.list<any>('content_execution_jobs',{where:{tenant_id:input.tenantId,task_id:input.taskId},perPage:500});
 if(jobs.totalItems!==jobs.items.length||jobs.items.some(job=>
  ['running','queued','retry_wait','reconciling','paused'].includes(socialText(job.status))
  ||Boolean(job.worker_id)||Boolean(job.lease_expires_at)))return fail('source_execution_active');
 const marker=socialObject(brief?._productAssetFallback);
 if(marker?.sourceRunId!==input.sourceRunId||marker?.budgetLedgerRef!==input.budgetLedgerRef
  ||marker?.sourceTaskVersion===input.expectedPreparedVersion||marker?.revisedPlanHash!==prepared.revisedPlanHash)
  return fail('prepared_identity_invalid');
 const body={schemaVersion:'social-content-asset-revision-lineage.v1' as const,executionTaskId:input.taskId,
  contentId:input.taskId,budgetTaskId:input.taskId,programId:String(binding.programId),originWeek:String(binding.originWeek),
  sourceRunId:input.sourceRunId,sourceDispatchCommandId:String(dispatch.commandId),
  sourceTaskVersion:String(marker.sourceTaskVersion),preparedVersion:input.expectedPreparedVersion,
  revisionId:String(marker.revisionId),revisedPlanHash:prepared.revisedPlanHash,budgetLedgerRef:input.budgetLedgerRef};
 return {...body,lineageHash:socialRequestHash(body)};
}
/** No parent ID supplied by a request is authoritative. Every creative-repair
 * edge is revalidated against its durable case, artifact and approval command.
 * Same-task revisions naturally keep the original ledger and original slot. */
export async function resolveSocialContentCostLineage(input:{repository:Starter198Repository;tenantId:string;taskId:string;now?:Date}):Promise<SocialContentCostLineage>{
 const store=input.repository.dataStore;if(!store)return fail('store_required');
 const visited=new Set<string>();
 async function visit(taskId:string):Promise<SocialContentCostLineage>{
  if(visited.has(taskId)||visited.size>=32)return fail('cycle');visited.add(taskId);
  const rows=await input.repository.list(STARTER_COLLECTIONS.socialContentTasks,input.tenantId,{where:{task_id:taskId},perPage:2});
  if(rows.totalItems!==1||rows.items.length!==1)return fail('task_missing_or_ambiguous');
  const task=rows.items[0];if(task.tenant_id!==input.tenantId||task.task_id!==taskId)return fail('tenant_mismatch');
  const brief=socialObject(socialJson(task.brief)),order=socialObject(socialJson(task.content_order));
  const repair=socialObject(brief?._weeklyCreativeRepairProof),revision=socialObject(brief?._productionRevision);
  if(repair&&revision)return fail('ambiguous_revision');
  let result:SocialContentCostLineage;
  if(repair){
   const authority=await resolveWeeklyCreativeRepairAuthority({store:store!,tenantId:input.tenantId,task,now:input.now});
   if(!authority||authority.proof.parentTaskId===taskId)return fail('repair_authority_invalid');
   const parent=await visit(authority.proof.parentTaskId);
   if(parent.programId&&parent.programId!==authority.repairCase.programId)return fail('program_changed');
   const mappings=await store!.list<any>('social_weekly_creative_repair_child_executions',{where:{tenant_id:input.tenantId,case_id:authority.proof.caseId},perPage:2});
   if(mappings.totalItems>1||mappings.totalItems!==mappings.items.length)return fail('repair_capacity_ambiguous');
   const mapping=mappings.totalItems===1&&mappings.items.length===1?socialObject(socialJson(mappings.items[0].payload)):null;
   if(mapping&&mappings.items[0].content_hash!==socialRequestHash(mapping))return fail('repair_capacity_corrupt');
   if(mapping){const {recordHash,...body}=mapping;if(recordHash!==socialRequestHash(body)||mapping.tenantId!==input.tenantId||mapping.caseId!==authority.proof.caseId
    ||mapping.parentTaskId!==authority.proof.parentTaskId||mapping.configurationHash!==authority.proof.configurationRecordHash||mapping.authorityHash!==authority.proof.originalAuthorityHash)return fail('repair_capacity_corrupt');}
   const authorized=Number(mapping?.authorizedMaximumCostCny??0);
   if(!Number.isFinite(authorized)||authorized<0||authorized>authority.configuration.maximumCostCny)return fail('repair_capacity_invalid');
   const body={schemaVersion:'social-content-cost-lineage.v1' as const,executionTaskId:taskId,contentId:parent.contentId,budgetTaskId:parent.budgetTaskId,
    parentTaskId:authority.proof.parentTaskId,programId:parent.programId??authority.repairCase.programId,originWeek:parent.originWeek,
    kind:'creative_repair' as const,parentLineageHash:parent.lineageHash,proofHash:authority.proof.recordHash,
    originalMaximumCny:parent.originalMaximumCny,maximumAdditionalCostCny:authorized};
   result={...body,lineageHash:socialRequestHash(body)};
  }else{
   if(revision){
    const {planHash,preparedBy,preparedAt,...frozen}=revision;
    if(revision.schemaVersion!=='social-production-revision.v1'||revision.tenantId!==input.tenantId||revision.taskId!==taskId
      ||typeof planHash!=='string'||socialRequestHash(frozen)!==planHash||!socialText(preparedBy)||!Number.isFinite(Date.parse(String(preparedAt))))return fail('revision_invalid');
    const artifacts=await input.repository.list(STARTER_COLLECTIONS.socialContentArtifacts,input.tenantId,{where:{task_id:taskId,artifact_id:String(revision.parentArtifactId)},perPage:2});
    if(artifacts.totalItems!==1||artifacts.items.length!==1||String(artifacts.items[0].version)!==String(revision.parentArtifactVersion))return fail('revision_parent_changed');
   }
   if(order&&(order.schemaVersion!=='social-content-order.v1'||order.contentId!==taskId||order.budgetTaskId!==taskId))return fail('unproven_alias');
   const weekly=socialObject(socialObject(brief?._weeklyAuthority)?.weeklyPackage);
   if(order?.programId&&weekly?.programId&&order.programId!==weekly.programId)return fail('program_changed');
   const programId=socialText(order?.programId)||socialText(weekly?.programId)||null;
   let originWeek=socialText(order?.originWeek)||null;
   if(!originWeek&&weekly){const date=new Date(String(task.created_at??task.created??''));if(!Number.isFinite(date.getTime()))return fail('original_week_missing');originWeek=shanghaiNaturalWeek(date);}
   const amount=Number(brief?.perItemBudgetCny);
   const body={schemaVersion:'social-content-cost-lineage.v1' as const,executionTaskId:taskId,contentId:taskId,budgetTaskId:taskId,parentTaskId:null,
    originalMaximumCny:Number.isFinite(amount)&&amount>0?Math.min(15,amount):null,maximumAdditionalCostCny:null,
    programId,originWeek,kind:revision?'in_place_revision' as const:'original' as const,
    ...(revision?{revisionPlanHash:revision.planHash}:{})};result={...body,lineageHash:socialRequestHash(body)};
  }
  if(order&&order.contentId!==taskId&&(order.contentId!==result.contentId||order.budgetTaskId!==result.budgetTaskId||order.programId!==result.programId||order.originWeek!==result.originWeek))return fail('binding_changed');
  return result;
 }
 return visit(input.taskId);
}

/** Called after the trusted repair proof is persisted and before first start.
 * A resumable partial creation can finish this binding, but a started child may
 * never be silently reparented. No cost or quota entry is moved or deleted. */
export async function bindSocialContentRevisionOrder(input:{repository:Starter198Repository;tenantId:string;taskId:string;now?:Date}){
 const lineage=await resolveSocialContentCostLineage(input);if(lineage.kind!=='creative_repair')return lineage;
 const store=input.repository.dataStore;if(!store?.compareAndSwap||!await store.supportsAtomicCompareAndSwap?.())return fail('atomic_store_required');
 const rows=await input.repository.list(STARTER_COLLECTIONS.socialContentTasks,input.tenantId,{where:{task_id:input.taskId},perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)return fail('task_missing_or_ambiguous');const task=rows.items[0] as StarterRecord;
 const order=socialObject(socialJson(task.content_order));
 const inherited={schemaVersion:'social-content-order.v1',contentId:lineage.contentId,budgetTaskId:lineage.budgetTaskId,
  entry:'weekly_package',programId:lineage.programId,originWeek:lineage.originWeek,parentTaskId:lineage.parentTaskId,lineageHash:lineage.lineageHash};
 if(order?.contentId===lineage.contentId&&order?.budgetTaskId===lineage.budgetTaskId)return lineage;
 if(socialText(task.run_id)||socialText(task.orchestrator_item_id))return fail('started_child_requires_reconciliation');
 if(order&&(order.contentId!==input.taskId||order.budgetTaskId!==input.taskId||order.programId||order.originWeek))return fail('binding_changed');
 if(!await store.compareAndSwap(STARTER_COLLECTIONS.socialContentTasks,task.id,{tenant_id:input.tenantId,content_order:task.content_order},
  {content_order:inherited}))return fail('binding_conflict');
 return lineage;
}
