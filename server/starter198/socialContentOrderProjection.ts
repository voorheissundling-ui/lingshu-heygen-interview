import {createHash} from 'node:crypto';
import type {Starter198Repository} from './repository.js';
import {STARTER_COLLECTIONS} from './repository.js';
import {requireSocialTask,socialArtifact,socialTaskSummary} from './socialContentRecords.js';
import {socialObject,socialJson,socialText,socialRequestHash,SocialContentWorkflowError} from './socialContentValidation.js';
import {createContentCreationQuotaService,type QuotaScope} from '../socialPrograms/contentCreationQuota.js';
import {resolveSocialContentCostLineage} from './socialContentCostLineage.js';
import {resolveSocialArtifactMedia,openSocialArtifactMedia} from './socialArtifactMedia.js';
import {assertSocialContentReleaseQuality} from './socialContentReleaseQuality.js';
import type {SocialContentBackendFilePort} from './socialContentFiles.js';
import {withSocialContentSubjectLease} from './socialContentMutation.js';

const fail=(code:string):never=>{throw new SocialContentWorkflowError(`social_content_order_projection_${code}`,409);};
function mock(value:unknown):boolean {
 if(!value||typeof value!=='object')return false;
 if(Array.isArray(value))return value.some(mock);
 return Object.entries(value as Record<string,unknown>).some(([key,v])=>
   (['mock','simulated','simulation'].includes(key)&&v===true)
   ||(['evidenceMode','executionMode','mode'].includes(key)&&['mock','simulation','simulated'].includes(String(v)))||mock(v));
}

/** Rebuild an idempotent business projection from persisted jobs and verified
 * delivery packages. No status supplied by a browser or worker callback is an
 * authority, and production success alone never counts as approved delivery. */
