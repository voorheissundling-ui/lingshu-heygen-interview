import type {
  SocialAgentWorkflowStage,
  SocialAssetSupplyPlan,
  SocialAssetSupplyShotPlan,
  SocialContentAgentWorkflow,
  SocialContentExecutionPlan,
  SocialContentExecutionScenePlan,
  SocialContentTaskBrief,
  SocialContentTaskStatus,
  SocialDirectorBrief,
  SocialDirectorBriefScene,
  SocialExecutionPlanReview,
  SocialInspirationHandoff,
  SocialReferenceVideoAnalysis,
  SocialReplicationJob,
  SocialReplicationJobContext,
  SocialReplicationScriptVersion,
  SocialShotSourceStrategy,
  SocialTaskSource,
} from '../../shared/contracts/socialContentWorkflow.js';
import { socialRequestHash } from './socialContentValidation.js';
import {publicationProductionDeadline} from '../socialPrograms/publicationDeadlines.js';
import type { BusinessContentGoal } from '../../shared/contracts/socialOperatingDecision.js';
import type {
  SocialWeeklyPublicationTask,
  VersionedSocialRef,
  WeeklyOperatingPackage,
  WeeklyWorkflowTask,
} from '../../shared/contracts/socialProgram.js';
import type { VersionedReferenceSelection } from '../socialDiscovery/orchestration.js';
import {
  type SocialMaterialRole,
  type SocialProductPolicy,
  type SocialSceneVisualContract,
} from '../../shared/sceneVisualContract.js';
import type { SocialReferenceReviewHandoff } from './socialReferenceReviewHandoff.js';
import { socialReferenceFidelityFailures } from './socialContentReferenceFidelity.js';
import type { MaterialAssetV2Metadata } from '../../shared/contracts/materialAssetV2.js';
import type { MaterialCapabilityManifest } from '../../shared/contracts/materialCapabilityManifest.js';
import { socialExecutionBudgetStatus } from './socialContentExecutionBudget.js';
export { socialExecutionBudgetStatus, socialExecutionExternalCost } from './socialContentExecutionBudget.js';
import { reviewSocialExecutionScene } from './socialContentExecutionSceneReview.js';
import {
  buildBusinessContext,
  buildDiscoveryBrief,
  buildInspirationHandoffs,
  buildReplicationJob,
  authoritativeHandoffs,
  mergeInspirationHandoffs,
  positiveNumber,
  stableId,
  unique,
  type SocialContentCapabilityRuntimeRegistration,
} from './socialContentAgentWorkflowContext.js';
export interface SocialWorkflowMaterialCandidate {
  assetId: string;
  sourceRef: string;
  label: string;
  mediaType: 'video' | 'image';
  previewUrl: string | null;
  origin: 'my_materials' | 'shared_library';
  matchedVoiceoverCueIds: string[];
  matchScore: number;
  segmentId?: string;
  footageEvidence?: import('../../shared/contracts/socialContentReplication.js').SocialProductFootageEvidenceBinding;
  productId?: string | null;
  productRef?: string | null;
  enterpriseCommon?: boolean;
  productPolicy?: SocialProductPolicy;
  materialRoles?: SocialMaterialRole[];
  visualContract?: SocialSceneVisualContract;
  timeRange?: { startSeconds: number; endSeconds: number } | null;
  segmentCandidateId?: string;
  sourceRevision?: string;
  materialV2?: MaterialAssetV2Metadata | null;
  /** Unified Director handoff; downstream agents must not reinterpret raw rows. */
  capabilityManifest?: MaterialCapabilityManifest;
}
export type {
  SocialContentCapabilityRuntime,
  SocialContentCapabilityRuntimeRegistration,
} from './socialContentAgentWorkflowContext.js';
export { socialContentCapabilityRegistry } from './socialContentAgentWorkflowContext.js';
import { buildDirectorBrief, capabilityCandidates, eligibleProductBudgetCandidate } from './socialContentAgentWorkflowPlanning.js';
function executionScene(input: {
  tenantId?: string;
  policyVersion?:string;
  taskId: string;
  taskVersion: string;
  scene: SocialDirectorBriefScene;
  supply: SocialAssetSupplyShotPlan;
  capabilityRuntime?: SocialContentCapabilityRuntimeRegistration[];
  materialCandidates?: SocialWorkflowMaterialCandidate[];
  preferLocalProductAnimation?: boolean;
}): SocialContentExecutionScenePlan {
  const candidates = capabilityCandidates({ ...input, sceneId: input.scene.sceneId });
  const identityLockedPresenter = input.scene.referenceProductionRouting?.state === 'ready'
    && input.scene.referenceProductionRouting.route === 'reference_frame_presenter';
  const topic = input.scene.visualTopic;
  const primaryHook = input.scene.referenceMaterial?.isPrimaryHook || input.supply.function === 'hook';
  const referenceHook = Boolean(input.scene.referenceMaterial?.isPrimaryHook
    || (input.scene.replicationFactors?.length ?? 0) > 0);
  const expressivePerson = topic?.personRole === 'expressive_action' && input.scene.productionRouting?.presenterIdentityReplacementRequired;
  const visibleSpeech = topic?.personRole === 'visible_speech' && input.scene.productionRouting?.needsPreciseLipSync
    && Boolean(input.scene.audioLayers.dialogue?.trim() || input.scene.audioLayers.voiceover?.trim());
  const matchingAsset = candidates.find(candidate => candidate.kind === 'asset'
    && candidate.sourceStrategy === 'customer_real_asset'
    && candidate.actionAndShotScore >= 0.8 && candidate.semanticScore >= 0.72);
  // For ordinary, non-evidentiary beats, a tenant-owned clip with a very high
  // subject/narration match remains a valid functional equivalent even when
  // its camera action differs from the reference. Hooks and evidence claims
  // retain the strict action/shot threshold above.
  const functionalAsset = !primaryHook && !input.supply.truthBoundary.customerEvidenceRequired
    ? candidates.find(candidate => candidate.kind === 'asset'
      && candidate.sourceStrategy === 'customer_real_asset'
      && candidate.semanticScore >= 0.9 && candidate.actionAndShotScore >= 0.25)
    : undefined;
  const capability = (strategy: SocialShotSourceStrategy) => candidates.find(candidate =>
    candidate.kind === 'capability' && candidate.sourceStrategy === strategy);
  // The Content Agent routes from observed purpose and available assets. A
  // Director-side supply hint cannot silently turn an action hook into a
  // talking avatar or a customer factory claim into generated evidence.
  const policy = visibleSpeech ? 'visible_speech'
    : expressivePerson ? 'expressive_action'
      : primaryHook ? 'hook_fidelity'
        : matchingAsset || functionalAsset ? 'reuse_material'
          : topic?.kind === 'product_introduction' ? 'product_scene' : 'needs_capability';
  const ordinaryCapability = ['motion_graphics', 'verified_fact_card'].includes(input.supply.sourceStrategy) ? capability(input.supply.sourceStrategy)
    : topic?.kind === 'factory_footage'
    ? (input.supply.truthBoundary.customerEvidenceRequired ? undefined : capability('licensed_stock_asset'))
    : input.supply.function === 'call_to_action'
      ? capability('verified_fact_card') ?? capability('motion_graphics')
    : topic?.kind === 'product_introduction'
      ? capability('aigc_product_scene_replication')
      : topic?.kind === 'competitor_comparison'
        ? capability('verified_fact_card')
        : capability('licensed_stock_asset') ?? capability('motion_graphics');
  const safeOriginalHookFallback = referenceHook
    ? undefined
    : capability('licensed_stock_asset') ?? capability('motion_graphics');
  const generatedReference=input.supply.sourceStrategy!=='customer_real_asset'
    &&Boolean(input.scene.referenceProductionRouting && ['aigc_video','non_presenter_aigc_video'].includes(input.scene.referenceProductionRouting.route));
  const mandatoryProductGeneration = input.supply.sourceStrategy === 'aigc_product_scene_replication'
    && !!input.supply.productSceneReplication && input.supply.fallbackSourceStrategy === null;
  const typedPreferred = input.supply.materialRouting
    ? input.supply.materialRouting.localMatch.state === 'matched' && input.supply.materialRouting.policy !== 'authorized_presenter'
      ? candidates.find(candidate => candidate.kind === 'asset' && candidate.sourceStrategy === 'customer_real_asset' && Boolean(candidate.sourceRef && input.supply.materialRouting!.localMatch.sourceRefs.includes(candidate.sourceRef)))
      : input.supply.materialRouting.policy === 'authorized_presenter' ? capability('authorized_digital_presenter')
        : input.supply.materialRouting.policy === 'local_first_product_i2v'||eligibleProductBudgetCandidate(input.supply,input.policyVersion)
          ? capability('aigc_product_scene_replication')
          : input.supply.materialRouting.policy === 'local_only'
            && ['motion_graphics', 'verified_fact_card'].includes(input.supply.sourceStrategy)
            ? capability(input.supply.sourceStrategy)
          : undefined
    : undefined;
  const preferred = input.supply.materialRouting ? typedPreferred : identityLockedPresenter ? capability('authorized_digital_presenter')
    : mandatoryProductGeneration ? capability('aigc_product_scene_replication')
    : generatedReference ? capability(input.supply.sourceStrategy)
    : visibleSpeech ? capability('authorized_digital_presenter') ?? matchingAsset ?? functionalAsset ?? ordinaryCapability
    : expressivePerson ? capability('authorized_digital_presenter') ?? matchingAsset ?? functionalAsset ?? ordinaryCapability
      : primaryHook && topic?.kind === 'product_introduction'
        ? capability('aigc_product_scene_replication') ?? matchingAsset ?? safeOriginalHookFallback
        : primaryHook ? matchingAsset ?? candidates.find(candidate => candidate.sourceStrategy === input.supply.sourceStrategy) ?? safeOriginalHookFallback
          : matchingAsset ?? functionalAsset ?? ordinaryCapability;
  const fallback = candidates.find(candidate => candidate.sourceStrategy === input.supply.fallbackSourceStrategy && candidate.candidateId !== preferred?.candidateId);
  const factorDetectionPlan = (factor: NonNullable<SocialDirectorBriefScene['replicationFactors']>[number]) => {
    const wholeOutput = factor.policy === 'prohibit_reuse';
    const validationScope = wholeOutput ? 'whole_output' as const
      : factor.category === 'rhythm' || factor.category === 'hook' ? 'timeline_segment' as const
        : factor.category === 'audio' ? 'audio_track' as const
          : factor.category === 'caption' ? 'caption_track' as const
            : 'scene_frames' as const;
    const requiredEvidence = validationScope === 'whole_output' ? ['fingerprint_measurement'] as const
      : validationScope === 'timeline_segment' ? ['reference_frame', 'output_frame', 'timeline_measurement'] as const
        : validationScope === 'audio_track' ? ['audio_segment'] as const
          : validationScope === 'caption_track' ? ['caption_text'] as const
            : ['reference_frame', 'output_frame'] as const;
    const detectorReady = Boolean(factor.validator.validatorId.trim() && factor.validator.detector.trim());
    return { validationScope, requiredEvidence: [...requiredEvidence], detectorReady };
  };
  return {
    sceneId: input.scene.sceneId,
    routeDecision: {
      visualTopic: topic,
      policy,
      reason: identityLockedPresenter ? input.scene.referenceProductionRouting!.reason : expressivePerson ? '人物明显动作需要已验收的首帧动作能力；当前注册能力不满足，退回补能力或改镜'
        : visibleSpeech ? '可见口播需要企业授权人物与逐句口型能力'
          : primaryHook ? '开场钩子先保持参考表现机制，再核对可执行素材或能力'
            : matchingAsset ? '现有素材满足视觉主题、表达目的与画面契约'
              : functionalAsset ? '现有素材与主体及逐句口播高度匹配，可作为普通镜头的功能等价画面'
              : '没有合格素材，按分镜目标检查可用能力',
      source: 'content_agent',
    },
    replicationFactorIds: (input.scene.replicationFactors ?? []).map(factor => factor.factorId),
    factorFeasibility: (input.scene.replicationFactors ?? []).map(factor => {
      const required = factor.semanticAdaptation?.status !== 'functionally_replaced';
      const detection = factorDetectionPlan(factor);
      return {
        factorId: factor.factorId,
        required,
        // A post-render detector plan is executable independently of whether
        // the Content Agent has already selected the production candidate.
        // Candidate absence is reviewed once by the candidate gate below; it
        // must not fan out into one false factor failure per frozen factor.
        feasible: required ? detection.detectorReady : true,
        reason: required
          ? `${preferred ? `由推荐候选 ${preferred.label} 承担` : '生产候选待补齐'}；成片后由 ${factor.validator.detector} 对 ${detection.validationScope} 独立检测`
          : factor.semanticAdaptation!.replacementReason!,
        plannedValidatorId: required ? factor.validator.validatorId : '',
        ...(required ? {
          validationScope: detection.validationScope,
          requiredEvidence: detection.requiredEvidence,
          detectorIndependence: 'independent_post_render' as const,
          plannedCandidateId: preferred?.candidateId ?? null,
        } : {}),
        ...(factor.semanticAdaptation ? { semanticAdaptation: structuredClone(factor.semanticAdaptation) } : {}),
      };
    }),
    feasibility: preferred&&eligibleProductBudgetCandidate(input.supply,input.policyVersion)&&preferred.sourceStrategy==='aigc_product_scene_replication'
      ? 'functional_equivalent' : preferred ? input.supply.feasibility : 'blocked_for_facts_or_rights',
    feasibilityReason: preferred&&eligibleProductBudgetCandidate(input.supply,input.policyVersion)&&preferred.sourceStrategy==='aigc_product_scene_replication'
      ? '已有当前产品身份输入和注册生成能力；仅进入整片真实报价预检，尚未获得付费调用授权。'
      : preferred ? input.supply.feasibilityReason : '内容 Agent 未找到满足本镜头要求的可执行素材或能力',
    candidates,
    recommendedCandidateIds: preferred ? [preferred.candidateId] : [],
    alternativeCandidateGroups: fallback ? [[fallback.candidateId]] : [],
    selectedSourceStrategy: preferred?.sourceStrategy ?? input.supply.sourceStrategy,
    fallbackSourceStrategy: fallback?.sourceStrategy ?? input.supply.fallbackSourceStrategy,
    estimatedCostCny: preferred?.estimatedCostCny ?? 0,
    estimatedSeconds: preferred?.estimatedSeconds ?? 0,
    estimatedSuccessRate: preferred?.estimatedSuccessRate ?? 0,
    rightsRisks: candidates.some(candidate => candidate.rightsStatus === 'requires_confirmation' || candidate.rightsStatus === 'restricted')
      ? ['部分外部能力受授权范围限制，执行前必须校验租户授权'] : [],
    dataTransferRisks: preferred?.dataTransfer === 'external_processor' ? ['推荐路线会把必要输入发送给外部处理服务'] : [],
    idempotencyKey: stableId('social_scene_execution', { taskId: input.taskId, taskVersion: input.taskVersion, sceneId: input.scene.sceneId }),
    ...(input.supply.productSceneReplication ? {
      productSceneReplication: structuredClone(input.supply.productSceneReplication),
    } : {}),
  };
}
function buildExecutionPlan(input: BuildSocialAgentWorkflowInput, directorBrief: SocialDirectorBrief): SocialContentExecutionPlan {
  const supplyById = new Map(input.assetSupplyPlan.shots.map(shot => [shot.shotId, shot]));
  let paidProductSceneCount = 0;
  const scenes = directorBrief.scenes.flatMap(scene => {
    const supply = supplyById.get(scene.sceneId);
    const productSceneOrdinal = supply?.sourceStrategy === 'aigc_product_scene_replication'
      ? ++paidProductSceneCount : 0;
    return supply ? [executionScene({
      tenantId: input.tenantId,
      policyVersion:input.assetSupplyPlan.materialRoutingPolicyVersion,
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      scene,
      supply,
      capabilityRuntime: input.capabilityRuntime,
      materialCandidates: input.materialCandidates,
      // Keep the two strongest product beats as generated scenes. Later value
      // and CTA beats use the exact owned product image with a local motion
      // treatment so an 18-second film remains inside the whole-film ceiling.
      preferLocalProductAnimation: productSceneOrdinal > 2
        && ['value', 'call_to_action'].includes(supply.function),
    })] : [];
  });
  const selectedApproach = input.brief.productionApproach ?? 'ai_enhanced';
  const ownMaterials = (input.materialCandidates ?? []).filter(item => item.origin === 'my_materials');
  const selectedMaterialIds = unique(scenes.flatMap(scene => {
    const recommended = new Set(scene.recommendedCandidateIds);
    return scene.candidates
      .filter(candidate => recommended.has(candidate.candidateId)
        && candidate.kind === 'asset' && candidate.sourceRef)
      .map(candidate => input.materialCandidates?.find(item => (
        item.sourceRef === candidate.sourceRef || item.assetId === candidate.sourceRef
      ))?.assetId || '');
  }).filter(Boolean));
  const previewMaterial = selectedMaterialIds
    .map(assetId => ownMaterials.find(item => item.assetId === assetId))
    .find((item): item is SocialWorkflowMaterialCandidate => Boolean(item))
    ?? ownMaterials[0]
    ?? null;
  const firstFramePreview = previewMaterial ? {
    assetId: previewMaterial.assetId,
    label: previewMaterial.label,
    mediaType: previewMaterial.mediaType,
    url: previewMaterial.previewUrl,
    sourceTimestampSeconds: 0 as const,
  } : null;
  const currentEstimatedCost = +scenes.reduce((sum, scene) => sum + scene.estimatedCostCny, 0).toFixed(2);
  return {
    executionPlanId: stableId('execution_plan', { taskId: input.taskId }),
    version: input.taskVersion,
    directorBriefId: directorBrief.directorBriefId,
    directorBriefVersion: directorBrief.version,
    status: directorBrief.status === 'ready' && scenes.length === directorBrief.scenes.length ? 'review_required' : 'blocked',
    reviewRound: 1,
    maxReviewRounds: 3,
    budgetLimitCny: positiveNumber(input.brief.perItemBudgetCny),
    deadlineAt: input.brief.dueAt,
    accountPresenterLock: directorBrief.accountPresenterLock
      ? structuredClone(directorBrief.accountPresenterLock)
      : null,
    estimatedTotalCostCny: currentEstimatedCost,
    estimatedTotalSeconds: +scenes.reduce((sum, scene) => sum + scene.estimatedSeconds, 0).toFixed(1),
    selectedApproach,
    productionOptions: [
      {
        approach: 'ai_enhanced',
        label: '智能混合制作·主推',
        description: '人物出镜自动使用账号数字人，产品展示自动使用产品身份锁定 IAIGC，其余镜头逐句匹配“我的素材”。',
        qualityTier: 'premium',
        available: true,
        unavailableReason: null,
        usesPaidProviders: true,
        estimatedCostCny: selectedApproach === 'ai_enhanced' ? currentEstimatedCost : Math.max(1, directorBrief.scenes.length * 3.6),
        includedOperations: ['前三秒精细生成约束', '数字人动作复现', '产品 IAIGC 场景复现', '逐句素材剪辑', '完整质量检查'],
        selectedMaterialIds,
        firstFramePreview,
      },
      {
        approach: 'material_cut',
        label: '免费素材剪辑',
        description: '逐句匹配“我的素材”，只做裁切、拼接、变速与字幕，不生成人物或产品画面。',
        qualityTier: 'standard',
        available: ownMaterials.length > 0,
        unavailableReason: ownMaterials.length ? null : '“我的素材”中没有可读取的图片或视频',
        usesPaidProviders: false,
        estimatedCostCny: 0,
        includedOperations: ['逐句语义匹配', '片段裁切', '节奏重排', '字幕与基础转场'],
        selectedMaterialIds: selectedMaterialIds.length ? selectedMaterialIds : ownMaterials.slice(0, 8).map(item => item.assetId),
        firstFramePreview,
      },
      {
        approach: 'shooting_plan',
        label: '建立代拍清单',
        description: '不立即生成视频，把编导方案转成可交给代拍团队的镜头、动作、场景、产品状态和验收清单。',
        qualityTier: 'enhanced',
        available: true,
        unavailableReason: null,
        usesPaidProviders: false,
        estimatedCostCny: 0,
        includedOperations: ['镜头清单', '表演与动作指令', '场景与道具要求', '产品状态与效果要求', '验收标准'],
        selectedMaterialIds: [],
        firstFramePreview: null,
      },
    ],
    referenceFirstFramePreview: input.referencePreviewUrl ? {
      label: '参考视频前三秒首帧',
      mediaType: 'image',
      url: input.referencePreviewUrl,
      sourceTimestampSeconds: 0,
    } : null,
    scenes,
    createdBy: 'content_agent',
  };
}
function buildReview(input: BuildSocialAgentWorkflowInput, directorBrief: SocialDirectorBrief, plan: SocialContentExecutionPlan): SocialExecutionPlanReview {
  const budget = socialExecutionBudgetStatus(plan, directorBrief, input.tenantId);
  const estimatedCost = budget.estimatedCostCny;
  const budgetPreflightRequired=input.assetSupplyPlan.materialRoutingPolicyVersion==='type-aware.v2';
  const budgetExceeded = budget.exceeded&&!budgetPreflightRequired;
  const planByScene = new Map(plan.scenes.map(scene => [scene.sceneId, scene]));
  const shootingPlanOnly = plan.selectedApproach === 'shooting_plan';
  const sceneResults = directorBrief.scenes.flatMap(scene => {
    const scenePlan = planByScene.get(scene.sceneId);
    if (shootingPlanOnly && scenePlan) return [{
      sceneId: scene.sceneId,
      approved: true,
      feasibility: scenePlan.feasibility,
      failedCriteria: [],
      requiredRevision: [],
      goalImpact: 'none' as const,
      reasonCodes: [],
    }];
    return scenePlan ? [reviewSocialExecutionScene({
      scene,
      plan: scenePlan,
      weekly: input.mode === 'weekly',
      rightsMissing: input.assetSupplyPlan.status === 'requires_rights_confirmation',
      enforceTruthGates: input.assetSupplyPlan.materialRoutingPolicyVersion==='type-aware.v2',
      conceptPreview: input.brief.productionMode === 'concept_preview',
    })] : [];
  });
  const directorBlocked = directorBrief.status === 'blocked';
  const referenceBlocked = input.brief.creationMode === 'viral_replication'
    && input.referenceReviewHandoff?.productionExecutionAllowed !== true;
  const fidelityFailures = input.brief.creationMode === 'viral_replication'
    ? socialReferenceFidelityFailures({ referenceAnalysis: input.referenceAnalysis, replicationScript: input.replicationScript }) : [];
  const approved = !directorBlocked && !referenceBlocked && !budgetExceeded
    && sceneResults.length === directorBrief.scenes.length && sceneResults.every(result => result.approved);
  const failedCriteria = unique([
    ...(directorBlocked ? ['导演方案或参考分析尚未满足完整性要求'] : []),
    ...(referenceBlocked ? ['参考视频的逐句时间码、分镜证据或授权尚未通过生产门禁'] : []),
    ...(budgetExceeded ? [`全片预计外部成本 ¥${estimatedCost.toFixed(2)} 超过预算 ¥${plan.budgetLimitCny!.toFixed(2)}`] : []),
    ...fidelityFailures,
    ...sceneResults.flatMap(result => result.failedCriteria),
  ]);
  const requiredRevision = unique([
    ...(directorBlocked ? ['补齐参考分析覆盖或导演方案后重新规划'] : []),
    ...(fidelityFailures.length ? ['逐槽恢复参考镜头身份、顺序与原始时间区间；预算不得缩短或合并参考时间线'] : []),
    ...(budgetExceeded ? ['改用有真实成本依据的预算内路线、复用已验收成片资产，或请求预算确认'] : []),
    ...(referenceBlocked ? (input.referenceReviewHandoff?.issues?.length
      ? input.referenceReviewHandoff.issues.map(issue => issue.action).filter(action => action.trim())
      : ['补齐参考视频的动作、声音、分镜及授权证据后重新审核']) : []),
    ...sceneResults.flatMap(result => result.requiredRevision),
  ]);
  const reasonCodes = unique([
    ...(directorBlocked ? ['expression_failed' as const] : []),
    ...(referenceBlocked ? ['expression_failed' as const] : []),
    ...(budgetExceeded ? ['budget_exceeded' as const] : []),
    ...sceneResults.flatMap(result => result.reasonCodes),
  ]);
  return {
    ...(budgetPreflightRequired?{budgetPreflight:{state:'required' as const,advisoryEstimatedCostCny:estimatedCost,maximumCny:plan.budgetLimitCny,advisoryExceeded:budget.exceeded}}:{}),
    reviewId: stableId('execution_plan_review', { taskId: input.taskId, taskVersion: input.taskVersion,
      referenceHandoffVersion: input.referenceReviewHandoff?.versionHash ?? null, round: plan.reviewRound }),
    version: input.taskVersion,
    executionPlanId: plan.executionPlanId,
    executionPlanVersion: plan.version,
    directorBriefId: directorBrief.directorBriefId,
    directorBriefVersion: directorBrief.version,
    approved,
    sceneResults,
    failedCriteria,
    requiredRevision,
    goalImpact: approved ? 'none' : input.mode === 'weekly' ? 'weekly_plan' : 'video',
    reasonCodes,
    createdBy: 'director_agent',
  };
}

