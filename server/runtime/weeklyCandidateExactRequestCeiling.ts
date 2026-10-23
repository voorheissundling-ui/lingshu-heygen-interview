import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {
 selectQwenMaaSPublishedTier,
 type QwenMaaSPublishedTier,
 type VerifiedQwenMaaSPricingPolicy,
} from '../lib/socialContentPublishedTariffs.js';
import {qwenVisionInputLimit} from '../lib/qwenVisionInputLimit.js';

export const WEEKLY_EXACT_PROTOCOL_TOKEN_RESERVE=8192;
export const WEEKLY_EXACT_REQUEST_CEILING_POLICY_VERSION='qwen3-vl-request-ceiling.v1';
const IMAGE_FACTOR=32;
const IMAGE_MIN_PIXELS=65_536;
const IMAGE_MAX_PIXELS=2_621_440;
const MAX_REQUEST_BYTES=64*1024*1024;
const MAX_IMAGE_BYTES=20*1024*1024;
const MAX_TOTAL_IMAGE_BYTES=32*1024*1024;
const MAX_IMAGES=100;
const MAX_DIMENSION=32_768;
const MAX_ASPECT_RATIO=200;
const MAX_DECODE_PIXELS=25_000_000;
const MAX_OUTPUT_TOKENS=16_384;
const MODEL='qwen3-vl-plus';

export type WeeklyExactRequestFallbackReason=
 |'request_schema_unknown'|'image_url_unsupported'|'image_data_invalid'
 |'image_mime_mismatch'|'image_dimensions_invalid'|'image_limit_exceeded';

export interface WeeklyExactRequestCeiling{
 schema:'weekly-candidate-exact-request-ceiling.v1';
 requestBodySha256:string;
 pricingPolicyHash:string;
 measurementPolicyHash:string;
 protocolReserveTokens:number;
 nonImageUtf8ByteCeiling:number;
 visualTokenCeiling:number;
 inputTokenCeiling:number;
 outputTokenCeiling:number;
 selectedTier:QwenMaaSPublishedTier;
 inputPriceCnyPerMillion:number;
 outputPriceCnyPerMillion:number;
 reservedMicros:number;
 imageCount:number;
 fallbackReason:WeeklyExactRequestFallbackReason|null;
}

type Json=string|number|boolean|null|Json[]|{[key:string]:Json};
type ParsedImage={mime:'image/jpeg'|'image/png'|'image/webp';bytes:Buffer};
type WalkResult={sanitized:Json;images:ParsedImage[]};

const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const measurementPolicyHash=sha(JSON.stringify({version:WEEKLY_EXACT_REQUEST_CEILING_POLICY_VERSION,model:MODEL,
 protocolReserveTokens:WEEKLY_EXACT_PROTOCOL_TOKEN_RESERVE,imageFactor:IMAGE_FACTOR,minPixels:IMAGE_MIN_PIXELS,
 maxPixels:IMAGE_MAX_PIXELS,maxImages:MAX_IMAGES,maxImageBytes:MAX_IMAGE_BYTES,maxTotalImageBytes:MAX_TOTAL_IMAGE_BYTES,
 maxDimension:MAX_DIMENSION,maxAspectRatio:MAX_ASPECT_RATIO,maxDecodePixels:MAX_DECODE_PIXELS,maxOutputTokens:MAX_OUTPUT_TOKENS,
 visualTokenFormula:'resized_height*resized_width/(32*32)+2',textTokenCeiling:'utf8_byte_per_token',
 sourceUrl:'https://docs.modelstudio.console.alibabacloud.com/en/model-studio/vision'}));
