import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import type {DataStore, ListQuery, ListResult} from '../storage/datastore.js';
import {runWithContentExecutionContext} from '../contentExecution/context.js';
import {
  createSocialHeyGenBridgePorts,
  type PublicHeyGenPresenter,
  type SocialHeyGenAdoptionEvent,
  type SocialHeyGenAdoptionResult,
} from './socialContentHeyGenBridge.js';

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
    if (collection === 'durable_operation_leases') {
      const duplicate = [...target.values()].some(row => row.tenant_id === data.tenant_id
        && row.lease_scope === data.lease_scope && row.subject_id === data.subject_id);
      if (duplicate) return null;
    }
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
    let items = [...this.collection(collection).values()].filter(row => (
      Object.entries(query.where || {}).every(([key, value]) => row[key] === value)
    ));
    const page = query.page || 1;
    const perPage = query.perPage || 20;
    const totalItems = items.length;
    return {
      items: items.slice((page - 1) * perPage, page * perPage) as T[], totalItems,
      totalPages: Math.ceil(totalItems / perPage), page, perPage,
    };
  }
}

const materialFile = path.join(os.tmpdir(), `step5-adoption-materials-${randomUUID()}.json`);
process.env.MATERIAL_LIBRARY_FILE = materialFile;
test.after(() => { fs.rmSync(materialFile, {force: true}); });

function publicRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'presenter-public-test', ownership: 'public', assetVersion: 1,
    avatarId: 'avatar_public_1', voiceId: 'voice_public_1',
    publicCatalogRef: 'https://api.heygen.com/v3/avatars/looks/avatar_public_1',
    providerTermsRef: 'https://www.heygen.com/terms',
    verifiedAt: new Date().toISOString(), accountId: 'heygen:test-account',
    ...overrides,
  };
}

function presenter(): PublicHeyGenPresenter {
  return {
    presenterAssetId: 'presenter-public-test', providerId: 'heygen',
    providerPresenterId: 'avatar_public_1', providerVoiceId: 'voice_public_1',
    assetVersion: 1, ownership: 'public',
    publicEvidence: {
      ownership: 'public',
      publicCatalogRef: 'https://api.heygen.com/v3/avatars/looks/avatar_public_1',
      providerTermsRef: 'https://www.heygen.com/terms',
      verifiedAt: new Date().toISOString(), accountId: 'heygen:test-account',
    },
  };
}

function buildStore(record: Record<string, unknown> | null = null) {
  const store = new MemoryStore();
  if (record) {
    void store.create('studio_production_defaults', {tenant_id: 't', payload: {presenters: [record]}});
  }
  return store;
}

function buildPorts(store: MemoryStore, media: Buffer, options: {
  duration?: number; status?: 'completed' | 'pending' | 'failed'; error?: string;
} = {}) {
  const calls = {create: 0, status: 0, download: 0, upload: 0};
  const ports = createSocialHeyGenBridgePorts({
    store,
    client: {
      create: async () => { calls.create += 1; return 'should-not-create'; },
      status: async () => {
        calls.status += 1;
        const status = options.status || 'completed';
        if (status === 'failed') return {status, error: options.error || 'provider_failed'};
        if (status === 'pending') return {status};
        return {status, url: 'https://files2.heygen.ai/video.mp4', duration: options.duration ?? 3.2};
      },
    },
    budget: {
      status: () => ({allowed: false, remainingCny: null, reservationCny: 0, reason: 'adoption_only'}),
      reserve: async () => { throw new Error('must_not_reserve'); },
    },
    storageReady: () => true,
    download: async () => { calls.download += 1; return media; },
    upload: async () => { calls.upload += 1; },
    head: async () => ({size: media.length, contentType: 'video/mp4', etag: 'etag-1'}),
    pollIntervalMs: 0,
    maxPolls: 3,
  });
  return {ports, calls};
}

function adoptionInput(idempotencyKey: string, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 't', taskId: 'video', runId: 'run', shotId: 'hook', presenter: presenter(),
    idempotencyKey, adoptedProviderTaskId: 'video-existing-1', script: 'Hello from Step 4.',
    expectedDurationSeconds: 3.2, outputDirectory: path.join(os.tmpdir(), `step5-adopt-${randomUUID()}`),
    ...overrides,
  };
}

