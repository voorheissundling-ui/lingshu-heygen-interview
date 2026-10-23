import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import {socialJson,socialObject,socialRequestHash} from '../starter198/socialContentValidation.js';
import {readWeeklyReviewActor} from '../socialPrograms/weeklyReviewEvidence.js';
import {probeReferenceMediaClock} from '../lib/referenceMediaClock.js';
import {classifyDiscoverySourceFailure} from '../socialDiscovery/sourceFailure.js';
import {CANDIDATE_ANALYSIS_OPERATIONS,CANDIDATE_ANALYSIS_RECEIPTS} from './weeklyCandidateReassessment.js';
import {PREPRODUCTION_RETRY_ATTEMPTS,type WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {executionPackageFrozen} from '../socialPrograms/weeklyExecutionGate.js';
import {dashscopeApiKey,getQwenProviderBinding} from '../agents/qwen.js';
import {withExactQwenScope} from '../agents/exactQwenScope.js';
import os from 'node:os';
import {store as routeStore} from '../storage/index.js';
import {verifiedWeeklyCandidateMedia} from './weeklyCandidateReassessment.js';
import {classifyQwenCompatibleEndpoint} from '../lib/qwenCompatibleEndpoint.js';

export const CANDIDATE_MODEL_REVISIONS='social_weekly_candidate_model_revisions';
export const CANDIDATE_REVISED_ANALYSIS_OPERATIONS='social_weekly_candidate_revised_analysis_operations';
export const CANDIDATE_REVISED_ANALYSIS_RECEIPTS='social_weekly_candidate_revised_analysis_receipts';
export const CANDIDATE_MODEL_PROVIDER_RECEIPTS='social_weekly_candidate_model_provider_receipts';
const obj=(v:unknown):Record<string,unknown>=>socialObject(socialJson(v))??{};
export interface CandidateModelConfiguration {endpoint:string;model:string;credentialDigest:string;}
interface CandidateProof {candidateId:string;parentOperationId:string;parentReceiptHash:string;parentReceiptKind?:'original'|'revision';recordSnapshotHash:string;recordSnapshot:Record_;mediaSha256:string;mediaFileId:string;duration:number;}
export interface CandidateModelRevision {
 schema:'weekly-candidate-model-revision.v1';revisionId:string;tenantId:string;jobId:string;jobBindingHash:string;
 parentRevisionId?:string|null;parentRevisionHash?:string|null;revisionNumber?:number;
 configuration:CandidateModelConfiguration;configurationHash:string;candidateProofs:CandidateProof[];
 actorUserId:string;authorizationRef:string;authorizationText:string;authorizedAt:string;recordHash:string;
}
const bind=(j:WeeklyPreproductionRetryAttempt)=>socialRequestHash({tenantId:j.tenantId,programId:j.programId,packageId:j.packageId,packageVersion:j.packageVersion,jobId:j.jobId,consumerTaskId:j.consumerTaskId,consumerInputHash:j.consumerInputHash,authority:j.authority,retry:j.retry});
function config(c:CandidateModelConfiguration){const u=new URL(c.endpoint);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!c.model.trim()||!/^[a-f0-9]{64}$/.test(c.credentialDigest))throw Error('weekly_candidate_model_configuration_invalid');return c;}
async function currentJob(store:DataStore,j:WeeklyPreproductionRetryAttempt){
 const r=await store.getById<Record_>(PREPRODUCTION_RETRY_ATTEMPTS,j.jobId),p=r?.payload as WeeklyPreproductionRetryAttempt;if(!p||r?.tenant_id!==j.tenantId||r.record_hash!==p.recordHash||p.recordHash!==socialRequestHash({...p,recordHash:''})||bind(p)!==bind(j)||['cancelled','succeeded'].includes(p.status))throw Error('weekly_candidate_model_attempt_unverified');
 const packages=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:j.tenantId,program_id:j.programId,package_id:j.packageId},sort:'-version',perPage:1}),pkg=obj(packages.items[0]?.payload);
 if(pkg.version!==j.packageVersion||!['draft','active'].includes(String(pkg.status))||await executionPackageFrozen(store,{tenantId:j.tenantId,programId:j.programId,packageId:j.packageId,packageVersion:j.packageVersion}))throw Error('weekly_candidate_model_package_stale_or_frozen');
}
type ProviderBindingReader=()=>{baseUrl:string;credentialSha256:string};
function sameTrustedProvider(c:CandidateModelConfiguration,read:ProviderBindingReader){const b=read();if(c.endpoint!==b.baseUrl||c.credentialDigest!==b.credentialSha256)throw Error('weekly_candidate_model_provider_change_not_authorized');}
const revisionOperationId=(r:CandidateModelRevision,p:CandidateProof)=>socialRequestHash({revisionId:r.revisionId,revisionHash:r.recordHash,candidateId:p.candidateId,parentOperationId:p.parentOperationId,parentReceiptHash:p.parentReceiptHash});
function verifiedRevision(row:Record_,j:WeeklyPreproductionRetryAttempt){const r=row.payload as CandidateModelRevision;if(!r||row.tenant_id!==j.tenantId||row.record_hash!==r.recordHash||r.recordHash!==socialRequestHash({...r,recordHash:''})||r.jobId!==j.jobId||r.jobBindingHash!==bind(j))throw Error('weekly_candidate_model_revision_unapproved');return r;}
function revisionHead(rows:Record_[],j:WeeklyPreproductionRetryAttempt){const revisions=rows.map(row=>verifiedRevision(row,j)),parents=new Set(revisions.map(r=>r.parentRevisionId).filter(Boolean));const heads=revisions.filter(r=>!parents.has(r.revisionId));if(heads.length!==1)throw Error('weekly_candidate_model_revision_ambiguous');const head=heads[0]!,byId=new Map(revisions.map(r=>[r.revisionId,r]));let cursor=head,depth=0;while(cursor.parentRevisionId){const parent=byId.get(cursor.parentRevisionId);if(!parent||cursor.parentRevisionHash!==parent.recordHash||(cursor.revisionNumber??0)!==(parent.revisionNumber??1)+1||++depth>revisions.length)throw Error('weekly_candidate_model_revision_chain_invalid');cursor=parent;}if(revisions.length>1&&depth!==revisions.length-1)throw Error('weekly_candidate_model_revision_ambiguous');return head;}
async function proof(store:DataStore,j:WeeklyPreproductionRetryAttempt,candidateId:string,mediaRoot:string,parent?:CandidateModelRevision):Promise<CandidateProof>{
 if(!/^[\w-]+$/.test(j.tenantId)||!/^[\w-]+$/.test(candidateId))throw Error('weekly_candidate_model_media_path_invalid');
 const r=await store.getById<Record_>('trend_videos',candidateId);if(!r||r.tenantId!==j.tenantId)throw Error('weekly_candidate_model_candidate_scope_changed');
 const a=obj(r.aiAnalysis),origins=Array.isArray(a.discoveryOrigins)?a.discoveryOrigins.map(obj):[];
 if(parent){
  const pp=parent.candidateProofs.find(v=>v.candidateId===candidateId);if(!pp)throw Error('weekly_candidate_model_revision_parent_candidate_changed');
  const parentOperationId=revisionOperationId(parent,pp),receipt=await store.getById<Record_>(CANDIDATE_REVISED_ANALYSIS_RECEIPTS,parentOperationId),rp=obj(receipt?.payload);
  if(!receipt||receipt.tenant_id!==j.tenantId||receipt.record_hash!==socialRequestHash(receipt.payload)||rp.operationId!==parentOperationId||rp.revisionHash!==parent.recordHash||rp.candidateId!==candidateId||rp.status!=='blocked'||(rp.reason!=='model_unavailable'&&classifyDiscoverySourceFailure(rp.reason)!=='model_unavailable')||rp.recordSnapshotHash!==socialRequestHash(r)||r.sourceUrl!==pp.recordSnapshot.sourceUrl||r.videoFileId!==pp.mediaFileId)throw Error('weekly_candidate_model_revision_parent_receipt_unverified');
  const relative=pp.mediaFileId,file=await fs.realpath(path.resolve(mediaRoot,relative)),base=await fs.realpath(path.resolve(mediaRoot,'tenants',j.tenantId));if(!file.startsWith(base+path.sep))throw Error('weekly_candidate_model_media_path_invalid');
  const mediaSha256=createHash('sha256').update(await fs.readFile(file)).digest('hex');if(mediaSha256!==pp.mediaSha256||mediaSha256!==a.contentSha256)throw Error('weekly_candidate_model_media_changed');
  const clock=await probeReferenceMediaClock(file);return {candidateId,parentOperationId,parentReceiptHash:String(receipt.record_hash),parentReceiptKind:'revision',recordSnapshotHash:String(rp.recordSnapshotHash),recordSnapshot:structuredClone(r),mediaSha256,mediaFileId:relative,duration:clock.duration};
 }
 const operations=await store.list<Record_>(CANDIDATE_ANALYSIS_OPERATIONS,{where:{tenant_id:j.tenantId,job_id:j.jobId,candidate_id:candidateId},perPage:2});
 if(operations.totalItems!==1)throw Error('weekly_candidate_model_original_operation_ambiguous');
 const op=operations.items[0]!,o=obj(op.payload),receipt=await store.getById<Record_>(CANDIDATE_ANALYSIS_RECEIPTS,op.id),p=obj(receipt?.payload);
 const origin=origins.find(v=>v.runId===o.parentRunId&&v.scopeId===j.authority?.scopeId&&v.scopeVersion===j.authority?.scopeVersion&&j.retry.sourceSelection.some(s=>s.platform===r.platform&&s.mode===v.mode&&s.queryRef===v.queryRef));
 if(op.record_hash!==socialRequestHash(op.payload)||o.jobId!==j.jobId||o.tenantId!==j.tenantId||o.candidateId!==candidateId||o.taskId!==j.consumerTaskId||!origin||o.sourceHash!==socialRequestHash(origin)||o.sourceUrl!==r.sourceUrl||!receipt||receipt.tenant_id!==j.tenantId||receipt.record_hash!==socialRequestHash(receipt.payload)||p.operationId!==op.id||p.jobId!==j.jobId||p.candidateId!==candidateId||p.status!=='blocked'||p.recordSnapshotHash!==socialRequestHash(r)||p.sourceHash!==o.sourceHash)throw Error('weekly_candidate_model_original_receipt_unverified');
 // A historical generic reason is not upgraded. Only the exact sealed snapshot
 // matching current bytes may prove a definite model rejection, never unknown.
 if(classifyDiscoverySourceFailure(a.analysisError??a.downloadError)!=='model_unavailable')throw Error('weekly_candidate_model_original_not_definite_rejection');
 const relative=`tenants/${j.tenantId}/reference-videos/${candidateId}.mp4`;
 if(r.videoFileId!==relative||!/^[a-f0-9]{64}$/.test(String(a.contentSha256)))throw Error('weekly_candidate_model_existing_media_required');
 const file=await fs.realpath(path.resolve(mediaRoot,relative)),base=await fs.realpath(path.resolve(mediaRoot,'tenants',j.tenantId));if(!file.startsWith(base+path.sep))throw Error('weekly_candidate_model_media_path_invalid');
 const mediaSha256=createHash('sha256').update(await fs.readFile(file)).digest('hex');if(mediaSha256!==a.contentSha256)throw Error('weekly_candidate_model_media_changed');
 const clock=await probeReferenceMediaClock(file);
 return {candidateId,parentOperationId:op.id,parentReceiptHash:String(receipt.record_hash),parentReceiptKind:'original',recordSnapshotHash:String(p.recordSnapshotHash),recordSnapshot:structuredClone(r),mediaSha256,mediaFileId:relative,duration:clock.duration};
}
/** Internal human-authorized configuration adoption only. No provider call,
 * task mutation, env adoption or automatic retry is performed here. */
