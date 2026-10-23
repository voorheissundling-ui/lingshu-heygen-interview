import type { BenchmarkMaterialType } from '../benchmarkAnalysis.js';
import {
  FIXED_YIELD_MATERIAL_RULES,
  FIXED_YIELD_ARCHETYPE_IDS,
  classifyFixedYieldArchetype,
  type FixedYieldArchetypeId,
} from '../fixedYieldMaterialRegistry.js';
import {
  SOCIAL_ENVIRONMENT_KINDS,
  SOCIAL_INTERACTION_KINDS,
  SOCIAL_MATERIAL_ROLES,
  SOCIAL_PRODUCT_USAGE_KINDS,
  type SocialEnvironmentKind,
  type SocialInteractionKind,
  type SocialMaterialRole,
  type SocialProductUsageKind,
  type SocialSceneVisualContract,
} from '../sceneVisualContract.js';

export const LOCAL_MATERIAL_SEGMENT_PROFILE_VERSION = 'fixed-yield-material-segment.v2' as const;

export const LOCAL_MATERIAL_SEGMENT_REJECTION_REASONS = [
  'segment_profile_missing',
  'segment_profile_version_unsupported',
  'tenant_mismatch',
  'local_ownership_missing',
  'asset_identity_missing',
  'segment_identity_missing',
  'source_revision_missing',
  'source_revision_mismatch',
  'non_video_source',
  'synthetic_source',
  'invalid_time_range',
  'material_type_unknown',
  'archetype_unclassified',
  'analysis_confidence_low',
  'human_review_required',
  'rights_evidence_missing',
  'commercial_use_not_allowed',
  'commercial_use_evidence_missing',
  'derivative_use_not_allowed',
  'edit_boundary_unverified',
  'material_type_mismatch',
  'archetype_mismatch',
  'required_material_role_missing',
  'forbidden_material_role_present',
  'product_identity_mismatch',
  'duration_insufficient',
  'required_action_missing',
  'semantic_similarity_insufficient',
  'segment_already_used_in_plan',
] as const;

export type LocalMaterialSegmentRejectionReason = typeof LOCAL_MATERIAL_SEGMENT_REJECTION_REASONS[number];

export interface LocalMaterialSegmentProfile {
  segmentProfileVersion: typeof LOCAL_MATERIAL_SEGMENT_PROFILE_VERSION;
  tenantId: string;
  assetId: string;
  segmentId: string;
  sourceRevision: string;
  startMs: number;
  endMs: number;
  materialType: Exclude<BenchmarkMaterialType, 'unknown'>;
  archetypeCandidates: FixedYieldArchetypeId[];
  materialRoles: SocialMaterialRole[];
  productId: string | null;
  productRef: string | null;
  interactionKind: SocialInteractionKind;
  environmentKind: SocialEnvironmentKind;
  productUsageKind: SocialProductUsageKind;
  observedActionTags: string[];
  framingTags: string[];
  cameraMovementTags: string[];
  entityAndTextTags: string[];
  rightsEvidenceRefs: string[];
  commercialUseApproved: boolean;
  commercialUseApprovalEvidenceRefs: string[];
  modelInputAllowed: boolean;
  derivativeUseAllowed: boolean;
  confidence: number;
  cleanEntry: boolean;
  cleanExit: boolean;
  productionEligible: boolean;
  /** Server-computed; persisted values are never trusted during normalization. */
  rejectionReasons: LocalMaterialSegmentRejectionReason[];
}

export interface LocalMaterialSegmentRejection {
  assetId: string;
  segmentId: string;
  sourceRevision: string | null;
  reasons: LocalMaterialSegmentRejectionReason[];
}

export interface BuildLocalMaterialSegmentProfileInput {
  tenantId: string;
  sourceTenantId: string | null;
  origin: 'my_materials' | 'shared_library';
  assetId: string;
  segmentId: string;
  sourceRevision: string;
  currentSourceRevision?: string | null;
  mediaType: string;
  synthetic: boolean;
  startSeconds: number | null;
  endSeconds: number | null;
  materialType: BenchmarkMaterialType;
  archetypeCandidates?: FixedYieldArchetypeId[];
  materialRoles: SocialMaterialRole[];
  productId: string | null;
  productRef: string | null;
  visualContract: SocialSceneVisualContract;
  observedActionTags?: string[];
  framingTags?: string[];
  cameraMovementTags?: string[];
  entityAndTextTags?: string[];
  rightsEvidenceRefs: string[];
  commercialUseApproved: boolean;
  /** Optional dedicated approval receipts. Existing owned-material callers may
   * use the same immutable receipt for rights and commercial-use approval. */
  commercialUseApprovalEvidenceRefs?: string[];
  modelInputAllowed: boolean;
  derivativeUseAllowed: boolean;
  confidence: number;
  needsReview: boolean;
  cleanEntry: boolean;
  cleanExit: boolean;
}

