import sharp from 'sharp';
import type { ReferenceImage } from './imageGen.js';

/** Pack several KB product images into one model reference while preserving
 * their left-to-right identity order and the full-resolution originals in the
 * shot specification and QA inputs. This is only a provider input adapter. */
export async function storyboardProductReferenceSheet(products: ReferenceImage[]): Promise<ReferenceImage> {
  if (products.length < 2 || products.length > 3) throw new Error('product_reference_sheet_count_invalid');
  // Product photos are usually portrait. A tall cell retains considerably
  // more package and label detail than a square sheet at the same cell width.
  const cellWidth = 720;
  const cellHeight = 1152;
  const inset = 20;
  const overlays = await Promise.all(products.map(async (product, index) => {
    const bytes = Buffer.from(product.base64, 'base64');
    const fitted = await sharp(bytes).rotate().resize(cellWidth - inset * 2, cellHeight - inset * 2, {
      fit: 'contain', background: '#ffffff', withoutEnlargement: true,
    }).png().toBuffer();
    const info = await sharp(fitted).metadata();
    return { input: fitted, left: index * cellWidth + Math.round((cellWidth - (info.width || 0)) / 2),
      top: Math.round((cellHeight - (info.height || 0)) / 2) };
  }));
  const sheet = await sharp({ create: { width: cellWidth * products.length, height: cellHeight, channels: 3, background: '#ffffff' } })
    .composite(overlays).png().toBuffer();
  return { mimeType: 'image/png', base64: sheet.toString('base64') };
}

/** Columns identify products; rows identify views of that same product. */
export async function storyboardMultiProductViewSheet(groups: ReferenceImage[][]): Promise<ReferenceImage> {
  if (groups.length < 2 || groups.length > 3 || groups.some(group => group.length < 1 || group.length > 3))
    throw new Error('product_view_sheet_count_invalid');
  const cellWidth = 720;
  const cellHeight = 768;
  const rows = Math.max(...groups.map(group => group.length));
  const overlays = await Promise.all(groups.flatMap((group, column) => group.map(async (view, row) => {
    const fitted = await sharp(Buffer.from(view.base64, 'base64')).rotate().resize(cellWidth - 40, cellHeight - 40, {
      fit: 'contain', background: '#ffffff', withoutEnlargement: true,
    }).png().toBuffer();
    const info = await sharp(fitted).metadata();
    return { input: fitted, left: column * cellWidth + Math.round((cellWidth - (info.width || 0)) / 2),
      top: row * cellHeight + Math.round((cellHeight - (info.height || 0)) / 2) };
  })));
  const sheet = await sharp({ create: { width: groups.length * cellWidth, height: rows * cellHeight,
    channels: 3, background: '#ffffff' } }).composite(overlays).png().toBuffer();
  return { mimeType: 'image/png', base64: sheet.toString('base64') };
}
