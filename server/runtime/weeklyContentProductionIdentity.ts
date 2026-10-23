/** 面试阅读注释：身份边界：周包版本、发布任务、内容任务和共享原创之间的绑定。不能按标题或最新记录猜对应关系。 */
import type {DataStore, Record_} from '../storage/datastore.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import type {WeeklyOperatingPackage,WeeklyExecutionTask} from '../../shared/contracts/socialProgram.js';
import type {VersionedSocialRef} from '../../shared/contracts/socialProgram.js';

export const WEEKLY_CONTENT_DISTRIBUTION_BINDINGS='social_weekly_content_distribution_bindings';
export interface WeeklyProductionScope {tenantId:string;programId:string;packageId:string;packageVersion:number;publicationTaskId:string;}
export interface WeeklyContentDistributionBinding {
 schemaVersion:'weekly-content-distribution.v1';scope:WeeklyProductionScope;
 contentId:string;productionTaskId:string;productionBindingKey:string;
 canonicalPublicationTaskId?:string;
}
export function canonicalWeeklyProductionPublication(pkg:WeeklyOperatingPackage,publicationTaskId:string){
 const matches=pkg.socialContentPackage.publicationTasks.filter(p=>p.publicationTaskId===publicationTaskId);if(matches.length!==1)throw Error('weekly_content_publication_missing');const pub=matches[0]!;
 if(pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1'||pub.inventoryReuseRef)return pub;
 if(!pub.motherContentId)throw Error('weekly_content_original_identity_missing');
 const group=pkg.socialContentPackage.publicationTasks.filter(p=>p.motherContentId===pub.motherContentId&&!p.inventoryReuseRef);
 const roots=group.filter(p=>!p.adaptationOfPublicationTaskId);if(roots.length!==1)throw Error('weekly_content_original_identity_ambiguous');const root=roots[0]!;
 // Sharing is explicit frozen scope, never a title-based deduplication. A
 // contradictory factual/creative contract cannot inherit another video's rights.
 const productionContract=(p:typeof pub)=>({businessProposition:p.businessProposition,cta:p.cta,factRefs:p.factRefs,contentTemplateBindingRef:p.contentTemplateBindingRef??null,materialRequirement:p.materialRequirement??null});
 if(socialRequestHash(productionContract(pub))!==socialRequestHash(productionContract(root)))throw Error('weekly_content_original_contract_conflict');
 return root;
}
export async function weeklyProductionCanonicalScope(store:DataStore,scope:WeeklyProductionScope){
 const rows=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,version:scope.packageVersion},perPage:2});
 if(rows.totalItems===0)return scope; // historical narrow evidence fixtures/records
 if(rows.totalItems!==1||rows.items.length!==1)throw Error('weekly_content_package_ambiguous');
 const pkg=rows.items[0]!.payload as WeeklyOperatingPackage;
 if(pkg?.socialContentPackage?.productionIdentityVersion!=='shared-original.v1')return scope;
 if(!pkg||pkg.programId!==scope.programId||pkg.packageId!==scope.packageId||pkg.version!==scope.packageVersion)throw Error('weekly_content_package_scope_invalid');
 return {...scope,publicationTaskId:canonicalWeeklyProductionPublication(pkg,scope.publicationTaskId).publicationTaskId};
}
export async function weeklyProductionEvidenceTask(store:DataStore,task:WeeklyExecutionTask):Promise<WeeklyExecutionTask>{
 if(!task.publicationTaskId)return task;
 const scope=await weeklyProductionCanonicalScope(store,{tenantId:task.tenantId,programId:task.programId,packageId:task.packageId,packageVersion:task.packageVersion,publicationTaskId:task.publicationTaskId});
 if(scope.publicationTaskId===task.publicationTaskId)return task;
 const rows=await store.list<Record_>('social_weekly_execution_tasks',{where:{tenant_id:task.tenantId,program_id:task.programId,package_id:task.packageId,package_version:task.packageVersion},perPage:1000});if(rows.totalItems!==rows.items.length)throw Error('weekly_content_graph_incomplete');
 const found=rows.items.flatMap(r=>{const t=r.payload as WeeklyExecutionTask;if(t?.publicationTaskId!==scope.publicationTaskId||t.schedule?.stepKind!==task.schedule.stepKind)return[];if(t.tenantId!==task.tenantId||t.programId!==task.programId||t.packageId!==task.packageId||t.packageVersion!==task.packageVersion||t.taskId!==r.task_id)throw Error('weekly_content_original_stage_scope_invalid');return[t];});
 if(found.length!==1)throw Error('weekly_content_original_stage_ambiguous');return found[0]!;
}
export async function weeklyProductionRowMatches(store:DataStore,scope:WeeklyProductionScope,row:Record_){const found=await resolveWeeklyProductionRow(store,scope);return Boolean(found&&found.task_id===row.task_id&&found.id===row.id);}
export async function assertWeeklySharedProductionGroupUnsplit(store:DataStore,tenantId:string,pkg:WeeklyOperatingPackage,publicationTaskId:string){
 if(pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1')return;
 const canonical=canonicalWeeklyProductionPublication(pkg,publicationTaskId);
 for(const pub of pkg.socialContentPackage.publicationTasks.filter(p=>p.motherContentId===canonical.motherContentId&&p.publicationTaskId!==canonical.publicationTaskId&&!p.inventoryReuseRef)){
   const existing=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:tenantId,create_idempotency_key:legacyWeeklyProductionKey({packageId:pkg.packageId,packageVersion:pkg.version,publicationTaskId:pub.publicationTaskId})},perPage:2});
   if(existing.totalItems||existing.items.length)throw Error('weekly_content_legacy_identity_conflict');
 }
}
export async function persistWeeklySharedProductionBindings(store:DataStore,tenantId:string,pkg:WeeklyOperatingPackage,row:Record_){
 if(pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1')return;
 const authority=(row.brief as any)?._weeklyAuthority,root=authority?.publicationTask;
 if(!root||row.tenant_id!==tenantId||authority?.weeklyPackage?.packageId!==pkg.packageId||authority?.weeklyPackage?.version!==pkg.version||authority?.weeklyPackage?.programId!==pkg.programId)throw Error('weekly_content_production_authority_invalid');
 const canonical=canonicalWeeklyProductionPublication(pkg,root.publicationTaskId);if(canonical.publicationTaskId!==root.publicationTaskId||row.create_idempotency_key!==legacyWeeklyProductionKey({packageId:pkg.packageId,packageVersion:pkg.version,publicationTaskId:root.publicationTaskId}))throw Error('weekly_content_original_authority_invalid');
 for(const pub of pkg.socialContentPackage.publicationTasks.filter(p=>p.motherContentId===canonical.motherContentId&&!p.inventoryReuseRef)){
   try{canonicalWeeklyProductionPublication(pkg,pub.publicationTaskId);}catch(error){if(error instanceof Error&&error.message==='weekly_content_original_contract_conflict')continue;throw error;}
   const scope:WeeklyProductionScope={tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version,publicationTaskId:pub.publicationTaskId};
   const current=await resolveWeeklyProductionRow(store,scope);if(current&&current.task_id!==row.task_id)throw Error('weekly_content_legacy_identity_conflict');
   const payload:WeeklyContentDistributionBinding={schemaVersion:'weekly-content-distribution.v1',scope,contentId:String(row.task_id),productionTaskId:String(row.task_id),productionBindingKey:String(row.create_idempotency_key),canonicalPublicationTaskId:canonical.publicationTaskId};
   const id=socialRequestHash(scope).slice(0,15),existing=await store.getById<Record_>(WEEKLY_CONTENT_DISTRIBUTION_BINDINGS,id);
   if(existing){if(existing.content_hash!==socialRequestHash(payload))throw Error('weekly_content_distribution_binding_changed');continue;}
   const saved=await store.create(WEEKLY_CONTENT_DISTRIBUTION_BINDINGS,{id,tenant_id:tenantId,program_id:pkg.programId,package_id:pkg.packageId,package_version:pkg.version,publication_task_id:pub.publicationTaskId,content_hash:socialRequestHash(payload),payload});if(!saved)throw Error('weekly_content_distribution_binding_storage_failed');
 }
}
export async function verifySharedOriginalProductionAdmission(input:{store:DataStore;tenantId:string;task:Record_}){
 const {store,tenantId,task}=input,authority=(task.brief as any)?._weeklyAuthority,frozen=authority?.weeklyPackage,publication=authority?.publicationTask;
 if(task.tenant_id!==tenantId||!frozen||!publication)throw Error('weekly_shared_original_authority_required');
 const rows=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:tenantId,program_id:frozen.programId,package_id:frozen.packageId,version:frozen.version},perPage:2});
 if(rows.totalItems!==1||rows.items.length!==1)throw Error('weekly_shared_original_package_required');const pkg=rows.items[0]!.payload as WeeklyOperatingPackage;
 if(!pkg||pkg.programId!==frozen.programId||pkg.packageId!==frozen.packageId||pkg.version!==frozen.version||pkg.socialContentPackage.productionIdentityVersion!=='shared-original.v1'||!['draft','active'].includes(pkg.status))throw Error('weekly_shared_original_package_invalid');
 const canonical=canonicalWeeklyProductionPublication(pkg,publication.publicationTaskId);
 const frozenPublication=(value:Record<string,unknown>)=>{const {status,...body}=value;return body;};
 if(canonical.status==='cancelled'||canonical.publicationTaskId!==publication.publicationTaskId||socialRequestHash(frozenPublication(canonical as unknown as Record<string,unknown>))!==socialRequestHash(frozenPublication(publication))||task.create_idempotency_key!==legacyWeeklyProductionKey({packageId:pkg.packageId,packageVersion:pkg.version,publicationTaskId:canonical.publicationTaskId})||authority.programRef?.id!==pkg.programId)throw Error('weekly_shared_original_identity_invalid');
 const resolved=await resolveWeeklyProductionRow(store,{tenantId,programId:pkg.programId,packageId:pkg.packageId,packageVersion:pkg.version,publicationTaskId:canonical.publicationTaskId});if(resolved?.task_id!==task.task_id)throw Error('weekly_shared_original_identity_invalid');
 return {contentId:String(task.task_id),programId:pkg.programId,originWeek:pkg.weekStart,packageId:pkg.packageId,packageVersion:pkg.version,canonicalPublicationTaskId:canonical.publicationTaskId};
}
/** Approval changes the artifact record version, not the generated media. Only
 * a proven exact approval revision may advance shared producer references. */
