import {createHash} from 'node:crypto';
import type {SocialPaidOperationIntent,SocialVerifiedAccountTariff} from './socialContentTaskBudgetAuthority.js';
import {classifyQwenCompatibleEndpoint} from './qwenCompatibleEndpoint.js';
import {qwenVisionInputLimit} from './qwenVisionInputLimit.js';
export interface PublishedPricingEvidence {
 schemaVersion:1;basis:'published_undiscounted_ceiling';provider:'qwen';model:string;region:'cn-beijing';accountRef:string;
 sourceUrl:string;sourceBody:string;sourceResponseSha256:string;sourceContentSha256:string;checkedAt:string;validUntil:string;providerBinding:{baseUrl:string;credentialSha256:string};
 inputPriceCnyPerMillion:number;outputPriceCnyPerMillion:number;
}
export interface LocalPublishedPricingEvidence {
 schemaVersion:2;basis:'published_undiscounted_ceiling';provider:'qwen';model:string;region:'cn-beijing';accountRef:string;
 catalogVersion:string;sourceUrl:string;sourceUpdatedAt:string;catalogValidForMs:number;catalogEntrySha256:string;checkedAt:string;validUntil:string;
 providerBinding:{baseUrl:string;credentialSha256:string};inputPriceCnyPerMillion:number;outputPriceCnyPerMillion:number;
}
/** Qianwen MaaS has its own published price list; Alibaba Model Studio's
 * similarly named model is deliberately not interchangeable. */
export interface MaaSPublishedPricingEvidence {
 schemaVersion:3;basis:'published_undiscounted_ceiling';provider:'qwen';model:'qwen3-vl-plus';accountRef:string;
 catalogVersion:string;sourceUrl:string;sourceCheckedAt:string;catalogEntrySha256:string;checkedAt:string;validUntil:string;
 providerBinding:{baseUrl:string;credentialSha256:string};maximumInputTokens:number;
 tiers:ReadonlyArray<{maximumInputTokens:number;inputPriceCnyPerMillion:number;outputPriceCnyPerMillion:number}>;
 inputPriceCnyPerMillion:number;outputPriceCnyPerMillion:number;
}
export type PublishedAccountTariff=SocialVerifiedAccountTariff&{pricingBasis:'published_undiscounted_ceiling';publicPricingEvidence:PublishedPricingEvidence};
export type LocalPublishedAccountTariff=SocialVerifiedAccountTariff&{pricingBasis:'published_undiscounted_ceiling';publicPricingEvidence:LocalPublishedPricingEvidence};
export type MaaSPublishedAccountTariff=SocialVerifiedAccountTariff&{pricingBasis:'published_undiscounted_ceiling';publicPricingEvidence:MaaSPublishedPricingEvidence};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/**
 * Published prices are copied into the tenant's durable tariff catalogue and
 * used as a conservative ceiling. Production must not depend on reloading the
 * vendor documentation for every film. Ninety days keeps the catalogue useful
 * across normal production while still requiring periodic evidence refresh.
 */
export const QWEN_PUBLISHED_TARIFF_VALIDITY_MS=90*24*3600000;
export const QWEN_LOCAL_TARIFF_CATALOG_VERSION='qwen-cn-beijing-2026-10-12-v1';
export const QWEN_MAAS_TARIFF_CATALOG_VERSION='qwen-maas-qwen3-vl-plus-2026-10-19-v1';
const QWEN_MAAS_SOURCE_URL='https://www.qianwenai.com/models/qwen3-vl-plus#pricing';
const QWEN_MAAS_CATALOG_CHECKED_AT='2026-10-18T16:00:00.000Z';
const QWEN_MAAS_TIERS_INTERNAL=Object.freeze([
 Object.freeze({maximumInputTokens:32768,inputPriceCnyPerMillion:1,outputPriceCnyPerMillion:10}),
 Object.freeze({maximumInputTokens:131072,inputPriceCnyPerMillion:1.5,outputPriceCnyPerMillion:15}),
 Object.freeze({maximumInputTokens:262144,inputPriceCnyPerMillion:3,outputPriceCnyPerMillion:30}),
] as const);
export type QwenMaaSPublishedTier=(typeof QWEN_MAAS_TIERS_INTERNAL)[number];
export interface VerifiedQwenMaaSPricingPolicy{
 schema:'verified-qwen-maas-pricing-policy.v1';evidence:MaaSPublishedPricingEvidence;verifiedAt:string;validUntilMs:number;verificationHash:string;
}
const VERIFIED_QWEN_MAAS_POLICIES=new WeakSet<object>();
export const qwenMaaSPublishedTiers=():ReadonlyArray<QwenMaaSPublishedTier>=>QWEN_MAAS_TIERS_INTERNAL.map(tier=>({...tier}));
const qwenMaaSPricingPolicyIdentity=(schema:VerifiedQwenMaaSPricingPolicy['schema'],evidence:MaaSPublishedPricingEvidence,validUntilMs:number)=>
 sha(JSON.stringify({schema,evidence,validUntilMs}));

