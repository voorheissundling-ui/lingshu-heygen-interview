import type { WeeklyPackage } from './weeklyPackage';
import type { DirectorItemStatus } from './contentDirector';
import type { VideoCreationPlan } from './videoCreationPlan';

export type DirectorDecision = 'continue' | 'adjust' | 'abandon';
export type DirectorDecisionReason = 'buyer_mismatch' | 'weak_product_fit' | 'weak_viral_hook' | 'insufficient_evidence' | 'duplicate_content' | 'brand_mismatch';

export const DIRECTOR_DECISION_LABELS: Record<DirectorDecision, string> = { continue: '继续', adjust: '调整', abandon: '放弃' };
export const DIRECTOR_REASON_LABELS: Record<DirectorDecisionReason, string> = {
  buyer_mismatch: '买家不相关', weak_product_fit: '产品结合弱', weak_viral_hook: '爆点不够强',
  insufficient_evidence: '证据不足', duplicate_content: '内容重复', brand_mismatch: '品牌不适合',
};

export type DirectorDecisionResult = { pack: WeeklyPackage; affectedContentIds: string[]; replacementContentId?: string };

const similar = (candidate: VideoCreationPlan, target: VideoCreationPlan) => candidate.productName === target.productName && (candidate.theme === target.theme || candidate.matrix?.accountId === target.matrix?.accountId);

export function applyDirectorDecision(input: { pack: WeeklyPackage; contentId: string; decision: DirectorDecision; reason?: DirectorDecisionReason; applyToSimilar?: boolean; now?: string }): DirectorDecisionResult {
  const productionIndex = input.pack.tasks.findIndex(task => task.templateId === 'production');
  if (productionIndex < 0) throw new Error('director_production_task_missing');
  const production = input.pack.tasks[productionIndex]!;
  const plans = production.videoPlans || [];
  const target = plans.find(plan => plan.contentId === input.contentId);
  if (!target) throw new Error('director_content_not_found');
  if (input.decision !== 'continue' && !input.reason) throw new Error('director_reason_required');
  const affected = plans.filter(plan => plan.contentId === input.contentId || input.applyToSimilar && similar(plan, target));
  const affectedIds = affected.map(plan => String(plan.contentId)).filter(Boolean);
  const now = input.now || new Date().toISOString();
  const nextStatus: VideoCreationPlan['directorStatus'] = input.decision === 'continue' ? 'in_production' : 'candidate';
  let nextPlans = plans.map(plan => affectedIds.includes(String(plan.contentId)) ? { ...plan, directorStatus: nextStatus } : plan);
  let replacementContentId: string | undefined;
  if (input.decision === 'abandon') {
    nextPlans = nextPlans.filter(plan => !affectedIds.includes(String(plan.contentId)));
    const replacements = affected.map((plan, index) => {
      const id = `auto-${Date.parse(now) || Date.now()}-${index + 1}`;
      if (!replacementContentId) replacementContentId = id;
      return { ...plan, contentId: id, route: 'clone' as const, referenceId: '', materialIds: [], theme: '等待编导 Agent 自动补位', buyerProblem: '', evidenceRequirement: '', directorStatus: 'candidate' as const, estimatedCost: 0 };
    });
    nextPlans.push(...replacements);
  }
  const status: DirectorItemStatus = input.decision === 'continue' ? 'in_production' : 'candidate';
  const title = `${DIRECTOR_DECISION_LABELS[input.decision]}：${target.productName || target.theme || input.contentId}`;
  const result = input.decision === 'continue' ? '保留当前方向并继续生产' : input.decision === 'adjust' ? `按“${DIRECTOR_REASON_LABELS[input.reason!]}”重新编排` : `放弃原方向，已建立 ${affected.length} 条自动补位任务`;
  const progress = [...(input.pack.directorPlan?.progress || []), { id: `decision-${Date.parse(now) || Date.now()}`, title, status, result, nextStep: input.decision === 'continue' ? '进入内容生产' : '编导 Agent 重新计算爆量潜力并生成脚本', owner: 'team' as const, updatedAt: now, estimatedCost: 0, actualCost: 0 }];
  return { pack: { ...input.pack, directorPlan: input.pack.directorPlan ? { ...input.pack.directorPlan, progress } : undefined, tasks: input.pack.tasks.map((task, index) => index === productionIndex ? { ...task, videoPlans: nextPlans } : task) }, affectedContentIds: affectedIds, ...(replacementContentId ? { replacementContentId } : {}) };
}
