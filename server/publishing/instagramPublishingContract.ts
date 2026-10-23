export type InstagramPublishingOAuthProvider = 'instagram_login' | 'facebook_login';
export type InstagramGraphHost = 'https://graph.instagram.com' | 'https://graph.facebook.com';
export interface InstagramPublishingContract {
  oauthProvider: InstagramPublishingOAuthProvider;
  graphHost: InstagramGraphHost;
  tokenKind: 'instagram_user' | 'facebook_page';
  publishScope: 'instagram_business_content_publish' | 'instagram_content_publish';
  requiredScopes: readonly string[];
}
/** Meta's two publishing APIs have distinct token and permission contracts. */
export function resolveInstagramPublishingContract(account: {oauthProvider?: unknown}): InstagramPublishingContract {
  const provider = String(account.oauthProvider ?? '').trim();
  if (provider === 'instagram_login') return {oauthProvider:provider,graphHost:'https://graph.instagram.com',tokenKind:'instagram_user',publishScope:'instagram_business_content_publish',requiredScopes:['instagram_business_basic','instagram_business_content_publish']};
  if (!provider || provider === 'facebook_login') return {oauthProvider:'facebook_login',graphHost:'https://graph.facebook.com',tokenKind:'facebook_page',publishScope:'instagram_content_publish',requiredScopes:['instagram_content_publish']};
  throw new Error('instagram_publishing_oauth_provider_unsupported');
}
export function assertInstagramPublishingScopes(account: {oauthProvider?:unknown;scope?:unknown}): InstagramPublishingContract {
  const contract = resolveInstagramPublishingContract(account);
  const scopes = new Set(String(account.scope ?? '').split(/[\s,]+/).filter(Boolean));
  if (!contract.requiredScopes.every(scope => scopes.has(scope))) throw new Error('provider_publish_scope_missing');
  return contract;
}
