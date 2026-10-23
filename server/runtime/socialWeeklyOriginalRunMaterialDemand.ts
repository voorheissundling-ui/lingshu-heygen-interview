import {readWeeklySchedulerMaterialPlan} from '../starter198/socialWeeklySchedulerMaterialPlan.js';
import {assertExecutionPackageGate,executionPackageFrozen} from '../socialPrograms/weeklyExecutionGate.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import {createStarter198Repository,type Starter198Repository} from '../starter198/repository.js';
import {readSocialTaskDetail} from '../starter198/socialContentRecords.js';
import {socialObject,socialJson,socialRequestHash,SocialContentWorkflowError} from '../starter198/socialContentValidation.js';
import {buildNoSharedMaterialDemand,type WeeklyMaterialDemandScope,type FrozenNoSharedMaterialDemand} from './socialWeeklyMaterialDemand.js';
export type OriginalRunMaterialDemandScope=WeeklyMaterialDemandScope&{tenantId:string};
const obj=(value:unknown)=>socialObject(socialJson(value));
function listHash(values:Array<{id:string;version?:string}>){return socialRequestHash(values.map(v=>({id:v.id,...(v.version?{version:v.version}:{})})).sort((a,b)=>a.id.localeCompare(b.id)));}
export interface OriginalRunMaterialDemandPorts {repository:Starter198Repository}
function ownedRepository(store:DataStore,ports?:OriginalRunMaterialDemandPorts){if(ports&&ports.repository.dataStore!==store)throw new SocialContentWorkflowError('weekly_material_repository_authority_invalid',409);return ports?.repository??createStarter198Repository(store);}
async function originalSource(store:DataStore,scope:OriginalRunMaterialDemandScope,purpose:'read'|'freeze',ports?:OriginalRunMaterialDemandPorts){
 const repository=ownedRepository(store,ports);
 async function one(collection:string,where:Record<string,string|number>){const found=await store.list<Record_>(collection,{where,perPage:2});return found.totalItems===1&&found.items.length===1&&found.items[0]&&Object.entries(where).every(([key,value])=>found.items[0]![key]===value)?found.items[0]:null;}
 const row=await one('starter_social_content_tasks',{tenant_id:scope.tenantId,task_id:scope.taskId});
 if(!row||typeof row.tenant_id!=='string'||!row.tenant_id||typeof row.run_id!=='string'||!row.run_id||row.create_idempotency_key!==`weekly-production:${scope.packageId}:${scope.packageVersion}:${scope.publicationTaskId}`)return null;
 const tenantId=row.tenant_id;
 const run=await store.getById<Record_>('workflow_runs',row.run_id),context=obj(run?.starter_context);
 if(!run||run.tenant_id!==tenantId||context?.schemaVersion!=='starter-social-content.auto-execution.v1'||context.socialTaskId!==scope.taskId||typeof context.socialTaskVersion!=='string'||!context.socialTaskVersion||!Array.isArray(context.sourceRefs)||!Array.isArray(context.packageSelection))return null;
 const authority=obj(obj(row.brief)?._weeklyAuthority),weekly=obj(authority?.weeklyPackage),publication=obj(authority?.publicationTask);
 if(!authority||weekly?.programId!==scope.programId||weekly.packageId!==scope.packageId||weekly.version!==scope.packageVersion||publication?.publicationTaskId!==scope.publicationTaskId||publication.accountId!==scope.accountId||socialRequestHash(publication.factRefs)!==socialRequestHash(scope.factRefs))return null;
 const pkg=await one('social_weekly_operating_packages',{tenant_id:tenantId,program_id:scope.programId,package_id:scope.packageId,version:scope.packageVersion}),payload=obj(pkg?.payload),pack=obj(payload?.socialContentPackage);
 if(!payload||!(purpose==='freeze'?['draft','active']:['draft','active','superseded','retired']).includes(String(payload.status))||!Array.isArray(pack?.publicationTasks))return null;
 const pubs=pack.publicationTasks.map(obj).filter(p=>p?.publicationTaskId===scope.publicationTaskId);
 if(pubs.length!==1||pubs[0]?.accountId!==scope.accountId||socialRequestHash(pubs[0]?.factRefs)!==socialRequestHash(scope.factRefs)||pubs[0]?.materialRequirement)return null;
 const detail=await readSocialTaskDetail({repository,tenantId,taskId:scope.taskId});
 if(!detail||detail.runId!==row.run_id||!detail.assetSupplyPlan)return null;
 if(context.weeklyMaterialPlan){const frozenPlan=await readWeeklySchedulerMaterialPlan(repository,row,detail);if(!frozenPlan)return null;detail.assetSupplyPlan=frozenPlan;}
 const sources=detail.sources.filter(s=>s.status==='active');
 const refs=context.sourceRefs.map(obj);if(refs.some(r=>!r||typeof r.id!=='string'||(r.version!==undefined&&typeof r.version!=='string')))return null;
 if(listHash(sources.map(s=>({id:s.sourceId,...(s.sourceVersion?{version:s.sourceVersion}:{})})))!==listHash(refs.map(r=>({id:String(r!.id),...(r!.version?{version:String(r!.version)}:{})}))))return null;
 const packages=(values:unknown[])=>values.map(obj).map(p=>({kind:p?.kind,packageKey:p?.packageKey,version:p?.version})).sort((a,b)=>String(a.kind).localeCompare(String(b.kind)));
 if(socialRequestHash(packages(detail.packageSelection))!==socialRequestHash(packages(context.packageSelection)))return null;
 const {tenantId:scopedTenant,...demandScope}=scope;
 const demand=buildNoSharedMaterialDemand(row,detail,demandScope);if(!demand)return null;
 return {row,tenantId,demand,proof:{runId:row.run_id,runContextHash:socialRequestHash(context),sourceDigest:socialRequestHash(sources),authorityHash:socialRequestHash(authority),planHash:socialRequestHash(detail.assetSupplyPlan)}};
}
export async function readVerifiedNoSharedMaterialDemand(store:DataStore,row:Record<string,unknown>,scope:OriginalRunMaterialDemandScope,ports?:OriginalRunMaterialDemandPorts):Promise<FrozenNoSharedMaterialDemand|null>{
 const repository=ownedRepository(store,ports);
 if(row.tenant_id!==scope.tenantId)return null;
 const stored=obj(row.brief)?._weeklyMaterialDemand as FrozenNoSharedMaterialDemand|undefined;
 if(!stored?.runProof){
   // An old pre-start declaration never authorizes a running producer without
   // a separately frozen original-run proof. Re-read pre-start plans as well.
   if(row.run_id)return null;
   const legacy=(await import('./socialWeeklyMaterialDemand.js')).verifiedNoSharedMaterialDemand(row,scope);
   if(!legacy)return null;
   const detail=await readSocialTaskDetail({repository,tenantId:scope.tenantId,taskId:scope.taskId});
   if(!detail||detail.runId)return null;
   const {tenantId:ignored,...demandScope}=scope;
   const actual=buildNoSharedMaterialDemand(row,detail,demandScope);
   return actual&&actual.recordHash===legacy.recordHash?legacy:null;
 }
 const {recordHash,...payload}=stored;if(recordHash!==socialRequestHash(payload))return null;
 const actual=await originalSource(store,scope,'read',ports);if(!actual||actual.row.id!==row.id||socialRequestHash(stored.runProof)!==socialRequestHash(actual.proof))return null;
 const {recordHash:ignored,...current}=actual.demand;
 return socialRequestHash({...current,runProof:actual.proof})===stored.recordHash?stored:null;
}
/** Write only for draft/active packages. Historical signature reads do not authorize new work. */
export async function freezeOriginalRunMaterialDemand(store:DataStore,scope:OriginalRunMaterialDemandScope,ports?:OriginalRunMaterialDemandPorts):Promise<FrozenNoSharedMaterialDemand|null>{
 const first=await originalSource(store,scope,'freeze',ports);if(!first)return null;
 const existing=obj(first.row.brief)?._weeklyMaterialDemand;
 if(existing){
   const legacy=existing as FrozenNoSharedMaterialDemand;
   if(legacy.runProof)return readVerifiedNoSharedMaterialDemand(store,first.row,scope,ports);
   try{if(!await assertExecutionPackageGate(store,{tenantId:scope.tenantId,programId:scope.programId,packageId:scope.packageId,packageVersion:scope.packageVersion}))return null;}catch{return null;}
   if(await executionPackageFrozen(store,{tenantId:scope.tenantId,programId:scope.programId,packageId:scope.packageId,packageVersion:scope.packageVersion}))return null;
   const verified=(await import('./socialWeeklyMaterialDemand.js')).verifiedNoSharedMaterialDemand(first.row,scope);
   const run=await store.getById<Record_>('workflow_runs',first.proof.runId),context=obj(run?.starter_context);
   if(!verified||String(verified.version)!==String(context?.socialTaskVersion)?.replace(/^v/,''))return null;
   const {recordHash:oldHash,version:oldVersion,...oldBase}=verified;
   const {recordHash:newHash,version:newVersion,...newBase}=first.demand;
   if(socialRequestHash(oldBase)!==socialRequestHash(newBase))return null;
   // Continue below with double fresh source validation before freezing a
   // new run-bound proof; the old declaration is never accepted by paid reads.
 }
 const second=await originalSource(store,scope,'freeze',ports);if(!second||second.row.id!==first.row.id||socialRequestHash(second.proof)!==socialRequestHash(first.proof)||socialRequestHash(second.demand)!==socialRequestHash(first.demand))return null;
 if(socialRequestHash(obj(second.row.brief)?._weeklyMaterialDemand??null)!==socialRequestHash(existing??null))return null;
 const {recordHash:ignored,...base}=first.demand;const payload={...base,runProof:first.proof};const demand={...payload,recordHash:socialRequestHash(payload)};
 if(!await store.update('starter_social_content_tasks',first.row.id,{brief:{...obj(second.row.brief),_weeklyMaterialDemand:demand}}))return null;
 const fresh=await store.getById<Record_>('starter_social_content_tasks',first.row.id);
 return fresh?readVerifiedNoSharedMaterialDemand(store,fresh,scope,ports):null;
}
