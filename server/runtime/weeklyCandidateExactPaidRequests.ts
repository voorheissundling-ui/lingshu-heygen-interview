import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import {withExactQwenScope,type ExactQwenProviderReceipt} from '../agents/exactQwenScope.js';
import {inspectWeeklyExactSupplierEnvelopes,type WeeklyExactSupplierEnvelopeInput} from './weeklyCandidateExactProviderEnvelope.js';
import {classifyQwenCompatibleEndpoint} from '../lib/qwenCompatibleEndpoint.js';
import {qwenVisionInputLimit} from '../lib/qwenVisionInputLimit.js';
import {verifyQwenMaaSPublishedPricingEvidence,type MaaSPublishedPricingEvidence} from '../lib/socialContentPublishedTariffs.js';
import {measureWeeklyCandidateExactRequestCeiling,weeklyCandidateExactMeasurementPolicyHash,type WeeklyExactRequestCeiling} from './weeklyCandidateExactRequestCeiling.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const hash=/^[a-f0-9]{64}$/;
const micros=(value:number)=>Math.round(value*1_000_000);
const fail=(code:string):never=>{throw Error(`weekly_candidate_exact_paid_${code}`);};
type Plan=Omit<WeeklyExactSupplierEnvelopeInput,'responses'>;
type Entry={state:'unknown'|'completed';response?:ExactQwenProviderReceipt};
type Ledger={schema:'weekly-candidate-exact-paid-requests.v1';authorizationHash:string;planHash:string;entries:Record<string,Entry>};

function validPlan(plan:Plan,authorizationHash:string){
 if(!hash.test(authorizationHash)||!plan.operationId||!plan.candidateId||!hash.test(plan.mediaSha256)||!hash.test(plan.credentialSha256)||
  !Number.isSafeInteger(micros(plan.maximumTotalCny))||micros(plan.maximumTotalCny)<=0||!plan.requests.length||plan.requests.length>128||
  new Set(plan.requests.map(r=>r.requestHash)).size!==plan.requests.length)fail('plan_invalid');
 // Use the same authoritative model, endpoint, token and tariff validation as
 // final settlement. Empty responses are not a success; only ignore that one
 // count diagnostic while retaining all remaining structural checks below.
 const sample:WeeklyExactSupplierEnvelopeInput={...plan,responses:plan.requests.map((r,i)=>({requestHash:r.requestHash,response:{provider:'qwen',responseId:`plan-${i}`,model:plan.model,usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0},httpStatus:200,requestModel:plan.model,requestHash:r.requestHash,receivedAt:new Date(0).toISOString()}}))};
 inspectWeeklyExactSupplierEnvelopes(sample);
}
function read(file:string,authorizationHash:string,planHash:string):Ledger{
 if(!fs.existsSync(file))return {schema:'weekly-candidate-exact-paid-requests.v1',authorizationHash,planHash,entries:{}};
 let ledger:Ledger;try{ledger=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('ledger_corrupt');}
 if(ledger.schema!=='weekly-candidate-exact-paid-requests.v1'||ledger.authorizationHash!==authorizationHash||ledger.planHash!==planHash||!ledger.entries||typeof ledger.entries!=='object'||Array.isArray(ledger.entries))fail('ledger_changed');
 for(const [key,entry] of Object.entries(ledger.entries))if(!hash.test(key)||!entry||!['unknown','completed'].includes(entry.state)||entry.response&&entry.response.requestHash!==key)fail('ledger_corrupt');
 return ledger;
}
function write(file:string,ledger:Ledger|DynamicLedger|DynamicLedgerV2){
 const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});const tmp=`${file}.${randomUUID()}.tmp`,fd=fs.openSync(tmp,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify(ledger));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 fs.renameSync(tmp,file);const dirfd=fs.openSync(dir,'r');try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
}

/** One immutable, separately human-approved exact-analysis plan. Its entire
 * worst-case charge is checked before the first child POST. Each child claim
 * is fsynced before network transport; restart/timeout can read only, never
 * reissue an unknown request (the compatible chat endpoint has no GET result). */
