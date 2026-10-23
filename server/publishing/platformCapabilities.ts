import axios from 'axios';
import { assertInstagramPublishingScopes, resolveInstagramPublishingContract } from './instagramPublishingContract.js';
import {createHash} from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { socialAccessToken, youtubeCredentials } from '../lib/accountCredentials.js';
import { getMyChannelInfo, probeYouTubeUploadPermission } from '../integrations/youtube.js';
import { getFacebookPage, getInstagramAccount, getMetaGrantedPermissions, getTikTokPublishStatus, getTikTokUser, probeTikTokPublishingPermission } from '../integrations/social.js';
import { getLinkedInOrganization, getLinkedInProfile, linkedInAuthorUrn, linkedInRequiredPublishingScope } from '../integrations/linkedin.js';

export const PLATFORM_CAPABILITY_EVIDENCE_COLLECTION = 'social_platform_capability_evidence';

export type RuntimeSocialPlatform = 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'linkedin';
export type RuntimePlatformCapability =
  | 'publishing.official'
  | 'publishing.receipt_lookup'
  | 'engagement.comments'
  | 'engagement.direct_messages';

export interface PlatformCapabilityEvidence {
  id: string;
  account_identity_hash?: string;
  tenant_id: string;
  account_id: string;
  platform: RuntimeSocialPlatform;
  capability: RuntimePlatformCapability;
  status: 'verified' | 'unavailable' | 'revoked';
  evidence_source: 'provider_probe' | 'provider_webhook' | 'operator_review';
  evidence_ref: string;
  verified_at: string;
  expires_at?: string;
  reason_code?: string;
  created_at: string;
  updated_at: string;
}

export interface PlatformCapabilityDecision {
  platform: RuntimeSocialPlatform;
  accountId: string;
  capability: RuntimePlatformCapability;
  status: 'available' | 'unavailable';
  reason: string;
  verifiedAt?: string;
  evidenceRef?: string;
}

const text = (value: unknown): string => String(value ?? '').trim();

export const PLATFORM_CAPABILITY_PROBE_TTL_MS = 15 * 60_000;
export const PLATFORM_CAPABILITY_MAX_EVIDENCE_AGE_MS = 30 * 60_000;

const LIVE_PROBE_REQUIRED = new Set<RuntimePlatformCapability>([
  'publishing.official',
  'publishing.receipt_lookup',
]);

export function platformCapabilityEvidenceIsCurrent(item: PlatformCapabilityEvidence, now = new Date()): boolean {
  if (item.status !== 'verified' || !text(item.evidence_ref) || !Number.isFinite(Date.parse(item.verified_at))) return false;
  const verifiedAt = Date.parse(item.verified_at);
  const expiry = Date.parse(text(item.expires_at));
  if (LIVE_PROBE_REQUIRED.has(item.capability)) {
    if (item.evidence_source !== 'provider_probe' || !Number.isFinite(expiry)) return false;
    if (!item.evidence_ref.startsWith(`provider:${item.platform}:`)) return false;
    if (verifiedAt > now.getTime() + 60_000 || now.getTime() - verifiedAt > PLATFORM_CAPABILITY_MAX_EVIDENCE_AGE_MS) return false;
    if (expiry > verifiedAt + PLATFORM_CAPABILITY_PROBE_TTL_MS + 60_000) return false;
  }
  return !Number.isFinite(expiry) || expiry > now.getTime();
}

/**
 * Runtime capability truth is based on a persisted provider observation. A
 * configured environment variable, OAuth client, or connected-looking account
 * is deliberately insufficient evidence that a tenant can use the capability.
 */