export async function currentSharedWeeklyArtifactRef(store:DataStore,scope:WeeklyProductionScope,ref:VersionedSocialRef):Promise<VersionedSocialRef>{
 if(ref.type!=='starter_social_content_artifact')return ref;
 const packages=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,version:scope.packageVersion},perPage:2});if(packages.totalItems!==1||(packages.items[0]?.payload as WeeklyOperatingPackage)?.socialContentPackage?.productionIdentityVersion!=='shared-original.v1')return ref;
 const rows=await store.list<Record_>('starter_social_content_artifacts',{where:{tenant_id:scope.tenantId,artifact_id:ref.id},perPage:2});if(rows.totalItems===0)return ref;if(rows.totalItems!==1||rows.items.length!==1)throw Error('weekly_shared_artifact_ambiguous');const row=rows.items[0]!,version=Number(String(row.version).replace(/^v/,''));
 if(version===ref.version)return ref;
 if(row.status!=='approved'||version!==ref.version+1||typeof row.last_operation_id!=='string')throw Error('weekly_shared_artifact_version_changed');
 const operations=await store.list<Record_>('starter_social_content_operations',{where:{tenant_id:scope.tenantId,operation_id:row.last_operation_id},perPage:2});const operation=operations.items[0];
 if(operations.totalItems!==1||!operation||operation.operation!=='decide_social_content_artifact'||operation.target_id!==row.task_id||operation.status!=='succeeded'||![String(ref.version),`v${ref.version}`].some(expectedVersion=>operation.request_hash===socialRequestHash({decision:'approved',expectedVersion,note:row.decision_note})))throw Error('weekly_shared_artifact_approval_unverified');
 const source=await resolveWeeklyProductionRow(store,scope);if(source?.task_id!==row.task_id)throw Error('weekly_shared_artifact_source_changed');return {...ref,version};
}
export function legacyWeeklyProductionKey(scope:Pick<WeeklyProductionScope,'packageId'|'packageVersion'|'publicationTaskId'>){return `weekly-production:${scope.packageId}:${scope.packageVersion}:${scope.publicationTaskId}`;}
/** Read-only migration boundary. Never renames an old run, merges by title, or
 * creates a replacement when the old provider outcome may be unknown. */