function inspectQwenMaaSPublishedPricingEvidence(evidence:MaaSPublishedPricingEvidence,input:{baseUrl:string;credentialSha256:string}){
 try{
  const normalizedBaseUrl=input.baseUrl.replace(/\/+$/,''),checked=Date.parse(evidence.checkedAt),validUntil=Date.parse(evidence.validUntil);
  if(evidence.schemaVersion!==3||evidence.basis!=='published_undiscounted_ceiling'||evidence.provider!=='qwen'||evidence.model!=='qwen3-vl-plus'||
   evidence.catalogVersion!==QWEN_MAAS_TARIFF_CATALOG_VERSION||evidence.sourceUrl!==QWEN_MAAS_SOURCE_URL||
   evidence.sourceCheckedAt!==QWEN_MAAS_CATALOG_CHECKED_AT||evidence.checkedAt!==evidence.sourceCheckedAt||
   !Number.isFinite(checked)||!Number.isFinite(validUntil)||validUntil-checked!==QWEN_PUBLISHED_TARIFF_VALIDITY_MS||
   evidence.catalogEntrySha256!==sha(maaSCatalogEntry())||evidence.maximumInputTokens!==qwenVisionInputLimit(evidence.model)||
   JSON.stringify(evidence.tiers)!==JSON.stringify(QWEN_MAAS_TIERS_INTERNAL)||evidence.inputPriceCnyPerMillion!==3||evidence.outputPriceCnyPerMillion!==30||
   classifyQwenCompatibleEndpoint(normalizedBaseUrl)!=='qianwen-maas'||input.credentialSha256!==evidence.providerBinding.credentialSha256||
   !/^[a-f0-9]{64}$/.test(input.credentialSha256)||evidence.providerBinding.baseUrl.replace(/\/+$/,'')!==normalizedBaseUrl||
   evidence.accountRef!==`qwen:${sha(JSON.stringify({baseUrl:normalizedBaseUrl,credentialSha256:input.credentialSha256}))}`)return null;
  const frozenEvidence=structuredClone(evidence);Object.freeze(frozenEvidence.providerBinding);
  for(const tier of frozenEvidence.tiers)Object.freeze(tier);Object.freeze(frozenEvidence.tiers);Object.freeze(frozenEvidence);
  const schema='verified-qwen-maas-pricing-policy.v1' as const;
  return {frozenEvidence,checked,validUntil,pricingPolicyHash:qwenMaaSPricingPolicyIdentity(schema,frozenEvidence,validUntil)};
 }catch{return null;}
}

/** Structural verification for settlement/recovery of requests already
 * durably claimed while the catalogue was live. This deliberately returns no
 * WeakSet-backed pricing capability and cannot authorize a new request. */
export function verifyQwenMaaSPublishedPricingEvidenceForHistoricalSettlement(evidence:MaaSPublishedPricingEvidence,input:{baseUrl:string;credentialSha256:string}){
 const inspected=inspectQwenMaaSPublishedPricingEvidence(evidence,input);if(!inspected)return null;
 return Object.freeze({schema:'verified-qwen-maas-historical-settlement-pricing.v1' as const,
  evidenceHash:sha(JSON.stringify(inspected.frozenEvidence)),pricingPolicyHash:inspected.pricingPolicyHash,
  validFromMs:inspected.checked,validUntilMs:inspected.validUntil});
}

/** Select only from the reviewed, immutable MaaS catalogue embedded in the
 * supplied evidence. Callers must never recreate these brackets locally. */
