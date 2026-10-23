import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialDirectorG5Scope} from '../../shared/contracts/socialDirectorG5Review.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import {readWeeklyAutomaticProductionIntent,readWeeklyAutomaticProductionCapacity} from '../socialPrograms/weeklyAutomaticProductionPlanning.js';
import {readDirectorG5OriginalFilmBudget} from '../starter198/socialDirectorG5CanonicalBudget.js';
import {createStarter198Repository} from '../starter198/repository.js';
import {readContentExecutionJob} from '../contentExecution/durableQueue.js';
import {socialObject,socialJson,socialRequestHash} from '../starter198/socialContentValidation.js';
import {readWeeklyContentQualityAuditContext,assertWeeklyContentQualityAudit} from './weeklyContentQualityAudit.js';
import {createSocialDirectorG5ReviewService} from '../starter198/socialDirectorG5ReviewService.js';
import {assertDirectorG5FrozenCapacityEnvelope} from '../starter198/socialDirectorG5CanonicalPaidCall.js';
import {readWeeklyOriginalRunStartProof} from './weeklyOriginalRunSettlementProof.js';
import {executionPackageFrozen} from '../socialPrograms/weeklyExecutionGate.js';
import {WEEKLY_CANCELLATIONS} from '../socialPrograms/weeklyCancellation.js';
import {createHash} from 'node:crypto';

function need(value:unknown,code:string):asserts value{if(!value)throw Error(`director_g5_weekly_${code}`);}
const object=(value:unknown)=>socialObject(socialJson(value))??{};
/** The automatic policy must use the model actually reserved by the original
 * film. A runtime descriptor alone cannot replace a frozen paid hold. */
export function assertWeeklyG5RuntimeMatchesOriginalHold(runtimeModel:string,heldModel:string){
 need(runtimeModel===heldModel,'runtime_model_changed');
}
/** A historical review may be read after its week, but its original grant
 * cannot be replayed as a current paid-work permit. */
export function weeklyG5HistoricalTimeValid(authorizedAt:string,runStartedAt:unknown,observedAt:string,weekEnd:string){
 const authorized=Date.parse(authorizedAt),started=Date.parse(String(runStartedAt??'')),observed=Date.parse(observedAt),end=Date.parse(`${weekEnd}T23:59:59.999+08:00`);
 return [authorized,started,observed,end].every(Number.isFinite)&&started<=authorized&&authorized<=end&&authorized<=observed&&observed>end;
}
/** Read-only machine authority. Neither an HTTP actor nor a content-task brief
 * can turn itself into weekly permission: all three persisted weekly proofs,
 * the exact quality task and the original ten-yuan hold must still agree. */
