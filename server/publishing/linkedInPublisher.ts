import type { SocialPlatform } from '../integrations/social.js';
import { getLinkedInPost, linkedInAuthorUrn, linkedInRequiredPublishingScope, publishLinkedInVideo } from '../integrations/linkedin.js';
import { socialAccessToken } from '../lib/accountCredentials.js';
import { store } from '../storage/index.js';
import type { PostRecord } from './waLink.js';

export interface LinkedInAccountRecord {
  id: string;
  tenantId: string;
  platform: SocialPlatform;
  providerAccountId: string;
  accessToken: string;
  scope?: string;
  parentPageId?: string;
  status: 'connected' | 'error' | 'expired';
}

export interface LinkedInPendingResolution {
  status: 'processing' | 'published' | 'failed' | 'unknown';
  providerReceiptId: string;
  platformPostId: string;
  platformUrl: string;
  providerStatus: string;
  error: string;
}

const scopesOf = (account: LinkedInAccountRecord) => new Set(String(account.scope || '').split(/[\s,]+/).filter(Boolean));
const publishingError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const recordObject = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export async function resolvePendingLinkedInPublish(input: {
  tenantId: string;
  accountId: string;
  receipt: string;
}): Promise<LinkedInPendingResolution> {
  const account = await store.getById<LinkedInAccountRecord>('social_accounts', input.accountId);
  if (!account || account.tenantId !== input.tenantId || account.platform !== 'linkedin') throw publishingError('LinkedIn account not found', 404);
  if (account.status !== 'connected') throw publishingError('LinkedIn account is not connected', 400);
  const authorUrn = linkedInAuthorUrn(account);
  const readScope = authorUrn.startsWith('urn:li:organization:') ? 'r_organization_social' : 'r_member_social';
  if (!scopesOf(account).has(readScope)) return {
    status: 'unknown', providerReceiptId: input.receipt, platformPostId: input.receipt,
    platformUrl: `https://www.linkedin.com/feed/update/${input.receipt}`,
    providerStatus: 'READ_SCOPE_MISSING',
    error: `LinkedIn 已保存发布回执，但当前应用未获授 ${readScope}，需人工核对状态；禁止自动重发`,
  };
  const result = await getLinkedInPost({
    accessToken: socialAccessToken(account as unknown as Record<string, unknown>),
    postId: input.receipt,
  });
  if (result.id !== input.receipt || result.author !== authorUrn) return {
    status: 'unknown', providerReceiptId: input.receipt, platformPostId: '', platformUrl: '',
    providerStatus: 'ACCOUNT_POST_UNVERIFIED', error: 'LinkedIn 原帖子不属于目标账号，禁止重新发布',
  };
  const state = result.lifecycleState.toUpperCase();
  if (['PUBLISHED', 'PUBLISHED_EDITED'].includes(state)) return { status: 'published', providerReceiptId: input.receipt, platformPostId: input.receipt, platformUrl: result.url, providerStatus: state, error: '' };
  if (['PROCESSING', 'DRAFT', 'PUBLISH_REQUESTED'].includes(state)) return { status: 'processing', providerReceiptId: input.receipt, platformPostId: input.receipt, platformUrl: result.url, providerStatus: state, error: '' };
  if (['DELETED', 'REJECTED', 'FAILED', 'PUBLISH_FAILED'].includes(state)) return { status: 'failed', providerReceiptId: input.receipt, platformPostId: input.receipt, platformUrl: result.url, providerStatus: state, error: 'LinkedIn 帖子未发布成功' };
  return { status: 'unknown', providerReceiptId: input.receipt, platformPostId: input.receipt, platformUrl: result.url, providerStatus: state || 'UNKNOWN', error: 'LinkedIn 未返回可确认的发布状态' };
}

export async function publishLinkedInWithDurableReceipt(input: {
  tenantId: string;
  accountId: string;
  account: LinkedInAccountRecord;
  filePath?: string;
  title: string;
  commentary: string;
  tracked: PostRecord;
  directAttempt: { attemptId: string } | null;
  finalizeTracking?: boolean;
  onProviderReceipt?: (receiptId: string) => Promise<void>;
  beforeEffect: () => Promise<void>;
  revalidate: () => Promise<void>;
  markProviderStarted: () => void;
}): Promise<unknown> {
  if (!input.filePath) throw publishingError('LinkedIn 发布需要本地 MP4 视频文件', 400);
  const requiredScope = linkedInRequiredPublishingScope(input.account);
  if (!scopesOf(input.account).has(requiredScope)) throw publishingError(`LinkedIn 账号缺少 ${requiredScope} 发布权限，请重新授权`, 403);
  const persistReceipt = async (receiptId: string) => {
    if (input.directAttempt && input.finalizeTracking !== false) {
      const current = await store.getById<PostRecord>('posts', input.tracked.id);
      if (!current || current.tenant_id !== input.tenantId) throw publishingError('linkedin_attempt_missing', 503);
      const stats = recordObject(current.stats), results = recordObject(stats.publishResults), attempt = recordObject(results[input.accountId]);
      if (attempt.attemptId !== input.directAttempt.attemptId || attempt.status !== 'in_flight') throw publishingError('linkedin_attempt_changed', 409);
      if (attempt.providerReceiptId && attempt.providerReceiptId !== receiptId) throw publishingError('linkedin_receipt_changed', 409);
      const saved = await store.update('posts', input.tracked.id, { stats: { ...stats, publishResults: { ...results, [input.accountId]: { ...attempt, providerReceiptId: receiptId } } } });
      if (!saved) throw publishingError('linkedin_receipt_persistence_failed', 503);
    }
    if (input.onProviderReceipt) await input.onProviderReceipt(receiptId);
  };
  return publishLinkedInVideo({
    accessToken: socialAccessToken(input.account as unknown as Record<string, unknown>), account: input.account,
    filePath: input.filePath, title: input.title, commentary: input.commentary,
    async beforeInitialize() { await input.beforeEffect(); await input.revalidate(); input.markProviderStarted(); },
    async beforeUpload() { await input.beforeEffect(); await input.revalidate(); },
    async beforePublish() { await input.beforeEffect(); await input.revalidate(); },
    onProviderReceipt: persistReceipt,
  });
}
