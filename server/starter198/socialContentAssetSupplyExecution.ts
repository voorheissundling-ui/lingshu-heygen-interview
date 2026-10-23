import {assertSocialAccountProductionConstraints,type SocialAccountProductionConstraints} from './socialAccountProductionConstraints.js';
import type {
  SocialAssetSupplyPlan,
  SocialAssetSupplyShotPlan,
  SocialShotSourceStrategy,
  SocialShotTruthBoundary,
} from '../../shared/contracts/socialContentWorkflow.js';
import { createSocialAssetSupplyPlan } from '../../shared/socialContentAssetSupply.js';
import { hasVerifiedSameClassSocialLocalMatch } from '../../shared/socialContentMaterialRouting.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';
import type { StoredSocialScriptBaseline } from './socialContentScriptBaseline.js';

export type SocialAssetSupplyRepresentation = 'customer_evidence' | 'non_evidentiary_visual';

export interface SocialAssetSupplyAdapterContext {
  accountPlaybookConstraints?:SocialAccountProductionConstraints;
  tenantId: string;
  taskId: string;
  /** Stable server-owned repair operation; task identity remains unchanged. */
  operationId?: string;
  outputDirectory: string;
  shot: SocialAssetSupplyShotPlan;
  baselineScene: StoredSocialScriptBaseline['scenes'][number];
  availableAssets: SocialProductionAsset[];
}

export interface SocialAssetSupplyAdapterResult {
  asset: SocialProductionAsset;
  sourceStrategy: SocialShotSourceStrategy;
  providerId: string;
  sourceRef: string | null;
  synthetic: boolean;
  representation: SocialAssetSupplyRepresentation;
  authorizationRef: string | null;
  disclosure: string | null;
}

/** Providers register only the strategies they can really execute. A missing
 * digital-human, stock or image-generation provider is therefore visible in
 * the trace instead of being silently presented as a successful AI call. */
export interface SocialAssetSupplyProviderAdapter {
  adapterId: string;
  sourceStrategies: SocialShotSourceStrategy[];
  execute(context: SocialAssetSupplyAdapterContext): Promise<SocialAssetSupplyAdapterResult | null>;
}

export interface SocialAssetSupplyExecutionAttempt {
  sourceStrategy: SocialShotSourceStrategy;
  adapterId: string | null;
  status: 'completed' | 'adapter_not_registered' | 'unavailable' | 'rejected_by_truth_boundary' | 'failed';
  reason: string | null;
}

export interface SocialAssetSupplyShotExecution {
  shotId: string;
  sceneId: string;
  function: SocialAssetSupplyShotPlan['function'];
  requestedSourceStrategy: SocialShotSourceStrategy;
  sourceStrategy: SocialShotSourceStrategy;
  fallbackApplied: boolean;
  providerId: string;
  assetId: string;
  sourceRef: string | null;
  truthBoundary: SocialShotTruthBoundary;
  functionalEquivalentReplacement: SocialAssetSupplyShotPlan['functionalEquivalentReplacement'];
  provenance: {
    synthetic: boolean;
    representation: SocialAssetSupplyRepresentation;
    authorizationRef: string | null;
    disclosure: string | null;
  };
  attempts: SocialAssetSupplyExecutionAttempt[];
  archivedMaterial?: {
    materialId: string;
    materialRevision: string;
    generationExecutionId: string;
    adoptedAt: string;
  };
}

export interface SocialAssetSupplyExecution {
  schemaVersion: 'social-content.asset-supply-execution.v1';
  planVersion: string;
  creationMode: SocialAssetSupplyPlan['creationMode'];
  productionRoute: SocialAssetSupplyPlan['productionRoute'];
  managementMode: SocialAssetSupplyPlan['managementMode'];
  executedAt: string;
  shots: SocialAssetSupplyShotExecution[];
}

export interface SocialAssetSupplyExecutionResult {
  plan: SocialAssetSupplyPlan;
  assets: SocialProductionAsset[];
  execution: SocialAssetSupplyExecution;
}

/** Projects the already selected, byte-addressed scene media into the public
 * production result. It never stores another copy and never treats a planning
 * candidate as an executed output. */
