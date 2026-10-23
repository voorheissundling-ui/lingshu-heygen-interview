import { normalizeManagedPublishingGrant, type ManagedPublishingGrant } from '../../shared/contracts/managedPublishingGrant.js';
import { normalizeContinuationPolicy, type ContinuationPolicy } from '../../shared/contracts/continuationPolicy.js';
import { normalizeAssessment, type OperatingAssessment } from '../../shared/contracts/operatingMaturity.js';
import { VIDEO_LANGUAGES, normalizeVideoLanguage } from '../../shared/contracts/videoLanguages.js';
import { normalizeVideoPlan, videoSchedulingErrors, type VideoCreationPlan } from '../../shared/contracts/videoCreationPlan.js';
import {
  connectedAccountIssues,
  SOCIAL_DISCOVERY_BASELINE,
  socialOperatingProfile,
  type SocialOperatingProfileId,
} from '../../shared/contracts/socialOperatingProfile.js';
import { automaticExecutionAllowed, resolveRuntimePolicy } from './runtimePolicy.js';
import type { Starter198ConfirmedOperatingPlan } from '../../shared/contracts/starter198.js';
import { hydrateWeeklyPublishingTargets } from '../../shared/contracts/weeklyPublishingTargets.js';
import {
  normalizeProductionOnboardingPreferences,
  type ProductionOnboardingPreferences,
} from '../../shared/contracts/productionOnboarding.js';

export type AutonomyMode = 'suggest' | 'collaborate' | 'managed' | 'automatic';
/** The five user-facing roles. Legacy persisted `industry` values are mapped at the read boundary. */
export type DigitalEmployeeAgentRole = 'orchestrator' | 'business' | 'director' | 'content' | 'customer';
export type PublishingPlatform = 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin';
export interface PublishingTarget {
  platform: PublishingPlatform;
  accountId: string;
  accountLabel: string;
  timezone?: string;
  /** Frozen account-level share of the user-confirmed weekly platform quota. */
  weeklyCount?: number;
}
export type WeeklyGoalStatus = 'draft' | 'pending_approval' | 'active' | 'paused' | 'completed' | 'cancelled';
export type WorkflowTaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_external'
  | 'waiting_approval'
  | 'waiting_human'
  | 'handed_off'
  | 'skipped'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface DigitalEmployeeConfig {
  productionOnboarding?: ProductionOnboardingPreferences;
  managedPublishingGrant?: ManagedPublishingGrant;
  continuationPolicy?: ContinuationPolicy;
  operatingMaturity?: "starting" | "growing" | "established";
  operatingAssessment?: OperatingAssessment;
  /** Phased social-matrix plan. Growth never bypasses its activation gates. */
  socialOperatingProfile?: SocialOperatingProfileId;
  defaultParticipation?: "agent" | "team";
  videoDefaults?: Partial<VideoCreationPlan>;
  /** Languages generated autonomously for every content order. */
  videoLanguages: string[];
  /** Future-cycle switch; active runs keep their frozen configuration. */
  smartOperationsEnabled: boolean;
  companyName: string;
  industry: string;
  primaryBusiness: string;
  targetMarkets: string;
  customerProfile: string;
  autonomyMode: AutonomyMode;
  approvalOwner: string;
  constraints: string[];
  team: string[];
  primaryGoal: 'awareness' | 'leads' | 'sales' | 'reactivation';
  focusProducts: string;
  enabledWorkflows: Array<'scheduled_social' | 'viral_clone' | 'product_content' | 'material_content' | 'content_publish' | 'customer_segmentation' | 'batch_followup'>;
  socialCadence: string;
  followupCadence: string;
  reviewSchedule: string;
  publishingTargets: PublishingTarget[];
  /**
   * User-confirmed planning limits. Planned accounts are deliberately separate
   * from publishingTargets: they do not claim a connection or grant publishing.
   */
  confirmedOperatingPlan?: Starter198ConfirmedOperatingPlan;
  /** Explicit tenant consent. Approval is still required for every content version. */
  allowRealPublishing: boolean;
  /** Shared outbound-consent flag consumed by the customer Agent. */
  allowRealCustomerMessages: boolean;
  /** Explicit consent to synthesize missing visual shots. Never inferred from enabled workflows. */
  allowGeneratedVisuals: boolean;
  approvalPolicy: {
    contentPublish: boolean;
    batchFollowup: boolean;
    commercialCommitment: boolean;
  };
  agentApprovalPolicies: {
    business: { activatePlan: boolean; changeGoalScope: boolean };
    industry: { addUnverifiedSource: boolean; expandCollectionScope: boolean };
    content: { contentPublish: boolean; factualClaims: boolean };
    customer: { batchFollowup: boolean; commercialCommitment: boolean };
  };
}

export interface WeeklyGoalInput {
  videoPlans?: VideoCreationPlan[];
  businessLine: 'full_funnel' | 'content_growth' | 'customer_conversion';
  contentPlatforms: Array<'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin'>;
  title: string;
  objective: string;
  metric: string;
  baseline: number;
  target: number;
  unit: string;
  startsAt: string;
  endsAt: string;
  scope: string;
  constraints: string[];
}