export async function platformCapabilityDecision(input: {
  tenantId: string;
  accountId: string;
  platform: RuntimeSocialPlatform;
  capability: RuntimePlatformCapability;
  now?: Date;
  dataStore?: DataStore;
}): Promise<PlatformCapabilityDecision> {
  const dataStore = input.dataStore ?? store;
  const boundary = await instagramPublishingBoundary(input,dataStore);
  if(boundary) return boundary;
  const result = await dataStore.list<PlatformCapabilityEvidence>(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION, {
    where: {
      tenant_id: text(input.tenantId), account_id: text(input.accountId),
      platform: input.platform, capability: input.capability,
    },
    sort: '-verified_at', page: 1, perPage: 2,
  }).catch(() => ({ items: [], totalItems: 0, totalPages: 0, page: 1, perPage: 2 }));
  if (result.totalItems > 1 && result.items.length > 1
    && result.items[0]?.verified_at === result.items[1]?.verified_at) {
    return { platform: input.platform, accountId: input.accountId, capability: input.capability, status: 'unavailable', reason: 'capability_evidence_ambiguous' };
  }
  const evidence = result.items[0];
  if (!evidence) return { platform: input.platform, accountId: input.accountId, capability: input.capability, status: 'unavailable', reason: 'provider_capability_not_verified' };
  if (!platformCapabilityEvidenceIsCurrent(evidence, input.now ?? new Date())) {
    return {
      platform: input.platform, accountId: input.accountId, capability: input.capability,
      status: 'unavailable', reason: evidence.reason_code || (evidence.status === 'revoked' ? 'provider_capability_revoked' : 'provider_capability_expired_or_unavailable'),
      verifiedAt: evidence.verified_at, evidenceRef: evidence.evidence_ref,
    };
  }
  if((input.platform === 'instagram' || input.platform === 'linkedin') && LIVE_PROBE_REQUIRED.has(input.capability)) {
    const account = await dataStore.getById<AccountRecord>('social_accounts',text(input.accountId));
    if(!account || evidence.account_identity_hash !== platformAccountIdentityHash(account,input.platform)) return {platform:input.platform,accountId:input.accountId,capability:input.capability,status:'unavailable',reason:'provider_account_identity_changed'};
  }
  return {
    platform: input.platform, accountId: input.accountId, capability: input.capability,
    status: 'available', reason: 'provider_capability_verified', verifiedAt: evidence.verified_at, evidenceRef: evidence.evidence_ref,
  };
}

type AccountRecord = Record<string, unknown> & { id: string; oauthProvider?: unknown };

export interface PlatformCapabilityProbeProviders {
  youtube(config: ReturnType<typeof youtubeCredentials>): Promise<{ id: string; publishGranted: boolean }>;
  facebook(accessToken: string, graphVersion: string, accountId: string): Promise<{ id: string; publishGranted: boolean }>;
  instagram(accountId: string, accessToken: string, graphVersion: string): Promise<{ id: string; publishGranted: boolean }>;
  instagramLogin?(accountId: string, accessToken: string, graphVersion: string): Promise<{ id: string; publishGranted: boolean }>;
  tiktok(accessToken: string): Promise<{ openId: string; publishGranted: boolean }>;
  tiktokReceipt(accessToken: string, receiptId: string): Promise<{ publishId: string }>;
  linkedin?(accessToken: string, account: AccountRecord): Promise<{ authorUrn: string; publishGranted: boolean }>;
}

