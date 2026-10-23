import assert from 'node:assert/strict';
import test from 'node:test';
import { currentDataAuthority, runWithDataAuthority } from '../storage/dataAuthority.js';
import type { DataStore, ListQuery, ListResult } from '../storage/datastore.js';
import {
  CONTENT_EXECUTION_JOB_COLLECTION,
  parseContentExecutionCheckpoints,
  readCurrentContentExecutionCheckpoint,
  recordCurrentContentExecutionCheckpoint,
  recordCurrentContentProviderReceipt,
  assertCurrentContentExecutionActive,
  runWithContentExecutionContext,
} from './context.js';
import {
  admitContentExecutionJob,
  contentExecutionDefaults,
  bindPristineContentExecutionCheckpoint,
  bindPristineContentExecutionCheckpoints,
  refreshUnspentContentExecutionCheckpoint,
  DurableContentExecutionWorker,
  controlContentExecutionJob,
  pauseContentExecutionJobsForRun,
  readContentExecutionJob,
  resumeContentExecutionJobsForRun,
  setContentExecutionLimit,
} from './durableQueue.js';
import { classifyContentExecutionFailure } from './retryPolicy.js';
import { generateSeedanceConceptVideo } from '../lib/generativeVideoGateway.js';
import { buildContentExecutionRuntime } from '../digitalEmployees/contentExecutionRuntime.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';

class MemoryStore implements DataStore {
  rows = new Map<string, Map<string, Record<string, unknown> & { id: string }>>();
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
    const row = { ...data, id } as Record<string, unknown> & { id: string };
    target.set(id, row);
    return row as T;
  }

  async update(collection: string, id: string, data: Record<string, unknown>): Promise<boolean> {
    const target = this.collection(collection);
    const prior = target.get(id);
    if (!prior) return false;
    target.set(id, { ...prior, ...data, id });
    return true;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    return this.collection(collection).delete(id);
  }

  async list<T>(collection: string, query: ListQuery = {}): Promise<ListResult<T>> {
    let items = [...this.collection(collection).values()].filter(row => (
      Object.entries(query.where || {}).every(([key, value]) => row[key] === value)
    ));
    const terms = String(query.sort || '').split(',').map(item => item.trim()).filter(Boolean);
    if (terms.length) items = items.sort((left, right) => {
      for (const term of terms) {
        const descending = term.startsWith('-');
        const key = descending ? term.slice(1) : term;
        const compared = String(left[key] ?? '').localeCompare(String(right[key] ?? ''));
        if (compared) return descending ? -compared : compared;
      }
      return left.id.localeCompare(right.id);
    });
    const page = query.page || 1;
    const perPage = query.perPage || 20;
    const totalItems = items.length;
    return {
      items: items.slice((page - 1) * perPage, page * perPage) as T[], totalItems,
      totalPages: Math.ceil(totalItems / perPage), page, perPage,
    };
  }
}

const env = {
  CONTENT_EXECUTION_WORKER_CONCURRENCY: '4',
  CONTENT_EXECUTION_POLL_INTERVAL_MS: '60000',
  CONTENT_EXECUTION_LEASE_MS: '60000',
  CONTENT_MAX_RUNNING_PER_TENANT: '2',
  CONTENT_MAX_RUNNING_PER_ACCOUNT: '1',
  CONTENT_MAX_RUNNING_PER_TASK_TYPE: '2',
  CONTENT_NETWORK_MAX_ATTEMPTS: '4',
  CONTENT_SYSTEM_MAX_ATTEMPTS: '3',
  CONTENT_RECONCILIATION_MAX_ATTEMPTS: '12',
} as NodeJS.ProcessEnv;

test('production defaults share three slots while preserving account throttling and explicit overrides', () => {
  const defaults = contentExecutionDefaults({});
  assert.equal(defaults.tenantMaxRunning, 3);
  assert.equal(defaults.taskTypeMaxRunning, 3);
  assert.equal(defaults.workerConcurrency, 3);
  assert.equal(defaults.accountMaxRunning, 1);
  const overridden = contentExecutionDefaults({
    CONTENT_MAX_RUNNING_PER_TENANT: '2', CONTENT_MAX_RUNNING_PER_ACCOUNT: '1',
    CONTENT_MAX_RUNNING_PER_TASK_TYPE: '1', CONTENT_EXECUTION_WORKER_CONCURRENCY: '2',
  });
  assert.equal(overridden.tenantMaxRunning, 2);
  assert.equal(overridden.taskTypeMaxRunning, 1);
  assert.equal(overridden.workerConcurrency, 2);
  assert.equal(overridden.accountMaxRunning, 1);
});

test('shared default pool claims three contents, not three per Agent or worker', async () => {
  const store = new MemoryStore();
  for (let index = 0; index < 5; index++) await admitContentExecutionJob({
    dataStore: store, tenantId: 'shared-production', userId: 'owner', taskId: `content-${index}`,
    runId: `run-${index}`, accountId: `account-${index}`, taskType: index % 2 ? 'social_content_weekly' : 'social_content_workbench',
  });
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = async (job: { taskId: string }) => { started.push(job.taskId); await gate; };
  const first = new DurableContentExecutionWorker({ dataStore: store, execute, env: {} });
  const second = new DurableContentExecutionWorker({ dataStore: store, execute, env: {} });
  try {
    await first.drain();
    await second.drain();
    assert.equal(started.length, 3);
    const rows = await store.list<Record<string, unknown>>(CONTENT_EXECUTION_JOB_COLLECTION);
    assert.equal(rows.items.filter(row => row.status === 'running').length, 3);
    assert.equal(rows.items.filter(row => row.status === 'queued').length, 2);
  } finally { first.stop(); second.stop(); release(); }
});

test('three production slots do not raise a shared account limit or persisted customer limit', async () => {
  for (const persistedLimit of [false, true]) {
    const store = new MemoryStore();
    if (persistedLimit) await setContentExecutionLimit({ dataStore: store, tenantId: 'limited',
      scope: 'tenant', scopeKey: '*', maxRunning: 1, updatedBy: 'existing-admin' });
    for (let index = 0; index < 3; index++) await admitContentExecutionJob({
      dataStore: store, tenantId: 'limited', userId: 'owner', taskId: `limited-${index}`,
      runId: `run-${index}`, accountId: persistedLimit ? `account-${index}` : 'shared-account',
      taskType: 'social_content_weekly',
    });
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const worker = new DurableContentExecutionWorker({ dataStore: store, env: {},
      execute: async job => { started.push(job.taskId); await gate; } });
    try { await worker.drain(); assert.equal(started.length, 1); }
    finally { worker.stop(); release(); }
  }
});

test('frozen 37-shot executor checkpoints fit the durable map envelope', () => {
  const accepted = parseContentExecutionCheckpoints({
    'social.executor': {
      version: '1', inputHash: 'a'.repeat(64),
      payload: { approvedContext: { frozenPlan: 'x'.repeat(3_000_000) } },
      updatedAt: '2026-10-11T00:00:00.000Z',
    },
  });
  assert.equal((accepted['social.executor'].payload as any).approvedContext.frozenPlan.length, 3_000_000);
  assert.deepEqual(parseContentExecutionCheckpoints({
    'social.executor': {
      version: '1', inputHash: 'a'.repeat(64),
      payload: { approvedContext: { frozenPlan: 'x'.repeat(4_300_000) } },
      updatedAt: '2026-10-11T00:00:00.000Z',
    },
  }), {}, 'oversized individual checkpoints remain rejected');
});