export interface LocalMaterialSegmentProfileAssessment {
  profile: LocalMaterialSegmentProfile | null;
  rejectionReasons: LocalMaterialSegmentRejectionReason[];
}

const MATERIAL_TYPES = ['talking_head', 'factory', 'product', 'consumer_demo', 'general'] as const;
const REJECTION_REASON_SET = new Set<string>(LOCAL_MATERIAL_SEGMENT_REJECTION_REASONS);

function text(value: unknown, maximum = 300): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, maximum) : '';
}

function list(value: unknown, maximum = 48): string[] {
  const values = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(values.map(item => text(item, 160)).filter(Boolean))].slice(0, maximum);
}

function reasons(value: unknown): LocalMaterialSegmentRejectionReason[] {
  return list(value).filter(item => REJECTION_REASON_SET.has(item)) as LocalMaterialSegmentRejectionReason[];
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedProduct(value: unknown): string {
  return text(value).toLocaleLowerCase().replace(/^product:/, '');
}

export function usableLocalMaterialRightsEvidence(values: unknown): string[] {
  return list(values).filter(value => !/(?:unverified|unknown|missing|pending|待确认|未确认)/i.test(value));
}

export function inferLocalMaterialSegmentType(input: {
  materialRoles: SocialMaterialRole[];
  visualContract: SocialSceneVisualContract;
}): BenchmarkMaterialType {
  if (input.materialRoles.includes('presenter')) return 'talking_head';
  if (input.materialRoles.includes('factory')) return 'factory';
  // A hand acting only as the product holder is the P2A product archetype,
  // not a D2C usage claim. P4 requires an observed use/application action.
  if (input.materialRoles.includes('product')
    && (input.visualContract.interaction.kind === 'person_holding_product'
      || (input.visualContract.productUsage.kind === 'hold'
        && !['person_using_product', 'apply_product_to_face'].includes(input.visualContract.interaction.kind)))) return 'product';
  if (input.materialRoles.includes('person_usage')
    || ['person_using_product', 'apply_product_to_face'].includes(input.visualContract.interaction.kind)
    || ['open_close', 'dispense', 'apply_to_face', 'apply_to_hand', 'result_display'].includes(input.visualContract.productUsage.kind)) {
    return 'consumer_demo';
  }
  if (input.materialRoles.includes('product')) return 'product';
  if (input.materialRoles.some(role => ['customer_case', 'environment', 'general'].includes(role))) return 'general';
  return 'unknown';
}

function structuralRejections(profile: Omit<LocalMaterialSegmentProfile, 'productionEligible' | 'rejectionReasons'>): LocalMaterialSegmentRejectionReason[] {
  const result: LocalMaterialSegmentRejectionReason[] = [];
  if (!profile.tenantId) result.push('tenant_mismatch');
  if (!profile.assetId) result.push('asset_identity_missing');
  if (!profile.segmentId) result.push('segment_identity_missing');
  if (!profile.sourceRevision) result.push('source_revision_missing');
  if (!(Number.isSafeInteger(profile.startMs) && Number.isSafeInteger(profile.endMs) && profile.startMs >= 0 && profile.endMs > profile.startMs)) {
    result.push('invalid_time_range');
  }
  if (!profile.archetypeCandidates.length) result.push('archetype_unclassified');
  if (profile.confidence < 0.6) result.push('analysis_confidence_low');
  if (!profile.rightsEvidenceRefs.length) result.push('rights_evidence_missing');
  if (!profile.commercialUseApproved) result.push('commercial_use_not_allowed');
  if (!profile.commercialUseApprovalEvidenceRefs.length) result.push('commercial_use_evidence_missing');
  if (!profile.derivativeUseAllowed) result.push('derivative_use_not_allowed');
  if (!profile.cleanEntry || !profile.cleanExit) result.push('edit_boundary_unverified');
  return [...new Set(result)];
}

export function buildLocalMaterialSegmentProfile(input: BuildLocalMaterialSegmentProfileInput): LocalMaterialSegmentProfileAssessment {
  const assetId = text(input.assetId);
  const segmentId = text(input.segmentId);
  const sourceRevision = text(input.sourceRevision);
  const tenantId = text(input.tenantId);
  const sourceTenantId = text(input.sourceTenantId);
  const startSeconds = finite(input.startSeconds);
  const endSeconds = finite(input.endSeconds);
  const archetype = input.materialType === 'unknown' ? null : classifyFixedYieldArchetype({
    materialType: input.materialType,
    visual: input.visualContract,
    description: [...(input.observedActionTags ?? []), ...(input.entityAndTextTags ?? [])].join(' '),
  });
  const archetypeCandidates = [...new Set([...(input.archetypeCandidates ?? []), ...(archetype ? [archetype] : [])])]
    .filter(item => FIXED_YIELD_ARCHETYPE_IDS.includes(item));
  const rejectionReasons: LocalMaterialSegmentRejectionReason[] = [];
  if (!assetId) rejectionReasons.push('asset_identity_missing');
  if (!segmentId) rejectionReasons.push('segment_identity_missing');
  if (!sourceRevision) rejectionReasons.push('source_revision_missing');
  if (input.currentSourceRevision && sourceRevision !== text(input.currentSourceRevision)) rejectionReasons.push('source_revision_mismatch');
  if (!tenantId || sourceTenantId !== tenantId) rejectionReasons.push('tenant_mismatch');
  if (input.origin !== 'my_materials') rejectionReasons.push('local_ownership_missing');
  if (text(input.mediaType) !== 'video') rejectionReasons.push('non_video_source');
  if (input.synthetic) rejectionReasons.push('synthetic_source');
  if (startSeconds === null || endSeconds === null || startSeconds < 0 || endSeconds <= startSeconds) rejectionReasons.push('invalid_time_range');
  if (input.materialType === 'unknown') rejectionReasons.push('material_type_unknown');
  if (!archetypeCandidates.length) rejectionReasons.push('archetype_unclassified');
  if (!Number.isFinite(input.confidence) || input.confidence < 0.6) rejectionReasons.push('analysis_confidence_low');
  if (input.needsReview) rejectionReasons.push('human_review_required');
  const rightsEvidenceRefs = usableLocalMaterialRightsEvidence(input.rightsEvidenceRefs);
  const commercialUseApprovalEvidenceRefs = input.commercialUseApproved
    ? usableLocalMaterialRightsEvidence(input.commercialUseApprovalEvidenceRefs?.length
      ? input.commercialUseApprovalEvidenceRefs : rightsEvidenceRefs)
    : [];
  if (!rightsEvidenceRefs.length) rejectionReasons.push('rights_evidence_missing');
  if (!input.commercialUseApproved) rejectionReasons.push('commercial_use_not_allowed');
  if (!commercialUseApprovalEvidenceRefs.length) rejectionReasons.push('commercial_use_evidence_missing');
  if (!input.derivativeUseAllowed) rejectionReasons.push('derivative_use_not_allowed');
  if (!input.cleanEntry || !input.cleanExit) rejectionReasons.push('edit_boundary_unverified');
  if (input.materialType === 'unknown' || startSeconds === null || endSeconds === null) {
    return { profile: null, rejectionReasons: [...new Set(rejectionReasons)] };
  }
  const base: Omit<LocalMaterialSegmentProfile, 'productionEligible' | 'rejectionReasons'> = {
    segmentProfileVersion: LOCAL_MATERIAL_SEGMENT_PROFILE_VERSION,
    tenantId,
    assetId,
    segmentId,
    sourceRevision,
    startMs: Math.round(startSeconds * 1000),
    endMs: Math.round(endSeconds * 1000),
    materialType: input.materialType,
    archetypeCandidates,
    materialRoles: [...new Set(input.materialRoles.filter(role => SOCIAL_MATERIAL_ROLES.includes(role)))],
    productId: text(input.productId) || null,
    productRef: text(input.productRef) || null,
    interactionKind: input.visualContract.interaction.kind,
    environmentKind: input.visualContract.environment.kind,
    productUsageKind: input.visualContract.productUsage.kind,
    observedActionTags: list(input.observedActionTags),
    framingTags: list(input.framingTags),
    cameraMovementTags: list(input.cameraMovementTags),
    entityAndTextTags: list(input.entityAndTextTags),
    rightsEvidenceRefs,
    commercialUseApproved: input.commercialUseApproved === true,
    commercialUseApprovalEvidenceRefs,
    modelInputAllowed: input.modelInputAllowed,
    derivativeUseAllowed: input.derivativeUseAllowed,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    cleanEntry: input.cleanEntry,
    cleanExit: input.cleanExit,
  };
  const allReasons = [...new Set([...rejectionReasons, ...structuralRejections(base)])];
  return { profile: { ...base, productionEligible: allReasons.length === 0, rejectionReasons: allReasons }, rejectionReasons: allReasons };
}

export function normalizeLocalMaterialSegmentProfile(value: unknown): LocalMaterialSegmentProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.segmentProfileVersion !== LOCAL_MATERIAL_SEGMENT_PROFILE_VERSION) return null;
  const materialType = text(row.materialType);
  const interactionKind = text(row.interactionKind);
  const environmentKind = text(row.environmentKind);
  const productUsageKind = text(row.productUsageKind);
  const startMs = finite(row.startMs);
  const endMs = finite(row.endMs);
  const confidence = finite(row.confidence);
  if (!MATERIAL_TYPES.includes(materialType as typeof MATERIAL_TYPES[number])
    || !SOCIAL_INTERACTION_KINDS.includes(interactionKind as SocialInteractionKind)
    || !SOCIAL_ENVIRONMENT_KINDS.includes(environmentKind as SocialEnvironmentKind)
    || !SOCIAL_PRODUCT_USAGE_KINDS.includes(productUsageKind as SocialProductUsageKind)
    || startMs === null || endMs === null || confidence === null) return null;
  const base: Omit<LocalMaterialSegmentProfile, 'productionEligible' | 'rejectionReasons'> = {
    segmentProfileVersion: LOCAL_MATERIAL_SEGMENT_PROFILE_VERSION,
    tenantId: text(row.tenantId),
    assetId: text(row.assetId),
    segmentId: text(row.segmentId),
    sourceRevision: text(row.sourceRevision),
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    materialType: materialType as Exclude<BenchmarkMaterialType, 'unknown'>,
    archetypeCandidates: list(row.archetypeCandidates).filter(item => FIXED_YIELD_ARCHETYPE_IDS.includes(item as FixedYieldArchetypeId)) as FixedYieldArchetypeId[],
    materialRoles: list(row.materialRoles).filter(item => SOCIAL_MATERIAL_ROLES.includes(item as SocialMaterialRole)) as SocialMaterialRole[],
    productId: text(row.productId) || null,
    productRef: text(row.productRef) || null,
    interactionKind: interactionKind as SocialInteractionKind,
    environmentKind: environmentKind as SocialEnvironmentKind,
    productUsageKind: productUsageKind as SocialProductUsageKind,
    observedActionTags: list(row.observedActionTags),
    framingTags: list(row.framingTags),
    cameraMovementTags: list(row.cameraMovementTags),
    entityAndTextTags: list(row.entityAndTextTags),
    rightsEvidenceRefs: usableLocalMaterialRightsEvidence(row.rightsEvidenceRefs),
    commercialUseApproved: row.commercialUseApproved === true,
    commercialUseApprovalEvidenceRefs: usableLocalMaterialRightsEvidence(row.commercialUseApprovalEvidenceRefs),
    modelInputAllowed: row.modelInputAllowed === true,
    derivativeUseAllowed: row.derivativeUseAllowed === true,
    confidence: Math.max(0, Math.min(1, confidence)),
    cleanEntry: row.cleanEntry === true,
    cleanExit: row.cleanExit === true,
  };
  const rejectionReasons = [...new Set([...reasons(row.rejectionReasons), ...structuralRejections(base)])];
  return { ...base, productionEligible: rejectionReasons.length === 0, rejectionReasons };
}