const liveProviders: PlatformCapabilityProbeProviders = {
  youtube: async config => {
    const [channel, permission] = await Promise.all([getMyChannelInfo(config), probeYouTubeUploadPermission(config)]);
    return { id: channel.id, publishGranted: permission.granted };
  },
  facebook: async (token, version, id) => {
    const [page, permissions] = await Promise.all([getFacebookPage(token, version, id), getMetaGrantedPermissions(token, version)]);
    return { id: page.id, publishGranted: permissions.includes('pages_manage_posts') };
  },
  instagram: async (id, token, version) => {
    const [account, permissions] = await Promise.all([getInstagramAccount(id, token, version), getMetaGrantedPermissions(token, version)]);
    return { id: account.id, publishGranted: permissions.includes('instagram_content_publish') };
  },
  instagramLogin: async (id, token, version) => {
    const host = resolveInstagramPublishingContract({oauthProvider:'instagram_login'}).graphHost;
    // /me binds the IG User token itself; a path containing the expected ID is insufficient.
    const account = await axios.get(`${host}/${version}/me`, {params:{fields:'id,user_id',access_token:token},maxRedirects:0});
    if(String(account.data?.id ?? '') !== id) throw new Error('provider_account_mismatch');
    // This read requires the native publishing permission; stored scope text alone is not proof.
    const permission = await axios.get(`${host}/${version}/${encodeURIComponent(id)}/content_publishing_limit`, {params:{fields:'quota_usage,config',access_token:token},maxRedirects:0});
    const rows = permission.data?.data;
    if(!Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(rows[0]?.quota_usage) || rows[0].quota_usage < 0 || !Number.isSafeInteger(rows[0]?.config?.quota_total) || rows[0].config.quota_total <= 0) throw new Error('provider_permission_response_invalid');
    return {id:String(account.data.id),publishGranted:true};
  },
  tiktok: async token => {
    const [user, permission] = await Promise.all([getTikTokUser(token), probeTikTokPublishingPermission(token)]);
    return { openId: user.openId, publishGranted: permission.granted };
  },
  tiktokReceipt: getTikTokPublishStatus,
  linkedin: async (token, account) => {
    const authorUrn = linkedInAuthorUrn({ providerAccountId: text(account.providerAccountId), parentPageId: text(account.parentPageId) });
    if (authorUrn.startsWith('urn:li:organization:')) {
      const organization = await getLinkedInOrganization(token, authorUrn.slice('urn:li:organization:'.length));
      return { authorUrn: organization.authorUrn, publishGranted: true };
    }
    const profile = await getLinkedInProfile(token);
    return { authorUrn: profile.authorUrn, publishGranted: true };
  },
};

async function instagramPublishingBoundary(input: {tenantId:string;accountId:string;platform:RuntimeSocialPlatform;capability:RuntimePlatformCapability}, dataStore:DataStore): Promise<PlatformCapabilityDecision | null> {
  if(input.platform !== 'instagram' || !LIVE_PROBE_REQUIRED.has(input.capability)) return null;
  const account = await dataStore.getById<AccountRecord>('social_accounts',text(input.accountId));
  let reason = '';
  if(!account || account.tenantId !== input.tenantId || account.platform !== 'instagram' || account.status !== 'connected') reason = 'provider_account_not_connected';
  else { try { resolveInstagramPublishingContract(account); } catch { reason = 'instagram_publishing_oauth_provider_unsupported'; } }
  return reason ? {platform:input.platform,accountId:input.accountId,capability:input.capability,status:'unavailable',reason} : null;
}

/** Frozen actual native identity and credential configuration; never exposed as raw secrets. */
export function platformAccountIdentityHash(record:Record<string,unknown>,platform:RuntimeSocialPlatform):string{return createHash('sha256').update(JSON.stringify({id:record.id,tenantId:record.tenantId,platform,oauthProvider:record.oauthProvider,nativeId:platform==='youtube'?record.channelId:record.providerAccountId,parentPageId:record.parentPageId,scope:record.scope,status:record.status,accessToken:record.accessToken,refreshToken:record.refreshToken,clientId:record.clientId,clientSecret:record.clientSecret})).digest('hex');}

function scopeSet(record: AccountRecord): Set<string> {
  return new Set(text(record.scope).split(/[\s,]+/).filter(Boolean));
}