export function createWeeklyCandidateExactPaidRequests(input:{root:string;authorizationHash:string;plan:Plan;assertCurrent:()=>Promise<void>}){
 const {plan,authorizationHash}=input;validPlan(plan,authorizationHash);
 const planHash=sha(JSON.stringify(plan)),root=path.resolve(input.root),file=path.join(root,sha(JSON.stringify([plan.operationId,authorizationHash]))+'.json');
 const plans=new Map(plan.requests.map(r=>[r.requestHash,r]));
 const exclusive=<T>(body:()=>Promise<T>)=>withPaidOperationLock(path.join(root,'.locks'),`weekly-exact:${plan.operationId}:${authorizationHash}`,body);
 return {
  async beforeProviderRequest(requestBody:string){
   const requestHash=sha(requestBody),child=plans.get(requestHash);
   if(!child)throw Error('weekly_candidate_exact_paid_request_not_frozen');
   let body:Record<string,unknown>;try{body=JSON.parse(requestBody);}catch{return fail('request_unreadable');}
   if(body.model!==plan.model||body.max_tokens!==child.maximumOutputTokens)fail('request_changed');
   await exclusive(async()=>{
    await input.assertCurrent();const ledger=read(file,authorizationHash,planHash);
    if(Object.keys(ledger.entries).some(key=>!plans.has(key)))fail('ledger_corrupt');
    if(ledger.entries[requestHash])fail('original_request_recovery_required');
    if(Object.values(ledger.entries).some(entry=>entry.state!=='completed'))fail('earlier_request_unsettled');
    ledger.entries[requestHash]={state:'unknown'};write(file,ledger);
   });
  },
  async onProviderReceipt(response:ExactQwenProviderReceipt){
   await exclusive(async()=>{
    const ledger=read(file,authorizationHash,planHash),entry=ledger.entries[response.requestHash];
    if(!entry||entry.response)fail('receipt_without_original_claim');
    // Persist even non-200 and malformed usage as unknown, not as an invented
    // zero-cost settlement. Subsequent children are not automatically released.
    entry.response=response;
    if(response.httpStatus===200){
     try{inspectWeeklyExactSupplierEnvelopes({...plan,maximumTotalCny:(plans.get(response.requestHash)!.maximumInputTokens*3+plans.get(response.requestHash)!.maximumOutputTokens*30)/1_000_000,
       requests:[plans.get(response.requestHash)!],responses:[{requestHash:response.requestHash,response}]});entry.state='completed';}catch{/* remain unknown */}
    }
    write(file,ledger);
   });
  },
  async readSettlement(){return exclusive(async()=>{
   const ledger=read(file,authorizationHash,planHash),responses=plan.requests.map(r=>ledger.entries[r.requestHash]);
   if(Object.keys(ledger.entries).some(key=>!plans.has(key))||responses.some(e=>e?.state!=='completed'||!e.response))return null;
   const original=plan.requests.map((r,i)=>({requestHash:r.requestHash,response:responses[i]!.response!}));
   return {...inspectWeeklyExactSupplierEnvelopes({...plan,responses:original}),authorizationHash,planHash,ledgerHash:sha(JSON.stringify(ledger))};
  });},
  async readClaim(requestHash:string){return exclusive(async()=>{if(!plans.has(requestHash))fail('request_not_frozen');return read(file,authorizationHash,planHash).entries[requestHash]??null;});}
 };
}

/** Explicit formal entrypoint. The older human model-revision scope is not
 * altered, while a new weekly exact executor cannot omit its paid guard. */
export async function withWeeklyCandidateExactPaidScope<T>(input:{root:string;authorizationHash:string;plan:Plan;configurationHash:string;assertCurrent:()=>Promise<void>;run:()=>Promise<T>}):Promise<{result:T;settlement:Awaited<ReturnType<ReturnType<typeof createWeeklyCandidateExactPaidRequests>['readSettlement']>>}>{
 const guard=createWeeklyCandidateExactPaidRequests(input);
 const result=await withExactQwenScope({model:input.plan.model,configurationHash:input.configurationHash,endpoint:input.plan.endpoint,credentialDigest:input.plan.credentialSha256,paidGuardRequired:true,
  beforeProviderRequest:guard.beforeProviderRequest,onProviderReceipt:guard.onProviderReceipt},input.run);
 return {result,settlement:await guard.readSettlement()};
}

/** Dynamic visual analysis cannot know later prompts before earlier responses.
 * This journal fixes the operation, tariff, request count and total ceiling
 * up front, then fsyncs each exact request and its full-model worst-case hold
 * before transport. Holds are never released based on caller-reported usage.
 * A completed response permits the next child in the same process, but does
 * not by itself prove independent supplier/paid-ledger settlement. */
