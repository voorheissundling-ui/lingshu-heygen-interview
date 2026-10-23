import {createHash} from 'node:crypto';
import type {ExactQwenProviderReceipt} from '../agents/exactQwenScope.js';
import {classifyQwenCompatibleEndpoint} from '../lib/qwenCompatibleEndpoint.js';
import {qwenVisionInputLimit} from '../lib/qwenVisionInputLimit.js';

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=/^[a-f0-9]{64}$/;
const whole=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const fail=(reason:string):never=>{throw Error(`weekly_candidate_exact_provider_${reason}`);};

/** An independently read original supplier envelope, not an application-made
 * "success" flag. One long-form candidate can make several visual POSTs. */
export interface WeeklyExactSupplierResponse {
 requestHash:string;
 response:ExactQwenProviderReceipt;
}
export interface WeeklyExactSupplierEnvelopeInput {
 operationId:string;
 candidateId:string;
 mediaSha256:string;
 endpoint:string;
 credentialSha256:string;
 model:'qwen3-vl-plus';
 /** Frozen before the first request. An unlisted child call is not billable
  * under this operation and must never be accepted as its analysis proof. */
 requests:Array<{requestHash:string;maximumInputTokens:number;maximumOutputTokens:number}>;
 responses:WeeklyExactSupplierResponse[];
 maximumTotalCny:number;
}

/** Structural settlement preflight only. The caller must still independently
 * recover raw provider responses and its own durable CNY paid ledger. A copied
 * response envelope or a caller-reported receipt cannot authorize production. */
export function inspectWeeklyExactSupplierEnvelopes(input:WeeklyExactSupplierEnvelopeInput){
 if(!input.operationId||!input.candidateId||!digest.test(input.mediaSha256)||!digest.test(input.credentialSha256)
  ||classifyQwenCompatibleEndpoint(input.endpoint)!=='qianwen-maas'||input.model!=='qwen3-vl-plus'
  ||!Number.isFinite(input.maximumTotalCny)||input.maximumTotalCny<=0)fail('binding_invalid');
 if(!input.requests.length||input.requests.length>128||input.requests.length!==input.responses.length)fail('request_count_invalid');
 const planned=new Map<string,{requestHash:string;maximumInputTokens:number;maximumOutputTokens:number}>();
 for(const request of input.requests){
  if(!digest.test(request.requestHash)||planned.has(request.requestHash)||!whole(request.maximumInputTokens)
   ||request.maximumInputTokens>qwenVisionInputLimit(input.model)||!whole(request.maximumOutputTokens)
   ||request.maximumOutputTokens>16384)fail('request_plan_invalid');
  planned.set(request.requestHash,request);
 }
 const reservedUpperBoundCny=input.requests.reduce((sum,request)=>sum+(request.maximumInputTokens*3+request.maximumOutputTokens*30)/1_000_000,0);
 if(!Number.isFinite(reservedUpperBoundCny)||reservedUpperBoundCny>input.maximumTotalCny+1e-9)fail('cny_plan_ceiling_exceeded');
 const seen=new Set<string>(),responseIds=new Set<string>();let inputTokens=0,outputTokens=0;
 for(const item of input.responses){
  const plan=planned.get(item.requestHash),r=item.response;
  if(!plan)throw Error('weekly_candidate_exact_provider_original_response_invalid');
  if(seen.has(item.requestHash)||r.requestHash!==item.requestHash||r.requestModel!==input.model
   ||r.model!==input.model||r.provider!=='qwen'||r.httpStatus!==200||typeof r.responseId!=='string'
   ||!r.responseId.trim()||responseIds.has(r.responseId)||!Number.isFinite(Date.parse(r.receivedAt)))fail('original_response_invalid');
  const usage=r.usage;
  if(!usage||typeof usage!=='object'||Array.isArray(usage))fail('usage_missing');
  const units=usage as Record<string,unknown>;
  // Qwen's OpenAI-compatible receipt uses prompt/completion/total tokens.
  // Never infer missing usage from prompt length or a client-side estimate.
  if(!whole(units.prompt_tokens)||!whole(units.completion_tokens)||!whole(units.total_tokens)
   ||units.total_tokens!==Number(units.prompt_tokens)+Number(units.completion_tokens)
   ||Number(units.prompt_tokens)>plan.maximumInputTokens||Number(units.completion_tokens)>plan.maximumOutputTokens)fail('usage_invalid');
  seen.add(item.requestHash);responseIds.add(r.responseId as string);inputTokens+=Number(units.prompt_tokens);outputTokens+=Number(units.completion_tokens);
 }
 // The highest standard online tier is deliberately used for every child
 // request, even when the observed token count would qualify for less.
 const measuredCeilingCny=(inputTokens*3+outputTokens*30)/1_000_000;
 if(!Number.isFinite(measuredCeilingCny)||measuredCeilingCny>input.maximumTotalCny+1e-9)fail('cny_ceiling_exceeded');
 return {requestSetHash:sha(input.requests),responseSetHash:sha(input.responses),requestCount:seen.size,inputTokens,outputTokens,reservedUpperBoundCny,measuredCeilingCny};
}