export async function recordCandidateModelRevision(store:DataStore,j:WeeklyPreproductionRetryAttempt,input:{configuration:CandidateModelConfiguration;candidateIds:string[];actorUserId:string;authorizationRef:string;authorizationText:string;authorizedAt:string},mediaRoot:string,providerBinding:ProviderBindingReader=getQwenProviderBinding){
 await currentJob(store,j);config(input.configuration);sameTrustedProvider(input.configuration,providerBinding);
 if(!input.authorizationRef.trim()||!input.authorizationText.trim()||!Number.isFinite(Date.parse(input.authorizedAt))||!input.candidateIds.length||new Set(input.candidateIds).size!==input.candidateIds.length)throw Error('weekly_candidate_model_authorization_required');
 const actor=await readWeeklyReviewActor(store,j.tenantId,input.actorUserId);if(!actor||actor.tenantId!==j.tenantId||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status))||!['admin','super_admin','social_operator'].includes(String(actor.role)))throw Error('weekly_candidate_model_actor_forbidden');
 const previousRows=await store.list<Record_>(CANDIDATE_MODEL_REVISIONS,{where:{tenant_id:j.tenantId,job_id:j.jobId},perPage:200}),parent=previousRows.totalItems?revisionHead(previousRows.items,j):undefined;
 const sameCandidates=parent&&socialRequestHash(parent.candidateProofs.map(p=>p.candidateId).sort())===socialRequestHash([...input.candidateIds].sort());
 if(parent&&sameCandidates&&parent.configurationHash===socialRequestHash(input.configuration)&&parent.authorizationRef===input.authorizationRef&&parent.authorizationText===input.authorizationText&&parent.actorUserId===input.actorUserId)return parent;
 // A sealed provider rejection may need a newly authorized retry on the same
 // model (for example after fixing a scoped child-call leak). Configuration
 // equality is therefore not retry authority: both human authorization fields
 // must be fresh, and proof() below still requires the sealed terminal receipt.
 if(parent&&(!sameCandidates||parent.authorizationRef===input.authorizationRef||parent.authorizationText===input.authorizationText))throw Error('weekly_candidate_model_revision_not_new');
 const candidateProofs=await Promise.all(input.candidateIds.map(id=>proof(store,j,id,mediaRoot,parent))),configurationHash=socialRequestHash(input.configuration),revisionId=socialRequestHash({jobBindingHash:bind(j),parentRevisionId:parent?.revisionId??null,parentRevisionHash:parent?.recordHash??null,configurationHash,candidateProofs,authorizationRef:input.authorizationRef}).slice(0,24);
 const revision:CandidateModelRevision={schema:'weekly-candidate-model-revision.v1',revisionId,tenantId:j.tenantId,jobId:j.jobId,jobBindingHash:bind(j),parentRevisionId:parent?.revisionId??null,parentRevisionHash:parent?.recordHash??null,revisionNumber:(parent?(parent.revisionNumber??1):0)+1,configuration:input.configuration,configurationHash,candidateProofs,actorUserId:input.actorUserId,authorizationRef:input.authorizationRef,authorizationText:input.authorizationText,authorizedAt:input.authorizedAt,recordHash:''};revision.recordHash=socialRequestHash({...revision,recordHash:''});
 const existing=await store.getById<Record_>(CANDIDATE_MODEL_REVISIONS,revisionId);if(existing){const previous=existing.payload as CandidateModelRevision;if(existing.record_hash!==previous.recordHash||previous.recordHash!==socialRequestHash({...previous,recordHash:''})||socialRequestHash({...previous,authorizedAt:'',recordHash:''})!==socialRequestHash({...revision,authorizedAt:'',recordHash:''}))throw Error('weekly_candidate_model_revision_conflict');return previous;}
 if(!await store.create(CANDIDATE_MODEL_REVISIONS,{id:revisionId,tenant_id:j.tenantId,job_id:j.jobId,record_hash:revision.recordHash,payload:revision}))throw Error('weekly_candidate_model_revision_write_unknown');return revision;
}
/** Explicit revision ID and exact runtime fingerprint are mandatory. Merely
 * changing env cannot select a revision or reset an old submitted operation. */
