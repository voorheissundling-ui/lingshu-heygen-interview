import type {
  SocialAssetSupplyShotPlan,
  SocialDirectorBrief,
  SocialDirectorBriefScene,
  SocialExecutionCandidate,
  SocialInspirationHandoff,
  SocialReferenceShotAnalysis,
  SocialReferenceVideoAnalysis,
  SocialReplicationFactorSpec,
  SocialReplicationJob,
  SocialReplicationScriptShot,
  SocialShotSourceStrategy,
  SocialShotTruthBoundary,
} from '../../shared/contracts/socialContentWorkflow.js';
import {
  normalizeSceneVisualContract,
  scoreSceneVisualCompatibility,
  type SocialProductPolicy,
  type SocialProductPolicySource,
} from '../../shared/sceneVisualContract.js';
import { socialReferenceFidelityFailures } from './socialContentReferenceFidelity.js';
import {
  buildBusinessContext,
  socialContentEmbeddedRuntimeRegistrations,
  positiveNumber,
  socialContentCapabilityRegistry,
  stableId,
  unique,
  type SocialContentCapabilityRuntimeRegistration,
} from './socialContentAgentWorkflowContext.js';

import type { BuildSocialAgentWorkflowInput, SocialWorkflowMaterialCandidate } from './socialContentAgentWorkflow.js';