export interface WeeklyCandidateDynamicExactPlan {
 operationId:string;candidateId:string;mediaSha256:string;endpoint:string;credentialSha256:string;
 model:'qwen3-vl-plus';maximumRequests:number;maximumTotalCny:number;
}
type DynamicEntry={sequence:number;requestHash:string;maximumInputTokens:number;maximumOutputTokens:number;reservedMicros:number;state:'unknown'|'response_recorded';response?:ExactQwenProviderReceipt};
type DynamicLedger={schema:'weekly-candidate-dynamic-exact-paid.v1';authorizationHash:string;planHash:string;entries:DynamicEntry[]};
function checkedDynamicPlan(plan:WeeklyCandidateDynamicExactPlan,authorizationHash:string){
 if(!hash.test(authorizationHash)||!plan.operationId||!plan.candidateId||!hash.test(plan.mediaSha256)||!hash.test(plan.credentialSha256)
  ||classifyQwenCompatibleEndpoint(plan.endpoint)!=='qianwen-maas'||plan.model!=='qwen3-vl-plus'
  ||!Number.isSafeInteger(plan.maximumRequests)||plan.maximumRequests<1||plan.maximumRequests>128
  ||!Number.isSafeInteger(micros(plan.maximumTotalCny))||micros(plan.maximumTotalCny)<1)fail('dynamic_plan_invalid');
}
function readDynamic(file:string,authorizationHash:string,planHash:string,plan:WeeklyCandidateDynamicExactPlan):DynamicLedger{
 if(!fs.existsSync(file))return {schema:'weekly-candidate-dynamic-exact-paid.v1',authorizationHash,planHash,entries:[]};
 let ledger:DynamicLedger;try{ledger=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('dynamic_ledger_corrupt');}
 if(ledger.schema!=='weekly-candidate-dynamic-exact-paid.v1'||ledger.authorizationHash!==authorizationHash||ledger.planHash!==planHash||!Array.isArray(ledger.entries)
  ||ledger.entries.length>plan.maximumRequests)fail('dynamic_ledger_changed');
 const seen=new Set<string>(),responseIds=new Set<string>();
 let heldMicros=0;
 for(const [index,entry] of ledger.entries.entries()){
  if(entry.sequence!==index||!hash.test(entry.requestHash)||seen.has(entry.requestHash)||entry.maximumInputTokens!==qwenVisionInputLimit('qwen3-vl-plus')
   ||!Number.isSafeInteger(entry.maximumOutputTokens)||entry.maximumOutputTokens<1||entry.maximumOutputTokens>16384
   ||entry.reservedMicros!==entry.maximumInputTokens*3+entry.maximumOutputTokens*30
   ||!['unknown','response_recorded'].includes(entry.state)||entry.response!==undefined&&entry.response.requestHash!==entry.requestHash
   ||entry.response?.responseBodySha256!==undefined&&!hash.test(entry.response.responseBodySha256)
   ||entry.response?.providerRequestId!==undefined&&entry.response.providerRequestId!==null&&
    (typeof entry.response.providerRequestId!=='string'||entry.response.providerRequestId.length>256||!/^[A-Za-z0-9._:-]+$/.test(entry.response.providerRequestId))
   ||entry.state==='response_recorded'&&!entry.response)fail('dynamic_ledger_corrupt');
  seen.add(entry.requestHash);
  heldMicros+=entry.reservedMicros;
  if(!Number.isSafeInteger(heldMicros)||heldMicros>micros(plan.maximumTotalCny))fail('dynamic_ledger_corrupt');
  if(entry.state==='response_recorded'){
   const responseId=entry.response?.responseId;
   if(typeof responseId!=='string'||!responseId||responseIds.has(responseId))fail('dynamic_ledger_corrupt');
   responseIds.add(responseId as string);
   try{inspectWeeklyExactSupplierEnvelopes({operationId:plan.operationId,candidateId:plan.candidateId,mediaSha256:plan.mediaSha256,endpoint:plan.endpoint,
    credentialSha256:plan.credentialSha256,model:plan.model,maximumTotalCny:entry.reservedMicros/1_000_000,
    requests:[{requestHash:entry.requestHash,maximumInputTokens:entry.maximumInputTokens,maximumOutputTokens:entry.maximumOutputTokens}],
    responses:[{requestHash:entry.requestHash,response:entry.response!}]});}catch{return fail('dynamic_ledger_corrupt');}
  }
 }
 return ledger;
}
export function createWeeklyCandidateDynamicExactPaidRequests(input:{root:string;authorizationHash:string;plan:WeeklyCandidateDynamicExactPlan;assertCurrent:()=>Promise<void>}){
 const {plan,authorizationHash}=input;checkedDynamicPlan(plan,authorizationHash);
 const planHash=sha(JSON.stringify(plan)),root=path.resolve(input.root),file=path.join(root,sha(JSON.stringify(['dynamic',plan.operationId,authorizationHash]))+'.json');
 const exclusive=<T>(body:()=>Promise<T>)=>withPaidOperationLock(path.join(root,'.locks'),`weekly-exact-dynamic:${plan.operationId}:${authorizationHash}`,body);
 return {
  async beforeProviderRequest(requestBody:string){
   let body:Record<string,unknown>;try{body=JSON.parse(requestBody);}catch{return fail('dynamic_request_unreadable');}
   const output=body.max_tokens;
   if(body.model!==plan.model||!Number.isSafeInteger(output)||Number(output)<1||Number(output)>16384)fail('dynamic_request_changed');
   const requestHash=sha(requestBody),maximumInputTokens=qwenVisionInputLimit(plan.model),reservedMicros=maximumInputTokens*3+Number(output)*30;
   await exclusive(async()=>{
    await input.assertCurrent();const ledger=readDynamic(file,authorizationHash,planHash,plan);
    if(ledger.entries.some(entry=>entry.requestHash===requestHash))fail('original_request_recovery_required');
    if(ledger.entries.length>=plan.maximumRequests)fail('dynamic_request_count_exceeded');
    if(ledger.entries.some(entry=>entry.state!=='response_recorded'))fail('earlier_request_unsettled');
    const sum=ledger.entries.reduce((total,entry)=>total+entry.reservedMicros,0)+reservedMicros;
    if(sum>micros(plan.maximumTotalCny))fail('dynamic_cny_ceiling_exceeded');
    ledger.entries.push({sequence:ledger.entries.length,requestHash,maximumInputTokens,maximumOutputTokens:Number(output),reservedMicros,state:'unknown'});
    write(file,ledger);
   });
  },
  async onProviderReceipt(response:ExactQwenProviderReceipt){
   await exclusive(async()=>{
    const ledger=readDynamic(file,authorizationHash,planHash,plan),entry=ledger.entries.at(-1);
    if(!entry||entry.requestHash!==response.requestHash||entry.response)return fail('dynamic_receipt_without_original_claim');
    entry.response=response;
    if(response.httpStatus===200&&!ledger.entries.slice(0,-1).some(prior=>prior.response?.responseId===response.responseId)){
     try{inspectWeeklyExactSupplierEnvelopes({operationId:plan.operationId,candidateId:plan.candidateId,mediaSha256:plan.mediaSha256,endpoint:plan.endpoint,
      credentialSha256:plan.credentialSha256,model:plan.model,maximumTotalCny:entry.reservedMicros/1_000_000,
      requests:[{requestHash:entry.requestHash,maximumInputTokens:entry.maximumInputTokens,maximumOutputTokens:entry.maximumOutputTokens}],responses:[{requestHash:entry.requestHash,response}]});
      entry.state='response_recorded';
     }catch{/* malformed or ambiguous original response remains unknown */}
    }
    write(file,ledger);
   });
  },
  async readDiagnostic(){return exclusive(async()=>{
   const ledger=readDynamic(file,authorizationHash,planHash,plan);
   return {planHash,authorizationHash,ledgerHash:sha(JSON.stringify(ledger)),requestCount:ledger.entries.length,
    reservedUpperBoundCny:ledger.entries.reduce((sum,entry)=>sum+entry.reservedMicros,0)/1_000_000,
    allResponsesRecorded:ledger.entries.length>0&&ledger.entries.every(entry=>entry.state==='response_recorded')};
  });},
  /** Read-only recovery view. These envelopes came from our transport and are
   * not independently settled supplier or billing evidence. */
  async readRecordedChildren(){return exclusive(async()=>{
   const ledger=readDynamic(file,authorizationHash,planHash,plan);
   return {planHash,authorizationHash,ledgerHash:sha(JSON.stringify(ledger)),entries:structuredClone(ledger.entries)};
  });},
  async readClaim(requestHash:string){return exclusive(async()=>readDynamic(file,authorizationHash,planHash,plan).entries.find(entry=>entry.requestHash===requestHash)??null);}
 };
}

