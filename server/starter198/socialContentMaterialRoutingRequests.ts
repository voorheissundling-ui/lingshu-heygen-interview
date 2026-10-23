import { classifySocialAssetSupplyMaterialType, type SocialAssetSupplyShotRequest } from '../../shared/socialContentAssetSupply.js';
import { normalizeSceneVisualContract, scoreSceneVisualCompatibility, type SocialSceneVisualContract } from '../../shared/sceneVisualContract.js';
import type { SocialReferenceShotAnalysis } from '../../shared/contracts/socialContentWorkflow.js';
import type { SocialWorkflowMaterialClipCandidate } from './socialContentRecords.js';
import { socialRequestHash } from './socialContentValidation.js';
import { classifyFixedYieldArchetype, fixedYieldCandidateMatches } from '../../shared/fixedYieldMaterialRegistry.js';
import type { BenchmarkMaterialType } from '../../shared/benchmarkAnalysis.js';
import {
  evaluateLocalMaterialSegmentProfile,
  normalizeLocalMaterialSegmentProfile,
  inferLocalMaterialSegmentType,
  type LocalMaterialSegmentRejection,
  type LocalMaterialSegmentRejectionReason,
} from '../../shared/contracts/localMaterialSegmentProfile.js';

export interface ReviewedMaterialRoutingBinding {
  shotId: string;
  assetId: string;
  segmentId: string;
  sourceRef: string;
  sourceRevision: string;
  rightsEvidenceRef: string;
}

const actionRequirements = [
  // Camera wording such as "横向摇移" is not a required subject action.
  /旋转|转圈|晃一圈|晃动|摇动|摇晃|rotat|shake|wobbl/i,
  /滚动|滚落|roll|tumble/i,
  /输送|流水线|传送带|conveyor/i,
  /灌装|注液|fill|dispens/i,
  /手持|手握|hold|grip/i,
  /涂抹|上脸|apply|applying|rub/i,
];
const affirmative = (text: string) => (text.split(/须避免[:：]?|负面提示[:：]?|negative\s*prompt[:：]?|\bavoid[:：]?/i, 1)[0] ?? '').split(/[；;。，,\n]/)
  .filter(clause => !/禁止|不得|不能|没有|未见|不添加|不出现|without|\b(?:no|not)\s/i.test(clause)).join('；');

function consumerSemanticScore(expected: SocialSceneVisualContract, candidate: SocialWorkflowMaterialClipCandidate): number {
  if (candidate.productId || candidate.productRef) return scoreSceneVisualCompatibility(expected, candidate.visualContract);
  // Candidate construction projects the task's authoritative product identity
  // into every visual contract. For a genuinely product-unbound usage clip,
  // that projection is planning context rather than observed package evidence.
  // Neutralize it only for semantic scoring; a candidate with any observed
  // product identity continues through the strict product-compatibility path.
  const withoutProductIdentity = (contract: SocialSceneVisualContract): SocialSceneVisualContract => normalizeSceneVisualContract({
    ...contract,
    productUsage: { ...contract.productUsage, productId: null, productRef: null },
    product: { policy: 'open', requestedProductId: null, requestedProductRef: null, source: 'inventory_open' },
  });
  return scoreSceneVisualCompatibility(withoutProductIdentity(expected), withoutProductIdentity(candidate.visualContract));
}

function candidateMaterialType(candidate: SocialWorkflowMaterialClipCandidate): BenchmarkMaterialType {
  return inferLocalMaterialSegmentType({ materialRoles: candidate.materialRoles, visualContract: candidate.visualContract });
}

