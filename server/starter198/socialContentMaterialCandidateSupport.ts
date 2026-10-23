import { buildLocalMaterialSegmentProfile, inferLocalMaterialSegmentType, usableLocalMaterialRightsEvidence,
  type LocalMaterialSegmentProfile, type LocalMaterialSegmentRejectionReason } from '../../shared/contracts/localMaterialSegmentProfile.js';
import type { SocialProductFootageEvidenceBinding, SocialShotFunction } from '../../shared/contracts/socialContentReplication.js';
import { materialAssetV2FromRecord } from '../../shared/contracts/materialAssetV2.js';
import { buildMaterialScriptAnalysis, type MaterialScriptAnalysis, type MaterialScriptShot } from '../../shared/materialScriptAnalysis.js';
import type { SocialMaterialRole } from '../../shared/sceneVisualContract.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import { isSyntheticMaterial } from '../lib/materialTruthfulness.js';
import { materialTenantId } from './socialContentProductionMaterials.js';
import { socialObject, socialText } from './socialContentValidation.js';
import type { SocialWorkflowMaterialCandidate } from './socialContentAgentWorkflow.js';

export interface SocialWorkflowMaterialClipCandidate extends SocialWorkflowMaterialCandidate {
  synthetic?: boolean;
  segmentId: string;
  footageEvidence?: SocialProductFootageEvidenceBinding;
  productId: string | null;
  productRef: string | null;
  enterpriseCommon: boolean;
  productPolicy: import('../../shared/sceneVisualContract.js').SocialProductPolicy;
  materialRoles: SocialMaterialRole[];
  visualContract: import('../../shared/sceneVisualContract.js').SocialSceneVisualContract;
  timeRange: { startSeconds: number; endSeconds: number } | null;
  segmentProfile: LocalMaterialSegmentProfile | null;
  segmentProfileRejectionReasons: LocalMaterialSegmentRejectionReason[];
  segmentCandidateId: string;
  sourceRevision: string;
}

export interface SocialWorkflowMaterialCandidateSet {
  candidates: SocialWorkflowMaterialClipCandidate[];
  rejectedSegments: import('../../shared/contracts/localMaterialSegmentProfile.js').LocalMaterialSegmentRejection[];
  productPolicy: import('../../shared/sceneVisualContract.js').SocialProductPolicy;
  requestedProductId: string | null;
  requestedProductRef: string | null;
}

export function assetSupplyShotFunction(value: string, index: number, total: number): SocialShotFunction {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase();
  if (/hook|开场|吸引/.test(normalized)) return 'hook';
  if (/problem|痛点|问题/.test(normalized)) return 'problem';
  if (/proof|证据|证明|质量|结果/.test(normalized)) return 'proof';
  if (/trust|信任|背书/.test(normalized)) return 'trust';
  if (/transition|转场|衔接/.test(normalized)) return 'transition';
  if (/call[_\s-]?to[_\s-]?action|cta|行动|收束|结尾|交付/.test(normalized) || index === total - 1) return 'call_to_action';
  if (/demonstration|演示|展示|过程|步骤|操作|使用/.test(normalized)) return 'demonstration';
  return 'value';
}

export function materialProductIdentity(record: MaterialRecord, preferredRef?: string | null): {
  productId: string | null; productRef: string | null;
} {
  const productId = socialText(record.productId || record.product_id) || null;
  if (!productId && materialIsEnterpriseCommon(record)) return { productId: null, productRef: null };
  const refs = [record.productName, record.productRef, ...(!productId && Array.isArray(record.productRefs) ? record.productRefs : [])]
    .map(socialText).filter(Boolean);
  const requested = socialText(preferredRef).normalize('NFKC').toLocaleLowerCase();
  return { productId, productRef: (requested ? refs.find(value => value.normalize('NFKC').toLocaleLowerCase() === requested) : '') || refs[0] || null };
}

export function materialIsEnterpriseCommon(record: MaterialRecord): boolean {
  const tags = socialText(record.tags).split(/[,，]/).map(value => value.trim().toLocaleLowerCase());
  const materialV2 = materialAssetV2FromRecord(record);
  return record.enterpriseCommon === true || record.enterprise_common === true || record.isEnterpriseCommon === true
    || ['enterprise_common', 'company_common'].includes(socialText(record.materialScope || record.material_scope))
    || tags.includes('enterprise_common') || materialV2?.enterpriseCommon === true || materialV2?.assetRole === 'generic_scene_plate';
}

export function analyzedMaterialShots(record: MaterialRecord): MaterialScriptShot[] {
  const stored = socialObject(record.scriptAnalysis) as (Partial<MaterialScriptAnalysis> & Record<string, unknown>) | null;
  if (stored?.status === 'ready' && Array.isArray(stored.shots)) {
    return stored.shots.flatMap(shot => {
      const row = socialObject(shot);
      return !row || !row.visualContract || !Array.isArray(row.materialRoles) ? [] : [shot as MaterialScriptShot];
    });
  }
  const segments = Array.isArray(record.segments) ? record.segments : [];
  if (socialText(record.type) === 'video' && segments.length === 0) return [];
  const duration = Number(record.duration);
  const segmentEnd = Math.max(0, ...segments.map(segment => Number(socialObject(segment)?.end ?? socialObject(segment)?.endTime ?? 0)).filter(Number.isFinite));
  return buildMaterialScriptAnalysis({ materialId: socialText(record.id), name: socialText(record.name || record.title) || '未命名素材',
    sourceRevision: socialText(record.analysisSourceRevision || record.sourceRevision || record.updatedAt) || `material:${socialText(record.id)}`,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : segmentEnd, segments,
    visualObservations: [record.visualObservations, record.observations]
      .flatMap(value => Array.isArray(value) ? value : [value]).map(socialText).filter(Boolean),
    ...materialProductIdentity(record) }).shots;
}

