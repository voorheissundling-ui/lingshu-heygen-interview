export type StoryboardSceneType = 'product' | 'factory' | 'usage' | 'general';
export type StoryboardMode = 'replication' | 'free_creation';
import type { StoryboardShotSpec } from '../../shared/storyboardShotSpec.js';

export const STORYBOARD_FIRST_FRAME_PROMPT_VERSION = 'storyboard-first-frame-v7';

export function buildStoryboardFirstFramePrompt(input: {
  mode: StoryboardMode;
  sceneType: StoryboardSceneType;
  shotDescription: string;
  productName?: string;
  productNames?: string[];
  hasSourceFrame: boolean;
  hasProductImage: boolean;
  productImageCount?: number;
  productReferenceMode?: 'individual' | 'contact_sheet' | 'multi_view_sheet' | 'multi_product_view_sheet';
  productViewCount?: number;
  hasCharacterImage: boolean;
  hasEnvironmentImage?: boolean;
  personEnvironmentReferenceMode?: 'individual' | 'contact_sheet';
  qualityRepairReasonCodes?: string[];
  ratio: string;
  spec?: StoryboardShotSpec;
}): string {
  const references: string[] = [];
  let index = 1;
  if (input.hasSourceFrame) references.push(`Reference image ${index++} is the source shot's actual first frame. Use it ONLY for camera angle, framing, subject positions and spatial layout. Replace its product and brand; do not copy subtitles or watermarks.`);
  const names = (input.productNames?.length ? input.productNames : input.hasProductImage ? [input.productName || 'selected enterprise product'] : []).slice(0, input.productImageCount || 1);
  if (input.productReferenceMode === 'multi_product_view_sheet' && names.length > 1) {
    references.push(`Reference image ${index++} is a grid of SEPARATE enterprise products. Product columns from left to right: ${names.map((name, position) => `${position + 1}: "${name}"`).join('; ')}. Within each column, images from top to bottom are available views of that SAME product; empty white cells mean no view is available. Never treat rows as separate products or merge identities between columns. Preserve only visible shape, packaging and logo details; white gutters are not part of the target scene.`);
  } else if (input.productReferenceMode === 'multi_view_sheet' && names.length === 1) {
    references.push(`Reference image ${index++} is a ${input.productViewCount || 2}-panel sheet of DIFFERENT VIEWS OF THE SAME enterprise knowledge-base product "${names[0]}". The left panel is the primary product photo; other panels show additional available angles. Reconcile shape, color, packaging, logo and proportions across the panels. Use only geometry actually visible in these views; do not treat panels as multiple products. The white gutters are not part of the scene.`);
  } else if (input.productReferenceMode === 'contact_sheet' && names.length > 1) {
    references.push(`Reference image ${index++} is a contact sheet of ${names.length} SEPARATE enterprise knowledge-base products, ordered left to right: ${names.map((name, position) => `${position + 1}: "${name}"`).join('; ')}. Treat each cell as a distinct product identity. Preserve each product's own shape, color, packaging and brand. Do not merge the products or copy source-video branding. The white gutters are not part of the scene.`);
  } else for (const name of names) {
    references.push(`Reference image ${index++} is enterprise knowledge-base product "${name}". Preserve its shape, color, packaging and brand identity. Do not merge it with another product or copy source-video branding.`);
  }
  if (input.personEnvironmentReferenceMode === 'contact_sheet' && input.hasCharacterImage && input.hasEnvironmentImage)
    references.push(`Reference image ${index++} is a two-panel contact sheet: LEFT is the specified enterprise person's identity, RIGHT is the selected enterprise environment image. Treat these as separate references, not one scene. Preserve the person's identity from the left panel and use only directly visible equipment, workstation and spatial appearance from the right panel. The white gutter is not part of the target scene. Neither panel proves factory ownership, production capability or certification.`);
  else {
    if (input.hasCharacterImage) references.push(`Reference image ${index++} defines the specified enterprise person's identity.`);
    if (input.hasEnvironmentImage) references.push(`Reference image ${index++} is the selected project environment image. Use only its directly visible spatial appearance as environment guidance. It does not prove factory ownership, production capability or certification.`);
  }
  const scene = input.sceneType === 'product'
    ? 'Create a realistic product filming setup. Keep the product supported by the hand, table or conveyor as described. Preserve plausible grip, contact and scale.'
    : input.sceneType === 'factory'
      ? 'Create a realistic factory filming setup. Keep equipment, conveyor direction, workers and workstations spatially coherent. Do not invent readable equipment labels.'
      : input.sceneType === 'usage'
        ? 'Create the stable START state of the real product use action. Establish the product, user or tool, target surface, and contact relationship in the stated environment. Do not show the action already complete.'
        : 'Create a realistic general storyboard scene matching the visual action and setting. No enterprise product is assigned to this shot; do not invent a branded product, packaging or logo.';
  const singleViewProductIds = (input.spec?.assets || []).filter(asset => asset.role === 'product'
    && !input.spec?.assets.some(view => view.role === 'product_view' && view.derivedFromAssetId === asset.id)).map(asset => asset.id);
  const qualityRepairs = [...new Set(input.qualityRepairReasonCodes || [])].flatMap(code => ({
    PRODUCT_IDENTITY_FAILED: 'Match the enterprise product reference exactly; do not alter package shape, color, logo placement, label layout, volume text or proportions.',
    VISUAL_INTEGRITY_FAILED: 'Remove malformed edges, duplicated parts, floating objects, warped packaging, illegible artifacts and physically impossible contact.',
    LAYOUT_FAILED: 'Follow the layout contract exactly; keep the required product, support surface, crop, spacing and camera relationship fully visible.',
  } as Record<string, string>)[code] || []);
  return [
    `Create exactly one photorealistic ${input.ratio} first-frame still for a short continuous video shot.`,
    `Shot requirement: ${input.shotDescription.slice(0, 1800)}`,
    input.productNames?.length ? `Target enterprise products: ${input.productNames.map(name => name.slice(0, 160)).join('; ')}.` : input.productName ? `Target enterprise product: ${input.productName.slice(0, 160)}.` : '',
    input.mode === 'replication' && input.hasProductImage
      ? 'PRODUCT REPLACEMENT IS MANDATORY: every visible package, logo, colorway, label layout and product silhouette must come from the enterprise product reference. The source frame may supply composition only. Never retain, reproduce, blend, or treat as valid any source-video product, brand, package, logo, readable label, or colorway.'
      : '',
    input.mode === 'replication' && input.hasProductImage && names.length === 1
      ? 'The enterprise reference contains ONE product identity. If the source frame shows several packages, boxes, pouches or bottles, show only repeated instances of that same enterprise product where composition needs multiples. Never preserve an unmatched package shape, pouch, bag, label or second brand from the source frame.'
      : '',
    ...references,
    scene,
    singleViewProductIds.length ? `Only one knowledge-base view is available for product IDs ${singleViewProductIds.join(', ')}. Keep those products near the supplied orientation; do not invent unseen sides, back panels or hidden packaging text.` : '',
    input.spec ? `Layout contract: ${JSON.stringify(input.spec.layout)}. This describes the starting frame; keep product, contact surface and camera relationship visible where specified.` : '',
    input.spec?.action.startState ? `The first frame must show this START state, before the action: ${input.spec.action.startState}` : '',
    input.spec?.action.beats.length ? `Later motion beats, in order (do not show them complete in this first frame): ${input.spec.action.beats.join(' → ')}` : '',
    input.spec?.action.endState ? `Intended later END state: ${input.spec.action.endState}` : '',
    qualityRepairs.length ? `QUALITY REPAIR — prior candidates were rejected. Correct every item below; do not repeat the rejected layout or product rendering:\n- ${qualityRepairs.join('\n- ')}` : '',
    'Keep all visible elements physically plausible. Do not add extra products, fingers, hands, floating objects, captions, watermarks, random text or unsupported business claims.',
  ].filter(Boolean).join('\n\n');
}

