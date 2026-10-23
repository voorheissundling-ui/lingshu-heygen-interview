import { normalizeMetricValues } from '../socialMetrics/aggregation.js';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  accessToken?: string;
}

export interface YouTubeChannelInfo {
  id: string;
  title: string;
  description: string;
  customUrl?: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  thumbnailUrl?: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  duration: string;
}

export interface YouTubeUploadInput {
  filePath: string;
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: 'private' | 'unlisted' | 'public';
  madeForKids?: boolean;
}

export interface YouTubeUploadResult {
  id: string;
  title: string;
  privacyStatus: string;
  url: string;
}

export interface YouTubeOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
}

export interface YouTubeComment {
  id: string;
  authorName: string;
  authorProfileImageUrl?: string;
  textDisplay: string;
  likeCount: number;
  publishedAt: string;
  videoId: string;
}

export interface YouTubeSuperChat {
  id: string;
  authorName: string;
  authorProfileImageUrl?: string;
  textDisplay: string;
  amountMicros: number;
  currency: string;
  publishedAt: string;
  videoId?: string;
}

export interface YouTubeCommentPage {
  comments: YouTubeComment[];
  nextPageToken?: string;
  totalFetched: number;
}

const accessTokenCache = new Map<string, { value: string; expiresAt: number }>();

const GOOGLE_AUTH_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3';
const YOUTUBE_ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';

function tokenCacheKey(config: YouTubeConfig) {
  return `${config.clientId}\0${config.refreshToken ?? config.accessToken ?? ''}`;
}

function videoMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    default: return 'video/*';
  }
}

/**
 * Fetch all comment threads on a channel's videos using an API Key (no OAuth).
 * Works for public channels and public videos.
 */
export async function getChannelCommentsByApiKey(
  apiKey: string,
  channelId: string,
  options: { maxResults?: number; pageToken?: string; order?: 'time' | 'relevance' } = {}
): Promise<YouTubeCommentPage> {
  const { maxResults = 100, pageToken, order = 'time' } = options;

  const params: Record<string, string | number> = {
    part: 'snippet',
    allThreadsRelatedToChannelId: channelId,
    textFormat: 'plainText',
    maxResults: Math.min(100, maxResults),
    order,
    key: apiKey,
  };
  if (pageToken) params.pageToken = pageToken;

  const res = await axios.get(`${YOUTUBE_API_URL}/commentThreads`, { params });

  const comments: YouTubeComment[] = (res.data.items || []).map((item: any) => {
    const top = item.snippet.topLevelComment;
    return {
      id: top.id,
      authorName: top.snippet.authorDisplayName,
      authorProfileImageUrl: top.snippet.authorProfileImageUrl,
      textDisplay: top.snippet.textDisplay,
      likeCount: top.snippet.likeCount || 0,
      publishedAt: top.snippet.publishedAt,
      videoId: top.snippet.videoId,
    };
  });

  return {
    comments,
    nextPageToken: res.data.nextPageToken,
    totalFetched: comments.length,
  };
}

/**
 * Fetch comments on a specific video using an API Key (no OAuth).
 */
export async function getVideoCommentsByApiKey(
  apiKey: string,
  videoId: string,
  options: { maxResults?: number; pageToken?: string; order?: 'time' | 'relevance' } = {}
): Promise<YouTubeCommentPage> {
  const { maxResults = 100, pageToken, order = 'time' } = options;

  const params: Record<string, string | number> = {
    part: 'snippet,replies',
    videoId,
    textFormat: 'plainText',
    maxResults: Math.min(100, maxResults),
    order,
    key: apiKey,
  };
  if (pageToken) params.pageToken = pageToken;

  const res = await axios.get(`${YOUTUBE_API_URL}/commentThreads`, { params });

  const comments: YouTubeComment[] = [];
  for (const item of res.data.items || []) {
    const top = item.snippet.topLevelComment;
    comments.push({
      id: top.id,
      authorName: top.snippet.authorDisplayName,
      authorProfileImageUrl: top.snippet.authorProfileImageUrl,
      textDisplay: top.snippet.textDisplay,
      likeCount: top.snippet.likeCount || 0,
      publishedAt: top.snippet.publishedAt,
      videoId,
    });
    for (const reply of item.replies?.comments || []) {
      comments.push({
        id: reply.id,
        authorName: reply.snippet.authorDisplayName,
        authorProfileImageUrl: reply.snippet.authorProfileImageUrl,
        textDisplay: reply.snippet.textDisplay,
        likeCount: reply.snippet.likeCount || 0,
        publishedAt: reply.snippet.publishedAt,
        videoId,
      });
    }
  }

  return {
    comments,
    nextPageToken: res.data.nextPageToken,
    totalFetched: comments.length,
  };
}

