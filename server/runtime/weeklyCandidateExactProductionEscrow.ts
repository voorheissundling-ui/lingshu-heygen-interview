import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {DataStore,Record_} from '../storage/datastore.js';
import type {SocialInspirationCollectionRun} from '../../shared/contracts/socialContentWorkflow.js';
import type {WeeklyOperatingPackage} from '../../shared/contracts/socialProgram.js';
import type {WeeklyPreproductionJob} from './weeklyPreproductionProducer.js';
import type {WeeklyPreproductionRetryAttempt} from './weeklyPreproductionRetryAttempts.js';
import {readWeeklyAutomationTemplate} from '../socialPrograms/weeklyAutomationTemplate.js';
import {readIndependentAdmission} from '../socialPrograms/weeklyIndependentAdmission.js';
import {socialRequestHash} from '../starter198/socialContentValidation.js';
import {weeklyCandidateExactJobBindingHash} from './weeklyCandidateExactFormalPorts.js';
import {weeklyCandidateExactRunBindingHash} from './weeklyCandidateExactRunBinding.js';
import {qwenVisionInputLimit} from '../lib/qwenVisionInputLimit.js';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import {verifyQwenMaaSPublishedPricingEvidence,verifyQwenMaaSPublishedPricingEvidenceForHistoricalSettlement,type MaaSPublishedPricingEvidence} from '../lib/socialContentPublishedTariffs.js';
import {weeklyCandidateExactMeasurementPolicyHash} from './weeklyCandidateExactRequestCeiling.js';
import type {WeeklyCandidateDynamicExactPlanV2} from './weeklyCandidateExactPaidRequests.js';

export const WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS='social_weekly_candidate_exact_production_escrows';
// qwen3-vl-plus can consume a one-million-token visual context. Two fully
// saturated child calls already reserve almost seven CNY; a third cannot fit
// inside the accepted ten-yuan mother-film envelope alongside production.
export const WEEKLY_EXACT_MAX_REQUESTS_PER_CANDIDATE=2 as const;
const inputCnyPerMillion=3,outputCnyPerMillion=30,maximumOutputTokens=16384;
const micros=(value:number)=>Math.ceil(value*1_000_000-1e-9);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const fail=(code:string):never=>{throw Error(`weekly_candidate_exact_production_escrow_${code}`);};
type Job=WeeklyPreproductionJob|WeeklyPreproductionRetryAttempt;

export interface WeeklyCandidateExactProductionEscrow {
 schema:'weekly-candidate-exact-production-escrow.v1';escrowId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 packageHash:string;templateAdoptionHash:string;independentAdmissionHash:string;jobId:string;jobHash:string;runId:string;runHash:string;
 model:'qwen3-vl-plus';endpoint:string;credentialSha256:string;tariffEvidenceHash:string;auditApiKeyId:string;
 weeklyProductionMaximumCny:number;perMotherIncludingRevisionsMaximumCny:10;maximumRequestsPerCandidate:2;
 maximumCnyPerCandidate:number;maximumCnyTotal:number;
 candidates:Array<{candidateId:string;mediaSha256:string;operationId:string}>;
 authorizesPublishing:false;authorizesAcceptance:false;authorizesCustomerMessages:false;createdAt:string;recordHash:string;
}
export type WeeklyCandidateExactProductionEscrowLedger={schema:'weekly-candidate-exact-production-escrow-ledger.v1';escrowHash:string;limitMicros:number;perMotherLimitMicros:number;entries:Record<string,{candidateId:string;mediaSha256:string;reservedMicros:number;state:'reserved'|'carried_forward';motherContentId:string|null;contentLedgerRef:string|null}>};
type Ledger=WeeklyCandidateExactProductionEscrowLedger;