export async function resolveWeeklyProductionRow(store:DataStore,scope:WeeklyProductionScope):Promise<Record_|null>{
 const identityScope:WeeklyProductionScope={tenantId:scope.tenantId,programId:scope.programId,packageId:scope.packageId,packageVersion:scope.packageVersion,publicationTaskId:scope.publicationTaskId};
 const where={tenant_id:identityScope.tenantId,program_id:identityScope.programId,package_id:identityScope.packageId,package_version:identityScope.packageVersion,publication_task_id:identityScope.publicationTaskId};
 const links=await store.list<Record_>(WEEKLY_CONTENT_DISTRIBUTION_BINDINGS,{where,perPage:2});
 if(links.totalItems>1||links.items.length>1)throw Error('weekly_content_distribution_binding_ambiguous');
 const legacy=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:scope.tenantId,create_idempotency_key:legacyWeeklyProductionKey(scope)},perPage:2});
 if(legacy.totalItems>1||legacy.items.length>1)throw Error('weekly_production_binding_ambiguous');
 if(!links.items.length){const canonical=await weeklyProductionCanonicalScope(store,scope);if(canonical.publicationTaskId===scope.publicationTaskId)return legacy.items[0]??null;
   if(legacy.items[0])throw Error('weekly_content_legacy_identity_conflict');
   return resolveWeeklyProductionRow(store,canonical);
 }
 const link=links.items[0]!,binding=link.payload as WeeklyContentDistributionBinding;
 if(!binding||binding.schemaVersion!=='weekly-content-distribution.v1'||socialRequestHash(binding.scope)!==socialRequestHash(identityScope)||link.content_hash!==socialRequestHash(binding)||!binding.contentId||!binding.productionTaskId||!binding.productionBindingKey)throw Error('weekly_content_distribution_binding_invalid');
 const found=await store.list<Record_>('starter_social_content_tasks',{where:{tenant_id:scope.tenantId,task_id:binding.productionTaskId},perPage:2});
 if(found.totalItems!==1||found.items.length!==1)throw Error('weekly_content_production_identity_missing');
 const row=found.items[0]!,brief=row.brief as Record<string,any>|undefined;
 if(row.create_idempotency_key!==binding.productionBindingKey||brief?.programRef?.id!==scope.programId)throw Error('weekly_content_production_identity_invalid');
 if(binding.canonicalPublicationTaskId){const canonical=await weeklyProductionCanonicalScope(store,scope),authority=brief?._weeklyAuthority;
   if(canonical.publicationTaskId!==binding.canonicalPublicationTaskId||binding.productionBindingKey!==legacyWeeklyProductionKey(canonical)||binding.contentId!==row.task_id||authority?.publicationTask?.publicationTaskId!==canonical.publicationTaskId||authority?.weeklyPackage?.programId!==scope.programId||authority?.weeklyPackage?.packageId!==scope.packageId||authority?.weeklyPackage?.version!==scope.packageVersion)throw Error('weekly_content_distribution_authority_invalid');
 }
 // A durable legacy order is never silently superseded, even if it is draft:
 // only an explicit migration may add a link pointing back to that same order.
 if(legacy.items[0]&&legacy.items[0].task_id!==row.task_id)throw Error('weekly_content_legacy_identity_conflict');
 return row;
}
