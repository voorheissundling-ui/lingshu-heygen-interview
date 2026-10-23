import {createHash} from 'node:crypto';

type JsonObject=Record<string,unknown>;
const object=(value:unknown):JsonObject|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:null;
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Read-only provider evidence. This is deliberately not a spending permit:
 * Actor prices alone do not bound dataset reads/transfer or USD→CNY conversion. */
export interface WeeklyApifyPpePreflight {
  actorId:string;
  observedAt:string;
  actorResponseHash:string;
  accountResponseHash:string;
  pricingRecordHash:string;
  pricingStartedAt:string;
  pricingModel:'PAY_PER_EVENT';
  accountTier:string;
  eventPricesUsd:Record<string,number>;
  accountServiceRatesUsd:{datasetRead:number;keyValueStoreRead:number;keyValueStoreList:number;datasetTimedStorageGbyteHour:number;keyValueStoreTimedStorageGbyteHour:number;externalDataTransferGbyte:number};
  minimalMaxTotalChargeUsd:number|null;
  actorPermissionLevel:'LIMITED_PERMISSIONS'|'FULL_PERMISSIONS'|'UNVERIFIED';
  agiPrepaidCompatibleByPermission:boolean;
}

/** An account-wide billing-cycle observation, not a weekly or per-run permit.
 * Other actors and storage traffic share this limit; a GET cannot reserve any
 * of its observed headroom for this collection. */
export interface WeeklyApifyAccountLimitObservation {
  observedAt:string;
  responseHash:string;
  cycleStartAt:string;
  cycleEndAt:string;
  maxMonthlyUsageUsd:number;
  currentMonthlyUsageUsd:number;
  observedHeadroomUsd:number;
  dataRetentionDays:number;
  maxMonthlyExternalDataTransferGbytes:number;
  currentMonthlyExternalDataTransferGbytes:number;
  observedExternalDataTransferHeadroomGbytes:number;
  permitsWeeklyCollection:false;
}

/** AGI's authenticated balance is a hard remaining USD ceiling for that token,
 * not evidence of the original purchase amount, exclusive use, or a CNY permit. */
export interface WeeklyApifyAgiBalanceObservation {
  observedAt:string;
  responseHash:string;
  tokenFingerprint:string;
  remainingBalanceUsd:number;
  expiresAt:string;
  permitsWeeklyCollection:false;
}

export function evaluateWeeklyApifyAgiBalance(input:{response:unknown;token:string;observedAt:string}):WeeklyApifyAgiBalanceObservation{
  const body=object(input.response),observed=Date.parse(input.observedAt),expiry=Date.parse(text(body?.expiresAt));
  const remaining=body?.remainingBalanceUsd;
  if(!input.token?.trim()||!Number.isFinite(observed)||!Number.isFinite(expiry)||expiry<=observed)fail('agi_balance_expired_or_unverified');
  if(typeof remaining!=='number'||!Number.isFinite(remaining)||remaining<0||!Number.isSafeInteger(Math.round(remaining*1_000_000))||Math.abs(Math.round(remaining*1_000_000)/1_000_000-remaining)>1e-9)fail('agi_balance_unverified');
  // Only known contract fields enter the returned hash; an unexpected response
  // field might contain a secret and must not become a readable receipt.
  return {observedAt:input.observedAt,responseHash:hash({remainingBalanceUsd:remaining,expiresAt:body?.expiresAt}),tokenFingerprint:createHash('sha256').update(input.token).digest('hex'),remainingBalanceUsd:remaining,expiresAt:text(body?.expiresAt),permitsWeeklyCollection:false};
}

/** No AGI purchase/challenge URL is touched. This GET cannot mint a token or
 * authorize a run, and the returned receipt deliberately omits the secret. */
