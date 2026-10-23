/** Metadata-only identity check. It does not download media or call an LLM. */
import type {DataStore} from '../storage/datastore.js';
import {createHash} from 'node:crypto';

export function videoSourceIdentity(platform: string, sourceUrl: string): string {
  const normalizedPlatform = platform.trim().toLowerCase();
  let url: URL;
  try { url = new URL(sourceUrl); } catch { return `${normalizedPlatform}:url:${sourceUrl.trim().toLowerCase()}`; }
  const path = url.pathname.replace(/\/+$/, '');
  const id = normalizedPlatform === 'youtube'
    ? url.searchParams.get('v') || path.match(/^\/(?:shorts|embed|live)\/([^/]+)/i)?.[1] || (/(?:^|\.)youtu\.be$/i.test(url.hostname) ? path.slice(1) : '')
    : normalizedPlatform === 'tiktok' ? path.match(/\/video\/(\d+)/i)?.[1]
      : normalizedPlatform === 'instagram' ? path.match(/^\/(?:reel|p|tv)\/([^/]+)/i)?.[1]
        : normalizedPlatform === 'facebook' ? path.match(/\/(?:reel|videos)\/(\d+)/i)?.[1] || url.searchParams.get('v')
          : normalizedPlatform === 'linkedin' ? path.match(/activity[:-](\d+)/i)?.[1] || path.match(/\/posts\/[^/]*?(\d{8,})/i)?.[1]
            : null;
  // YouTube IDs and Instagram shortcodes are case-sensitive.
  if (id) return `${normalizedPlatform}:id:${id}`;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|igshid$|si$)/i.test(key)) url.searchParams.delete(key);
  return `${normalizedPlatform}:url:${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`.toLowerCase();
}

export function discoveryVideoRecordId(tenantId: string, platform: string, sourceUrl: string): string {
  return createHash('sha256').update(JSON.stringify([tenantId, videoSourceIdentity(platform, sourceUrl)])).digest('hex').slice(0, 15);
}

/** Only return a creator URL when the canonical video URL itself proves it. */
export function sourceAccountFromVideoUrl(platform: string, sourceUrl: string): string | null {
  if (platform.trim().toLowerCase() !== 'tiktok') return null;
  let url: URL;
  try { url = new URL(sourceUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !/(^|\.)tiktok\.com$/i.test(url.hostname)) return null;
  const handle = url.pathname.match(/^\/(\@[A-Za-z0-9._-]+)\/video\/\d+(?:\/|$)/)?.[1];
  return handle ? `https://www.tiktok.com/${handle}` : null;
}

/** Normalize a creator URL supplied with this video by the crawler/provider.
 * A bare display name is never sufficient account evidence. */
export function sourceAccountFromProviderMetadata(platform: string, value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./,'');
  const path = url.pathname.replace(/\/+$/,'');
  if (platform === 'tiktok' && host === 'tiktok.com') {
    const handle = path.match(/^\/@[A-Za-z0-9._-]{2,100}$/)?.[0];
    return handle ? `https://www.tiktok.com${handle}` : null;
  }
  if (platform === 'instagram' && host === 'instagram.com') {
    const handle = path.match(/^\/([A-Za-z0-9._]{1,30})$/)?.[1];
    return handle && !['reel','p','tv','explore','stories'].includes(handle.toLowerCase()) ? `https://www.instagram.com/${handle}` : null;
  }
  if (platform === 'youtube' && host === 'youtube.com') {
    if (/^\/channel\/UC[A-Za-z0-9_-]{20,}$/.test(path) || /^\/@[A-Za-z0-9._-]{2,100}$/.test(path)
      || /^\/(?:user|c)\/[A-Za-z0-9._-]{2,100}$/.test(path)) return `https://www.youtube.com${path}`;
  }
  if (platform === 'facebook' && ['facebook.com','m.facebook.com','mbasic.facebook.com'].includes(host)) {
    if (/^\/[A-Za-z0-9._-]{2,100}$/.test(path) && !/^\/(?:reel|watch|videos|groups|share|posts|photo)$/i.test(path)) return `https://www.facebook.com${path}`;
    const profileId = path === '/profile.php' ? url.searchParams.get('id') : null;
    if (profileId && /^\d{5,}$/.test(profileId)) return `https://www.facebook.com/profile.php?id=${profileId}`;
  }
  if (platform === 'linkedin' && host === 'linkedin.com') {
    const company = path.match(/^\/company\/([A-Za-z0-9._-]{2,120})$/)?.[1];
    return company ? `https://www.linkedin.com/company/${company}` : null;
  }
  return null;
}

export function sourceAccountFromYouTubeRenderer(renderer: Record<string, unknown>): string | null {
  const owner = renderer.ownerText && typeof renderer.ownerText === 'object' ? renderer.ownerText as Record<string, unknown> : {};
  const runs = Array.isArray(owner.runs) ? owner.runs : [];
  for (const value of runs) {
    const run = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const nav = run.navigationEndpoint && typeof run.navigationEndpoint === 'object' ? run.navigationEndpoint as Record<string, unknown> : {};
    const browse = nav.browseEndpoint && typeof nav.browseEndpoint === 'object' ? nav.browseEndpoint as Record<string, unknown> : {};
    const canonical = String(browse.canonicalBaseUrl || '');
    const id = String(browse.browseId || '');
    const url = canonical ? `https://www.youtube.com${canonical}` : /^UC[A-Za-z0-9_-]{20,}$/.test(id) ? `https://www.youtube.com/channel/${id}` : '';
    const account = sourceAccountFromProviderMetadata('youtube',url);
    if (account) return account;
  }
  return null;
}

/** Read the complete tenant video inventory before admitting new discovery rows. */
export async function loadKnownVideoSourceIdentities(dataStore: Pick<DataStore, 'list'>, collection: string, tenantId: string): Promise<Set<string>> {
  const known = new Set<string>();
  for (let page = 1;; page++) {
    const existing = await dataStore.list<Record<string, unknown>>(collection, { where: { tenantId }, page, perPage: 200 });
    for (const row of existing.items) {
      const url = String(row.sourceUrl || '');
      if (!url) continue;
      const platform = String(row.platform || (/linkedin/i.test(url) ? 'linkedin' : /tiktok/i.test(url) ? 'tiktok' : /instagram/i.test(url) ? 'instagram' : /facebook|fb\.watch/i.test(url) ? 'facebook' : /youtube|youtu\.be/i.test(url) ? 'youtube' : ''));
      known.add(videoSourceIdentity(platform, url));
    }
    if (page >= existing.totalPages) break;
  }
  return known;
}