export interface PlannedTask {
  key: string;
  title: string;
  description: string;
  agentRole: DigitalEmployeeAgentRole;
  backgroundCapability?: 'knowledge' | 'planner' | 'risk' | 'channel' | 'review';
  kind: 'analysis' | 'planning' | 'production' | 'approval' | 'activation' | 'review';
  sequence: number;
  priority: 'high' | 'medium';
  requiresApproval: boolean;
  dependsOn: string[];
  expectedMinutes: number;
  businessDomain: 'foundation' | 'content' | 'publishing' | 'customer' | 'review';
  capabilityKey: string;
  destination: 'enterprise' | 'scheduled' | 'socialInspiration' | 'scriptLibrary' | 'smartAssets' | 'conversion' | 'digitalEmployees';
  destinationView?: 'create' | 'publish';
  statusSource: string;
  executionMode: 'internal' | 'observe' | 'draft_executor' | 'approval';
  externalEffect: 'none' | 'draft' | 'schedule' | 'publish' | 'send';
  automaticExecutionAllowed: boolean;
  policySource: 'effective_runtime_policy';
}

export interface WeeklyPlanDraft {
  strategy: string;
  successCriteria: string[];
  estimatedCost: number;
  estimatedMinutes: number;
  qualityGates: string[];
  riskSummary: string;
  tasks: PlannedTask[];
}

const text = (value: unknown, max = 500): string => String(value ?? '').trim().slice(0, max);
const number = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function normalizeConfirmedOperatingPlan(value: unknown): Starter198ConfirmedOperatingPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Partial<Starter198ConfirmedOperatingPlan>;
  const allowedPlatforms = new Set<PublishingPlatform>(['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin']);
  const presenter = ['brand_spokesperson', 'product_expert', 'none'].includes(String(source.presenter))
    ? source.presenter as Starter198ConfirmedOperatingPlan['presenter']
    : null;
  const rawAccountCount = Array.isArray(source.plannedAccounts) ? source.plannedAccounts.length : 0;
  const plannedAccounts = Array.isArray(source.plannedAccounts)
    ? source.plannedAccounts.map(item => ({
      platform: String(item?.platform || '') as PublishingPlatform,
      accountName: text(item?.accountName, 200),
      weeklyOutput: Math.floor(number(item?.weeklyOutput, 0)),
    })).filter(item => allowedPlatforms.has(item.platform) && Boolean(item.accountName) && item.weeklyOutput > 0)
      .filter((item, index, items) => items.findIndex(candidate => candidate.platform === item.platform) === index)
    : [];
  const weeklyMasterCount = Math.floor(number(source.weeklyMasterCount, 0));
  const weeklyVariantCount = Math.floor(number(source.weeklyVariantCount, 0));
  const minCost = Math.floor(number(source.estimatedCostCny?.min, -1));
  const maxCost = Math.floor(number(source.estimatedCostCny?.max, -1));
  const deliveryDays = Math.floor(number(source.deliveryDays, 0));
  const accountOutput = plannedAccounts.reduce((sum, item) => sum + item.weeklyOutput, 0);
  if (!text(source.brandName, 120) || !presenter || plannedAccounts.length === 0 || plannedAccounts.length > 5
    || rawAccountCount !== plannedAccounts.length
    || weeklyMasterCount < 1 || weeklyVariantCount < 1 || weeklyVariantCount !== accountOutput
    || weeklyVariantCount > weeklyMasterCount * plannedAccounts.length
    || plannedAccounts.some(item => item.weeklyOutput > weeklyMasterCount)
    || minCost !== weeklyMasterCount * 10 || maxCost !== weeklyMasterCount * 15
    || deliveryDays !== 7) return undefined;
  return {
    brandName: text(source.brandName, 120),
    presenter,
    plannedAccounts,
    weeklyMasterCount,
    weeklyVariantCount,
    estimatedCostCny: { min: minCost, max: maxCost },
    deliveryDays,
  };
}

