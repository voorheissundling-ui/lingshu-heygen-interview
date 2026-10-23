import { authHeader } from './auth';

export type SocialPerformancePlatform = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'linkedin';

export interface ConnectedSocialPerformanceAccount {
  id: string;
  platform: SocialPerformancePlatform;
  title: string;
  handle: string;
  followerCount: number;
  videoCount: number;
  viewCount: number;
  lastSyncAt: string;
}

export interface ConnectedSocialPerformanceContent {
  id: string;
  accountId: string;
  accountTitle: string;
  platform: SocialPerformancePlatform;
  title: string;
  publishedAt: string;
  thumbnailUrl: string;
  platformUrl: string;
  metrics: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  };
}

export interface ConnectedSocialPerformance {
  accounts: ConnectedSocialPerformanceAccount[];
  contents: ConnectedSocialPerformanceContent[];
  unavailable: Array<{ platform: SocialPerformancePlatform; accountId?: string; reason: string }>;
  loadedAt: string;
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeader() });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    const raw = String(body.error || '');
    if (response.status === 401 || response.status === 403 || /unauthorized|forbidden|token|auth/i.test(raw)) {
      throw new Error('账号授权已失效，请重新连接对应平台后再同步数据');
    }
    if (response.status === 429) throw new Error('平台同步频率过高，请稍后再试');
    if (response.status >= 500) throw new Error('平台数据服务暂时不可用，已保留上次同步结果');
    throw new Error(raw || `账号数据读取失败（${response.status}）`);
  }
  return body;
}

const numberOrNull = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Read the same official-account endpoints used by Content Monitoring. Loading
 * videos also asks the server to refresh account metadata and persist metric
 * snapshots, so Smart Business review and Content Monitoring stay aligned.
 */
export async function loadConnectedSocialPerformance(maxResults = 50): Promise<ConnectedSocialPerformance> {
  const unavailable: ConnectedSocialPerformance['unavailable'] = [];
  const accounts: ConnectedSocialPerformanceAccount[] = [];
  const accountRequests = await Promise.allSettled([
    json<{ items?: Array<Record<string, unknown>> }>('/api/overseas/youtube/accounts'),
    json<{ items?: Array<Record<string, unknown>> }>('/api/overseas/social/accounts'),
  ]);

  if (accountRequests[0].status === 'fulfilled') {
    for (const raw of accountRequests[0].value.items || []) {
      if (raw.status !== 'connected') continue;
      accounts.push({
        id: String(raw.id || ''), platform: 'youtube', title: String(raw.channelTitle || 'YouTube'),
        handle: String(raw.customUrl || raw.channelId || ''), followerCount: Number(raw.subscriberCount || 0),
        videoCount: Number(raw.videoCount || 0), viewCount: Number(raw.viewCount || 0), lastSyncAt: String(raw.lastSyncAt || ''),
      });
    }
  } else unavailable.push({ platform: 'youtube', reason: accountRequests[0].reason instanceof Error ? accountRequests[0].reason.message : 'YouTube 账号读取失败' });

  if (accountRequests[1].status === 'fulfilled') {
    for (const raw of accountRequests[1].value.items || []) {
      const platform = String(raw.platform || '') as SocialPerformancePlatform;
      if (!['tiktok', 'instagram', 'facebook'].includes(platform) || raw.status !== 'connected') continue;
      accounts.push({
        id: String(raw.id || ''), platform, title: String(raw.title || platform), handle: String(raw.handle || raw.providerAccountId || ''),
        followerCount: Number(raw.followerCount || 0), videoCount: Number(raw.videoCount || 0), viewCount: Number(raw.viewCount || 0), lastSyncAt: String(raw.lastSyncAt || ''),
      });
    }
  } else unavailable.push({ platform: 'facebook', reason: accountRequests[1].reason instanceof Error ? accountRequests[1].reason.message : '社媒账号读取失败' });

  const contentResults = await Promise.allSettled(accounts.map(async account => {
    const base = account.platform === 'youtube' ? '/api/overseas/youtube' : '/api/overseas/social';
    const response = await json<{ videos?: Array<Record<string, unknown>> }>(`${base}/accounts/${encodeURIComponent(account.id)}/videos?maxResults=${Math.max(1, Math.min(50, maxResults))}`);
    return (response.videos || []).map(raw => ({
      id: `${account.platform}:${account.id}:${String(raw.id || '')}`,
      accountId: account.id,
      accountTitle: account.title,
      platform: account.platform,
      title: String(raw.title || '未命名内容'),
      publishedAt: String(raw.publishedAt || ''),
      thumbnailUrl: String(raw.thumbnailUrl || ''),
      platformUrl: String(raw.permalinkUrl || raw.url || (account.platform === 'youtube' && raw.id ? `https://www.youtube.com/watch?v=${raw.id}` : '')),
      metrics: {
        views: numberOrNull(raw.viewCount), likes: numberOrNull(raw.likeCount),
        comments: numberOrNull(raw.commentCount), shares: numberOrNull(raw.shareCount),
      },
    } satisfies ConnectedSocialPerformanceContent));
  }));

  const contents: ConnectedSocialPerformanceContent[] = [];
  contentResults.forEach((result, index) => {
    if (result.status === 'fulfilled') contents.push(...result.value);
    else unavailable.push({
      platform: accounts[index].platform,
      accountId: accounts[index].id,
      reason: result.reason instanceof Error ? result.reason.message : '账号内容读取失败',
    });
  });
  return { accounts, contents, unavailable, loadedAt: new Date().toISOString() };
}
