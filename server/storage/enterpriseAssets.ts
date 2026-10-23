import path from 'node:path';

export const ENTERPRISE_ASSET_PREFIX = 'enterprise-assets/tenants';

export function enterpriseAssetTenantKey(tenantId: string): string {
  return Buffer.from(tenantId, 'utf8').toString('base64url');
}

export function enterpriseAssetObjectKey(tenantId: string, filename: string): string {
  return `${ENTERPRISE_ASSET_PREFIX}/${enterpriseAssetTenantKey(tenantId)}/${path.basename(filename)}`;
}

export function enterpriseAssetObjectKeyFromTenantKey(tenantKey: string, filename: string): string {
  return `${ENTERPRISE_ASSET_PREFIX}/${path.basename(tenantKey)}/${path.basename(filename)}`;
}

export function enterpriseAssetContentType(filename: string, supplied = ''): string {
  const normalized = supplied.trim().toLowerCase();
  if (normalized) return normalized;
  switch (path.extname(filename).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

export function enterpriseAssetTypeAllowed(contentType: string): boolean {
  const normalized = contentType.trim().toLowerCase().split(';', 1)[0];
  return normalized.startsWith('image/')
    || normalized.startsWith('video/')
    || normalized === 'application/pdf';
}
