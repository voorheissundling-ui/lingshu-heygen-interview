import {createHash} from 'node:crypto';
import {ECB_FX_URL,parseEcbUsdCny} from '../lib/heygenPublishedPricing.js';
import type {WeeklyAccountCollectionBudgetAuthorization} from './weeklyAccountCollectionBudget.js';
import type {WeeklyAccountCollectionProviderEvidence} from './weeklyAccountCollectionProviderEvidence.js';

export const APIFY_RUN_ACTOR_API_DOC_URL='https://docs.apify.com/api/v2/actors-runs-post';
export const APIFY_PUBLIC_PRICING_URL='https://apify.com/pricing';
const MAXIMUM_DATASET_BYTES=45*2_000_000;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const micros=(value:number)=>Math.ceil(value*1_000_000-1e-9);
const finite=(value:number)=>Number.isFinite(value)&&value>=0;

/**
 * Fixed request shape of the current five-video recovery implementation.  It
 * deliberately counts both independent mapping verification and the media
 * reader's revalidation; removing a GET from the implementation may lower a
 * future quote, but adding one must first change this contract and its tests.
 */
export const WEEKLY_ACCOUNT_COLLECTION_COST_MODEL=Object.freeze({
 candidateCount:5,
 maximumMediaBytesPerCandidate:100*1024*1024,
 datasetReads:1,
 keyValueStoreReads:0,
 keyValueStoreLists:0,
 /** A seven-day scenario, not a ceiling: paid-plan unnamed-store retention can
   * be longer, which is why retention control remains a hard requirement. */
  modeledTimedStorageGbHours:(MAXIMUM_DATASET_BYTES/1_000_000_000)*24*7,
 maximumExternalTransferGb:MAXIMUM_DATASET_BYTES/1_000_000_000,
});

export interface WeeklyAccountCollectionAuthenticatedCostFeasibility {
 schema:'weekly-account-collection-authenticated-cost-feasibility.v1';authorizationId:string;authorizationHash:string;providerEvidenceId:string;providerEvidenceHash:string;
 accountTier:string;dataRetentionDays:number;maximumStoredBytes:number;retentionStorageGbHours:number;nonRunCostUsd:number;availableRunCapUsd:number;requiredMinimumRunCapUsd:number;
 observedCnyPerUsd:number;authorizedLimitCny:number;fitsAuthorizedBudget:boolean;reason:'authenticated_cost_fits_observed_scenario'|'provider_minimum_exceeds_remaining_budget';
 permitsPaidCollection:false;
}
export interface WeeklyAccountCollectionFxObservation {schema:'weekly-account-collection-fx-observation.v1';authorizationId:string;authorizationHash:string;sourceUrl:typeof ECB_FX_URL;sourceSha256:string;rateDate:string;observedCnyPerUsd:number;checkedAt:string;validUntil:string;permitsPaidCollection:false}

/** Reprices the fixed five-video path against the authenticated account's
 * actual retention policy. This closes the old seven-day modeling error, but
 * remains a diagnostic: ECB spot is not a future FX ceiling and no spend or
 * provider operation is authorized here. */