function write(file:string,value:Ledger){const directory=path.dirname(file);fs.mkdirSync(directory,{recursive:true,mode:0o700});const temporary=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
function read(file:string,escrow:WeeklyCandidateExactProductionEscrow):Ledger{if(!fs.existsSync(file))return{schema:'weekly-candidate-exact-production-escrow-ledger.v1',escrowHash:escrow.recordHash,limitMicros:micros(escrow.weeklyProductionMaximumCny),perMotherLimitMicros:10_000_000,entries:{}};let value:Ledger;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('ledger_corrupt');}if(value.schema!=='weekly-candidate-exact-production-escrow-ledger.v1'||value.escrowHash!==escrow.recordHash||value.limitMicros!==micros(escrow.weeklyProductionMaximumCny)||value.perMotherLimitMicros!==10_000_000||!value.entries||Array.isArray(value.entries))fail('ledger_changed');let total=0;for(const [operationId,entry] of Object.entries(value.entries)){if(!operationId||!escrow.candidates.some(c=>c.operationId===operationId&&c.candidateId===entry.candidateId&&c.mediaSha256===entry.mediaSha256)||entry.reservedMicros!==micros(escrow.maximumCnyPerCandidate)||!['reserved','carried_forward'].includes(entry.state)||(entry.state==='reserved'&&(entry.motherContentId!==null||entry.contentLedgerRef!==null))||(entry.state==='carried_forward'&&(!entry.motherContentId||!entry.contentLedgerRef)))fail('ledger_corrupt');total+=entry.reservedMicros;}if(total>value.limitMicros)fail('weekly_limit_exceeded');return value;}
async function uniquePackage(store:DataStore,job:Job){const rows=await store.list<Record_>('social_weekly_operating_packages',{where:{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,version:job.packageVersion},perPage:2});if(rows.totalItems!==1||rows.items.length!==1)return fail('package_missing_or_ambiguous');const pkg=rows.items[0]!.payload as WeeklyOperatingPackage;if(pkg.packageId!==job.packageId||pkg.programId!==job.programId||pkg.version!==job.packageVersion||!['draft','active'].includes(pkg.status))fail('package_changed');return{row:rows.items[0]!,pkg};}

/**
 * Derive the pre-production hold from the already adopted weekly package.
 * This is not another user approval. Supplier audit evidence remains a
 * separate settlement requirement after the provider request.
 */
