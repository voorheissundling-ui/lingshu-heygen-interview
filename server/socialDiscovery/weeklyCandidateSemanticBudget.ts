import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyPreproductionJob} from '../runtime/weeklyPreproductionProducer.js';
import type {CandidateContextAssessment} from './candidateContextAssessment.js';
import type {MaterialAnalysisPaidCall} from '../digitalEmployees/materialAnalysisPaidOperation.js';
import type {PaidOperationSubmission} from '../lib/socialContentPaidOperationPermit.js';
import type {SocialPaidOperationIntent,SocialVerifiedAccountTariff} from '../lib/socialContentTaskBudgetAuthority.js';
import {quoteSocialPaidOperationTariff} from '../lib/socialContentTaskBudgetAuthority.js';
import {createSocialContentVerifiedTariffReader} from '../lib/socialContentVerifiedTariffs.js';
import {createQwenMaaSPublishedTariffReader} from '../lib/socialContentPublishedTariffs.js';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import {readWeeklyReviewActor} from '../socialPrograms/weeklyReviewEvidence.js';
import {socialObject,socialJson,socialRequestHash} from '../starter198/socialContentValidation.js';
import {verifiedWeeklyCandidateMedia} from '../runtime/weeklyCandidateReassessment.js';
import {readWeeklyCandidateAdmissionSnapshot} from '../runtime/weeklyCandidateAdmissionSnapshot.js';
import {readCandidateContextAssessment} from './candidateContextAssessment.js';
import {getQwenProviderBinding} from '../agents/qwen.js';
import {readQwenMaaSVisionCatalog} from '../lib/qwenMaaSModelCatalog.js';
import {measureCandidateSemanticInputUpperBound,QWEN3_VL_SEMANTIC_MAX_INPUT_TOKENS} from './candidateSemanticBudgetResolver.js';

export const WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS='social_weekly_candidate_semantic_budget_authorizations';
export const WEEKLY_CANDIDATE_SEMANTIC_BUDGET_REVOCATIONS='social_weekly_candidate_semantic_budget_revocations';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const fail=(reason:string):never=>{throw Error(`weekly_candidate_semantic_budget_${reason}`);};
const object=(v:unknown)=>socialObject(socialJson(v))??{};
const validMoney=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0&&Number.isSafeInteger(Math.round(n*1e6))&&Math.abs(Math.round(n*1e6)/1e6-n)<1e-9;
const micros=(n:number)=>Math.round(n*1e6);
/** A reviewed public MaaS ceiling is admissible only for its exact endpoint,
 * credential fingerprint and model. An account tariff takes precedence. */
export async function readWeeklyCandidateSemanticTariff(store:DataStore,tenantId:string,binding:{baseUrl:string;credentialSha256:string;materialModel:string},intent:SocialPaidOperationIntent){
 const durable=await createSocialContentVerifiedTariffReader(store,tenantId).read(intent);
 if(durable)return durable;
 return createQwenMaaSPublishedTariffReader({readProviderBinding:async()=>({provider:'qwen',model:binding.materialModel,baseUrl:binding.baseUrl,credentialSha256:binding.credentialSha256})}).read(intent);
}

/** A separate, explicit weekly authorization. It is not inherited from the
 * collection allowance or any publication task's production allowance. */
