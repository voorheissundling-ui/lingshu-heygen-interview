import {createHash} from 'node:crypto';
import type {SocialPaidOperationIntent,SocialVerifiedAccountTariff} from './socialContentTaskBudgetAuthority.js';
export const SEEDREAM_OFFICIAL_PRICE_URL='https://docs.volcengine.com/api/doc/getDocDetail?LibraryCode=ark&DocumentCode=model-pricing';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const text=(zone:any)=>Array.isArray(zone?.ops)?zone.ops.map((o:any)=>typeof o.insert==='string'&&o.insert!=='*'?o.insert:'').join('').trim():null;
export interface SeedreamPublishedPricingEvidence {schemaVersion:1;basis:'published_undiscounted_ceiling';provider:'seedream';model:string;region:'cn-beijing';generationMode:'single_image';inputPriceCnyPerImage:number;outputCeilingCnyPerImage:number;firstInputFree:boolean;sourceUrl:string;sourceBody:string;sourceResponseSha256:string;sourceContentSha256:string;sourceUpdatedAt:string;checkedAt:string;validUntil:string;accountRef:string;providerBinding:{baseUrl:string;credentialSha256:string};}
export type SeedreamPublishedTariff=Omit<SocialVerifiedAccountTariff,'publicPricingEvidence'>&{publicPricingEvidence:SeedreamPublishedPricingEvidence};
/** Only cells referenced by the current published document table qualify.
 * MDContent may lag and detached editor cells must not be mistaken for tariffs. */