export function buildStoryboardVideoActionPrompt(spec: StoryboardShotSpec): string {
  const action = spec.action;
  const singleViewProductIds = spec.assets.filter(asset => asset.role === 'product'
    && !spec.assets.some(view => view.role === 'product_view' && view.derivedFromAssetId === asset.id)).map(asset => asset.id);
  return [
    `Single continuous ${spec.targetDurationSeconds.toFixed(1)}-second ${spec.scene} storyboard shot.`,
    `Visual requirement: ${spec.description}`,
    action.startState ? `START state: ${action.startState}` : 'START from the confirmed first-frame state.',
    action.beats.length ? `Perform in exact temporal order: ${action.beats.map((beat, index) => `${index + 1}. ${beat}`).join(' ')}` : 'Perform only the visible action described by the storyboard.',
    action.endState ? `END state that must be visible: ${action.endState}` : 'Do not imply an unobserved completed action.',
    action.cameraMotion ? `Camera motion: ${action.cameraMotion}` : 'Use one smooth, physically plausible camera movement.',
    `Identity and physical constraints: ${spec.constraints.join(', ')}.`,
    singleViewProductIds.length ? `For single-view product IDs ${singleViewProductIds.join(', ')}, keep the product near its known orientation. Do not reveal an unseen back or side or invent hidden label text.` : '',
    action.forbiddenChanges.length ? `Forbidden changes: ${action.forbiddenChanges.join('; ')}` : '',
    'Maintain the confirmed first frame composition and subject identity across all frames. Do not add captions, labels, watermarks, extra products, people or tools.',
  ].filter(Boolean).join('\n');
}