function taskStage(input: BuildSocialAgentWorkflowInput, review: SocialExecutionPlanReview, replicationJob: SocialReplicationJob | null): SocialAgentWorkflowStage {
  if (!review.approved) {
    if (review.reasonCodes.includes('rights_missing')) return 'needs_rights';
    if (review.reasonCodes.includes('facts_missing')) return 'needs_facts';
    if (review.reasonCodes.includes('budget_exceeded')) return 'needs_budget';
    if (review.sceneResults.some(result => result.feasibility === 'goal_degraded')) return 'goal_degraded';
    if (replicationJob?.status === 'factor_ready') return 'factor_ready';
    if (replicationJob?.status === 'reference_ready' || replicationJob?.status === 'blocked') return 'reference_ready';
    if (input.referenceAnalysis?.status !== 'ready' && input.brief.creationMode === 'viral_replication') return 'planned';
    return 'director_review';
  }
  const mapping: Partial<Record<SocialContentTaskStatus, SocialAgentWorkflowStage>> = {
    draft: 'planned',
    needs_input: 'planned',
    plan_review: 'director_ready',
    producing: 'producing',
    asset_review: 'asset_review',
    packaging: 'ready_to_publish',
    delivered: 'ready_to_publish',
    awaiting_publish: 'ready_to_publish',
    awaiting_metrics: 'ready_to_publish',
    reviewed: 'ready_to_publish',
    paused: 'failed_recoverable',
    attention: 'failed_recoverable',
  };
  return mapping[input.taskStatus] ?? 'director_review';
}

