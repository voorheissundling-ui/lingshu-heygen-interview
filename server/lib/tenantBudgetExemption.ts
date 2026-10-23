/**
 * Exact tenant-scoped bypass for internal admission budgets.
 *
 * This does not change provider balances, entitlements, consent requirements,
 * authentication, or any other safety gate. Wildcards are deliberately
 * rejected so a local testing exception cannot silently become global.
 */
export function isInternalBudgetExemptTenant(
  tenantId: unknown,
  configuredIds = process.env.INTERNAL_BUDGET_EXEMPT_TENANT_IDS,
): boolean {
  if (typeof tenantId !== 'string' || !tenantId) return false;
  const exactIds = new Set(String(configuredIds || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => Boolean(value) && value !== '*'));
  return exactIds.has(tenantId);
}

/** Environment/runtime discovery may run before a request tenant exists. */
export function hasInternalBudgetExemptTenants(
  configuredIds = process.env.INTERNAL_BUDGET_EXEMPT_TENANT_IDS,
): boolean {
  return String(configuredIds || '')
    .split(',')
    .map(value => value.trim())
    .some(value => Boolean(value) && value !== '*');
}
