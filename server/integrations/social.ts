import { normalizeMetricValues } from '../socialMetrics/aggregation.js';
import { createHash } from 'node:crypto';
import { prepareTikTokAttemptReceipt, probeTikTokVideoDuration, validateTikTokCreatorInfo, tikTokContractHash, type TikTokAttemptPreparedReceipt, type TikTokDirectPostOptions } from '../lib/tikTokDirectPostContract.js';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs';
import path from 'node:path';
import type { MetaInstagramAccount } from './instagramLogin.js';
export { exchangeInstagramLoginCode, getInstagramLoginAccount, refreshInstagramLoginToken } from './instagramLogin.js';
export type { MetaInstagramAccount, InstagramLoginTokens } from './instagramLogin.js';

const TIKTOK_API = 'https://open.tiktokapis.com';
const META_GRAPH = 'https://graph.facebook.com';
const META_GRAPH_VIDEO = 'https://graph-video.facebook.com';

export type SocialPlatform = 'tiktok' | 'instagram' | 'facebook' | 'linkedin';

export interface SocialUploadInput {
  filePath?: string;
  videoUrl?: string;
  title: string;
  description?: string;
  privacyStatus?: 'private' | 'unlisted' | 'public';
}

export interface SocialUploadResult {
  id: string;
  title: string;
  privacyStatus: string;
  url: string;
  /** TikTok FILE_UPLOAD is asynchronous; init/upload acceptance is not publication. */
  deliveryStatus?: 'published' | 'provider_accepted';
  providerReceiptId?: string;
}

export interface FacebookImagePostResult extends SocialUploadResult {
  photoIds: string[];
}

export interface TikTokPublishStatusResult {
  state: 'processing' | 'published' | 'failed' | 'unknown';
  publishId: string;
  platformPostId: string;
  url: string;
  providerStatus: string;
  failureReason: string;
}

export interface TikTokTokens {
  accessToken: string;
  refreshToken: string;
  openId: string;
  scope?: string;
  expiresIn?: number;
  refreshExpiresIn?: number;
}

export interface TikTokUser {
  openId: string;
  displayName: string;
  avatarUrl?: string;
  profileUrl?: string;
  followerCount?: number;
  videoCount?: number;
  likeCount?: number;
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  pictureUrl?: string;
  fanCount?: number;
  instagram?: {
    id: string;
    username: string;
    profilePictureUrl?: string;
    followersCount?: number;
    mediaCount?: number;
  };
}

function mimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'video/mp4';
}