test('retry policy separates balance, rejection, network, system and provider reconciliation', () => {
  assert.equal(classifyContentExecutionFailure(new Error('余额不足'), { attempt: 1, env }).failureClass, 'insufficient_balance');
  assert.equal(classifyContentExecutionFailure(new Error('Qwen Image 422: content rejected'), { attempt: 1, env }).failureClass, 'content_rejected');
  const network = classifyContentExecutionFailure(new Error('fetch failed ETIMEDOUT'), { attempt: 1, env });
  assert.equal(network.failureClass, 'network_timeout');
  assert.equal(network.disposition, 'retry');
  assert.equal(classifyContentExecutionFailure(new Error('unexpected local crash'), { attempt: 1, env }).failureClass, 'system_fault');
  for (const reason of ['product_footage_shot_review_required', 'product_footage_bytes_changed',
    'product_footage_material_unreadable']) {
    const decision = classifyContentExecutionFailure(new Error(reason), { attempt: 1, env });
    assert.equal(decision.failureClass, 'input_required');
    assert.equal(decision.disposition, 'block');
    assert.equal(decision.maxAttempts, 1);
  }
  assert.equal(classifyContentExecutionFailure(new Error('socket closed'), {
    attempt: 1, hasUnsettledProviderReceipt: true, env,
  }).failureClass, 'provider_reconciliation');
});

test('missing signed product-footage window blocks the original durable run without blind retries or plan edits', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-footage',
    userId: 'owner', taskId: 'original-content', runId: 'original-run', accountId: 'account',
    taskType: 'social_content_weekly' });
  const frozenPlan = { selectedMaterialSegment: { sourceRef: 'actual-product-video',
    segmentId: 'frozen-shot', startSeconds: 1, endSeconds: 3,
    footageEvidence: null } };
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, { checkpoints: {
    'social.executor': { version: '1', inputHash: 'a'.repeat(64),
      payload: { frozenPlan }, updatedAt: new Date().toISOString() },
  } });
  let attempts = 0;
  const worker = new DurableContentExecutionWorker({ dataStore: store, env,
    async execute() { attempts++; throw Error('product_footage_shot_review_required'); } });
  await worker.drain();
  for (let wait = 0; wait < 30 && worker.isLocallyActive('tenant-footage', 'original-content'); wait++)
    await new Promise<void>(resolve => setImmediate(resolve));
  await worker.drain();
  worker.stop();
  const stored = await readContentExecutionJob(store, 'tenant-footage', 'original-content', 'original-run');
  assert.equal(stored?.id, job.id);
  assert.equal(stored?.status, 'blocked');
  assert.equal(stored?.retryClass, 'input_required');
  assert.equal(stored?.attempt, 1);
  assert.equal(attempts, 1);
  assert.deepEqual(stored?.checkpoints['social.executor']?.payload, { frozenPlan });
  assert.equal((await store.list(CONTENT_EXECUTION_JOB_COLLECTION)).totalItems, 1);
  await assert.rejects(controlContentExecutionJob({ dataStore: store, tenantId: job.tenantId,
    jobId: job.id, action: 'retry' }), /content_execution_frozen_footage_revision_required/);
  const after = await readContentExecutionJob(store, job.tenantId, job.taskId, job.runId);
  assert.equal(after?.status, 'blocked');
  assert.equal(after?.attempt, 1);
  assert.deepEqual(after?.checkpoints['social.executor']?.payload, { frozenPlan });
});

test('frozen footage review failure with an already bound finding retains explicit retry', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-footage-bound',
    userId: 'owner', taskId: 'content', runId: 'run', taskType: 'social_content_weekly',
    initialCheckpoints: { 'social.executor': { version: '1', inputHash: 'a'.repeat(64),
      updatedAt: new Date().toISOString(), payload: { approvedContext: { assetSupplyPlan: { shots: [{
        selectedMaterialSegment: { sourceRef: 'material', footageEvidence: {
          approvalId: 'approved', visualFindingId: 'finding', contentSha256: 'b'.repeat(64),
        } },
      }] } } } } },
  });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, { status: 'blocked',
    last_error: 'product_footage_shot_review_required', retry_class: 'input_required' });
  const retried = await controlContentExecutionJob({ dataStore: store,
    tenantId: job.tenantId, jobId: job.id, action: 'retry' });
  assert.equal(retried.status, 'queued');
  assert.equal(retried.runId, job.runId);
});

test('durable admission is idempotent and provider receipts survive execution context loss', async () => {
  const store = new MemoryStore();
  const first = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-a', runId: 'run-a',
    accountId: 'account-a', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:00:00Z'),
  });
  const replay = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-a', runId: 'run-a',
    accountId: 'account-a', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:01:00Z'),
  });
  assert.equal(replay.id, first.id);
  assert.equal((await store.list(CONTENT_EXECUTION_JOB_COLLECTION)).totalItems, 1);

  await runWithContentExecutionContext({
    dataStore: store, jobId: first.id, action: async () => {
      await recordCurrentContentProviderReceipt({
        provider: 'seedance', requestId: 'request-a', state: 'accepted', providerTaskId: 'provider-task-a',
        metadata: { reservationId: 'reservation-a', reservedCny: 1.5 },
      });
    },
  });
  const persisted = await readContentExecutionJob(store, 'tenant-a', 'task-a', 'run-a');
  assert.equal(persisted?.providerState, 'accepted');
  assert.equal(persisted?.providerReceipts[0]?.providerTaskId, 'provider-task-a');
});

test('executor selection is visible atomically at admission and cannot change on replay', async () => {
  const store = new MemoryStore();
  const base = { dataStore: store, tenantId: 'tenant-executor', userId: 'user-a', taskId: 'task-executor', runId: 'run-executor', taskType: 'social_content_weekly' };
  const checkpoint = (executor: string) => ({ version: '1', inputHash: 'approved-plan-v1', payload: { executor }, updatedAt: '2026-10-11T00:00:00.000Z' });
  const originalCreate = store.create.bind(store);
  let observedExecutor: unknown;
  store.create = async <T>(collection: string, data: Record<string, unknown>): Promise<T | null> => {
    if (collection === CONTENT_EXECUTION_JOB_COLLECTION) observedExecutor = ((data.checkpoints as Record<string, ReturnType<typeof checkpoint>>)['social.executor'])?.payload.executor;
    return originalCreate<T>(collection, data);
  };
  const first = await admitContentExecutionJob({ ...base, initialCheckpoints: { 'social.executor': checkpoint('langgraph') } });
  assert.equal(observedExecutor, 'langgraph', 'a worker must never observe an unbound newly created job');
  const replay = await admitContentExecutionJob({ ...base, initialCheckpoints: { 'social.executor': checkpoint('legacy') } });
  assert.equal(replay.id, first.id);
  assert.equal((replay.checkpoints['social.executor'].payload as { executor: string }).executor, 'langgraph');
  const historic = await admitContentExecutionJob({ ...base, runId: 'historic-run' });
  const historicReplay = await admitContentExecutionJob({ ...base, runId: 'historic-run', initialCheckpoints: { 'social.executor': checkpoint('langgraph') } });
  assert.deepEqual(historic.checkpoints, {});
  assert.deepEqual(historicReplay.checkpoints, {}, 'historic jobs remain on the legacy executor');
});

