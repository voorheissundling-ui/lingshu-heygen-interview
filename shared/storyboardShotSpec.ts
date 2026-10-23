/** Versioned, provider-independent input for one non-presenter storyboard shot. */
export const STORYBOARD_SHOT_SPEC_VERSION = 'storyboard-shot-spec-v2';

export type StoryboardShotScene = 'product' | 'factory' | 'usage' | 'general';
export type StoryboardShotMode = 'replication' | 'free_creation';
export type StoryboardAssetRole = 'composition' | 'product' | 'product_view' | 'product_cutout' | 'foreground_occluder' | 'person' | 'environment' | 'motion';

export interface StoryboardShotAsset {
  role: StoryboardAssetRole;
  id: string;
  version: string;
  source: 'reference_video' | 'knowledge_base' | 'enterprise_asset' | 'generated';
  label?: string;
  /** Cutout identity is tied to the exact knowledge-base product image version. */
  derivedFromAssetId?: string;
  derivedFromVersion?: string;
  /** Front, left, right etc.; exact pixel compositing requires the intended view. */
  view?: string;
}

export interface StoryboardActionSpec {
  startState: string;
  beats: string[];
  endState: string;
  cameraMotion: string;
  forbiddenChanges: string[];
  /** Source analysis is evidence only when the confirmed shot actually states it. */
  evidence: 'confirmed_reference_analysis' | 'confirmed_storyboard' | 'unspecified';
  multiStep: boolean;
}

export interface StoryboardLayoutSpec {
  ratio: '9:16' | '16:9' | '1:1';
  subject: string;
  productPosition: string;
  environment: string;
  contactSurface: string;
  handOrPersonPosition: string;
  cameraAngle: string;
  preserveSourceComposition: boolean;
  /** Optional machine-checkable geometry for an exact source-pixel product layer. */
  productBox?: { x: number; y: number; width: number; height: number };
  contactSurfaceY?: number;
  contactScene?: 'tabletop' | 'handheld' | 'conveyor';
  productView?: string;
}

export interface StoryboardShotSpec {
  version: typeof STORYBOARD_SHOT_SPEC_VERSION;
  shotId: string;
  mode: StoryboardShotMode;
  scene: StoryboardShotScene;
  description: string;
  startSeconds: number | null;
  endSeconds: number | null;
  targetDurationSeconds: number;
  assets: StoryboardShotAsset[];
  layout: StoryboardLayoutSpec;
  action: StoryboardActionSpec;
  constraints: Array<'product_identity' | 'factory_space' | 'person_identity' | 'physical_contact' | 'action_completion'>;
}

const clean = (value: unknown, max = 500): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
const cleanList = (value: unknown, maxItems: number, maxText: number): string[] => Array.isArray(value)
  ? value.slice(0, maxItems).map(item => clean(item, maxText)).filter(Boolean) : [];
const validTime = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function normalized(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }

export function compileStoryboardShotSpec(input: {
  shotId: string;
  mode: StoryboardShotMode;
  scene: StoryboardShotScene;
  description: string;
  ratio: StoryboardLayoutSpec['ratio'];
  startSeconds?: unknown;
  endSeconds?: unknown;
  assets: StoryboardShotAsset[];
  layout?: Partial<StoryboardLayoutSpec>;
  action?: Partial<StoryboardActionSpec>;
}): StoryboardShotSpec {
  const shotId = clean(input.shotId, 160);
  const description = clean(input.description, 4000);
  if (!shotId || !description) throw new Error('shot_spec_missing_identity_or_description');
  const startSeconds = validTime(input.startSeconds);
  const endSeconds = validTime(input.endSeconds);
  if (startSeconds !== null && endSeconds !== null && endSeconds <= startSeconds) throw new Error('shot_spec_invalid_time_range');
  const targetDurationSeconds = startSeconds !== null && endSeconds !== null ? endSeconds - startSeconds : 4;
  const assets = input.assets.map(asset => ({ ...asset, id: clean(asset.id, 300), version: clean(asset.version, 128),
    derivedFromAssetId: asset.derivedFromAssetId ? clean(asset.derivedFromAssetId, 300) : undefined,
    derivedFromVersion: asset.derivedFromVersion ? clean(asset.derivedFromVersion, 128) : undefined,
    view: asset.view ? clean(asset.view, 80) : undefined }));
  if (assets.some(asset => !asset.id || !asset.version)) throw new Error('shot_spec_invalid_asset_provenance');
  if (new Set(assets.map(asset => `${asset.role}:${asset.id}`)).size !== assets.length) throw new Error('shot_spec_duplicate_asset');
  const productBox = input.layout?.productBox;
  if (productBox && (!normalized(productBox.x) || !normalized(productBox.y) || !normalized(productBox.width)
      || !normalized(productBox.height) || productBox.width === 0 || productBox.height === 0
      || productBox.x + productBox.width > 1 || productBox.y + productBox.height > 1)) throw new Error('shot_spec_invalid_product_box');
  const contactSurfaceY = input.layout?.contactSurfaceY;
  if (contactSurfaceY !== undefined && !normalized(contactSurfaceY)) throw new Error('shot_spec_invalid_contact_surface_y');
  if (input.mode === 'replication' && !assets.some(asset => asset.role === 'composition' && asset.source === 'reference_video')) throw new Error('shot_spec_missing_source_frame');
  if (input.scene === 'product' || input.scene === 'usage') {
    if (!assets.some(asset => asset.role === 'product' && asset.source === 'knowledge_base')) throw new Error('shot_spec_missing_product');
  }
  const action = input.action || {};
  const beats = cleanList(action.beats, 8, 240);
  const startState = clean(action.startState, 400);
  const endState = clean(action.endState, 400);
  const multiStep = beats.length > 1;
  // A missing end state is retained as an explicit incomplete input. It may
  // still be used to draft a first frame, but video submission must stop.
  const constraints: StoryboardShotSpec['constraints'] = [];
  if (assets.some(asset => asset.role === 'product')) constraints.push('product_identity');
  if (input.scene === 'factory' || /工厂|产线|流水线|车间|传送带|factory|conveyor/i.test(description)) constraints.push('factory_space');
  if (assets.some(asset => asset.role === 'person')) constraints.push('person_identity');
  if (input.scene === 'usage' || /手持|握持|拿着|安装|涂抹|操作|handheld|install|apply/i.test(description)) constraints.push('physical_contact');
  if (input.scene === 'usage' && endState) constraints.push('action_completion');
  return {
    version: STORYBOARD_SHOT_SPEC_VERSION, shotId, mode: input.mode, scene: input.scene, description,
    startSeconds, endSeconds, targetDurationSeconds, assets,
    layout: {
      ratio: input.ratio,
      subject: clean(input.layout?.subject, 300) || (input.scene === 'factory' ? 'factory equipment or worker' : input.scene === 'general' ? 'subject described by the storyboard' : 'selected enterprise product'),
      productPosition: clean(input.layout?.productPosition, 300),
      environment: clean(input.layout?.environment, 300),
      contactSurface: clean(input.layout?.contactSurface, 300),
      handOrPersonPosition: clean(input.layout?.handOrPersonPosition, 300),
      cameraAngle: clean(input.layout?.cameraAngle, 300),
      preserveSourceComposition: input.mode === 'replication',
      ...(productBox ? { productBox: { ...productBox } } : {}),
      ...(contactSurfaceY !== undefined ? { contactSurfaceY } : {}),
      ...(input.layout?.contactScene === 'tabletop' || input.layout?.contactScene === 'handheld' || input.layout?.contactScene === 'conveyor'
        ? { contactScene: input.layout.contactScene } : {}),
      ...(clean(input.layout?.productView, 80) ? { productView: clean(input.layout?.productView, 80) } : {}),
    },
    action: {
      startState, beats, endState, cameraMotion: clean(action.cameraMotion, 300),
      forbiddenChanges: cleanList(action.forbiddenChanges, 12, 200),
      evidence: action.evidence === 'confirmed_reference_analysis' || action.evidence === 'confirmed_storyboard' ? action.evidence : 'unspecified',
      multiStep,
    },
    constraints,
  };
}
