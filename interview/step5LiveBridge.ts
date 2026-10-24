/**
 * Step 5 zero-cost live bridge.
 *
 * This assembles the ORIGINAL social HeyGen bridge for the already-accepted
 * Step 4 provider tasks. It only performs GET status checks and media
 * downloads; every write path (POST) is guarded twice: the transport rejects
 * non-GET methods and client.create throws. No budget is reserved and the
 * wallet must not change.
 */
import {createHash} from 'node:crypto';
import type {DataStore} from '../server/storage/datastore.js';
import {runWithDataAuthority} from '../server/storage/dataAuthority.js';
import {HeyGenClient} from '../server/lib/heygen.js';
import {objectStorageHead, objectStorageUpload} from '../server/storage/objectStorage.js';
import {
  buildPublicPresenterRecord,
  createSocialHeyGenBridgePorts,
  defaultDownload,
  type PublicHeyGenPresenter,
  type SocialHeyGenAdoptionEvent,
  type SocialHeyGenAdoptionResult,
  type SocialHeyGenBridgePorts,
} from '../server/starter198/socialContentHeyGenBridge.js';
import {
  validatePublicHeyGenPresenterRecord,
  type PublicPresenterEvidence,
} from '../server/lib/presenterAssetTrust.js';
import {productionBillingAccountRef} from '../server/starter198/socialContentProductionBudgetRoutes.js';
import {activeProviderDownloadAllowlist, validateProviderDownloadUrl} from './realMode.js';

export const STEP5_LIVE_BRIDGE_PRESENTER_ID = 'presenter-public-storyboard';
export const HEYGEN_VIDEO_BILLING_BASE = 'https://api.heygen.com/v3/videos';

export function isStep5LiveBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTERVIEW_REAL_MODE === '1' && Boolean(String(env.HEYGEN_API_KEY || '').trim());
}

function fail(code: string, detail?: string): never {
  throw new Error(code + (detail ? `:${detail}` : ''));
}

/** GET-only wrapper for HeyGenClient. Any attempted write fails before the
 * network guard sees it, so adoption can never create a paid task. */
export function createAdoptionOnlyTransport(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(init?.method || 'GET').toUpperCase();
    if (method !== 'GET') return Promise.reject(new Error('step5_adoption_only_no_new_submission'));
    return baseFetch(input, init);
  }) as typeof fetch;
}

/** Budget-shaped stub required by the bridge constructor. Adoption never reads
 * a reservation and never calls reserve(); the bridge's maximumCostCny becomes
 * zero, which is the intended "no new paid operation" signal. */
export const adoptionOnlyBudget = {
  status: (_provider: 'heygen' | 'qwen_asr', _overrideCny?: number, _tenantId?: string) => ({
    allowed: false,
    remainingCny: null,
    reservationCny: 0,
    reason: '零新增费用：接管已受理任务，不预占预算',
    budgetExempt: true,
  }),
  async reserve(): Promise<void> {
    throw new Error('step5_adoption_only_no_new_submission');
  },
};

export function createStep5LiveAdoptionBridge(input: {
  store: DataStore;
  env?: NodeJS.ProcessEnv;
  downloadImpl?: (url: string) => Promise<Buffer>;
  maxPolls?: number;
  pollIntervalMs?: number;
}): SocialHeyGenBridgePorts {
  const env = input.env ?? process.env;
  const key = String(env.HEYGEN_API_KEY || '').trim();
  if (!key) fail('step5_live_bridge_key_missing');
  const client = new HeyGenClient(key, createAdoptionOnlyTransport());
  const download = async (url: string): Promise<Buffer> => {
    const validated = validateProviderDownloadUrl(url);
    if (!validated) fail('step5_live_bridge_media_url_untrusted');
    // Real mode blocks unknown hosts; a provider-returned URL must be
    // registered before the fetch is allowed.
    activeProviderDownloadAllowlist()?.register(validated);
    return (input.downloadImpl ?? defaultDownload)(validated);
  };
  return createSocialHeyGenBridgePorts({
    store: input.store,
    client: {
      create: async () => { throw new Error('step5_adoption_only_no_new_submission'); },
      status: (id: string) => client.status(id),
    },
    budget: adoptionOnlyBudget,
    storageReady: () => true,
    download,
    upload: objectStorageUpload,
    head: objectStorageHead,
    ...(input.maxPolls !== undefined ? {maxPolls: input.maxPolls} : {}),
    ...(input.pollIntervalMs !== undefined ? {pollIntervalMs: input.pollIntervalMs} : {}),
  });
}