export interface BuildSocialAgentWorkflowInput {
  /** Exact tenant scope used for server-side internal budget policy. */
  tenantId?: string;
  taskId: string;
  taskVersion: string;
  taskStatus: SocialContentTaskStatus;
  mode: 'weekly' | 'instant';
  weeklyPlanId: string | null;
  brief: SocialContentTaskBrief;
  sources: SocialTaskSource[];
  factSourceRefs: string[];
  assetSupplyPlan: SocialAssetSupplyPlan;
  referenceAnalysis: SocialReferenceVideoAnalysis | null;
  /** Version-bound reference gate; Content may plan but cannot execute while false. */
  referenceReviewHandoff?: Pick<SocialReferenceReviewHandoff, 'productionExecutionAllowed' | 'versionHash'> & Partial<Pick<SocialReferenceReviewHandoff, 'issues'>> | null;
  replicationScript: SocialReplicationScriptVersion | null;
  /** Optional versioned account/content lineage; omitted on historic tasks. */
  replicationContext?: SocialReplicationJobContext;
  /** Additional references used only by series/hybrid modes. */
  inspirationHandoffs?: SocialInspirationHandoff[];
  /** Frozen T3/T4 authority. When present, legacy weeklyPlanId and caller facts are projections only. */
  authoritativeContext?: {
    programRef: VersionedSocialRef;
    enterpriseProfileRef: VersionedSocialRef;
    weeklyPackage: WeeklyOperatingPackage;
    weeklyWorkflowTask: WeeklyWorkflowTask;
    publicationTask: SocialWeeklyPublicationTask;
    businessGoal: BusinessContentGoal;
    referenceSelection: VersionedReferenceSelection;
    selectedHandoffs: SocialInspirationHandoff[];
  };
  /** Runtime registrations after adapter and environment readiness checks. Omit to use only embedded adapters. */
  capabilityRuntime?: SocialContentCapabilityRuntimeRegistration[];
  materialCandidates?: SocialWorkflowMaterialCandidate[];
  inferredProductRef?: string | null;
  enterprisePresenterAssetRef?: string | null;
  referencePreviewUrl?: string | null;
  now?: Date;
}

