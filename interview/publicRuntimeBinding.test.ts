import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicHeyGenRuntimeRouteEvidence,
  readTrustedPublicHeyGenRuntimeBinding,
  type HeyGenRuntimeBindingPorts,
} from '../server/starter198/socialContentHeyGenRuntimeBinding.js';

const avatarId = 'ee25a2363ef941a1b5b0f7b1172e57d1';
const voiceId = 'c5e71f9038a2419d9d43c7132c31fe49';

function presenter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'presenter-public-storyboard',
    ownership: 'public',
    assetVersion: 1,
    avatarId,
    voiceId,
    publicCatalogRef: `https://api.heygen.com/v3/avatars/looks/${avatarId}`,
    providerTermsRef: 'https://www.heygen.com/terms',
    verifiedAt: new Date(Date.now() - 60_000).toISOString(),
    accountId: 'heygen:test-account',
    ...overrides,
  };
}

function ports(record: Record<string, unknown> = presenter(), live: {
  look?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
} = {}): HeyGenRuntimeBindingPorts & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    store: {
      list: async () => ({
        items: [{ tenant_id: 't', payload: { presenters: [record] } }],
        totalItems: 1,
      }),
    } as any,
    env: () => ({ HEYGEN_API_KEY: 'test-runtime-key' }),
    readProvider: async (url: string) => {
      reads.push(url);
      if (url.includes('/avatars/looks/')) return { data: {
        id: avatarId, status: 'completed', avatar_type: 'photo_avatar',
        supported_api_engines: ['avatar_v', 'avatar_iv'],
        ...live.look,
      } };
      if (url.includes('/voices/')) return { data: {
        voice_id: voiceId, language: 'English', status: 'complete',
        ...live.voice,
      } };
      return { data: {
        billing_type: 'wallet',
        wallet: {
          currency: 'usd', remaining_balance: 2.3, auto_reload: { enabled: false },
          ...live.wallet,
        },
      } };
    },
  };
}

test('public runtime binding keeps catalog/terms evidence and never invents clone consent', async () => {
  const p = ports();
  const binding = await readTrustedPublicHeyGenRuntimeBinding({
    tenantId: 't', presenterAssetId: 'presenter-public-storyboard', language: 'en',
  }, p);
  assert.ok(binding);
  assert.equal(binding.model, 'avatar_iv');
  assert.equal(binding.avatarId, avatarId);
  assert.equal(binding.voiceId, voiceId);
  assert.equal(binding.publicEvidence.ownership, 'public');
  assert.equal('authorizationRef' in binding, false);
  assert.equal('consentRef' in binding, false);
  assert.equal('consentRef' in binding.publicEvidence, false);
  assert.match(binding.publicEvidence.accountId, /^heygen:[a-f0-9]{64}$/);
  assert.match(publicHeyGenRuntimeRouteEvidence(binding), /^heygen-approved-public-person:/);
  assert.equal(publicHeyGenRuntimeRouteEvidence(binding), publicHeyGenRuntimeRouteEvidence(binding));
  assert.deepEqual(p.reads.map(url => new URL(url).pathname).sort(), [
    `/v3/avatars/looks/${avatarId}`,
    `/v3/users/me`,
    `/v3/voices/${voiceId}`,
  ].sort());
});

test('public runtime binding rejects a presenter without public catalog evidence', async () => {
  const result = await readTrustedPublicHeyGenRuntimeBinding({
    tenantId: 't', presenterAssetId: 'presenter-public-storyboard',
  }, ports(presenter({ publicCatalogRef: '' })));
  assert.equal(result, null);
});

test('public runtime binding rejects a stale catalog verification', async () => {
  const result = await readTrustedPublicHeyGenRuntimeBinding({
    tenantId: 't', presenterAssetId: 'presenter-public-storyboard',
  }, ports(presenter({ verifiedAt: '2026-10-01T00:00:00Z' })));
  assert.equal(result, null);
});

test('public runtime binding rejects a live avatar without Avatar IV', async () => {
  const result = await readTrustedPublicHeyGenRuntimeBinding({
    tenantId: 't', presenterAssetId: 'presenter-public-storyboard',
  }, ports(presenter(), { look: { supported_api_engines: ['avatar_v'] } }));
  assert.equal(result, null);
});

test('public runtime binding rejects a voice language mismatch', async () => {
  const result = await readTrustedPublicHeyGenRuntimeBinding({
    tenantId: 't', presenterAssetId: 'presenter-public-storyboard', language: 'zh',
  }, ports());
  assert.equal(result, null);
});

test('public runtime binding rejects auto-reload or a non-USD wallet', async () => {
  const autoReload = await readTrustedPublicHeyGenRuntimeBinding({
    tenantId: 't', presenterAssetId: 'presenter-public-storyboard',
  }, ports(presenter(), { wallet: { auto_reload: { enabled: true } } }));
  assert.equal(autoReload, null);

  const currency = await readTrustedPublicHeyGenRuntimeBinding({
    tenantId: 't', presenterAssetId: 'presenter-public-storyboard',
  }, ports(presenter(), { wallet: { currency: 'cny' } }));
  assert.equal(currency, null);
});