test('historic executor binding is allowed only before any durable execution or provider evidence', async () => {
  const store = new MemoryStore();
  const checkpoint = { version: '1', inputHash: 'a'.repeat(64), payload: { executor: 'langgraph', inputHash: 'a'.repeat(64), planVersion: '1' }, updatedAt: '2026-10-11T00:00:00.000Z' };
  const pristine = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-bind', userId: 'user-a', taskId: 'task-bind', runId: 'run-bind', taskType: 'social_content_weekly' });
  const bound = await bindPristineContentExecutionCheckpoint({ dataStore: store, tenantId: pristine.tenantId, jobId: pristine.id, runId: pristine.runId, checkpointKey: 'social.executor', checkpoint });
  assert.equal(bound.id, pristine.id);
  assert.equal(bound.runId, pristine.runId);
  assert.equal((bound.checkpoints['social.executor'].payload as { executor: string }).executor, 'langgraph');
  const replay = await bindPristineContentExecutionCheckpoint({ dataStore: store, tenantId: pristine.tenantId, jobId: pristine.id, runId: pristine.runId, checkpointKey: 'social.executor', checkpoint });
  assert.equal(replay.checkpoints['social.executor'].inputHash, checkpoint.inputHash);

  const started = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-bind', userId: 'user-a', taskId: 'task-started', runId: 'run-started', taskType: 'social_content_weekly', initialCheckpoints: { 'runtime.retry': checkpoint } });
  await assert.rejects(bindPristineContentExecutionCheckpoint({ dataStore: store, tenantId: started.tenantId, jobId: started.id, runId: started.runId, checkpointKey: 'social.executor', checkpoint }), /pristine_binding_not_allowed/);
});

test('a pristine historical job upgrades its executor and graph bridge atomically',async()=>{
  const store=new MemoryStore(),executor={version:'1',inputHash:'a'.repeat(64),payload:{executor:'langgraph'},updatedAt:new Date().toISOString()};
  const bridge={version:'1',inputHash:'a'.repeat(64),payload:{schemaVersion:'content-production-bridge.v1'},updatedAt:new Date().toISOString()};
  const pristine=await admitContentExecutionJob({dataStore:store,tenantId:'tenant-atomic',userId:'owner',taskId:'task',runId:'run',taskType:'social_content_weekly'});
  const bound=await bindPristineContentExecutionCheckpoints({dataStore:store,tenantId:pristine.tenantId,jobId:pristine.id,runId:pristine.runId,checkpoints:{'social.executor':executor,'content.production_bridge':bridge}});
  assert.deepEqual(Object.keys(bound.checkpoints).sort(),['content.production_bridge','social.executor']);
  const replay=await bindPristineContentExecutionCheckpoints({dataStore:store,tenantId:pristine.tenantId,jobId:pristine.id,runId:pristine.runId,checkpoints:{'social.executor':executor,'content.production_bridge':bridge}});
  assert.equal(replay.id,pristine.id);
  const started=await admitContentExecutionJob({dataStore:store,tenantId:'tenant-atomic',userId:'owner',taskId:'started',runId:'started',taskType:'social_content_weekly',initialCheckpoints:{'runtime.retry':executor}});
  await assert.rejects(bindPristineContentExecutionCheckpoints({dataStore:store,tenantId:started.tenantId,jobId:started.id,runId:started.runId,checkpoints:{'social.executor':executor,'content.production_bridge':bridge}}),/pristine_binding_not_allowed/);
});

test('an unspent blocked admission may refresh only its executor binding', async () => {
  const store = new MemoryStore();
  const old = { version:'1', inputHash:'a'.repeat(64), payload:{executor:'langgraph'}, updatedAt:new Date().toISOString() };
  const fresh = { ...old, inputHash:'b'.repeat(64) };
  const job = await admitContentExecutionJob({dataStore:store,tenantId:'tenant-refresh',userId:'user-a',taskId:'task-a',runId:'run-a',taskType:'social',initialCheckpoints:{'social.executor':old}});
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION,job.id,{status:'blocked',checkpoints:{...job.checkpoints,'runtime.retry':{...old,inputHash:job.id}}});
  const refreshed=await refreshUnspentContentExecutionCheckpoint({dataStore:store,tenantId:job.tenantId,jobId:job.id,runId:job.runId,checkpointKey:'social.executor',checkpoint:fresh});
  assert.equal(refreshed.checkpoints['social.executor'].inputHash,fresh.inputHash);
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION,job.id,{provider_state:'accepted'});
  await assert.rejects(refreshUnspentContentExecutionCheckpoint({dataStore:store,tenantId:job.tenantId,jobId:job.id,runId:job.runId,checkpointKey:'social.executor',checkpoint:old}),/refresh_not_allowed/);
});

test('an unspent pre-provider graph failure may be discarded when refreshing its executor binding', async () => {
  const store = new MemoryStore();
  const old = { version:'1', inputHash:'a'.repeat(64), payload:{executor:'langgraph'}, updatedAt:new Date().toISOString() };
  const fresh = { ...old, inputHash:'b'.repeat(64) };
  const retry = { ...old, inputHash:'retry'.padEnd(64, '0'), payload:{attempt:2} };
  const graph = { version:'langgraph-checkpoints.v1', inputHash:'c'.repeat(64), updatedAt:new Date().toISOString(), payload:{
    format:'langgraph-checkpoints.v1', identityHash:'c'.repeat(64), checkpoints:[], writes:{},
  }};
  const failedNode = { version:'1', inputHash:'d'.repeat(64), updatedAt:new Date().toISOString(), payload:{
    node:'assets', status:'failed', outputSha256:null, providerReceiptRefs:[], reservedCny:null, actualCostCny:0,
    failureCode:'budget_preflight_failed', failureReason:'budget_preflight_failed',
  }};
  const job = await admitContentExecutionJob({dataStore:store,tenantId:'tenant-graph-refresh',userId:'user-a',taskId:'task-a',runId:'run-a',taskType:'social',initialCheckpoints:{'social.executor':old}});
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION,job.id,{status:'blocked',checkpoints:{
    ...job.checkpoints,'runtime.retry':retry,'langgraph.v1':graph,'langgraph.node.assets':failedNode,
  }});
  const refreshed=await refreshUnspentContentExecutionCheckpoint({dataStore:store,tenantId:job.tenantId,jobId:job.id,runId:job.runId,checkpointKey:'social.executor',checkpoint:fresh});
  assert.equal(refreshed.checkpoints['social.executor'].inputHash,fresh.inputHash);
  assert.equal(refreshed.checkpoints['runtime.retry'].inputHash,retry.inputHash);
  assert.equal(refreshed.checkpoints['langgraph.v1'],undefined);
  assert.equal(refreshed.checkpoints['langgraph.node.assets'],undefined);
});

