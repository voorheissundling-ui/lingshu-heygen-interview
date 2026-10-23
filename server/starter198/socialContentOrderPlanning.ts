import type {Starter198Repository,StarterRecord} from './repository.js';
import {STARTER_COLLECTIONS} from './repository.js';
import {socialJson,socialObject,socialText,socialRequestHash,SocialContentWorkflowError} from './socialContentValidation.js';
import {withSocialContentSubjectLease} from './socialContentMutation.js';
import {createContentCreationQuotaService,shanghaiNaturalWeek,type QuotaScope,type CreationQuotaOrder} from '../socialPrograms/contentCreationQuota.js';
import {verifySharedOriginalProductionAdmission} from '../runtime/weeklyContentProductionIdentity.js';
import {readSocialContentOrderReleaseSafety} from './socialContentOrderCancellation.js';

type Base={repository:Starter198Repository;tenantId:string;programId:string;weekStart:string};
const fail=(code:string):never=>{throw new SocialContentWorkflowError(`social_content_order_planning_${code}`,409);};
const scopeOf=(i:Base):QuotaScope=>({tenantId:i.tenantId,programId:i.programId,weekStart:i.weekStart});
async function assertProgram(i:Base){
 const rows=await i.repository.dataStore?.list<any>('social_programs',{where:{tenant_id:i.tenantId,program_id:i.programId},perPage:2});
 if(rows?.totalItems!==1||rows.items.length!==1||rows.items[0]?.tenant_id!==i.tenantId||rows.items[0]?.program_id!==i.programId)fail('program_required');
}
function service(i:Base){const store=i.repository.dataStore;if(!store?.compareAndSwap)return fail('atomic_store_required');
 return createContentCreationQuotaService({store,assertAtomicStore:async()=>{if(!await store.supportsAtomicCompareAndSwap?.())fail('atomic_store_required');},
 readReleaseSafety:(order,scope)=>readSocialContentOrderReleaseSafety({repository:i.repository,scope,order,allowUnstartedPlan:true}),verifyDelivery:async()=>false});}