export function socialExecutedSceneMediaArtifact(input: {
  sceneId: string;
  execution: SocialAssetSupplyExecution | null;
  assets: SocialProductionAsset[];
}) {
  const shots = input.execution?.shots.filter(shot => shot.sceneId === input.sceneId) || [];
  if (shots.length !== 1) return undefined;
  const shot = shots[0]!;
  const assets = input.assets.filter(asset => asset.id === shot.assetId);
  if (assets.length !== 1) return undefined;
  const asset = assets[0]!;
  const resourceRef = String(asset.url || '').trim();
  const contentHash = String(asset.contentHash || '').trim();
  if (!resourceRef || !/^[a-f0-9]{64}$/i.test(contentHash) || !Number.isFinite(asset.duration) || asset.duration < 0) return undefined;
  return {
    assetId: asset.id,
    mediaType: asset.type,
    resourceRef,
    contentHash: contentHash.toLowerCase(),
    durationSeconds: asset.duration,
    providerId: shot.providerId,
    supplyPlanVersion: input.execution!.planVersion,
    role: 'scene_render_input' as const,
  };
}

function shotFunction(scene: StoredSocialScriptBaseline['scenes'][number], index: number, total: number) {
  const text = `${scene.shotFunction} ${scene.subject} ${scene.action}`.toLocaleLowerCase();
  if (index === 0) return 'hook' as const;
  if (/d\s*to\s*c|吸睛|生活场景|hook|开场|开头|前三秒|吸引|钩子/.test(text)) return 'd_to_c' as const;
  if (index === total - 1 || /cta|行动|咨询|联系|转化|收尾/.test(text)) return 'call_to_action' as const;
  if (/痛点|问题|困扰|难题|problem/.test(text)) return 'problem' as const;
  if (/证明|证据|参数|数据|proof/.test(text)) return 'proof' as const;
  if (/信任|工厂|车间|生产|交付|trust/.test(text)) return 'trust' as const;
  if (/演示|使用|操作|步骤|过程|demo/.test(text)) return 'demonstration' as const;
  if (/转场|衔接|transition/.test(text)) return 'transition' as const;
  return 'value' as const;
}

function truthSensitiveSubject(scene: StoredSocialScriptBaseline['scenes'][number]) {
  const text = `${scene.shotFunction} ${scene.subject} ${scene.action} ${scene.script} ${scene.voiceover} ${scene.caption} ${scene.narration}`;
  if (/工厂|车间|产线|生产基地|仓库/.test(text)) return 'customer_factory' as const;
  if (/客户案例|客户反馈|合作案例|成交结果|客户成果/.test(text)) return 'customer_case' as const;
  if (/使用效果|前后对比|效果证明|实测效果|真实效果/.test(text)) return 'product_effect' as const;
  return 'none' as const;
}

/** Rebuild the public task-level plan at actual script-shot granularity while
 * preserving the task's creation mode, management choice and confirmed facts. */