export async function withWeeklyCandidateDynamicExactPaidScope<T>(input:{root:string;authorizationHash:string;plan:WeeklyCandidateDynamicExactPlan;configurationHash:string;assertCurrent:()=>Promise<void>;run:()=>Promise<T>}){
 const guard=createWeeklyCandidateDynamicExactPaidRequests(input);
 const result=await withExactQwenScope({model:input.plan.model,configurationHash:input.configurationHash,endpoint:input.plan.endpoint,
  credentialDigest:input.plan.credentialSha256,paidGuardRequired:true,beforeProviderRequest:guard.beforeProviderRequest,onProviderReceipt:guard.onProviderReceipt},input.run);
 return {result,diagnostic:await guard.readDiagnostic()};
}

// Phase 2 foundation only. No production composition imports this v2 API.
// Its ten-yuan ceiling is the same mother's total content authorization, not
// an additional analysis allowance; later production must carry every held
// micro-yuan into that same mother ledger before spending the remainder.
export interface WeeklyCandidateDynamicExactPlanV2{
 schema:'weekly-candidate-dynamic-exact-plan.v2';operationId:string;candidateId:string;mediaSha256:string;
 endpoint:string;credentialSha256:string;ledgerIntegrityKeySha256:string;model:'qwen3-vl-plus';pricingEvidence:MaaSPublishedPricingEvidence;
 pricingEvidenceHash:string;pricingPolicyHash:string;measurementPolicyHash:string;
 protocolMaximumRequests:number;candidateMaximumMicros:number;
}
export type WeeklyCandidateDynamicExactEntryV2=WeeklyExactRequestCeiling&{
 sequence:number;state:'unknown'|'response_recorded';response?:ExactQwenProviderReceipt;integrityMac:string;
};
export type WeeklyCandidateDynamicExactLedgerV2={
 schema:'weekly-candidate-dynamic-exact-paid.v2';authorizationHash:string;planHash:string;
 pricingEvidenceHash:string;pricingPolicyHash:string;measurementPolicyHash:string;
 candidateMaximumMicros:number;protocolMaximumRequests:number;generation:number;previousHeadHash:string|null;
 entries:WeeklyCandidateDynamicExactEntryV2[];integrityMac:string;
};
type DynamicLedgerV2=WeeklyCandidateDynamicExactLedgerV2;
export interface WeeklyCandidateDynamicExactHeadV2{
 schema:'weekly-candidate-dynamic-exact-head.v2';operationId:string;authorizationHash:string;planHash:string;generation:number;ledgerHash:string;
}
export interface WeeklyCandidateDynamicExactHeadAnchorV2{
 /** This port is a separate durable authority, not a second file beside the
  * ledger. It MUST retain the genesis row, serialize CAS, and never return an
  * older generation after acknowledging a newer one. */
 read:()=>Promise<WeeklyCandidateDynamicExactHeadV2|null>;
 compareAndSwap:(expected:WeeklyCandidateDynamicExactHeadV2,next:WeeklyCandidateDynamicExactHeadV2)=>Promise<boolean>;
}
const v2PlanHash=(plan:WeeklyCandidateDynamicExactPlanV2)=>sha(JSON.stringify(plan));
export const weeklyCandidateDynamicExactV2LedgerPath=(root:string,authorizationHash:string,plan:WeeklyCandidateDynamicExactPlanV2)=>
 path.join(path.resolve(root),sha(JSON.stringify(['weekly-candidate-dynamic-exact-paid.v2',plan.operationId,authorizationHash]))+'.json');