/** Creates or merges exactly one registry row, preserving other presenters and
 * never adding clone authorization/consent fields. */
export async function ensurePublicPresenterRecord(
  store: DataStore,
  record: Record<string, unknown>,
  tenantId = 't',
): Promise<void> {
  await runWithDataAuthority('local', async () => {
    const rows = await store.list<any>('studio_production_defaults', {
      where: {tenant_id: tenantId}, perPage: 2,
    });
    if (rows.items.length > 1 || rows.totalItems > 1) fail('step5_public_presenter_registry_ambiguous');
    const row = rows.items[0];
    if (row && (!row.payload || !Array.isArray(row.payload.presenters)))
      fail('step5_public_presenter_registry_ambiguous');
    const payload = row
      ? {
        ...row.payload,
        presenters: [
          ...row.payload.presenters.filter((item: any) => item?.id !== record.id),
          record,
        ],
        defaultPresenterId: row.payload.defaultPresenterId || String(record.id || ''),
      }
      : {presenters: [record], defaultPresenterId: String(record.id || '')};
    const saved = row
      ? await store.update('studio_production_defaults', row.id, {payload})
      : await store.create('studio_production_defaults', {tenant_id: tenantId, payload});
    if (!saved) fail('step5_public_presenter_binding_invalid', 'registry_save_failed');
  });
}

export interface Step4PresenterSource {
  id: string;
  script: string;
  requestId: string;
  videoId: string;
  durationSeconds: number;
  mediaSha256: string;
  mediaBytes?: number;
  avatarId: string;
  voiceId: string;
  publicEvidence: PublicPresenterEvidence;
  providerEvidenceRef?: string;
}

export interface Step5LiveCounters {
  newPaidSubmissions: 0;
  newChargedCny: 0;
  statusCalls: number;
  downloads: number;
  uploads: number;
  presentersAdopted: number;
}

export interface Step5LiveAdoption {
  presenter: PublicHeyGenPresenter;
  accountRef: string;
  counters: Step5LiveCounters;
  adopt(source: Step4PresenterSource): Promise<SocialHeyGenAdoptionResult & {shotId: string}>;
}

export interface PrepareStep5LiveInput {
  store: DataStore;
  sources: Step4PresenterSource[];
  avatarId: string;
  voiceId: string;
  outputDirectory: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  onEvent?: (shotId: string, event: SocialHeyGenAdoptionEvent) => void | Promise<void>;
  maxPolls?: number;
  pollIntervalMs?: number;
}

function credentialHash(env: NodeJS.ProcessEnv): string {
  const configured = String(env.INTERVIEW_CREDENTIAL_SHA256 || '').trim();
  if (/^[a-f0-9]{64}$/.test(configured)) return configured;
  return createHash('sha256').update(String(env.HEYGEN_API_KEY || '')).digest('hex');
}

function sameEvidence(a: PublicPresenterEvidence, b: PublicPresenterEvidence): boolean {
  return a.ownership === b.ownership
    && a.publicCatalogRef === b.publicCatalogRef
    && a.providerTermsRef === b.providerTermsRef
    && a.verifiedAt === b.verifiedAt
    && a.accountId === b.accountId;
}

/**
 * Validates Step 4 presenter metadata, proves the current key belongs to the
 * same provider account, upserts the public presenter registry and resolves it
 * through the original bridge. Missing or contradictory evidence is a hard
 * failure; the fallback is never "pretend it is a clone".
 */