function assertAuthoritativeContext(input: BuildSocialAgentWorkflowInput): void {
  const authority = input.authoritativeContext;
  if (!authority) return;
  const packageTask = authority.weeklyPackage.workflowTasks.find(item => item.taskId === authority.weeklyWorkflowTask.taskId);
  const publicationTask = authority.weeklyPackage.socialContentPackage.publicationTasks
    .find(item => item.publicationTaskId === authority.publicationTask.publicationTaskId);
  const publicationInput = (item: typeof authority.publicationTask) => {
    const {status, ...frozen} = item;
    return frozen;
  };
  if (authority.weeklyPackage.programId !== authority.programRef.id
    || authority.businessGoal.programId !== authority.weeklyPackage.programId
    || authority.weeklyPackage.businessContentGoalRef?.id !== authority.businessGoal.goalId
    || authority.weeklyPackage.enterpriseProfileRef?.id !== authority.enterpriseProfileRef.id
    || !packageTask || packageTask.kind !== 'content' || !publicationTask
    || (publicationTask && socialRequestHash(publicationInput(publicationTask)) !== socialRequestHash(publicationInput(authority.publicationTask)))
    || !packageTask.subjectRefs.some(ref => ref.type === 'weekly_publication_task'
      && ref.id === publicationTask.publicationTaskId && ref.version === authority.weeklyPackage.version)
    || publicationTask.factRefs.some(factRef => !authority.businessGoal.publicFactRefs.some(goalFact => (
      goalFact.type === factRef.type && goalFact.id === factRef.id && goalFact.version === factRef.version
    )))
    || authority.referenceSelection.upstreamTaskRef !== authority.weeklyWorkflowTask.taskId) {
    throw new Error('social_content_authoritative_context_mismatch');
  }
  const mode = input.replicationContext?.referenceMode ?? input.brief.referenceMode;
  if (mode === 'single_source_fidelity') {
    const selected = authority.referenceSelection.selected;
    if (selected.length !== 1 || selected[0]?.readiness !== 'production_reference') {
      throw new Error('social_content_fidelity_primary_reference_required');
    }
  }
}

