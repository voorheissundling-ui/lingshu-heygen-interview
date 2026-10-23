/**
 * Strategy-layer contract for social-video scripts.
 *
 * This module is deliberately side-effect free and is not wired into the
 * current /studio/script prompt yet. It gives the product and prompt layers a
 * stable, testable contract before policy decisions are enabled in production.
 */

export type ScriptGenerationLayer = 'primary_script' | 'rewrite' | 'derivative_voiceover';
export type ScriptGenerationMode = 'product_info' | 'asset_library' | 'viral_remix' | 'inspiration_board';
export type ContentTheme =
  | 'buyer_pain' | 'product_proof' | 'use_case' | 'supplier_capability'
  | 'customization' | 'comparison' | 'customer_case' | 'trend' | 'talking_head';
export type CooperationRoute = 'oem_odm' | 'wholesale_distribution' | 'consumer_retail';
export type AssetPlanStatus = 'available' | 'suggested_shoot' | 'evidence_required' | 'forbidden_claim';
export type BriefReadiness = 'ready' | 'needs_information' | 'blocked';
export type VisualCapability =
  | 'product_identity' | 'product_detail' | 'demo_action' | 'scene_context' | 'problem_contrast'
  | 'production_process' | 'quality_check' | 'fulfillment_process'
  | 'packaging_customization' | 'sample_prototype' | 'specification_comparison'
  | 'comparison_pair' | 'customer_context' | 'case_process' | 'case_result_visual'
  | 'trend_source_visual' | 'presenter_identity';
export type SuggestedShootStatus = 'queued' | 'in_progress' | 'completed' | 'cancelled';
export type SuggestedShootOrigin = 'script_gap';
export type EvidenceDocumentKind = 'certificate' | 'test_report' | 'price_rule' | 'moq_rule' | 'lead_time_rule' | 'case_authorization' | 'case_material' | 'other';

export interface ScriptFact {
  label: string;
  value: string;
  source?: 'enterprise' | 'product' | 'material' | 'user_confirmed';
}

export interface ScriptEvidence {
  label: string;
  type: 'product_detail' | 'material' | 'factory' | 'document' | 'case' | 'trend_source' | 'other';
  source?: string;
  visualCapabilities?: VisualCapability[];
}

export interface ScriptAssetPlan {
  sceneId: string;
  status: AssetPlanStatus;
  description: string;
  visualCapabilities?: VisualCapability[];
}

/** A cross-page task created from a missing visual in the Studio. */
export interface SuggestedShootTask {
  id: string;
  status: SuggestedShootStatus;
  origin: SuggestedShootOrigin;
  tenantId: string;
  productIds: string[];
  contentTheme: ContentTheme;
  targetCapabilities: VisualCapability[];
  suggestedDurationSec: number;
  shotBrief: string;
  sourceProjectId?: string;
  sourcePortfolioId?: string;
  sourceMaterialAssemblyId?: string;
  sourceStoryboardSlotId?: string;
  uploadedMaterialIds?: string[];
  /** Created by one-click refill; source assemblies are always immutable. */
  refillMaterialAssemblyId?: string;
  createdAt: string;
}

/** One canonical enterprise file, surfaced in product and/or business views. */
export interface EvidenceDocumentLink {
  documentId: string;
  kinds: EvidenceDocumentKind[];
  linkedProductIds: string[];
  visibleInProductCards: boolean;
  visibleInBusinessMaterials: boolean;
}

export interface ScriptStrategyBrief {
  generationLayer: ScriptGenerationLayer;
  generationMode: ScriptGenerationMode;
  contentTheme: ContentTheme;
  /** In production this is inherited from the enterprise-center initial setup. */
  cooperationRoute: CooperationRoute;
  targetBuyerRoles: string[];
  targetMarkets: string[];
  languagePlan: string[];
  platform: string;
  targetDurationSec: number;
  buyerQuestions: string[];
  approvedFacts: ScriptFact[];
  availableEvidence: ScriptEvidence[];
  missingHighRiskFacts: string[];
  assetPlan: ScriptAssetPlan[];
  primaryCta: string;
  verifiedCtaChannels: string[];
  forbiddenClaims: string[];
}