/** Stable identity only; possession of this hash grants no pricing capability. */
export const weeklyCandidateExactMeasurementPolicyHash=()=>measurementPolicyHash;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value:Record<string,unknown>,allowed:readonly string[])=>Object.keys(value).every(key=>allowed.includes(key));
function parseCanonicalImage(value:string):ParsedImage|null{
 const match=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
 if(!match||match[2]!.length%4!==0)return null;
 const bytes=Buffer.from(match[2]!,'base64');
 if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==match[2])return null;
 return {mime:match[1] as ParsedImage['mime'],bytes};
}
function sanitizeRequest(body:unknown):WalkResult|WeeklyExactRequestFallbackReason{
 if(!record(body)||!exactKeys(body,['model','messages','response_format','temperature','max_tokens'])||body.model!==MODEL||
  !Array.isArray(body.messages)||!body.messages.length||!record(body.response_format)||
  !exactKeys(body.response_format,['type'])||body.response_format.type!=='json_object'||
  (body.temperature!==undefined&&(typeof body.temperature!=='number'||!Number.isFinite(body.temperature))))return 'request_schema_unknown';
 const output=body.max_tokens;
 const images:ParsedImage[]=[];
 let totalImageBytes=0;
 const messages:Json[]=[];
 for(const message of body.messages){
  if(!record(message)||!exactKeys(message,['role','content'])||!['system','user','assistant','tool'].includes(String(message.role)))return 'request_schema_unknown';
  if(typeof message.content==='string')messages.push({role:String(message.role),content:message.content});
  else if(Array.isArray(message.content)){
   const content:Json[]=[];
   for(const part of message.content){
    if(!record(part)||typeof part.type!=='string')return 'request_schema_unknown';
    if(part.type==='text'){
     if(!exactKeys(part,['type','text'])||typeof part.text!=='string')return 'request_schema_unknown';
     content.push({type:'text',text:part.text});
    }else if(part.type==='image_url'){
     if(!exactKeys(part,['type','image_url'])||!record(part.image_url)||!exactKeys(part.image_url,['url'])||typeof part.image_url.url!=='string')return 'request_schema_unknown';
     if(!part.image_url.url.startsWith('data:image/'))return 'image_url_unsupported';
     const parsed=parseCanonicalImage(part.image_url.url);if(!parsed)return 'image_data_invalid';
     totalImageBytes+=parsed.bytes.length;if(totalImageBytes>MAX_TOTAL_IMAGE_BYTES)return 'image_limit_exceeded';
     images.push(parsed);if(images.length>MAX_IMAGES)return 'image_limit_exceeded';
     content.push({type:'image_url',image_url:{url:`data:${parsed.mime};base64,`}});
    }else return 'request_schema_unknown';
   }
   messages.push({role:String(message.role),content});
  }else return 'request_schema_unknown';
 }
 const sanitized:Record<string,Json>={model:MODEL,messages,response_format:{type:'json_object'},max_tokens:Number(output)};
 if(body.temperature!==undefined)sanitized.temperature=body.temperature as number;
 return {sanitized,images};
}
function smartResizeTokens(height:number,width:number):number|null{
 if(!Number.isSafeInteger(height)||!Number.isSafeInteger(width)||height<=10||width<=10||height>MAX_DIMENSION||width>MAX_DIMENSION||
  Math.max(height/width,width/height)>MAX_ASPECT_RATIO)return null;
 let resizedHeight=Math.round(height/IMAGE_FACTOR)*IMAGE_FACTOR;
 let resizedWidth=Math.round(width/IMAGE_FACTOR)*IMAGE_FACTOR;
 const pixels=height*width;
 if(resizedHeight*resizedWidth>IMAGE_MAX_PIXELS){
  const beta=Math.sqrt(pixels/IMAGE_MAX_PIXELS);
  resizedHeight=Math.floor(height/beta/IMAGE_FACTOR)*IMAGE_FACTOR;
  resizedWidth=Math.floor(width/beta/IMAGE_FACTOR)*IMAGE_FACTOR;
 }else if(resizedHeight*resizedWidth<IMAGE_MIN_PIXELS){
  const beta=Math.sqrt(IMAGE_MIN_PIXELS/pixels);
  resizedHeight=Math.ceil(height*beta/IMAGE_FACTOR)*IMAGE_FACTOR;
  resizedWidth=Math.ceil(width*beta/IMAGE_FACTOR)*IMAGE_FACTOR;
 }
 if(resizedHeight<=0||resizedWidth<=0||resizedHeight*resizedWidth>IMAGE_MAX_PIXELS||resizedHeight*resizedWidth<IMAGE_MIN_PIXELS)return null;
 return resizedHeight*resizedWidth/(IMAGE_FACTOR*IMAGE_FACTOR)+2;
}
function decimalThousandths(value:number):bigint|null{
 if(!Number.isFinite(value)||value<=0)return null;
 const scaled=value*1000;if(!Number.isSafeInteger(scaled))return null;
 return BigInt(scaled);
}
function reserveMicros(inputTokens:number,outputTokens:number,tier:QwenMaaSPublishedTier):number|null{
 const inputRate=decimalThousandths(tier.inputPriceCnyPerMillion),outputRate=decimalThousandths(tier.outputPriceCnyPerMillion);
 if(inputRate===null||outputRate===null)return null;
 const numerator=BigInt(inputTokens)*inputRate+BigInt(outputTokens)*outputRate;
 const micros=(numerator+999n)/1000n;
 return micros<=BigInt(Number.MAX_SAFE_INTEGER)?Number(micros):null;
}
function fallback(requestBodySha256:string,outputTokenCeiling:number,pricingPolicy:VerifiedQwenMaaSPricingPolicy,
 reason:WeeklyExactRequestFallbackReason):WeeklyExactRequestCeiling{
 const inputTokenCeiling=qwenVisionInputLimit(MODEL),selectedTier=selectQwenMaaSPublishedTier(inputTokenCeiling,pricingPolicy);
 if(!selectedTier)throw Error('weekly_exact_pricing_policy_unverified');
 const reservedMicros=reserveMicros(inputTokenCeiling,outputTokenCeiling,selectedTier);
 if(reservedMicros===null)throw Error('weekly_exact_price_overflow');
 return {schema:'weekly-candidate-exact-request-ceiling.v1',requestBodySha256,pricingPolicyHash:pricingPolicy.verificationHash,measurementPolicyHash,
  protocolReserveTokens:WEEKLY_EXACT_PROTOCOL_TOKEN_RESERVE,nonImageUtf8ByteCeiling:0,visualTokenCeiling:0,
  inputTokenCeiling,outputTokenCeiling,selectedTier,inputPriceCnyPerMillion:selectedTier.inputPriceCnyPerMillion,
  outputPriceCnyPerMillion:selectedTier.outputPriceCnyPerMillion,reservedMicros,imageCount:0,fallbackReason:reason};
}

