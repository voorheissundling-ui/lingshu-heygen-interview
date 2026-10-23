import { tikTokCreatorConsentHash } from './tiktokCreatorConsent.js';
import type { DataStore } from '../storage/datastore.js';
import { assertTikTokAttemptReceipt, tikTokAccountIdentityHash, type TikTokAttemptPreparedReceipt, type TikTokDirectPostOptions } from '../lib/tikTokDirectPostContract.js';
import { resolveInstagramPublishingContract, assertInstagramPublishingScopes } from './instagramPublishingContract.js';
import {assertPublicationAtomicStore} from './publicationAtomicStore.js';
import { assertManagedPublishingAuthorization } from './managedPublishingAuthorization.js';
import {
  assertNoUnresolvedPublishing,
  withDirectPublishingLease,
  type DirectPublishingLeaseGuard,
} from './pendingPublishGuard.js';
import axios from 'axios';
import { getAccessToken, uploadVideoToYouTube, type YouTubeConfig } from '../integrations/youtube.js';
import {
  getTikTokPublishStatus,
  publishFacebookImagePost,
  publishInstagramReel,
  uploadFacebookVideo,
  uploadTikTokVideo,
  type SocialPlatform,
  type SocialUploadInput,
} from '../integrations/social.js';
import { recordSuccessfulPublish, type PublishPlatform } from '../lib/publishHistory.js';
import { store } from '../storage/index.js';
import { appendTrackedWaLink, createTrackedPostDraft, finalizeTrackedPost, type PostRecord } from './waLink.js';
import {
  freezePublishSourceClaim,
  verifyFrozenPublishSourceClaim,
  type FrozenPublishSourceClaim,
  type PublishSourceRequestKind,
} from './publishSourceClaim.js';
import { socialAccessToken, youtubeCredentials } from '../lib/accountCredentials.js';
import { tikTokDirectPostApproved } from '../lib/socialOAuthScopes.js';
import { assertPublishingCopyFactVersion, type PublishingCopyAudit } from './copyFactVersion.js';
import { publishLinkedInWithDurableReceipt, resolvePendingLinkedInPublish } from './linkedInPublisher.js';
import { normalizeVideoPath, parsePublishingTags, publishError, publishingAccountStatus } from './platformPublisherUtils.js';
import { instagramCompatibleVideo, publicVideoUrlIfNeeded, validateLocalVideo } from './publishVideoMedia.js';
import { assertUnifiedPublishPreflight } from './unifiedPublishPreflight.js';

interface YouTubeAccountRecord {
  id: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  status: 'connected' | 'error' | 'expired';
}

interface SocialAccountRecord {
  id: string;
  tenantId: string;
  platform: SocialPlatform;
  providerAccountId: string;
  accessToken: string;
  oauthProvider?: string;
  scope?: string;
  parentPageId?: string;
  status: 'connected' | 'error' | 'expired';
}

export interface PublishToAccountInput {
  tenantId: string;
  accountId: string;
  platform: PublishPlatform;
  videoPath?: string;
  videoUrl?: string;
  imagePaths?: string[];
  title: string;
  description?: string;
  tags?: unknown;
  privacyStatus?: 'private' | 'unlisted' | 'public';
  madeForKids?: boolean;
  projectId?: string;
  generationVersionId?: string;
  generationKind?: 'script' | 'poster';
  generationProvenance?: string;
  qualityStatus?: string;
  publishable?: boolean;
  generationRecordId?: string;
  sourceKind?: PublishSourceRequestKind;
  sourceVideoPath?: string;
  sourceClaim?: FrozenPublishSourceClaim;
  ratio?: string;
  language?: string;
  contentId?: string;
  trackWaLink?: boolean;
  trackingPost?: PostRecord;
  finalizeTracking?: boolean;
  publishAttemptId?: string;
  enterpriseFactVersion?: string;
  copyAudit?: PublishingCopyAudit;
  onProviderReceipt?: (receiptId: string) => Promise<void>;
  onPublishedMedia?: (mediaId: string) => Promise<void>;
  tiktokPostOptions?: TikTokDirectPostOptions;
  tiktokCreatorReceiptHash?: string;
  onTikTokAttemptPrepared?: (receipt: TikTokAttemptPreparedReceipt) => Promise<void>;
}

export interface PublishToAccountResult {
  video: unknown;
  tracking: PostRecord;
  publishRecord: ReturnType<typeof recordSuccessfulPublish> | null;
  platformPostId: string;
  deliveryStatus?: 'published' | 'provider_accepted';
  providerReceiptId?: string;
  platformUrl?: string;
}

export interface PendingPublishResolution {
  status: 'processing' | 'published' | 'failed' | 'unknown';
  providerReceiptId: string;
  platformPostId: string;
  platformUrl: string;
  providerStatus: string;
  error: string;
}


async function revalidatePublishSource(input: PublishToAccountInput): Promise<void> {
  if(input.sourceClaim?.weeklyAssignment&&input.videoUrl)throw Error('weekly_publish_remote_video_override_forbidden');
  if (input.trackingPost) await assertManagedPublishingAuthorization(input.trackingPost, input.accountId);
  await assertPublishingCopyFactVersion(input.tenantId, input);
  if (!input.sourceClaim) throw publishError('发布来源校验记录缺失', 409);
  await verifyFrozenPublishSourceClaim(input.tenantId, input.sourceClaim, input.videoPath, input.imagePaths);
}