function requireFile(filePath?: string) {
  if (!filePath) throw new Error('缺少视频文件路径');
  if (!fs.existsSync(filePath)) throw new Error('成片文件不存在，请先重新合成');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('成片路径不是文件');
  return stat;
}

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function exchangeTikTokCode(input: {
  clientKey: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<TikTokTokens> {
  const params = new URLSearchParams({
    client_key: input.clientKey,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  });

  const res = await axios.post(`${TIKTOK_API}/v2/oauth/token/`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    openId: res.data.open_id,
    scope: res.data.scope,
    expiresIn: res.data.expires_in,
    refreshExpiresIn: res.data.refresh_expires_in,
  };
}

export async function getTikTokUser(accessToken: string): Promise<TikTokUser> {
  const fields = [
    'open_id',
    'display_name',
    'avatar_url',
    'profile_deep_link',
    'follower_count',
    'video_count',
    'likes_count',
  ].join(',');
  const res = await axios.get(`${TIKTOK_API}/v2/user/info/`, {
    params: { fields },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = res.data?.data?.user;
  if (!user?.open_id) throw new Error('TikTok 未返回账号信息');
  return {
    openId: user.open_id,
    displayName: user.display_name || 'TikTok',
    avatarUrl: user.avatar_url,
    profileUrl: user.profile_deep_link,
    followerCount: Number(user.follower_count || 0),
    videoCount: Number(user.video_count || 0),
    likeCount: Number(user.likes_count || 0),
  };
}

/** TikTok's side-effect-free Content Posting capability endpoint. */
export async function probeTikTokPublishingPermission(accessToken: string): Promise<{ granted: boolean }> {
  const response = await axios.post(`${TIKTOK_API}/v2/post/publish/creator_info/query/`, {}, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
  });
  return { granted: response.data?.error?.code === 'ok' && Boolean(response.data?.data?.creator_username) };
}

/** Provider-granted permissions, queried from Meta rather than trusted from our account row. */
export async function getMetaGrantedPermissions(accessToken: string, graphVersion: string): Promise<string[]> {
  const response = await axios.get(`${META_GRAPH}/${graphVersion}/me/permissions`, { params: { access_token: accessToken } });
  return (response.data?.data || [])
    .filter((item: any) => item?.status === 'granted')
    .map((item: any) => String(item.permission || ''))
    .filter(Boolean);
}

export async function getTikTokVideos(accessToken: string, maxResults = 20) {
  const fields = [
    'id',
    'title',
    'cover_image_url',
    'share_url',
    'video_description',
    'duration',
    'create_time',
    'view_count',
    'like_count',
    'comment_count',
    'share_count',
  ].join(',');
  const res = await axios.post(
    `${TIKTOK_API}/v2/video/list/`,
    { max_count: Math.min(20, maxResults) },
    {
      params: { fields },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
    },
  );
  return (res.data?.data?.videos ?? []).map((v: any) => ({
    id: String(v.id),
    title: String(v.title || v.video_description || 'TikTok video'),
    description: String(v.video_description || ''),
    publishedAt: v.create_time ? new Date(Number(v.create_time) * 1000).toISOString() : '',
    thumbnailUrl: String(v.cover_image_url || ''),
    viewCount: normalizeMetricValues({ views: v.view_count }).views,
    likeCount: normalizeMetricValues({ likes: v.like_count }).likes,
    commentCount: normalizeMetricValues({ comments: v.comment_count }).comments,
    shareCount: normalizeMetricValues({ shares: v.share_count }).shares,
    duration: String(v.duration || ''),
    permalinkUrl: String(v.share_url || ''),
  }));
}

export interface PlatformInsightPoint {
  metric: string;
  period: string;
  value: number | Record<string, unknown>;
  endTime?: string;
}

function normalizeMetaInsights(data: any): PlatformInsightPoint[] {
  return (data?.data ?? []).flatMap((metric: any) =>
    (metric.values ?? [{ value: metric.total_value?.value ?? metric.value }]).map((point: any) => ({
      metric: String(metric.name || metric.id || ''),
      period: String(metric.period || 'lifetime'),
      value: typeof point?.value === 'number' ? point.value : (point?.value ?? {}),
      ...(point?.end_time ? { endTime: String(point.end_time) } : {}),
    })),
  ).filter((point: PlatformInsightPoint) => point.metric);
}

/** Page-level metrics for a Facebook Page owned by the authorized user. */
export async function getFacebookPageInsights(
  pageId: string,
  pageAccessToken: string,
  graphVersion: string,
  input: { since: string; until: string },
) {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${pageId}/insights`, {
    params: {
      access_token: pageAccessToken,
      metric: [
        'page_impressions_unique',
        'page_post_engagements',
        'page_video_views',
        'page_video_view_time',
      ].join(','),
      period: 'day',
      since: input.since,
      until: input.until,
    },
  });
  return normalizeMetaInsights(res.data);
}

/** Account-level metrics for an Instagram professional account. */
export async function getInstagramAccountInsights(
  igUserId: string,
  pageAccessToken: string,
  graphVersion: string,
  input: { since: string; until: string },
) {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${igUserId}/insights`, {
    params: {
      access_token: pageAccessToken,
      metric: 'reach,follower_count,profile_views,accounts_engaged,total_interactions,likes,comments,shares,saves',
      period: 'day',
      metric_type: 'total_value',
      since: input.since,
      until: input.until,
    },
  });
  return normalizeMetaInsights(res.data);
}

export interface TikTokUploadLifecycle {
  tenantId: string; accountId: string; attemptId: string; accountIdentityHash: string;
  options: TikTokDirectPostOptions;
  onTikTokAttemptPrepared(receipt: TikTokAttemptPreparedReceipt): Promise<void>;
  onProviderReceipt(publishId: string, initialized: { uploadUrlHash: string }): Promise<void>;
  beforeInit(): Promise<void>; beforeUpload(): Promise<void>;
  probeDuration?: (filePath: string) => Promise<number>;
}
export async function uploadTikTokVideo(accessToken: string, input: SocialUploadInput, lifecycle?: TikTokUploadLifecycle): Promise<SocialUploadResult> {
  if (String(process.env.TIKTOK_DIRECT_POST_RELEASE_MODE || '').trim().toLowerCase() !== 'approved') throw Error('tiktok_direct_post_not_approved');
  if (!lifecycle) throw Error('tiktok_attempt_persistence_required');
  const stat = requireFile(input.filePath);
  const fileHash = () => createHash('sha256').update(fs.readFileSync(input.filePath!)).digest('hex');
  const creator = await axios.post(`${TIKTOK_API}/v2/post/publish/creator_info/query/`, {}, { maxRedirects: 0, timeout: 30_000, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } });
  if (creator.data?.error?.code !== 'ok') throw Error(`tiktok_creator_info_rejected:${String(creator.data?.error?.code || 'missing_error_code')}`);
  const receipt = prepareTikTokAttemptReceipt({ tenantId: lifecycle.tenantId, accountId: lifecycle.accountId, attemptId: lifecycle.attemptId, accountIdentityHash: lifecycle.accountIdentityHash,
    creator: validateTikTokCreatorInfo(creator.data?.data), options: lifecycle.options, videoSha256: fileHash(), videoSize: stat.size,
    durationSeconds: await (lifecycle.probeDuration || probeTikTokVideoDuration)(input.filePath!), validatedAt: new Date().toISOString() });
  await lifecycle.onTikTokAttemptPrepared(structuredClone(receipt));
  const freshCreator = await axios.post(`${TIKTOK_API}/v2/post/publish/creator_info/query/`, {}, { maxRedirects: 0, timeout: 30_000, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } });
  if (freshCreator.data?.error?.code !== 'ok' || tikTokContractHash(validateTikTokCreatorInfo(freshCreator.data?.data)) !== tikTokContractHash(receipt.creator)) throw Error('tiktok_creator_changed_before_init');
  await lifecycle.beforeInit();
  if (fileHash() !== receipt.videoSha256 || fs.statSync(input.filePath!).size !== receipt.videoSize) throw Error('tiktok_video_changed_before_init');
  const options = receipt.options;
  const title = (input.title || input.description || 'Untitled video').slice(0, 2200);
  const init = await axios.post(`${TIKTOK_API}/v2/post/publish/video/init/`, {
    post_info: { title, privacy_level: options.privacyLevel, disable_duet: !options.allowDuet, disable_comment: !options.allowComment, disable_stitch: !options.allowStitch,
      brand_organic_toggle: options.commercial.ownBrand, brand_content_toggle: options.commercial.brandedContent, is_aigc: options.isAigc },
    source_info: { source: 'FILE_UPLOAD', video_size: stat.size, chunk_size: stat.size, total_chunk_count: 1 },
  }, { maxRedirects: 0, timeout: 30_000, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } });
  if (init.data?.error?.code !== 'ok') throw Error(`tiktok_init_rejected:${String(init.data?.error?.code || 'missing_error_code')}`);
  const publishId = String(init.data?.data?.publish_id || '').trim();
  if (!publishId || publishId.length > 64) throw Error('tiktok_publish_id_missing');
  const uploadUrl = String(init.data?.data?.upload_url || '');
  await lifecycle.onProviderReceipt(publishId, { uploadUrlHash: tikTokContractHash(uploadUrl) });
  if (!uploadUrl || uploadUrl.length > 256) throw Error('tiktok_upload_url_invalid');
  const parsed = new URL(uploadUrl);
  if (parsed.protocol !== 'https:' || !/^([a-z0-9-]+\.)*tiktokapis\.com$/i.test(parsed.hostname) || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw Error('tiktok_upload_url_untrusted');
  await lifecycle.beforeUpload();
  if (fileHash() !== receipt.videoSha256 || fs.statSync(input.filePath!).size !== receipt.videoSize) throw Error('tiktok_video_changed_before_upload');
  await axios.put(uploadUrl, fs.createReadStream(input.filePath!), { maxRedirects: 0, headers: {
    'Content-Type': mimeType(input.filePath!), 'Content-Length': String(stat.size), 'Content-Range': `bytes 0-${stat.size - 1}/${stat.size}` }, maxBodyLength: stat.size, maxContentLength: stat.size, timeout: 120_000 });
  return { id: '', title, privacyStatus: options.privacyLevel === 'PUBLIC_TO_EVERYONE' ? 'public' : 'private', url: '', deliveryStatus: 'provider_accepted', providerReceiptId: publishId };
}