export function evaluateLocalMaterialSegmentProfile(input: {
  profile: LocalMaterialSegmentProfile | null | undefined;
  tenantId: string;
  assetId: string;
  segmentId: string;
  sourceRevision?: string | null;
  targetMaterialType: Exclude<BenchmarkMaterialType, 'unknown'>;
  targetArchetypeId: FixedYieldArchetypeId;
  requestedProductRef?: string | null;
  requiredDurationSeconds: number;
  alreadyUsed?: boolean;
}): LocalMaterialSegmentRejectionReason[] {
  const profile = input.profile ? normalizeLocalMaterialSegmentProfile(input.profile) : null;
  if (!profile) return ['segment_profile_missing'];
  const result = [...profile.rejectionReasons];
  if (profile.tenantId !== text(input.tenantId) || profile.assetId !== text(input.assetId)
    || profile.segmentId !== text(input.segmentId)) result.push('tenant_mismatch');
  if (input.sourceRevision && profile.sourceRevision !== text(input.sourceRevision)) result.push('source_revision_mismatch');
  if (profile.materialType !== input.targetMaterialType) result.push('material_type_mismatch');
  if (!profile.archetypeCandidates.includes(input.targetArchetypeId)) result.push('archetype_mismatch');
  const targetRule = FIXED_YIELD_MATERIAL_RULES[input.targetArchetypeId];
  if (!targetRule.requiredAnyRoles.some(role => profile.materialRoles.includes(role))) result.push('required_material_role_missing');
  if (targetRule.forbiddenRoles.some(role => profile.materialRoles.includes(role))) result.push('forbidden_material_role_present');
  const requested = normalizedProduct(input.requestedProductRef);
  if (targetRule.productIdentity === 'same_product' && !requested) result.push('product_identity_mismatch');
  if (requested && targetRule.productIdentity === 'same_product') {
    const candidateRefs = [profile.productId, profile.productRef].map(normalizedProduct).filter(Boolean);
    if (!candidateRefs.includes(requested)) result.push('product_identity_mismatch');
  }
  if (profile.endMs - profile.startMs + 1 < input.requiredDurationSeconds * 1000) result.push('duration_insufficient');
  if (input.alreadyUsed) result.push('segment_already_used_in_plan');
  return [...new Set(result)];
}