function checkedDynamicPlanV2(plan:WeeklyCandidateDynamicExactPlanV2,authorizationHash:string){
 if(plan.schema!=='weekly-candidate-dynamic-exact-plan.v2'||!hash.test(authorizationHash)||!plan.operationId||!plan.candidateId||
  !hash.test(plan.mediaSha256)||!hash.test(plan.credentialSha256)||!hash.test(plan.ledgerIntegrityKeySha256)||
  plan.ledgerIntegrityKeySha256===plan.credentialSha256||classifyQwenCompatibleEndpoint(plan.endpoint)!=='qianwen-maas'||
  plan.model!=='qwen3-vl-plus'||!hash.test(plan.pricingEvidenceHash)||plan.pricingEvidenceHash!==sha(JSON.stringify(plan.pricingEvidence))||
  !hash.test(plan.pricingPolicyHash)||plan.measurementPolicyHash!==weeklyCandidateExactMeasurementPolicyHash()||
  !Number.isSafeInteger(plan.protocolMaximumRequests)||plan.protocolMaximumRequests<1||plan.protocolMaximumRequests>128||
  !Number.isSafeInteger(plan.candidateMaximumMicros)||plan.candidateMaximumMicros<1||plan.candidateMaximumMicros>10_000_000||
  plan.pricingEvidence.providerBinding.baseUrl.replace(/\/+$/,'')!==plan.endpoint.replace(/\/+$/,'')||
  plan.pricingEvidence.providerBinding.credentialSha256!==plan.credentialSha256)fail('dynamic_v2_plan_invalid');
}
function rebuildPricingPolicyV2(plan:WeeklyCandidateDynamicExactPlanV2){
 const policy=verifyQwenMaaSPublishedPricingEvidence(plan.pricingEvidence,{baseUrl:plan.endpoint,credentialSha256:plan.credentialSha256});
 if(!policy)fail('dynamic_v2_pricing_policy_unverified');
 if(policy!.verificationHash!==plan.pricingPolicyHash)fail('dynamic_v2_pricing_policy_unverified');
 return policy!;
}
function v2LedgerMac(ledger:Omit<DynamicLedgerV2,'integrityMac'>,integrityKey:string){
 return createHmac('sha256',integrityKey).update(JSON.stringify(ledger)).digest('hex');
}
function emptyDynamicV2(authorizationHash:string,planHash:string,plan:WeeklyCandidateDynamicExactPlanV2,integrityKey:string):DynamicLedgerV2{
 const body:Omit<DynamicLedgerV2,'integrityMac'>={schema:'weekly-candidate-dynamic-exact-paid.v2',authorizationHash,planHash,pricingEvidenceHash:plan.pricingEvidenceHash,
  pricingPolicyHash:plan.pricingPolicyHash,measurementPolicyHash:plan.measurementPolicyHash,
  candidateMaximumMicros:plan.candidateMaximumMicros,protocolMaximumRequests:plan.protocolMaximumRequests,generation:0,previousHeadHash:null,entries:[]};
 return {...body,integrityMac:v2LedgerMac(body,integrityKey)};
}
export function weeklyCandidateDynamicExactInitialHeadV2(authorizationHash:string,plan:WeeklyCandidateDynamicExactPlanV2,integrityKey:string):WeeklyCandidateDynamicExactHeadV2{
 const planHash=v2PlanHash(plan),ledger=emptyDynamicV2(authorizationHash,planHash,plan,integrityKey);
 return {schema:'weekly-candidate-dynamic-exact-head.v2',operationId:plan.operationId,authorizationHash,planHash,generation:0,ledgerHash:sha(JSON.stringify(ledger))};
}
function validV2Receipt(entry:WeeklyCandidateDynamicExactEntryV2,response:ExactQwenProviderReceipt,prior:WeeklyCandidateDynamicExactEntryV2[]){
 const usage=response.usage as {prompt_tokens?:unknown;completion_tokens?:unknown;total_tokens?:unknown}|null|undefined;
 const prompt=usage?.prompt_tokens,completion=usage?.completion_tokens,total=usage?.total_tokens;
 return response.provider==='qwen'&&response.requestHash===entry.requestBodySha256&&response.requestModel==='qwen3-vl-plus'&&
  response.model==='qwen3-vl-plus'&&response.httpStatus===200&&typeof response.responseId==='string'&&response.responseId.length>0&&
  !prior.some(item=>item.response?.responseId===response.responseId)&&Number.isSafeInteger(prompt)&&Number(prompt)>=0&&
  Number(prompt)<=entry.inputTokenCeiling&&Number.isSafeInteger(completion)&&Number(completion)>=0&&
  Number(completion)<=entry.outputTokenCeiling&&Number.isSafeInteger(total)&&Number(total)===Number(prompt)+Number(completion);
}
function v2EntryMac(entry:Omit<WeeklyCandidateDynamicExactEntryV2,'integrityMac'>,integrityKey:string){
 return createHmac('sha256',integrityKey).update(JSON.stringify(entry)).digest('hex');
}
function validV2EntryMac(entry:WeeklyCandidateDynamicExactEntryV2,integrityKey:string){
 const {integrityMac,...body}=entry,expected=v2EntryMac(body,integrityKey);
 return hash.test(integrityMac)&&timingSafeEqual(Buffer.from(integrityMac,'hex'),Buffer.from(expected,'hex'));
}
function validV2Ceiling(entry:WeeklyCandidateDynamicExactEntryV2,plan:WeeklyCandidateDynamicExactPlanV2){
 const tier=plan.pricingEvidence.tiers.find(item=>entry.inputTokenCeiling<=item.maximumInputTokens);
 const computedInput=entry.nonImageUtf8ByteCeiling+entry.visualTokenCeiling+entry.protocolReserveTokens;
 const fallbackReasons=['image_url_unsupported','image_data_invalid','image_mime_mismatch','image_dimensions_invalid','image_limit_exceeded'];
 const fallback=entry.fallbackReason!==null;
 const expectedMicros=tier?Math.ceil(entry.inputTokenCeiling*tier.inputPriceCnyPerMillion+
  entry.outputTokenCeiling*tier.outputPriceCnyPerMillion):NaN;
 return Boolean(tier)&&JSON.stringify(entry.selectedTier)===JSON.stringify(tier)&&entry.inputPriceCnyPerMillion===tier!.inputPriceCnyPerMillion&&
  entry.outputPriceCnyPerMillion===tier!.outputPriceCnyPerMillion&&entry.protocolReserveTokens===8192&&
  Number.isSafeInteger(entry.nonImageUtf8ByteCeiling)&&entry.nonImageUtf8ByteCeiling>=0&&
  Number.isSafeInteger(entry.visualTokenCeiling)&&entry.visualTokenCeiling>=0&&Number.isSafeInteger(entry.imageCount)&&entry.imageCount>=0&&
  (fallback?(fallbackReasons.includes(String(entry.fallbackReason))&&entry.inputTokenCeiling===260096&&entry.nonImageUtf8ByteCeiling===0&&entry.visualTokenCeiling===0&&entry.imageCount===0):
   entry.inputTokenCeiling===computedInput)&&entry.reservedMicros===expectedMicros;
}
function readDynamicV2(file:string,authorizationHash:string,planHash:string,plan:WeeklyCandidateDynamicExactPlanV2,integrityKey:string):DynamicLedgerV2{
 if(!fs.existsSync(file))return emptyDynamicV2(authorizationHash,planHash,plan,integrityKey);
 let ledger:DynamicLedgerV2;try{ledger=JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fail('dynamic_v2_ledger_corrupt');}
 const {integrityMac,...ledgerBody}=ledger,expectedLedgerMac=v2LedgerMac(ledgerBody,integrityKey);
 if(ledger.schema!=='weekly-candidate-dynamic-exact-paid.v2'||ledger.authorizationHash!==authorizationHash||ledger.planHash!==planHash||
  ledger.pricingEvidenceHash!==plan.pricingEvidenceHash||ledger.pricingPolicyHash!==plan.pricingPolicyHash||
  ledger.measurementPolicyHash!==plan.measurementPolicyHash||ledger.candidateMaximumMicros!==plan.candidateMaximumMicros||
  ledger.protocolMaximumRequests!==plan.protocolMaximumRequests)fail('dynamic_v2_ledger_changed');
 if(!Number.isSafeInteger(ledger.generation)||ledger.generation<0||
  (ledger.generation===0?ledger.previousHeadHash!==null:!hash.test(String(ledger.previousHeadHash)))||!hash.test(String(integrityMac))||
  !timingSafeEqual(Buffer.from(String(integrityMac),'hex'),Buffer.from(expectedLedgerMac,'hex'))||
  !Array.isArray(ledger.entries)||ledger.entries.length>plan.protocolMaximumRequests)
  fail('dynamic_v2_ledger_corrupt');
 const requests=new Set<string>(),responses=new Set<string>();let held=0;
 for(const [index,entry] of ledger.entries.entries()){
  if(!validV2EntryMac(entry,integrityKey)||entry.sequence!==index||entry.schema!=='weekly-candidate-exact-request-ceiling.v1'||!hash.test(entry.requestBodySha256)||
   requests.has(entry.requestBodySha256)||entry.pricingPolicyHash!==plan.pricingPolicyHash||entry.measurementPolicyHash!==plan.measurementPolicyHash||
   !Number.isSafeInteger(entry.inputTokenCeiling)||entry.inputTokenCeiling<1||!Number.isSafeInteger(entry.outputTokenCeiling)||entry.outputTokenCeiling<1||
   !Number.isSafeInteger(entry.reservedMicros)||entry.reservedMicros<1||!['unknown','response_recorded'].includes(entry.state)||
   entry.response!==undefined&&entry.response.requestHash!==entry.requestBodySha256||entry.state==='response_recorded'&&!entry.response||!validV2Ceiling(entry,plan))
   fail('dynamic_v2_ledger_corrupt');
  requests.add(entry.requestBodySha256);held+=entry.reservedMicros;
  if(!Number.isSafeInteger(held)||held>plan.candidateMaximumMicros)fail('dynamic_v2_ledger_corrupt');
  if(entry.state==='response_recorded'){
   const response=entry.response!,responseId=response.responseId;
   if(!validV2Receipt(entry,response,ledger.entries.slice(0,index))||typeof responseId!=='string'||responses.has(responseId))fail('dynamic_v2_ledger_corrupt');
   responses.add(responseId!);
  }
 }
 return ledger;
}

