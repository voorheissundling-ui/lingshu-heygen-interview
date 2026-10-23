import fs from 'node:fs';
import axios, { type AxiosInstance } from 'axios';

const LINKEDIN_API_ROOT = 'https://api.linkedin.com';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = `${LINKEDIN_API_ROOT}/v2/userinfo`;

export type LinkedInOwnerType = 'member' | 'organization';

export interface LinkedInOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
  scope: string;
}

export interface LinkedInProfile {
  id: string;
  name: string;
  pictureUrl: string;
  email: string;
  authorUrn: string;
}

export interface LinkedInOrganization {
  id: string;
  name: string;
  vanityName: string;
  authorUrn: string;
}

export interface LinkedInAccountIdentity {
  providerAccountId: string;
  parentPageId?: string;
}

export interface LinkedInVideoPostResult {
  id: string;
  providerReceiptId: string;
  videoUrn: string;
  authorUrn: string;
  url: string;
}

export interface LinkedInImagePostResult {
  id: string;
  providerReceiptId: string;
  imageUrns: string[];
  authorUrn: string;
  url: string;
}

export interface LinkedInPostMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  clicks?: number;
  impressions?: number;
}

export interface LinkedInComment {
  id: string;
  authorName: string;
  textDisplay: string;
  likeCount: number;
  publishedAt: string;
  postId: string;
}

function text(value: unknown): string {
  return String(value ?? '').trim();
}

export function linkedInApiVersion(env: NodeJS.ProcessEnv = process.env): string {
  const configured = text(env.LINKEDIN_API_VERSION);
  if (configured && !/^20\d{4}$/.test(configured)) throw new Error('linkedin_api_version_invalid');
  // LinkedIn Marketing APIs are versioned monthly. Keep this overridable so a
  // sunset version can be advanced without changing publishing code.
  return configured || '202609';
}

export function linkedInOrganizationPublishingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(text(env.LINKEDIN_ORGANIZATION_PUBLISHING_ENABLED).toLowerCase());
}

export function linkedInMemberReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(text(env.LINKEDIN_MEMBER_READ_ENABLED).toLowerCase());
}

export function linkedInOAuthScopes(env: NodeJS.ProcessEnv = process.env): string[] {
  const scopes = ['openid', 'profile', 'email', 'w_member_social'];
  if (linkedInMemberReadEnabled(env)) scopes.push('r_member_social', 'r_member_social_feed');
  if (linkedInOrganizationPublishingEnabled(env)) {
    scopes.push('rw_organization_admin', 'w_organization_social', 'r_organization_social', 'r_organization_social_feed');
  }
  return scopes;
}

export function linkedInAuthorUrn(account: LinkedInAccountIdentity): string {
  const parent = text(account.parentPageId);
  if (/^urn:li:organization:\d+$/.test(parent)) return parent;
  const providerId = text(account.providerAccountId);
  if (!providerId || /[:\s]/.test(providerId)) throw new Error('linkedin_account_identity_invalid');
  return `urn:li:person:${providerId}`;
}

export function linkedInOwnerType(account: LinkedInAccountIdentity): LinkedInOwnerType {
  return linkedInAuthorUrn(account).startsWith('urn:li:organization:') ? 'organization' : 'member';
}

export function linkedInRequiredPublishingScope(account: LinkedInAccountIdentity): string {
  return linkedInOwnerType(account) === 'organization' ? 'w_organization_social' : 'w_member_social';
}

