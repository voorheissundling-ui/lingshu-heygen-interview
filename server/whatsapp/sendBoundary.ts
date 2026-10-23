import type {Record_} from '../storage/datastore.js';
import {store} from '../storage/index.js';
import {canonicalWhatsAppAccountFromRow} from './canonicalAccount.js';
import {assertVerifiedWhatsAppAssets,whatsappAssetAuthorityHash} from './assetAuthority.js';
import {resolveTenantWhatsAppConfig} from './send.js';
import type {TenantPlatformAppRecord} from '../lib/tenantPlatformApps.js';
const object=(value:unknown):Record<string,unknown>=>{if(typeof value==='string'){try{return object(JSON.parse(value));}catch{return {};}}return value&&typeof value==='object'?value as Record<string,unknown>:{};};
export function normalizedWhatsAppRecipient(value:string):string{const normalized=value.trim().replace(/^\+/,'');if(!/^\d{6,20}$/.test(normalized))throw Error('whatsapp_recipient_invalid');return normalized;}
/** Re-read account, tenant consent and verified native recipient before each effect. */
export async function assertWhatsAppSendBoundary(input:{tenantId:string;to:string;expectedAccountHash?:string;requireRecentInbound?:boolean}){
 const to=normalizedWhatsAppRecipient(input.to);
 const apps=await store.list<TenantPlatformAppRecord>('tenant_platform_apps',{where:{tenant_id:input.tenantId,platform:'meta'},perPage:2});
 if(apps.totalItems!==1||apps.items.length!==1)throw Error('whatsapp_account_ambiguous');const app=structuredClone(apps.items[0]!);
 const currentApp=await store.getById<TenantPlatformAppRecord>('tenant_platform_apps',app.id);if(!currentApp||whatsappAssetAuthorityHash(currentApp)!==whatsappAssetAuthorityHash(app)||currentApp.status!==app.status||currentApp.token_expires_at!==app.token_expires_at||currentApp.token_type!==app.token_type)throw Error('whatsapp_account_version_changed');
 const proof=canonicalWhatsAppAccountFromRow(app,input.tenantId,app.id);assertVerifiedWhatsAppAssets(app);
 if(input.expectedAccountHash&&proof.accountHash!==input.expectedAccountHash)throw Error('whatsapp_account_version_changed');
 const {readCustomerMessagingAuthorization}=await import('../digitalEmployees/customerMessagingPolicy.js');
 const authorization=await readCustomerMessagingAuthorization(input.tenantId,'whatsapp');if(!authorization.manualFollowupSendAllowed)throw Error('whatsapp_tenant_message_authorization_revoked');
 const candidates:Record_[]=[];let total:number|undefined;
 for(let page=1;page<=1000;page++){const result=await store.list<Record_>('whatsapp_interactions',{where:{tenant_id:input.tenantId},page,perPage:250});if(total!==undefined&&total!==result.totalItems)throw Error('whatsapp_recipient_scope_changed');total=result.totalItems;candidates.push(...result.items);if(candidates.length===total)break;if(!result.items.length||page===1000)throw Error('whatsapp_recipient_scope_incomplete');}
 const inbound=candidates.filter(row=>row.tenant_id===input.tenantId).map(row=>object(row.payload)).filter(message=>{const audit=object(message.audit);return message.tenantId===input.tenantId&&message.type==='msg_in'&&message.waNumber===to&&typeof message.metaMessageId==='string'&&message.metaMessageId.startsWith('wamid.')&&audit.inboundSource==='verified_meta_webhook'&&audit.providerMessageId===message.metaMessageId&&audit.providerRecipientId===to&&audit.accountId===proof.accountId&&audit.phoneNumberId===proof.nativeAccountId&&audit.wabaId===proof.wabaId&&typeof message.timestamp==='number'&&Number.isFinite(message.timestamp)&&message.timestamp>0&&message.timestamp<=Date.now();});
 if(!inbound.length)throw Error('whatsapp_recipient_scope_unverified');
 if(input.requireRecentInbound!==false&&!inbound.some(message=>Date.now()-Number(message.timestamp)<=24*60*60*1000))throw Error('whatsapp_recipient_message_window_expired');
 const finalAuthorization=await readCustomerMessagingAuthorization(input.tenantId,'whatsapp');if(!finalAuthorization.manualFollowupSendAllowed||finalAuthorization.configVersion!==authorization.configVersion)throw Error('whatsapp_tenant_message_authorization_changed');
 const finalApp=await store.getById<TenantPlatformAppRecord>('tenant_platform_apps',app.id);if(!finalApp||whatsappAssetAuthorityHash(finalApp)!==whatsappAssetAuthorityHash(app)||finalApp.status!==app.status||finalApp.token_expires_at!==app.token_expires_at||finalApp.token_type!==app.token_type)throw Error('whatsapp_account_version_changed');
 return {to,accountHash:proof.accountHash,config:resolveTenantWhatsAppConfig(input.tenantId,app)};
}
