import path from 'node:path';
import type { Platform } from '../types/index.js';
import { sourceAccountFromProviderMetadata, videoSourceIdentity } from './videoSourceIdentity.js';

export interface CrawledVideo {
  platform: Platform;
  title: string;
  sourceUrl: string;
  thumbnailUrl: string;
  duration: number;
  views: string;
  tags: string[];
  /** Public source post copy is evidence, not permission to republish. */
  caption?: string;
  uploadedAt?: string;
  dateEvidence?: string;
  author?: string;
  /** Account URL returned with this exact video, not inferred from its title. */
  sourceAccountUrl?: string;
  likes?: string;
  comments?: string;
  shares?: string;
  plays?: string;
  followers?: number;
  isAd?: boolean;
  isPaidPartnership?: boolean;
  source?: string;
  /** True only when YouTube supplied the candidate from its Shorts surface. */
  youtubeShort?: boolean;
}

export function apifyCandidateWindow(limit: number, platform: 'tiktok' | 'facebook', strictProviderLimit: boolean): number {
  if (strictProviderLimit) return Math.max(1, limit);
  return platform === 'tiktok' ? Math.max(limit * 5, 5) : Math.min(50, Math.max(limit * 4, limit, 10));
}

export function metadataUploader(meta: Record<string, unknown>): string {
  return String(meta.uploader_id || meta.uploader || meta.channel_id || meta.channel || '').trim();
}

export function metadataCreatorAccount(platform: Platform, meta: Record<string, unknown>): string | undefined {
  const candidates=[meta.channel_url,meta.uploader_url,meta.creator_url];
  if(platform==='youtube'&&/^UC[A-Za-z0-9_-]{20,}$/.test(String(meta.channel_id||'')))candidates.push(`https://www.youtube.com/channel/${meta.channel_id}`);
  if(platform==='instagram'&&/^[A-Za-z0-9._]{1,30}$/.test(String(meta.uploader_id||'')))candidates.push(`https://www.instagram.com/${meta.uploader_id}`);
  return candidates.map(value=>sourceAccountFromProviderMetadata(platform,String(value||''))).find(Boolean)??undefined;
}

export function metadataTitle(platform: Platform, meta: Record<string, unknown>): string {
  const rawTitle = String(meta.title || meta.fulltitle || '').trim();
  const description = String(meta.description || '').trim();
  const descriptionTitle = description.split(/\n+/).map(line => line.trim()).find(Boolean);
  if (descriptionTitle && (platform === 'instagram' || /^Video by /i.test(rawTitle))) return descriptionTitle.slice(0, 180);
  return rawTitle || descriptionTitle?.slice(0, 180) || `${platform} video`;
}

export function isGenericSocialTitle(title: string, platform: Platform): boolean {
  const normalized = normalizeSearchText(title);
  if (!normalized) return true;
  if (normalized === `${platform} video`) return true;
  if (platform === 'facebook' && /^(facebook|watch|reel|video)( video)?$/.test(normalized)) return true;
  if (platform === 'instagram' && /^(instagram|reel|post)( video)?$/.test(normalized)) return true;
  return /^video by /.test(normalized);
}

export function extractMeta(html: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1]
    || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, 'i'))?.[1]
    || '';
}

export function extractTitle(html: string): string {
  return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
}

export function extractFacebookViews(title: string): string {
  const decoded = decodeHtml(title);
  const zh = decoded.match(/([\d,.]+)\s*(万|亿)?\s*次播放/);
  if (zh) return `${zh[1]}${zh[2] ?? ''} 次播放`;
  return decoded.match(/([\d,.]+)\s*([MK])?\s*views/i)?.[0] || '';
}

export function cleanupFacebookTitle(title: string): string {
  return decodeHtml(title)
    .replace(/\s*\|\s*Facebook\s*$/i, '')
    .replace(/^[\d,.]+\s*(?:万|亿)?\s*次播放\s*[·・]\s*/i, '')
    .replace(/^[\d,.]+\s*(?:reactions?|个心情)\s*(?:[·・|]\s*)?/i, '')
    .trim() || 'Facebook video';
}