export function linkedInHeaders(accessToken: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = text(accessToken);
  if (!token) throw new Error('linkedin_access_token_required');
  return {
    Authorization: `Bearer ${token}`,
    'Linkedin-Version': linkedInApiVersion(env),
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
}

export async function exchangeLinkedInCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  http?: AxiosInstance;
}): Promise<LinkedInOAuthTokens> {
  const http = input.http ?? axios;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: text(input.code),
    client_id: text(input.clientId),
    client_secret: text(input.clientSecret),
    redirect_uri: text(input.redirectUri),
  });
  if (![input.clientId, input.clientSecret, input.code, input.redirectUri].every(value => text(value))) {
    throw new Error('linkedin_oauth_exchange_input_invalid');
  }
  const response = await http.post(LINKEDIN_TOKEN_URL, body.toString(), {
    maxRedirects: 0,
    timeout: 30_000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const accessToken = text(response.data?.access_token);
  if (!accessToken) throw new Error('linkedin_access_token_missing');
  return {
    accessToken,
    refreshToken: text(response.data?.refresh_token),
    expiresIn: Math.max(0, Number(response.data?.expires_in) || 0),
    refreshTokenExpiresIn: Math.max(0, Number(response.data?.refresh_token_expires_in) || 0),
    scope: text(response.data?.scope),
  };
}

export async function getLinkedInProfile(accessToken: string, http: AxiosInstance = axios): Promise<LinkedInProfile> {
  const response = await http.get(LINKEDIN_USERINFO_URL, {
    maxRedirects: 0,
    timeout: 30_000,
    headers: { Authorization: `Bearer ${text(accessToken)}` },
  });
  const id = text(response.data?.sub);
  if (!id || /[:\s]/.test(id)) throw new Error('linkedin_profile_identity_missing');
  return {
    id,
    name: text(response.data?.name) || [text(response.data?.given_name), text(response.data?.family_name)].filter(Boolean).join(' ') || 'LinkedIn 账号',
    pictureUrl: text(response.data?.picture),
    email: text(response.data?.email),
    authorUrn: `urn:li:person:${id}`,
  };
}

export async function getLinkedInAdminOrganizations(
  accessToken: string,
  http: AxiosInstance = axios,
): Promise<LinkedInOrganization[]> {
  const headers = linkedInHeaders(accessToken);
  const acls = await http.get(`${LINKEDIN_API_ROOT}/rest/organizationAcls`, {
    maxRedirects: 0,
    timeout: 30_000,
    headers,
    params: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED', count: 100, start: 0 },
  });
  const ids = [...new Set<string>((Array.isArray(acls.data?.elements) ? acls.data.elements : [])
    .map((item: Record<string, unknown>) => text(item.organization || item.organizationTarget).match(/^urn:li:organization:(\d+)$/)?.[1] || '')
    .filter((id: string): id is string => Boolean(id)))];
  if (!ids.length) return [];
  const organizations = await Promise.all(ids.map(async id => {
    const response = await http.get(`${LINKEDIN_API_ROOT}/rest/organizations/${encodeURIComponent(id)}`, {
      maxRedirects: 0,
      timeout: 30_000,
      headers,
    });
    const returnedId = text(response.data?.id);
    if (returnedId !== id) throw new Error('linkedin_organization_identity_mismatch');
    return {
      id,
      name: text(response.data?.localizedName) || `LinkedIn Page ${id}`,
      vanityName: text(response.data?.vanityName),
      authorUrn: `urn:li:organization:${id}`,
    };
  }));
  return organizations;
}

export async function getLinkedInOrganization(
  accessToken: string,
  organizationId: string,
  http: AxiosInstance = axios,
): Promise<LinkedInOrganization> {
  const id = text(organizationId);
  if (!/^\d+$/.test(id)) throw new Error('linkedin_organization_identity_invalid');
  const response = await http.get(`${LINKEDIN_API_ROOT}/rest/organizations/${encodeURIComponent(id)}`, {
    maxRedirects: 0,
    timeout: 30_000,
    headers: linkedInHeaders(accessToken),
  });
  if (text(response.data?.id) !== id) throw new Error('linkedin_organization_identity_mismatch');
  return {
    id,
    name: text(response.data?.localizedName) || `LinkedIn Page ${id}`,
    vanityName: text(response.data?.vanityName),
    authorUrn: `urn:li:organization:${id}`,
  };
}

async function initializeVideoUpload(input: {
  accessToken: string;
  authorUrn: string;
  fileSizeBytes: number;
  http: AxiosInstance;
}) {
  const response = await input.http.post(`${LINKEDIN_API_ROOT}/rest/videos?action=initializeUpload`, {
    initializeUploadRequest: {
      owner: input.authorUrn,
      fileSizeBytes: input.fileSizeBytes,
      uploadCaptions: false,
      uploadThumbnail: false,
    },
  }, { maxRedirects: 0, timeout: 30_000, headers: linkedInHeaders(input.accessToken) });
  const value = response.data?.value;
  const video = text(value?.video);
  const uploadToken = text(value?.uploadToken);
  const instructions = Array.isArray(value?.uploadInstructions) ? value.uploadInstructions : [];
  if (!/^urn:li:video:/.test(video) || !instructions.length) throw new Error('linkedin_video_upload_initialization_invalid');
  return { video, uploadToken, instructions };
}

async function uploadVideoParts(input: {
  filePath: string;
  instructions: Array<{ firstByte?: unknown; lastByte?: unknown; uploadUrl?: unknown }>;
  http: AxiosInstance;
}): Promise<string[]> {
  const file = fs.openSync(input.filePath, 'r');
  try {
    const partIds: string[] = [];
    for (const instruction of input.instructions) {
      const firstByte = Number(instruction.firstByte);
      const lastByte = Number(instruction.lastByte);
      const uploadUrl = text(instruction.uploadUrl);
      if (!Number.isSafeInteger(firstByte) || !Number.isSafeInteger(lastByte) || firstByte < 0 || lastByte < firstByte || !uploadUrl.startsWith('https://')) {
        throw new Error('linkedin_video_upload_instruction_invalid');
      }
      const length = lastByte - firstByte + 1;
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(file, buffer, 0, length, firstByte);
      if (bytesRead !== length) throw new Error('linkedin_video_upload_source_changed');
      const response = await input.http.put(uploadUrl, buffer, {
        maxRedirects: 0,
        timeout: 120_000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(length) },
      });
      const partId = text(response.headers?.etag).replace(/^"|"$/g, '');
      if (!partId) throw new Error('linkedin_video_upload_etag_missing');
      partIds.push(partId);
    }
    return partIds;
  } finally {
    fs.closeSync(file);
  }
}