async function trackingPost(input: PublishToAccountInput): Promise<PostRecord> {
  if (input.trackingPost) {
    if (input.trackingPost.tenant_id !== input.tenantId) throw publishError('Scheduled post does not belong to this tenant', 404);
    if (input.trackingPost.platform && input.trackingPost.platform !== input.platform) throw publishError('Scheduled post platform does not match target account', 400);
    return input.trackingPost;
  }
  return createTrackedPostDraft(input.tenantId, {
    contentId: input.contentId,
    platform: input.platform,
    title: input.title,
    language: input.language,
    enabled: input.trackWaLink !== false,
  }, input.copyAudit ? { stats: { enterpriseFactVersion: input.copyAudit.enterpriseFactVersion, copyAudit: input.copyAudit } } : undefined);
}

function platformContentId(video: any): string {
  return String(video?.id || video?.videoId || video?.publishId || '').trim();
}

function recordObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* empty */ }
  }
  return {};
}

async function persistProviderAccepted(input: {
  request: PublishToAccountInput;
  tracked: PostRecord;
  providerReceiptId: string;
}): Promise<void> {
  if (input.request.finalizeTracking === false) return;
  const now = new Date().toISOString();
  const current = await store.getById<PostRecord>('posts', input.tracked.id);
  if (!current || current.tenant_id !== input.request.tenantId) throw publishError('tiktok_attempt_missing', 503);
  const currentStats = recordObject(current.stats);
  const publishResults = recordObject(currentStats.publishResults);
  const existing = recordObject(publishResults[input.request.accountId]);
  const attemptId = String(existing.attemptId || input.request.publishAttemptId || '');
  if (!attemptId || existing.providerReceiptId !== input.providerReceiptId) throw publishError('tiktok_attempt_changed', 409);
  const updated = await store.update('posts', input.tracked.id, {
    stats: {
      ...currentStats,
      status: 'provider_processing',
      targetAccountIds: [input.request.accountId],
      videoPath: input.request.videoPath || '',
      videoUrl: input.request.videoUrl || '',
      publishAttempts: Math.max(1, Number(currentStats.publishAttempts || 0)),
      publishResults: {
        ...publishResults,
        [input.request.accountId]: {
          ...existing,
          status: 'provider_accepted',
          attemptId,
          startedAt: now,
          providerReceiptId: input.providerReceiptId,
          lastCheckedAt: '',
        },
      },
      nextProviderCheckAt: now,
      publishError: '',
      warnings: ['TikTok 已接收上传，正在等待平台发布终态。'],
    },
  });
  if (!updated) {
    throw publishError('TikTok 已接收上传，但本地未能保存处理回执；禁止重复提交，请人工核对', 503);
  }
}

async function beginDirectAttempt(
  input: PublishToAccountInput,
  tracked: PostRecord,
): Promise<{ attemptId: string; startedAt: string } | null> {
  if (input.finalizeTracking === false && input.platform !== 'tiktok') return null;
  const attemptId = input.publishAttemptId || `direct:${tracked.id}`;
  const startedAt = new Date().toISOString();
  const currentStats = recordObject(tracked.stats);
  const publishResults = recordObject(currentStats.publishResults);
  const updated = await store.update('posts', tracked.id, {
    stats: {
      ...currentStats,
      status: 'publishing',
      targetAccountIds: [input.accountId],
      videoPath: input.videoPath || '',
      videoUrl: input.videoUrl || '',
      imagePaths: input.imagePaths || [],
      publishAttempts: Math.max(1, Number(currentStats.publishAttempts || 0)),
      publishResults: {
        ...publishResults,
        [input.accountId]: { status: 'in_flight', attemptId, startedAt },
      },
      publishError: '',
      warnings: [],
    },
  });
  if (!updated) throw publishError('无法保存发布尝试，尚未调用平台', 503);
  return { attemptId, startedAt };
}

async function markDirectAttemptNotSubmitted(
  input: PublishToAccountInput,
  tracked: PostRecord,
  attempt: { attemptId: string; startedAt: string } | null,
  error: unknown,
): Promise<void> {
  if (!attempt) return;
  const current = await store.getById<PostRecord>('posts', tracked.id).catch(() => null);
  if (!current) return;
  const stats = recordObject(current.stats);
  const publishResults = recordObject(stats.publishResults);
  const existing = recordObject(publishResults[input.accountId]);
  if (String(existing.attemptId || '') !== attempt.attemptId || existing.status !== 'in_flight') return;
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : '发布安全锁不可用';
  await store.update('posts', tracked.id, {
    stats: {
      ...stats,
      status: 'failed',
      publishResults: {
        ...publishResults,
        [input.accountId]: {
          ...existing,
          status: 'failed',
          error: message,
          failedAt: new Date().toISOString(),
          providerCalled: false,
        },
      },
      publishError: message,
      warnings: [message],
    },
  }).catch(() => undefined);
}

async function markDirectAttemptUnknown(
  input: PublishToAccountInput,
  tracked: PostRecord,
  attempt: { attemptId: string; startedAt: string } | null,
  error: unknown,
): Promise<void> {
  if (!attempt) return;
  const current = await store.getById<PostRecord>('posts', tracked.id).catch(() => null);
  if (!current) return;
  const stats = recordObject(current.stats);
  const publishResults = recordObject(stats.publishResults);
  const existing = recordObject(publishResults[input.accountId]);
  if (String(existing.attemptId || '') !== attempt.attemptId
    || !['in_flight', 'provider_accepted'].includes(String(existing.status || ''))) return;
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : '平台结果不明，需人工核对';
  await store.update('posts', tracked.id, {
    stats: {
      ...stats,
      status: 'needs_attention',
      publishResults: {
        ...publishResults,
        [input.accountId]: {
          ...existing,
          status: 'unknown',
          error: message,
          failedAt: new Date().toISOString(),
        },
      },
      publishError: '平台结果不明，需核对回执，禁止自动重发',
      warnings: ['平台结果不明，需核对回执，禁止自动重发'],
    },
  }).catch(() => undefined);
}

