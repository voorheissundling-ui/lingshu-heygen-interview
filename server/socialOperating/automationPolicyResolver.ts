import type { BusinessContentGoal, DecisionEvidence } from '../../shared/contracts/socialOperatingDecision.js';
import type { BoundedPublishingAuthorizationSnapshot } from '../digitalEmployees/publishingExecution.js';
import { boundedAuthorizationIssue } from '../digitalEmployees/publishingExecution.js';
import { buildOperatingDecision, type OperatingDecisionBlocker, type OperatingDecisionRecord, type OperatingResolverOptions } from './capacityPlanner.js';
import {evaluateProductionOutlineReadiness} from './productionReadiness.js';

export const AUTOMATION_POLICY_RULE_VERSION = 'automation-policy/1.1.0' as const;
export const AUTOMATION_MODES = ['suggest', 'collaborate', 'managed'] as const;
export type AutomationMode = typeof AUTOMATION_MODES[number];
export type AutomationAction = 'read' | 'analyze' | 'draft' | 'change_scope' | 'spend' | 'publish' | 'customer_send' | 'commercial_commitment';
export type HumanGate = 'none' | 'review' | 'approve_each' | 'bounded_authorization' | 'human_only' | 'blocked';

export interface AutomationPolicyInput {
  goal: BusinessContentGoal;
  mode: AutomationMode | string;
  action: AutomationAction;
  capability: { key: string; availability: 'available' | 'unavailable' | 'unknown' };
  factsVerified: boolean | null;
  withinBudget: boolean | null;
  rightsSufficient: boolean | null;
  publishTarget?: { accountId: string; platform: 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin'; scheduledAt: string };
  publishingAuthorization?: BoundedPublishingAuthorizationSnapshot;
}

export interface AutomationPolicyResolution {
  status: 'allowed' | 'approval_required' | 'blocked';
  mode: AutomationMode | null;
  action: AutomationAction;
  humanGate: HumanGate;
  automaticExecutionAllowed: boolean;
  authorizationIssue: string | null;
}

const externalActions = new Set<AutomationAction>(['spend', 'publish', 'customer_send', 'commercial_commitment']);

export function resolveAutomationPolicy(input: AutomationPolicyInput, options: OperatingResolverOptions): {
  policy: AutomationPolicyResolution;
  decision: OperatingDecisionRecord<AutomationPolicyResolution>;
} {
  const blockers: OperatingDecisionBlocker[] = [];
  const mode = AUTOMATION_MODES.includes(input.mode as AutomationMode) ? input.mode as AutomationMode : null;
  if (!mode) blockers.push({ code: 'invalid_or_unknown_input', field: 'mode', message: '未知自动化模式，已失败关闭。', recoverable: true });
  if (input.goal.status !== 'ready' && !(input.action==='draft'&&evaluateProductionOutlineReadiness(input.goal).ready)) blockers.push({ code: 'business_goal_not_ready', field: 'goal.status', message: '经营目标缺少当前动作所需事实。', recoverable: true });
  if (input.capability.availability !== 'available') blockers.push({ code: 'capability_unavailable', field: `capability.${input.capability.key}`, message: '所需能力不可用或状态未知。', recoverable: true });
  for (const [field, value] of [['factsVerified', input.factsVerified], ['withinBudget', input.withinBudget], ['rightsSufficient', input.rightsSufficient]] as const) {
    if (value !== true) blockers.push({ code: value === null ? 'invalid_or_unknown_input' : field === 'rightsSufficient' ? 'rights_insufficient' : field === 'withinBudget' ? 'budget_exceeded' : 'invalid_or_unknown_input', field, message: `${field}未通过，不允许自动执行。`, recoverable: true });
  }
  let humanGate: HumanGate = 'blocked';
  if (!blockers.length && mode) {
    if (input.action === 'commercial_commitment') humanGate = 'human_only';
    else if (mode === 'suggest') humanGate = 'approve_each';
    else if (mode === 'collaborate') humanGate = ['read', 'analyze'].includes(input.action) ? 'none' : 'review';
    else humanGate = externalActions.has(input.action) ? (input.action === 'publish' ? 'bounded_authorization' : 'approve_each') : input.action === 'change_scope' ? 'review' : 'none';
  }
  let authorizationIssue: string | null = null;
  if (!blockers.length && input.action === 'publish' && humanGate === 'bounded_authorization') {
    authorizationIssue = input.publishTarget ? boundedAuthorizationIssue(input.publishingAuthorization, input.publishTarget) : 'bounded_authorization_target_missing';
    if (authorizationIssue) blockers.push({ code: 'authorization_required', field: 'publishingAuthorization', message: `发布授权不满足：${authorizationIssue}。`, recoverable: true });
  }
  const approvalRequired = !blockers.length && humanGate !== 'none' && humanGate !== 'bounded_authorization';
  const policy: AutomationPolicyResolution = {
    status: blockers.length ? 'blocked' : approvalRequired ? 'approval_required' : 'allowed', mode, action: input.action,
    humanGate: blockers.length ? 'blocked' : humanGate,
    automaticExecutionAllowed: !blockers.length && (humanGate === 'none' || (humanGate === 'bounded_authorization' && !authorizationIssue)),
    authorizationIssue,
  };
  const goalRef = { type: 'business_content_goal', id: input.goal.goalId, version: input.goal.version };
  const evidence: DecisionEvidence[] = [
    { key: 'automation_mode', state: mode ? 'fact' : 'unknown', value: mode, sourceRefs: [goalRef], explanation: '自动化等级决定最低人工门槛。' },
    { key: 'authorization', state: input.action === 'publish' ? (authorizationIssue ? 'unknown' : 'fact') : 'fact', value: authorizationIssue, sourceRefs: [], explanation: '发布仅读验证现有有界授权合同。' },
  ];
  const decision = buildOperatingDecision({ decisionType: 'automation_policy', subjectRef: goalRef, ruleVersion: AUTOMATION_POLICY_RULE_VERSION, input, inputRefs: [goalRef], evidence, blockers, output: policy, outcome: blockers.length ? 'blocked' : approvalRequired ? 'degraded' : 'accepted', options });
  return { policy, decision };
}