export async function probeWeeklyApifyAgiBalance(input:{token:string;fetcher?:typeof fetch;now?:()=>number}):Promise<WeeklyApifyAgiBalanceObservation>{
  if(!input.token?.trim())fail('credentials_required');
  const response=await (input.fetcher??fetch)('https://agi.apify.com/prepaid-tokens/balance',{method:'GET',headers:{Authorization:`Bearer ${input.token}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(!response.ok)fail('agi_balance_http_unverified');
  return evaluateWeeklyApifyAgiBalance({response:await response.json(),token:input.token,observedAt:new Date((input.now??Date.now)()).toISOString()});
}

export function evaluateWeeklyApifyAccountLimits(response:unknown,observedAt:string):WeeklyApifyAccountLimitObservation{
  const data=object(object(response)?.data),cycle=object(data?.monthlyUsageCycle);
  const limits=object(data?.limits),current=object(data?.current);
  const observed=Date.parse(observedAt),start=Date.parse(text(cycle?.startAt)),end=Date.parse(text(cycle?.endAt));
  const maximum=limits?.maxMonthlyUsageUsd,used=current?.monthlyUsageUsd;
  const retention=limits?.dataRetentionDays,maximumTransfer=limits?.maxMonthlyExternalDataTransferGbytes,usedTransfer=current?.monthlyExternalDataTransferGbytes;
  if(!Number.isFinite(observed)||!Number.isFinite(start)||!Number.isFinite(end)||start>end||observed<start||observed>end)fail('account_limit_cycle_unverified');
  if(typeof maximum!=='number'||!Number.isFinite(maximum)||maximum<0||typeof used!=='number'||!Number.isFinite(used)||used<0)fail('account_limit_usage_unverified');
  if(!Number.isSafeInteger(retention)||Number(retention)<1||Number(retention)>3660||typeof maximumTransfer!=='number'||!Number.isFinite(maximumTransfer)||maximumTransfer<0||typeof usedTransfer!=='number'||!Number.isFinite(usedTransfer)||usedTransfer<0)fail('account_storage_or_transfer_limit_unverified');
  return {observedAt,responseHash:hash(response),cycleStartAt:text(cycle?.startAt),cycleEndAt:text(cycle?.endAt),maxMonthlyUsageUsd:maximum,currentMonthlyUsageUsd:used,observedHeadroomUsd:Math.max(0,maximum-used),dataRetentionDays:Number(retention),maxMonthlyExternalDataTransferGbytes:maximumTransfer,currentMonthlyExternalDataTransferGbytes:usedTransfer,observedExternalDataTransferHeadroomGbytes:Math.max(0,maximumTransfer-usedTransfer),permitsWeeklyCollection:false};
}

/** The authenticated limits endpoint is read-only. Never treat the returned
 * headroom as a reserved budget or as a USD→CNY upper-bound certificate. */
export async function probeWeeklyApifyAccountLimits(input:{token:string;fetcher?:typeof fetch;now?:()=>number}):Promise<WeeklyApifyAccountLimitObservation>{
  if(!input.token?.trim())fail('credentials_required');
  const response=await (input.fetcher??fetch)('https://api.apify.com/v2/users/me/limits',{method:'GET',headers:{Authorization:`Bearer ${input.token}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(!response.ok)fail('provider_http_unverified');
  return evaluateWeeklyApifyAccountLimits(await response.json(),new Date((input.now??Date.now)()).toISOString());
}

function fail(code:string):never{throw Error(`weekly_apify_preflight_${code}`);}

export function evaluateWeeklyApifyPpeResponses(input:{actorId:string;actorResponse:unknown;accountResponse:unknown;observedAt:string}):WeeklyApifyPpePreflight{
  const actor=object(object(input.actorResponse)?.data??input.actorResponse);
  const account=object(object(input.accountResponse)?.data??input.accountResponse);
  const observed=Date.parse(input.observedAt);
  if(!input.actorId||!actor||!account||!Number.isFinite(observed))fail('response_invalid');
  // The account tier must be explicit in the authenticated account response;
  // a public Store price or inferred subscription name is not sufficient.
  // /v2/users/me exposes the effective subscription tier under plan.tier.
  // Top-level pricingTier/discountTier are not part of that API contract.
  const plan=object(account.plan),tier=text(plan?.tier),servicePrices=object(object(plan?.planPricing)?.chargeableServiceUnitPricesUsd);
  if(plan?.isEnabled!==true||!tier||!['FREE','BRONZE','SILVER','GOLD','PLATINUM','DIAMOND'].includes(tier))fail('account_tier_unverified');
  const records=actor.pricingInfos;
  if(!Array.isArray(records)||records.length<1)return fail('pricing_missing');
  const active=records.filter(value=>{
    const record=object(value),start=Date.parse(text(record?.startedAt));
    return record&&Number.isFinite(start)&&start<=observed;
  }).sort((a,b)=>Date.parse(text(object(b)?.startedAt))-Date.parse(text(object(a)?.startedAt)));
  const pricing=object(active[0]);
  if(!pricing||pricing.pricingModel!=='PAY_PER_EVENT')fail('ppe_unverified');
  const effective=Date.parse(text(pricing.startedAt));
  if(active.length>1&&Date.parse(text(object(active[1])?.startedAt))===effective)fail('pricing_ambiguous');
  const events=object(object(pricing.pricingPerEvent)?.actorChargeEvents);
  if(!events||Object.keys(events).length===0)fail('events_unverified');
  const prices:Record<string,number>={};
  for(const [eventName,value] of Object.entries(events)){
    const event=object(value),tierEntry=object(object(event?.eventTieredPricingUsd)?.[tier]);
    // The API defines flat and tiered event prices as mutually exclusive.
    if(!event||('eventPriceUsd' in event)===('eventTieredPricingUsd' in event))fail('event_price_unverified');
    const amount=event.eventPriceUsd??tierEntry?.tieredEventPriceUsd;
    if(!eventName||typeof amount!=='number'||!Number.isFinite(amount)||amount<0)fail('event_price_unverified');
    prices[eventName]=amount;
  }
  const floor=pricing.minimalMaxTotalChargeUsd;
  if(floor!==null&&floor!==undefined&&(typeof floor!=='number'||!Number.isFinite(floor)||floor<0))fail('minimum_cap_unverified');
  // AGI prepaid tokens can only run limited-permission Actors. An absent or
  // unknown field must not be interpreted as proof of AGI compatibility.
  const actorPermissionLevel=actor.actorPermissionLevel==='LIMITED_PERMISSIONS'||actor.actorPermissionLevel==='FULL_PERMISSIONS'
    ?actor.actorPermissionLevel:'UNVERIFIED';
  const serviceKeys={datasetRead:'DATASET_READS',keyValueStoreRead:'KEY_VALUE_STORE_READS',keyValueStoreList:'KEY_VALUE_STORE_LISTS',datasetTimedStorageGbyteHour:'DATASET_TIMED_STORAGE_GBYTE_HOURS',keyValueStoreTimedStorageGbyteHour:'KEY_VALUE_STORE_TIMED_STORAGE_GBYTE_HOURS',externalDataTransferGbyte:'DATA_TRANSFER_EXTERNAL_GBYTES'} as const;
  const accountServiceRatesUsd={} as WeeklyApifyPpePreflight['accountServiceRatesUsd'];
  for(const [name,key] of Object.entries(serviceKeys) as Array<[keyof typeof serviceKeys,typeof serviceKeys[keyof typeof serviceKeys]]>){const value=servicePrices?.[key];if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('account_service_pricing_unverified');accountServiceRatesUsd[name]=value;}
  return {actorId:input.actorId,observedAt:input.observedAt,actorResponseHash:hash(input.actorResponse),accountResponseHash:hash(input.accountResponse),pricingRecordHash:hash(pricing),pricingStartedAt:text(pricing.startedAt),pricingModel:'PAY_PER_EVENT',accountTier:tier,eventPricesUsd:prices,accountServiceRatesUsd,minimalMaxTotalChargeUsd:floor as number|null|undefined??null,actorPermissionLevel,agiPrepaidCompatibleByPermission:actorPermissionLevel==='LIMITED_PERMISSIONS'};
}

/** Only authenticated GETs are allowed. No query-string token and no Actor run. */
export async function probeWeeklyApifyPpe(input:{actorId:string;token:string;fetcher?:typeof fetch;now?:()=>number}):Promise<WeeklyApifyPpePreflight>{
  if(!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(input.actorId)||input.actorId.length>128||!input.token?.trim())fail('credentials_required');
  const fetcher=input.fetcher??fetch;
  const get=async(url:string):Promise<unknown>=>{
    const response=await fetcher(url,{method:'GET',headers:{Authorization:`Bearer ${input.token}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(!response.ok)fail('provider_http_unverified');
    return response.json() as Promise<unknown>;
  };
  const [actorResponse,accountResponse]=await Promise.all([
    get(`https://api.apify.com/v2/acts/${encodeURIComponent(input.actorId)}`),
    get('https://api.apify.com/v2/users/me'),
  ]);
  return evaluateWeeklyApifyPpeResponses({actorId:input.actorId,actorResponse,accountResponse,observedAt:new Date((input.now??Date.now)()).toISOString()});
}
