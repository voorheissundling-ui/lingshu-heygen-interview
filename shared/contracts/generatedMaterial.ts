import type {WeeklyAssetRequirement} from '../weeklyAutomaticMaterial.js';
export const PRODUCTION_PIPELINE_IDS = [
  'material_processing', 'digital_human_1', 'digital_human_2', 'digital_human_3',
  'non_person_generation', 'shooting_plan',
] as const;
export type ProductionPipelineId = typeof PRODUCTION_PIPELINE_IDS[number];

export const ASSET_GENERATION_KINDS = [
  'digital_human', 'product_scene', 'concept_visual', 'motion_graphics', 'final_video',
] as const;
export type AssetGenerationKind = typeof ASSET_GENERATION_KINDS[number];

export const GENERATED_ASSET_STATES = [
  'draft', 'planned', 'preflight_passed', 'submitting', 'provider_pending', 'generated',
  'quality_checking', 'accepted', 'repair_required', 'failed', 'uncertain', 'archived', 'adopted',
] as const;
export type GeneratedAssetState = typeof GENERATED_ASSET_STATES[number];
export type GeneratedAssetQualityState = 'accepted' | 'repair_required' | 'failed';
export type GeneratedAssetCheckStatus = 'passed' | 'failed' | 'unavailable';

export interface GeneratedAssetQualityCheck {
  key: string;
  status: GeneratedAssetCheckStatus;
  evidence: string;
}

export interface GeneratedAssetQuality {
  state: GeneratedAssetQualityState;
  checks: GeneratedAssetQualityCheck[];
  checkedAt: string;
  policyVersion: string;
  /** Keeps a pipeline-specific report available without making it the shared contract. */
  rawReport?: unknown;
}

export interface GeneratedAssetGeneration {
  pipelineId: ProductionPipelineId;
  assetGenerationKind: AssetGenerationKind;
  pipelineVersion: string;
  executionId: string;
  provider: string;
  model: string;
  providerTaskId?: string;
  idempotencyKey: string;
  inputFingerprint: string;
  promptOrSpecHash: string;
  inputMaterialIds: string[];
  estimatedCostCny?: number;
  actualCostCny?: number;
}

export interface GeneratedAssetLineage {
  sourceTaskId?: string;
  sourceProjectId?: string;
  sourceAssemblyId?: string;
  sourceShotId?: string;
}

export interface GeneratedAssetReuse {
  eligible: boolean;
  reason: string;
  usageCount: number;
  lastUsedAt?: string;
}

export interface GeneratedMaterialMetadata {
  generation: GeneratedAssetGeneration;
  lineage: GeneratedAssetLineage;
  quality: GeneratedAssetQuality;
  reuse: GeneratedAssetReuse;
  rightsScope: string;
}

export interface GeneratedAssetArchiveInput {
  automaticMaterial?: {requirement:WeeklyAssetRequirement;independentVisualCheckRef:string;rightsEvidenceRef:string;authorizationScopes:string[]};
  tenantId: string;
  name?: string;
  media: {
    type: 'video' | 'image' | 'audio';
    localPath?: string;
    objectKey?: string;
    mimeType: string;
    duration?: number;
    width?: number;
    height?: number;
    contentSha256: string;
  };
  generation: GeneratedAssetGeneration;
  lineage: GeneratedAssetLineage;
  quality: GeneratedAssetQuality;
  rightsScope: string;
}

export interface ShotMaterialReference {
  materialId: string;
  materialRevision: string;
  generationExecutionId?: string;
  adoptedAt: string;
}

export function qualityAllowsReuse(quality: GeneratedAssetQuality): boolean {
  return quality.state === 'accepted'
    && quality.checks.length > 0
    && quality.checks.every(check => check.status === 'passed');
}

export function assertGeneratedMaterialMetadata(value: GeneratedMaterialMetadata): void {
  const generation = value?.generation;
  if (!PRODUCTION_PIPELINE_IDS.includes(generation?.pipelineId)) throw new Error('生成素材管线无效');
  if (!ASSET_GENERATION_KINDS.includes(generation?.assetGenerationKind)) throw new Error('生成素材类型无效');
  for (const [key, field] of Object.entries({ pipelineVersion: generation.pipelineVersion, executionId: generation.executionId,
    provider: generation.provider, model: generation.model, idempotencyKey: generation.idempotencyKey,
    inputFingerprint: generation.inputFingerprint, promptOrSpecHash: generation.promptOrSpecHash, rightsScope: value.rightsScope })) {
    if (!String(field || '').trim()) throw new Error(`生成素材缺少 ${key}`);
  }
  if (!Array.isArray(generation.inputMaterialIds)) throw new Error('生成素材输入引用无效');
  if (!['accepted', 'repair_required', 'failed'].includes(value.quality?.state)) throw new Error('生成素材质量状态无效');
  if (!Array.isArray(value.quality?.checks)) throw new Error('生成素材质量检查无效');
  if (value.quality.state === 'accepted' && !qualityAllowsReuse(value.quality)) throw new Error('自动证据不完整，生成素材不能标记为 accepted');
  if (value.reuse?.eligible && !qualityAllowsReuse(value.quality)) throw new Error('未通过质量门禁的素材不能复用');
}
