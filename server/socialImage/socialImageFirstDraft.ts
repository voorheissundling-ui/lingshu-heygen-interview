import type { SocialImageContentType, SocialImageReplicationRecipe } from '../../shared/contracts/socialImageCreation.js';

export interface SocialImageFirstDraftPromptInput {
  imagePrompt: string;
  poster: Record<string, unknown>;
  ratio: string;
  imageType?: SocialImageContentType;
  hasBenchmark: boolean;
  ownedReferenceCount: number;
  replicationRecipe?: SocialImageReplicationRecipe;
  fixedIdentityComposition?: boolean;
}

/** A paid GIF unit is only a scene plate; all customer-visible identity and copy are composited later. */
export function buildSocialImageGifPlatePrompt(input: {
  sceneIntent: string; ratio: string; index: number; count: number; hasBenchmark: boolean;
}): string {
  return [
    `Generate exactly one background plate for frame ${input.index + 1} of ${input.count} in a multi-background GIF.`,
    `Canvas aspect ratio: ${input.ratio}. Keep the background visually distinct from the other frames while preserving a stable scene category and lighting system.`,
    `Scene intent: ${input.sceneIntent}`,
    'BACKGROUND ONLY. Do not draw any product, package, bottle, cap, logo, brand mark, person holding a product, headline, letter, number, badge, search card, bottom bar, CTA, watermark, or interface element.',
    'Keep a calm upper copy zone, a clear central product stage, and a bottom CTA zone. These fixed identity and text layers are added deterministically after every background plate is durable.',
    input.hasBenchmark
      ? 'The reference image is a structural benchmark only. Preserve its canvas dimensions, perspective, zone geometry, whitespace and background rhythm; do not copy its product, brand, text, logo or other identity.'
      : '',
  ].filter(Boolean).join('\n\n');
}

export function socialImageUnitPoster(poster: Record<string, unknown>, imageType: SocialImageContentType | undefined, index: number, count: number): Record<string, unknown> {
  if (imageType !== 'carousel' || count <= 1) return poster;
  const sellingPoints = Array.isArray(poster.sellingPoints) ? poster.sellingPoints.map(String).filter(Boolean) : [];
  const trustBadges = Array.isArray(poster.trustBadges) ? poster.trustBadges.map(String).filter(Boolean) : [];
  const process = Array.isArray(poster.process) ? poster.process.map(String).filter(Boolean) : [];
  const roles = [
    { pageRole: 'cover', headline: poster.headline, subheadline: poster.subheadline },
    { pageRole: 'value', headline: sellingPoints[0] || poster.headline, subheadline: sellingPoints.slice(1, 3).join(' · ') || poster.subheadline },
    { pageRole: 'proof', headline: trustBadges[0] || process[0] || poster.headline, subheadline: [...trustBadges.slice(1, 3), ...process.slice(1, 2)].join(' · ') || poster.subheadline },
    { pageRole: 'conversion', headline: poster.cta || poster.headline, subheadline: Array.isArray(poster.bottomBar) ? poster.bottomBar.map(String).join(' · ') : poster.subheadline },
  ];
  return { ...poster, ...roles[Math.min(index, roles.length - 1)], carouselPage: index + 1, carouselPageCount: count };
}

function recipeSummary(recipe?: SocialImageReplicationRecipe): string {
  if (!recipe) return '';
  const regions = recipe.layoutRegions.map(region =>
    `${region.id} (${region.role})=[${region.x},${region.y},${region.width},${region.height}]`,
  ).join('; ');
  const typography = (recipe.typographyRegions || []).map(region =>
    `${region.role}:${region.region}/${region.relativeSize}/${region.alignment}/line-breaks=${region.preserveLineBreaks}`,
  ).join('; ');
  const blueprint = recipe.referenceLayerBlueprints?.[0];
  const layerOrder = blueprint?.layers.slice().sort((a, b) => a.zIndex - b.zIndex)
    .map(layer => `${layer.role}:${layer.id}@z${layer.zIndex}`).join(' > ');
  const masks = blueprint?.masks.map(mask =>
    `${mask.id}:${mask.shape}/box=[${mask.bounds.x},${mask.bounds.y},${mask.bounds.width},${mask.bounds.height}]/opacity=${mask.opacity}/z=${mask.zIndex}`,
  ).join('; ');
  return [
    regions ? `Normalized layout priors: ${regions}.` : '',
    typography ? `Typography priors: ${typography}.` : '',
    recipe.productPresentation ? `Product presentation: ${recipe.productPresentation}.` : '',
    recipe.protectedSubjects.length ? `Protected subjects: ${recipe.protectedSubjects.join(', ')}.` : '',
    layerOrder ? `Measured back-to-front layer order: ${layerOrder}.` : '',
    masks ? `Measured masks (preserve contour, coverage and opacity): ${masks}.` : '',
  ].filter(Boolean).join(' ');
}