export async function reserveRevisedCandidateAnalysis(store:DataStore,j:WeeklyPreproductionRetryAttempt,input:{revisionId:string;candidateId:string;configuration:CandidateModelConfiguration},mediaRoot:string,providerBinding:ProviderBindingReader=getQwenProviderBinding){
 sameTrustedProvider(config(input.configuration),providerBinding);
 await currentJob(store,j);const row=await store.getById<Record_>(CANDIDATE_MODEL_REVISIONS,input.revisionId),r=row?.payload as CandidateModelRevision;
 if(!r||row?.tenant_id!==j.tenantId||row.record_hash!==r.recordHash||r.recordHash!==socialRequestHash({...r,recordHash:''})||r.jobBindingHash!==bind(j)||r.configurationHash!==socialRequestHash(config(input.configuration))||!r.authorizationRef||!r.authorizationText)throw Error('weekly_candidate_model_revision_unapproved');
 const p=r.candidateProofs.find(v=>v.candidateId===input.candidateId);if(!p||socialRequestHash(p.recordSnapshot)!==p.recordSnapshotHash||classifyDiscoverySourceFailure(obj(p.recordSnapshot.aiAnalysis).analysisError??obj(p.recordSnapshot.aiAnalysis).downloadError)!=='model_unavailable')throw Error('weekly_candidate_model_revision_evidence_changed');
 const actor=await readWeeklyReviewActor(store,j.tenantId,r.actorUserId);if(!actor||actor.tenantId!==j.tenantId||actor.disabled===true||actor.active===false||['disabled','suspended'].includes(String(actor.status))||!['admin','super_admin','social_operator'].includes(String(actor.role)))throw Error('weekly_candidate_model_actor_forbidden');
 const frozenReceipt=await store.getById<Record_>(p.parentReceiptKind==='revision'?CANDIDATE_REVISED_ANALYSIS_RECEIPTS:CANDIDATE_ANALYSIS_RECEIPTS,p.parentOperationId);if(!frozenReceipt||frozenReceipt.record_hash!==p.parentReceiptHash||frozenReceipt.record_hash!==socialRequestHash(frozenReceipt.payload)||obj(frozenReceipt.payload).recordSnapshotHash!==p.recordSnapshotHash)throw Error('weekly_candidate_model_original_receipt_unverified');
 const operationId=revisionOperationId(r,p);
 const prior=await store.getById<Record_>(CANDIDATE_REVISED_ANALYSIS_OPERATIONS,operationId);if(prior){const p=obj(prior.payload);if(prior.record_hash!==socialRequestHash(prior.payload)||prior.tenant_id!==j.tenantId||p.jobId!==j.jobId||p.operationId!==operationId||p.revisionHash!==r.recordHash||p.candidateId!==input.candidateId)throw Error('weekly_candidate_model_revision_operation_changed');return {admitted:false as const,code:'weekly_candidate_model_revision_original_receipt_pending',operationId};}
 let parent:CandidateModelRevision|undefined;if(r.parentRevisionId){const parentRow=await store.getById<Record_>(CANDIDATE_MODEL_REVISIONS,r.parentRevisionId);if(!parentRow||parentRow.record_hash!==r.parentRevisionHash)throw Error('weekly_candidate_model_revision_chain_invalid');parent=verifiedRevision(parentRow,j);}
 if(socialRequestHash(p)!==socialRequestHash(await proof(store,j,input.candidateId,mediaRoot,parent)))throw Error('weekly_candidate_model_revision_evidence_changed');
 const payload={schema:'weekly-candidate-revised-analysis-operation.v1',operationId,tenantId:j.tenantId,jobId:j.jobId,candidateId:p.candidateId,revisionId:r.revisionId,revisionHash:r.recordHash,configurationHash:r.configurationHash,parentOperationId:p.parentOperationId,parentReceiptHash:p.parentReceiptHash,mediaSha256:p.mediaSha256,mediaFileId:p.mediaFileId,state:'submitted_or_unknown',analysisCostState:'retained_unknown',newCollectionRequests:0,newDownloads:0};
 if(!await store.create(CANDIDATE_REVISED_ANALYSIS_OPERATIONS,{id:operationId,tenant_id:j.tenantId,job_id:j.jobId,record_hash:socialRequestHash(payload),payload}))throw Error('weekly_candidate_model_revision_submit_unknown');return {admitted:true as const,operationId,payload};
}

