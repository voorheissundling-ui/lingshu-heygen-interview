import { normalizeVideoPlan, type VideoCreationPlan, videoPlanErrors } from '../../shared/contracts/videoCreationPlan.js';
import type { DigitalEmployeeConfig, PublishingPlatform, WeeklyGoalInput } from './domain.js';
import type { DirectorScriptContract } from '../../src/lib/directorScript.js';
import { platformExecutionConstraints } from '../../shared/contracts/socialOperatingProfile.js';
import { MATERIAL_TYPE_LABELS, SHOT_ROLE_LABELS, type BenchmarkAnalysis } from '../../shared/benchmarkAnalysis.js';
import { productionReferenceAdmission, type ProductionReferenceAdmission } from '../../shared/productionReferenceAdmission.js';
import { compileFixedYieldTimeline, type FixedYieldTimelineCompilation } from '../../shared/fixedYieldTimelineCompiler.js';
import {
  referenceContentIdentity,
  sameReferenceContent,
  type ReferenceContentIdentity,
} from './referenceContentIdentity.js';

export type ContentRoute = 'clone' | 'product' | 'material';

export interface ContentRoutingEvidence {
  products: Array<{ id: string; name: string; materialIds: string[] }>;
  exactAnalysisIds: string[];
  /** Server-rebuilt admission; completion IDs alone only prove analysis ran. */
  referenceAdmissions?: Record<string, ProductionReferenceAdmission>;
  /** Server-normalized references used to freeze the exact physical timeline. */
  referenceAnalyses?: Record<string, BenchmarkAnalysis>;
  /** Server-derived physical identities. Record ids alone are not sufficient:
   * downloads/reimports of the same video must still count as one weekly use. */
  referenceIdentities?: Record<string, ReferenceContentIdentity>;
  materialIds: string[];
}

export interface ContentOrder extends Partial<DirectorScriptContract> {
  /** Server-controlled: additional production is not covered by a weekly publish grant. */
  publishMode?: 'draft_only';
  videoPlan?: VideoCreationPlan;
  /** Publish destinations derived from this master without another full render. */
  deliveryVariants?: Array<{
    contentId: string;
    platform: PublishingPlatform;
    accountId: string;
    accountLabel: string;
    plannedPublishDate: string;
    plannedPublishAt?: string;
    adaptationMode: 'master' | 'platform_light';
    publication?: VideoCreationPlan['publication'];
  }>;
  /** Frozen autonomous deliverable languages for this approved order. */
  languages?: string[];
  id: string;
  goalId: string;
  productId: string;
  productName: string;
  theme: { key: string; label: string };
  platform: PublishingPlatform;
  accountId: string;
  accountLabel: string;
  route: ContentRoute;
  configurationSnapshot: { configVersion: number; policyVersion: string; factsVersion: string };
  cta: string;
  constraints: string[];
  evidenceRefs: Array<{ type: 'exact_analysis' | 'enterprise_material'; id: string }>;
  /** Missing inputs for this master only; unrelated orders may still run. */
  readinessBlockers?: string[];
  /** One-to-one reference timeline compiled on the server before production. */
  fixedYieldTimeline?: FixedYieldTimelineCompilation;
  /** Explicit executor gate; legacy projects are never silently interpreted as V2. */
  productionContractVersion?: 'legacy.v1' | 'fixed-yield.v2-preflight';
  status: 'planned';
}

export interface ContentBatchPlanDraft {
  status: 'planned' | 'blocked';
  orders: ContentOrder[];
  blocker: string;
  coverage?: ReturnType<typeof contentPlanCoverage>;
  eligibleRoutes: ContentRoute[];
  disabledRoutes: Array<{ route: ContentRoute; reason: string }>;
}

interface PriorReviewRoutingEvidence {
  priorRouteDistribution?: Partial<Record<ContentRoute, number>>;
  approvalFeedback?: Array<{ note?: string }>;
  contentInheritance?: {
    status?: string;
    title?: string;
    hook?: string;
    framework?: string[];
  };
  tagAdaptation?: {
    status?: string;
    newTags?: string[];
    droppedTags?: string[];
    requiresConfirmation?: boolean;
  };
  industryTrends?: {
    status?: string;
    signals?: Array<{ title?: string; sourceUrl?: string }>;
  };
}

