import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
export interface ExactQwenProviderReceipt {provider:'qwen';responseId:string|null;model:string|null;usage:unknown;httpStatus:number;requestModel:string|null;requestHash:string;receivedAt:string;
 /** Transport-observed audit anchors, not independent supplier or billing proof. */
 responseBodySha256?:string;providerRequestId?:string|null;}
interface ExactScope {model:string;configurationHash:string;endpoint?:string;credentialDigest?:string;paidGuardRequired?:boolean;beforeProviderRequest?:(requestBody:string)=>Promise<void>;onProviderReceipt?:(receipt:ExactQwenProviderReceipt)=>Promise<void>;}
// `tsx -e` evaluates the entrypoint as CJS while route dynamic imports are ESM.
// A module-local ALS is duplicated across that boundary, silently dropping the
// paid-operation scope. Symbol.for makes both module instances share one ALS
// within the process without exposing its contents outside this module API.
const scopeKey=Symbol.for('lingshu.exact-qwen-scope.v1');
const processGlobals=globalThis as typeof globalThis&Record<symbol,AsyncLocalStorage<ExactScope>|undefined>;
const scope=processGlobals[scopeKey]??=new AsyncLocalStorage<ExactScope>();
export const exactQwenScope=()=>scope.getStore();
/** Fail before transport if a child call escaped the frozen visual model. */
export function assertExactQwenRequestModel(requestBody:string){
 const current=scope.getStore();if(!current)return;
 let requested:unknown;try{requested=JSON.parse(requestBody).model;}catch{throw Error('weekly_candidate_model_request_unreadable');}
 if(requested!==current.model)throw Error('weekly_candidate_model_request_scope_changed');
}
/** Called after the exact request bytes are known and before a scoped POST.
 * Legacy/manual revision scopes retain their own admission contract; the
 * formal weekly exact-analysis scope opts into the strict paid guard. */
export async function authorizeExactQwenProviderRequest(requestBody:string){
 const current=scope.getStore();if(!current)return;
 assertExactQwenRequestModel(requestBody);
 if(current.paidGuardRequired&&!current.beforeProviderRequest)throw Error('weekly_candidate_exact_paid_permit_required');
 await current.beforeProviderRequest?.(requestBody);
}
/** Persist a minimal transport response envelope for both success and failure.
 * Never stores prompts, media, credentials, response bodies or error text. */
export async function recordExactQwenProviderResponse(response:Response,requestBody:string){
 const current=scope.getStore();if(!current?.onProviderReceipt)return;
 const responseBody=await response.clone().text();
 let payload:Record<string,unknown>={};try{const parsed=JSON.parse(responseBody);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))payload=parsed as Record<string,unknown>;}catch{}
 let requestModel:string|null=null;try{requestModel=String(JSON.parse(requestBody).model??'')||null;}catch{}
 const observedRequestId=[response.headers.get('x-request-id'),response.headers.get('x-acs-request-id'),payload.request_id]
  .find(value=>typeof value==='string'&&value.length>0&&value.length<=256&&/^[A-Za-z0-9._:-]+$/.test(value)) as string|undefined;
 await current.onProviderReceipt({provider:'qwen',responseId:typeof payload.id==='string'?payload.id:null,model:typeof payload.model==='string'?payload.model:null,
  usage:payload.usage??null,httpStatus:response.status,requestModel,requestHash:createHash('sha256').update(requestBody).digest('hex'),receivedAt:new Date().toISOString(),
  responseBodySha256:createHash('sha256').update(responseBody).digest('hex'),providerRequestId:observedRequestId??null});
}
/** Caller must first durably reserve a human-authorized revision operation. */
export const withExactQwenScope=<T>(binding:ExactScope,run:()=>Promise<T>)=>scope.run(binding,run);