export function alignSocialAssetSupplyPlanToBaseline(input: {
  plan: SocialAssetSupplyPlan;
  baseline: StoredSocialScriptBaseline;
}): SocialAssetSupplyPlan {
  const baselineIds = input.baseline.scenes.map(scene => scene.sceneId);
  const planIds = input.plan.shots.map(shot => shot.shotId);
  const identityError = () => new Error(`asset_supply_scene_identity_missing_or_duplicate:baseline=${baselineIds.join(',')}:plan=${planIds.join(',')}`);
  if(!baselineIds.length||new Set(baselineIds).size!==baselineIds.length||new Set(planIds).size!==planIds.length)throw identityError();
  if(baselineIds.some(sceneId=>!sceneId||planIds.filter(shotId=>shotId===sceneId).length!==1))throw identityError();
  const confirmedFactRefs = [...new Set(input.plan.shots.flatMap(shot => shot.truthBoundary.confirmedFactRefs))];
  const productImageIds = [...new Set(input.plan.shots.flatMap(shot => (
    shot.productSceneReplication?.productIdentity.groups.flatMap(group => group.referenceImageIds) ?? []
  )))];
  const presenterAssetIds = [...new Set(input.plan.shots.flatMap(shot => shot.digitalHumanPlan?.presenterAssetIds ?? []))];
  const referenceVideoIds = [...new Set(input.plan.shots.flatMap(shot => [
    ...(shot.digitalHumanPlan?.referenceMaterialIds ?? []),
    ...(shot.productSceneReplication?.referenceSourceId ? [shot.productSceneReplication.referenceSourceId] : []),
  ]))];
  const factoryEvidenceAssetIds = [...new Set(input.plan.shots
    .filter(shot => shot.truthBoundary.subject === 'customer_factory')
    .flatMap(shot => shot.truthBoundary.customerEvidenceRefs.length
      ? shot.truthBoundary.customerEvidenceRefs : shot.sourceRefs))];
  const customerCaseEvidenceAssetIds = [...new Set(input.plan.shots
    .filter(shot => shot.truthBoundary.subject === 'customer_case')
    .flatMap(shot => shot.truthBoundary.customerEvidenceRefs.length
      ? shot.truthBoundary.customerEvidenceRefs : shot.sourceRefs))];
  const productEffectEvidenceAssetIds = [...new Set(input.plan.shots
    .filter(shot => shot.truthBoundary.subject === 'product_effect')
    .flatMap(shot => shot.truthBoundary.customerEvidenceRefs.length
      ? shot.truthBoundary.customerEvidenceRefs : shot.sourceRefs))];
  const customerVideoIds = [...new Set(input.plan.shots
    .filter(shot => shot.sourceStrategy === 'customer_real_asset' && shot.truthBoundary.subject === 'none')
    .flatMap(shot => shot.sourceRefs))];
  const licensedStockAssetIds = [...new Set(input.plan.shots
    .filter(shot => shot.sourceStrategy === 'licensed_stock_asset')
    .flatMap(shot => shot.sourceRefs))];
  const aligned = createSocialAssetSupplyPlan({
    creationMode: input.plan.creationMode,
    productionApproach: input.plan.productionApproach ?? 'ai_enhanced',
    assetAvailability: input.plan.assetAvailability,
    managementMode: input.plan.managementMode,
    planVersion: input.plan.planVersion,
    ...(input.plan.materialRoutingPolicyVersion ? { materialRoutingPolicyVersion: input.plan.materialRoutingPolicyVersion } : {}),
    accountPresenterLock: input.plan.accountPresenterLock,
    inventory: {
      productImageIds,
      productIdentityGroups: input.plan.shots.flatMap(shot => (
        shot.productSceneReplication?.productIdentity.groups.map(group => ({
          productRef: group.productRef,
          imageIds: [...group.referenceImageIds],
        })) ?? []
      )),
      presenterAssetIds,
      referenceVideoIds,
      factoryEvidenceAssetIds,
      customerCaseEvidenceAssetIds,
      productEffectEvidenceAssetIds,
      customerVideoIds,
      licensedStockAssetIds,
    },
    confirmedFactRefs,
    // Anything already admitted to the tenant material library is executable;
    // missing legacy rights metadata must not silently reroute a production.
    rightsConfirmationRequired: false,
    shots: input.baseline.scenes.map((scene, index) => {
      const original = input.plan.shots.find(shot => shot.shotId === scene.sceneId)!;
      return {
        shotId: scene.sceneId,
        function: shotFunction(scene, index, input.baseline.scenes.length),
        requestedDescription: [scene.shotFunction, scene.subject, scene.action].filter(Boolean).join(' · '),
        truthSensitiveSubject: truthSensitiveSubject(scene),
        referenceShotId: original?.productSceneReplication?.referenceShotId ?? null,
        ...(original?.visualContract ? { visualContract: structuredClone(original.visualContract) } : {}),
        ...(original?.productSceneReplication
          ? { productSceneReplication: structuredClone(original.productSceneReplication) }
          : {}),
      };
    }),
  });
  const originalById = new Map(input.plan.shots.map(shot => [shot.shotId, shot]));
  return {
    ...aligned,
    shots: aligned.shots.map(shot => {
      const original = originalById.get(shot.shotId)!;
      // Upgraded planning defaults do not migrate an already frozen legacy shot.
      if (!original.materialRouting) {
        delete shot.materialRouting;
      }
      const approvedFirstFrame=(original as typeof original & {approvedFirstFrame?:unknown}).approvedFirstFrame;
      if(approvedFirstFrame)(shot as typeof shot & {approvedFirstFrame?:unknown}).approvedFirstFrame=structuredClone(approvedFirstFrame);
      // Versioned material routing is a reviewed production decision. Keep it
      // intact rather than letting legacy reference/capability inference replan it.
      if (original.materialRouting) {
        const preserved = { ...shot, ...structuredClone(original), shotId: shot.shotId, function: shot.function };
        // Product generation consumes the enterprise product images frozen in
        // the reviewed routing contract. Older task retries can retain stale
        // sourceRefs from a preceding route; do not let that mutable index
        // override the versioned generation inputs.
        const routing = preserved.materialRouting!;
        if (routing.materialType === 'product'
          && (routing.localMatch.state === 'missing' || input.plan.materialRoutingPolicyVersion==='type-aware.v2'&&routing.productGenerationDecision?.state==='selected')
          && routing.generation) {
          preserved.sourceRefs = [...routing.generation.productImageRefs];
        }
        if(routing.policy==='local_only'&&routing.localMatch.state==='matched'){
          preserved.sourceStrategy='customer_real_asset';
          preserved.sourceRefs=[...routing.localMatch.sourceRefs];
          preserved.fallbackSourceStrategy=null;
          if(preserved.selectedMaterialSegment&&!preserved.sourceRefs.includes(preserved.selectedMaterialSegment.sourceRef))
            delete preserved.selectedMaterialSegment;
        }
        return preserved;
      }
      // The reviewed Content-Agent route is authoritative. A legacy
      // digitalHumanPlan describes an available capability and must not turn a
      // reviewed product/stock/local scene back into a paid presenter scene.
      if (original && original.sourceStrategy !== 'authorized_digital_presenter' && original.digitalHumanPlan) {
        return { ...shot, ...structuredClone(original), shotId: shot.shotId, function: shot.function };
      }
      if (original?.referenceProductionRouting) return { ...shot, ...structuredClone(original), shotId: shot.shotId, function: shot.function };
      if (original?.selectedMaterialSegment) {
        return {
          ...shot,
          sourceStrategy: original.sourceStrategy,
          sourceRefs: [...original.sourceRefs],
          fallbackSourceStrategy: original.fallbackSourceStrategy,
          selectedMaterialSegment: structuredClone(original.selectedMaterialSegment),
          productionInstruction: original.productionInstruction,
          feasibility: original.feasibility,
          feasibilityReason: original.feasibilityReason,
          ...(original.visualContract ? { visualContract: structuredClone(original.visualContract) } : {}),
        };
      }
      if (shot.truthBoundary.subject !== 'none') return original?.visualContract
        ? { ...shot, visualContract: structuredClone(original.visualContract) }
        : shot;
      if (original?.productSceneReplication) {
        return {
          ...shot,
          sourceStrategy: 'aigc_product_scene_replication',
          sourceRefs: original.productSceneReplication.productIdentity.groups.flatMap(group => group.referenceImageIds),
          fallbackSourceStrategy: original.fallbackSourceStrategy,
          productionInstruction: original.productionInstruction,
          feasibility: original.feasibility,
          feasibilityReason: original.feasibilityReason,
          productSceneReplication: structuredClone(original.productSceneReplication),
          ...(original.visualContract ? { visualContract: structuredClone(original.visualContract) } : {}),
        };
      }
      if (!original?.digitalHumanPlan) return shot;
      return {
        ...shot,
        sourceStrategy: 'authorized_digital_presenter',
        sourceRefs: [...original.digitalHumanPlan.presenterAssetIds],
        fallbackSourceStrategy: original.fallbackSourceStrategy,
        productionInstruction: original.productionInstruction,
        feasibility: original.feasibility,
        feasibilityReason: original.feasibilityReason,
        digitalHumanPlan: structuredClone(original.digitalHumanPlan),
        ...(original.visualContract ? { visualContract: structuredClone(original.visualContract) } : {}),
      };
    }),
  };
}

