import type {
  AssetGenerationKind, GeneratedAssetQuality, GeneratedAssetState, GeneratedMaterialMetadata,
  ProductionPipelineId,
} from '../../shared/contracts/generatedMaterial.js';
export type { AssetGenerationKind } from '../../shared/contracts/generatedMaterial.js';

export type GeneratedMaterialKindFilter = 'all' | AssetGenerationKind;
export const GENERATED_MATERIAL_KIND_FILTERS: ReadonlyArray<{ id: GeneratedMaterialKindFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'digital_human', label: '数字人' },
  { id: 'product_scene', label: '产品场景' },
  { id: 'concept_visual', label: '概念画面' },
  { id: 'motion_graphics', label: '动态图文' },
  { id: 'final_video', label: '完整成片' },
];

// Material records currently come from several independently evolved models.
// Keep this compatibility boundary permissive; the returned projection is the
// strongly typed contract consumed by new code.
type MaterialLike = any;
const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => String(value || '').trim();

const LEGACY_KIND_RULES: Array<[RegExp, AssetGenerationKind]> = [
  [/heygen|digital[-_ ]?human|photo[-_ ]?talking|viral[-_ ]?sentence[-_ ]?replication|target[-_ ]?first[-_ ]?frame/i, 'digital_human'],
  [/motion[-_ ]?graphic|dynamic[-_ ]?text|fact[-_ ]?card|local[-_ ]?graphic/i, 'motion_graphics'],
  [/final[-_ ]?(?:video|render)|social[-_ ]?final|assembled[-_ ]?video/i, 'final_video'],
];

function legacyKind(material: MaterialLike): AssetGenerationKind | null {
  const provenance = recordOf(material.provenance);
  const source = [material.sourceType, material.sourceProvider, provenance.sourceChannel, provenance.sourceEntry,
    provenance.provider].map(text).join(' ');
  for (const [rule, kind] of LEGACY_KIND_RULES) if (rule.test(source)) return kind;
  if (recordOf(provenance.productSceneSpec).schemaVersion || recordOf(material.productSceneSpec).schemaVersion) return 'product_scene';
  if (/seedance|seedream|gemini|qwen|aigc|ai[-_ ]?generated|generation/i.test(source)) return 'concept_visual';
  return null;
}

function legacyPipeline(material: MaterialLike, kind: AssetGenerationKind): ProductionPipelineId {
  const source = [material.sourceType, recordOf(material.provenance).sourceChannel].map(text).join(' ');
  if (kind !== 'digital_human') return 'non_person_generation';
  if (/viral[-_ ]?sentence|pipeline.?3/i.test(source)) return 'digital_human_3';
  if (/replace|reenact|runway|act.?two|fast.?head/i.test(source)) return 'digital_human_2';
  return 'digital_human_1';
}

function projectedQuality(material: MaterialLike): GeneratedAssetQuality {
  const explicit = recordOf(material.quality);
  const explicitState = text(explicit.state);
  const accepted = explicitState === 'accepted' && Array.isArray(explicit.checks)
    && explicit.checks.length > 0 && explicit.checks.every(item => recordOf(item).status === 'passed');
  return accepted ? explicit as unknown as GeneratedAssetQuality : {
    state: explicitState === 'failed' ? 'failed' : 'repair_required', checks: [],
    checkedAt: text(explicit.checkedAt || material.updatedAt || material.createdAt) || new Date(0).toISOString(),
    policyVersion: text(explicit.policyVersion) || 'legacy-projection.v1',
    rawReport: explicit.rawReport || material.quality || material.pipeline3Quality,
  };
}

