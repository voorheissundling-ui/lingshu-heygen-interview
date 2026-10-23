import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateHeyGenPresenterRecord,
  validatePublicHeyGenPresenterRecord,
  type PublicHyGenPresenterRecord,
} from '../server/lib/presenterAssetTrust.js';

const now = new Date('2026-10-23T00:00:00Z');
const avatarId = 'ee25a2363ef941a1b5b0f7b1172e57d1';
const voiceId = 'c5e71f9038a2419d9d43c7132c31fe49';

function publicRecord(overrides: Partial<PublicHyGenPresenterRecord> = {}): PublicHyGenPresenterRecord {
  return {
    id: 'presenter-public-1',
    ownership: 'public',
    assetVersion: 1,
    avatarId,
    voiceId,
    publicCatalogRef: `https://api.heygen.com/v3/avatars/looks/${avatarId}`,
    providerTermsRef: 'https://www.heygen.com/terms',
    verifiedAt: '2026-10-22T12:00:00Z',
    accountId: 'acct_123456',
    ...overrides,
  };
}

function cloneRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'presenter-clone-1',
    authorized: true,
    assetVersion: 1,
    avatarId,
    voiceId,
    rightsEvidence: {
      authorizationRef: 'document://rights/1',
      consentRef: 'consent://subject/1',
      grantedAt: '2026-01-01T00:00:00Z',
      subjectAdultConfirmed: true,
      permittedProviders: ['heygen'],
      permittedUses: ['digital_presenter', 'voice_synthesis'],
    },
    ...overrides,
  };
}

test('public presenter path accepts a recent public catalog and terms reference', () => {
  const result = validatePublicHeyGenPresenterRecord(publicRecord(), now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.avatarId, avatarId);
  assert.equal(result.voiceId, voiceId);
  assert.equal(result.evidence.ownership, 'public');
  assert.equal(result.evidence.providerTermsRef, 'https://www.heygen.com/terms');
  assert.equal(result.evidence.accountId, 'acct_123456');
  assert.equal('consentRef' in result.evidence, false);
  assert.equal('authorizationRef' in result.evidence, false);
});

test('public presenter path requires a catalog reference', () => {
  const result = validatePublicHeyGenPresenterRecord(publicRecord({publicCatalogRef: ''}), now);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reasons.includes('public_catalog_ref_invalid'));
});

test('public catalog URL must identify the same avatar', () => {
  const result = validatePublicHeyGenPresenterRecord(publicRecord({
    publicCatalogRef: 'https://api.heygen.com/v3/avatars/looks/ffffffffffffffffffffffffffffffff',
  }), now);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.reasons.includes('public_catalog_ref_avatar_mismatch'));
});

test('public presenter path accepts a hashed catalog response reference', () => {
  const result = validatePublicHeyGenPresenterRecord(publicRecord({
    publicCatalogRef: `heygen-public-catalog:${'a'.repeat(64)}`,
  }), now);
  assert.equal(result.ok, true);
});

test('public presenter path requires provider terms and account identity', () => {
  const terms = validatePublicHeyGenPresenterRecord(publicRecord({providerTermsRef: ''}), now);
  assert.equal(terms.ok, false);
  if (!terms.ok) assert.ok(terms.reasons.includes('provider_terms_ref_invalid'));

  const account = validatePublicHeyGenPresenterRecord(publicRecord({accountId: ''}), now);
  assert.equal(account.ok, false);
  if (!account.ok) assert.ok(account.reasons.includes('provider_account_id_invalid'));
});

test('public presenter verification must be recent and not in the future', () => {
  const stale = validatePublicHeyGenPresenterRecord(publicRecord({verifiedAt: '2026-10-01T00:00:00Z'}), now);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.ok(stale.reasons.includes('public_catalog_verification_stale'));

  const future = validatePublicHeyGenPresenterRecord(publicRecord({verifiedAt: '2026-10-24T00:00:00Z'}), now);
  assert.equal(future.ok, false);
  if (!future.ok) assert.ok(future.reasons.includes('public_catalog_verified_at_invalid'));
});

test('public presenter path rejects private ownership', () => {
  const result = validatePublicHeyGenPresenterRecord(publicRecord({ownership: 'private'}), now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reasons.includes('public_ownership_required'));
});

test('clone path remains unchanged and rejects a missing subject consent', () => {
  const withoutConsent = cloneRecord();
  delete (withoutConsent.rightsEvidence as Record<string, unknown>).consentRef;
  const result = validateHeyGenPresenterRecord(withoutConsent as any, now);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.reasons.includes('subject_consent_ref_invalid'));
});

test('clone path still accepts complete authorization and consent evidence', () => {
  const result = validateHeyGenPresenterRecord(cloneRecord() as any, now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rights.consentRef, 'consent://subject/1');
});

test('public records cannot bypass the clone consent gate', () => {
  const result = validateHeyGenPresenterRecord(publicRecord() as any, now);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasons.includes('presenter_not_authorized'));
    assert.ok(result.reasons.includes('subject_consent_ref_invalid'));
  }
});