async function persistProbeEvidence(input: {
  tenantId: string; accountId: string; platform: RuntimeSocialPlatform; capability: RuntimePlatformCapability;
  status: PlatformCapabilityEvidence['status']; reasonCode?: string; providerRef: string; accountIdentityHash?:string; now: Date; dataStore: DataStore;
}): Promise<PlatformCapabilityEvidence> {
  const verifiedAt = input.now.toISOString();
  const payload = {
    ...(input.accountIdentityHash?{account_identity_hash:input.accountIdentityHash}:{}),
    tenant_id: input.tenantId,
    account_id: input.accountId,
    platform: input.platform,
    capability: input.capability,
    status: input.status,
    evidence_source: 'provider_probe',
    evidence_ref: `provider:${input.platform}:${input.providerRef}`,
    verified_at: verifiedAt,
    expires_at: new Date(input.now.getTime() + PLATFORM_CAPABILITY_PROBE_TTL_MS).toISOString(),
    reason_code: input.reasonCode || '',
    created_at: verifiedAt,
    updated_at: verifiedAt,
  };
  const where={tenant_id:input.tenantId,account_id:input.accountId,capability:input.capability,evidence_ref:payload.evidence_ref};
  async function existing(){const rows=await input.dataStore.list<PlatformCapabilityEvidence>(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION,{where,perPage:2});if(rows.totalItems!==rows.items.length||rows.items.length>1||rows.items.some(row=>Object.entries(where).some(([key,value])=>row[key as keyof PlatformCapabilityEvidence]!==value)))throw Error('platform_capability_evidence_ambiguous');return rows.items[0]??null;}
  async function replace(prior:PlatformCapabilityEvidence){if(prior.platform!==input.platform)throw Error('platform_capability_evidence_identity_changed');if(prior.verified_at>verifiedAt)return prior;if(input.accountIdentityHash){const collection=input.platform==='youtube'?'youtube_accounts':'social_accounts';const current=await input.dataStore.getById<AccountRecord>(collection,input.accountId);if(!current||platformAccountIdentityHash(current,input.platform)!==input.accountIdentityHash)throw Error('provider_account_changed_during_probe');}if(!await input.dataStore.update(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION,prior.id,{...payload,created_at:prior.created_at,account_identity_hash:input.accountIdentityHash??''}))throw Error('platform_capability_evidence_persist_failed');const saved=await existing();if(!saved)throw Error('platform_capability_evidence_persist_failed');return saved;}
  const prior=await existing();if(prior)return replace(prior);
  let record:PlatformCapabilityEvidence|null=null;try{record=await input.dataStore.create<PlatformCapabilityEvidence>(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION,payload);}catch(error){const winner=await existing();if(!winner)throw error;return replace(winner);}
  if (!record) throw new Error('platform_capability_evidence_persist_failed');
  return record;
}

/**
 * Performs a read-only call against the provider using the tenant account's
 * encrypted credential. It never infers permission from `status=connected` or
 * from an operator assertion. TikTok receipt lookup additionally needs a real
 * provider receipt because the provider exposes no credential-only capability
 * endpoint for that operation.
 */