test('graph binding refresh rejects any provider, cost, output, completed, or ambiguous graph evidence', async () => {
  const unsafeNodes = [
    {status:'running',outputSha256:null,providerReceiptRefs:[],reservedCny:null,actualCostCny:null},
    {status:'completed',outputSha256:null,providerReceiptRefs:[],reservedCny:null,actualCostCny:null},
    {status:'failed',outputSha256:'e'.repeat(64),providerReceiptRefs:[],reservedCny:null,actualCostCny:null},
    {status:'failed',outputSha256:null,providerReceiptRefs:['qwen:request-1'],reservedCny:null,actualCostCny:null},
    {status:'failed',outputSha256:null,providerReceiptRefs:[],reservedCny:0.01,actualCostCny:null},
    {status:'failed',outputSha256:null,providerReceiptRefs:[],reservedCny:null,actualCostCny:0.01},
  ];
  for (const [index,payload] of unsafeNodes.entries()) {
    const store = new MemoryStore();
    const old = {version:'1',inputHash:'a'.repeat(64),payload:{executor:'langgraph'},updatedAt:new Date().toISOString()};
    const job = await admitContentExecutionJob({dataStore:store,tenantId:`tenant-unsafe-${index}`,userId:'user-a',taskId:'task-a',runId:'run-a',taskType:'social',initialCheckpoints:{'social.executor':old}});
    await store.update(CONTENT_EXECUTION_JOB_COLLECTION,job.id,{status:'blocked',checkpoints:{...job.checkpoints,
      'langgraph.v1':{version:'langgraph-checkpoints.v1',inputHash:'c'.repeat(64),updatedAt:new Date().toISOString(),payload:{format:'langgraph-checkpoints.v1',identityHash:'c'.repeat(64),checkpoints:[],writes:{}}},
      'langgraph.node.assets':{version:'1',inputHash:'d'.repeat(64),updatedAt:new Date().toISOString(),payload},
    }});
    await assert.rejects(refreshUnspentContentExecutionCheckpoint({dataStore:store,tenantId:job.tenantId,jobId:job.id,runId:job.runId,checkpointKey:'social.executor',checkpoint:{...old,inputHash:'b'.repeat(64)}}),/refresh_not_allowed/);
  }
});

test('explicit customer pause replaces a workflow review wait without losing its receipts', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-pause', userId: 'user-a', taskId: 'task-pause', runId: 'run-pause', taskType: 'social_content_weekly' });
  const review = await controlContentExecutionJob({ dataStore: store, tenantId: job.tenantId, jobId: job.id, action: 'pause', pauseOrigin: 'workflow_review' });
  assert.equal((review.checkpoints['runtime.pause'].payload as { origin: string }).origin, 'workflow_review');
  const manual = await controlContentExecutionJob({ dataStore: store, tenantId: job.tenantId, jobId: job.id, action: 'pause' });
  assert.equal((manual.checkpoints['runtime.pause'].payload as { origin: string }).origin, 'manual');
  assert.equal(manual.id, job.id);
  assert.deepEqual(manual.providerReceipts, review.providerReceipts);
  const lateReview = await controlContentExecutionJob({ dataStore: store, tenantId: job.tenantId, jobId: job.id, action: 'pause', pauseOrigin: 'workflow_review' });
  assert.equal((lateReview.checkpoints['runtime.pause'].payload as { origin: string }).origin, 'manual', 'a late graph wait cannot undo an explicit pause');
});

test('run lifecycle controls pause and resume only their own non-terminal production jobs', async () => {
  const store = new MemoryStore();
  const base = { dataStore: store, tenantId: 'tenant-run-control', userId: 'user-a', runId: 'run-a', taskType: 'social_content_weekly' };
  const owned = await admitContentExecutionJob({ ...base, taskId: 'owned', initialCheckpoints: {
    'production.stage': { version: '1', inputHash: 'stage-input', payload: { stage: 'voice' }, updatedAt: '2026-10-12T00:00:00.000Z' },
  } });
  const manuallyPaused = await admitContentExecutionJob({ ...base, taskId: 'manual' });
  const reviewPaused = await admitContentExecutionJob({ ...base, taskId: 'review' });
  const blocked = await admitContentExecutionJob({ ...base, taskId: 'blocked' });
  const terminal = await admitContentExecutionJob({ ...base, taskId: 'terminal' });
  const sibling = await admitContentExecutionJob({ ...base, taskId: 'sibling', runId: 'run-b' });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, owned.id, { provider_receipts: [{
    provider: 'seedance', requestId: 'existing-request', state: 'accepted', providerTaskId: 'provider-task', metadata: {},
    firstRecordedAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
  }] });
  await controlContentExecutionJob({ dataStore: store, tenantId: base.tenantId, jobId: manuallyPaused.id, action: 'pause' });
  await controlContentExecutionJob({ dataStore: store, tenantId: base.tenantId, jobId: reviewPaused.id, action: 'pause', pauseOrigin: 'workflow_review' });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, blocked.id, { status: 'blocked', last_error: 'avatar_required' });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, terminal.id, { status: 'succeeded', completed_at: '2026-10-12T00:01:00.000Z' });

  const paused = await pauseContentExecutionJobsForRun({ dataStore: store, tenantId: base.tenantId, runId: base.runId, origin: 'workflow_run_pause' });
  assert.deepEqual(paused.affectedJobIds, [owned.id]);
  assert.deepEqual(paused.preservedJobIds.sort(), [manuallyPaused.id, reviewPaused.id, blocked.id].sort());
  assert.deepEqual(paused.terminalJobIds, [terminal.id]);
  const replay = await pauseContentExecutionJobsForRun({ dataStore: store, tenantId: base.tenantId, runId: base.runId, origin: 'workflow_run_pause' });
  assert.deepEqual(replay.affectedJobIds, [owned.id], 'a repeated run pause is an idempotent repair');

  const controlled = await readContentExecutionJob(store, base.tenantId, owned.taskId, base.runId);
  assert.equal(controlled?.status, 'paused');
  assert.equal((controlled?.checkpoints['runtime.pause'].payload as { origin: string }).origin, 'workflow_run_pause');
  assert.deepEqual(controlled?.checkpoints['production.stage'].payload, { stage: 'voice' });
  assert.equal(controlled?.providerReceipts[0]?.providerTaskId, 'provider-task');

  const resumed = await resumeContentExecutionJobsForRun({ dataStore: store, tenantId: base.tenantId, runId: base.runId, origin: 'workflow_run_pause' });
  assert.deepEqual(resumed.affectedJobIds, [owned.id]);
  assert.equal((await readContentExecutionJob(store, base.tenantId, owned.taskId, base.runId))?.status, 'reconciling');
  assert.equal((await readContentExecutionJob(store, base.tenantId, manuallyPaused.taskId, base.runId))?.status, 'paused');
  assert.equal((await readContentExecutionJob(store, base.tenantId, reviewPaused.taskId, base.runId))?.status, 'paused');
  assert.equal((await readContentExecutionJob(store, base.tenantId, blocked.taskId, base.runId))?.status, 'blocked', 'run resume cannot bypass a domain blocker');
  assert.equal((await readContentExecutionJob(store, base.tenantId, sibling.taskId, sibling.runId))?.status, 'queued');
});

test('run resume is all-or-none while an original controlled worker is still settling', async () => {
  const store = new MemoryStore();
  const base = { dataStore: store, tenantId: 'tenant-handoff', userId: 'user-a', runId: 'run-handoff', taskType: 'social_content_weekly' };
  const first = await admitContentExecutionJob({ ...base, taskId: 'first' });
  const second = await admitContentExecutionJob({ ...base, taskId: 'second' });
  await pauseContentExecutionJobsForRun({ dataStore: store, tenantId: base.tenantId, runId: base.runId, origin: 'workflow_handoff' });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, second.id, { worker_id: 'settling-worker', lease_expires_at: '2026-10-12T00:05:00.000Z' });
  await assert.rejects(
    resumeContentExecutionJobsForRun({ dataStore: store, tenantId: base.tenantId, runId: base.runId, origin: 'workflow_handoff' }),
    /content_execution_original_worker_not_settled/,
  );
  assert.equal((await readContentExecutionJob(store, base.tenantId, first.taskId, base.runId))?.status, 'paused', 'preflight prevents a partial resume');
  assert.equal((await readContentExecutionJob(store, base.tenantId, second.taskId, base.runId))?.status, 'paused');
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, second.id, { worker_id: '', lease_expires_at: '' });
  const resumed = await resumeContentExecutionJobsForRun({ dataStore: store, tenantId: base.tenantId, runId: base.runId, origin: 'workflow_handoff' });
  assert.deepEqual(resumed.affectedJobIds.sort(), [first.id, second.id].sort());
  assert.equal((await readContentExecutionJob(store, base.tenantId, first.taskId, base.runId))?.status, 'queued');
  assert.equal((await readContentExecutionJob(store, base.tenantId, second.taskId, base.runId))?.status, 'queued');
});

