import assert from 'node:assert/strict';
import test from 'node:test';
import type {DataStore, ListQuery, ListResult} from '../server/storage/datastore.js';
import {validatePublicHeyGenPresenterRecord} from '../server/lib/presenterAssetTrust.js';
import {productionBillingAccountRef} from '../server/starter198/socialContentProductionBudgetRoutes.js';
import {buildPublicPresenterRecord} from '../server/starter198/socialContentHeyGenBridge.js';
import {
  HEYGEN_VIDEO_BILLING_BASE,
  createAdoptionOnlyTransport,
  ensurePublicPresenterRecord,
  isStep5LiveBridgeEnabled,
  prepareStep5LiveAdoption,
} from './step5LiveBridge.js';

class MemoryStore implements DataStore {
  rows = new Map<string, Map<string, Record<string, unknown> & {id: string}>>();
  private sequence = 0;
  private collection(name: string) {
    let collection = this.rows.get(name);
    if (!collection) { collection = new Map(); this.rows.set(name, collection); }
    return collection;
  }
  async getById<T>(collection: string, id: string): Promise<T | null> {
    return (this.collection(collection).get(id) as T | undefined) ?? null;
  }
  async create<T>(collection: string, data: Record<string, unknown>): Promise<T | null> {
    const target = this.collection(collection);
    const id = String(data.id || `row${String(++this.sequence).padStart(12, '0')}`).slice(0, 15);
    if (target.has(id)) return null;
    const row = {...data, id} as Record<string, unknown> & {id: string};
    target.set(id, row);
    return row as T;
  }
  async update(collection: string, id: string, data: Record<string, unknown>): Promise<boolean> {
    const target = this.collection(collection);
    const prior = target.get(id);
    if (!prior) return false;
    target.set(id, {...prior, ...data, id});
    return true;
  }
  async delete(collection: string, id: string): Promise<boolean> {
    return this.collection(collection).delete(id);
  }
  async list<T>(collection: string, query: ListQuery = {}): Promise<ListResult<T>> {
    const items = [...this.collection(collection).values()].filter(row => (
      Object.entries(query.where || {}).every(([key, value]) => row[key] === value)
    ));
    const page = query.page || 1;
    const perPage = query.perPage || 20;
    return {
      items: items.slice((page - 1) * perPage, page * perPage) as T[], totalItems: items.length,
      totalPages: Math.ceil(items.length / perPage), page, perPage,
    };
  }
}

const credentialSha256 = 'a'.repeat(64);
const accountRef = productionBillingAccountRef('heygen', HEYGEN_VIDEO_BILLING_BASE, credentialSha256);
const verifiedAt = new Date().toISOString();

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    ownership: 'public' as const,
    publicCatalogRef: 'https://api.heygen.com/v3/avatars/looks/avatar_public_1',
    providerTermsRef: 'https://www.heygen.com/terms',
    verifiedAt, accountId: accountRef,
    ...overrides,
  };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hook', script: 'Hello.', requestId: 'req-1', videoId: 'video-existing-1',
    durationSeconds: 3.21306, mediaSha256: 'b'.repeat(64), mediaBytes: 961494,
    avatarId: 'avatar_public_1', voiceId: 'voice_public_1',
    publicEvidence: evidence(),
    ...overrides,
  };
}

test('adoption-only transport rejects every write method', async () => {
  let forwarded = 0;
  const base = (async () => {
    forwarded += 1;
    return new Response('{}');
  }) as unknown as typeof fetch;
  const transport = createAdoptionOnlyTransport(base);
  await assert.rejects(
    transport('https://api.heygen.com/v3/videos', {method: 'POST', body: '{}'}),
    /step5_adoption_only_no_new_submission/,
  );
  assert.equal(forwarded, 0);
  await transport('https://api.heygen.com/v3/videos/x');
  assert.equal(forwarded, 1);
});

test('live bridge is only enabled by real mode plus a loaded key', () => {
  assert.equal(isStep5LiveBridgeEnabled({}), false);
  assert.equal(isStep5LiveBridgeEnabled({INTERVIEW_REAL_MODE: '1'}), false);
  assert.equal(isStep5LiveBridgeEnabled({HEYGEN_API_KEY: 'k'}), false);
  assert.equal(isStep5LiveBridgeEnabled({INTERVIEW_REAL_MODE: '1', HEYGEN_API_KEY: 'k'}), true);
});

