import {createHash} from 'node:crypto';
import type {WanImageVideoModel} from './wanImageVideo.js';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const clean=(v:string)=>v.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,'').replace(/\s+/g,'');
export const WAN_OFFICIAL_PRICE_URL='https://help.aliyun.com/zh/model-studio/model-pricing';
export interface WanPublishedPricingEvidence {schemaVersion:1;basis:'published_undiscounted_ceiling';provider:'wan';model:WanImageVideoModel;region:'cn-beijing';resolution:'720P';audio:false;priceCnyPerSecond:number;sourceUrl:string;sourceBody:string;sourceResponseSha256:string;sourceContentSha256:string;checkedAt:string;validUntil:string;accountRef:string;credentialSha256:string;}
/** Expand actual HTML rowspan cells before selecting exact silent 720P SKU.
 * Free quotas, international prices and other video models never qualify. */
export function parseWanPublishedPricing(body:string,model:WanImageVideoModel){
 if(Buffer.byteLength(body)>5*1024*1024)return null;const match=body.match(/window\.__ICE_PAGE_PROPS__=(\{[\s\S]*?\});/);if(!match)return null;
 let row:any;try{row=JSON.parse(match[1]!).docDetailData.storeData.data;}catch{return null;}
 if(row.alias!=='/model-studio/model-pricing'||row.website!=='cn'||row.language!=='zh'||typeof row.content!=='string')return null;
 const content=row.content,start=content.indexOf('<h3 id="万相-图生视频-基于首帧"');if(start<0)return null;const after=content.slice(start),next=after.indexOf('<h3',4),section=next<0?after:after.slice(0,next);
 const regionStart=section.search(/<section\b[^>]*id="华北2-北京(?:-\d+)?"/);if(regionStart<0)return null;const tags=/<\/?section\b[^>]*>/g;tags.lastIndex=regionStart;let depth=0,end=-1;for(let t=tags.exec(section);t;t=tags.exec(section)){depth+=t[0].startsWith('</')?-1:1;if(depth===0){end=tags.lastIndex;break;}}if(end<0)return null;
 const region=section.slice(regionStart,end),tables=[...region.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)];if(tables.length!==1)return null;const table=tables[0]![1]!;
 const headers=[...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(m=>clean(m[1]!));if(headers.length!==5||headers.slice(0,4).join('|')!=='模型ID（ModelID）|输出视频类型|输出视频分辨率|输出单价')return null;
 const spans:Array<{remaining:number;value:string}|undefined>=[],prices:number[]=[];
 for(const tr of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)){
  const cells=[...tr[1]!.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)];if(!cells.length)continue;const expanded:string[]=[];let column=0;
  const inherited=()=>{while(spans[column]&&spans[column]!.remaining>0){expanded[column]=spans[column]!.value;spans[column]!.remaining--;column++;}};
  for(const cell of cells){inherited();const value=clean(cell[2]!),span=Number(cell[1]!.match(/rowspan="(\d+)"/)?.[1]||1);if(!Number.isSafeInteger(span)||span<1||span>20)return null;expanded[column]=value;spans[column]={remaining:span-1,value};column++;}inherited();
  if(expanded[0]!==model||!expanded[1]?.startsWith('无声视频')||expanded[2]!=='720P')continue;
  if(model==='wan2.6-i2v-flash'&&expanded[1]!=='无声视频audio=false')return null;const rate=expanded[3]?.match(/^(\d+(?:\.\d+)?)元\/秒$/);if(!rate)return null;const value=Number(rate[1]);if(!Number.isFinite(value)||value<=0)return null;prices.push(value);
 }
 if(prices.length!==1)return null;return{priceCnyPerSecond:prices[0]!,sourceContentSha256:sha(content)};
}
export function verifyWanPublishedPricing(e:WanPublishedPricingEvidence){try{return e.schemaVersion===1&&e.basis==='published_undiscounted_ceiling'&&e.provider==='wan'&&['wan2.6-i2v-flash','wan2.2-i2v-flash'].includes(e.model)&&e.sourceUrl===WAN_OFFICIAL_PRICE_URL&&e.region==='cn-beijing'&&e.resolution==='720P'&&e.audio===false&&/^[a-f0-9]{64}$/.test(e.credentialSha256)&&e.accountRef==='wan:'+sha(JSON.stringify({baseUrl:'https://dashscope.aliyuncs.com/api/v1',credentialSha256:e.credentialSha256}))&&sha(e.sourceBody)===e.sourceResponseSha256&&Date.parse(e.validUntil)>Date.parse(e.checkedAt)&&Date.parse(e.validUntil)-Date.parse(e.checkedAt)<=6*3600000&&(()=>{const parsed=parseWanPublishedPricing(e.sourceBody,e.model);return parsed?.priceCnyPerSecond===e.priceCnyPerSecond&&parsed?.sourceContentSha256===e.sourceContentSha256;})();}catch{return false;}}
export async function readWanPublishedPricing(input:{model:WanImageVideoModel;baseUrl:string;credentialSha256:string;fetchOfficial?:(url:string)=>Promise<{url:string;status:number;body:string}>;now?:()=>Date}):Promise<WanPublishedPricingEvidence|null>{
 if(input.baseUrl.replace(/\/+$/,'')!=='https://dashscope.aliyuncs.com/compatible-mode/v1'||!/^[a-f0-9]{64}$/.test(input.credentialSha256))return null;
 const transport=input.fetchOfficial|| (async(url:string)=>{const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});const reader=r.body?.getReader();if(!reader)return{url:r.url,status:r.status,body:''};const chunks:Buffer[]=[];let total=0;for(;;){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>5*1024*1024){await reader.cancel();throw Error('wan_official_pricing_too_large');}chunks.push(Buffer.from(part.value));}return{url:r.url,status:r.status,body:Buffer.concat(chunks).toString('utf8')};});
 let source;try{source=await transport(WAN_OFFICIAL_PRICE_URL);}catch{return null;}if(source.url!==WAN_OFFICIAL_PRICE_URL||source.status!==200)return null;const parsed=parseWanPublishedPricing(source.body,input.model);if(!parsed)return null;
 const checkedAt=(input.now?.()||new Date()).toISOString(),e:WanPublishedPricingEvidence={schemaVersion:1,basis:'published_undiscounted_ceiling',provider:'wan',model:input.model,region:'cn-beijing',resolution:'720P',audio:false,...parsed,sourceUrl:source.url,sourceBody:source.body,sourceResponseSha256:sha(source.body),checkedAt,validUntil:new Date(Date.parse(checkedAt)+6*3600000).toISOString(),credentialSha256:input.credentialSha256,accountRef:'wan:'+sha(JSON.stringify({baseUrl:'https://dashscope.aliyuncs.com/api/v1',credentialSha256:input.credentialSha256}))};return verifyWanPublishedPricing(e)?e:null;
}
export function verifyWanPublishedTariff(t:import('./socialContentTaskBudgetAuthority.js').SocialVerifiedAccountTariff){
 const evidence=t.publicPricingEvidence as WanPublishedPricingEvidence|undefined;return !!evidence&&t.provider==='wan'&&t.stage==='video'&&t.verifiedAccountPrice===false&&t.pricingBasis==='published_undiscounted_ceiling'&&t.currency==='CNY'&&evidence.model===t.model&&evidence.accountRef===t.accountRef&&evidence.checkedAt===t.checkedAt&&evidence.validUntil===t.validUntil&&verifyWanPublishedPricing(evidence)&&t.evidenceRef==='official-public-tariff:'+sha(JSON.stringify(evidence))&&Object.keys(t.meters).join(',')==='providerSeconds'&&t.meters.providerSeconds?.priceCny===evidence.priceCnyPerSecond&&t.meters.providerSeconds?.unitsPerPrice===1&&t.meters.providerSeconds?.minimumUnits===0&&t.meters.providerSeconds?.increment===1;
}
export async function readWanPublishedTariff(intent:import('./socialContentTaskBudgetAuthority.js').SocialPaidOperationIntent,binding:{baseUrl:string;credentialSha256:string;fetchOfficial?:(url:string)=>Promise<{url:string;status:number;body:string}>}){
 if(intent.provider!=='wan'||intent.stage!=='video'||!['wan2.6-i2v-flash','wan2.2-i2v-flash'].includes(intent.model)||Object.keys(intent.maximumUnits).join(',')!=='providerSeconds')return null;
 const evidence=await readWanPublishedPricing({model:intent.model as WanImageVideoModel,...binding});if(!evidence||evidence.accountRef!==intent.accountRef)return null;
 return {provider:'wan',model:intent.model,accountRef:intent.accountRef,stage:'video',currency:'CNY' as const,verifiedAccountPrice:false,pricingBasis:'published_undiscounted_ceiling' as const,publicPricingEvidence:evidence,evidenceRef:'official-public-tariff:'+sha(JSON.stringify(evidence)),checkedAt:evidence.checkedAt,validUntil:evidence.validUntil,meters:{providerSeconds:{priceCny:evidence.priceCnyPerSecond,unitsPerPrice:1,minimumUnits:0,increment:1}}};
}
