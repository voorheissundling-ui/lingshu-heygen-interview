/** Canonical, optional metadata for material-library production matching. */

export const MATERIAL_ASSET_ROLES_V2 = [
  'exact_product',
  'generic_scene_plate',
  'fact_evidence',
  'person_authorization',
  'digital_human_input',
  'reusable_template',
  'supporting',
] as const;
export type MaterialAssetRoleV2 = typeof MATERIAL_ASSET_ROLES_V2[number];

export const MATERIAL_CONTENT_ROLES_V2 = [
  'product_front',
  'product_side',
  'product_back',
  'product_detail',
  'transparent_cutout',
  'label_artwork',
  'packaging_dieline',
  'scene_plate',
  'fact_evidence',
  'person_authorization',
  'digital_human_portrait',
  'digital_human_voice',
  'other',
] as const;
export type MaterialContentRoleV2 = typeof MATERIAL_CONTENT_ROLES_V2[number];

export type MaterialProductIdentityLevelV2 = 'exact' | 'category' | 'none';

export interface MaterialSegmentCandidateV2 {
  candidateId: string;
  segmentId: string;
  sourceRevision: string;
  startSeconds: number;
  endSeconds: number;
  assetRole: MaterialAssetRoleV2;
  contentRole: MaterialContentRoleV2;
  productIdentityLevel: MaterialProductIdentityLevelV2;
  templateEligible: boolean;
  reuseScore: number;
}

export interface MaterialAssetV2Metadata {
  schemaVersion: 'material-asset.v2';
  assetRole: MaterialAssetRoleV2;
  contentRole: MaterialContentRoleV2;
  productIdentityLevel: MaterialProductIdentityLevelV2;
  /** Tenant-owned reusable material that intentionally has no product binding. */
  enterpriseCommon: boolean;
  /** Stable subjects this asset may satisfy, e.g. scene:warehouse or presenter:alice. */
  subjectRefs: string[];
  sceneType: string | null;
  personProductContact: 'none' | 'incidental' | 'held' | 'used' | null;
  occlusion: 'none' | 'low' | 'medium' | 'high' | null;
  cleanPlate: boolean | null;
  cameraMotion: string | null;
  labelReadability: 'none' | 'low' | 'medium' | 'high' | null;
  templateEligible: boolean;
  reuseScore: number;
  segmentCandidates: MaterialSegmentCandidateV2[];
}

export class MaterialAssetV2ValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MaterialAssetV2ValidationError';
  }
}

const object = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const text = (value: unknown, max = 160): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new MaterialAssetV2ValidationError('material_v2_text_invalid');
  }
  return value.trim();
};

