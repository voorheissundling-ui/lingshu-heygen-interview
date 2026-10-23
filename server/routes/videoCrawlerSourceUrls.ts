import type { Platform } from '../types/index.js';
import { isPlatformUrl } from './videoCrawlerNormalization.js';

export function tiktokVideoId(url: string): string {
  return String(url || '').match(/\/video\/(\d{8,})/i)?.[1]
    || String(url || '').match(/[?&](?:item_id|video_id|aweme_id)=(\d{8,})/i)?.[1]
    || '';
}

export function cleanTikTokUsername(input: string): string {
  return String(input || '').replace(/^@/, '').trim().replace(/[^\w.-]/g, '');
}

export function tiktokUsername(url: string): string {
  return cleanTikTokUsername(String(url || '').match(/tiktok\.com\/@([^/?#]+)/i)?.[1] || '');
}

export function canonicalSourceUrl(platform: Platform, rawUrl: string, author?: string): string {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  if (platform === 'youtube') {
    const id = youtubeVideoId(url);
    return id ? `https://www.youtube.com/watch?v=${id}` : stripTrackingParams(url);
  }
  if (platform === 'tiktok') {
    const id = tiktokVideoId(url);
    if (!id) return stripTrackingParams(url);
    const username = tiktokUsername(url) || cleanTikTokUsername(author || '');
    return username ? `https://www.tiktok.com/@${username}/video/${id}` : stripTrackingParams(url);
  }
  return stripTrackingParams(url);
}

export function youtubeVideoId(url: string): string {
  const trimmed = String(url || '').trim();
  // Flat playlists may return a bare 11-character video ID.
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.replace(/^\//, '');
    return parsed.searchParams.get('v') || parsed.pathname.match(/\/(?:shorts|embed)\/([^/?#]+)/)?.[1] || '';
  } catch {
    return trimmed.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{6,})/)?.[1] || '';
  }
}

export function looksLikeVideoUrl(url: string, platform: Platform): boolean {
  if (platform === 'tiktok') return /\/video\/\d+/i.test(url);
  if (platform === 'instagram') return /\/(?:reel|p)\//i.test(url);
  if (platform === 'facebook') return /\/(?:reel|watch|videos)\b/i.test(url) || /[?&]v=\d+/i.test(url);
  if (platform === 'linkedin') return /\/(?:posts|feed\/update)\//i.test(url) || /activity[:-]\d+/i.test(url);
  return true;
}

/** Account homepage, not a single content URL or a lookalike host. */
export function looksLikeAccountUrl(input: string, platform: Platform): boolean {
  const url = String(input || '').trim();
  if (!isPlatformUrl(url, platform)) return false;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);
    if (platform === 'youtube') {
      if (youtubeVideoId(url)) return false;
      return /\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/i.test(path);
    }
    if (platform === 'tiktok') return /\/@[^/?#]+/i.test(path) && !/\/video\/\d+/i.test(path);
    if (platform === 'instagram') {
      if (looksLikeVideoUrl(url, 'instagram')) return false;
      const first = segments[0] || '';
      return Boolean(first) && !['accounts', 'explore', 'reel', 'reels', 'p', 'stories', 'tv', 'direct'].includes(first.toLowerCase());
    }
    if (platform === 'facebook') {
      if (looksLikeVideoUrl(url, 'facebook')) return false;
      const first = segments[0] || '';
      return Boolean(first) && !['watch', 'reel', 'reels', 'videos', 'groups', 'events', 'marketplace', 'share'].includes(first.toLowerCase());
    }
    if (platform === 'linkedin') return segments[0]?.toLowerCase() === 'company' && Boolean(segments[1]);
  } catch { return false; }
  return false;
}

export function accountLabelFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const handle = path.match(/\/(@[^/?#]+)/)?.[1]
      || path.match(/\/(?:channel|c|user)\/([^/?#]+)/i)?.[1]
      || path.split('/').filter(Boolean).pop();
    return handle ? decodeURIComponent(handle) : url;
  } catch { return url; }
}

export function stripTrackingParams(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['si', 'feature', 'fbclid', 'gclid'].includes(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    return parsed.toString();
  } catch { return rawUrl; }
}

export function normalizeAccountListUrl(platform: Platform, url: string): string {
  const clean = stripTrackingParams(String(url || '').trim()).replace(/\/+$/, '');
  if (platform === 'youtube') {
    const base = clean.replace(/\/(?:videos|shorts|streams|featured)$/i, '');
    return `${base}/shorts`;
  }
  if (platform === 'instagram') {
    if (/\/(?:reels|reels\/|tagged)$/i.test(clean)) return clean;
    return `${clean}/reels`;
  }
  if (platform === 'facebook') {
    if (/\/(?:videos|reels)$/i.test(clean)) return clean;
    return `${clean}/videos`;
  }
  return clean;
}

export function accountListUrlCandidates(platform: Platform, url: string): string[] {
  const primary = normalizeAccountListUrl(platform, url);
  if (platform !== 'youtube') return [primary];
  const clean = stripTrackingParams(String(url || '').trim()).replace(/\/+$/, '');
  const base = clean.replace(/\/(?:videos|shorts|streams|featured)$/i, '');
  return Array.from(new Set([primary, `${base}/shorts`]));
}

export function youtubeThumbnailFromUrl(url: string): string {
  const id = youtubeVideoId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}
