import {assertVerifiedWhatsAppAssets} from './assetAuthority.js';
import {createHash} from 'node:crypto';
import type {DataStore} from '../storage/datastore.js';
import {decryptSecret,type TenantPlatformAppRecord} from '../lib/tenantPlatformApps.js';
import {resolveTenantWhatsAppConfig} from './send.js';
export interface CanonicalWhatsAppAccountProof{accountId:string;tenantId:string;nativeAccountId:string;wabaId:string;accountHash:string}
/** Existing tenant app is the real WhatsApp account; do not manufacture a social_accounts row. */
export async function readCanonicalWhatsAppAccount(store:DataStore,tenantId:string,accountId:string,openSecret=decryptSecret):Promise<CanonicalWhatsAppAccountProof>{
 const row=await store.getById<TenantPlatformAppRecord>('tenant_platform_apps',accountId);
 return canonicalWhatsAppAccountFromRow(row,tenantId,accountId,openSecret);
}
/** Compute authority from exactly the snapshot used for provider configuration. */
export function canonicalWhatsAppAccountFromRow(row:TenantPlatformAppRecord|null,tenantId:string,accountId:string,openSecret=decryptSecret):CanonicalWhatsAppAccountProof{
 if(!row||row.id!==accountId||row.tenant_id!==tenantId||row.platform!=='meta'||row.status!=='active'||typeof row.waba_id!=='string'||!row.waba_id.trim()||typeof row.app_id!=='string'||!row.app_id.trim()||!openSecret(row.app_secret as string|undefined))throw Error('weekly_whatsapp_account_not_ready');
 assertVerifiedWhatsAppAssets(row as unknown as TenantPlatformAppRecord);
 const config=resolveTenantWhatsAppConfig(tenantId,row as unknown as TenantPlatformAppRecord,openSecret);
 const authority={tenantId,accountId,appId:row.app_id,phoneNumberId:config.phoneNumberId,wabaId:row.waba_id,status:row.status,tokenType:row.token_type??null,tokenExpiresAt:row.token_expires_at??null,credentialHash:createHash('sha256').update(String(row.access_token)).digest('hex'),signingCredentialHash:createHash('sha256').update(String(row.app_secret)).digest('hex')};
 return{tenantId,accountId,nativeAccountId:config.phoneNumberId,wabaId:String(row.waba_id),accountHash:createHash('sha256').update(JSON.stringify(authority)).digest('hex')};
}