test('versioned checkpoints survive a new execution context and stale workers are fenced', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-checkpoint', userId: 'user-a', taskId: 'task-checkpoint',
    runId: 'run-checkpoint', taskType: 'social_content_weekly',
  });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, {
    status: 'running', worker_id: 'worker-a', attempt: 1,
  });
  await runWithContentExecutionContext({
    dataStore: store, jobId: job.id, expectedWorkerId: 'worker-a', expectedAttempt: 1,
    action: () => recordCurrentContentExecutionCheckpoint({
      stage: 'social.director_storyboard', version: '1', inputHash: 'input-v1',
      payload: { scenes: [{ sceneId: 'scene-1', materialId: 'asset-1' }] },
    }),
  });
  const persisted = await readContentExecutionJob(
    store, 'tenant-checkpoint', 'task-checkpoint', 'run-checkpoint',
  );
  await runWithContentExecutionContext({
    dataStore: store, jobId: job.id, checkpoints: persisted?.checkpoints,
    action: async () => {
      assert.deepEqual(readCurrentContentExecutionCheckpoint({
        stage: 'social.director_storyboard', version: '1', inputHash: 'input-v1',
      }), { scenes: [{ sceneId: 'scene-1', materialId: 'asset-1' }] });
      assert.equal(readCurrentContentExecutionCheckpoint({
        stage: 'social.director_storyboard', version: '1', inputHash: 'changed-input',
      }), null, 'changed inputs must never reuse an old intermediate result');
    },
  });

  await assert.rejects(runWithContentExecutionContext({
    dataStore: store, jobId: job.id, checkpoints: persisted?.checkpoints,
    expectedWorkerId: 'worker-a', expectedAttempt: 1,
    action: async () => {
      await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, {
        worker_id: 'worker-b', attempt: 2,
      });
      await recordCurrentContentExecutionCheckpoint({
        stage: 'social.director_storyboard', version: '1', inputHash: 'stale-write', payload: {},
      });
    },
  }), /content_execution_stopped/);
  const afterFence = await readContentExecutionJob(
    store, 'tenant-checkpoint', 'task-checkpoint', 'run-checkpoint',
  );
  assert.equal(afterFence?.checkpoints['social.director_storyboard']?.inputHash, 'input-v1');
});

test('provider receipt writers merge under a durable lock and stale callbacks cannot downgrade completion', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-receipt', userId: 'user-a', taskId: 'task-receipt',
    runId: 'run-receipt', taskType: 'social_content_weekly',
  });
  await runWithContentExecutionContext({ dataStore: store, jobId: job.id, action: async () => {
    await recordCurrentContentProviderReceipt({
      provider: 'seedance', requestId: 'request-new', state: 'completed', providerTaskId: 'task-new',
    });
  } });
  // This context intentionally starts with an empty/stale in-memory array.
  await runWithContentExecutionContext({ dataStore: store, jobId: job.id, providerReceipts: [], action: async () => {
    await recordCurrentContentProviderReceipt({
      provider: 'heygen', requestId: 'request-old-worker', state: 'accepted', providerTaskId: 'task-old',
    });
    await recordCurrentContentProviderReceipt({
      provider: 'seedance', requestId: 'request-new', state: 'accepted', providerTaskId: 'task-new',
    });
  } });
  const persisted = await readContentExecutionJob(store, 'tenant-receipt', 'task-receipt', 'run-receipt');
  assert.equal(persisted?.providerReceipts.length, 2);
  assert.equal(persisted?.providerReceipts.find(item => item.requestId === 'request-new')?.state, 'completed');
  assert.equal(persisted?.providerReceipts.find(item => item.requestId === 'request-old-worker')?.providerTaskId, 'task-old');
});

test('customer runtime projection explains capacity, queue position and retry without exposing raw failures', async () => {
  const store = new MemoryStore();
  await setContentExecutionLimit({
    dataStore: store, tenantId: 'tenant-a', scope: 'tenant', scopeKey: '*', maxRunning: 1,
    updatedBy: 'admin-a', now: new Date('2026-10-04T00:00:00Z'),
  });
  const running = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-running', runId: 'run-running',
    accountId: 'account-a', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:00:00Z'),
  });
  const queued = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-queued', runId: 'run-queued',
    accountId: 'account-b', taskType: 'social_content_instant', now: new Date('2026-10-04T00:00:01Z'),
  });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, running.id, {
    status: 'running', attempt: 1, worker_id: 'private-worker', last_error: 'private provider payload',
  });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, queued.id, {
    status: 'retry_wait', attempt: 2, retry_class: 'network_timeout',
    next_attempt_at: '2026-10-04T00:05:00Z', last_error: 'private socket address',
  });

  const runtime = await buildContentExecutionRuntime({ dataStore: store, tenantId: 'tenant-a', env, now: new Date('2026-10-04T00:02:00Z') });
  assert.deepEqual(runtime.capacity.tenant, { active: 1, max: 1 });
  const retry = runtime.jobs.find(job => job.id === queued.id);
  assert.equal(retry?.queuePosition, 1);
  assert.equal(retry?.waitingOn, 'tenant');
  assert.equal(retry?.maxAttempts, 4);
  assert.match(retry?.publicReason || '', /分级重试/);
  assert.equal(JSON.stringify(runtime).includes('private socket address'), false);
  assert.equal(JSON.stringify(runtime).includes('private-worker'), false);
});

test('active child boundary rejects a completed root group fence but preserves accepted unknown provider receipts', async () => {
 const store=new MemoryStore();
 await store.create('starter_social_content_tasks',{id:'root',tenant_id:'tenant-a',task_id:'original',status:'completed',content_order:{contentId:'original',budgetTaskId:'original',cancellation:{operationId:'cancel'}}});
 await store.create('starter_social_content_tasks',{id:'child',tenant_id:'tenant-a',task_id:'child',status:'running',content_order:{contentId:'original',budgetTaskId:'original'}});
 await store.create('workflow_runs',{id:'run',tenant_id:'tenant-a',status:'running'});
 const job=await admitContentExecutionJob({dataStore:store,tenantId:'tenant-a',userId:'owner',taskId:'child',runId:'run',taskType:'social_content_weekly'});
 await runWithContentExecutionContext({dataStore:store,jobId:job.id,action:async()=>{
   await assert.rejects(assertCurrentContentExecutionActive(),/content_execution_stopped/);
   await assert.rejects(recordCurrentContentProviderReceipt({provider:'seedance',requestId:'new',state:'submitting'}),/content_execution_stopped/);
   await recordCurrentContentProviderReceipt({provider:'seedance',requestId:'old',state:'unknown'});
 }});
 const saved=await store.getById<any>(CONTENT_EXECUTION_JOB_COLLECTION,job.id);
 assert.equal(saved.provider_receipts[0].requestId,'old');assert.equal(saved.provider_receipts[0].state,'unknown');
});
test('completed original group cancellation fences queued and unknown revision jobs without deleting evidence', async () => {
  const store = new MemoryStore();
  await store.create('starter_social_content_tasks', { id: 'root', tenant_id: 'tenant-a', task_id: 'original', status: 'completed',
    content_order: { contentId: 'original', budgetTaskId: 'original', cancellation: { operationId: 'cancel-group' } } });
  await store.create('starter_social_content_tasks', { id: 'child', tenant_id: 'tenant-a', task_id: 'revision', status: 'queued',
    content_order: { contentId: 'original', budgetTaskId: 'original' } });
  const job = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', userId: 'owner', taskId: 'revision', runId: 'run', taskType: 'social_content_weekly' });
  const receipts = [{ operationId: 'original-paid-request', state: 'unknown', requestId: 'provider-request' }];
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, { status: 'reconciling', provider_receipts: receipts });
  let executions = 0;
  const worker = new DurableContentExecutionWorker({ dataStore: store, env: {}, execute: async () => { executions += 1; } });
  try {
    await worker.drain();
    assert.equal(executions, 0);
    const saved = await store.getById<any>(CONTENT_EXECUTION_JOB_COLLECTION, job.id);
    assert.deepEqual(saved.provider_receipts, receipts);
    assert.equal(saved.attempt, 0);
    await assert.rejects(controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'retry' }), /order_cancelled_or_replaced/);
    assert.equal((await store.getById<any>('starter_social_content_tasks', 'root')).status, 'completed');
  } finally { worker.stop(); }
});