export async function publishLinkedInVideo(input: {
  accessToken: string;
  account: LinkedInAccountIdentity;
  filePath: string;
  title: string;
  commentary: string;
  beforeInitialize?: () => Promise<void>;
  beforeUpload?: () => Promise<void>;
  beforePublish?: () => Promise<void>;
  onProviderReceipt?: (postId: string) => Promise<void>;
  http?: AxiosInstance;
}): Promise<LinkedInVideoPostResult> {
  const http = input.http ?? axios;
  const authorUrn = linkedInAuthorUrn(input.account);
  const stat = fs.statSync(input.filePath);
  if (!stat.isFile() || stat.size < 75 * 1024 || stat.size > 500 * 1024 * 1024 || !/\.mp4$/i.test(input.filePath)) {
    throw new Error('linkedin_video_file_invalid');
  }
  if (input.beforeInitialize) await input.beforeInitialize();
  const initialized = await initializeVideoUpload({ accessToken: input.accessToken, authorUrn, fileSizeBytes: stat.size, http });
  if (input.beforeUpload) await input.beforeUpload();
  const uploadedPartIds = await uploadVideoParts({ filePath: input.filePath, instructions: initialized.instructions, http });
  await http.post(`${LINKEDIN_API_ROOT}/rest/videos?action=finalizeUpload`, {
    finalizeUploadRequest: {
      video: initialized.video,
      uploadToken: initialized.uploadToken,
      uploadedPartIds,
    },
  }, { maxRedirects: 0, timeout: 30_000, headers: linkedInHeaders(input.accessToken) });
  if (input.beforePublish) await input.beforePublish();
  const response = await http.post(`${LINKEDIN_API_ROOT}/rest/posts`, {
    author: authorUrn,
    commentary: text(input.commentary),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media: { title: text(input.title).slice(0, 200), id: initialized.video } },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  }, { maxRedirects: 0, timeout: 30_000, headers: linkedInHeaders(input.accessToken) });
  const postId = text(response.headers?.['x-restli-id']);
  if (!/^urn:li:(?:share|ugcPost):/.test(postId)) throw new Error('linkedin_post_receipt_missing');
  if (input.onProviderReceipt) await input.onProviderReceipt(postId);
  return {
    id: postId,
    providerReceiptId: postId,
    videoUrn: initialized.video,
    authorUrn,
    url: `https://www.linkedin.com/feed/update/${postId}`,
  };
}