/** Read-only recovery for a TikTok Content Posting API init receipt. */
export async function getTikTokPublishStatus(
  accessToken: string,
  publishId: string,
): Promise<TikTokPublishStatusResult> {
  const normalizedPublishId = publishId.trim();
  if (!normalizedPublishId || normalizedPublishId.length > 240 || /[\u0000-\u001f\u007f]/.test(normalizedPublishId)) {
    throw new Error('TikTok 发布回执无效');
  }
  const response = await axios.post(
    `${TIKTOK_API}/v2/post/publish/status/fetch/`,
    { publish_id: normalizedPublishId },
    {
      maxRedirects: 0, timeout: 30_000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
    },
  );
  if (response.data?.error?.code !== 'ok') throw Error(`tiktok_status_rejected:${String(response.data?.error?.code || 'missing_error_code')}`);
  const data = response.data?.data;
  const providerStatus = String(data?.status || '').trim().toUpperCase();
  const rawIds = data?.publicaly_available_post_id ?? data?.publicly_available_post_id;
  const ids = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [])
    .map(String).map(value => value.trim()).filter(Boolean);
  const platformPostId = ids[0] || '';
  const url = String(data?.share_url || data?.public_url || '').trim();
  const failureReason = String(data?.fail_reason || data?.failure_reason || '').trim();
  const processing = new Set([
    'PROCESSING_UPLOAD',
    'PROCESSING_DOWNLOAD',
    'SEND_TO_USER_INBOX',
    'PENDING',
    'PROCESSING',
  ]);
  return {
    state: providerStatus === 'PUBLISH_COMPLETE'
      ? platformPostId ? 'published' : 'unknown'
      : providerStatus === 'FAILED'
        ? 'failed'
        : processing.has(providerStatus)
          ? 'processing'
          : 'unknown',
    publishId: normalizedPublishId,
    platformPostId,
    url,
    providerStatus,
    failureReason,
  };
}

