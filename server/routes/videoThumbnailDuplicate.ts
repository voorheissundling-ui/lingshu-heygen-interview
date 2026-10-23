import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { DataStore } from '../storage/datastore.js';

export interface VideoThumbnailFingerprint {
  version: 'thumbnail-dhash-rgb-v1';
  contentSha256: string;
  dhash: string;
  rgb: string;
}
export interface VideoThumbnailInventoryItem {
  fingerprint: VideoThumbnailFingerprint;
  title: string;
  duration: number;
}

/** Restrict the extra pre-ingest fetch to known public platform image hosts. */
export function canFingerprintThumbnailUrl(platform: string, thumbnailUrl: string): boolean {
  let url: URL;
  try { url = new URL(thumbnailUrl); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const suffixes: Record<string, string[]> = {
    tiktok: ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com', 'byteimg.com'],
    facebook: ['fbcdn.net'],
    instagram: ['cdninstagram.com', 'fbcdn.net'],
    youtube: ['ytimg.com', 'ggpht.com'],
  };
  return (suffixes[platform.toLowerCase()] ?? []).some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

export async function fingerprintVideoThumbnail(bytes: Buffer): Promise<VideoThumbnailFingerprint> {
  const grey = await sharp(bytes).rotate().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  const rgb = await sharp(bytes).rotate().resize(4, 4, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (grey[y * 9 + x]! > grey[y * 9 + x + 1]! ? 1n : 0n);
  return { version: 'thumbnail-dhash-rgb-v1', contentSha256: createHash('sha256').update(bytes).digest('hex'), dhash: bits.toString(16).padStart(16, '0'), rgb: rgb.toString('hex') };
}

function titleSimilarity(a: string, b: string): number {
  const normalize = (value: string) => value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const left = normalize(a), right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (value: string) => new Set(Array.from({ length: Math.max(1, value.length - 2) }, (_, i) => value.slice(i, i + 3)));
  const aa = grams(left), bb = grams(right);
  const overlap = [...aa].filter(value => bb.has(value)).length;
  return overlap / (aa.size + bb.size - overlap);
}

/** Conservative: a matching poster alone never proves that two videos match. */
export function likelySameVideoThumbnail(a: VideoThumbnailInventoryItem, b: VideoThumbnailInventoryItem): boolean {
  if (a.fingerprint.version !== 'thumbnail-dhash-rgb-v1' || b.fingerprint.version !== 'thumbnail-dhash-rgb-v1') return false;
  if (!Number.isFinite(a.duration) || !Number.isFinite(b.duration) || Math.abs(a.duration - b.duration) > 2) return false;
  const title = titleSimilarity(a.title, b.title);
  if (title < 0.8) return false;
  // Flat template cards are common across distinct videos and are unsafe as
  // stand-alone visual identity evidence, even when their bytes are equal.
  const spread = (hex: string) => {
    const bytes = Buffer.from(hex, 'hex');
    if (bytes.length !== 48) return 0;
    let total = 0;
    for (let channel = 0; channel < 3; channel++) {
      const samples = Array.from({length:16},(_,i)=>bytes[i*3+channel]!);
      total += Math.max(...samples)-Math.min(...samples);
    }
    return total/3;
  };
  if (spread(a.fingerprint.rgb) < 16 || spread(b.fingerprint.rgb) < 16) return false;
  if (a.fingerprint.contentSha256 === b.fingerprint.contentSha256) return true;
  let bits = BigInt(`0x${a.fingerprint.dhash}`) ^ BigInt(`0x${b.fingerprint.dhash}`), distance = 0;
  while (bits) { distance += Number(bits & 1n); bits >>= 1n; }
  if (distance > 2 || title < 0.9) return false;
  const left = Buffer.from(a.fingerprint.rgb, 'hex'), right = Buffer.from(b.fingerprint.rgb, 'hex');
  if (left.length !== 48 || right.length !== 48) return false;
  let colorDifference = 0;
  for (let index = 0; index < left.length; index++) colorDifference += Math.abs(left[index]! - right[index]!);
  return colorDifference / left.length <= 8;
}

function parseFingerprint(value: unknown): VideoThumbnailFingerprint | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return record.version === 'thumbnail-dhash-rgb-v1' && typeof record.contentSha256 === 'string' && /^[a-f0-9]{64}$/.test(record.contentSha256)
    && typeof record.dhash === 'string' && /^[a-f0-9]{16}$/.test(record.dhash)
    && typeof record.rgb === 'string' && /^[a-f0-9]{96}$/.test(record.rgb)
    ? record as unknown as VideoThumbnailFingerprint : null;
}

/** Existing trend-video inventory is the only source; no parallel media catalog. */
export async function loadKnownVideoThumbnailFingerprints(dataStore: Pick<DataStore, 'list'>, tenantId: string): Promise<VideoThumbnailInventoryItem[]> {
  const known: VideoThumbnailInventoryItem[] = [];
  for (let page = 1;; page++) {
    const rows = await dataStore.list<Record<string, unknown>>('trend_videos', { where: { tenantId }, page, perPage: 200 });
    for (const row of rows.items) {
      let analysis: Record<string, unknown> = {};
      try { analysis = typeof row.aiAnalysis === 'string' ? JSON.parse(row.aiAnalysis) as Record<string, unknown> : row.aiAnalysis as Record<string, unknown> ?? {}; } catch { /* old records may not parse */ }
      const fingerprint = parseFingerprint(analysis?.thumbnailFingerprint);
      if (fingerprint) known.push({ fingerprint, title: String(row.title || ''), duration: Number(row.duration || 0) });
    }
    if (page >= rows.totalPages) break;
  }
  return known;
}