export function extractFacebookWatchUrls(html: string): string[] {
  const decoded = decodeHtml(html.replace(/\\\//g, '/').replace(/\\u0025/g, '%'));
  const urls = new Set<string>();
  for (const match of decoded.matchAll(/https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:watch|reel|[^"' <]+\/videos)[^"' <)]+/gi)) {
    urls.add(match[0].replace(/\\+$/, ''));
  }
  for (const match of decoded.matchAll(/\/(?:watch|reel)\/(?:\?v=)?([0-9]{8,})/gi)) {
    urls.add(`https://www.facebook.com/reel/${match[1]}/`);
  }
  return [...urls].filter(url => !url.includes('/watch/explore/')).slice(0, 30);
}

export function extractYtInitialData(html: string): unknown {
  const marker = 'ytInitialData';
  const idx = html.indexOf(marker);
  if (idx < 0) throw new Error('ytInitialData not found in YouTube page');
  const start = html.indexOf('{', idx);
  if (start < 0) throw new Error('ytInitialData JSON start not found');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('ytInitialData JSON end not found');
}

export function findObjectsByKey(input: unknown, key: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!input || typeof input !== 'object') return out;
  const obj = input as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj);
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach(v => findObjectsByKey(v, key, out));
    else if (value && typeof value === 'object') findObjectsByKey(value, key, out);
  }
  return out;
}

export function textAt(obj: Record<string, unknown>, path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : '';
}

export function extractRunsText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const obj = value as Record<string, unknown>;
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  if (Array.isArray(obj.runs)) {
    return obj.runs.map(run => {
      if (!run || typeof run !== 'object') return '';
      const text = (run as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    }).join('').trim();
  }
  return '';
}

export function extractBestThumbnail(value: unknown): string {
  if (!value) return '';
  const thumbs = Array.isArray(value) ? value : (typeof value === 'object' ? (value as Record<string, unknown>).thumbnails : null);
  if (!Array.isArray(thumbs)) return '';
  let best = '';
  let bestWidth = 0;
  for (const thumb of thumbs) {
    if (!thumb || typeof thumb !== 'object') continue;
    const obj = thumb as Record<string, unknown>;
    const url = typeof obj.url === 'string' ? obj.url : '';
    const width = typeof obj.width === 'number' ? obj.width : 0;
    if (url && width >= bestWidth) {
      best = url;
      bestWidth = width;
    }
  }
  return best;
}

export function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  return 'video/mp4';
}

export function safeVideoExtension(filename: string | undefined, mimeType: string): string {
  const ext = path.extname(filename || '').replace(/^\./, '').toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return ext;
  if (/webm/i.test(mimeType)) return 'webm';
  if (/quicktime|mov/i.test(mimeType)) return 'mov';
  if (/matroska|mkv/i.test(mimeType)) return 'mkv';
  return 'mp4';
}