export interface RevisedCandidatePorts {
 providerBinding?:ProviderBindingReader;
 modelPermission?:(configuration:CandidateModelConfiguration)=>Promise<'authorized'|'unauthorized'|'model_unavailable'|'unknown'>;
 scopeContinuity?:(configuration:CandidateModelConfiguration,configurationHash:string)=>Promise<boolean>;
 analyze?:(record:Record_,operationId:string,localMedia:string)=>Promise<void>;
 verify?:(record:Record_,mediaRoot:string)=>Promise<boolean>;
}
export async function verifyCandidateExactScopeContinuity(configuration:CandidateModelConfiguration,configurationHash:string):Promise<boolean>{
 try{return await withExactQwenScope({model:configuration.model,configurationHash,endpoint:configuration.endpoint,credentialDigest:configuration.credentialDigest},async()=>{
  const {readExactQwenScopeContinuity}=await import('../routes/videos.js'),observed=readExactQwenScopeContinuity();
  return !!observed&&observed.model===configuration.model&&observed.configurationHash===configurationHash&&observed.endpoint===configuration.endpoint&&observed.credentialDigest===configuration.credentialDigest;
 });}catch{return false;}
}
/** Read-only account capability preflight. Only an explicit model row carrying
 * INFERENCE permission admits a paid operation; transport/schema uncertainty
 * is not treated as authorization. */
