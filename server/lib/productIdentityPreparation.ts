import sharp from 'sharp';
import type { StoryboardShotSpec } from '../../shared/storyboardShotSpec.js';
import type { ProductIdentityCompositeInput } from './productIdentityLayer.js';

/** A source image qualifies only when a real, nonempty transparent cutout is present. */
export async function verifiedTransparentCutoutGeometry(bytes: Buffer): Promise<{ aspectRatio: number } | null> {
  try {
    const metadata = await sharp(bytes).metadata();
    if (!metadata.hasAlpha || !metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) return null;
    const alpha = await sharp(bytes).extractChannel(3).raw().toBuffer();
    let visible = 0; let clear = 0; let minX = metadata.width; let minY = metadata.height; let maxX = -1; let maxY = -1;
    for (let y = 0; y < metadata.height; y++) for (let x = 0; x < metadata.width; x++) {
      const value = alpha[y * metadata.width + x] || 0;
      if (value > 240) visible++;
      if (value < 15) clear++;
      if (value > 15) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    }
    return visible / alpha.length >= .01 && clear / alpha.length >= .015 && maxX >= minX && maxY >= minY
      ? { aspectRatio: (maxX - minX + 1) / (maxY - minY + 1) } : null;
  } catch { return null; }
}

export async function isVerifiedTransparentProductCutout(bytes: Buffer): Promise<boolean> {
  return !!await verifiedTransparentCutoutGeometry(bytes);
}

export type ProductIdentityPreparation =
  | { status: 'eligible'; composite: ProductIdentityCompositeInput; provenance: { productAssetId: string; productAssetVersion: string; cutoutAssetId: string; cutoutVersion: string; occluderAssetId?: string } }
  | { status: 'generative_fallback'; reason: string };

/** Maps identity-layer inputs to a precise first-frame recipe without calling a model. */
export async function prepareProductIdentityLayer(input: {
  spec: StoryboardShotSpec;
  /** Must be a model-generated plate with products removed, not a finished first frame. */
  cleanPlate: boolean;
  background: Buffer;
  assetBytes: ReadonlyMap<string, Buffer>;
}): Promise<ProductIdentityPreparation> {
  const fallback = (reason: string): ProductIdentityPreparation => ({ status: 'generative_fallback', reason });
  if (!input.cleanPlate) return fallback('background_not_clean_plate');
  const productAssets = input.spec.assets.filter(asset => asset.role === 'product' && asset.source === 'knowledge_base');
  if (productAssets.length !== 1) return fallback('exact_layer_requires_one_bound_product');
  const productAsset = productAssets[0]!;
  const layout = input.spec.layout;
  if (!layout.productBox || !layout.contactScene || !layout.productView) return fallback('layout_geometry_or_view_missing');
  if ((layout.contactScene === 'tabletop' || layout.contactScene === 'conveyor') && layout.contactSurfaceY === undefined)
    return fallback('contact_surface_missing');
  if (layout.contactSurfaceY !== undefined && Math.abs(layout.productBox.y + layout.productBox.height - layout.contactSurfaceY) > .035)
    return fallback('contact_surface_geometry_mismatch');
  const cutout = input.spec.assets.find(asset => asset.role === 'product_cutout'
    && asset.derivedFromAssetId === productAsset.id && asset.derivedFromVersion === productAsset.version
    && asset.view === layout.productView);
  if (!cutout) return fallback('matching_product_cutout_missing');
  const productCutout = input.assetBytes.get(cutout.id);
  if (!productCutout) return fallback('product_cutout_unreadable');
  if (!await isVerifiedTransparentProductCutout(productCutout)) return fallback('product_cutout_not_verified_transparent');
  let foregroundOccluder: Buffer | undefined;
  const occluderAsset = input.spec.assets.find(asset => asset.role === 'foreground_occluder');
  if (layout.contactScene === 'handheld' && !occluderAsset) return fallback('hand_foreground_missing');
  if (occluderAsset) {
    foregroundOccluder = input.assetBytes.get(occluderAsset.id);
    if (!foregroundOccluder) return fallback('foreground_occluder_unreadable');
    try {
      const [plate, foreground] = await Promise.all([sharp(input.background).metadata(), sharp(foregroundOccluder).metadata()]);
      if (!foreground.hasAlpha || foreground.width !== plate.width || foreground.height !== plate.height)
        return fallback('foreground_occluder_geometry_mismatch');
    } catch { return fallback('foreground_occluder_invalid'); }
  }
  return {
    status: 'eligible',
    composite: {
      background: input.background, productCutout,
      placement: { ...layout.productBox, ...(layout.contactSurfaceY !== undefined ? { surfaceY: layout.contactSurfaceY } : {}) },
      scene: layout.contactScene, foregroundOccluder,
    },
    provenance: {
      productAssetId: productAsset.id, productAssetVersion: productAsset.version,
      cutoutAssetId: cutout.id, cutoutVersion: cutout.version,
      ...(occluderAsset ? { occluderAssetId: occluderAsset.id } : {}),
    },
  };
}
