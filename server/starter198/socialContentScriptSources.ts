import {consolidateReferenceSemanticShots, type ReferenceSemanticPlanning} from './socialContentSemanticConsolidation.js';
import type {
  SocialContentThemeId,
  SocialReferenceShotAnalysis,
  SocialReferenceVideoAnalysis,
  SocialReplicationScriptShot,
  SocialReplicationScriptVersion,
  SocialShotFunction,
  SocialShotSourceStrategy,
  SocialShotTruthBoundary,
  SocialTaskSource,
  SocialThreeSecondHook,
} from '../../shared/contracts/socialContentWorkflow.js';
import { store } from '../storage/index.js';
import type { SocialInspirationScriptMatch, VerifiedSocialScriptContext } from './socialContentScriptBaseline.js';
import {
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';
import { deriveNarrationStyleProfile, type NarrationStyleProfile } from '../digitalEmployees/narrationStyle.js';
import {
  buildSceneCapabilitySignature,
  normalizeSceneVisualContract,
  type SocialSceneCapabilitySignature,
  type SocialSceneProductionAdmission,
  type SocialSceneVisualContract,
} from '../../shared/sceneVisualContract.js';
import { presenterShotMeasurements } from './presenterShotMeasurements.js';
import { approximateSpeechLines } from '../lib/referenceApproxSpeech.js';
import { hasCompletedExactVideoEvidence } from '../lib/videoAnalysisCodec.js';
import { referenceFrameActionPrompt } from './referenceFrameActionPrompt.js';
import { applyExactPresenterTemporalSplit } from './presenterTemporalShotSplit.js';
import { buildReferenceShotProductionRouting, type ReferenceShotProductionRouting,
  type ReferencePresenterContinuityEvidence } from '../../shared/referenceShotProductionRouting.js';

import {
  THEME_TERMS, recordObject, listText, exactAnalysis, synthetic, referenceCoverage,
  combinedText, safeShotFunction, safeSubject, safeReferenceStructure,
  safeReferenceNodes, referenceNarrationLines, sourceSpeechTiming,
  verifiedSpokenLines, reviewedShotSpeech, referenceCaptionLines, identityPlan,
  replaceIdentityOnly, normalizedReferenceIdentity, recordReferenceIdentities,
  sourceReferenceIdentities, type ExactReferenceDetail, type ResolvedSocialTaskReference,
} from './socialContentReferenceEvidence.js';
export { normalizeReferenceTimelineBoundaries, pendingSocialTaskReferenceAnalysis, normalizedReferenceIdentity, recordReferenceIdentities, sourceReferenceIdentities } from './socialContentReferenceEvidence.js';
export type { ResolvedSocialTaskReference } from './socialContentReferenceEvidence.js';

function shotPurpose(detail: Record<string, unknown>, themeId: SocialContentThemeId): SocialShotFunction {
  const explicitIntent = combinedText(detail, ['purpose', 'inferredIntent']);
  if (/(?:D\s*to\s*C|吸睛|视觉冲击|真实生活|生活场景)/i.test(explicitIntent)) return 'd_to_c';
  if (/(?:钩子|开场|吸引|hook|opening|attention)/i.test(explicitIntent)) return 'hook';
  if (/(?:建立信任|增强信任|可信度|trust|credib)/i.test(explicitIntent)) return 'trust';
  const safe = safeShotFunction(detail, themeId);
  if (safe === '开场吸引') return 'hook';
  if (safe === '证据呈现') return 'proof';
  if (safe === '真实过程演示' || safe === '现场过程展示') return 'demonstration';
  if (safe === '信息收束') return 'call_to_action';
  if (safe === '细节展示' || safe === '产品画面展示') return 'value';
  return themeId === 'customer_case' ? 'trust'
    : themeId === 'scenario_solution' ? 'problem'
      : themeId === 'supplier_capability' ? 'trust'
        : 'value';
}

function truthBoundaryFor(input: {
  purpose: SocialShotFunction;
  subject: string;
}): SocialShotTruthBoundary {
  const factory = /生产现场|工厂|车间|产线/.test(input.subject);
  const customerCase = /客户案例|客户现场|客户使用/.test(input.subject);
  const effect = /(人物|人脸|模特|用户).*(使用|涂抹|上脸|效果|对比)|(使用|涂抹|上脸).*(产品|效果)/.test(input.subject);
  const subject = factory ? 'customer_factory' as const
    : customerCase ? 'customer_case' as const
      : effect ? 'product_effect' as const
        : 'none' as const;
  const evidenceRequired = subject !== 'none' || input.purpose === 'proof';
  return {
    subject,
    syntheticVisualAllowed: !evidenceRequired,
    customerEvidenceRequired: evidenceRequired,
    customerEvidenceRefs: [],
    confirmedFactRefs: [],
    mustNotImplyCustomerReality: true,
    prohibitedRepresentations: [
      'depict_generated_factory_as_customer_factory',
      'invent_customer_case_or_results',
      'depict_generated_effect_as_verified_product_result',
      'alter_locked_product_identity',
      'present_synthetic_media_as_customer_evidence',
    ],
  };
}

function productionStrategyFor(
  boundary: SocialShotTruthBoundary,
  _purpose: SocialShotFunction,
  visualContract?: SocialSceneVisualContract | null,
): SocialShotSourceStrategy {
  if (boundary.subject === 'customer_factory' || boundary.subject === 'customer_case') return 'customer_real_asset';
  const signature = visualContract ? buildSceneCapabilitySignature(visualContract) : null;
  // The current presenter stack can produce talking heads, but it cannot
  // preserve an exact SKU through hand contact, application or an operating
  // interaction with factory equipment. Keep those requests on an explicit
  // functional-equivalent route until a verified interaction stack exists.
  if (signature?.requiresPersonProductContact || signature?.requiresEnvironmentInteraction) return 'motion_graphics';
  if (boundary.subject === 'product_effect' || signature?.requiresPerson) return 'authorized_digital_presenter';
  if (signature?.requiresProductIdentity) return 'aigc_product_scene_replication';
  return 'customer_real_asset';
}

function structuralFidelityPoints(input: {
  purpose: SocialShotFunction;
  structure: SocialInspirationScriptMatch['nodes'][number]['referenceStructure'];
}): string[] {
  return [
    `保留镜头功能：${input.purpose}`,
    `保留时间位置：${input.structure.sourceTiming.startSeconds}-${input.structure.sourceTiming.endSeconds} 秒`,
    `保留景别与运镜：${input.structure.shotScale}、${input.structure.cameraMovement}`,
    `保留节奏与转场：${input.structure.pace}、${input.structure.transition}`,
  ];
}

const REQUIRED_DIFFERENCES = [
  '口播逐字逐句冻结，仅替换企业名、品牌名或产品名；不得改写事实、句序、停顿与时长',
  '字幕仅做同一组身份词替换；替换原视频账号标识和水印',
  '开场使用目标商品身份生成，后续优先使用素材库真实画面',
  '保持原信息顺序，同时增加全新音乐、音效和字幕动效包装',
] as const;

function sceneContractForReference(input: {
  row: ExactReferenceDetail;
  productRef: string | null;
}): SocialSceneVisualContract {
  const raw = input.row.detail;
  const visual = socialText(raw.visual);
  const action = combinedText(raw, ['visual', 'observedFacts', 'beats']);
  const subjects = [
    ...listText(raw.subjects),
    ...(/人物|真人|员工|工人|模特|主播|脸|手|person|people|human|worker|presenter|model|face|hand/i.test(visual) ? ['画面人物'] : []),
    ...(/产品|商品|包装|瓶|罐|盒|膏体|液体|product|package|bottle|jar|box|cream|serum/i.test(visual) ? ['画面产品'] : []),
    ...(/工厂|车间|产线|生产线|设备|factory|workshop|production.?line/i.test(visual) ? ['工厂环境'] : []),
    socialText(raw.subject),
  ].filter(Boolean);
  return normalizeSceneVisualContract({
    subjects: subjects.length ? subjects : [safeSubject(raw)],
    interaction: socialText(raw.interaction) || action,
    subjectRelations: raw.subjectRelations,
    environment: socialText(raw.environment) || visual,
    productUsage: socialText(raw.productUsage) || action,
    product: {
      policy: input.productRef ? 'preferred' : 'open',
      requestedProductRef: input.productRef,
      source: input.productRef ? 'agent_inferred' : 'inventory_open',
    },
    action: {
      startState: socialText(raw.startState) || `${safeSubject(raw)}处于本镜头的可见初始状态`,
      path: action,
      peakState: socialText(raw.peakState),
      endState: socialText(raw.endState) || `${safeSubject(raw)}停留在镜头结束状态`,
      startSeconds: input.row.timing.startSeconds,
      peakSeconds: Number.isFinite(Number(raw.actionPeak)) ? Number(raw.actionPeak) : null,
      endSeconds: input.row.timing.endSeconds,
    },
    camera: {
      shotSize: socialText(raw.shot),
      angle: socialText(raw.angle),
      movement: socialText(raw.camera),
      composition: socialText(raw.composition),
    },
    precision: input.row.timing.startSeconds < 3 ? 'hook_high' : 'standard',
    evidence: {
      sourceRange: { startSeconds: input.row.timing.startSeconds, endSeconds: input.row.timing.endSeconds },
      keyframeIds: [
        ...new Set([
          ...listText(raw.keyframeIds),
          ...(socialText(recordObject(raw.materialEvidence).firstFrameRef)
            ? [socialText(recordObject(raw.materialEvidence).firstFrameRef)] : []),
        ]),
      ],
      confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : null,
    },
  });
}

function currentStackAdmission(signature: SocialSceneCapabilitySignature): SocialSceneProductionAdmission {
  const unsupportedRequirements = [
    ...(signature.requiresPersonProductContact
      ? signature.requiredCapabilities.filter(capability => capability === 'person_product_interaction_control'
        || capability === 'face_contact_control')
      : []),
    ...(signature.requiresEnvironmentInteraction ? ['environment_interaction_control'] : []),
  ];
  if (unsupportedRequirements.length > 0) {
    return {
      status: 'fallback_only',
      route: 'material_edit',
      executable: true,
      confidence: 0.9,
      requiredCapabilities: [...signature.requiredCapabilities],
      unsupportedRequirements: [...new Set(unsupportedRequirements)],
      // Shooting is an explicit user-selected production mode, not an
      // automatic fallback for a missing system capability.
      fallbackRoutes: [],
    };
  }
  const route = signature.requiresPerson
    ? 'digital_human' as const
    : signature.requiresProductIdentity
      ? 'product_aigc' as const
      : 'material_edit' as const;
  return {
    status: 'admitted',
    route,
    executable: true,
    confidence: 0.92,
    requiredCapabilities: [...signature.requiredCapabilities],
    unsupportedRequirements: [],
    fallbackRoutes: route === 'digital_human'
      ? ['material_edit']
      : route === 'product_aigc'
        ? ['material_edit']
        : [],
  };
}

function publicShot(input: {
  row: ExactReferenceDetail;
  index: number;
  themeId: SocialContentThemeId;
  spokenText?: string;
  spokenTextTiming?: SocialReferenceShotAnalysis['spokenTextTiming'];
  spokenLines?: SocialReferenceShotAnalysis['spokenLines'];
  captionText?: string;
  productRef?: string | null;
  verifiedRouting:ReferenceShotProductionRouting;
}): SocialReferenceShotAnalysis {
  const raw = input.row.detail;
  const referenceProductionRouting = input.verifiedRouting;
  const presenterContinuityEvidence = raw.presenterContinuityEvidence as ReferencePresenterContinuityEvidence | undefined;
  const reliableRole = referenceProductionRouting?.state === 'ready' ? referenceProductionRouting.observedPresenterRole : undefined;
  const inferredPurpose = shotPurpose(input.row.detail, input.themeId);
  const purpose: SocialShotFunction = input.index === 0 ? 'hook'
    : inferredPurpose === 'hook' ? 'd_to_c' : inferredPurpose;
  const subject = safeSubject(input.row.detail);
  const structure = safeReferenceStructure(input.row);
  const truth = truthBoundaryFor({ purpose, subject });
  const detailText = (fields: string[]) => combinedText(input.row.detail, fields);
  const shotText = detailText(['shot', 'visual']);
  const angleText = detailText(['angle', 'camera']);
  const compositionText = detailText(['composition']);
  const voiceDetected = Boolean(detailText(['dialogue']));
  const captionDetected = Boolean(detailText(['onScreenText', 'subtitle']));
  const ambientDetected = Boolean(detailText(['ambientSound']));
  const musicDetected = Boolean(detailText(['bgm']));
  const effectsDetected = Boolean(detailText(['soundEffects']));
  const visualContract = sceneContractForReference({
    row: input.row,
    productRef: input.productRef ?? null,
  });
  const strategy = productionStrategyFor(truth, purpose, visualContract);
  const evidence = recordObject(raw.materialEvidence);
  const observedVisual = socialText(raw.visual) || socialText(raw.observedFacts);
  const observedIntent = socialText(raw.purpose) || socialText(raw.inferredIntent);
  const shotId = socialText(raw.shotId) ? `reference-${socialText(raw.shotId)}` : `reference-shot-${input.index + 1}`;
  const materialEvidence = {
    sourceVideoRef: socialText(evidence.sourceVideoRef) || null,
    clipRef: socialText(evidence.clipRef) || null,
    firstFrameRef: socialText(evidence.firstFrameRef) || null,
    firstFrameSeconds: Number.isFinite(Number(evidence.firstFrameSeconds)) ? Number(evidence.firstFrameSeconds) : input.row.timing.startSeconds,
    extractionStatus: evidence.extractionStatus === 'ready' ? 'ready' as const : 'unavailable' as const,
  };
  return {
    shotId,
    personContinuityId: referenceProductionRouting.personContinuityId,
    observedPresenterRole: reliableRole || (referenceProductionRouting ? 'unknown' : ['sales_presenter', 'presenter_action', 'background', 'none', 'unknown'].includes(String(raw.observedPresenterRole)) ? raw.needsReview === true && raw.salesPresenterConfirmed !== true ? 'unknown' : raw.observedPresenterRole as SocialReferenceShotAnalysis['observedPresenterRole'] : undefined),
    ...(referenceProductionRouting ? { referenceProductionRouting: structuredClone(referenceProductionRouting) } : {}),
    ...(presenterContinuityEvidence ? { presenterContinuityEvidence: structuredClone(presenterContinuityEvidence) } : {}),
    startSeconds: structure.sourceTiming.startSeconds,
    endSeconds: structure.sourceTiming.endSeconds,
    visualDescription: observedVisual ? `${observedVisual}；${structure.shotScale}，${structure.cameraMovement}` : `${subject}；${structure.shotScale}，${structure.cameraMovement}`,
    semanticLabel: { content: observedVisual || subject, intent: observedIntent || safeShotFunction(raw, input.themeId) },
    materialEvidence,
    presenterMeasurements: presenterShotMeasurements({
      shotId,
      startSeconds: structure.sourceTiming.startSeconds,
      endSeconds: structure.sourceTiming.endSeconds,
      materialEvidence,
    }),
    spokenText: input.spokenText ?? null,
    spokenTextTiming: input.spokenTextTiming,
    spokenLines: input.spokenLines,
    captionText: input.captionText ?? null,
    audioDescription: '口播逐字逐句冻结并仅替换身份词；保留声画配合，重新制作配音、配乐和音效。',
    rhythmDescription: `${structure.pace}节奏，${structure.transition}`,
    purpose,
    action: {
      startState: socialText(raw.startState) || `${subject}处于本镜头的可见初始状态`,
      path: socialText(raw.action) || socialText(raw.interaction) || observedVisual || `${subject}按${structure.cameraMovement}逐步揭示信息`,
      endState: socialText(raw.endState) || `${subject}停留在本镜头的可见结束状态`,
      spatialRelation: '只记录画面中可确认的主体位置和连续关系；无法确认的左右方向不补写',
    },
    shotLanguage: {
      shotSize: structure.shotScale,
      cameraAngle: socialText(raw.angle) || (/俯拍|overhead|top.down/i.test(angleText) ? '俯拍' : /仰拍|low.angle/i.test(angleText) ? '仰拍' : /侧面|side/i.test(angleText) ? '侧面机位' : '未确认具体角度'),
      movement: structure.cameraMovement,
      composition: socialText(raw.composition) || (/对称|symmetr/i.test(compositionText) ? '对称构图' : /三分|third/i.test(compositionText) ? '三分构图' : /中心|center/i.test(compositionText) ? '中心构图' : '未确认具体构图'),
    },
    audioLayers: {
      voice: voiceDetected ? '检测到人声层；按原节奏保留并做产品关键词替换' : null,
      captions: captionDetected ? '检测到字幕层；保留信息顺序并重新制作字幕动效' : null,
      ambient: ambientDetected ? '检测到环境声层' : null,
      music: musicDetected ? '检测到音乐层；新视频必须重新授权或替换' : null,
      soundEffects: effectsDetected ? '检测到音效层' : null,
    },
    observation: {
      observableFacts: [observedVisual || subject, structure.shotScale, structure.cameraMovement],
      inferredIntent: [observedIntent || `推断镜头作用为：${purpose}`],
      causalGaps: structure.transition === '自然衔接' ? [] : ['转场可能压缩真实过程，不能据此推断未展示的因果关系'],
      postProductionOverlays: captionDetected ? ['字幕或平台文字属于后期叠加层，不属于物理场景'] : [],
    },
    visualContract,
    tags: {
      sceneTypes: [/生产现场/.test(subject) ? '工厂实拍结构' : purpose === 'demonstration' ? '使用演示结构' : '产品内容结构'],
      subjects: [subject],
      subjectRelations: [purpose === 'demonstration' ? '主体执行动作' : '主体承担镜头信息'],
      cameraLanguage: [structure.shotScale, structure.cameraMovement, structure.transition],
      contentFunctions: [purpose],
      soundTypes: ['原口播仅做企业名、品牌名或产品名替换', '重新配乐与音效'],
      onScreenInformation: ['原字幕仅做身份词替换与动效重制'],
      truthRequirements: [truth.subject],
      suggestedProductionMethods: [strategy],
    },
    fidelityPoints: structuralFidelityPoints({ purpose, structure }),
    mustDifferPoints: [...REQUIRED_DIFFERENCES],
  };
}

function hookOption(input: {
  analysisId: string;
  role: SocialThreeSecondHook['role'];
  index: number;
  firstShot: SocialReferenceShotAnalysis;
  strategy: SocialShotSourceStrategy;
  productLabel: string;
  narrationStyle?: NarrationStyleProfile | null;
}): SocialThreeSecondHook {
  const truthBoundary = truthBoundaryFor({ purpose: 'hook', subject: input.firstShot.visualDescription });
  const signature = buildSceneCapabilitySignature(input.firstShot.visualContract
    ?? normalizeSceneVisualContract({ subjects: input.firstShot.tags.subjects, interaction: input.firstShot.action?.path, precision: 'hook_high' }));
  const alternatives = [
    {
      firstFrame: `直接展示${input.firstShot.visualDescription}`,
      firstSecondAction: '第一秒立即进入核心动作，不使用片头铺垫。',
      mechanism: '沿用参考视频的首屏信息密度和节奏，但替换全部内容表达。',
      audiovisualPlan: '首帧主体与第一句口播同时出现，三秒内完成问题或价值承诺。',
    },
    {
      firstFrame: '数字人或人物近景提出一个与产品相关的真实问题。',
      firstSecondAction: '人物在第一秒完成提问，画面立即切到解决方向。',
      mechanism: '把参考视频的视觉钩子改写为问题钩子。',
      audiovisualPlan: '短句提问配大字字幕，第二秒进入产品或场景画面。',
    },
    {
      firstFrame: '用动态图形快速呈现一个已确认的产品类别或使用场景。',
      firstSecondAction: '首秒完成关键词放大，并衔接第一个功能镜头。',
      mechanism: '把参考视频的开场节奏改写为信息型钩子。',
      audiovisualPlan: '动态图形、提示音和全新字幕同步进入，避免复用原片声画元素。',
    },
  ] as const;
  const option = alternatives[input.index]!;
  const learnedHook = input.narrationStyle?.hookMechanism === 'question'
    ? `你选${input.productLabel}时，最容易忽略什么？`
    : input.narrationStyle?.hookMechanism === 'contrast'
      ? `看${input.productLabel}，不是先听形容词，而是先核对真正影响判断的信息。`
      : `看${input.productLabel}，先别听形容词，三秒抓住真正值得核对的细节。`;
  return {
    hookId: `hook-${socialRequestHash({ analysisId: input.analysisId, index: input.index }).slice(0, 12)}`,
    role: input.role,
    ...option,
    spokenLine: input.index === 0 ? learnedHook
      : input.index === 1 ? `你选${input.productLabel}时，最容易忽略什么？`
        : '先看一个关键细节，再决定要不要继续了解。',
    caption: input.index === 0 ? '3 秒看懂怎么选'
      : input.index === 1 ? '你可能忽略了这一点'
        : '先看这个关键细节',
    sourceStrategy: input.strategy,
    truthBoundary,
    referencePoints: [input.firstShot.shotId, ...input.firstShot.fidelityPoints.slice(0, 3)],
    mustDifferPoints: [...REQUIRED_DIFFERENCES],
    detailedAnalysis: {
      firstFrameComposition: input.firstShot.shotLanguage?.composition
        || input.firstShot.tags.cameraLanguage.join('、') || '首帧主体与字幕安全区关系',
      primarySubject: input.firstShot.tags.subjects.join('、') || input.firstShot.visualDescription,
      subjectScaleAndPosition: `${input.firstShot.shotLanguage?.shotSize || '明确景别'}；${input.firstShot.shotLanguage?.cameraAngle || '主体位置可辨识'}`,
      actionStartAndPeak: input.firstShot.action
        ? `${input.firstShot.action.startState} → ${input.firstShot.action.path} → ${input.firstShot.action.endState}`
        : input.firstShot.visualDescription,
      cameraMovement: input.firstShot.shotLanguage?.movement || input.firstShot.tags.cameraLanguage.join('、') || '无可验证运镜记录',
      captionTrigger: input.firstShot.captionText || input.firstShot.tags.onScreenInformation.join('、') || '无首屏字幕触发',
      audioTrigger: input.firstShot.audioDescription || input.firstShot.tags.soundTypes.join('、') || '无明确声音触发',
      informationDensity: input.firstShot.tags.onScreenInformation.length + input.firstShot.tags.subjects.length >= 3 ? '高' : '中',
      swipeRisk: input.firstShot.startSeconds > 0.15 ? '主体出现偏晚' : '需确保第一帧主体可辨识且首秒动作有进展',
      minimumMaterialMatchScore: 0.78,
    },
    capabilitySignature: signature,
    productionAdmission: currentStackAdmission(signature),
    status: input.role === 'primary' ? 'recommended' : 'draft',
  };
}

function materialPlanForShot(shot: SocialReferenceShotAnalysis): SocialReplicationScriptShot['materialPlan'] {
  const truthBoundary = truthBoundaryFor({ purpose: shot.purpose, subject: shot.visualDescription });
  const sourceStrategy = shot.referenceProductionRouting?.route === 'reference_frame_presenter'
    ? 'authorized_digital_presenter' : productionStrategyFor(truthBoundary, shot.purpose, shot.visualContract);
  const usesDigitalHuman = sourceStrategy === 'authorized_digital_presenter';
  const usesProductAigc = sourceStrategy === 'aigc_product_scene_replication';
  return {
    shotId: shot.shotId,
    function: shot.purpose,
    requestedDescription: shot.visualDescription,
    sourceStrategy,
    ...(shot.referenceProductionRouting ? { referenceProductionRouting: structuredClone(shot.referenceProductionRouting) } : {}),
    sourceRefs: [],
    fallbackSourceStrategy: usesDigitalHuman || usesProductAigc ? null : 'motion_graphics',
    productionInstruction: usesDigitalHuman
      ? '按冻结口播与详细动作契约调用数字人；人物原素材只作画面参考，原声静音。'
      : usesProductAigc
        ? '锁定企业中心产品身份与参考画面的场景、构图、动作和运镜，再调用产品 IAIGC；不得把产品图简单叠到底图。'
        : `按口播逐字逐句在已入库素材中匹配精确片段，工厂、客户案例和企业通用素材可直接剪辑；${shot.rhythmDescription}只约束裁切与节奏。`,
    truthBoundary,
    functionalEquivalentReplacement: {
      required: false,
      preservesFunction: shot.purpose,
      replacesSubject: null,
      description: null,
      reason: null,
    },
    feasibility: 'functional_equivalent',
    feasibilityReason: usesDigitalHuman
      ? '人物出镜或人物使用产品由数字人承接，无需用户补充内容制作信息'
      : usesProductAigc
        ? '纯产品展示由产品身份锁定 IAIGC 承接，并按前三秒精细视觉契约执行'
        : '内容 Agent 按冻结口播优先选用已入库的可用素材片段，产品未指定时可使用企业通用素材',
    customerShootRequired: false,
  };
}

export function buildSocialTaskReferencePackage(input: {
  planning?: ReferenceSemanticPlanning;
  record: Record<string, unknown>;
  source: Pick<SocialTaskSource, 'sourceId' | 'sourceRef' | 'sourceVersion' | 'createdAt'>;
  themeId: SocialContentThemeId;
  verifiedContext: VerifiedSocialScriptContext;
  /** Target tenant identities. Product falls back to verified enterprise
   * knowledge; company and brand are replaced only when explicitly supplied. */
  identityReplacements?: {
    companyName?: string | null;
    brandName?: string | null;
    productName?: string | null;
  };
}): ResolvedSocialTaskReference | null {
  const exact = exactAnalysis(input.record);
  if (!exact || synthetic(input.record, exact.analysis)) return null;
  const recordIds = recordReferenceIdentities(input.record);
  if (![...sourceReferenceIdentities(input.source)].some(identity => recordIds.has(identity))) return null;
  const nodes = safeReferenceNodes(input.themeId, exact.details);
  const recordId = socialText(input.record.id);
  if (!recordId || nodes.length < 2) return null;
  const analysisId = `reference-analysis-${socialRequestHash({
    sourceId: input.source.sourceId,
    sourceRef: normalizedReferenceIdentity(input.source.sourceRef),
    recordId,
    analysis: input.record.aiAnalysis,
    shotReview: input.record.referenceShotReview,
    verifiedSpeech: input.record.referenceVerifiedSpeech,
  }).slice(0, 20)}`;
  const referenceLines = exact.reviewedSpeech
    ? exact.details.map(row => reviewedShotSpeech(row, exact.reviewedSpeech!, socialText(exact.analysis.analysisRunId), exact.reviewedSpeechPrecision || 'phrase').spokenText)
    : referenceNarrationLines(exact.details);
  const transcript = recordObject(exact.gemini.audioTranscript);
  const approximateLines = approximateSpeechLines(transcript.segments);
  const rawTranscriptSegments = Array.isArray(transcript.segments) ? transcript.segments.map(recordObject) : [];
  const phraseTranscript = rawTranscriptSegments.length > 0 && rawTranscriptSegments.every(segment =>
    segment.timingPrecision === 'phrase' && Boolean(socialText(segment.provenance))
    && Boolean(socialText(segment.text)) && Number(segment.end) > Number(segment.start));
  const sourceSpeech = exact.reviewedSpeech ?? (phraseTranscript ? rawTranscriptSegments : approximateLines.map(line => recordObject(line)));
  const sourcePrecision = exact.reviewedSpeechPrecision || (phraseTranscript ? 'phrase' : 'coarse');
  const runId = socialText(exact.analysis.analysisRunId);
  // ASR is the speech source of truth when present. Model-authored shot
  // dialogue may paraphrase and must not replace the actual source wording.
  if (!exact.reviewedSpeech && sourceSpeech.length) {
    exact.details.forEach((row, index) => {
      referenceLines[index] = reviewedShotSpeech(row, sourceSpeech, runId, sourcePrecision).spokenText;
    });
  }
  const referenceCaptions = referenceCaptionLines(exact.details);
  const replacements = identityPlan({
    record: input.record,
    exact,
    referenceLines,
    verifiedContext: input.verifiedContext,
    replacements: input.identityReplacements,
  });
  const canonicalRouting=buildReferenceShotProductionRouting({sourceSha256:socialText(exact.analysis.contentSha256),shots:exact.details.map((row,index)=>({
    shotId:socialText(row.detail.shotId)?`reference-${socialText(row.detail.shotId)}`:`reference-shot-${index+1}`,
    time:`${row.timing.startSeconds}-${row.timing.endSeconds}`,
    criticalShot:row.detail.criticalShot as Parameters<typeof buildReferenceShotProductionRouting>[0]['shots'][number]['criticalShot'],
    presenterContinuityEvidence:row.detail.presenterContinuityEvidence as ReferencePresenterContinuityEvidence|undefined,
  }))});
  const shots = exact.details.map((row, index) => publicShot({
    row,
    index,
    themeId: input.themeId,
    verifiedRouting:canonicalRouting.shots[index]!.productionRouting,
    spokenText: referenceLines[index],
    spokenTextTiming: sourceSpeech.length
      ? reviewedShotSpeech(row, sourceSpeech, runId, sourcePrecision).timing
      : sourceSpeechTiming(row, referenceLines[index] || '', transcript),
    spokenLines: sourceSpeech.length
      ? reviewedShotSpeech(row, sourceSpeech, runId, sourcePrecision).lines
      : verifiedSpokenLines(row, referenceLines[index] || '', transcript),
    captionText: referenceCaptions[index],
    productRef: input.identityReplacements?.productName || input.verifiedContext.productName,
  }));
  const openingShot = (row: ExactReferenceDetail) => row.timing.startSeconds < 3
    && row.timing.endSeconds > 0 && row.timing.durationSeconds >= 0.2;
  const defaultHookIndex = exact.details.findIndex(openingShot);
  if (defaultHookIndex < 0) return null;
  const selectedHookIndex = defaultHookIndex;
  const hookShot = shots[selectedHookIndex]!;
  const narrationStyle = deriveNarrationStyleProfile(exact.details.map(row => row.detail));
  const hookVoiceover = replaceIdentityOnly(sourceSpeech.length
    ? referenceLines[selectedHookIndex] ?? '' : '', replacements);
  const hookCaption = replaceIdentityOnly(referenceCaptions[selectedHookIndex] ?? '', replacements);
  const primaryHook = {
    ...hookOption({
    analysisId,
    role: 'primary',
    index: 0,
    firstShot: hookShot,
    strategy: productionStrategyFor(
      truthBoundaryFor({ purpose: 'hook', subject: hookShot.visualDescription }),
      'hook',
      hookShot.visualContract,
    ),
    productLabel: input.verifiedContext.productName || '这类产品',
    narrationStyle,
    }),
    spokenLine: hookVoiceover.text || null,
    caption: hookCaption.text || null,
  } satisfies SocialThreeSecondHook;
  const hookOptions: SocialThreeSecondHook[] = [
    primaryHook,
    {
      ...hookOption({ analysisId, role: 'alternative', index: 1, firstShot: hookShot, strategy: 'authorized_digital_presenter', productLabel: input.verifiedContext.productName || '这类产品' }),
      spokenLine: hookVoiceover.text || null,
      caption: hookCaption.text || null,
    },
    {
      ...hookOption({ analysisId, role: 'alternative', index: 2, firstShot: hookShot, strategy: 'motion_graphics', productLabel: input.verifiedContext.productName || '这类产品' }),
      spokenLine: hookVoiceover.text || null,
      caption: hookCaption.text || null,
    },
  ];
  const createdAt = socialText(input.record.updatedAt)
    || socialText(input.record.updated)
    || socialText(input.record.crawledAt)
    || input.source.createdAt;
  const coverage = referenceCoverage({ record: input.record, exact, shots });
  const referenceVideoAnalysis: SocialReferenceVideoAnalysis = {
    narrationProducts: listText(transcript.products), narrationBrands: listText(transcript.brands),
    analysisId,
    version: socialRequestHash({ recordId, analysis: input.record.aiAnalysis,
      shotReview: input.record.referenceShotReview, verifiedSpeech: input.record.referenceVerifiedSpeech }).slice(0, 12),
    referenceSourceId: input.source.sourceId,
    referenceRecordId: recordId,
    status: 'ready',
    durationSeconds: coverage.fullDurationSeconds,
    analysisLayers: [
      { level: 'L0', status: 'complete', scope: '来源、标题、平台元数据与整片时长', confidence: 1 },
      { level: 'L1', status: 'complete', scope: 'ASR、OCR、抽帧、镜头切分、主体与场景粗标签', confidence: coverage.overallConfidence },
      { level: 'L2', status: coverage.fullDurationSeconds === null ? 'partial' : 'complete', scope: '钩子、信息顺序、证据位置、节奏、情绪与 CTA 粗结构', confidence: coverage.overallConfidence },
      { level: 'L3', status: coverage.fullTimelineCovered ? 'complete' : 'partial', scope: '连续时间线、动作起止、空间连续性、镜头语言与音频层', confidence: coverage.overallConfidence },
      { level: 'L4', status: 'pending', scope: '等待误识别修正、权利风险与实际制作结果回流', confidence: null },
    ],
    coverage,
    shots,
    hookAnalysis: primaryHook,
    rightsNotice: '已入库的工厂、客户案例和企业通用素材可直接用于匹配与剪辑。口播按参考逐字逐句冻结，仅替换企业名、品牌名或产品名，不改写事实、句序、停顿与时长；画面、配乐、音效和字幕动效重新制作。',
    createdAt,
  };
  // Speech is one ordered source timeline. Visual cuts only reference lines;
  // they do not create another narration sentence when a line spans cuts.
  const uniqueSourceLines = new Map<string, NonNullable<SocialReferenceShotAnalysis['spokenLines']>[number]>();
  for (const shot of shots) for (const line of shot.spokenLines ?? []) {
    const key = JSON.stringify([line.startSeconds, line.endSeconds, line.text, line.provenance]);
    uniqueSourceLines.set(key, line);
  }
  const narrationLines = [...uniqueSourceLines.values()]
    .sort((left, right) => left.startSeconds - right.startSeconds
      || left.endSeconds - right.endSeconds)
    .map((line, index) => {
      const visualShotIds = shots
        .filter(shot => line.startSeconds < shot.endSeconds && line.endSeconds > shot.startSeconds)
        .map(shot => `replication-${shot.shotId}`);
      const adjusted = replaceIdentityOnly(line.text, replacements);
      return {
        lineId: `line-${String(index + 1).padStart(3, '0')}`,
        referenceText: line.text,
        draftText: adjusted.text,
        sourceStartSeconds: line.startSeconds,
        sourceEndSeconds: line.endSeconds,
        sourcePrecision: line.precision,
        sourceWords: line.precision === 'phrase' ? rawTranscriptSegments.filter(segment => Number(segment.start) === line.startSeconds && Number(segment.end) === line.endSeconds).flatMap(segment => Array.isArray(segment.words) ? segment.words.map(recordObject).map(word => ({start: Number(word.start), end: Number(word.end), text: socialText(word.text)})).filter(word => Number.isFinite(word.start) && word.end > word.start && word.text) : []) : [],
        sourceProvenance: line.provenance,
        replacedEntityTypes: adjusted.replacedEntityTypes,
        narrationOwnerShotId: visualShotIds[0] ?? '',
        visualShotIds,
      };
    });
  let scriptShots: SocialReplicationScriptShot[] = shots.map((shot, index) => {
    const rawDetail = exact.details[index]!.detail;
    const frameAction = referenceFrameActionPrompt(rawDetail);
    const referenceSpokenText = referenceLines[index] ?? '';
    const adjustedVoiceover = replaceIdentityOnly(referenceSpokenText, replacements);
    const adjustedCaption = replaceIdentityOnly(referenceCaptions[index] ?? '', replacements);
    const shotId = `replication-${shot.shotId}`;
    const speechLines = narrationLines.filter(line => line.visualShotIds.includes(shotId));
    const ownedLines = speechLines.filter(line => line.narrationOwnerShotId === shotId);
    const spokenText = ownedLines.map(line => line.draftText).join(' ');
    const referenceText = ownedLines.map(line => line.referenceText).join(' ');
    return {
    shotId,
    referenceShotId: shot.shotId,
    startSeconds: shot.startSeconds,
    endSeconds: shot.endSeconds,
    purpose: shot.purpose,
    visualInstruction: [
      `按${shot.visualDescription}的镜头功能制作全新内容。`,
      `抽帧动作证据（${frameAction.evidenceKind}，${frameAction.sampleCount}组）：${frameAction.prompt}`,
      socialText(rawDetail.omniNegativePrompt) ? `须避免：${socialText(rawDetail.omniNegativePrompt)}` : '',
      shot.materialEvidence?.firstFrameRef ? `参考首帧：${shot.materialEvidence.firstFrameRef}` : '',
    ].filter(Boolean).join(' '),
    referenceSpokenText: referenceText || null,
    spokenText: spokenText || null,
    speechLines,
    voiceoverReplacement: {
      mode: 'identity_only',
      replacedEntityTypes: adjustedVoiceover.replacedEntityTypes,
    },
    captionText: adjustedCaption.text || null,
    audioAndTransition: shot.audioDescription,
    fidelityPoints: [...shot.fidelityPoints],
    mustDifferPoints: [...shot.mustDifferPoints],
    materialPlan: materialPlanForShot(shot),
    lockedRegions: ['客户产品外观、包装、Logo 和文字不得被生成式修改', '客户真实人物身份和工厂事实不得被虚构替换'],
    risks: shot.tags.truthRequirements.some(item => item !== 'none')
      ? ['缺少客户真实证据时必须使用功能等价替代镜头']
      : [],
    };
  });
  if(input.planning)scriptShots=consolidateReferenceSemanticShots({shots:scriptShots,planning:input.planning,context:input.verifiedContext});
  let replicationScript: SocialReplicationScriptVersion = {
    version: String(Math.max(1, Date.parse(createdAt) || 1)),
    referenceAnalysisId: analysisId,
    status: 'review_required',
    primaryHookId: primaryHook.hookId,
    hookOptions,
    shots: scriptShots,
    narrationLines: scriptShots.some(shot=>shot.scriptOrigin==='budget_semantic_revision') ? [] : narrationLines,
    narrationSourceStatus: narrationLines.length ? 'asr_aligned' : 'missing_source_asr',
    structureFidelitySummary: scriptShots.some(shot=>shot.scriptOrigin==='budget_semantic_revision') ? '按整片预算和目标时长合并语义功能镜；所有参考镜头因素保留many-to-one映射。口播为企业原创精简版本，参考原时长与逐字台词不声称保真。' : '口播逐字逐句冻结，仅替换企业名、品牌名或产品名；同时保留句序、停顿、时长、前三秒机制、镜头功能与节奏关系。',
    originalityDifferenceSummary: '不做事实改写；画面按当前技术栈重制，音乐、音效、字幕动效和视觉包装使用全新版本。',
    createdAt,
  };
  replicationScript = applyExactPresenterTemporalSplit({ script: replicationScript, presenterDenseSampling: exact.analysis.presenterDenseSampling, details: exact.details, referenceShotIds: shots.map(shot => shot.shotId) });
  return {
    match: {
      recordId,
      title: '当前任务指定参考视频分析',
      confidence: 0.98,
      nodes,
      referenceSource: {
        sourceId: input.source.sourceId,
        sourceRef: input.source.sourceRef,
        sourceVersion: input.source.sourceVersion,
      },
    },
    referenceVideoAnalysis,
    replicationScript,
    shotMaterialMap: replicationScript.shots.map(shot => ({
      shotId: shot.shotId,
      customerAssetIds: [],
      generatedAssetIds: [],
      licensedAssetIds: [],
      sourceStrategy: shot.materialPlan.sourceStrategy,
      truthBoundary: shot.materialPlan.truthBoundary,
      functionalEquivalentReplacement: shot.materialPlan.functionalEquivalentReplacement,
    })),
  };
}

export function matchSocialInspirationScript(input: {
  records: Record<string, unknown>[];
  themeId: SocialContentThemeId;
  verifiedContext: VerifiedSocialScriptContext;
}): SocialInspirationScriptMatch | null {
  const themeTerms = THEME_TERMS[input.themeId];
  const productTerms = [input.verifiedContext.productName, ...input.verifiedContext.facts.map(item => item.value)]
    .map(socialText).filter(value => value.length >= 2);
  const candidates = input.records.flatMap(record => {
    const exact = exactAnalysis(record);
    if (!exact || synthetic(record, exact.analysis)) return [];
    const searchable = [
      record.title,
      ...listText(record.tags),
      exact.gemini.theme,
      exact.gemini.structure,
      ...listText(exact.gemini.sellingPoints),
      ...exact.details.flatMap(({ detail }) => [detail.purpose, detail.visual, detail.observedFacts]),
    ].map(socialText).join(' ').toLocaleLowerCase();
    const themeHits = themeTerms.filter(term => searchable.includes(term.toLocaleLowerCase())).length;
    if (!themeHits) return [];
    const productHits = productTerms.filter(term => searchable.includes(term.toLocaleLowerCase())).length;
    const timelineConfidence = exact.details
      .map(({ detail }) => Number(detail.confidence))
      .filter(Number.isFinite)
      .reduce((sum, value, _index, values) => sum + value / values.length, 0);
    const confidence = Math.max(0, Math.min(0.96,
      0.5 + Math.min(0.24, themeHits * 0.04) + Math.min(0.12, productHits * 0.04) + Math.min(0.1, timelineConfidence * 0.1)));
    return [{
      match: {
        recordId: socialText(record.id),
        title: '已分析灵感结构',
        confidence,
        nodes: safeReferenceNodes(input.themeId, exact.details),
      },
      updatedAt: Date.parse(socialText(record.updated) || socialText(record.crawledAt) || '') || 0,
    }];
  }).filter(item => item.match.recordId && item.match.confidence >= 0.58)
    .sort((left, right) => right.match.confidence - left.match.confidence || right.updatedAt - left.updatedAt);
  return candidates[0]?.match ?? null;
}

export {
  parseStoredSocialReferenceVideoAnalysis,
  parseStoredSocialReplicationScript,
  parseStoredSocialShotMaterialMap,
  resolveSocialInspirationScript,
  resolveSocialRecommendedReferenceScript,
  resolveSocialTaskReferenceScript,
} from './socialContentScriptResolvers.js';
/** Read-only projection: expose actionable codes, never provider logs or local paths. */
export function referencePreparationForRecord(row: Record<string, unknown> | null):
  { status: 'pending' | 'review_required' | 'blocked'; reason: string | null } {
  const analysis = socialObject(socialJson(row?.aiAnalysis));
  if (row && hasCompletedExactVideoEvidence(analysis ?? {})) {
    return exactAnalysis(row)
      ? { status: 'pending', reason: null }
      : { status: 'review_required', reason: 'director_review_pending' };
  }
  const error = socialText(analysis?.analysisError);
  if (error) return { status: 'blocked', reason: /Monthly usage hard limit|quota|额度/i.test(error) ? 'reference_provider_quota' : 'reference_download_failed' };
  return { status: 'pending', reason: null };
}

export async function readReferencePreparation(tenantId: string, sources: SocialTaskSource[]) {
  const source = sources.find(item => item.status === 'active' && item.kind === 'reference_link');
  if (!source) return { status: 'blocked' as const, reason: 'reference_missing' };
  const tenants = [...new Set([tenantId, socialText(process.env.SOCIAL_SHARED_INSPIRATION_TENANT_ID) || 'demo-shared-video-pool'])];
  const identities = sourceReferenceIdentities(source);
  const directId = socialText(source.sourceRef).match(/^(?:local:\/\/|trendvideo:|trend_video:|video:)([a-z0-9._-]+)$/i)?.[1];
  for (const owner of tenants) {
    const direct = directId ? await store.getById<Record<string, unknown>>('trend_videos', directId) : null;
    const listed = direct && socialText(direct.tenantId) === owner ? null
      : await store.list<Record<string, unknown>>('trend_videos', {
        where: { tenantId: owner, ...(source.sourceRef.startsWith('http') ? { sourceUrl: source.sourceRef } : {}) },
        page: 1, perPage: source.sourceRef.startsWith('http') ? 10 : 500,
      });
    const row = [direct, ...(listed?.items ?? [])].find(candidate => candidate
      && socialText(candidate.tenantId) === owner
      && [...identities].some(identity => recordReferenceIdentities(candidate).has(identity)));
    if (row) return referencePreparationForRecord(row);
  }
  return { status: 'pending' as const, reason: null };
}