/** Recover only a durably recorded real init identity after an outer callback failed. */
export async function readTikTokCanonicalAttemptReceipt(input: {
  tenantId: string; accountId: string; attemptId: string; dataStore?: DataStore;
}): Promise<string | null> {
  if (!input.tenantId.trim() || !input.accountId.trim() || !input.attemptId.trim()) return null;
  const dataStore = input.dataStore ?? store;
  const account = await dataStore.getById<SocialAccountRecord>('social_accounts', input.accountId);
  if (!account || account.tenantId !== input.tenantId || account.platform !== 'tiktok' || account.status !== 'connected') return null;
  let identityHash: string;
  try { identityHash = tikTokAccountIdentityHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: account.providerAccountId, accessToken: socialAccessToken(account as unknown as Record<string, unknown>) }); }
  catch { return null; }
  const posts = await dataStore.list<PostRecord>('posts', { where: { tenant_id: input.tenantId }, perPage: 500 });
  if (posts.totalItems !== posts.items.length) return null;
  const candidates = posts.items.filter(post => post.tenant_id === input.tenantId && post.platform === 'tiktok').map(post => recordObject(recordObject(recordObject(post.stats).publishResults)[input.accountId])).filter(attempt => attempt.attemptId === input.attemptId);
  if (candidates.length !== 1) return null;
  const attempt = candidates[0]!, receiptId = String(attempt.providerReceiptId || '').trim();
  if (!receiptId || receiptId.length > 64 || /[\u0000-\u001f\u007f]/.test(receiptId) || !['in_flight','unknown','provider_accepted','published'].includes(String(attempt.status))) return null;
  try { assertTikTokAttemptReceipt(attempt.tiktokValidationReceipt as TikTokAttemptPreparedReceipt, { tenantId: input.tenantId, accountId: input.accountId, attemptId: input.attemptId, accountIdentityHash: identityHash }); }
  catch { return null; }
  const fresh = await dataStore.getById<SocialAccountRecord>('social_accounts', input.accountId);
  if (!fresh || fresh.tenantId !== input.tenantId || fresh.platform !== 'tiktok' || fresh.status !== 'connected') return null;
  try { if (tikTokAccountIdentityHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: fresh.providerAccountId, accessToken: socialAccessToken(fresh as unknown as Record<string, unknown>) }) !== identityHash) return null; }
  catch { return null; }
  return receiptId;
}