test('public presenter record carries catalog evidence but never clone consent', () => {
  const record = buildPublicPresenterRecord(evidence(), 'avatar_public_1', 'voice_public_1');
  assert.equal(record.ownership, 'public');
  assert.equal(record.publicCatalogRef, evidence().publicCatalogRef);
  assert.equal('authorizationRef' in record, false);
  assert.equal('consentRef' in record, false);
  const fresh = validatePublicHeyGenPresenterRecord(record, new Date());
  assert.equal(fresh.ok, true);
  const stale = validatePublicHeyGenPresenterRecord(
    {...record, verifiedAt: '2026-01-01T00:00:00.000Z'}, new Date('2026-10-23T00:00:00.000Z'));
  assert.equal(stale.ok, false);
  assert.ok(stale.ok === false && stale.reasons.includes('public_catalog_verification_stale'));
});

test('registry upsert keeps other presenters and replaces only the public one', async () => {
  const store = new MemoryStore();
  await store.create('studio_production_defaults', {
    tenant_id: 't',
    payload: {
      defaultPresenterId: 'presenter-other',
      presenters: [{id: 'presenter-other', authorized: true, avatarId: 'x', voiceId: 'y'}],
    },
  });
  const record = buildPublicPresenterRecord(evidence(), 'avatar_public_1', 'voice_public_1');
  await ensurePublicPresenterRecord(store, record);
  await ensurePublicPresenterRecord(store, {...record, verifiedAt});
  const rows = await store.list<any>('studio_production_defaults', {where: {tenant_id: 't'}});
  assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0].payload.presenters.length, 2);
  assert.ok(rows.items[0].payload.presenters.some((item: any) => item.id === 'presenter-other'));
  assert.equal(rows.items[0].payload.presenters.filter((item: any) => item.id === record.id).length, 1);
  assert.equal(rows.items[0].payload.defaultPresenterId, 'presenter-other');
});

test('preparation rejects a key that belongs to a different provider account', async () => {
  const store = new MemoryStore();
  const env = {
    INTERVIEW_REAL_MODE: '1', HEYGEN_API_KEY: 'k'.repeat(32), INTERVIEW_CREDENTIAL_SHA256: credentialSha256,
  };
  await assert.rejects(
    prepareStep5LiveAdoption({
      store, sources: [source({publicEvidence: evidence({accountId: 'heygen:another-account'})})],
      avatarId: 'avatar_public_1', voiceId: 'voice_public_1',
      outputDirectory: 'unused', env, now: new Date(),
    }),
    /step5_credential_account_changed/,
  );
});

test('preparation resolves the public presenter through the original bridge', async () => {
  const store = new MemoryStore();
  const env = {
    INTERVIEW_REAL_MODE: '1', HEYGEN_API_KEY: 'k'.repeat(32), INTERVIEW_CREDENTIAL_SHA256: credentialSha256,
  };
  const prepared = await prepareStep5LiveAdoption({
    store, sources: [source(), source({id: 'capabilities', requestId: 'req-2', videoId: 'video-existing-2'})],
    avatarId: 'avatar_public_1', voiceId: 'voice_public_1',
    outputDirectory: 'unused', env, now: new Date(),
  });
  assert.equal(prepared.presenter.ownership, 'public');
  assert.equal(prepared.presenter.providerPresenterId, 'avatar_public_1');
  assert.equal(prepared.counters.newPaidSubmissions, 0);
  assert.equal(prepared.counters.newChargedCny, 0);
  assert.equal(prepared.accountRef, accountRef);
  const rows = await store.list<any>('studio_production_defaults', {where: {tenant_id: 't'}});
  assert.equal(rows.items.length, 1);
  const record = rows.items[0].payload.presenters[0];
  assert.equal(record.ownership, 'public');
  assert.equal('authorizationRef' in record, false);
  assert.equal('consentRef' in record, false);
});