export function normalizeMaterialAssetV2(value: unknown): MaterialAssetV2Metadata {
  const input = object(value);
  if (!input) throw new MaterialAssetV2ValidationError('material_v2_metadata_required');
  const assetRole = String(input.assetRole || 'supporting') as MaterialAssetRoleV2;
  const contentRole = String(input.contentRole || 'other') as MaterialContentRoleV2;
  const productIdentityLevel = String(input.productIdentityLevel || 'none') as MaterialProductIdentityLevelV2;
  if (!MATERIAL_ASSET_ROLES_V2.includes(assetRole)) throw new MaterialAssetV2ValidationError('material_v2_asset_role_invalid');
  if (!MATERIAL_CONTENT_ROLES_V2.includes(contentRole)) throw new MaterialAssetV2ValidationError('material_v2_content_role_invalid');
  if (!['exact', 'category', 'none'].includes(productIdentityLevel)) throw new MaterialAssetV2ValidationError('material_v2_product_identity_invalid');
  if ((assetRole === 'exact_product') !== (productIdentityLevel === 'exact')) {
    throw new MaterialAssetV2ValidationError('material_v2_exact_product_identity_mismatch');
  }
  const reuseScore = input.reuseScore === undefined ? 0 : Number(input.reuseScore);
  if (!Number.isFinite(reuseScore) || reuseScore < 0 || reuseScore > 1) {
    throw new MaterialAssetV2ValidationError('material_v2_reuse_score_invalid');
  }
  const enumOrNull = <T extends string>(raw: unknown, allowed: readonly T[], code: string): T | null => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'string' || !allowed.includes(raw as T)) throw new MaterialAssetV2ValidationError(code);
    return raw as T;
  };
  const boolean = (raw: unknown, fallback: boolean, code: string): boolean => {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw !== 'boolean') throw new MaterialAssetV2ValidationError(code);
    return raw;
  };
  const enterpriseCommon = boolean(input.enterpriseCommon, false, 'material_v2_enterprise_common_invalid')
    || assetRole === 'generic_scene_plate';
  if (enterpriseCommon && productIdentityLevel === 'exact') {
    throw new MaterialAssetV2ValidationError('material_v2_enterprise_common_exact_product_conflict');
  }
  const segmentCandidates = Array.isArray(input.segmentCandidates) ? input.segmentCandidates.map((entry, index) => {
    const segment = object(entry);
    if (!segment) throw new MaterialAssetV2ValidationError('material_v2_segment_invalid');
    const startSeconds = Number(segment.startSeconds);
    const endSeconds = Number(segment.endSeconds);
    const segmentReuse = Number(segment.reuseScore ?? reuseScore);
    const segmentAssetRole = String(segment.assetRole || assetRole) as MaterialAssetRoleV2;
    const segmentContentRole = String(segment.contentRole || contentRole) as MaterialContentRoleV2;
    const segmentIdentity = String(segment.productIdentityLevel || productIdentityLevel) as MaterialProductIdentityLevelV2;
    if (!MATERIAL_ASSET_ROLES_V2.includes(segmentAssetRole)
      || !MATERIAL_CONTENT_ROLES_V2.includes(segmentContentRole)
      || !['exact', 'category', 'none'].includes(segmentIdentity)
      || ((segmentAssetRole === 'exact_product') !== (segmentIdentity === 'exact'))
      || (enterpriseCommon && segmentIdentity === 'exact')
      || !Number.isFinite(startSeconds) || startSeconds < 0
      || !Number.isFinite(endSeconds) || endSeconds <= startSeconds
      || !Number.isFinite(segmentReuse) || segmentReuse < 0 || segmentReuse > 1) {
      throw new MaterialAssetV2ValidationError('material_v2_segment_invalid');
    }
    const segmentId = text(segment.segmentId, 200);
    const sourceRevision = text(segment.sourceRevision, 200);
    const candidateId = text(segment.candidateId, 240) || `${sourceRevision}:${segmentId}:${index}`;
    if (!segmentId || !sourceRevision) throw new MaterialAssetV2ValidationError('material_v2_segment_identity_required');
    return {
      candidateId,
      segmentId,
      sourceRevision,
      startSeconds,
      endSeconds,
      assetRole: segmentAssetRole,
      contentRole: segmentContentRole,
      productIdentityLevel: segmentIdentity,
      templateEligible: boolean(segment.templateEligible, false, 'material_v2_segment_invalid'),
      reuseScore: segmentReuse,
    };
  }) : [];
  if (segmentCandidates.length > 500) throw new MaterialAssetV2ValidationError('material_v2_segments_too_many');
  const subjectRefs = input.subjectRefs === undefined ? [] : input.subjectRefs;
  if (!Array.isArray(subjectRefs) || subjectRefs.length > 100) throw new MaterialAssetV2ValidationError('material_v2_subject_refs_invalid');
  const normalizedSubjectRefs = [...new Set(subjectRefs.map(value => text(value, 240)).filter((value): value is string => Boolean(value)))].sort();
  return {
    schemaVersion: 'material-asset.v2',
    assetRole,
    contentRole,
    productIdentityLevel,
    enterpriseCommon,
    subjectRefs: normalizedSubjectRefs,
    sceneType: text(input.sceneType),
    personProductContact: enumOrNull(input.personProductContact, ['none', 'incidental', 'held', 'used'] as const, 'material_v2_contact_invalid'),
    occlusion: enumOrNull(input.occlusion, ['none', 'low', 'medium', 'high'] as const, 'material_v2_occlusion_invalid'),
    cleanPlate: input.cleanPlate === null || input.cleanPlate === undefined
      ? null : boolean(input.cleanPlate, false, 'material_v2_clean_plate_invalid'),
    cameraMotion: text(input.cameraMotion),
    labelReadability: enumOrNull(input.labelReadability, ['none', 'low', 'medium', 'high'] as const, 'material_v2_label_readability_invalid'),
    templateEligible: boolean(input.templateEligible, false, 'material_v2_template_eligible_invalid'),
    reuseScore,
    segmentCandidates,
  };
}

export function materialAssetV2FromRecord(record: Record<string, unknown>): MaterialAssetV2Metadata | null {
  const provenance = object(record.provenance);
  const candidate = record.materialV2 ?? record.materialAssetV2 ?? provenance?.materialAssetV2;
  if (!candidate) return null;
  try { return normalizeMaterialAssetV2(candidate); } catch { return null; }
}
