import {createHash} from 'node:crypto';
import type {SocialPaidOperationIntent} from '../lib/socialContentTaskBudgetAuthority.js';
import type {PaidOperationSubmission} from '../lib/socialContentPaidOperationPermit.js';
export interface MaterialAnalysisPaidCall {
 requirementKey:string;
 intent:SocialPaidOperationIntent;
 permit:{assertRecovery?:(operationId:string)=>Promise<unknown>;isProvenUnsubmitted?:(operationId:string)=>Promise<boolean>;beforeSubmit(request:PaidOperationSubmission):Promise<unknown>;markOutcome(operationId:string,status:'accepted'|'unknown'|'completed',receiptRef:string):Promise<unknown>};
 /** Trusted model-aware measurement/upper bound of this exact multimodal body.
  * No model-specific image token formula is guessed in the consumer. */
 measureInputTokens(body:Record<string,unknown>):Promise<number>;
 persistProviderReceipt(input:{requestSha256:string;response:unknown}):Promise<string>;
}
export interface MaterialAnalysisPaidContext {
 forRequest(input:{assetId:string;sourceSha256:string;stage:'material_image_analysis'|'material_video_analysis'|'material_video_review';batchIndex:number;provider:'qwen';model:string}):Promise<MaterialAnalysisPaidCall>;
}
export async function submitMaterialAnalysisPaidRequest<T>(body:Record<string,unknown>,call:MaterialAnalysisPaidCall,
 send:(body:Record<string,unknown>)=>Promise<T>):Promise<T>{
 const request=structuredClone(body);
 if(call.intent.provider!=='qwen'||request.model!==call.intent.model||!Number.isSafeInteger(request.max_tokens)||Number(request.max_tokens)<=0
  ||!Array.isArray(request.messages))throw Error('material_paid_request_binding_invalid');
 const inputTokens=await call.measureInputTokens(structuredClone(request));
 if(!Number.isSafeInteger(inputTokens)||inputTokens<=0)throw Error('material_paid_input_token_measurement_missing');
 const actualUnits:Record<string,number>={inputTokens,outputTokens:Number(request.max_tokens)};
 if('frames' in call.intent.maximumUnits) actualUnits.frames=(request.messages as Array<{content?:unknown}>).reduce((total,message)=>total+(Array.isArray(message.content)?message.content.filter((item:{type?:string})=>item.type==='image_url').length:0),0);
 if('requests' in call.intent.maximumUnits) actualUnits.requests=1;
 const keys=Object.keys(call.intent.maximumUnits).sort();
 if(JSON.stringify(keys)!==JSON.stringify(Object.keys(actualUnits).sort()))throw Error('material_paid_usage_dimensions_unsupported');
 const requestSha256=createHash('sha256').update(JSON.stringify(request)).digest('hex');
 const {maximumUnits:_,...binding}=call.intent;
 await call.permit.beforeSubmit({...binding,actualUnits});
 // The permit is unknown durably before any network call. Transport/parser/
 // receipt failures retain that charge and never authorize another POST.
 const response=await send(request);
 const receiptRef=await call.persistProviderReceipt({requestSha256,response});
 if(!receiptRef)throw Error('material_paid_provider_receipt_missing');
 await call.permit.markOutcome(call.intent.operationId,'completed',receiptRef);
 return response;
}
