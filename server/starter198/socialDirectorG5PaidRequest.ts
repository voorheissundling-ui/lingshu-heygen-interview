import {createHash} from 'node:crypto';
import type {MaterialAnalysisPaidCall} from '../digitalEmployees/materialAnalysisPaidOperation.js';
import {submitMaterialAnalysisPaidRequest} from '../digitalEmployees/materialAnalysisPaidOperation.js';

/** G5 is a separate billable request, but occupies the original film ledger.
 * The caller must resolve this call from the server-owned canonical plan. */
export type DirectorG5PaidCall=MaterialAnalysisPaidCall;

/** Provider usage is evidence about this exact paid response, not a caller
 * estimate. An absent or over-envelope observation retains the permit's
 * unknown charge for reconciliation instead of completing the film ledger. */
function assertDirectorG5ProviderUsage(response:unknown,call:DirectorG5PaidCall){
 const result=response&&typeof response==='object'?response as Record<string,unknown>:null;
 const usage=result?.usage&&typeof result.usage==='object'?result.usage as Record<string,unknown>:null;
 const choice=Array.isArray(result?.choices)?result.choices[0] as Record<string,unknown>|undefined:undefined;
 const input=usage?.prompt_tokens,output=usage?.completion_tokens;
 const details=usage?.prompt_tokens_details&&typeof usage.prompt_tokens_details==='object'
  ?usage.prompt_tokens_details as Record<string,unknown>:null;
 // The downstream G5 audit prices uncached input only. Missing or nonzero
 // cache metering must retain the original film's unknown occupancy, rather
 // than first marking that same paid operation completed on a cheaper quote.
 const cached=details?.cached_tokens,total=usage?.total_tokens;
 if(typeof result?.id!=='string'||!result.id.trim()||result.model!==call.intent.model
  ||choice?.finish_reason!=='stop'
  ||!Number.isSafeInteger(input)||Number(input)<0||Number(input)>call.intent.maximumUnits.inputTokens
  ||!Number.isSafeInteger(output)||Number(output)<0||Number(output)>call.intent.maximumUnits.outputTokens
  ||cached!==0
  ||(total!==undefined&&(!Number.isSafeInteger(total)||total!==Number(input)+Number(output))))
  throw Error('director_g5_provider_usage_unverified');
}

export async function submitDirectorG5PaidRequest<T>(input:{
 requestId:string;body:Record<string,unknown>;call:DirectorG5PaidCall|null|undefined;
 accountRef:string;send(body:Record<string,unknown>):Promise<T>;
}):Promise<T>{
 const call=input.call,body=structuredClone(input.body);
 if(!call)throw Error('director_g5_canonical_paid_permit_required');
 const requestHash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
 if(call.intent.stage!=='director_review'||call.intent.shotId!==null||call.intent.provider!=='qwen'
  ||call.intent.operationId!==input.requestId||call.intent.inputContractHash!==requestHash
  ||call.intent.accountRef!==input.accountRef
  ||Object.keys(call.intent.maximumUnits).sort().join(',')!=='inputTokens,outputTokens')
  throw Error('director_g5_paid_request_binding_invalid');
 return submitMaterialAnalysisPaidRequest(body,call,async request=>{
  const response=await input.send(request);
  assertDirectorG5ProviderUsage(response,call);
  return response;
 });
}