export function normalizeDigitalEmployeeConfig(input: Partial<DigitalEmployeeConfig>): DigitalEmployeeConfig {
  const autonomyMode: AutonomyMode = ['suggest', 'collaborate', 'managed', 'automatic'].includes(String(input.autonomyMode))
    ? input.autonomyMode as AutonomyMode
    : 'managed';
  const constraints = Array.isArray(input.constraints)
    ? input.constraints.map(item => text(item, 240)).filter(Boolean).slice(0, 20)
    : [];
  const primaryGoal = ['awareness', 'leads', 'sales', 'reactivation'].includes(String(input.primaryGoal))
    ? input.primaryGoal as DigitalEmployeeConfig['primaryGoal']
    : 'leads';
  const allowedWorkflows = new Set<DigitalEmployeeConfig['enabledWorkflows'][number]>([
    'scheduled_social', 'viral_clone', 'product_content', 'material_content', 'content_publish', 'customer_segmentation', 'batch_followup',
  ]);
  const enabledWorkflows = Array.isArray(input.enabledWorkflows)
    ? input.enabledWorkflows.filter((item): item is DigitalEmployeeConfig['enabledWorkflows'][number] => allowedWorkflows.has(item as DigitalEmployeeConfig['enabledWorkflows'][number]))
    : [];
  const allowedPublishingPlatforms = new Set<PublishingPlatform>(['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin']);
  const socialCadence = text(input.socialCadence, 1000) || 'LinkedIn、Facebook 为主，TikTok、Instagram、YouTube 为补充；优先采集已确认对标账号，关键词仅补充发现；近 7 天；每天 09:00；每次最多 20 条；按链接与标题去重 30 天；每周生成 5 条发布草稿，发布前人工审批';
  const publishingTargets: PublishingTarget[] = hydrateWeeklyPublishingTargets(Array.isArray(input.publishingTargets)
    ? input.publishingTargets
      .map(item => ({
        platform: String(item?.platform || '') as PublishingPlatform,
        accountId: text(item?.accountId, 160),
        accountLabel: text(item?.accountLabel, 200),
        ...(item?.timezone ? { timezone: text(item.timezone, 100) } : {}),
        ...(Number.isFinite(Number(item?.weeklyCount)) ? { weeklyCount: Math.min(30, Math.max(0, Math.floor(Number(item.weeklyCount)))) } : {}),
      }))
      .filter((item): item is PublishingTarget => allowedPublishingPlatforms.has(item.platform) && Boolean(item.accountId))
      .filter((item, index, items) => items.findIndex(candidate => candidate.platform === item.platform && candidate.accountId === item.accountId) === index)
    : [], socialCadence);
  // External publication, bulk outreach, and commercial commitments are hard
  // human-approval boundaries. They cannot be relaxed by a stale client or a
  // higher autonomy selection.
  const contentPublishApproval = true;
  const batchFollowupApproval = true;
  const commercialCommitmentApproval = true;
  const defaultVideoLanguage = normalizeVideoLanguage(input.videoDefaults?.language || 'en');
  const requestedVideoLanguages = Array.isArray(input.videoLanguages) ? input.videoLanguages : [defaultVideoLanguage];
  const videoLanguages = [...new Set(requestedVideoLanguages.map(normalizeVideoLanguage))]
    .filter(code => code in VIDEO_LANGUAGES)
    .slice(0, 5);
  const confirmedOperatingPlan = normalizeConfirmedOperatingPlan(input.confirmedOperatingPlan);
  const productionOnboarding = normalizeProductionOnboardingPreferences(input.productionOnboarding);
  return {
    ...(productionOnboarding ? { productionOnboarding } : {}),
    managedPublishingGrant: normalizeManagedPublishingGrant(input.managedPublishingGrant),
    continuationPolicy: normalizeContinuationPolicy(input.continuationPolicy),
    operatingMaturity: ["starting", "growing", "established"].includes(String(input.operatingMaturity)) ? input.operatingMaturity : "growing",
    operatingAssessment: normalizeAssessment(input.operatingAssessment),
    socialOperatingProfile: input.socialOperatingProfile === 'dual_account_growth' ? 'dual_account_growth' : 'starter_four_platform',
    defaultParticipation: input.defaultParticipation === "team" ? "team" : "agent",
    videoDefaults: normalizeVideoPlan(input.videoDefaults || {}),
    videoLanguages: videoLanguages.length ? videoLanguages : [defaultVideoLanguage in VIDEO_LANGUAGES ? defaultVideoLanguage : 'en'],
    smartOperationsEnabled: input.smartOperationsEnabled !== false,
    companyName: text(input.companyName, 120),
    industry: text(input.industry, 120),
    primaryBusiness: text(input.primaryBusiness, 500),
    targetMarkets: text(input.targetMarkets, 300),
    customerProfile: text(input.customerProfile, 500),
    autonomyMode,
    approvalOwner: text(input.approvalOwner, 120),
    constraints,
    team: ['orchestrator', 'business', 'director', 'content', 'customer'],
    primaryGoal,
    focusProducts: text(input.focusProducts, 500),
    enabledWorkflows: Array.isArray(input.enabledWorkflows)
      ? [...new Set(enabledWorkflows)]
      : ['scheduled_social', 'viral_clone', 'product_content', 'content_publish', 'customer_segmentation', 'batch_followup'],
    socialCadence,
    followupCadence: text(input.followupCadence, 500) || '每周五 09:00 生成分层跟进草稿；17:00 前审批；仅在客户当地工作日 09:00–18:00 发送；同一客户 7 天最多 1 次',
    reviewSchedule: text(input.reviewSchedule, 300) || '周五 17:30（北京时间）；数据截止 17:00；通知审批负责人；仅生成复盘和下周任务草稿',
    publishingTargets,
    ...(confirmedOperatingPlan ? { confirmedOperatingPlan } : {}),
    allowRealPublishing: input.allowRealPublishing === true,
    allowRealCustomerMessages: input.allowRealCustomerMessages === true,
    allowGeneratedVisuals: input.allowGeneratedVisuals === true,
    approvalPolicy: {
      contentPublish: contentPublishApproval,
      batchFollowup: batchFollowupApproval,
      commercialCommitment: commercialCommitmentApproval,
    },
    agentApprovalPolicies: {
      business: { activatePlan: input.agentApprovalPolicies?.business?.activatePlan !== false, changeGoalScope: input.agentApprovalPolicies?.business?.changeGoalScope !== false },
      industry: { addUnverifiedSource: input.agentApprovalPolicies?.industry?.addUnverifiedSource !== false, expandCollectionScope: input.agentApprovalPolicies?.industry?.expandCollectionScope !== false },
      content: { contentPublish: contentPublishApproval, factualClaims: input.agentApprovalPolicies?.content?.factualClaims !== false },
      customer: { batchFollowup: batchFollowupApproval, commercialCommitment: commercialCommitmentApproval },
    },
  };
}

export function validateDigitalEmployeeConfig(config: DigitalEmployeeConfig): string[] {
  const missing: string[] = [];
  if (!config.companyName) missing.push('企业名称');
  if (!config.industry) missing.push('行业');
  if (!config.primaryBusiness) missing.push('主要业务');
  if (!config.targetMarkets) missing.push('目标市场');
  if (!config.customerProfile) missing.push('核心客户');
  if (!config.approvalOwner) missing.push('审批负责人');
  return missing;
}

