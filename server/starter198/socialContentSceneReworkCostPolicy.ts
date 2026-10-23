import type { Record_ } from '../storage/datastore.js';
import type { Starter198Repository } from './repository.js';
import type { SocialSceneReworkIntent } from './socialContentSceneRework.js';
import type { StoredSocialSceneCache } from './socialContentSceneReworkService.js';
import { createSocialSceneReworkService } from './socialContentSceneReworkService.js';
import { socialJson, socialObject, socialRequestHash } from './socialContentValidation.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

export const SCENE_REWORK_COST_POLICIES = 'starter_social_scene_rework_cost_policies';
export const LOCAL_SCENE_REWORK_STRATEGIES = new Set([
  'customer_real_asset', 'licensed_stock_asset', 'motion_graphics', 'verified_fact_card',
]);

export interface SceneReworkCostScope {
  tenantId: string; taskId: string; runId: string; operationId: string; actorUserId: string;
}
export interface SceneReworkRouteQuote {
  type: 'scene_rework_route_quote'; version: 1; tenantId: string; taskId: string;
  executionRunId: string; operationId: string; cacheHash: string; planHash: string;
  provider: 'qwen_image'; model: string; sceneIds: string[]; operationsPerScene: 1;
  imagesPerOperation: 1; maximumCostCnyPerImage: number; totalUpperBoundCny: number;
  maximumOriginalBudgetCny: number; tariffSourceRef: string; tariffVersion: string;
  validUntil: string; recordHash: string;
}
export interface SceneReworkCostPolicy {
  type: 'scene_rework_cost_policy'; version: 1; scope: SceneReworkCostScope;
  quote: SceneReworkRouteQuote; authorizedMaximumCostCny: number; confirmedAt: string; recordHash: string;
}
export interface SceneReworkQuoteEvidence {
  localOnly: boolean; quote: SceneReworkRouteQuote | null; gaps: string[];
}

type VerifiedActual = StoredSocialSceneCache & { intent: SocialSceneReworkIntent };
const fail = (code: string): never => { throw new Error(code); };
export function sceneReworkExceedsOriginalInternalBudget(
  tenantId: string, amountCny: number, maximumOriginalBudgetCny: number,
): boolean {
  return !isInternalBudgetExemptTenant(tenantId) && amountCny > maximumOriginalBudgetCny;
}