export async function exchangeMetaCode(input: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
  graphVersion: string;
}) {
  const res = await axios.get(`${META_GRAPH}/${input.graphVersion}/oauth/access_token`, {
    params: {
      client_id: input.appId,
      client_secret: input.appSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    },
  });
  return String(res.data.access_token || '');
}

export async function getMetaPages(accessToken: string, graphVersion: string): Promise<MetaPage[]> {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/me/accounts`, {
    params: {
      access_token: accessToken,
      fields: 'id,name,access_token,fan_count,picture{url},instagram_business_account{id,username,profile_picture_url,followers_count,media_count}',
      limit: 100,
    },
  });
  return (res.data?.data ?? []).map((page: any) => ({
    id: String(page.id),
    name: String(page.name || 'Facebook Page'),
    accessToken: String(page.access_token || ''),
    pictureUrl: page.picture?.data?.url,
    fanCount: Number(page.fan_count || 0),
    instagram: page.instagram_business_account ? {
      id: String(page.instagram_business_account.id),
      username: String(page.instagram_business_account.username || 'Instagram'),
      profilePictureUrl: page.instagram_business_account.profile_picture_url,
      followersCount: Number(page.instagram_business_account.followers_count || 0),
      mediaCount: Number(page.instagram_business_account.media_count || 0),
    } : undefined,
  }));
}

function normalizeMetaPage(page: any, accessTokenFallback = ''): MetaPage {
  return {
    id: String(page.id),
    name: String(page.name || 'Facebook Page'),
    accessToken: String(page.access_token || accessTokenFallback || ''),
    pictureUrl: page.picture?.data?.url,
    fanCount: Number(page.fan_count || 0),
    instagram: page.instagram_business_account ? {
      id: String(page.instagram_business_account.id),
      username: String(page.instagram_business_account.username || 'Instagram'),
      profilePictureUrl: page.instagram_business_account.profile_picture_url,
      followersCount: Number(page.instagram_business_account.followers_count || 0),
      mediaCount: Number(page.instagram_business_account.media_count || 0),
    } : undefined,
  };
}

export async function getMetaBusinessPages(accessToken: string, graphVersion: string): Promise<MetaPage[]> {
  const fields = [
    'id',
    'name',
    'owned_pages.limit(100){id,name,access_token,fan_count,picture{url},instagram_business_account{id,username,profile_picture_url,followers_count,media_count}}',
    'client_pages.limit(100){id,name,access_token,fan_count,picture{url},instagram_business_account{id,username,profile_picture_url,followers_count,media_count}}',
  ].join(',');
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/me/businesses`, {
    params: {
      access_token: accessToken,
      fields,
      limit: 100,
    },
  });
  const pages: MetaPage[] = [];
  for (const business of res.data?.data ?? []) {
    for (const page of business.owned_pages?.data ?? []) pages.push(normalizeMetaPage(page));
    for (const page of business.client_pages?.data ?? []) pages.push(normalizeMetaPage(page));
  }
  const seen = new Set<string>();
  return pages.filter(page => {
    if (!page.id || seen.has(page.id)) return false;
    seen.add(page.id);
    return true;
  });
}

