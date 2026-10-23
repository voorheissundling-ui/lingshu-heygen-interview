import {CONTENT_CREATION_QUOTA_COLLECTION,createContentCreationQuotaService,shanghaiNaturalWeek,type QuotaEntry,type QuotaScope} from '../socialPrograms/contentCreationQuota.js';
import type {Starter198Repository,StarterRecord} from './repository.js';
import {STARTER_COLLECTIONS} from './repository.js';
import {socialJson,socialObject,socialText,SocialContentWorkflowError} from './socialContentValidation.js';
import {socialRequestHash} from './socialContentValidation.js';
import type {Starter198OrchestratorQueuePort} from './runtimePorts.js';
import {bindSocialContentRevisionOrder,resolvePreparedProductAssetCostLineage} from './socialContentCostLineage.js';
import {readPreparedSocialProductAssetFallback} from './socialContentProductAssetRevisionPrepare.js';
import {verifySharedOriginalProductionAdmission} from '../runtime/weeklyContentProductionIdentity.js';
import {withSocialContentSubjectLease} from './socialContentMutation.js';
import {requireSocialTask} from './socialContentRecords.js';

export interface SocialContentDispatchEnvelope {
 schemaVersion:'social-content-dispatch.v1';commandId:string;userId:string;expectedVersion:string;idempotencyKey:string;
 queueRequest:Parameters<Starter198OrchestratorQueuePort['enqueue']>[0];requestHash:string;
}

export interface SocialContentOrderBinding {
 schemaVersion:'social-content-order.v1';contentId:string;budgetTaskId:string;
 entry:QuotaEntry;programId:string|null;originWeek:string|null;
 dispatch?:SocialContentDispatchEnvelope;
 dispatchHistory?:SocialContentDispatchEnvelope[];
}
export const initialSocialContentOrder=(taskId:string,entry:QuotaEntry='workspace'):SocialContentOrderBinding=>({
 schemaVersion:'social-content-order.v1',contentId:taskId,budgetTaskId:taskId,entry,programId:null,originWeek:null,
});
const fail=(code:string):never=>{throw new SocialContentWorkflowError(code,409);};

/** Quota-side admission only. A separate execution adapter must recover and
 * acknowledge the frozen outbox before it may enqueue the revised plan. */