const themes = [
  { key: 'buyer_problem', label: '客户痛点与解法' },
  { key: 'use_case', label: '应用场景与选择建议' },
  { key: 'product_evidence', label: '产品事实与可核验信息' },
];

export function enterpriseAssetStableId(productIndex: number, assetIndex: number, url: string): string {
  return `enterprise-product-${productIndex}-${assetIndex}-${Buffer.from(url).toString('base64url').slice(0, 12)}`;
}

function requestedCount(cadence: string): number {
  const match = String(cadence || '').match(/(?:每周|week)[^\d]{0,8}(\d{1,2})\s*(?:条|posts?)/i);
  return Math.max(1, Math.min(30, Number(match?.[1] || 3)));
}

export function contentPlanCoverage(config: DigitalEmployeeConfig, goal: WeeklyGoalInput, planned: number) {
  const cadence = String(config.socialCadence || '').match(/(?:每周|week)[^\d]{0,8}(\d{1,2})\s*(?:条|posts?)/i);
  const target = cadence ? Number(cadence[1]) : goal.metric === 'approved_content_packages' ? goal.target : planned;
  const missing = Math.max(0, target - planned);
  return { target, planned, missing, message: missing ? `本周独立内容计划覆盖 ${planned}/${target}，还缺 ${missing} 条；请补齐差异化制作计划或调整目标，平台分发次数不计为独立成片。` : `本周独立内容计划覆盖 ${planned}/${target}` };
}

function ctaFor(goal: DigitalEmployeeConfig['primaryGoal']): string {
  if (goal === 'awareness') return '提出一个与买家判断有关的讨论问题，邀请评论';
  if (goal === 'sales') return '联系业务人员确认真实产品与交付条件';
  if (goal === 'reactivation') return '回复消息说明当前需求是否有变化';
  return '私信说说当前选型需求，不承诺提供额外资料或方案';
}

