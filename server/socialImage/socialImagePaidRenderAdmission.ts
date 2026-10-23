import { createHash } from 'node:crypto';
import type { SocialImageCreationTask } from '../../shared/contracts/socialImageCreation.js';
import type { EnterpriseProfile } from '../routes/enterpriseProfileContracts.js';
import { IMAGE_DELIVERABLE_LABELS, type ImageDeliverable, type ImageProductionStrategy } from '../../shared/imageCreativePlanning.js';
import { SocialImagePaidJobError } from './socialImagePaidJob.js';
import { buildSocialImageGifPlatePrompt } from './socialImageFirstDraft.js';

/** A changed or missing product must be caught before buying another GIF plate. */
export async function verifyFrozenGifProductAssets(
  task: SocialImageCreationTask,
  products: NonNullable<EnterpriseProfile['products']['items']>,
  productIdentity: (product: NonNullable<EnterpriseProfile['products']['items']>[number], index: number) => string,
  readImage: (url: string) => Promise<Buffer | null>,
): Promise<void> {
  if (task.imageType !== 'gif_poster' || !task.renderPlan || task.contentBrief.productRefs.length < 1
    || task.contentBrief.productRefs.length > 2) throw new SocialImagePaidJobError('social_image_gif_product_identity_changed');
  for (const productId of task.contentBrief.productRefs) {
    const product = products.find((item, index) => productIdentity(item, index) === productId);
    const imageUrl = String(product?.images?.[0]?.url || product?.imageUrl || '');
    const bytes = imageUrl ? await readImage(imageUrl) : null;
    const binding = task.enterpriseAssets.find(item => item.role === 'product' && item.assetId === productId);
    const actualHash = bytes ? createHash('sha256').update(bytes).digest('hex') : '';
    if (!binding?.contentHash || binding.contentHash !== actualHash) {
      throw new SocialImagePaidJobError('social_image_gif_product_identity_changed');
    }
  }
}

export function buildStudioSocialImagePaidPrompt(input: {
  sceneIntent: string; ratio: string; poster: Record<string, unknown>;
  deliverableType: ImageDeliverable; productionStrategy: ImageProductionStrategy;
  referenceRoleText: string; benchmarkCount: number; ownedReferenceCount: number;
  gifUnit?: { index: number; count: number };
}): string {
  if (input.gifUnit) return buildSocialImageGifPlatePrompt({ sceneIntent: input.sceneIntent,
    ratio: input.ratio, index: input.gifUnit.index, count: input.gifUnit.count,
    hasBenchmark: input.benchmarkCount > 0 });
  return [
    input.sceneIntent,
    `Generate one finished ${IMAGE_DELIVERABLE_LABELS[input.deliverableType]} (${input.deliverableType}). Production strategy: ${input.productionStrategy}.`,
    'Do not imply OEM/ODM, export, factory, certification, pricing, MOQ, lead-time, delivery, or customization capabilities unless they appear verbatim in the verified JSON.',
    `Use this exact poster JSON as the content source:\n${JSON.stringify(input.poster, null, 2)}`,
    `Aspect ratio: ${input.ratio}.`,
    input.referenceRoleText,
    'An exact_product reference is the only product identity authority. A style reference may influence composition and visual rhythm only, never product, logo, packaging, text or commercial facts.',
    'Use only the sections that contain verified JSON content. Empty badge, proof, process, category, or CTA sections must stay absent rather than being filled with generic marketing claims.',
    'All visible text must match the JSON exactly. Avoid extra fake certifications, fake numbers, fake flags, watermarks, or unreadable tiny claims.',
    input.benchmarkCount > 0
      ? 'The final reference is a benchmark: use it only for generic layout hierarchy, visual rhythm and image-copy relationship. Never copy its brand, logo, product, packaging, claims, contact information or exact wording.'
      : '',
    input.ownedReferenceCount > 0
      ? `The first ${input.ownedReferenceCount} reference image(s) are tenant-owned enterprise assets and are the only authority for product appearance, packaging and brand identity. Do not redraw or invent their labels or logos.`
      : 'No tenant-owned product or brand reference was provided. Keep product and Logo areas empty rather than copying them from the benchmark or inventing enterprise identity.',
  ].filter(Boolean).join('\n\n');
}

export function socialImageReferenceRoleText(input: {
  productIds: string[]; materialReferences: Array<{ role: string; materialId: string; productId?: string | null }>;
  benchmarkCount: number; ownedReferenceCount: number;
}): string {
  return [
    ...input.productIds.map((productId, index) => `Reference ${index + 1}: exact_product; enterpriseProduct=${productId}`),
    ...input.materialReferences.map((item, index) =>
      `Reference ${input.productIds.length + index + 1}: ${item.role}; material=${item.materialId}; product=${item.productId || 'none'}`),
    ...Array.from({ length: input.benchmarkCount }, (_, index) => `Reference ${input.ownedReferenceCount + index + 1}: style_benchmark_only`),
  ].slice(0, 3).join('\n');
}