export function parseSeedreamPublishedPricing(body:string,model:string){
 if(Buffer.byteLength(body)>5*1024*1024||!/^doubao-seedream-5-0-(pro-260628|flash-260915)$/.test(model))return null;
 let row:any,document:any;try{row=JSON.parse(body).Result;document=JSON.parse(row.Content);}catch{return null;}
 if(row.DocumentCode!=='model-pricing'||row.LibraryCode!=='ark'||row.Title!=='模型价格'||row.Status!==2||row.Language!=='zh'||!Number.isFinite(Date.parse(row.UpdatedTime))||document.version!=='0.4.24'||!document.data?.['0']?.ops)return null;
 const data=document.data;const matches:Array<{input:string;output:string}>=[];
 for(const op of data['0'].ops){const ref=op.attributes?.aceTable;if(typeof ref!=='string')continue;const ids=ref.split(' ');if(ids.length!==2)continue;
  const rowZone=data[ids[0]],colZone=data[ids[1]];if(rowZone?.zoneType!=='R'||colZone?.zoneType!=='C')continue;
  const rows=rowZone.ops?.map((o:any)=>o.insert?.id),cols=colZone.ops?.map((o:any)=>o.insert?.id);if(!Array.isArray(rows)||!Array.isArray(cols)||cols.length!==3)continue;
  const cells=(rid:string)=>cols.map((cid:string)=>text(data['x'+rid+'x'+cid]));const headers=cells(rows[0]);if(headers.join('|')!=='模型名称|输入图单价（元/张）|输出图单价（元/张）')continue;
  for(const rid of rows.slice(1)){const values=cells(rid);if(values[0]?.split('\n')[0]!==model.replace(/-\d{6}$/,''))continue;if(typeof values[1]!=='string'||typeof values[2]!=='string')return null;matches.push({input:values[1],output:values[2]});}
 }
 if(matches.length!==1)return null;const found=matches[0]!;
 if(model.includes('-pro-')){
  const input=found.input.match(/^首张免费\s*第\s*2\s*张起：\s*(\d+(?:\.\d+)?)$/);const output=found.output.match(/^单图生成场景：\s*≤\s*261\s*万像素（分辨率\s*1\.5K\s*及以下）：\s*(\d+(?:\.\d+)?)\s*>\s*261\s*万像素（分辨率\s*1\.5K\s*以上）：\s*(\d+(?:\.\d+)?)\s*图层拆分场景：[\s\S]+$/);
  if(!input||!output)return null;const inputPriceCnyPerImage=Number(input[1]),outputCeilingCnyPerImage=Math.max(Number(output[1]),Number(output[2]));if(!Number.isFinite(inputPriceCnyPerImage)||inputPriceCnyPerImage<0||!Number.isFinite(outputCeilingCnyPerImage)||outputCeilingCnyPerImage<=0)return null;
  return{inputPriceCnyPerImage,outputCeilingCnyPerImage,firstInputFree:true,sourceContentSha256:sha(row.Content),sourceUpdatedAt:row.UpdatedTime as string};
 }
 if(found.input!=='免费'||!/^\d+(?:\.\d+)?$/.test(found.output)||Number(found.output)<=0)return null;return{inputPriceCnyPerImage:0,outputCeilingCnyPerImage:Number(found.output),firstInputFree:true,sourceContentSha256:sha(row.Content),sourceUpdatedAt:row.UpdatedTime as string};
}
export async function readSeedreamPublishedTariff(intent:SocialPaidOperationIntent,binding:{baseUrl:string;credentialSha256:string;fetchOfficial?:(url:string)=>Promise<{url:string;status:number;body:string}>;now?:()=>Date}):Promise<SeedreamPublishedTariff|null>{
 if(intent.provider!=='seedream'||intent.stage!=='first_frame'||Object.keys(intent.maximumUnits).sort().join(',')!=='inputImages,outputImages'||intent.maximumUnits.outputImages!==1||binding.baseUrl.replace(/\/+$/,'')!=='https://ark.cn-beijing.volces.com/api/v3'||!/^[a-f0-9]{64}$/.test(binding.credentialSha256))return null;
 const accountRef='seedream:'+sha(JSON.stringify({baseUrl:binding.baseUrl.replace(/\/+$/,''),credentialSha256:binding.credentialSha256}));if(intent.accountRef!==accountRef)return null;
 const fetcher=binding.fetchOfficial||(async(url:string)=>{const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});const reader=response.body?.getReader();if(!reader)return{url:response.url,status:response.status,body:''};const chunks:Buffer[]=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>5*1024*1024){await reader.cancel();throw Error('official_price_source_too_large');}chunks.push(Buffer.from(part.value));}return{url:response.url,status:response.status,body:Buffer.concat(chunks).toString('utf8')};});
 let source;try{source=await fetcher(SEEDREAM_OFFICIAL_PRICE_URL);}catch{return null;}if(source.status!==200||source.url!==SEEDREAM_OFFICIAL_PRICE_URL)return null;const parsed=parseSeedreamPublishedPricing(source.body,intent.model);if(!parsed)return null;
 const checkedAt=(binding.now?.()||new Date()).toISOString();if(Date.parse(parsed.sourceUpdatedAt)>Date.parse(checkedAt))return null;
 const evidence:SeedreamPublishedPricingEvidence={schemaVersion:1,basis:'published_undiscounted_ceiling',provider:'seedream',model:intent.model,region:'cn-beijing',generationMode:'single_image',...parsed,sourceUrl:source.url,sourceBody:source.body,sourceResponseSha256:sha(source.body),providerBinding:{baseUrl:binding.baseUrl,credentialSha256:binding.credentialSha256},accountRef,checkedAt,validUntil:new Date(Date.parse(checkedAt)+6*3600000).toISOString()};
 // Counting every reference at the later-image rate is a conservative ceiling;
 // the first free input is retained as evidence, not falsely reported billed.
 return{provider:'seedream',model:intent.model,stage:intent.stage,accountRef,currency:'CNY',verifiedAccountPrice:false,pricingBasis:'published_undiscounted_ceiling',publicPricingEvidence:evidence,evidenceRef:'official-public-tariff:'+sha(JSON.stringify(evidence)),checkedAt,validUntil:evidence.validUntil,meters:{inputImages:{priceCny:parsed.inputPriceCnyPerImage,unitsPerPrice:1,minimumUnits:0,increment:1},outputImages:{priceCny:parsed.outputCeilingCnyPerImage,unitsPerPrice:1,minimumUnits:0,increment:1}}};
}
export function verifySeedreamPublishedTariff(value:unknown):boolean{
 try{const t=value as SeedreamPublishedTariff,e=t.publicPricingEvidence;if(t.provider!=='seedream'||t.stage!=='first_frame'||t.currency!=='CNY'||t.verifiedAccountPrice!==false||t.pricingBasis!=='published_undiscounted_ceiling'||!e||e.schemaVersion!==1||e.basis!==t.pricingBasis||e.provider!==t.provider||e.model!==t.model||e.region!=='cn-beijing'||e.generationMode!=='single_image'||e.accountRef!==t.accountRef||e.checkedAt!==t.checkedAt||e.validUntil!==t.validUntil||e.sourceUrl!==SEEDREAM_OFFICIAL_PRICE_URL||sha(e.sourceBody)!==e.sourceResponseSha256||e.providerBinding.baseUrl.replace(/\/+$/,'')!=='https://ark.cn-beijing.volces.com/api/v3'||!/^[a-f0-9]{64}$/.test(e.providerBinding.credentialSha256)||t.accountRef!=='seedream:'+sha(JSON.stringify({baseUrl:e.providerBinding.baseUrl.replace(/\/+$/,''),credentialSha256:e.providerBinding.credentialSha256}))||Date.parse(e.validUntil)-Date.parse(e.checkedAt)>6*3600000||Date.parse(e.validUntil)<=Date.parse(e.checkedAt)||Date.parse(e.sourceUpdatedAt)>Date.parse(e.checkedAt))return false;
  const parsed=parseSeedreamPublishedPricing(e.sourceBody,t.model);if(!parsed||Object.entries(parsed).some(([key,v])=>e[key as keyof SeedreamPublishedPricingEvidence]!==v)||t.evidenceRef!=='official-public-tariff:'+sha(JSON.stringify(e))||Object.keys(t.meters).sort().join(',')!=='inputImages,outputImages')return false;
  return ['inputImages','outputImages'].every(unit=>{const meter=t.meters[unit];return meter?.priceCny===(unit==='inputImages'?e.inputPriceCnyPerImage:e.outputCeilingCnyPerImage)&&meter.unitsPerPrice===1&&meter.minimumUnits===0&&meter.increment===1;});
 }catch{return false;}
}
