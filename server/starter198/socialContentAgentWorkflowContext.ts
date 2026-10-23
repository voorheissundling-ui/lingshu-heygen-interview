import {publicationProductionDeadline} from '../socialPrograms/publicationDeadlines.js';
import type {
  SocialAdHocBusinessContext,
  SocialContentTaskStatus,
  SocialDiscoveryBrief,
  SocialDirectorBriefScene,
  SocialExecutionCandidate,
  SocialInspirationHandoff,
  SocialReferenceVideoAnalysis,
  SocialReplicationFactorSpec,
  SocialReplicationJob,
  SocialReplicationJobContext,
  SocialReplicationReferenceChain,
  SocialReplicationReferenceMode,
  SocialReplicationScriptShot,
  SocialReplicationScriptVersion,
  SocialShotSourceStrategy,
  SocialTaskSource,
  SocialWeeklyContentPackage,
} from '../../shared/contracts/socialContentWorkflow.js';
import {
  buildSocialReplicationFactorSpecs,
  buildSocialTimelineBeats,
  inferSocialReplicationReferenceMode,
} from '../../shared/socialInspirationStrategy.js';
import { socialRequestHash } from './socialContentValidation.js';
import type { BuildSocialAgentWorkflowInput } from './socialContentAgentWorkflow.js';
import { objectStorageEnabled } from '../storage/objectStorage.js';
import { studioPaidBudget } from '../lib/studioPaidBudget.js';

type CapabilityDefinition = {
  strategy: SocialShotSourceStrategy;
  label: string;
  evidenceStrength: SocialExecutionCandidate['evidenceStrength'];
  estimatedCostCny: number;
  estimatedSeconds: number;
  estimatedSuccessRate: number;
  dataTransfer: SocialExecutionCandidate['dataTransfer'];
  rightsStatus: SocialExecutionCandidate['rightsStatus'];
  canDo: string[];
  cannotDo: string[];
  inputRequirements: string[];
  outputSpec: string;
  qualityRange: string;
  concurrencyLimit: number;
  rateLimitPerMinute: number;
  /** Product-level support. This does not assert that the current runtime can execute it. */
  planningAvailability: 'supported' | 'experimental' | 'unsupported';
  authorizationScope: string;
  dataRestriction: string;
  fallbackStrategies: SocialShotSourceStrategy[];
  applicableScenes: SocialDirectorBriefScene['purpose'][];
};

export interface SocialContentCapabilityRuntimeRegistration {
  strategy: SocialShotSourceStrategy;
  adapterIds: string[];
  environmentReady: boolean;
  reason: string | null;
}

export type SocialContentCapabilityRuntime = CapabilityDefinition & {
  availability: 'available' | 'degraded' | 'unavailable';
  executable: boolean;
  registeredAdapterIds: string[];
  availabilityReason: string | null;
};

/** Runtime registrations advertised to the planner. Provider-backed capabilities
 * become executable only after this process has verified their environment. */
/** Resolve runtime-backed capabilities when a workflow is built. Reading the
 * environment at module import made a worker keep an obsolete capability set
 * after its verified runtime configuration was refreshed. */
