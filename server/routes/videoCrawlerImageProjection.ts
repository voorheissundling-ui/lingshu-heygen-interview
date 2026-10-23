import type { CrawledImagePost } from '../socialDiscovery/imagePostEvidenceAnalysis.js';
import { canonicalSourceUrl, stripTrackingParams } from './videoCrawlerSourceUrls.js';
import { isPlatformUrl, tagsFromKeyword } from './videoCrawlerNormalization.js';
import {
  apifyAuthor, apifyFacebookUploadedAt, apifyInstagramTags, apifyInstagramUploadedAt, apifyTikTokTags, apifyUploadedAt,
  asRecord, cleanupAnalysisTitle, compactNumber, findFacebookVideoMedia, firstImageUrl, imageUrlsFrom,
} from './videoCrawlerProviderProjection.js';

export function apifyInstagramItemToImagePost(item: Record<string, unknown>, keyword: string): CrawledImagePost | null {
  const type = String(item.type || '').toLowerCase();
  const isVideo = type === 'video' || item.productType === 'clips' || Boolean(item.videoUrl);
  if (isVideo) return null;
  const author = String(item.ownerUsername || '').trim();
  const shortCode = String(item.shortCode || '').trim();
  const rawUrl = String(item.url || (shortCode ? `https://www.instagram.com/p/${shortCode}/` : '')).trim();
  const sourceUrl = canonicalSourceUrl('instagram', rawUrl, author);
  if (!sourceUrl || !isPlatformUrl(sourceUrl, 'instagram')) return null;
  if (!/\/p\//i.test(sourceUrl)) return null;
  const thumbnailUrl = firstImageUrl([item.displayUrl, item.images, item]);
  if (!thumbnailUrl) return null;
  const caption = String(item.caption || '').trim();
  const imageUrls = imageUrlsFrom([item.displayUrl, item.images, item.childPosts, item]).filter(url => !/\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(url));
  const likes = Number(item.likesCount || 0);
  const comments = Number(item.commentsCount || 0);
  const owner = asRecord(item.owner);
  return {
    platform: 'instagram',
    title: cleanupAnalysisTitle(caption || (author ? `Instagram post by ${author}` : 'Instagram image post')),
    sourceUrl,
    thumbnailUrl,
    caption,
    imageUrls: imageUrls.length ? imageUrls : [thumbnailUrl],
    views: likes > 0 ? `${compactNumber(likes)} likes` : 'Instagram',
    tags: apifyInstagramTags(item, keyword),
    uploadedAt: apifyInstagramUploadedAt(item),
    author,
    likes: likes > 0 ? compactNumber(likes) : undefined,
    comments: comments > 0 ? compactNumber(comments) : undefined,
    followers: Number(item.ownerFollowersCount || item.followersCount || owner.followersCount || 0) || undefined,
    isPaidPartnership: item.isPaidPartnership === true || item.isPaidPartnershipPost === true,
    source: 'apify-image',
  };
}

export function apifyTikTokItemToImagePost(item: Record<string, unknown>, keyword: string): CrawledImagePost | null {
  const hasImages = Boolean(item.imagePost)
    || (Array.isArray(item.images) && item.images.length > 0)
    || (Array.isArray(item.imageUrls) && item.imageUrls.length > 0)
    || String(item.type || item.mediaType || '').toLowerCase().includes('photo');
  if (!hasImages) return null;
  const author = apifyAuthor(item);
  const sourceUrl = canonicalSourceUrl('tiktok', String(item.webVideoUrl || item.url || item.shareUrl || item.link || '').trim(), author);
  if (!sourceUrl || !isPlatformUrl(sourceUrl, 'tiktok')) return null;
  const text = String(item.text || item.description || item.desc || item.title || '').trim();
  const thumbnailUrl = firstImageUrl([item.imagePost, item.images, item.imageUrls, item.coverUrl, item.thumbnailUrl, item]);
  const imageUrls = imageUrlsFrom([item.imagePost, item.images, item.imageUrls, item.coverUrl, item.thumbnailUrl, item]);
  const likes = Number(item.diggCount || item.likes || item.likeCount || 0);
  const comments = Number(item.commentCount || item.comments || 0);
  const shares = Number(item.shareCount || item.shares || 0);
  const plays = Number(item.playCount || item.plays || 0);
  const authorMeta = asRecord(item.authorMeta);
  return {
    platform: 'tiktok',
    title: cleanupAnalysisTitle(text || (author ? `TikTok photo post by ${author}` : 'TikTok photo post')),
    sourceUrl,
    thumbnailUrl,
    caption: text,
    imageUrls: imageUrls.length ? imageUrls : [thumbnailUrl].filter(Boolean),
    views: likes > 0 ? `${compactNumber(likes)} likes` : 'TikTok',
    tags: apifyTikTokTags(item, keyword),
    uploadedAt: apifyUploadedAt(item),
    author,
    likes: likes > 0 ? compactNumber(likes) : undefined,
    comments: comments > 0 ? compactNumber(comments) : undefined,
    shares: shares > 0 ? compactNumber(shares) : undefined,
    plays: plays > 0 ? compactNumber(plays) : undefined,
    followers: Number(authorMeta.fans || authorMeta.followers || 0) || undefined,
    isAd: item.isAd === true || item.isSponsored === true,
    source: 'apify-image',
  };
}

function isDirectFacebookImageAsset(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === 'facebook.com' || host.endsWith('.facebook.com')) return false;
    return host.endsWith('.fbcdn.net') || /\.(?:jpe?g|png|webp|avif)(?:$|[?#])/i.test(url.pathname + url.search);
  } catch { return false; }
}

export function apifyFacebookPostToImagePost(item: Record<string, unknown>, keyword: string): CrawledImagePost | null {
  if (findFacebookVideoMedia(item)) return null;
  const media = findFacebookImageMedia(item);
  const sourceUrl = String(item.url || item.topLevelUrl || media?.url || '').trim();
  if (!sourceUrl || !isPlatformUrl(sourceUrl, 'facebook')) return null;
  if (/\/search\//i.test(sourceUrl)) return null;
  const imageUrls = imageUrlsFrom([media, item.media, item]).filter(isDirectFacebookImageAsset);
  const thumbnailUrl = imageUrls[0] || '';
  if (!media || !thumbnailUrl) return null;
  const author = String(item.pageName || asRecord(item.user).name || '').trim();
  const text = String(item.text || item.message || '').trim();
  const captionTags = [...text.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map(match => match[1]!).filter(Boolean);
  const likes = Number(item.likes || item.reactionLikeCount || 0);
  const comments = Number(item.comments || 0);
  const shares = Number(item.shares || item.shareCount || 0);
  const user = asRecord(item.user);
  return {
    platform: 'facebook',
    title: cleanupAnalysisTitle(text || (author ? `Facebook post by ${author}` : 'Facebook image post')),
    sourceUrl: stripTrackingParams(sourceUrl),
    thumbnailUrl,
    caption: text,
    imageUrls: imageUrls.length ? imageUrls : [thumbnailUrl],
    views: likes > 0 ? `${compactNumber(likes)} likes` : 'Facebook',
    tags: [...new Set([...captionTags, ...tagsFromKeyword(/^https?:\/\//i.test(keyword) ? '' : keyword, 'facebook')])].slice(0, 12),
    uploadedAt: apifyFacebookUploadedAt(item, media || {}),
    author,
    likes: likes > 0 ? compactNumber(likes) : undefined,
    comments: comments > 0 ? compactNumber(comments) : undefined,
    shares: shares > 0 ? compactNumber(shares) : undefined,
    followers: Number(item.followersCount || item.pageFollowers || user.followersCount || 0) || undefined,
    source: 'apify-image',
  };
}

function findFacebookImageMedia(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFacebookImageMedia(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const type = String(record.__typename || record.__isMedia || '').toLowerCase();
  if (type === 'photo' || record.photo_image || record.photoImage || record.image || record.thumbnail || record.thumbnail_image) return record;
  for (const key of ['media', 'attachments', 'attachment', 'subattachments', 'all_subattachments', 'styles', 'photo', 'photos']) {
    const found = findFacebookImageMedia(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}