export async function readWeeklyG5AutomaticAuthority(store:DataStore,scope:SocialDirectorG5Scope,executionTaskId:string,now=new Date().toISOString(),historicalObservationAt?:string){
 const taskRows=await store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:scope.tenantId,task_id:executionTaskId},perPage:2});
 need(taskRows.totalItems===1&&taskRows.items.length===1,'quality_task_required');
 const taskRow=taskRows.items[0]!;
 const task=taskRow?.payload as WeeklyExecutionTask|undefined;
 need(task&&taskRow?.tenant_id===scope.tenantId&&taskRow.task_id===executionTaskId&&task.taskId===executionTaskId&&task.tenantId===scope.tenantId&&task.schedule.stepKind==='quality_check'&&task.workflowKind==='content'&&task.publicationTaskId,'quality_task_required');
 const packageRows=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:scope.tenantId,program_id:task.programId,package_id:task.packageId,version:task.packageVersion},perPage:2});
 need(packageRows.totalItems===1&&packageRows.items.length===1,'package_required');
 const pkg=packageRows.items[0]!.payload as WeeklyOperatingPackage;
 need(pkg?.status==='active'&&pkg.programId===task.programId&&pkg.packageId===task.packageId&&pkg.version===task.packageVersion&&pkg.socialContentPackage.perItemBudgetCny===10,'package_changed');
 const original=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:scope.tenantId,task_id:scope.taskId},perPage:2});
 need(original.totalItems===1&&original.items.length===1,'content_task_required');
 const content=original.items[0]!,brief=object(content.brief),weekly=object(brief._weeklyAuthority),week=object(weekly.weeklyPackage),publication=object(weekly.publicationTask);
 need(content.run_id===scope.runId&&content.create_idempotency_key===`weekly-production:${task.packageId}:${task.packageVersion}:${task.publicationTaskId}`&&week.programId===task.programId&&week.packageId===task.packageId&&week.version===task.packageVersion&&publication.publicationTaskId===task.publicationTaskId,'content_binding_changed');
 const artifactRows=await store.list<Record_>('starter_social_content_artifacts',{where:{tenant_id:scope.tenantId,task_id:scope.taskId,artifact_id:scope.artifactId},perPage:2});
 need(artifactRows.totalItems===1&&artifactRows.items.length===1,'artifact_required');
 const artifact=artifactRows.items[0]!,video=object(object(artifact.content).mediaStorage);
 need(artifact.content_hash===socialRequestHash({resourceRef:artifact.resource_ref,content:object(artifact.content)})&&object(video.video).sha256,'artifact_changed');
 const upstream:WeeklyExecutionTask[]=[];
 for(const dependencyId of task.dependsOnTaskIds){const rows=await store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:scope.tenantId,task_id:dependencyId},perPage:2});need(rows.totalItems===1&&rows.items.length===1,'upstream_required');const candidate=rows.items[0]!.payload as WeeklyExecutionTask;need(candidate.taskId===dependencyId&&candidate.tenantId===task.tenantId&&candidate.programId===task.programId&&candidate.packageId===task.packageId&&candidate.packageVersion===task.packageVersion,'upstream_changed');upstream.push(candidate);}
 const pinned=upstream.flatMap(candidate=>candidate.status==='succeeded'&&candidate.schedule.stepKind==='video_generation'?candidate.resultRefs.filter(ref=>ref.type==='starter_social_content_artifact'):[]);
 need(pinned.length===1&&pinned[0]!.id===scope.artifactId&&pinned[0]!.version===Number(String(artifact.version).replace(/^v/,'')),'upstream_artifact_changed');
 const source=await (await import('../starter198/socialContentSceneCacheSource.js')).resolveSceneCacheSourceRun(createStarter198Repository(store),{tenantId:scope.tenantId,taskId:scope.taskId,parentArtifactId:scope.artifactId});
 need(source===scope.runId,'artifact_run_changed');
 const frozen=await readWeeklyAutomaticProductionIntent(store,{tenantId:scope.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion},pkg,task.publicationTaskId);
 need(frozen&&frozen.intent.actorUserId&&frozen.intent.authorizesContentAcceptance===false&&frozen.intent.authorizesPublishing===false,'automatic_intent_required');
 if(historicalObservationAt){
  const run=await store.getById<Record_>('workflow_runs',scope.runId);
  need(run?.tenant_id===scope.tenantId&&weeklyG5HistoricalTimeValid(now,run.started_at,historicalObservationAt,pkg.weekEnd),'historical_time_changed');
  const original=await readWeeklyOriginalRunStartProof({store,task,pkg,planning:frozen.planning,now:historicalObservationAt});
  need(original?.contentTaskId===scope.taskId&&original.runId===scope.runId&&original.artifactRef.id===scope.artifactId&&original.artifactRef.version===Number(String(artifact.version).replace(/^v/,'')),'historical_original_run_required');
  const cancelId=createHash('sha256').update(`${scope.tenantId}\0${task.packageId}\0${task.packageVersion}`).digest('hex').slice(0,15);
  need(!await store.getById(WEEKLY_CANCELLATIONS,cancelId),'historical_package_revoked');
  need(!await executionPackageFrozen(store,{tenantId:scope.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion}),'historical_package_revoked');
 }
 const capacity=await readWeeklyAutomaticProductionCapacity(store,{intent:frozen.intent,pkg,planning:frozen.planning,task,now});
 need(capacity?.eligible&&capacity.proof.assignments.some(assignment=>assignment.taskId===executionTaskId&&assignment.mode==='planned'),'capacity_required');
 const job=await readContentExecutionJob(store,scope.tenantId,scope.taskId,scope.runId);
 const plan=(job?.checkpoints['social.whole_film_budget']?.payload as {plan?:{paidOperations?:Array<{operationId:string;stage:string;model:string;maximumUnits:{inputTokens?:number;outputTokens?:number}}>}}|undefined)?.plan;
 const held=(plan?.paidOperations??[]).filter(operation=>operation.stage==='director_review_capacity');
 need(held.length===1&&/^director-g5-[a-f0-9]{64}$/.test(held[0]!.operationId),'original_hold_required');
 assertDirectorG5FrozenCapacityEnvelope(held[0]!,held[0]!.model,2400);
 await readDirectorG5OriginalFilmBudget({repository:createStarter198Repository(store),reviewScope:scope});
 return {executionTaskId,intentId:frozen.intent.intentId,capacityProofId:capacity.proof.proofId,operationId:held[0]!.operationId,heldModel:held[0]!.model,actorUserId:frozen.intent.actorUserId,packageId:task.packageId,packageVersion:task.packageVersion,sourceHash:socialRequestHash({scope,executionTaskId,intentId:frozen.intent.intentId,capacityProofId:capacity.proof.proofId,operationId:held[0]!.operationId,heldModel:held[0]!.model,artifactHash:artifact.content_hash})};
}