export function selectQwenMaaSPublishedTier(
 inputTokens:number,policy:VerifiedQwenMaaSPricingPolicy,
):QwenMaaSPublishedTier|null{
 if(!Number.isSafeInteger(inputTokens)||inputTokens<0||!VERIFIED_QWEN_MAAS_POLICIES.has(policy)||policy.schema!=='verified-qwen-maas-pricing-policy.v1'||
  Date.now()<Date.parse(policy.evidence.checkedAt)||Date.now()>=policy.validUntilMs||
  policy.verificationHash!==qwenMaaSPricingPolicyIdentity(policy.schema,policy.evidence,policy.validUntilMs))return null;
 return QWEN_MAAS_TIERS_INTERNAL.find(tier=>inputTokens<=tier.maximumInputTokens)||null;
}
const maaSCatalogEntry=()=>JSON.stringify({catalogVersion:QWEN_MAAS_TARIFF_CATALOG_VERSION,sourceUrl:QWEN_MAAS_SOURCE_URL,sourceCheckedAt:QWEN_MAAS_CATALOG_CHECKED_AT,model:'qwen3-vl-plus',basis:'standard_online_undiscounted',tiers:QWEN_MAAS_TIERS_INTERNAL});
export function verifyQwenMaaSPublishedPricingEvidence(evidence:MaaSPublishedPricingEvidence,input:{
 baseUrl:string;credentialSha256:string;
}):VerifiedQwenMaaSPricingPolicy|null{
 try{const inspected=inspectQwenMaaSPublishedPricingEvidence(evidence,input),now=Date.now();if(!inspected||!Number.isFinite(now)||now<inspected.checked||now>=inspected.validUntil)return null;
  const frozenEvidence=inspected.frozenEvidence,schema='verified-qwen-maas-pricing-policy.v1' as const,verifiedAt=new Date(now).toISOString(),validUntilMs=inspected.validUntil;
  const policy=Object.freeze({schema,evidence:frozenEvidence,verifiedAt,validUntilMs,
   // This is a durable policy identity, not an observation timestamp. A
   // restart must rebuild the same identity from the same frozen evidence,
   // while the capability itself is still short-lived and checked against
   // the module clock on every tier selection.
   verificationHash:inspected.pricingPolicyHash});
  VERIFIED_QWEN_MAAS_POLICIES.add(policy);return policy;
 }catch{return null;}
}
const QWEN_LOCAL_TARIFF_CATALOG_UPDATED_AT='2026-10-12T00:00:00.000Z';
const QWEN_LOCAL_TARIFF_CATALOG={
 'qwen3-vl-flash':{inputPriceCnyPerMillion:.6,outputPriceCnyPerMillion:6,sourceUrl:'https://help.aliyun.com/zh/model-studio/qwen3-vl-flash'},
 'qwen3-vl-plus':{inputPriceCnyPerMillion:3,outputPriceCnyPerMillion:30,sourceUrl:'https://help.aliyun.com/zh/model-studio/qwen3-vl-plus'},
} as const;
const canonicalCatalogEntry=(model:keyof typeof QWEN_LOCAL_TARIFF_CATALOG)=>JSON.stringify({catalogVersion:QWEN_LOCAL_TARIFF_CATALOG_VERSION,model,region:'cn-beijing',sourceUpdatedAt:QWEN_LOCAL_TARIFF_CATALOG_UPDATED_AT,catalogValidForMs:QWEN_PUBLISHED_TARIFF_VALIDITY_MS,...QWEN_LOCAL_TARIFF_CATALOG[model]});
const text=(s:string)=>s.replace(/<[^>]*>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,'').trim();
const valid=(n:number)=>Number.isFinite(n)&&n>0;
/** Parse the official model page's JSON data, never execute vendor scripts.
 * Region is selected inside the model-price section; cache/batch/free prices
 * are never accepted as standard online inference prices. */
