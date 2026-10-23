import type { ReviewTodo } from './reviewTodos';
import type { VideoCreationPlan } from './videoCreationPlan';
import { matrixIssues, type MatrixAccountPlan } from './weeklyMatrix';
import { directorIssues, type ContentDirectorPlan } from './contentDirector';

import type { Maturity, OperatingAssessment } from './operatingMaturity';
export { maturityLabels } from './operatingMaturity';
export type { Maturity } from './operatingMaturity';
export type Participation = 'agent' | 'team';
export const TASK_TEMPLATES = [
  { id: 'readiness', title: '准备企业与产品资料', description: '核对产品资料、账号和执行授权。', outcome: '资料与账号具备执行条件', keys: ['context_readiness'], page: 'enterprise' },
  { id: 'director', title: '分析爆款并完成脚本分镜', description: '完成对标采集与爆款分析，拆解原脚本，并依据企业事实生成适配脚本和逐镜分镜。', outcome: '形成有证据来源的编导结论、脚本与分镜', keys: ['scheduled_source_collection', 'viral_analysis'], page: 'socialInspiration' },
  { id: 'production', title: '排期并制作产品视频', description: '经营 Agent 根据编导结论冻结详细选题与排期，内容 Agent 再完成素材、生成、渲染与质检。', outcome: '完成排期中的视频并通过内容 Agent 质检', keys: ['content_mode_routing', 'content_production', 'content_quality_gate'], page: 'smartAssets' },
  { id: 'publishing', title: '发布内容', description: '将作品发布到指定账号，并核验平台回执。', outcome: '取得真实平台发布回执', keys: ['content_release_approval', 'publishing_calendar', 'platform_publish'], page: 'smartAssets' },
  { id: 'customers', title: '整理客户分层', description: '整理客户来源与当前阶段，形成跟进客群。', outcome: '保存客户分层快照', keys: ['customer_attribution', 'customer_segmentation'], page: 'conversion' },
  { id: 'followup', title: '跟进潜在客户', description: '为指定客户生成草稿并跟进，记录实际回执。', outcome: '取得跟进记录和渠道回执', keys: ['followup_batch_draft', 'followup_batch_approval', 'followup_dispatch'], page: 'conversion' },
  { id: 'review', title: '复盘本周工作', description: '汇总人工与 Agent 的实际交付和待解决问题。', outcome: '形成有真实数据依据的本周复盘', keys: ['weekly_review'], page: 'digitalEmployees' },
] as const;
/** Read-only compatibility aliases. New packages must use `director`. */
export const LEGACY_TASK_TEMPLATE_IDS = ['collection', 'inspiration'] as const;
export type TemplateId = typeof TASK_TEMPLATES[number]['id'];
export interface PackageTask {
  templateId: TemplateId;
  title: string;
  ownerId: string; // Empty means Agent; membership is checked on the server.
  ownerName: string;
  dueAt: string;
  notes: string;
  videoPlans?: VideoCreationPlan[];
  sourceProjectIds: string[];
}
export interface PackageAuthorization {
  mode: 'each' | 'bounded';
  accountIds: string[];
  maxPublishItems: number;
  customerIds: string[];
  maxCustomerMessages: number;
}
export interface WeeklyOperatingContext {
  objective: string;
  metric: string;
  markets: string[];
  cycle: { startsAt: string; endsAt: string };
  accounts: Array<{
    accountId: string;
    platform: string;
    accountLabel: string;
    positioning: string;
    contentCount: number;
    budgetCny: number | null;
    allocationBasis: 'estimated_cost' | 'content_load';
  }>;
  budget: {
    currency: string;
    productionCny: number;
    productionMinCny?: number;
    productionMaxCny?: number;
    paidMediaCny: number;
    totalCny: number;
    totalMinCny?: number;
    totalMaxCny?: number;
  };
  cadence: {
    contentCount: number;
    description: string;
    reviewSchedule: string;
  };
  authorization: {
    mode: 'each' | 'bounded';
    allowRealPublishing: boolean;
    allowRealCustomerMessages: boolean;
    accountIds: string[];
    maxPublishItems: number;
    maxCustomerMessages: number;
  };
  outputs: {
    count: number;
    originalCount?: number;
    platformVersionCount?: number;
    publishCount?: number;
    formats: string[];
    totalDurationSeconds: number;
  };
}
export interface WeeklyPackage {
  directorPlan?: ContentDirectorPlan;
  matrixPlan?: MatrixAccountPlan[];
  reviewTodos?: ReviewTodo[];
  detailGeneration?: {
    status: 'generating' | 'ready' | 'blocked';
    startedAt: string;
    generatedAt: string;
    estimatedMinutes: number;
    usageCostCny: number | null;
    readyCount: number;
    blockedCount: number;
    blockers: string[];
  };
  revision: number;
  maturity: Maturity;
  operatingAssessment?: OperatingAssessment;
  participation: Participation;
  tasks: PackageTask[];
  authorization: PackageAuthorization;
  /** Frozen, user-readable projection of goal, scope, cost, output and authority. */
  operatingContext?: WeeklyOperatingContext;
}
export function packageIssues(pack: WeeklyPackage, startsAt: string, endsAt: string): string[] {
  const issues: string[] = [];
  const ids = new Set(pack.tasks.map(t => t.templateId));
  if (!pack.tasks.length) issues.push('请至少添加一项任务');
  if (ids.size !== pack.tasks.length) issues.push('同类任务请在现有卡片中调整，不要重复添加');
  if (ids.has('publishing') && !ids.has('production') && !pack.tasks.find(t => t.templateId === 'publishing')?.sourceProjectIds.length) issues.push('发布内容需要制作任务，或选择已有作品');
  if (ids.has('followup') && !ids.has('customers')) issues.push('客户跟进需要先加入客户分层任务');
  for (const task of pack.tasks) {
    if (!TASK_TEMPLATES.some(t => t.id === task.templateId)) issues.push('包含不支持的任务模板');
    if (!task.title.trim()) issues.push('请填写任务标题');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueAt) || task.dueAt < startsAt || task.dueAt > endsAt) issues.push(`${task.title || '任务'}的完成日期须在本周周期内`);
    if (task.templateId === 'production' && !task.videoPlans?.length) issues.push('制作视频需要至少一条具体视频安排');
  }
  const videoPlans = pack.tasks.find(task => task.templateId === 'production')?.videoPlans || [];
  if (pack.directorPlan && pack.tasks.some(task => task.templateId === 'production')) {
    const originals = videoPlans.filter(plan => plan.productionRole !== 'platform_adaptation');
    if (originals.length !== pack.directorPlan.originalTarget) issues.push(`实际制作视频为 ${originals.length} 条，与本周目标 ${pack.directorPlan.originalTarget} 条不一致`);
    if (videoPlans.length !== pack.directorPlan.platformVersionTarget) issues.push(`平台交付版本为 ${videoPlans.length} 条，与编导目标 ${pack.directorPlan.platformVersionTarget} 条不一致`);
    const estimated = videoPlans.reduce((sum, plan) => sum + Number(plan.estimatedCost || 0), 0);
    if (estimated + pack.directorPlan.productionSpent > (pack.directorPlan.productionBudgetMax || pack.directorPlan.productionBudget)) issues.push('内容计划预计费用与已用金额超过生产预算');
  }
  return [...new Set([...issues, ...matrixIssues(pack), ...directorIssues(pack.directorPlan, { requirePublishing: ids.has('publishing') })])];
}