function truthBoundaryViolation(
  shot: SocialAssetSupplyShotPlan,
  result: SocialAssetSupplyAdapterResult,
): string | null {
  const boundary = shot.truthBoundary;
  if (result.sourceStrategy !== shot.sourceStrategy && result.sourceStrategy !== shot.fallbackSourceStrategy
    && result.sourceStrategy !== 'motion_graphics') {
    return 'adapter_returned_unplanned_source_strategy';
  }
  if (result.synthetic && !boundary.syntheticVisualAllowed) return 'synthetic_visual_is_forbidden';
  if (boundary.customerEvidenceRequired) {
    if (result.synthetic || result.representation !== 'customer_evidence') return 'customer_evidence_is_required';
    if (!result.sourceRef || !boundary.customerEvidenceRefs.includes(result.sourceRef)) {
      return 'customer_evidence_reference_mismatch';
    }
  }
  if (boundary.mustNotImplyCustomerReality && result.representation !== 'non_evidentiary_visual') {
    return 'non_evidentiary_representation_is_required';
  }
  if (result.sourceStrategy === 'licensed_stock_asset' && !result.authorizationRef) {
    return 'licensed_stock_authorization_is_required';
  }
  if (result.synthetic && result.representation === 'customer_evidence') {
    return 'synthetic_media_cannot_be_customer_evidence';
  }
  if (boundary.mustNotImplyCustomerReality && result.synthetic && !result.disclosure) {
    return 'synthetic_non_evidentiary_disclosure_is_required';
  }
  return null;
}

