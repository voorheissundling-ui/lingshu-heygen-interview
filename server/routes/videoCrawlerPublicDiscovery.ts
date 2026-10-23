import type { Platform } from '../types/index.js';
import { isDiscoveryVideoEligible, youtubeShortUrl } from '../../shared/contracts/discoveryVideoPolicy.js';
import { sourceAccountFromYouTubeRenderer } from './videoSourceIdentity.js';
import { looksLikeVideoUrl } from './videoCrawlerSourceUrls.js';
import { cleanSearchResultUrl, crawlFailureMessage, publicSearchQuery, youtubeHtmlSearchUrl } from './videoCrawlerPublicProjection.js';
import {
  decodeHtml, extractBestThumbnail, extractRunsText, extractYtInitialData, findObjectsByKey,
  isPlatformUrl, isWithinDateRange, parseDuration, textAt, type CrawledVideo,
} from './videoCrawlerNormalization.js';

type FlatSearch = (
  platform: Platform, searchUrl: string, keyword: string, limit: number,
  dateFrom?: string, dateTo?: string, youtubeShortsSource?: boolean,
) => Promise<CrawledVideo[]>;

/** Public search transport only; paid admission and stored record ownership remain with the route. */
export async function crawlYouTubePublicSearch(input: {
  keyword: string;
  limit: number;
  dateFrom?: string;
  dateTo?: string;
  crawlFlatSearch: FlatSearch;
  fetchPage?: typeof fetch;
}): Promise<CrawledVideo[]> {
  const { keyword, limit, dateFrom = '', dateTo = '', crawlFlatSearch, fetchPage = fetch } = input;
  const shortsUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}&sp=EgIYAQ%253D%253D`;
  let ytDlpFailure = '';
  try {
    const items = await crawlFlatSearch('youtube', shortsUrl, keyword, Math.max(limit * 3, limit), '', '', true);
    return items
      .filter(item => isWithinDateRange(item.uploadedAt, dateFrom, dateTo))
      .filter(item => isDiscoveryVideoEligible(item))
      .slice(0, limit);
  } catch (error) {
    ytDlpFailure = error instanceof Error ? error.message : String(error);
    console.warn('[videos] YouTube yt-dlp search failed, trying HTML search:', ytDlpFailure);
  }
  const { url, dateEvidence } = youtubeHtmlSearchUrl(keyword, dateFrom, dateTo);
  const response = await fetchPage(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) throw new Error(crawlFailureMessage('YouTube', [ytDlpFailure, `HTML search HTTP ${response.status}`], 'search returned no videos'));

  const html = await response.text();
  const data = extractYtInitialData(html);
  const renderers = findObjectsByKey(data, 'videoRenderer')
    .map(obj => obj.videoRenderer as Record<string, unknown>)
    .filter(Boolean);

  const seen = new Set<string>();
  const out: CrawledVideo[] = [];
  for (const renderer of renderers) {
    const videoId = textAt(renderer, ['videoId']);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);

    const title = extractRunsText(renderer.title) || extractRunsText(renderer.headline) || 'Untitled YouTube video';
    const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnailUrl = extractBestThumbnail(renderer.thumbnail);
    const durationLabel = extractRunsText(renderer.lengthText);
    const views = extractRunsText(renderer.viewCountText) || extractRunsText(renderer.shortViewCountText);

    out.push({
      platform: 'youtube',
      title,
      sourceUrl: youtubeShortUrl(sourceUrl),
      thumbnailUrl,
      duration: parseDuration(durationLabel),
      views,
      tags: keyword.split(/\s+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean).slice(0, 5),
      uploadedAt: undefined,
      dateEvidence,
      sourceAccountUrl: sourceAccountFromYouTubeRenderer(renderer) ?? undefined,
      youtubeShort: true,
    });
    if (out.length >= limit) break;
  }

  if (out.length === 0) throw new Error(crawlFailureMessage('YouTube', [ytDlpFailure, 'No videos parsed from HTML search results'], 'search returned no videos'));
  return out;
}

export async function fetchPublicText(url: string, timeoutMs: number, fetchPage: typeof fetch = fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchPage(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function searchPublicVideoUrlsByQuery(
  platform: Platform, query: string, limit: number,
  readText: (url: string, timeoutMs: number) => Promise<string> = fetchPublicText,
): Promise<string[]> {
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const xml = await readText(url, 20_000);
  const urls = new Set<string>();
  for (const raw of xml.matchAll(/<link>([^<]+)<\/link>/gi)) {
    const link = decodeHtml(raw[1] || '').trim();
    if (isPlatformUrl(link, platform) && looksLikeVideoUrl(link, platform)) urls.add(cleanSearchResultUrl(link));
  }
  for (const raw of xml.matchAll(/https?:\/\/[^"<\s]+/gi)) {
    const link = decodeHtml(raw[0] || '').trim();
    if (isPlatformUrl(link, platform) && looksLikeVideoUrl(link, platform)) urls.add(cleanSearchResultUrl(link));
  }
  return [...urls].slice(0, limit);
}

export function searchPublicVideoUrls(platform: Platform, keyword: string, limit: number): Promise<string[]> {
  return searchPublicVideoUrlsByQuery(platform, publicSearchQuery(platform, keyword), limit);
}
