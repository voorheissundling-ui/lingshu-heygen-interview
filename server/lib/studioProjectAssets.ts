import path from 'node:path';
import { signAssetUrl } from './assetAccess.js';

const PROJECT_PRIVATE_ASSET_PATH = /^\/api\/overseas\/studio\/private-assets\/(tts|voice-samples|covers|exports)\/([^/?#]+)$/;

function decodedRenderFile(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === path.basename(decoded) && path.extname(decoded).toLowerCase() === '.mp4' ? decoded : '';
  } catch {
    return '';
  }
}

function mapStudioProjectPrivateAssetUrls(
  value: unknown,
  mapUrl: (namespace: string, file: string) => string,
  depth = 0,
): unknown {
  if (depth > 16) return value;
  if (typeof value === 'string') {
    try {
      const parsed = new URL(value, 'http://local');
      const renderMatch = parsed.pathname.match(/^\/api\/overseas\/(?:publishing\/local-videos|studio\/local-renders)\/([^/?#]+)$/);
      const renderFile = renderMatch ? decodedRenderFile(renderMatch[1]!) : '';
      if (renderFile && value.startsWith('/')) return mapUrl('local-renders', renderFile);
      const match = parsed.pathname.match(PROJECT_PRIVATE_ASSET_PATH);
      return match ? mapUrl(match[1]!, path.basename(match[2]!)) : value;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(item => mapStudioProjectPrivateAssetUrls(item, mapUrl, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, mapStudioProjectPrivateAssetUrls(item, mapUrl, depth + 1)]));
}

/** Persist stable private-asset references instead of short-lived signed URLs. */
export function studioProjectSpecForStorage(spec: unknown): Record<string, unknown> {
  const { _baseUpdatedAt, ...source } = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec as Record<string, unknown> : {};
  return mapStudioProjectPrivateAssetUrls(
    source,
    (namespace, file) => namespace === 'local-renders'
      ? `/api/overseas/studio/local-renders/${file}`
      : `/api/overseas/studio/private-assets/${namespace}/${file}`,
  ) as Record<string, unknown>;
}

/** Every project read receives fresh tenant-scoped media signatures. */
export function refreshStudioProjectAssetUrls(spec: unknown, tenantId: string): Record<string, unknown> {
  const source = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
  return mapStudioProjectPrivateAssetUrls(
    source,
    (namespace, file) => signAssetUrl(
      namespace === 'local-renders'
        ? `/api/overseas/studio/local-renders/${encodeURIComponent(path.basename(file))}`
        : `/api/overseas/studio/private-assets/${namespace}/${path.basename(file)}`,
      tenantId,
      namespace === 'local-renders' ? 24 * 60 * 60 * 1000 : undefined,
    ),
  ) as Record<string, unknown>;
}
