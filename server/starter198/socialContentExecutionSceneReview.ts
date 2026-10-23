import type {
  SocialContentExecutionScenePlan,
  SocialDirectorBriefScene,
  SocialExecutionPlanReviewReason,
  SocialExecutionPlanSceneReview,
} from '../../shared/contracts/socialContentWorkflow.js';

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export function reviewSocialExecutionScene(input: {
  scene: SocialDirectorBriefScene;
  plan: SocialContentExecutionScenePlan;
  weekly: boolean;
  rightsMissing: boolean;
  enforceTruthGates?: boolean;
  conceptPreview: boolean;
}): SocialExecutionPlanSceneReview {
  const failedCriteria: string[] = [], requiredRevision: string[] = [];
  const reasonCodes: SocialExecutionPlanReviewReason[] = [];
  if (input.enforceTruthGates && input.rightsMissing) {
    failedCriteria.push('当前素材或生成输入尚未完成授权核验');
    requiredRevision.push('补充对应真实授权凭据，不得以预算预检替代授权');
    reasonCodes.push('rights_missing');
  }
  if (input.enforceTruthGates && input.scene.truthBoundary.customerEvidenceRequired && !input.scene.truthBoundary.customerEvidenceRefs.length) {
    failedCriteria.push('当前分镜缺少必要的真实业务证据');
    requiredRevision.push('补充对应真实资料或修改参考，不得生成事实证明替代');
    reasonCodes.push('facts_missing');
  }
  if (input.plan.feasibility === 'goal_degraded') {
    failedCriteria.push('当前路线降低了镜头的核心证明强度或经营目标');
    requiredRevision.push('寻找能保持事实强度的替代路线，或显式返回经营 Agent 调整目标');
    reasonCodes.push('material_insufficient');
  }
  if (!input.plan.recommendedCandidateIds.length) {
    failedCriteria.push('没有可执行的推荐候选');
    requiredRevision.push('补充候选素材或可用能力后重新提交');
    reasonCodes.push('capability_mismatch');
  }
  const requiredFactorIds = (input.scene.replicationFactors ?? []).map(factor => factor.factorId);
  const plannedFactorIds = new Set(input.plan.replicationFactorIds ?? []);
  const applicableFactorIds = new Set((input.scene.replicationFactors ?? [])
    .filter(factor => factor.semanticAdaptation?.status !== 'functionally_replaced').map(factor => factor.factorId));
  const factorExecutionById = new Map((input.plan.factorFeasibility ?? []).map(item => [item.factorId, item]));
  const missingFactorIds = requiredFactorIds.filter(factorId => applicableFactorIds.has(factorId)
    && (!plannedFactorIds.has(factorId) || !factorExecutionById.has(factorId)));
  const infeasibleFactorIds = [...applicableFactorIds].filter(factorId => {
    const execution = factorExecutionById.get(factorId);
    return Boolean(execution && (!execution.feasible || !execution.plannedValidatorId));
  });
  if (missingFactorIds.length || infeasibleFactorIds.length) {
    failedCriteria.push(`存在未被执行方案承接的裂变因素：${unique([...missingFactorIds, ...infeasibleFactorIds]).join('、')}`);
    requiredRevision.push('为每个冻结因素补充可执行候选和独立检测器，不得通过放宽因素规格绕过');
    reasonCodes.push('capability_mismatch');
  }
  const approved = failedCriteria.length === 0;
  return { sceneId: input.scene.sceneId, approved, feasibility: input.plan.feasibility, failedCriteria, requiredRevision,
    goalImpact: approved ? 'none' : input.weekly ? 'weekly_plan' : 'video', reasonCodes: unique(reasonCodes) };
}