export function normalizeWeeklyGoal(input: Partial<WeeklyGoalInput>, config: DigitalEmployeeConfig): WeeklyGoalInput {
  const now = new Date();
  const weekEnd = new Date(now);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const baseline = Math.max(0, number(input.baseline));
  const target = Math.max(baseline + 1, number(input.target, baseline + 5));
  const businessLine = ['full_funnel', 'content_growth', 'customer_conversion'].includes(String(input.businessLine))
    ? input.businessLine as WeeklyGoalInput['businessLine']
    : 'full_funnel';
  const allowedPlatforms = new Set<WeeklyGoalInput['contentPlatforms'][number]>(['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin']);
  const configuredPlatforms = [...new Set(config.publishingTargets.map(target => target.platform))];
  const defaultPlatforms = config.enabledWorkflows.includes('content_publish') && configuredPlatforms.length
    ? configuredPlatforms
    : ['facebook', 'instagram', 'tiktok', 'youtube'] as WeeklyGoalInput['contentPlatforms'];
  const contentPlatforms: WeeklyGoalInput['contentPlatforms'] = Array.isArray(input.contentPlatforms)
    ? [...new Set(input.contentPlatforms.filter((item): item is WeeklyGoalInput['contentPlatforms'][number] => allowedPlatforms.has(item as WeeklyGoalInput['contentPlatforms'][number])))]
    : defaultPlatforms;
  return {
    businessLine,
    ...(Array.isArray(input.videoPlans) ? { videoPlans: input.videoPlans.slice(0, 30).map(normalizeVideoPlan) } : {}),
    contentPlatforms: contentPlatforms.length ? contentPlatforms : defaultPlatforms,
    title: text(input.title, 160) || `${config.companyName} 本周增长目标`,
    objective: text(input.objective, 1000),
    metric: text(input.metric, 120) || 'approved_content_packages',
    baseline,
    target,
    unit: text(input.unit, 40) || '项',
    startsAt: text(input.startsAt, 40) || now.toISOString().slice(0, 10),
    endsAt: text(input.endsAt, 40) || weekEnd.toISOString().slice(0, 10),
    scope: text(input.scope, 600) || config.targetMarkets,
    constraints: Array.isArray(input.constraints)
      ? input.constraints.map(item => text(item, 240)).filter(Boolean).slice(0, 20)
      : [...config.constraints],
  };
}

export function validateWeeklyGoal(goal: WeeklyGoalInput): string[] {
  const missing: string[] = [];
  for (const [index, plan] of (goal.videoPlans || []).entries()) missing.push(...videoSchedulingErrors(plan).map(error => `第 ${index + 1} 条：${error}`));
  if (!goal.title) missing.push('目标名称');
  if (!goal.objective) missing.push('目标说明');
  if (!goal.metric) missing.push('指标');
  if (!goal.scope) missing.push('业务范围');
  if (!goal.startsAt || !goal.endsAt) missing.push('目标周期');
  if (goal.target <= goal.baseline) missing.push('目标值必须高于基线');
  return missing;
}