export function socialContentEmbeddedRuntimeRegistrations(options: { tenantId?: string; wholeFilmBudget?: boolean; productVideoProvider?: 'wan' | 'seedance' } = {}): SocialContentCapabilityRuntimeRegistration[] {
  const firstFrameReady = Boolean(String(process.env.SEEDREAM_API_KEY || process.env.SEEDANCE_API_KEY || '').trim());
  const productSceneReady = options.wholeFilmBudget && options.productVideoProvider === 'wan'
    ? firstFrameReady && Boolean(String(process.env.DASHSCOPE_API_KEY || '').trim())
    : process.env.SEEDANCE_VIDEO_ENABLED === 'true'
    && Boolean(String(process.env.SEEDANCE_API_KEY || '').trim())
    && Boolean(String(process.env.SEEDREAM_API_KEY || process.env.SEEDANCE_API_KEY || '').trim());
  const heygenBudget = studioPaidBudget.status('heygen', undefined, options.tenantId);
  const heygenReasons = [
    ...(process.env.SOCIAL_CONTENT_HEYGEN_ENABLED === 'true' ? [] : ['SOCIAL_CONTENT_HEYGEN_ENABLED']),
    ...(process.env.HEYGEN_GENERATION_ENABLED === 'true' ? [] : ['HEYGEN_GENERATION_ENABLED']),
    ...(String(process.env.HEYGEN_API_KEY || '').trim() ? [] : ['HEYGEN_API_KEY']),
    ...(objectStorageEnabled() ? [] : ['对象存储']),
    ...(options.wholeFilmBudget || heygenBudget.budgetExempt
      || heygenBudget.allowed && Number(heygenBudget.reservationCny) > 0
      ? [] : [`付费预算：${heygenBudget.reason || '未配置正数预留额'}`]),
  ];
  return [
    { strategy: 'customer_real_asset', adapterIds: ['existing_customer_asset.v1'], environmentReady: true, reason: null },
    { strategy: 'customer_product_image_animation', adapterIds: ['existing_customer_asset.v1'], environmentReady: true, reason: null },
    { strategy: 'licensed_stock_asset', adapterIds: ['authorized_shared_library.v1'], environmentReady: true, reason: '执行仍取决于租户可见库存与逐条授权记录' },
    { strategy: 'motion_graphics', adapterIds: ['system_safe_motion_graphics.v1'], environmentReady: true, reason: null },
    { strategy: 'verified_fact_card', adapterIds: ['system_safe_motion_graphics.v1'], environmentReady: true, reason: null },
    {
      strategy: 'authorized_digital_presenter',
      adapterIds: ['controlled_digital_presenter.v1'],
      environmentReady: heygenReasons.length === 0,
      reason: heygenReasons.length ? heygenReasons.join('；') : null,
    },
    ...(productSceneReady ? [{
      strategy: 'aigc_product_scene_replication',
      adapterIds: ['controlled_product_scene_replication.v1'],
      environmentReady: true,
      reason: null,
    } satisfies SocialContentCapabilityRuntimeRegistration] : []),
  ];
}