export async function prepareWeeklyCandidateExactProductionEscrow(input:{store:DataStore;job:Job;run:SocialInspirationCollectionRun;root:string;provider:{endpoint:string;credentialSha256:string;model:'qwen3-vl-plus';tariffEvidenceHash:string;auditApiKeyId:string};candidates:Array<{candidateId:string;mediaSha256:string;operationId:string}>;now?:()=>number}){
 const {job,run}=input,scope={tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion};
 if(!path.isAbsolute(input.root)||!job.authority||run.discoveryScopeId!==job.authority.scopeId||run.discoveryScopeVersion!==job.authority.scopeVersion||input.candidates.length!==5||new Set(input.candidates.map(c=>c.candidateId)).size!==5||new Set(input.candidates.map(c=>c.operationId)).size!==5||input.candidates.some(c=>!c.candidateId||!c.operationId||!/^[a-f0-9]{64}$/.test(c.mediaSha256)))fail('scope_invalid');
 if(input.provider.model!=='qwen3-vl-plus'||input.provider.endpoint!=='https://maas.qianwenaiapi.com/compatible-mode/v1'||!/^[a-f0-9]{64}$/.test(input.provider.credentialSha256)||!/^[a-f0-9]{64}$/.test(input.provider.tariffEvidenceHash)||!/^[A-Za-z0-9._:-]{1,128}$/.test(input.provider.auditApiKeyId))fail('provider_evidence_invalid');
 const [{row,pkg},adoption,independent]=await Promise.all([uniquePackage(input.store,job),readWeeklyAutomationTemplate(input.store,scope),readIndependentAdmission(input.store,scope)]);
 if(!adoption||!independent||adoption.actorUserId!==independent.actorUserId||adoption.template.perFinishedVideoMaxCny!==10||pkg.socialContentPackage.perItemBudgetCny!==10||!Number.isFinite(pkg.socialContentPackage.weeklyBudgetCny)||pkg.socialContentPackage.weeklyBudgetCny!<=0)fail('weekly_authority_required');
 const maximumCnyPerCandidate=micros(WEEKLY_EXACT_MAX_REQUESTS_PER_CANDIDATE*(qwenVisionInputLimit('qwen3-vl-plus')*inputCnyPerMillion+maximumOutputTokens*outputCnyPerMillion)/1_000_000)/1_000_000;
 if(maximumCnyPerCandidate>10)return fail('per_mother_limit_exceeded');const maximumCnyTotal=maximumCnyPerCandidate*5;if(maximumCnyTotal>pkg.socialContentPackage.weeklyBudgetCny!)return fail('weekly_limit_exceeded');
 const body={schema:'weekly-candidate-exact-production-escrow.v1' as const,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion,packageHash:socialRequestHash(row.payload),templateAdoptionHash:socialRequestHash(adoption),independentAdmissionHash:socialRequestHash(independent),jobId:job.jobId,jobHash:weeklyCandidateExactJobBindingHash(job),runId:run.runId,runHash:weeklyCandidateExactRunBindingHash(run),model:input.provider.model,endpoint:input.provider.endpoint,credentialSha256:input.provider.credentialSha256,tariffEvidenceHash:input.provider.tariffEvidenceHash,auditApiKeyId:input.provider.auditApiKeyId,weeklyProductionMaximumCny:pkg.socialContentPackage.weeklyBudgetCny!,perMotherIncludingRevisionsMaximumCny:10 as const,maximumRequestsPerCandidate:WEEKLY_EXACT_MAX_REQUESTS_PER_CANDIDATE,maximumCnyPerCandidate,maximumCnyTotal,candidates:[...input.candidates].sort((a,b)=>a.candidateId.localeCompare(b.candidateId)),authorizesPublishing:false as const,authorizesAcceptance:false as const,authorizesCustomerMessages:false as const,createdAt:new Date((input.now??Date.now)()).toISOString()};
 const escrowId=socialRequestHash({...body,createdAt:''}).slice(0,24),item:WeeklyCandidateExactProductionEscrow={...body,escrowId,recordHash:''};item.recordHash=socialRequestHash({...item,recordHash:''});
 const assertCurrent=async(escrow:WeeklyCandidateExactProductionEscrow)=>{const [current,currentAdoption,currentIndependent]=await Promise.all([uniquePackage(input.store,job),readWeeklyAutomationTemplate(input.store,scope),readIndependentAdmission(input.store,scope)]),saved=await input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,escrow.escrowId);if(!saved||saved.tenant_id!==job.tenantId||saved.record_hash!==escrow.recordHash||socialRequestHash(saved.payload)!==socialRequestHash(escrow)||socialRequestHash(current.row.payload)!==escrow.packageHash||!currentAdoption||socialRequestHash(currentAdoption)!==escrow.templateAdoptionHash||!currentIndependent||socialRequestHash(currentIndependent)!==escrow.independentAdmissionHash||weeklyCandidateExactJobBindingHash(job)!==escrow.jobHash||weeklyCandidateExactRunBindingHash(run)!==escrow.runHash)fail('authority_changed');};
 const prior=await input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,escrowId);if(prior){const existing=prior.payload as WeeklyCandidateExactProductionEscrow;if(prior.tenant_id!==job.tenantId||prior.record_hash!==existing.recordHash||existing.recordHash!==socialRequestHash({...existing,recordHash:''})||socialRequestHash({...existing,createdAt:'',recordHash:''})!==socialRequestHash({...item,createdAt:'',recordHash:''}))fail('record_changed');return createEscrowHandle(input.root,existing,()=>assertCurrent(existing));}
 if(!await input.store.create(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,{id:escrowId,tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,job_id:job.jobId,run_id:run.runId,record_hash:item.recordHash,payload:item}))fail('record_write_unknown');
 return createEscrowHandle(input.root,item,()=>assertCurrent(item));
}
export function openWeeklyCandidateExactProductionEscrow(root:string,escrow:WeeklyCandidateExactProductionEscrow,assertCurrent:()=>Promise<void>){
 if(!path.isAbsolute(root)||escrow.recordHash!==socialRequestHash({...escrow,recordHash:''}))fail('record_changed');
 return createEscrowHandle(root,escrow,assertCurrent);
}
function createEscrowHandle(root:string,escrow:WeeklyCandidateExactProductionEscrow,assertCurrent:()=>Promise<void>){const absolute=path.resolve(root),file=path.join(absolute,sha(JSON.stringify([escrow.tenantId,escrow.programId,escrow.packageId,escrow.packageVersion]))+'.json'),lock=path.join(absolute,'.locks');return{escrow,assertCurrent,async reserve(candidateId:string,mediaSha256:string,operationId:string){return withPaidOperationLock(lock,`weekly-exact-production-escrow:${escrow.packageId}:${escrow.packageVersion}`,async()=>{await assertCurrent();const candidate=escrow.candidates.find(c=>c.candidateId===candidateId&&c.mediaSha256===mediaSha256&&c.operationId===operationId);if(!candidate)fail('candidate_changed');const ledger=read(file,escrow),prior=ledger.entries[operationId];if(!prior){const amount=micros(escrow.maximumCnyPerCandidate);if(Object.values(ledger.entries).reduce((sum,e)=>sum+e.reservedMicros,0)+amount>ledger.limitMicros)fail('weekly_limit_exceeded');ledger.entries[operationId]={candidateId,mediaSha256,reservedMicros:amount,state:'reserved',motherContentId:null,contentLedgerRef:null};write(file,ledger);}return{authorizationId:escrow.escrowId,authorizationHash:escrow.recordHash,maximumRequests:escrow.maximumRequestsPerCandidate,maximumCny:escrow.maximumCnyPerCandidate};});},readOnlyStatus(){return structuredClone(read(file,escrow));},async carryForward(input:{candidateId:string;mediaSha256:string;operationId:string;motherContentId:string;contentLedgerRef:string}){return withPaidOperationLock(lock,`weekly-exact-production-escrow:${escrow.packageId}:${escrow.packageVersion}`,async()=>{await assertCurrent();if(!input.motherContentId||!/^social-task-budget:[a-f0-9]{64}$/.test(input.contentLedgerRef))fail('carry_forward_binding_invalid');const candidate=escrow.candidates.find(c=>c.candidateId===input.candidateId&&c.mediaSha256===input.mediaSha256&&c.operationId===input.operationId);if(!candidate)fail('candidate_changed');const ledger=read(file,escrow),entry=ledger.entries[input.operationId];if(!entry)fail('reservation_missing');if(entry.state==='carried_forward'){if(entry.motherContentId!==input.motherContentId||entry.contentLedgerRef!==input.contentLedgerRef)fail('carry_forward_changed');return structuredClone(ledger);}entry.state='carried_forward';entry.motherContentId=input.motherContentId;entry.contentLedgerRef=input.contentLedgerRef;await assertCurrent();write(file,ledger);return structuredClone(ledger);});},async status(){return withPaidOperationLock(lock,`weekly-exact-production-escrow:${escrow.packageId}:${escrow.packageVersion}`,async()=>structuredClone(read(file,escrow)));}};}