async function task(i:Base,taskId:string){const rows=await i.repository.list(STARTER_COLLECTIONS.socialContentTasks,i.tenantId,{where:{task_id:taskId},perPage:2});if(rows.totalItems!==1||rows.items.length!==1)fail('task_missing');return rows.items[0]!;}
async function bindUnstarted(i:Base,row:StarterRecord,persist=true){
 const b=socialObject(socialJson(row.content_order)),brief=socialObject(socialJson(row.brief));
 if(!b)return fail('unstarted_original_required');
 if(!b||b.schemaVersion!=='social-content-order.v1'||b.contentId!==row.task_id||b.budgetTaskId!==row.task_id||b.dispatch||b.dispatchHistory||row.run_id||row.orchestrator_item_id
  ||!['draft','needs_input','plan_review'].includes(socialText(row.status))||brief?._productionRevision||brief?._weeklyCreativeRepairProof)fail('unstarted_original_required');
 if(b.programId&&b.programId!==i.programId||b.originWeek&&b.originWeek!==i.weekStart)fail('scope_changed');
 const programs=await i.repository.dataStore!.list<any>('social_programs',{where:{tenant_id:i.tenantId,program_id:i.programId},perPage:2});if(programs.totalItems!==1)fail('program_required');
 const declaredProgram=socialText(socialObject(brief?.programRef)?.id);
 if(declaredProgram&&declaredProgram!==i.programId)fail('scope_changed');
 const frozen={...b,programId:i.programId,originWeek:i.weekStart};
 if(persist&&JSON.stringify(frozen)!==JSON.stringify(b)&&!await i.repository.dataStore!.compareAndSwap!(STARTER_COLLECTIONS.socialContentTasks,row.id,{tenant_id:i.tenantId,content_order:row.content_order},{content_order:frozen}))fail('binding_conflict');
 return persist?{...row,content_order:frozen}:row;
}
/** Only persisted canonical originals are planned; a slot is not an invented task. */
export async function registerSocialContentWeeklyPlan(input:{repository:Starter198Repository;tenantId:string;task:StarterRecord}){
 const b=socialObject(socialJson(input.task.content_order));if(b?.entry!=='weekly_package')return;
 const store=input.repository.dataStore;if(!store)return fail('atomic_store_required');
 const identity=await verifySharedOriginalProductionAdmission({store,tenantId:input.tenantId,task:input.task});
 const i={...input,programId:identity.programId,weekStart:shanghaiNaturalWeek(new Date(`${identity.originWeek}T12:00:00+08:00`))};
 return withSocialContentSubjectLease({...input,subjectId:identity.contentId,action:async()=>{
  const quota=service(i),current=await quota.read(scopeOf(i));if(current?.orders[identity.contentId])return;
  await bindUnstarted(i,await task(i,identity.contentId));
  return quota.plan(scopeOf(i),{commandId:`weekly-plan:${socialRequestHash([identity.packageId,identity.packageVersion,identity.contentId])}`,actorId:'weekly-planning-policy',reason:'persisted_canonical_original_plan'},
   {contentId:identity.contentId,entry:'weekly_package',packageId:identity.packageId,packageVersion:identity.packageVersion});
 }});
}
export async function readSocialContentOrderPlanning(i:Base){
 await assertProgram(i);
 const versioned=await service(i).readVersioned(scopeOf(i));
 const orders=await Promise.all(Object.values(versioned?.pool.orders??{}).map(async order=>{
  const rows=await i.repository.list(STARTER_COLLECTIONS.socialContentTasks,i.tenantId,{where:{task_id:order.contentId},perPage:2});const row=rows.items.length===1?rows.items[0]:null;
  const safety=await readSocialContentOrderReleaseSafety({repository:i.repository,scope:scopeOf(i),order,allowUnstartedPlan:true});
  const replaceable=order.state==='planned'&&!Object.values(safety).some(Boolean);
  return{...order,title:socialText(socialObject(socialJson(row?.brief))?.title)||socialText(row?.title)||socialText(row?.name)||'内容任务',taskStatus:socialText(row?.status),replaceable,blockedReason:replaceable?null:order.state!=='planned'?'plan_already_started_or_released':'activity_or_cost_requires_reconciliation'};
 }));return{scope:scopeOf(i),revision:versioned?.revision??0,limit:versioned?.pool.limit??5,orders};
}
export async function replaceSocialContentPlannedOrder(i:Base&{userId:string;commandId:string;reason:string;expectedRevision:number;selectedContentId:string;replacementTaskId:string}){
 if(i.selectedContentId===i.replacementTaskId)fail('different_content_required');
 const ids=[i.selectedContentId,i.replacementTaskId].sort();
 return withSocialContentSubjectLease({...i,subjectId:ids[0]!,action:()=>withSocialContentSubjectLease({...i,subjectId:ids[1]!,action:async()=>{
  const quota=service(i),pool=await quota.read(scopeOf(i)),prior=pool?.commands[i.commandId];
  if(prior){
   // A successful replacement remains replayable after the new content starts.
   // The quota command verifies the original fingerprint/actor/reason before
   // returning; no new readiness, cancellation or spending authority is granted.
   const original=prior.contentId?pool!.orders[prior.contentId]:null;
   await quota.replacePlanned(scopeOf(i),{commandId:i.commandId,actorId:i.userId,reason:i.reason},{expectedRevision:i.expectedRevision,selectedContentId:i.selectedContentId,replacement:{contentId:i.replacementTaskId,entry:original?.entry??'workspace'}});
   await reconcileSocialContentPlannedCancellation({...i,contentId:i.selectedContentId});
   return readSocialContentOrderPlanning(i);
  }
  const versioned=await quota.readVersioned(scopeOf(i));
  if(!versioned||versioned.revision!==i.expectedRevision)return fail('version_conflict');
  if(versioned.pool.orders[i.selectedContentId]?.state!=='planned')fail('selected_plan_required');
  const replacement=await bindUnstarted(i,await task(i,i.replacementTaskId),false);
  const b=socialObject(socialJson(replacement.content_order))!;
  if(b.entry==='weekly_package')fail('manual_replacement_required');
  const virtual:CreationQuotaOrder={contentId:i.replacementTaskId,slotId:'pending',state:'planned',entry:b.entry as 'workspace'|'assistant',packageId:null,packageVersion:null,productionTaskId:null,deliveryRef:null,replacesContentId:null};
  if(Object.values(await readSocialContentOrderReleaseSafety({repository:i.repository,scope:scopeOf(i),order:virtual,allowUnstartedPlan:true,allowUnboundDraft:true})).some(Boolean))fail('replacement_not_safe');
  await quota.replacePlanned(scopeOf(i),{commandId:i.commandId,actorId:i.userId,reason:i.reason},{expectedRevision:i.expectedRevision,selectedContentId:i.selectedContentId,replacement:{contentId:i.replacementTaskId,entry:b.entry as 'workspace'|'assistant'}});
  await reconcileSocialContentPlannedCancellation({...i,contentId:i.selectedContentId});
  return readSocialContentOrderPlanning(i);
 }} )});
}
/** A committed replacement fences dispatch immediately in quota; this repairs
 * the old task projection after crashes without deleting any run or receipt. */