/** Resolve an already accepted provider receipt without submitting content again. */
export async function resolvePendingPublishToAccount(input: {
  tenantId: string;
  accountId: string;
  platform: PublishPlatform;
  providerReceiptId: string;
  platformPostId?: string;
  publishAttemptId?: string;
}): Promise<PendingPublishResolution> {
  const receipt = input.providerReceiptId.trim();
  if (!receipt) throw publishError('平台发布回执为空', 400);
  if (input.platform === 'youtube') {
    const account = await store.getById<YouTubeAccountRecord>('youtube_accounts', input.accountId);
    if (!account || account.tenantId !== input.tenantId) throw publishError('YouTube account not found', 404);
    if (account.status !== 'connected') throw publishError('YouTube account is not connected', 400);
    const token = await getAccessToken(youtubeCredentials(account as unknown as Record<string, unknown>));
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'id,status,processingDetails', id: receipt },
      headers: { Authorization: `Bearer ${token}` },
    });
    const video = response.data?.items?.[0];
    if (!video?.id) return { status: 'unknown', providerReceiptId: receipt, platformPostId: '', platformUrl: '', providerStatus: 'NOT_FOUND', error: 'YouTube 未找到该视频，需人工核对' };
    const uploadStatus = String(video.status?.uploadStatus || '').toLowerCase();
    if (uploadStatus === 'failed' || uploadStatus === 'rejected' || uploadStatus === 'deleted') {
      return { status: 'failed', providerReceiptId: receipt, platformPostId: receipt, platformUrl: `https://www.youtube.com/watch?v=${receipt}`, providerStatus: uploadStatus, error: String(video.status?.failureReason || video.status?.rejectionReason || 'YouTube processing failed') };
    }
    if (uploadStatus && uploadStatus !== 'processed') {
      return { status: 'processing', providerReceiptId: receipt, platformPostId: receipt, platformUrl: `https://www.youtube.com/watch?v=${receipt}`, providerStatus: uploadStatus, error: '' };
    }
    const privacyStatus = String(video.status?.privacyStatus || '').toLowerCase();
    if (privacyStatus !== 'public') {
      return {
        status: 'processing', providerReceiptId: receipt, platformPostId: receipt,
        platformUrl: `https://www.youtube.com/watch?v=${receipt}`,
        providerStatus: `processed:${privacyStatus || 'privacy_unknown'}`,
        error: `YouTube 视频已处理但尚未公开（${privacyStatus || 'unknown'}）`,
      };
    }
    return { status: 'published', providerReceiptId: receipt, platformPostId: receipt, platformUrl: `https://www.youtube.com/watch?v=${receipt}`, providerStatus: 'processed:public', error: '' };
  }
  if (input.platform === 'facebook' || input.platform === 'instagram') {
    const account = await store.getById<SocialAccountRecord>('social_accounts', input.accountId);
    if (!account || account.tenantId !== input.tenantId || account.platform !== input.platform) throw publishError('Social account not found', 404);
    if (account.status !== 'connected') throw publishError('Social account is not connected', 400);
    if (input.platform === 'instagram') {
      const contract = resolveInstagramPublishingContract(account);
      if (contract.oauthProvider === 'instagram_login' && !String(account.scope || '').split(/[\s,]+/).includes('instagram_business_basic')) throw publishError('provider_read_scope_missing', 403);
    }
    const lookupReceipt = input.platform === 'instagram' && receipt.startsWith('ig-container:') && input.platformPostId?.trim() ? input.platformPostId.trim() : receipt;
    if (input.platform === 'instagram' && receipt.startsWith('ig-container:') && lookupReceipt === receipt) {
      const containerId = receipt.slice('ig-container:'.length);
      if (!containerId) throw publishError('Instagram container receipt missing', 400);
      const response = await axios.get(`${resolveInstagramPublishingContract(account).graphHost}/${process.env.META_GRAPH_VERSION?.trim() || 'v25.0'}/${encodeURIComponent(containerId)}`, {
        maxRedirects: 0,
        params: { access_token: socialAccessToken(account as unknown as Record<string, unknown>), fields: 'id,status,status_code' },
      });
      const status = String(response.data?.status_code || '');
      if (String(response.data?.id || '') !== containerId) return { status: 'unknown', providerReceiptId: receipt, platformPostId: '', platformUrl: '', providerStatus: 'CONTAINER_MISMATCH', error: 'Instagram 容器回执不匹配' };
      return { status: ['ERROR', 'EXPIRED'].includes(status) ? 'failed' : status === 'IN_PROGRESS' ? 'processing' : 'unknown', providerReceiptId: receipt, platformPostId: '', platformUrl: '', providerStatus: status, error: status === 'PUBLISHED' ? '容器已发布，需核对最终媒体 ID；禁止重新发布' : '仅查询原容器，禁止重新创建或发布' };
    }
    const response = await axios.get(`${input.platform === 'instagram' ? resolveInstagramPublishingContract(account).graphHost : 'https://graph.facebook.com'}/${process.env.META_GRAPH_VERSION?.trim() || 'v25.0'}/${encodeURIComponent(lookupReceipt)}`, {
      params: {
        access_token: socialAccessToken(account as unknown as Record<string, unknown>),
        fields: input.platform === 'facebook' ? 'id,permalink_url,status' : 'id,permalink,media_type',
      },
      maxRedirects: 0,
    });
    const id = String(response.data?.id || '').trim();
    if (!id || (input.platform === 'instagram' && id !== lookupReceipt)) return { status: 'unknown', providerReceiptId: receipt, platformPostId: '', platformUrl: '', providerStatus: 'NOT_FOUND', error: `${input.platform} 未找到该内容，需人工核对` };
    if (input.platform === 'facebook') {
      const videoStatus = String(response.data?.status?.video_status || response.data?.status || '').toLowerCase();
      if (videoStatus === 'error' || videoStatus === 'failed') return { status: 'failed', providerReceiptId: receipt, platformPostId: id, platformUrl: String(response.data?.permalink_url || ''), providerStatus: videoStatus, error: 'Facebook 视频处理失败' };
      if (videoStatus && !['ready', 'published', 'complete', 'completed'].includes(videoStatus)) return { status: 'processing', providerReceiptId: receipt, platformPostId: id, platformUrl: String(response.data?.permalink_url || ''), providerStatus: videoStatus, error: '' };
    }
    if (input.platform === 'instagram' && resolveInstagramPublishingContract(account).oauthProvider === 'instagram_login') {
      let owned = false, after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const media = await axios.get(`${resolveInstagramPublishingContract(account).graphHost}/${process.env.META_GRAPH_VERSION?.trim() || 'v25.0'}/${encodeURIComponent(account.providerAccountId)}/media`, {
          maxRedirects: 0, params: { access_token: socialAccessToken(account as unknown as Record<string, unknown>), fields: 'id', limit: 100, ...(after ? { after } : {}) },
        });
        owned = Array.isArray(media.data?.data) && media.data.data.some((item: { id?: unknown }) => String(item.id || '') === id);
        if (owned) break;
        after = String(media.data?.paging?.cursors?.after || '');
        if (!media.data?.paging?.next || !after) break;
      }
      if (!owned) return { status: 'unknown', providerReceiptId: receipt, platformPostId: '', platformUrl: '', providerStatus: 'ACCOUNT_MEDIA_UNVERIFIED', error: 'Instagram 原媒体不属于目标账号或暂未可核验，禁止重新发布' };
    }
    return {
      status: 'published', providerReceiptId: receipt, platformPostId: id,
      platformUrl: String(response.data?.permalink_url || response.data?.permalink || ''),
      providerStatus: 'published', error: '',
    };
  }
  if (input.platform === 'linkedin') {
    return resolvePendingLinkedInPublish({ tenantId: input.tenantId, accountId: input.accountId, receipt });
  }
  if (input.platform !== 'tiktok') {
    return {
      status: 'unknown',
      providerReceiptId: input.providerReceiptId,
      platformPostId: '',
      platformUrl: '',
      providerStatus: '',
      error: '当前平台不支持自动查询发布终态',
    };
  }
  const account = await store.getById<SocialAccountRecord>('social_accounts', input.accountId);
  if (!account || account.tenantId !== input.tenantId || account.platform !== 'tiktok') {
    throw publishError('TikTok account not found', 404);
  }
  if (account.status !== 'connected') throw publishError('TikTok account is not connected', 400);
  const identityHash = tikTokAccountIdentityHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: account.providerAccountId, accessToken: socialAccessToken(account as unknown as Record<string, unknown>) });
  const posts = await store.list<PostRecord>('posts', { where: { tenant_id: input.tenantId }, perPage: 500 });
  if (posts.totalItems !== posts.items.length) throw publishError('tiktok_canonical_attempt_scan_incomplete', 409);
  const candidates = posts.items.map(post => recordObject(recordObject(recordObject(post.stats).publishResults)[input.accountId])).filter(attempt => attempt.providerReceiptId === input.providerReceiptId && (!input.publishAttemptId || attempt.attemptId === input.publishAttemptId));
  if (candidates.length !== 1) throw publishError('tiktok_canonical_attempt_missing_or_ambiguous', 409);
  const canonical = candidates[0]!;
  assertTikTokAttemptReceipt(canonical.tiktokValidationReceipt as TikTokAttemptPreparedReceipt, { tenantId: input.tenantId, accountId: input.accountId, attemptId: String(canonical.attemptId), accountIdentityHash: identityHash });
  const result = await getTikTokPublishStatus(
    socialAccessToken(account as unknown as Record<string, unknown>),
    input.providerReceiptId,
  );
  const freshAccount = await store.getById<SocialAccountRecord>('social_accounts', input.accountId);
  if (!freshAccount || freshAccount.tenantId !== input.tenantId || freshAccount.platform !== 'tiktok' || freshAccount.status !== 'connected' || tikTokAccountIdentityHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: freshAccount.providerAccountId, accessToken: socialAccessToken(freshAccount as unknown as Record<string, unknown>) }) !== identityHash) throw publishError('tiktok_account_changed_during_lookup', 409);
  return {
    status: result.state,
    providerReceiptId: result.publishId,
    platformPostId: result.platformPostId,
    platformUrl: result.url,
    providerStatus: result.providerStatus,
    error: result.failureReason,
  };
}

