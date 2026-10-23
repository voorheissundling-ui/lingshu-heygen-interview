const META_GRAPH = 'https://graph.facebook.com';

function graphVersion() {
  return process.env.META_GRAPH_VERSION?.trim() || 'v25.0';
}

async function metaRequest(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${META_GRAPH}/${graphVersion()}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || data.error) {
    const providerError = data.error && typeof data.error === 'object'
      ? String((data.error as Record<string, unknown>).message || '')
      : '';
    throw new Error(providerError || `Meta Messenger request failed (${response.status})`);
  }
  return data;
}

export async function subscribeMessengerPage(input: { pageId: string; pageAccessToken: string }) {
  const fields = ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads', 'message_echoes'];
  const params = new URLSearchParams({
    subscribed_fields: fields.join(','),
    access_token: input.pageAccessToken,
  });
  const result = await metaRequest(`/${encodeURIComponent(input.pageId)}/subscribed_apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (result.success !== true) throw Error('messenger_subscription_not_confirmed');
  return result;
}

export async function sendMessengerText(input: {
  pageId: string;
  pageAccessToken: string;
  recipientId: string;
  text: string;
}) {
  const data = await metaRequest(`/${encodeURIComponent(input.pageId)}/messages?access_token=${encodeURIComponent(input.pageAccessToken)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: input.recipientId },
      messaging_type: 'RESPONSE',
      message: { text: input.text },
    }),
  });
  if (!String(data.message_id || '').trim() || String(data.recipient_id || '') !== input.recipientId) throw Error('messenger_provider_receipt_identity_invalid');
  return {
    messageId: String(data.message_id || ''),
    recipientId: String(data.recipient_id),
    raw: data,
  };
}

/** Read actual grants and native Page identity; requested OAuth scopes are not evidence. */
export async function probeMessengerPageCapability(input: { pageId: string; pageAccessToken: string; appId: string; appSecret: string }): Promise<{ grantedScopes: string[]; pageId: string; appId: string; validUntil: number }> {
  if (![input.pageId,input.pageAccessToken,input.appId,input.appSecret].every(value => value.trim())) throw Error('messenger_probe_configuration_missing');
  const debugParams = new URLSearchParams({input_token:input.pageAccessToken,access_token:`${input.appId}|${input.appSecret}`});
  const debug = await metaRequest(`/debug_token?${debugParams}`, {method:'GET'});
  const authority = debug.data && typeof debug.data === 'object' ? debug.data as Record<string,unknown> : {};
  const scopes = Array.isArray(authority.scopes) ? authority.scopes.filter((value): value is string => typeof value === 'string') : [];
  if (authority.is_valid !== true || String(authority.app_id || '') !== input.appId || authority.type !== 'PAGE'
    || (authority.profile_id !== undefined && String(authority.profile_id) !== input.pageId)
    || !['pages_messaging','pages_manage_metadata'].every(scope => scopes.includes(scope))) throw Error('messenger_token_grants_invalid');
  for (const expiry of [authority.expires_at, authority.data_access_expires_at]) {
    if (expiry !== undefined && expiry !== 0 && (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry * 1000 <= Date.now())) throw Error('messenger_token_expired');
  }
  if (Array.isArray(authority.granular_scopes)) {
    for (const grant of authority.granular_scopes) {
      if (!grant || typeof grant !== 'object') throw Error('messenger_granular_grant_invalid');
      const value = grant as Record<string,unknown>;
      if (['pages_messaging','pages_manage_metadata'].includes(String(value.scope)) && Array.isArray(value.target_ids) && !value.target_ids.map(String).includes(input.pageId)) throw Error('messenger_page_grant_missing');
    }
  }
  const me = await metaRequest(`/me?${new URLSearchParams({fields:'id',access_token:input.pageAccessToken})}`, {method:'GET'});
  if (String(me.id || '') !== input.pageId) throw Error('messenger_native_page_mismatch');
  const expiries=[authority.expires_at,authority.data_access_expires_at].filter((value):value is number=>typeof value==='number'&&value>0).map(value=>value*1000);
  return {grantedScopes:[...new Set(scopes)].sort(),pageId:input.pageId,appId:input.appId,validUntil:Math.min(Date.now()+10*60*1000,...expiries)};
}
export async function connectMessengerPageCapability(input: { pageId: string; pageAccessToken: string; appId: string; appSecret: string }) {
  const proof = await probeMessengerPageCapability(input);
  await subscribeMessengerPage(input);
  await verifyMessengerPageSubscription(input);
  return proof;
}

export async function verifyMessengerPageSubscription(input:{pageId:string;pageAccessToken:string;appId:string}):Promise<void>{
  const subscription = await metaRequest(`/${encodeURIComponent(input.pageId)}/subscribed_apps?${new URLSearchParams({access_token:input.pageAccessToken})}`, {method:'GET'});
  if (!Array.isArray(subscription.data) || subscription.data.filter(item => item && typeof item === 'object' && String((item as Record<string,unknown>).id) === input.appId && Array.isArray((item as Record<string,unknown>).subscribed_fields) && ['messages','messaging_postbacks','message_deliveries','message_reads'].every(field => ((item as Record<string,unknown>).subscribed_fields as unknown[]).includes(field))).length !== 1) throw Error('messenger_subscription_readback_invalid');
}
