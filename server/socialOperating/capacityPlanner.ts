import type {
  BusinessContentGoal,
  DecisionEvidence,
} from '../../shared/contracts/socialOperatingDecision.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { deterministicFingerprint } from './businessGoalBuilder.js';
import { evaluateProductionOutlineReadiness } from './productionReadiness.js';

export const CAPACITY_PLANNER_RULE_VERSION = 'capacity-planner/1.1.1' as const;

export type OperatingDecisionType = 'capacity_plan' | 'automation_policy' | 'reference_mode';
export type OperatingDecisionBlockerCode =
  | 'business_goal_not_ready'
  | 'invalid_or_unknown_input'
  | 'budget_exceeded'
  | 'material_capacity_insufficient'
  | 'deadline_capacity_insufficient'
  | 'account_capacity_insufficient'
  | 'interaction_capacity_insufficient'
  | 'sales_capacity_insufficient'
  | 'capability_unavailable'
  | 'authorization_required'
  | 'rights_insufficient'
  | 'exact_analysis_required';

export interface OperatingDecisionBlocker {
  code: OperatingDecisionBlockerCode;
  field: string;
  message: string;
  recoverable: true;
}

export interface OperatingDecisionRecord<T> {
  decisionId: string;
  decisionType: OperatingDecisionType;
  subjectRef: VersionedSocialRef;
  version: 1;
  outcome: 'accepted' | 'degraded' | 'blocked';
  ruleVersion: string;
  inputRefs: VersionedSocialRef[];
  inputFingerprint: string;
  evidence: DecisionEvidence[];
  blockers: OperatingDecisionBlocker[];
  output: T;
  operator: { type: 'user' | 'agent' | 'system'; id: string };
  decidedAt: string;
}

export interface CapacityAccountInput {
  ref: VersionedSocialRef;
  accountId: string;
  status: 'active' | 'planned' | 'paused' | 'retired' | 'unknown';
  weeklyPublicationCapacity: number | null;
}

export interface CapacityPlanInput {
  goal: BusinessContentGoal;
  desiredOriginalContents: number;
  desiredAdaptations: number;
  costPerOriginalCny: number | null;
  costPerAdaptationCny: number | null;
  readyMaterialUnits: number | null;
  materialUnitsPerOriginal: number | null;
  productionItemsPerDay: number | null;
  daysUntilDeadline: number | null;
  accounts: CapacityAccountInput[];
  interactionItemsPerWeek: number | null;
  salesLeadsPerWeek: number | null;
  expectedInteractionsPerPublication: number | null;
  expectedLeadsPerPublication: number | null;
  capabilities: Record<'studio.production' | 'publishing.calendar' | 'customer.attribution', 'available' | 'unavailable' | 'unknown'>;
}

export interface AccountCapacityAllocation {
  accountId: string;
  publicationQuota: number;
}

export interface CapacityPlan {
  status: 'ready' | 'degraded' | 'blocked';
  originalContentQuota: number;
  adaptationQuota: number;
  publicationQuota: number;
  accountQuotas: AccountCapacityAllocation[];
  estimatedCostCny: number;
  limitingFactors: string[];
}

export interface OperatingResolverOptions {
  operator: { type: 'user' | 'agent' | 'system'; id: string };
  decidedAt: string;
}

const finiteNonNegative = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
const whole = (value: number): number => Math.max(0, Math.floor(value));
const sortedRefs = (refs: VersionedSocialRef[]) => [...refs].sort((a, b) => `${a.type}:${a.id}:${a.version}`.localeCompare(`${b.type}:${b.id}:${b.version}`));

export function buildOperatingDecision<T>(args: {
  decisionType: OperatingDecisionType;
  subjectRef: VersionedSocialRef;
  ruleVersion: string;
  input: unknown;
  inputRefs: VersionedSocialRef[];
  evidence: DecisionEvidence[];
  blockers: OperatingDecisionBlocker[];
  output: T;
  outcome: OperatingDecisionRecord<T>['outcome'];
  options: OperatingResolverOptions;
}): OperatingDecisionRecord<T> {
  const inputRefs = sortedRefs(args.inputRefs);
  const inputFingerprint = deterministicFingerprint({ input: args.input, ruleVersion: args.ruleVersion });
  return {
    decisionId: `dec_${deterministicFingerprint({ type: args.decisionType, subject: args.subjectRef, inputFingerprint }).slice(0, 24)}`,
    decisionType: args.decisionType,
    subjectRef: args.subjectRef,
    version: 1,
    outcome: args.outcome,
    ruleVersion: args.ruleVersion,
    inputRefs,
    inputFingerprint,
    evidence: args.evidence,
    blockers: args.blockers,
    output: args.output,
    operator: args.options.operator,
    decidedAt: args.options.decidedAt,
  };
}

