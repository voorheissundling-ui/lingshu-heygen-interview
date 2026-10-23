/** Keep COS keys and signed supplier URLs out of browser render manifests. */
export function studioBgmMediaPath(track: { id: string; tenantId?: string; scope?: string } | null | undefined, tenantId: string): string | null {
  if (!track || !/^[\w-]{1,128}$/.test(track.id) || !/^[\w-]{1,128}$/.test(tenantId)) return null;
  if (track.tenantId && track.tenantId !== tenantId) return null;
  return `/api/overseas/studio/bgm/media/${track.id}`;
}

export function studioBgmObjectKey(track: { id: string; tenantId?: string; scope?: string; objectKey?: string } | null | undefined, tenantId: string): string | null {
  if (!studioBgmMediaPath(track, tenantId) || !track?.objectKey) return null;
  const key = track.objectKey;
  const encodedTenant = Buffer.from(tenantId, 'utf8').toString('base64url');
  const parent = track.scope === 'shared' && !track.tenantId ? 'shared' : `tenants/${encodedTenant}`;
  return new RegExp(`^bgm/${parent}/[\\w.-]+$`).test(key) ? key : null;
}
