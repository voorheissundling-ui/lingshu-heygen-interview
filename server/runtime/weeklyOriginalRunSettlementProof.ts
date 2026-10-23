import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyAgentPlanningState,WeeklyExecutionTask,WeeklyOperatingPackage,VersionedSocialRef} from '../../shared/contracts/socialProgram.js';
import {naturalWeek} from '../../shared/naturalWeek.js';
import {scheduleHash} from '../socialPrograms/weeklyScheduleSnapshots.js';
import {weeklyContinuationInputHash} from '../socialPrograms/weeklyExecutionContinuations.js';
import {WEEKLY_AUTOMATIC_PRODUCTION_INTENTS,type WeeklyAutomaticProductionIntent} from '../socialPrograms/weeklyAutomaticProductionPlanning.js';
import {WEEKLY_PRODUCTION_SCOPE_CAPACITIES,type ProductionScopeCapacity} from '../socialPrograms/weeklyProductionScopeCapacity.js';
import {verifiedWeeklyPlanningTemplateAdoption} from '../socialPrograms/weeklyPlanningTemplateAdoption.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {socialContentQueueItemId} from '../starter198/socialContentScheduler.js';
import {CONTENT_CREATION_QUOTA_COLLECTION} from '../socialPrograms/contentCreationQuota.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {validateContentArtifact} from './socialWeeklyResultValidation.js';

type Scope={tenantId:string;programId:string;packageId:string;packageVersion:number};
type Input={store:DataStore;task:WeeklyExecutionTask;pkg:WeeklyOperatingPackage;planning:WeeklyAgentPlanningState;now:string};
export type OriginalRunSettlementProof={contentTaskId:string;runId:string;jobId:string;startOperationId:string;capacityProofId:string;artifactRef:VersionedSocialRef};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const object=(value:unknown):Record<string,any>=>socialObject(socialJson(value))??{};
const inWeek=(value:unknown,pkg:WeeklyOperatingPackage)=>{
 const date=Date.parse(text(value));
 return Number.isFinite(date)&&naturalWeek(new Date(date).toISOString()).start===pkg.weekStart&&naturalWeek(new Date(date).toISOString()).end===pkg.weekEnd;
};
const unique=async(store:DataStore,collection:string,where:Record<string,string|number|boolean>)=>{
 const rows=await store.list<Record_>(collection,{where,perPage:2});
 return rows.totalItems===1&&rows.items.length===1?rows.items[0]:null;
};
/** A post-week quality receipt is historical evidence only when its own
 * persisted completion instant follows the original start and is observable
 * now. It never grants capacity for another production. */
export function originalRunArtifactCompletionInBounds(createdAt:unknown,jobCreatedAt:unknown,observedAt:unknown):boolean{
 const completed=Date.parse(text(createdAt)),started=Date.parse(text(jobCreatedAt)),observed=Date.parse(text(observedAt));
 return Number.isFinite(completed)&&Number.isFinite(started)&&Number.isFinite(observed)&&completed>=started&&completed<=observed;
}
const packageProductionHash=(pkg:WeeklyOperatingPackage)=>scheduleHash({programId:pkg.programId,packageId:pkg.packageId,version:pkg.version,weekStart:pkg.weekStart,weekEnd:pkg.weekEnd,productionIdentityVersion:pkg.socialContentPackage.productionIdentityVersion,publicationTasks:pkg.socialContentPackage.publicationTasks.map(({status,...value})=>value),weeklyBudgetCny:pkg.socialContentPackage.weeklyBudgetCny});

/** Historical admission is evidence of an original run, never a fresh capacity grant.
 * This reader has no writes and refuses any missing or ambiguous link. It is
 * deliberately not wired into ordinary production admission. */