/**
 * Look up a channel ID by its handle or custom URL using an API Key.
 */
export async function getChannelIdByHandle(apiKey: string, handle: string): Promise<string | null> {
  const forHandle = handle.startsWith('@') ? handle : `@${handle}`;
  const res = await axios.get(`${YOUTUBE_API_URL}/channels`, {
    params: {
      part: 'id',
      forHandle,
      key: apiKey,
    },
  });
  return res.data.items?.[0]?.id ?? null;
}

/**
 * Get or refresh access token
 */
export async function getAccessToken(config: YouTubeConfig): Promise<string> {
  // If we have a cached token and it hasn't expired, return it
  const cacheKey = tokenCacheKey(config);
  const cached = accessTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  // If no refresh token, use the provided access token (if it exists)
  if (!config.refreshToken && config.accessToken) {
    return config.accessToken;
  }

  // Refresh token
  if (config.refreshToken) {
    try {
      const res = await axios.post(GOOGLE_AUTH_URL, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      });

      accessTokenCache.set(cacheKey, {
        value: res.data.access_token,
        expiresAt: Date.now() + (res.data.expires_in - 60) * 1000,
      });
      return res.data.access_token;
    } catch (error) {
      console.error('Failed to refresh YouTube access token:', (error as any)?.response?.data ?? (error as any)?.message ?? error);
      throw error;
    }
  }

  throw new Error('No refresh token or access token provided');
}

/** Read-only OAuth introspection used before enabling videos.insert. */
export async function probeYouTubeUploadPermission(config: YouTubeConfig): Promise<{ granted: boolean; scopes: string[] }> {
  const accessToken = await getAccessToken(config);
  const response = await axios.get('https://oauth2.googleapis.com/tokeninfo', { params: { access_token: accessToken } });
  const scopes = String(response.data?.scope || '').split(/\s+/).filter(Boolean);
  return { granted: scopes.includes('https://www.googleapis.com/auth/youtube.upload'), scopes };
}

export async function exchangeYouTubeOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<YouTubeOAuthTokens> {
  const params = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  });

  const res = await axios.post(GOOGLE_AUTH_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return {
    accessToken: res.data.access_token,
    refreshToken: res.data.refresh_token,
    expiresIn: res.data.expires_in,
    scope: res.data.scope,
    tokenType: res.data.token_type,
  };
}

/**
 * Upload a local video file to the authenticated YouTube channel.
 * Uses YouTube Data API videos.insert with a resumable upload session.
 */
