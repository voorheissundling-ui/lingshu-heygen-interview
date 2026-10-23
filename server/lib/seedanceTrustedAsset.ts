
export type SeedanceTrustedAssetKind = 'image' | 'video';
export type SeedanceTrustedAsset = {
  uri: string;
  kind: SeedanceTrustedAssetKind;
  status: 'active';
  provider: 'volcengine_ark';
};

const ASSET_URI = /^asset:\/\/asset-[a-z0-9-]+$/i;

/**
 * Normalizes a provider-issued asset URI. A material-library id or an arbitrary
 * `asset://` string is never enough: callers must retain the media kind returned
 * by the provider, otherwise a video asset can accidentally be submitted as an
 * image first frame.
 */
export function normalizeSeedanceTrustedAsset(input: unknown): SeedanceTrustedAsset | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const uri = String(value.uri || '').trim();
  const kind = String(value.kind || '').trim().toLowerCase();
  const status = String(value.status || '').trim().toLowerCase();
  const provider = String(value.provider || '').trim().toLowerCase();
  if (!ASSET_URI.test(uri) || (kind !== 'image' && kind !== 'video') || status !== 'active' || provider !== 'volcengine_ark') return undefined;
  return { uri, kind, status: 'active', provider: 'volcengine_ark' };
}

/** Reads the persisted contract while allowing the initial flat field migration. */
export function hasSeedanceTrustedAssetMetadata(material: Record<string, unknown>): boolean {
  return Boolean(material.seedanceTrustedAsset || material.seedanceTrustedAssetUri || material.seedanceTrustedAssetKind || material.seedanceTrustedAssetStatus || material.seedanceTrustedAssetProvider);
}

export function seedanceTrustedAssetForMaterial(material: { type?: unknown } & Record<string, unknown>): SeedanceTrustedAsset | undefined {
  const nested = normalizeSeedanceTrustedAsset(material.seedanceTrustedAsset);
  const asset = nested || normalizeSeedanceTrustedAsset({
    uri: material.seedanceTrustedAssetUri,
    kind: material.seedanceTrustedAssetKind,
    status: material.seedanceTrustedAssetStatus,
    provider: material.seedanceTrustedAssetProvider,
  });
  // The material record remains the source of truth for its media kind. Do not
  // let a stale provider mapping turn a video material into an image first frame.
  return asset && String(material.type) === asset.kind ? asset : undefined;
}

export function seedanceImageFirstFrameInput(asset: SeedanceTrustedAsset): { url: string; kind: 'image' } {
  if (asset.kind !== 'image') throw new Error('Seedance 逐句首帧必须绑定状态为 Active 的图片型可信资产；视频型可信资产只能用于视频参考，不能作为 image_url 首帧');
  return { url: asset.uri, kind: 'image' };
}

export function isSeedanceTrustedAssetUri(value: string): boolean {
  return ASSET_URI.test(String(value || '').trim());
}