export function assertSocialAssetSupplyTruthBoundary(input: {
  shot: SocialAssetSupplyShotPlan;
  result: SocialAssetSupplyAdapterResult;
}): void {
  const violation = truthBoundaryViolation(input.shot, input.result);
  if (violation) throw new Error(`asset_supply_truth_boundary:${input.shot.shotId}:${violation}`);
}

function materialStrategyOrder(shot: SocialAssetSupplyShotPlan,policyVersion?:SocialAssetSupplyPlan['materialRoutingPolicyVersion']): SocialShotSourceStrategy[] | null {
  const routing = shot.materialRouting;
  if (!routing) return null;
  const fail = (reason: string): never => { throw new Error(`material_routing_invalid:${shot.shotId}:${reason}`); };
  if (routing.schemaVersion !== 'social-material-routing.v1' || !routing.localMatch
    || !Array.isArray(routing.localMatch.sourceRefs)) fail('contract');
  const local = routing.localMatch;
  const matched = local.state === 'matched' && local.sourceRefs.length > 0
    && typeof local.evidenceRef === 'string' && local.evidenceRef.trim().length > 0;
  // A server-reviewed local clip may replace a reference talking-head image
  // while narration remains a separately measured whole-film track. It does
  // not authorize a new presenter generation or require a presenter lock.
  if (routing.policy === 'local_only' && matched) {
    if (routing.generation || shot.sourceStrategy !== 'customer_real_asset'
      || shot.fallbackSourceStrategy !== null || !shot.sourceRefs.length
      || shot.sourceRefs.some(ref => !local.sourceRefs.includes(ref))) fail('local_reviewed_video_required');
    return ['customer_real_asset'];
  }
  if (['factory', 'consumer_demo', 'general', 'unknown'].includes(routing.materialType)) {
    if (routing.policy !== 'local_only' || routing.generation || !matched
      || shot.sourceStrategy !== 'customer_real_asset' || shot.fallbackSourceStrategy !== null
      || !shot.sourceRefs.length || shot.sourceRefs.some(ref => !local.sourceRefs.includes(ref)))
      fail(`local_real_video_required:policy=${routing.policy}:generation=${Boolean(routing.generation)}:matched=${matched}:strategy=${shot.sourceStrategy}:fallback=${String(shot.fallbackSourceStrategy)}:refs=${shot.sourceRefs.length}:refMatch=${shot.sourceRefs.every(ref=>local.sourceRefs.includes(ref))}`);
    return ['customer_real_asset'];
  }
  if (routing.materialType === 'product') {
    const decision=routing.productGenerationDecision;
    const selectedUpgrade=policyVersion==='type-aware.v2'&&decision?.state==='selected';
    if(decision?.state==='selected'&&!selectedUpgrade)fail('product_selected_policy_version');
    if(selectedUpgrade&&(!decision.quoteRef?.trim()||!decision.budgetPlanRef?.trim()
      ||!Number.isFinite(decision.estimatedCostCny)||Number(decision.estimatedCostCny)<0||Number(decision.estimatedCostCny)>15))fail('product_selected_budget_proof');
    if (routing.policy === 'local_only') {
      if (routing.generation || !matched || shot.sourceStrategy !== 'customer_real_asset'
        || shot.fallbackSourceStrategy !== null || !shot.sourceRefs.length
        || shot.sourceRefs.some(ref => !local.sourceRefs.includes(ref))) fail('product_local_video_required');
      return ['customer_real_asset'];
    }
    if (routing.policy !== 'local_first_product_i2v' || shot.fallbackSourceStrategy !== null) fail('product_policy');
    if (matched&&!selectedUpgrade) {
      if (shot.sourceStrategy !== 'customer_real_asset' || !shot.sourceRefs.length
        || shot.sourceRefs.some(ref => !local.sourceRefs.includes(ref))) fail('product_local_route');
      return ['customer_real_asset'];
    }
    const generation = routing.generation;
    const invalidProductGeneration = (detail: string): never => fail(`product_generation_contract:${detail}`);
    if(selectedUpgrade&&matched){
      if(!hasVerifiedSameClassSocialLocalMatch(shot))invalidProductGeneration('selected_local_provenance');
    }else if (local.state !== 'missing' || local.sourceRefs.length) invalidProductGeneration('local_match_state');
    if (!generation) return invalidProductGeneration('generation_missing');
    if (!(['reference_first_frame_product_replacement_i2v', 'enterprise_authored_product_first_frame_i2v'] as string[]).includes(generation.method)) invalidProductGeneration('method');
    if (generation.method === 'enterprise_authored_product_first_frame_i2v' && generation.firstFrameOrigin !== 'enterprise_authored_storyboard') invalidProductGeneration('first_frame_origin');
    if (!Number.isFinite(generation.durationSeconds) || generation.durationSeconds <= 0) invalidProductGeneration('duration');
    if (!Array.isArray(generation.productImageRefs) || !generation.productImageRefs.length) invalidProductGeneration('product_images');
    const replication = shot.productSceneReplication;
    if (!replication) return invalidProductGeneration('replication_spec');
    if (Math.abs(generation.durationSeconds - replication.cameraLock.durationSeconds) > 0.000001) invalidProductGeneration('frozen_duration');
    if (!shot.sourceRefs.length || shot.sourceRefs.some(ref => !generation.productImageRefs.includes(ref))) invalidProductGeneration('source_refs');
    // A tenant product image is an identity input for the approved first-frame
    // editor and I2V provider. It is never itself an executable video source.
    // Reject frozen compatibility plans before an adapter can render zoom/pan.
    if (shot.sourceStrategy === 'customer_product_image_animation') invalidProductGeneration('still_image_motion_forbidden');
    if (shot.sourceStrategy !== 'aigc_product_scene_replication') invalidProductGeneration('source_strategy');
    return ['aigc_product_scene_replication'];
  }
  if (routing.materialType === 'talking_head') {
    if (routing.policy !== 'authorized_presenter' || shot.sourceStrategy !== 'authorized_digital_presenter'
      || shot.fallbackSourceStrategy !== null || !shot.digitalHumanPlan
      || !['preview_only', 'ready_for_capability_check'].includes(shot.digitalHumanPlan.executionState)) fail('authorized_presenter_required');
    // Continue through the existing reference identity lock checks below.
    return null;
  }
  return fail('unknown_material_type');
}

