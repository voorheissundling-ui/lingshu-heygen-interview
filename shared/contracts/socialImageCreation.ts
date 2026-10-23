export const SOCIAL_IMAGE_CONTENT_TYPES = [
  'light_packaging', 'product_poster', 'brand_news', 'experiment_comparison',
  'trend', 'infographic', 'carousel', 'gif_poster',
] as const;

export type SocialImageContentType = typeof SOCIAL_IMAGE_CONTENT_TYPES[number];
export type SocialImageCreationPath = 'material_processing' | 'viral_replication';
export type SocialImageFactuality = 'verified' | 'user_supplied' | 'mock';
export type SocialImageTaskStep = 'type' | 'inputs' | 'plan' | 'generate' | 'motion' | 'review';
export type SocialImageTaskStatus = 'draft' | 'planned' | 'generating' | 'review_required' | 'blocked' | 'approved';

export interface SocialImageReferenceSnapshot {
  sourceRecordId?: string;
  sourceUrl?: string;
  platform?: string;
  accountName?: string;
  title?: string;
  caption?: string;
  imageUrls: string[];
  collectedAt: string;
  fingerprint: string;
}

export type SocialImageReferenceLayerRole = 'background' | 'mask' | 'product' | 'text' | 'logo' | 'decoration';
export type SocialImageReferenceMaskShape = 'rectangle' | 'rounded_rectangle' | 'ellipse' | 'polygon' | 'linear_gradient';

