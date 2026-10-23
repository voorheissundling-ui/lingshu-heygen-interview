import { createHash } from 'node:crypto';
import { verifyAssetToken } from './assetAccess.js';

export const MAX_STUDIO_RENDER_SHOTS = 60;
export const MAX_STUDIO_RENDER_SECONDS = 600;
export const MAX_STUDIO_RENDER_ASSET_BYTES = 100 * 1024 * 1024;
export const MAX_STUDIO_RENDER_TOTAL_BYTES = 1024 * 1024 * 1024;

export function studioRenderManifestHash(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest ?? null)).digest('hex');
}

function safePath(pathname: string, tenantId: string): boolean {
  const escaped = tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scoped = new RegExp(`^/(?:media|tts|covers|bgm)/tenants/${escaped}/[\\w.-]+(?:/[\\w.-]+){0,3}$`);
  const shared = /^\/(?:media|tts|covers|bgm)\/shared\/[\w.-]+$/;
  const legacy = /^\/(?:media|tts|covers|bgm)\/[\w.-]+$/;
  const privateAsset = /^\/api\/overseas\/studio\/private-assets\/(?:materials|tts|covers)\/[\w.-]+$/;
  const bgmMedia = /^\/api\/overseas\/studio\/bgm\/media\/[\w-]+$/;
  const cloudMaterial = /^\/api\/overseas\/studio\/materials\/pb\/[\w-]+\/(?:media|poster)$/;
  const cloudPlayback = /^\/studio-media\/[\w-]+\/(?:media\.mp4|poster\.jpg)$/;
  const signedCloudPlayback = /^\/studio-media\/[\w-]+\/signed\/[A-Za-z0-9_.-]+\/(?:media\.mp4|poster\.jpg)$/;
  return scoped.test(pathname) || shared.test(pathname) || legacy.test(pathname)
    || privateAsset.test(pathname) || bgmMedia.test(pathname) || cloudMaterial.test(pathname) || cloudPlayback.test(pathname) || signedCloudPlayback.test(pathname);
}

/** Only server-controlled media routes are eligible for web rendering. */
export function studioRenderAssetPath(value: unknown, tenantId: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('渲染素材地址无效');
  if (/%|\\|\.\./.test(value.split('?', 1)[0])) throw new Error('渲染素材必须来自当前租户的受控素材库');
  let parsed: URL;
  try { parsed = new URL(value, 'http://render.local'); } catch { throw new Error('渲染素材地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash
    || !safePath(parsed.pathname, tenantId) || /%|\\|\.\./.test(parsed.pathname)) {
    throw new Error('渲染素材必须来自当前租户的受控素材库');
  }
  // Absolute URLs may only be normalized by the caller after checking their original origin.
  if (parsed.searchParams.has('assetToken')) {
    const identity = verifyAssetToken(parsed.searchParams.get('assetToken'), parsed.pathname);
    if (!identity || identity.tenantId !== tenantId) throw new Error('渲染素材授权已失效或不属于当前租户');
  }
  const signedCloud = parsed.pathname.match(/^\/studio-media\/([\w-]+)\/signed\/([A-Za-z0-9_.-]+)\/(media\.mp4|poster\.jpg)$/);
  if (signedCloud) {
    const original = `/studio-media/${signedCloud[1]}/${signedCloud[3]}`;
    const identity = verifyAssetToken(signedCloud[2], original);
    if (!identity || identity.tenantId !== tenantId) throw new Error('渲染素材授权已失效或不属于当前租户');
    return `${original}${parsed.search}`;
  }
  return `${parsed.pathname}${parsed.search}`;
}

export function secureStudioRenderManifest<T extends Record<string, any>>(
  manifest: T, tenantId: string, issuedOrigin: string, internalOrigin: string,
): T {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.timeline)
    || manifest.timeline.length < 1 || manifest.timeline.length > MAX_STUDIO_RENDER_SHOTS) {
    throw new Error('分镜数量超出渲染限制');
  }
  const duration = Number(manifest.spec?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_STUDIO_RENDER_SECONDS) throw new Error('成片时长超出渲染限制');
  if (JSON.stringify(manifest).length > 256_000) throw new Error('渲染清单过大');
  const origin = new URL(issuedOrigin).origin;
  const asset = (value: unknown): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string') throw new Error('渲染素材地址无效');
    if (new URL(value, origin).origin !== origin) {
      throw new Error('渲染素材不能使用外部地址');
    }
    return `${internalOrigin}${studioRenderAssetPath(value, tenantId)}`;
  };
  let maxEnd = 0;
  const timeline = manifest.timeline.map((shot: any) => {
    const start = Number(shot.targetStart ?? 0);
    const end = Number(shot.targetEnd ?? (start + Number(shot.targetDuration ?? duration)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > MAX_STUDIO_RENDER_SECONDS + 1) {
      throw new Error('分镜时间范围无效');
    }
    maxEnd = Math.max(maxEnd, end);
    return { ...shot, url: asset(shot.url), productUrl: asset(shot.productUrl), backgroundUrl: asset(shot.backgroundUrl) };
  });
  if (maxEnd > MAX_STUDIO_RENDER_SECONDS) throw new Error('成片时长超出渲染限制');
  if (Array.isArray(manifest.subtitles?.cues) && manifest.subtitles.cues.length > 1500) throw new Error('字幕数量超出渲染限制');
  return {
    ...manifest,
    timeline,
    voiceover: manifest.voiceover ? { ...manifest.voiceover, url: asset(manifest.voiceover.url) } : manifest.voiceover,
    cover: manifest.cover ? { ...manifest.cover, url: asset(manifest.cover.url) } : manifest.cover,
    bgm: manifest.bgm ? { ...manifest.bgm, url: asset(manifest.bgm.url) } : manifest.bgm,
    requireVisualAssets: true,
  };
}
