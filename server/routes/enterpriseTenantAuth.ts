import type { AuthLocals } from '../middleware/auth.js';

export function authenticatedTenantId(res: { locals: Record<string, unknown> }): string | null {
  const tenantId = (res.locals as unknown as Partial<AuthLocals>).tenantId;
  return typeof tenantId === 'string' && tenantId ? tenantId : null;
}