const CAPABILITIES: CapabilityDefinition[] = [
  { strategy: 'customer_product_image_animation', label: '产品图基础动效（兼容）', evidenceStrength: 'supporting', estimatedCostCny: 0.35, estimatedSeconds: 45, estimatedSuccessRate: 0.94, dataTransfer: 'local_only', rightsStatus: 'confirmed', canDo: ['在不具备产品场景生成能力时制作受控的基础运镜'], cannotDo: ['宣称完整复刻参考场景或镜头语言', '重绘包装文字、商标或证明真实使用效果'], inputRequirements: ['已授权且清晰的客户产品图'], outputSpec: '基础产品图短镜头', qualityRange: '仅作为兼容回退路线', concurrencyLimit: 4, rateLimitPerMinute: 30, planningAvailability: 'supported', authorizationScope: '当前租户产品素材', dataRestriction: '本地处理优先', fallbackStrategies: ['motion_graphics'], applicableScenes: ['hook', 'value', 'demonstration', 'call_to_action'] },
  { strategy: 'aigc_product_scene_replication', label: 'AIGC 产品场景复刻', evidenceStrength: 'supporting', estimatedCostCny: 2.8, estimatedSeconds: 240, estimatedSuccessRate: 0.78, dataTransfer: 'external_processor', rightsStatus: 'restricted', canDo: ['在锁定真实产品身份的前提下，复现展台、背景、布光、产品槽位和完整镜头轨迹'], cannotDo: ['重设计产品轮廓、材质、Logo或包装文字', '把生成场景表述为客户真实工厂、案例或使用效果', '用静态产品图缩放、平移或幻灯片冒充产品场景视频'], inputRequirements: ['ProductIdentityLock', 'ProductSceneReplicationSpec', '素材库产品参考图', '单镜预算'], outputSpec: '产品身份、场景拓扑与镜头轨迹可分别验收的视频镜头', qualityRange: '五项强锁门禁通过后才可采用', concurrencyLimit: 2, rateLimitPerMinute: 8, planningAvailability: 'supported', authorizationScope: '当前租户可见素材库', dataRestriction: '仅传输本镜产品参考与冻结场景规格', fallbackStrategies: [], applicableScenes: ['hook', 'value', 'demonstration', 'call_to_action'] },
  { strategy: 'authorized_digital_presenter', label: '账号一致数字人口播', evidenceStrength: 'non_evidentiary', estimatedCostCny: 4.48, estimatedSeconds: 150, estimatedSuccessRate: 0.87, dataTransfer: 'external_processor', rightsStatus: 'restricted', canDo: ['复用当前社媒账号已发布的形象与声音人格生成稳定口播'], cannotDo: ['任务内随机换脸、换声、换年龄感或冒充客户证言'], inputRequirements: ['已确认口播', '已发布 AccountPresenterProfile', '形象与声音授权', '目标语言'], outputSpec: '带账号身份版本溯源的口播镜头', qualityRange: '口型、人脸、声纹与账号身份一致性逐镜检查', concurrencyLimit: 2, rateLimitPerMinute: 10, planningAvailability: 'supported', authorizationScope: '当前社媒账号已发布数字人版本', dataRestriction: '仅传输生成所需文案和锁定身份资产', fallbackStrategies: ['motion_graphics'], applicableScenes: ['hook', 'problem', 'value', 'call_to_action'] },
  { strategy: 'licensed_stock_asset', label: '商用授权素材库', evidenceStrength: 'non_evidentiary', estimatedCostCny: 0.8, estimatedSeconds: 30, estimatedSuccessRate: 0.9, dataTransfer: 'external_processor', rightsStatus: 'confirmed', canDo: ['补充环境、气氛和转场画面'], cannotDo: ['作为客户真实工厂、案例或效果证据'], inputRequirements: ['场景语义', '平台和权利范围'], outputSpec: '已授权图片或视频片段', qualityRange: '依赖素材库供给', concurrencyLimit: 8, rateLimitPerMinute: 60, planningAvailability: 'supported', authorizationScope: '商用授权范围内', dataRestriction: '只发送检索词和规格', fallbackStrategies: ['non_evidentiary_ai_visual', 'motion_graphics'], applicableScenes: ['hook', 'problem', 'value', 'transition'] },
  { strategy: 'non_evidentiary_ai_visual', label: '非证明性生成画面', evidenceStrength: 'non_evidentiary', estimatedCostCny: 1.8, estimatedSeconds: 220, estimatedSuccessRate: 0.74, dataTransfer: 'external_processor', rightsStatus: 'restricted', canDo: ['生成概念、气氛和非证明性辅助画面'], cannotDo: ['伪造客户工厂、案例、认证、效果或真实产品细节'], inputRequirements: ['真值边界', '画面目标', '禁止事项'], outputSpec: '图片或短视频镜头', qualityRange: '一致性和文字准确性需复检', concurrencyLimit: 2, rateLimitPerMinute: 8, planningAvailability: 'supported', authorizationScope: '允许外部生成的非敏感输入', dataRestriction: '真实客户证据不得外传或作为生成目标', fallbackStrategies: ['motion_graphics', 'licensed_stock_asset'], applicableScenes: ['hook', 'problem', 'value', 'transition'] },
  { strategy: 'motion_graphics', label: '动态图文与示意动画', evidenceStrength: 'non_evidentiary', estimatedCostCny: 0.25, estimatedSeconds: 35, estimatedSuccessRate: 0.97, dataTransfer: 'local_only', rightsStatus: 'confirmed', canDo: ['生成流程示意、字幕、图标和品牌动画'], cannotDo: ['替代未经确认的产品事实或真实证据'], inputRequirements: ['已确认文案或事实'], outputSpec: '可组合的视频图形层', qualityRange: '稳定可控', concurrencyLimit: 8, rateLimitPerMinute: 120, planningAvailability: 'supported', authorizationScope: '当前租户品牌资产', dataRestriction: '本地处理', fallbackStrategies: ['authorized_digital_presenter'], applicableScenes: ['hook', 'problem', 'value', 'demonstration', 'transition', 'call_to_action'] },
  { strategy: 'verified_fact_card', label: '已确认事实卡片', evidenceStrength: 'supporting', estimatedCostCny: 0.12, estimatedSeconds: 20, estimatedSuccessRate: 0.99, dataTransfer: 'local_only', rightsStatus: 'confirmed', canDo: ['把已确认参数和事实转为可读信息卡'], cannotDo: ['补写未确认参数、认证、价格或效果'], inputRequirements: ['可追溯事实引用'], outputSpec: '品牌化信息卡视频层', qualityRange: '事实准确性优先', concurrencyLimit: 16, rateLimitPerMinute: 240, planningAvailability: 'supported', authorizationScope: '当前任务确认事实', dataRestriction: '本地处理', fallbackStrategies: ['motion_graphics'], applicableScenes: ['value', 'demonstration', 'proof', 'trust', 'call_to_action'] },
];

