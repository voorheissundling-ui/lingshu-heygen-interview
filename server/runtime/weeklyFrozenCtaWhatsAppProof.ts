import axios from 'axios';
import {createHash} from 'node:crypto';
import type {DataStore} from '../storage/datastore.js';
import {decryptSecret, type TenantPlatformAppRecord} from '../lib/tenantPlatformApps.js';
import {readCanonicalWhatsAppAccount} from '../whatsapp/canonicalAccount.js';

const digits=(value:unknown)=>typeof value==='string'?value.replace(/[^0-9]/g,''):'';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface WeeklyFrozenCtaWhatsAppProof {
  kind:'meta_whatsapp_live_number.v1';
  tenantId:string;
  accountId:string;
  accountHash:string;
  wabaId:string;
  phoneNumberId:string;
  publicNumber:string;
  verifiedAt:string;
  providerResponseHash:string;
  proofHash:string;
}

/**
 * A local phone field or embedded-signup checklist is not a public-number proof:
 * both can be edited through the generic admin app configuration. This reader
 * asks Meta again, on the server, and never accepts provider data from a client.
 * expectedPublicNumber must come from a separately verified, version-bound
 * frozen CTA claim; this parameter is not itself such a claim or authority.
 * The returned number observation does not authorize content creation, paid
 * production, outbound messaging, or the product-specific free-sample promise.
 */
export async function readLiveWeeklyWhatsAppCtaProof(input:{
  store:DataStore;
  tenantId:string;
  accountId:string;
  expectedPublicNumber:string;
  now?:Date;
  provider?:{
    listPhoneNumbers:(wabaId:string,token:string)=>Promise<unknown>;
    getPhoneNumber:(phoneNumberId:string,token:string)=>Promise<unknown>;
  };
}):Promise<WeeklyFrozenCtaWhatsAppProof>{
  const expected=digits(input.expectedPublicNumber);
  if(!/^\d{6,20}$/.test(expected))throw Error('weekly_cta_whatsapp_number_invalid');
  const account=await readCanonicalWhatsAppAccount(input.store,input.tenantId,input.accountId);
  const row=await input.store.getById<TenantPlatformAppRecord>('tenant_platform_apps',input.accountId);
  if(!row||row.tenant_id!==input.tenantId||row.status!=='active'||row.platform!=='meta')throw Error('weekly_cta_whatsapp_account_changed');
  if(digits(row.wa_public_number)!==expected)throw Error('weekly_cta_whatsapp_number_changed');
  const initialPublicNumber=row.wa_public_number;
  const token=decryptSecret(row.access_token);
  if(!token)throw Error('weekly_cta_whatsapp_credential_unavailable');
  const graphVersion=process.env.META_GRAPH_VERSION?.trim()||'v25.0';
  const provider=input.provider??{
    listPhoneNumbers:async(wabaId:string,accessToken:string)=>(await axios.get(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(wabaId)}/phone_numbers`,{headers:{Authorization:`Bearer ${accessToken}`},maxRedirects:0,timeout:15000})).data,
    getPhoneNumber:async(phoneNumberId:string,accessToken:string)=>(await axios.get(`https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}`,{headers:{Authorization:`Bearer ${accessToken}`},params:{fields:'id,display_phone_number'},maxRedirects:0,timeout:15000})).data,
  };
  const phones=await provider.listPhoneNumbers(account.wabaId,token) as {data?:Array<{id?:unknown}>};
  if(!Array.isArray(phones?.data)||phones.data.filter(phone=>phone?.id===account.nativeAccountId).length!==1)throw Error('weekly_cta_whatsapp_membership_invalid');
  const info=await provider.getPhoneNumber(account.nativeAccountId,token) as {id?:unknown;display_phone_number?:unknown};
  if(info?.id!==account.nativeAccountId||digits(info.display_phone_number)!==expected)throw Error('weekly_cta_whatsapp_provider_number_invalid');
  const refreshed=await readCanonicalWhatsAppAccount(input.store,input.tenantId,input.accountId);
  const finalRow=await input.store.getById<TenantPlatformAppRecord>('tenant_platform_apps',input.accountId);
  if(refreshed.accountHash!==account.accountHash||finalRow?.wa_public_number!==initialPublicNumber)throw Error('weekly_cta_whatsapp_account_changed');
  const body={kind:'meta_whatsapp_live_number.v1' as const,tenantId:input.tenantId,accountId:input.accountId,accountHash:account.accountHash,wabaId:account.wabaId,phoneNumberId:account.nativeAccountId,publicNumber:expected,verifiedAt:(input.now??new Date()).toISOString(),providerResponseHash:digest({wabaId:account.wabaId,phoneNumberId:info.id,displayPhoneNumber:info.display_phone_number})};
  return {...body,proofHash:digest(body)};
}