test('group fence suppresses a late worker success callback and preserves provider history', async () => {
  const store = new MemoryStore();
  const root = { id: 'root', tenant_id: 'tenant-a', task_id: 'original', status: 'completed', content_order: { contentId: 'original', budgetTaskId: 'original' } };
  await store.create('starter_social_content_tasks', root);
  await store.create('starter_social_content_tasks', { id: 'child', tenant_id: 'tenant-a', task_id: 'revision', status: 'queued', content_order: { contentId: 'original', budgetTaskId: 'original' } });
  const job = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', userId: 'owner', taskId: 'revision', runId: 'run', taskType: 'social_content_weekly' });
  let callbacks = 0, executed = false;
  const worker = new DurableContentExecutionWorker({ dataStore: store, env: {}, execute: async () => {
    executed = true;
    await store.update('starter_social_content_tasks', 'root', { content_order: { ...root.content_order, cancellation: { operationId: 'cancel-group' } } });
  }, onSucceeded: async () => { callbacks += 1; } });
  try {
    await worker.drain();
    for (let i = 0; i < 30; i += 1) { await new Promise(resolve => setImmediate(resolve)); if (!(await readContentExecutionJob(store, 'tenant-a', 'revision', 'run'))?.workerId) break; }
    assert.equal(executed, true); assert.equal(callbacks, 0);
    assert.notEqual((await readContentExecutionJob(store, 'tenant-a', 'revision', 'run'))?.status, 'succeeded');
  } finally { worker.stop(); }
});

test('pause, cancel, resume and manual retry preserve the same durable job identity', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-control', runId: 'run-control',
    accountId: 'account-a', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:00:00Z'),
  });
  const paused = await controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'pause' });
  assert.equal(paused.status, 'paused');
  const resumed = await controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'resume' });
  assert.equal(resumed.status, 'queued');
  const duplicateResume = await controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'resume' });
  assert.equal(duplicateResume.id, job.id);
  assert.equal(duplicateResume.status, 'queued');
  const cancelled = await controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  const recovered = await controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'resume' });
  assert.equal(recovered.status, 'queued');
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, { status: 'blocked', attempt: 3, last_error: 'private failure' });
  const retried = await controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'retry' });
  assert.equal(retried.status, 'queued');
  assert.equal(retried.attempt, 0);
  assert.equal(retried.lastError, null);
  assert.equal(retried.id, job.id);
  assert.deepEqual(retried.checkpoints['runtime.retry']?.payload, {
    action: 'retry', fromStatus: 'blocked',
  });
  const duplicateRetry = await controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', jobId: job.id, action: 'retry' });
  assert.equal(duplicateRetry.id, job.id);
  assert.equal(duplicateRetry.status, 'queued');
  await assert.rejects(
    controlContentExecutionJob({ dataStore: store, tenantId: 'tenant-b', jobId: job.id, action: 'pause' }),
    /content_execution_job_not_found/,
  );
});

test('failed success projection cannot retry a durably completed production job', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', userId: 'user-a',
    taskId: 'completed-task', runId: 'completed-run', accountId: 'account-a', taskType: 'social_content_weekly' });
  let executed = 0;
  let projected = 0;
  let retried = 0;
  let blocked = 0;
  const worker = new DurableContentExecutionWorker({ dataStore: store, env,
    async execute() { executed++; },
    async onSucceeded() { projected++; throw new Error('completion_projection_write_failed'); },
    async onRetry() { retried++; },
    async onBlocked() { blocked++; },
  });
  await worker.drain();
  for (let attempt = 0; attempt < 20 && worker.isLocallyActive('tenant-a', 'completed-task'); attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await worker.drain();
  worker.stop();
  const actual = await readContentExecutionJob(store, 'tenant-a', 'completed-task', 'completed-run');
  assert.equal(actual?.id, job.id);
  assert.equal(actual?.status, 'succeeded');
  assert.ok(actual?.completedAt);
  assert.equal(executed, 1);
  assert.equal(projected, 1);
  assert.equal(retried, 0);
  assert.equal(blocked, 0);
});

test('worker enforces tenant and account caps while allowing another customer to run', async () => {
  const store = new MemoryStore();
  await setContentExecutionLimit({
    dataStore: store, tenantId: 'tenant-a', scope: 'tenant', scopeKey: '*', maxRunning: 1,
    updatedBy: 'admin-a', now: new Date('2026-10-04T00:00:00Z'),
  });
  await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-a1', runId: 'run-a1', accountId: 'account-a', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:00:00Z') });
  await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-a2', runId: 'run-a2', accountId: 'account-b', taskType: 'social_content_instant', now: new Date('2026-10-04T00:00:01Z') });
  await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-b', userId: 'user-b', taskId: 'task-b1', runId: 'run-b1', accountId: 'account-c', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:00:02Z') });

  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const worker = new DurableContentExecutionWorker({
    dataStore: store, env,
    execute: job => new Promise<void>(resolve => { started.push(job.taskId); gates.set(job.taskId, resolve); }),
  });
  await worker.drain();
  assert.deepEqual(new Set(started), new Set(['task-a1', 'task-b1']));
  assert.equal(started.includes('task-a2'), false);

  gates.get('task-a1')?.();
  gates.get('task-b1')?.();
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  await worker.drain();
  assert.equal(started.includes('task-a2'), true);
  gates.get('task-a2')?.();
  worker.stop();
});

test('two worker instances claim one durable job only once', async () => {
  const store = new MemoryStore();
  await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-a', runId: 'run-a',
    accountId: 'account-a', taskType: 'social_content_instant', now: new Date('2026-10-04T00:00:00Z'),
  });
  let executions = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const execute = async () => { executions += 1; await gate; };
  const first = new DurableContentExecutionWorker({ dataStore: store, env, execute });
  const second = new DurableContentExecutionWorker({ dataStore: store, env, execute });
  await Promise.all([first.drain(), second.drain()]);
  assert.equal(executions, 1);
  release();
  first.stop();
  second.stop();
});

