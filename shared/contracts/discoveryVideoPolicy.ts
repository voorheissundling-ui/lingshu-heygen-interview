export const DISCOVERY_VIDEO_MAX_DURATION_SECONDS = 60;

export type DiscoveryVideoPolicyInput = {
  platform?: string;
  duration?: number;
  sourceUrl?: string;
  youtubeShort?: boolean;
};

export function isKnownDiscoveryVideoDuration(duration: unknown): boolean {
  const seconds = Number(duration);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= DISCOVERY_VIDEO_MAX_DURATION_SECONDS;
}

export function isYouTubeShortUrl(sourceUrl: unknown): boolean {
  try {
    const url = new URL(String(sourceUrl || ''));
    return /(^|\.)youtube\.com$/i.test(url.hostname) && /^\/shorts\/[^/?#]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function youtubeShortUrl(sourceUrl: unknown): string {
  const raw = String(sourceUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const id = url.hostname.includes('youtu.be')
      ? url.pathname.replace(/^\//, '').split('/')[0]
      : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed)\/([^/?#]+)/i)?.[1] || '';
    return id ? `https://www.youtube.com/shorts/${id}` : raw;
  } catch {
    return raw;
  }
}

export function isDiscoveryVideoEligible(input: DiscoveryVideoPolicyInput): boolean {
  if (!isKnownDiscoveryVideoDuration(input.duration)) return false;
  if (String(input.platform || '').toLowerCase() !== 'youtube') return true;
  return input.youtubeShort === true || isYouTubeShortUrl(input.sourceUrl);
}
