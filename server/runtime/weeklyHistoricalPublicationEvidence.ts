import type {DataStore,Record_} from '../storage/datastore.js';
import type {VersionedSocialRef,WeeklyExecutionTask,WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {DurablePublicationAttempt,StoredPublicationAssignment} from '../publishing/weeklyLineage.js';
import {buildPublicationAssignment} from '../digitalEmployees/publishingExecution.js';
import {assertWeeklyPublicationStoredScope} from '../publishing/weeklyFormalPublicationBoundary.js';
import {readStarterPublicationPackage} from '../publishing/starterPublicationPackage.js';
import {publicationInstant} from '../socialPrograms/publicationDeadlines.js';
import {validateWeeklyPublicationAcceptance} from './socialWeeklyResultValidation.js';
import {SocialProgramError} from '../socialPrograms/service.js';
const fail=():never=>{throw new SocialProgramError('weekly_historical_publication_unverified',409,'历史发布回执、归属、冻结身份或批准证据无法验证。');};
function requireEvidence(condition:unknown):asserts condition{if(!condition)fail();}
async function unique<T extends {id:string}>(store:DataStore,collection:string,where:Record<string,string|number>):Promise<T>{const rows=await store.list<T>(collection,{where,perPage:2});requireEvidence(rows.totalItems===1&&rows.items.length===1);const row=rows.items[0]!;requireEvidence(Object.entries(where).every(([k,v])=>(row as Record<string,unknown>)[k]===v));return row;}
/** Read-only evidence of an effect completed before revocation. This function
 * grants no publishing authority and is never used by effect admission. */
export async function validateWeeklyHistoricalPublication(store:DataStore,task:WeeklyExecutionTask,ref:VersionedSocialRef,now=new Date()):Promise<void>{
 requireEvidence(task.workflowKind==='publishing'&&task.schedule.stepKind==='publishing'&&ref.type==='weekly_publication_attempt'&&ref.version===1);
 const attempt=await unique<DurablePublicationAttempt>(store,'social_publication_attempts',{tenant_id:task.tenantId,attempt_id:ref.id});
 requireEvidence(attempt.status==='published'&&attempt.provider_receipt_id?.trim()&&attempt.platform_post_id?.trim()&&!/mock|simulat|test[_-]?provider/i.test(attempt.provider)&&!/^(simr_|mock|simulat)/i.test(attempt.provider_receipt_id)&&!/^(simp_|mock|simulat)/i.test(attempt.platform_post_id));
 requireEvidence(!(attempt as unknown as Record_).mock&&!(attempt as unknown as Record_).simulated);
 const started=publicationInstant(attempt.started_at),resolved=publicationInstant(attempt.resolved_at??'');requireEvidence(started!==null&&resolved!==null&&resolved>=started&&resolved<=now.getTime());
 const assignment=await unique<StoredPublicationAssignment>(store,'social_publication_assignments',{tenant_id:task.tenantId,assignment_id:attempt.assignment_id});
 requireEvidence(['package_ready','revoked'].includes(assignment.status)&&assignment.package_id===attempt.package_id&&assignment.operating_package_id===task.packageId&&assignment.operating_package_version===task.packageVersion&&assignment.publication_task_id===task.publicationTaskId&&assignment.account_id===task.accountId);
 const weekly=await unique<Record_>(store,'social_weekly_operating_packages',{tenant_id:task.tenantId,package_id:task.packageId,version:task.packageVersion});const pkg=weekly.payload as WeeklyOperatingPackage;
 requireEvidence(weekly.program_id===task.programId&&pkg?.programId===task.programId&&['active','superseded'].includes(pkg.status));assertWeeklyPublicationStoredScope(assignment,pkg);
 const auth=pkg.socialContentPackage.authorization,authorized=publicationInstant(auth.authorizedAt??'');requireEvidence(auth.mode==='bounded'||auth.mode==='each');requireEvidence(authorized!==null&&authorized<=started&&auth.authorizedBy&&auth.accountIds.includes(assignment.account_id)&&Number.isSafeInteger(auth.maxPublishItems)&&auth.maxPublishItems>0);
 const start=publicationInstant(`${auth.weekStart}T00:00:00Z`),end=publicationInstant(`${auth.weekEnd}T23:59:59.999Z`);requireEvidence(start!==null&&end!==null&&started>=start&&resolved<=end&&auth.weekStart===pkg.weekStart&&auth.weekEnd===pkg.weekEnd);
 if(auth.revokedAt){const revoked=publicationInstant(auth.revokedAt);requireEvidence(revoked!==null&&resolved<=revoked&&auth.revokedBy&&!auth.allowRealPublishing);}else requireEvidence(auth.allowRealPublishing===true);
 if(assignment.status==='revoked'||assignment.authorization_revoked_at){const revoked=publicationInstant(assignment.authorization_revoked_at??'');requireEvidence(assignment.status==='revoked'&&revoked!==null&&resolved<=revoked&&assignment.authorization_revoked_by);}
 const expectedProvider=assignment.platform==='tiktok'?'tiktok-content-posting-api':assignment.platform==='youtube'?'youtube-data-api':['instagram','facebook'].includes(assignment.platform)?'meta-graph-api':null;requireEvidence(attempt.provider===expectedProvider);
 const manifest=await readStarterPublicationPackage(task.tenantId,attempt.package_id,store);requireEvidence(manifest?.operatingLineage&&manifest.tenantId===task.tenantId&&manifest.packageId===assignment.package_id&&manifest.platform===assignment.platform&&manifest.operatingLineage.assignmentId===assignment.assignment_id&&manifest.operatingLineage.assignmentHash===assignment.assignment_hash&&manifest.operatingLineage.productionResultRef.id===assignment.production_result_id);
 const publication=pkg.socialContentPackage.publicationTasks.find(p=>p.publicationTaskId===assignment.publication_task_id);requireEvidence(publication);
 const rebuilt=buildPublicationAssignment({tenantId:task.tenantId,operatingPackage:pkg,publicationTask:publication,productionResult:{productionResultId:assignment.production_result_id,productionResultRef:assignment.payload.lineage.productionResultRef,contentId:manifest.contentId,contentVersion:manifest.contentVersion,contentHash:manifest.contentHash,title:manifest.copy.title,body:manifest.copy.body,assets:manifest.assets,sourceRefs:assignment.payload.lineage.upstreamRefs,acceptedAt:manifest.generatedAt,...(assignment.payload.lineage.instagramDelivery?{instagramDelivery:assignment.payload.lineage.instagramDelivery}:{})}});
 requireEvidence(rebuilt.assignmentId===assignment.assignment_id&&rebuilt.assignmentHash===assignment.assignment_hash&&rebuilt.packageId===assignment.package_id&&rebuilt.packageIdempotencyKey===assignment.payload.packageIdempotencyKey&&rebuilt.publishWindow===assignment.payload.publishWindow);
 await validateWeeklyPublicationAcceptance(store,task,assignment.production_result_id);
}
