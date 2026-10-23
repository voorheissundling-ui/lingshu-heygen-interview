import { createPublicKey, verify } from 'node:crypto';
import { socialRequestHash } from '../starter198/socialContentValidation.js';
import type { SamplePolicyScope, SamplePolicyTerms } from './weeklySamplePolicyEvidence.js';

/** Cryptographic primitive only. No issuer is provisioned for production.
 * A caller-supplied key is not authority: trust roots must be provisioned
 * independently of the enterprise, uploader, reviewer and request body. */
export interface SignedSamplePolicy {
  kind: 'weekly-sample-policy-attestation.v1';
  issuerId: string;
  keyId: string;
  policyId: string;
  scope: SamplePolicyScope;
  selectionHash: string;
  productId: string;
  productSku: string | null;
  enterpriseFactContentHash: string;
  frozenCtaHash: string;
  contactReceiptId: string;
  contactHash: string;
  sourceSha256: string;
  terms: SamplePolicyTerms;
  issuedAt: string;
  signatureBase64: string;
}

export interface SignedSamplePolicyContext {
  scope: SamplePolicyScope;
  selectionHash: string;
  productId: string;
  productSku: string | null;
  enterpriseFactContentHash: string;
  frozenCtaHash: string;
  contactReceiptId: string;
  contactHash: string;
  targetMarket: string;
  customerType: string;
}

export interface PreprovisionedPolicyTrustRoot {
  issuerId: string;
  keyId: string;
  publicKeyPem: string;
  tenantId: string;
}

function validTerms(terms: SamplePolicyTerms, nowMs: number) {
  return terms?.sampleFeeCny === 0
    && Number.isSafeInteger(terms.maximumFreeQuantity) && terms.maximumFreeQuantity > 0
    && ['seller', 'buyer'].includes(terms.shippingFeePayer)
    && ['seller', 'buyer'].includes(terms.customsDutyPayer)
    && Array.isArray(terms.eligibleMarkets) && terms.eligibleMarkets.length > 0
    && Array.isArray(terms.eligibleCustomerTypes) && terms.eligibleCustomerTypes.length > 0
    && [...terms.eligibleMarkets, ...terms.eligibleCustomerTypes].every(value => typeof value === 'string' && value.trim().length > 0)
    && Number.isFinite(Date.parse(terms.validFrom)) && Number.isFinite(Date.parse(terms.validUntil))
    && Date.parse(terms.validFrom) <= nowMs && nowMs < Date.parse(terms.validUntil);
}

/** Returns null on every missing, stale, ambiguous or invalid authority.
 * `isRevoked` must consult an independent *current* issuer revocation source;
 * a stored boolean or internal review ledger is not sufficient. This does not
 * verify live Meta ownership and must never be used alone for production. */
export async function verifyPreprovisionedSignedSamplePolicy(input: {
  policy: SignedSamplePolicy | null;
  context: SignedSamplePolicyContext;
  preprovisionedRoots: readonly PreprovisionedPolicyTrustRoot[];
  isRevoked: (issuerId: string, policyId: string, keyId: string) => Promise<boolean | null>;
  now?: Date;
}): Promise<SignedSamplePolicy | null> {
  const { policy, context } = input;
  if (!policy || policy.kind !== 'weekly-sample-policy-attestation.v1') return null;
  const roots = input.preprovisionedRoots.filter(root => root.issuerId === policy.issuerId
    && root.keyId === policy.keyId && root.tenantId === context.scope.tenantId);
  if (roots.length !== 1) return null;
  const fields = ['scope', 'selectionHash', 'productId', 'productSku', 'enterpriseFactContentHash',
    'frozenCtaHash', 'contactReceiptId', 'contactHash'] as const;
  if (fields.some(field => socialRequestHash(policy[field]) !== socialRequestHash(context[field]))) return null;
  const nowMs = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(Date.parse(policy.issuedAt))
    || Date.parse(policy.issuedAt) > nowMs || !validTerms(policy.terms, nowMs)
    || !context.targetMarket || !context.customerType
    || !policy.terms.eligibleMarkets.includes(context.targetMarket)
    || !policy.terms.eligibleCustomerTypes.includes(context.customerType)
    || !/^[a-f0-9]{64}$/.test(policy.sourceSha256)
    || !policy.policyId || !policy.contactReceiptId || !policy.contactHash
    || !/^[a-f0-9]{64}$/.test(policy.selectionHash)
    || !/^[a-f0-9]{64}$/.test(policy.frozenCtaHash)) return null;
  try {
    const { signatureBase64, ...body } = policy;
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64 || !verify(null, Buffer.from(socialRequestHash(body)),
      createPublicKey(roots[0]!.publicKeyPem), signature)) return null;
    // Fail closed if the independent revocation source is unreachable/unknown.
    if (await input.isRevoked(policy.issuerId, policy.policyId, policy.keyId) !== false) return null;
    return policy;
  } catch {
    return null;
  }
}
