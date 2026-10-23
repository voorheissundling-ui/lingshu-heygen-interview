import {randomUUID} from 'node:crypto';
import type {Starter198Repository} from './repository.js';
import {STARTER_COLLECTIONS} from './repository.js';
import {requireSocialTask} from './socialContentRecords.js';
import {executeSocialContentMutation,withSocialContentSubjectLease} from './socialContentMutation.js';
import {resolveSocialContentCostLineage} from './socialContentCostLineage.js';
import {socialJson,socialObject,socialText,socialRequestHash,SocialContentWorkflowError} from './socialContentValidation.js';
import {createContentCreationQuotaService,type CreationQuotaOrder,type QuotaScope} from '../socialPrograms/contentCreationQuota.js';
import {SocialContentTaskBudget} from '../lib/socialContentTaskBudget.js';
import {acquireDurableOperationLease,assertDurableOperationLease,releaseDurableOperationLease} from '../runtime/durableLease.js';
import {controlContentExecutionJob} from '../contentExecution/durableQueue.js';

const fail=(code:string):never=>{throw new SocialContentWorkflowError(`social_content_order_cancel_${code}`,409);};
type Safety={leaseActive:boolean;inFlight:boolean;paid:boolean;unknown:boolean};
type Participant={taskId:string;lineageHashes:string[];preserveStatus:string|null};
const terminal=(status:unknown)=>['completed','succeeded','delivered','awaiting_publish','awaiting_metrics','reviewed'].includes(socialText(status));
export function socialContentCancellationGroupHash(taskId:string,revisions:CreationQuotaOrder['revisions']=[]){
 return socialRequestHash({schemaVersion:'social-content-cancellation-group.v1',taskId,revisions:[...(revisions??[])].map(r=>({executionTaskId:r.executionTaskId,lineageHash:r.lineageHash,commandId:r.commandId})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
}
/** This is a stop-only proof, not renewed execution authority. An expired
 * unstarted repair must remain stoppable; its original durable proof is checked
 * at issuance, while every immutable case/artifact/configuration is still read. */
async function cancellationParticipants(input:{repository:Starter198Repository;tenantId:string;taskId:string;now?:Date},order:CreationQuotaOrder|undefined,root:any){
 const registrations=order?.revisions??[],ids=[...new Set([input.taskId,...registrations.map(r=>r.executionTaskId)])].sort();
 const participants:Participant[]=[];
 for(const taskId of ids){
  const task=taskId===input.taskId?root:await requireSocialTask({...input,taskId});
  const binding=socialObject(socialJson(task.content_order));
  if(binding?.schemaVersion!=='social-content-order.v1'||binding.contentId!==input.taskId||binding.budgetTaskId!==input.taskId
    ||binding.programId!==socialObject(socialJson(root.content_order))?.programId||binding.originWeek!==socialObject(socialJson(root.content_order))?.originWeek)return fail('participant_binding_invalid');
  const own=registrations.filter(r=>r.executionTaskId===taskId);
  if(own.length){
   const proof=socialObject(socialObject(socialJson(task.brief))?._weeklyCreativeRepairProof);
   const proofAt=proof&&new Date(String(proof.issuedAt));
   const lineage=await resolveSocialContentCostLineage({...input,taskId,...(proofAt&&Number.isFinite(proofAt.getTime())?{now:proofAt}:{})});
   if(lineage.contentId!==input.taskId||lineage.budgetTaskId!==input.taskId||lineage.programId!==binding.programId||lineage.originWeek!==binding.originWeek)return fail('participant_lineage_invalid');
   // Historical in-place revisions may have different frozen plan hashes. Each
   // registration must have its own persisted, immutable dispatch command.
   const dispatches=[binding.dispatch,...(Array.isArray(binding.dispatchHistory)?binding.dispatchHistory:[])].filter(Boolean);
   for(const registration of own){
    if(registration.lineageHash!==lineage.lineageHash&&!(taskId===input.taskId&&dispatches.some(d=>d.commandId===registration.commandId)))return fail('participant_lineage_invalid');
    if(!dispatches.some(d=>d.commandId===registration.commandId&&d.queueRequest?.subject?.id===taskId
      &&d.queueRequest?.tenantId===input.tenantId&&d.requestHash===socialRequestHash((({requestHash,...body})=>body)(d)) ))return fail('participant_dispatch_invalid');
   }
  }
  participants.push({taskId,lineageHashes:own.map(r=>r.lineageHash).sort(),preserveStatus:terminal(task.status)?socialText(task.status):null});
 }
 return participants;
}
/** Read actual persisted evidence across every revision. Absence of a receipt is
 * not proof that a previously-started worker never submitted an external call. */
export async function readSocialContentOrderReleaseSafety(input:{repository:Starter198Repository;scope:QuotaScope;
 order:CreationQuotaOrder;budgetRoot?:string;allowUnstartedPlan?:boolean;allowUnboundDraft?:boolean;taskIds?:string[]}):Promise<Safety>{
 const store=input.repository.dataStore;if(!store)return{leaseActive:true,inFlight:true,paid:true,unknown:true};
 const result:Safety={leaseActive:false,inFlight:false,paid:false,unknown:false};
 for(const taskId of new Set(input.taskIds??[input.order.contentId,...(input.order.revisions??[]).map(r=>r.executionTaskId)])){
  const rows=await input.repository.list(STARTER_COLLECTIONS.socialContentTasks,input.scope.tenantId,{where:{task_id:taskId},perPage:2});
  if(rows.totalItems!==1||rows.items.length!==1){result.unknown=true;continue;}
  const task=rows.items[0],binding=socialObject(socialJson(task.content_order));
  const brief=socialObject(socialJson(task.brief));
  const unboundDraft=input.allowUnboundDraft===true&&input.allowUnstartedPlan===true&&input.order.state==='planned'&&!input.order.revisions?.length
   &&!brief?._productionRevision&&!brief?._weeklyCreativeRepairProof&&!socialText(task.run_id)&&!socialText(task.orchestrator_item_id)
   &&!binding?.dispatch&&!binding?.dispatchHistory&&!binding?.cancellation&&!binding?.replacedByContentId
   &&['draft','needs_input','plan_review'].includes(socialText(task.status));
  if(binding?.schemaVersion!=='social-content-order.v1'||binding?.contentId!==input.order.contentId||binding?.budgetTaskId!==input.order.contentId
    ||(binding?.programId!==input.scope.programId&&!(unboundDraft&&binding?.programId==null))
    ||(binding?.originWeek!==input.scope.weekStart&&!(unboundDraft&&binding?.originWeek==null))){result.unknown=true;continue;}
  // Replacement callers may only use this proof for a fenced cancellation or
  // an actually unstarted plan, never a live task that can still be started.
  const unstartedPlan=input.allowUnstartedPlan===true&&input.order.state==='planned'&&!socialText(task.run_id)&&!socialText(task.orchestrator_item_id)&&!binding.dispatch
    &&!Array.isArray(binding.dispatchHistory)&&!socialObject(binding.cancellation)
    &&['draft','needs_input','plan_review','attention'].includes(socialText(task.status));
  if(!['cancelled','cancelling'].includes(socialText(task.status))&&!terminal(task.status)&&!unstartedPlan)result.inFlight=true;
  const jobs=await store.list<any>('content_execution_jobs',{where:{tenant_id:input.scope.tenantId,task_id:taskId},perPage:1000});
  if(jobs.totalItems!==jobs.items.length)result.unknown=true;
  if(unstartedPlan&&jobs.totalItems)result.inFlight=true;
  if((socialText(task.run_id)||socialText(task.orchestrator_item_id))&&!jobs.items.length)result.unknown=true;
  for(const job of jobs.items){
   if(job.worker_id||job.lease_expires_at)result.leaseActive=true;
   if(!['cancelled','succeeded','dead_letter'].includes(job.status))result.inFlight=true;
   // A persisted terminal production is historical activity even if legacy
   // start/receipt columns are absent. Missing accounting is not a free slot.
   if(job.last_started_at||Number(job.attempt)>0||['succeeded','dead_letter'].includes(job.status))result.unknown=true;
   if(!Array.isArray(job.provider_receipts))result.unknown=true;
   for(const receipt of Array.isArray(job.provider_receipts)?job.provider_receipts:[]){
    if(['accepted','completed'].includes(receipt.state))result.paid=true;
    if(!['rejected','failed'].includes(receipt.state))result.unknown=true;
   }
   if(job.provider_state&&!['none','rejected','failed'].includes(job.provider_state))result.unknown=true;
  }
  const leases=await store.list<any>('durable_operation_leases',{where:{tenant_id:input.scope.tenantId,lease_scope:'content_execution_job'},perPage:1000});
  if(leases.totalItems!==leases.items.length)result.unknown=true;
  if(leases.items.some(l=>jobs.items.some(j=>j.id===l.subject_id)))result.leaseActive=true;
  try{
   const ledger=new SocialContentTaskBudget(input.budgetRoot,{authorization:async()=>{throw Error('read_only');},quote:async()=>{throw Error('read_only');},assertCurrent:async()=>{},verifyRejection:async()=>false});
   const status=ledger.status({tenantId:input.scope.tenantId,taskId, budgetTaskId:input.order.contentId,runId:'cancellation-evidence',planHash:'0'.repeat(64)});
   if(status?.entries.some(e=>e.status!=='rejected'))result.paid=true;
   if(status?.entries.some(e=>['reserved','accepted','unknown'].includes(e.status)))result.unknown=true;
   // A historical child ledger must not disappear behind the shared alias.
   if(taskId!==input.order.contentId&&ledger.status({tenantId:input.scope.tenantId,taskId,runId:'cancellation-evidence',planHash:'0'.repeat(64)})?.entries.length)result.unknown=true;
  }catch{result.unknown=true;}
 }
 return result;
}

export async function cancelSocialContentOrder(input:{repository:Starter198Repository;tenantId:string;userId:string;
 taskId:string;expectedVersion:string;idempotencyKey:string;reason:string;expectedGroupHash?:string;now?:Date;budgetRoot?:string}){
 if(!input.reason.trim())return fail('reason_required');
 const result=await executeSocialContentMutation({...input,operation:'cancel_social_content_order',targetId:input.taskId,
  requestHash:socialRequestHash({expectedVersion:input.expectedVersion,reason:input.reason,actorId:input.userId,...(input.expectedGroupHash?{expectedGroupHash:input.expectedGroupHash}:{})}),
  replay:async()=>{const row=await requireSocialTask(input);return socialObject(socialObject(socialJson(row.content_order))?.cancellation)?.result as any;},
  action:async operationId=>{
   let task=await requireSocialTask(input);const store=input.repository.dataStore;
   if(!store?.compareAndSwap||!await store.supportsAtomicCompareAndSwap?.())return fail('atomic_store_required');
   let binding=socialObject(socialJson(task.content_order));
   if(binding?.schemaVersion!=='social-content-order.v1'||binding.contentId!==input.taskId||binding.budgetTaskId!==input.taskId)return fail('root_order_required');
   const previous=socialObject(binding.cancellation);
   if(previous?.operationId!==operationId&&socialText(task.version)!==input.expectedVersion)return fail('version_conflict');
   if(previous&&previous.operationId!==operationId)return fail('already_requested');
   let persistedOrder:CreationQuotaOrder|undefined;
   if(binding.programId&&binding.originWeek){
    const pools=await store.list<any>('social_content_creation_quotas',{where:{tenant_id:input.tenantId,program_id:String(binding.programId),week_start:String(binding.originWeek)},perPage:2});
    if(pools.totalItems>1||pools.totalItems!==pools.items.length)return fail('quota_ambiguous');
    persistedOrder=pools.items[0]?.payload?.orders?.[input.taskId];
   }
   if(!previous&&!persistedOrder?.revisions?.length){
    if(terminal(task.status))return fail('already_completed');
    if(persistedOrder?.state==='delivered')return fail('already_delivered');
   }
   if(!previous&&(persistedOrder?.revisions?.length||input.expectedGroupHash)&&input.expectedGroupHash!==socialContentCancellationGroupHash(input.taskId,persistedOrder?.revisions))return fail('group_changed');
   if(previous?.groupHash&&previous.groupHash!==socialContentCancellationGroupHash(input.taskId,persistedOrder?.revisions))throw Error('social_content_order_cancel_frozen_group_changed');
   const participants=previous?.participants as Participant[]|undefined??await cancellationParticipants(input,persistedOrder,task);
   if(!participants.length||!participants.some(p=>p.taskId===input.taskId)||new Set(participants.map(p=>p.taskId)).size!==participants.length)return fail('manifest_invalid');
   // A durable manifest is recovery authority, never a mutable task-ID request.
   if(previous?.participantsHash&&previous.participantsHash!==socialRequestHash(participants))return fail('manifest_invalid');
   const rootParticipant=participants.find(p=>p.taskId===input.taskId)!;
   if(!previous){
    const changed={...binding,cancellation:{schemaVersion:'social-content-cancellation.v1',operationId,actorId:input.userId,
      expectedVersion:input.expectedVersion,idempotencyKey:input.idempotencyKey,reason:input.reason,at:(input.now??new Date()).toISOString(),
      rootTaskId:input.taskId,participants,participantsHash:socialRequestHash(participants),groupHash:socialContentCancellationGroupHash(input.taskId,persistedOrder?.revisions),...(input.expectedGroupHash?{expectedGroupHash:input.expectedGroupHash}:{})}};
    if(!await store.compareAndSwap(STARTER_COLLECTIONS.socialContentTasks,task.id,{tenant_id:input.tenantId,version:task.version,content_order:task.content_order},
      {status:rootParticipant.preserveStatus??'cancelling',version:String(Number(task.version)+1),content_order:changed,last_operation_id:operationId,updated_by:input.userId}))return fail('version_conflict');
    task=await requireSocialTask(input);binding=socialObject(socialJson(task.content_order))!;
   }
   // Same lease as claimNextJob: prevents stale queued snapshots from claiming
   // after cancellation and prevents a false no-worker proof during release.
   const controlGroup=async()=>{
   const scheduler=await acquireDurableOperationLease({dataStore:store,tenantId:'__system__',scope:'content_queue_scheduler',subjectId:'global',ownerId:`cancel:${randomUUID()}`,leaseDurationMs:60000});
   if(!scheduler)throw Error('social_content_order_cancel_scheduler_busy');
   try{
    const participantOutcomes:Array<{taskId:string;status:string;preservedStatus:string|null;jobIds:string[];retainedReasons:string[]}>=[];
    for(const participant of participants){
    await assertDurableOperationLease({dataStore:store,lease:scheduler,minimumRemainingMs:1000});
    const currentTask=await requireSocialTask({...input,taskId:participant.taskId});
    const jobs=await store.list<any>('content_execution_jobs',{where:{tenant_id:input.tenantId,task_id:participant.taskId},perPage:1000});
    if(jobs.totalItems!==jobs.items.length)throw Error('social_content_order_cancel_jobs_truncated');
    for(const job of jobs.items){
     if(!['succeeded','cancelled','dead_letter'].includes(job.status))await controlContentExecutionJob({dataStore:store,tenantId:input.tenantId,jobId:job.id,action:'cancel',now:input.now});
    }
    for(const runId of new Set([socialText(currentTask.run_id),...jobs.items.map(job=>socialText(job.run_id))].filter(Boolean))){
     const run=await input.repository.get(STARTER_COLLECTIONS.runs,input.tenantId,runId);
     const context=socialObject(socialJson(run?.starter_context));
     if(run&&context?.socialTaskId===participant.taskId&&!['completed','succeeded','failed','cancelled'].includes(socialText(run.status)))
      if(!await store.compareAndSwap!(STARTER_COLLECTIONS.runs,run.id,{tenant_id:input.tenantId,status:run.status},{status:'cancelled',pause_reason:input.reason,completed_at:(input.now??new Date()).toISOString()}))throw Error('social_content_order_cancel_run_conflict');
    }
    participantOutcomes.push({taskId:participant.taskId,status:participant.preserveStatus??'cancelled',preservedStatus:participant.preserveStatus,jobIds:jobs.items.map(j=>String(j.id)),retainedReasons:[]});
    }
    let quotaReleased=false,retainedReasons:string[]=[];
    if(binding.programId&&binding.originWeek){
     const scope={tenantId:input.tenantId,programId:String(binding.programId),weekStart:String(binding.originWeek)};
     const quota=createContentCreationQuotaService({store,assertAtomicStore:async()=>{},now:()=>input.now??new Date(),verifyDelivery:async()=>false,
      readReleaseSafety:order=>readSocialContentOrderReleaseSafety({...input,scope,order})});
     const pool=await quota.read(scope),order=pool?.orders[input.taskId];
     if(!order)retainedReasons=['reservation_missing'];
     else if(order.state==='released')quotaReleased=true;
     else {const safety=await readSocialContentOrderReleaseSafety({...input,scope,order});
      retainedReasons=Object.entries(safety).filter(([,value])=>value).map(([key])=>key);
      if(order.state==='delivered')retainedReasons.push('already_delivered');
      if(!retainedReasons.length){await assertDurableOperationLease({dataStore:store,lease:scheduler,minimumRemainingMs:1000});await quota.release(scope,{commandId:`${operationId}:release`,actorId:input.userId,reason:input.reason},input.taskId);quotaReleased=true;}
     }
    }
    // Task fences stop future work; they do not revoke a request already sent
    // to a provider. Its worker lease, receipt and ledger remain unchanged.
    for(const participant of participantOutcomes){
     const row=await requireSocialTask({...input,taskId:participant.taskId}),childOrder=socialObject(socialJson(row.content_order))!;
     if(binding.programId&&binding.originWeek&&persistedOrder){
      const evidence=await readSocialContentOrderReleaseSafety({...input,scope:{tenantId:input.tenantId,programId:String(binding.programId),weekStart:String(binding.originWeek)},order:persistedOrder,taskIds:[participant.taskId]});
      participant.retainedReasons=Object.entries(evidence).filter(([,value])=>value).map(([key])=>key);
     }
     if(participant.taskId!==input.taskId){
      const childResult={...participant,executionStopped:true};
      if(!await store.compareAndSwap!(STARTER_COLLECTIONS.socialContentTasks,row.id,{tenant_id:input.tenantId,content_order:row.content_order},
       {status:participant.status,content_order:{...childOrder,cancellation:{...socialObject(childOrder.cancellation),participantResult:childResult}},updated_at:(input.now??new Date()).toISOString()}))throw Error('social_content_order_cancel_child_projection_conflict');
     }
    }
    const outcome={taskId:input.taskId,status:rootParticipant.preserveStatus??'cancelled',quotaReleased,retainedReasons,
      executionStopped:true,externalSettlementPending:retainedReasons.some(r=>['leaseActive','inFlight','unknown'].includes(r)),participants:participantOutcomes};
    await assertDurableOperationLease({dataStore:store,lease:scheduler,minimumRemainingMs:1000});
    const current=await requireSocialTask(input),order=socialObject(socialJson(current.content_order))!;
    if(!await store.compareAndSwap!(STARTER_COLLECTIONS.socialContentTasks,current.id,{tenant_id:input.tenantId,content_order:current.content_order},
      {status:outcome.status,content_order:{...order,cancellation:{...socialObject(order.cancellation),result:outcome}},updated_at:(input.now??new Date()).toISOString()}))throw Error('social_content_order_cancel_projection_conflict');
    return outcome;
   }finally{await releaseDurableOperationLease({dataStore:store,lease:scheduler});}
   };
   // Lock acquisition is nonblocking. A child start may already hold its own
   // lock while waiting for root admission, so a busy child leaves a durable
   // root fence and processing operation for retry instead of deadlocking.
   const fenceChildren=async(index:number):Promise<any>=>{
    if(index===participants.length)return controlGroup();
    const participant=participants[index]!;
    if(participant.taskId===input.taskId)return fenceChildren(index+1);
    try{return await withSocialContentSubjectLease({repository:input.repository,tenantId:input.tenantId,subjectId:participant.taskId,action:async()=>{
     const child=await requireSocialTask({...input,taskId:participant.taskId}),childOrder=socialObject(socialJson(child.content_order));
     if(childOrder?.contentId!==input.taskId||childOrder.budgetTaskId!==input.taskId)throw Error('social_content_order_cancel_child_binding_changed');
     const childCancellation=socialObject(childOrder.cancellation);
     if(childCancellation&&childCancellation.operationId!==operationId)throw Error('social_content_order_cancel_child_command_conflict');
     if(!childCancellation){
      if(!await store.compareAndSwap!(STARTER_COLLECTIONS.socialContentTasks,child.id,{tenant_id:input.tenantId,version:child.version,content_order:child.content_order},
       {status:participant.preserveStatus??'cancelling',version:String(Number(child.version)+1),content_order:{...childOrder,cancellation:{schemaVersion:'social-content-cancellation-participant.v1',operationId,rootTaskId:input.taskId,actorId:input.userId,reason:input.reason,at:(input.now??new Date()).toISOString()}},updated_by:input.userId}))throw Error('social_content_order_cancel_child_fence_conflict');
     }
     return fenceChildren(index+1);
    }});}catch(error){if(error instanceof SocialContentWorkflowError&&error.code==='social_content_mutation_busy')throw Error('social_content_order_cancel_child_busy');throw error;}
   };
   try{return await fenceChildren(0);}catch(error){
    // Once the stop fence exists, an incomplete participant projection is a
    // recoverable stop command, not a final business rejection.
    if(error instanceof SocialContentWorkflowError)throw Error(`social_content_order_cancel_group_pending:${error.code}`);
    throw error;
   }
  }});
 return result.value;
}

/** Recover only a previously authorized, still-processing cancellation. Exact
 * original command bytes and actor are checked; no new cancellation is inferred
 * from a paused/error task, and business-rejected operations stay rejected. */
export async function recoverPendingSocialContentOrderCancellations(input:{repository:Starter198Repository;now?:Date;budgetRoot?:string;
 maximumTasks?:number;afterTaskKey?:string;onAttempt?:(key:string)=>void}){
 const store=input.repository.dataStore;if(!store)return{recovered:0,failed:0};
 const candidates:any[]=[];
 for(let page=1;page<=100;page++){
  const rows=await store.list<any>(STARTER_COLLECTIONS.socialContentTasks,{page,perPage:100,sort:'id'});
  candidates.push(...rows.items.filter(row=>{const binding=socialObject(socialJson(row.content_order));return binding?.contentId===row.task_id&&socialObject(binding?.cancellation);}));
  if(!rows.items.length||page>=rows.totalPages||rows.totalItems<=page*100)break;
  if(page===100)throw Error('social_content_order_cancel_scan_limit');
 }
 const key=(row:any)=>JSON.stringify([row.tenant_id,row.task_id]);candidates.sort((a,b)=>key(a).localeCompare(key(b)));
 const split=input.afterTaskKey?candidates.findIndex(row=>key(row).localeCompare(input.afterTaskKey!)>0):0,start=split<0?0:split;
 let recovered=0,failed=0;
 for(const row of [...candidates.slice(start),...candidates.slice(0,start)].slice(0,Math.max(1,Math.min(100,input.maximumTasks??20)))){
  input.onAttempt?.(key(row));
  const cancellation=socialObject(socialObject(socialJson(row.content_order))?.cancellation);
  if(!cancellation||cancellation.schemaVersion!=='social-content-cancellation.v1')continue;
  try{
   const tenantId=socialText(row.tenant_id),taskId=socialText(row.task_id),userId=socialText(cancellation.actorId),
    expectedVersion=socialText(cancellation.expectedVersion),idempotencyKey=socialText(cancellation.idempotencyKey),reason=typeof cancellation.reason==='string'?cancellation.reason:'',expectedGroupHash=socialText(cancellation.expectedGroupHash)||undefined;
   const operations=await input.repository.list(STARTER_COLLECTIONS.socialContentOperations,tenantId,{where:{operation_id:socialText(cancellation.operationId)},perPage:2});
   const operation=operations.items[0];
   if(operation?.status==='succeeded')continue;
   if(operations.totalItems!==1||!operation||operation.operation!=='cancel_social_content_order'||operation.target_id!==taskId
     ||operation.status!=='processing'||operation.created_by!==userId||operation.idempotency_key!==idempotencyKey
     ||operation.request_hash!==socialRequestHash({expectedVersion,reason,actorId:userId,...(expectedGroupHash?{expectedGroupHash}:{})}))throw Error('cancellation_original_command_unverified');
   await cancelSocialContentOrder({...input,tenantId,taskId,userId,expectedVersion,idempotencyKey,reason,expectedGroupHash});recovered++;
  }catch{failed++;}
 }
 return{recovered,failed,truncated:false};
}