export function buildWeeklyPlan(goal: WeeklyGoalInput, config: DigitalEmployeeConfig): WeeklyPlanDraft {
  const runtimePolicy = resolveRuntimePolicy(config);
  const operatingProfile = socialOperatingProfile(config.socialOperatingProfile);
  const profileConnectionIssues = connectedAccountIssues(operatingProfile.id, config.publishingTargets);
  const businessLineName = goal.businessLine === 'content_growth' ? '内容增长' : goal.businessLine === 'customer_conversion' ? '客户转化' : '全链路经营';
  const platformName: Record<WeeklyGoalInput['contentPlatforms'][number], string> = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn' };
  const contentPlatformNames = goal.contentPlatforms.map(item => platformName[item]).join(' / ');
  const taskCatalog: Array<Omit<PlannedTask, 'automaticExecutionAllowed' | 'policySource'>> = [
    {
      key: 'context_readiness',
      title: '盘点企业、产品与授权边界',
      description: `灵小枢调用知识能力读取 ${config.companyName} 的企业资料、重点产品、目标市场、社媒账号与客服授权，形成可追溯执行上下文。`,
      agentRole: 'orchestrator', backgroundCapability: 'knowledge', kind: 'analysis', sequence: 1, priority: 'high', requiresApproval: false, dependsOn: [], expectedMinutes: 3,
      businessDomain: 'foundation', capabilityKey: 'enterprise.readiness', destination: 'enterprise', statusSource: 'enterprise/profile + platform accounts', executionMode: 'internal', externalEffect: 'none',
    },
    {
      key: 'goal_decomposition',
      title: '拆解本周目标与成功标准',
      description: `经营 Agent 将“${goal.objective}”按${businessLineName}主线拆解，并绑定指标 ${goal.metric}；当前采用“${operatingProfile.name}”。实际视频数量以已保存的账号矩阵为准，每条计划视频独立制作，发布动作单独排期。`,
      agentRole: 'business', backgroundCapability: 'planner', kind: 'planning', sequence: 2, priority: 'high', requiresApproval: false, dependsOn: ['context_readiness'], expectedMinutes: 4,
      businessDomain: 'foundation', capabilityKey: 'workflow.plan', destination: 'digitalEmployees', statusSource: 'weekly_plans', executionMode: 'internal', externalEffect: 'none',
    },
    {
      key: 'scheduled_source_collection',
      title: '编导采集平台热点与对标',
      description: `编导 Agent 调用采集能力，只从 ${contentPlatformNames} 已确认的对标账号采集视频和图文；图文保留原帖配文，只有通过来源、分析、相关性和可迁移性准入的候选才进入生产库存。过程结果同步到灵感中心，节奏为：${config.socialCadence}。`,
      agentRole: 'director', backgroundCapability: 'channel', kind: 'activation', sequence: 3, priority: 'high', requiresApproval: false, dependsOn: ['goal_decomposition'], expectedMinutes: 4,
      businessDomain: 'content', capabilityKey: 'scheduler.social_collection', destination: 'scheduled', statusSource: 'scheduled_tasks + crawl_jobs', executionMode: 'observe', externalEffect: 'schedule',
    },
    {
      key: 'viral_analysis',
      title: '编导分析爆款并输出创作结论',
      description: '编导 Agent 读取灵感与对标分析，记录采用或淘汰依据，拆解爆款原脚本与分镜，并结合企业已确认事实形成可供排期使用的新脚本和分镜结论。',
      agentRole: 'director', backgroundCapability: 'knowledge', kind: 'analysis', sequence: 4, priority: 'high', requiresApproval: false, dependsOn: ['scheduled_source_collection'], expectedMinutes: 8,
      businessDomain: 'content', capabilityKey: 'inspiration.exact_analysis', destination: 'socialInspiration', statusSource: 'trend_videos.aiAnalysis', executionMode: 'observe', externalEffect: 'none',
    },
    {
      key: 'content_mode_routing',
      title: '经营 Agent 确定今日成片主题与排期',
      description: '经营 Agent 读取当天编导 Agent 的新增爆款分析，只确定当天成片的主题、产品、参考视频、账号、平台与发布时间，并形成内容 Agent 可执行的派单；周计划只约束总量、预算与平台节奏。',
      agentRole: 'business', backgroundCapability: 'planner', kind: 'planning', sequence: 5, priority: 'high', requiresApproval: false, dependsOn: ['viral_analysis'], expectedMinutes: 3,
      businessDomain: 'content', capabilityKey: 'studio.mode_routing', destination: 'scriptLibrary', statusSource: 'content_batch_plans.orders', executionMode: 'internal', externalEffect: 'draft',
    },
    {
      key: 'content_production',
      title: '按确认脚本执行素材与成片生产',
      description: '内容 Agent 读取内容订单绑定的已锁定导演方案和素材映射，完成配音、字幕、剪辑、混音、封面、分镜质检和渲染；不得自行匹配结构、生成或改写脚本，作品完成状态不等于平台发布。',
      agentRole: 'content', kind: 'production', sequence: 6, priority: 'high', requiresApproval: false, dependsOn: ['content_mode_routing'], expectedMinutes: 30,
      businessDomain: 'content', capabilityKey: 'studio.production', destination: 'smartAssets', destinationView: 'create', statusSource: 'studio_projects + render jobs', executionMode: 'draft_executor', externalEffect: 'draft',
    },
    {
      key: 'content_quality_gate', title: '完成内容质量门', description: '内容 Agent 调用风险能力核对事实、品牌、素材覆盖与分镜质量，保留需要人工修改的具体节点。',
      agentRole: 'content', backgroundCapability: 'risk', kind: 'analysis', sequence: 7, priority: 'high', requiresApproval: false, dependsOn: ['content_production'], expectedMinutes: 8,
      businessDomain: 'content', capabilityKey: 'studio.quality_gate', destination: 'smartAssets', destinationView: 'create', statusSource: 'studio project quality state', executionMode: 'observe', externalEffect: 'none',
    },
    {
      key: 'content_release_approval', title: '审批发布内容与账号', description: '经营 Agent 汇总作品、平台文案、发布账号和时间；负责人一次确认本周有界发布范围，包内合规内容自动排期。修改内容或关键经营边界后原授权自动失效并提醒用户。',
      agentRole: 'business', backgroundCapability: 'risk', kind: 'approval', sequence: 8, priority: 'high', requiresApproval: runtimePolicy.agents.content.approvals.contentPublish, dependsOn: ['content_quality_gate'], expectedMinutes: 5,
      businessDomain: 'publishing', capabilityKey: 'publishing.approval', destination: 'smartAssets', destinationView: 'publish', statusSource: 'approval_requests', executionMode: 'approval', externalEffect: 'publish',
    },
    {
      key: 'publishing_calendar', title: '写入内容发布日历', description: '经营 Agent 调用渠道能力将批准内容写入发布日历；经营自动化 Scheduler 与真实发布日历保持明确区分。',
      agentRole: 'business', backgroundCapability: 'channel', kind: 'activation', sequence: 9, priority: 'high', requiresApproval: false, dependsOn: ['content_release_approval'], expectedMinutes: 4,
      businessDomain: 'publishing', capabilityKey: 'publishing.calendar', destination: 'smartAssets', destinationView: 'publish', statusSource: 'posts.stats.status=scheduled', executionMode: 'observe', externalEffect: 'schedule',
    },
    {
      key: 'platform_publish', title: '等待平台发布真实回执', description: '经营 Agent 调用渠道能力观察逐账号发布、失败重试和平台回执；只有平台 ID 或 publishResults=published 才算发布完成。',
      agentRole: 'business', backgroundCapability: 'channel', kind: 'activation', sequence: 10, priority: 'high', requiresApproval: false, dependsOn: ['publishing_calendar'], expectedMinutes: 5,
      businessDomain: 'publishing', capabilityKey: 'publishing.delivery', destination: 'smartAssets', destinationView: 'publish', statusSource: 'posts.platform_post_id + publishResults', executionMode: 'observe', externalEffect: 'publish',
    },
    {
      key: 'customer_attribution', title: '回流互动与客户来源', description: '客户 Agent 将 WhatsApp 询盘与平台内容、产品和追踪码关联，无法确认时明确标记待归因。',
      agentRole: 'customer', kind: 'analysis', sequence: 11, priority: 'high', requiresApproval: false, dependsOn: ['platform_publish'], expectedMinutes: 4,
      businessDomain: 'customer', capabilityKey: 'customer.attribution', destination: 'conversion', statusSource: 'whatsapp_customers.sourcePostId', executionMode: 'observe', externalEffect: 'none',
    },
    {
      key: 'customer_segmentation', title: '冻结本周客户分层快照', description: '客户 Agent 根据阶段、意向、BANT、来源、沉默时长和风险生成可审计客群，并记录排除原因。',
      agentRole: 'customer', kind: 'analysis', sequence: 12, priority: 'high', requiresApproval: false, dependsOn: ['customer_attribution'], expectedMinutes: 5,
      businessDomain: 'customer', capabilityKey: 'customer.segment_snapshot', destination: 'conversion', statusSource: 'customer_segments + members', executionMode: 'observe', externalEffect: 'none',
    },
    {
      key: 'followup_batch_draft', title: '生成逐客跟进草稿', description: '客户 Agent 为冻结客群逐客生成草稿，保留语言、时区、24 小时窗口、模板状态与风险检查结果。',
      agentRole: 'customer', kind: 'production', sequence: 13, priority: 'high', requiresApproval: false, dependsOn: ['customer_segmentation'], expectedMinutes: 12,
      businessDomain: 'customer', capabilityKey: 'customer.followup_drafts', destination: 'conversion', statusSource: 'followup_batches + followup_batch_items', executionMode: 'observe', externalEffect: 'draft',
    },
    {
      key: 'followup_batch_approval', title: '审批批量跟进', description: '负责人抽检或整批审批逐客草稿；价格、MOQ、付款和交期等商业承诺仍需逐条人工处理。',
      agentRole: 'customer', backgroundCapability: 'risk', kind: 'approval', sequence: 14, priority: 'high', requiresApproval: runtimePolicy.agents.customer.approvals.batchFollowup, dependsOn: ['followup_batch_draft'], expectedMinutes: 8,
      businessDomain: 'customer', capabilityKey: 'customer.followup_approval', destination: 'conversion', statusSource: 'approval_requests + followup_batches', executionMode: 'approval', externalEffect: 'send',
    },
    {
      key: 'followup_dispatch', title: '按客户时区执行跟进', description: '客户 Agent 只发送已批准且通过窗口、模板与风险校验的单客任务；批量发送 Worker 未就绪时保持阻塞。',
      agentRole: 'customer', kind: 'activation', sequence: 15, priority: 'high', requiresApproval: false, dependsOn: ['followup_batch_approval'], expectedMinutes: 10,
      businessDomain: 'customer', capabilityKey: 'customer.followup_delivery', destination: 'conversion', statusSource: 'followup_batch_items.status + provider receipt', executionMode: 'observe', externalEffect: 'send',
    },
    {
      key: 'weekly_review', title: '生成真实周复盘与下周草案', description: '经营 Agent 调用复盘能力聚合任务、内容、发布、询盘、客户、批次与人工纠偏；缺失来源显示数据缺口。',
      agentRole: 'business', backgroundCapability: 'review', kind: 'review', sequence: 16, priority: 'medium', requiresApproval: false, dependsOn: ['followup_dispatch'], expectedMinutes: 5,
      businessDomain: 'review', capabilityKey: 'review.weekly_business', destination: 'digitalEmployees', statusSource: 'weekly_reviews + business snapshot', executionMode: 'internal', externalEffect: 'none',
    },
  ];
  const enabled = new Set(config.enabledWorkflows);
  const lineAllowsContent = goal.businessLine !== 'customer_conversion';
  const lineAllowsCustomer = goal.businessLine !== 'content_growth';
  const hasScheduledCollection = lineAllowsContent && enabled.has('scheduled_social');
  const hasViralClone = lineAllowsContent && enabled.has('viral_clone');
  const hasContentCreation = lineAllowsContent && (hasViralClone || enabled.has('product_content') || enabled.has('material_content'));
  const hasPublishing = lineAllowsContent && enabled.has('content_publish');
  const hasBatchFollowup = lineAllowsCustomer && enabled.has('batch_followup');
  const hasCustomerSegmentation = lineAllowsCustomer && (enabled.has('customer_segmentation') || hasBatchFollowup);
  const included = new Set<string>(['context_readiness', 'goal_decomposition', 'weekly_review']);
  if (hasScheduledCollection) included.add('scheduled_source_collection');
  if (hasViralClone) included.add('viral_analysis');
  if (hasContentCreation) {
    included.add('content_mode_routing');
    included.add('content_production');
    included.add('content_quality_gate');
  }
  if (hasPublishing) {
    included.add('content_release_approval');
    included.add('publishing_calendar');
    included.add('platform_publish');
  }
  if (hasPublishing && hasCustomerSegmentation) included.add('customer_attribution');
  if (lineAllowsCustomer && hasCustomerSegmentation) included.add('customer_segmentation');
  if (hasBatchFollowup) {
    included.add('followup_batch_draft');
    included.add('followup_batch_approval');
    included.add('followup_dispatch');
  }

  const dependencyByKey: Record<string, string[]> = {
    context_readiness: [],
    goal_decomposition: ['context_readiness'],
    scheduled_source_collection: ['goal_decomposition'],
    viral_analysis: [hasScheduledCollection ? 'scheduled_source_collection' : 'goal_decomposition'],
    // Viral-clone plans consume the Director Agent's confirmed benchmark analysis.
    content_mode_routing: [hasViralClone ? 'viral_analysis' : 'goal_decomposition'],
    content_production: ['content_mode_routing'],
    content_quality_gate: ['content_production'],
    content_release_approval: [hasContentCreation ? 'content_quality_gate' : 'goal_decomposition'],
    publishing_calendar: ['content_release_approval'],
    platform_publish: ['publishing_calendar'],
    customer_attribution: ['platform_publish'],
    customer_segmentation: ['goal_decomposition'],
    followup_batch_draft: ['customer_segmentation'],
    followup_batch_approval: ['followup_batch_draft'],
    followup_dispatch: ['followup_batch_approval'],
  };
  const reviewDependencies = [
    hasPublishing ? 'platform_publish' : hasContentCreation ? 'content_quality_gate' : hasScheduledCollection ? 'scheduled_source_collection' : '',
    hasBatchFollowup ? 'followup_dispatch' : hasCustomerSegmentation ? 'customer_segmentation' : '',
  ].filter(Boolean);
  dependencyByKey.weekly_review = [...new Set(reviewDependencies.length ? reviewDependencies : ['goal_decomposition'])];

  const tasks = taskCatalog
    .filter(task => included.has(task.key))
    .map((task, index) => ({
      ...task,
      sequence: index + 1,
      dependsOn: dependencyByKey[task.key] || [],
      automaticExecutionAllowed: automaticExecutionAllowed(runtimePolicy, task.externalEffect),
      policySource: 'effective_runtime_policy' as const,
    }));
  const estimatedMinutes = tasks.reduce((sum, task) => sum + task.expectedMinutes, 0);
  return {
    strategy: `围绕“${goal.objective}”，按${businessLineName}主线${goal.businessLine === 'content_growth' ? `（${contentPlatformNames}）` : ''}组织任务；所有对外动作受 ${config.autonomyMode} 自主模式约束。`,
    successCriteria: [
      `${goal.metric} 从 ${goal.baseline} 提升到 ${goal.target} ${goal.unit}`,
      '每个任务都绑定现有业务能力、事实来源与工作台去向',
      '平台发布、批量发送与商业承诺均经过人工审批',
      '作品完成与平台发布使用不同的真实状态来源',
      `${operatingProfile.name}按“原创 → 平台改编 → 单账号发布任务”分别计数${profileConnectionIssues.length ? `；账号缺口：${profileConnectionIssues.join('、')}` : ''}`,
    ],
    // Kept in the API contract for backwards compatibility; paid-media spend
    // is intentionally not part of the current digital-employee workflow.
    estimatedCost: 0,
    estimatedMinutes,
    qualityGates: ['企业事实完整性', '爆款证据完整性', '平台媒体格式适配', '统一文案与 Tag 一致性', '内容质量门', '发布与批量跟进审批', '业务结果可追溯'],
    riskSummary: '读取、分析和内部草稿属于低风险动作；平台发布、批量发送与商业承诺仍需负责人批准。',
    tasks,
  };
}