export function evaluateWeeklyAccountCollectionAuthenticatedCostFeasibility(input:{authorization:WeeklyAccountCollectionBudgetAuthorization;providerEvidence:WeeklyAccountCollectionProviderEvidence;published:Pick<WeeklyAccountCollectionCostPreflight,'authorizationId'|'authorizationHash'|'observedCnyPerUsd'|'permitsPaidCollection'>}):WeeklyAccountCollectionAuthenticatedCostFeasibility|null{
 const {authorization:a,providerEvidence:p,published:q}=input;
 if(p.schema!=='weekly-account-provider-evidence.v2'||p.authorizationId!==a.authorizationId||p.authorizationHash!==a.recordHash||q.authorizationId!==a.authorizationId||q.authorizationHash!==a.recordHash||q.permitsPaidCollection!==false||p.permitsPaidCollection!==false||!Number.isSafeInteger(p.accountLimits.dataRetentionDays)||p.accountLimits.dataRetentionDays<1||p.provider.minimalMaxTotalChargeUsd===null||!finite(p.provider.minimalMaxTotalChargeUsd)||p.provider.minimalMaxTotalChargeUsd<=0)return null;
 const maximumMediaBytes=0,maximumStoredBytes=MAXIMUM_DATASET_BYTES;
 const retentionHours=24*p.accountLimits.dataRetentionDays,retentionStorageGbHours=maximumStoredBytes/1_000_000_000*retentionHours;
 const r=p.provider.accountServiceRatesUsd,u=WEEKLY_ACCOUNT_COLLECTION_COST_MODEL;
 const nonRunCostUsd=u.datasetReads*r.datasetRead+u.keyValueStoreReads*r.keyValueStoreRead+u.keyValueStoreLists*r.keyValueStoreList+MAXIMUM_DATASET_BYTES/1_000_000_000*retentionHours*r.datasetTimedStorageGbyteHour+maximumMediaBytes/1_000_000_000*retentionHours*r.keyValueStoreTimedStorageGbyteHour+u.maximumExternalTransferGb*r.externalDataTransferGbyte;
 const authorizedLimitCny=Math.min(a.totalLimitCny,a.perRunLimitCny),availableRunCapUsd=Math.floor((authorizedLimitCny/q.observedCnyPerUsd-nonRunCostUsd)*1_000_000)/1_000_000;
 const fitsAuthorizedBudget=availableRunCapUsd>=p.provider.minimalMaxTotalChargeUsd;
 return {schema:'weekly-account-collection-authenticated-cost-feasibility.v1',authorizationId:a.authorizationId,authorizationHash:a.recordHash,providerEvidenceId:p.evidenceId,providerEvidenceHash:p.recordHash,accountTier:p.provider.accountTier,dataRetentionDays:p.accountLimits.dataRetentionDays,maximumStoredBytes,retentionStorageGbHours,nonRunCostUsd,availableRunCapUsd,requiredMinimumRunCapUsd:p.provider.minimalMaxTotalChargeUsd,observedCnyPerUsd:q.observedCnyPerUsd,authorizedLimitCny,fitsAuthorizedBudget,reason:fitsAuthorizedBudget?'authenticated_cost_fits_observed_scenario':'provider_minimum_exceeds_remaining_budget',permitsPaidCollection:false};
}

export interface ApifyPublishedCostEvidence {
 schema:'apify-weekly-account-cost-evidence.v1';
 pricingSourceUrl:typeof APIFY_PUBLIC_PRICING_URL;pricingSourceBody:string;pricingSourceSha256:string;
 runApiSourceUrl:typeof APIFY_RUN_ACTOR_API_DOC_URL;runApiSourceBody:string;runApiSourceSha256:string;
 fxSourceUrl:typeof ECB_FX_URL;fxSourceBody:string;fxSourceSha256:string;
 checkedAt:string;validUntil:string;
}
export interface WeeklyAccountCollectionCostPreflight {
 schema:'weekly-account-collection-cost-preflight.v1';authorizationId:string;authorizationHash:string;
 modeledUsage:typeof WEEKLY_ACCOUNT_COLLECTION_COST_MODEL;
 publishedRatesUsd:{datasetReadsPer1000:number;keyValueStoreReadsPer1000:number;keyValueStoreListsPer1000:number;timedStoragePer1000GbHours:number;externalTransferPerGb:number};
 observedCnyPerUsd:number;modeledNonRunUsd:number;maximumRunChargeUsd:number;modeledTotalCny:number;
 actorRunUrl:string;evidenceRef:string;checkedAt:string;validUntil:string;
 /** Public prices and ECB spot conversion are useful preflight evidence, but
   * do not prove the card/account's eventual CNY conversion or Actor minimum.
   * Consequently this object can never itself mint a paid permit. */
 permitsPaidCollection:false;
 remainingRequirements:readonly ['verified_account_fx_ceiling','current_actor_minimum_charge_and_pricing','server_enforced_run_cap_receipt','post_run_storage_retention_control'];
}

function uniqueNumber(body:string,patterns:RegExp[]):number|null{
 for(const pattern of patterns){
  const values=[...body.matchAll(pattern)].map(match=>Number(match[1]));
  if(values.length===1&&finite(values[0]!)&&values[0]!>0)return values[0]!;
 }
 return null;
}
/** Parses only the public undiscounted/free-or-Starter columns. The source is
 * evidence for a conservative estimate, never an account-specific invoice. */
