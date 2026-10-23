import type { CrawledVideo } from './videoCrawlerNormalization.js';

export interface LinkedInImagePost {
  platform: 'linkedin'; title: string; sourceUrl: string; thumbnailUrl: string;
  caption: string; imageUrls: string[]; views: string; tags: string[];
  uploadedAt?: string; author?: string; likes?: string; comments?: string;
  shares?: string; followers?: number; source: 'apify-image';
}

type ParsedPost =
  | { kind: 'image'; uploadedAt?: string; item: LinkedInImagePost }
  | { kind: 'video'; uploadedAt?: string; item: CrawledVideo };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }

function linkedInUrl(value: unknown): string {
  const raw = text(value);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || !/(?:^|\.)linkedin\.com$/i.test(url.hostname)) return '';
    url.search = ''; url.hash = '';
    return url.toString();
  } catch { return ''; }
}

function mediaUrls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(entry => {
    if (typeof entry === 'string') return [entry];
    const item = record(entry);
    return [item.url, item.src, item.imageUrl, item.thumbnailUrl].filter((candidate): candidate is string => typeof candidate === 'string');
  }).map(value => value.trim()).filter(value => /^https?:\/\//i.test(value) && !/\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(value));
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function uploadedAt(item: Record<string, unknown>): string | undefined {
  const raw = text(item.postedAt || item.publishedAt || item.createdAt || item.date || item.postedDate);
  if (raw && !Number.isFinite(Number(raw)) && Number.isFinite(Date.parse(raw))) return new Date(raw).toISOString();
  const timestamp = count(item.timestamp || item.postedTimestamp);
  if (timestamp > 1_000_000_000_000) return new Date(timestamp).toISOString();
  if (timestamp > 1_000_000_000) return new Date(timestamp * 1000).toISOString();
  return undefined;
}

/** Pure provider-row translation; no actor start, wallet access, or media download. */
export function parseLinkedInCompanyPost(row: Record<string, unknown>, companyUrl: string): ParsedPost | null {
  const sourceUrl = [row.postUrl, row.url, row.linkedinUrl, row.postLink, row.link].map(linkedInUrl)
    .find(url => /\/(?:posts|feed\/update)\//i.test(url) || /activity[:-]\d+/i.test(url));
  const sourceAccountUrl = linkedInUrl(companyUrl);
  if (!sourceUrl || !sourceAccountUrl || !/\/company\/[^/]+/i.test(sourceAccountUrl)) return null;
  const company = record(row.company);
  const caption = text(row.text || row.content || row.commentary || row.description || row.postText);
  const author = text(row.companyName || row.authorName || company.name) || new URL(sourceAccountUrl).pathname.split('/').filter(Boolean).at(-1) || 'LinkedIn';
  const images = [...new Set([row.images, row.imageUrls, row.media, row.attachments, row.documentImages, row.thumbnail, row.videoThumbnail, row.videoPoster].flatMap(mediaUrls))];
  const likes = count(row.reactionCount || row.reactionsCount || row.likesCount || row.numLikes || row.likes);
  const comments = count(row.commentCount || row.commentsCount || row.numComments || row.comments);
  const shares = count(row.repostCount || row.repostsCount || row.shareCount || row.shares);
  const followers = count(row.companyFollowersCount || row.followersCount || company.followersCount) || undefined;
  const tags = [...new Set([
    ...(Array.isArray(row.hashtags) ? row.hashtags.map(value => text(typeof value === 'string' ? value : record(value).name || record(value).text)) : []),
    ...[...caption.matchAll(/#([\p{L}\p{N}_-]+)/gu)].map(match => match[1]),
  ].map(tag => tag.replace(/^#/, '')).filter(Boolean))].slice(0, 20);
  const date = uploadedAt(row);
  const title = (caption.split(/[。；;\n]/)[0].trim() || `LinkedIn post by ${author}`).slice(0, 160);
  const common = { platform: 'linkedin' as const, title, caption, sourceUrl, tags, uploadedAt: date, author,
    views: likes ? `${likes} reactions` : 'LinkedIn', likes: likes ? String(likes) : undefined,
    comments: comments ? String(comments) : undefined, shares: shares ? String(shares) : undefined, followers };
  const video = text(row.videoUrl || row.videoDownloadUrl || row.mediaUrl);
  const isVideo = Boolean(video) || /video/i.test(text(row.mediaType || row.postType || row.type));
  if (isVideo) {
    const duration = count(row.videoDuration || row.duration || row.durationSeconds);
    const thumbnailUrl = images[0] || '';
    if (!duration || !thumbnailUrl) return null;
    return { kind: 'video', uploadedAt: date, item: { ...common, thumbnailUrl, duration, sourceAccountUrl, source: 'apify' } };
  }
  if (!images.length) return null;
  return { kind: 'image', uploadedAt: date, item: { ...common, thumbnailUrl: images[0], imageUrls: images, source: 'apify-image' } };
}