/** Calculate a quote only from cache, plan, receipts and handoff verified by the server. */
async function quoteVerified(store: NonNullable<Starter198Repository['dataStore']>, env: NodeJS.ProcessEnv,
  scope: SceneReworkCostScope, actual: VerifiedActual): Promise<SceneReworkQuoteEvidence> {
  if (actual.intent.tenantId !== scope.tenantId || actual.intent.taskId !== scope.taskId
    || actual.intent.executionRunId !== scope.runId || actual.intent.operationId !== scope.operationId
    || actual.intent.actorUserId !== scope.actorUserId) fail('scene_rework_cost_scope_invalid');
  const selected = actual.plan.shots.map((shot, index) => ({ shot, sceneId: actual.baseline.scenes[index]?.sceneId }))
    .filter(item => typeof item.sceneId === 'string' && actual.intent.affectedSceneIds.includes(item.sceneId));
  const routes = (shot: typeof actual.plan.shots[number]) => [shot.sourceStrategy,
    ...(shot.fallbackSourceStrategy ? [shot.fallbackSourceStrategy] : [])];
  if (selected.length !== actual.intent.affectedSceneIds.length) {
    return { localOnly: false, quote: null, gaps: ['scene_rework_route_pricing_not_supported'] };
  }
  const allRoutes = selected.flatMap(item => routes(item.shot));
  const localOnly = allRoutes.length > 0 && allRoutes.every(route => LOCAL_SCENE_REWORK_STRATEGIES.has(route));
  if (localOnly) return { localOnly: true, quote: null, gaps: [] };
  const allowed = new Set([...LOCAL_SCENE_REWORK_STRATEGIES, 'non_evidentiary_ai_visual']);
  const paid = selected.filter(item => routes(item.shot).includes('non_evidentiary_ai_visual'));
  if (!paid.length || allRoutes.some(route => !allowed.has(route))
    || actual.cache.scenes.filter(scene => paid.some(item => item.sceneId === scene.sceneId))
      .some(scene => scene.result.asset.type !== 'image')) {
    return { localOnly: false, quote: null, gaps: ['scene_rework_route_pricing_not_supported'] };
  }
  const model = (env.QWEN_IMAGE_MODEL || 'qwen-image-3.0').trim();
  const priceRaw = env.SCENE_REWORK_QWEN_MAX_BILLED_CNY_PER_IMAGE;
  const maximumCostCnyPerImage = priceRaw === undefined ? NaN : Number(priceRaw);
  const tariffSourceRef = String(env.SCENE_REWORK_QWEN_TARIFF_SOURCE_REF || '').trim();
  const tariffVersion = String(env.SCENE_REWORK_QWEN_TARIFF_VERSION || '').trim();
  const validUntil = String(env.SCENE_REWORK_QWEN_TARIFF_VALID_UNTIL || '');
  if (env.SCENE_REWORK_QWEN_TARIFF_MODEL !== model || !priceRaw?.trim()
    || !Number.isFinite(maximumCostCnyPerImage) || maximumCostCnyPerImage < 0
    || !tariffSourceRef || !tariffVersion || !Number.isFinite(Date.parse(validUntil))
    || Date.parse(validUntil) <= Date.now()) {
    return { localOnly: false, quote: null, gaps: ['scene_rework_trusted_tariff_upper_bound_missing'] };
  }
  const handoffs = await store.list<Record_>('starter_social_production_handoffs', { where: {
    tenant_id: scope.tenantId, handoff_id: actual.handoffId, handoff_version: actual.handoffVersion,
  }, perPage: 2 });
  const handoff = socialObject(socialJson(handoffs.items[0]?.payload));
  const maximumOriginalBudgetCny = socialObject(handoff?.executionPlan)?.budgetLimitCny;
  const totalUpperBoundCny = Math.ceil(maximumCostCnyPerImage * paid.length * 100) / 100;
  if (handoffs.totalItems !== 1 || typeof maximumOriginalBudgetCny !== 'number'
    || !Number.isFinite(maximumOriginalBudgetCny)
    || sceneReworkExceedsOriginalInternalBudget(scope.tenantId, totalUpperBoundCny, maximumOriginalBudgetCny)) {
    return { localOnly: false, quote: null, gaps: ['scene_rework_original_budget_upper_bound_required'] };
  }
  const value = { type: 'scene_rework_route_quote' as const, version: 1 as const,
    tenantId: scope.tenantId, taskId: scope.taskId, executionRunId: scope.runId,
    operationId: scope.operationId, cacheHash: actual.intent.cacheHash, planHash: actual.intent.planHash,
    provider: 'qwen_image' as const, model, sceneIds: paid.map(item => String(item.sceneId)).sort(),
    operationsPerScene: 1 as const, imagesPerOperation: 1 as const, maximumCostCnyPerImage,
    maximumOriginalBudgetCny, totalUpperBoundCny, tariffSourceRef, tariffVersion, validUntil };
  return { localOnly: false, quote: { ...value, recordHash: socialRequestHash(value) }, gaps: [] };
}

