import type {SocialAssetSupplyPlan, SocialContentTaskDetail} from '../../shared/contracts/socialContentWorkflow.js';
import {socialRequestHash} from './socialContentValidation.js';
import type {readSocialTaskDetail} from './socialContentRecords.js';

type ProductionTaskDetail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;

/** Rebind only execution routing from the canonical task plan. Reviewed shot
 * decisions stay frozen even when an older graph checkpoint lacks routing. */
export function bindCanonicalTypeAwareRouting<T extends NonNullable<ProductionTaskDetail['assetSupplyPlan']>>(approved: T, canonical: T): T {
  const canonicalById=new Map(canonical.shots.map(shot=>[shot.shotId,shot]));
  const approvedIds=approved.shots.map(shot=>shot.shotId),canonicalIds=canonical.shots.map(shot=>shot.shotId);
  if(!canonicalIds.length||approvedIds.length!==canonicalIds.length||new Set(approvedIds).size!==approvedIds.length
    ||new Set(canonicalIds).size!==canonicalIds.length||canonicalIds.some(id=>!id)
    || socialRequestHash([...approvedIds].sort())!==socialRequestHash([...canonicalIds].sort()))throw Error('type_aware_frozen_scene_set_changed');
  const shots=approved.shots.map(shot=>{
    const authority=canonicalById.get(shot.shotId);
    if(!authority?.materialRouting)throw Error(`type_aware_canonical_routing_missing:${shot.shotId}`);
    const generatesProduct=authority.sourceStrategy==='aigc_product_scene_replication';
    const eligibleProduct=canonical.materialRoutingPolicyVersion==='type-aware.v2'&&authority.materialRouting.productGenerationDecision?.state==='eligible';
    if(generatesProduct&&!authority.productSceneReplication)throw Error(`type_aware_canonical_product_spec_missing:${shot.shotId}`);
    const {productSceneReplication:_staleProductSpec,...approvedShot}=structuredClone(shot);
    const realLocalRoute=authority.materialRouting.policy==='local_only'&&(authority.materialRouting.materialType!=='product'||canonical.materialRoutingPolicyVersion==='type-aware.v2');
    const matchedRefs=realLocalRoute?authority.materialRouting.localMatch.sourceRefs:[];
    const matchedSegment=realLocalRoute&&authority.selectedMaterialSegment&&matchedRefs.includes(authority.selectedMaterialSegment.sourceRef)
      ?structuredClone(authority.selectedMaterialSegment):undefined;
    return {...approvedShot,
      ...(realLocalRoute?{sourceStrategy:'customer_real_asset' as const,sourceRefs:[...matchedRefs],
        fallbackSourceStrategy:null,selectedMaterialSegment:matchedSegment}:{}),
      materialRouting:structuredClone(authority.materialRouting),
      ...(generatesProduct||eligibleProduct?{productSceneReplication:structuredClone(authority.productSceneReplication!)}:{})};
  });
  if(shots.some(shot=>!shot.materialRouting))throw Error('type_aware_frozen_routing_incomplete');
  if(shots.some(shot=>shot.sourceStrategy==='aigc_product_scene_replication'&&!shot.productSceneReplication)
    ||shots.some(shot=>shot.sourceStrategy!=='aigc_product_scene_replication'&&shot.productSceneReplication&&!(canonical.materialRoutingPolicyVersion==='type-aware.v2'&&shot.materialRouting?.productGenerationDecision?.state==='eligible')))throw Error('type_aware_frozen_product_contract_incomplete');
  return {...structuredClone(approved),materialRoutingPolicyVersion:canonical.materialRoutingPolicyVersion,shots} as T;
}

export function assertCompleteTypeAwareExecutionPlan(plan: NonNullable<ProductionTaskDetail['assetSupplyPlan']>, expectedShotIds?: readonly string[]) {
  const actualIds=plan.shots.map(shot=>shot.shotId);
  if(!actualIds.length||actualIds.some(id=>!id)||new Set(actualIds).size!==actualIds.length
    ||(expectedShotIds&&(expectedShotIds.length!==actualIds.length||new Set(expectedShotIds).size!==expectedShotIds.length
      ||socialRequestHash([...expectedShotIds].sort())!==socialRequestHash([...actualIds].sort()))))throw Error('type_aware_execution_scene_set_invalid');
  const missingRoute=plan.shots.find(shot=>!shot.materialRouting);
  if(missingRoute)throw Error(`type_aware_execution_routing_missing:${missingRoute.shotId}`);
  const generatedProducts=plan.shots.filter(shot=>shot.sourceStrategy==='aigc_product_scene_replication');
  const missingSpec=generatedProducts.find(shot=>shot.materialRouting?.materialType!=='product'||!shot.productSceneReplication);
  if(missingSpec)throw Error(`type_aware_execution_product_spec_missing:${missingSpec.shotId}`);
  const staleSpec=plan.shots.find(shot=>shot.sourceStrategy!=='aigc_product_scene_replication'&&shot.productSceneReplication);
  if(staleSpec)throw Error(`type_aware_execution_product_spec_unexpected:${staleSpec.shotId}`);
}

/** Project the Content Agent's reviewed candidate into an executable supply
 * plan. This is deliberately pure so paid execution cannot affect approval. */
export function assetSupplyPlanWithExecutionSelections(
  plan: SocialAssetSupplyPlan,
  workflow: NonNullable<SocialContentTaskDetail['agentWorkflow']>,
): SocialAssetSupplyPlan {
  const executionByScene = new Map(workflow.executionPlan.scenes.map(scene => [scene.sceneId, scene]));
  return {
    ...structuredClone(plan),
    shots: plan.shots.map(shot => {
      const execution = executionByScene.get(shot.shotId);
      if (!execution) return structuredClone(shot);
      const recommendedId = execution.recommendedCandidateIds[0];
      const candidate = execution.candidates.find(item => item.candidateId === recommendedId);
      if (!candidate) return {
        ...structuredClone(shot),
        sourceStrategy: execution.selectedSourceStrategy,
        fallbackSourceStrategy: execution.fallbackSourceStrategy,
      };
      const segment = candidate.materialSegments?.[0];
      return {
        ...structuredClone(shot),
        sourceStrategy: execution.selectedSourceStrategy,
        fallbackSourceStrategy: execution.fallbackSourceStrategy,
        ...(candidate.kind === 'capability' && !['authorized_digital_presenter', 'customer_product_image_animation'].includes(execution.selectedSourceStrategy)
          ? { sourceRefs: [] } : {}),
        ...(candidate.kind === 'asset' && candidate.sourceRef ? {
          sourceRefs: [candidate.sourceRef],
          selectedMaterialSegment: segment ? {
            sourceRef: candidate.sourceRef,
            segmentId: segment.segmentId,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            ...(segment.footageEvidence ? { footageEvidence: structuredClone(segment.footageEvidence) } : {}),
          } : null,
        } : {}),
      };
    }),
  };
}
