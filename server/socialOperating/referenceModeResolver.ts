import type { BusinessContentGoal, DecisionEvidence } from '../../shared/contracts/socialOperatingDecision.js';
import type { SocialReplicationReferenceMode } from '../../shared/contracts/socialContentWorkflow.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { buildOperatingDecision, type OperatingDecisionBlocker, type OperatingDecisionRecord, type OperatingResolverOptions } from './capacityPlanner.js';

export const REFERENCE_MODE_RULE_VERSION = 'reference-mode/1.0.0' as const;

export interface ReferenceModeInput {
  goal: BusinessContentGoal;
  requestedMode: 'ordinary_inspiration' | 'high_fidelity' | 'auto' | string;
  referenceRef: VersionedSocialRef;
  referenceRights: 'authorized' | 'restricted' | 'unknown';
  exactAnalysis: 'available' | 'unavailable' | 'unknown';
  productionCapability: 'available' | 'unavailable' | 'unknown';
  estimatedCostCny: number | null;
  remainingBudgetCny: number | null;
}

export interface ReferenceModeResolution {
  status: 'ready' | 'degraded' | 'blocked';
  mode: SocialReplicationReferenceMode | null;
  productMode: 'ordinary_inspiration' | 'high_fidelity' | null;
  mayEnterProduction: boolean;
}

export function resolveReferenceMode(input: ReferenceModeInput, options: OperatingResolverOptions): {
  resolution: ReferenceModeResolution;
  decision: OperatingDecisionRecord<ReferenceModeResolution>;
} {
  const blockers: OperatingDecisionBlocker[] = [];
  if (input.goal.status !== 'ready') blockers.push({ code: 'business_goal_not_ready', field: 'goal.status', message: '经营目标未就绪。', recoverable: true });
  if (!['ordinary_inspiration', 'high_fidelity', 'auto'].includes(input.requestedMode)) blockers.push({ code: 'invalid_or_unknown_input', field: 'requestedMode', message: '未知参考模式，已失败关闭。', recoverable: true });
  if (input.productionCapability !== 'available') blockers.push({ code: 'capability_unavailable', field: 'productionCapability', message: '生产能力不可用或状态未知。', recoverable: true });
  if (input.estimatedCostCny === null || input.remainingBudgetCny === null || !Number.isFinite(input.estimatedCostCny) || !Number.isFinite(input.remainingBudgetCny) || input.estimatedCostCny < 0 || input.remainingBudgetCny < 0) {
    blockers.push({ code: 'invalid_or_unknown_input', field: 'budget', message: '成本或剩余预算未知/无效。', recoverable: true });
  } else if (input.estimatedCostCny > input.remainingBudgetCny) blockers.push({ code: 'budget_exceeded', field: 'remainingBudgetCny', message: '参考生产成本超过剩余预算。', recoverable: true });
  const wantsHighFidelity = input.requestedMode === 'high_fidelity' || (input.requestedMode === 'auto' && input.exactAnalysis === 'available');
  if ((wantsHighFidelity && input.referenceRights !== 'authorized') || (!wantsHighFidelity && input.referenceRights === 'unknown')) {
    blockers.push({ code: 'rights_insufficient', field: 'referenceRights', message: '参考内容权利不足或未知。', recoverable: true });
  }
  if (wantsHighFidelity && input.exactAnalysis !== 'available') blockers.push({ code: 'exact_analysis_required', field: 'exactAnalysis', message: '高保真模式必须有可用的精确分析。', recoverable: true });
  const degraded = !blockers.length && input.requestedMode === 'auto' && input.exactAnalysis !== 'available';
  const productMode = blockers.length ? null : wantsHighFidelity ? 'high_fidelity' : 'ordinary_inspiration';
  const resolution: ReferenceModeResolution = {
    status: blockers.length ? 'blocked' : degraded ? 'degraded' : 'ready',
    mode: blockers.length ? null : wantsHighFidelity ? 'single_source_fidelity' : 'multi_source_hybrid',
    productMode,
    mayEnterProduction: blockers.length === 0,
  };
  const goalRef = { type: 'business_content_goal', id: input.goal.goalId, version: input.goal.version };
  const evidence: DecisionEvidence[] = [
    { key: 'reference_rights', state: input.referenceRights === 'unknown' ? 'unknown' : 'fact', value: input.referenceRights, sourceRefs: [input.referenceRef], explanation: '权利未知不等于已授权。' },
    { key: 'exact_analysis', state: input.exactAnalysis === 'unknown' ? 'unknown' : 'fact', value: input.exactAnalysis, sourceRefs: [input.referenceRef], explanation: '高保真只在精确分析可用时成立。' },
  ];
  const decision = buildOperatingDecision({ decisionType: 'reference_mode', subjectRef: goalRef, ruleVersion: REFERENCE_MODE_RULE_VERSION, input, inputRefs: [goalRef, input.referenceRef], evidence, blockers, output: resolution, outcome: resolution.status === 'ready' ? 'accepted' : resolution.status, options });
  return { resolution, decision };
}
