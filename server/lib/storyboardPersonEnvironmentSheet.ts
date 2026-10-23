import sharp from 'sharp';
import type { ReferenceImage } from './imageGen.js';

/** Provider input only: left cell is a person identity reference, right cell
 * is a separate environment reference. Originals remain separate in the
 * shot spec and quality inspection. */
export async function storyboardPersonEnvironmentSheet(person: ReferenceImage, environment: ReferenceImage): Promise<ReferenceImage> {
  const height = 1152;
  const personWidth = 768;
  const environmentWidth = 1152;
  const inset = 24;
  const fit = async (reference: ReferenceImage, width: number) => {
    const buffer = await sharp(Buffer.from(reference.base64, 'base64')).rotate()
      .resize(width - inset * 2, height - inset * 2, { fit: 'contain', background: '#ffffff', withoutEnlargement: true })
      .png().toBuffer();
    const dimensions = await sharp(buffer).metadata();
    return { input: buffer, left: Math.round((width - (dimensions.width || 0)) / 2),
      top: Math.round((height - (dimensions.height || 0)) / 2) };
  };
  const [personCell, environmentCell] = await Promise.all([fit(person, personWidth), fit(environment, environmentWidth)]);
  const sheet = await sharp({ create: { width: personWidth + environmentWidth, height, channels: 3, background: '#ffffff' } })
    .composite([personCell, { ...environmentCell, left: personWidth + environmentCell.left }]).png().toBuffer();
  return { mimeType: 'image/png', base64: sheet.toString('base64') };
}