/**
 * Server-owned prompt contract for the paid first-draft render. The browser may
 * submit business intent, but it must not be the authority for identity,
 * reference reconstruction, safety zones, or visible commercial claims.
 */
export function buildSocialImageFirstDraftPrompt(input: SocialImageFirstDraftPromptInput): string {
  const benchmarkContract = input.hasBenchmark ? [
    'REFERENCE RECONSTRUCTION CONTRACT — structure has priority over decorative novelty.',
    'Treat reference image 1 as a locked structural blueprint, not a loose style moodboard.',
    'First decompose it into measurable layers: background scene and perspective; product as a single item, product combination, or complete set; top-left corner badge/UI; bottom bar/UI; headline; subheadline; and supporting copy.',
    'Preserve normalized bounding boxes, z-order, relative scale, alignment, whitespace, overlap order, visual center, product-count rhythm, group silhouette, and approximate text line breaks.',
    'Preserve the benchmark negative-space strategy. If its copy sits in open sky or another quiet upper-right area, keep that area quiet and place the new headline, subheadline, and supporting copy there rather than centering them.',
    'Match scene category, horizon, perspective, lighting direction, depth, and dense-versus-empty distribution while replacing every competitor-specific property.',
    'Rebuild corner badge and bottom bar as separate UI modules. Never copy benchmark brand, logo, product, packaging, claims, certifications, flags, contacts, MOQ, or exact wording.',
    'A result that merely shares the same industry or premium mood but moves the modules to new positions is incorrect.',
    recipeSummary(input.replicationRecipe),
  ].filter(Boolean).join(' ') : '';

  return [
    input.imagePrompt,
    `Content archetype: ${input.imageType || 'product_poster'}.`,
    'Generate exactly one finished high-end B2B social-media first draft.',
    input.imageType === 'gif_poster' && input.fixedIdentityComposition
      ? 'GIF BACKGROUND PLATE ONLY: generate the scene/background for this frame with no product, logo, headline, text, badge, search card, bottom bar, CTA, watermark, or interface element. Those fixed layers are composited deterministically after generation.'
      : '',
    'The supplied poster JSON is the sole authority for visible wording. Do not add text, numbers, badges, certifications, contact details, flags, watermarks, or commercial claims that are absent from it.',
    `Poster JSON:\n${JSON.stringify(input.poster, null, 2)}`,
    `Aspect ratio: ${input.ratio}. This canvas ratio is mandatory. Compose all subjects and text for this exact frame; do not substitute a nearby portrait, square, or landscape ratio.`,
    'Keep headline, translucent overlays, logo, CTA, and important subjects in separate safe zones. Minor overlap is allowed only when legibility remains intact.',
    'For every supplied product, keep the complete cap or top closure, brand name, core label, and group silhouette visible. Do not let copy, badges, masks, decorative objects, cropping, or another product hide those anchors.',
    'Use only non-empty JSON sections. Empty badge, proof, process, category, or CTA sections must remain absent.',
    benchmarkContract,
    input.ownedReferenceCount > 0
      ? `Reference images after the benchmark are tenant-owned enterprise assets and are the only authority for product appearance, packaging, logo, and brand identity. Preserve them; do not redraw labels or invent variants. Owned reference count: ${input.ownedReferenceCount}.`
      : 'No tenant-owned identity reference is available. Keep product and logo regions empty rather than copying identity from the benchmark or inventing one.',
  ].filter(Boolean).join('\n\n');
}
