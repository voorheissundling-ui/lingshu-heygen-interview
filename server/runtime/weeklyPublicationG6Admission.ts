import type {DataStore,Record_} from '../storage/datastore.js';
import type {WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
import type {StoredPublicationAssignment} from '../publishing/weeklyLineage.js';
import type {StarterPublicationPackage} from '../publishing/starterPublicationPackage.js';
import {createStarter198Repository} from '../starter198/repository.js';
import {SOCIAL_WEEKLY_G6_REVIEWS,verifySocialWeeklyG6Receipt,type WeeklyG6Ports} from '../starter198/socialWeeklyG6ReviewService.js';
import {parseSocialProductionReceiptRecord} from '../starter198/socialContentProductionHandoff.js';
import type {StarterRecord} from '../starter198/repository.js';
import {socialRequestHash,socialObject,socialJson} from '../starter198/socialContentValidation.js';
import {SocialProgramError} from '../socialPrograms/service.js';

const object=(value:unknown)=>socialObject(socialJson(value))??{};
function check(value:unknown,code:string):asserts value {if(!value)throw new SocialProgramError(code,409,'发布前预检未能核验同一周任务、账号及真实成片。');}
/** Admission for a NEW publish only. Original unknown attempts retain status-only reconciliation. */
export async function assertWeeklyPublicationG6Admission(store:DataStore,task:WeeklyExecutionTask,assignment:StoredPublicationAssignment,publicationPackage:StarterPublicationPackage,ports:WeeklyG6Ports={}){
 const lineage=assignment.payload.lineage,manifest=publicationPackage.operatingLineage;
 check(assignment.tenant_id===task.tenantId&&assignment.operating_package_id===task.packageId&&assignment.operating_package_version===task.packageVersion&&assignment.publication_task_id===task.publicationTaskId&&assignment.account_id===task.accountId&&assignment.status==='package_ready','weekly_g6_assignment_scope_changed');
 check(assignment.payload.tenantId===task.tenantId&&assignment.payload.accountId===assignment.account_id&&assignment.payload.platform===assignment.platform&&assignment.payload.publicationTaskId===task.publicationTaskId&&assignment.payload.packageId===assignment.package_id&&assignment.assignment_hash===assignment.payload.assignmentHash&&assignment.assignment_id===assignment.payload.assignmentId&&assignment.production_result_id===lineage.productionResultRef.id&&lineage.programRef.id===task.programId&&lineage.operatingPackageRef.id===task.packageId&&lineage.operatingPackageRef.version===task.packageVersion&&lineage.weeklyPublicationTaskRef.id===task.publicationTaskId,'weekly_g6_assignment_lineage_changed');
 check(publicationPackage.tenantId===task.tenantId&&publicationPackage.packageId===assignment.package_id&&publicationPackage.platform===assignment.platform&&manifest?.assignmentId===assignment.assignment_id&&manifest.assignmentHash===assignment.assignment_hash&&socialRequestHash(manifest.productionResultRef)===socialRequestHash(lineage.productionResultRef),'weekly_g6_publication_package_changed');
 const scope={tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion,publication_task_id:task.publicationTaskId!};
 const rows=await store.list<Record_>(SOCIAL_WEEKLY_G6_REVIEWS,{where:scope,perPage:1000});
 check(rows.totalItems===rows.items.length&&rows.items.every(row=>Object.entries(scope).every(([key,value])=>row[key]===value)),'weekly_g6_review_scan_incomplete');
 const repository=createStarter198Repository(store),verified=[];
 for(const row of rows.items){
  const payload=object(row.payload),review=object(payload.review);
  check(row.content_hash===socialRequestHash(payload),'weekly_g6_review_corrupt');
  if(review.status!=='passed')continue;
  check(review.tenantId===task.tenantId&&review.programId===task.programId&&review.packageId===task.packageId&&review.packageVersion===task.packageVersion&&review.publicationTaskId===task.publicationTaskId&&typeof review.receiptId==='string','weekly_g6_review_scope_changed');
  const receipts=await store.list<Record_>('starter_social_production_receipts',{where:{tenant_id:task.tenantId,receipt_id:review.receiptId},perPage:2});
  if(receipts.totalItems!==1||receipts.items.length!==1)continue;
  const receipt=parseSocialProductionReceiptRecord(receipts.items[0] as StarterRecord);
  let proof:Awaited<ReturnType<typeof verifySocialWeeklyG6Receipt>>;
  try{proof=await verifySocialWeeklyG6Receipt(repository,task.tenantId,receipt,ports);}catch{continue;}
  const current=proof.context;
  check(current.programId===task.programId&&current.packageId===task.packageId&&current.packageVersion===task.packageVersion&&current.publicationTaskId===task.publicationTaskId&&current.accountId===assignment.account_id&&current.platform===assignment.platform&&current.productionResultId===assignment.production_result_id&&publicationPackage.contentId===`${current.artifactId}:${task.publicationTaskId}`&&current.artifactHash===publicationPackage.contentHash&&current.plannedPublishWindow===assignment.payload.publishWindow,'weekly_g6_output_binding_changed');
  check(publicationPackage.assets.some(asset=>asset.kind==='video'&&asset.contentHash===current.fileSha256),'weekly_g6_package_media_changed');
  if(current.assignmentRef)check(current.assignmentRef.assignmentId===assignment.assignment_id&&current.assignmentRef.assignmentHash===assignment.assignment_hash,'weekly_g6_preflight_assignment_changed');
  verified.push(proof);
 }
 check(verified.length>0,'weekly_g6_current_preflight_required');
 check(new Set(verified.map(proof=>proof.context.sourceHash)).size===1,'weekly_g6_current_preflight_ambiguous');
 return verified.map(proof=>({reviewId:proof.review.reviewId,receiptId:proof.receipt.receiptId,sourceHash:proof.context.sourceHash}));
}