export async function registerPreparedProductAssetRevisionDispatch(input:{
 repository:Starter198Repository;tenantId:string;userId:string;taskId:string;commandId:string;
 dispatch:SocialContentDispatchEnvelope;now?:Date;
 prepared:Parameters<typeof readPreparedSocialProductAssetFallback>[0];
}){
 return withSocialContentSubjectLease({repository:input.repository,tenantId:input.tenantId,subjectId:input.taskId,action:async()=>{
  if(input.prepared.repository!==input.repository||input.prepared.tenantId!==input.tenantId
   ||input.prepared.taskId!==input.taskId)return fail('social_content_asset_revision_scope_invalid');
  const store=input.repository.dataStore;
  if(!store?.compareAndSwap||!await store.supportsAtomicCompareAndSwap?.())return fail('social_content_order_atomic_store_required');
  const lineage=await resolvePreparedProductAssetCostLineage(input.prepared);
  const {requestHash,...dispatchBody}=input.dispatch,queue=input.dispatch.queueRequest;
  if(input.dispatch.schemaVersion!=='social-content-dispatch.v1'||requestHash!==socialRequestHash(dispatchBody)
   ||input.dispatch.commandId!==input.commandId||input.dispatch.userId!==input.userId
   ||queue.commandId!==input.commandId||queue.userId!==input.userId||queue.tenantId!==input.tenantId
   ||queue.workflowScope!=='social_content'||queue.subject?.id!==input.taskId
   ||queue.subject.admissionVersion!==lineage.preparedVersion||queue.subject.version!==lineage.preparedVersion)
   return fail('social_content_asset_revision_dispatch_invalid');
  let task=await requireSocialTask(input),binding=socialObject(socialJson(task.content_order));
  if(!binding||binding.contentId!==lineage.contentId||binding.budgetTaskId!==lineage.budgetTaskId
   ||binding.programId!==lineage.programId||binding.originWeek!==lineage.originWeek
   ||binding.cancellation||binding.replacedByContentId||binding.supersededByContentId
   ||socialText(task.version)!==lineage.preparedVersion)return fail('social_content_asset_revision_binding_changed');
  const frozenEntry=binding.entry;
  const scope:QuotaScope={tenantId:input.tenantId,programId:lineage.programId,weekStart:lineage.originWeek};
  const quota=createContentCreationQuotaService({store,
   assertAtomicStore:async()=>{if(!await store.supportsAtomicCompareAndSwap?.())return fail('social_content_order_atomic_store_required');},
   now:()=>input.now??new Date(),readReleaseSafety:async()=>({leaseActive:true,inFlight:true,paid:true,unknown:true}),
   verifyDelivery:async()=>false,
   verifyRevisionDispatch:async(order,actualScope,value)=>{
    const current=await resolvePreparedProductAssetCostLineage(input.prepared);
    return order.contentId===current.contentId&&order.entry===frozenEntry
     &&actualScope.programId===current.programId&&actualScope.weekStart===current.originWeek
     &&value.executionTaskId===current.executionTaskId&&value.lineageHash===current.lineageHash;
   }});
  const pool=await quota.read(scope),order=pool?.orders?.[lineage.contentId];
  if(!pool||!order||!['reserved','running','delivered'].includes(order.state)||order.contentId!==lineage.contentId
   ||order.slotId!==pool.slots.find(slot=>slot.contentId===lineage.contentId)?.slotId
   ||!pool.outbox.some(item=>item.kind==='dispatch'&&item.contentId===lineage.contentId
    &&item.commandId===lineage.sourceDispatchCommandId&&(item.executionTaskId??item.contentId)===lineage.contentId))
   return fail('social_content_asset_revision_original_order_required');
  if(order.revisions?.some(item=>item.executionTaskId===lineage.executionTaskId
   &&item.lineageHash===lineage.lineageHash&&item.commandId!==input.commandId))
   return fail('social_content_asset_revision_already_registered');
  const existing=socialObject(binding.dispatch);
  if(existing?.commandId===input.commandId){if(socialRequestHash(existing)!==socialRequestHash(input.dispatch))
    return fail('social_content_asset_revision_dispatch_changed');}
  else{
   if(Array.isArray(binding.dispatchHistory)&&binding.dispatchHistory.some((item:unknown)=>socialObject(item)?.commandId===input.commandId))
    return fail('social_content_asset_revision_dispatch_changed');
   const next={...binding,dispatch:structuredClone(input.dispatch),
    dispatchHistory:[...(Array.isArray(binding.dispatchHistory)?binding.dispatchHistory:[]),...(existing?[structuredClone(existing)]:[])]};
   if(!await store.compareAndSwap(STARTER_COLLECTIONS.socialContentTasks,task.id,
    {tenant_id:input.tenantId,version:task.version,run_id:task.run_id,content_order:task.content_order},
    {content_order:next}))return fail('social_content_asset_revision_binding_conflict');
   task=await requireSocialTask(input);binding=socialObject(socialJson(task.content_order));
  }
  const result=await quota.registerRevisionDispatch(scope,
   {commandId:input.commandId,actorId:input.userId,reason:'verified_product_asset_revision'},
   {contentId:lineage.contentId,executionTaskId:lineage.executionTaskId,lineageHash:lineage.lineageHash});
  const revision=result.order?.revisions?.find(item=>item.executionTaskId===lineage.executionTaskId
   &&item.lineageHash===lineage.lineageHash&&item.commandId===input.commandId);
  const outbox=result.pool.outbox.find(item=>item.kind==='dispatch'&&item.contentId===lineage.contentId
   &&item.executionTaskId===lineage.executionTaskId&&item.commandId===input.commandId);
  if(!revision||!outbox)return fail('social_content_asset_revision_dispatch_missing');
  return {scope,lineage,dispatchCommandId:input.commandId,outboxState:outbox.state,authorizesProvider:false as const};
 }});
}

/** Draft creation is free of quota effects. First start freezes the original
 * week on the task with a database CAS before reserving the stable weekly pool.
 * Historical rows stay on their existing identity until explicitly migrated. */
