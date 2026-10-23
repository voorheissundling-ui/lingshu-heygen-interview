import type { Platform } from '../types/index.js';

const SUPPORTED_PLATFORMS: Platform[] = ['youtube', 'tiktok', 'instagram', 'facebook'];

function platformForHost(hostname: string): Platform | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'youtu.be' || host.endsWith('.youtu.be') || host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'facebook.com' || host.endsWith('.facebook.com')) return 'facebook';
  return null;
}

function youtubeId(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = url.pathname.split('/').filter(Boolean);
  const candidate = host === 'youtu.be' || host.endsWith('.youtu.be')
    ? path[0]
    : url.searchParams.get('v') || (['shorts', 'embed', 'live'].includes(path[0] || '') ? path[1] : '');
  return /^[a-zA-Z0-9_-]{6,20}$/.test(String(candidate || '')) ? String(candidate) : '';
}

function canonicalVideoUrl(url: URL, platform: Platform): string | null {
  if (platform === 'youtube') {
    const id = youtubeId(url);
    return id ? `https://www.youtube.com/watch?v=${id}` : null;
  }
  if (platform === 'tiktok') {
    const match = url.pathname.match(/^\/@([a-zA-Z0-9._-]+)\/video\/(\d+)/i);
    return match ? `https://www.tiktok.com/@${match[1]}/video/${match[2]}` : null;
  }
  if (platform === 'instagram') {
    const match = url.pathname.match(/^\/(reel|p|tv)\/([a-zA-Z0-9_-]+)/i);
    return match ? `https://www.instagram.com/${match[1].toLowerCase()}/${match[2]}/` : null;
  }
  const reel = url.pathname.match(/^\/reel\/(\d+)/i);
  if (reel) return `https://www.facebook.com/reel/${reel[1]}`;
  const queryId = url.searchParams.get('v');
  if (/^\d+$/.test(String(queryId || ''))) return `https://www.facebook.com/watch/?v=${encodeURIComponent(queryId!)}`;
  const video = url.pathname.match(/^\/[^/]+\/videos\/(?:[^/]+\/)?(\d+)/i);
  if (video) return `https://www.facebook.com/videos/${video[1]}`;
  return null;
}

export interface ValidatedPublicVideoSource {
  sourceUrl: string;
  platform: Platform;
}

/**
 * Accept only canonical public video pages on supported social platforms.
 * This is intentionally stricter than a generic URL check: these values are
 * later passed to network-capable downloaders and must never become an SSRF
 * primitive for localhost, cloud metadata services, or arbitrary hosts.
 */
export function validatePublicVideoSourceUrl(input: unknown, requestedPlatform?: unknown): ValidatedPublicVideoSource | null {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2_048) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return null;
  const platform = platformForHost(parsed.hostname);
  if (!platform) return null;
  if (requestedPlatform !== undefined && requestedPlatform !== null && requestedPlatform !== '') {
    if (!SUPPORTED_PLATFORMS.includes(requestedPlatform as Platform) || requestedPlatform !== platform) return null;
  }
  const sourceUrl = canonicalVideoUrl(parsed, platform);
  return sourceUrl ? { sourceUrl, platform } : null;
}

export function resolvePublicVideoSource(input: {
  recordSourceUrl?: unknown;
  recordPlatform?: unknown;
  requestedSourceUrl?: unknown;
  requestedPlatform?: unknown;
}): ValidatedPublicVideoSource | null {
  const recordUrl = String(input.recordSourceUrl || '').trim();
  if (recordUrl) {
    const authoritative = validatePublicVideoSourceUrl(recordUrl, input.recordPlatform);
    if (!authoritative) return null;
    const suppliedUrl = String(input.requestedSourceUrl || '').trim();
    if (!suppliedUrl) return authoritative;
    const supplied = validatePublicVideoSourceUrl(suppliedUrl, input.requestedPlatform || input.recordPlatform);
    // Record-scoped requests cannot replace a tenant-owned source URL.
    return supplied?.sourceUrl === authoritative.sourceUrl ? authoritative : null;
  }
  return validatePublicVideoSourceUrl(input.requestedSourceUrl, input.requestedPlatform);
}