async function initializeImageUpload(input: {
  accessToken: string;
  authorUrn: string;
  http: AxiosInstance;
}): Promise<{ imageUrn: string; uploadUrl: string }> {
  const response = await input.http.post(`${LINKEDIN_API_ROOT}/rest/images?action=initializeUpload`, {
    initializeUploadRequest: { owner: input.authorUrn },
  }, { maxRedirects: 0, timeout: 30_000, headers: linkedInHeaders(input.accessToken) });
  const value = response.data?.value;
  const imageUrn = text(value?.image);
  const uploadUrl = text(value?.uploadUrl);
  if (!/^urn:li:image:/.test(imageUrn) || !uploadUrl.startsWith('https://')) throw new Error('linkedin_image_upload_initialization_invalid');
  return { imageUrn, uploadUrl };
}

export async function publishLinkedInImages(input: {
  accessToken: string;
  account: LinkedInAccountIdentity;
  imagePaths: string[];
  title: string;
  commentary: string;
  beforeInitialize?: (imagePath: string, index: number) => Promise<void>;
  beforeUpload?: (imagePath: string, index: number) => Promise<void>;
  beforePublish?: () => Promise<void>;
  onProviderReceipt?: (postId: string) => Promise<void>;
  http?: AxiosInstance;
}): Promise<LinkedInImagePostResult> {
  const http = input.http ?? axios;
  const authorUrn = linkedInAuthorUrn(input.account);
  if (!input.imagePaths.length || input.imagePaths.length > 9) throw new Error('linkedin_image_count_invalid');
  const imageUrns: string[] = [];
  for (const [index, imagePath] of input.imagePaths.entries()) {
    const stat = fs.statSync(imagePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024 * 1024 || !/\.(?:jpe?g|png)$/i.test(imagePath)) {
      throw new Error('linkedin_image_file_invalid');
    }
    if (input.beforeInitialize) await input.beforeInitialize(imagePath, index);
    const initialized = await initializeImageUpload({ accessToken: input.accessToken, authorUrn, http });
    if (input.beforeUpload) await input.beforeUpload(imagePath, index);
    await http.put(initialized.uploadUrl, fs.readFileSync(imagePath), {
      maxRedirects: 0,
      timeout: 120_000,
      maxBodyLength: stat.size,
      maxContentLength: stat.size,
      headers: {
        'Content-Type': /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg',
        'Content-Length': String(stat.size),
      },
    });
    imageUrns.push(initialized.imageUrn);
  }
  if (input.beforePublish) await input.beforePublish();
  const content = imageUrns.length === 1
    ? { media: { title: text(input.title).slice(0, 200), id: imageUrns[0] } }
    : { multiImage: { images: imageUrns.map(id => ({ id, altText: text(input.title).slice(0, 120) })) } };
  const response = await http.post(`${LINKEDIN_API_ROOT}/rest/posts`, {
    author: authorUrn,
    commentary: text(input.commentary),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    content,
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  }, { maxRedirects: 0, timeout: 30_000, headers: linkedInHeaders(input.accessToken) });
  const postId = text(response.headers?.['x-restli-id']);
  if (!/^urn:li:(?:share|ugcPost):/.test(postId)) throw new Error('linkedin_post_receipt_missing');
  if (input.onProviderReceipt) await input.onProviderReceipt(postId);
  return {
    id: postId,
    providerReceiptId: postId,
    imageUrns,
    authorUrn,
    url: `https://www.linkedin.com/feed/update/${postId}`,
  };
}

export async function getLinkedInPost(input: {
  accessToken: string;
  postId: string;
  http?: AxiosInstance;
}): Promise<{ id: string; author: string; lifecycleState: string; url: string }> {
  const postId = text(input.postId);
  if (!/^urn:li:(?:share|ugcPost):/.test(postId)) throw new Error('linkedin_post_receipt_invalid');
  const http = input.http ?? axios;
  const response = await http.get(`${LINKEDIN_API_ROOT}/rest/posts/${encodeURIComponent(postId)}`, {
    maxRedirects: 0,
    timeout: 30_000,
    headers: linkedInHeaders(input.accessToken),
    params: { viewContext: 'AUTHOR' },
  });
  return {
    id: text(response.data?.id) || postId,
    author: text(response.data?.author),
    lifecycleState: text(response.data?.lifecycleState),
    url: `https://www.linkedin.com/feed/update/${postId}`,
  };
}

