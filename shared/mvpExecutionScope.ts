/** Explicit opt-in scope; legacy executions without an MVP scope are unchanged. */
export interface MvpExecutionScope {
  tenantId: string;
  taskId: string;
  version: number;
  session: 'A' | 'B';
  /** Null explicitly binds media-only work with no selected publishing account. */
  accountId: string | null;
  productId: string;
  runId: string;
  action: 'generate_media';
  authority: 'customer' | 'authorized_business_reviewer';
  expiresAt: string;
  revoked: boolean;
  provider: string;
  model: string;
  shotIds: string[];
  authorizedBy: string;
  authorizationRef: string;
  budgetPoolId: string;
  budgetLimitCny: number;
}
export interface MvpBudgetPool {
  id: string;
  tenantId: string;
  taskId: string;
  session: 'A' | 'B';
  limitCny: number;
  spentCny: number;
  reservedCny: number;
}
/** Pool counters are server-owned totals across every request and version. */
export function assertMvpExecutionScope(input: {
  scope?: MvpExecutionScope;
  tenantId: string;
  taskId: string;
  version: number;
  session: 'A' | 'B';
  accountId: string | null;
  productId: string;
  runId: string;
  action: string;
  now?: string;
  provider: string;
  model: string;
  shotId: string;
  estimatedCostCny: number;
  pool?: MvpBudgetPool;
}): void {
  const s = input.scope;
  if (!s) return;
  const strings = [s.tenantId, s.taskId, s.provider, s.model, s.authorizedBy, s.authorizationRef, s.budgetPoolId, s.productId, s.runId];
  if ((s.accountId !== null && (typeof s.accountId !== 'string' || !s.accountId.trim()))
    || strings.some(v => typeof v !== 'string' || !v.trim()) || !Number.isSafeInteger(s.version) || s.version < 1
    || !Array.isArray(s.shotIds) || !s.shotIds.length || s.shotIds.some(v => typeof v !== 'string' || !v.trim())
    || new Set(s.shotIds).size !== s.shotIds.length) throw Error('mvp_scope_invalid');
  const expires = Date.parse(s.expiresAt);
  const now = input.now === undefined ? Date.now() : Date.parse(input.now);
  if (!Number.isFinite(expires) || !Number.isFinite(now) || s.revoked !== false || expires <= now
    || !['customer', 'authorized_business_reviewer'].includes(s.authority)) throw Error('mvp_authorization_invalid');
  if (s.action !== 'generate_media' || input.action !== s.action) throw Error('mvp_action_not_authorized');
  if (s.accountId !== input.accountId || s.productId !== input.productId || s.runId !== input.runId) throw Error('mvp_execution_authority_mismatch');
  if (s.tenantId !== input.tenantId || s.taskId !== input.taskId || s.version !== input.version
    || s.session !== input.session || s.provider !== input.provider || s.model !== input.model
    || !s.shotIds.includes(input.shotId)) throw Error('mvp_execution_authority_mismatch');
  const p = input.pool;
  if (!p || p.id !== s.budgetPoolId || p.tenantId !== s.tenantId || p.taskId !== s.taskId || p.session !== s.session)
    throw Error('mvp_budget_pool_scope_mismatch');
  if (![s.budgetLimitCny, p.limitCny, p.spentCny, p.reservedCny, input.estimatedCostCny].every(v => Number.isFinite(v) && v >= 0)
    || s.budgetLimitCny !== p.limitCny || p.limitCny <= 0) throw Error('mvp_budget_invalid');
  if (p.spentCny + p.reservedCny + input.estimatedCostCny > p.limitCny) throw Error('mvp_budget_exceeded');
}