async function finalizeIfRequested(input: PublishToAccountInput, tracked: PostRecord, platformPostId: string): Promise<void> {
  if (input.finalizeTracking === false) return;
  const current = await store.getById<PostRecord>('posts', tracked.id);
  const stats = recordObject(current?.stats);
  const publishResults = recordObject(stats.publishResults);
  const existing = recordObject(publishResults[input.accountId]);
  const publishedAt = new Date().toISOString();
  await finalizeTrackedPost(tracked.id, {
    platformPostId,
    title: input.title,
    stats: {
      ...stats,
      status: 'published',
      publishResults: {
        ...publishResults,
        [input.accountId]: { ...existing, status: 'published', platformPostId, publishedAt },
      },
      publishedAt,
      publishError: '',
      warnings: [],
    },
  });
}

async function publishVideoToAccountWithLease(
  input: PublishToAccountInput,
  publishLease: DirectPublishingLeaseGuard,
): Promise<PublishToAccountResult> {
  await assertNoUnresolvedPublishing({ tenantId: input.tenantId, platform: input.platform, accountIds: [input.accountId], contentId: input.contentId || input.sourceClaim?.projectId, videoPath: input.videoPath, videoUrl: input.videoUrl, currentPostId: input.trackingPost?.id, currentAttemptId: input.publishAttemptId });
  const imagePaths = [...new Set((input.imagePaths ?? []).map(normalizeVideoPath))];
  if (imagePaths.length && input.platform !== 'facebook' && input.platform !== 'linkedin') {
    throw publishError('当前统一图文发布只支持 Facebook 与 LinkedIn', 400);
  }
  if (input.platform === 'tiktok' && !tikTokDirectPostApproved()) {
    throw publishError('TikTok Direct Post 尚未通过正式审核，当前仅开放账号连接与发布准备，不会向 TikTok 提交内容。', 409);
  }
  if (input.platform === 'youtube') {
    const account = await store.getById<YouTubeAccountRecord>('youtube_accounts', input.accountId);
    if (!account || account.tenantId !== input.tenantId) throw publishError('YouTube account not found', 404);
    if (account.status !== 'connected') throw publishError('YouTube account is not connected', 400);
    const privacyStatus = input.privacyStatus || 'unlisted';
    if (!['private', 'unlisted', 'public'].includes(privacyStatus)) throw publishError('Invalid YouTube privacy status', 400);
    const filePath = validateLocalVideo(input.videoPath, ['.mp4', '.mov', '.webm', '.mkv', '.avi'], Number(process.env.YOUTUBE_MAX_UPLOAD_MB ?? 2048));
    const tracked = await trackingPost(input);
    const description = appendTrackedWaLink('youtube', input.description || '', tracked.wa_link || '');
    const config: YouTubeConfig = youtubeCredentials(account as unknown as Record<string, unknown>);
    let directAttempt: { attemptId: string; startedAt: string } | null = null;
    let providerStarted = false;
    try {
      directAttempt = await beginDirectAttempt(input, tracked);
      await publishLease.beforeEffect();
      await revalidatePublishSource(input);
      providerStarted = true;
      const video = await uploadVideoToYouTube(config, {
        filePath,
        title: input.title,
        description,
        tags: parsePublishingTags(input.tags, description),
        privacyStatus,
        madeForKids: input.madeForKids ?? false,
      });
      const id = platformContentId(video);
      if (!id) throw publishError('YouTube did not return a video id', 502);
      await finalizeIfRequested(input, tracked, id).catch(error => console.error('[publishing] YouTube tracking update failed:', error));
      await store.update('youtube_accounts', input.accountId, { lastSyncAt: new Date().toISOString(), status: 'connected' })
        .catch(error => console.error('[publishing] YouTube account sync update failed:', error));
      let publishRecord: ReturnType<typeof recordSuccessfulPublish> | null = null;
      try {
        publishRecord = recordSuccessfulPublish({
          tenantId: input.tenantId,
          platform: 'youtube',
          accountId: input.accountId,
          platformContentId: id,
          projectId: input.projectId,
          generationVersionId: input.generationVersionId,
          title: input.title,
          description: input.description || '',
          videoPath: input.videoPath,
          ratio: input.ratio,
          language: input.language,
        });
      } catch (error) {
        console.error('[publishing] YouTube history write failed:', error);
      }
      return { video, tracking: tracked, publishRecord, platformPostId: id, deliveryStatus: 'published' };
    } catch (error) {
      if (providerStarted) await markDirectAttemptUnknown(input, tracked, directAttempt, error);
      else await markDirectAttemptNotSubmitted(input, tracked, directAttempt, error);
      const status = publishingAccountStatus(error);
      if (status === 401 || status === 403) await store.update('youtube_accounts', input.accountId, { status: 'error' });
      throw error;
    }
  }

  const account = await store.getById<SocialAccountRecord>('social_accounts', input.accountId);
  if (!account || account.tenantId !== input.tenantId || account.platform !== input.platform) throw publishError('Social account not found', 404);
  if (account.status !== 'connected') throw publishError('Social account is not connected', 400);
  if (input.platform === 'instagram') {
    const contract = resolveInstagramPublishingContract(account);
    if (contract.oauthProvider === 'instagram_login') assertInstagramPublishingScopes(account);
  }
  const filePath = !imagePaths.length && input.videoPath
    ? validateLocalVideo(
      input.videoPath,
      input.platform === 'linkedin' ? ['.mp4'] : ['.mp4', '.mov', '.webm'],
      input.platform === 'linkedin' ? Number(process.env.LINKEDIN_MAX_UPLOAD_MB ?? 500) : Number(process.env.SOCIAL_MAX_UPLOAD_MB ?? 2048),
    )
    : undefined;
  if (!imagePaths.length && !filePath && !input.videoUrl) throw publishError('缺少待发布的视频文件、公开视频地址或图片产物', 400);
  if (account.platform === 'tiktok' && !filePath) {
    throw publishError('当前 TikTok 发布实现需要本地视频文件', 400);
  }
  if (account.platform === 'instagram' && !input.videoUrl && !process.env.R2_PUBLIC_URL?.trim()) {
    throw publishError('Instagram 发布需要配置 R2_PUBLIC_URL 或提供公开视频地址', 400);
  }
  const tracked = await trackingPost(input);
  const accessToken = socialAccessToken(account as unknown as Record<string, unknown>);
  const socialInput: SocialUploadInput = {
    filePath,
    videoUrl: input.videoUrl,
    title: input.title,
    description: appendTrackedWaLink(account.platform, input.description || '', tracked.wa_link || ''),
    privacyStatus: input.privacyStatus,
  };
  let directAttempt: { attemptId: string; startedAt: string } | null = null;
  let providerStarted = false;
  try {
    directAttempt = await beginDirectAttempt(input, tracked);
    let video: unknown;
    if (account.platform === 'tiktok') {
      if (!directAttempt) throw publishError('tiktok_durable_attempt_missing', 503);
      if (!String(account.scope || '').split(/[\s,]+/).includes('video.publish')) throw publishError('provider_publish_scope_missing', 403);
      const accountIdentityHash = tikTokAccountIdentityHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: account.providerAccountId, accessToken });
      const assertAccount = async () => {
        const fresh = await store.getById<SocialAccountRecord>('social_accounts', input.accountId);
        if (!fresh || fresh.tenantId !== input.tenantId || fresh.platform !== 'tiktok' || fresh.status !== 'connected' || tikTokAccountIdentityHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: fresh.providerAccountId, accessToken: socialAccessToken(fresh as unknown as Record<string, unknown>) }) !== accountIdentityHash) throw publishError('tiktok_account_identity_changed', 409);
        const user = await axios.get('https://open.tiktokapis.com/v2/user/info/', { maxRedirects: 0, timeout: 30_000, params: { fields: 'open_id,display_name' }, headers: { Authorization: `Bearer ${accessToken}` } });
        if (user.data?.error?.code !== 'ok' || String(user.data?.data?.user?.open_id || '') !== account.providerAccountId) throw publishError('tiktok_provider_account_changed', 409);
      };
      const persistAttempt = async (patch: Record<string, unknown>) => {
        const current = await store.getById<PostRecord>('posts', tracked.id);
        if (!current || current.tenant_id !== input.tenantId) throw publishError('tiktok_attempt_missing', 503);
        const stats = recordObject(current.stats), results = recordObject(stats.publishResults), attempt = recordObject(results[input.accountId]);
        if (attempt.attemptId !== directAttempt!.attemptId || attempt.status !== 'in_flight') throw publishError('tiktok_attempt_changed', 409);
        if (patch.providerReceiptId && attempt.providerReceiptId && patch.providerReceiptId !== attempt.providerReceiptId) throw publishError('tiktok_receipt_changed', 409);
        if (!await store.update('posts', tracked.id, { stats: { ...stats, publishResults: { ...results, [input.accountId]: { ...attempt, ...patch } } } })) throw publishError('tiktok_attempt_persistence_failed', 503);
      };
      await assertAccount();
      video = await uploadTikTokVideo(accessToken, socialInput, {
        tenantId: input.tenantId, accountId: input.accountId, attemptId: directAttempt.attemptId, accountIdentityHash, options: input.tiktokPostOptions!,
        async onTikTokAttemptPrepared(receipt) {
          await assertAccount();
          if (input.tiktokCreatorReceiptHash && input.tiktokCreatorReceiptHash !== tikTokCreatorConsentHash({ tenantId: input.tenantId, accountId: input.accountId, providerAccountId: account.providerAccountId, accessToken, creator: receipt.creator })) throw publishError('tiktok_creator_display_changed', 409);
          if (input.onTikTokAttemptPrepared) await input.onTikTokAttemptPrepared(structuredClone(receipt));
          assertTikTokAttemptReceipt(receipt, { tenantId: input.tenantId, accountId: input.accountId, accountIdentityHash, attemptId: directAttempt!.attemptId });
          await persistAttempt({ tiktokValidationReceipt: receipt });
        },
        async beforeInit() { await assertAccount(); await publishLease.beforeEffect(); await revalidatePublishSource(input); providerStarted = true; },
        async onProviderReceipt(receipt, initialized) { await persistAttempt({ providerReceiptId: receipt, tiktokUploadUrlHash: initialized.uploadUrlHash }); if (input.onProviderReceipt) await input.onProviderReceipt(receipt); },
        async beforeUpload() { await assertAccount(); await publishLease.beforeEffect(); await revalidatePublishSource(input); },
      });
    }
    if (account.platform === 'facebook') {
      if (imagePaths.length) {
        video = await publishFacebookImagePost(account.providerAccountId, accessToken, process.env.META_GRAPH_VERSION?.trim() || 'v25.0', {
          imagePaths,
          title: input.title,
          description: socialInput.description || '',
        }, {
          async beforeImageUpload() {
            await publishLease.beforeEffect();
            await revalidatePublishSource(input);
            providerStarted = true;
          },
          async beforePublish() {
            await publishLease.beforeEffect();
            await revalidatePublishSource(input);
          },
          onProviderReceipt: input.onProviderReceipt,
        });
      } else {
        await publishLease.beforeEffect();
        await revalidatePublishSource(input);
        providerStarted = true;
        video = await uploadFacebookVideo(account.providerAccountId, accessToken, process.env.META_GRAPH_VERSION?.trim() || 'v25.0', socialInput);
      }
    }
    if (account.platform === 'instagram') {
      if (input.finalizeTracking === false && !input.onProviderReceipt) throw publishError('instagram_container_persistence_required', 503);
      if (input.finalizeTracking === false && !input.onPublishedMedia) throw publishError('instagram_media_persistence_required', 503);
      if(input.sourceClaim?.weeklyAssignment&&input.sourceClaim.sourceKind!=='social_instagram_delivery')throw Error('instagram_delivery_frozen_proof_missing');
    const compatibleFilePath = input.sourceClaim?.sourceKind==='social_instagram_delivery'?filePath:socialInput.videoUrl?undefined:await instagramCompatibleVideo(filePath);
      if (!socialInput.videoUrl) {
        await publishLease.beforeEffect();
        await revalidatePublishSource(input);
        providerStarted = true;
      }
      const publicVideoUrl = socialInput.videoUrl || await publicVideoUrlIfNeeded(compatibleFilePath);
      await publishLease.beforeEffect();
      await revalidatePublishSource(input);
      providerStarted = true;
      video = await publishInstagramReel(account.providerAccountId, accessToken, process.env.META_GRAPH_VERSION?.trim() || 'v25.0', {
        ...socialInput,
        filePath: compatibleFilePath,
        videoUrl: publicVideoUrl,
      }, { graphHost: resolveInstagramPublishingContract(account).graphHost, async onContainerCreated(creationId) {
        const receipt = `ig-container:${creationId}`;
        if (input.onProviderReceipt) await input.onProviderReceipt(receipt);
        if (input.finalizeTracking === false && !input.onProviderReceipt) throw publishError('instagram_container_persistence_required', 503);
        if (input.finalizeTracking !== false) {
          const current = await store.getById<PostRecord>('posts', tracked.id);
          if (!current) throw publishError('instagram_container_persistence_failed', 503);
          const stats = recordObject(current.stats);
          const results = recordObject(stats.publishResults);
          const existing = recordObject(results[input.accountId]);
          if (existing.attemptId !== directAttempt?.attemptId || existing.status !== 'in_flight') throw publishError('instagram_container_attempt_changed', 409);
          const saved = await store.update('posts', tracked.id, { stats: { ...stats, publishResults: { ...results, [input.accountId]: { ...existing, providerReceiptId: receipt, instagramContainerId: creationId } } } });
          if (!saved) throw publishError('instagram_container_persistence_failed', 503);
        }
      }, async onPublishedMedia(mediaId) {
        if (input.onPublishedMedia) await input.onPublishedMedia(mediaId);
        if (input.finalizeTracking !== false) {
          const current = await store.getById<PostRecord>('posts', tracked.id);
          if (!current) throw publishError('instagram_media_persistence_failed', 503);
          const stats = recordObject(current.stats), results = recordObject(stats.publishResults), existing = recordObject(results[input.accountId]);
          if (existing.attemptId !== directAttempt?.attemptId || existing.status !== 'in_flight') throw publishError('instagram_media_attempt_changed', 409);
          const saved = await store.update('posts', tracked.id, { stats: { ...stats, publishResults: { ...results, [input.accountId]: { ...existing, platformPostId: mediaId, instagramMediaId: mediaId } } } });
          if (!saved) throw publishError('instagram_media_persistence_failed', 503);
        }
      }, async beforePublish() {
        await publishLease.beforeEffect();
        await revalidatePublishSource(input);
      } });
    }
    if (account.platform === 'linkedin') {
      video = await publishLinkedInWithDurableReceipt({
        tenantId: input.tenantId, accountId: input.accountId, account, filePath,
        title: input.title, commentary: socialInput.description || '', tracked, directAttempt,
        finalizeTracking: input.finalizeTracking, onProviderReceipt: input.onProviderReceipt,
        beforeEffect: () => publishLease.beforeEffect(), revalidate: () => revalidatePublishSource(input),
        markProviderStarted: () => { providerStarted = true; },
      });
    }
    const deliveryStatus = (video as { deliveryStatus?: unknown } | undefined)?.deliveryStatus;
    const providerReceiptId = String((video as { providerReceiptId?: unknown } | undefined)?.providerReceiptId || '').trim();
    if (account.platform === 'tiktok' && deliveryStatus === 'provider_accepted') {
      if (!providerReceiptId) throw publishError('TikTok 未返回可恢复的发布回执', 502);
      await persistProviderAccepted({ request: input, tracked, providerReceiptId });
      await store.update('social_accounts', input.accountId, { lastSyncAt: new Date().toISOString(), status: 'connected' })
        .catch(error => console.error('[publishing] TikTok account sync update failed:', error));
      const persistedTracking = input.finalizeTracking === false
        ? tracked
        : await store.getById<PostRecord>('posts', tracked.id) ?? tracked;
      return {
        video,
        tracking: persistedTracking,
        publishRecord: null,
        platformPostId: '',
        deliveryStatus: 'provider_accepted',
        providerReceiptId,
      };
    }
    const id = platformContentId(video);
    if (!video || !id) throw publishError('平台没有返回最终发布内容 id', 502);
    await finalizeIfRequested(input, tracked, id);
    await store.update('social_accounts', input.accountId, { lastSyncAt: new Date().toISOString(), status: 'connected' })
      .catch(error => console.error(`[publishing] ${account.platform} account sync update failed:`, error));
    let publishRecord: ReturnType<typeof recordSuccessfulPublish> | null = null;
    try {
      publishRecord = recordSuccessfulPublish({
        tenantId: input.tenantId,
        platform: account.platform,
        accountId: input.accountId,
        platformContentId: id,
        projectId: input.projectId,
        generationVersionId: input.generationVersionId,
        title: input.title,
        description: input.description || '',
        videoPath: input.videoPath,
        ratio: input.ratio,
        language: input.language,
      });
    } catch (error) {
      console.error(`[publishing] ${account.platform} history write failed:`, error);
    }
    const platformUrl = String((video as { url?: unknown } | undefined)?.url || '').trim();
    return { video, tracking: tracked, publishRecord, platformPostId: id, deliveryStatus: 'published', ...(providerReceiptId ? { providerReceiptId } : {}), ...(platformUrl ? { platformUrl } : {}) };
  } catch (error) {
    if (providerStarted) await markDirectAttemptUnknown(input, tracked, directAttempt, error);
    else await markDirectAttemptNotSubmitted(input, tracked, directAttempt, error);
    const status = publishingAccountStatus(error);
    if (status === 401 || status === 403) await store.update('social_accounts', input.accountId, { status: 'error' });
    throw error;
  }
}

