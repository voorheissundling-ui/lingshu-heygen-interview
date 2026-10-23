import fs from 'node:fs';
import path from 'node:path';
import type { Platform } from '../types/index.js';
import { attachFile } from '../storage/files.js';
import { store } from '../storage/index.js';
import { decodeHtml, parseJsonRecord } from './videoCrawlerNormalization.js';
import { tiktokVideoId, youtubeThumbnailFromUrl } from './videoCrawlerSourceUrls.js';

export function signedThumbnailExpiry(url: string): number | null {
  const x = /[?&]x-expires?=(\d+)/i.exec(url);
  if (x) {
    const ts = Number(x[1]);
    return Number.isFinite(ts) ? ts * 1000 : null;
  }
  if (/\bfbcdn\.net\/|\bcdninstagram\.com\//i.test(url)) {
    const oe = /[?&]oe=([0-9A-Fa-f]{6,12})(?:&|$)/.exec(url);
    if (oe) {
      const ts = parseInt(oe[1], 16);
      return Number.isFinite(ts) ? ts * 1000 : null;
    }
  }
  return null;
}

export function isSignedExpiringThumbnail(url: string): boolean {
  return /^https?:\/\//i.test(url) && signedThumbnailExpiry(url) !== null;
}

export function isExpiredSignedThumbnail(url: string): boolean {
  const exp = signedThumbnailExpiry(url);
  return exp !== null && exp < Date.now() + 60_000;
}

/** Stable app URL bound to the crawler record, not a local checkout path. */
export function recordThumbnailUrl(recordId: string): string {
  return `/api/overseas/videos/${recordId}/thumbnail`;
}

export async function fetchThumbnailBuffer(url: string, timeoutMs = 20_000, noRedirect = false): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: noRedirect ? 'error' : 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!resp.ok) return null;
    const type = resp.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    if (Number(resp.headers.get('content-length') || 0) > 5 * 1024 * 1024) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > 5 * 1024 * 1024) return null;
    return { buf, contentType: type };
  } catch {
    return null;
  }
}

export async function publicSourceThumbnail(record: Record<string, unknown>): Promise<string> {
  const sourceUrl = String(record.sourceUrl || '').trim();
  const platform = String(record.platform || '') as Platform;
  if (!sourceUrl) return '';
  if (platform === 'youtube') return youtubeThumbnailFromUrl(sourceUrl);
  if (platform === 'instagram' && /\/(?:p|reel|tv)\//i.test(sourceUrl)) return `${sourceUrl.replace(/[?#].*$/, '').replace(/\/$/, '')}/media/?size=l`;
  if (platform !== 'tiktok' || !tiktokVideoId(sourceUrl)) return '';
  try {
    const response = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(sourceUrl)}`, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    });
    if (response.ok) {
      const payload = await response.json() as { thumbnail_url?: string };
      if (/^https?:\/\//i.test(String(payload.thumbnail_url || ''))) return String(payload.thumbnail_url);
    }
  } catch {
    // Public oEmbed may rate-limit; the public page can still carry its cover.
  }
  try {
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(12_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36', 'Accept': 'text/html' },
    });
    if (!response.ok) return '';
    const html = await response.text();
    const encoded = html.match(/<link[^>]+href=["']([^"']+)["'][^>]+data-source=["']ssr-cover-preload["']/i)?.[1]
      || html.match(/<link[^>]+data-source=["']ssr-cover-preload["'][^>]+href=["']([^"']+)["']/i)?.[1]
      || '';
    const cover = decodeHtml(encoded);
    return /^https?:\/\//i.test(cover) ? cover : '';
  } catch {
    return '';
  }
}

export function createVideoThumbnailPersistence(input: {
  collection: string;
  mediaDir: string;
  uploadObject: (recordId: string, role: string, body: Buffer, contentType: string) => Promise<string>;
  dataStore?: typeof store;
  attachFile?: typeof attachFile;
}) {
  const dataStore = input.dataStore || store;
  const attachFileRecord = input.attachFile || attachFile;
  const isMissingLocalThumbnail = (url: string): boolean => {
    if (!url.startsWith('/media/')) return false;
    return !fs.existsSync(path.join(input.mediaDir, path.basename(url)));
  };

  const storeThumbnailBuffer = async (recordId: string, buf: Buffer, contentType: string): Promise<string | null> => {
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    try {
      const key = await input.uploadObject(recordId, 'thumbnail', buf, contentType);
      const record = await dataStore.getById<Record<string, unknown>>(input.collection, recordId);
      const analysis = parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {});
      await dataStore.update(input.collection, recordId, {
        aiAnalysis: JSON.stringify({ ...analysis, thumbnailStorage: 'cos', thumbnailObjectKey: key, thumbnailExtension: ext }),
      });
      return recordThumbnailUrl(recordId);
    } catch (error) {
      console.warn('[videos] COS thumbnail persistence failed:', error instanceof Error ? error.message : error);
      try {
        const thumbnailFile = await attachFileRecord(input.collection, recordId, 'thumbnailFile', {
          name: `${recordId}-thumbnail.${ext}`,
          buf,
          contentType,
        });
        if (!thumbnailFile) return null;
        const record = await dataStore.getById<Record<string, unknown>>(input.collection, recordId);
        const analysis = parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {});
        const { thumbnailObjectKey: _staleThumbnailObjectKey, ...restAnalysis } = analysis;
        await dataStore.update(input.collection, recordId, {
          thumbnailFile,
          thumbnailUrl: recordThumbnailUrl(recordId),
          aiAnalysis: JSON.stringify({ ...restAnalysis, thumbnailStorage: 'record_file', thumbnailExtension: ext }),
        });
        return recordThumbnailUrl(recordId);
      } catch (fallbackError) {
        console.warn('[videos] record thumbnail persistence failed:', fallbackError instanceof Error ? fallbackError.message : fallbackError);
        return null;
      }
    }
  };

  const cacheThumbnailLocally = async (recordId: string, url: string): Promise<string | null> => {
    const image = await fetchThumbnailBuffer(url);
    if (!image) return null;
    return storeThumbnailBuffer(recordId, image.buf, image.contentType);
  };

  const persistThumbnailIfExpiring = async (recordId: string, url: string): Promise<void> => {
    if (!/^https?:\/\//i.test(url)) return;
    const local = await cacheThumbnailLocally(recordId, url);
    if (local) await dataStore.update(input.collection, recordId, { thumbnailUrl: local });
  };

  return { isMissingLocalThumbnail, cacheThumbnailLocally, storeThumbnailBuffer, persistThumbnailIfExpiring };
}