export function parseOfficialQwenPublishedPrices(body:string,model:string){
 if(body.length>5*1024*1024)return null;
 const match=body.match(/window\.__ICE_PAGE_PROPS__=(\{[\s\S]*?\});/);if(!match)return null;
 let row:Record<string,unknown>;try{row=JSON.parse(match[1]!).docDetailData.storeData.data;}catch{return null;}
 if(row.title!==model||row.alias!==`/model-studio/${model}`||row.website!=='cn'||row.language!=='zh'||typeof row.content!=='string')return null;
 const content=row.content,priceStart=content.search(/<h2[^>]*>模型价格\b|<h2[^>]*>模型价格\s/);if(priceStart<0)return null;
 const after=content.slice(priceStart),next=after.indexOf('<h2',4),prices=next<0?after:after.slice(0,next);
 const start=prices.search(/<section\b[^>]*id="华北2-北京(?:-\d+)?"/);if(start<0)return null;
 const tags=/<\/?section\b[^>]*>/g;tags.lastIndex=start;let depth=0,end=-1;
 for(let token=tags.exec(prices);token;token=tags.exec(prices)){if(token[0].startsWith('</'))depth--;else depth++;if(depth===0){end=tags.lastIndex;break;}}
 if(end<0)return null;const region=prices.slice(start,end);
 const inputs:number[]=[],outputs:number[]=[];
 for(const table of region.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/g)){
  const html=table[1]!;const headers=[...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(m=>text(m[1]!));
  if(headers.join('|')!=='计费项|价格（元）|单位'){if(headers.includes('计费项'))return null;continue;}
  for(const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)){
   const cells=[...tr[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m=>text(m[1]!));
   if(cells.length!==3||!['输入','输出'].includes(cells[0]!)||!/^每百万tokens$/i.test(cells[2]!))continue;
   if(!/^\d+(?:\.\d+)?$/.test(cells[1]!))return null;const amount=Number(cells[1]);if(!valid(amount))return null;(cells[0]==='输入'?inputs:outputs).push(amount);
  }
 }
 if(!inputs.length||inputs.length!==outputs.length)return null;
 return {inputPriceCnyPerMillion:Math.max(...inputs),outputPriceCnyPerMillion:Math.max(...outputs),sourceContentSha256:sha(content)};
}
/** Re-parse the actual public document; a caller flag or numeric env estimate
 * cannot qualify as published account-bound evidence. */