function strategyOrder(shot: SocialAssetSupplyShotPlan,policyVersion?:SocialAssetSupplyPlan['materialRoutingPolicyVersion']): SocialShotSourceStrategy[] {
  const materialStrategies = materialStrategyOrder(shot,policyVersion);
  if (materialStrategies) return materialStrategies;
  const routing = shot.referenceProductionRouting;
  if (routing) {
    if (routing.state !== 'ready' || routing.route === 'undetermined') throw new Error(`reference_person_automatic_analysis_required:${shot.shotId}`);
    if (routing.route === 'reference_frame_presenter') {
      if (shot.sourceStrategy !== 'authorized_digital_presenter' || !shot.digitalHumanPlan)
        throw new Error(`reference_presenter_identity_route_violation:${shot.shotId}`);
      if (!routing.identityLock?.required || !routing.identityLock.targetPresenterAssetId || !shot.digitalHumanPlan.accountPresenterLock
        || !['preview_only', 'ready_for_capability_check'].includes(shot.digitalHumanPlan.executionState))
        throw new Error(`reference_presenter_account_identity_required:${shot.shotId}`);
      if (routing.identityLock?.targetPresenterAssetId && routing.identityLock.targetPresenterAssetId !== shot.digitalHumanPlan.accountPresenterLock.presenterAssetId)
        throw new Error(`reference_presenter_account_identity_conflict:${shot.shotId}`);
      if (shot.digitalHumanPlan.referenceRequired && !shot.digitalHumanPlan.referenceMaterialIds.length)
        throw new Error(`reference_presenter_source_evidence_required:${shot.shotId}`);
      return ['authorized_digital_presenter'];
    }
    const permitted = ['library_match', 'non_presenter_library_match'].includes(routing.route)
      ? ['customer_real_asset', 'licensed_stock_asset'] : ['aigc_product_scene_replication', 'non_evidentiary_ai_visual'];
    if (!permitted.includes(shot.sourceStrategy)) throw new Error(`reference_production_route_violation:${shot.shotId}`);
    return [shot.sourceStrategy];
  }
  // The fee card promises a real product-scene generation. Provider or quality
  // failure must pause instead of silently returning a lower-quality graphic.
  if (shot.sourceStrategy === 'aigc_product_scene_replication'
    && shot.productSceneReplication && shot.sourceRefs.length > 0) {
    return ['aigc_product_scene_replication'];
  }
  // A person/presenter shot must not be silently represented as a generic
  // graphic once an authorized presenter plan has been confirmed without an
  // explicit fallback. A reviewed fallback remains a valid recovery route.
  if (shot.sourceStrategy === 'authorized_digital_presenter'
    && shot.digitalHumanPlan
    && shot.fallbackSourceStrategy === null
    && ['preview_only', 'ready_for_capability_check'].includes(shot.digitalHumanPlan.executionState)) {
    return ['authorized_digital_presenter'];
  }
  // If a preliminary route names a capability that was never made executable,
  // exclude that route and retain the plan's safe fallback. This keeps the
  // zero-input free path usable without weakening a confirmed paid route.
  return [...new Set([
    shot.sourceStrategy,
    ...(shot.fallbackSourceStrategy ? [shot.fallbackSourceStrategy] : []),
    ...(shot.truthBoundary.syntheticVisualAllowed ? ['motion_graphics' as const] : []),
  ])].filter(strategy => {
    if (strategy === 'authorized_digital_presenter') {
      return Boolean(shot.digitalHumanPlan
        && ['preview_only', 'ready_for_capability_check'].includes(shot.digitalHumanPlan.executionState));
    }
    if (strategy === 'aigc_product_scene_replication') {
      return Boolean(shot.productSceneReplication && shot.sourceRefs.length > 0);
    }
    return true;
  });
}