export function planCapacity(input: CapacityPlanInput, options: OperatingResolverOptions): {
  plan: CapacityPlan;
  decision: OperatingDecisionRecord<CapacityPlan>;
} {
  const blockers: OperatingDecisionBlocker[] = [];
  const productionOutlineOnly=input.goal.status==='blocked'&&evaluateProductionOutlineReadiness(input.goal).ready;
  const invalidFields: string[] = [];
  const numericEntries: Array<[string, number | null]> = [
    ['desiredOriginalContents', input.desiredOriginalContents], ['desiredAdaptations', input.desiredAdaptations],
    ['costPerOriginalCny', input.costPerOriginalCny], ['costPerAdaptationCny', input.costPerAdaptationCny],
    ['readyMaterialUnits', input.readyMaterialUnits], ['materialUnitsPerOriginal', input.materialUnitsPerOriginal],
    ['productionItemsPerDay', input.productionItemsPerDay], ['daysUntilDeadline', input.daysUntilDeadline],
    ['interactionItemsPerWeek', input.interactionItemsPerWeek], ['salesLeadsPerWeek', input.salesLeadsPerWeek],
    ['expectedInteractionsPerPublication', input.expectedInteractionsPerPublication], ['expectedLeadsPerPublication', input.expectedLeadsPerPublication],
  ];
  for (const [field, value] of numericEntries) if (!finiteNonNegative(value)) invalidFields.push(field);
  if (!finiteNonNegative(input.goal.weeklyBudgetCny)) invalidFields.push('goal.weeklyBudgetCny');
  if (input.goal.status !== 'ready' && !evaluateProductionOutlineReadiness(input.goal).ready) blockers.push({ code: 'business_goal_not_ready', field: 'goal.status', message: '经营目标缺少内容生产必需事实，不分配容量。', recoverable: true });
  if (invalidFields.length) blockers.push({ code: 'invalid_or_unknown_input', field: invalidFields.join(','), message: '容量输入存在未知、负数或非有限值，已失败关闭。', recoverable: true });
  const unavailableCapabilities = input.capabilities['studio.production'] === 'available' ? [] : ['studio.production'];
  if (unavailableCapabilities.length) blockers.push({ code: 'capability_unavailable', field: 'capabilities', message: `能力不可用或状态未知：${unavailableCapabilities.join('、')}。`, recoverable: true });
  const usableAccounts = input.accounts.filter(account => (account.status === 'active'||productionOutlineOnly&&account.status==='planned') && finiteNonNegative(account.weeklyPublicationCapacity))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
  if (!productionOutlineOnly&&input.accounts.some(account => account.status === 'unknown' || !finiteNonNegative(account.weeklyPublicationCapacity))) {
    blockers.push({ code: 'invalid_or_unknown_input', field: 'accounts', message: '账号状态或周发布容量未知，已失败关闭。', recoverable: true });
  }

  let originals = 0;
  let adaptations = 0;
  let publicationQuota = 0;
  let estimatedCostCny = 0;
  const limitingFactors: string[] = [];
  if (!blockers.length) {
    const desiredOriginals = whole(input.desiredOriginalContents);
    const desiredAdaptations = whole(input.desiredAdaptations);
    const desiredTotal = desiredOriginals + desiredAdaptations;
    const deadlineLimit = whole(input.productionItemsPerDay! * input.daysUntilDeadline!);
    // When only outbound facts are missing, this decision allocates draft
    // production capacity. Publishing accounts, local material inventory and
    // sales handling must not reduce that capacity to zero; the downstream
    // asset-supply, provider, budget and outbound gates still enforce their
    // own real inputs. A commercially ready goal keeps the original limits.
    const materialLimit = productionOutlineOnly?desiredOriginals:input.materialUnitsPerOriginal! === 0 ? desiredOriginals : whole(input.readyMaterialUnits! / input.materialUnitsPerOriginal!);
    const accountLimit = productionOutlineOnly?desiredTotal:usableAccounts.reduce((sum, account) => sum + whole(account.weeklyPublicationCapacity!), 0);
    const interactionLimit = productionOutlineOnly?desiredTotal:input.expectedInteractionsPerPublication! === 0 ? desiredTotal : whole(input.interactionItemsPerWeek! / input.expectedInteractionsPerPublication!);
    const salesLimit = productionOutlineOnly?desiredTotal:input.expectedLeadsPerPublication! === 0 ? desiredTotal : whole(input.salesLeadsPerWeek! / input.expectedLeadsPerPublication!);
    const operationalLimit = Math.min(desiredTotal, deadlineLimit, accountLimit, interactionLimit, salesLimit);
    originals = Math.min(desiredOriginals, materialLimit, operationalLimit);
    const remainingSlots = Math.max(0, operationalLimit - originals);
    adaptations = Math.min(desiredAdaptations, remainingSlots);
    const beforeBudget = originals + adaptations;
    while (originals > 0 && originals * input.costPerOriginalCny! + adaptations * input.costPerAdaptationCny! > input.goal.weeklyBudgetCny!) {
      if (adaptations > 0) adaptations -= 1;
      else originals -= 1;
    }
    estimatedCostCny = originals * input.costPerOriginalCny! + adaptations * input.costPerAdaptationCny!;
    publicationQuota = originals + adaptations;
    if (materialLimit < desiredOriginals) limitingFactors.push('materials');
    if (deadlineLimit < desiredTotal) limitingFactors.push('deadline');
    if (accountLimit < desiredTotal) limitingFactors.push('accounts');
    if (interactionLimit < desiredTotal) limitingFactors.push('interaction');
    if (salesLimit < desiredTotal) limitingFactors.push('sales');
    if (publicationQuota < beforeBudget) limitingFactors.push('budget');
    if (publicationQuota === 0 && desiredTotal > 0) blockers.push({ code: 'budget_exceeded', field: 'goal.weeklyBudgetCny', message: '预算与单件成本无法支持任何内容。', recoverable: true });
  }
  let remaining = publicationQuota;
  const accountQuotas = usableAccounts.map(account => {
    const quota = Math.min(remaining, whole(account.weeklyPublicationCapacity!));
    remaining -= quota;
    return { accountId: account.accountId, publicationQuota: quota };
  });
  const status: CapacityPlan['status'] = blockers.length ? 'blocked' : limitingFactors.length ? 'degraded' : 'ready';
  const plan: CapacityPlan = { status, originalContentQuota: originals, adaptationQuota: adaptations, publicationQuota, accountQuotas, estimatedCostCny, limitingFactors: [...new Set(limitingFactors)].sort() };
  const goalRef = { type: 'business_content_goal', id: input.goal.goalId, version: input.goal.version };
  const evidence: DecisionEvidence[] = [
    { key: 'budget_capacity', state: finiteNonNegative(input.goal.weeklyBudgetCny) ? 'fact' : 'unknown', value: input.goal.weeklyBudgetCny, sourceRefs: [goalRef], explanation: '仅使用经营目标冻结的周预算。' },
    { key: 'account_capacity', state: usableAccounts.length ? 'fact' : 'unknown', value: usableAccounts.map(account => `${account.accountId}:${account.weeklyPublicationCapacity}`), sourceRefs: usableAccounts.map(account => account.ref), explanation: '只向活跃且容量已知的账号分配。' },
    { key: 'capacity_limits', state: invalidFields.length ? 'unknown' : 'fact', value: invalidFields.length ? null : plan.limitingFactors, sourceRefs: [goalRef], explanation: '素材、截止时间、互动和销售承接共同限制发布量。' },
  ];
  const normalizedInput = { ...input, accounts: [...input.accounts].sort((a, b) => a.accountId.localeCompare(b.accountId)) };
  const decision = buildOperatingDecision({ decisionType: 'capacity_plan', subjectRef: goalRef, ruleVersion: CAPACITY_PLANNER_RULE_VERSION, input: normalizedInput, inputRefs: [goalRef, ...input.accounts.map(account => account.ref)], evidence, blockers, output: plan, outcome: status === 'ready' ? 'accepted' : status, options });
  return { plan, decision };
}