test('adoption takes over an existing video without creating a new provider task', async () => {
  const store = buildStore();
  const media = Buffer.alloc(12_000, 7);
  const {ports, calls} = buildPorts(store, media);
  const events: SocialHeyGenAdoptionEvent[] = [];
  const result = await ports.adoptProviderTask(adoptionInput('req-1', {
    expectedMediaSha256: createHash('sha256').update(media).digest('hex'),
    onProviderEvent: (event: SocialHeyGenAdoptionEvent) => { events.push(event); },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(calls.create, 0, 'adoption must never POST a new task');
  assert.ok(calls.status >= 1);
  assert.equal(calls.download, 1);
  assert.equal(calls.upload, 1);
  const rows = await store.list<any>('studio_social_presenter_jobs', {where: {tenant_id: 't'}});
  assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0].status, 'completed');
  assert.equal(rows.items[0].provider_task_id, 'video-existing-1');
  assert.equal(rows.items[0].visual_control.adoption, true);
  assert.ok(fs.existsSync(result.localPath!));
  assert.equal(events.some(event => event.state === 'downloaded'), true);
  assert.equal(events.some(event => event.state === 'completed'), true);
});

test('repeated adoption reuses the same row and still never creates a task', async () => {
  const store = buildStore();
  const media = Buffer.alloc(12_000, 3);
  const first = buildPorts(store, media).ports;
  const input = adoptionInput('req-repeat', {
    expectedMediaSha256: createHash('sha256').update(media).digest('hex'),
  });
  assert.equal((await first.adoptProviderTask(input)).status, 'completed');
  const second = buildPorts(store, media);
  assert.equal((await second.ports.adoptProviderTask(input)).status, 'completed');
  assert.equal(second.calls.create, 0);
  const rows = await store.list<any>('studio_social_presenter_jobs', {where: {tenant_id: 't'}});
  assert.equal(rows.items.length, 1);
});

test('adoption rejects a media hash mismatch without uploading', async () => {
  const store = buildStore();
  const {ports, calls} = buildPorts(store, Buffer.alloc(12_000, 1));
  const result = await ports.adoptProviderTask(adoptionInput('req-hash', {
    expectedMediaSha256: '0'.repeat(64),
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'provider_content_hash_mismatch');
  assert.equal(calls.create, 0);
  assert.equal(calls.upload, 0);
});

test('adoption rejects a provider duration that contradicts Step 4', async () => {
  const store = buildStore();
  const {ports, calls} = buildPorts(store, Buffer.alloc(12_000, 1), {duration: 9.9});
  const result = await ports.adoptProviderTask(adoptionInput('req-duration'));
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'provider_duration_mismatch');
  assert.equal(calls.download, 0);
  assert.equal(calls.create, 0);
});

test('adoption writes accepted and completed receipts inside the durable context', async () => {
  const store = buildStore();
  await store.create('content_execution_jobs', {
    id: 'job-1', tenant_id: 't', task_id: 'content', run_id: 'run', status: 'running',
    provider_receipts: [],
  });
  const media = Buffer.alloc(12_000, 5);
  const {ports} = buildPorts(store, media);
  await runWithContentExecutionContext({
    dataStore: store, jobId: 'job-1',
    action: () => ports.adoptProviderTask(adoptionInput('req-receipt', {
      expectedMediaSha256: createHash('sha256').update(media).digest('hex'),
    })),
  });
  const job = await store.getById<any>('content_execution_jobs', 'job-1');
  const receipts = job.provider_receipts.filter((item: any) => item.requestId === 'req-receipt');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'completed');
  assert.equal(receipts[0].providerTaskId, 'video-existing-1');
  assert.equal(receipts[0].metadata.adoption, true);
});

test('public presenter resolution requires public evidence and never invents consent', async () => {
  const store = buildStore(publicRecord());
  const {ports} = buildPorts(store, Buffer.alloc(12_000, 1));
  const resolved = await ports.resolvePublicPresenter({tenantId: 't', presenterAssetId: 'presenter-public-test'});
  assert.ok(resolved);
  assert.equal(resolved.ownership, 'public');
  const serialized = JSON.stringify(resolved);
  assert.equal(serialized.includes('authorizationRef'), false);
  assert.equal(serialized.includes('consentRef'), false);

  const cloneOnly = buildStore({...publicRecord(), id: 'presenter-clone-test', ownership: 'clone',
    publicCatalogRef: '', authorizationRef: 'a', consentRef: 'c'});
  const second = buildPorts(cloneOnly, Buffer.alloc(12_000, 1)).ports;
  assert.equal(await second.resolvePublicPresenter({tenantId: 't', presenterAssetId: 'presenter-clone-test'}), null);
});

test('adoption surfaces provider failure and pending without retrying', async () => {
  const media = Buffer.alloc(12_000, 1);
  const failedStore = buildStore();
  const failed = buildPorts(failedStore, media, {status: 'failed'});
  const failedResult: SocialHeyGenAdoptionResult = await failed.ports.adoptProviderTask(adoptionInput('req-failed'));
  assert.equal(failedResult.status, 'failed');
  assert.equal(failed.calls.create, 0);

  const pendingStore = buildStore();
  const pending = buildPorts(pendingStore, media, {status: 'pending'});
  const pendingResult = await pending.ports.adoptProviderTask(adoptionInput('req-pending'));
  assert.equal(pendingResult.status, 'pending');
  assert.equal(pending.calls.create, 0);
});