export const WEEKLY_EXACT_V2_PROTOCOL_MAXIMUM_REQUESTS=32 as const;
export interface WeeklyCandidateExactProductionEscrowV2{
 schema:'weekly-candidate-exact-production-escrow.v2';escrowId:string;tenantId:string;programId:string;packageId:string;packageVersion:number;
 packageHash:string;templateAdoptionHash:string;independentAdmissionHash:string;jobId:string;jobHash:string;runId:string;runHash:string;
 model:'qwen3-vl-plus';endpoint:string;credentialSha256:string;auditApiKeyId:string;ledgerIntegrityKeySha256:string;pricingEvidence:MaaSPublishedPricingEvidence;
 pricingEvidenceHash:string;pricingPolicyHash:string;measurementPolicyHash:string;
 weeklyProductionMaximumMicros:number;perMotherIncludingRevisionsMaximumMicros:10_000_000;
 candidateMaximumMicros:10_000_000;weeklyExactMaximumMicros:50_000_000;protocolMaximumRequests:32;
 supersedesEscrowId:null;supersedesEscrowHash:null;
 candidates:Array<{candidateId:string;mediaSha256:string;operationId:string}>;
 authorizesPublishing:false;authorizesAcceptance:false;authorizesCustomerMessages:false;authorizesProviderExecution:false;
 createdAt:string;recordHash:string;
}
export type WeeklyCandidateExactProductionEscrowLedgerV2={
 schema:'weekly-candidate-exact-production-escrow-ledger.v2';escrowId:string;escrowHash:string;
 weeklyExactMaximumMicros:50_000_000;perMotherLimitMicros:10_000_000;
 entries:Record<string,{candidateId:string;mediaSha256:string;reservedMicros:10_000_000;state:'reserved'|'carried_forward';
  motherContentId:string|null;contentLedgerRef:string|null;settlementRecordHash:string|null;retainedOccupationMicros:number|null}>;
};
const failV2=(code:string):never=>{throw Error(`weekly_candidate_exact_production_escrow_v2_${code}`);};
export const weeklyCandidateExactProductionEscrowV2LedgerPath=(root:string,escrow:WeeklyCandidateExactProductionEscrowV2)=>
 path.join(path.resolve(root),sha(JSON.stringify(['weekly-candidate-exact-production-escrow-ledger.v2',escrow.escrowId,escrow.recordHash]))+'.json');