export async function getFacebookPage(pageAccessToken: string, graphVersion: string, pageId?: string): Promise<MetaPage> {
  const node = pageId?.trim() || 'me';
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${node}`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,name,fan_count,picture{url}',
    },
  });
  const page = res.data;
  if (!page?.id) throw new Error('Facebook Page token 无法读取主页信息');
  return {
    id: String(page.id),
    name: String(page.name || 'Facebook Page'),
    accessToken: pageAccessToken,
    pictureUrl: page.picture?.data?.url,
    fanCount: Number(page.fan_count || 0),
  };
}

export async function getInstagramAccount(igUserId: string, pageAccessToken: string, graphVersion: string): Promise<MetaInstagramAccount> {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${igUserId}`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,username,profile_picture_url,followers_count,media_count',
    },
  });
  const account = res.data;
  if (!account?.id) throw new Error('Instagram token 无法读取专业账号信息');
  return {
    id: String(account.id),
    username: String(account.username || 'Instagram'),
    profilePictureUrl: account.profile_picture_url,
    followersCount: Number(account.followers_count || 0),
    mediaCount: Number(account.media_count || 0),
  };
}

export async function getInstagramAccountFromPage(pageId: string, pageAccessToken: string, graphVersion: string) {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${pageId}`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,name,instagram_business_account{id,username,profile_picture_url,followers_count,media_count}',
    },
  });
  const page = res.data;
  const account = page?.instagram_business_account;
  if (!account?.id) throw new Error('该 Facebook Page 没有关联 Instagram 专业账号');
  return {
    page: {
      id: String(page.id || pageId),
      name: String(page.name || 'Facebook Page'),
    },
    instagram: {
      id: String(account.id),
      username: String(account.username || 'Instagram'),
      profilePictureUrl: account.profile_picture_url,
      followersCount: Number(account.followers_count || 0),
      mediaCount: Number(account.media_count || 0),
    } satisfies MetaInstagramAccount,
  };
}

export async function getFacebookVideos(pageId: string, pageAccessToken: string, graphVersion: string, maxResults = 25) {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${pageId}/videos`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,title,description,created_time,permalink_url,thumbnails,views,likes.summary(true),comments.summary(true)',
      limit: Math.min(50, maxResults),
    },
  });
  return (res.data?.data ?? []).map((v: any) => ({
    id: String(v.id),
    title: String(v.title || v.description || 'Facebook video'),
    description: String(v.description || ''),
    publishedAt: String(v.created_time || ''),
    thumbnailUrl: String(v.thumbnails?.data?.[0]?.uri || ''),
    viewCount: normalizeMetricValues({ views: v.views }).views,
    likeCount: normalizeMetricValues({ likes: v.likes?.summary?.total_count }).likes,
    commentCount: normalizeMetricValues({ comments: v.comments?.summary?.total_count }).comments,
    duration: '',
    permalinkUrl: String(v.permalink_url || ''),
  }));
}

