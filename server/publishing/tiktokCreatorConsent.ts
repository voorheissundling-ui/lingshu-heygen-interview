import { tikTokDirectPostApproved } from '../lib/socialOAuthScopes.js';
import { createHmac } from 'node:crypto';
import axios from 'axios';
import type { DataStore, Record_ } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { socialAccessToken } from '../lib/accountCredentials.js';
import { tikTokAccountIdentityHash, validateTikTokCreatorInfo, type TikTokCreatorInfo } from '../lib/tikTokDirectPostContract.js';
export function tikTokCreatorConsentHash(input: {tenantId:string;accountId:string;providerAccountId:string;accessToken:string;creator:TikTokCreatorInfo}):string {
  return createHmac('sha256',input.accessToken).update(JSON.stringify({version:1,tenantId:input.tenantId,accountId:input.accountId,providerAccountId:input.providerAccountId,creator:validateTikTokCreatorInfo(input.creator)})).digest('hex');
}
export async function readTikTokCreatorConsent(input:{tenantId:string;accountId:string;dataStore?:DataStore}) {
  const dataStore=input.dataStore??store;
  const account=await dataStore.getById<Record_>('social_accounts',input.accountId);
  if(!account||account.tenantId!==input.tenantId||account.platform!=='tiktok'||account.status!=='connected'||typeof account.providerAccountId!=='string'||!account.providerAccountId.trim()||!String(account.scope??'').split(/[\s,]+/).includes('video.publish'))throw Error('tiktok_creator_account_not_ready');
  const accessToken=socialAccessToken(account);
  const identity=tikTokAccountIdentityHash({tenantId:input.tenantId,accountId:input.accountId,providerAccountId:account.providerAccountId,accessToken});
  const user=await axios.get('https://open.tiktokapis.com/v2/user/info/',{maxRedirects:0,timeout:30000,params:{fields:'open_id,display_name'},headers:{Authorization:`Bearer ${accessToken}`}});
  if(user.data?.error?.code!=='ok'||user.data?.data?.user?.open_id!==account.providerAccountId)throw Error('tiktok_creator_native_identity_changed');
  const response=await axios.post('https://open.tiktokapis.com/v2/post/publish/creator_info/query/',{}, {maxRedirects:0,timeout:30000,headers:{Authorization:`Bearer ${accessToken}`}});
  if(response.data?.error?.code!=='ok')throw Error('tiktok_creator_query_rejected');
  const creator=validateTikTokCreatorInfo(response.data?.data);
  const current=await dataStore.getById<Record_>('social_accounts',input.accountId);
  if(!current||current.tenantId!==input.tenantId||current.platform!=='tiktok'||current.status!=='connected'||typeof current.providerAccountId!=='string'||!String(current.scope??'').split(/[\s,]+/).includes('video.publish')||tikTokAccountIdentityHash({tenantId:input.tenantId,accountId:input.accountId,providerAccountId:current.providerAccountId,accessToken:socialAccessToken(current)})!==identity)throw Error('tiktok_creator_account_changed');
  return {accountId:input.accountId,creator,creatorReceiptHash:tikTokCreatorConsentHash({tenantId:input.tenantId,accountId:input.accountId,providerAccountId:account.providerAccountId,accessToken,creator}),queriedAt:new Date().toISOString(),directPostApproved:tikTokDirectPostApproved()};
}