export function createSocialSceneReworkCostPolicyService(repository: Starter198Repository,
  env: NodeJS.ProcessEnv = process.env) {
  const store = repository.dataStore;
  if (!store) return fail('scene_rework_cost_store_required');
  async function saved(scope: SceneReworkCostScope) {
    const rows = await store!.list<Record_>(SCENE_REWORK_COST_POLICIES,
      { where: { tenant_id: scope.tenantId, operation_id: scope.operationId }, perPage: 2 });
    if (rows.totalItems !== rows.items.length || rows.items.length > 1) fail('scene_rework_cost_policy_ambiguous');
    if (!rows.items.length) return null;
    const row = rows.items[0]!;
    const payload = socialObject(socialJson(row.payload)) as unknown as SceneReworkCostPolicy | null;
    if (!payload || row.content_hash !== socialRequestHash(payload)
      || socialRequestHash(payload.scope) !== socialRequestHash(scope)) fail('scene_rework_cost_policy_corrupt');
    const policy = payload!;
    const { recordHash, ...value } = policy;
    if (!policy.quote) fail('scene_rework_cost_policy_corrupt');
    const { recordHash: quoteHash, ...quoteBody } = policy.quote;
    if (recordHash !== socialRequestHash(value) || policy.quote.type !== 'scene_rework_route_quote'
      || policy.quote.version !== 1 || quoteHash !== socialRequestHash(quoteBody)
      || policy.quote.tenantId !== scope.tenantId || policy.quote.taskId !== scope.taskId
      || policy.quote.executionRunId !== scope.runId || policy.quote.operationId !== scope.operationId
      || !Number.isFinite(policy.authorizedMaximumCostCny)
      || policy.authorizedMaximumCostCny < policy.quote.totalUpperBoundCny
      || sceneReworkExceedsOriginalInternalBudget(scope.tenantId, policy.authorizedMaximumCostCny,
        policy.quote.maximumOriginalBudgetCny)) fail('scene_rework_cost_policy_corrupt');
    return policy;
  }
  const prepared = (scope: SceneReworkCostScope, actual: VerifiedActual) => quoteVerified(store!, env, scope, actual);
  async function confirmEvidence(scope: SceneReworkCostScope, actual: VerifiedActual,
    input: { expectedQuoteHash: string; authorizedMaximumCostCny: number }) {
    const evidence = await prepared(scope, actual);
    if (!evidence.quote) fail(evidence.gaps[0] ?? 'scene_rework_cost_confirmation_not_required');
    const quote = evidence.quote!;
    if (quote.recordHash !== input.expectedQuoteHash || !Number.isFinite(input.authorizedMaximumCostCny)
      || input.authorizedMaximumCostCny < quote.totalUpperBoundCny
      || sceneReworkExceedsOriginalInternalBudget(scope.tenantId, input.authorizedMaximumCostCny,
        quote.maximumOriginalBudgetCny)) fail('scene_rework_cost_confirmation_invalid');
    const existing = await saved(scope);
    if (existing) {
      if (existing.quote.recordHash !== input.expectedQuoteHash
        || existing.authorizedMaximumCostCny !== input.authorizedMaximumCostCny) fail('scene_rework_cost_policy_immutable');
      return existing;
    }
    const value = { type: 'scene_rework_cost_policy' as const, version: 1 as const, scope: { ...scope },
      quote, authorizedMaximumCostCny: input.authorizedMaximumCostCny,
      confirmedAt: new Date().toISOString() };
    const policy = { ...value, recordHash: socialRequestHash(value) };
    const recordId = socialRequestHash([scope.tenantId, scope.operationId]).slice(0, 15);
    try {
      const row = await store!.create(SCENE_REWORK_COST_POLICIES, { id: recordId, tenant_id: scope.tenantId,
        operation_id: scope.operationId, content_hash: socialRequestHash(policy), payload: policy });
      if (!row) fail('scene_rework_cost_policy_save_failed');
      return policy;
    } catch (error) {
      const recovered = await saved(scope);
      if (recovered?.quote.recordHash === input.expectedQuoteHash
        && recovered.authorizedMaximumCostCny === input.authorizedMaximumCostCny) return recovered;
      throw error;
    }
  }
  async function requireEvidence(scope: SceneReworkCostScope, actual: VerifiedActual) {
    const evidence = await prepared(scope, actual);
    const policy = await saved(scope);
    if (!policy || !evidence.quote || policy.quote.recordHash !== evidence.quote.recordHash) {
      throw new Error('scene_rework_cost_policy_confirmation_required');
    }
    return policy;
  }
  const actualForJob = (scope: SceneReworkCostScope): Promise<VerifiedActual> =>
    createSocialSceneReworkService(repository).readForJob(scope);
  return {
    readConfirmedRecord: saved, readPrepared: prepared, confirmPrepared: confirmEvidence,
    requirePreparedConfirmed: requireEvidence,
    async read(scope: SceneReworkCostScope) { const actual = await actualForJob(scope);
      return { ...await prepared(scope, actual), policy: await saved(scope) }; },
    async confirm(scope: SceneReworkCostScope, input: { expectedQuoteHash: string; authorizedMaximumCostCny: number }) {
      return confirmEvidence(scope, await actualForJob(scope), input);
    },
    async requireConfirmed(scope: SceneReworkCostScope) {
      return requireEvidence(scope, await actualForJob(scope));
    },
  };
}