export function isVerifiedPublishedTariff(t:SocialVerifiedAccountTariff):boolean{
 try{
 const p=t as PublishedAccountTariff|LocalPublishedAccountTariff|MaaSPublishedAccountTariff,e=p.publicPricingEvidence;if(!/^qwen3-vl-(?:flash|plus)$|^qwen-vl-max$/.test(p.model)||p.pricingBasis!=='published_undiscounted_ceiling'||p.verifiedAccountPrice!==false||p.currency!=='CNY'||!e||![1,2,3].includes(e.schemaVersion)||e.basis!==p.pricingBasis||e.provider!==p.provider||e.model!==p.model||e.accountRef!==p.accountRef||e.checkedAt!==p.checkedAt||e.validUntil!==p.validUntil||!e.providerBinding)return false;
 if(e.schemaVersion===3){
  const m=e as MaaSPublishedPricingEvidence,b=m.providerBinding;
  if(p.model!=='qwen3-vl-plus'||classifyQwenCompatibleEndpoint(b.baseUrl)!=='qianwen-maas'||! /^[a-f0-9]{64}$/.test(b.credentialSha256))return false;
  const account=`qwen:${sha(JSON.stringify({baseUrl:b.baseUrl.replace(/\/+$/,''),credentialSha256:b.credentialSha256}))}`;
  if(account!==p.accountRef||m.sourceUrl!==QWEN_MAAS_SOURCE_URL||m.catalogVersion!==QWEN_MAAS_TARIFF_CATALOG_VERSION||m.sourceCheckedAt!==QWEN_MAAS_CATALOG_CHECKED_AT||m.catalogEntrySha256!==sha(maaSCatalogEntry())||JSON.stringify(m.tiers)!==JSON.stringify(QWEN_MAAS_TIERS_INTERNAL)||m.maximumInputTokens!==qwenVisionInputLimit('qwen3-vl-plus')||m.inputPriceCnyPerMillion!==3||m.outputPriceCnyPerMillion!==30||p.evidenceRef!==`local-qwen-maas-tariff:${m.catalogEntrySha256}`||m.checkedAt!==m.sourceCheckedAt||Date.parse(m.validUntil)-Date.parse(m.checkedAt)!==QWEN_PUBLISHED_TARIFF_VALIDITY_MS)return false;
  return Object.keys(p.meters).sort().join(',')==='inputTokens,outputTokens'&&['inputTokens','outputTokens'].every(unit=>{const meter=p.meters[unit];return meter&&meter.priceCny===(unit==='inputTokens'?3:30)&&meter.unitsPerPrice===1000000&&meter.minimumUnits===0&&meter.increment===1;});
 }
 if(e.region!=='cn-beijing'||e.sourceUrl!==`https://help.aliyun.com/zh/model-studio/${p.model}`)return false;
 // Alibaba Model Studio prices do not attest pricing on the separate
 // Qianwen MaaS account, even when the model ID is identical.
 const b=e.providerBinding;if(classifyQwenCompatibleEndpoint(b.baseUrl)!=='dashscope-legacy'||! /^[a-f0-9]{64}$/.test(b.credentialSha256))return false;
 const account=`qwen:${sha(JSON.stringify({baseUrl:b.baseUrl.replace(/\/+$/,''),credentialSha256:b.credentialSha256}))}`;if(account!==p.accountRef)return false;
 if(e.schemaVersion===1){const parsed=parseOfficialQwenPublishedPrices(e.sourceBody,p.model);if(!parsed||parsed.sourceContentSha256!==e.sourceContentSha256||parsed.inputPriceCnyPerMillion!==e.inputPriceCnyPerMillion||parsed.outputPriceCnyPerMillion!==e.outputPriceCnyPerMillion||p.evidenceRef!==`official-public-tariff:${sha(JSON.stringify(e))}`||Date.parse(e.validUntil)-Date.parse(e.checkedAt)>QWEN_PUBLISHED_TARIFF_VALIDITY_MS)return false;}
 else {const model=p.model as keyof typeof QWEN_LOCAL_TARIFF_CATALOG,entry=QWEN_LOCAL_TARIFF_CATALOG[model];if(!entry||e.catalogVersion!==QWEN_LOCAL_TARIFF_CATALOG_VERSION||e.sourceUpdatedAt!==QWEN_LOCAL_TARIFF_CATALOG_UPDATED_AT||e.catalogValidForMs!==QWEN_PUBLISHED_TARIFF_VALIDITY_MS||e.catalogEntrySha256!==sha(canonicalCatalogEntry(model))||e.sourceUrl!==entry.sourceUrl||e.inputPriceCnyPerMillion!==entry.inputPriceCnyPerMillion||e.outputPriceCnyPerMillion!==entry.outputPriceCnyPerMillion||e.checkedAt!==e.sourceUpdatedAt||Date.parse(e.validUntil)-Date.parse(e.sourceUpdatedAt)!==QWEN_PUBLISHED_TARIFF_VALIDITY_MS||p.evidenceRef!==`local-official-tariff-catalog:${e.catalogEntrySha256}`)return false;}
 if(Object.keys(p.meters).sort().join(',')!=='inputTokens,outputTokens')return false;
 return ['inputTokens','outputTokens'].every(unit=>{const m=p.meters[unit];return m&&m.priceCny===(unit==='inputTokens'?e.inputPriceCnyPerMillion:e.outputPriceCnyPerMillion)&&m.unitsPerPrice===1000000&&m.minimumUnits===0&&m.increment===1;});
 }catch{return false;}
}
/** Runtime reader for the reviewed local catalogue. It is intentionally
 * network-free; createSocialContentPublishedTariffReader remains the periodic
 * maintenance/import tool used to refresh the reviewed catalogue. */