export interface SocialImageReferenceLayerBlueprint {
  imageIndex: number;
  layers: Array<{
    id: string;
    role: SocialImageReferenceLayerRole;
    zIndex: number;
    bounds: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  masks: Array<{
    id: string;
    shape: SocialImageReferenceMaskShape;
    bounds: { x: number; y: number; width: number; height: number };
    opacity: number;
    color?: string;
    cornerRadius?: number;
    feather?: number;
    angle?: number;
    points?: Array<{ x: number; y: number }>;
    zIndex: number;
    confidence: number;
  }>;
}

export interface SocialImageReplicationRecipe {
  contentArchetype: string;
  imageCopyRelation: SocialImageCreativeRecipe['imageTextRelation'];
  preserve: string[];
  replace: string[];
  palette: string[];
  layoutRegions: Array<{ id: string; role: string; x: number; y: number; width: number; height: number }>;
  productPresentation?: 'single' | 'combination' | 'set' | 'auto_from_reference';
  typographyRegions?: Array<{
    role: 'headline' | 'subheadline' | 'supporting';
    region: string;
    relativeSize: 'display' | 'large' | 'medium' | 'small';
    alignment: 'left' | 'center' | 'right';
    preserveLineBreaks: boolean;
  }>;
  protectedSubjects: string[];
  overlayZones: string[];
  referenceLayerBlueprints?: SocialImageReferenceLayerBlueprint[];
  motionMechanism?: SocialImageDeliverySpec['motion'] extends infer T ? T extends { mechanism: infer M } ? M : never : never;
}

export type SocialImageEnterpriseAssetRole = 'product' | 'logo' | 'scene' | 'evidence';
export interface SocialImageEnterpriseAssetBinding {
  assetId: string;
  role: SocialImageEnterpriseAssetRole;
  name: string;
  source: 'enterprise_knowledge_base' | 'enterprise_material_library';
  contentHash?: string;
  required: boolean;
}

export interface SocialImageGenerationJob {
  id: string;
  idempotencyKey: string;
  planVersion?: number;
  unitIndex?: number;
  plannedInputHash?: string;
  /** Hash of the server-admitted render request, frozen before a paid call. */
  inputHash?: string;
  status: 'queued' | 'running' | 'output_ready' | 'quality_checking' | 'repairing' | 'completed' | 'failed' | 'outcome_unknown';
  outputNodeIds: string[];
  provider?: string;
  providerReceipt?: string;
  attempt: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialImageFrozenRenderPlan {
  version: number;
  sourceHash: string;
  createdAt: string;
  units: Array<{
    jobId: string;
    index: number;
    count: number;
    label: string;
    role: 'carousel_page' | 'gif_plate';
    poster: Record<string, unknown>;
    idempotencyKey: string;
    plannedInputHash: string;
  }>;
}

export interface SocialImageRepairInstruction {
  id: string;
  outputNodeId: string;
  failedChecks: SocialImageQualityCheckKey[];
  targetLayer: 'background' | 'product' | 'logo' | 'typography' | 'timeline' | 'full_composite';
  instruction: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  fromVersion: number;
  toVersion?: number;
}

export interface SocialImageEvidenceItem {
  id: string;
  label: string;
  source: 'enterprise_profile' | 'user_input' | 'reference' | 'mock';
  value: string;
}

export interface SocialImageContentBrief {
  objective: 'awareness' | 'trust' | 'education' | 'lead_generation' | 'event_conversion';
  topicType: 'trend' | 'ingredient_launch' | 'formulation_demo' | 'experiment_comparison' | 'brand_news' | 'partnership_news' | 'origin_story' | 'factory_trust' | 'technical_solution';
  coreClaim: string;
  audience: string[];
  productRefs: string[];
  productNames: string[];
  evidenceItems: SocialImageEvidenceItem[];
  partnerName?: string;
  factuality: SocialImageFactuality;
  targetAction?: string;
  prohibitedClaims: string[];
}

export interface SocialImageCreativeRecipe {
  narrativePattern: 'news_announcement' | 'problem_solution' | 'visible_experiment' | 'trend_to_opportunity' | 'origin_to_benefit' | 'person_to_trust';
  visualProof: 'event_photo' | 'product_hero' | 'before_after' | 'process_sequence' | 'texture_macro' | 'lab_scene' | 'source_landscape' | 'data_visualization';
  layoutRecipe: 'news_search_card' | 'hero_product_poster' | 'split_comparison' | 'editorial_story' | 'step_carousel' | 'minimal_luxury' | 'technical_infographic';
  copyPattern: string;
  imageTextRelation: 'image_proves_copy' | 'image_contextualizes_copy' | 'image_explains_copy' | 'image_evokes_copy';
  colorStrategy: 'derive_from_product' | 'derive_from_brand' | 'derive_from_event' | 'benchmark_locked';
  referenceStrength: number;
}

export interface SocialImageTextContract {
  headline: string;
  supportingText?: string;
  caption: string;
  hashtags: string[];
  cta?: string;
  requiredFacts: string[];
  prohibitedInferences: string[];
  visualMustShow: string[];
  visualMustNotImply: string[];
}

export interface SocialImageDeliverySpec {
  format: 'jpg' | 'png' | 'carousel' | 'gif';
  platform: 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin';
  aspectRatio: '1:1' | '4:5' | '9:16' | '16:9';
  language: string;
  outputCount: number;
  imageGeneration?: {
    provider: 'openai';
    model: 'gpt-image-2';
    quality: 'low' | 'medium' | 'high';
  };
  motion?: {
    mechanism: 'background_switch' | 'typewriter' | 'state_reveal' | 'crossfade';
    fixedLayers: string[];
    dynamicLayers: string[];
    loopDurationMs: number;
  };
}

export type SocialImageQualityCheckKey =
  | 'product_identity' | 'packaging_visibility' | 'subject_visibility' | 'label_ocr'
  | 'fact_consistency' | 'copy_visual_consistency' | 'brand_consistency'
  | 'text_overflow' | 'safe_zone' | 'reference_structure_similarity' | 'motion_mechanism_similarity';

export interface SocialImageQualityCheck {
  key: SocialImageQualityCheckKey;
  verdict: 'pass' | 'fail' | 'uncertain' | 'not_applicable';
  severity: 'hard' | 'soft';
  note: string;
  score?: number;
  checker?: 'deterministic' | 'multimodal' | 'human';
  evidence?: string[];
  region?: { x: number; y: number; width: number; height: number };
  repairSuggestion?: string;
}

export interface SocialImageOutputNode {
  id: string;
  role: 'single' | 'carousel_page' | 'gif_plate' | 'gif_frame' | 'gif_output';
  label: string;
  state: 'pending' | 'generating' | 'quality_checking' | 'repair_required' | 'blocked' | 'approved' | 'superseded';
  mediaUrl?: string;
  materialId?: string;
  version: number;
  qualityChecks: SocialImageQualityCheck[];
  sourceJobId?: string;
}

export interface SocialImageGifDelivery {
  planVersion: number;
  sourceHash: string;
  frameOutputIds: string[];
  finalOutputId: string;
}

export interface SocialImageCreationTask {
  schemaVersion: 'social-image-creation.v1' | 'social-image-creation.v2';
  id: string;
  version: number;
  title: string;
  creationPath: SocialImageCreationPath;
  contentMode: 'image';
  imageType: SocialImageContentType;
  step: SocialImageTaskStep;
  status: SocialImageTaskStatus;
  contentBrief: SocialImageContentBrief;
  creativeRecipe: SocialImageCreativeRecipe;
  imageTextContract: SocialImageTextContract;
  renderBrief?: {
    headline: string;
    subheadline: string;
    originBadge: string;
    trustBadges: string[];
    sellingPoints: string[];
    process: string[];
    categories: Array<{ name: string; description: string }>;
    bottomBar: string[];
    cta: string;
  };
  deliverySpec: SocialImageDeliverySpec;
  materialIds: string[];
  referenceUrls: string[];
  referenceSnapshot?: SocialImageReferenceSnapshot;
  replicationRecipe?: SocialImageReplicationRecipe;
  layerGraph?: SocialImageLayerGraph;
  enterpriseAssets: SocialImageEnterpriseAssetBinding[];
  generationJobs: SocialImageGenerationJob[];
  renderPlan?: SocialImageFrozenRenderPlan;
  gifDelivery?: SocialImageGifDelivery;
  repairInstructions: SocialImageRepairInstruction[];
  outputs: SocialImageOutputNode[];
  fieldsToConfirm: string[];
  publishable: boolean;
  createdAt: string;
  updatedAt: string;
}

export const SOCIAL_IMAGE_HARD_CHECKS: SocialImageQualityCheckKey[] = [
  'product_identity', 'packaging_visibility', 'subject_visibility', 'label_ocr',
  'fact_consistency', 'copy_visual_consistency', 'brand_consistency', 'text_overflow', 'safe_zone',
];

export function socialImageCurrentOutputs(task: Pick<SocialImageCreationTask, 'outputs'>): SocialImageOutputNode[] {
  const latest = new Map<string, SocialImageOutputNode>();
  for (const output of task.outputs) {
    const key = `${output.role}:${output.label}`;
    const current = latest.get(key);
    if (!current || output.version > current.version) latest.set(key, output);
  }
  return [...latest.values()];
}

function socialImageMultiOutputComplete(task: SocialImageCreationTask, outputs: SocialImageOutputNode[]): boolean {
  if (task.imageType !== 'carousel' && task.imageType !== 'gif_poster') return true;
  const plan = task.renderPlan;
  if (!plan || plan.units.length !== task.deliverySpec.outputCount) return false;
  const unitsReady = plan.units.every(unit => {
    const job = task.generationJobs.find(item => item.id === unit.jobId && item.planVersion === plan.version && item.unitIndex === unit.index);
    const output = outputs.find(item => item.role === unit.role && item.label === unit.label && item.materialId
      && (task.imageType === 'gif_poster' ? item.state !== 'superseded' : item.state === 'approved'));
    return Boolean(job && output && job.outputNodeIds.includes(output.id));
  });
  if (!unitsReady) return false;
  if (task.imageType !== 'gif_poster') return true;
  const delivery = task.gifDelivery;
  return Boolean(delivery && delivery.planVersion === plan.version && delivery.sourceHash === plan.sourceHash
    && delivery.frameOutputIds.length === plan.units.length
    && plan.units.every(unit => outputs.some(output => output.id === delivery.frameOutputIds[unit.index]
      && output.role === 'gif_frame' && output.sourceJobId === unit.jobId && output.materialId && output.state === 'approved'))
    && outputs.some(output => output.id === delivery.finalOutputId && output.role === 'gif_output' && output.materialId && output.state === 'approved'));
}

function deliverableOutputs(task: SocialImageCreationTask, outputs: SocialImageOutputNode[]): SocialImageOutputNode[] {
  return task.imageType === 'gif_poster' ? outputs.filter(output => output.role !== 'gif_plate') : outputs;
}

export function socialImageTaskIssues(task: SocialImageCreationTask): string[] {
  const issues: string[] = [];
  if (!['social-image-creation.v1', 'social-image-creation.v2'].includes(task.schemaVersion)) issues.push('合同版本无效');
  if (!task.title.trim()) issues.push('缺少任务标题');
  if (!SOCIAL_IMAGE_CONTENT_TYPES.includes(task.imageType)) issues.push('图片类型无效');
  if (!task.contentBrief.coreClaim.trim()) issues.push('缺少核心主张');
  if (!task.contentBrief.productRefs.length) issues.push('至少选择一个企业产品');
  if (!task.deliverySpec.language.trim()) issues.push('缺少内容语言');
  if (task.deliverySpec.outputCount < 1 || task.deliverySpec.outputCount > 10) issues.push('输出数量须为 1–10');
  if (task.imageType === 'gif_poster' && task.deliverySpec.format !== 'gif') issues.push('GIF 动态海报必须输出 GIF');
  if (task.deliverySpec.format === 'gif' && !task.deliverySpec.motion) issues.push('GIF 缺少动效规格');
  if (task.contentBrief.factuality === 'mock' && task.publishable) issues.push('模拟内容不可直接发布');
  if (task.creationPath === 'viral_replication' && task.schemaVersion === 'social-image-creation.v2' && !task.referenceSnapshot) issues.push('爆款复刻缺少参考作品快照');
  const identityBindings = task.enterpriseAssets.filter(asset => asset.role === 'product' || asset.role === 'logo');
  if (task.schemaVersion === 'social-image-creation.v2' && identityBindings.some(asset => !asset.assetId || !asset.source.startsWith('enterprise_'))) issues.push('产品或 Logo 必须绑定企业知识库资产');
  const currentOutputs = socialImageCurrentOutputs(task);
  if (task.status === 'approved' && !socialImageMultiOutputComplete(task, currentOutputs)) issues.push('多图单元或最终动图未全部完成审阅');
  const deliverables = deliverableOutputs(task, currentOutputs);
  const hardChecks = deliverables.flatMap(output => output.qualityChecks).filter(check => check.severity === 'hard');
  const failedHard = hardChecks.some(check => check.verdict !== 'pass' && check.verdict !== 'not_applicable');
  const missingHard = deliverables.length > 0 && deliverables.some(output => SOCIAL_IMAGE_HARD_CHECKS.some(key => !output.qualityChecks.some(check => check.key === key && check.severity === 'hard')));
  if (failedHard && task.publishable) issues.push('硬质量门未全部通过');
  if (missingHard && task.publishable) issues.push('硬质量门结果不完整');
  return issues;
}

export function socialImageTaskCanPublish(task: SocialImageCreationTask): boolean {
  const currentOutputs = socialImageCurrentOutputs(task);
  const deliverables = deliverableOutputs(task, currentOutputs);
  const hardChecksPassed = deliverables.length > 0 && deliverables.every(output => SOCIAL_IMAGE_HARD_CHECKS.every(key => output.qualityChecks.some(check => check.key === key && check.severity === 'hard' && (check.verdict === 'pass' || check.verdict === 'not_applicable'))));
  return task.status === 'approved' && task.contentBrief.factuality !== 'mock' && task.fieldsToConfirm.length === 0 && socialImageTaskIssues({ ...task, publishable: false }).length === 0
    && currentOutputs.length > 0
    && socialImageMultiOutputComplete(task, currentOutputs)
    && deliverables.every(output => output.state === 'approved') && hardChecksPassed;
}
import type { SocialImageLayerGraph } from './socialImageLayerGraph';