export function socialContentCapabilityRegistry(
  registrations: SocialContentCapabilityRuntimeRegistration[] = socialContentEmbeddedRuntimeRegistrations(),
): ReadonlyArray<Readonly<SocialContentCapabilityRuntime>> {
  const byStrategy = new Map(registrations.map(item => [item.strategy, item]));
  return CAPABILITIES.map(capability => {
    const runtime = byStrategy.get(capability.strategy);
    const adapterIds = runtime?.adapterIds.filter(Boolean) ?? [];
    const executable = adapterIds.length > 0 && runtime?.environmentReady === true;
    return {
      ...structuredClone(capability),
      availability: executable ? 'available' : adapterIds.length > 0 ? 'degraded' : 'unavailable',
      executable,
      registeredAdapterIds: [...adapterIds],
      availabilityReason: executable ? runtime?.reason ?? null
        : runtime?.reason ?? (adapterIds.length ? '执行环境未就绪' : '未注册执行适配器'),
    };
  });
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function positiveNumber(value: number | null | undefined): number | null {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : null;
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${socialRequestHash(value).slice(0, 20)}`;
}

export function buildBusinessContext(input: BuildSocialAgentWorkflowInput): {
  weeklyPackage: SocialWeeklyContentPackage | null;
  adHocBusinessContext: SocialAdHocBusinessContext | null;
} {
  const originalContentCount = Math.max(1, Math.floor(input.brief.requestedOutputCount || 1));
  const publicationTaskCount = originalContentCount * Math.max(1, input.brief.platforms.length);
  if (input.mode === 'weekly') {
    const authority = input.authoritativeContext;
    if (authority) {
      const content = authority.weeklyPackage.socialContentPackage;
      return {
        weeklyPackage: {
          packageId: authority.weeklyPackage.packageId,
          version: String(authority.weeklyPackage.version),
          businessGoal: authority.businessGoal.objective,
          productFocus: authority.businessGoal.products[0] ?? input.brief.productRef,
          audience: authority.businessGoal.audiences[0] ?? input.brief.audience,
          markets: [...authority.businessGoal.markets],
          languages: [...authority.businessGoal.languages],
          originalContentCount: content.originalContentTarget,
          adaptationVersionCount: content.adaptationVersionTarget,
          publicationTaskCount: content.publicationTaskTarget,
          platforms: unique(content.publicationTasks.map(item => item.platform)),
          publicationMatrix: content.publicationTasks.map(item => ({
            platform: item.platform,
            accountRef: item.accountId,
            accountPositioning: item.accountPositioning,
            publishWindow: item.publishWindow,
          })),
          weeklyBudgetCny: content.weeklyBudgetCny,
          perItemBudgetCny: content.perItemBudgetCny,
          dueAt: publicationProductionDeadline(authority.publicationTask.publishWindow),
          availableAssetRefs: input.sources.filter(source => source.kind === 'material').map(source => source.sourceId),
          customerCanShoot: false,
          availableCapabilities: socialContentCapabilityRegistry(input.capabilityRuntime)
            .filter(item => item.executable).map(item => item.strategy),
          priorities: ['must_do'],
          successCriteria: [...authority.weeklyPackage.successCriteria],
          metricTargets: [...authority.publicationTask.metricTargets],
          createdBy: 'business_agent',
        },
        adHocBusinessContext: null,
      };
    }
    return {
      weeklyPackage: {
        packageId: input.weeklyPlanId || stableId('weekly_package', { taskId: input.taskId }),
        version: input.taskVersion,
        businessGoal: input.brief.objective,
        productFocus: input.brief.productRef,
        audience: input.brief.audience,
        markets: input.brief.markets,
        languages: input.brief.languages,
        originalContentCount,
        adaptationVersionCount: Math.max(0, publicationTaskCount - originalContentCount),
        publicationTaskCount,
        platforms: input.brief.platforms,
        publicationMatrix: input.brief.platforms.map(platform => ({ platform, accountRef: null, accountPositioning: null, publishWindow: input.brief.dueAt })),
        weeklyBudgetCny: positiveNumber(input.brief.weeklyBudgetCny),
        perItemBudgetCny: positiveNumber(input.brief.perItemBudgetCny),
        dueAt: input.brief.dueAt,
        availableAssetRefs: input.sources.filter(source => source.kind === 'material').map(source => source.sourceId),
        customerCanShoot: false,
        availableCapabilities: socialContentCapabilityRegistry(input.capabilityRuntime)
          .filter(item => item.executable).map(item => item.strategy),
        priorities: ['must_do'],
        successCriteria: unique([
          input.brief.objective,
          input.brief.callToAction ? `观众完成行动：${input.brief.callToAction}` : '',
        ].filter(Boolean)),
        metricTargets: ['播放完成度', '互动质量', '有效询盘或目标行动'],
        createdBy: 'business_agent',
      },
      adHocBusinessContext: null,
    };
  }
  return {
    weeklyPackage: null,
    adHocBusinessContext: {
      contextId: stableId('ad_hoc_context', { taskId: input.taskId }),
      version: input.taskVersion,
      objective: input.brief.objective,
      productRef: input.brief.productRef,
      audience: input.brief.audience,
      platforms: input.brief.platforms,
      markets: input.brief.markets,
      languages: input.brief.languages,
      budgetCny: positiveNumber(input.brief.perItemBudgetCny),
      dueAt: input.brief.dueAt,
      factSourceRefs: input.factSourceRefs,
      createdBy: 'business_agent',
    },
  };
}

function platformFromReference(value: string): string {
  if (/tiktok/i.test(value)) return 'tiktok';
  if (/youtu/i.test(value)) return 'youtube';
  if (/instagram/i.test(value)) return 'instagram';
  if (/facebook|fb\.watch/i.test(value)) return 'facebook';
  return 'external';
}

export function buildDiscoveryBrief(input: BuildSocialAgentWorkflowInput): SocialDiscoveryBrief | null {
  if (input.brief.creationMode !== 'viral_replication') return null;
  const market = input.brief.markets[0] || '';
  const audience = input.brief.audience || '';
  const productRef = input.brief.productRef || '';
  const keywordSetId = stableId('market_keyword_set', { productRef, market, audience });
  return {
    discoveryBriefId: stableId('discovery_brief', { taskId: input.taskId, version: input.taskVersion }),
    keywordSetId,
    keywordSetVersion: 1,
    productRef,
    market,
    audience,
    discoverySeedIds: productRef ? [stableId('seed', { keywordSetId, productRef })] : [],
    trackedSceneIds: [],
    competitorAccounts: [],
    discoveryModes: ['momentum', 'account', 'innovation'],
    platforms: [...input.brief.platforms],
    lookbackDays: 7,
    resultLimit: 30,
    budgetLimitCny: positiveNumber(input.brief.perItemBudgetCny),
    productionGap: input.referenceAnalysis ? null : '当前任务尚无达到生产级的参考分析',
    createdBy: 'director_agent',
  };
}

export function buildInspirationHandoffs(input: BuildSocialAgentWorkflowInput): SocialInspirationHandoff[] {
  const analysis = input.referenceAnalysis;
  if (!analysis) return [];
  const source = input.sources.find(item => item.sourceId === analysis.referenceSourceId)
    ?? input.sources.find(item => item.kind === 'reference_link');
  const exactReady = analysis.status === 'ready'
    && analysis.coverage?.fullTimelineCovered === true
    && (analysis.analysisLayers ?? []).some(layer => layer.level === 'L3' && layer.status === 'complete');
  const strategyReady = analysis.status === 'ready'
    && ((analysis.analysisLayers ?? []).some(layer => layer.level === 'L2' && layer.status === 'complete') || analysis.shots.length > 0);
  const readiness: SocialInspirationHandoff['readiness'] = exactReady
    ? 'production_reference'
    : strategyReady ? 'strategy_reference' : 'discovery_reference';
  const sourceRef = source?.sourceRef || '';
  const primaryHook = analysis.hookAnalysis;
  return [{
    handoffId: stableId('inspiration_handoff', { taskId: input.taskId, inspirationId: source?.sourceId || analysis.referenceSourceId }),
    version: input.taskVersion,
    inspirationId: source?.sourceId || analysis.referenceSourceId,
    analysisId: analysis.analysisId,
    analysisVersion: analysis.version || input.taskVersion,
    readiness,
    source: { platform: platformFromReference(sourceRef), sourceUrl: sourceRef },
    taskContext: {
      taskId: input.taskId,
      productRef: input.brief.productRef || undefined,
      market: input.brief.markets[0],
      audience: input.brief.audience || undefined,
    },
    whySelected: source?.sourceId.startsWith('system-reference:')
      ? ['系统根据当前产品、受众和任务目标推荐']
      : ['用户已将该参考关联到当前任务'],
    referenceRole: 'primary_structure',
    reusableLogic: {
      hookTypes: unique([primaryHook?.mechanism || ''].filter(Boolean)),
      revealOrder: analysis.shots.map(shot => shot.purpose),
      proofPlacement: analysis.shots.filter(shot => shot.purpose === 'proof').map(shot => `${shot.startSeconds}-${shot.endSeconds}s`),
      pacing: analysis.shots.map(shot => shot.rhythmDescription).filter(Boolean).join(' → '),
      emotionalProgression: '由前三秒吸引进入价值与证明，再收束到行动',
      ctaPosition: analysis.shots.some(shot => shot.purpose === 'call_to_action') ? '结尾' : '待编导补充',
    },
    adaptationBoundary: {
      reusable: unique(analysis.shots.flatMap(shot => shot.fidelityPoints)),
      mustReplace: unique(analysis.shots.flatMap(shot => shot.mustDifferPoints)),
      prohibited: ['原视频文件', '原人物身份', '原品牌与商标', '原台词和字幕', '未授权音乐'],
    },
    productionImplications: {
      requiredEvidence: unique(analysis.shots.flatMap(shot => shot.observation?.observableFacts ?? [])),
      likelyAssetNeeds: unique(analysis.shots.flatMap(shot => shot.tags?.sceneTypes ?? [])),
      difficulty: exactReady ? 'medium' : 'high',
      risks: analysis.coverage?.gaps.map(gap => `${gap.startSeconds}-${gap.endSeconds}s：${gap.reason}`) ?? [],
    },
    evidenceRefs: analysis.shots.map(shot => ({
      startTime: shot.startSeconds,
      endTime: shot.endSeconds,
      description: shot.visualDescription,
      confidence: analysis.coverage?.overallConfidence ?? 0.7,
      needsReview: Boolean(shot.observation?.causalGaps?.length),
    })),
    rights: { mayAnalyze: true, mayUseOriginalMedia: false, mayAdapt: false, note: analysis.rightsNotice },
  }];
}

export function authoritativeHandoffs(input: BuildSocialAgentWorkflowInput): SocialInspirationHandoff[] {
  const authority = input.authoritativeContext;
  if (!authority) return input.inspirationHandoffs ?? [];
  if (authority.referenceSelection.status !== 'selected') throw new Error('social_content_reference_selection_required');
  const selected = new Set(authority.referenceSelection.selected.map(item => item.candidateId));
  const evidenceRefs = new Set(authority.referenceSelection.evidenceVersionRefs);
  const handoffs = authority.selectedHandoffs.filter(item => selected.has(item.inspirationId));
  if (handoffs.length !== selected.size || authority.referenceSelection.selected.some(item => (
    !evidenceRefs.has(`${item.evidenceId}@${item.evidenceVersion}`)
  ))) throw new Error('social_content_reference_selection_lineage_invalid');
  return handoffs.map(handoff => ({
    ...handoff,
    handoffId: handoff.handoffId ?? stableId('inspiration_handoff', { taskId: authority.weeklyWorkflowTask.taskId, inspirationId: handoff.inspirationId }),
    version: handoff.version ?? String(authority.referenceSelection.version),
    taskContext: { ...handoff.taskContext, taskId: authority.weeklyWorkflowTask.taskId },
    whySelected: unique([...handoff.whySelected, `ReferenceSelector ${authority.referenceSelection.selectionId}@${authority.referenceSelection.version}`]),
  }));
}

export function mergeInspirationHandoffs(
  generated: SocialInspirationHandoff[],
  provided: SocialInspirationHandoff[],
): SocialInspirationHandoff[] {
  const byAnalysisId = new Map<string, SocialInspirationHandoff>();
  for (const handoff of [...provided, ...generated]) byAnalysisId.set(handoff.analysisId, handoff);
  return [...byAnalysisId.values()];
}

function referenceChain(input: {
  context: SocialReplicationJobContext | undefined;
  analysis: SocialReferenceVideoAnalysis | null;
  analysisId?: string;
  analysisVersion?: string;
  timelineBeatIds?: string[];
  checkedAt: string;
}): SocialReplicationReferenceChain {
  const benchmarkAccountSnapshot = input.context?.benchmarkAccountSnapshotRef ?? null;
  const referenceContentAnalysis = input.context?.referenceContentAnalysisRef ?? null;
  const analysisId = input.analysisId ?? input.analysis?.analysisId ?? null;
  const analysisVersion = input.analysisVersion ?? input.analysis?.version ?? null;
  const referenceAnalysis = analysisId ? {
    objectType: 'reference_analysis',
    id: analysisId,
    version: analysisVersion || 'historic',
  } : null;
  const timelineBeatIds = input.timelineBeatIds ?? (input.analysis ? buildSocialTimelineBeats(input.analysis).map(beat => beat.beatId) : []);
  const timelineBeats = timelineBeatIds.map(beatId => ({
    objectType: 'timeline_beat',
    id: beatId,
    version: analysisVersion || 'historic',
  }));
  const targetAccountPlaybook = input.context?.accountPlaybookRef ?? null;
  const missing: SocialReplicationReferenceChain['integrity']['missing'] = [];
  if (!benchmarkAccountSnapshot) missing.push('benchmark_account');
  if (!referenceContentAnalysis) missing.push('reference_content');
  if (!referenceAnalysis) missing.push('reference_analysis');
  if (!timelineBeats.length) missing.push('timeline_beats');
  if (!targetAccountPlaybook) missing.push('account_playbook');
  return {
    benchmarkAccountSnapshot,
    referenceContentAnalysis,
    referenceAnalysis,
    timelineBeats,
    targetAccountPlaybook,
    integrity: { complete: missing.length === 0, missing, checkedAt: input.checkedAt },
  };
}

export function buildReplicationJob(input: BuildSocialAgentWorkflowInput, context: ReturnType<typeof buildBusinessContext>, handoffs: SocialInspirationHandoff[]): SocialReplicationJob | null {
  if (input.brief.creationMode !== 'viral_replication') return null;
  const createdAt = (input.now ?? new Date()).toISOString();
  const replicationContext: SocialReplicationJobContext = {
    ...input.replicationContext,
    programRef: input.replicationContext?.programRef ?? input.brief.programRef ?? null,
    targetAccountRef: input.replicationContext?.targetAccountRef ?? input.brief.targetAccountRef ?? null,
    accountPlaybookRef: input.replicationContext?.accountPlaybookRef ?? input.brief.accountPlaybookRef ?? null,
    referenceMode: input.replicationContext?.referenceMode ?? input.brief.referenceMode,
    primaryExperimentVariable: input.replicationContext?.primaryExperimentVariable ?? input.brief.primaryExperimentVariable ?? null,
  };
  const referenceMode: SocialReplicationReferenceMode = inferSocialReplicationReferenceMode({
    explicitMode: replicationContext.referenceMode,
    userRequestedExactReplication: replicationContext.referenceMode === 'single_source_fidelity',
    referenceCount: handoffs.length || (input.referenceAnalysis ? 1 : 0),
    hasAccountFormatEvidence: Boolean(input.replicationContext?.benchmarkAccountSnapshotRef),
  });
  const timelineBeats = input.referenceAnalysis ? buildSocialTimelineBeats(input.referenceAnalysis) : [];
  const fullTimelineReady = Boolean(input.referenceAnalysis?.status === 'ready'
    && input.referenceAnalysis.coverage?.fullTimelineCovered !== false
    && timelineBeats.length);
  const factors: SocialReplicationFactorSpec[] = input.referenceAnalysis && fullTimelineReady
    ? buildSocialReplicationFactorSpecs({
      analysis: input.referenceAnalysis,
      referenceMode,
      version: input.taskVersion,
      frozenAt: createdAt,
    })
    : [];
  const chain = referenceChain({
    context: replicationContext,
    analysis: input.referenceAnalysis,
    timelineBeatIds: timelineBeats.map(beat => beat.beatId),
    checkedAt: createdAt,
  });
  const primaryAnalysisId = replicationContext.primaryReferenceAnalysisId
    ?? input.referenceAnalysis?.analysisId
    ?? handoffs.find(handoff => handoff.referenceRole === 'primary_structure')?.analysisId
    ?? null;
  const assignments = handoffs.map((handoff, index) => {
    const primary = referenceMode === 'single_source_fidelity'
      ? handoff.analysisId === primaryAnalysisId
      : handoff.referenceRole === 'primary_structure' && index === handoffs.findIndex(item => item.referenceRole === 'primary_structure');
    return {
      assignmentId: stableId('reference_assignment', { taskId: input.taskId, analysisId: handoff.analysisId, role: handoff.referenceRole }),
      inspirationId: handoff.inspirationId,
      analysisId: handoff.analysisId,
      analysisVersion: handoff.analysisVersion,
      role: handoff.referenceRole,
      primary,
      purpose: handoff.whySelected.join('；') || `作为${handoff.referenceRole}参考`,
      chain: handoff.analysisId === input.referenceAnalysis?.analysisId || (replicationContext.verifiedPrimaryReference?.sourceAnalysisId===handoff.analysisId && replicationContext.verifiedPrimaryReference.sourceAnalysisVersion===handoff.analysisVersion && replicationContext.verifiedPrimaryReference.runtimeAnalysisId===input.referenceAnalysis?.analysisId && replicationContext.verifiedPrimaryReference.runtimeAnalysisVersion===input.referenceAnalysis?.version && replicationContext.verifiedPrimaryReference.recordId===input.referenceAnalysis?.referenceRecordId) ? chain : referenceChain({
        context: replicationContext,
        analysis: null,
        analysisId: handoff.analysisId,
        analysisVersion: handoff.analysisVersion,
        timelineBeatIds: [],
        checkedAt: createdAt,
      }),
    };
  });
  const singleSourcePrimaryCount = assignments.filter(assignment => assignment.primary).length;
  const factorReady = fullTimelineReady
    && factors.length > 0
    && factors.every(factor => factor.evidenceRefs.length > 0 && factor.validator.detector && factor.target.metric)
    && (referenceMode !== 'single_source_fidelity' || singleSourcePrimaryCount === 1);
  const blocked = Boolean(input.referenceAnalysis && !fullTimelineReady)
    || (referenceMode === 'single_source_fidelity' && assignments.length > 0 && singleSourcePrimaryCount !== 1);
  const businessContextRef = context.weeklyPackage ? {
    objectType: 'weekly_content_package', id: context.weeklyPackage.packageId, version: context.weeklyPackage.version,
  } : {
    objectType: 'ad_hoc_business_context',
    id: context.adHocBusinessContext?.contextId ?? stableId('ad_hoc_context', { taskId: input.taskId }),
    version: context.adHocBusinessContext?.version ?? input.taskVersion,
  };
  const inputRefCandidates = [
    businessContextRef,
    ...(chain.benchmarkAccountSnapshot ? [chain.benchmarkAccountSnapshot] : []),
    ...(chain.referenceContentAnalysis ? [chain.referenceContentAnalysis] : []),
    ...(chain.referenceAnalysis ? [chain.referenceAnalysis] : []),
    ...(chain.targetAccountPlaybook ? [chain.targetAccountPlaybook] : []),
  ];
  const inputRefs = [...new Map(inputRefCandidates.map(ref => [JSON.stringify(ref), ref])).values()];
  return {
    replicationJobId: stableId('replication_job', { taskId: input.taskId }),
    version: input.taskVersion,
    contentTaskId: input.taskId,
    status: blocked ? 'blocked' : factorReady ? 'factor_ready' : input.referenceAnalysis?.status === 'ready' ? 'reference_ready' : 'draft',
    referenceMode,
    target: {
      programRef: replicationContext.programRef ?? null,
      accountRef: replicationContext.targetAccountRef ?? null,
      accountPlaybookRef: replicationContext.accountPlaybookRef ?? null,
      productRef: input.brief.productRef,
    },
    businessContextRef,
    referenceAssignments: assignments,
    primaryReferenceAnalysisId: primaryAnalysisId,
    referenceChain: chain,
    factorSpecVersion: input.taskVersion,
    factorSpecs: factors,
    primaryExperimentVariable: replicationContext.primaryExperimentVariable ?? null,
    frozenAt: factorReady ? createdAt : null,
    inputRefs,
    createdBy: 'director_agent',
    createdAt,
  };
}