export async function uploadVideoToYouTube(
  config: YouTubeConfig,
  input: YouTubeUploadInput
): Promise<YouTubeUploadResult> {
  if (!input.title?.trim()) throw new Error('视频标题不能为空');
  if (!fs.existsSync(input.filePath)) throw new Error('成片文件不存在，请先重新合成');

  const stat = fs.statSync(input.filePath);
  if (!stat.isFile()) throw new Error('成片路径不是文件');

  const token = await getAccessToken(config);
  const mimeType = videoMimeType(input.filePath);
  const metadata = {
    snippet: {
      title: input.title.trim().slice(0, 100),
      description: input.description ?? '',
      categoryId: input.categoryId ?? '22',
      ...(input.tags?.length ? { tags: input.tags.slice(0, 30) } : {}),
    },
    status: {
      privacyStatus: input.privacyStatus ?? 'unlisted',
      selfDeclaredMadeForKids: input.madeForKids ?? false,
    },
  };

  const init = await axios.post(
    `${YOUTUBE_UPLOAD_URL}/videos`,
    metadata,
    {
      params: { uploadType: 'resumable', part: 'snippet,status' },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(stat.size),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );

  const uploadUrl = init.headers.location;
  if (!uploadUrl) throw new Error('YouTube 未返回上传地址');

  const uploaded = await axios.put(
    uploadUrl,
    fs.createReadStream(input.filePath),
    {
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(stat.size),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 0,
    }
  );

  const video = uploaded.data;
  const id = String(video.id ?? '');
  if (!id) throw new Error('YouTube 上传成功但未返回视频 ID');

  return {
    id,
    title: String(video.snippet?.title ?? metadata.snippet.title),
    privacyStatus: String(video.status?.privacyStatus ?? metadata.status.privacyStatus),
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

/**
 * Get authenticated user's channel info
 */
export async function getMyChannelInfo(config: YouTubeConfig): Promise<YouTubeChannelInfo> {
  const token = await getAccessToken(config);

  const res = await axios.get(`${YOUTUBE_API_URL}/channels`, {
    params: {
      part: 'snippet,statistics',
      mine: true,
      fields: 'items(id,snippet(title,description,customUrl,thumbnails),statistics(subscriberCount,videoCount,viewCount))',
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.data.items || res.data.items.length === 0) {
    throw new Error('No channel found');
  }

  const item = res.data.items[0];
  return {
    id: item.id,
    title: item.snippet.title,
    description: item.snippet.description || '',
    customUrl: item.snippet.customUrl,
    subscriberCount: parseInt(item.statistics.subscriberCount || '0'),
    videoCount: parseInt(item.statistics.videoCount || '0'),
    viewCount: parseInt(item.statistics.viewCount || '0'),
    thumbnailUrl: item.snippet.thumbnails?.default?.url,
  };
}

/**
 * Get my videos with statistics
 */
export async function getMyVideos(
  config: YouTubeConfig,
  maxResults: number = 50
): Promise<YouTubeVideo[]> {
  const token = await getAccessToken(config);

  // First get the uploads playlist ID
  const channelRes = await axios.get(`${YOUTUBE_API_URL}/channels`, {
    params: {
      part: 'contentDetails',
      mine: true,
      fields: 'items(contentDetails(relatedPlaylists(uploads)))',
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const uploadsPlaylistId = channelRes.data.items[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    throw new Error('Could not find uploads playlist');
  }

  // Get videos from uploads playlist
  const playlistRes = await axios.get(`${YOUTUBE_API_URL}/playlistItems`, {
    params: {
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: Math.min(50, maxResults),
      fields: 'items(contentDetails(videoId))',
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const videoIds = playlistRes.data.items.map((item: any) => item.contentDetails.videoId);

  if (videoIds.length === 0) {
    return [];
  }

  // Get video details and statistics
  const detailsRes = await axios.get(`${YOUTUBE_API_URL}/videos`, {
    params: {
      part: 'snippet,statistics,contentDetails',
      id: videoIds.join(','),
      fields: 'items(id,snippet(title,description,publishedAt,thumbnails),statistics(viewCount,likeCount,commentCount),contentDetails(duration))',
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  return detailsRes.data.items.map((item: any) => ({
    id: item.id,
    title: item.snippet.title,
    description: item.snippet.description || '',
    publishedAt: item.snippet.publishedAt,
    thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    viewCount: normalizeMetricValues({ views: item.statistics?.viewCount }).views,
    likeCount: normalizeMetricValues({ likes: item.statistics?.likeCount }).likes,
    commentCount: normalizeMetricValues({ comments: item.statistics?.commentCount }).comments,
    duration: item.contentDetails.duration,
  }));
}

/**
 * Get comments on a specific video
 */
export async function getVideoComments(
  config: YouTubeConfig,
  videoId: string,
  maxResults: number = 100
): Promise<YouTubeComment[]> {
  const token = await getAccessToken(config);

  const res = await axios.get(`${YOUTUBE_API_URL}/commentThreads`, {
    params: {
      part: 'snippet',
      videoId,
      textFormat: 'plainText',
      maxResults: Math.min(100, maxResults),
      order: 'relevance',
      fields: 'items(snippet(topLevelComment(id,snippet(authorDisplayName,authorProfileImageUrl,textDisplay,likeCount,publishedAt)),replies))',
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const comments: YouTubeComment[] = [];

  for (const item of res.data.items || []) {
    const topComment = item.snippet.topLevelComment;
    comments.push({
      id: topComment.id,
      authorName: topComment.snippet.authorDisplayName,
      authorProfileImageUrl: topComment.snippet.authorProfileImageUrl,
      textDisplay: topComment.snippet.textDisplay,
      likeCount: topComment.snippet.likeCount,
      publishedAt: topComment.snippet.publishedAt,
      videoId,
    });

    // Add replies if any
    if (item.snippet.replies && item.snippet.replies.length > 0) {
      for (const reply of item.snippet.replies) {
        comments.push({
          id: reply.id,
          authorName: reply.snippet.authorDisplayName,
          authorProfileImageUrl: reply.snippet.authorProfileImageUrl,
          textDisplay: reply.snippet.textDisplay,
          likeCount: reply.snippet.likeCount,
          publishedAt: reply.snippet.publishedAt,
          videoId,
        });
      }
    }
  }

  return comments;
}

/**
 * Get all comments across all my videos
 */
export async function getMyVideoComments(
  config: YouTubeConfig,
  maxResults: number = 1000,
  channelId?: string,
): Promise<YouTubeComment[]> {
  const token = await getAccessToken(config);
  const resolvedChannelId = channelId || (await getMyChannelInfo(config)).id;

  // commentThreads is the supported endpoint for channel-wide comment discovery.
  const res = await axios.get(`${YOUTUBE_API_URL}/commentThreads`, {
    params: {
      part: 'snippet',
      allThreadsRelatedToChannelId: resolvedChannelId,
      textFormat: 'plainText',
      maxResults: Math.min(100, maxResults),
      order: 'time',
      fields: 'items(snippet(videoId,topLevelComment(id,snippet(authorDisplayName,authorProfileImageUrl,textDisplay,likeCount,publishedAt))))',
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  return (res.data.items || []).map((item: any) => ({
    id: item.snippet.topLevelComment.id,
    authorName: item.snippet.topLevelComment.snippet.authorDisplayName,
    authorProfileImageUrl: item.snippet.topLevelComment.snippet.authorProfileImageUrl,
    textDisplay: item.snippet.topLevelComment.snippet.textDisplay,
    likeCount: item.snippet.topLevelComment.snippet.likeCount,
    publishedAt: item.snippet.topLevelComment.snippet.publishedAt,
    videoId: item.snippet.videoId,
  }));
}

/** Reply to an existing top-level comment. Requires youtube.force-ssl OAuth scope. */
export async function replyToYouTubeComment(config: YouTubeConfig, parentId: string, text: string): Promise<{ id: string }> {
  const token = await getAccessToken(config);
  const res = await axios.post(`${YOUTUBE_API_URL}/comments`, {
    snippet: { parentId, textOriginal: text },
  }, {
    params: { part: 'snippet' },
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return { id: String(res.data?.id || '') };
}

/**
 * Get super chats / channel memberships (requires specific scopes)
 * Note: Super Chat data requires YouTube Analytics API
 */
export async function getSuperChats(
  config: YouTubeConfig,
  videoId?: string
): Promise<YouTubeSuperChat[]> {
  const token = await getAccessToken(config);

  try {
    // This endpoint requires specific OAuth scopes: 'https://www.googleapis.com/auth/youtube'
    const res = await axios.get(`${YOUTUBE_API_URL}/superChatEvents`, {
      params: {
        part: 'snippet',
        ...(videoId && { videoId }),
        fields: 'items(id,snippet(creatorChannelId,creatorChannelUrl,displayString,superChatDetails,publishedAt))',
      },
      headers: { Authorization: `Bearer ${token}` },
    });

    return (res.data.items || []).map((item: any) => ({
      id: item.id,
      authorName: item.snippet.authorChannelUrl?.split('/').pop() || 'Anonymous',
      textDisplay: item.snippet.displayString || '',
      amountMicros: item.snippet.superChatDetails?.amountMicros || 0,
      currency: item.snippet.superChatDetails?.currency || 'USD',
      publishedAt: item.snippet.publishedAt,
      videoId,
    }));
  } catch (error) {
    console.warn('Failed to fetch super chats:', error);
    return [];
  }
}

/**
 * Get channel monetization status and analytics
 */
export async function getChannelAnalytics(config: YouTubeConfig): Promise<{
  isMonetized: boolean;
  totalSubscribers: number;
  totalViews: number;
  totalVideos: number;
}> {
  const token = await getAccessToken(config);

  const res = await axios.get(`${YOUTUBE_API_URL}/channels`, {
    params: {
      part: 'monetization,statistics',
      mine: true,
      fields: 'items(monetization(accessLevel),statistics)',
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  const item = res.data.items?.[0];
  return {
    isMonetized: item?.monetization?.accessLevel === 'monetized',
    totalSubscribers: parseInt(item?.statistics?.subscriberCount || '0'),
    totalViews: parseInt(item?.statistics?.viewCount || '0'),
    totalVideos: parseInt(item?.statistics?.videoCount || '0'),
  };
}

export interface YouTubeAnalyticsRow {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  averageViewPercentage: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  subscribersLost: number;
}

/** Daily, owner-only channel performance from the YouTube Analytics API. */
export async function getYouTubeAnalyticsReport(
  config: YouTubeConfig,
  input: { startDate: string; endDate: string },
): Promise<{ range: { startDate: string; endDate: string }; rows: YouTubeAnalyticsRow[] }> {
  const token = await getAccessToken(config);
  const metrics = [
    'views',
    'estimatedMinutesWatched',
    'averageViewDuration',
    'averageViewPercentage',
    'likes',
    'comments',
    'shares',
    'subscribersGained',
    'subscribersLost',
  ];
  const res = await axios.get(YOUTUBE_ANALYTICS_URL, {
    params: {
      ids: 'channel==MINE',
      startDate: input.startDate,
      endDate: input.endDate,
      dimensions: 'day',
      metrics: metrics.join(','),
      sort: 'day',
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  const headers = (res.data?.columnHeaders ?? []).map((header: any) => String(header.name));
  const rows = (res.data?.rows ?? []).map((values: unknown[]) => {
    const item = Object.fromEntries(headers.map((header: string, index: number) => [header, values[index]]));
    return {
      date: String(item.day || ''),
      views: Number(item.views || 0),
      estimatedMinutesWatched: Number(item.estimatedMinutesWatched || 0),
      averageViewDuration: Number(item.averageViewDuration || 0),
      averageViewPercentage: Number(item.averageViewPercentage || 0),
      likes: Number(item.likes || 0),
      comments: Number(item.comments || 0),
      shares: Number(item.shares || 0),
      subscribersGained: Number(item.subscribersGained || 0),
      subscribersLost: Number(item.subscribersLost || 0),
    };
  });
  return { range: input, rows };
}

/**
 * Verify OAuth credentials
 */
export async function verifyYouTubeCredentials(config: YouTubeConfig): Promise<boolean> {
  try {
    await getMyChannelInfo(config);
    return true;
  } catch {
    return false;
  }
}