export function createSocialContentLocalPublishedTariffReader(ports:{
 readProviderBinding(intent:SocialPaidOperationIntent):Promise<{provider:string;model:string;baseUrl:string;credentialSha256:string}|null>;now?:()=>Date;
}){
 return {async read(intent:SocialPaidOperationIntent):Promise<LocalPublishedAccountTariff|null>{
  const binding=await ports.readProviderBinding(intent),entry=QWEN_LOCAL_TARIFF_CATALOG[intent.model as keyof typeof QWEN_LOCAL_TARIFF_CATALOG];
  if(!binding||!entry||binding.provider!=='qwen'||intent.provider!=='qwen'||binding.model!==intent.model||!/^[a-f0-9]{64}$/.test(binding.credentialSha256)||Object.keys(intent.maximumUnits).sort().join(',')!=='inputTokens,outputTokens')return null;
  if(classifyQwenCompatibleEndpoint(binding.baseUrl)!=='dashscope-legacy')return null;
  const normalizedBaseUrl=binding.baseUrl.replace(/\/+$/,''),accountRef=`qwen:${sha(JSON.stringify({baseUrl:normalizedBaseUrl,credentialSha256:binding.credentialSha256}))}`;if(accountRef!==intent.accountRef)return null;
  const checkedAt=QWEN_LOCAL_TARIFF_CATALOG_UPDATED_AT,validUntil=new Date(Date.parse(checkedAt)+QWEN_PUBLISHED_TARIFF_VALIDITY_MS).toISOString();if((ports.now?.()||new Date()).getTime()>=Date.parse(validUntil))return null;
  const catalogEntrySha256=sha(canonicalCatalogEntry(intent.model as keyof typeof QWEN_LOCAL_TARIFF_CATALOG));
  const evidence:LocalPublishedPricingEvidence={schemaVersion:2,basis:'published_undiscounted_ceiling',provider:'qwen',model:intent.model,region:'cn-beijing',accountRef,catalogVersion:QWEN_LOCAL_TARIFF_CATALOG_VERSION,sourceUpdatedAt:QWEN_LOCAL_TARIFF_CATALOG_UPDATED_AT,catalogValidForMs:QWEN_PUBLISHED_TARIFF_VALIDITY_MS,catalogEntrySha256,checkedAt,validUntil,providerBinding:{baseUrl:binding.baseUrl,credentialSha256:binding.credentialSha256},...entry};
  const tariff:LocalPublishedAccountTariff={provider:intent.provider,model:intent.model,accountRef,stage:intent.stage,currency:'CNY',verifiedAccountPrice:false,pricingBasis:'published_undiscounted_ceiling',publicPricingEvidence:evidence,evidenceRef:`local-official-tariff-catalog:${catalogEntrySha256}`,checkedAt,validUntil,meters:{inputTokens:{priceCny:entry.inputPriceCnyPerMillion,unitsPerPrice:1000000,minimumUnits:0,increment:1},outputTokens:{priceCny:entry.outputPriceCnyPerMillion,unitsPerPrice:1000000,minimumUnits:0,increment:1}}};
  return isVerifiedPublishedTariff(tariff)?tariff:null;
 }};
}
/** Read-only Qianwen MaaS standard-online ceiling, limited to the verified
 * three input tiers. It never fetches prices or credentials at production time. */