export function safeBoundary(boundary: SocialShotTruthBoundary): SocialShotTruthBoundary {
  return {
    ...boundary,
    // The Director declares what evidence is required; the Content Agent owns
    // the actual asset choice and therefore receives no preselected asset ids.
    customerEvidenceRefs: [],
    confirmedFactRefs: [...boundary.confirmedFactRefs],
    prohibitedRepresentations: [...boundary.prohibitedRepresentations],
  };
}
export function requiredEvidence(boundary: SocialShotTruthBoundary, purpose: SocialDirectorBriefScene['purpose'], typedMaterial = false): string[] {
  const subjectLabel = boundary.subject === 'customer_factory' ? '优先使用“我的素材”中的真实工厂或生产过程'
    : boundary.subject === 'customer_case' ? '优先使用“我的素材”中的客户案例'
      : boundary.subject === 'product_effect' ? typedMaterial ? '消费者使用或效果镜头仅使用已核验真实素材，不生成效果或消费者证据' : '人物使用产品的效果镜头使用数字人路线'
        : null;
  return unique([
    ...(subjectLabel ? [subjectLabel] : []),
    ...(purpose === 'proof' ? ['直接优先调用已入库的工厂、客户案例或产品效果素材'] : []),
  ]);
}
export function sceneProductSelection(input: BuildSocialAgentWorkflowInput): {
  policy: SocialProductPolicy;
  source: SocialProductPolicySource;
  productId: string | null;
  productRef: string | null;
} {
  if (input.brief.productId || input.brief.productRef) return {
    policy: 'locked', source: 'user_explicit',
    productId: input.brief.productId ?? null,
    productRef: input.brief.productRef,
  };
  if (input.inferredProductRef) return { policy: 'preferred', source: 'agent_inferred', productId: null, productRef: input.inferredProductRef };
  return { policy: 'open', source: 'inventory_open', productId: null, productRef: null };
}
export function shotLanguage(reference: SocialReferenceShotAnalysis | undefined) {
  const tags = reference?.tags.cameraLanguage ?? [];
  const pick = (pattern: RegExp, fallback: string) => tags.find(item => pattern.test(item)) || fallback;
  return {
    shotSize: pick(/特写|近景|中景|全景|远景|close|medium|wide/i, '根据主体信息密度选择明确景别'),
    cameraAngle: pick(/平视|俯拍|仰拍|侧面|正面|angle|overhead|low/i, '保持主体关系清楚的稳定机位'),
    movement: pick(/推进|拉远|横移|跟拍|手持|固定|推拉|pan|track|static/i, '运镜服务于信息揭示，不做无目的运动'),
    composition: pick(/构图|中心|对称|三分|前景|留白|composition/i, '主体、证据和字幕安全区互不遮挡'),
  };
}
export function visualTopicFor(reference: SocialReferenceShotAnalysis | undefined, targetVisual: string, intent: string): NonNullable<SocialDirectorBriefScene['visualTopic']> {
  const subject = reference?.semanticLabel?.content || targetVisual;
  const description = [subject, reference?.visualDescription, ...(reference?.tags.sceneTypes ?? [])].filter(Boolean).join(' ');
  const personIsForeground = /(?:女|男)?主播|女主|男主|人物|真人|女性|男性|口播|数字人|presenter|talking/i.test(description)
    && !/背影|背景人物|远景人物|路人|人群|silhouette|background person/i.test(description);
  const personHasAction = /手势|靠近|凑近|转身|敲门|gesture|approach/i.test(description);
  const kind = personIsForeground && personHasAction ? 'presenter_talking'
    : /工厂|车间|生产线|灌装|factory|manufactur/i.test(description) ? 'factory_footage'
    : /竞品|对比|比较|before.?after|competitor|comparison/i.test(description) ? 'competitor_comparison'
      : /产品|商品|包装|质地|瓶身|product|packaging/i.test(description) ? 'product_introduction'
      : /口播|主播|女主|男主|人物|真人|数字人|女性|男性|女主播|男主播|presenter|talking/i.test(description) ? 'presenter_talking' : 'other';
  const personRole = /背影|背景人物|远景人物|路人|人群|silhouette|background person/i.test(description) ? 'background'
    : /手势|靠近|凑近|转身|敲门|双臂|手臂|动作|gesture|approach/i.test(description) && personIsForeground ? 'expressive_action'
      : /口播|说话|对镜|口型|唇|talking|speaking/i.test(description) && personIsForeground ? 'visible_speech'
        : personIsForeground ? 'visible_speech' : 'none';
  return { kind, subject, intent: reference?.semanticLabel?.intent || intent, personRole };
}
export function directorScene(input: {
  index: number;
  script: SocialReplicationScriptShot | null;
  supply: SocialAssetSupplyShotPlan;
  reference: SocialReferenceShotAnalysis | undefined;
  replicationFactors: SocialReplicationFactorSpec[];
  productSelection: ReturnType<typeof sceneProductSelection>;
  primaryHook: SocialReferenceVideoAnalysis['hookAnalysis'];
  enterprisePresenterAssetRef: string | null;
  functionalReplacement: boolean;
}): SocialDirectorBriefScene {
  const startSeconds = input.script?.startSeconds ?? input.reference?.startSeconds ?? input.index * 3;
  const endSeconds = input.script?.endSeconds ?? input.reference?.endSeconds ?? startSeconds + 3;
  const targetVisual = input.script?.visualInstruction || input.supply.requestedDescription || '用清楚、可验证的画面完成本镜头的信息作用';
  // Each line can be associated with several visual cuts, but only its owner
  // shot plays the narration. This avoids repeating one sentence at every cut.
  const spokenText = input.script?.speechLines
    ?.filter(line => !line.narrationOwnerShotId || line.narrationOwnerShotId === input.script?.shotId)
    .map(line => line.draftText.trim()).filter(Boolean).join(' ')
    || input.script?.spokenText || null;
  const boundary = safeBoundary(input.supply.truthBoundary);
  const evidence = requiredEvidence(boundary, input.supply.function, Boolean(input.supply.materialRouting));
  const visualContract = normalizeSceneVisualContract({
    ...(input.supply.visualContract ?? input.reference?.visualContract ?? {
      subjects: input.reference?.tags.subjects ?? [],
      interaction: input.reference?.action?.path ?? targetVisual,
      environment: input.reference?.tags.sceneTypes?.[0] ?? '',
      action: input.reference?.action ?? { path: targetVisual },
      shotLanguage: input.reference?.shotLanguage ?? shotLanguage(input.reference),
      evidence: { sourceRange: { startSeconds, endSeconds } },
    }),
    product: {
      policy: input.productSelection.policy,
      requestedProductId: input.productSelection.productId,
      requestedProductRef: input.productSelection.productRef,
      source: input.productSelection.source,
    },
    precision: startSeconds < 3 ? 'hook_high' : 'standard',
  });
  const reference = input.reference;
  const typedRouting = input.supply.materialRouting;
  const reviewedLocalVideo = typedRouting?.policy === 'local_only' && typedRouting.localMatch?.state === 'matched';
  const referenceRouting = typedRouting && typedRouting.materialType !== 'talking_head' ? undefined : reference?.referenceProductionRouting;
  const identityLockedPresenter = referenceRouting?.state === 'ready' && referenceRouting.route === 'reference_frame_presenter';
  // Optional continuity analysis controls identity fidelity, not whether a
  // plainly visible foreground person exists. An unresolved route must not
  // erase observable presenter evidence and silently replace a talking-head
  // shot with a product still.
  const presenterVisible = typedRouting ? typedRouting.materialType === 'talking_head' : Boolean(identityLockedPresenter) || Boolean(reference && /真人|人物|人像|口播|数字人|主播|女性|男性|女主|男主|模特|presenter|person|human|face|talking/i.test([
    reference.visualDescription, reference.semanticLabel?.content, ...reference.tags.subjects,
  ].filter(Boolean).join(' ')));
  const isPrimaryHook = Boolean(reference && input.primaryHook?.referencePoints.includes(reference.shotId));
  const needsExpressiveAction = Boolean(reference && /手势|指向|凑近|靠近|转身|拿起|展示|动作|gesture|approach|point|move/i.test([
    reference.visualDescription, reference.action?.path, reference.semanticLabel?.content,
  ].filter(Boolean).join(' ')));
  const needsCameraOrCompositionReconstruction = Boolean(isPrimaryHook || (reference && /推进|拉远|运镜|构图|特写|镜头|camera|composition|zoom|pan/i.test([
    reference.visualDescription, reference.shotLanguage?.movement, reference.shotLanguage?.composition,
  ].filter(Boolean).join(' '))));
  const personRole = typedRouting?.materialType === 'talking_head'
    ? Boolean(spokenText || reference?.spokenText) ? 'visible_speech' : needsExpressiveAction ? 'expressive_action' : 'visible_speech'
    : identityLockedPresenter ? referenceRouting.observedPresenterRole === 'presenter_action' ? 'expressive_action' : 'visible_speech'
    : visualTopicFor(reference, targetVisual, input.supply.function).personRole;
  const visibleMouth = personRole === 'visible_speech' || (personRole === 'expressive_action'
    && (Boolean(spokenText || reference?.spokenText) || /口播|说话|对镜|唇|talking|speaking/i.test([
      reference?.visualDescription, reference?.semanticLabel?.content,
    ].filter(Boolean).join(' '))));
  const needsPreciseLipSync = !reviewedLocalVideo && presenterVisible && visibleMouth && Boolean(spokenText || reference?.spokenText);
  return {
    sceneId: input.script?.shotId || input.supply.shotId,
    order: input.index + 1,
    referenceShotId: input.script?.referenceShotId ?? input.reference?.shotId ?? null,
    ...(referenceRouting ? { referenceProductionRouting: structuredClone(referenceRouting) } : {}),
    visualTopic: visualTopicFor(input.reference, targetVisual, input.supply.function),
    ...(reference ? {
      referenceMaterial: {
        semanticLabel: reference.semanticLabel ?? null,
        sourceVideoRef: reference.materialEvidence?.sourceVideoRef ?? null,
        clipRef: reference.materialEvidence?.clipRef ?? null,
        firstFrameRef: reference.materialEvidence?.firstFrameRef ?? null,
        firstFrameSeconds: reference.materialEvidence?.firstFrameSeconds ?? null,
        extractionStatus: reference.materialEvidence?.extractionStatus ?? 'unavailable' as const,
        isPrimaryHook,
        hookDetail: isPrimaryHook ? input.primaryHook?.detailedAnalysis ?? null : null,
      },
      productionRouting: {
        presenterVisible,
        presenterIdentityReplacementRequired: !reviewedLocalVideo && presenterVisible && personRole !== 'background',
        enterprisePresenterAssetRef: !reviewedLocalVideo && presenterVisible && personRole !== 'background' ? input.enterprisePresenterAssetRef : null,
        needsPreciseLipSync,
        needsExpressiveAction,
        needsCameraOrCompositionReconstruction,
        decisionReason: [
          ...(presenterVisible ? ['人物镜头必须使用原分镜首帧作为构图证据，并替换为企业人物身份'] : []),
          ...(needsPreciseLipSync ? ['镜头包含可见人物口播，需校验逐字口型同步'] : []),
          ...(needsExpressiveAction ? ['镜头含动作或手势，需保留动作轨迹'] : []),
          ...(needsCameraOrCompositionReconstruction ? ['镜头含钩子或明确镜头语言，需还原构图与运镜'] : []),
        ],
      },
    } : {}),
    purpose: input.supply.function,
    targetVisual,
    visualContract,
    requiredEvidence: evidence,
    action: {
      startState: input.index === 0 ? '第一帧立即出现清楚主体' : '承接上一镜的主体、方向和信息状态',
      path: targetVisual,
      endState: input.supply.function === 'call_to_action' ? '画面停留在明确行动信息上' : '以稳定主体或动作结果衔接下一镜',
    },
    shotLanguage: shotLanguage(input.reference),
    spaceAndContinuity: [
      '人物、产品、包装和品牌元素在前后镜保持一致',
      '动作方向、主体位置和环境关系不得无解释跳变',
    ],
    audioLayers: {
      voiceover: spokenText,
      dialogue: null,
      captionIntent: input.script?.captionText ?? null,
      ambient: input.reference?.audioDescription ?? null,
      music: input.script?.audioAndTransition ?? null,
      soundEffects: null,
    },
    ...(input.script?.speechLines?.length ? {
      voiceoverLines: input.script.speechLines.map(line => ({
        lineId: line.lineId || `${input.script?.shotId}:line:${line.sourceStartSeconds}`,
        text: line.draftText,
        sourceStartSeconds: line.sourceStartSeconds,
        sourceEndSeconds: line.sourceEndSeconds,
        narrationOwnerShotId: line.narrationOwnerShotId || input.script?.shotId || input.supply.shotId,
        visualShotIds: [...(line.visualShotIds?.length ? line.visualShotIds : [input.script?.shotId || input.supply.shotId])],
        isNarrationOwner: !line.narrationOwnerShotId || line.narrationOwnerShotId === input.script?.shotId,
      })),
    } : {}),
    ...(spokenText ? {
      voiceoverAlignment: {
        cueId: `${input.script?.shotId ?? input.supply.shotId}:voiceover`,
        text: spokenText,
        startSeconds,
        endSeconds,
        matchMode: 'verbatim_semantic' as const,
        secondaryVisualTags: unique([
          input.supply.function,
          input.supply.requestedDescription || '',
          ...(input.reference?.tags.subjects ?? []),
          ...(input.reference?.action ? [input.reference.action.startState, input.reference.action.path, input.reference.action.endState] : []),
          ...(input.reference?.tags.sceneTypes ?? []),
        ].filter(Boolean)),
      },
    } : {}),
    duration: { startSeconds, endSeconds, targetSeconds: Math.max(0.2, +(endSeconds - startSeconds).toFixed(2)) },
    truthBoundary: boundary,
    allowedVariation: unique([
      '可以改变具体素材组合、制作能力和镜头实现方式',
      '可以在不改变镜头作用和事实强度的前提下使用功能等价表达',
      ...(input.supply.functionalEquivalentReplacement.required && input.supply.functionalEquivalentReplacement.description
        ? [input.supply.functionalEquivalentReplacement.description]
        : []),
    ]),
    acceptanceCriteria: unique([
      `观众能够看懂本镜头的作用：${input.supply.function}`,
      `画面可观察地实现：${targetVisual}`,
      `镜头时长控制在约 ${Math.max(0.2, endSeconds - startSeconds).toFixed(1)} 秒`,
      ...(startSeconds < 3 ? [
        '前三秒钩子必须逐帧核对主体出现时间、动作峰值、构图、运镜、字幕与声音触发，不得用粗标签近似替代',
        '前三秒候选素材必须同时通过逐句口播语义、主体动作、节奏和清晰度高阈值',
      ] : []),
      ...(presenterVisible ? ['必须提取该分镜的原始首帧，并以企业人物资产替换人物身份；全片人物身份保持一致'] : []),
      ...(isPrimaryHook ? ['开场钩子须依据原分镜首帧、动作轨迹、构图与逐镜脚本做高精度复刻'] : []),
      ...evidence.map(item => `证据要求：${item}`),
      ...input.replicationFactors.map(factor => input.script?.scriptOrigin === 'budget_semantic_revision'
        && factor.policy !== 'prohibit_reuse' && factor.policy !== 'replace_identity' && factor.category !== 'identity'
        ? `来源因素 ${factor.factorId}：已按本镜头功能诚实替换，不声明复现原视觉`
        : `裂变因素 ${factor.factorId}：${factor.target.metric} 达到目标并通过 ${factor.validator.detector}`),
      ...(boundary.mustNotImplyCustomerReality ? ['合成或通用画面不得被表述为客户真实证据'] : []),
      ...(input.supply.productSceneReplication ? [
        '产品身份相似度、Logo 与标签 OCR 必须通过，不得重设计产品',
        '场景拓扑、产品槽位和镜头轨迹必须在冻结容差内，不得退化为单图平移缩放',
      ] : []),
    ]),
    ...(input.supply.productSceneReplication ? {
      productSceneReplication: structuredClone(input.supply.productSceneReplication),
    } : {}),
    replicationFactors: input.replicationFactors.map(factor => {
      const budgetReplacement = input.script?.scriptOrigin === 'budget_semantic_revision';
      const remainsApplicable = input.functionalReplacement ? factor.policy === 'prohibit_reuse'
        : !budgetReplacement || factor.policy === 'prohibit_reuse' || factor.policy === 'replace_identity' || factor.category === 'identity';
      const replacementReason = remainsApplicable ? null
        : '目标镜头为原创产品介绍；保留来源因素及谱系，但不声称逐项复现原工厂、DTC 或第三方视觉';
      return {
        factorId: factor.factorId,
        factorSpecVersion: factor.version,
        category: factor.category,
        policy: factor.policy,
        importance: factor.importance,
        target: structuredClone(factor.target),
        tolerance: structuredClone(factor.tolerance),
        validator: structuredClone(factor.validator),
        semanticAdaptation: {
          status: remainsApplicable ? 'applicable' : 'functionally_replaced',
          sourceFactorId: factor.factorId,
          targetFunction: input.script?.purpose ?? input.supply.function,
          replacementReason,
        },
      };
    }),
    fidelityPoints: input.script?.fidelityPoints ?? input.reference?.fidelityPoints ?? [],
    mustDifferPoints: input.script?.mustDifferPoints ?? input.reference?.mustDifferPoints ?? [],
  };
}
export function buildDirectorBrief(
  input: BuildSocialAgentWorkflowInput,
  context: ReturnType<typeof buildBusinessContext>,
  inspirationHandoffs: SocialInspirationHandoff[],
  replicationJob: SocialReplicationJob | null,
): SocialDirectorBrief {
  const scriptShots = input.replicationScript?.shots ?? [];
  const supplyShots = input.assetSupplyPlan.shots;
  const supplyById = new Map(supplyShots.map(shot => [shot.shotId, shot]));
  const referenceShots = input.referenceAnalysis?.shots ?? [];
  const referenceById = new Map(referenceShots.map(shot => [shot.shotId, shot]));
  const scriptIdentityReady = !scriptShots.length || (
    new Set(scriptShots.map(shot => shot.shotId)).size === scriptShots.length
    && new Set(supplyShots.map(shot => shot.shotId)).size === supplyShots.length
    && new Set(referenceShots.map(shot => shot.shotId)).size === referenceShots.length
    && scriptShots.every(shot => supplyById.has(shot.shotId)
      && (!shot.referenceShotId || referenceById.has(shot.referenceShotId))
      && (shot.referenceShotIds||[]).every(id=>referenceById.has(id)))
  );
  const productSelection = sceneProductSelection(input);
  const scenes = (scriptShots.length ? scriptShots : supplyShots.map(() => null)).map((script, index) => {
    const supply = script ? supplyById.get(script.shotId) : supplyShots[index] ?? supplyShots[0];
    if (!supply) return null;
    const reference = script
      ? referenceById.get(script.referenceShotId || '')
      : referenceShots[index];
    return directorScene({
      index,
      script,
      supply,
      reference,
      replicationFactors: replicationJob?.factorSpecs.filter(factor => (
        script?.referenceShotIds?.length ? script.referenceShotIds.includes(factor.referenceShotId||'') : factor.referenceShotId === (script?.referenceShotId ?? reference?.shotId ?? null)
      )) ?? [],
      productSelection,
      primaryHook: input.referenceAnalysis?.hookAnalysis ?? null,
      enterprisePresenterAssetRef: input.assetSupplyPlan.accountPresenterLock?.presenterAssetId
        ?? input.enterprisePresenterAssetRef ?? null,
      functionalReplacement: input.brief.referenceMode === 'multi_source_hybrid'
        && input.brief.productionApproach === 'material_cut'
        && supply.sourceStrategy === 'customer_real_asset'
        && supply.feasibility === 'functional_equivalent',
    });
  }).filter((scene): scene is SocialDirectorBriefScene => Boolean(scene));
  const coverage = input.referenceAnalysis?.coverage;
  const referenceRequired = input.brief.creationMode === 'viral_replication';
  const referenceReady = !referenceRequired || Boolean(input.referenceAnalysis?.status === 'ready' && coverage?.fullTimelineCovered !== false);
  const factorsReady = !referenceRequired || replicationJob?.status === 'factor_ready';
  const fidelityReady = !referenceRequired
    || socialReferenceFidelityFailures({ referenceAnalysis: input.referenceAnalysis, replicationScript: input.replicationScript }).length === 0;
  const orderedScenes = [...scenes].sort((left, right) => left.order - right.order);
  const timelineValid = orderedScenes.every((scene, index) => scene.duration.endSeconds > scene.duration.startSeconds
    && (index === 0 || scene.duration.startSeconds >= orderedScenes[index - 1]!.duration.endSeconds));
  // Five Han characters or 2.7 whitespace-delimited words per second is a
  // deliberately conservative, deterministic speech-capacity gate.
  const dialogueFits = scenes.every(scene => {
    if (scene.voiceoverAlignment?.matchMode === 'verbatim_semantic') return true;
    const speech = scene.audioLayers.dialogue ?? scene.audioLayers.voiceover;
    if (!speech) return true;
    const units = /[\u3400-\u9fff]/.test(speech)
      ? [...speech].filter(char => /[\u3400-\u9fff]/.test(char)).length
      : speech.trim().split(/\s+/).filter(Boolean).length;
    const capacity = /[\u3400-\u9fff]/.test(speech) ? scene.duration.targetSeconds * 5 : scene.duration.targetSeconds * 2.7;
    return units <= Math.max(1, capacity);
  });
  const expectedSceneCount = scriptShots.length || supplyShots.length;
  const status = scenes.length > 0 && scenes.length === expectedSceneCount && scriptIdentityReady
    && referenceReady && factorsReady && fidelityReady && timelineValid && dialogueFits ? 'ready' : 'blocked';
  const totalDurationSeconds = Math.max(0, ...scenes.map(scene => scene.duration.endSeconds));
  const inferredProductRef = productSelection.productRef;
  const requirementText = [
    inferredProductRef,
    ...scenes.map(scene => `${scene.targetVisual} ${scene.audioLayers.voiceover || ''}`),
    ...(input.referenceAnalysis?.shots ?? []).map(shot => `${shot.visualDescription} ${shot.tags.subjects.join(' ')} ${shot.tags.sceneTypes.join(' ')}`),
  ].filter(Boolean).join(' ');
  const productRequired = /产品|商品|包装|瓶|罐|盒|product|package|bottle|jar/i.test(requirementText);
  const materialKinds = unique([
    ...(productRequired ? ['product'] : []),
    ...(/工厂|车间|产线|factory|workshop/i.test(requirementText) ? ['factory'] : []),
    ...(/人物|真人|口播|person|presenter|human/i.test(requirementText) ? ['person'] : []),
    ...(/场景|环境|使用|scenario|environment/i.test(requirementText) ? ['scenario'] : []),
    ...(/细节|特写|detail|close/i.test(requirementText) ? ['detail'] : []),
  ]) as NonNullable<SocialDirectorBrief['contentRequirements']>['primaryMaterialKinds'];
  return {
    directorBriefId: stableId('director_brief', { taskId: input.taskId }),
    version: input.taskVersion,
    status,
    source: {
      weeklyPackageId: context.weeklyPackage?.packageId ?? null,
      adHocBusinessContextId: context.adHocBusinessContext?.contextId ?? null,
    },
    replicationJobRef: replicationJob ? {
      replicationJobId: replicationJob.replicationJobId,
      version: replicationJob.version,
      factorSpecVersion: replicationJob.factorSpecVersion,
    } : null,
    referenceMode: replicationJob?.referenceMode ?? null,
    accountPlaybookRef: replicationJob?.target.accountPlaybookRef ?? null,
    accountPresenterLock: input.assetSupplyPlan.accountPresenterLock
      ? structuredClone(input.assetSupplyPlan.accountPresenterLock)
      : null,
    referenceAnalysis: input.referenceAnalysis ? {
      analysisId: input.referenceAnalysis.analysisId,
      version: input.referenceAnalysis.version || input.taskVersion,
      fullDurationSeconds: coverage?.fullDurationSeconds ?? input.referenceAnalysis.durationSeconds,
      precisionIntervals: coverage?.precisionIntervals ?? input.referenceAnalysis.shots.map(shot => ({ startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, level: 'L3' as const })),
      gaps: coverage?.gaps ?? [],
      overallConfidence: coverage?.overallConfidence ?? null,
    } : null,
    inspirationHandoffIds: inspirationHandoffs.map(item => item.handoffId ?? item.inspirationId),
    topic: input.brief.title,
    audience: unique([input.brief.audience,...(input.replicationContext?.verifiedAccountPlaybook?.audience??[])]).join('；'),
    platforms: input.brief.platforms,
    accountRefs: input.authoritativeContext ? [input.authoritativeContext.publicationTask.accountId] : [],
    creativeIntent: input.brief.objective,
    narrativeStructure: scenes.map(scene => scene.purpose),
    rhythm: input.referenceAnalysis ? '保持参考内容的信息推进节奏，但按新素材重新安排具体切点' : '前三秒快速建立主题，随后逐步补充价值、证据和行动信息',
    primaryHookId: input.replicationScript?.primaryHookId ?? null,
    coreSellingPoints: unique([input.brief.productRef || '', input.brief.brandNotes || ''].filter(Boolean)),
    callToAction: input.brief.callToAction,
    totalDurationSeconds,
    aspectRatio: input.brief.aspectRatio,
    languages: input.brief.languages,
    brandRequirements: unique([input.brief.brandNotes || '', ...input.brief.restrictions, ...(input.replicationContext?.verifiedAccountPlaybook?.evidenceRules??[]), ...(input.replicationContext?.verifiedAccountPlaybook?.visualRules??[]), ...(input.replicationContext?.verifiedAccountPlaybook?.languageRules??[]), ...(input.replicationContext?.verifiedAccountPlaybook?.presenterRules??[]), ...(input.replicationContext?.verifiedAccountPlaybook?.fixedFactors??[]), ...(input.replicationContext?.verifiedAccountPlaybook?.pillars??[]).map(value=>`账号栏目要求：${value}`), ...(input.replicationContext?.verifiedAccountPlaybook?.recurringFormats??[]).map(value=>`账号固定内容形式：${value}`), ...(input.replicationContext?.verifiedAccountPlaybook?[`账号行动引导要求：${input.replicationContext.verifiedAccountPlaybook.conversionRoute.callToAction}`,`账号获客入口：${input.replicationContext.verifiedAccountPlaybook.conversionRoute.entryType} ${input.replicationContext.verifiedAccountPlaybook.conversionRoute.entryRef??''}`]:[])].filter(Boolean)),
    factSourceRefs: input.authoritativeContext
      ? unique(input.authoritativeContext.publicationTask.factRefs.map(ref => `${ref.type}:${ref.id}@${ref.version}`))
      : input.factSourceRefs,
    contentRequirements: {
      product: {
        required: productRequired,
        productId: productRequired ? productSelection.productId : null,
        productRef: productRequired ? inferredProductRef : null,
        policy: productSelection.policy,
        source: productSelection.source,
        confidence: productRequired ? (inferredProductRef ? 0.9 : 0.55) : 0.75,
        reason: productRequired
          ? inferredProductRef ? '用户已选产品或系统已从企业中心与素材库自动优选' : '未指定产品，按 open 策略使用当前最匹配的产品或企业通用素材'
          : '参考视频未要求产品主体持续出镜',
      },
      enterpriseFacts: {
        required: false,
        factSourceRefs: input.factSourceRefs,
        reason: '内容制作前不要求用户补填事实；企业信息自动来自企业中心',
      },
      primaryMaterialKinds: materialKinds.length ? materialKinds : ['general'],
    },
    rightsConstraints: unique([
      '参考视频的口播逐字冻结，仅替换企业名、品牌名和产品名',
      '已入库的工厂、客户案例和企业通用素材可直接进入匹配与剪辑',
    ]),
    referenceEvidence: [
      ...(input.referenceAnalysis ? input.referenceAnalysis.shots.map(shot => ({
        analysisId: input.referenceAnalysis!.analysisId,
        referenceShotId: shot.shotId,
        transferable: [...shot.fidelityPoints],
        mustReplace: [...shot.mustDifferPoints],
      })) : []),
      ...inspirationHandoffs
        .filter(handoff => handoff.analysisId !== input.referenceAnalysis?.analysisId)
        .map(handoff => ({
          analysisId: handoff.analysisId,
          referenceShotId: null,
          transferable: [...handoff.adaptationBoundary.reusable],
          mustReplace: [...handoff.adaptationBoundary.mustReplace, ...handoff.adaptationBoundary.prohibited],
        })),
    ],
    budgetCny: positiveNumber(input.brief.perItemBudgetCny),
    dueAt: input.brief.dueAt,
    scenes,
    createdBy: 'director_agent',
  };
}
export function eligibleProductBudgetCandidate(supply:SocialAssetSupplyShotPlan,policyVersion?:string){
 const routing=supply.materialRouting,generation=routing?.generation,spec=supply.productSceneReplication;
 return policyVersion==='type-aware.v2'&&routing?.materialType==='product'
   &&routing.productGenerationDecision?.state==='eligible'
   &&generation?.method==='enterprise_authored_product_first_frame_i2v'
   &&generation.firstFrameOrigin==='enterprise_authored_storyboard'
   &&generation.videoProvider==='seedance'&&generation.productImageRefs.length>0
   &&Boolean(spec?.productIdentity.groups.length)
   &&spec!.productIdentity.groups.every(group=>group.referenceImageIds.length>0
     &&group.referenceImageIds.every(ref=>generation.productImageRefs.includes(ref)));
}
export function capabilityCandidates(input: {
  tenantId?: string;
  policyVersion?:string;
  taskId: string;
  taskVersion: string;
  sceneId: string;
  scene: SocialDirectorBriefScene;
  supply: SocialAssetSupplyShotPlan;
  capabilityRuntime?: SocialContentCapabilityRuntimeRegistration[];
  materialCandidates?: SocialWorkflowMaterialCandidate[];
  preferLocalProductAnimation?: boolean;
}): SocialExecutionCandidate[] {
  const targetSeconds = input.scene.duration.targetSeconds;
  const registrations = input.capabilityRuntime ?? socialContentEmbeddedRuntimeRegistrations(input.supply.materialRouting ? { tenantId: input.tenantId, wholeFilmBudget: true, productVideoProvider: input.supply.materialRouting.generation?.videoProvider } : { tenantId: input.tenantId });
  const runtimeRegistration = new Map(registrations
    .map(item => [item.strategy, item]));
  const sourceRuntime = runtimeRegistration.get(input.supply.sourceStrategy);
  // Product image refs are inputs to the paid scene-generation capability,
  // not zero-cost finished clips. Keeping them out of `actualAssets` makes the
  // confirmation card report the real Seedream + Seedance route and estimate.
  const generatedInputStrategies: SocialShotSourceStrategy[] = [
    'aigc_product_scene_replication',
    'authorized_digital_presenter',
  ];
  const finishedAssetRefs = generatedInputStrategies.includes(input.supply.sourceStrategy)
    ? [] : input.supply.sourceRefs;
  const explicitAssetRows = finishedAssetRefs.flatMap<{ sourceRef: string; material: SocialWorkflowMaterialCandidate | null }>(sourceRef => {
    const rows = input.materialCandidates?.filter(item => item.sourceRef === sourceRef || item.assetId === sourceRef) ?? [];
    return rows.length
      ? rows.map(material => ({ sourceRef, material }))
      : [{ sourceRef, material: null }];
  });
  // Ordinary later shots can reuse owned clips when topic and purpose fit.
  // Opening hooks retain their reference mechanism and are not auto-replaced.
  const topic = input.scene.visualTopic;
  const sceneCueIds = new Set([
    `${input.sceneId}:voiceover`,
    ...(input.scene.voiceoverLines ?? []).map(line => line.lineId),
  ]);
  const matchesSceneSpeech = (material: SocialWorkflowMaterialCandidate) =>
    material.matchedVoiceoverCueIds.some(cueId => sceneCueIds.has(cueId));
  const localAssetRows = (input.materialCandidates ?? [])
    .filter(() => input.supply.function !== 'hook' && !input.scene.referenceMaterial?.isPrimaryHook)
    .filter(material => material.origin === 'my_materials' && material.mediaType === 'video' && material.visualContract)
    .filter(material => !input.scene.productionRouting?.presenterIdentityReplacementRequired)
    .filter(material => topic?.kind !== 'competitor_comparison' || !input.supply.truthBoundary.customerEvidenceRequired)
    .filter(material => (input.scene.visualContract ?? input.supply.visualContract)
      && scoreSceneVisualCompatibility(input.scene.visualContract ?? input.supply.visualContract, material.visualContract) >= 0.8)
    .filter(material => {
      const subject = topic?.subject ?? '';
      const words = subject.match(/[\u4e00-\u9fff]{2,4}|[a-z]{4,}/gi) ?? [];
      return words.some(word => material.label.toLowerCase().includes(word.toLowerCase()))
        || matchesSceneSpeech(material);
    })
    .map(material => ({ sourceRef: material.sourceRef, material }));
  const actualAssetRows = [...explicitAssetRows, ...localAssetRows.filter(row =>
    !explicitAssetRows.some(explicit => explicit.sourceRef === row.sourceRef))];
  const actualAssets = actualAssetRows.map(({ sourceRef, material }, index): SocialExecutionCandidate => {
    const cueMatched = material ? matchesSceneSpeech(material) : false;
    const normalizedMatch = material ? Math.max(0, Math.min(1, material.matchScore / 1_000)) : 0;
    const visualScore = material?.visualContract && (input.scene.visualContract ?? input.supply.visualContract)
      ? scoreSceneVisualCompatibility(input.scene.visualContract ?? input.supply.visualContract, material.visualContract)
      : 0.65;
    const semanticScore = material
      ? Math.min(1, (cueMatched ? 0.82 : 0.55) + normalizedMatch * 0.18)
      : 0.5;
    return ({
    candidateId: stableId('candidate', {
      sceneId: input.sceneId,
      sourceRef,
      segmentId: material?.segmentId ?? null,
      timeRange: material?.timeRange ?? null,
    }),
    kind: 'asset',
    label: material?.label || `已入库素材 ${index + 1}`,
    sourceRef,
    sourceStrategy: material && !finishedAssetRefs.includes(sourceRef) ? 'customer_real_asset' : input.supply.sourceStrategy,
    evidenceStrength: input.supply.truthBoundary.customerEvidenceRequired ? 'strong' : 'supporting',
    rightsStatus: 'confirmed',
    enterpriseOwnershipScore: material?.origin === 'shared_library' ? 0.6 : 1,
    semanticScore,
    evidenceScore: input.supply.truthBoundary.customerEvidenceRequired ? 1 : 0.8,
    actionAndShotScore: visualScore,
    qualityScore: 0.85,
    durationFitScore: 0.9,
    repetitionPenalty: 0,
    estimatedCostCny: 0,
    estimatedSeconds: targetSeconds,
    estimatedSuccessRate: 0.99,
    dataTransfer: 'local_only',
    providerId: sourceRuntime?.adapterIds[0] ?? null,
    modelId: null,
    clipId: sourceRef,
    timeRange: material?.timeRange ?? null,
    promptRef: null,
    previewUrl: material?.previewUrl ?? null,
    mediaType: material?.mediaType ?? null,
    matchedVoiceoverCueIds: material?.matchedVoiceoverCueIds ?? [],
    productId: material?.productId ?? null,
    productRef: material?.productRef ?? null,
    enterpriseCommon: material?.enterpriseCommon ?? false,
    materialRoles: material?.materialRoles ?? [],
    ...(material?.visualContract && material.segmentId && material.timeRange ? {
      materialSegments: [{
        candidateId: material.segmentCandidateId,
        segmentId: material.segmentId,
        sourceRevision: material.sourceRevision,
        ...(material.footageEvidence ? { footageEvidence: structuredClone(material.footageEvidence) } : {}),        startSeconds: material.timeRange.startSeconds,
        endSeconds: material.timeRange.endSeconds,
        assetRole: material.materialV2?.assetRole,
        contentRole: material.materialV2?.contentRole,
        productIdentityLevel: material.materialV2?.productIdentityLevel,
        templateEligible: material.materialV2?.templateEligible,
        reuseScore: material.materialV2?.reuseScore,
        visualContract: structuredClone(material.visualContract),
        materialRoles: [...(material.materialRoles ?? [])],
        matchedVoiceoverCueIds: [...material.matchedVoiceoverCueIds],
        voiceoverScore: semanticScore,
        visualCompatibilityScore: visualScore,
      }],
    } : {}),
    retryPolicy: { maxAttempts: 1, fallbackStrategies: input.supply.fallbackSourceStrategy ? [input.supply.fallbackSourceStrategy] : [] },
    provenance: {
      origin: material?.origin === 'shared_library' ? 'licensed_library' : 'customer',
      inputVersion: input.taskVersion,
      authorizationRef: sourceRef,
      executionRecordId: null,
    },
  });
  });
  const capabilityRows = socialContentCapabilityRegistry(registrations)
    .filter(capability => capability.executable)
    .filter(capability => capability.strategy !== 'authorized_digital_presenter'
      || (input.supply.digitalHumanPlan !== undefined
        && ['preview_only', 'ready_for_capability_check'].includes(input.supply.digitalHumanPlan.executionState)))
    .filter(capability => capability.strategy !== 'aigc_product_scene_replication'
      || (input.supply.productSceneReplication !== undefined && (input.supply.sourceRefs.length > 0||eligibleProductBudgetCandidate(input.supply,input.policyVersion))))
    .filter(capability => capability.strategy !== 'customer_product_image_animation'
      || (input.supply.productSceneReplication !== undefined
        && input.supply.productSceneReplication.productIdentity.groups.length > 0
        && input.supply.sourceRefs.length > 0))
    .map((capability): SocialExecutionCandidate => ({
      candidateId: stableId('capability', { sceneId: input.sceneId, strategy: capability.strategy }),
      kind: 'capability',
      label: capability.label,
      sourceRef: null,
      sourceStrategy: capability.strategy,
      evidenceStrength: capability.evidenceStrength,
      rightsStatus: capability.rightsStatus,
      enterpriseOwnershipScore: 0,
      semanticScore: capability.strategy === input.supply.sourceStrategy ? 0.88
        : capability.strategy === input.supply.fallbackSourceStrategy ? 0.72 : 0.48,
      evidenceScore: capability.evidenceStrength === 'strong' ? 1 : capability.evidenceStrength === 'supporting' ? 0.7 : 0.25,
      actionAndShotScore: capability.applicableScenes.includes(input.supply.function) ? 0.85 : 0.4,
      qualityScore: capability.estimatedSuccessRate,
      durationFitScore: 0.8,
      repetitionPenalty: 0,
      estimatedCostCny: +(capability.strategy === 'authorized_digital_presenter'
        && Number.isFinite(Number(process.env.HEYGEN_ESTIMATED_CNY_PER_SECOND))
        && Number(process.env.HEYGEN_ESTIMATED_CNY_PER_SECOND) > 0
        ? Number(process.env.HEYGEN_ESTIMATED_CNY_PER_SECOND) * targetSeconds
        : capability.estimatedCostCny * targetSeconds / capability.estimatedSeconds).toFixed(4),
      estimatedSeconds: targetSeconds,
      estimatedSuccessRate: capability.estimatedSuccessRate,
      dataTransfer: capability.dataTransfer,
      providerId: capability.registeredAdapterIds[0] ?? null,
      modelId: null,
      clipId: null,
      timeRange: null,
      promptRef: null,
      retryPolicy: { maxAttempts: 3, fallbackStrategies: input.scene.referenceProductionRouting ? [] : [...capability.fallbackStrategies] },
      provenance: { origin: capability.strategy === 'licensed_stock_asset' ? 'licensed_library' : 'system_capability', inputVersion: input.taskVersion, authorizationRef: capability.rightsStatus === 'confirmed' ? `capability:${capability.strategy}` : null, executionRecordId: null },
    }));
  const ranked = [...actualAssets, ...capabilityRows]
    .filter(candidate => {
      const typed = input.supply.materialRouting;
      if (typed) {
        if(eligibleProductBudgetCandidate(input.supply,input.policyVersion)&&candidate.kind==='capability'
          &&candidate.sourceStrategy==='aigc_product_scene_replication')return true;
        if (typed.localMatch.state === 'matched' && typed.policy !== 'authorized_presenter') {
          if (candidate.kind !== 'asset' || candidate.sourceStrategy !== 'customer_real_asset' || !candidate.sourceRef) return false;
          if (typed.localMatch.sourceRefs.includes(candidate.sourceRef)) return true;
          const roles = new Set(candidate.materialRoles ?? []);
          if (typed.materialType === 'factory') return roles.has('factory');
          if (typed.materialType === 'consumer_demo') return roles.has('person_usage') && !roles.has('factory') && !roles.has('presenter');
          if (typed.materialType === 'product') {
            const requested = String(input.supply.productSceneReplication?.productIdentity.groups[0]?.productRef
              ?? typed.generation?.productImageRefs[0] ?? '')
              .normalize('NFKC').trim().toLocaleLowerCase().replace(/^product:/, '');
            const actual = String(candidate.productRef ?? candidate.productId ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/^product:/, '');
            return roles.has('product') && Boolean(requested && actual === requested);
          }
          return false;
        }
        if (typed.policy === 'local_only') return candidate.kind === 'capability'
          && candidate.dataTransfer === 'local_only'
          && ['motion_graphics', 'verified_fact_card'].includes(candidate.sourceStrategy)
          && candidate.sourceStrategy === input.supply.sourceStrategy;
        return candidate.kind === 'capability' && (typed.policy === 'authorized_presenter'
          ? candidate.sourceStrategy === 'authorized_digital_presenter'
          : candidate.sourceStrategy === 'aigc_product_scene_replication');
      }
      // A user-selected local-only route may intentionally replace the
      // reference production mechanism with a verified tenant clip. Keep the
      // reference analysis on the Director brief for QA, but do not let its
      // historic AIGC route erase the exact server-selected local asset.
      const routing = input.supply.sourceStrategy === 'customer_real_asset'
        && input.supply.sourceRefs.length ? undefined : input.scene.referenceProductionRouting;
      if (!routing) return true;
      // An unresolved optional person-continuity observation is retained for
      // audit, but does not suppress otherwise executable assets/capabilities.
      if (routing.state !== 'ready' || routing.route === 'undetermined') return true;
      if (routing.route === 'reference_frame_presenter') return candidate.kind === 'capability' && candidate.sourceStrategy === 'authorized_digital_presenter';
      if (['aigc_video', 'non_presenter_aigc_video'].includes(routing.route)) return candidate.kind === 'capability'
        && ['aigc_product_scene_replication', 'non_evidentiary_ai_visual'].includes(candidate.sourceStrategy);
      if (!['customer_real_asset', 'licensed_stock_asset'].includes(candidate.sourceStrategy)) return false;
      if (routing.route === 'library_match' && candidate.kind === 'asset') {
        const material = input.materialCandidates?.find(item => item.sourceRef === candidate.sourceRef || item.assetId === candidate.sourceRef);
        return Boolean(material?.visualContract && !material.visualContract.subjects.some(subject => subject.kind === 'person'));
      }
      return true;
    })
    .sort((left, right) => right.semanticScore - left.semanticScore || right.estimatedSuccessRate - left.estimatedSuccessRate);
  if (input.supply.materialRouting?.localMatch.state !== 'matched') return ranked.slice(0, 20);
  // Keep several distinct eligible assets in the frozen execution plan. The
  // task-level allocator can then avoid repeating one source across adjacent
  // shots, while retaining a second analyzed segment for bounded reuse after
  // all distinct assets have been consumed.
  const perAsset = new Map<string, number>(), diversified: SocialExecutionCandidate[] = [];
  for (const candidate of ranked) {
    const key = candidate.kind === 'asset' && candidate.sourceRef ? candidate.sourceRef : candidate.candidateId;
    const count = perAsset.get(key) ?? 0;
    if (count >= 2) continue;
    perAsset.set(key, count + 1);
    diversified.push(candidate);
    if (diversified.length >= 20) break;
  }
  return diversified;
}