export async function readWeeklyOriginalRunStartProof(input:Input):Promise<OriginalRunSettlementProof|null>{
 const {store,task,pkg,planning,now}=input;
 if(!Number.isFinite(Date.parse(now))||Date.parse(now)<=Date.parse(`${pkg.weekEnd}T23:59:59.999+08:00`)||pkg.status==='retired'
  ||!['quality_check','rework'].includes(task.schedule.stepKind)||!task.publicationTaskId
  ||task.inputSnapshot?.weeklyCreativeRepairRef||task.inputSnapshot?.inventoryReuseRef
  ||task.tenantId!==text((pkg as any).tenantId)&&Boolean((pkg as any).tenantId)
  ||task.programId!==pkg.programId||task.packageId!==pkg.packageId||task.packageVersion!==pkg.version
  ||pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1')return null;
 const scope:Scope={tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion};
 const adoption=verifiedWeeklyPlanningTemplateAdoption(planning);
 if(!adoption||planning.status!=='dispatched'||!planning.dispatch)return null;
 const intentId=socialRequestHash([scope,adoption.recordHash]);
 const intentRow=await store.getById<Record_>(WEEKLY_AUTOMATIC_PRODUCTION_INTENTS,intentId);
 const intent=intentRow?.payload as WeeklyAutomaticProductionIntent|undefined;
 if(!intent||intentRow?.tenant_id!==task.tenantId||intentRow.content_hash!==socialRequestHash(intent)
  ||intent.intentId!==intentId||socialRequestHash(intent.scope)!==socialRequestHash(scope)
  ||intent.source!=='automatic_template'||intent.templateVersion!=='weekly-automation.v3'||intent.userApproval!==null
  ||intent.authorizesPublishing!==false||intent.authorizesContentAcceptance!==false||intent.authorizesCustomerMessages!==false
  ||intent.planningAdoptionHash!==adoption.recordHash||intent.dispatchHash!==socialRequestHash(planning.dispatch)
  ||socialRequestHash(intent.selectedPublicationTaskIds)!==socialRequestHash(planning.dispatch.scheduleItems.map(item=>item.publicationTaskId))
  ||!intent.selectedPublicationTaskIds.includes(task.publicationTaskId))return null;
 const capacityRow=await store.getById<Record_>(WEEKLY_PRODUCTION_SCOPE_CAPACITIES,intent.capacityProofId);
 const capacity=capacityRow?.payload as ProductionScopeCapacity|undefined;
 if(!capacity||capacityRow?.tenant_id!==task.tenantId||capacityRow.content_hash!==scheduleHash(capacity)
  ||capacity.proofId!==intent.capacityProofId||capacity.source!=='automatic_template'||capacity.budgetPolicyVersion!=='weekly-per-film-10.v1'
  ||capacity.userApproval!==null||capacity.authorizesPublishing!==false||capacity.authorizesAcceptance!==false||capacity.authorizesCustomerMessages!==false
  ||capacity.perFilmIncludingRevisionsMaxCny!==10||capacity.planningAdoptionHash!==adoption.recordHash
  ||capacity.detailedScheduleHash!==scheduleHash(planning.detailedSchedule)
  ||scheduleHash(capacity.selectedSlotIds)!==scheduleHash(adoption.selectedSlotIds)
  ||scheduleHash(capacity.planningRef)!==scheduleHash(planning.detailedSchedule?.ref)
  ||capacity.packageProductionHash!==packageProductionHash(pkg)
  ||capacity.tenantId!==scope.tenantId||capacity.programId!==scope.programId||capacity.packageId!==scope.packageId||capacity.packageVersion!==scope.packageVersion
  ||capacity.selectedPublicationTaskIds.includes(task.publicationTaskId)===false
  ||capacity.assignments.length!==new Set(capacity.assignments.map(entry=>entry.taskId)).size
  ||capacity.reservedBudgetCny!==capacity.assignments.reduce((sum,entry)=>sum+entry.reservedCny,0)
  ||capacity.assignments.some(entry=>entry.reservedCny<0||entry.reservedCny>10))return null;
 const {proofId,...body}=capacity;
 // Planning-template acceptance may predate this natural week. intent.adoptedAt
 // is instead the timestamp of formal production preparation (set from `now`
 // alongside the capacity proof); both must belong to the original week and
 // neither substitutes for evidence of the actual run start.
 if(scheduleHash(body)!==proofId||!inWeek(intent.adoptedAt,pkg)||!inWeek(capacity.adoptedAt,pkg)
  ||capacity.adoptedAt!==intent.adoptedAt||capacity.reservedBudgetCny>pkg.socialContentPackage.weeklyBudgetCny!)return null;
 // A historical proof cannot be re-issued after the week, but its complete
 // frozen graph still has to be present. Checking only the requested quality
 // node would allow an unrelated ancestor to drift while its old capacity
 // assignment remains trusted for settlement.
 for(const entry of capacity.assignments){
  const row=await unique(store,'social_weekly_execution_tasks',{tenant_id:scope.tenantId,task_id:entry.taskId});
  const current=row?.payload as WeeklyExecutionTask|undefined;
  if(!current||current.tenantId!==scope.tenantId||current.programId!==scope.programId
   ||current.packageId!==scope.packageId||current.packageVersion!==scope.packageVersion
   ||weeklyContinuationInputHash(current)!==entry.inputHash
   ||current.schedule.estimatedDurationMinutes!==entry.estimatedDurationMinutes
   ||scheduleHash(current.dependsOnTaskIds)!==scheduleHash(entry.dependencies)
   ||['cancelled','dead_letter'].includes(current.status)
   ||entry.mode==='verified_completed'&&(current.status!=='succeeded'
    ||scheduleHash(current.resultRefs)!==entry.resultHash
    ||Date.parse(current.schedule.actualFinishedAt??'')!==Date.parse(entry.finishAt)))return null;
 }
 const assignment=capacity.assignments.find(entry=>entry.taskId===task.taskId);
 if(!assignment||assignment.inputHash!==weeklyContinuationInputHash(task)||assignment.reservedCny>10
  ||!inWeek(assignment.startAt,pkg)||!inWeek(assignment.finishAt,pkg)
  ||assignment.dependencies.length!==task.dependsOnTaskIds.length
  ||scheduleHash(assignment.dependencies)!==scheduleHash(task.dependsOnTaskIds))return null;
 const dependents:VersionedSocialRef[]=[];
 for(const id of task.dependsOnTaskIds){
  const row=await unique(store,'social_weekly_execution_tasks',{tenant_id:task.tenantId,task_id:id});
  const parent=row?.payload as WeeklyExecutionTask|undefined;
  if(!parent||parent.tenantId!==task.tenantId||parent.programId!==task.programId||parent.packageId!==task.packageId
   ||parent.packageVersion!==task.packageVersion||parent.status!=='succeeded')return null;
  dependents.push(...parent.resultRefs.filter(ref=>ref.type==='starter_social_content_artifact'));
 }
 const refs=[...new Map(dependents.map(ref=>[`${ref.type}:${ref.id}:${ref.version}`,ref])).values()];
 if(refs.length!==1)return null;
 const artifactRef=refs[0]!;
 const content=await unique(store,'starter_social_content_tasks',{tenant_id:task.tenantId,create_idempotency_key:`weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`});
 const brief=object(content?.brief);
 if(!content||text(content.weekly_plan_id)!==task.packageId||!text(content.task_id)||!text(content.run_id)
  ||brief.programRef?.id!==task.programId||brief._weeklyCreativeRepairProof||brief._productionRevision
  ||['cancelled','cancelling'].includes(text(content.status)))return null;
 const contentOrder=object(content.content_order),dispatch=object(contentOrder.dispatch),{requestHash,...dispatchBody}=dispatch;
 const queue=object(dispatch.queueRequest),subject=object(queue.subject);
 if(contentOrder.schemaVersion!=='social-content-order.v1'||contentOrder.entry!=='weekly_package'
  ||contentOrder.contentId!==content.task_id||contentOrder.budgetTaskId!==content.task_id
  ||contentOrder.cancellation||contentOrder.replacedByContentId||contentOrder.supersededByContentId
  ||dispatch.schemaVersion!=='social-content-dispatch.v1'||requestHash!==socialRequestHash(dispatchBody)
  ||!text(dispatch.commandId)||dispatch.userId!==intent.actorUserId||!text(dispatch.idempotencyKey)
  ||queue.tenantId!==task.tenantId||queue.userId!==dispatch.userId||queue.commandId!==dispatch.commandId
  ||queue.idempotencyKey!==dispatch.idempotencyKey||queue.workflowScope!=='social_content'
  ||subject.type!=='social_content_task'||subject.id!==content.task_id||subject.admissionVersion!==dispatch.expectedVersion
  ||text(content.orchestrator_item_id)!==socialContentQueueItemId(queue as any)
  ||contentOrder.programId!==task.programId||contentOrder.originWeek!==pkg.weekStart)return null;
 // Planned weekly capacity is not evidence that the original content order
 // actually occupied a slot. Read the original week's atomic quota record;
 // never reserve a new slot while settling a historical run.
 const quotaRow=await unique(store,CONTENT_CREATION_QUOTA_COLLECTION,{tenant_id:task.tenantId,program_id:task.programId,week_start:pkg.weekStart});
 const quota=object(quotaRow?.payload),quotaScope=object(quota.scope),orders=object(quota.orders),order=object(orders[String(content.task_id)]);
 const matchingSlots=Array.isArray(quota.slots)?quota.slots.filter((slot:unknown)=>object(slot).contentId===content.task_id):[];
 const matchingOutbox=Array.isArray(quota.outbox)?quota.outbox.filter((entry:unknown)=>object(entry).kind==='dispatch'&&object(entry).contentId===content.task_id&&object(entry).commandId===dispatch.commandId&&!object(entry).executionTaskId):[];
 const matchingReserve=Array.isArray(quota.audit)?quota.audit.filter((entry:unknown)=>object(entry).action==='reserved'&&object(entry).contentId===content.task_id&&object(entry).commandId===dispatch.commandId&&object(entry).actorId===dispatch.userId):[];
 if(!quotaRow||quotaScope.tenantId!==task.tenantId||quotaScope.programId!==task.programId||quotaScope.weekStart!==pkg.weekStart
  ||order.contentId!==content.task_id||order.entry!=='weekly_package'||order.packageId!==pkg.packageId||order.packageVersion!==pkg.version
  ||!['reserved','running','delivered'].includes(order.state)||order.productionTaskId&&order.productionTaskId!==content.task_id
  ||matchingSlots.length!==1||object(matchingSlots[0]).slotId!==order.slotId
  ||matchingOutbox.length!==1||object(matchingOutbox[0]).state!=='acknowledged'
  ||matchingReserve.length!==1||!inWeek(object(matchingReserve[0]).at,pkg))return null;
 const operation=await unique(store,'starter_social_content_operations',{tenant_id:task.tenantId,operation_id:dispatch.commandId});
 const operationReceipt=object(operation?.result);
 if(!operation||operation.operation!=='start_social_content_task'||operation.status!=='succeeded'
  ||operation.target_id!==content.task_id||operation.created_by!==dispatch.userId||operation.idempotency_key!==dispatch.idempotencyKey
  ||operation.request_hash!==socialRequestHash({expectedVersion:dispatch.expectedVersion})||!inWeek(operation.created_at,pkg)
  ||Date.parse(text(operation.created_at))<Date.parse(capacity.adoptedAt)
  // The quota reservation is an original-run precondition, not a fact that
  // can be added after the start operation to make a historical run look
  // funded. Keep the ordering tied to the same frozen capacity proof.
  ||Date.parse(text(object(matchingReserve[0]).at))<Date.parse(capacity.adoptedAt)
  ||Date.parse(text(object(matchingReserve[0]).at))>Date.parse(text(operation.created_at))
  ||operationReceipt.schemaVersion!=='social-content.operation-result.v1'
  ||operationReceipt.operationId!==dispatch.commandId||operationReceipt.targetId!==content.task_id)return null;
 const run=await store.getById<Record_>('workflow_runs',String(content.run_id)),context=object(run?.starter_context);
 if(!run||run.tenant_id!==task.tenantId||run.id!==content.run_id||run.product_profile!=='starter_198'
  ||context.schemaVersion!=='starter-social-content.auto-execution.v1'||context.socialTaskId!==content.task_id
  ||!inWeek(run.started_at,pkg)
  ||Date.parse(text(run.started_at))<Date.parse(text(operation.created_at))
  ||['cancelled','failed','dead_letter'].includes(text(run.status)))return null;
 const job=await readContentExecutionJob(store,task.tenantId,String(content.task_id),String(content.run_id));
 if(!job||job.tenantId!==task.tenantId||job.taskId!==content.task_id||job.runId!==content.run_id
  ||job.userId!==dispatch.userId||!inWeek(job.createdAt,pkg)
  ||Date.parse(job.createdAt)<Date.parse(text(run.started_at))
  ||['cancelled','dead_letter'].includes(job.status))return null;
 return {contentTaskId:String(content.task_id),runId:String(content.run_id),jobId:job.id,startOperationId:String(operation.operation_id),capacityProofId:capacity.proofId,artifactRef};
}

/** Full settlement requires the real artifact/file/graph-QA validator as well. */
export async function readWeeklyOriginalRunSettlementProof(input:Input):Promise<(OriginalRunSettlementProof&{artifactCompletedAt:string})|null>{
 const start=await readWeeklyOriginalRunStartProof(input);
 if(!start)return null;
 // The general artifact validator retains pre-v3 compatibility. Historical
 // automatic settlement is narrower: only the current graph-produced artifact
 // carries the independent graph-review and graph-quality evidence required
 // to call the original run finished. Never promote a legacy playable file.
 const artifact=await unique(input.store,'starter_social_content_artifacts',{tenant_id:input.task.tenantId,artifact_id:start.artifactRef.id});
 const job=await readContentExecutionJob(input.store,input.task.tenantId,start.contentTaskId,start.runId);
 if(!artifact||object(artifact.content).workflowSchema!=='social-content.auto-production.v3'
  ||artifact.task_id!==start.contentTaskId||!job||job.id!==start.jobId
  ||!originalRunArtifactCompletionInBounds(artifact.created_at,job.createdAt,input.now))return null;
 const checkpoint=object(job.checkpoints?.['social.graph_review']);
 if(!originalRunArtifactCompletionInBounds(checkpoint.updatedAt,artifact.created_at,input.now))return null;
 try{
  await validateContentArtifact(input.store,input.task,start.artifactRef);
  // G4/G5 validation above proves source and outcome, while this historical
  // reader also requires the persisted receipts to exist by observation time.
  const productionId=text(object(object(artifact.content).productionResult).productionResultId);
  if(!productionId)return null;
  const receipts=await input.store.list<Record_>('starter_social_production_receipts',{where:{tenant_id:input.task.tenantId,production_result_id:productionId},perPage:500});
  if(receipts.totalItems!==receipts.items.length)return null;
  const {parseSocialProductionReceiptRecord}=await import('../starter198/socialContentProductionHandoff.js');
  for(const row of receipts.items){
   const receipt=parseSocialProductionReceiptRecord(row as import('../starter198/repository.js').StarterRecord);
   if((receipt.gate==='G4'||receipt.gate==='G5')
    &&!originalRunArtifactCompletionInBounds(receipt.createdAt,artifact.created_at,input.now))return null;
  }
 }catch{return null;}
 return {...start,artifactCompletedAt:String(artifact.created_at)};
}