export interface WeeklyCandidateSemanticBudgetAuthorization {
 schema:'weekly-candidate-semantic-budget-authorization.v1';authorizationId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 jobId:string;jobHash:string;runId:string;runHash:string;scopeId:string;scopeVersion:number;scopeHash:string;
 provider:{accountRef:string;model:string;catalogEvidenceRef:string};
 approvedBy:string;approvedAt:string;expiresAt:string;status:'approved';totalLimitCny:number;
 candidates:Array<{candidateId:string;contextAssessmentId:string;contextHash:string;mediaSha256:string;perCandidateLimitCny:number}>;
 recordHash:string;
}
export interface WeeklyCandidateSemanticBudgetPorts {
 binding?:()=>{baseUrl:string;credentialSha256:string;materialModel:string};
 readTariff?:(intent:SocialPaidOperationIntent)=>Promise<SocialVerifiedAccountTariff|null>;
 ledgerRoot?:string;
 measureInputTokens?:(body:Record<string,unknown>)=>Promise<number>;
 now?:()=>number;
 readModelCatalog?:typeof readQwenMaaSVisionCatalog;
}
interface Entry {operationId:string;candidateId:string;contextHash:string;intentHash:string;quoteRef:string;reservedMicros:number;status:'reserved'|'unknown'|'completed';requestHash:string|null;receiptRef:string|null;}
interface Ledger {schema:1;authorizationId:string;authorizationHash:string;tenantId:string;programId:string;packageId:string;packageVersion:number;limitMicros:number;entries:Record<string,Entry>;}
function ledgerFile(root:string,a:WeeklyCandidateSemanticBudgetAuthorization){return path.join(root,sha(JSON.stringify([a.tenantId,a.programId,a.packageId,a.packageVersion]))+'.json');}
function readLedger(file:string,a:WeeklyCandidateSemanticBudgetAuthorization):Ledger|null{
 if(!fs.existsSync(file))return null;
 let l:Ledger;try{l=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('ledger_corrupt');}
 if(l.schema!==1||l.authorizationId!==a.authorizationId||l.authorizationHash!==a.recordHash||l.tenantId!==a.tenantId||l.programId!==a.programId||l.packageId!==a.packageId||l.packageVersion!==a.packageVersion||l.limitMicros!==micros(a.totalLimitCny)||!l.entries||typeof l.entries!=='object'||Array.isArray(l.entries))fail('ledger_changed');
 for(const [id,e] of Object.entries(l.entries))if(id!==sha(e.operationId)||!a.candidates.some(c=>c.candidateId===e.candidateId&&c.contextHash===e.contextHash)||!Number.isSafeInteger(e.reservedMicros)||e.reservedMicros<=0||!['reserved','unknown','completed'].includes(e.status)||!/^[a-f0-9]{64}$/.test(e.intentHash)||typeof e.quoteRef!=='string'||!e.quoteRef||e.status!=='reserved'&&!/^[a-f0-9]{64}$/.test(String(e.requestHash)))fail('ledger_corrupt');
 const total=Object.values(l.entries).reduce((n,e)=>n+e.reservedMicros,0);if(!Number.isSafeInteger(total)||total>l.limitMicros)fail('ledger_corrupt');
 return l;
}
function writeLedger(root:string,file:string,l:Ledger){
 fs.mkdirSync(root,{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(l));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
const approvalId=(scope:{tenantId:string;programId:string;packageId:string;packageVersion:number})=>sha(JSON.stringify([scope.tenantId,scope.programId,scope.packageId,scope.packageVersion,'candidate-semantic-v1'])).slice(0,15);
const revocationId=(authorizationId:string)=>sha(JSON.stringify([authorizationId,'revoked'])).slice(0,15);
async function approvedActor(store:DataStore,tenantId:string,userId:string){const actor=await readWeeklyReviewActor(store,tenantId,userId);if(!actor||actor.tenantId!==tenantId||actor.active===false||actor.disabled===true||['disabled','suspended'].includes(String(actor.status))||!['admin','super_admin','social_operator'].includes(String(actor.role)))fail('approval_actor_invalid');}
/** Sign only after the authenticated actor supplies explicit CNY ceilings and
 * every candidate, source byte, current scope, and account tariff is verified.
 * Neither collection nor production grants this authorization implicitly. */
export async function issueWeeklyCandidateSemanticBudgetAuthorization(input:{store:DataStore;tenantId:string;actorUserId:string;programId:string;packageId:string;packageVersion:number;jobId:string;runId:string;candidateLimits:Array<{candidateId:string;contextAssessmentId:string;perCandidateLimitCny:number}>;totalLimitCny:number;expiresAt:string;mediaRoot:string;now?:()=>number}){
 const {store}=input,now=input.now??Date.now;
 await approvedActor(store,input.tenantId,input.actorUserId);
 if(!Number.isSafeInteger(input.packageVersion)||input.packageVersion<1||!validMoney(input.totalLimitCny)||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=now()||Date.parse(input.expiresAt)>now()+31*86400000||!Array.isArray(input.candidateLimits)||input.candidateLimits.length<1||input.candidateLimits.length>5||new Set(input.candidateLimits.map(c=>c.candidateId)).size!==input.candidateLimits.length||input.candidateLimits.some(c=>!c.candidateId||!c.contextAssessmentId||!validMoney(c.perCandidateLimitCny)||c.perCandidateLimitCny>input.totalLimitCny))fail('approval_input_invalid');
 const pkgRow=await original(store,'social_weekly_operating_packages',{tenant_id:input.tenantId,program_id:input.programId,package_id:input.packageId,version:input.packageVersion}),pkg=object(pkgRow.payload);
 if(pkg.packageId!==input.packageId||pkg.version!==input.packageVersion||!['draft','active'].includes(String(pkg.status)))fail('package_changed');
 const jobRow=(await store.getById<Record_>('social_weekly_preproduction_jobs',input.jobId))??await store.getById<Record_>('social_weekly_preproduction_retry_attempts',input.jobId),job=jobRow?.payload as WeeklyPreproductionJob|undefined;
 if(!job||jobRow?.record_hash!==job.recordHash||job.recordHash!==socialRequestHash({...job,recordHash:''})||job.tenantId!==input.tenantId||job.programId!==input.programId||job.packageId!==input.packageId||job.packageVersion!==input.packageVersion||job.kind!=='discovery'||!job.authority)throw Error('weekly_candidate_semantic_budget_job_changed');
 const run=await original<SocialInspirationCollectionRun>(store,'social_discovery_runs',{tenant_id:input.tenantId,runId:input.runId});
 if(run.discoveryScopeId!==job.authority.scopeId||run.discoveryScopeVersion!==job.authority.scopeVersion||!['succeeded','partial','stopped'].includes(run.status))fail('run_changed');
 const scope=await store.getById<Record_>('social_discovery_scopes',job.authority.scopeId);
 if(!scope||scope.tenant_id!==input.tenantId||scope.version!==job.authority.scopeVersion||socialRequestHash(scope.payload)!==job.authority.scopeHash||scope.status==='retired')fail('scope_changed');
 const admitted=await readWeeklyCandidateAdmissionSnapshot({store,job,run,mediaRoot:input.mediaRoot});
 const binding=getQwenProviderBinding();if(!/^[a-f0-9]{64}$/.test(binding.credentialSha256)||!/^https:\/\//.test(binding.baseUrl)||!/^(qwen3-vl-(?:flash|plus)|qwen-vl-max)(?:-\d{4}-\d{2}-\d{2})?$/.test(binding.materialModel))fail('provider_binding_invalid');
 const catalog=await readQwenMaaSVisionCatalog({endpoint:binding.baseUrl,credentialSha256:binding.credentialSha256,model:binding.materialModel});if(!catalog)throw Error('weekly_candidate_semantic_budget_provider_model_unverified');
 const accountRef=`qwen:${sha(JSON.stringify({baseUrl:binding.baseUrl.replace(/\/+$/,''),credentialSha256:binding.credentialSha256}))}`;
 const candidates:WeeklyCandidateSemanticBudgetAuthorization['candidates']=[];let quotedMicros=0;
 for(const proposed of input.candidateLimits){
  if(!admitted.some(c=>c.candidateId===proposed.candidateId&&c.evidenceRef))fail('candidate_not_admitted');
  const video=await store.getById<Record_>('trend_videos',proposed.candidateId);if(!video||video.tenantId!==input.tenantId||!await verifiedWeeklyCandidateMedia(video,input.mediaRoot))throw Error('weekly_candidate_semantic_budget_original_media_changed');
  const context=await readCandidateContextAssessment(store,input.tenantId,proposed.candidateId,{programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion},video);
  if(!context||context.assessmentId!==proposed.contextAssessmentId||context.keyword.scopeId!==job.authority.scopeId||context.keyword.scopeVersion!==job.authority.scopeVersion||context.canonical.mediaSha256!==object(object(object(video.aiAnalysis).gemini).sourceMediaClock).sourceSha256)throw Error('weekly_candidate_semantic_budget_context_changed');
  const intent:SocialPaidOperationIntent={operationId:`candidate-semantic:${context.assessmentId}`,provider:'qwen',model:binding.materialModel,accountRef,stage:'candidate_context_semantic',shotId:null,inputContractHash:context.recordHash,maximumUnits:{inputTokens:binding.materialModel.startsWith('qwen-vl-max')?129024:QWEN3_VL_SEMANTIC_MAX_INPUT_TOKENS,outputTokens:1600}};
  const quote=quoteSocialPaidOperationTariff(intent,await readWeeklyCandidateSemanticTariff(store,input.tenantId,binding,intent));if(micros(quote.upperBoundCny)>micros(proposed.perCandidateLimitCny))fail('candidate_limit_exceeded');quotedMicros+=micros(quote.upperBoundCny);
  candidates.push({candidateId:proposed.candidateId,contextAssessmentId:context.assessmentId,contextHash:context.recordHash,mediaSha256:context.canonical.mediaSha256,perCandidateLimitCny:proposed.perCandidateLimitCny});
 }
 if(quotedMicros>micros(input.totalLimitCny))fail('weekly_limit_exceeded');
 const authorizationId=approvalId(input),existing=await store.getById<Record_>(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS,authorizationId);if(existing)fail('authorization_already_exists');
 const item:WeeklyCandidateSemanticBudgetAuthorization={schema:'weekly-candidate-semantic-budget-authorization.v1',authorizationId,tenantId:input.tenantId,programId:input.programId,packageId:input.packageId,packageVersion:input.packageVersion,jobId:job.jobId,jobHash:job.recordHash,runId:run.runId,runHash:socialRequestHash(run),scopeId:job.authority.scopeId,scopeVersion:job.authority.scopeVersion,scopeHash:job.authority.scopeHash,provider:{accountRef,model:binding.materialModel,catalogEvidenceRef:catalog.evidenceRef},approvedBy:input.actorUserId,approvedAt:new Date(now()).toISOString(),expiresAt:input.expiresAt,status:'approved',totalLimitCny:input.totalLimitCny,candidates,recordHash:''};item.recordHash=socialRequestHash({...item,recordHash:''});
 if(!await store.create(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS,{id:authorizationId,tenant_id:item.tenantId,program_id:item.programId,package_id:item.packageId,package_version:item.packageVersion,status:'approved',record_hash:item.recordHash,payload:item}))fail('authorization_write_unknown');
 return item;
}
export async function revokeWeeklyCandidateSemanticBudgetAuthorization(input:{store:DataStore;tenantId:string;actorUserId:string;authorizationId:string;reason:string;now?:()=>number}){
 const {store}=input;await approvedActor(store,input.tenantId,input.actorUserId);
 const auth=await store.getById<Record_>(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS,input.authorizationId),a=auth?.payload as WeeklyCandidateSemanticBudgetAuthorization|undefined;
 if(!a||auth?.tenant_id!==input.tenantId||auth.record_hash!==a.recordHash||a.recordHash!==socialRequestHash({...a,recordHash:''})||a.status!=='approved'||!input.reason?.trim()||input.reason.length>1000)throw Error('weekly_candidate_semantic_budget_revocation_scope_invalid');
 const id=revocationId(a.authorizationId),item={schema:'weekly-candidate-semantic-budget-revocation.v1',revocationId:id,authorizationId:a.authorizationId,authorizationHash:a.recordHash,tenantId:a.tenantId,revokedBy:input.actorUserId,revokedAt:new Date((input.now??Date.now)()).toISOString(),reason:input.reason.trim()};
 const old=await store.getById<Record_>(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_REVOCATIONS,id);if(old)return old.payload;
 if(!await store.create(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_REVOCATIONS,{id,tenant_id:a.tenantId,authorization_id:a.authorizationId,record_hash:socialRequestHash(item),payload:item}))fail('revocation_write_unknown');return item;
}
/** Exact weekly shared-volume reservation. All five candidate operations
 * contend on the same lock and ledger, including after worker restart. */
export async function reserveWeeklyCandidateSemanticCharge(input:{root:string;authorization:WeeklyCandidateSemanticBudgetAuthorization;candidateId:string;contextHash:string;intentHash:string;operationId:string;quoteRef:string;quotedCny:number;assertCurrent:()=>Promise<void>}){
 const {authorization:a,candidateId,contextHash,intentHash,operationId,quoteRef,quotedCny,assertCurrent}=input;
 const candidate=a.candidates.find(c=>c.candidateId===candidateId&&c.contextHash===contextHash);
 if(!candidate||!validMoney(quotedCny)||micros(quotedCny)>micros(candidate.perCandidateLimitCny)||!validMoney(a.totalLimitCny))fail('candidate_limit_exceeded');
 const root=path.resolve(input.root),file=ledgerFile(root,a),key=JSON.stringify([a.tenantId,a.programId,a.packageId,a.packageVersion]),entryId=sha(operationId),reservedMicros=micros(quotedCny);
 await withPaidOperationLock(path.join(root,'.locks'),key,async()=>{
  await assertCurrent();const l=readLedger(file,a)??{schema:1 as const,authorizationId:a.authorizationId,authorizationHash:a.recordHash,tenantId:a.tenantId,programId:a.programId,packageId:a.packageId,packageVersion:a.packageVersion,limitMicros:micros(a.totalLimitCny),entries:{}};
  const prior=l.entries[entryId];if(prior){if(prior.operationId!==operationId||prior.candidateId!==candidateId||prior.contextHash!==contextHash||prior.intentHash!==intentHash||prior.reservedMicros!==reservedMicros||prior.quoteRef!==quoteRef||prior.status!=='reserved')fail('original_operation_recovery_required');return;}
  if(Object.values(l.entries).reduce((n,e)=>n+e.reservedMicros,0)+reservedMicros>l.limitMicros)fail('weekly_limit_exceeded');
  l.entries[entryId]={operationId,candidateId,contextHash,intentHash,quoteRef,reservedMicros,status:'reserved',requestHash:null,receiptRef:null};await assertCurrent();writeLedger(root,file,l);
 });
 return {root,file,key,entryId};
}
async function original<T=Record_>(store:DataStore,collection:string,where:Record<string,string|number>){const rows=await store.list<T&Record_>(collection,{where,perPage:2});if(rows.totalItems!==1||rows.items.length!==1)return fail('lineage_missing_or_ambiguous');return rows.items[0]!;}

/** No authorization record means no operation and no provider POST. Every
 * reservation and submission re-reads the exact original bytes and scope. */
export async function resolveWeeklyCandidateSemanticPaidCall(input:{store:DataStore;job:WeeklyPreproductionJob;run:SocialInspirationCollectionRun;candidateId:string;context:CandidateContextAssessment;mediaRoot:string;ports?:WeeklyCandidateSemanticBudgetPorts}):Promise<MaterialAnalysisPaidCall>{
 const {store,job,run,candidateId,context,mediaRoot}=input,ports=input.ports??{},now=ports.now??Date.now;
 const authorityRow=await original(store,WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS,{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,status:'approved'});
 const a=authorityRow.payload as WeeklyCandidateSemanticBudgetAuthorization;
 const assertCurrent=async()=>{
  if(!a||a.schema!=='weekly-candidate-semantic-budget-authorization.v1'||a.status!=='approved'||!/^[a-zA-Z0-9_]{15}$/.test(a.authorizationId)||authorityRow.id!==a.authorizationId||authorityRow.record_hash!==a.recordHash||a.recordHash!==socialRequestHash({...a,recordHash:''})||authorityRow.tenant_id!==a.tenantId||authorityRow.program_id!==a.programId||authorityRow.package_id!==a.packageId||authorityRow.package_version!==a.packageVersion||authorityRow.status!==a.status||a.tenantId!==job.tenantId||a.programId!==job.programId||a.packageId!==job.packageId||a.packageVersion!==job.packageVersion||a.jobId!==job.jobId||a.jobHash!==job.recordHash||a.runId!==run.runId||a.runHash!==socialRequestHash(run)||a.scopeId!==job.authority?.scopeId||a.scopeVersion!==job.authority.scopeVersion||a.scopeHash!==job.authority.scopeHash||!a.provider?.accountRef||!a.provider.model||!a.provider.catalogEvidenceRef||!validMoney(a.totalLimitCny)||!Number.isFinite(Date.parse(a.approvedAt))||Date.parse(a.approvedAt)>now()||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<=now())fail('authorization_invalid_or_changed');
  if(!Array.isArray(a.candidates)||a.candidates.length<1||a.candidates.length>5||new Set(a.candidates.map(c=>c.candidateId)).size!==a.candidates.length||a.candidates.some(c=>!c.candidateId||!c.contextAssessmentId||!/^[a-f0-9]{64}$/.test(c.contextHash)||!/^[a-f0-9]{64}$/.test(c.mediaSha256)||!validMoney(c.perCandidateLimitCny)||c.perCandidateLimitCny>a.totalLimitCny))fail('candidate_policy_invalid');
  const candidate=a.candidates.find(c=>c.candidateId===candidateId);if(!candidate)throw Error('weekly_candidate_semantic_budget_candidate_scope_changed');
  if(candidate.contextAssessmentId!==context.assessmentId||candidate.contextHash!==context.recordHash||candidate.mediaSha256!==context.canonical.mediaSha256||context.tenantId!==a.tenantId||context.candidateId!==candidateId||context.programId!==a.programId||context.packageId!==a.packageId||context.packageVersion!==a.packageVersion||context.keyword.scopeId!==a.scopeId||context.keyword.scopeVersion!==a.scopeVersion)fail('candidate_scope_changed');
  const actor=await readWeeklyReviewActor(store,a.tenantId,a.approvedBy);if(!actor||actor.tenantId!==a.tenantId||actor.active===false||actor.disabled===true||['disabled','suspended'].includes(String(actor.status))||!['admin','super_admin','social_operator'].includes(String(actor.role)))fail('approval_actor_invalid');
  const freshAuth=await store.getById<Record_>(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_AUTHORIZATIONS,a.authorizationId);if(!freshAuth||freshAuth.record_hash!==a.recordHash||freshAuth.status!=='approved')fail('authorization_changed');
  const revoked=await store.getById<Record_>(WEEKLY_CANDIDATE_SEMANTIC_BUDGET_REVOCATIONS,revocationId(a.authorizationId));if(revoked)fail('authorization_revoked');
  const jobRow=(await store.getById<Record_>('social_weekly_preproduction_jobs',a.jobId))??(await store.getById<Record_>('social_weekly_preproduction_retry_attempts',a.jobId));if(!jobRow||jobRow.record_hash!==a.jobHash||socialRequestHash(jobRow.payload)!==socialRequestHash(job))fail('job_changed');
  const scope=await store.getById<Record_>('social_discovery_scopes',a.scopeId);if(!scope||scope.tenant_id!==a.tenantId||scope.version!==a.scopeVersion||socialRequestHash(scope.payload)!==a.scopeHash||socialRequestHash(scope)!==context.keyword.scopeHash||scope.status==='retired')fail('discovery_scope_changed');
  const packageRow=await original(store,'social_weekly_operating_packages',{tenant_id:a.tenantId,program_id:a.programId,package_id:a.packageId,version:a.packageVersion});const pkg=object(packageRow.payload);if(pkg.packageId!==a.packageId||pkg.version!==a.packageVersion||!['draft','active'].includes(String(pkg.status)))fail('package_changed');
  const runRow=await original<SocialInspirationCollectionRun>(store,'social_discovery_runs',{tenant_id:a.tenantId,runId:a.runId});if(socialRequestHash(runRow)!==a.runHash||socialRequestHash(runRow)!==socialRequestHash(run)||runRow.discoveryScopeId!==a.scopeId||runRow.discoveryScopeVersion!==a.scopeVersion)fail('run_changed');
  const admitted=await readWeeklyCandidateAdmissionSnapshot({store,job,run,mediaRoot});if(!admitted.some(item=>item.candidateId===candidateId&&item.evidenceRef))fail('candidate_not_admitted');
  const contextRow=await store.getById<Record_>('social_candidate_context_assessments',context.assessmentId);if(!contextRow||contextRow.tenant_id!==a.tenantId||contextRow.record_hash!==context.recordHash||socialRequestHash(contextRow.payload)!==socialRequestHash(context)||context.recordHash!==socialRequestHash({...context,recordHash:''}))fail('context_changed');
  const video=await store.getById<Record_>('trend_videos',candidateId),analysis=object(video?.aiAnalysis),gemini=object(analysis.gemini),clock=object(gemini.sourceMediaClock);if(!video||video.tenantId!==a.tenantId||analysis.analysisRunId!==context.canonical.analysisRunId||clock.sourceSha256!==candidate.mediaSha256||!await verifiedWeeklyCandidateMedia(video,mediaRoot))fail('original_media_changed');
  const origins=(Array.isArray(analysis.discoveryOrigins)?analysis.discoveryOrigins:[]).map(object).filter(o=>o.runId===a.runId&&o.scopeId===a.scopeId&&o.scopeVersion===a.scopeVersion);if(origins.length!==1)fail('origin_changed');
  return candidate;
 };
 const candidate=await assertCurrent(),binding=ports.binding?.()??getQwenProviderBinding();if(!/^[a-f0-9]{64}$/.test(binding.credentialSha256)||!/^https:\/\//.test(binding.baseUrl)||!/^(qwen3-vl-(?:flash|plus)|qwen-vl-max)(?:-\d{4}-\d{2}-\d{2})?$/.test(binding.materialModel))fail('provider_binding_invalid');
 const assertBinding=()=>{const current=ports.binding?.()??getQwenProviderBinding();if(current.baseUrl!==binding.baseUrl||current.credentialSha256!==binding.credentialSha256||current.materialModel!==binding.materialModel)fail('provider_binding_changed');};
 const accountRef=`qwen:${sha(JSON.stringify({baseUrl:binding.baseUrl.replace(/\/+$/,''),credentialSha256:binding.credentialSha256}))}`,operationId=`candidate-semantic:${context.assessmentId}`;
 if(accountRef!==a.provider.accountRef||binding.materialModel!==a.provider.model)fail('provider_binding_changed');
 const assertCatalog=async()=>{const proof=await (ports.readModelCatalog??readQwenMaaSVisionCatalog)({endpoint:binding.baseUrl,credentialSha256:binding.credentialSha256,model:binding.materialModel});if(!proof||proof.evidenceRef!==a.provider.catalogEvidenceRef)fail('provider_model_unverified');};
 await assertCatalog();
 const intent:SocialPaidOperationIntent={operationId,provider:'qwen',model:binding.materialModel,accountRef,stage:'candidate_context_semantic',shotId:null,inputContractHash:context.recordHash,maximumUnits:{inputTokens:binding.materialModel.startsWith('qwen-vl-max')?129024:QWEN3_VL_SEMANTIC_MAX_INPUT_TOKENS,outputTokens:1600}};
 const readTariff=()=>ports.readTariff?ports.readTariff(intent):readWeeklyCandidateSemanticTariff(store,a.tenantId,binding,intent);
 const tariff=await readTariff(),quote=quoteSocialPaidOperationTariff(intent,tariff),reservedMicros=micros(quote.upperBoundCny);if(reservedMicros<=0||reservedMicros>micros(candidate.perCandidateLimitCny))fail('candidate_limit_exceeded');
 const root=path.resolve(ports.ledgerRoot??process.env.WEEKLY_CANDIDATE_SEMANTIC_BUDGET_DIR??'data/weekly-candidate-semantic-budget'),intentHash=socialRequestHash(intent);
 const reserved=await reserveWeeklyCandidateSemanticCharge({root,authorization:a,candidateId,contextHash:context.recordHash,intentHash,operationId,quoteRef:quote.quoteRef,quotedCny:quote.upperBoundCny,assertCurrent:async()=>{await assertCurrent();assertBinding();}});
 const {file,entryId,key:lockKey}=reserved;
 const permit={
  async isProvenUnsubmitted(id:string){return withPaidOperationLock(path.join(root,'.locks'),lockKey,async()=>{
   const l=readLedger(file,a),e=l?.entries[entryId];if(!e)throw Error('weekly_candidate_semantic_budget_recovery_binding_changed');if(id!==operationId||e.operationId!==operationId||e.intentHash!==intentHash||l?.authorizationHash!==a.recordHash)fail('recovery_binding_changed');
   return e.status==='reserved'&&e.requestHash===null;
  });},
  async assertRecovery(id:string){return withPaidOperationLock(path.join(root,'.locks'),lockKey,async()=>{
   const l=readLedger(file,a),e=l?.entries[entryId];if(!e)throw Error('weekly_candidate_semantic_budget_recovery_original_claim_missing');if(id!==operationId||e.operationId!==operationId||e.intentHash!==intentHash||l?.authorizationHash!==a.recordHash||e.status==='reserved'||!e.requestHash)fail('recovery_original_claim_missing');
   return {operationId,status:e.status,requestHash:e.requestHash,receiptRef:e.receiptRef};
  });},
  async beforeSubmit(request:PaidOperationSubmission){return withPaidOperationLock(path.join(root,'.locks'),lockKey,async()=>{
   await assertCurrent();assertBinding();await assertCatalog();const latestQuote=quoteSocialPaidOperationTariff(intent,await readTariff());
   if(Date.parse(quote.validUntil)<=now()||latestQuote.quoteRef!==quote.quoteRef||micros(latestQuote.upperBoundCny)!==reservedMicros)fail('quote_changed_or_expired');
   const l=readLedger(file,a),e=l?.entries[entryId];if(!e)throw Error('weekly_candidate_semantic_budget_reservation_missing_or_uncertain');
   if(e.status!=='reserved'||e.intentHash!==intentHash||e.candidateId!==candidateId||e.contextHash!==context.recordHash)fail('reservation_missing_or_uncertain');
   if(request.operationId!==operationId||request.provider!==intent.provider||request.model!==intent.model||request.accountRef!==intent.accountRef||request.stage!==intent.stage||request.shotId!==null||request.inputContractHash!==context.recordHash||Object.keys(request.actualUnits).sort().join(',')!=='inputTokens,outputTokens'||!Number.isSafeInteger(request.actualUnits.inputTokens)||request.actualUnits.inputTokens!<=0||request.actualUnits.inputTokens!>intent.maximumUnits.inputTokens||!Number.isSafeInteger(request.actualUnits.outputTokens)||request.actualUnits.outputTokens!<=0||request.actualUnits.outputTokens!>intent.maximumUnits.outputTokens)fail('request_binding_changed');
   // The claim is durable before a network POST. An interruption remains an
   // unknown charge and cannot mint a second provider submission.
   e.status='unknown';e.requestHash=socialRequestHash(request);writeLedger(root,file,l!);return {operationId};
  });},
  async markOutcome(id:string,status:'accepted'|'unknown'|'completed',receiptRef:string){return withPaidOperationLock(path.join(root,'.locks'),lockKey,async()=>{
   const l=readLedger(file,a),e=l?.entries[entryId];if(!e||e.intentHash!==intentHash||l?.authorizationHash!==a.recordHash)throw Error('weekly_candidate_semantic_budget_outcome_conflict');
   if(id!==operationId||e.status==='reserved'||!e.requestHash||typeof receiptRef!=='string'||!receiptRef||e.status==='completed'&&(status!=='completed'||e.receiptRef!==receiptRef))fail('outcome_conflict');
   e.status=status==='completed'?'completed':'unknown';e.receiptRef=receiptRef;writeLedger(root,file,l!);
  });}
 };
 return {requirementKey:operationId,intent,permit,measureInputTokens:ports.measureInputTokens??measureCandidateSemanticInputUpperBound,persistProviderReceipt:async({requestSha256,response})=>{
  if(!/^[a-f0-9]{64}$/.test(requestSha256)||response===undefined)fail('provider_receipt_invalid');return `weekly-candidate-semantic-receipt:${operationId}:${requestSha256}`;
 }};
}