export async function refreshPlatformCapabilityEvidence(input: {
  tenantId: string;
  accountId: string;
  platform: RuntimeSocialPlatform;
  capability: 'publishing.official' | 'publishing.receipt_lookup';
  receiptId?: string;
  now?: Date;
  dataStore?: DataStore;
  providers?: PlatformCapabilityProbeProviders;
}): Promise<PlatformCapabilityEvidence> {
  const dataStore = input.dataStore ?? store;
  const providers = input.providers ?? liveProviders;
  const now = input.now ?? new Date();
  const collection = input.platform === 'youtube' ? 'youtube_accounts' : 'social_accounts';
  const account = await dataStore.getById<AccountRecord>(collection, text(input.accountId));
  const belongsToTenant = account && text(account.tenantId) === text(input.tenantId);
  const matchesPlatform = input.platform === 'youtube' || text(account?.platform) === input.platform;
  if (!belongsToTenant || !matchesPlatform || account?.status !== 'connected') {
    return persistProbeEvidence({ ...input, status: 'unavailable', reasonCode: 'provider_account_not_connected', providerRef: 'account-unavailable', now, dataStore });
  }

  const accountIdentityHash=platformAccountIdentityHash(account,input.platform);
  try {
    if(input.platform === 'instagram') resolveInstagramPublishingContract(account);
    let providerRef = '';
    if (input.capability === 'publishing.receipt_lookup') {
      if (input.platform !== 'tiktok' || !text(input.receiptId)) {
        return persistProbeEvidence({ ...input, status: 'unavailable', reasonCode: 'real_provider_receipt_required', providerRef: 'receipt-unavailable', now, dataStore });
      }
      const result = await providers.tiktokReceipt(socialAccessToken(account), text(input.receiptId));
      if (text(result.publishId) !== text(input.receiptId)) throw new Error('provider_receipt_mismatch');
      providerRef = `receipt:${text(input.receiptId)}`;
    } else if (input.platform === 'youtube') {
      const result = await providers.youtube(youtubeCredentials(account));
      if (!text(result.id) || text(result.id) !== text(account.channelId)) throw new Error('provider_account_mismatch');
      if (!result.publishGranted) throw new Error('provider_publish_permission_not_granted');
      providerRef = `account:${text(result.id)}`;
    } else if (input.platform === 'facebook') {
      if (!scopeSet(account).has('pages_manage_posts')) throw new Error('provider_publish_scope_missing');
      const result = await providers.facebook(socialAccessToken(account), process.env.META_GRAPH_VERSION?.trim() || 'v25.0', text(account.providerAccountId));
      if (text(result.id) !== text(account.providerAccountId)) throw new Error('provider_account_mismatch');
      if (!result.publishGranted) throw new Error('provider_publish_permission_not_granted');
      providerRef = `account:${text(result.id)}`;
    } else if (input.platform === 'instagram') {
      const contract = assertInstagramPublishingScopes(account);
      const probe = contract.oauthProvider === 'instagram_login' ? providers.instagramLogin : providers.instagram;
      if(!probe) throw new Error('instagram_login_capability_probe_unavailable');
      const result = await probe(text(account.providerAccountId), socialAccessToken(account), process.env.META_GRAPH_VERSION?.trim() || 'v25.0');
      if (text(result.id) !== text(account.providerAccountId)) throw new Error('provider_account_mismatch');
      if (!result.publishGranted) throw new Error('provider_publish_permission_not_granted');
      providerRef = `account:${text(result.id)}`;
    } else if (input.platform === 'linkedin') {
      const requiredScope = linkedInRequiredPublishingScope({ providerAccountId: text(account.providerAccountId), parentPageId: text(account.parentPageId) });
      if (!scopeSet(account).has(requiredScope)) throw new Error('provider_publish_scope_missing');
      if (!providers.linkedin) throw new Error('linkedin_capability_probe_unavailable');
      const result = await providers.linkedin(socialAccessToken(account), account);
      const expectedAuthor = linkedInAuthorUrn({ providerAccountId: text(account.providerAccountId), parentPageId: text(account.parentPageId) });
      if (result.authorUrn !== expectedAuthor) throw new Error('provider_account_mismatch');
      if (!result.publishGranted) throw new Error('provider_publish_permission_not_granted');
      providerRef = `account:${expectedAuthor}`;
    } else {
      if (!scopeSet(account).has('video.publish')) throw new Error('provider_publish_scope_missing');
      const result = await providers.tiktok(socialAccessToken(account));
      if (text(result.openId) !== text(account.providerAccountId)) throw new Error('provider_account_mismatch');
      if (!result.publishGranted) throw new Error('provider_publish_permission_not_granted');
      providerRef = `account:${text(result.openId)}`;
    }
    const fresh=await dataStore.getById<AccountRecord>(collection,text(input.accountId));if(!fresh||platformAccountIdentityHash(fresh,input.platform)!==accountIdentityHash)throw Error('provider_account_changed_during_probe');
    return persistProbeEvidence({ ...input, status: 'verified', providerRef,accountIdentityHash, now, dataStore });
  } catch (error) {
    const reason = text(error instanceof Error ? error.message : error) || 'provider_probe_failed';
    // Keep a failed receipt probe tied to the requested receipt. Otherwise a
    // provider outage retries on every poll because the generic failure ref
    // never matches the requested receipt in ensurePlatformCapability.
    const providerRef = input.capability === 'publishing.receipt_lookup' && text(input.receiptId)
      ? `receipt:${text(input.receiptId)}` : 'probe-failed';
    return persistProbeEvidence({ ...input, status: 'unavailable', reasonCode: reason.slice(0, 120), providerRef, now, dataStore });
  }
}

/**
 * Production gate used by adapters. A missing/expired observation triggers one
 * read-only provider probe. A recent failed probe is honored until its short
 * TTL expires so a provider outage cannot cause a hot retry loop.
 */
