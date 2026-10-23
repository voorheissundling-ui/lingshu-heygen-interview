import {weeklyFormalPublicationBoundary} from './weeklyFormalPublicationBoundary.js';
import {canonicalWeeklyProductionPublication,weeklyProductionRowMatches} from '../runtime/weeklyContentProductionIdentity.js';
import type {WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {StoredPublicationAssignment} from './weeklyLineage.js';
import {readStarterPublicationPackage} from './starterPublicationPackage.js';
import {assertWeeklyPublicationG6Admission} from '../runtime/weeklyPublicationG6Admission.js';
import {resolveSceneCacheSourceRun} from '../starter198/socialContentSceneCacheSource.js';
import {executionPackageFrozen} from '../socialPrograms/weeklyExecutionGate.js';
import type {DataStore} from '../storage/datastore.js';
import type {PublicationAssignment} from '../digitalEmployees/publishingExecution.js';
import type {SocialWeeklyG6Scope} from '../../shared/contracts/socialWeeklyG6Review.js';
import {socialObject,socialJson,socialRequestHash} from '../starter198/socialContentValidation.js';
import {createStarter198Repository} from '../starter198/repository.js';
import {createSocialSceneReworkService} from '../starter198/socialContentSceneReworkService.js';
import {assertSocialDirectorG5Audit} from '../starter198/socialDirectorG5ReviewService.js';
import {createWeeklyInventoryReuseService} from '../socialPrograms/weeklyInventoryReuse.js';
const obj=(v:unknown)=>socialObject(socialJson(v))??{};
const assert=(v:unknown)=>{if(!v)throw Error('weekly_publish_source_evidence_invalid');};
/** Weekly producer summaries remain immutable. Actual independent G4/G5 are the authority. */
export async function verifyWeeklyPublishSourceEvidence(store:DataStore,assignment:PublicationAssignment,artifact:{artifact_id:string;task_id?:string;content_hash:string;content:unknown}){
 const rows=await store.list('social_publication_assignments',{where:{tenant_id:assignment.tenantId,assignment_id:assignment.assignmentId},perPage:2});assert(rows.totalItems===1&&rows.totalPages===1&&rows.items.length===1);const row=rows.items[0]!,saved=obj(row.payload);assert(row.assignment_hash===assignment.assignmentHash&&socialRequestHash(saved)===socialRequestHash(assignment)&&!row.authorization_revoked_at&&!row.authorization_revoked_by&&row.status!=='revoked');
 const target={tenantId:assignment.tenantId,programId:assignment.lineage.programRef.id,packageId:assignment.lineage.operatingPackageRef.id,packageVersion:assignment.lineage.operatingPackageRef.version,publicationTaskId:assignment.publicationTaskId};
 const packages=await store.list('social_weekly_operating_packages',{where:{tenant_id:target.tenantId,program_id:target.programId,package_id:target.packageId,version:target.packageVersion},perPage:2});assert(packages.totalItems===1&&packages.items.length===1);const pkg=packages.items[0]!.payload as WeeklyOperatingPackage;assert(pkg&&pkg.status==='active'&&!await executionPackageFrozen(store,target));const head=await store.list('social_weekly_operating_packages',{where:{tenant_id:target.tenantId,program_id:target.programId,package_id:target.packageId},sort:'-version',perPage:2});assert(head.items[0]?.version===target.packageVersion&&!(head.items.length>1&&head.items[1]?.version===target.packageVersion));const pubs=pkg.socialContentPackage.publicationTasks;assert(Array.isArray(pubs));const publications=(pubs as unknown[]).map(obj).filter(p=>p.publicationTaskId===target.publicationTaskId);assert(publications.length===1);const pub=publications[0]!;assert(pub.accountId===assignment.accountId&&pub.platform===assignment.platform&&pub.publishWindow===assignment.publishWindow&&pub.status!=='cancelled');
 const boundary=await weeklyFormalPublicationBoundary(store,row as unknown as StoredPublicationAssignment,pkg);if(boundary==='legacy'){const legacy=obj(obj(artifact.content).productionResult);assert(obj(legacy.technicalReview).approved===true&&obj(legacy.creativeReview).approved===true);return null;}
 const tasks=await store.list('starter_social_content_tasks',{where:{tenant_id:target.tenantId,task_id:String(artifact.task_id??'')},perPage:2});assert(tasks.totalItems===1&&tasks.items.length===1);const task=tasks.items[0]!,authority=obj(obj(task.brief)._weeklyAuthority),frozen=obj(authority.weeklyPackage),production=obj(obj(artifact.content).productionResult);
 assert(production.productionResultId===assignment.lineage.productionResultRef.id);
 if(pub.inventoryReuseRef){const binding=await createWeeklyInventoryReuseService(store).readVerifiedBinding({...target,accountId:assignment.accountId,inputSnapshot:{publicationTask:pkg.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===target.publicationTaskId)!}});assert(binding.item.source.sourceContentTaskId===artifact.task_id&&binding.item.source.artifactRef.id===artifact.artifact_id&&binding.item.source.artifactHash===artifact.content_hash);}else {
 const {resolveWeeklyCreativeRepairApprovalEvidence}=await import('../socialPrograms/weeklyCreativeRepairApprovalEvidence.js');
 const repair=await resolveWeeklyCreativeRepairApprovalEvidence(store,target);
 const canonical=canonicalWeeklyProductionPublication(pkg,target.publicationTaskId);
 assert(frozen.programId===target.programId&&frozen.packageId===target.packageId&&frozen.version===target.packageVersion&&obj(authority.publicationTask).publicationTaskId===canonical.publicationTaskId&&socialRequestHash({...canonical,status:undefined})===socialRequestHash({...obj(authority.publicationTask),status:undefined}));
 if(repair)assert(repair.contentTask.task_id===artifact.task_id&&repair.artifactRef.id===artifact.artifact_id&&repair.artifact.content_hash===artifact.content_hash&&repair.artifact.status==='approved');
 else assert(await weeklyProductionRowMatches(store,target,task));
 const {validateWeeklyPublicationAcceptance}=await import('../runtime/socialWeeklyResultValidation.js');
 const approvalScope={...target,accountId:assignment.accountId} as WeeklyExecutionTask;
 await validateWeeklyPublicationAcceptance(store,approvalScope,String(production.productionResultId));
 }
 const repository=createStarter198Repository(store);const runId=await resolveSceneCacheSourceRun(repository,{tenantId:target.tenantId,taskId:String(artifact.task_id),parentArtifactId:artifact.artifact_id});const sourceScope={tenantId:target.tenantId,taskId:String(artifact.task_id),runId,artifactId:artifact.artifact_id};assert(sourceScope.runId);const cache=await createSocialSceneReworkService(repository).readCache({...sourceScope,parentArtifactId:artifact.artifact_id});assert(cache.cache.parentArtifactHash===artifact.content_hash&&cache.cache.scenes.length>0&&cache.cache.scenes.every(s=>s.status==='passed'&&s.technicalReceiptId));const g5=await assertSocialDirectorG5Audit(repository,{...sourceScope,artifactHash:artifact.content_hash});
 const actualTasks=await store.list('social_weekly_execution_tasks',{where:{tenant_id:target.tenantId,program_id:target.programId,package_id:target.packageId,package_version:target.packageVersion},perPage:1000});assert(actualTasks.totalItems===actualTasks.items.length&&actualTasks.totalPages<=1);const consumers=actualTasks.items.map(r=>obj(r.payload) as unknown as WeeklyExecutionTask).filter(t=>t.tenantId===target.tenantId&&t.programId===target.programId&&t.packageId===target.packageId&&t.packageVersion===target.packageVersion&&t.publicationTaskId===target.publicationTaskId&&t.accountId===assignment.accountId&&t.schedule?.stepKind==='publishing');assert(consumers.length===1);const publicationPackage=await readStarterPublicationPackage(target.tenantId,assignment.packageId,store);assert(publicationPackage);await assertWeeklyPublicationG6Admission(store,consumers[0]!,row as unknown as StoredPublicationAssignment,publicationPackage!);
 const scope:SocialWeeklyG6Scope={...sourceScope,...target};return {scope,sourceAuditHash:socialRequestHash({g4:cache.cache.scenes.map(s=>({sceneId:s.sceneId,productionSceneId:s.productionSceneId,receiptId:s.technicalReceiptId})),g5:g5.receipt.recordHash})};
}
