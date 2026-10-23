import { createHash } from 'node:crypto';
import {
  BUSINESS_GOAL_RULE_VERSION,
  type BusinessContentGoal,
  type BusinessGoalBuildInput,
  type DecisionBlocker,
  type DecisionEvidence,
  type DecisionRecord,
} from '../../shared/contracts/socialOperatingDecision.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';

const clean = (value: string) => value.trim();
const strings = (values: string[]) => [...new Set(values.map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const refs = (values: VersionedSocialRef[]) => [...values].sort((a, b) => `${a.type}:${a.id}:${a.version}`.localeCompare(`${b.type}:${b.id}:${b.version}`));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const deterministicFingerprint = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

function normalizeInput(input: BusinessGoalBuildInput): BusinessGoalBuildInput {
  return {
    programRef: input.programRef,
    enterprise: {
      ...input.enterprise,
      products: strings(input.enterprise.products),
      markets: strings(input.enterprise.markets),
      audiences: strings(input.enterprise.audiences),
      languages: strings(input.enterprise.languages),
      prohibitedClaims: strings(input.enterprise.prohibitedClaims),
      publicFacts: [...input.enterprise.publicFacts]
        .map(item => ({ ref: item.ref, statement: clean(item.statement) }))
        .filter(item => item.statement)
        .sort((a, b) => `${a.ref.id}:${a.ref.version}:${a.statement}`.localeCompare(`${b.ref.id}:${b.ref.version}:${b.statement}`)),
      salesOwnerId: input.enterprise.salesOwnerId?.trim() || null,
    },
    accounts: [...input.accounts].filter(item => item.status === 'active' || item.status === 'planned').sort((a, b) => a.accountId.localeCompare(b.accountId)),
    conversionRoutes: [...input.conversionRoutes].sort((a, b) => a.routeId.localeCompare(b.routeId)),
    objective: input.objective?.trim() || null,
  };
}

export interface BuildBusinessGoalOptions {
  version: number;
  operator: { type: 'user' | 'agent' | 'system'; id: string };
  decidedAt: string;
}

export function buildBusinessContentGoal(raw: BusinessGoalBuildInput, options: BuildBusinessGoalOptions): {
  goal: BusinessContentGoal;
  decision: DecisionRecord;
} {
  const input = normalizeInput(raw);
  const verifiedRoutes = input.conversionRoutes.filter(route => route.verified && Boolean(route.target));
  const accountBoundaries = input.accounts.map(account => ({
    accountId: account.accountId,
    accountVersion: account.ref.version,
    platform: account.platform,
    role: account.role.trim(),
    conversionRouteId: verifiedRoutes.some(route => route.routeId === account.conversionRouteId) ? account.conversionRouteId : null,
  }));
  const blockers: DecisionBlocker[] = [];
  if (!input.enterprise.publicFacts.length) blockers.push({ code: 'public_facts_required', field: 'enterprise.publicFacts', message: '至少需要一条可公开且有版本引用的企业事实。', recoverable: true });
  if (!verifiedRoutes.length) blockers.push({ code: 'conversion_route_required', field: 'conversionRoutes', message: '至少需要一个已验证的转化入口。', recoverable: true });
  if (!input.enterprise.salesOwnerId) blockers.push({ code: 'sales_owner_required', field: 'enterprise.salesOwnerId', message: '需要明确销售承接负责人。', recoverable: true });
  if (!accountBoundaries.length) blockers.push({ code: 'account_required', field: 'accounts', message: '至少需要一个可规划的业务账号。', recoverable: true });

  const inputRefs = refs([
    input.programRef,
    input.enterprise.ref,
    ...input.enterprise.publicFacts.map(item => item.ref),
    ...input.accounts.map(item => item.ref),
    ...input.conversionRoutes.map(item => item.ref),
  ]);
  const fingerprint = deterministicFingerprint({ input, ruleVersion: BUSINESS_GOAL_RULE_VERSION });
  const goalId = `bcg_${deterministicFingerprint({ program: input.programRef.id }).slice(0, 24)}`;
  const decisionId = `dec_${deterministicFingerprint({ goalId, version: options.version, fingerprint }).slice(0, 24)}`;
  const goalRef = { type: 'business_content_goal', id: goalId, version: options.version };
  const decisionRef = { type: 'decision_record', id: decisionId, version: 1 };
  const evidence: DecisionEvidence[] = [
    { key: 'products', state: input.enterprise.products.length ? 'fact' : 'unknown', value: input.enterprise.products.length ? input.enterprise.products : null, sourceRefs: [input.enterprise.ref], explanation: '产品范围只读取企业知识版本。' },
    { key: 'markets', state: input.enterprise.markets.length ? 'fact' : 'unknown', value: input.enterprise.markets.length ? input.enterprise.markets : null, sourceRefs: [input.enterprise.ref], explanation: '市场是已配置范围，不推断访客国别。' },
    { key: 'audiences', state: input.enterprise.audiences.length ? 'fact' : 'unknown', value: input.enterprise.audiences.length ? input.enterprise.audiences : null, sourceRefs: [input.enterprise.ref], explanation: '受众只读取企业知识版本。' },
    { key: 'public_facts', state: input.enterprise.publicFacts.length ? 'fact' : 'unknown', value: input.enterprise.publicFacts.map(item => item.statement), sourceRefs: input.enterprise.publicFacts.map(item => item.ref), explanation: '内容可用事实不由经营 Agent 补写。' },
    { key: 'account_roles', state: accountBoundaries.length ? 'inference' : 'unknown', value: accountBoundaries.map(item => `${item.accountId}:${item.role}`), sourceRefs: input.accounts.map(item => item.ref), explanation: '账号角色是基于已配置账号的经营边界，可被用户覆盖。' },
  ];
  const status = blockers.length ? 'blocked' : 'ready';
  const objective = input.objective || (status === 'ready'
    ? `面向${input.enterprise.audiences.join('、')}，用可验证事实解释${input.enterprise.products.join('、')}，并通过已验证入口获取可资格确认的咨询。`
    : '经营目标待必需事实与承接边界补齐后生效。');
  const goal: BusinessContentGoal = {
    goalId, programId: input.programRef.id, version: options.version, status, objective,
    products: input.enterprise.products, markets: input.enterprise.markets, audiences: input.enterprise.audiences,
    languages: input.enterprise.languages, accountBoundaries, conversionRouteIds: verifiedRoutes.map(route => route.routeId),
    publicFactRefs: refs(input.enterprise.publicFacts.map(item => item.ref)), prohibitedClaims: input.enterprise.prohibitedClaims,
    weeklyBudgetCny: input.enterprise.weeklyBudgetCny, evidence, blockers, inputRefs, inputFingerprint: fingerprint,
    ruleVersion: BUSINESS_GOAL_RULE_VERSION, decisionRecordRef: decisionRef,
    createdBy: options.operator.id, createdAt: options.decidedAt,
  };
  const decision: DecisionRecord = {
    decisionId, decisionType: 'business_content_goal', subjectRef: goalRef, version: 1,
    outcome: status === 'ready' ? 'accepted' : 'blocked', ruleVersion: BUSINESS_GOAL_RULE_VERSION,
    inputRefs, inputFingerprint: fingerprint, evidence, blockers,
    impacts: [], output: goalRef, operator: options.operator, decidedAt: options.decidedAt,
  };
  return { goal, decision };
}
