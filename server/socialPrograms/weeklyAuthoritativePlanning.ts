import type { BusinessContentGoal } from '../../shared/contracts/socialOperatingDecision.js';
import type { CapacityPlan } from '../socialOperating/capacityPlanner.js';
import type { AutomationPolicyResolution } from '../socialOperating/automationPolicyResolver.js';
import type { createSocialOperatingRepository } from '../socialOperating/repository.js';
import { SocialProgramError } from './service.js';
import type { WeeklyAutomationPolicySnapshot, WeeklyCapacitySnapshot } from './weeklyPlanner.js';
import {
  businessGoal,
  stable,
  validAutomationPolicy,
  validCapacityPlan,
  versionedRef,
} from './weeklyOperatingPackageSupport.js';

type OperatingRepository = ReturnType<typeof createSocialOperatingRepository>;

export function rejectClientAuthorityObjects(input: Record<string, unknown>): void {
  for (const field of ['businessContentGoal', 'capacityPlan', 'automationPolicy', 'scheduleRevisionRef', 'scheduleAssignments', 'templateApplicationRef', 'profileUpgradeConsumption']) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw new SocialProgramError('authoritative_object_injection_forbidden', 400, `不得直接提交权威对象 ${field}，请仅提交版本引用。`);
    }
  }
}

export async function resolveWeeklyAuthoritativePlanning(
  operatingRepository: OperatingRepository,
  tenantId: string,
  programId: string,
  input: Record<string, unknown>,
): Promise<{
  input: Record<string, unknown>;
  goal: BusinessContentGoal | null;
  capacity: WeeklyCapacitySnapshot | null;
  policy: WeeklyAutomationPolicySnapshot | null;
}> {
  const goalRef = versionedRef(input.businessContentGoalRef);
  if (input.businessContentGoalRef != null && !goalRef) throw new SocialProgramError('business_goal_ref_invalid', 400, '经营目标引用无效。');
  if (goalRef && goalRef.type !== 'business_content_goal') throw new SocialProgramError('business_goal_ref_invalid', 400, '经营目标引用类型无效。');
  const storedGoal = goalRef ? await operatingRepository.getGoal(tenantId, programId, goalRef.id, goalRef.version) : null;
  if (goalRef && !storedGoal) throw new SocialProgramError('business_goal_not_found', 404, '经营目标不存在。');
  const goal = businessGoal(storedGoal, programId);
  if (storedGoal && !goal) throw new SocialProgramError('business_goal_corrupt', 409, '权威经营目标数据不完整，已失败关闭。');

  const capacityRef = versionedRef(input.capacityPlanRef);
  if (input.capacityPlanRef != null && !capacityRef) throw new SocialProgramError('capacity_plan_ref_invalid', 400, '容量决策引用无效。');
  if (capacityRef && capacityRef.type !== 'capacity_plan') throw new SocialProgramError('capacity_plan_ref_invalid', 400, '容量决策引用类型无效。');
  const capacityDecision = capacityRef ? await operatingRepository.getOperatingDecision<CapacityPlan>(tenantId, programId, capacityRef.id) : null;
  if (capacityRef && (!capacityDecision || capacityDecision.decisionType !== 'capacity_plan' || capacityDecision.version !== capacityRef.version)) {
    throw new SocialProgramError('capacity_plan_not_found', 404, '权威容量决策不存在。');
  }
  if (capacityDecision && (!Array.isArray(capacityDecision.blockers) || !validCapacityPlan(capacityDecision.output))) {
    throw new SocialProgramError('capacity_plan_corrupt', 409, '权威容量决策数据不完整，已失败关闭。');
  }
  if (capacityDecision && (!goalRef || stable(capacityDecision.subjectRef) !== stable(goalRef))) {
    throw new SocialProgramError('capacity_plan_lineage_invalid', 409, '容量决策与当前经营目标版本不一致。');
  }
  const capacity: WeeklyCapacitySnapshot | null = capacityDecision && capacityRef ? {
    ref: capacityRef,
    status: capacityDecision.outcome === 'blocked' || capacityDecision.output.status === 'blocked' ? 'blocked' : 'ready',
    originalContentTarget: capacityDecision.output.originalContentQuota,
    accountPlans: capacityDecision.output.accountQuotas.filter(item => item.publicationQuota > 0).map(item => ({ accountId: item.accountId, publicationCount: item.publicationQuota })),
    productionBudgetCny: input.operatingDecisionSnapshotRef ? goal?.weeklyBudgetCny ?? capacityDecision.output.estimatedCostCny : capacityDecision.output.estimatedCostCny,
    blockers: capacityDecision.blockers.map(item => item.code),
  } : null;

  const policyRef = versionedRef(input.automationPolicyRef);
  if (input.automationPolicyRef != null && !policyRef) throw new SocialProgramError('automation_policy_ref_invalid', 400, '自动化决策引用无效。');
  if (policyRef && policyRef.type !== 'automation_policy') throw new SocialProgramError('automation_policy_ref_invalid', 400, '自动化决策引用类型无效。');
  const policyDecision = policyRef ? await operatingRepository.getOperatingDecision<AutomationPolicyResolution>(tenantId, programId, policyRef.id) : null;
  if (policyRef && (!policyDecision || policyDecision.decisionType !== 'automation_policy' || policyDecision.version !== policyRef.version)) {
    throw new SocialProgramError('automation_policy_not_found', 404, '权威自动化决策不存在。');
  }
  if (policyDecision && (!Array.isArray(policyDecision.blockers) || !validAutomationPolicy(policyDecision.output))) {
    throw new SocialProgramError('automation_policy_corrupt', 409, '权威自动化决策数据不完整，已失败关闭。');
  }
  if (policyDecision && (!goalRef || stable(policyDecision.subjectRef) !== stable(goalRef))) {
    throw new SocialProgramError('automation_policy_lineage_invalid', 409, '自动化决策与当前经营目标版本不一致。');
  }
  const policy: WeeklyAutomationPolicySnapshot | null = policyDecision && policyRef ? {
    ref: policyRef,
    status: policyDecision.outcome === 'blocked' || policyDecision.output.status === 'blocked' ? 'blocked' : 'ready',
    blockers: policyDecision.blockers.map(item => item.code),
  } : null;
  return { input: { ...input, businessContentGoal: goal, capacityPlan: capacity, automationPolicy: policy }, goal, capacity, policy };
}