/** Reads the engagement counters LinkedIn exposes for one registered post. */
export async function getLinkedInPostMetrics(input: {
  accessToken: string;
  postId: string;
  authorUrn?: string;
  http?: AxiosInstance;
}): Promise<LinkedInPostMetrics> {
  const postId = text(input.postId);
  if (!/^urn:li:(?:share|ugcPost):/.test(postId)) throw new Error('linkedin_post_receipt_invalid');
  const http = input.http ?? axios;
  const social = await http.get(`${LINKEDIN_API_ROOT}/rest/socialMetadata/${encodeURIComponent(postId)}`, {
    maxRedirects: 0,
    timeout: 30_000,
    headers: linkedInHeaders(input.accessToken),
  });
  const data = social.data || {};
  const finite = (value: unknown): number | undefined => Number.isFinite(Number(value)) ? Number(value) : undefined;
  const reactionSummaries = data.reactionSummaries && typeof data.reactionSummaries === 'object'
    ? Object.values(data.reactionSummaries as Record<string, { count?: unknown }>) : [];
  const reactions = reactionSummaries.reduce((sum, item) => sum + (finite(item?.count) ?? 0), 0);
  const base: LinkedInPostMetrics = {
    likes: reactions,
    comments: finite(data.commentSummary?.count),
  };
  const authorUrn = text(input.authorUrn);
  if (!/^urn:li:organization:\d+$/.test(authorUrn)) return base;
  const statsParams: Record<string, string> = { q: 'organizationalEntity', organizationalEntity: authorUrn };
  if (postId.startsWith('urn:li:share:')) statsParams.shares = `List(${postId})`;
  else statsParams['ugcPosts[0]'] = postId;
  const statistics = await http.get(`${LINKEDIN_API_ROOT}/rest/organizationalEntityShareStatistics`, {
    maxRedirects: 0,
    timeout: 30_000,
    headers: linkedInHeaders(input.accessToken),
    params: statsParams,
  });
  if (!Array.isArray(statistics.data?.elements)) throw new Error('linkedin_share_statistics_invalid');
  const row = statistics.data.elements.find((item: Record<string, unknown>) => text(item.share || item.ugcPost) === postId);
  const totals = row?.totalShareStatistics || {};
  return {
    ...base,
    likes: finite(totals.likeCount) ?? base.likes,
    comments: finite(totals.commentCount) ?? base.comments,
    shares: finite(totals.shareCount),
    views: finite(totals.impressionCount),
    clicks: finite(totals.clickCount),
    impressions: finite(totals.uniqueImpressionsCount ?? totals.uniqueImpressionsCounts),
  };
}

/** Reads comments for a post already registered by a successful local publish receipt. */
export async function getLinkedInComments(input: {
  accessToken: string;
  postId: string;
  count?: number;
  http?: AxiosInstance;
}): Promise<LinkedInComment[]> {
  const postId = text(input.postId);
  if (!/^urn:li:(?:share|ugcPost):/.test(postId)) throw new Error('linkedin_post_receipt_invalid');
  const response = await (input.http ?? axios).get(`${LINKEDIN_API_ROOT}/rest/socialActions/${encodeURIComponent(postId)}/comments`, {
    maxRedirects: 0,
    timeout: 30_000,
    headers: linkedInHeaders(input.accessToken),
    params: { start: 0, count: Math.min(100, Math.max(1, input.count ?? 100)) },
  });
  return (Array.isArray(response.data?.elements) ? response.data.elements : []).map((item: Record<string, any>): LinkedInComment => ({
    id: text(item.id || item.commentUrn),
    authorName: text(item.actor || item.commenter?.name || 'LinkedIn member'),
    textDisplay: text(item.message?.text || item.commentary || item.text),
    likeCount: Number(item.likesSummary?.totalLikes || 0),
    publishedAt: new Date(Number(item.created?.time || item.createdAt || Date.now())).toISOString(),
    postId,
  })).filter((item: LinkedInComment) => item.id && item.textDisplay);
}