export async function reconcileSocialContentOrderProjection(input:{repository:Starter198Repository;tenantId:string;taskId:string;
 backendFilePort?:SocialContentBackendFilePort;now?:Date}){
 const row=await requireSocialTask(input),binding=socialObject(socialJson(row.content_order));
 if(!binding)return{status:'legacy' as const};
 const lineage=await resolveSocialContentCostLineage(input);
 return withSocialContentSubjectLease({repository:input.repository,tenantId:input.tenantId,subjectId:lineage.contentId,
   action:()=>reconcileSocialContentOrderProjectionUnderLease(input)});
}
async function reconcileSocialContentOrderProjectionUnderLease(input:{repository:Starter198Repository;tenantId:string;taskId:string;
 backendFilePort?:SocialContentBackendFilePort;now?:Date}){
 const task=await requireSocialTask(input),binding=socialObject(socialJson(task.content_order));
 if(!binding)return{status:'legacy' as const};
 if(binding.cancellation||binding.replacedByContentId||['cancelled','cancelling'].includes(socialText(task.status)))
   return{status:'cancelled' as const};
 const store=input.repository.dataStore;
 if(!store?.compareAndSwap||!await store.supportsAtomicCompareAndSwap?.())return fail('atomic_store_required');
 const lineage=await resolveSocialContentCostLineage(input);
 // Group cancellation is authoritative on the original even when its
 // historical completed/delivered status must remain unchanged. A late child
 // package is retained as evidence, not promoted into a new delivery.
 if(lineage.contentId!==input.taskId){
   const root=await requireSocialTask({...input,taskId:lineage.contentId});
   const rootOrder=socialObject(socialJson(root.content_order));
   if(!rootOrder||rootOrder.contentId!==lineage.contentId||rootOrder.budgetTaskId!==lineage.budgetTaskId)
     return fail('identity_changed');
   if(rootOrder.cancellation||rootOrder.replacedByContentId||['cancelled','cancelling'].includes(socialText(root.status)))
     return{status:'cancelled' as const};
 }
 if(!lineage.programId||!lineage.originWeek)return{status:'not_reserved' as const};
 if(binding.contentId!==lineage.contentId||binding.budgetTaskId!==lineage.budgetTaskId
   ||binding.programId!==lineage.programId||binding.originWeek!==lineage.originWeek)return fail('identity_changed');
 const scope:QuotaScope={tenantId:input.tenantId,programId:lineage.programId,weekStart:lineage.originWeek};
 let verifiedDelivery:string|null=null;
 const quota=createContentCreationQuotaService({store,now:()=>input.now??new Date(),
   assertAtomicStore:async()=>{if(!await store.supportsAtomicCompareAndSwap?.())return fail('atomic_store_required');},
   readReleaseSafety:async()=>({leaseActive:true,inFlight:true,paid:true,unknown:true}),
   verifyDelivery:async(_order,_scope,deliveryRef,revision)=>deliveryRef===verifiedDelivery
     &&(!revision||(revision.executionTaskId===input.taskId&&revision.lineageHash===lineage.lineageHash)),
 });
 const pool=await quota.read(scope),order=pool?.orders[lineage.contentId];
 if(!order)return fail('reservation_missing');
 if(['planned','released'].includes(order.state))return{status:'not_executing' as const};
 const packages=await input.repository.list(STARTER_COLLECTIONS.socialDeliveryPackages,input.tenantId,
   {where:{task_id:input.taskId},perPage:500,sort:'-created_at'});
 if(packages.totalItems!==packages.items.length)return fail('delivery_truncated');
 const summary=socialTaskSummary(task);
 const revision=lineage.kind!=='original';
 if(!revision&&order.state==='delivered')return{status:'delivered' as const,contentId:lineage.contentId,deliveryRef:order.deliveryRef,revision:false};
 const priorRevision=revision?order.revisions?.find(r=>r.executionTaskId===input.taskId&&r.lineageHash===lineage.lineageHash):null;
 if(priorRevision?.deliveries?.length)return{status:'delivered' as const,contentId:lineage.contentId,
   deliveryRef:priorRevision.deliveries[priorRevision.deliveries.length-1].deliveryRef,revision:true};
 for(const row of packages.items){
   if(!['ready','confirmed'].includes(socialText(row.status)))continue;
   const manifest=socialObject(socialJson(row.manifest)),packageId=socialText(row.package_id);
   if(!manifest||manifest.schemaVersion!=='social-content.delivery.v1'||manifest.taskId!==input.taskId
     ||manifest.packageId!==packageId||socialRequestHash(manifest)!==row.package_hash||mock(manifest))return fail('delivery_invalid');
   if(!Array.isArray(manifest.artifacts)||!Array.isArray(manifest.media)||!manifest.artifacts.length) return fail('delivery_media_missing');
   const shortVideos=(manifest.artifacts as any[]).filter(a=>a.kind==='short_video'||a.kind==='video');
   if(!shortVideos.length)continue; // A PDF/script is not a produced film.
   const operation=await input.repository.list(STARTER_COLLECTIONS.socialContentOperations,input.tenantId,
     {where:{operation_id:socialText(row.created_operation_id)},perPage:2});
   if(operation.totalItems!==1||operation.items[0]?.operation!=='create_social_delivery_package'
     ||operation.items[0]?.target_id!==input.taskId||operation.items[0]?.status!=='succeeded')return fail('delivery_operation_unverified');
   let hasCurrentRevision=false;
   for(const frozen of shortVideos){
     const records=await input.repository.list(STARTER_COLLECTIONS.socialContentArtifacts,input.tenantId,
       {where:{task_id:input.taskId,artifact_id:String(frozen.artifactId)},perPage:2});
     if(records.totalItems!==1||records.items.length!==1)return fail('artifact_missing');
     const artifact=socialArtifact(records.items[0]);
     if(revision&&socialObject(artifact.content?.productionWorkspaceSource)?.runId!==socialText(task.run_id))continue;
     if(artifact.status!=='approved'||frozen.status!=='approved'||artifact.resourceRef!==frozen.resourceRef
       ||artifact.version!==frozen.version||mock(artifact.content))return fail('artifact_changed_or_unapproved');
     const render=socialObject(artifact.content?.render),result=socialObject(artifact.content?.productionResult);
     if(render?.completed===false||render?.qualityPassed===false||render?.audioDecoded===false
       ||socialObject(result?.technicalReview)?.approved===false||socialObject(result?.creativeReview)?.approved===false)
         return fail('artifact_quality_failed');
     if(revision){
       const source=socialObject(artifact.content?.productionWorkspaceSource);
       if(source?.runId!==socialText(task.run_id))continue;
       hasCurrentRevision=true;
     }
     assertSocialContentReleaseQuality({brief:summary.brief,content:artifact.content,mode:'human'});
     const media=await resolveSocialArtifactMedia({...input,value:{kind:artifact.kind,origin:artifact.origin,
       platform:artifact.platform,language:artifact.language,resourceRef:artifact.resourceRef,content:artifact.content,parentArtifactId:artifact.parentArtifactId}});
     const descriptor=(manifest.media as any[]).find(m=>m.artifactId===artifact.artifactId);
     if(!media||!descriptor||descriptor.fileRef!==media.file.fileRef||descriptor.sha256!==media.file.sha256
       ||descriptor.size!==media.file.size||!media.file.mimeType.startsWith('video/'))return fail('delivery_media_changed');
     const stream=await openSocialArtifactMedia({...input,descriptor});
     const digest=createHash('sha256');let size=0;
     for await(const chunk of stream){size+=chunk.byteLength;if(size>descriptor.size)return fail('delivery_media_changed');digest.update(chunk);}
     if(size!==descriptor.size||digest.digest('hex')!==descriptor.sha256)return fail('delivery_media_changed');
   }
   if(revision&&!hasCurrentRevision)continue;
   const deliveryRef=`delivery:${packageId}:${row.package_hash}`;
   verifiedDelivery=deliveryRef;
   if(revision){
     await quota.recordRevisionDelivery(scope,{commandId:`delivery:${createHash('sha256').update(deliveryRef+lineage.lineageHash).digest('hex')}`,
       actorId:'system:verified-delivery',reason:'verified_revision_delivery_package'},
       {contentId:lineage.contentId,executionTaskId:input.taskId,lineageHash:lineage.lineageHash,deliveryRef});
   }else if(order.state!=='delivered'){
     await quota.transition(scope,{commandId:`delivery:${createHash('sha256').update(deliveryRef).digest('hex')}`,
       actorId:'system:verified-delivery',reason:'verified_delivery_package'},
       {contentId:lineage.contentId,productionTaskId:lineage.contentId,state:'delivered',deliveryRef});
   }
   return{status:'delivered' as const,contentId:lineage.contentId,deliveryRef,revision};
 }
 const jobs=await store.list<any>('content_execution_jobs',{where:{tenant_id:input.tenantId,task_id:input.taskId,run_id:socialText(task.run_id)},perPage:100});
 if(jobs.totalItems!==jobs.items.length)return fail('jobs_truncated');
 if(!revision&&order.state==='reserved'&&jobs.items.some(job=>job.status==='running'
   &&socialText(job.worker_id)&&Date.parse(String(job.lease_expires_at))>(input.now??new Date()).getTime()&&!mock(job))){
   await quota.transition(scope,{commandId:`running:${socialText(task.run_id)}`,actorId:'system:production-worker',reason:'verified_live_worker_lease'},
     {contentId:lineage.contentId,productionTaskId:lineage.contentId,state:'running'});
   return{status:'running' as const};
 }
 return{status:order.state as string};
}