/** Saved in enterprise center; multiple routes may be enabled for one enterprise. */
export interface EnterpriseCooperationProfile {
  enabledRoutes: CooperationRoute[];
  /** Per-route settings configured through enterprise-center choice questions. */
  routeStrategies?: Partial<Record<CooperationRoute, EnterpriseRouteStrategy>>;
}

/** Independent enterprise-center record, automatically composed from other enterprise data. */
export interface EnterpriseSocialStrategy {
  cooperationProfile: EnterpriseCooperationProfile;
  inferredFrom: Array<'company_market' | 'products' | 'business_rules' | 'materials'>;
  generatedAt: string;
  manuallyEditedFields: string[];
}

export interface EnterpriseRouteStrategy {
  /** Multi-select buyer roles; their order is the enterprise's priority order. */
  targetBuyerRoles: string[];
  /** One selected primary CTA keeps every generated video focused. */
  primaryCta: string;
  /** Multi-select; only verified, configured channels may be used in a CTA. */
  verifiedCtaChannels: string[];
}

/** Defaults used only when the enterprise social-strategy record is first synthesized. */
export const DEFAULT_ROUTE_BUYER_ROLES: Record<CooperationRoute, string[]> = {
  oem_odm: ['品牌创始人', '产品经理', '采购'],
  wholesale_distribution: ['进口商', '经销商', '渠道采购'],
  consumer_retail: ['终端消费者'],
};

/** Applied only when Messenger has been configured and verified for the enterprise. */
export const DEFAULT_ROUTE_PRIMARY_CTA: Record<CooperationRoute, string> = {
  oem_odm: '引导通过 Messenger 联系',
  wholesale_distribution: '引导通过 Messenger 联系',
  consumer_retail: '引导通过 Messenger 联系',
};

export type CooperationRouteResolution =
  | { requiresSelection: true; availableRoutes: CooperationRoute[] }
  | { requiresSelection: false; route: CooperationRoute };

export interface StrategyReadiness {
  status: BriefReadiness;
  blockers: string[];
  warnings: string[];
}

export const HIGH_RISK_FACTS = ['price', 'moq', 'lead_time', 'certification', 'efficacy', 'capacity', 'customer_case'] as const;

export interface ThemeVisualRequirement {
  allOf?: VisualCapability[];
  anyOf?: VisualCapability[];
}

/**
 * Prompt fragment applied after shared B2B/fact/mode constraints.
 * CTA is deliberately excluded: it comes only from the draft's primaryCta.
 */
export interface ThemePromptConstraint {
  hookDirective: string;
  evidenceDirective: string;
  prohibitedPatterns: string[];
}

/** A deterministic editorial plan produced before an LLM writes any prose. */
export interface ScriptContentBeat {
  function: 'hook' | 'buyer_problem' | 'evidence' | 'decision_guidance' | 'cta';
  instruction: string;
  allowedFactLabels: string[];
}

export interface ScriptContentPlan {
  targetBuyer: string;
  buyerQuestion: string;
  hookFormula: string;
  proofOrder: string[];
  beats: ScriptContentBeat[];
  modeEvidenceRule: string;
}