/**
 * Compatibility projection for the unified Business → Director → Content
 * chain. Historic storage remains readable; new clients consume agent-owned
 * objects without allowing the Director to lock assets or providers.
 */
export function buildSocialAgentWorkflow(input: BuildSocialAgentWorkflowInput): SocialContentAgentWorkflow {
  assertAuthoritativeContext(input);
  if (input.authoritativeContext) {
    input = {...input, brief: {...input.brief,
      dueAt: publicationProductionDeadline(input.authoritativeContext.publicationTask.publishWindow),
    }};
  }
  const context = buildBusinessContext(input);
  const discoveryBrief = buildDiscoveryBrief(input);
  const inspirationHandoffs = mergeInspirationHandoffs(
    input.authoritativeContext ? [] : buildInspirationHandoffs(input),
    authoritativeHandoffs(input),
  );
  const replicationJob = buildReplicationJob(input, context, inspirationHandoffs);
  const directorBrief = buildDirectorBrief(input, context, inspirationHandoffs, replicationJob);
  if (replicationJob?.status === 'factor_ready' && directorBrief.status === 'ready') replicationJob.status = 'director_ready';
  const executionPlan = buildExecutionPlan(input, directorBrief);
  const executionPlanReview = buildReview(input, directorBrief, executionPlan);
  executionPlan.status = executionPlanReview.approved ? 'approved' : 'blocked';
  return {
    schemaVersion: 'social-content-agent-workflow.v2',
    stage: taskStage(input, executionPlanReview, replicationJob),
    contentPlanId: stableId('content_plan', { weeklyPlanId: input.weeklyPlanId, taskId: input.taskId }),
    videoTaskId: input.taskId,
    weeklyPackage: context.weeklyPackage,
    adHocBusinessContext: context.adHocBusinessContext,
    discoveryBrief,
    inspirationHandoffs,
    replicationJob,
    responsibilityBoundary: {
      businessGoalOwner: 'business_agent',
      factorDecisionOwner: 'director_agent',
      executionOwner: 'content_agent',
      metricEvidenceProvider: 'metrics_worker',
      mediaEvidenceProvider: 'media_evaluation_worker',
      finalGateOrder: ['content_agent', 'media_evaluation_worker', 'director_agent', 'business_agent', 'rules_engine'],
      selfApprovalForbidden: true,
    },
    directorBrief,
    executionPlan,
    executionPlanReview,
    productionResult: null,
    replicationEvaluation: null,
  };
}