export async function getFacebookComments(videoId: string, pageAccessToken: string, graphVersion: string, maxResults = 50) {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${videoId}/comments`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,from,message,like_count,created_time',
      limit: Math.min(100, maxResults),
    },
  });
  return (res.data?.data ?? []).map((c: any) => ({
    id: String(c.id),
    authorName: String(c.from?.name || 'Facebook user'),
    authorProfileImageUrl: '',
    textDisplay: String(c.message || ''),
    likeCount: Number(c.like_count || 0),
    publishedAt: String(c.created_time || ''),
    videoId,
  }));
}

export async function uploadFacebookVideo(pageId: string, pageAccessToken: string, graphVersion: string, input: SocialUploadInput): Promise<SocialUploadResult> {
  const stat = requireFile(input.filePath);
  const title = (input.title || 'Untitled video').slice(0, 255);
  const form = new FormData();
  form.append('title', title);
  form.append('description', input.description || '');
  form.append('published', input.privacyStatus !== 'private' ? 'true' : 'false');
  form.append('access_token', pageAccessToken);
  form.append('source', fs.createReadStream(input.filePath!), {
    filename: path.basename(input.filePath!),
    contentType: mimeType(input.filePath!),
    knownLength: stat.size,
  });

  const res = await axios.post(
    `${META_GRAPH_VIDEO}/${graphVersion}/${pageId}/videos`,
    form,
    {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 10 * 60 * 1000,
    },
  );
  const id = String(res.data?.id || '');
  if (!id) throw new Error('Facebook 未返回视频 ID');
  return {
    id,
    title,
    privacyStatus: input.privacyStatus === 'private' ? 'private' : 'public',
    url: `https://www.facebook.com/${pageId}/videos/${id}`,
  };
}

export async function publishFacebookImagePost(
  pageId: string,
  pageAccessToken: string,
  graphVersion: string,
  input: { imagePaths: string[]; title: string; description: string },
  lifecycle: {
    beforeImageUpload?: (imagePath: string, index: number) => Promise<void>;
    beforePublish?: () => Promise<void>;
    onProviderReceipt?: (postId: string) => Promise<void>;
  } = {},
): Promise<FacebookImagePostResult> {
  const photoIds: string[] = [];
  for (const [index, imagePath] of input.imagePaths.entries()) {
    const stat = requireFile(imagePath);
    if (!['.jpg', '.jpeg', '.png'].includes(path.extname(imagePath).toLowerCase())) throw new Error('facebook_image_file_invalid');
    if (lifecycle.beforeImageUpload) await lifecycle.beforeImageUpload(imagePath, index);
    const form = new FormData();
    form.append('published', 'false');
    form.append('access_token', pageAccessToken);
    form.append('source', fs.createReadStream(imagePath), {
      filename: path.basename(imagePath),
      contentType: path.extname(imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
      knownLength: stat.size,
    });
    const response = await axios.post(`${META_GRAPH}/${graphVersion}/${pageId}/photos`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000,
    });
    const photoId = String(response.data?.id || '').trim();
    if (!photoId) throw new Error('facebook_photo_receipt_missing');
    photoIds.push(photoId);
  }
  if (lifecycle.beforePublish) await lifecycle.beforePublish();
  const body = new URLSearchParams({ access_token: pageAccessToken, message: input.description });
  photoIds.forEach((mediaId, index) => body.set(`attached_media[${index}]`, JSON.stringify({ media_fbid: mediaId })));
  const response = await axios.post(`${META_GRAPH}/${graphVersion}/${pageId}/feed`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    maxRedirects: 0,
    timeout: 30_000,
  });
  const id = String(response.data?.id || '').trim();
  if (!id) throw new Error('facebook_post_receipt_missing');
  if (lifecycle.onProviderReceipt) await lifecycle.onProviderReceipt(id);
  return {
    id,
    photoIds,
    title: input.title,
    privacyStatus: 'public',
    url: `https://www.facebook.com/${id}`,
  };
}