/** Uses analyzed, tenant-scoped segments rather than treating inventory presence as a match. */
export function materialRoutingRequests(input: {
  policyVersion?: 'type-aware.v1' | 'type-aware.v2';
  tenantId: string;
  shots: SocialAssetSupplyShotRequest[];
  candidates: SocialWorkflowMaterialClipCandidate[];
  /** Server-projected weekly reviewed-material bindings. Callers must derive
   * these from the persisted shot map, active source and frozen request. */
  reviewedMaterialBindings?: ReviewedMaterialRoutingBinding[];
  /** Inventory segments excluded before semantic ranking (rights/version/edit gates). */
  rejectedSegments?: LocalMaterialSegmentRejection[];
  referenceShots?: SocialReferenceShotAnalysis[];
  productRef: string | null;
  /** @deprecated Retained only so old callers can be read. V2 product routing
   * never changes when this value changes and never creates an I2V fallback. */
  productGenerationAllowed?: boolean;
}): SocialAssetSupplyShotRequest[] {
  if (input.policyVersion !== 'type-aware.v1' && input.policyVersion !== 'type-aware.v2') return input.shots;
  const assetUseCount = new Map<string, number>();
  const segmentUseCount = new Map<string, number>();
  const usage = (candidate: SocialWorkflowMaterialClipCandidate) => ({
    asset: assetUseCount.get(candidate.assetId) ?? 0,
    segment: segmentUseCount.get(`${candidate.assetId}:${candidate.segmentId}`) ?? 0,
  });
  const recordUse = (candidate: SocialWorkflowMaterialClipCandidate | undefined) => {
    if (!candidate) return;
    assetUseCount.set(candidate.assetId, (assetUseCount.get(candidate.assetId) ?? 0) + 1);
    const key = `${candidate.assetId}:${candidate.segmentId}`;
    segmentUseCount.set(key, (segmentUseCount.get(key) ?? 0) + 1);
  };
  return input.shots.map(original => {
    // Re-evaluate evidence against this inventory; a prior plan's proof is not current evidence.
    const { localVideoMatch: _priorMatch, selectedMaterialSegment: _priorSegment, ...current } = original;
    const shot = { ...current, productRef: original.productRef ?? input.productRef };
    const materialType = classifySocialAssetSupplyMaterialType(shot, input.referenceShots);
    const reference = input.referenceShots?.find(item => item.shotId === shot.referenceShotId);
    const holdingProduct = materialType === 'product' && /手持|手握|拿|hold|grip/i.test(shot.requestedDescription ?? '');
    const expected = normalizeSceneVisualContract(shot.visualContract ?? reference?.visualContract ?? {
      subjects: materialType === 'product' ? holdingProduct ? ['person', 'product'] : ['product']
        : materialType === 'factory' ? ['factory'] : ['person', 'product'],
      interaction: { kind: materialType === 'factory' ? 'factory_process' : materialType === 'consumer_demo'
        ? 'person_using_product' : holdingProduct ? 'person_holding_product' : 'product_only_display',
        description: shot.requestedDescription ?? '' },
      action: { path: shot.requestedDescription ?? '' },
      productRef: materialType === 'product' ? shot.productRef : null,
      productPolicy: materialType === 'product' ? 'locked' : 'open',
    });
    const description = affirmative([shot.requestedDescription, expected.action.path,
      expected.interaction.description].filter(Boolean).join('；'));
    const fixedYieldArchetypeId = shot.fixedYieldArchetypeId ?? classifyFixedYieldArchetype({
      materialType, visual: expected, description, function: shot.function,
    });
    // Preserve the planned contract used to match the source. The Director
    // otherwise has no subjects for non-reference baselines and cannot review
    // the same match against the actual material contract.
    const plannedShot = ['product', 'factory', 'consumer_demo'].includes(materialType)
      ? { ...shot, visualContract: expected } : shot;
    const required = actionRequirements.filter(pattern => pattern.test(description));
    const evidenceDuration = expected.evidence.sourceRange
      ? expected.evidence.sourceRange.endSeconds - expected.evidence.sourceRange.startSeconds : NaN;
    // A local clip only has to cover this edit slot. Requiring every analyzed
    // source segment to be three seconds discarded exact 0.5–1 second reference
    // beats even when the owned segment was substantially longer than the slot.
    const requiredDuration = Number.isFinite(shot.plannedDurationSeconds) && Number(shot.plannedDurationSeconds) > 0
      ? Number(shot.plannedDurationSeconds)
      : Number.isFinite(evidenceDuration) && evidenceDuration > 0 ? evidenceDuration : 3;
    const rejected: LocalMaterialSegmentRejection[] = structuredClone(input.rejectedSegments ?? []);
    const reject = (candidate: SocialWorkflowMaterialClipCandidate, values: LocalMaterialSegmentRejectionReason[]) => {
      const reasons = [...new Set(values)];
      if (!reasons.length) return false;
      rejected.push({ assetId: candidate.assetId, segmentId: candidate.segmentId,
        sourceRevision: candidate.segmentProfile?.sourceRevision ?? null, reasons });
      return true;
    };
    const reviewed = input.reviewedMaterialBindings
      ?.filter(binding => binding.shotId === shot.shotId)
      .flatMap(binding => input.candidates.filter(candidate => {
        const profile = normalizeLocalMaterialSegmentProfile(candidate.segmentProfile);
        return candidate.assetId === binding.assetId && candidate.sourceRef === binding.sourceRef
          && candidate.segmentId === binding.segmentId && candidate.sourceRevision === binding.sourceRevision
          && candidate.mediaType === 'video' && candidate.origin === 'my_materials' && candidate.synthetic !== true
          && Boolean(candidate.timeRange) && profile?.productionEligible === true
          && profile.tenantId === input.tenantId && profile.assetId === candidate.assetId
          && profile.segmentId === candidate.segmentId && profile.sourceRevision === binding.sourceRevision
          && profile.rightsEvidenceRefs.includes(binding.rightsEvidenceRef)
          && profile.commercialUseApproved && profile.commercialUseApprovalEvidenceRefs.includes(binding.rightsEvidenceRef)
          && profile.derivativeUseAllowed;
      }))
      .sort((a, b) => usage(a).asset - usage(b).asset || usage(a).segment - usage(b).segment
        || b.matchScore - a.matchScore || a.assetId.localeCompare(b.assetId))[0];
    const candidates = input.candidates.filter(candidate => {
      if (!fixedYieldArchetypeId || materialType === 'talking_head' || materialType === 'unknown') return false;
      const profileReasons = evaluateLocalMaterialSegmentProfile({
        profile: candidate.segmentProfile,
        tenantId: input.tenantId,
        assetId: candidate.assetId,
        segmentId: candidate.segmentId,
        targetMaterialType: materialType,
        targetArchetypeId: fixedYieldArchetypeId,
        requestedProductRef: shot.productRef,
        requiredDurationSeconds: requiredDuration,
        alreadyUsed: segmentUseCount.has(`${candidate.assetId}:${candidate.segmentId}`),
      });
      if (candidate.synthetic && !profileReasons.includes('synthetic_source')) profileReasons.push('synthetic_source');
      if (candidate.origin !== 'my_materials' && !profileReasons.includes('local_ownership_missing')) profileReasons.push('local_ownership_missing');
      if (candidate.mediaType !== 'video' && !profileReasons.includes('non_video_source')) profileReasons.push('non_video_source');
      if (!candidate.timeRange && !profileReasons.includes('invalid_time_range')) profileReasons.push('invalid_time_range');
      if (reject(candidate, profileReasons)) return false;
      const fixedMatch = fixedYieldCandidateMatches({
        archetypeId: fixedYieldArchetypeId,
        candidateMaterialType: candidateMaterialType(candidate),
        candidateRoles: candidate.materialRoles,
        candidateVisual: candidate.visualContract,
        requestedProductRef: shot.productRef,
        candidateProductRefs: [candidate.productId, candidate.productRef],
      });
      if (!fixedMatch.accepted) {
        reject(candidate, [fixedMatch.reason as LocalMaterialSegmentRejectionReason]);
        return false;
      }
      const visual = candidate.visualContract;
      const observed = affirmative([visual.action.path, visual.interaction.description,
        ...visual.subjects.map(subject => subject.description)].join('；'));
      const visualScore = materialType === 'consumer_demo' ? consumerSemanticScore(expected, candidate)
        : scoreSceneVisualCompatibility(expected, visual);
      // Factory footage is selected by its analyzed factory role and observed
      // process action. Cosmetic differences from the reference must not erase
      // a real tenant-owned filling, conveyor or inspection candidate.
      const minimumVisualScore = materialType === 'factory' ? (required.length ? 0.4 : 0.6)
        // Consumer b-roll preserves the real hand/person-use function while the
        // reference's set dressing may differ. The role exclusions above keep
        // factory and presenter footage out of this bounded fallback.
        : materialType === 'consumer_demo' ? 0.6 : 0.72;
      const semanticReasons: LocalMaterialSegmentRejectionReason[] = [];
      if (!required.every(pattern => pattern.test(observed))) semanticReasons.push('required_action_missing');
      if (visualScore < minimumVisualScore) semanticReasons.push('semantic_similarity_insufficient');
      return !reject(candidate, semanticReasons);
    }).sort((a, b) => usage(a).asset - usage(b).asset || usage(a).segment - usage(b).segment
      || (materialType === 'consumer_demo' ? consumerSemanticScore(expected, b) - consumerSemanticScore(expected, a)
      : scoreSceneVisualCompatibility(expected, b.visualContract) - scoreSceneVisualCompatibility(expected, a.visualContract))
      || a.assetId.localeCompare(b.assetId));
    // A frozen weekly reviewed binding is stronger than heuristic archetype
    // similarity, but only after the current tenant/source/profile/rights
    // evidence has been revalidated above.
    const match = reviewed ?? candidates[0];
    const sourceTier: NonNullable<NonNullable<SocialAssetSupplyShotRequest['localVideoMatch']>['sourceTier']> | undefined
      = materialType === 'product' && match ? 'product_high_fidelity_local' : undefined;
    const localMaterialRejections = rejected.slice(0, 20);
    if (!match?.timeRange || !fixedYieldArchetypeId) return { ...plannedShot, materialType,
      ...(fixedYieldArchetypeId ? { fixedYieldArchetypeId } : {}),
      ...(localMaterialRejections.length ? { localMaterialRejections } : {}) };
    recordUse(match);
    const segment = { sourceRef: match.sourceRef, segmentId: match.segmentId,
      startSeconds: match.timeRange.startSeconds, endSeconds: match.timeRange.endSeconds,
      ...(match.footageEvidence ? { footageEvidence: structuredClone(match.footageEvidence) } : {}) };
    return { ...plannedShot, materialType, fixedYieldArchetypeId, selectedMaterialSegment: segment,
      ...(localMaterialRejections.length ? { localMaterialRejections } : {}),
      localVideoMatch: { sourceRefs: [match.sourceRef], semanticMatch: 'verified' as const,
        archetypeId: fixedYieldArchetypeId,
        ...(sourceTier ? { sourceTier } : {}),
        productRef: match.productRef,
        evidenceRef: `material-visual-match:${input.tenantId}:${socialRequestHash({ shotId: shot.shotId, expected,
          sourceRef: match.sourceRef, segment, segmentProfile: match.segmentProfile, visual: match.visualContract })}` } };
  });
}