function writeV2(file:string,value:WeeklyCandidateExactProductionEscrowLedgerV2){
 const directory=path.dirname(file);fs.mkdirSync(directory,{recursive:true,mode:0o700});const temporary=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(temporary,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);
 const dir=fs.openSync(directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function readV2(file:string,escrow:WeeklyCandidateExactProductionEscrowV2):WeeklyCandidateExactProductionEscrowLedgerV2{
 if(!fs.existsSync(file))return{schema:'weekly-candidate-exact-production-escrow-ledger.v2',escrowId:escrow.escrowId,escrowHash:escrow.recordHash,
  weeklyExactMaximumMicros:50_000_000,perMotherLimitMicros:10_000_000,entries:{}};
 let value:WeeklyCandidateExactProductionEscrowLedgerV2;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return failV2('ledger_corrupt');}
 if(value.schema!=='weekly-candidate-exact-production-escrow-ledger.v2'||value.escrowId!==escrow.escrowId||value.escrowHash!==escrow.recordHash||
  value.weeklyExactMaximumMicros!==escrow.weeklyExactMaximumMicros||value.perMotherLimitMicros!==escrow.candidateMaximumMicros||
  !value.entries||Array.isArray(value.entries))failV2('ledger_changed');
 let total=0;for(const [operationId,entry] of Object.entries(value.entries)){
  const reservedMarker=entry.state==='reserved'&&entry.motherContentId===null&&entry.contentLedgerRef===null&&entry.settlementRecordHash===null&&entry.retainedOccupationMicros===null;
  const carriedMarker=entry.state==='carried_forward'&&typeof entry.motherContentId==='string'&&entry.motherContentId.length>0&&
   typeof entry.contentLedgerRef==='string'&&/^social-task-budget:[a-f0-9]{64}$/.test(entry.contentLedgerRef)&&
   typeof entry.settlementRecordHash==='string'&&/^[a-f0-9]{64}$/.test(entry.settlementRecordHash)&&
   Number.isSafeInteger(entry.retainedOccupationMicros)&&entry.retainedOccupationMicros!>0&&entry.retainedOccupationMicros!<=entry.reservedMicros;
  if((!reservedMarker&&!carriedMarker)||entry.reservedMicros!==10_000_000||!escrow.candidates.some(candidate=>candidate.operationId===operationId&&
   candidate.candidateId===entry.candidateId&&candidate.mediaSha256===entry.mediaSha256))failV2('ledger_corrupt');
  total+=entry.reservedMicros;
 }
 if(total>escrow.weeklyExactMaximumMicros)failV2('weekly_limit_exceeded');return value;
}
function verifyEscrowV2Pricing(escrow:WeeklyCandidateExactProductionEscrowV2){
 if(escrow.pricingEvidenceHash!==sha(JSON.stringify(escrow.pricingEvidence))||escrow.measurementPolicyHash!==weeklyCandidateExactMeasurementPolicyHash())
  failV2('pricing_evidence_changed');
 const policy=verifyQwenMaaSPublishedPricingEvidence(escrow.pricingEvidence,{baseUrl:escrow.endpoint,credentialSha256:escrow.credentialSha256});
 if(!policy||policy.verificationHash!==escrow.pricingPolicyHash)failV2('pricing_evidence_unverified');return policy;
}
function verifyEscrowV2HistoricalPricing(escrow:WeeklyCandidateExactProductionEscrowV2){
 if(escrow.pricingEvidenceHash!==sha(JSON.stringify(escrow.pricingEvidence))||escrow.measurementPolicyHash!==weeklyCandidateExactMeasurementPolicyHash())
  failV2('pricing_evidence_changed');
 const historical=verifyQwenMaaSPublishedPricingEvidenceForHistoricalSettlement(escrow.pricingEvidence,
  {baseUrl:escrow.endpoint,credentialSha256:escrow.credentialSha256});
 if(!historical||historical.evidenceHash!==escrow.pricingEvidenceHash||historical.pricingPolicyHash!==escrow.pricingPolicyHash)
  failV2('pricing_evidence_unverified');
}
function createEscrowV2Handle(root:string,escrow:WeeklyCandidateExactProductionEscrowV2,assertCurrent:()=>Promise<void>){
 const file=weeklyCandidateExactProductionEscrowV2LedgerPath(root,escrow),lock=path.join(path.resolve(root),'.locks');
 return {escrow,ledgerPath:file,assertCurrent,pricingPolicy:()=>verifyEscrowV2Pricing(escrow),
  async reserve(candidateId:string,mediaSha256:string,operationId:string){return withPaidOperationLock(lock,
   `weekly-exact-production-escrow-v2:${escrow.escrowId}:${escrow.recordHash}`,async()=>{
    await assertCurrent();verifyEscrowV2Pricing(escrow);const candidate=escrow.candidates.find(item=>item.candidateId===candidateId&&item.mediaSha256===mediaSha256&&item.operationId===operationId);
    if(!candidate)failV2('candidate_changed');const ledger=readV2(file,escrow);if(!ledger.entries[operationId]){
     if(Object.values(ledger.entries).reduce((sum,item)=>sum+item.reservedMicros,0)+escrow.candidateMaximumMicros>escrow.weeklyExactMaximumMicros)
      failV2('weekly_limit_exceeded');
     ledger.entries[operationId]={candidateId,mediaSha256,reservedMicros:10_000_000,state:'reserved',motherContentId:null,
      contentLedgerRef:null,settlementRecordHash:null,retainedOccupationMicros:null};writeV2(file,ledger);
    }
    return {authorizationId:escrow.escrowId,authorizationHash:escrow.recordHash,candidateMaximumMicros:escrow.candidateMaximumMicros,
     protocolMaximumRequests:escrow.protocolMaximumRequests,pricingEvidence:structuredClone(escrow.pricingEvidence),
     pricingEvidenceHash:escrow.pricingEvidenceHash,pricingPolicyHash:escrow.pricingPolicyHash,measurementPolicyHash:escrow.measurementPolicyHash,
     ledgerIntegrityKeySha256:escrow.ledgerIntegrityKeySha256};
   });},
  async assertReservedPlan(plan:WeeklyCandidateDynamicExactPlanV2,authorizationHash:string){return withPaidOperationLock(lock,
   `weekly-exact-production-escrow-v2:${escrow.escrowId}:${escrow.recordHash}`,async()=>{
    await assertCurrent();verifyEscrowV2Pricing(escrow);
    if(authorizationHash!==escrow.recordHash||plan.schema!=='weekly-candidate-dynamic-exact-plan.v2'||plan.model!==escrow.model||
     plan.endpoint!==escrow.endpoint||plan.credentialSha256!==escrow.credentialSha256||plan.ledgerIntegrityKeySha256!==escrow.ledgerIntegrityKeySha256||
     plan.pricingEvidenceHash!==escrow.pricingEvidenceHash||plan.pricingPolicyHash!==escrow.pricingPolicyHash||
     plan.measurementPolicyHash!==escrow.measurementPolicyHash||plan.protocolMaximumRequests!==escrow.protocolMaximumRequests||
     plan.candidateMaximumMicros!==escrow.candidateMaximumMicros||JSON.stringify(plan.pricingEvidence)!==JSON.stringify(escrow.pricingEvidence))
     failV2('authorized_plan_changed');
    const candidate=escrow.candidates.find(item=>item.operationId===plan.operationId&&item.candidateId===plan.candidateId&&item.mediaSha256===plan.mediaSha256);
    if(!candidate)failV2('authorized_plan_candidate_changed');
    const entry=readV2(file,escrow).entries[plan.operationId];
    if(!entry||entry.state!=='reserved'||entry.reservedMicros!==escrow.candidateMaximumMicros||entry.candidateId!==plan.candidateId||entry.mediaSha256!==plan.mediaSha256)
     failV2('authorized_plan_reservation_missing');
   });},
  async assertReservedPlanForSettlement(plan:WeeklyCandidateDynamicExactPlanV2,authorizationHash:string){return withPaidOperationLock(lock,
   `weekly-exact-production-escrow-v2:${escrow.escrowId}:${escrow.recordHash}`,async()=>{
    await assertCurrent();verifyEscrowV2HistoricalPricing(escrow);
    if(authorizationHash!==escrow.recordHash||plan.schema!=='weekly-candidate-dynamic-exact-plan.v2'||plan.model!==escrow.model||
     plan.endpoint!==escrow.endpoint||plan.credentialSha256!==escrow.credentialSha256||plan.ledgerIntegrityKeySha256!==escrow.ledgerIntegrityKeySha256||
     plan.pricingEvidenceHash!==escrow.pricingEvidenceHash||plan.pricingPolicyHash!==escrow.pricingPolicyHash||
     plan.measurementPolicyHash!==escrow.measurementPolicyHash||plan.protocolMaximumRequests!==escrow.protocolMaximumRequests||
     plan.candidateMaximumMicros!==escrow.candidateMaximumMicros||JSON.stringify(plan.pricingEvidence)!==JSON.stringify(escrow.pricingEvidence))
     failV2('authorized_plan_changed');
    const candidate=escrow.candidates.find(item=>item.operationId===plan.operationId&&item.candidateId===plan.candidateId&&item.mediaSha256===plan.mediaSha256);
    if(!candidate)failV2('authorized_plan_candidate_changed');
    const entry=readV2(file,escrow).entries[plan.operationId];
    if(!entry||entry.reservedMicros!==escrow.candidateMaximumMicros||entry.candidateId!==plan.candidateId||entry.mediaSha256!==plan.mediaSha256)
     failV2('authorized_plan_reservation_missing');
    return {authorizationId:escrow.escrowId,authorizationHash:escrow.recordHash,auditApiKeyId:escrow.auditApiKeyId};
   });},
  async markCarriedForward(input:{candidateId:string;mediaSha256:string;operationId:string;motherContentId:string;contentLedgerRef:string;
   settlementRecordHash:string;retainedOccupationMicros:number}){return withPaidOperationLock(lock,
   `weekly-exact-production-escrow-v2:${escrow.escrowId}:${escrow.recordHash}`,async()=>{
    await assertCurrent();verifyEscrowV2HistoricalPricing(escrow);
    if(!input.motherContentId||!/^social-task-budget:[a-f0-9]{64}$/.test(input.contentLedgerRef)||
     !/^[a-f0-9]{64}$/.test(input.settlementRecordHash)||!Number.isSafeInteger(input.retainedOccupationMicros)||input.retainedOccupationMicros<=0)
     failV2('carry_forward_binding_invalid');
    const candidate=escrow.candidates.find(item=>item.operationId===input.operationId&&item.candidateId===input.candidateId&&item.mediaSha256===input.mediaSha256);
    if(!candidate)failV2('candidate_changed');
    const ledger=readV2(file,escrow),entry=ledger.entries[input.operationId];if(!entry)failV2('reservation_missing');
    if(input.retainedOccupationMicros>entry.reservedMicros)failV2('carry_forward_amount_invalid');
    if(entry.state==='carried_forward'){
     if(entry.motherContentId!==input.motherContentId||entry.contentLedgerRef!==input.contentLedgerRef||
      entry.settlementRecordHash!==input.settlementRecordHash||entry.retainedOccupationMicros!==input.retainedOccupationMicros)
      failV2('carry_forward_changed');
     return structuredClone(ledger);
    }
    entry.state='carried_forward';entry.motherContentId=input.motherContentId;entry.contentLedgerRef=input.contentLedgerRef;
    entry.settlementRecordHash=input.settlementRecordHash;entry.retainedOccupationMicros=input.retainedOccupationMicros;
    await assertCurrent();verifyEscrowV2HistoricalPricing(escrow);writeV2(file,ledger);return structuredClone(ledger);
   });},
  readOnlyStatus(){return structuredClone(readV2(file,escrow));},
 };
}

export function openWeeklyCandidateExactProductionEscrowV2(root:string,escrow:WeeklyCandidateExactProductionEscrowV2,assertCurrent:()=>Promise<void>){
 if(!path.isAbsolute(root)||escrow.schema!=='weekly-candidate-exact-production-escrow.v2'||escrow.recordHash!==socialRequestHash({...escrow,recordHash:''}))
  failV2('record_changed');
 verifyEscrowV2HistoricalPricing(escrow);return createEscrowV2Handle(root,escrow,assertCurrent);
}

/** Dormant v2 authority. It can reserve the already accepted mother ceiling;
 * later settlement/carry remains explicit and is not composed into production. */
export async function prepareWeeklyCandidateExactProductionEscrowV2(input:{
 store:DataStore;job:Job;run:SocialInspirationCollectionRun;root:string;
 provider:{endpoint:string;credentialSha256:string;auditApiKeyId:string;model:'qwen3-vl-plus';pricingEvidence:MaaSPublishedPricingEvidence};
 ledgerIntegrityKeySha256:string;candidates:Array<{candidateId:string;mediaSha256:string;operationId:string}>;now?:()=>number;
}){
 const {job,run}=input,scope={tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,packageVersion:job.packageVersion};
 if(!path.isAbsolute(input.root)||!/^[a-f0-9]{64}$/.test(input.ledgerIntegrityKeySha256)||input.ledgerIntegrityKeySha256===input.provider.credentialSha256||
  !/^[A-Za-z0-9._:-]{1,128}$/.test(input.provider.auditApiKeyId)||
  !job.authority||run.discoveryScopeId!==job.authority.scopeId||run.discoveryScopeVersion!==job.authority.scopeVersion||
  input.candidates.length!==5||new Set(input.candidates.map(item=>item.candidateId)).size!==5||new Set(input.candidates.map(item=>item.operationId)).size!==5||
  input.candidates.some(item=>!item.candidateId||!item.operationId||!/^([a-f0-9]{64})$/.test(item.mediaSha256)))failV2('scope_invalid');
 const policy=verifyQwenMaaSPublishedPricingEvidence(input.provider.pricingEvidence,{baseUrl:input.provider.endpoint,credentialSha256:input.provider.credentialSha256});
 if(!policy)failV2('pricing_evidence_unverified');
 if(input.provider.model!=='qwen3-vl-plus')failV2('pricing_evidence_unverified');
 const [{row,pkg},adoption,independent,existing]=await Promise.all([uniquePackage(input.store,job),readWeeklyAutomationTemplate(input.store,scope),
  readIndependentAdmission(input.store,scope),input.store.list<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,
   {where:{tenant_id:job.tenantId,program_id:job.programId,package_id:job.packageId,package_version:job.packageVersion,job_id:job.jobId,run_id:run.runId},perPage:3})]);
 if(!adoption||!independent||adoption.actorUserId!==independent.actorUserId||adoption.template.perFinishedVideoMaxCny!==10||
  pkg.socialContentPackage.perItemBudgetCny!==10||!Number.isFinite(pkg.socialContentPackage.weeklyBudgetCny)||pkg.socialContentPackage.weeklyBudgetCny!<50)
  failV2('weekly_authority_required');
 if(existing.totalItems>1||existing.items.length>1)failV2('record_ambiguous');
 if(existing.items.some(item=>(item.payload as {schema?:unknown})?.schema==='weekly-candidate-exact-production-escrow.v1'))failV2('legacy_v1_exists');
 const pricingEvidence=structuredClone(input.provider.pricingEvidence),pricingEvidenceHash=sha(JSON.stringify(pricingEvidence));
 const body={schema:'weekly-candidate-exact-production-escrow.v2' as const,tenantId:job.tenantId,programId:job.programId,packageId:job.packageId,
  packageVersion:job.packageVersion,packageHash:socialRequestHash(row.payload),templateAdoptionHash:socialRequestHash(adoption),
  independentAdmissionHash:socialRequestHash(independent),jobId:job.jobId,jobHash:weeklyCandidateExactJobBindingHash(job),runId:run.runId,
  runHash:weeklyCandidateExactRunBindingHash(run),model:input.provider.model,endpoint:input.provider.endpoint,
  credentialSha256:input.provider.credentialSha256,auditApiKeyId:input.provider.auditApiKeyId,ledgerIntegrityKeySha256:input.ledgerIntegrityKeySha256,
  pricingEvidence,pricingEvidenceHash,pricingPolicyHash:policy!.verificationHash,
  measurementPolicyHash:weeklyCandidateExactMeasurementPolicyHash(),weeklyProductionMaximumMicros:micros(pkg.socialContentPackage.weeklyBudgetCny!),
  perMotherIncludingRevisionsMaximumMicros:10_000_000 as const,candidateMaximumMicros:10_000_000 as const,
  weeklyExactMaximumMicros:50_000_000 as const,protocolMaximumRequests:WEEKLY_EXACT_V2_PROTOCOL_MAXIMUM_REQUESTS,
  supersedesEscrowId:null,supersedesEscrowHash:null,candidates:[...input.candidates].sort((left,right)=>left.candidateId.localeCompare(right.candidateId)),
  authorizesPublishing:false as const,authorizesAcceptance:false as const,authorizesCustomerMessages:false as const,
  authorizesProviderExecution:false as const,createdAt:new Date((input.now??Date.now)()).toISOString()};
 const escrowId=socialRequestHash({...body,createdAt:''}).slice(0,24),item:WeeklyCandidateExactProductionEscrowV2={...body,escrowId,recordHash:''};
 item.recordHash=socialRequestHash({...item,recordHash:''});
 const assertCurrent=async(escrow:WeeklyCandidateExactProductionEscrowV2)=>{
  const [current,currentAdoption,currentIndependent,saved]=await Promise.all([uniquePackage(input.store,job),readWeeklyAutomationTemplate(input.store,scope),
   readIndependentAdmission(input.store,scope),input.store.getById<Record_>(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,escrow.escrowId)]);
  if(!saved||saved.record_hash!==escrow.recordHash||socialRequestHash(saved.payload)!==socialRequestHash(escrow)||socialRequestHash(current.row.payload)!==escrow.packageHash||
   !currentAdoption||socialRequestHash(currentAdoption)!==escrow.templateAdoptionHash||!currentIndependent||socialRequestHash(currentIndependent)!==escrow.independentAdmissionHash||
   weeklyCandidateExactJobBindingHash(job)!==escrow.jobHash||weeklyCandidateExactRunBindingHash(run)!==escrow.runHash)failV2('authority_changed');
 };
 const prior=existing.items[0];
 if(prior){const saved=prior.payload as WeeklyCandidateExactProductionEscrowV2;if(saved.schema!=='weekly-candidate-exact-production-escrow.v2'||prior.id!==escrowId||
  prior.record_hash!==saved.recordHash||saved.recordHash!==socialRequestHash({...saved,recordHash:''})||
  socialRequestHash({...saved,createdAt:'',recordHash:''})!==socialRequestHash({...item,createdAt:'',recordHash:''}))failV2('record_changed');
  return createEscrowV2Handle(input.root,saved,()=>assertCurrent(saved));}
 if(!await input.store.create(WEEKLY_CANDIDATE_EXACT_PRODUCTION_ESCROWS,{id:escrowId,tenant_id:job.tenantId,program_id:job.programId,
  package_id:job.packageId,package_version:job.packageVersion,job_id:job.jobId,run_id:run.runId,record_hash:item.recordHash,payload:item}))
  failV2('record_write_unknown');
 return createEscrowV2Handle(input.root,item,()=>assertCurrent(item));
}