export async function getInstagramMedia(igUserId: string, pageAccessToken: string, graphVersion: string, maxResults = 25) {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${igUserId}/media`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count',
      limit: Math.min(50, maxResults),
    },
  });
  return (res.data?.data ?? []).map((m: any) => ({
    id: String(m.id),
    title: String(m.caption || 'Instagram media').slice(0, 120),
    description: String(m.caption || ''),
    publishedAt: String(m.timestamp || ''),
    thumbnailUrl: String(m.thumbnail_url || m.media_url || ''),
    viewCount: undefined,
    likeCount: normalizeMetricValues({ likes: m.like_count }).likes,
    commentCount: normalizeMetricValues({ comments: m.comments_count }).comments,
    duration: '',
    permalinkUrl: String(m.permalink || ''),
  }));
}

export async function getInstagramComments(mediaId: string, pageAccessToken: string, graphVersion: string, maxResults = 50) {
  const res = await axios.get(`${META_GRAPH}/${graphVersion}/${mediaId}/comments`, {
    params: {
      access_token: pageAccessToken,
      fields: 'id,text,username,timestamp,like_count',
      limit: Math.min(100, maxResults),
    },
  });
  return (res.data?.data ?? []).map((c: any) => ({
    id: String(c.id),
    authorName: String(c.username || 'Instagram user'),
    authorProfileImageUrl: '',
    textDisplay: String(c.text || ''),
    likeCount: Number(c.like_count || 0),
    publishedAt: String(c.timestamp || ''),
    videoId: mediaId,
  }));
}

export async function replyToFacebookComment(commentId: string, pageAccessToken: string, graphVersion: string, message: string): Promise<{ id: string }> {
  const res = await axios.post(`${META_GRAPH}/${graphVersion}/${commentId}/comments`, null, {
    params: { access_token: pageAccessToken, message },
  });
  return { id: String(res.data?.id || '') };
}

export async function replyToInstagramComment(commentId: string, pageAccessToken: string, graphVersion: string, message: string): Promise<{ id: string }> {
  const res = await axios.post(`${META_GRAPH}/${graphVersion}/${commentId}/replies`, null, {
    params: { access_token: pageAccessToken, message },
  });
  return { id: String(res.data?.id || '') };
}

export async function publishInstagramReel(igUserId: string, pageAccessToken: string, graphVersion: string, input: SocialUploadInput, lifecycle?: { onContainerCreated: (creationId: string) => Promise<void>; beforePublish?: () => Promise<void>; graphHost?: 'https://graph.instagram.com' | 'https://graph.facebook.com'; onPublishedMedia?: (mediaId: string) => Promise<void> }): Promise<SocialUploadResult> {
  if (!input.videoUrl) {
    throw new Error('Instagram 发布需要公网可访问的视频 URL。请配置 R2_PUBLIC_URL 或传入 videoUrl。');
  }
  if (!lifecycle) throw new Error('instagram_container_persistence_required');
  const graphHost = lifecycle.graphHost || META_GRAPH;
  const caption = input.description || input.title || '';
  const create = await axios.post(`${graphHost}/${graphVersion}/${igUserId}/media`, null, {
    maxRedirects: 0,
    params: {
      access_token: pageAccessToken,
      media_type: 'REELS',
      video_url: input.videoUrl,
      caption,
    },
  });
  const creationId = String(create.data?.id || '');
  if (!creationId) throw new Error('Instagram 未返回媒体容器 ID');
  // Persist before polling or submitting: a lost publish response must retain this identity.
  await lifecycle.onContainerCreated(creationId);

  await waitForInstagramContainer(creationId, pageAccessToken, graphVersion, graphHost);
  await lifecycle.beforePublish?.();

  const publish = await axios.post(`${graphHost}/${graphVersion}/${igUserId}/media_publish`, null, {
    maxRedirects: 0,
    params: {
      access_token: pageAccessToken,
      creation_id: creationId,
    },
  });
  const id = String(publish.data?.id || '');
  if (!id) throw new Error('Instagram 未返回最终媒体 ID，禁止重新创建容器');
  await lifecycle.onPublishedMedia?.(id);
  return {
    id,
    providerReceiptId: `ig-container:${creationId}`,
    title: input.title,
    privacyStatus: 'public',
    url: `https://www.instagram.com/reel/${id}`,
  };
}

async function waitForInstagramContainer(creationId: string, pageAccessToken: string, graphVersion: string, graphHost: string) {
  const maxAttempts = Number(process.env.INSTAGRAM_MEDIA_PUBLISH_MAX_ATTEMPTS ?? 30);
  const intervalMs = Number(process.env.INSTAGRAM_MEDIA_PUBLISH_POLL_MS ?? 3000);
  let lastStatus = '';
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await axios.get(`${graphHost}/${graphVersion}/${creationId}`, {
      maxRedirects: 0,
    params: {
        access_token: pageAccessToken,
        fields: 'id,status,status_code',
      },
    });
    if (String(res.data?.id || '') !== creationId) throw new Error('Instagram 容器回执不匹配，禁止发布');
    lastStatus = String(res.data?.status_code || res.data?.status || '');
    lastError = String(res.data?.status || '');
    if (lastStatus === 'FINISHED') return;
    if (lastStatus === 'ERROR' || lastStatus === 'EXPIRED') {
      throw new Error(`Instagram 视频处理失败：${lastError || lastStatus}`);
    }
    await delay(intervalMs);
  }

  throw new Error(`Instagram 视频仍在处理中，请稍后重试。最后状态：${lastStatus || '未知'}`);
}