export async function reserveSocialContentOrder(input:{repository:Starter198Repository;tenantId:string;userId:string;
 task:StarterRecord;commandId:string;dispatch?:SocialContentDispatchEnvelope;now?:Date}){
 let task=input.task;
 const brief=socialObject(socialJson(task.brief)),authority=socialObject(brief?._weeklyAuthority);
 const revision=Boolean(brief?._weeklyCreativeRepairProof||brief?._productionRevision);
 const lineage=revision?await bindSocialContentRevisionOrder({...input,taskId:socialText(task.task_id)}):null;
 if(lineage){const fresh=await input.repository.get(STARTER_COLLECTIONS.socialContentTasks,input.tenantId,task.id);if(!fresh)return fail('social_content_order_identity_invalid');task=fresh;}
 const admit=async()=>{
 const raw=socialObject(socialJson(task.content_order));
 if(!raw)return null;
 if(raw.cancellation||raw.replacedByContentId||raw.supersededByContentId
   ||['cancelled','cancelling'].includes(socialText(task.status)))
   return fail('social_content_order_original_cancelled_or_replaced');
 const store=input.repository.dataStore;
 if(!store?.compareAndSwap||!await store.supportsAtomicCompareAndSwap?.())return fail('social_content_order_atomic_store_required');
 const taskId=socialText(task.task_id),binding=raw as unknown as SocialContentOrderBinding;
 if(binding.schemaVersion!=='social-content-order.v1'||binding.contentId!==(lineage?.contentId??taskId)||binding.budgetTaskId!==(lineage?.budgetTaskId??taskId)
   ||!['weekly_package','workspace','assistant'].includes(binding.entry))return fail('social_content_order_identity_invalid');
 // Revisions need an explicit, cost-preserving lineage migration, not a new
 // ordinary-content allowance. Never silently grant a child a fresh budget.
 const pkg=socialObject(authority?.weeklyPackage);
 // A legacy publication is not an original-content identity. Do not spend
 // the new shared five-slot allowance once per platform while its authority
 // and delivery proof chain is still awaiting the versioned migration.
 const weekly=pkg&&!lineage?.parentTaskId?await verifySharedOriginalProductionAdmission({store,tenantId:input.tenantId,task}):null;
 // A replacement's quota CAS can survive a crash before its task projection.
 // Recover that committed scope rather than minting a current-week allowance.
 let committedScope:QuotaScope|null=null;
 if(!binding.programId||!binding.originWeek){
   const pools=await store.list<any>(CONTENT_CREATION_QUOTA_COLLECTION,{where:{tenant_id:input.tenantId},perPage:1000});
   if(pools.totalItems!==pools.items.length)return fail('social_content_order_plan_history_incomplete');
   const matches=pools.items.filter(row=>row.payload?.orders?.[binding.contentId]);
   if(matches.length>1)return fail('social_content_order_plan_scope_ambiguous');
   if(matches.length){const row=matches[0],s=row.payload?.scope,o=row.payload.orders[binding.contentId];
     if(!s||s.tenantId!==input.tenantId||s.programId!==row.program_id||s.weekStart!==row.week_start
       ||o.contentId!==binding.contentId||o.state!=='planned')return fail('social_content_order_plan_reconciliation_required');
     if(binding.programId&&binding.programId!==s.programId||binding.originWeek&&binding.originWeek!==s.weekStart)
       return fail('social_content_order_plan_scope_changed');
     committedScope=s;
   }
 }
 const requestedProgram=weekly?.programId??committedScope?.programId??binding.programId;
 const programs=await store.list<any>('social_programs',{where:{tenant_id:input.tenantId,...(requestedProgram?{program_id:requestedProgram}:{})},perPage:2});
 if(programs.totalItems!==1||programs.items.length!==1)return fail('social_content_order_program_selection_required');
 const programId=socialText(programs.items[0]?.program_id);
 if(!programId||programs.items[0]?.tenant_id!==input.tenantId)return fail('social_content_order_program_invalid');
 const originWeek=binding.originWeek??committedScope?.weekStart??(weekly?shanghaiNaturalWeek(new Date(`${weekly.originWeek}T12:00:00+08:00`)):shanghaiNaturalWeek(input.now??new Date()));
 if(binding.programId&&binding.programId!==programId)return fail('social_content_order_program_changed');
 if(input.dispatch){const {requestHash,...body}=input.dispatch;
   if(requestHash!==socialRequestHash(body)||input.dispatch.commandId!==input.commandId
     ||input.dispatch.queueRequest.subject?.id!==taskId||input.dispatch.queueRequest.tenantId!==input.tenantId
     ||input.dispatch.userId!==input.userId)return fail('social_content_order_dispatch_invalid');
   if(binding.dispatch&&socialRequestHash(binding.dispatch)!==socialRequestHash(input.dispatch)
     &&(binding.dispatch.commandId===input.dispatch.commandId||!lineage))return fail('social_content_order_dispatch_changed');}
 const changedDispatch=Boolean(input.dispatch&&binding.dispatch&&socialRequestHash(input.dispatch)!==socialRequestHash(binding.dispatch));
 const frozen:SocialContentOrderBinding={...binding,programId,originWeek,...(input.dispatch?{dispatch:structuredClone(input.dispatch)}:{}),
   ...(changedDispatch?{dispatchHistory:[...(binding.dispatchHistory??[]),structuredClone(binding.dispatch!)]}:{})};
 if(JSON.stringify(frozen)!==JSON.stringify(binding)){
   if(!await store.compareAndSwap(STARTER_COLLECTIONS.socialContentTasks,task.id,
     {tenant_id:input.tenantId,content_order:task.content_order},{content_order:frozen}))return fail('social_content_order_binding_conflict');
 }
 const scope:QuotaScope={tenantId:input.tenantId,programId,weekStart:originWeek};
 const quota=createContentCreationQuotaService({store,
   assertAtomicStore:async()=>{if(!await store.supportsAtomicCompareAndSwap?.())return fail('social_content_order_atomic_store_required');},
   now:()=>input.now??new Date(),
   // No public cancellation/replacement command is exposed here. Until the
   // real queue/cost receipt readers are connected, refusal is safer than a
   // guessed "no activity" result.
   readReleaseSafety:async()=>({leaseActive:true,inFlight:true,paid:true,unknown:true}),
   verifyDelivery:async()=>false,
   verifyRevisionDispatch:async(_order,_scope,value)=>Boolean(lineage&&value.executionTaskId===taskId
     &&value.lineageHash===lineage.lineageHash&&lineage.contentId===binding.contentId
     &&lineage.programId===programId&&lineage.originWeek===originWeek),
 });
 const cmd={commandId:input.commandId,actorId:input.userId,reason:'confirmed_content_start'};
 const result=await (lineage&&lineage.kind!=='original'?quota.registerRevisionDispatch(scope,cmd,
   {contentId:binding.contentId,executionTaskId:taskId,lineageHash:lineage.lineageHash}):quota.reserve(scope,cmd,
   {contentId:binding.contentId,entry:frozen.entry,packageId:weekly?.packageId??null,packageVersion:weekly?.packageVersion??null})).catch(error=>{
       if(error instanceof Error&&/^content_creation_quota_[a-z_]+$/.test(error.message))
         return fail(`social_${error.message}`);
       throw error;
     });
 if(!result.order||!['reserved','running','delivered'].includes(result.order.state))return fail('social_content_order_not_reserved');
 const dispatch=result.pool.outbox.find(item=>item.contentId===binding.contentId&&item.kind==='dispatch'
   &&(item.executionTaskId??item.contentId)===taskId&&(!lineage||lineage.kind==='original'||item.commandId===input.commandId));
 if(!dispatch)return fail('social_content_order_dispatch_missing');
 return {binding:frozen,scope,order:result.order,dispatchCommandId:dispatch.commandId,
   async acknowledge(){
     if(dispatch.state==='acknowledged')return;
     // The durable queue accepted this exact content; this acknowledges the
     // dispatch, never a supplier result or a delivered film.
     await quota.acknowledgeOutbox(scope,{commandId:`${dispatch.commandId}:dispatch-ack`,actorId:input.userId,reason:'durable_queue_accepted'},
       {outboxCommandId:dispatch.commandId,contentId:binding.contentId,kind:'dispatch'});
   }};
 };
 // Creative children already hold their own start lease. Serialize their
 // registration with root cancellation too, so a child cannot appear between
 // the root's safety snapshot and its durable cancellation fence.
 if(lineage?.parentTaskId)return withSocialContentSubjectLease({repository:input.repository,tenantId:input.tenantId,
   subjectId:lineage.contentId,action:async()=>{
     const root=await requireSocialTask({...input,taskId:lineage.contentId});
     const rootOrder=socialObject(socialJson(root.content_order));
     if(rootOrder?.cancellation||rootOrder?.replacedByContentId||['cancelling','cancelled'].includes(socialText(root.status)))
       return fail('social_content_order_original_cancelled_or_replaced');
     return admit();
   }});
 return admit();
}
