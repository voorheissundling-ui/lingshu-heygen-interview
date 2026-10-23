import {createHash} from 'node:crypto';
import {dashscopeApiKey} from '../agents/qwen.js';
export type WanImageVideoModel='wan2.6-i2v-flash'|'wan2.2-i2v-flash';
export interface WanImageVideoRequest {model:WanImageVideoModel;firstFrame:Buffer;mimeType:'image/jpeg'|'image/png';prompt:string;durationSeconds:number;firstFrameSha256:string;inputContractHash:string;}
export interface WanImageVideoCheckpoint {schemaVersion:1;requestSha256:string;accountRef:string;inputContractHash:string;status:'unknown'|'accepted'|'completed'|'failed';providerTaskId:string|null;providerReceipt?:unknown;mediaSha256?:string;}
export interface WanImageVideoPorts {
 readCheckpoint():Promise<WanImageVideoCheckpoint|null>;
 writeCheckpoint(value:WanImageVideoCheckpoint):Promise<void>;
 /** Whole-film permit is already reserved; exact request consumes its intent. */
 beforeSubmit(body:Record<string,unknown>,binding:{model:WanImageVideoModel;accountRef:string;providerSeconds:number}):Promise<void>;
 assertRecovery(checkpoint:WanImageVideoCheckpoint):Promise<void>;
 assertCurrent():Promise<void>;
 transport?:typeof fetch;
 credentials?:()=>{apiKey:string;baseUrl:string;credentialSha256:string};
}
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
function credentials(){const apiKey=dashscopeApiKey();return {baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',credentialSha256:sha(apiKey),apiKey};}
function binding(ports:WanImageVideoPorts){const config=ports.credentials?.()||credentials();const url=new URL(config.baseUrl);if(url.protocol!=='https:'||url.hostname!=='dashscope.aliyuncs.com'||url.pathname.replace(/\/+$/,'')!=='/compatible-mode/v1'||url.username||url.password||url.search||url.hash||sha(config.apiKey)!==config.credentialSha256)throw Error('wan_official_account_binding_invalid');return{...config,accountRef:'wan:'+sha(JSON.stringify({baseUrl:'https://dashscope.aliyuncs.com/api/v1',credentialSha256:config.credentialSha256}))};}
export function prepareWanImageVideoRequest(input:WanImageVideoRequest){
 if(!['wan2.6-i2v-flash','wan2.2-i2v-flash'].includes(input.model)||!input.firstFrame.length||input.firstFrame.length>(input.model==='wan2.6-i2v-flash'?20:10)*1024*1024||sha(input.firstFrame)!==input.firstFrameSha256||!/^[a-f0-9]{64}$/.test(input.inputContractHash)||!Number.isInteger(input.durationSeconds)||input.durationSeconds<2||input.durationSeconds>15||!input.prompt.trim()||input.prompt.length>(input.model==='wan2.6-i2v-flash'?1500:800))throw Error('wan_i2v_input_contract_invalid');
 const providerSeconds=input.model==='wan2.2-i2v-flash'?5:input.durationSeconds;
 return {providerSeconds,requiresExplicitTrim:providerSeconds!==input.durationSeconds,body:{model:input.model,input:{prompt:input.prompt,img_url:`data:${input.mimeType};base64,${input.firstFrame.toString('base64')}`},parameters:{resolution:'720P',duration:providerSeconds,prompt_extend:false,watermark:false,...(input.model==='wan2.6-i2v-flash'?{audio:false,shot_type:'single'}:{})}}};
}
/** One POST maximum. An ambiguous transport result remains unknown and can
 * never be resubmitted. Accepted invocations only GET the same task ID. */
export async function executeWanImageVideo(input:WanImageVideoRequest,ports:WanImageVideoPorts):Promise<{status:'pending';providerTaskId:string}|{status:'completed';providerTaskId:string;bytes:Buffer;mediaSha256:string;providerReceipt:unknown;requiresExplicitTrim:boolean;providerSeconds:number}>{
 const persist=async(value:WanImageVideoCheckpoint)=>{await ports.writeCheckpoint(value);const saved=await ports.readCheckpoint();if(!saved||sha(JSON.stringify(saved))!==sha(JSON.stringify(value)))throw Error('wan_checkpoint_not_persisted');};
 await ports.assertCurrent();const prepared=prepareWanImageVideoRequest(input),config=binding(ports),requestSha256=sha(JSON.stringify(prepared.body));
 let checkpoint=await ports.readCheckpoint();
 if(checkpoint){if(checkpoint.schemaVersion!==1||checkpoint.requestSha256!==requestSha256||checkpoint.accountRef!==config.accountRef||checkpoint.inputContractHash!==input.inputContractHash)throw Error('wan_recovery_contract_changed');await ports.assertRecovery(checkpoint);if(checkpoint.status==='unknown'||!checkpoint.providerTaskId)throw Error('wan_submission_unknown_no_resubmit');if(checkpoint.status==='failed')throw Error('wan_provider_failed_no_resubmit');}
 const fetcher=ports.transport||fetch;
 const call=async(url:string,init:RequestInit)=>{await ports.assertCurrent();const current=binding(ports);if(current.accountRef!==config.accountRef)throw Error('wan_account_changed');const response=await fetcher(url,{...init,headers:{...init.headers,Authorization:'Bearer '+current.apiKey},signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('wan_provider_http_'+response.status);return response.json() as Promise<any>;};
 if(!checkpoint){await ports.beforeSubmit(prepared.body,{model:input.model,accountRef:config.accountRef,providerSeconds:prepared.providerSeconds});checkpoint={schemaVersion:1,requestSha256,accountRef:config.accountRef,inputContractHash:input.inputContractHash,status:'unknown',providerTaskId:null};await persist(checkpoint);
 const raw=await call('https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',{method:'POST',headers:{'Content-Type':'application/json','X-DashScope-Async':'enable'},body:JSON.stringify(prepared.body)});const id=raw?.output?.task_id;if(typeof id!=='string'||!id.trim())throw Error('wan_submission_unknown_no_resubmit');checkpoint={...checkpoint,status:'accepted',providerTaskId:id,providerReceipt:raw};await persist(checkpoint);}
 const raw=await call('https://dashscope.aliyuncs.com/api/v1/tasks/'+encodeURIComponent(checkpoint.providerTaskId!),{method:'GET'});const output=raw?.output;
 if(output?.task_id&&output.task_id!==checkpoint.providerTaskId)throw Error('wan_provider_task_changed');
 if(['FAILED','CANCELED'].includes(output?.task_status)){await persist({...checkpoint,status:'failed',providerReceipt:raw});throw Error('wan_provider_generation_failed');}
 if(output?.task_status!=='SUCCEEDED')return{status:'pending',providerTaskId:checkpoint.providerTaskId!};
 if(typeof output.video_url!=='string'||!output.video_url.startsWith('https://'))throw Error('wan_provider_video_missing');await ports.assertCurrent();const response=await fetcher(output.video_url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('wan_video_download_failed');const reader=response.body?.getReader();if(!reader)throw Error('wan_video_download_empty');const chunks:Buffer[]=[];let total=0;for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>256*1024*1024){await reader.cancel();throw Error('wan_video_download_too_large');}chunks.push(Buffer.from(part.value));}const bytes=Buffer.concat(chunks);if(!bytes.length)throw Error('wan_video_download_empty');const mediaSha256=sha(bytes);if(checkpoint.mediaSha256&&checkpoint.mediaSha256!==mediaSha256)throw Error('wan_recovery_media_changed');await persist({...checkpoint,status:'completed',mediaSha256,providerReceipt:raw});return{status:'completed',providerTaskId:checkpoint.providerTaskId!,bytes,mediaSha256,providerReceipt:raw,requiresExplicitTrim:prepared.requiresExplicitTrim,providerSeconds:prepared.providerSeconds};
}
