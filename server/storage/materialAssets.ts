import path from 'node:path';

export const MATERIAL_ASSET_PREFIX = 'materials/tenants';

export function materialAssetTenantKey(tenantId: string): string {
  return Buffer.from(String(tenantId), 'utf8').toString('base64url');
}

export function materialAssetObjectKey(tenantId: string, filename: string): string {
  return `${MATERIAL_ASSET_PREFIX}/${materialAssetTenantKey(tenantId)}/${path.basename(filename)}`;
}

/** Stable per-tenant key used to reuse identical uploads without exposing the
 * original filename. The digest is already computed by the streaming ingress. */
export function materialContentAddressedObjectKey(tenantId: string, sha256: string, filename: string): string {
  const digest = String(sha256).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('素材内容哈希无效');
  const extension = path.extname(filename).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin';
  return materialAssetObjectKey(tenantId, `${digest}${safeExtension}`);
}

export function materialPosterObjectKey(tenantId: string, sha256: string, filename: string): string {
  const digest = String(sha256).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('素材内容哈希无效');
  const extension = path.extname(filename).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.jpg';
  return tenantPrivateObjectKey('material-posters', tenantId, `${digest}${safeExtension}`);
}

export function isTenantPrivateObjectKey(objectKey: string, tenantId: string): boolean {
  const parts = String(objectKey).split('/');
  return parts.length === 4
    && /^[a-z0-9._-]+$/i.test(parts[0] || '')
    && parts[1] === 'tenants'
    && parts[2] === materialAssetTenantKey(tenantId)
    && Boolean(parts[3] && parts[3] !== '.' && parts[3] !== '..' && path.basename(parts[3]) === parts[3]);
}

export function tenantPrivateObjectKey(namespace: string, tenantId: string, filename: string): string {
  const safeNamespace = String(namespace).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'assets';
  return `${safeNamespace}/tenants/${materialAssetTenantKey(tenantId)}/${path.basename(filename)}`;
}

export function sharedObjectKey(namespace: string, filename: string): string {
  const safeNamespace = String(namespace).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'assets';
  return `${safeNamespace}/shared/${path.basename(filename)}`;
}

export function materialAssetObjectKeyFromTenantKey(tenantKey: string, filename: string): string {
  return `${MATERIAL_ASSET_PREFIX}/${path.basename(tenantKey)}/${path.basename(filename)}`;
}

export function materialAssetContentType(filename: string, supplied = ''): string {
  const normalized = supplied.trim().toLowerCase().split(';', 1)[0];
  if (normalized) return normalized;
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.m4a': return 'audio/mp4';
    default: return 'application/octet-stream';
  }
}

export function materialAssetTypeAllowed(contentType: string): boolean {
  const normalized = contentType.trim().toLowerCase().split(';', 1)[0];
  return normalized.startsWith('image/') || normalized.startsWith('video/') || normalized.startsWith('audio/');
}