export function buildTaskOutput(
  taskKey: string,
  goal: WeeklyGoalInput,
  config: DigitalEmployeeConfig,
): Record<string, unknown> {
  if (taskKey === 'context_readiness') {
    return {
      company: config.companyName,
      industry: config.industry,
      business: config.primaryBusiness,
      targetMarkets: config.targetMarkets,
      customerProfile: config.customerProfile,
      constraints: config.constraints,
      evidenceStatus: 'confirmed_configuration',
    };
  }
  if (taskKey === 'goal_decomposition') {
    const operatingProfile = socialOperatingProfile(config.socialOperatingProfile);
    return {
      objective: goal.objective,
      successMetric: goal.metric,
      baseline: goal.baseline,
      target: goal.target,
      unit: goal.unit,
      scope: goal.scope,
      businessLine: goal.businessLine,
      contentPlatforms: goal.contentPlatforms,
      videoPlans: goal.videoPlans || [],
      socialOperatingProfile: {
        id: operatingProfile.id,
        name: operatingProfile.name,
        weeklyTargets: operatingProfile.weeklyTargets,
        activationGates: operatingProfile.activationGates,
        accountReadinessIssues: connectedAccountIssues(operatingProfile.id, config.publishingTargets),
      },
      checkpoints: goal.videoPlans?.length ? ['确认每条制作计划', '完整口播与同语言配音字幕', '成片质量检查', '人工验收当前版本', '生成周复盘'] : goal.businessLine === 'content_growth'
        ? ['建立四平台采集', '完成爆款分析与内容生产', '发布回执入库', '归因内容询盘', '生成周复盘']
        : goal.businessLine === 'customer_conversion'
          ? ['冻结客户分层', '生成逐客草稿', '完成人工审批', '按时区发送并回流', '生成周复盘']
          : ['建立社媒采集', '完成爆款分析与内容生产', '发布回执入库', '客户分层与逐客跟进', '生成周复盘'],
    };
  }
  if (taskKey === 'scheduled_source_collection') {
    return { capability: 'scheduler.social_collection', destination: 'scheduled', cadence: config.socialCadence, platforms: goal.contentPlatforms, discoveryBaseline: SOCIAL_DISCOVERY_BASELINE, mixPolicy: 'confirmed_competitor_accounts_only', taskTypes: ['competitor_account_crawl'], statusSource: 'scheduled_tasks + crawl_jobs + social_candidate_evidence', externalWritePerformed: false };
  }
  if (taskKey === 'viral_analysis') {
    return { capability: 'inspiration.exact_analysis', destination: 'socialInspiration', minimumEvidence: 'full_video_exact_analysis', statusSource: 'trend_videos.aiAnalysis', selectionPerformed: false };
  }
  if (taskKey === 'content_mode_routing') {
    const market = goal.scope || config.targetMarkets;
    return {
      packageType: 'business_native_content_plan',
      audience: config.customerProfile,
      market,
      focusProducts: config.focusProducts,
      routingSource: 'content_batch_plans.orders',
      planningPerformed: false,
      destination: 'smartAssets/create',
    };
  }
  if (taskKey === 'content_production') return { capability: 'studio.production', statusSource: 'studio_projects + render jobs', destination: 'smartAssets/create', completedWorkIsPublished: false };
  if (taskKey === 'content_quality_gate') return { capability: 'studio.quality_gate', checks: ['facts', 'brand', 'material_coverage', 'storyboard'], destination: 'smartAssets/create' };
  if (taskKey === 'content_release_approval') return { capability: 'publishing.approval', destination: 'smartAssets/publish', externalPublishPerformed: false, approvalRequired: config.approvalPolicy.contentPublish };
  if (taskKey === 'publishing_calendar') return { capability: 'publishing.calendar', statusSource: 'posts.stats.status=scheduled', destination: 'smartAssets/publish', scheduledIsPublished: false };
  if (taskKey === 'platform_publish') return { capability: 'publishing.delivery', statusSource: 'posts.platform_post_id + publishResults', destination: 'smartAssets/publish', externalPublishPerformed: false };
  if (taskKey === 'customer_attribution') return { capability: 'customer.attribution', statusSource: 'whatsapp_customers.sourcePostId', destination: 'conversion', attributionStatus: 'waiting_business_data' };
  if (taskKey === 'customer_segmentation') return { capability: 'customer.segment_snapshot', criteria: ['stage', 'intentScore', 'bant', 'source', 'silentDays', 'risk'], destination: 'conversion', snapshotCreated: false };
  if (taskKey === 'followup_batch_draft') return { capability: 'customer.followup_drafts', cadence: config.followupCadence, safetyMode: 'per_customer_draft', destination: 'conversion', messagesSent: 0 };
  if (taskKey === 'followup_batch_approval') return { capability: 'customer.followup_approval', destination: 'conversion', messagesSent: 0, approvalRequired: config.approvalPolicy.batchFollowup, commercialCommitmentsRequireIndividualReview: true };
  if (taskKey === 'followup_dispatch') {
    return { capability: 'customer.followup_delivery', deliveryMode: 'single_customer_confirmation', bulkWorkerStatus: 'manual_or_scheduled', messagesSent: 0, reason: 'Worker 已接入；只有 Meta 返回消息 ID 后才计为已发送，Webhook 继续回写送达与已读。' };
  }
  if (taskKey === 'weekly_review') return { capability: 'review.weekly_business', destination: 'digitalEmployees', statusSource: 'business snapshot', nextWeekPlanCreated: false };
  return { status: 'completed', summary: '任务已完成并写入真实运行记录。' };
}