export async function readQwenModelInferencePermission(configuration:CandidateModelConfiguration,request:typeof fetch=fetch):Promise<'authorized'|'unauthorized'|'model_unavailable'|'unknown'>{
 try{
  const endpoint=new URL(config(configuration).endpoint),origin=endpoint.origin;
  // Qianwen AI API pay-as-you-go keys do not use per-model permission rows.
  // A successful authenticated compatible catalogue containing the exact model
  // is its read-only admission proof. Never reinterpret an empty permissions
  // table from that platform as a denial.
  const endpointKind=classifyQwenCompatibleEndpoint(endpoint.toString());
  if(endpointKind==='qianwen-maas'){
   const url=new URL(endpoint.pathname.replace(/\/+$/,'')+'/models',origin),response=await request(url,{method:'GET',headers:{Authorization:`Bearer ${dashscopeApiKey()}`,Accept:'application/json'}});if(!response.ok)return 'unknown';
   const payload=await response.json() as Record<string,unknown>,rows=Array.isArray(payload.data)?payload.data.map(obj):[];if(!rows.length)return 'unknown';
   return rows.some(row=>String(row.id??row.model??row.model_name??'').trim()===configuration.model.trim())?'authorized':'model_unavailable';
  }
  if(endpointKind!=='dashscope-legacy')return 'unknown';
  const url=new URL('/api/v1/models/permissions',origin);url.searchParams.set('authorization_scope','AUTHORIZED');url.searchParams.set('action','INFERENCE');
  const response=await request(url,{method:'GET',headers:{Authorization:`Bearer ${dashscopeApiKey()}`,Accept:'application/json'}});if(!response.ok)return 'unknown';
  const payload=await response.json() as Record<string,unknown>,objects:Record<string,unknown>[]=[];let sawArray=false;
  const visit=(value:unknown)=>{if(Array.isArray(value)){sawArray=true;for(const item of value)visit(item);}else if(value&&typeof value==='object'){const row=value as Record<string,unknown>;objects.push(row);for(const item of Object.values(row))visit(item);}};visit(payload);
  const model=configuration.model.trim(),matching=objects.filter(row=>[row.id,row.model,row.modelId,row.model_id,row.modelName,row.model_name,row.name].some(value=>String(value??'').trim()===model));
  const permits=(row:Record<string,unknown>):boolean=>row.inference===true||String(row.action??'').toUpperCase()==='INFERENCE'||Object.entries(row).some(([key,value])=>
   /permission|action|authoriz/i.test(key)&&(Array.isArray(value)?value.some(item=>String(item).toUpperCase()==='INFERENCE'):value&&typeof value==='object'?permits(value as Record<string,unknown>):false));
  if(matching.some(permits))return 'authorized';
  if(Number(payload.total)===0||sawArray)return 'unauthorized';
  return 'unknown';
 }catch{return 'unknown';}
}
export async function executeExistingCandidateMedia(record:Record_,operationId:string,localMedia:string,sourceRunner?:typeof import('../routes/videos.js').analyzeSourceVideoJob,analysisAdapters:Omit<import('../routes/videos.js').SourceAnalysisAdapters,'download'|'compressPreview'>={}){
 const {analyzeSourceVideoJob}=await import('../routes/videos.js');
 const a=obj(record.aiAnalysis);
 // Reservation was already sealed before claiming a fresh analysis identity.
 if(!await routeStore.update('trend_videos',record.id,{aiAnalysis:JSON.stringify({...a,analysisRunId:operationId,requestedAnalysisMode:'exact'})}))throw Error('weekly_candidate_model_analysis_claim_unknown');
 const fresh=await routeStore.getById<Record_>('trend_videos',record.id);if(!fresh||fresh.tenantId!==record.tenantId)throw Error('weekly_candidate_model_candidate_scope_changed');
 let temporaryDirectory:string|undefined;
 try{await (sourceRunner??analyzeSourceVideoJob)({record:fresh,sourceUrl:String(record.sourceUrl),title:String(record.title??''),platform:record.platform as 'tiktok',suppressOpsRequeue:true,suppressVisibleBackfill:true,skipYoutubeUrlAnalysis:true},{...analysisAdapters,download:async()=>{
  // Existing pipeline owns temporary-file cleanup. Copy verified local bytes,
  // never hand it the durable original and never invoke a download provider.
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'weekly-revised-analysis-'));temporaryDirectory=directory;const filePath=path.join(directory,'reference.mp4');await fs.copyFile(localMedia,filePath);const stat=await fs.stat(filePath);
  return {filePath,fileName:'reference.mp4',mimeType:'video/mp4',size:stat.size};
 },compressPreview:async()=>{throw Error('weekly_scoped_analysis_uses_verified_local_media');}});}finally{if(temporaryDirectory)await fs.rm(temporaryDirectory,{recursive:true,force:true});}
}
/** Invoked only from the normal product consumer. A unique persisted human
 * revision is required; no env change can manufacture one. One new op per scan. */