export const THEME_PROMPT_CONSTRAINTS: Record<ContentTheme, ThemePromptConstraint> = {
  buyer_pain: { hookDirective: 'Open with one concrete buyer decision problem, never generic anxiety.', evidenceDirective: 'Answer the stated problem with visible or approved product evidence.', prohibitedPatterns: ['fear marketing', 'invented buyer loss'] },
  product_proof: { hookDirective: 'Open with how to verify one product detail beyond a catalog image.', evidenceDirective: 'Show the product and a real detail or demonstration before explaining its buying value.', prohibitedPatterns: ['unsupported efficacy', 'premium quality'] },
  use_case: { hookDirective: 'Open with one buyer-relevant use or channel scenario.', evidenceDirective: 'Use a complete visible action or scene; do not turn it into an unverified result claim.', prohibitedPatterns: ['sales-volume claim', 'efficacy claim'] },
  supplier_capability: { hookDirective: 'Open with how a buyer can see one production, quality, or fulfillment action.', evidenceDirective: 'Describe only what the selected visual or approved enterprise fact supports.', prohibitedPatterns: ['unverified scale', 'guaranteed delivery'] },
  customization: { hookDirective: 'Open with one confirmed product or packaging touchpoint that a brand may adapt.', evidenceDirective: 'Anchor customization in a visible sample, packaging, or approved option.', prohibitedPatterns: ['anything can be customized', 'unsupported sampling lead time'] },
  comparison: { hookDirective: 'Open with a selection question between real options.', evidenceDirective: 'Compare only approved, shared dimensions.', prohibitedPatterns: ['competitor attack', 'invented superiority'] },
  customer_case: { hookDirective: 'Open with an authorized customer problem or collaboration path.', evidenceDirective: 'Use only authorized case material and approved facts.', prohibitedPatterns: ['chat screenshot as case', 'invented customer'] },
  trend: { hookDirective: 'Open with one dated, attributable market or platform signal.', evidenceDirective: 'Separate the source signal from the current enterprise product response.', prohibitedPatterns: ['everyone is buying', 'single post presented as trend'] },
  talking_head: { hookDirective: 'Open with a presenter answering one concrete buyer question.', evidenceDirective: 'Keep speech, visible actions, and identity within the selected presenter material.', prohibitedPatterns: ['invented founder identity', 'invented expert identity'] },
};

/**
 * Preferred visual coverage for a theme. These describe the functions a
 * viewer can see, not the number of uploaded files and not permission to make
 * claims. A gap here must adapt the script; it must never invalidate related
 * product material or block generation.
 */
export const THEME_MINIMUM_VISUALS: Record<ContentTheme, ThemeVisualRequirement> = {
  buyer_pain: { anyOf: ['product_identity', 'problem_contrast', 'product_detail'] },
  product_proof: { allOf: ['product_identity'], anyOf: ['product_detail', 'demo_action'] },
  use_case: { allOf: ['product_identity'], anyOf: ['demo_action', 'scene_context'] },
  supplier_capability: { anyOf: ['production_process', 'quality_check', 'fulfillment_process'] },
  customization: { allOf: ['product_identity'], anyOf: ['packaging_customization', 'sample_prototype', 'specification_comparison'] },
  comparison: { allOf: ['comparison_pair'] },
  customer_case: { anyOf: ['customer_context', 'case_process', 'case_result_visual'] },
  trend: { allOf: ['trend_source_visual', 'product_identity'] },
  talking_head: { allOf: ['presenter_identity'] },
};

export function hasThemeMinimumVisuals(brief: Pick<ScriptStrategyBrief, 'contentTheme' | 'availableEvidence' | 'assetPlan'>): boolean {
  const capabilities = new Set<VisualCapability>([
    ...brief.availableEvidence.flatMap(item => item.visualCapabilities ?? []),
    ...brief.assetPlan
      .filter(item => item.status === 'available' || item.status === 'suggested_shoot')
      .flatMap(item => item.visualCapabilities ?? []),
  ]);
  const requirement = THEME_MINIMUM_VISUALS[brief.contentTheme];
  return (requirement.allOf ?? []).every(item => capabilities.has(item))
    && (!(requirement.anyOf?.length) || requirement.anyOf.some(item => capabilities.has(item)));
}

/**
 * Resolves the route for one draft. A multi-route enterprise must be confirmed
 * by the user in the Studio mode-selection step before script generation.
 */
export function resolveCooperationRoute(profile: EnterpriseCooperationProfile): CooperationRouteResolution {
  const availableRoutes = Array.from(new Set(profile.enabledRoutes));
  if (availableRoutes.length === 1) return { requiresSelection: false, route: availableRoutes[0]! };
  return { requiresSelection: true, availableRoutes };
}

/** Maps one confirmed enterprise route to the fields inherited by a new draft. */
export function routeStrategyDefaults(profile: EnterpriseCooperationProfile, route: CooperationRoute): EnterpriseRouteStrategy {
  return profile.routeStrategies?.[route] ?? { targetBuyerRoles: [], primaryCta: '', verifiedCtaChannels: [] };
}

