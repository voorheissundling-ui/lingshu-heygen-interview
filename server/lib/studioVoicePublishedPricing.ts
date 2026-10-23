import {createHash} from 'node:crypto';
import type {SocialPaidOperationIntent,SocialVerifiedAccountTariff} from './socialContentTaskBudgetAuthority.js';
import {productionBillingAccountRef} from '../starter198/socialContentProductionBudgetRoutes.js';
import {getQwenAsrProviderBinding,getQwenProviderBinding} from '../agents/qwen.js';
const sourceUrl='https://help.aliyun.com/zh/model-studio/model-pricing';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const plain=(s:string)=>s.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,'');
export function parseOfficialNativeVoicePrice(body:string,model:string) {
 if(Buffer.byteLength(body)>5*1024*1024||!['qwen3-tts-flash','qwen3-asr-flash','qwen3-asr-flash-filetrans'].includes(model))return null;
 const match=body.match(/window\.__ICE_PAGE_PROPS__=(\{[\s\S]*?\});/);if(!match)return null;
 let data:any;try{data=JSON.parse(match[1]!).docDetailData.storeData.data;}catch{return null;}
 if(data.alias!=='/model-studio/model-pricing'||data.website!=='cn'||data.language!=='zh'||typeof data.content!=='string')return null;
 const html=data.content as string;
 // Select the actual mainland pricing subsection, never overseas, realtime,
 // token-based models or trial allowances. Preserve inherited ASR price cells.
 const start=html.indexOf(model==='qwen3-tts-flash'?'id="千问3-tts-flash"':'id="千问asr"');
 if(start<0)return null;
 const ends=[html.indexOf('id="新加坡',start),html.indexOf('id="美国',start)].filter(i=>i>start);const region=html.slice(start,ends.length?Math.min(...ends):undefined);
 if(model==='qwen3-tts-flash'&&!plain(region).includes('每万字符'))return null;
 if(model.startsWith('qwen3-asr-flash')&&!plain(region).includes('按输入音频的秒数计费'))return null;
 for(const table of region.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)){
  let inheritedPrice:number|null=null;
  for(const row of table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)){
   const cells=[...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m=>plain(m[1]!));
   if(!cells.length)continue;
   const price=cells.slice(1).find(c=>/^\d+(?:\.\d+)?元(?:\/秒)?$/.test(c));
   if(price)inheritedPrice=Number(price.match(/^\d+(?:\.\d+)?/)![0]);
   if(cells[0]!==model)continue;
   if(!inheritedPrice||!Number.isFinite(inheritedPrice))return null;
   return {unit:model==='qwen3-tts-flash'?'characters':'audioSeconds',priceCny:inheritedPrice,unitsPerPrice:model==='qwen3-tts-flash'?10000:1,contentSha256:sha(html)};
  }
 }
 return null;
}
interface VoiceEvidence {schemaVersion:1;sourceUrl:string;sourceBody:string;sourceSha256:string;contentSha256:string;binding:{baseUrl:string;credentialSha256:string};checkedAt:string;validUntil:string;}
type VoiceTariff=SocialVerifiedAccountTariff&{nativeVoicePublishedEvidence:VoiceEvidence};
function bindingFor(intent:SocialPaidOperationIntent) {
 if(intent.provider!=='qwen')return null;
 if(intent.stage==='tts'&&intent.model==='qwen3-tts-flash') {
  const key=process.env.DASHSCOPE_API_KEY||'',baseUrl=process.env.DASHSCOPE_TTS_ENDPOINT||'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  if(!key.trim()||baseUrl!=='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'||(process.env.QWEN_TTS_MODEL||'qwen3-tts-flash')!==intent.model)return null;
  return {baseUrl,credentialSha256:sha(key)};
 }
 if(intent.stage==='voice_alignment'&&intent.model==='qwen3-asr-flash-filetrans') {
  try{const b=getQwenProviderBinding(),base=(process.env.DASHSCOPE_ASR_BASE_URL||'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/,'');if(base!=='https://dashscope.aliyuncs.com/api/v1')return null;return {baseUrl:base+'/services/audio/asr/transcription',credentialSha256:b.credentialSha256};}catch{return null;}
 }
 if(intent.stage==='voice_asr'&&intent.model==='qwen3-asr-flash') {
  try {const b=getQwenAsrProviderBinding();if(b.baseUrl!=='https://dashscope.aliyuncs.com/compatible-mode/v1'||(process.env.QWEN_ASR_MODEL||'qwen3-asr-flash')!==intent.model)return null;return b;}catch{return null;}
 }
 return null;
}
export function verifyNativeVoicePublishedTariff(t:SocialVerifiedAccountTariff):boolean {
 try {
  const e=(t as VoiceTariff).nativeVoicePublishedEvidence;
  if(!e||e.schemaVersion!==1||t.provider!=='qwen'||t.pricingBasis!=='published_undiscounted_ceiling'||t.verifiedAccountPrice!==false||t.currency!=='CNY'||e.sourceUrl!==sourceUrl||sha(e.sourceBody)!==e.sourceSha256||e.checkedAt!==t.checkedAt||e.validUntil!==t.validUntil||Date.parse(e.validUntil)-Date.parse(e.checkedAt)>6*3600000)return false;
  const expected=t.model==='qwen3-tts-flash'?'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation':t.model==='qwen3-asr-flash'?'https://dashscope.aliyuncs.com/compatible-mode/v1':t.model==='qwen3-asr-flash-filetrans'?'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription':null;
  if(!expected||e.binding.baseUrl!==expected||t.accountRef!==productionBillingAccountRef('qwen',expected,e.binding.credentialSha256)||t.stage!==(t.model==='qwen3-tts-flash'?'tts':t.model==='qwen3-asr-flash-filetrans'?'voice_alignment':'voice_asr'))return false;
  const p=parseOfficialNativeVoicePrice(e.sourceBody,t.model);if(!p||p.contentSha256!==e.contentSha256||Object.keys(t.meters).join(',')!==p.unit)return false;
  const m=t.meters[p.unit];return !!m&&m.priceCny===p.priceCny&&m.unitsPerPrice===p.unitsPerPrice&&m.increment===1&&m.minimumUnits===0&&t.evidenceRef==='official-native-voice:'+sha(JSON.stringify(e));
 }catch{return false;}
}
export async function readNativeVoicePublishedTariff(intent:SocialPaidOperationIntent,ports:{readBinding?:(intent:SocialPaidOperationIntent)=>{baseUrl:string;credentialSha256:string}|null;fetchOfficial?:(url:string)=>Promise<{url:string;status:number;body:string}>;now?:()=>Date}={}):Promise<SocialVerifiedAccountTariff|null> {
 const binding=(ports.readBinding||bindingFor)(intent);if(!binding||productionBillingAccountRef(intent.provider,binding.baseUrl,binding.credentialSha256)!==intent.accountRef)return null;
 const unit=intent.model==='qwen3-tts-flash'?'characters':intent.model.startsWith('qwen3-asr-flash')?'audioSeconds':null;
 if(!unit||Object.keys(intent.maximumUnits).join(',')!==unit)return null;
 let source:{url:string;status:number;body:string};try {
  source=await (ports.fetchOfficial|| (async url=>{const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});const reader=r.body?.getReader();if(!reader)throw Error('official_voice_price_body_missing');let bytes=0;const parts:Uint8Array[]=[];for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>5*1024*1024){await reader.cancel();throw Error('official_voice_price_too_large');}parts.push(p.value);}return {url:r.url,status:r.status,body:Buffer.concat(parts).toString('utf8')};}))(sourceUrl);
 }catch{return null;}
 if(source.url!==sourceUrl||source.status!==200)return null;
 const parsed=parseOfficialNativeVoicePrice(source.body,intent.model);if(!parsed)return null;
 const checkedAt=(ports.now?.()||new Date()).toISOString(),validUntil=new Date(Date.parse(checkedAt)+6*3600000).toISOString();
 const evidence:VoiceEvidence={schemaVersion:1,sourceUrl,sourceBody:source.body,sourceSha256:sha(source.body),contentSha256:parsed.contentSha256,binding,checkedAt,validUntil};
 const tariff:VoiceTariff={provider:intent.provider,model:intent.model,stage:intent.stage,accountRef:intent.accountRef,currency:'CNY',verifiedAccountPrice:false,pricingBasis:'published_undiscounted_ceiling',evidenceRef:'official-native-voice:'+sha(JSON.stringify(evidence)),checkedAt,validUntil,nativeVoicePublishedEvidence:evidence,meters:{[parsed.unit]:{priceCny:parsed.priceCny,unitsPerPrice:parsed.unitsPerPrice,minimumUnits:0,increment:1}}};
 return verifyNativeVoicePublishedTariff(tariff)?tariff:null;
}