/** Read-only compatibility view. It never writes inferred fields back to a legacy record. */
export function projectGeneratedMaterial(material: MaterialLike): GeneratedMaterialMetadata | null {
  const generation = recordOf(material.generation);
  if (generation.pipelineId && generation.assetGenerationKind) {
    const quality = recordOf(material.quality) as unknown as GeneratedAssetQuality;
    return {
      generation: generation as unknown as GeneratedMaterialMetadata['generation'],
      lineage: recordOf(material.lineage), quality,
      reuse: recordOf(material.reuse) as unknown as GeneratedMaterialMetadata['reuse'],
      rightsScope: text(material.rightsScope) || 'tenant_private',
    };
  }
  const kind = legacyKind(material);
  if (!kind) return null;
  const provenance = recordOf(material.provenance);
  const id = text(material.id) || 'unknown';
  const quality = projectedQuality(material);
  return {
    generation: {
      pipelineId: legacyPipeline(material, kind), assetGenerationKind: kind,
      pipelineVersion: 'legacy-projection.v1', executionId: text(provenance.executionId || material.sourceExecutionId) || `legacy:${id}`,
      provider: text(material.sourceProvider || provenance.provider || material.sourceType) || 'legacy', model: text(material.providerModel || provenance.model) || 'unknown',
      providerTaskId: text(material.providerTaskId || provenance.providerTaskId) || undefined,
      idempotencyKey: text(material.idempotencyKey || provenance.idempotencyKey) || `legacy:${id}`,
      inputFingerprint: text(material.inputFingerprint || provenance.inputFingerprint || material.contentSha256) || `legacy:${id}`,
      promptOrSpecHash: text(material.promptOrSpecHash || provenance.promptOrSpecHash) || `legacy:${id}`,
      inputMaterialIds: Array.isArray(material.inputMaterialIds) ? material.inputMaterialIds.map(text).filter(Boolean) : [],
    },
    lineage: {
      sourceTaskId: text(provenance.sourceTaskId || material.sourceTaskId) || undefined,
      sourceProjectId: text(provenance.projectId || material.sourceProjectId) || undefined,
      sourceAssemblyId: text(provenance.assemblyId || material.sourceAssemblyId) || undefined,
      sourceShotId: text(provenance.shotId || material.sourceShotId) || undefined,
    },
    quality,
    reuse: { eligible: quality.state === 'accepted', reason: quality.state === 'accepted' ? 'quality_accepted' : 'legacy_quality_evidence_incomplete', usageCount: Number(material.usageCount || 0) || 0 },
    rightsScope: text(material.rightsScope) || 'tenant_private',
  };
}

export function isMyGeneratedMaterial(material: MaterialLike, tenantId?: string): boolean {
  const owner = text(material.tenantId || material.tenant_id);
  return material.scope === 'own' && (!tenantId || owner === tenantId) && projectGeneratedMaterial(material) !== null;
}

export function projectGeneratedAssetState(material: MaterialLike): GeneratedAssetState {
  const normalized = text(material.generationState || material.status).toLowerCase();
  if (['draft', 'planned', 'preflight_passed', 'submitting', 'provider_pending', 'generated', 'quality_checking',
    'accepted', 'repair_required', 'failed', 'uncertain', 'archived', 'adopted'].includes(normalized)) return normalized as GeneratedAssetState;
  if (normalized === 'pending' || normalized === 'processing') return 'provider_pending';
  const metadata = projectGeneratedMaterial(material);
  if ((normalized === 'completed' || normalized === 'ready') && metadata) return metadata.quality.state === 'accepted' ? 'archived' : 'repair_required';
  if (!metadata) return 'draft';
  return metadata.quality.state === 'accepted' ? 'archived' : metadata.quality.state;
}

export function filterMyGeneratedMaterials(materials: MaterialLike[], input: {
  tenantId?: string; assetGenerationKind?: AssetGenerationKind; qualityState?: GeneratedAssetQuality['state']; reusableOnly?: boolean;
} = {}): MaterialLike[] {
  return materials.filter(material => {
    if (!isMyGeneratedMaterial(material, input.tenantId)) return false;
    const metadata = projectGeneratedMaterial(material)!;
    return (!input.assetGenerationKind || metadata.generation.assetGenerationKind === input.assetGenerationKind)
      && (!input.qualityState || metadata.quality.state === input.qualityState)
      && (!input.reusableOnly || metadata.reuse.eligible);
  });
}

export function generatedMaterialKindLabel(material: MaterialLike): string | null {
  const kind = projectGeneratedMaterial(material)?.generation.assetGenerationKind;
  return GENERATED_MATERIAL_KIND_FILTERS.find(item => item.id === kind)?.label || null;
}

export function matchesGeneratedMaterialKind(material: MaterialLike, filter: GeneratedMaterialKindFilter): boolean {
  return filterMyGeneratedMaterials([material], {
    assetGenerationKind: filter === 'all' ? undefined : filter,
  }).length === 1;
}