export function parseDuration(label: string): number {
  const parts = label.split(':').map(n => Number(n));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

export function videoDedupeKey(item: CrawledVideo): string {
  if (item.sourceUrl.trim()) return videoSourceIdentity(item.platform, item.sourceUrl);
  return `${item.platform}:title:${item.title.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim()}`;
}

export function sortByHeat(items: CrawledVideo[]): CrawledVideo[] {
  return [...items].sort((a, b) => heatValue(b.views) - heatValue(a.views));
}

export function heatValue(views: string): number {
  const raw = String(views || '').toLowerCase().replace(/,/g, '');
  const n = Number(raw.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return 0;
  if (raw.includes('亿') || raw.includes('b')) return n * 100000000;
  if (raw.includes('万')) return n * 10000;
  if (raw.includes('m') || raw.includes('百万')) return n * 1000000;
  if (raw.includes('k') || raw.includes('千')) return n * 1000;
  return n;
}

export function ytdlpDateArgs(dateFrom = '', dateTo = ''): string[] {
  const args: string[] = [];
  const after = compactDate(dateFrom);
  const before = compactDate(dateTo);
  if (after) args.push('--dateafter', after);
  if (before) args.push('--datebefore', before);
  return args;
}

export function compactDate(input: string): string {
  const m = String(input || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

export function hasDateRange(dateFrom = '', dateTo = ''): boolean {
  return Boolean(compactDate(dateFrom) || compactDate(dateTo));
}

export function uploadedAtFromMeta(meta: Record<string, unknown>): string | undefined {
  const uploadDate = meta.upload_date ?? meta.release_date ?? meta.modified_date;
  const compact = String(uploadDate || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T00:00:00.000Z`;

  const timestamp = Number(meta.timestamp || meta.release_timestamp || meta.modified_timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return new Date(timestamp * 1000).toISOString();

  const iso = String(meta.uploaded_at || meta.created_at || meta.release_datetime || '').trim();
  if (iso) {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

export function filterDateRangeItems(items: CrawledVideo[], dateFrom = '', dateTo = ''): CrawledVideo[] {
  if (!hasDateRange(dateFrom, dateTo)) return items;
  return items.filter(item => item.dateEvidence === 'youtube-upload-filter' || isWithinDateRange(item.uploadedAt, dateFrom, dateTo));
}

export function isWithinDateRange(uploadedAt: string | undefined, dateFrom = '', dateTo = ''): boolean {
  if (!hasDateRange(dateFrom, dateTo)) return true;
  const uploaded = dateOnly(uploadedAt);
  if (!uploaded) return false;
  const from = compactDate(dateFrom);
  const to = compactDate(dateTo);
  return (!from || uploaded >= from) && (!to || uploaded <= to);
}

export function dateOnly(input: string | undefined): string {
  if (!input) return '';
  const compact = String(input).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}${compact[2]}${compact[3]}`;
  const dashed = String(input).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dashed) return `${dashed[1]}${dashed[2]}${dashed[3]}`;
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10).replace(/-/g, '');
}

export function filterRealMediaItems(items: CrawledVideo[]): CrawledVideo[] {
  return items.filter(hasRealThumbnail);
}

export function hasRealThumbnail(item: CrawledVideo): boolean {
  const thumbnail = item.thumbnailUrl.trim();
  return /^https?:\/\//i.test(thumbnail)
    || thumbnail.startsWith('/media/')
    || /^\/api\/overseas\/videos\/[^/]+\/thumbnail(?:\?|$)/.test(thumbnail);
}

export const PLATFORM_LABEL: Partial<Record<Platform, string>> = {
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  instagram: 'Instagram',
};

export function filterKeywordRelevantItems(items: CrawledVideo[], keyword: string): CrawledVideo[] {
  const terms = keywordSearchTerms(keyword);
  if (terms.length === 0) return items;
  return items.filter(item => isKeywordRelevant(item, keyword));
}

export function isKeywordRelevant(item: CrawledVideo, keyword: string): boolean {
  const terms = keywordSearchTerms(keyword);
  if (terms.length === 0) return true;
  const haystack = normalizeSearchText(`${item.title} ${item.tags.join(' ')}`);
  const requiredGroups = keywordRequiredTermGroups(keyword);
  if (requiredGroups.length > 1) {
    return requiredGroups.every(group => group.some(term => hasSearchTerm(haystack, term)));
  }
  return terms.some(term => hasSearchTerm(haystack, term));
}

export function keywordSearchTerms(keyword: string): string[] {
  const normalized = normalizeSearchText(keyword);
  if (!normalized || /^https?:\/\//i.test(keyword.trim())) return [];
  const words = normalized.split(/\s+/).filter(Boolean);
  const terms = new Set(words);

  const specificAliasGroups: string[][] = [
    ['mask', 'face mask', 'facial mask', 'sheet mask', 'clay mask', 'masque', '面膜'],
  ];
  for (const group of specificAliasGroups) {
    if (group.some(alias => hasSearchTerm(normalized, normalizeSearchText(alias)))) {
      group.forEach(alias => terms.add(normalizeSearchText(alias)));
    }
  }

  const aliasGroups: string[][] = [
    ['skincare', 'skin care', 'skin', 'sunscreen', 'serum', 'moisturizer', 'cleanser', 'toner', 'pore', 'acne', 'anti aging', 'beauty', 'routine', '护肤', '保养', '防晒', '精华', '面霜', '洁面', '爽肤', '毛孔', '痘', '美白', '抗老', '皮肤'],
    ['makeup', 'cosmetic', 'cosmetics', 'beauty', 'lipstick', 'foundation', 'mascara', 'blush', 'concealer', 'eyeliner', '美妆', '彩妆', '化妆', '口红', '粉底', '睫毛', '腮红', '遮瑕'],
    ['haircare', 'hair care', 'hair', 'shampoo', 'conditioner', 'scalp', 'hairstyle', '护发', '洗发', '头发', '发型', '头皮'],
  ];
  for (const group of aliasGroups) {
    if (group.some(alias => normalized.includes(normalizeSearchText(alias)))) {
      group.forEach(alias => terms.add(normalizeSearchText(alias)));
    }
  }

  return [...terms].filter(term => term.length >= 2);
}

export function keywordRequiredTermGroups(keyword: string): string[][] {
  const normalized = normalizeSearchText(keyword);
  if (!normalized || /^https?:\/\//i.test(keyword.trim())) return [];
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [];
  return words
    .map(word => {
      const aliases = new Set<string>([word]);
      if (word === 'clean') ['cleanse', 'cleanser', 'cleansing', 'cleaning'].forEach(alias => aliases.add(alias));
      if (word === 'mask') ['face mask', 'facial mask', 'sheet mask', 'clay mask', 'masque', 'masking', '面膜'].forEach(alias => aliases.add(alias));
      if (word === 'skin') ['skincare', 'skin care'].forEach(alias => aliases.add(alias));
      if (word === 'review') ['reviews', 'tested', 'testing', 'try', 'tried'].forEach(alias => aliases.add(alias));
      if (word === 'gadget') ['gadgets'].forEach(alias => aliases.add(alias));
      if (word === 'product') ['products'].forEach(alias => aliases.add(alias));
      return [...aliases].map(normalizeSearchText).filter(term => term.length >= 2);
    })
    .filter(group => group.length > 0);
}

export function keywordCategory(keyword: string): 'skincare' | 'makeup' | 'haircare' | 'general' {
  const normalized = normalizeSearchText(keyword);
  const hasAny = (terms: string[]) => terms.some(term => normalized.includes(normalizeSearchText(term)));
  if (hasAny(['skincare', 'skin care', 'skin', 'sunscreen', 'serum', 'moisturizer', 'cleanser', 'toner', 'pore', 'acne', 'retinol', 'glycolic', 'niacinamide', 'cerave', 'the ordinary', 'derm', 'mask', 'face mask', 'facial mask', 'sheet mask', 'clay mask', 'masque', '护肤', '保养', '防晒', '精华', '面霜', '洁面', '爽肤', '毛孔', '抗老', '皮肤', '面膜'])) return 'skincare';
  if (hasAny(['makeup', 'cosmetic', 'cosmetics', 'lipstick', 'foundation', 'mascara', 'blush', 'concealer', 'eyeliner', '美妆', '彩妆', '化妆', '口红', '粉底', '睫毛', '腮红', '遮瑕'])) return 'makeup';
  if (hasAny(['haircare', 'hair care', 'hair', 'shampoo', 'conditioner', 'scalp', 'hairstyle', '护发', '洗发', '头发', '发型', '头皮'])) return 'haircare';
  return 'general';
}

export function normalizeSearchText(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasSearchTerm(haystack: string, term: string): boolean {
  if (!term) return false;
  if (/[\u4e00-\u9fff]/.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`, 'i').test(haystack);
}

export function mergeExistingTags(existingRaw: unknown, nextTags: string[], keyword: string, platform: Platform): string[] {
  const existing = parseJsonRecord<string[]>(existingRaw, []);
  if (existing.length > 0) return existing;
  const keywordTags = tagsFromKeyword(keyword, platform);
  const nextKey = JSON.stringify([...nextTags].sort());
  const keywordKey = JSON.stringify([...keywordTags].sort());
  return nextKey === keywordKey ? [] : nextTags;
}

export function tagsFromKeyword(keyword: string, platform?: Platform): string[] {
  if (/^https?:\/\//i.test(keyword.trim())) return [platform ?? inferPlatformFromUrl(keyword), 'video'].filter(Boolean).slice(0, 5);
  return keyword.split(/\s+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean).slice(0, 5);
}

export function isPlatformUrl(input: string, platform: Platform): boolean {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const host = new URL(trimmed).hostname;
  if (platform === 'tiktok') return /(?:^|\.)tiktok\.com$/i.test(host);
  if (platform === 'instagram') return /(?:^|\.)instagram\.com$/i.test(host);
  if (platform === 'facebook') return /(?:^|\.)facebook\.com$/i.test(host);
  if (platform === 'linkedin') return /(?:^|\.)linkedin\.com$/i.test(host);
  if (platform === 'youtube') return /(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/i.test(host);
  return false;
}

export function inferPlatformFromUrl(input: string): Platform {
  try {
    const host = new URL(input).hostname;
    if (/tiktok\.com$/i.test(host)) return 'tiktok';
    if (/instagram\.com$/i.test(host)) return 'instagram';
    if (/facebook\.com$/i.test(host)) return 'facebook';
    if (/(?:^|\.)linkedin\.com$/i.test(host)) return 'linkedin';
    if (/youtu\.be$|youtube\.com$/i.test(host)) return 'youtube';
  } catch { /* ignore */ }
  return 'tiktok';
}

export function parseJsonRecord<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === 'string' ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function safeMaterialName(title: string, platform: Platform): string {
  const base = title.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || `${platform}-video`;
  return `爆款·${PLATFORM_LABEL[platform] ?? platform}·${base}.mp4`;
}

export function decodeHtml(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number(num)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}