export function parseApifyPublicStorageRates(body:string){
 if(Buffer.byteLength(body)>4*1024*1024)return null;
 const normalized=body.replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ');
 const read=(label:string)=>uniqueNumber(normalized,[new RegExp(`${label}[^$]{0,160}\\$(\\d+(?:\\.\\d+)?)`,'gi')]);
 const datasetReadsPer1000=read('Dataset.{0,100}?1,?000 reads');
 const keyValueStoreReadsPer1000=read('Key-value store.{0,160}?1,?000 reads');
 const keyValueStoreListsPer1000=read('Key-value store.{0,220}?1,?000 lists');
 const timedStoragePer1000GbHours=read('Dataset.{0,100}?Timed storage 1,?000 GB-hours');
 const externalTransferPerGb=read('External ?/?GB');
 if([datasetReadsPer1000,keyValueStoreReadsPer1000,keyValueStoreListsPer1000,timedStoragePer1000GbHours,externalTransferPerGb].some(value=>value===null))return null;
 return {datasetReadsPer1000:datasetReadsPer1000!,keyValueStoreReadsPer1000:keyValueStoreReadsPer1000!,keyValueStoreListsPer1000:keyValueStoreListsPer1000!,timedStoragePer1000GbHours:timedStoragePer1000GbHours!,externalTransferPerGb:externalTransferPerGb!};
}

function runCapDocumented(body:string):boolean{
 if(Buffer.byteLength(body)>2*1024*1024)return false;
 const text=body.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
 return /maxTotalChargeUsd/.test(text)&&/maximum total cost of the run/i.test(text)&&/all pricing models/i.test(text);
}

/** Produces the strongest zero-account-mutation preflight possible from public
 * primary sources. The result remains fail-closed because neither public
 * pricing nor ECB spot rates establish this account's final CNY settlement. */
export function prepareWeeklyAccountCollectionPublishedCostPreflight(input:{authorization:WeeklyAccountCollectionBudgetAuthorization;evidence:ApifyPublishedCostEvidence;now?:Date}):WeeklyAccountCollectionCostPreflight|null{
 const {authorization:a,evidence:e}=input,now=input.now??new Date();
 if(e.schema!=='apify-weekly-account-cost-evidence.v1'||e.pricingSourceUrl!==APIFY_PUBLIC_PRICING_URL||e.runApiSourceUrl!==APIFY_RUN_ACTOR_API_DOC_URL||e.fxSourceUrl!==ECB_FX_URL||sha(e.pricingSourceBody)!==e.pricingSourceSha256||sha(e.runApiSourceBody)!==e.runApiSourceSha256||sha(e.fxSourceBody)!==e.fxSourceSha256||!Number.isFinite(Date.parse(e.checkedAt))||Date.parse(e.checkedAt)>now.getTime()||!Number.isFinite(Date.parse(e.validUntil))||Date.parse(e.validUntil)<=now.getTime()||Date.parse(e.validUntil)-Date.parse(e.checkedAt)>6*3600000||!runCapDocumented(e.runApiSourceBody))return null;
 const rates=parseApifyPublicStorageRates(e.pricingSourceBody),fx=parseEcbUsdCny(e.fxSourceBody,new Date(e.checkedAt));
 if(!rates||!fx||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<=now.getTime())return null;
 const u=WEEKLY_ACCOUNT_COLLECTION_COST_MODEL;
 const modeledNonRunUsd=u.datasetReads/1000*rates.datasetReadsPer1000+u.keyValueStoreReads/1000*rates.keyValueStoreReadsPer1000+u.keyValueStoreLists/1000*rates.keyValueStoreListsPer1000+u.modeledTimedStorageGbHours/1000*rates.timedStoragePer1000GbHours+u.maximumExternalTransferGb*rates.externalTransferPerGb;
 const cnyLimit=Math.min(a.totalLimitCny,a.perRunLimitCny),maximumRunChargeUsd=Math.floor((cnyLimit/fx.cnyPerUsd-modeledNonRunUsd)*1_000_000)/1_000_000;
 if(!(maximumRunChargeUsd>0))return null;
 const modeledTotalCny=(maximumRunChargeUsd+modeledNonRunUsd)*fx.cnyPerUsd;
 if(micros(modeledTotalCny)>micros(cnyLimit))return null;
 const actorRunUrl=`https://api.apify.com/v2/actors/${encodeURIComponent(a.actorId.replace('/','~'))}/runs?maxItems=5&maxTotalChargeUsd=${maximumRunChargeUsd.toFixed(6)}`;
 const evidenceRef='apify-published-cost-preflight:'+sha(JSON.stringify({authorizationHash:a.recordHash,evidence:e,modeledUsage:u,rates,fx,modeledNonRunUsd,maximumRunChargeUsd,actorRunUrl}));
 return {schema:'weekly-account-collection-cost-preflight.v1',authorizationId:a.authorizationId,authorizationHash:a.recordHash,modeledUsage:u,publishedRatesUsd:rates,observedCnyPerUsd:fx.cnyPerUsd,modeledNonRunUsd,maximumRunChargeUsd,modeledTotalCny,actorRunUrl,evidenceRef,checkedAt:e.checkedAt,validUntil:e.validUntil,permitsPaidCollection:false,remainingRequirements:['verified_account_fx_ceiling','current_actor_minimum_charge_and_pricing','server_enforced_run_cap_receipt','post_run_storage_retention_control']};
}