/** Deterministic, network-free conservative ceiling for one frozen Qwen MaaS
 * chat-completions request. Image decoding only inspects the supplied bytes. */
export async function measureWeeklyCandidateExactRequestCeiling(input:{
 requestBody:string;pricingPolicy:VerifiedQwenMaaSPricingPolicy;
}):Promise<WeeklyExactRequestCeiling>{
 const requestBodySha256=sha(input.requestBody);
 if(!selectQwenMaaSPublishedTier(qwenVisionInputLimit(MODEL),input.pricingPolicy))throw Error('weekly_exact_pricing_policy_unverified');
 if(Buffer.byteLength(input.requestBody)>MAX_REQUEST_BYTES)throw Error('weekly_exact_request_too_large');
 let body:unknown;try{body=JSON.parse(input.requestBody);}catch{throw Error('weekly_exact_request_json_invalid');}
 if(!record(body)||!Number.isSafeInteger(body.max_tokens)||Number(body.max_tokens)<1||Number(body.max_tokens)>MAX_OUTPUT_TOKENS)
  throw Error('weekly_exact_request_output_limit_invalid');
 const output=Number(body.max_tokens);
 const walked=sanitizeRequest(body);
 if(walked==='request_schema_unknown')throw Error('weekly_exact_request_schema_unknown');
 if(typeof walked==='string')return fallback(requestBodySha256,output,input.pricingPolicy,walked);
 if(walked.images.reduce((sum,image)=>sum+image.bytes.length,0)>MAX_TOTAL_IMAGE_BYTES)return fallback(requestBodySha256,output,input.pricingPolicy,'image_limit_exceeded');
 let visualTokenCeiling=0;
 for(const image of walked.images){
  let metadata:{format?:string;width?:number;height?:number;pages?:number;pageHeight?:number};
  try{metadata=await sharp(image.bytes,{failOn:'error',limitInputPixels:MAX_DECODE_PIXELS,animated:true}).metadata();}
  catch{return fallback(requestBodySha256,output,input.pricingPolicy,'image_data_invalid');}
  if((metadata.pages??1)!==1||metadata.pageHeight!==undefined&&metadata.height!==metadata.pageHeight)
   return fallback(requestBodySha256,output,input.pricingPolicy,'image_dimensions_invalid');
  const actualMime=metadata.format==='jpeg'?'image/jpeg':metadata.format==='png'?'image/png':metadata.format==='webp'?'image/webp':null;
  if(actualMime!==image.mime)return fallback(requestBodySha256,output,input.pricingPolicy,'image_mime_mismatch');
  const tokens=smartResizeTokens(Number(metadata.height),Number(metadata.width));
  if(tokens===null)return fallback(requestBodySha256,output,input.pricingPolicy,'image_dimensions_invalid');
  visualTokenCeiling+=tokens;
 }
 const nonImageUtf8ByteCeiling=Buffer.byteLength(JSON.stringify(walked.sanitized));
 const computed=nonImageUtf8ByteCeiling+visualTokenCeiling+WEEKLY_EXACT_PROTOCOL_TOKEN_RESERVE;
 if(!Number.isSafeInteger(computed)||computed>qwenVisionInputLimit(MODEL))throw Error('weekly_exact_request_model_input_limit_exceeded');
 const selectedTier=selectQwenMaaSPublishedTier(computed,input.pricingPolicy);
 if(!selectedTier)throw Error('weekly_exact_pricing_policy_unverified');
 const reservedMicros=reserveMicros(computed,output,selectedTier);if(reservedMicros===null)throw Error('weekly_exact_price_overflow');
 return {schema:'weekly-candidate-exact-request-ceiling.v1',requestBodySha256,pricingPolicyHash:input.pricingPolicy.verificationHash,measurementPolicyHash,
  protocolReserveTokens:WEEKLY_EXACT_PROTOCOL_TOKEN_RESERVE,nonImageUtf8ByteCeiling,visualTokenCeiling,
  inputTokenCeiling:computed,outputTokenCeiling:output,selectedTier,inputPriceCnyPerMillion:selectedTier.inputPriceCnyPerMillion,
  outputPriceCnyPerMillion:selectedTier.outputPriceCnyPerMillion,reservedMicros,imageCount:walked.images.length,fallbackReason:null};
}