export async function prepareStep5LiveAdoption(input: PrepareStep5LiveInput): Promise<Step5LiveAdoption> {
  const env = input.env ?? process.env;
  if (!isStep5LiveBridgeEnabled(env)) fail('step5_live_bridge_key_missing');
  if (!input.sources.length) fail('step5_live_bridge_public_evidence_missing');
  for (const source of input.sources) {
    if (!source.requestId || !source.videoId || !source.script.trim()) fail('step5_provider_evidence_missing', source.id);
    if (!source.publicEvidence) fail('step5_live_bridge_public_evidence_missing', source.id);
    if (source.avatarId !== input.avatarId || source.voiceId !== input.voiceId)
      fail('step5_live_bridge_public_evidence_mismatch', `${source.id}:avatar_or_voice`);
    if (!(Number(source.durationSeconds) > 0) || !/^[a-f0-9]{64}$/.test(source.mediaSha256 || ''))
      fail('step5_provider_evidence_missing', `${source.id}:media_metadata`);
  }
  const evidence = input.sources[0]!.publicEvidence;
  if (input.sources.some(source => !sameEvidence(source.publicEvidence, evidence)))
    fail('step5_live_bridge_public_evidence_mismatch', 'presenter_evidence_drift');

  const record = buildPublicPresenterRecord(evidence, input.avatarId, input.voiceId, STEP5_LIVE_BRIDGE_PRESENTER_ID);
  const validated = validatePublicHeyGenPresenterRecord(record, input.now ?? new Date());
  if (!validated.ok)
    fail('step5_public_presenter_binding_invalid', validated.reasons.join(','));
  if (validated.avatarId !== input.avatarId || validated.voiceId !== input.voiceId)
    fail('step5_live_bridge_public_evidence_mismatch', 'registry_avatar_or_voice');

  const accountRef = productionBillingAccountRef('heygen', HEYGEN_VIDEO_BILLING_BASE, credentialHash(env));
  if (evidence.accountId !== accountRef) fail('step5_credential_account_changed');

  await ensurePublicPresenterRecord(input.store, record);
  const ports = createStep5LiveAdoptionBridge({
    store: input.store, env,
    ...(input.maxPolls !== undefined ? {maxPolls: input.maxPolls} : {}),
    ...(input.pollIntervalMs !== undefined ? {pollIntervalMs: input.pollIntervalMs} : {}),
  });
  const presenter = await ports.resolvePublicPresenter({tenantId: 't', presenterAssetId: STEP5_LIVE_BRIDGE_PRESENTER_ID});
  if (!presenter) fail('step5_public_presenter_binding_invalid', 'resolve_failed');
  if (presenter.providerPresenterId !== input.avatarId || presenter.providerVoiceId !== input.voiceId)
    fail('step5_live_bridge_public_evidence_mismatch', 'resolved_avatar_or_voice');
  if (!sameEvidence(presenter.publicEvidence, evidence))
    fail('step5_live_bridge_public_evidence_mismatch', 'resolved_evidence_drift');

  const counters: Step5LiveCounters = {
    newPaidSubmissions: 0, newChargedCny: 0,
    statusCalls: 0, downloads: 0, uploads: 0, presentersAdopted: 0,
  };
  return {
    presenter,
    accountRef,
    counters,
    async adopt(source) {
      const result = await ports.adoptProviderTask({
        tenantId: 't',
        taskId: 'video',
        runId: 'run',
        shotId: source.id,
        presenter,
        idempotencyKey: source.requestId,
        adoptedProviderTaskId: source.videoId,
        script: source.script,
        expectedDurationSeconds: source.durationSeconds,
        expectedMediaSha256: source.mediaSha256,
        ...(source.mediaBytes !== undefined ? {expectedMediaBytes: source.mediaBytes} : {}),
        outputDirectory: `${input.outputDirectory}/${source.id}`,
        onProviderEvent: async event => {
          if (event.state === 'checking') counters.statusCalls += 1;
          if (event.state === 'downloaded') counters.downloads += 1;
          if (event.state === 'uploaded') counters.uploads += 1;
          if (event.state === 'completed') counters.presentersAdopted += 1;
          await input.onEvent?.(source.id, event);
        },
      });
      if (result.status === 'completed') return {...result, shotId: source.id};
      if (result.status === 'failed') {
        if (result.error === 'provider_duration_mismatch')
          fail('step5_provider_duration_mismatch', source.id);
        if (result.error === 'provider_content_hash_mismatch')
          fail('step5_provider_media_hash_mismatch', source.id);
        fail('step5_provider_failed', `${source.id}:${result.error || 'provider_failed'}`);
      }
      if (result.status === 'pending') fail('step5_provider_pending', source.id);
      fail('step5_provider_uncertain', `${source.id}:${result.error || 'unknown'}`);
    },
  };
}