export function createScriptStrategyBrief(input: Partial<ScriptStrategyBrief> = {}): ScriptStrategyBrief {
  return {
    generationLayer: input.generationLayer ?? 'primary_script',
    generationMode: input.generationMode ?? 'product_info',
    contentTheme: input.contentTheme ?? 'buyer_pain',
    // Legacy-safe fallback only. The future request assembler supplies the
    // enterprise-center setting for every newly generated script.
    cooperationRoute: input.cooperationRoute ?? 'oem_odm',
    targetBuyerRoles: input.targetBuyerRoles ?? [],
    targetMarkets: input.targetMarkets ?? [],
    languagePlan: input.languagePlan ?? [],
    platform: input.platform ?? 'tiktok',
    targetDurationSec: input.targetDurationSec ?? 20,
    buyerQuestions: input.buyerQuestions ?? [],
    approvedFacts: input.approvedFacts ?? [],
    availableEvidence: input.availableEvidence ?? [],
    missingHighRiskFacts: input.missingHighRiskFacts ?? [],
    assetPlan: input.assetPlan ?? [],
    primaryCta: input.primaryCta ?? '',
    verifiedCtaChannels: input.verifiedCtaChannels ?? [],
    forbiddenClaims: input.forbiddenClaims ?? [],
  };
}

/** Returns product-policy readiness; it does not generate or rewrite content. */
export function assessScriptStrategyBrief(brief: ScriptStrategyBrief): StrategyReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!brief.approvedFacts.some(item => item.label.trim() && item.value.trim())) blockers.push('缺少已确认的产品事实');
  if (!brief.primaryCta.trim()) blockers.push('缺少唯一主 CTA');
  if (!brief.verifiedCtaChannels.length) blockers.push('主 CTA 没有已验证承接渠道');
  if (brief.generationMode === 'asset_library' && !brief.availableEvidence.some(item => item.type === 'material')) {
    blockers.push('素材库模式缺少可用素材证据');
  }
  if (brief.contentTheme === 'comparison' && brief.approvedFacts.length < 2) blockers.push('选型对比至少需要两个可验证对象');

  // Theme eligibility is determined by its minimum visual material, not by
  // high-risk business facts. Missing certificates/MOQ/cases/trend sources
  // constrain only the claim and publication gate, never the theme itself.
  if (!hasThemeMinimumVisuals(brief)) {
    warnings.push('缺少当前主题的理想画面功能；将使用已选相关素材调整分镜，并可建议补拍');
  }
  if (brief.generationMode === 'product_info' && brief.assetPlan.some(item => item.status === 'suggested_shoot')) {
    warnings.push('包含建议补拍镜头；不得将其表述为企业已有素材或既成事实');
  }
  if (brief.missingHighRiskFacts.length) warnings.push(`高风险待确认项：${brief.missingHighRiskFacts.join('、')}`);
  if (!brief.targetBuyerRoles.length) warnings.push('未指定目标买家角色，将使用保守的 B2B 表达');
  if (!brief.targetMarkets.length) warnings.push('未指定目标市场，不能应用市场本地化策略');
  return { status: blockers.length ? 'blocked' : warnings.length ? 'needs_information' : 'ready', blockers, warnings };
}

/**
 * Produces the non-negotiable story logic before the prose-writing model runs.
 * It intentionally does not invent industry facts: the model may only turn the
 * chosen facts and evidence into natural words and executable shots.
 */
