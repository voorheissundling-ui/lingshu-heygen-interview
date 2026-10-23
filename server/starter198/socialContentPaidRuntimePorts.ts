import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {SocialTaskBudgetScope} from '../lib/socialContentTaskBudget.js';
import {createProductionBudgetRouteReaders} from './socialContentProductionBudgetRoutes.js';
import type {SocialMaterialPaidRuntimePorts} from './socialContentMaterialPaidContext.js';
import type {ProductPaidContext} from './socialContentProductPaidContext.js';
import {qwenVisionInputLimit} from '../lib/qwenVisionInputLimit.js';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Model accepted-context ceiling for this actual SDK request, not observed
 * billed usage or a copied intent maximum. Validate supported body/modalities
 * before applying the independently documented model envelope.
 * Sources: official model pages/context window, and
 * https://help.aliyun.com/zh/model-studio/vision-model/ . */
export async function measureQwenRequestInputUpperBound(body:Record<string,unknown>):Promise<number>{
 if(typeof body.model!=='string'||!/^(qwen3-vl-(flash|plus)|qwen-vl-max)(?:-\d{4}-\d{2}-\d{2})?$/.test(body.model)||!Array.isArray(body.messages)||!body.messages.length||body.messages.length>32)throw Error('qwen_request_token_bound_unsupported');
 if(Object.keys(body).some(k=>!['model','messages','max_tokens','temperature','top_p','enable_thinking','stream','response_format','vl_high_resolution_images'].includes(k)))throw Error('qwen_request_token_bound_extra_input');
 let count=0;const normalized=body.messages.map((raw:unknown)=>{
  if(!raw||typeof raw!=='object')throw Error('qwen_request_message_invalid');const message=raw as Record<string,unknown>;
  if(!['system','user','assistant'].includes(String(message.role))||Object.keys(message).some(k=>!['role','content'].includes(k)))throw Error('qwen_request_message_invalid');
  if(typeof message.content==='string')return message;
  if(!Array.isArray(message.content))throw Error('qwen_request_content_invalid');
  return {...message,content:message.content.map((rawPart:unknown)=>{
   if(!rawPart||typeof rawPart!=='object')throw Error('qwen_request_part_invalid');const part=rawPart as Record<string,unknown>;
   if(part.type==='text'&&typeof part.text==='string'&&Object.keys(part).every(k=>['type','text'].includes(k)))return part;
   if(part.type==='image_url'&&part.image_url&&typeof part.image_url==='object'&&Object.keys(part).every(k=>['type','image_url'].includes(k))){const image=part.image_url as Record<string,unknown>;if(typeof image.url!=='string'||!image.url||Object.keys(image).some(k=>!['url','detail','max_pixels'].includes(k)))throw Error('qwen_request_image_invalid');if(image.max_pixels!==undefined&&(!Number.isSafeInteger(image.max_pixels)||Number(image.max_pixels)<=0))throw Error('qwen_request_image_invalid');count++;return {type:'image_url',image_url:{url:'',detail:image.detail,max_pixels:image.max_pixels}};}
   throw Error('qwen_request_modality_unsupported');
  })};
 });
 const ceiling=qwenVisionInputLimit(body.model);
 if(!Number.isSafeInteger(body.max_tokens)||Number(body.max_tokens)<=0||Number(body.max_tokens)>ceiling||count===0||Buffer.byteLength(JSON.stringify({...body,messages:normalized}),'utf8')>ceiling)throw Error('qwen_request_input_exceeds_context');
 return ceiling;
}
export function createSocialContentPaidRuntimePorts(input:{scope:SocialTaskBudgetScope;receiptRoot?:string;assertCurrent:()=>Promise<void>;routes?:ReturnType<typeof createProductionBudgetRouteReaders>}){
 const routes=input.routes||createProductionBudgetRouteReaders();
 const material:SocialMaterialPaidRuntimePorts={assertProviderBinding:routes.assertProviderBinding,measureInputTokens:measureQwenRequestInputUpperBound,
  async persistProviderReceipt(receipt){
   await input.assertCurrent();if(!/^[a-f0-9]{64}$/.test(receipt.requestSha256)||receipt.response===undefined)throw Error('production_provider_receipt_invalid');
   const document={schemaVersion:1,scope:input.scope,requestSha256:receipt.requestSha256,response:receipt.response};const bytes=JSON.stringify(document);if(Buffer.byteLength(bytes)>8*1024*1024)throw Error('production_provider_receipt_too_large');
   const digest=sha(bytes),root=path.resolve(input.receiptRoot||process.env.SOCIAL_CONTENT_PROVIDER_RECEIPT_DIR||'data/social-content-provider-receipts'),file=path.join(root,digest+'.json');await fs.mkdir(root,{recursive:true,mode:0o700});
   try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   if(sha(await fs.readFile(file,'utf8'))!==digest)throw Error('production_provider_receipt_persistence_failed');await input.assertCurrent();return 'production-provider-receipt:'+digest;
  }};
 const product:Pick<ProductPaidContext,'assertProviderBinding'|'measureInputTokens'|'measureVideoOutputTokens'>={
  async assertProviderBinding(route){for(const stage of route.provider==='qwen'?['first_frame_qa','video_qa']:route.provider==='seedream'?['first_frame']:['video']){await routes.assertProviderBinding({...route,stage});}},
  measureInputTokens:body=>measureQwenRequestInputUpperBound(body),
 };
 return {material,product};
}
