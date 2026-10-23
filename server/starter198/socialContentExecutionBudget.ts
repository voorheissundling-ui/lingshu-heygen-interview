import type { SocialContentExecutionPlan, SocialDirectorBrief } from '../../shared/contracts/socialContentWorkflow.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

export function socialExecutionExternalCost(plan: SocialContentExecutionPlan, directorBrief: SocialDirectorBrief): number {
  const briefByScene = new Map(directorBrief.scenes.map(scene => [scene.sceneId, scene]));
  const reusedExternal = new Set<string>();
  return +plan.scenes.reduce((sum, scene) => {
    const candidate = scene.candidates.find(item => scene.recommendedCandidateIds.includes(item.candidateId));
    if (!candidate || candidate.dataTransfer === 'local_only') return sum;
    const briefScene = briefByScene.get(scene.sceneId);
    if (candidate.sourceStrategy === 'authorized_digital_presenter' && briefScene) {
      const seconds = Math.max(0, briefScene.duration.endSeconds - briefScene.duration.startSeconds);
      const configuredRate = Number(process.env.HEYGEN_ESTIMATED_CNY_PER_SECOND);
      // Keep the planner's frozen quote unless operations configured a real positive rate.
      return sum + (Number.isFinite(configuredRate) && configuredRate > 0
        ? seconds * configuredRate : candidate.estimatedCostCny);
    }
    // One licensed physical asset can serve adjacent semantic cuts without a second acquisition.
    if (candidate.sourceStrategy === 'licensed_stock_asset') {
      const key = `${candidate.sourceStrategy}:${briefScene?.visualTopic?.subject.trim().toLowerCase() || scene.sceneId}`;
      if (reusedExternal.has(key)) return sum;
      reusedExternal.add(key);
    }
    return sum + candidate.estimatedCostCny;
  }, 0).toFixed(2);
}

export function socialExecutionBudgetStatus(
  plan: SocialContentExecutionPlan,
  directorBrief: SocialDirectorBrief,
  tenantId?: string,
): { estimatedCostCny: number; budgetLimitCny: number | null; exceeded: boolean } {
  const estimatedCostCny = socialExecutionExternalCost(plan, directorBrief);
  return {
    estimatedCostCny,
    budgetLimitCny: plan.budgetLimitCny,
    exceeded: !isInternalBudgetExemptTenant(tenantId)
      && plan.budgetLimitCny !== null
      && estimatedCostCny > plan.budgetLimitCny,
  };
}