export function sameProduct(candidate: { productId: string | null; productRef: string | null }, requested: {
  productId: string | null; productRef: string | null;
}): boolean {
  if (candidate.productId && requested.productId && candidate.productId === requested.productId) return true;
  const candidateRef = socialText(candidate.productRef).normalize('NFKC').toLocaleLowerCase();
  const requestedRef = socialText(requested.productRef).normalize('NFKC').toLocaleLowerCase();
  return Boolean(candidateRef && requestedRef && candidateRef === requestedRef);
}

function materialRightsEvidenceRefs(record: MaterialRecord): string[] {
  return usableLocalMaterialRightsEvidence([record.rightsEvidenceRef, record.licenseEvidence, record.consentRef,
    ...(Array.isArray(record.rightsEvidenceRefs) ? record.rightsEvidenceRefs : []), record.provenance?.rightsEvidenceRef,
    record.provenance?.authorizationRef]);
}

function materialSourceRevision(record: MaterialRecord): { analysis: string; current: string } {
  const stored = socialObject(record.scriptAnalysis);
  const analysis = socialText(stored?.sourceRevision) || socialText(record.analysisSourceRevision)
    || socialText(record.sourceRevision) || `material:${socialText(record.id)}`;
  const current = socialText(record.analysisSourceRevision) || socialText(record.sourceRevision)
    || socialText(record.contentSha256) || socialText(record.sha256) || analysis;
  return { analysis, current };
}

export function buildMaterialSegmentProfile(input: { record: MaterialRecord; shot: MaterialScriptShot; tenantId: string;
  assetId: string; mediaType: 'video' | 'image'; materialRoles: SocialMaterialRole[];
  identity: { productId: string | null; productRef: string | null };
}): ReturnType<typeof buildLocalMaterialSegmentProfile> {
  const sourceTenantId = materialTenantId(input.record);
  const origin = sourceTenantId === input.tenantId ? 'my_materials' as const : 'shared_library' as const;
  const sourceRevision = materialSourceRevision(input.record);
  const rightsStatus = socialText(input.record.rightsStatus).toLocaleLowerCase();
  const commercialUseApproved = input.record.commercialUseApproved === true;
  const derivativeUseAllowed = input.record.derivativeUseAllowed === true || input.record.derivativesApproved === true
    || (origin === 'my_materials' && commercialUseApproved && ['owned', 'authorized'].includes(rightsStatus));
  const authorizationScopes: string[] = Array.isArray(input.record.provenance?.authorizationScopes)
    ? input.record.provenance.authorizationScopes.map(socialText) : [];
  const modelInputAllowed = input.record.modelInputAllowed === true
    || (input.record.rawLibraryUseApproved === true && authorizationScopes.some(scope => /model|provider|enterprise-video/i.test(scope)));
  const shot = input.shot;
  return buildLocalMaterialSegmentProfile({ tenantId: input.tenantId, sourceTenantId: sourceTenantId || null, origin,
    assetId: input.assetId, segmentId: shot.segmentId, sourceRevision: sourceRevision.analysis,
    currentSourceRevision: sourceRevision.current, mediaType: input.mediaType, synthetic: isSyntheticMaterial(input.record),
    startSeconds: Number.isFinite(shot.startSeconds) ? shot.startSeconds : null,
    endSeconds: Number.isFinite(shot.endSeconds) ? shot.endSeconds : null,
    materialType: inferLocalMaterialSegmentType({ materialRoles: input.materialRoles, visualContract: shot.visualContract }),
    materialRoles: input.materialRoles, productId: input.identity.productId, productRef: input.identity.productRef,
    visualContract: shot.visualContract,
    observedActionTags: [...shot.editorial.actions, shot.visualContract.action.path, shot.visualContract.action.startState,
      shot.visualContract.action.peakState, shot.visualContract.action.endState],
    framingTags: [...shot.editorial.shotLanguage, shot.visualContract.camera.shotSize, shot.visualContract.camera.angle,
      shot.visualContract.camera.composition], cameraMovementTags: [shot.visualContract.camera.movement],
    entityAndTextTags: [...shot.editorial.subjects, ...shot.observedEvidence, ...shot.matchTags],
    rightsEvidenceRefs: materialRightsEvidenceRefs(input.record), commercialUseApproved, modelInputAllowed, derivativeUseAllowed,
    confidence: shot.confidence, needsReview: shot.needsReview, cleanEntry: shot.editorial.trim.cleanEntry,
    cleanExit: shot.editorial.trim.cleanExit });
}