export async function reconcileSocialContentPlannedCancellation(i:Base&{contentId:string;commandId:string}){
 const initial=await service(i).read(scopeOf(i));
 const replacement=Object.values(initial?.orders??{}).filter(o=>o.replacesContentId===i.contentId);
 if(replacement.length!==1)fail('replacement_receipt_required');
 const ids=[i.contentId,replacement[0]!.contentId].sort();
 return withSocialContentSubjectLease({...i,subjectId:ids[0]!,action:()=>withSocialContentSubjectLease({...i,subjectId:ids[1]!,action:async()=>{
  const quota=service(i),pool=await quota.read(scopeOf(i)),old=pool?.orders[i.contentId];
  const item=pool?.outbox.find(o=>o.kind==='cancel_planned'&&o.contentId===i.contentId&&o.commandId===i.commandId);
  if(!old||old.state!=='released'||!item)return fail('replacement_receipt_required');
  const newOrder=pool!.orders[replacement[0]!.contentId];
  if(!newOrder||newOrder.replacesContentId!==i.contentId)fail('replacement_receipt_required');
  const newTask=await task(i,newOrder.contentId),newBinding=socialObject(socialJson(newTask.content_order));
  if(!newBinding||newBinding.schemaVersion!=='social-content-order.v1'||newBinding.entry!==newOrder.entry||newBinding.contentId!==newOrder.contentId||newBinding.budgetTaskId!==newOrder.contentId)return fail('replacement_binding_invalid');
  if(newBinding.programId!==i.programId||newBinding.originWeek!==i.weekStart){
   if(newBinding.programId&&newBinding.programId!==i.programId||newBinding.originWeek&&newBinding.originWeek!==i.weekStart)fail('scope_changed');
   if(newOrder.state!=='planned')fail('unexpected_started_plan');
   await bindUnstarted(i,newTask,true);
  }
  const row=await task(i,i.contentId),b=socialObject(socialJson(row.content_order));
  if(row.run_id||row.orchestrator_item_id||b?.dispatch||b?.dispatchHistory||old.productionTaskId||old.deliveryRef)fail('unexpected_started_plan');
  if(!['cancelled','superseded'].includes(socialText(row.status))){
   if(!['draft','needs_input','plan_review','attention'].includes(socialText(row.status)))fail('unexpected_started_plan');
   if(!await i.repository.dataStore!.compareAndSwap!(STARTER_COLLECTIONS.socialContentTasks,row.id,{tenant_id:i.tenantId,status:row.status,content_order:row.content_order},{status:'cancelled',content_order:{...b,replacedByContentId:Object.values(pool!.orders).find(o=>o.replacesContentId===i.contentId)?.contentId??null,replacementCommandId:i.commandId}}))fail('projection_conflict');
  }
  await quota.acknowledgeOutbox(scopeOf(i),{commandId:`${i.commandId}:planned-cancel-ack`,actorId:'planning-recovery',reason:'committed_replacement_projected'},{outboxCommandId:i.commandId,contentId:i.contentId,kind:'cancel_planned'});
 }} )});
}
export async function increaseSocialContentOrderTarget(i:Base&{userId:string;commandId:string;reason:string;expectedRevision:number;newLimit:number;confirmed:boolean}){
 if(i.confirmed!==true)fail('explicit_confirmation_required');
 await assertProgram(i);
 await service(i).increaseTarget(scopeOf(i),{commandId:i.commandId,actorId:i.userId,reason:i.reason},{newLimit:i.newLimit,expectedRevision:i.expectedRevision,confirmationRef:`user-confirmation:${i.userId}:${i.commandId}`});
 return readSocialContentOrderPlanning(i);
}
