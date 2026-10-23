import sharp from 'sharp';

export type ProductContactScene = 'tabletop' | 'handheld' | 'conveyor';
export interface ProductIdentityPlacement {
  /** Normalized rectangle in the final frame. The source cutout is fitted inside it without stretching. */
  x: number; y: number; width: number; height: number;
  /** Normalized surface height. Required for tabletop and conveyor contact. */
  surfaceY?: number;
}
export interface ProductIdentityCompositeInput {
  background: Buffer;
  /** A real transparent cutout, not an opaque product photograph. */
  productCutout: Buffer;
  placement: ProductIdentityPlacement;
  scene: ProductContactScene;
  /** Transparent foreground hand/fingers or conveyor lip, already aligned to the background. */
  foregroundOccluder?: Buffer;
}
export interface ProductIdentityCompositeResult {
  bytes: Buffer;
  width: number;
  height: number;
  productBox: { left: number; top: number; width: number; height: number };
  /** Occluder overlap is checked before compositing, so the product label is not silently hidden. */
  occludedProductFraction: number;
}

function finite01(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`product_identity_invalid_${label}`);
  return value;
}

async function alphaData(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(bytes).ensureAlpha().resize(width, height, { fit: 'fill' }).extractChannel(3).raw().toBuffer();
}

/**
 * Preserves source product pixels where perspective permits a cutout overlay.
 * Unsafe inputs fail closed: a flat photograph or an unverified hand pose must
 * be generated and reviewed instead of being pasted into an unrelated scene.
 */
export async function compositeProductIdentityLayer(input: ProductIdentityCompositeInput): Promise<ProductIdentityCompositeResult> {
  const background = await sharp(input.background).metadata();
  const width = background.width || 0;
  const height = background.height || 0;
  if (width < 64 || height < 64 || width > 8192 || height > 8192) throw new Error('product_identity_invalid_background');
  const p = input.placement;
  finite01(p.x, 'x'); finite01(p.y, 'y'); finite01(p.width, 'width'); finite01(p.height, 'height');
  if (p.width <= 0 || p.height <= 0 || p.x + p.width > 1 || p.y + p.height > 1) throw new Error('product_identity_invalid_placement');
  if ((input.scene === 'tabletop' || input.scene === 'conveyor') && p.surfaceY === undefined) throw new Error('product_identity_missing_contact_surface');
  if (p.surfaceY !== undefined) {
    finite01(p.surfaceY, 'surface');
    if (Math.abs(p.y + p.height - p.surfaceY) > 0.035) throw new Error('product_identity_surface_contact_mismatch');
  }
  if (input.scene === 'handheld' && !input.foregroundOccluder) throw new Error('product_identity_hand_occluder_required');

  const source = await sharp(input.productCutout).rotate().metadata();
  if (!source.hasAlpha || !source.width || !source.height) throw new Error('product_identity_cutout_required');
  const sourceAlpha = await sharp(input.productCutout).rotate().extractChannel(3).raw().toBuffer();
  const opaque = sourceAlpha.reduce((count, a) => count + (a > 240 ? 1 : 0), 0);
  if (opaque / sourceAlpha.length < 0.01) throw new Error('product_identity_empty_cutout');
  if (opaque / sourceAlpha.length > 0.985) throw new Error('product_identity_cutout_required');
  let minX = source.width; let minY = source.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    if ((sourceAlpha[y * source.width + x] || 0) <= 15) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < minX || maxY < minY) throw new Error('product_identity_empty_cutout');

  const slotWidth = Math.max(1, Math.round(p.width * width));
  const slotHeight = Math.max(1, Math.round(p.height * height));
  const product = await sharp(input.productCutout).rotate().extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .resize(slotWidth, slotHeight, { fit: 'contain', background: '#00000000' }).png().toBuffer();
  const left = Math.round(p.x * width);
  const top = Math.round(p.y * height);
  const productMask = await alphaData(product, slotWidth, slotHeight);
  let occludedProductFraction = 0;
  let occluder: Buffer | undefined;
  if (input.foregroundOccluder) {
    const occluderMeta = await sharp(input.foregroundOccluder).metadata();
    if (!occluderMeta.hasAlpha || occluderMeta.width !== width || occluderMeta.height !== height) throw new Error('product_identity_occluder_dimensions');
    occluder = await sharp(input.foregroundOccluder).png().toBuffer();
    const occluderMask = await alphaData(occluder, width, height);
    let productArea = 0; let overlap = 0;
    for (let y = 0; y < slotHeight; y++) for (let x = 0; x < slotWidth; x++) {
      const productAlpha = productMask[y * slotWidth + x] || 0;
      productArea += productAlpha;
      overlap += productAlpha * (occluderMask[(top + y) * width + left + x] || 0) / 255;
    }
    occludedProductFraction = productArea ? overlap / productArea : 0;
    if (occludedProductFraction > 0.4) throw new Error('product_identity_excessive_occlusion');
    if (input.scene === 'handheld' && occludedProductFraction < 0.005) throw new Error('product_identity_hand_not_touching_product');
  }
  const overlays: Array<{ input: Buffer; top: number; left: number }> = [{ input: product, top, left }];
  if (occluder) overlays.push({ input: occluder, top: 0, left: 0 });
  const bytes = await sharp(input.background).ensureAlpha().composite(overlays).png().toBuffer();
  return { bytes, width, height, productBox: { left, top, width: slotWidth, height: slotHeight }, occludedProductFraction };
}