export async function publishVideoToAccount(input: PublishToAccountInput): Promise<PublishToAccountResult> {
  // Reject unsupported token/API contracts before source, lease or tracking writes.
  if(input.platform === 'instagram') {
    const account = await store.getById<SocialAccountRecord>('social_accounts',input.accountId);
    if(!account || account.tenantId !== input.tenantId || account.platform !== 'instagram') throw publishError('Social account not found',404);
    const contract = resolveInstagramPublishingContract(account);
    if (contract.oauthProvider === 'instagram_login') assertInstagramPublishingScopes(account);
    if (input.finalizeTracking === false && !input.onProviderReceipt) throw publishError('instagram_container_persistence_required', 503);
    if (input.finalizeTracking === false && !input.onPublishedMedia) throw publishError('instagram_media_persistence_required', 503);
  }
  await assertPublicationAtomicStore(store);
  assertUnifiedPublishPreflight(input);
  const copyAudit = await assertPublishingCopyFactVersion(input.tenantId, input);
  const sourceClaim = input.sourceClaim
    ? await verifyFrozenPublishSourceClaim(input.tenantId, input.sourceClaim, input.videoPath, input.imagePaths)
    : await freezePublishSourceClaim(input.tenantId, input);
  const verifiedInput = {
    ...input,
    projectId: sourceClaim.projectId || undefined,
    sourceClaim,
    ...(copyAudit ? { enterpriseFactVersion: copyAudit.enterpriseFactVersion, copyAudit } : {}),
  };
  return withDirectPublishingLease({
    tenantId: verifiedInput.tenantId,
    platform: verifiedInput.platform,
    accountId: verifiedInput.accountId,
    contentId: verifiedInput.contentId || sourceClaim.projectId,
    videoPath: verifiedInput.videoPath,
    videoUrl: verifiedInput.videoUrl,
  }, publishLease => publishVideoToAccountWithLease(verifiedInput, publishLease));
}