export interface ReviewInput {
  goal: WeeklyGoalInput;
  totalTasks: number;
  completedTasks: number;
  approvalCount: number;
  handoffCount: number;
  failedTasks: number;
}

export function buildWeeklyReview(input: ReviewInput): Record<string, unknown> {
  const completionRate = input.totalTasks ? Math.round((input.completedTasks / input.totalTasks) * 100) : 0;
  const automaticTasks = Math.max(0, input.completedTasks - input.approvalCount);
  const automationRate = input.completedTasks ? Math.round((automaticTasks / input.completedTasks) * 100) : 0;
  return {
    completionRate,
    automationRate,
    approvalRate: input.totalTasks ? Math.round((input.approvalCount / input.totalTasks) * 100) : 0,
    handoffRate: input.totalTasks ? Math.round((input.handoffCount / input.totalTasks) * 100) : 0,
    completedTasks: input.completedTasks,
    totalTasks: input.totalTasks,
    failedTasks: input.failedTasks,
    highlights: input.failedTasks
      ? ['已形成完整运行证据链', '存在失败节点，需要在下周计划中优先修复']
      : ['周目标已形成可追溯任务链', '审批边界得到执行', '生产现场事件完整记录'],
    nextGoalSuggestion: input.failedTasks ? '先处理本轮失败及退回意见，修订后重新提交；不自动扩大渠道或发送授权。' : `延续“${input.goal.objective}”，先核对本周产物及审批状态，再按已授权范围安排后续动作，并用 ${input.goal.metric} 校准下一周目标。`,
    knowledgeCandidates: ['本周有效的内容主题', '审批人修改意见', '应继续保留的风险边界'],
  };
}
