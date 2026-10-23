import { isDiscoveryVideoEligible } from '../../shared/contracts/discoveryVideoPolicy.js';
import { accountLabelFromUrl, canonicalSourceUrl, looksLikeVideoUrl, stripTrackingParams } from './videoCrawlerSourceUrls.js';
import { isPlatformUrl, tagsFromKeyword, type CrawledVideo } from './videoCrawlerNormalization.js';
import { sourceAccountFromProviderMetadata } from './videoSourceIdentity.js';

/** Pure projections of supplier rows; network calls and cost gates remain in videos.ts. */

function isRecordThumbnailUrl(url: string): boolean {
  return /^\/api\/overseas\/videos\/[^/]+\/thumbnail$/.test(url);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function cleanupAnalysisTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 140) || '未命名社媒视频';
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function normalizeThumbnailUrl(raw: string): string {
  const url = String(raw || '').trim().replace(/\\u0026/g, '&');
  // PB 文件字段里的封面用 /api/overseas/videos/<id>/thumbnail 表示，同样是合法封面，
  // 不认它的话修复逻辑会判定"没有封面"并无限重爬。
  if (isRecordThumbnailUrl(url)) return url;
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/media/')) return '';
  if (/\.(?:mp4|mov|webm|m3u8)(?:[?#]|$)/i.test(url)) return '';
  return url;
}

export function firstImageUrl(values: unknown[]): string {
  for (const value of values) {
    const found = findImageUrl(value);
    if (found) return found;
  }
  return '';
}

export function imageUrlsFrom(values: unknown[], limit = 10): string[] {
  const out: string[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (out.length >= limit || depth > 8 || value == null) return;
    if (typeof value === 'string') {
      const found = normalizeThumbnailUrl(value);
      if (found && !out.includes(found)) out.push(found);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const key of [
      'displayUrl', 'url', 'uri', 'src', 'thumbnail', 'thumbnailUrl', 'thumbnail_url',
      'thumbnail_image', 'image', 'images', 'media', 'attachments', 'attachment',
      'subattachments', 'all_subattachments', 'styles', 'photos', 'photo',
      'photo_image', 'photoImage',
    ]) {
      visit(record[key], depth + 1);
    }
  };
  values.forEach(value => visit(value));
  return out.slice(0, limit);
}

function findImageUrl(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return normalizeThumbnailUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string' && (record.width || record.height || Object.keys(record).length <= 3)) {
    const found = findImageUrl(record.url, depth + 1);
    if (found) return found;
  }
  const keys = [
    'thumbnail',
    'thumbnailUrl',
    'thumbnail_url',
    'coverUrl',
    'cover_url',
    'cover',
    'covers',
    'dynamicCover',
    'originCover',
    'displayImage',
    'image',
    'images',
  ];
  for (const key of keys) {
    const found = findImageUrl(record[key], depth + 1);
    if (found) return found;
  }
  return '';
}

export function apifyTikTokItemToCrawledVideo(item: Record<string, unknown>, keyword: string): CrawledVideo | null {
  if (item.isSlideshow === true || (Array.isArray(item.slideshowImageLinks) && item.slideshowImageLinks.length > 0)) return null;
  const author = apifyAuthor(item);
  const sourceUrl = canonicalSourceUrl('tiktok', String(item.webVideoUrl || item.url || item.shareUrl || item.videoUrl || item.link || '').trim(), author);
  if (!sourceUrl || !isPlatformUrl(sourceUrl, 'tiktok')) return null;
  const text = String(item.text || item.description || item.desc || item.title || '').trim();
  const title = cleanupAnalysisTitle(text || (author ? `TikTok video by ${author}` : 'TikTok video'));
  const thumbnailUrl = firstImageUrl([
    item.videoMeta,
    item.coverUrl,
    item.thumbnailUrl,
    item.thumbnail,
    item.dynamicCover,
    item.originCover,
    item.covers,
    item.images,
    item,
  ]);
  const duration = Number(item.videoMeta && typeof item.videoMeta === 'object' && 'duration' in item.videoMeta
    ? (item.videoMeta as Record<string, unknown>).duration
    : item.duration || 0);
  if (!isDiscoveryVideoEligible({ platform: 'tiktok', duration, sourceUrl })) return null;
  const playCount = Number(item.playCount || item.views || item.viewCount || 0);
  const diggCount = Number(item.diggCount || item.likes || item.likeCount || 0);
  const commentCount = Number(item.commentCount || item.comments || 0);
  const tags = apifyTikTokTags(item, keyword);
  return {
    platform: 'tiktok',
    title,
    sourceUrl,
    thumbnailUrl,
    duration,
    views: playCount > 0 ? compactNumber(playCount) : 'TikTok',
    tags,
    uploadedAt: apifyUploadedAt(item),
    author,
    likes: diggCount > 0 ? compactNumber(diggCount) : undefined,
    comments: commentCount > 0 ? compactNumber(commentCount) : undefined,
    source: 'apify',
  };
}

export function apifyAuthor(item: Record<string, unknown>): string {
  const authorMeta = item.authorMeta && typeof item.authorMeta === 'object' ? item.authorMeta as Record<string, unknown> : {};
  return String(authorMeta.name || authorMeta.nickName || item.author || item.username || '').trim();
}

export function apifyUploadedAt(item: Record<string, unknown>): string | undefined {
  const timestamp = Number(item.createTime || item.createTimeISO || item.timestamp || 0);
  if (timestamp > 1_000_000_000_000) return new Date(timestamp).toISOString();
  if (timestamp > 1_000_000_000) return new Date(timestamp * 1000).toISOString();
  const iso = String(item.createTimeISO || item.createdAt || item.date || '').trim();
  return iso && !Number.isFinite(Number(iso)) ? iso : undefined;
}

export function apifyTikTokTags(item: Record<string, unknown>, keyword: string): string[] {
  const raw = [
    ...(Array.isArray(item.hashtags) ? item.hashtags : []),
    ...(Array.isArray(item.mentions) ? item.mentions : []),
    ...tagsFromKeyword(keyword, 'tiktok'),
  ];
  return [...new Set(raw
    .map(tag => typeof tag === 'string' ? tag : String((tag as Record<string, unknown>)?.name || (tag as Record<string, unknown>)?.title || ''))
    .map(tag => tag.replace(/^#/, '').trim())
    .filter(Boolean))].slice(0, 8);
}

export function apifyInstagramItemToCrawledVideo(item: Record<string, unknown>, keyword: string): CrawledVideo | null {
  // 只保留可拿到 mp4 的视频/Reel，跳过纯图片帖。
  const type = String(item.type || '').toLowerCase();
  const isVideo = type === 'video' || item.productType === 'clips' || Boolean(item.videoUrl);
  if (!isVideo) return null;
  const author = String(item.ownerUsername || '').trim();
  const shortCode = String(item.shortCode || '').trim();
  const rawUrl = String(item.url || (shortCode ? `https://www.instagram.com/reel/${shortCode}/` : '')).trim();
  const sourceUrl = canonicalSourceUrl('instagram', rawUrl, author);
  if (!sourceUrl || !isPlatformUrl(sourceUrl, 'instagram')) return null;
  const caption = String(item.caption || '').trim();
  const title = cleanupAnalysisTitle(caption || (author ? `Instagram video by ${author}` : 'Instagram video'));
  const thumbnailUrl = firstImageUrl([item.displayUrl, item.images, item]);
  const duration = Number(item.videoDuration || 0);
  const playCount = Number(item.videoPlayCount || item.videoViewCount || 0);
  const likeCount = Number(item.likesCount || 0);
  const commentCount = Number(item.commentsCount || 0);
  const tags = apifyInstagramTags(item, keyword);
  return {
    platform: 'instagram',
    title,
    sourceUrl,
    thumbnailUrl,
    duration,
    views: playCount > 0 ? compactNumber(playCount) : 'Instagram',
    tags,
    uploadedAt: apifyInstagramUploadedAt(item),
    author,
    sourceAccountUrl: author ? sourceAccountFromProviderMetadata('instagram',`https://www.instagram.com/${author}`) ?? undefined : undefined,
    likes: likeCount > 0 ? compactNumber(likeCount) : undefined,
    comments: commentCount > 0 ? compactNumber(commentCount) : undefined,
    source: 'apify',
  };
}

export function apifyInstagramUploadedAt(item: Record<string, unknown>): string | undefined {
  const iso = String(item.timestamp || item.takenAt || '').trim();
  return iso && !Number.isFinite(Number(iso)) ? iso : undefined;
}

export function apifyInstagramTags(item: Record<string, unknown>, keyword: string): string[] {
  const raw = [
    ...(Array.isArray(item.hashtags) ? item.hashtags : []),
    ...(Array.isArray(item.mentions) ? item.mentions : []),
    ...tagsFromKeyword(keyword, 'instagram'),
  ];
  return [...new Set(raw
    .map(tag => typeof tag === 'string' ? tag : String((tag as Record<string, unknown>)?.name || (tag as Record<string, unknown>)?.title || ''))
    .map(tag => tag.replace(/^#/, '').trim())
    .filter(Boolean))].slice(0, 8);
}

export function apifyFacebookPostToCrawledVideo(item: Record<string, unknown>, accountUrl: string): CrawledVideo | null {
  const media = findFacebookVideoMedia(item);
  if (!media) return null;
  const rawUrl = String(media.url || media.permalink_url || item.url || item.topLevelUrl || '').trim();
  const sourceUrl = rawUrl && isPlatformUrl(rawUrl, 'facebook') ? stripTrackingParams(rawUrl) : '';
  if (!sourceUrl || !looksLikeVideoUrl(sourceUrl, 'facebook')) return null;
  const author = String(item.pageName || asRecord(item.user).name || accountLabelFromUrl(accountUrl)).trim();
  const text = String(item.text || item.message || '').trim();
  const title = cleanupAnalysisTitle(text || (author ? `Facebook video by ${author}` : 'Facebook video'));
  const durationMs = Number(media.playable_duration_in_ms || 0);
  const likes = Number(item.likes || item.reactionLikeCount || 0);
  const comments = Number(item.comments || 0);
  const shares = Number(item.shares || 0);
  return {
    platform: 'facebook',
    title,
    sourceUrl,
    thumbnailUrl: firstImageUrl([media.thumbnail, media.thumbnailImage, media.image, media]),
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : Number(media.duration || 0),
    views: shares > 0 ? `${compactNumber(shares)} shares` : 'Facebook',
    tags: facebookTagsFromPost(item, accountUrl),
    uploadedAt: apifyFacebookUploadedAt(item, media),
    author,
    sourceAccountUrl: [item.pageUrl,item.facebookUrl,accountUrl].map(value=>sourceAccountFromProviderMetadata('facebook',String(value||''))).find(Boolean) ?? undefined,
    likes: likes > 0 ? compactNumber(likes) : undefined,
    comments: comments > 0 ? compactNumber(comments) : undefined,
    source: 'apify',
  };
}

export function findFacebookVideoMedia(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFacebookVideoMedia(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const type = String(record.__typename || record.__isMedia || '').toLowerCase();
  const playable = record.is_playable === true
    || type === 'video'
    || Boolean(record.playable_url || record.playable_url_quality_hd || record.browser_native_hd_url || record.browser_native_sd_url || record.videoId);
  const mediaUrl = String(record.url || record.permalink_url || '').trim();
  if (playable && (!mediaUrl || isPlatformUrl(mediaUrl, 'facebook'))) return record;
  for (const key of ['media', 'attachments', 'video', 'videos', 'comet_sections']) {
    const found = findFacebookVideoMedia(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function apifyFacebookUploadedAt(item: Record<string, unknown>, media: Record<string, unknown>): string | undefined {
  const iso = String(item.time || item.createdAt || item.date || '').trim();
  if (iso && !Number.isFinite(Number(iso))) return iso;
  const timestamp = Number(item.timestamp || media.publish_time || 0);
  if (timestamp > 1_000_000_000_000) return new Date(timestamp).toISOString();
  if (timestamp > 1_000_000_000) return new Date(timestamp * 1000).toISOString();
  return undefined;
}

function facebookTagsFromPost(item: Record<string, unknown>, accountUrl: string): string[] {
  const tags = new Set<string>();
  const text = String(item.text || '').trim();
  for (const match of text.matchAll(/#([\p{L}\p{N}_-]+)/gu)) tags.add(match[1]);
  const account = accountLabelFromUrl(accountUrl).replace(/^@/, '').trim();
  if (account) tags.add(account);
  tags.add('facebook');
  return [...tags].filter(Boolean).slice(0, 8);
}