test('abandoned accepted provider job enters reconciliation without blind resubmission', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-a', runId: 'run-a',
    accountId: 'account-a', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:00:00Z'),
  });
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, {
    status: 'running', attempt: 1, worker_id: 'dead-worker', lease_expires_at: '2026-10-04T00:01:00Z',
    provider_state: 'accepted', provider_receipts: [{
      provider: 'heygen', requestId: 'request-a', state: 'accepted', providerTaskId: 'provider-task-a',
      metadata: {}, firstRecordedAt: '2026-10-04T00:00:10Z', updatedAt: '2026-10-04T00:00:10Z',
    }],
  });
  let executions = 0;
  let settled!: () => void;
  const didSettle = new Promise<void>(resolve => { settled = resolve; });
  const worker = new DurableContentExecutionWorker({
    dataStore: store, env, now: () => new Date('2026-10-04T00:02:00Z'),
    execute: async () => { executions += 1; throw new Error('provider_submission_unknown:heygen'); },
    onRetry: async () => settled(),
  });
  await worker.drain();
  await didSettle;
  const recovered = await readContentExecutionJob(store, 'tenant-a', 'task-a', 'run-a');
  assert.equal(executions, 1);
  assert.equal(recovered?.status, 'reconciling');
  assert.equal(recovered?.retryClass, 'provider_reconciliation');
  assert.equal(recovered?.providerReceipts[0]?.providerTaskId, 'provider-task-a');
  worker.stop();
});

test('accepted Seedance receipt resumes polling and never submits a second paid task', async () => {
  const store = new MemoryStore();
  const job = await admitContentExecutionJob({
    dataStore: store, tenantId: 'tenant-a', userId: 'user-a', taskId: 'task-a', runId: 'run-a',
    accountId: 'account-a', taskType: 'social_content_weekly', now: new Date('2026-10-04T00:00:00Z'),
  });
  await runWithContentExecutionContext({ dataStore: store, jobId: job.id, action: async () => {
    await recordCurrentContentProviderReceipt({
      provider: 'seedance', requestId: 'stable-request', state: 'accepted', providerTaskId: 'provider-task-7',
      metadata: { reservationId: 'reservation-7', reservedCny: 2, model: 'seedance-test' },
    });
  } });
  const persisted = await readContentExecutionJob(store, 'tenant-a', 'task-a', 'run-a');
  const requests: string[] = [];
  const result = await runWithContentExecutionContext({
    dataStore: store, jobId: job.id, providerReceipts: persisted?.providerReceipts,
    action: () => generateSeedanceConceptVideo({
      tenantId: 'tenant-a', prompt: 'resume', durationSeconds: 5, ratio: '9:16',
      idempotencyKey: 'stable-request', timeoutMs: 1_000, apiKey: 'secret', model: 'seedance-test', pollMs: 1,
      transport: async url => {
        const address = String(url); requests.push(address);
        if (address.includes('/tasks/provider-task-7')) {
          return Response.json({ status: 'succeeded', content: { video_url: 'https://media.example/resumed.mp4' } });
        }
        if (address === 'https://media.example/resumed.mp4') return new Response(Buffer.from('resumed-video'));
        throw new Error(`unexpected request:${address}`);
      },
      reserveBudget: () => { throw new Error('must_not_reserve_twice'); },
      releaseBudget: () => { throw new Error('must_not_release_accepted_reservation'); },
    }),
  });
  assert.equal(result.providerTaskId, 'provider-task-7');
  assert.equal(result.bytes.toString(), 'resumed-video');
  assert.equal(requests.some(url => url.endsWith('/contents/generations/tasks')), false);
});


test('worker pins local storage across claims, execution, callbacks and remote wakeups', async () => {
  const store = new MemoryStore();
  await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-local', userId: 'user-local', taskId: 'task-local', runId: 'run-local', taskType: 'social_content_instant' });
  const calls: string[] = [];
  const scopedStore = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assert.equal(currentDataAuthority(), 'local', String(property));
        calls.push(String(property));
        return value.apply(target, args);
      };
    },
  });
  let executed = false;
  let succeeded = false;
  const worker = new DurableContentExecutionWorker({
    dataStore: scopedStore, dataAuthority: 'local', env,
    async execute() { await Promise.resolve(); assert.equal(currentDataAuthority(), 'local'); executed = true; },
    async onSucceeded() { assert.equal(currentDataAuthority(), 'local'); succeeded = true; },
  });
  await runWithDataAuthority('pocketbase', async () => {
    await worker.drain();
    assert.equal(currentDataAuthority(), 'pocketbase', 'worker context must not leak into caller');
  });
  for (let attempt = 0; attempt < 20 && !succeeded; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  worker.stop();
  assert.ok(executed && succeeded, 'the persisted job reaches successful completion');
  assert.ok(calls.includes('list') && calls.includes('getById') && calls.includes('update') && calls.includes('delete'));
});

test('durable phase pause settles without success or failure projections, then resumes the same provider identity',async()=>{
 const store=new MemoryStore();await store.create('workflow_runs',{id:'phase-run',tenant_id:'tenant-a',status:'running'});
 const original=await admitContentExecutionJob({dataStore:store,tenantId:'tenant-a',userId:'user-a',taskId:'phase-task',runId:'phase-run',accountId:'account-a',taskType:'social_content_weekly'});
 let submissions=0,executions=0,succeeded=0,blocked=0,retried=0;
 const worker=new DurableContentExecutionWorker({dataStore:store,env,async execute(job){executions++;if(executions===1){submissions++;await recordCurrentContentProviderReceipt({provider:'controlled',requestId:'same-request',state:'unknown',providerTaskId:'provider-original'});await controlContentExecutionJob({dataStore:store,tenantId:'tenant-a',jobId:job.id,action:'pause'});return;}
 const receipt=job.providerReceipts.find(row=>row.requestId==='same-request');assert.equal(receipt?.providerTaskId,'provider-original');assert.equal(receipt?.state,'unknown');await recordCurrentContentProviderReceipt({provider:'controlled',requestId:'same-request',state:'completed',providerTaskId:'provider-original'});},async onSucceeded(){succeeded++;},async onBlocked(){blocked++;},async onRetry(){retried++;}});
 const settle=async()=>{await worker.drain();for(let n=0;n<30&&worker.isLocallyActive('tenant-a','phase-task');n++)await new Promise<void>(resolve=>setImmediate(resolve));};
 await settle();const paused=await readContentExecutionJob(store,'tenant-a','phase-task','phase-run');assert.equal(paused?.status,'paused');assert.equal(paused?.completedAt,null);assert.equal(succeeded,0);assert.equal(blocked,0);assert.equal(retried,0);
 const resumed=await controlContentExecutionJob({dataStore:store,tenantId:'tenant-a',jobId:original.id,action:'resume'});assert.equal(resumed.id,original.id);assert.equal(resumed.runId,'phase-run');assert.equal(resumed.status,'reconciling');assert.equal(resumed.providerReceipts[0]?.providerTaskId,'provider-original');
 await settle();worker.stop();const complete=await readContentExecutionJob(store,'tenant-a','phase-task','phase-run');assert.equal(complete?.status,'succeeded');assert.equal(complete?.id,original.id);assert.equal(executions,2);assert.equal(submissions,1);assert.equal(succeeded,1);assert.equal(blocked,0);assert.equal(retried,0);
});