export async function ensurePlatformCapability(input: {
  tenantId: string;
  accountId: string;
  platform: RuntimeSocialPlatform;
  capability: 'publishing.official' | 'publishing.receipt_lookup';
  receiptId?: string;
  now?: Date;
  dataStore?: DataStore;
  providers?: PlatformCapabilityProbeProviders;
}): Promise<PlatformCapabilityDecision> {
  const dataStore = input.dataStore ?? store;
  const boundary = await instagramPublishingBoundary(input,dataStore);
  if(boundary) return boundary;
  const now = input.now ?? new Date();
  const requestedReceiptRef = input.capability === 'publishing.receipt_lookup' && text(input.receiptId)
    ? `provider:${input.platform}:receipt:${text(input.receiptId)}` : '';
  // Receipt lookup is specific to one provider receipt. A successful probe
  // for another receipt cannot authorize it, nor can a newer failed probe for
  // another receipt hide its own cached result.
  const decision = requestedReceiptRef
    ? await (async (): Promise<PlatformCapabilityDecision> => {
      const rows = await dataStore.list<PlatformCapabilityEvidence>(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION, {
        where: { tenant_id: text(input.tenantId), account_id: text(input.accountId), platform: input.platform,
          capability: input.capability, evidence_ref: requestedReceiptRef },
        sort: '-verified_at', page: 1, perPage: 2,
      }).catch(() => ({ items: [], totalItems: 0, totalPages: 0, page: 1, perPage: 2 }));
      const evidence = rows.items[0];
      if (rows.items[1]?.verified_at === evidence?.verified_at) return { platform: input.platform, accountId: input.accountId, capability: input.capability, status: 'unavailable', reason: 'capability_evidence_ambiguous' };
      if (!evidence) return { platform: input.platform, accountId: input.accountId, capability: input.capability, status: 'unavailable', reason: 'provider_capability_not_verified' };
      return { platform: input.platform, accountId: input.accountId, capability: input.capability,
        status: platformCapabilityEvidenceIsCurrent(evidence, now) ? 'available' : 'unavailable',
        reason: platformCapabilityEvidenceIsCurrent(evidence, now) ? 'provider_capability_verified' : evidence.reason_code || 'provider_capability_expired_or_unavailable',
        verifiedAt: evidence.verified_at, evidenceRef: evidence.evidence_ref };
    })()
    : await platformCapabilityDecision({ ...input, now, dataStore });
  if (decision.status === 'available') return decision;
  const latest = await dataStore.list<PlatformCapabilityEvidence>(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION, {
    where: { tenant_id: text(input.tenantId), account_id: text(input.accountId), platform: input.platform,
      capability: input.capability, ...(requestedReceiptRef ? { evidence_ref: requestedReceiptRef } : {}) },
    sort: '-verified_at', page: 1, perPage: 1,
  }).catch(() => ({ items: [], totalItems: 0, totalPages: 0, page: 1, perPage: 1 }));
  const retryAfter = Date.parse(text(latest.items[0]?.expires_at));
  if (latest.items[0]?.status !== 'verified' && Number.isFinite(retryAfter) && retryAfter > now.getTime()) return decision;
  const refreshed = await refreshPlatformCapabilityEvidence({ ...input, now, dataStore });
  if (platformCapabilityEvidenceIsCurrent(refreshed, now)
    && (!requestedReceiptRef || refreshed.evidence_ref === requestedReceiptRef)) {
    return { platform: input.platform, accountId: input.accountId, capability: input.capability, status: 'available', reason: 'provider_capability_verified', verifiedAt: refreshed.verified_at, evidenceRef: refreshed.evidence_ref };
  }
  return { platform: input.platform, accountId: input.accountId, capability: input.capability, status: 'unavailable', reason: refreshed.reason_code || 'provider_capability_expired_or_unavailable', verifiedAt: refreshed.verified_at, evidenceRef: refreshed.evidence_ref };
}

export async function listTenantCapabilityEvidence(
  tenantId: string,
  dataStore: DataStore = store,
): Promise<PlatformCapabilityEvidence[]> {
  const result = await dataStore.list<PlatformCapabilityEvidence>(PLATFORM_CAPABILITY_EVIDENCE_COLLECTION, {
    where: { tenant_id: text(tenantId) }, sort: '-verified_at', page: 1, perPage: 500,
  }).catch(() => ({ items: [], totalItems: 0, totalPages: 0, page: 1, perPage: 500 }));
  return result.items;
}