/** Called by the real quality worker after an immutable render exists. G4 is
 * checked before machine policy creation; the service owns the paid request,
 * durable lock, unknown-response recovery and idempotency. */
export async function advanceWeeklyAutomaticG5(store:DataStore,task:WeeklyExecutionTask,artifactRef:{type:'starter_social_content_artifact';id:string;version:number},actorUserId:string){
 const actual=await readWeeklyContentQualityAuditContext(store,task,artifactRef);
 // Existing independent G5 evidence, including a legitimate human fallback,
 // is consumed unchanged. Automatic authority is only for an absent review.
 try{await assertWeeklyContentQualityAudit(store,task,artifactRef);return null;}
 catch(error){
  // A failed, corrupted or stale independent audit is not an invitation to
  // spend again on the same film. Only an actually absent G5 may enter the
  // automatic review command; repair/revision owns all other outcomes.
  if(!(error instanceof Error)||error.message!=='scene_g5_latest_g5_missing')throw error;
 }
 const scope=actual.scope,proof=await readWeeklyG5AutomaticAuthority(store,scope,task.taskId);
 need(actorUserId===proof.actorUserId,'actor_changed');
 const service=createSocialDirectorG5ReviewService(actual.repository);
 let context=await service.context(scope,actorUserId);
 if(context.agent.gaps.includes('director_usage_policy_missing')){
  context=await service.authorizeWeeklyExecution(scope,actorUserId,{expectedContextHash:context.contextHash,weeklyExecutionTaskId:task.taskId});
 }
 need(context.agent.executionPermitted,'execution_not_permitted');
 let review=await service.get(scope,actorUserId,proof.operationId);
 if(review.item?.state==='running'&&review.runtimeObservationResumeAvailable)review=await service.resumeProjection(scope,actorUserId,proof.operationId);
 else if(!review.item)review=await service.agent(scope,actorUserId,{requestId:proof.operationId,expectedContextHash:context.contextHash});
 if(review.item?.state==='completed'&&review.projectionStatus==='pending')review=await service.resumeProjection(scope,actorUserId,proof.operationId);
 need(review.item?.status==='passed'&&review.projectionStatus==='applied','review_pending');
 await assertWeeklyContentQualityAudit(store,task,artifactRef);
 return review;
}
