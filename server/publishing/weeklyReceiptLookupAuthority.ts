import {resolveInstagramPublishingContract} from './instagramPublishingContract.js';
import type {DataStore,Record_} from '../storage/datastore.js';
import {socialAccessToken,youtubeCredentials} from '../lib/accountCredentials.js';
import {ensurePlatformCapability,platformAccountIdentityHash} from './platformCapabilities.js';
export type WeeklyPublishingPurpose='publish'|'receipt_lookup';
export async function weeklyReceiptLookupAuthority(input:{tenantId:string;accountId:string;platform:'tiktok'|'youtube'|'facebook'|'instagram'|'linkedin';providerReceiptId?:string;dataStore:DataStore;now?:Date}){
 const receipt=input.providerReceiptId?.trim();if(!receipt)return {reason:'provider_receipt_missing',identityHash:null};
 const account=await input.dataStore.getById<Record_>(input.platform==='youtube'?'youtube_accounts':'social_accounts',input.accountId);
 if(!account||account.tenantId!==input.tenantId||(input.platform!=='youtube'&&account.platform!==input.platform))return {reason:'receipt_lookup_account_scope_mismatch',identityHash:null};
 if(account.status!=='connected')return {reason:'receipt_lookup_account_not_connected',identityHash:null};
 if(typeof (input.platform==='youtube'?account.channelId:account.providerAccountId)!=='string'||!String(input.platform==='youtube'?account.channelId:account.providerAccountId).trim())return {reason:'receipt_lookup_native_identity_missing',identityHash:null};
 try{if(input.platform==='youtube')youtubeCredentials(account);else socialAccessToken(account);}catch{return {reason:'receipt_lookup_credential_unavailable',identityHash:null};}
 if(input.platform==='instagram') {
  let contract;try{contract=resolveInstagramPublishingContract({oauthProvider:account.oauthProvider});}catch{return {reason:'instagram_publishing_oauth_provider_unsupported',identityHash:null};}
  if(contract.oauthProvider==='instagram_login'&&!new Set(String(account.scope??'').split(/[\s,]+/)).has('instagram_business_basic'))return {reason:'receipt_lookup_scope_missing',identityHash:null};
 }
 const identityHash=platformAccountIdentityHash(account,input.platform);
 if(input.platform==='tiktok'){
  const decision=await ensurePlatformCapability({tenantId:input.tenantId,accountId:input.accountId,platform:'tiktok',capability:'publishing.receipt_lookup',receiptId:receipt,dataStore:input.dataStore,now:input.now});if(decision.status!=='available')return {reason:decision.reason,identityHash};
  const proof=await input.dataStore.list('social_platform_capability_evidence',{where:{tenant_id:input.tenantId,account_id:input.accountId,platform:'tiktok',capability:'publishing.receipt_lookup',evidence_ref:`provider:tiktok:receipt:${receipt}`},sort:'-verified_at',perPage:2});
  if(!proof.items[0]||proof.items[0].account_identity_hash!==identityHash||(proof.items.length>1&&proof.items[0].verified_at===proof.items[1]!.verified_at))return {reason:'receipt_lookup_account_evidence_changed',identityHash};
 }
 // Other providers have a real status GET. This permits trying that GET; it
 // does not assert verified provider permission or a published outcome.
 return {reason:'',identityHash};
}
