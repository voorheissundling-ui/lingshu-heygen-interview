import { isIP } from 'node:net';
import type { WeeklySamplePolicyAuthority } from './weeklySamplePolicyEvidence.js';

type Provision = { issuerId: string; keyId: string; tenantId: string; publicKeyPem: string; revocationUrl: string };

/** Operator-only independent issuer configuration. No key, URL or issuer is
 * read from a tenant profile, PDF, intervention request or signed policy row.
 * An absent/malformed configuration leaves the production gate closed. */
export function provisionedWeeklySamplePolicyAuthority(): WeeklySamplePolicyAuthority | null {
  const raw = process.env.WEEKLY_SAMPLE_POLICY_TRUST_CONFIG_JSON;
  if (!raw) return null;
  try {
    const provisions = JSON.parse(raw) as Provision[];
    if (!Array.isArray(provisions) || !provisions.length || provisions.length > 20) return null;
    const seen = new Set<string>();
    for (const item of provisions) {
      if (!item || !item.issuerId || !item.keyId || !item.tenantId || !item.publicKeyPem || !item.revocationUrl) return null;
      const key = `${item.tenantId}\0${item.issuerId}\0${item.keyId}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const url = new URL(item.revocationUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || isIP(url.hostname) || url.hostname === 'localhost' || !url.hostname.includes('.')) return null;
    }
    return {
      roots: provisions.map(({ issuerId, keyId, tenantId, publicKeyPem }) => ({ issuerId, keyId, tenantId, publicKeyPem })),
      isRevoked: async (issuerId, policyId, keyId) => {
        const matches = provisions.filter(item => item.issuerId === issuerId && item.keyId === keyId);
        if (matches.length !== 1 || !policyId || policyId.length > 200) return null;
        const url = new URL(matches[0]!.revocationUrl);
        url.searchParams.set('policyId', policyId);
        const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store',
          headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json') return null;
        const body = await response.json() as Record<string, unknown>;
        if (body.issuerId !== issuerId || body.keyId !== keyId || body.policyId !== policyId
          || typeof body.revoked !== 'boolean') return null;
        return body.revoked;
      },
    };
  } catch { return null; }
}
