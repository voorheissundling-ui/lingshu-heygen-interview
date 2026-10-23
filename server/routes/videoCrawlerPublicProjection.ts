import type { Platform } from '../types/index.js';
import { youtubeShortUrl } from '../../shared/contracts/discoveryVideoPolicy.js';
import { canonicalSourceUrl, youtubeThumbnailFromUrl } from './videoCrawlerSourceUrls.js';
import { compactDate, metadataCreatorAccount, metadataTitle, metadataUploader, uploadedAtFromMeta, videoDedupeKey, type CrawledVideo } from './videoCrawlerNormalization.js';
import { compactNumber, firstImageUrl, normalizeThumbnailUrl } from './videoCrawlerProviderProjection.js';

/** Pure public-discovery projection. Network calls, paid admission, and persistence remain in videos.ts. */
export function crawlFailureMessage(platform: string, failures: string[], fallback: string): string {
  const causes = [...new Set(failures.map(value => value.trim()).filter(Boolean))];
  return causes.length ? `${platform} crawl failed: ${causes.join('；')}` : `${platform} ${fallback}`;
}

export function youtubeHtmlSearchUrl(keyword: string, dateFrom = '', dateTo = ''): { url: string; dateEvidence: string } {
  const uploadDateFilter = youtubeUploadDateFilterParam(dateFrom, dateTo);
  const sp = uploadDateFilter || 'EgIYAQ%253D%253D';
  return {
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=${sp}`,
    dateEvidence: uploadDateFilter ? 'youtube-upload-filter' : 'youtube-shorts-filter',
  };
}

function youtubeUploadDateFilterParam(dateFrom = '', dateTo = ''): string {
  const from = compactDate(dateFrom);
  const to = compactDate(dateTo);
  if (!from && !to) return '';
  const end = to ? dateFromCompact(to) : new Date();
  const start = from ? dateFromCompact(from) : new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Discovery passes dateFrom as now - lookbackDays, so count elapsed days.
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
  if (days <= 1) return 'EgIIAg%253D%253D';
  if (days <= 7) return 'EgIIAw%253D%253D';
  if (days <= 31) return 'EgIIBA%253D%253D';
  if (days <= 366) return 'EgIIBQ%253D%253D';
  return '';
}

function dateFromCompact(input: string): Date {
  return new Date(`${input.slice(0, 4)}-${input.slice(4, 6)}-${input.slice(6, 8)}T00:00:00.000Z`);
}

export function publicSearchQuery(platform: Platform, keyword: string): string {
  if (platform === 'tiktok') return `site:tiktok.com/@ "${keyword}" "/video/"`;
  if (platform === 'instagram') return `site:instagram.com/reel "${keyword}"`;
  if (platform === 'facebook') return `site:facebook.com/reel OR site:facebook.com/watch "${keyword}"`;
  return keyword;
}

export function cleanSearchResultUrl(url: string): string {
  return url.replace(/&amp;/g, '&').replace(/[?#]utm_[^#]+$/i, '');
}

export function mergeCrawledVideos(existing: CrawledVideo[], incoming: CrawledVideo[]): CrawledVideo[] {
  const seen = new Set(existing.map(item => videoDedupeKey(item)));
  const out = [...existing];
  for (const item of incoming) {
    const normalized = normalizeCrawledVideo(item);
    const key = videoDedupeKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function metaToCrawledVideo(platform: Platform, keyword: string, youtubeShortsSource = false): (meta: Record<string, unknown>) => CrawledVideo | null {
  return (meta) => {
    const rawWebpageUrl = String(meta.webpage_url || meta.original_url || meta.url || '');
    const canonicalUrl = canonicalSourceUrl(platform, rawWebpageUrl, metadataUploader(meta));
    const isYouTubeShort = platform === 'youtube' && (youtubeShortsSource || /youtube\.com\/shorts\//i.test(rawWebpageUrl));
    const webpageUrl = isYouTubeShort ? youtubeShortUrl(canonicalUrl) : canonicalUrl;
    if (!webpageUrl) return null;
    const title = metadataTitle(platform, meta);
    const duration = Number(meta.duration || 0);
    const views = typeof meta.view_count === 'number' ? compactNumber(meta.view_count) : platform;
    const tags = Array.isArray(meta.tags)
      ? meta.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 5)
      : [];
    return normalizeCrawledVideo({
      platform,
      title,
      sourceUrl: webpageUrl,
      thumbnailUrl: thumbnailForPlatform(platform, webpageUrl, firstImageUrl([meta.thumbnails, meta.thumbnail, meta])),
      duration,
      views,
      tags,
      uploadedAt: uploadedAtFromMeta(meta),
      sourceAccountUrl: metadataCreatorAccount(platform, meta),
      youtubeShort: isYouTubeShort || undefined,
    });
  };
}

export function normalizeCrawledVideo(item: CrawledVideo): CrawledVideo {
  const canonicalUrl = canonicalSourceUrl(item.platform, item.sourceUrl, item.author);
  const sourceUrl = item.platform === 'youtube' && (item.youtubeShort || /youtube\.com\/shorts\//i.test(item.sourceUrl))
    ? youtubeShortUrl(canonicalUrl)
    : canonicalUrl;
  return {
    ...item,
    sourceUrl,
    thumbnailUrl: thumbnailForPlatform(item.platform, sourceUrl, item.thumbnailUrl),
  };
}

export function thumbnailForPlatform(platform: Platform, sourceUrl: string, rawThumbnail: string): string {
  const thumbnail = normalizeThumbnailUrl(rawThumbnail);
  if (thumbnail) return thumbnail;
  if (platform === 'youtube') return youtubeThumbnailFromUrl(sourceUrl);
  return '';
}

export function softDownloadFailure(platform: Platform, error: unknown): { status: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  if (platform === 'instagram' && /cookies|login|empty media response|Unable to extract data/i.test(message)) {
    return { status: 'needs_cookies' };
  }
  if (platform === 'tiktok' && /private|embedding disabled|cookies|login/i.test(message)) {
    return { status: 'needs_cookies' };
  }
  return null;
}

export function isNonRetryableVideoFetch(platform: Platform, message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes('incomplete_gemini_video_analysis')) return true;
  if (lower.includes('yt-dlp did not produce an analysis video file')) return true;
  if (platform === 'youtube' && lower.includes('requested format is not available')) return true;
  if (platform === 'youtube' && lower.includes('sign in to confirm') && lower.includes('not a bot')) return true;
  return false;
}
