import type {DataStore} from '../storage/datastore.js';
import type {SocialInstagramDelivery,SocialInstagramDeliveryPublishProof} from '../../shared/contracts/socialInstagramDelivery.js';
import type {SocialWeeklyG6Scope} from '../../shared/contracts/socialWeeklyG6Review.js';
import {createStarter198Repository} from '../starter198/repository.js';
import {INSTAGRAM_DELIVERIES,decodeInstagramDelivery,readInstagramDeliveryEvidence} from '../starter198/socialInstagramDeliveryEvidence.js';
import {createSocialWeeklyG6ReviewService,SOCIAL_WEEKLY_G6_REVIEWS} from '../starter198/socialWeeklyG6ReviewService.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
const obj=(v:unknown)=>socialObject(socialJson(v))??{};
const assert=(v:unknown,code:string)=>{if(!v)throw Error('instagram_delivery_'+code);};
/** A new assignment freezes the actual packaged bytes and actual independent review/G6 receipts. */
export async function createInstagramDeliveryPublicationProof(store:DataStore,input:Omit<SocialWeeklyG6Scope,'runId'>):Promise<SocialInstagramDeliveryPublishProof>{
 const rows=await store.list(INSTAGRAM_DELIVERIES,{where:{tenant_id:input.tenantId,task_id:input.taskId,artifact_id:input.artifactId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion,publication_task_id:input.publicationTaskId},perPage:2});assert(rows.totalItems===1&&rows.items.length===1&&rows.totalPages===1,'required_for_assignment');
 const delivery=decodeInstagramDelivery<SocialInstagramDelivery>(rows.items[0]!);const scope:SocialWeeklyG6Scope={...input,runId:delivery.runId};const repository=createStarter198Repository(store),g6=createSocialWeeklyG6ReviewService(repository),context=await g6.context(scope,delivery.preparedBy);assert(context.platform==='instagram'&&context.checks.every(c=>c.status==='passed')&&!context.gaps.length,'g6_not_passed');
 const evidence=await readInstagramDeliveryEvidence(repository,scope,context);assert(evidence?.item.deliveryId===delivery.deliveryId,'source_changed');const technical=evidence!.reviews.find(r=>r.kind==='technical'),creative=evidence!.reviews.find(r=>r.kind==='creative');assert(technical?.status==='passed'&&creative?.status==='passed','independent_reviews_required');
 const checks=await store.list(SOCIAL_WEEKLY_G6_REVIEWS,{where:{tenant_id:scope.tenantId,task_id:scope.taskId,run_id:scope.runId,artifact_id:scope.artifactId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion,publication_task_id:scope.publicationTaskId},perPage:1000});assert(checks.totalPages<=1&&checks.items.length===checks.totalItems,'g6_receipt_scan_incomplete');
 const current=checks.items.map(r=>obj(obj(r.payload).review)).filter(r=>r.sourceHash===context.sourceHash&&r.contextHash===context.contextHash&&r.status==='passed').sort((a,b)=>String(b.requestedAt).localeCompare(String(a.requestedAt)));assert(current.length&&!(current.length>1&&current[0]!.requestedAt===current[1]!.requestedAt),'g6_receipt_required');const chosen=current[0]!,verified=await g6.get(scope,String(chosen.requestedBy),String(chosen.requestId));assert(verified.currentSourceVerified&&verified.projectionStatus==='applied'&&verified.item?.status==='passed'&&verified.item.receiptHash,'g6_receipt_required');
 return {scope,deliveryId:delivery.deliveryId,deliveryHash:delivery.recordHash,sourceFileSha256:delivery.sourceFileSha256,fileRef:delivery.fileRef,fileId:delivery.fileId,fileSha256:delivery.fileSha256,conversionVersion:delivery.conversionVersion,technicalReviewHash:technical!.recordHash,creativeReviewHash:creative!.recordHash,g6RequestId:verified.item!.requestId,g6ReviewHash:verified.item!.recordHash,g6ReceiptHash:verified.item!.receiptHash!};
}
export async function verifyInstagramDeliveryPublicationProof(store:DataStore,proof:SocialInstagramDeliveryPublishProof){
 const actual=await createInstagramDeliveryPublicationProof(store,proof.scope);assert(socialRequestHash(actual)===socialRequestHash(proof),'frozen_publication_proof_changed');return actual;
}