/** Dormant v2 journal. Tests call this directly; no production scope wrapper
 * is exported until Phase 3 installs audited settlement and carry-forward. */
export function createWeeklyCandidateDynamicExactPaidRequestsV2(input:{
 root:string;authorizationHash:string;plan:WeeklyCandidateDynamicExactPlanV2;integrityKey:string;
 assertAuthorizedPlan:(plan:WeeklyCandidateDynamicExactPlanV2,authorizationHash:string)=>Promise<void>;
 headAnchor:WeeklyCandidateDynamicExactHeadAnchorV2;
}){
 checkedDynamicPlanV2(input.plan,input.authorizationHash);
 if(!input.integrityKey||sha(input.integrityKey)!==input.plan.ledgerIntegrityKeySha256)fail('dynamic_v2_integrity_key_invalid');
 const planHash=v2PlanHash(input.plan),file=weeklyCandidateDynamicExactV2LedgerPath(input.root,input.authorizationHash,input.plan);
 const exclusive=<T>(body:()=>Promise<T>)=>withPaidOperationLock(path.join(path.resolve(input.root),'.locks'),
  `weekly-exact-dynamic-v2:${input.plan.operationId}:${input.authorizationHash}`,body);
 const readAnchored=async(recoverInterrupted=true):Promise<{ledger:DynamicLedgerV2;head:WeeklyCandidateDynamicExactHeadV2}>=>{
  const head=await input.headAnchor.read(),exists=fs.existsSync(file);
  const initial=weeklyCandidateDynamicExactInitialHeadV2(input.authorizationHash,input.plan,input.integrityKey);
  if(!head)return fail('dynamic_v2_anchor_missing');const currentHead=head;
  if(!exists){if(JSON.stringify(currentHead)!==JSON.stringify(initial))fail('dynamic_v2_anchor_changed');return{ledger:emptyDynamicV2(input.authorizationHash,planHash,input.plan,input.integrityKey),head:currentHead};}
  const ledger=readDynamicV2(file,input.authorizationHash,planHash,input.plan,input.integrityKey);
  const ledgerHash=sha(JSON.stringify(ledger));
  if(currentHead.schema!=='weekly-candidate-dynamic-exact-head.v2'||currentHead.operationId!==input.plan.operationId||
   currentHead.authorizationHash!==input.authorizationHash||currentHead.planHash!==planHash)fail('dynamic_v2_anchor_changed');
  if(currentHead.generation===ledger.generation&&currentHead.ledgerHash===ledgerHash)return{ledger,head:currentHead};
  // The file is fsynced before CAS. Exactly one authenticated generation ahead
  // is an interrupted commit: finish its monotonic head update, but never
  // re-authorize the unknown request or accept an older/multi-step snapshot.
  if(recoverInterrupted&&ledger.generation===currentHead.generation+1&&ledger.previousHeadHash===sha(JSON.stringify(currentHead))){
   const recovered:WeeklyCandidateDynamicExactHeadV2={schema:'weekly-candidate-dynamic-exact-head.v2',operationId:input.plan.operationId,
    authorizationHash:input.authorizationHash,planHash,generation:ledger.generation,ledgerHash};
   if(await input.headAnchor.compareAndSwap(currentHead,recovered))return{ledger,head:recovered};
  }
  return fail('dynamic_v2_anchor_changed');
 };
 const persist=async(ledger:DynamicLedgerV2,head:WeeklyCandidateDynamicExactHeadV2)=>{
  ledger.generation=head.generation+1;ledger.previousHeadHash=sha(JSON.stringify(head));
  const {integrityMac:_,...ledgerBody}=ledger;ledger.integrityMac=v2LedgerMac(ledgerBody,input.integrityKey);write(file,ledger);
  const next:WeeklyCandidateDynamicExactHeadV2={schema:'weekly-candidate-dynamic-exact-head.v2',operationId:input.plan.operationId,
   authorizationHash:input.authorizationHash,planHash,generation:ledger.generation,ledgerHash:sha(JSON.stringify(ledger))};
  if(!await input.headAnchor.compareAndSwap(head,next))fail('dynamic_v2_anchor_commit_unknown');
 };
 return {
  ledgerPath:file,
  async beforeProviderRequest(requestBody:string){
   await input.assertAuthorizedPlan(input.plan,input.authorizationHash);
   const policy=rebuildPricingPolicyV2(input.plan);
   const ceiling=await measureWeeklyCandidateExactRequestCeiling({requestBody,pricingPolicy:policy});
   if(ceiling.pricingPolicyHash!==input.plan.pricingPolicyHash||ceiling.measurementPolicyHash!==input.plan.measurementPolicyHash)
    fail('dynamic_v2_measurement_changed');
   await exclusive(async()=>{
    await input.assertAuthorizedPlan(input.plan,input.authorizationHash);rebuildPricingPolicyV2(input.plan);
    const anchored=await readAnchored(),ledger=anchored.ledger;
    if(ledger.entries.some(entry=>entry.requestBodySha256===ceiling.requestBodySha256))fail('original_request_recovery_required');
    if(ledger.entries.some(entry=>entry.state!=='response_recorded'))fail('earlier_request_unsettled');
    if(ledger.entries.length>=input.plan.protocolMaximumRequests)fail('dynamic_v2_request_count_exceeded');
    const held=ledger.entries.reduce((sum,entry)=>sum+entry.reservedMicros,0);
    if(!Number.isSafeInteger(held+ceiling.reservedMicros)||held+ceiling.reservedMicros>input.plan.candidateMaximumMicros)
     fail('dynamic_v2_cny_ceiling_exceeded');
    const body={...ceiling,sequence:ledger.entries.length,state:'unknown' as const};
    ledger.entries.push({...body,integrityMac:v2EntryMac(body,input.integrityKey)});await persist(ledger,anchored.head);
   });
  },
  async onProviderReceipt(response:ExactQwenProviderReceipt){
   await exclusive(async()=>{
    const anchored=await readAnchored(),ledger=anchored.ledger,entry=ledger.entries.at(-1);
    if(!entry||entry.requestBodySha256!==response.requestHash||entry.response)fail('dynamic_v2_receipt_without_original_claim');
    const current=entry!;current.response=response;
    if(validV2Receipt(current,response,ledger.entries.slice(0,-1)))current.state='response_recorded';
    const {integrityMac:_,...body}=current;current.integrityMac=v2EntryMac(body,input.integrityKey);
    await persist(ledger,anchored.head);
   });
  },
  async readDiagnostic(){return exclusive(async()=>{
   const ledger=(await readAnchored()).ledger;
   return {planHash,authorizationHash:input.authorizationHash,ledgerHash:sha(JSON.stringify(ledger)),requestCount:ledger.entries.length,
    reservedMicros:ledger.entries.reduce((sum,entry)=>sum+entry.reservedMicros,0),
    allResponsesRecorded:ledger.entries.length>0&&ledger.entries.every(entry=>entry.state==='response_recorded')};
  });},
  async readRecordedChildren(){return exclusive(async()=>structuredClone((await readAnchored()).ledger));},
  /** Strictly read-only settlement view. Interrupted commits must first be
   * repaired through the normal recovery path; settlement never moves head. */
  async readAnchoredSnapshot(){return exclusive(async()=>{const value=await readAnchored(false);return structuredClone(value);});},
  async readClaim(requestHash:string){return exclusive(async()=>(await readAnchored()).ledger.entries.find(entry=>entry.requestBodySha256===requestHash)??null);},
 };
}
