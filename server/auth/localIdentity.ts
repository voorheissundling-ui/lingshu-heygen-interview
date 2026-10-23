import { issueLocalDemoToken, isLocalDemoAuthorization, verifyLocalDemoToken } from './localDemoToken.js';
import { localAccountRecordsFile, readLocalAccountRecords, type LocalStoredAccount } from '../lib/localAccountStore.js';
import { getLocalTenant } from '../lib/localTenants.js';
import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import type { OrganizationRole } from '../lib/organizationRole.js';

const ORGANIZATION_ROLES = new Set<OrganizationRole>([
  'super_admin',
  'admin',
  'social_operator',
  'customer_service',
]);

export interface VerifiedLocalIdentity {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  accountType: LocalStoredAccount['accountType'];
  role: OrganizationRole | null;
}

const testPrincipals = new Map<string, VerifiedLocalIdentity>();

function principalKey(userId: string, tenantId: string): string {
  return `${userId}\0${tenantId}`;
}

function verifiedAccount(account: LocalStoredAccount): VerifiedLocalIdentity | null {
  const tenant = getLocalTenant(account.tenantId);
  const role = ORGANIZATION_ROLES.has(account.role as OrganizationRole)
    ? account.role as OrganizationRole
    : null;
  if (!tenant || !account.userId || !account.tenantId || !account.email) return null;
  return {
    userId: account.userId,
    tenantId: account.tenantId,
    email: account.email.trim().toLowerCase(),
    name: account.name,
    accountType: account.accountType,
    role,
  };
}

export function verifyLocalIdentity(authorization: string | undefined): VerifiedLocalIdentity | null {
  if (!localFallbacksEnabled()) return null;
  const claims = verifyLocalDemoToken(authorization);
  if (!claims) return null;
  const account = readLocalAccountRecords(localAccountRecordsFile())
    .find(candidate => candidate.userId === claims.sub && candidate.tenantId === claims.tenantId);
  if (account) {
    const verified = verifiedAccount(account);
    if (verified) return verified;
  }
  if (process.env.NODE_ENV === 'test') {
    return testPrincipals.get(principalKey(claims.sub, claims.tenantId)) ?? null;
  }
  return null;
}

export function issueVerifiedLocalIdentityToken(identity: { userId: string; tenantId: string }): string {
  return issueLocalDemoToken(identity);
}

/** Register an isolated test authority and return a normally signed token. */
export function issueLocalIdentityTokenForTest(
  identity: Omit<Partial<VerifiedLocalIdentity>, 'role' | 'accountType'> & {
    userId: string;
    tenantId: string;
    role?: string;
    accountType?: string;
  },
  options: { nowMs?: number; ttlSeconds?: number; jti?: string } = {},
): string {
  if (process.env.NODE_ENV !== 'test') throw new Error('local_identity_test_issuer_forbidden');
  const principal: VerifiedLocalIdentity = {
    userId: identity.userId,
    tenantId: identity.tenantId,
    email: identity.email || `${identity.userId}@example.test`,
    name: identity.name || identity.userId,
    accountType: ['customer', 'trial', 'admin'].includes(String(identity.accountType))
      ? identity.accountType as LocalStoredAccount['accountType']
      : 'customer',
    role: ORGANIZATION_ROLES.has(identity.role as OrganizationRole)
      ? identity.role as OrganizationRole
      : null,
  };
  testPrincipals.set(principalKey(principal.userId, principal.tenantId), principal);
  return issueLocalDemoToken(principal, options);
}

export function clearLocalIdentityPrincipalsForTest(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('local_identity_test_registry_forbidden');
  testPrincipals.clear();
}

export { isLocalDemoAuthorization };