export async function consumeCandidateModelRevision(store:DataStore,j:WeeklyPreproductionRetryAttempt,candidateIds:string[],mediaRoot:string,ports:RevisedCandidatePorts={}):Promise<{spentSlot:boolean;code:string|null}>{
 const rows=await store.list<Record_>(CANDIDATE_MODEL_REVISIONS,{where:{tenant_id:j.tenantId,job_id:j.jobId},perPage:200});if(!rows.totalItems)return {spentSlot:false,code:null};
 const r=revisionHead(rows.items,j);
 if(r.candidateProofs.some(p=>!candidateIds.includes(p.candidateId)))throw Error('weekly_candidate_model_revision_unapproved');
 await currentJob(store,j);sameTrustedProvider(r.configuration,ports.providerBinding??getQwenProviderBinding);
 const pending:string[]=[];let unknownCount=0;
 for(const p of r.candidateProofs){
  const operationId=revisionOperationId(r,p);
  const prior=await store.getById<Record_>(CANDIDATE_REVISED_ANALYSIS_OPERATIONS,operationId),receipt=await store.getById<Record_>(CANDIDATE_REVISED_ANALYSIS_RECEIPTS,operationId);
  let record=await store.getById<Record_>('trend_videos',p.candidateId);if(!record||record.tenantId!==j.tenantId||record.sourceUrl!==p.recordSnapshot.sourceUrl||record.videoFileId!==p.mediaFileId)throw Error('weekly_candidate_model_revision_evidence_changed');
  const file=path.resolve(mediaRoot,p.mediaFileId),bytes=await fs.readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==p.mediaSha256)throw Error('weekly_candidate_model_media_changed');
  if(prior){
   // Validates the original new-op seal without comparing changing analysis to
   // the old rejection snapshot. Unknown crashes are observed, never resubmitted.
   await reserveRevisedCandidateAnalysis(store,j,{revisionId:r.revisionId,candidateId:p.candidateId,configuration:r.configuration},mediaRoot,ports.providerBinding);
   if(receipt){const rp=obj(receipt.payload);if(receipt.record_hash!==socialRequestHash(receipt.payload)||rp.operationId!==operationId||rp.revisionHash!==r.recordHash)throw Error('weekly_candidate_model_revision_receipt_changed');if(rp.status==='completed')continue;const reason=String(rp.reason??'weekly_candidate_analysis_review_required');if(['model_unavailable','provider_authorization_required','provider_budget_exhausted'].includes(reason))return {spentSlot:true,code:reason};pending.push(reason);continue;}
   if(obj(record.aiAnalysis).analysisRunId===operationId&&await (ports.verify??verifiedWeeklyCandidateMedia)(record,mediaRoot)){
    await completion(store,j,r,p,operationId,record,'completed',null);continue;
   }
   unknownCount++;pending.push('weekly_candidate_model_revision_original_receipt_pending');continue;
  }
  if(unknownCount>=3)return {spentSlot:true,code:'weekly_candidate_model_revision_original_receipt_pending'};
  if(!await (ports.scopeContinuity??verifyCandidateExactScopeContinuity)(r.configuration,r.configurationHash))return {spentSlot:false,code:'weekly_candidate_model_scope_unavailable'};
  const permission=await (ports.modelPermission??readQwenModelInferencePermission)(r.configuration);
  if(permission!=='authorized')return {spentSlot:false,code:permission==='unauthorized'?'provider_authorization_required':permission==='model_unavailable'?'model_unavailable':'weekly_candidate_model_permission_unavailable'};
  const reserved=await reserveRevisedCandidateAnalysis(store,j,{revisionId:r.revisionId,candidateId:p.candidateId,configuration:r.configuration},mediaRoot,ports.providerBinding);if(!reserved.admitted)return {spentSlot:true,code:reserved.code};
  if(!ports.analyze&&store!==routeStore)throw Error('weekly_candidate_model_analysis_store_mismatch');
  let failure:string|null=null;
  try{await withExactQwenScope({model:r.configuration.model,configurationHash:r.configurationHash,endpoint:r.configuration.endpoint,credentialDigest:r.configuration.credentialDigest,onProviderReceipt:async receipt=>{
   const payload={schema:'weekly-candidate-model-provider-receipt.v1',tenantId:j.tenantId,jobId:j.jobId,candidateId:p.candidateId,operationId,revisionId:r.revisionId,revisionHash:r.recordHash,configurationHash:r.configurationHash,...receipt,costCny:null,costState:'retained_unknown'};
   const id=socialRequestHash(payload),prior=await store.getById<Record_>(CANDIDATE_MODEL_PROVIDER_RECEIPTS,id);if(prior){if(prior.record_hash!==socialRequestHash(payload))throw Error('weekly_candidate_model_provider_receipt_changed');return;}if(!await store.create(CANDIDATE_MODEL_PROVIDER_RECEIPTS,{id,tenant_id:j.tenantId,job_id:j.jobId,operation_id:operationId,record_hash:socialRequestHash(payload),payload}))throw Error('weekly_candidate_model_provider_receipt_write_unknown');
  }},()=> (ports.analyze??executeExistingCandidateMedia)(record!,operationId,file));}catch(error){const c=classifyDiscoverySourceFailure(error);if(c!=='source_failed')failure=c;else if(/(?:analysis_quality_retryable|chunk_quality_failed|timeline_quality_failed)/i.test(String(error))&&!/timeout|abort|socket|network/i.test(String(error)))failure='weekly_candidate_analysis_review_required';}
  record=await store.getById<Record_>('trend_videos',p.candidateId);if(!record||record.tenantId!==j.tenantId)throw Error('weekly_candidate_model_candidate_scope_changed');
  if(await (ports.verify??verifiedWeeklyCandidateMedia)(record,mediaRoot)){await completion(store,j,r,p,operationId,record,'completed',null);return {spentSlot:true,code:null};}
  const actual=obj(record.aiAnalysis),actualError=String(actual.analysisError??actual.downloadError??'');
  if(!failure&&actual.analysisRunId===operationId){const c=classifyDiscoverySourceFailure(actualError);if(c!=='source_failed')failure=c;else if(actual.analysisQuality==='video_review_required'||/analysis_quality_retryable|chunk_quality_failed|timeline_quality_failed|invalid.json|json.*invalid|clock.*(?:invalid|mismatch)/i.test(actualError)&&!/timeout|abort|socket|network/i.test(actualError))failure='weekly_candidate_analysis_review_required';}
  if(failure){await completion(store,j,r,p,operationId,record,'blocked',failure);return {spentSlot:true,code:failure};}
  return {spentSlot:true,code:'weekly_candidate_model_revision_original_receipt_pending'};
 }
 return {spentSlot:pending.length>0,code:pending[0]??null};
}
async function completion(store:DataStore,j:WeeklyPreproductionRetryAttempt,r:CandidateModelRevision,p:CandidateProof,operationId:string,record:Record_,status:'completed'|'blocked',reason:string|null){
 const payload={schema:'weekly-candidate-revised-analysis-receipt.v1',operationId,revisionId:r.revisionId,revisionHash:r.recordHash,jobId:j.jobId,candidateId:p.candidateId,parentReceiptHash:p.parentReceiptHash,configurationHash:r.configurationHash,recordSnapshotHash:socialRequestHash(record),mediaSha256:p.mediaSha256,status,reason,analysisCostState:'retained_unknown',createdAt:new Date().toISOString()};
 if(!await store.create(CANDIDATE_REVISED_ANALYSIS_RECEIPTS,{id:operationId,tenant_id:j.tenantId,job_id:j.jobId,record_hash:socialRequestHash(payload),payload}))throw Error('weekly_candidate_model_revision_receipt_write_unknown');
}
