import {inspectInstagramArchivedStreamProof} from './instagramArchivedStreamProof.js';
import {createHash} from 'node:crypto';
import type {Starter198Repository} from './repository.js';
import type {SocialWeeklyG6Scope,SocialWeeklyG6Context} from '../../shared/contracts/socialWeeklyG6Review.js';
import type {SocialInstagramDelivery,SocialInstagramDeliveryReview} from '../../shared/contracts/socialInstagramDelivery.js';
import {INSTAGRAM_DELIVERY_TECHNICAL_CHECKS,INSTAGRAM_DELIVERY_CREATIVE_CHECKS} from '../../shared/contracts/socialInstagramDelivery.js';
import {socialJson,socialObject,socialRequestHash} from './socialContentValidation.js';
import {readSocialContentFile} from './socialContentFiles.js';
import {createSocialSceneReworkService} from './socialContentSceneReworkService.js';
import {assertSocialDirectorG5Audit} from './socialDirectorG5ReviewService.js';
import {INSTAGRAM_DELIVERY_CONVERSION_VERSION} from './socialInstagramDeliveryConversion.js';
export const INSTAGRAM_DELIVERIES='starter_social_instagram_deliveries';
export const INSTAGRAM_DELIVERY_REVIEWS='starter_social_instagram_delivery_reviews';
export async function readInstagramSourceAudit(repository:Starter198Repository,a:SocialWeeklyG6Scope){const scope={tenantId:a.tenantId,taskId:a.taskId,runId:a.runId,artifactId:a.artifactId},cache=await createSocialSceneReworkService(repository).readCache({...scope,parentArtifactId:a.artifactId});if(!cache.cache.scenes.length||!cache.cache.scenes.every(s=>s.status==='passed'&&s.technicalReceiptId))throw Error('instagram_delivery_source_g4_required');const g5=await assertSocialDirectorG5Audit(repository,scope);return socialRequestHash({g4:cache.cache.scenes.map(s=>({sceneId:s.sceneId,productionSceneId:s.productionSceneId,receiptId:s.technicalReceiptId})),g5:g5.receipt.recordHash});}
export const deliveryScopeFields=(a:SocialWeeklyG6Scope)=>({tenant_id:a.tenantId,task_id:a.taskId,run_id:a.runId,artifact_id:a.artifactId,program_id:a.programId,package_id:a.packageId,package_version:a.packageVersion,publication_task_id:a.publicationTaskId});
export function deliveryScopeMatches(a:SocialWeeklyG6Scope,b:SocialWeeklyG6Scope){return Object.keys(deliveryScopeFields(a)).every(key=>deliveryScopeFields(a)[key as keyof ReturnType<typeof deliveryScopeFields>]===deliveryScopeFields(b)[key as keyof ReturnType<typeof deliveryScopeFields>]);}
export function decodeInstagramDelivery<T extends {recordHash:string}>(row:Record<string,unknown>):T{
 const value=socialObject(socialJson(row.payload));if(!value)throw Error('instagram_delivery_record_invalid');
 const {recordHash,...body}=value;if(typeof recordHash!=='string'||recordHash!==socialRequestHash(body)||row.content_hash!==recordHash)throw Error('instagram_delivery_record_hash_changed');return value as unknown as T;
}
/** This read does not invoke G6, avoiding recursive source verification. Caller supplies fresh original production facts. */
export async function readInstagramDeliveryEvidence(repository:Starter198Repository,a:SocialWeeklyG6Scope,source:Pick<SocialWeeklyG6Context,'artifactHash'|'fileRef'|'fileSha256'|'handoffId'|'handoffVersion'|'productionResultId'|'productionResultHash'>){
 const store=repository.dataStore;if(!store)throw Error('instagram_delivery_storage_missing');
 const rows=await store.list(INSTAGRAM_DELIVERIES,{where:deliveryScopeFields(a),perPage:2});
 if(rows.totalItems>1||rows.totalPages>1||rows.items.length>1)throw Error('instagram_delivery_scope_ambiguous');
 if(!rows.items.length)return null;
 if(rows.totalItems!==rows.items.length||Object.entries(deliveryScopeFields(a)).some(([key,value])=>rows.items[0]![key]!==value))throw Error('instagram_delivery_scope_changed');
 const item=decodeInstagramDelivery<SocialInstagramDelivery>(rows.items[0]!);
 if(!item.metadata||typeof item.metadata!=='object'||Array.isArray(item.metadata))throw Error('instagram_delivery_conversion_proof_changed');
 const {recordHash:metadataHash,...metadataBody}=item.metadata;
 if(item.conversionVersion!==INSTAGRAM_DELIVERY_CONVERSION_VERSION||metadataHash!==socialRequestHash(metadataBody)||item.conversionHash!==socialRequestHash({conversionVersion:item.conversionVersion,sourceSha256:item.sourceFileSha256,deliverySha256:item.fileSha256,metadataHash})||![item.sourceFileSha256,item.fileSha256,item.sourceAuditHash].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))throw Error('instagram_delivery_conversion_proof_changed');
 if(item.sourceAuditHash!==await readInstagramSourceAudit(repository,a))throw Error('instagram_delivery_source_audit_changed');
 if(!deliveryScopeMatches(a,item)||item.version!==1||item.sourceArtifactHash!==source.artifactHash||item.sourceFileRef!==source.fileRef||item.sourceFileSha256!==source.fileSha256||item.sourceHandoffId!==source.handoffId||item.sourceHandoffVersion!==source.handoffVersion||item.sourceProductionResultId!==source.productionResultId||item.sourceProductionResultHash!==source.productionResultHash)throw Error('instagram_delivery_source_changed');
 const opened=await readSocialContentFile({repository,tenantId:a.tenantId,fileId:item.fileId});
 if(opened.view.taskId!==a.taskId||opened.view.usage!=='artifact_media'||opened.view.fileRef!==item.fileRef||opened.view.sha256!==item.fileSha256||item.metadata.fileSha256!==item.fileSha256)throw Error('instagram_delivery_owned_file_changed');
 const {readFile}=await import('node:fs/promises');let bytes:Buffer;
 if(opened.localPath)bytes=await readFile(opened.localPath);else if(opened.backend)bytes=opened.backend.buf;else if(opened.object){const parts:Buffer[]=[];let total=0;for await(const part of opened.object.body){const b=Buffer.from(part);total+=b.length;if(total>110*1024*1024)throw Error('instagram_delivery_file_size_invalid');parts.push(b);}bytes=Buffer.concat(parts);}else throw Error('instagram_delivery_owned_file_unavailable');
 if(createHash('sha256').update(bytes).digest('hex')!==item.fileSha256||bytes.length!==opened.view.size)throw Error('instagram_delivery_file_bytes_changed');
 const rr=await store.list(INSTAGRAM_DELIVERY_REVIEWS,{where:{tenant_id:a.tenantId,delivery_id:item.deliveryId},perPage:3});if(rr.totalPages>1||rr.totalItems>2||rr.items.length!==rr.totalItems)throw Error('instagram_delivery_review_ambiguous');
 const reviews=rr.items.map(row=>{const review=decodeInstagramDelivery<SocialInstagramDeliveryReview>(row);if(row.tenant_id!==a.tenantId||row.delivery_id!==item.deliveryId||row.kind!==review.kind||row.request_id!==review.requestId)throw Error('instagram_delivery_review_scope_changed');return review;});const kinds=new Set<string>();
 for(const review of reviews){if(review.deliveryId!==item.deliveryId||review.deliveryHash!==item.recordHash||review.fileSha256!==item.fileSha256)throw Error('instagram_delivery_review_source_changed');
  if(!['technical','creative'].includes(review.kind)||kinds.has(review.kind))throw Error('instagram_delivery_review_kind_invalid');kinds.add(review.kind);
  const codes=review.kind==='technical'?INSTAGRAM_DELIVERY_TECHNICAL_CHECKS:INSTAGRAM_DELIVERY_CREATIVE_CHECKS;
  if(review.actorRole!==(review.kind==='technical'?'human_technical_reviewer':'human_director_reviewer')||!Array.isArray(review.checks)||review.checks.length!==codes.length||!codes.every(code=>review.checks.filter(c=>c.code===code&&['passed','failed','unknown'].includes(c.outcome)&&typeof c.observation==='string'&&c.observation.trim().length>0&&c.observation.length<=4000).length===1))throw Error('instagram_delivery_review_checks_invalid');
  const status=review.checks.some(c=>c.outcome==='failed')?'failed':review.checks.every(c=>c.outcome==='passed')?'passed':'review_required';if(review.status!==status||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(review.reviewedAt)||!Number.isFinite(Date.parse(review.reviewedAt)))throw Error('instagram_delivery_review_status_invalid');
  const user=await store.getById('users',review.actorUserId);if(!user||user.tenantId!==a.tenantId||user.disabled===true||user.enabled===false||user.active===false||['disabled','suspended'].includes(String(user.status))||!['admin','super_admin','social_operator'].includes(String(user.role)))throw Error('instagram_delivery_reviewer_unavailable');}
 return {item,reviews,bytes,streamProof:inspectInstagramArchivedStreamProof(bytes)};
}