export function createQwenMaaSPublishedTariffReader(ports:{
 readProviderBinding(intent:SocialPaidOperationIntent):Promise<{provider:string;model:string;baseUrl:string;credentialSha256:string}|null>;now?:()=>Date;
}){
 return {async read(intent:SocialPaidOperationIntent):Promise<MaaSPublishedAccountTariff|null>{
  const binding=await ports.readProviderBinding(intent);
  if(!binding||intent.provider!=='qwen'||intent.model!=='qwen3-vl-plus'||binding.provider!=='qwen'||binding.model!==intent.model||classifyQwenCompatibleEndpoint(binding.baseUrl)!=='qianwen-maas'||!/^[a-f0-9]{64}$/.test(binding.credentialSha256)||Object.keys(intent.maximumUnits).sort().join(',')!=='inputTokens,outputTokens')return null;
  const maximumInputTokens=intent.maximumUnits.inputTokens,maximumOutputTokens=intent.maximumUnits.outputTokens;
  if(!Number.isSafeInteger(maximumInputTokens)||maximumInputTokens<0||maximumInputTokens>qwenVisionInputLimit(intent.model)||!Number.isSafeInteger(maximumOutputTokens)||maximumOutputTokens<0||maximumOutputTokens>32768)return null;
  const normalizedBaseUrl=binding.baseUrl.replace(/\/+$/,''),accountRef=`qwen:${sha(JSON.stringify({baseUrl:normalizedBaseUrl,credentialSha256:binding.credentialSha256}))}`;
  if(accountRef!==intent.accountRef)return null;
  const checkedAt=QWEN_MAAS_CATALOG_CHECKED_AT,validUntil=new Date(Date.parse(checkedAt)+QWEN_PUBLISHED_TARIFF_VALIDITY_MS).toISOString();
  if((ports.now?.()||new Date()).getTime()>=Date.parse(validUntil))return null;
  const catalogEntrySha256=sha(maaSCatalogEntry());
  const evidence:MaaSPublishedPricingEvidence={schemaVersion:3,basis:'published_undiscounted_ceiling',provider:'qwen',model:'qwen3-vl-plus',accountRef,catalogVersion:QWEN_MAAS_TARIFF_CATALOG_VERSION,sourceUrl:QWEN_MAAS_SOURCE_URL,sourceCheckedAt:QWEN_MAAS_CATALOG_CHECKED_AT,catalogEntrySha256,checkedAt,validUntil,providerBinding:{baseUrl:binding.baseUrl,credentialSha256:binding.credentialSha256},maximumInputTokens:qwenVisionInputLimit(intent.model),tiers:qwenMaaSPublishedTiers(),inputPriceCnyPerMillion:3,outputPriceCnyPerMillion:30};
  const tariff:MaaSPublishedAccountTariff={provider:'qwen',model:intent.model,accountRef,stage:intent.stage,currency:'CNY',verifiedAccountPrice:false,pricingBasis:'published_undiscounted_ceiling',publicPricingEvidence:evidence,evidenceRef:`local-qwen-maas-tariff:${catalogEntrySha256}`,checkedAt,validUntil,meters:{inputTokens:{priceCny:3,unitsPerPrice:1000000,minimumUnits:0,increment:1},outputTokens:{priceCny:30,unitsPerPrice:1000000,minimumUnits:0,increment:1}}};
  return isVerifiedPublishedTariff(tariff)?tariff:null;
 }};
}
export function createSocialContentPublishedTariffReader(ports:{
 readProviderBinding(intent:SocialPaidOperationIntent):Promise<{provider:string;model:string;baseUrl:string;credentialSha256:string}|null>;
 fetchOfficial?:(url:string)=>Promise<{url:string;status:number;body:string}>;now?:()=>Date;
}){
 const fetchOfficial=ports.fetchOfficial||(async function(url:string){const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});const reader=response.body?.getReader();if(!reader)return{url:response.url,status:response.status,body:''};const chunks:Uint8Array[]=[];let bytes=0;for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>5*1024*1024){await reader.cancel();throw new Error('official_pricing_document_too_large');}chunks.push(part.value);}const body=Buffer.concat(chunks).toString('utf8');return{url:response.url,status:response.status,body};});
 return {async read(intent:SocialPaidOperationIntent):Promise<PublishedAccountTariff|null>{
  const binding=await ports.readProviderBinding(intent);if(!binding||binding.provider!=='qwen'||intent.provider!=='qwen'||binding.model!==intent.model||!/^[a-f0-9]{64}$/.test(binding.credentialSha256))return null;
  if(classifyQwenCompatibleEndpoint(binding.baseUrl)!=='dashscope-legacy')return null;
  const accountRef=`qwen:${sha(JSON.stringify({baseUrl:binding.baseUrl.replace(/\/+$/,''),credentialSha256:binding.credentialSha256},Object.keys({baseUrl:'',credentialSha256:''}).sort()))}`;
  if(accountRef!==intent.accountRef||!/^qwen3-vl-(?:flash|plus)$|^qwen-vl-max$/.test(intent.model)||Object.keys(intent.maximumUnits).sort().join(',')!=='inputTokens,outputTokens')return null;
  const url=`https://help.aliyun.com/zh/model-studio/${intent.model}`;
  let source:{url:string;status:number;body:string};try{source=await fetchOfficial(url);}catch{return null;}
  if(source.url!==url||source.status!==200)return null;
  const extracted=parseOfficialQwenPublishedPrices(source.body,intent.model);if(!extracted)return null;
  const checkedAt=(ports.now?.()||new Date()).toISOString(),validUntil=new Date(Date.parse(checkedAt)+QWEN_PUBLISHED_TARIFF_VALIDITY_MS).toISOString();
  const evidence:PublishedPricingEvidence={schemaVersion:1,basis:'published_undiscounted_ceiling',provider:'qwen',model:intent.model,region:'cn-beijing',accountRef,sourceUrl:url,sourceBody:source.body,providerBinding:{baseUrl:binding.baseUrl,credentialSha256:binding.credentialSha256},sourceResponseSha256:sha(source.body),...extracted,checkedAt,validUntil};
  return{provider:intent.provider,model:intent.model,accountRef,stage:intent.stage,currency:'CNY',verifiedAccountPrice:false,pricingBasis:'published_undiscounted_ceiling',publicPricingEvidence:evidence,evidenceRef:`official-public-tariff:${sha(JSON.stringify(evidence))}`,checkedAt,validUntil,meters:{inputTokens:{priceCny:extracted.inputPriceCnyPerMillion,unitsPerPrice:1000000,minimumUnits:0,increment:1},outputTokens:{priceCny:extracted.outputPriceCnyPerMillion,unitsPerPrice:1000000,minimumUnits:0,increment:1}}};
 }};
}