export function buildScriptContentPlan(brief: ScriptStrategyBrief): ScriptContentPlan {
  const targetBuyer = brief.targetBuyerRoles[0]
    || DEFAULT_ROUTE_BUYER_ROLES[brief.cooperationRoute][0]
    || '海外 B2B 买家';
  const factLabels = brief.approvedFacts.map(item => item.label).filter(Boolean);
  const evidenceLabels = brief.availableEvidence.map(item => item.label).filter(Boolean);
  const theme = brief.contentTheme;
  const questionByTheme: Record<ContentTheme, string> = {
    buyer_pain: `${targetBuyer}如何在信息不完整时作出下一步采购判断？`,
    product_proof: `${targetBuyer}如何确认目录图以外的一个真实产品细节？`,
    use_case: `${targetBuyer}如何判断产品是否适合一个明确的渠道或使用场景？`,
    supplier_capability: `${targetBuyer}如何核实一个生产、质检或履约节点？`,
    customization: `${targetBuyer}如何先确认一个产品或包装适配点，再推进定制讨论？`,
    comparison: `${targetBuyer}如何在真实可比较的方案之间作选择？`,
    customer_case: `${targetBuyer}如何参考一个已授权的合作过程？`,
    trend: `${targetBuyer}如何判断一个有来源的市场信号是否值得响应？`,
    talking_head: `${targetBuyer}最需要谁回答哪一个具体采购问题？`,
  };
  const buyerQuestion = brief.buyerQuestions[0] || questionByTheme[theme];
  const hookFormulaByTheme: Record<ContentTheme, string> = {
    buyer_pain: `围绕${targetBuyer}的一个具体决策阻力开场；可以用动作、细节或观点体现，不必点名职业。`,
    product_proof: '从资料支持的具体细节、操作或选型判断切入，再说明它对购买决定的意义。',
    use_case: '先给具体渠道或使用场景中的一个动作，再说明适配判断。',
    supplier_capability: '先提出一个供应风险，再让一个真实生产、质检或履约节点回应它。',
    customization: '先展示一个已确认的包装、样品或规格触点，再提出品牌适配问题。',
    comparison: '先把两个真实选择放在同一比较维度中，不先下结论。',
    customer_case: '先交代授权范围内的客户问题或合作路径，不夸大结果。',
    trend: '先说清一个有来源、可归因的信号，再讨论其采购含义。',
    talking_head: '由已识别身份的人用一句明确观点或答疑开场，不能念企业介绍。',
  };
  const modeEvidenceRule: Record<ScriptGenerationMode, string> = {
    product_info: '产品资料决定事实边界。没有对应画面时可规划“建议补拍”，但不能说企业已经拍到或已经证明该画面。',
    asset_library: '所选素材决定画面边界。不得把素材中不可见的人物、动作、工厂、结果写成已发生；缺口只能写成建议补拍。',
    viral_remix: '对标逐镜分析只决定可迁移的钩子机制、节奏、镜头功能和证明顺序；企业资料决定全部事实与 CTA。',
    inspiration_board: '灵感只决定可借鉴的创意机制，不能作为企业事实或画面证据。',
  };
  const proofOrder = [
    '先兑现钩子提出的买家问题',
    evidenceLabels.length ? `再展示已选证据：${evidenceLabels.slice(0, 2).join('、')}` : '再使用已确认产品事实，不用形容词替代证据',
    '最后解释这项证据对当前买家决策有什么意义',
  ];
  return {
    targetBuyer,
    buyerQuestion,
    hookFormula: hookFormulaByTheme[theme],
    proofOrder,
    modeEvidenceRule: modeEvidenceRule[brief.generationMode],
    beats: [
      { function: 'hook', instruction: hookFormulaByTheme[theme], allowedFactLabels: [] },
      { function: 'buyer_problem', instruction: `把问题说具体：${buyerQuestion}`, allowedFactLabels: [] },
      { function: 'evidence', instruction: proofOrder[1]!, allowedFactLabels: [...factLabels, ...evidenceLabels] },
      { function: 'decision_guidance', instruction: '只解释证据对该买家当前决策的意义；不新增商业承诺。', allowedFactLabels: factLabels },
      { function: 'cta', instruction: `只使用唯一主 CTA：${brief.primaryCta || '发起下一步咨询'}`, allowedFactLabels: [brief.primaryCta].filter(Boolean) },
    ],
  };
}

/** Prompt-ready contract. This is deliberately compact so theme logic stays testable in code. */
export function renderScriptContentPlan(plan: ScriptContentPlan): string {
  return [
    '策略结构（内部执行；必须按此结构写成稿，不得复述）：',
    `- 目标买家：${plan.targetBuyer}`,
    `- 本条只回答的问题：${plan.buyerQuestion}`,
    `- 前3秒钩子：${plan.hookFormula}`,
    `- 证明顺序：${plan.proofOrder.join(' → ')}`,
    `- 模式证据边界：${plan.modeEvidenceRule}`,
    '- 叙事要素（可合并到实际分镜，不要求逐项各占一段）：' + plan.beats.map(item => `${item.function}（${item.instruction}）`).join(' → '),
  ].join('\n');
}