function priorReviewConstraints(evidence?: PriorReviewRoutingEvidence): string[] {
  if (!evidence) return [];
  const constraints: string[] = [];
  const inheritance = evidence.contentInheritance;
  if (inheritance?.status === 'ready') {
    if (String(inheritance.title || '').trim()) constraints.push(`上轮优秀内容继承：复用「${String(inheritance.title).trim()}」的内容框架与钩子，但必须重新表达并更换镜头组合`);
    if (String(inheritance.hook || '').trim()) constraints.push(`上轮有效钩子候选：${String(inheritance.hook).trim()}`);
    if (Array.isArray(inheritance.framework) && inheritance.framework.length) constraints.push(`上轮有效结构候选：${inheritance.framework.slice(0, 8).join(' → ')}`);
  }
  const tags = evidence.tagAdaptation;
  if (tags?.status === 'changed' && Array.isArray(tags.newTags) && tags.newTags.length) {
    constraints.push(`热门 Tag 变化候选：${tags.newTags.slice(0, 8).map(tag => `#${String(tag).replace(/^#+/, '')}`).join(' ')}；用于验证新卖点关键词和选题，不得改写已确认产品事实`);
    if (tags.requiresConfirmation) constraints.push('采集范围变化需要人工确认；内容 Agent 只能先生成候选方案，不得静默扩大采集范围');
  }
  const signals = evidence.industryTrends?.status === 'available' && Array.isArray(evidence.industryTrends.signals)
    ? evidence.industryTrends.signals : [];
  if (signals.length) constraints.push(`行业热点候选：${signals.slice(0, 3).map(signal => String(signal.title || '').trim()).filter(Boolean).join('；')}；仅基于可追溯来源用于下一轮编导判断`);
  return constraints;
}

function physicalReferenceIdentity(
  evidence: ContentRoutingEvidence,
  referenceId: string,
): ReferenceContentIdentity {
  const persisted = evidence.referenceIdentities?.[referenceId];
  if (persisted) return persisted;
  const analysis = evidence.referenceAnalyses?.[referenceId];
  const transcript = analysis?.speechGroups.map(group => group.text).filter(Boolean).join(' ')
    || analysis?.shots.map(shot => shot.dialogue).filter(Boolean).join(' ')
    || '';
  const duration = analysis?.shots.reduce((maximum, shot) => Math.max(maximum, shot.end || 0), 0) || undefined;
  // Compatibility callers may not yet carry the persisted media identity. In
  // that case keep same-id protection and conservatively use exact transcript
  // plus duration when available; never assume two otherwise empty records are
  // the same physical file.
  return referenceContentIdentity({
    id: referenceId,
    duration,
    aiAnalysis: transcript ? { gemini: { audioTranscript: { rawText: transcript } } } : undefined,
  });
}

function uniquePhysicalReferenceIds(evidence: ContentRoutingEvidence, referenceIds: string[]): string[] {
  const accepted: Array<{ id: string; identity: ReferenceContentIdentity }> = [];
  for (const id of referenceIds) {
    const identity = physicalReferenceIdentity(evidence, id);
    if (accepted.some(item => sameReferenceContent(item.identity, identity))) continue;
    accepted.push({ id, identity });
  }
  return accepted.map(item => item.id);
}

export function buildContentBatchPlan(input: {
  goalId: string;
  goal: WeeklyGoalInput;
  config: DigitalEmployeeConfig;
  evidence: ContentRoutingEvidence;
  versions: { configVersion: number; policyVersion: string; factsVersion: string };
  priorRoutingEvidence?: PriorReviewRoutingEvidence;
}): ContentBatchPlanDraft {
  const disabledRoutes: ContentBatchPlanDraft['disabledRoutes'] = [];
  const eligibleRoutes: ContentRoute[] = [];
  const enabled = new Set(input.config.enabledWorkflows);
  const readyExactAnalysisIds = uniquePhysicalReferenceIds(input.evidence,
    [...new Set(input.evidence.exactAnalysisIds.filter(id => !input.evidence.referenceAdmissions
      || input.evidence.referenceAdmissions[id]?.ready === true))]);
  const productsWithMaterial = input.evidence.products.filter(product => product.materialIds.length > 0);
  const reviewConstraints = priorReviewConstraints(input.priorRoutingEvidence);
  if (input.goal.videoPlans?.length) {
    const orders: ContentOrder[] = [];
    const firstIndependentUses: Array<{ index: number; referenceId: string; identity: ReferenceContentIdentity }> = [];
    const duplicateIndependentUse = new Map<number, { index: number; referenceId: string }>();
    input.goal.videoPlans.forEach((plan, index) => {
      if (plan.productionRole === 'platform_adaptation' || plan.route !== 'clone' || !plan.referenceId) return;
      const identity = physicalReferenceIdentity(input.evidence, plan.referenceId);
      const first = firstIndependentUses.find(item => sameReferenceContent(item.identity, identity));
      if (first) duplicateIndependentUse.set(index, first);
      else firstIndependentUses.push({ index, referenceId: plan.referenceId, identity });
    });
    input.goal.videoPlans.forEach((plan, index) => {
      if (plan.productionRole === 'platform_adaptation') return;
      const prefix = `第 ${index + 1} 条：`;
      const deferredMaterialErrors = /(?:请选择本条素材|数字人混剪需选择产品画面素材)/;
      const blockers = videoPlanErrors(plan).filter(error => !deferredMaterialErrors.test(error)).map(error => prefix + error);
      if (plan.route !== 'clone') {
        blockers.push(`${prefix}固定路径编译失败：固定恒产 V2 只把爆款参考 clone 作为独立视频计划；product/material 是参考时间线内的本地素材镜头类型，不能作为新的独立生产路线`);
      }
      const workflowByRoute = { clone: 'viral_clone', product: 'product_content', material: 'material_content' } as const;
      if (!enabled.has(workflowByRoute[plan.route])) blockers.push(prefix + '指定内容路径未在 Agent 配置中开启');
      const explicitProductId = String(plan.productId || '').trim();
      const legacyProductMatches = explicitProductId ? [] : input.evidence.products.filter(product => product.name === plan.productName || product.id === plan.productName);
      const product = explicitProductId
        ? input.evidence.products.find(candidate => candidate.id === explicitProductId)
        : legacyProductMatches.length === 1 ? legacyProductMatches[0] : undefined;
      if (!product) blockers.push(prefix + '指定产品不在当前冻结产品资料中');
      const ids = product ? (plan.materialIds.length ? plan.materialIds : product.materialIds) : [];
      if (product && ids.some(id => !product.materialIds.includes(id))) blockers.push(prefix + '所选素材不存在或不属于指定产品');
      // A missing product visual is a per-master production readiness issue.
      // Keep the order so other masters in the same week can still run; the
      // storyboard preflight below reports the exact missing shot requirement.
      if (plan.route === 'clone' && !input.evidence.exactAnalysisIds.includes(plan.referenceId)) blockers.push(prefix + '参考视频尚无有效精确分析');
      const duplicateReference = duplicateIndependentUse.get(index);
      if (plan.route === 'clone' && plan.referenceId && duplicateReference) {
        blockers.push(`${prefix}同一周计划内每条物理爆款视频最多只能用于 1 条独立视频；${plan.referenceId} 与第 ${duplicateReference.index + 1} 条使用的 ${duplicateReference.referenceId} 是同一视频`);
      }
      if (plan.route === 'clone') {
        const admission = input.evidence.referenceAdmissions
          ? input.evidence.referenceAdmissions[plan.referenceId] || productionReferenceAdmission(null)
          : plan.benchmarkAnalysis ? productionReferenceAdmission(plan.benchmarkAnalysis) : undefined;
        if (admission && !admission.ready) blockers.push(...admission.blockers.map(reason => `${prefix}制作前编导交接待复核：${reason}`));
      }
      const fixedYieldAnalysis = input.evidence.referenceAnalyses?.[plan.referenceId] || plan.benchmarkAnalysis;
      const fixedYieldTimeline = plan.route === 'clone'
        ? compileFixedYieldTimeline({
          analysis: fixedYieldAnalysis,
          productRef: product?.id || explicitProductId || null,
        })
        : undefined;
      if (plan.route === 'clone' && !fixedYieldAnalysis) {
        blockers.push(`${prefix}固定路径编译失败：参考视频完整精确分析事实尚未载入；分析补齐后请重新编译本计划`);
      }
      if (fixedYieldTimeline && !fixedYieldTimeline.ready) {
        blockers.push(...fixedYieldTimeline.blockers.map(reason => `${prefix}固定路径编译失败：${reason}`));
      }
      const account = input.config.publishingTargets.find(target => target.platform === plan.platform && (!plan.matrix || target.accountId === plan.matrix.accountId));
      if (!input.goal.contentPlatforms.includes(plan.platform)) blockers.push(prefix + '制作平台不在本周目标范围中');
      const familyVariants = input.goal.videoPlans!.filter(candidate => (candidate.contentFamilyId || candidate.contentId) === (plan.contentFamilyId || plan.contentId));
      const deliveryVariants: NonNullable<ContentOrder['deliveryVariants']> = familyVariants.map((variant, variantIndex) => {
        const target = input.config.publishingTargets.find(item => item.platform === variant.platform && (!variant.matrix || item.accountId === variant.matrix.accountId));
        return {
          contentId: variant.contentId || `${plan.contentId || `content-${index + 1}`}-delivery-${variantIndex + 1}`,
          platform: variant.platform,
          accountId: target?.accountId || variant.matrix?.accountId || '',
          accountLabel: target?.accountLabel || (enabled.has('content_publish') ? '发布前待绑定账号' : '仅内容生产，不分发'),
          plannedPublishDate: variant.plannedPublishDate || '',
          plannedPublishAt: variant.plannedPublishAt || '',
          adaptationMode: variant.productionRole === 'platform_adaptation' ? 'platform_light' : 'master',
          ...(variant.publication ? { publication: variant.publication } : {}),
        };
      });
      const frozenScript = plan.preproduction?.directorScript;
      const benchmarkStructureConstraints = plan.benchmarkAnalysis?.structure.map((step, structureIndex) => {
        const shots = step.shotIds.map(id => plan.benchmarkAnalysis?.shots.find(shot => shot.shotId === id)).filter(Boolean);
        const first = shots[0];
        return `参考结构 ${structureIndex + 1}：${MATERIAL_TYPE_LABELS[step.materialType]} / ${SHOT_ROLE_LABELS[step.narrativeRole]} / ${step.shotIds.length} 镜${first?.purpose ? `；作用：${first.purpose}` : ''}`;
      }) || [];
      const productId = product?.id || explicitProductId;
      const productName = product?.name || plan.productName;
      const frozenVideoPlan = normalizeVideoPlan({ ...plan, productId, productName });
      orders.push({ id: `content_order_${index + 1}`, goalId: input.goalId, productId, productName,
        languages: plan.matrix ? [plan.language] : input.config.videoLanguages,
        theme: { key: 'user_selected', label: plan.theme }, platform: plan.platform, accountId: account?.accountId || '', accountLabel: account?.accountLabel || (enabled.has('content_publish') ? '发布前待绑定账号' : '仅内容生产，不分发'),
        route: plan.route, videoPlan: frozenVideoPlan, deliveryVariants, configurationSnapshot: input.versions, cta: plan.matrix?.cta || ctaFor(input.config.primaryGoal),
        constraints: [...new Set([...input.config.constraints, ...input.goal.constraints, ...reviewConstraints,
          ...familyVariants.flatMap(variant => platformExecutionConstraints(variant.platform).map(rule => `${variant.platform} 平台改编：${rule}`)),
          `本订单只生产 1 条独立制作视频；${deliveryVariants.length} 个平台发布版本共用独立视频，不得重复提交完整 AIGC 生成`,
          ...(plan.buyerProblem ? [`必须回答的买家问题：${plan.buyerProblem}`] : []),
          ...(plan.evidenceRequirement ? [`必须呈现并核验的证据：${plan.evidenceRequirement}`] : []),
          ...(plan.matrix?.objective ? [`账号本周目标：${plan.matrix.objective}`] : []),
          ...(plan.matrix?.accountRole ? [`账号定位：${plan.matrix.accountRole === 'brand_capability' ? '品牌与供应能力' : plan.matrix.accountRole === 'buyer_advisor' ? '买家顾问与采购教育' : '品牌综合账号'}`] : []),
          ...(plan.matrix?.formats?.length ? [`平台内容形式：${plan.matrix.formats.join('、')}`] : []),
          ...(benchmarkStructureConstraints.length ? ['素材调用必须严格按以下规范化结构顺序逐段匹配，不得合并或改写素材类别', ...benchmarkStructureConstraints] : []),
          ...(plan.reviewRequirements || []).map(r => `复盘分镜约束【${r.todoId}】：第1镜0–3秒；参考：${r.reference}；保留：${r.requirements}；素材：${r.materials}；验收：${r.acceptance}`)])],
        evidenceRefs: [...ids.map(id => ({ type: 'enterprise_material' as const, id })), ...(plan.route === 'clone' && plan.referenceId ? [{ type: 'exact_analysis' as const, id: plan.referenceId }] : [])],
        readinessBlockers: [...new Set(blockers)], ...(fixedYieldTimeline ? {
          fixedYieldTimeline, productionContractVersion: 'fixed-yield.v2-preflight' as const,
        } : { productionContractVersion: 'legacy.v1' as const }), status: 'planned',
        ...(frozenScript ? {
          contractVersion: 1 as const,
          scripts: { [frozenScript.language]: frozenScript },
        } : {}),
      });
    });
    // A user-selected clone must retain its reference requirement; never
    // silently replace it with another enabled content route.
    // Missing clone evidence blocks that master, not unrelated product orders.
    // Keep its frozen reference and surface the disabled route; the production
    // preflight still refuses to generate it until the analysis is available.
    const routeBlockers = orders.flatMap(order => (order.readinessBlockers || []).map(reason => ({ route: order.route, reason })));
    return {
      coverage: contentPlanCoverage(input.config, input.goal, orders.length),
      status: orders.length ? 'planned' : 'blocked',
      orders,
      blocker: orders.length ? '' : '周视频计划中没有可执行的独立制作视频',
      eligibleRoutes: [...new Set(orders.filter(order => !order.readinessBlockers?.length).map(order => order.route))],
      disabledRoutes: [...disabledRoutes, ...routeBlockers],
    };
  }
  const missingProducts = input.evidence.products.filter(product => !product.materialIds.length);
  if (missingProducts.length) return { status: 'blocked', orders: [], blocker: `重点产品缺少素材：${missingProducts.map(product => product.name).join('、')}。请补充素材或逐条确认制作计划，不能自动替换产品。`, eligibleRoutes, disabledRoutes };

  // Fixed-yield V2 starts from one admitted reference timeline. Product and
  // factory footage are shot-level local-material inputs inside that timeline,
  // never alternative paid top-level routes for a newly allocated plan.
  if (!enabled.has('viral_clone')) {
    disabledRoutes.push({ route: 'clone', reason: '固定恒产计划需要启用爆款参考 clone 工作流' });
  } else if (!readyExactAnalysisIds.length) {
    disabledRoutes.push({ route: 'clone', reason: '固定恒产计划需要至少 1 条已完成全片精确分析且通过复核的参考视频；分析补齐后请重新生成计划' });
  } else if (!productsWithMaterial.length) {
    disabledRoutes.push({ route: 'clone', reason: '固定恒产计划缺少已绑定本地素材的真实产品' });
  } else {
    eligibleRoutes.push('clone');
  }

  const connectedTargets = input.config.publishingTargets.filter(target => input.goal.contentPlatforms.includes(target.platform));
  const targets = input.goal.contentPlatforms.map(platform => connectedTargets.find(target => target.platform === platform) || { platform, accountId: '', accountLabel: enabled.has('content_publish') ? '发布前待绑定账号' : '仅内容生产，不分发' });
  if (!eligibleRoutes.length) return { status: 'blocked', orders: [], blocker: disabledRoutes.map(item => `${item.route}：${item.reason}`).join('；') || '没有可执行的内容路径', eligibleRoutes, disabledRoutes };

  // Under-coverage is an existing first-class plan state. Prefer a smaller,
  // explicit batch over silently cycling the same physical reference.
  const count = Math.min(requestedCount(input.config.socialCadence), readyExactAnalysisIds.length);
  const feedbackConstraints = (input.priorRoutingEvidence?.approvalFeedback || []).map(item => String(item.note || '').trim()).filter(Boolean).slice(0, 10).map(note => `审批反馈：${note}`);
  const orders: ContentOrder[] = Array.from({ length: count }, (_, index) => {
    const route = 'clone' as const;
    const product = productsWithMaterial[index % productsWithMaterial.length];
    const target = targets[index % targets.length];
    const theme = themes[index % themes.length];
    const productMaterial = { type: 'enterprise_material' as const, id: product.materialIds[index % product.materialIds.length] };
    const referenceId = readyExactAnalysisIds[index % readyExactAnalysisIds.length]!;
    const evidenceRefs: ContentOrder['evidenceRefs'] = [{ type: 'exact_analysis', id: referenceId }, productMaterial];
    const fixedYieldAnalysis = input.evidence.referenceAnalyses?.[referenceId];
    const fixedYieldTimeline = compileFixedYieldTimeline({ analysis: fixedYieldAnalysis, productRef: product.id });
    const readinessBlockers = [
      ...(!fixedYieldAnalysis
        ? [`固定路径编译失败：参考视频 ${referenceId} 的完整精确分析事实尚未载入；分析补齐后请重新编译本计划`]
        : []),
      ...fixedYieldTimeline.blockers.map(reason => `固定路径编译失败：${reason}`),
    ];
    return {
      id: `content_order_${index + 1}`,
      languages: input.config.videoLanguages,
      goalId: input.goalId,
      productId: product.id,
      productName: product.name,
      theme,
      platform: target.platform,
      accountId: target.accountId,
      accountLabel: target.accountLabel,
      route,
      configurationSnapshot: input.versions,
      cta: ctaFor(input.config.primaryGoal),
      constraints: [...new Set([
        ...input.config.constraints,
        ...input.goal.constraints,
        ...input.goal.contentPlatforms.flatMap(platform => platformExecutionConstraints(platform).map(rule => `${platform} 平台改编：${rule}`)),
        ...feedbackConstraints,
        ...reviewConstraints,
      ])],
      evidenceRefs,
      readinessBlockers: [...new Set(readinessBlockers)],
      fixedYieldTimeline,
      productionContractVersion: 'fixed-yield.v2-preflight',
      status: 'planned',
    };
  });
  const routeBlockers = orders.flatMap(order => (order.readinessBlockers || []).map(reason => ({ route: order.route, reason })));
  return {
    coverage: contentPlanCoverage(input.config, input.goal, orders.length),
    status: 'planned',
    orders,
    blocker: '',
    eligibleRoutes: orders.some(order => !order.readinessBlockers?.length) ? ['clone'] : [],
    disabledRoutes: [...disabledRoutes, ...routeBlockers],
  };
}
