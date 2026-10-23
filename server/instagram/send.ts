import type {WeeklyNativeSendAuthority} from '../../shared/contracts/weeklyNativeSendAuthority.js';
import { socialAccessToken } from '../lib/accountCredentials.js';
import { store } from '../storage/index.js';
import {createCustomerChannelSendRequestService,resolveCustomerChannelOutboxContext} from '../digitalEmployees/customerChannelSendRequests.js';
import { getInstagramCustomers, upsertInstagramMessage } from './conversations.js';

function graphVersion() {
  return process.env.META_GRAPH_VERSION?.trim() || 'v25.0';
}

/** Send only to the Instagram-scoped user ID received in a verified webhook. */
export async function sendInstagramText(input: {
  instagramAccountId: string;
  instagramUserId: string;
  accessToken: string;
  oauthProvider: 'instagram_login' | 'facebook_login';
  parentPageId?: string;
  text: string;
}) {
  const isInstagramLogin = input.oauthProvider === 'instagram_login';
  const senderId = isInstagramLogin ? input.instagramAccountId : input.parentPageId;
  if (!senderId) throw new Error('instagram_messaging_page_required');
  const host = isInstagramLogin ? 'graph.instagram.com' : 'graph.facebook.com';
  const response = await fetch(`https://${host}/${graphVersion()}/${encodeURIComponent(senderId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: input.instagramUserId }, message: { text: input.text } }),
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || data.error) {
    const providerError = data.error && typeof data.error === 'object'
      ? String((data.error as Record<string, unknown>).message || '') : '';
    throw new Error(providerError || `Instagram send failed (${response.status})`);
  }
  const messageId = String(data.message_id || '');
  if (!messageId) throw new Error('instagram_provider_message_id_missing');
  return { messageId, recipientId: String(data.recipient_id || input.instagramUserId), raw: data };
}

export async function sendTenantInstagramText(input: { tenantId: string; customerId: string; body: string;requestId:string;actorUserId:string;weeklyAuthority?:WeeklyNativeSendAuthority }) {
  const customer = getInstagramCustomers(input.tenantId).find(item => item.id === input.customerId);
  if (!customer) throw new Error('instagram_customer_not_found');
  const lastBuyerAt = Math.max(0, ...customer.timeline.filter(event => event.actor === 'buyer').map(event => event.timestamp));
  if (!lastBuyerAt || Date.now() - lastBuyerAt > 24 * 60 * 60 * 1000) {
    throw new Error('距客户上次互动已超过 24 小时，当前不能直接发送普通 Instagram 私信。');
  }
  const context=await resolveCustomerChannelOutboxContext(store,{tenantId:input.tenantId,actorUserId:input.actorUserId,customerId:input.customerId,channel:'instagram',nativeAccountId:customer.instagramAccountId});
  const account=(await store.getById<Record<string,unknown>>('social_accounts',context.accountId))!;
  const oauthProvider = account.oauthProvider === 'instagram_login' ? 'instagram_login' : 'facebook_login';
  const requiredScope = oauthProvider === 'instagram_login' ? 'instagram_business_manage_messages' : 'instagram_manage_messages';
  const scopes = new Set(String(account.scope || '').split(/[\s,]+/).filter(Boolean));
  if (!scopes.has(requiredScope)) throw new Error('Instagram 私信权限未授权，请在集成中心重新连接账号。');
  return createCustomerChannelSendRequestService(store).execute({
    tenantId:input.tenantId,actorUserId:input.actorUserId,requestId:input.requestId,weeklyAuthority:input.weeklyAuthority,channel:'instagram',customerId:input.customerId,
    accountId:String(account.id),recipientId:customer.instagramUserId,body:input.body,
    send:()=>sendInstagramText({instagramAccountId:customer.instagramAccountId,instagramUserId:customer.instagramUserId,accessToken:socialAccessToken(account),oauthProvider,parentPageId:String(account.parentPageId||''),text:input.body}),
    recordHistory:receipt=>{upsertInstagramMessage({tenantId:input.tenantId,instagramAccountId:customer.instagramAccountId,userId:customer.instagramUserId,messageId:receipt.messageId,body:input.body,timestamp:Date.parse(receipt.acceptedAt),actor:'seller',sendStatus:'sent'});}
  });
}