export async function executeSocialAssetSupplyPlan(input: {
  tenantId: string;
  taskId: string;
  operationId?: string;
  outputDirectory: string;
  plan: SocialAssetSupplyPlan;
  baseline: StoredSocialScriptBaseline;
  availableAssets: SocialProductionAsset[];
  adapters: SocialAssetSupplyProviderAdapter[];
  now?: Date;
}): Promise<SocialAssetSupplyExecutionResult> {
  const plan = alignSocialAssetSupplyPlanToBaseline({ plan: input.plan, baseline: input.baseline });
  if (input.operationId !== undefined && !/^scene_rework_[a-f0-9]{24}$/.test(input.operationId)) {
    throw new Error('asset_supply_operation_identity_invalid');
  }
  const assets: SocialProductionAsset[] = [];
  const shots: SocialAssetSupplyShotExecution[] = [];
  if(input.baseline.accountPlaybookConstraints)assertSocialAccountProductionConstraints(input.baseline.accountPlaybookConstraints);
  for (const shot of plan.shots) {
    const scene = input.baseline.scenes.find(scene=>scene.sceneId===shot.shotId);
    if (!scene) throw new Error(`asset_supply_baseline_scene_missing:${shot.shotId}`);
    const attempts: SocialAssetSupplyExecutionAttempt[] = [];
    let selected: SocialAssetSupplyAdapterResult | null = null;
    for (const strategy of strategyOrder(shot,plan.materialRoutingPolicyVersion)) {
      const adapters = input.adapters.filter(adapter => adapter.sourceStrategies.includes(strategy));
      if (!adapters.length) {
        attempts.push({ sourceStrategy: strategy, adapterId: null, status: 'adapter_not_registered', reason: null });
        continue;
      }
      for (const adapter of adapters) {
        try {
          const candidate = await adapter.execute({
            tenantId: input.tenantId,
            taskId: input.taskId,
            operationId: input.operationId,
            outputDirectory: input.outputDirectory,
            shot: { ...shot, sourceStrategy: strategy },
            baselineScene: scene,
            ...(input.baseline.accountPlaybookConstraints?{accountPlaybookConstraints:structuredClone(input.baseline.accountPlaybookConstraints)}:{}),
            availableAssets: input.availableAssets,
          });
          if (!candidate) {
            attempts.push({ sourceStrategy: strategy, adapterId: adapter.adapterId, status: 'unavailable', reason: adapter.adapterId==='existing_customer_asset.v1'
              ?`refs=${shot.sourceRefs.join(',')};segment=${shot.selectedMaterialSegment?.segmentId??'none'};available=${input.availableAssets.filter(asset=>shot.sourceRefs.includes(asset.id)||shot.sourceRefs.includes(asset.sourceId)).map(asset=>asset.id).join(',')}`:null });
            continue;
          }
          if (candidate.sourceStrategy !== strategy) {
            attempts.push({
              sourceStrategy: strategy,
              adapterId: adapter.adapterId,
              status: 'rejected_by_truth_boundary',
              reason: 'adapter_returned_wrong_strategy',
            });
            continue;
          }
          const materialRouting = shot.materialRouting;
          if (materialRouting?.localMatch.state === 'matched' && strategy === 'customer_real_asset'
            && (candidate.asset.type !== 'video' || candidate.synthetic
              || !candidate.sourceRef || !materialRouting.localMatch.sourceRefs.includes(candidate.sourceRef)
              || ![candidate.asset.sourceId, candidate.asset.id].includes(candidate.sourceRef))) {
            attempts.push({ sourceStrategy: strategy, adapterId: adapter.adapterId, status: 'rejected_by_truth_boundary', reason: 'material_route_requires_verified_local_video' });
            continue;
          }
          const violation = truthBoundaryViolation(shot, candidate);
          if (violation) {
            attempts.push({ sourceStrategy: strategy, adapterId: adapter.adapterId, status: 'rejected_by_truth_boundary', reason: violation });
            continue;
          }
          attempts.push({ sourceStrategy: strategy, adapterId: adapter.adapterId, status: 'completed', reason: null });
          selected = candidate;
          break;
        } catch (error) {
          const reason = String(error instanceof Error ? error.message : error || 'provider_failed');
          // A submitted request with an unresolved outcome is not a failed
          // candidate. Trying another adapter would hide the in-flight charge.
          if (/provider_submission_(?:unknown|uncertain)|do not resubmit|not_completed:(?:pending|uncertain)|weekly_production_cta_evidence_required/i.test(reason)) {
            throw error;
          }
          attempts.push({
            sourceStrategy: strategy,
            adapterId: adapter.adapterId,
            status: 'failed',
            reason: reason.slice(0, 240),
          });
        }
      }
      if (selected) break;
    }
    if (!selected) {
      const reasons = attempts.map(item => `${item.adapterId || item.sourceStrategy}:${item.status}${item.reason ? `:${item.reason}` : ''}`)
        .join('|').slice(0, 900);
      throw new Error(`asset_supply_provider_exhausted:${shot.shotId}:${reasons}`);
    }
    assertSocialAssetSupplyTruthBoundary({ shot, result: selected });
    assets.push(selected.asset);
    shots.push({
      shotId: shot.shotId,
      sceneId: scene.sceneId,
      function: shot.function,
      requestedSourceStrategy: shot.sourceStrategy,
      sourceStrategy: selected.sourceStrategy,
      fallbackApplied: selected.sourceStrategy !== shot.sourceStrategy,
      providerId: selected.providerId,
      assetId: selected.asset.id,
      sourceRef: selected.sourceRef,
      truthBoundary: shot.truthBoundary,
      functionalEquivalentReplacement: shot.functionalEquivalentReplacement,
      provenance: {
        synthetic: selected.synthetic,
        representation: selected.representation,
        authorizationRef: selected.authorizationRef,
        disclosure: selected.disclosure,
      },
      attempts,
    });
  }
  return {
    plan,
    assets,
    execution: {
      schemaVersion: 'social-content.asset-supply-execution.v1',
      planVersion: plan.planVersion,
      creationMode: plan.creationMode,
      productionRoute: plan.productionRoute,
      managementMode: plan.managementMode,
      executedAt: (input.now ?? new Date()).toISOString(),
      shots,
    },
  };
}
