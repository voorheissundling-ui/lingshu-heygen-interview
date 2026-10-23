import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';
import type { StarterRecord } from './repository.js';
import type { Starter198Repository } from './repository.js';
import { SocialContentWorkflowError, socialRequestHash, socialText } from './socialContentValidation.js';
import { decodeMaterialRef } from './socialContentProductionMaterials.js';
import { readSocialTaskDetail } from './socialContentRecords.js';

export interface SocialFunctionalReplacementRevision {
  schemaVersion: 'social-functional-replacement-revision.v1';
  priorReferenceMode: 'single_source_fidelity';
  revisedReferenceMode: 'multi_source_hybrid';
  semanticIntent: 'functionally_replaced';
  retainedReferenceUse: 'structure_and_qa_evidence';
  planHash: string;
  evidenceHash: string;
  revisedBy: string;
  revisedAt: string;
  revisionHash: string;
}

/** Forward-only, pre-run revision from pixel fidelity to reviewed functional replacement. */
export function authorizeFunctionalReplacement(input: {
  record: StarterRecord;
  detail: SocialContentTaskDetail;
  actorUserId: string;
  revisedAt: string;
}): SocialFunctionalReplacementRevision {
  if (socialText(input.record.run_id) || input.detail.runId) {
    throw new SocialContentWorkflowError('social_content_functional_replacement_run_started', 409);
  }
  if (input.detail.brief.referenceMode !== 'single_source_fidelity') {
    throw new SocialContentWorkflowError('social_content_functional_replacement_fidelity_contract_required', 409);
  }
  const plan = input.detail.assetSupplyPlan;
  if (!plan || plan.overallFeasibility !== 'functional_equivalent' || !plan.shots.length) {
    throw new SocialContentWorkflowError('social_content_functional_replacement_plan_required', 409);
  }
  const storedBrief = (input.record.brief && typeof input.record.brief === 'object')
    ? input.record.brief as Record<string, unknown> : {};
  const authority = storedBrief._weeklyAuthority && typeof storedBrief._weeklyAuthority === 'object'
    ? storedBrief._weeklyAuthority as Record<string, unknown> : {};
  const publicationTask = authority.publicationTask && typeof authority.publicationTask === 'object'
    ? authority.publicationTask as Record<string, unknown> : {};
  const materialRequirement = publicationTask.materialRequirement && typeof publicationTask.materialRequirement === 'object'
    ? publicationTask.materialRequirement as Record<string, unknown> : {};
  const requestIds = Array.isArray(materialRequirement.requestIds)
    ? materialRequirement.requestIds.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())) : [];
  const shotBindings = new Map((input.detail.shotMaterialMap ?? []).map(binding => [binding.shotId, binding]));
  const admitted = plan.shots.map(shot => {
    const routing = shot.materialRouting;
    const segment = shot.selectedMaterialSegment;
    const evidence = segment?.footageEvidence;
    const fullyRouted = shot.sourceStrategy === 'customer_real_asset'
      && routing?.policy === 'local_only' && routing.localMatch.state === 'matched'
      && routing.localMatch.sourceRefs.length > 0 && Boolean(routing.localMatch.evidenceRef)
      && Boolean(segment?.sourceRef && segment.segmentId && evidence?.contentSha256 && evidence.productId
        && evidence.approvalId && evidence.visualFindingId && routing.localMatch.sourceRefs.includes(segment.sourceRef));
    if (shot.feasibility !== 'functional_equivalent') {
      throw new SocialContentWorkflowError('social_content_functional_replacement_plan_required', 409);
    }
    if (fullyRouted) return { shotId: shot.shotId, sourceRef: segment!.sourceRef, segmentId: segment!.segmentId,
      contentSha256: evidence!.contentSha256, productId: evidence!.productId,
      approvalId: evidence!.approvalId, visualFindingId: evidence!.visualFindingId,
      evidenceRef: routing!.localMatch.evidenceRef! };
    const binding = shotBindings.get(shot.shotId);
    const sources = (binding?.customerAssetIds ?? []).flatMap(recordId => input.detail.sources.filter(source => {
      const decoded = decodeMaterialRef(source.sourceRef);
      return source.status === 'active' && source.kind === 'material' && (decoded === recordId || decoded === `pb-${recordId}`)
        && /^[a-f0-9]{64}$/.test(source.sourceVersion ?? '');
    }));
    if (binding?.sourceStrategy !== 'customer_real_asset' || sources.length !== 1 || requestIds.length !== 1) {
      throw new SocialContentWorkflowError('social_content_functional_replacement_reviewed_material_required', 409);
    }
    const source = sources[0]!;
    return { shotId: shot.shotId, sourceRef: source.sourceRef, segmentId: 'reviewed-route-pending',
      contentSha256: source.sourceVersion!, productId: input.detail.brief.productId ?? input.detail.brief.productRef ?? '',
      approvalId: requestIds[0]!, visualFindingId: requestIds[0]!, evidenceRef: requestIds[0]! };
  });
  const factors = input.detail.agentWorkflow?.replicationJob?.factorSpecs ?? [];
  if (!factors.length || factors.some(factor => !factor.evidenceRefs.length || !factor.validator.detector || !factor.target.metric)) {
    throw new SocialContentWorkflowError('social_content_functional_replacement_factor_evidence_required', 409);
  }
  const planHash = socialRequestHash(plan);
  const evidenceHash = socialRequestHash({ admitted, factors: factors.map(factor => ({
    factorId: factor.factorId, evidenceRefs: factor.evidenceRefs, validator: factor.validator, target: factor.target,
  })) });
  const revision = {
    schemaVersion: 'social-functional-replacement-revision.v1' as const,
    priorReferenceMode: 'single_source_fidelity' as const,
    revisedReferenceMode: 'multi_source_hybrid' as const,
    semanticIntent: 'functionally_replaced' as const,
    retainedReferenceUse: 'structure_and_qa_evidence' as const,
    planHash, evidenceHash, revisedBy: input.actorUserId, revisedAt: input.revisedAt,
  };
  return { ...revision, revisionHash: socialRequestHash(revision) };
}

export async function applyFunctionalReplacementRevision(input: {
  repository: Starter198Repository; tenantId: string; taskId: string; record: StarterRecord;
  actorUserId: string; revisedAt: string; currentApproach: unknown; nextApproach: unknown;
  brief: Record<string, unknown>; serverBrief: Record<string, unknown>;
}) {
  if (input.nextApproach !== 'material_cut' || input.currentApproach === 'material_cut') return;
  const detail = await readSocialTaskDetail(input);
  if (!detail) throw new SocialContentWorkflowError('social_content_task_not_found', 404);
  const effectiveReferenceMode = detail.agentWorkflow?.replicationJob?.referenceMode ?? detail.brief.referenceMode;
  if (effectiveReferenceMode !== 'single_source_fidelity') return;
  const revision = authorizeFunctionalReplacement({ record: input.record, detail: {
    ...detail, brief: { ...detail.brief, referenceMode: effectiveReferenceMode },
  }, actorUserId: input.actorUserId, revisedAt: input.revisedAt });
  input.brief.referenceMode = revision.revisedReferenceMode;
  input.serverBrief._replicationContractRevision = revision;
  Object.assign(input.brief, input.serverBrief);
}