test('an execution stopped after durable pause cannot project a blocked failure',async()=>{
 const store=new MemoryStore();const job=await admitContentExecutionJob({dataStore:store,tenantId:'tenant-a',userId:'user-a',taskId:'stopped-task',runId:'stopped-run',accountId:'account-a',taskType:'social_content_weekly'});let success=0,block=0,retry=0;
 const worker=new DurableContentExecutionWorker({dataStore:store,env,async execute(){await controlContentExecutionJob({dataStore:store,tenantId:'tenant-a',jobId:job.id,action:'pause'});throw Error('content_execution_stopped');},async onSucceeded(){success++;},async onBlocked(){block++;},async onRetry(){retry++;}});
 await worker.drain();for(let n=0;n<30&&worker.isLocallyActive('tenant-a','stopped-task');n++)await new Promise<void>(resolve=>setImmediate(resolve));worker.stop();assert.equal((await readContentExecutionJob(store,'tenant-a','stopped-task','stopped-run'))?.status,'paused');assert.equal(success+block+retry,0);
});

test('resume cannot erase an unsettled paused worker or let its late completion settle resumed production',async()=>{
 const store=new MemoryStore();const admission={dataStore:store,tenantId:'tenant-a',userId:'user-a',taskId:'unsettled-phase-task',runId:'unsettled-phase-run',accountId:'account-a',taskType:'social_content_weekly'};
 const original=await admitContentExecutionJob(admission);let executions=0,success=0;
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const worker=new DurableContentExecutionWorker({dataStore:store,env,async execute(){executions++;if(executions===1){entered();await gate;}},async onSucceeded(){success++;}});
 try{
  await worker.drain();await started;
  const paused=await controlContentExecutionJob({dataStore:store,tenantId:'tenant-a',jobId:original.id,action:'pause'});
  assert.ok(paused.workerId);assert.ok(paused.leaseExpiresAt);
  const repeated=await admitContentExecutionJob(admission);assert.equal(repeated.id,original.id);assert.equal(repeated.status,'paused');
  await assert.rejects(controlContentExecutionJob({dataStore:store,tenantId:'tenant-a',jobId:original.id,action:'resume'}),/content_execution_original_worker_not_settled/);
  // Expiration alone does not prove that the original external call stopped.
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION,original.id,{lease_expires_at:'2000-01-01T00:00:00.000Z'});
  await assert.rejects(controlContentExecutionJob({dataStore:store,tenantId:'tenant-a',jobId:original.id,action:'resume'}),/content_execution_original_worker_not_settled/);
  release();for(let n=0;n<60&&worker.isLocallyActive('tenant-a','unsettled-phase-task');n++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(worker.isLocallyActive('tenant-a','unsettled-phase-task'),false);
  const settled=await readContentExecutionJob(store,'tenant-a','unsettled-phase-task','unsettled-phase-run');assert.equal(settled?.status,'paused');assert.equal(settled?.workerId,null);assert.equal(settled?.leaseExpiresAt,null);assert.equal(success,0);
  const resumed=await controlContentExecutionJob({dataStore:store,tenantId:'tenant-a',jobId:original.id,action:'resume'});assert.equal(resumed.id,original.id);assert.equal(resumed.runId,original.runId);assert.equal(resumed.status,'queued');
  await worker.drain();for(let n=0;n<60&&worker.isLocallyActive('tenant-a','unsettled-phase-task');n++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal((await readContentExecutionJob(store,'tenant-a','unsettled-phase-task','unsettled-phase-run'))?.status,'succeeded');assert.equal(executions,2);assert.equal(success,1);
  assert.equal((await store.list(CONTENT_EXECUTION_JOB_COLLECTION)).totalItems,1);
 }finally{release();worker.stop();}
});

test('trusted job scope excludes unrelated queued jobs and abandoned recovery, and snapshots the allowlist', async () => {
  const store = new MemoryStore();
  const admit = (taskId: string, tenantId: string) => admitContentExecutionJob({dataStore: store, tenantId, userId:'user-a', taskId, runId:taskId, accountId:taskId, taskType:'social_content_weekly'});
  const unrelated = await admit('unrelated', 'tenant-other');
  const abandoned = await admit('abandoned', 'tenant-other');
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, abandoned.id, {status:'running', worker_id:'external-worker', lease_expires_at:'2020-01-01T00:00:00Z'});
  const target = await admit('target', 'tenant-target');
  const ids = [target.id];
  const executed: string[] = [];
  const worker = new DurableContentExecutionWorker({dataStore:store, env, allowedJobIds:ids, async execute(job){executed.push(job.id);}});
  ids.push(unrelated.id);
  await worker.drain();
  for(let i=0;i<30 && worker.isLocallyActive('tenant-target','target');i++) await new Promise<void>(resolve=>setImmediate(resolve));
  await worker.drain();
  worker.stop();
  assert.deepEqual(executed,[target.id]);
  assert.equal((await store.getById<Record<string,unknown>>(CONTENT_EXECUTION_JOB_COLLECTION,unrelated.id))?.status,'queued');
  assert.equal((await store.getById<Record<string,unknown>>(CONTENT_EXECUTION_JOB_COLLECTION,abandoned.id))?.status,'running');
  const empty = new DurableContentExecutionWorker({dataStore:store,env,allowedJobIds:[],async execute(){assert.fail('empty scope must not execute');}});
  await empty.drain(); empty.stop();
  assert.equal((await store.getById<Record<string,unknown>>(CONTENT_EXECUTION_JOB_COLLECTION,abandoned.id))?.status,'running');
  assert.throws(()=>new DurableContentExecutionWorker({dataStore:store,allowedJobIds:[' '],async execute(){}}),/invalid_content_execution_allowed_job_ids/);
});

test('the existing worker claims a revision only through the complete production admission checkpoint', async () => {
  const store = new MemoryStore();
  const marker = { sourceRunId: 'source-run', revisedPlanHash: '1'.repeat(64) };
  const job = await admitContentExecutionJob({ dataStore: store, tenantId: 'tenant-r', userId: 'user-r',
    taskId: 'revision-task', runId: 'revision-run', accountId: 'account-r', taskType: 'social_content_weekly' });
  await store.create('starter_social_content_tasks', { id: 'revision-task-row', tenant_id: 'tenant-r',
    task_id: 'revision-task', brief: { _productFootageRevision: marker } });
  let executions = 0;
  const worker = new DurableContentExecutionWorker({ dataStore: store, env, allowedJobIds: [job.id],
    async execute() { executions++; } });
  await worker.drain();
  assert.equal(executions, 0);
  const body = { schemaVersion: 'social-product-footage-revision-worker-admission.v1',
    tenantId: job.tenantId, taskId: job.taskId, runId: job.runId,
    guardHash: '2'.repeat(64), paidPlanFreezeHash: '3'.repeat(64), canonicalPlanHash: '4'.repeat(64),
    planHash: marker.revisedPlanHash, approvalBindings: [{ groupId: 'presenter-1',
      approvalRecordHash: '5'.repeat(64), decisionRecordHash: '6'.repeat(64),
      assetProvenanceHash: '7'.repeat(64) }], workerLane: 'social_content_production',
    admittedAt: '2026-10-19T00:00:00.000Z' };
  const recordHash = socialRequestHash(body);
  await store.update(CONTENT_EXECUTION_JOB_COLLECTION, job.id, { checkpoints: {
    'social.footage_revision_worker_admission': { version: '1', inputHash: recordHash,
      payload: { ...body, recordHash }, updatedAt: body.admittedAt },
  } });
  await worker.drain();
  for (let attempt = 0; attempt < 30 && worker.isLocallyActive(job.tenantId, job.taskId); attempt++)
    await new Promise<void>(resolve => setImmediate(resolve));
  worker.stop();
  assert.equal(executions, 1);
  assert.equal((await readContentExecutionJob(store, job.tenantId, job.taskId, job.runId))?.status, 'succeeded');
});