type OfficialResponse={url:string;status:number;body:string};
async function boundedOfficial(url:string):Promise<OfficialResponse>{
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Accept:'text/html,application/xml;q=0.9'}});
 if(response.url!==url||response.status!==200||!response.body)throw Error('weekly_account_collection_cost_source_unavailable');
 const reader=response.body.getReader(),chunks:Buffer[]=[];let length=0;
 try{for(;;){const value=await reader.read();if(value.done)break;length+=value.value.byteLength;if(length>4*1024*1024)throw Error('weekly_account_collection_cost_source_too_large');chunks.push(Buffer.from(value.value));}}
 finally{await reader.cancel().catch(()=>undefined);}
 return {url:response.url,status:response.status,body:Buffer.concat(chunks,length).toString('utf8')};
}

/** Account-specific rates come from the authenticated provider snapshot; this
 * reader supplies only the current primary-source USD/CNY observation. */
export async function readWeeklyAccountCollectionFxObservation(input:{authorization:WeeklyAccountCollectionBudgetAuthorization;fetchOfficial?:(url:string)=>Promise<OfficialResponse>;now?:()=>Date}):Promise<WeeklyAccountCollectionFxObservation|null>{
 const now=input.now?.()??new Date(),fetchOfficial=input.fetchOfficial??boundedOfficial;let response:OfficialResponse;
 try{response=await fetchOfficial(ECB_FX_URL);}catch{return null;}
 if(response.url!==ECB_FX_URL||response.status!==200)return null;
 const fx=parseEcbUsdCny(response.body,now);if(!fx)return null;
 return {schema:'weekly-account-collection-fx-observation.v1',authorizationId:input.authorization.authorizationId,authorizationHash:input.authorization.recordHash,sourceUrl:ECB_FX_URL,sourceSha256:sha(response.body),rateDate:fx.date,observedCnyPerUsd:fx.cnyPerUsd,checkedAt:now.toISOString(),validUntil:new Date(now.getTime()+6*3600000).toISOString(),permitsPaidCollection:false};
}

/** Runtime read adapter for public primary sources. It performs no Actor API
 * call, creates no durable authorization and cannot submit paid work. */
export async function readWeeklyAccountCollectionPublishedCostPreflight(input:{authorization:WeeklyAccountCollectionBudgetAuthorization;fetchOfficial?:(url:string)=>Promise<OfficialResponse>;now?:()=>Date}):Promise<WeeklyAccountCollectionCostPreflight|null>{
 const fetchOfficial=input.fetchOfficial??boundedOfficial,now=input.now?.()??new Date();let pricing:OfficialResponse,runApi:OfficialResponse,fx:OfficialResponse;
 try{[pricing,runApi,fx]=await Promise.all([fetchOfficial(APIFY_PUBLIC_PRICING_URL),fetchOfficial(APIFY_RUN_ACTOR_API_DOC_URL),fetchOfficial(ECB_FX_URL)]);}catch{return null;}
 if(pricing.url!==APIFY_PUBLIC_PRICING_URL||runApi.url!==APIFY_RUN_ACTOR_API_DOC_URL||fx.url!==ECB_FX_URL||[pricing.status,runApi.status,fx.status].some(status=>status!==200))return null;
 const checkedAt=now.toISOString(),validUntil=new Date(now.getTime()+6*3600000).toISOString();
 const evidence:ApifyPublishedCostEvidence={schema:'apify-weekly-account-cost-evidence.v1',pricingSourceUrl:APIFY_PUBLIC_PRICING_URL,pricingSourceBody:pricing.body,pricingSourceSha256:sha(pricing.body),runApiSourceUrl:APIFY_RUN_ACTOR_API_DOC_URL,runApiSourceBody:runApi.body,runApiSourceSha256:sha(runApi.body),fxSourceUrl:ECB_FX_URL,fxSourceBody:fx.body,fxSourceSha256:sha(fx.body),checkedAt,validUntil};
 return prepareWeeklyAccountCollectionPublishedCostPreflight({authorization:input.authorization,evidence,now});
}
