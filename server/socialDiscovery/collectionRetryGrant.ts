import type {DataStore,Record_} from '../storage/datastore.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {readWeeklyReviewActor} from '../socialPrograms/weeklyReviewEvidence.js';
import {planTerminalDiscoverySourceRetry} from './retryPlan.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import {PACKAGES} from '../socialPrograms/weeklyOperatingPackageSupport.js';

export const COLLECTION_RETRY_GRANTS='social_discovery_retry_grants';
export interface CollectionRetryScope {tenantId:string;programId:string;packageId:string;packageVersion:number;taskId:string;parentRunId:string;parentRunHash:string;}
export interface CollectionRetryGrant extends CollectionRetryScope {grantId:string;count:number;businessDate:string;actorUserId:string;authorizedAt:string;source:'explicit_user_authorization';authorizationRef:string;authorizationText:string;recordHash:string;}
const seal=(g:CollectionRetryGrant)=>({...g,recordHash:socialRequestHash({...g,recordHash:''})});
type DiscoveryRoot={jobId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;consumerTaskId:string;kind:string;status:string;originalRunKey:string;sourceHash:string;authority?:unknown;recordHash:string};
const rootSeal=(root:DiscoveryRoot)=>socialRequestHash({...root,recordHash:''});
function checkedRoot(row:Record_){
 const root=row.payload as DiscoveryRoot;
 if(!root||root.kind!=='discovery'||!root.jobId||!root.originalRunKey||!root.sourceHash||!root.authority||root.recordHash!==rootSeal(root)||row.record_hash!==root.recordHash||row.id!==root.jobId||row.tenant_id!==root.tenantId||row.program_id!==root.programId||row.package_id!==root.packageId||row.package_version!==root.packageVersion||row.task_id!==root.consumerTaskId)throw Error('collection_retry_root_invalid');
 return root;
}
async function canonicalRoot(store:DataStore,input:{tenantId:string;programId:string;packageId:string;packageVersion:number;taskId:string}){
 const requestedRows=await store.list<Record_>('social_weekly_preproduction_jobs',{where:{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion,task_id:input.taskId},perPage:2});
 if(requestedRows.totalItems!==1)throw Error('collection_retry_root_unavailable');
 const requested=checkedRoot(requestedRows.items[0]!);
 if(requested.status!=='blocked')throw Error('collection_retry_root_unavailable');
 const rows:Record_[]=[];
 for(let page=1;page<=1000;page++){
  const result=await store.list<Record_>('social_weekly_preproduction_jobs',{where:{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,package_version:input.packageVersion},page,perPage:100});
  rows.push(...result.items);
  if(page>=result.totalPages){if(rows.length!==result.totalItems)throw Error('collection_retry_root_scan_incomplete');break;}
  if(!result.items.length)throw Error('collection_retry_root_scan_incomplete');
 }
 const cohort=rows.filter(row=>(row.payload as {kind?:string}|undefined)?.kind==='discovery').map(checkedRoot).filter(root=>root.sourceHash===requested.sourceHash&&socialRequestHash(root.authority)===socialRequestHash(requested.authority)).sort((left,right)=>left.jobId.localeCompare(right.jobId));
 const leader=cohort[0];
 if(!leader||leader.status!=='blocked')throw Error('collection_retry_root_unavailable');
 return leader;
}
export async function validateCollectionRetryGrant(store:DataStore,scope:CollectionRetryScope){
 const id=socialRequestHash(scope),row=await store.getById<Record_>(COLLECTION_RETRY_GRANTS,id);
 if(!row)return null;
 const g=row.payload as CollectionRetryGrant;
 if(!g||g.grantId!==id||g.recordHash!==seal(g).recordHash||row.record_hash!==g.recordHash||row.tenant_id!==scope.tenantId||Object.entries(scope).some(([k,v])=>g[k as keyof CollectionRetryScope]!==v)||g.source!=='explicit_user_authorization'||!Number.isSafeInteger(g.count)||g.count<1||g.count>10||!g.authorizationRef||!g.authorizationText)throw Error('collection_retry_grant_invalid');
 return g;
}
/** Internal configuration adoption, not a task-start or status mutation API.
 * Must only be invoked with an actual human authorization; never by a scan. */
export async function recordCollectionRetryGrant(store:DataStore,input:Omit<CollectionRetryGrant,'grantId'|'recordHash'|'source'>){
 if(!Number.isSafeInteger(input.count)||input.count<1||input.count>10||!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)||!Number.isFinite(Date.parse(input.authorizedAt))||!input.authorizationRef||!input.authorizationText)throw Error('collection_retry_authorization_invalid');
 const actor=await readWeeklyReviewActor(store,input.tenantId,input.actorUserId);
 if(!actor||actor.tenantId!==input.tenantId||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status))||!['admin','super_admin','social_operator'].includes(String(actor.role)))throw Error('collection_retry_actor_forbidden');
 const packages=await store.list<Record_>(PACKAGES,{where:{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId},sort:'-version',perPage:1}),pkg=packages.items[0]?.payload as any;
 if(!pkg||pkg.version!==input.packageVersion||!['draft','active'].includes(pkg.status))throw Error('collection_retry_package_stale');
 const root=await canonicalRoot(store,input);
 const scope:CollectionRetryScope={tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,taskId:root.consumerTaskId,parentRunId:input.parentRunId,parentRunHash:input.parentRunHash};
 if(input.parentRunId!==`weekly_discovery_${socialRequestHash({tenantId:input.tenantId,key:root.originalRunKey})}`)throw Error('collection_retry_parent_scope_changed');
 const rows=await store.list<SocialInspirationCollectionRun & Record_>('social_discovery_runs',{where:{tenant_id:input.tenantId,runId:input.parentRunId},perPage:2});
 const parent=rows.items[0];
 const weeklyProducer=(parent?.scopeSnapshot as {weeklyProducer?:{key?:string}}|undefined)?.weeklyProducer;
 if(rows.totalItems!==1||!parent||socialRequestHash(parent)!==input.parentRunHash||parent.discoveryScopeId!==(root.authority as {scopeId?:string}).scopeId||parent.discoveryScopeVersion!==(root.authority as {scopeVersion?:number}).scopeVersion||weeklyProducer?.key!==root.originalRunKey||planTerminalDiscoverySourceRetry(parent).blockingCodes.length)throw Error('collection_retry_parent_unverified');
 const prior=await validateCollectionRetryGrant(store,scope);
 if(prior){if(prior.count!==input.count||prior.authorizationRef!==input.authorizationRef||prior.businessDate!==input.businessDate)throw Error('collection_retry_grant_conflict');return prior;}
 const grant=seal({...input,...scope,grantId:socialRequestHash(scope),source:'explicit_user_authorization',recordHash:''});
 if(!await store.create(COLLECTION_RETRY_GRANTS,{id:grant.grantId,tenant_id:input.tenantId,record_hash:grant.recordHash,payload:grant})){
  const recovered=await validateCollectionRetryGrant(store,scope);if(!recovered||recovered.recordHash!==grant.recordHash)throw Error('collection_retry_grant_write_unknown');return recovered;
 }
 return grant;
}
