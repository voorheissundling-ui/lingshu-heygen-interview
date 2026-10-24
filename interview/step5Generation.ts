/**
 * Step 5 page-triggered real generation.
 *
 * Unlike the zero-cost adoption bridge, this module may submit NEW paid HeyGen
 * tasks from the interview page. It is gated by:
 *
 *  - real mode + an out-of-repo key + an explicit page enable flag;
 *  - the already-approved Step 4 CNY cap (default 8, never above 8 here);
 *  - a page confirmation whose value equals the env cap;
 *  - a fresh read-only preflight and a live public-presenter/wallet binding.
 *
 * Per-shot request identity is derived from the shot content, so an unchanged
 * shot is reused from Step 4 (or from a previous Step 5 run) and an edited shot
 * gets exactly one new submission. Every paid request is reserved and persisted
 * before the POST. A lost response leaves the ledger in `submission_unknown` and
 * the shot is only ever reconciled by GETs — never resubmitted. Narration can
 * not be list-reconciled, so an unknown narration requires a new content
 * revision (changing the speech changes the request identity).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import type {DataStore} from '../server/storage/datastore.js';
import {runWithDataAuthority} from '../server/storage/dataAuthority.js';
import {HeyGenClient, HeyGenRequestError} from '../server/lib/heygen.js';
import {buildPublicPresenterRecord} from '../server/starter198/socialContentHeyGenBridge.js';
import {
  readTrustedPublicHeyGenRuntimeBinding,
  type TrustedPublicHeyGenRuntimeBinding,
} from '../server/starter198/socialContentHeyGenRuntimeBinding.js';
import {validatePublicHeyGenPresenterRecord} from '../server/lib/presenterAssetTrust.js';
import {productionBillingAccountRef} from '../server/starter198/socialContentProductionBudgetRoutes.js';
import {
  assertBudgetIdentity, assertCanReserve, readBudget, reserve, release, settle, persistBudget,
  roundCny, type Step4Budget,
} from './step4Budget.js';
import type {Storyboard, StoryboardShot} from './storyboard.js';
import {activeProviderDownloadAllowlist, validateProviderDownloadUrl} from './realMode.js';

export const STEP5_GENERATION_MAX_APPROVED_CNY = 8;
export const STEP5_GENERATION_PRESENTER_ID = 'presenter-public-storyboard';
export const STEP5_GENERATION_PROVIDER_TERMS_REF = 'https://www.heygen.com/terms';
export const STEP5_GENERATION_ROOT = path.resolve('.interview-data/step5-generation');
export const STEP5_GENERATION_BUDGET_FILE = path.resolve('.interview-data/step4-shots/budget.json');
export const STEP5_GENERATION_PREFLIGHT_FILE = path.resolve('.interview-data/provider-preflight.json');
export const STEP4_SHOTS_ROOT = path.resolve('.interview-data/step4-shots');
export const STEP4_NARRATION_ROOT = path.resolve('.interview-data/step4-narration');

const MAX_MEDIA_BYTES = 110 * 1024 * 1024;
const MAX_AUDIO_BYTES = 20_000_000;
const PREFLIGHT_MAX_AGE_MS = 7 * 24 * 3600_000;
const RECONCILE_WINDOW_BEFORE_MS = 5 * 60_000;
const RECONCILE_WINDOW_AFTER_MS = 20 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 12 * 60_000;
const execFileAsync = promisify(execFile);

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function fail(code: string, detail?: string): never {
  throw new Error(code + (detail ? `:${detail}` : ''));
}

function scrub(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted-token]')
    .slice(0, 800);
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fail('step5_generation_state_unreadable', path.basename(file));
  }
}

async function persistJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), {mode: 0o600});
  await fs.rename(temp, file);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function isStep5PageGenerationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTERVIEW_REAL_MODE === '1'
    && Boolean(String(env.HEYGEN_API_KEY || '').trim())
    && env.STEP5_PAGE_GENERATION_ENABLED === '1';
}

export function step5GenerationCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const cap = Number(env.HEYGEN_INTERVIEW_MAX_CNY);
  if (!(cap > 0) || !Number.isFinite(cap)) fail('step5_generation_cap_not_configured');
  if (cap > STEP5_GENERATION_MAX_APPROVED_CNY)
    fail('step5_generation_cap_exceeds_limit', String(STEP5_GENERATION_MAX_APPROVED_CNY));
  return cap;
}

function credentialHash(env: NodeJS.ProcessEnv): string {
  const configured = String(env.INTERVIEW_CREDENTIAL_SHA256 || '').trim();
  if (/^[a-f0-9]{64}$/.test(configured)) return configured;
  return sha(String(env.HEYGEN_API_KEY || ''));
}

/* ------------------------------------------------------------------ */
/* Request identity                                                    */
/* ------------------------------------------------------------------ */

export function presenterContentHash(input: {avatarId: string; voiceId: string; speech: string}): string {
  return sha(JSON.stringify({
    v: 1, kind: 'presenter',
    avatarId: input.avatarId.trim(),
    voiceId: input.voiceId.trim(),
    speech: input.speech.trim(),
  }));
}

export function narrationContentHash(input: {
  voiceId: string; engine: 'orca' | 'starfish'; language: string; text: string;
}): string {
  return sha(JSON.stringify({
    v: 1, kind: 'illustration',
    voiceId: input.voiceId.trim(),
    engine: input.engine,
    language: input.language.trim().toLowerCase(),
    text: input.text.trim(),
  }));
}

export function presenterRequestId(shotId: string, contentHash: string): string {
  return `interview-step5-presenter-${shotId}-${contentHash.slice(0, 12)}`;
}

export function narrationRequestId(shotId: string, contentHash: string): string {
  return `interview-step5-tts-${shotId}-${contentHash.slice(0, 12)}`;
}

export function generationTitle(shotId: string, contentHash: string): string {
  return `LingShu Step5 ${shotId} ${contentHash.slice(0, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Provider wallet / preflight                                         */
/* ------------------------------------------------------------------ */

export interface GenerationWallet {
  billingType: string;
  currency: string;
  balance: number;
  autoReload: boolean;
}

export function assertGenerationWallet(wallet: GenerationWallet): void {
  if (wallet.billingType !== 'wallet' || String(wallet.currency).toUpperCase() !== 'USD'
    || !Number.isFinite(wallet.balance) || wallet.balance < 0 || wallet.autoReload !== false)
    fail('step5_generation_wallet_not_safe');
}

export async function readGenerationWallet(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerationWallet> {
  const response = await fetchImpl('https://api.heygen.com/v3/users/me', {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: {'x-api-key': key},
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || !payload?.data) fail('step5_generation_wallet_read_failed', String(response.status));
  const wallet = payload.data?.wallet;
  const value: GenerationWallet = {
    billingType: String(payload.data?.billing_type || ''),
    currency: String(wallet?.currency || ''),
    balance: Number(wallet?.remaining_balance),
    autoReload: wallet?.auto_reload?.enabled === true,
  };
  assertGenerationWallet(value);
  return value;
}

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', chinese: 'zh', spanish: 'es', french: 'fr', german: 'de',
  japanese: 'ja', korean: 'ko', portuguese: 'pt', italian: 'it', arabic: 'ar',
  hindi: 'hi', russian: 'ru',
};
const languageCode = (value: unknown) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return LANGUAGE_CODES[raw] ?? raw.split(/[-_]/)[0];
};

export interface Step5GenerationPreflight {
  checkedAt: string;
  catalogSha256: string;
  avatar: any;
  voice: any;
  engine: 'orca' | 'starfish';
}

export async function readGenerationPreflight(
  input: {storyboard: Storyboard; file?: string; now?: Date},
): Promise<Step5GenerationPreflight> {
  const file = input.file ?? STEP5_GENERATION_PREFLIGHT_FILE;
  let preflight: any;
  try {
    preflight = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    fail('step5_generation_preflight_missing');
  }
  if (preflight.mode !== 'read_only_no_generation' || preflight.preflightOk !== true)
    fail('step5_generation_preflight_incomplete');
  const checkedAtMs = Date.parse(preflight.checkedAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > now + 60_000 || now - checkedAtMs > PREFLIGHT_MAX_AGE_MS)
    fail('step5_generation_preflight_stale_or_in_future');
  const catalogSha256 = String(preflight.catalog?.sha256 || '');
  if (!/^[a-f0-9]{64}$/.test(catalogSha256)) fail('step5_generation_catalog_digest_missing');
  const {avatarId, voiceId} = input.storyboard.presenter;
  const avatar = (preflight.publicAvatars || []).find((item: any) => item.id === avatarId);
  const voice = (preflight.publicVoices || []).find((item: any) => item.id === voiceId);
  if (!avatar || avatar.status !== 'completed'
    || !avatar.supportedEngines?.includes('avatar_iv') || avatar.avatarType !== 'photo_avatar')
    fail('step5_generation_public_avatar_evidence_invalid');
  if (!voice || languageCode(voice.language) !== languageCode(input.storyboard.language))
    fail('step5_generation_public_voice_evidence_invalid');
  const engines = Array.isArray(voice.engines) ? voice.engines : [];
  const engine = engines.includes('orca') ? 'orca' : engines.includes('starfish') ? 'starfish' : '';
  if (!engine) fail('step5_generation_public_voice_has_no_speech_engine');
  return {checkedAt: String(preflight.checkedAt), catalogSha256, avatar, voice, engine: engine as 'orca' | 'starfish'};
}

/* ------------------------------------------------------------------ */
/* Readiness / prepare (no POST)                                       */
/* ------------------------------------------------------------------ */

export interface PreparedStep5Generation {
  capCny: number;
  credentialHash: string;
  accountRef: string;
  wallet: GenerationWallet;
  preflight: Step5GenerationPreflight;
  publicEvidence: TrustedPublicHeyGenRuntimeBinding['publicEvidence'];
  providerEvidenceRef: string;
  presenterAssetId: string;
  narrationEngine: 'orca' | 'starfish';
}

export interface PrepareStep5GenerationInput {
  store: DataStore;
  storyboard: Storyboard;
  confirmedCapCny: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  budgetFile?: string;
  preflightFile?: string;
  wallet?: (key: string) => Promise<GenerationWallet>;
  publicBinding?: (input: {
    store: DataStore; env: NodeJS.ProcessEnv; preflight: Step5GenerationPreflight; storyboard: Storyboard;
  }) => Promise<TrustedPublicHeyGenRuntimeBinding | null>;
  ensurePresenter?: (store: DataStore, record: Record<string, unknown>) => Promise<void>;
}

function validateStoryboardForGeneration(storyboard: Storyboard): void {
  if (!storyboard.shots.length) fail('step5_generation_storyboard_empty');
  for (const shot of storyboard.shots) {
    if (!shot.speech.trim()) fail('step5_generation_speech_missing', shot.id);
    if (shot.kind === 'presenter') {
      if (!(shot.durationSeconds >= 3 && shot.durationSeconds <= 8))
        fail('step5_generation_presenter_duration_must_be_3_to_8_seconds', shot.id);
    } else if (shot.speech.trim().length > 5000) {
      fail('step5_generation_narration_text_invalid', shot.id);
    }
  }
}

/**
 * Proves every precondition WITHOUT making a paid call. The returned wallet
 * balance is the balance observed before the first submission; each submission
 * re-checks it before spending.
 */
export async function prepareStep5Generation(
  input: PrepareStep5GenerationInput,
): Promise<PreparedStep5Generation> {
  const env = input.env ?? process.env;
  if (!isStep5PageGenerationEnabled(env)) fail('step5_generation_disabled');
  const key = String(env.HEYGEN_API_KEY || '').trim();
  if (!key) fail('step5_generation_key_missing');
  const capCny = step5GenerationCapFromEnv(env);
  if (!(input.confirmedCapCny > 0) || !Number.isFinite(input.confirmedCapCny))
    fail('step5_generation_cap_not_confirmed');
  if (Number(input.confirmedCapCny) !== capCny)
    fail('step5_generation_cap_confirmation_mismatch');

  validateStoryboardForGeneration(input.storyboard);

  const credential = credentialHash(env);
  let budget: Step4Budget;
  try {
    budget = await readBudget(input.budgetFile ?? STEP5_GENERATION_BUDGET_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('step5_generation_budget_missing');
    throw error;
  }
  assertBudgetIdentity(budget, {
    approvedCny: capCny, credentialHash: credential, storyboardSha256: budget.storyboardSha256,
  });
  if (budget.approvedCny > STEP5_GENERATION_MAX_APPROVED_CNY)
    fail('step5_generation_budget_approved_above_limit');
  if (roundCny(budget.approvedCny - budget.chargedCny - budget.reservedCny) <= 0)
    fail('step5_generation_budget_exhausted');

  const preflight = await readGenerationPreflight({
    storyboard: input.storyboard,
    ...(input.preflightFile ? {file: input.preflightFile} : {}),
    ...(input.now ? {now: input.now} : {}),
  });

  const wallet = input.wallet
    ? await input.wallet(key)
    : await readGenerationWallet(key);
  assertGenerationWallet(wallet);
  if (!(wallet.balance > 0)) fail('step5_generation_wallet_balance_empty');

  const accountRef = productionBillingAccountRef(
    'heygen', 'https://api.heygen.com/v3/videos', credential,
  );
  const record = buildPublicPresenterRecord({
    ownership: 'public',
    publicCatalogRef: `heygen-public-catalog:${preflight.catalogSha256}`,
    providerTermsRef: STEP5_GENERATION_PROVIDER_TERMS_REF,
    verifiedAt: preflight.checkedAt,
    accountId: accountRef,
  }, input.storyboard.presenter.avatarId, input.storyboard.presenter.voiceId,
  STEP5_GENERATION_PRESENTER_ID);
  const validated = validatePublicHeyGenPresenterRecord(record, input.now ?? new Date());
  if (!validated.ok) fail('step5_generation_public_presenter_binding_invalid', validated.reasons.join(','));

  const ensurePresenter = input.ensurePresenter
    ?? (async (store: DataStore, rec: Record<string, unknown>) => {
      const {ensurePublicPresenterRecord} = await import('./step5LiveBridge.js');
      await ensurePublicPresenterRecord(store, rec);
    });
  await ensurePresenter(input.store, record);

  let binding: TrustedPublicHeyGenRuntimeBinding | null;
  if (input.publicBinding) {
    binding = await input.publicBinding({store: input.store, env, preflight, storyboard: input.storyboard});
  } else {
    binding = await runWithDataAuthority('local', () => readTrustedPublicHeyGenRuntimeBinding({
      tenantId: 't', presenterAssetId: STEP5_GENERATION_PRESENTER_ID,
      language: input.storyboard.language,
    }, {store: input.store, env: () => env, assertCurrent: async () => {}}));
  }
  if (!binding) fail('step5_generation_public_presenter_binding_invalid', 'resolve_failed');
  if (binding.avatarId !== input.storyboard.presenter.avatarId
    || binding.voiceId !== input.storyboard.presenter.voiceId)
    fail('step5_generation_public_presenter_binding_invalid', 'avatar_or_voice_mismatch');
  if (binding.credentialSha256 !== credential)
    fail('step5_generation_credential_account_changed');
  if (binding.accountRef !== accountRef)
    fail('step5_generation_credential_account_changed', 'account_ref');
  if (binding.publicEvidence.ownership !== 'public'
    || 'consentRef' in (binding.publicEvidence as any)
    || 'authorizationRef' in (binding.publicEvidence as any))
    fail('step5_generation_public_evidence_must_not_fake_clone_consent');

  return {
    capCny,
    credentialHash: credential,
    accountRef,
    wallet,
    preflight,
    publicEvidence: binding.publicEvidence,
    providerEvidenceRef: binding.providerEvidenceRef,
    presenterAssetId: STEP5_GENERATION_PRESENTER_ID,
    narrationEngine: preflight.engine,
  };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export type GenerationShotPhase =
  | 'prepared' | 'submitting' | 'accepted' | 'downloaded'
  | 'submission_unknown' | 'rejected' | 'failed';

export interface GenerationReconciliation {
  attempts: number;
  lastAttemptAt?: string;
  lastMethod?: 'list' | 'manual';
  matches?: number;
  note?: string;
}

export interface GenerationShotState {
  schemaVersion: 1;
  shotId: string;
  kind: 'presenter' | 'illustration';
  phase: GenerationShotPhase;
  contentHash: string;
  requestId: string;
  title: string;
  storyboardSha256: string;
  avatarId: string;
  voiceId: string;
  speech?: string;
  text?: string;
  engine?: 'orca' | 'starfish';
  language?: string;
  storyboardDurationSeconds: number;
  provider?: {
    videoId?: string;
    videoHost?: string;
    audioUrl?: string;
    status?: string;
    duration?: number;
    requestId?: string;
    audioHost?: string;
  };
  providerRequest?: Record<string, unknown>;
  providerRequestHash?: string;
  mediaFile?: string;
  mediaSha256?: string;
  mediaBytes?: number;
  durationSeconds?: number;
  budgetForecastCny: number;
  reservationActive?: boolean;
  paidSubmissions: number;
  chargedCny?: number;
  estimatedCostCny?: number;
  walletBefore?: number;
  walletAfter?: number;
  observedWalletDeltaUsd?: number;
  observedWalletDeltaCny?: number;
  withinApprovedCap?: boolean;
  reuse?: {from: 'step4' | 'generation'; sourceFile: string; at: string};
  reconciliation?: GenerationReconciliation;
  createdAt: string;
  submittedAt?: string;
  acceptedAt?: string;
  lastCheckedAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface Step5GenerationShotSummary {
  shotId: string;
  kind: 'presenter' | 'illustration';
  phase: GenerationShotPhase;
  contentHash: string;
  requestId: string;
  title: string;
  providerTaskId: string | null;
  providerStatus: string | null;
  durationSeconds: number | null;
  chargedCny: number;
  reusedFrom: 'step4' | 'generation' | null;
  reconciliation: GenerationReconciliation | null;
  mediaSha256: string | null;
  mediaBytes: number | null;
}

export interface Step5GenerationCounters {
  newPaidSubmissions: number;
  newChargedCny: number;
  statusCalls: number;
  downloads: number;
  reusedShots: number;
  presentersGenerated: number;
  narrationGenerated: number;
  reconciledShots: number;
}

export interface Step5GenerationBudgetSummary {
  approvedCny: number;
  chargedCny: number;
  reservedCny: number;
  remainingCny: number;
  paidSubmissions: number;
}

export interface Step5GenerationMedia {
  presenters: Record<string, {file: string; durationSeconds: number}>;
  narration: Record<string, {file: string; durationSeconds: number}>;
}

export interface Step5GenerationResult {
  prepared: Omit<PreparedStep5Generation, 'wallet'> & {wallet: {balance: number; currency: string; autoReload: boolean}};
  shots: Step5GenerationShotSummary[];
  media: Step5GenerationMedia;
  counters: Step5GenerationCounters;
  budget: Step5GenerationBudgetSummary;
}

export function generationShotDir(shotId: string, root: string = STEP5_GENERATION_ROOT): string {
  return path.join(root, shotId);
}

export function generationStateFile(shotId: string, root: string = STEP5_GENERATION_ROOT): string {
  return path.join(generationShotDir(shotId, root), 'state.json');
}

export function generationMediaFile(
  shotId: string, kind: 'presenter' | 'illustration', root: string = STEP5_GENERATION_ROOT,
): string {
  return path.join(generationShotDir(shotId, root), kind === 'presenter' ? 'provider-output.mp4' : 'narration.mp3');
}

export function summarizeGenerationShot(state: GenerationShotState): Step5GenerationShotSummary {
  return {
    shotId: state.shotId,
    kind: state.kind,
    phase: state.phase,
    contentHash: state.contentHash,
    requestId: state.requestId,
    title: state.title,
    providerTaskId: state.provider?.videoId ?? state.provider?.requestId ?? null,
    providerStatus: state.provider?.status ?? null,
    durationSeconds: state.durationSeconds ?? state.provider?.duration ?? null,
    chargedCny: Number(state.chargedCny ?? 0),
    reusedFrom: state.reuse?.from ?? null,
    reconciliation: state.reconciliation ?? null,
    mediaSha256: state.mediaSha256 ?? null,
    mediaBytes: state.mediaBytes ?? null,
  };
}

export async function readGenerationShot(
  shotId: string, root: string = STEP5_GENERATION_ROOT,
): Promise<GenerationShotState | null> {
  const value = await readJson(generationStateFile(shotId, root));
  return value && value.shotId === shotId ? value as GenerationShotState : null;
}

export async function readStep5GenerationSummary(root: string = STEP5_GENERATION_ROOT): Promise<{
  shots: Step5GenerationShotSummary[];
  unknownShots: string[];
  pendingShots: string[];
} | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  const shots: Step5GenerationShotSummary[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('state-')) continue;
    const value = await readJson(path.join(root, entry, 'state.json')).catch(() => null);
    if (!value || value.schemaVersion !== 1 || value.shotId !== entry) continue;
    shots.push(summarizeGenerationShot(value as GenerationShotState));
  }
  shots.sort((a, b) => a.shotId.localeCompare(b.shotId));
  return {
    shots,
    unknownShots: shots.filter(shot => shot.phase === 'submission_unknown').map(shot => shot.shotId),
    pendingShots: shots.filter(shot => shot.phase === 'submitting' || shot.phase === 'accepted')
      .map(shot => shot.shotId),
  };
}

/* ------------------------------------------------------------------ */
/* Provider reads (GET only)                                           */
/* ------------------------------------------------------------------ */

export interface ProviderVideoSummary {
  id: string;
  title: string;
  createdAtSeconds: number;
  status: string;
  duration: number | null;
  videoUrl: string | null;
}

function mapVideo(item: any): ProviderVideoSummary | null {
  const id = String(item?.id || item?.video_id || '');
  if (!id) return null;
  return {
    id,
    title: String(item.title || ''),
    createdAtSeconds: Number(item.created_at) || 0,
    status: String(item.status || ''),
    duration: Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
    videoUrl: typeof item.video_url === 'string' ? item.video_url : null,
  };
}

export async function listProviderVideos(
  key: string, fetchImpl: typeof fetch = fetch, limit = 100,
): Promise<ProviderVideoSummary[]> {
  const response = await fetchImpl(`https://api.heygen.com/v3/videos?limit=${Math.min(Math.max(limit, 1), 100)}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: {'x-api-key': key},
  });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || !Array.isArray(payload?.data)) fail('step5_reconcile_list_failed', String(response.status));
  return payload.data.map(mapVideo).filter((item: ProviderVideoSummary | null): item is ProviderVideoSummary => Boolean(item));
}

export async function getProviderVideo(
  key: string, videoId: string, fetchImpl: typeof fetch = fetch,
): Promise<ProviderVideoSummary | null> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(videoId)) fail('step5_reconcile_video_id_invalid');
  const response = await fetchImpl(`https://api.heygen.com/v3/videos/${encodeURIComponent(videoId)}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: {'x-api-key': key},
  });
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok || !payload?.data) fail('step5_reconcile_read_failed', String(response.status));
  return mapVideo(payload.data);
}

function submittedAtMs(state: GenerationShotState): number {
  return Date.parse(state.submittedAt || state.createdAt);
}

function isCandidate(state: GenerationShotState, video: ProviderVideoSummary): boolean {
  if (video.title !== state.title) return false;
  const submitted = submittedAtMs(state);
  if (!Number.isFinite(submitted) || !(video.createdAtSeconds > 0)) return false;
  const created = video.createdAtSeconds * 1000;
  return created >= submitted - RECONCILE_WINDOW_BEFORE_MS
    && created <= submitted + RECONCILE_WINDOW_AFTER_MS;
}

/* ------------------------------------------------------------------ */
/* Media probe                                                        */
/* ------------------------------------------------------------------ */

async function probeVideo(file: string): Promise<{
  duration: number; width: number; height: number; videoCodec: string; audioCodec: string;
}> {
  if (!ffmpegStatic) fail('ffmpeg_static_missing');
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegStatic, ['-hide_banner', '-nostdin', '-i', file], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    stderr = String(result.stderr || '');
  } catch (error) {
    stderr = String((error as {stderr?: string}).stderr || '');
  }
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = stderr.match(/Video:\s*([^,\s]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
  const audio = stderr.match(/Audio:\s*([^,\s]+)/);
  if (!duration || !video || !audio) fail('step5_generation_media_probe_failed');
  return {
    duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    width: Number(video[2]),
    height: Number(video[3]),
    videoCodec: video[1].toLowerCase(),
    audioCodec: audio[1].toLowerCase(),
  };
}

async function probeAudio(file: string): Promise<{duration: number; codec: string}> {
  if (!ffmpegStatic) fail('ffmpeg_static_missing');
  let stderr = '';
  try {
    const result = await execFileAsync(ffmpegStatic, ['-hide_banner', '-nostdin', '-i', file], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    });
    stderr = String(result.stderr || '');
  } catch (error) {
    stderr = String((error as {stderr?: string}).stderr || '');
  }
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const audio = stderr.match(/Audio:\s*([^,\s]+)/);
  if (!duration || !audio) fail('step5_generation_narration_probe_failed');
  return {
    duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    codec: audio[1].toLowerCase(),
  };
}

export async function validateGenerationPresenterMedia(file: string, providerDuration: number): Promise<{
  durationSeconds: number; width: number; height: number; videoCodec: string; audioCodec: string;
}> {
  const probe = await probeVideo(file);
  if (Math.abs(probe.duration - providerDuration) > 1.5)
    fail('step5_generation_provider_duration_mismatch');
  if (!(probe.duration >= 2 && probe.duration <= 12.5))
    fail('step5_generation_presenter_duration_invalid', probe.duration.toFixed(2));
  if (Math.abs(probe.width / probe.height - 9 / 16) > 0.01 || ![720, 1080].includes(probe.width))
    fail('step5_generation_media_aspect_invalid', `${probe.width}x${probe.height}`);
  if (!['h264', 'avc1'].includes(probe.videoCodec)) fail('step5_generation_media_codec_invalid', probe.videoCodec);
  if (!['aac', 'mp3', 'opus'].includes(probe.audioCodec)) fail('step5_generation_media_audio_missing', probe.audioCodec);
  return {
    durationSeconds: probe.duration, width: probe.width, height: probe.height,
    videoCodec: probe.videoCodec, audioCodec: probe.audioCodec,
  };
}

export async function validateGenerationNarrationMedia(file: string): Promise<{
  durationSeconds: number; codec: string;
}> {
  const probe = await probeAudio(file);
  if (!(probe.duration > 0) || probe.duration > 20)
    fail('step5_generation_narration_duration_invalid', probe.duration.toFixed(2));
  return {durationSeconds: probe.duration, codec: probe.codec};
}

/* ------------------------------------------------------------------ */
/* Download                                                           */
/* ------------------------------------------------------------------ */

async function downloadBytes(url: string, limit: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const validated = validateProviderDownloadUrl(url);
  if (!validated) fail('step5_generation_media_url_untrusted');
  activeProviderDownloadAllowlist()?.register(validated);
  const response = await fetchImpl(validated, {redirect: 'error', signal: AbortSignal.timeout(120_000)});
  if (!response.ok || !response.body) fail('step5_generation_download_failed', String(response.status));
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        fail('step5_generation_media_too_large', String(size));
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* Generation runtime                                                 */
/* ------------------------------------------------------------------ */

export type NarrationSubmission =
  | {ok: true; data: {audioUrl: string; duration: number; engine: string; requestId?: string}}
  | {ok: false; status: number; error: string};

export interface Step5GenerationReceipt {
  state: 'submitting' | 'accepted' | 'completed' | 'failed';
  requestId: string;
  providerTaskId: string | null;
  metadata: Record<string, unknown>;
}

export type Step5GenerationEvent = {
  type: 'shot';
  shotId: string;
  kind: 'presenter' | 'illustration';
  phase: GenerationShotPhase;
  providerTaskId?: string | null;
};

export interface Step5GenerationDependencies {
  env?: NodeJS.ProcessEnv;
  budgetFile?: string;
  stateRoot?: string;
  step4ShotsRoot?: string;
  step4NarrationRoot?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  wallet?: (key: string) => Promise<GenerationWallet>;
  clientFactory?: (key: string, callbacks: {
    beforeSubmit(request: Record<string, unknown>, requestId: string): Promise<void>;
    onAccepted(taskId: string, requestId: string, receipt?: Record<string, unknown>): Promise<void>;
    onStatus?(taskId: string, receipt: Record<string, unknown>): Promise<void>;
  }) => {
    create(input: {
      avatarId: string; voiceId: string; script: string; engine?: 'avatar_iv';
      ratio: string; transparent: boolean; title: string; fit?: 'cover' | 'contain';
    }, requestId: string): Promise<string>;
    status(id: string): Promise<{status: 'pending' | 'completed' | 'failed'; url?: string; duration?: number; error?: string}>;
  };
  narration?: (input: {
    key: string; request: Record<string, unknown>; requestId: string;
  }) => Promise<NarrationSubmission>;
  download?: (url: string, kind: 'presenter' | 'narration') => Promise<Buffer>;
  listVideos?: (key: string) => Promise<ProviderVideoSummary[]>;
  getVideo?: (key: string, videoId: string) => Promise<ProviderVideoSummary | null>;
  validatePresenterMedia?: (file: string, providerDuration: number) => Promise<{
    durationSeconds: number; width?: number; height?: number;
  }>;
  validateNarrationMedia?: (file: string) => Promise<{durationSeconds: number; codec?: string}>;
  recordReceipt?: (receipt: Step5GenerationReceipt) => Promise<void>;
  onEvent?: (event: Step5GenerationEvent) => void | Promise<void>;
}

export interface RunStep5GenerationInput extends Step5GenerationDependencies {
  store?: DataStore;
  storyboard: Storyboard;
  storyboardSha256: string;
  confirmedCapCny: number;
  prepared?: PreparedStep5Generation;
}

interface Runtime {
  env: NodeJS.ProcessEnv;
  key: string;
  budgetFile: string;
  stateRoot: string;
  step4ShotsRoot: string;
  step4NarrationRoot: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  wallet: (key: string) => Promise<GenerationWallet>;
  clientFactory: NonNullable<Step5GenerationDependencies['clientFactory']>;
  narration: NonNullable<Step5GenerationDependencies['narration']>;
  download: NonNullable<Step5GenerationDependencies['download']>;
  listVideos: NonNullable<Step5GenerationDependencies['listVideos']>;
  getVideo: NonNullable<Step5GenerationDependencies['getVideo']>;
  validatePresenterMedia: NonNullable<Step5GenerationDependencies['validatePresenterMedia']>;
  validateNarrationMedia: NonNullable<Step5GenerationDependencies['validateNarrationMedia']>;
  recordReceipt?: Step5GenerationDependencies['recordReceipt'];
  onEvent?: Step5GenerationDependencies['onEvent'];
}

function defaultNarration(key: string): NonNullable<Step5GenerationDependencies['narration']> {
  return async ({request}) => {
    let response: Response;
    try {
      response = await fetch('https://api.heygen.com/v3/voices/speech', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: {'x-api-key': key, 'Content-Type': 'application/json'},
        body: JSON.stringify(request),
      });
    } catch (error) {
      return {ok: false, status: 0, error: scrub(error)};
    }
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const known = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
      return {
        ok: false, status: response.status,
        error: `${known ? 'providerrejected:' : ''}${scrub(payload?.error?.message || payload?.error?.code || 'speech_failed')}`,
      };
    }
    const data = payload?.data || payload;
    if (typeof data?.audio_url !== 'string' || !Number.isFinite(Number(data?.duration))
      || Number(data.duration) <= 0 || !['orca', 'starfish'].includes(String(data?.engine)))
      return {ok: false, status: 200, error: 'step5_generation_narration_receipt_invalid'};
    return {
      ok: true,
      data: {
        audioUrl: String(data.audio_url),
        duration: Number(data.duration),
        engine: String(data.engine),
        requestId: data.request_id ? String(data.request_id) : undefined,
      },
    };
  };
}

function buildRuntime(input: RunStep5GenerationInput, prepared: PreparedStep5Generation): Runtime {
  const env = input.env ?? process.env;
  const key = String(env.HEYGEN_API_KEY || '').trim();
  if (!key) fail('step5_generation_key_missing');
  if (credentialHash(env) !== prepared.credentialHash) fail('step5_generation_credential_account_changed');
  if (step5GenerationCapFromEnv(env) !== prepared.capCny)
    fail('step5_generation_cap_confirmation_mismatch', 'env_changed');
  const stateRoot = input.stateRoot ?? STEP5_GENERATION_ROOT;
  return {
    env, key,
    budgetFile: input.budgetFile ?? STEP5_GENERATION_BUDGET_FILE,
    stateRoot,
    step4ShotsRoot: input.step4ShotsRoot ?? STEP4_SHOTS_ROOT,
    step4NarrationRoot: input.step4NarrationRoot ?? STEP4_NARRATION_ROOT,
    now: input.now ?? (() => new Date()),
    sleep: input.sleep ?? sleep,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs: input.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    wallet: input.wallet ?? ((credential) => readGenerationWallet(credential)),
    clientFactory: input.clientFactory ?? ((credential, callbacks) => new HeyGenClient(credential, fetch, callbacks)),
    narration: input.narration ?? defaultNarration(key),
    download: input.download ?? ((url) => downloadBytes(url, MAX_MEDIA_BYTES)),
    listVideos: input.listVideos ?? ((credential) => listProviderVideos(credential)),
    getVideo: input.getVideo ?? ((credential, id) => getProviderVideo(credential, id)),
    validatePresenterMedia: input.validatePresenterMedia ?? validateGenerationPresenterMedia,
    validateNarrationMedia: input.validateNarrationMedia ?? validateGenerationNarrationMedia,
    ...(input.recordReceipt ? {recordReceipt: input.recordReceipt} : {}),
    ...(input.onEvent ? {onEvent: input.onEvent} : {}),
  };
}

async function emit(
  runtime: Pick<Runtime, 'onEvent'>, state: GenerationShotState,
): Promise<void> {
  await runtime.onEvent?.({
    type: 'shot', shotId: state.shotId, kind: state.kind, phase: state.phase,
    providerTaskId: state.provider?.videoId ?? state.provider?.requestId ?? null,
  });
}

async function persistShot(
  runtime: Pick<Runtime, 'stateRoot'>, state: GenerationShotState,
): Promise<void> {
  await persistJson(generationStateFile(state.shotId, runtime.stateRoot), state);
}

async function receipt(runtime: Runtime, value: Step5GenerationReceipt): Promise<void> {
  await runtime.recordReceipt?.(value);
}

function expectedForecast(budget: Step4Budget, shot: StoryboardShot, engine: 'orca' | 'starfish'): number {
  if (shot.kind === 'presenter') {
    return roundCny(budget.avatarUsdPerMinute * budget.fx.cnyPerUsd * (shot.durationSeconds + 3) / 60);
  }
  return engine === 'orca'
    ? roundCny(budget.speechUsdPerMillionChars * shot.speech.trim().length / 1_000_000 * budget.fx.cnyPerUsd)
    : roundCny(0.12 * (shot.durationSeconds + 3) / 60 * budget.fx.cnyPerUsd);
}

function newShotState(input: {
  shot: StoryboardShot;
  kind: 'presenter' | 'illustration';
  contentHash: string;
  requestId: string;
  title: string;
  storyboardSha256: string;
  avatarId: string;
  voiceId: string;
  engine?: 'orca' | 'starfish';
  language?: string;
  forecastCny: number;
  now: string;
  walletBefore: number;
}): GenerationShotState {
  return {
    schemaVersion: 1,
    shotId: input.shot.id,
    kind: input.kind,
    phase: 'prepared',
    contentHash: input.contentHash,
    requestId: input.requestId,
    title: input.title,
    storyboardSha256: input.storyboardSha256,
    avatarId: input.avatarId,
    voiceId: input.voiceId,
    ...(input.kind === 'presenter' ? {speech: input.shot.speech.trim()} : {text: input.shot.speech.trim()}),
    ...(input.engine ? {engine: input.engine} : {}),
    ...(input.language ? {language: input.language} : {}),
    storyboardDurationSeconds: input.shot.durationSeconds,
    budgetForecastCny: input.forecastCny,
    paidSubmissions: 0,
    walletBefore: input.walletBefore,
    createdAt: input.now,
  };
}

async function archiveStateIfChanged(
  runtime: Runtime, state: GenerationShotState, contentHash: string,
): Promise<void> {
  if (state.contentHash === contentHash) return;
  const file = generationStateFile(state.shotId, runtime.stateRoot);
  const archive = path.join(path.dirname(file), `state-${state.contentHash.slice(0, 16)}.json`);
  if (!(await exists(archive))) await fs.copyFile(file, archive);
}

async function mediaFileValid(file: string, expectedSha: string | undefined, expectedBytes?: number): Promise<boolean> {
  if (!(await exists(file))) return false;
  try {
    const bytes = await fs.readFile(file);
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) return false;
    return !expectedSha || sha(bytes) === expectedSha;
  } catch {
    return false;
  }
}

/* ------------------------- Step 4 reuse --------------------------- */

async function tryReuseStep4Presenter(input: {
  runtime: Runtime;
  shot: StoryboardShot;
  contentHash: string;
  avatarId: string;
  voiceId: string;
}): Promise<GenerationShotState | null> {
  const root = path.join(input.runtime.step4ShotsRoot, input.shot.id);
  const state = await readJson(path.join(root, 'state.json'));
  const media = String(state?.mediaFile || path.join(root, 'provider-output.mp4'));
  if (!state || state.phase !== 'downloaded' || state.fit !== 'cover') return null;
  if (state.avatarId !== input.avatarId || state.voiceId !== input.voiceId
    || String(state.speech || '').trim() !== input.shot.speech.trim()) return null;
  const hash = presenterContentHash({
    avatarId: state.avatarId, voiceId: state.voiceId, speech: state.speech,
  });
  if (hash !== input.contentHash) return null;
  if (!(Number(state.duration) > 0) || !/^[a-f0-9]{64}$/.test(String(state.mediaSha256 || ''))) return null;
  if (!(await mediaFileValid(media, state.mediaSha256, state.mediaBytes))) return null;

  const target = generationMediaFile(input.shot.id, 'presenter', input.runtime.stateRoot);
  await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  await fs.copyFile(media, target);
  const stamp = input.runtime.now().toISOString();
  return {
    schemaVersion: 1,
    shotId: input.shot.id,
    kind: 'presenter',
    phase: 'downloaded',
    contentHash: input.contentHash,
    requestId: String(state.requestId),
    title: generationTitle(input.shot.id, input.contentHash),
    storyboardSha256: String(state.storyboardSha256 || ''),
    avatarId: input.avatarId,
    voiceId: input.voiceId,
    speech: input.shot.speech.trim(),
    storyboardDurationSeconds: input.shot.durationSeconds,
    provider: {
      videoId: String(state.videoId),
      status: 'completed',
      duration: Number(state.duration),
      requestId: state.provider?.requestId ? String(state.provider.requestId) : undefined,
      ...(state.providerVideoHost ? {videoHost: String(state.providerVideoHost)} : {}),
    },
    mediaFile: target,
    mediaSha256: String(state.mediaSha256),
    mediaBytes: Number(state.mediaBytes ?? 0) || undefined,
    durationSeconds: Number(state.duration),
    budgetForecastCny: 0,
    paidSubmissions: 0,
    chargedCny: 0,
    reuse: {from: 'step4', sourceFile: media, at: stamp},
    createdAt: stamp,
    completedAt: stamp,
  };
}

async function tryReuseStep4Narration(input: {
  runtime: Runtime;
  shot: StoryboardShot;
  contentHash: string;
  voiceId: string;
  engine: 'orca' | 'starfish';
  language: string;
}): Promise<GenerationShotState | null> {
  const root = path.join(input.runtime.step4NarrationRoot, input.shot.id);
  const state = await readJson(path.join(root, 'state.json'));
  const media = String(state?.audioFile || path.join(root, 'narration.mp3'));
  if (!state || state.phase !== 'downloaded') return null;
  if (state.voiceId !== input.voiceId || String(state.text || '').trim() !== input.shot.speech.trim()) return null;
  const stateEngine = String(state.engine);
  if (stateEngine !== 'orca' && stateEngine !== 'starfish') return null;
  if (stateEngine !== input.engine || String(state.language || 'en') !== input.language) return null;
  const hash = narrationContentHash({
    voiceId: state.voiceId, engine: stateEngine, language: state.language, text: state.text,
  });
  if (hash !== input.contentHash) return null;
  if (!(Number(state.provider?.duration) > 0) || !/^[a-f0-9]{64}$/.test(String(state.audioSha256 || ''))) return null;
  if (!(await mediaFileValid(media, state.audioSha256, state.audioBytes))) return null;

  const target = generationMediaFile(input.shot.id, 'illustration', input.runtime.stateRoot);
  await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
  await fs.copyFile(media, target);
  const stamp = input.runtime.now().toISOString();
  return {
    schemaVersion: 1,
    shotId: input.shot.id,
    kind: 'illustration',
    phase: 'downloaded',
    contentHash: input.contentHash,
    requestId: String(state.requestId),
    title: generationTitle(input.shot.id, input.contentHash),
    storyboardSha256: String(state.storyboardSha256 || ''),
    avatarId: '',
    voiceId: input.voiceId,
    text: input.shot.speech.trim(),
    engine: input.engine,
    language: input.language,
    storyboardDurationSeconds: input.shot.durationSeconds,
    provider: {
      status: 'completed',
      duration: Number(state.provider.duration),
      requestId: state.provider?.requestId ? String(state.provider.requestId) : undefined,
      audioHost: state.provider?.audioUrlHost ? String(state.provider.audioUrlHost) : undefined,
    },
    mediaFile: target,
    mediaSha256: String(state.audioSha256),
    mediaBytes: Number(state.audioBytes ?? 0) || undefined,
    durationSeconds: Number(state.provider.duration),
    budgetForecastCny: 0,
    paidSubmissions: 0,
    chargedCny: 0,
    reuse: {from: 'step4', sourceFile: media, at: stamp},
    createdAt: stamp,
    completedAt: stamp,
  };
}

/* ------------------------- Reconciliation ------------------------- */

interface ReconcileRuntime {
  key: string;
  stateRoot: string;
  now: () => Date;
  getVideo: (key: string, videoId: string) => Promise<ProviderVideoSummary | null>;
  listVideos: (key: string) => Promise<ProviderVideoSummary[]>;
  onEvent?: Step5GenerationDependencies['onEvent'];
}

interface ReconcileContext {
  runtime: ReconcileRuntime;
  state: GenerationShotState;
  method: 'list' | 'manual';
  videoId?: string;
}

async function adoptProviderVideo(
  context: ReconcileContext,
  video: ProviderVideoSummary,
): Promise<void> {
  const {state, runtime} = context;
  if (video.title !== state.title) fail('step5_reconcile_video_identity_mismatch');
  if (!isCandidate(state, video)) fail('step5_reconcile_video_identity_mismatch', 'created_at_window');
  if (video.status === 'failed') {
    state.phase = 'failed';
    state.provider = {...state.provider, videoId: video.id, status: video.status};
    state.lastError = 'provider_task_failed_after_reconciliation';
    state.reconciliation = {
      ...(state.reconciliation ?? {attempts: 0}),
      attempts: (state.reconciliation?.attempts ?? 0) + 1,
      lastAttemptAt: runtime.now().toISOString(),
      lastMethod: context.method,
      matches: 1,
      note: 'provider task failed; no resubmission',
    };
    await persistShot(runtime, state);
    fail('step5_generation_provider_failed:providerrejected');
  }
  state.phase = 'accepted';
  let videoHost: string | undefined;
  if (video.videoUrl) {
    try { videoHost = new URL(video.videoUrl).hostname; } catch { videoHost = undefined; }
  }
  state.provider = {
    ...state.provider,
    videoId: video.id,
    status: video.status || 'pending',
    ...(videoHost ? {videoHost} : {}),
    ...(video.duration ? {duration: video.duration} : {}),
  };
  state.acceptedAt = state.acceptedAt ?? runtime.now().toISOString();
  state.reconciliation = {
    ...(state.reconciliation ?? {attempts: 0}),
    attempts: (state.reconciliation?.attempts ?? 0) + 1,
    lastAttemptAt: runtime.now().toISOString(),
    lastMethod: context.method,
    matches: 1,
    note: 'adopted by GET only; no second submission',
  };
  delete state.lastError;
  await persistShot(runtime, state);
  await emit(runtime, state);
}

export async function reconcileGenerationShot(input: {
  runtime: ReconcileRuntime;
  state: GenerationShotState;
  method: 'list' | 'manual';
  videoId?: string;
}): Promise<GenerationShotState> {
  const {runtime, state} = input;
  if (state.kind === 'illustration')
    fail('step5_reconcile_requires_new_content_revision', state.shotId);
  if (!['submitting', 'submission_unknown', 'accepted'].includes(state.phase)) {
    fail('step5_reconcile_not_in_unknown_state', `${state.shotId}:${state.phase}`);
  }

  if (input.method === 'manual') {
    const videoId = String(input.videoId || '');
    if (!videoId) fail('step5_reconcile_video_id_required');
    const video = await runtime.getVideo(runtime.key, videoId);
    if (!video) fail('step5_reconcile_not_found', videoId);
    await adoptProviderVideo({runtime, state, method: 'manual', videoId}, video);
    return state;
  }

  const videos = await runtime.listVideos(runtime.key);
  const matches = videos.filter(video => isCandidate(state, video));
  state.reconciliation = {
    ...(state.reconciliation ?? {attempts: 0}),
    attempts: (state.reconciliation?.attempts ?? 0) + 1,
    lastAttemptAt: runtime.now().toISOString(),
    lastMethod: 'list',
    matches: matches.length,
  };
  if (matches.length === 0) {
    await persistShot(runtime, state);
    fail('step5_reconcile_not_found', state.shotId);
  }
  if (matches.length > 1) {
    await persistShot(runtime, state);
    fail('step5_reconcile_ambiguous', state.shotId);
  }
  await adoptProviderVideo({runtime, state, method: 'list', videoId: matches[0]!.id}, matches[0]!);
  return state;
}

/* ------------------------- Presenter flow ------------------------- */

async function ensureWalletCovers(
  runtime: Runtime, budget: Step4Budget, forecastCny: number,
): Promise<GenerationWallet> {
  const wallet = await runtime.wallet(runtime.key);
  assertGenerationWallet(wallet);
  if (!(wallet.balance * budget.fx.cnyPerUsd >= forecastCny))
    fail('step5_generation_wallet_not_safe', 'insufficient_balance_for_forecast');
  return wallet;
}

async function submitPresenter(input: {
  runtime: Runtime;
  budget: Step4Budget;
  shot: StoryboardShot;
  state: GenerationShotState;
  counters: Step5GenerationCounters;
}): Promise<void> {
  const {runtime, budget, shot, state, counters} = input;
  const forecastCny = state.budgetForecastCny;
  assertCanReserve(budget, forecastCny);
  const wallet = await ensureWalletCovers(runtime, budget, forecastCny);
  state.walletBefore = wallet.balance;

  const budgetState = budget;
  const client = runtime.clientFactory(runtime.key, {
    beforeSubmit: async (request, requestId) => {
      if (state.phase !== 'prepared' || state.paidSubmissions !== 0 || state.requestId !== requestId)
        fail('step5_generation_submission_not_authorized');
      const requestHash = sha(JSON.stringify(request));
      if (state.providerRequestHash && state.providerRequestHash !== requestHash)
        fail('step5_generation_submission_body_drift');
      reserve(budgetState, forecastCny);
      await persistBudget(runtime.budgetFile, budgetState);
      state.reservationActive = true;
      state.phase = 'submitting';
      state.paidSubmissions = 1;
      state.providerRequest = request;
      state.providerRequestHash = requestHash;
      state.submittedAt = runtime.now().toISOString();
      await persistShot(runtime, state);
      counters.newPaidSubmissions += 1;
      await receipt(runtime, {
        state: 'submitting', requestId, providerTaskId: null,
        metadata: {
          shotId: shot.id, kind: 'presenter', title: state.title,
          contentHash: state.contentHash, forecastCny,
        },
      });
      await emit(runtime, state);
    },
    onAccepted: async (taskId, requestId) => {
      if (state.requestId !== requestId) fail('step5_generation_accepted_request_mismatch');
      state.phase = 'accepted';
      state.provider = {...state.provider, videoId: taskId, status: 'pending'};
      state.acceptedAt = runtime.now().toISOString();
      await persistShot(runtime, state);
      await receipt(runtime, {
        state: 'accepted', requestId, providerTaskId: taskId,
        metadata: {shotId: shot.id, kind: 'presenter', title: state.title},
      });
      await emit(runtime, state);
    },
    onStatus: async (taskId, value) => {
      state.lastCheckedAt = runtime.now().toISOString();
      state.provider = {
        ...state.provider,
        videoId: taskId,
        status: String(value.status || 'pending'),
      };
      if (Number.isFinite(Number(value.duration))) state.provider.duration = Number(value.duration);
      if (typeof value.video_url === 'string') {
        try { state.provider.videoHost = new URL(value.video_url).hostname; } catch { /* host only */ }
      }
      await persistShot(runtime, state);
    },
  });

  try {
    await client.create({
      avatarId: state.avatarId, voiceId: state.voiceId, script: state.speech || '',
      ratio: '9:16', transparent: false, title: state.title, fit: 'cover',
    }, state.requestId);
  } catch (error) {
    if (state.phase === 'prepared') {
      release(budgetState, forecastCny);
      await persistBudget(runtime.budgetFile, budgetState);
      delete state.reservationActive;
      state.lastError = scrub(error);
      await persistShot(runtime, state);
      fail('step5_generation_submission_failed_before_send', scrub(error));
    }
    const knownRejection = error instanceof HeyGenRequestError
      && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
    state.phase = knownRejection ? 'rejected' : 'submission_unknown';
    state.lastError = scrub(error);
    if (knownRejection && state.reservationActive) {
      release(budgetState, forecastCny);
      await persistBudget(runtime.budgetFile, budgetState);
      delete state.reservationActive;
    }
    await persistShot(runtime, state);
    await receipt(runtime, {
      state: 'failed', requestId: state.requestId, providerTaskId: null,
      metadata: {shotId: shot.id, kind: 'presenter', reason: knownRejection ? 'known_rejection' : 'unknown'},
    });
    if (knownRejection)
      fail('step5_generation_rejected_no_resubmit:providerrejected', shot.id);
    fail('step5_submission_unknown', shot.id);
  }
}

async function waitForPresenter(
  input: {runtime: Runtime; state: GenerationShotState; counters: Step5GenerationCounters; shotId: string},
): Promise<{url: string; duration: number}> {
  const {runtime, state, counters} = input;
  const deadline = runtime.now().getTime() + runtime.pollTimeoutMs;
  const client = runtime.clientFactory(runtime.key, {
    beforeSubmit: async () => fail('step5_generation_submission_not_authorized'),
    onAccepted: async () => fail('step5_generation_submission_not_authorized'),
  });
  for (;;) {
    const videoId = state.provider?.videoId;
    if (!videoId) fail('step5_generation_video_id_missing_do_not_resubmit', input.shotId);
    let result: Awaited<ReturnType<typeof client.status>>;
    try {
      result = await client.status(videoId);
      counters.statusCalls += 1;
    } catch (error) {
      // A status read failure does not make the submission unknown: the video
      // id is already persisted. Treat it as pending until the deadline.
      state.lastCheckedAt = runtime.now().toISOString();
      state.lastError = scrub(error);
      await persistShot(runtime, state);
      if (runtime.now().getTime() >= deadline)
        fail('step5_provider_pending', `${input.shotId}:status_read_failed`);
      await runtime.sleep(runtime.pollIntervalMs);
      continue;
    }
    if (result.status === 'completed') {
      if (!result.url || !(Number(result.duration) > 0))
        fail('step5_generation_provider_receipt_invalid', input.shotId);
      return {url: result.url, duration: Number(result.duration)};
    }
    if (result.status === 'failed') {
      state.phase = 'failed';
      state.provider = {...state.provider, status: 'failed'};
      state.lastError = 'provider_generation_failed';
      await persistShot(runtime, state);
      await receipt(runtime, {
        state: 'failed', requestId: state.requestId, providerTaskId: state.provider?.videoId ?? null,
        metadata: {shotId: input.shotId, kind: 'presenter', reason: 'provider_failed'},
      });
      fail('step5_generation_provider_failed:providerrejected', input.shotId);
    }
    state.provider = {...state.provider, status: 'pending'};
    state.lastCheckedAt = runtime.now().toISOString();
    await persistShot(runtime, state);
    if (runtime.now().getTime() >= deadline)
      fail('step5_provider_pending', `${input.shotId}:poll_timeout`);
    await runtime.sleep(runtime.pollIntervalMs);
  }
}

async function finishPresenter(input: {
  runtime: Runtime;
  budget: Step4Budget;
  state: GenerationShotState;
  counters: Step5GenerationCounters;
  url: string;
  providerDuration: number;
}): Promise<void> {
  const {runtime, budget, state, counters} = input;
  const mediaFile = generationMediaFile(state.shotId, 'presenter', runtime.stateRoot);
  let bytes: Buffer;
  let probe: Awaited<ReturnType<Runtime['validatePresenterMedia']>>;
  try {
    bytes = await runtime.download(input.url, 'presenter');
    await fs.writeFile(mediaFile, bytes, {mode: 0o600});
    counters.downloads += 1;
    probe = await runtime.validatePresenterMedia(mediaFile, input.providerDuration);
  } catch (error) {
    // Keep the accepted ledger so a later run retries the download against the
    // same video id instead of submitting a new paid task.
    state.lastError = scrub(error);
    state.lastCheckedAt = runtime.now().toISOString();
    await persistShot(runtime, state);
    throw error;
  }

  const walletAfter = await runtime.wallet(runtime.key);
  assertGenerationWallet(walletAfter);
  const observedUsd = Number(state.walletBefore ?? walletAfter.balance) - walletAfter.balance;
  const observedCny = observedUsd * budget.fx.cnyPerUsd;
  const estimatedCny = roundCny(budget.avatarUsdPerMinute * probe.durationSeconds / 60 * budget.fx.cnyPerUsd);
  const settled = settle(budget, {
    kind: 'presenter_shot', id: state.shotId, at: runtime.now().toISOString(),
    requestedAt: state.submittedAt ?? state.createdAt,
    forecastCny: state.budgetForecastCny, estimatedCny, observedDeltaCny: observedCny,
    walletBefore: state.walletBefore ?? null, walletAfter: walletAfter.balance,
    providerRef: state.provider?.videoId ?? null,
  });
  await persistBudget(runtime.budgetFile, budget);
  delete state.reservationActive;

  state.phase = 'downloaded';
  state.mediaFile = mediaFile;
  state.mediaBytes = bytes.length;
  state.mediaSha256 = sha(bytes);
  state.durationSeconds = probe.durationSeconds;
  state.provider = {
    ...state.provider,
    status: 'completed',
    duration: input.providerDuration,
  };
  state.estimatedCostCny = estimatedCny;
  state.observedWalletDeltaUsd = observedUsd;
  state.observedWalletDeltaCny = observedCny;
  state.walletAfter = walletAfter.balance;
  state.chargedCny = settled.chargedCny;
  state.withinApprovedCap = budget.chargedCny <= budget.approvedCny;
  state.completedAt = runtime.now().toISOString();
  delete state.lastError;
  await persistShot(runtime, state);
  counters.newChargedCny = roundCny(counters.newChargedCny + settled.chargedCny);
  counters.presentersGenerated += 1;
  await receipt(runtime, {
    state: 'completed', requestId: state.requestId,
    providerTaskId: state.provider?.videoId ?? null,
    metadata: {
      shotId: state.shotId, kind: 'presenter', title: state.title,
      contentHash: state.contentHash, mediaSha256: state.mediaSha256,
      chargedCny: settled.chargedCny,
    },
  });
  await emit(runtime, state);
}

/* ------------------------- Narration flow ------------------------- */

async function submitNarration(input: {
  runtime: Runtime;
  budget: Step4Budget;
  shot: StoryboardShot;
  state: GenerationShotState;
  counters: Step5GenerationCounters;
}): Promise<void> {
  const {runtime, budget, shot, state, counters} = input;
  const forecastCny = state.budgetForecastCny;
  assertCanReserve(budget, forecastCny);
  const wallet = await ensureWalletCovers(runtime, budget, forecastCny);
  state.walletBefore = wallet.balance;

  const request: Record<string, unknown> = {
    text: state.text, voice_id: state.voiceId, input_type: 'text', speed: 1,
    language: state.language || 'en', force_regenerate: false, engine: state.engine,
  };
  const requestHash = sha(JSON.stringify(request));
  reserve(budget, forecastCny);
  await persistBudget(runtime.budgetFile, budget);
  state.reservationActive = true;
  state.phase = 'submitting';
  state.paidSubmissions = 1;
  state.providerRequest = request;
  state.providerRequestHash = requestHash;
  state.submittedAt = runtime.now().toISOString();
  await persistShot(runtime, state);
  counters.newPaidSubmissions += 1;
  await receipt(runtime, {
    state: 'submitting', requestId: state.requestId, providerTaskId: null,
    metadata: {shotId: shot.id, kind: 'illustration', title: state.title, forecastCny},
  });
  await emit(runtime, state);

  const result = await runtime.narration({
    key: runtime.key, request, requestId: state.requestId,
  });
  if (!result.ok) {
    const knownRejection = result.status >= 400 && result.status < 500 && ![408, 429].includes(result.status);
    state.phase = knownRejection ? 'rejected' : 'submission_unknown';
    state.lastError = result.error;
    if (knownRejection && state.reservationActive) {
      release(budget, forecastCny);
      await persistBudget(runtime.budgetFile, budget);
      delete state.reservationActive;
    }
    await persistShot(runtime, state);
    await receipt(runtime, {
      state: 'failed', requestId: state.requestId, providerTaskId: null,
      metadata: {
        shotId: shot.id, kind: 'illustration',
        reason: knownRejection ? 'known_rejection' : 'unknown_no_list_reconciliation',
      },
    });
    if (knownRejection)
      fail('step5_generation_rejected_no_resubmit:providerrejected', shot.id);
    fail('step5_submission_unknown', `${shot.id}:narration_cannot_be_list_reconciled`);
  }
  const audioUrl = validateProviderDownloadUrl(result.data.audioUrl);
  if (result.data.engine !== state.engine || !audioUrl) {
    state.phase = 'submission_unknown';
    state.lastError = !audioUrl ? 'audio_url_untrusted' : 'engine_drift';
    await persistShot(runtime, state);
    fail('step5_submission_unknown', `${shot.id}:${state.lastError}`);
  }
  state.phase = 'accepted';
  state.provider = {
    ...state.provider,
    status: 'completed',
    duration: result.data.duration,
    audioUrl,
    audioHost: new URL(audioUrl).hostname,
    requestId: result.data.requestId,
  };
  state.acceptedAt = runtime.now().toISOString();
  await persistShot(runtime, state);
  await receipt(runtime, {
    state: 'accepted', requestId: state.requestId,
    providerTaskId: result.data.requestId ?? null,
    metadata: {shotId: shot.id, kind: 'illustration', title: state.title},
  });
  await emit(runtime, state);
}

async function finishNarration(input: {
  runtime: Runtime;
  budget: Step4Budget;
  state: GenerationShotState;
  counters: Step5GenerationCounters;
}): Promise<void> {
  const {runtime, budget, state, counters} = input;
  const audioUrl = state.provider?.audioUrl;
  if (!audioUrl) fail('step5_generation_audio_url_missing_do_not_resubmit', state.shotId);
  const mediaFile = generationMediaFile(state.shotId, 'illustration', runtime.stateRoot);
  let bytes: Buffer;
  let probe: Awaited<ReturnType<Runtime['validateNarrationMedia']>>;
  try {
    bytes = await runtime.download(audioUrl, 'narration');
    await fs.writeFile(mediaFile, bytes, {mode: 0o600});
    counters.downloads += 1;
    probe = await runtime.validateNarrationMedia(mediaFile);
  } catch (error) {
    // Keep the accepted ledger and audio URL so a later run retries only the
    // download; narration cannot be list-reconciled after a new submission.
    state.lastError = scrub(error);
    state.lastCheckedAt = runtime.now().toISOString();
    await persistShot(runtime, state);
    throw error;
  }

  const walletAfter = await runtime.wallet(runtime.key);
  assertGenerationWallet(walletAfter);
  const observedUsd = Number(state.walletBefore ?? walletAfter.balance) - walletAfter.balance;
  const observedCny = observedUsd * budget.fx.cnyPerUsd;
  const estimatedCny = state.engine === 'orca'
    ? roundCny(budget.speechUsdPerMillionChars * String(state.text || '').length / 1_000_000 * budget.fx.cnyPerUsd)
    : roundCny(0.12 * probe.durationSeconds / 60 * budget.fx.cnyPerUsd);
  const settled = settle(budget, {
    kind: 'explainer_speech', id: state.shotId, at: runtime.now().toISOString(),
    requestedAt: state.submittedAt ?? state.createdAt,
    forecastCny: state.budgetForecastCny, estimatedCny, observedDeltaCny: observedCny,
    walletBefore: state.walletBefore ?? null, walletAfter: walletAfter.balance,
    providerRef: state.provider?.requestId ?? null,
  });
  await persistBudget(runtime.budgetFile, budget);
  delete state.reservationActive;

  state.phase = 'downloaded';
  state.mediaFile = mediaFile;
  state.mediaBytes = bytes.length;
  state.mediaSha256 = sha(bytes);
  state.durationSeconds = probe.durationSeconds;
  if (state.provider) delete state.provider.audioUrl;
  state.estimatedCostCny = estimatedCny;
  state.observedWalletDeltaUsd = observedUsd;
  state.observedWalletDeltaCny = observedCny;
  state.walletAfter = walletAfter.balance;
  state.chargedCny = settled.chargedCny;
  state.withinApprovedCap = budget.chargedCny <= budget.approvedCny;
  state.completedAt = runtime.now().toISOString();
  delete state.lastError;
  await persistShot(runtime, state);
  counters.newChargedCny = roundCny(counters.newChargedCny + settled.chargedCny);
  counters.narrationGenerated += 1;
  await receipt(runtime, {
    state: 'completed', requestId: state.requestId,
    providerTaskId: state.provider?.requestId ?? null,
    metadata: {
      shotId: state.shotId, kind: 'illustration', title: state.title,
      contentHash: state.contentHash, mediaSha256: state.mediaSha256,
      chargedCny: settled.chargedCny,
    },
  });
  await emit(runtime, state);
}

/* ------------------------- Per-shot orchestration ----------------- */

async function generateShot(input: {
  runtime: Runtime;
  budget: Step4Budget;
  shot: StoryboardShot;
  prepared: PreparedStep5Generation;
  storyboard: Storyboard;
  storyboardSha256: string;
  counters: Step5GenerationCounters;
}): Promise<GenerationShotState> {
  const {runtime, budget, shot, prepared, storyboard, storyboardSha256, counters} = input;
  const kind = shot.kind;
  const voiceId = storyboard.presenter.voiceId;
  const contentHash = kind === 'presenter'
    ? presenterContentHash({avatarId: storyboard.presenter.avatarId, voiceId, speech: shot.speech})
    : narrationContentHash({
      voiceId, engine: prepared.narrationEngine,
      language: storyboard.language, text: shot.speech,
    });
  const requestId = kind === 'presenter'
    ? presenterRequestId(shot.id, contentHash)
    : narrationRequestId(shot.id, contentHash);
  const title = generationTitle(shot.id, contentHash);

  let state = await readGenerationShot(shot.id, runtime.stateRoot);
  if (state) await archiveStateIfChanged(runtime, state, contentHash);

  if (state && state.contentHash === contentHash) {
    // Verify an already downloaded file before trusting the ledger.
    if (state.phase === 'downloaded') {
      const file = generationMediaFile(shot.id, kind, runtime.stateRoot);
      if (await mediaFileValid(file, state.mediaSha256, state.mediaBytes)) {
        counters.reusedShots += 1;
        state.reuse = state.reuse ?? {
          from: 'generation', sourceFile: file, at: runtime.now().toISOString(),
        };
        await persistShot(runtime, state);
        return state;
      }
      if (kind === 'presenter' && state.provider?.videoId) {
        state.phase = 'accepted';
        await persistShot(runtime, state);
      } else if (kind === 'illustration' && state.provider?.audioUrl) {
        state.phase = 'accepted';
        await persistShot(runtime, state);
      } else {
        fail('step5_generation_media_missing_no_resubmit', shot.id);
      }
    }
  } else {
    // A materially changed shot is a new content revision. If Step 4 already
    // produced identical media, adopt it; otherwise submit exactly once.
    const reused = kind === 'presenter'
      ? await tryReuseStep4Presenter({
        runtime, shot, contentHash,
        avatarId: storyboard.presenter.avatarId, voiceId,
      })
      : await tryReuseStep4Narration({
        runtime, shot, contentHash, voiceId,
        engine: prepared.narrationEngine, language: storyboard.language,
      });
    if (reused) {
      state = reused;
      await persistShot(runtime, state);
      counters.reusedShots += 1;
      await emit(runtime, state);
      return state;
    }
    const forecastCny = expectedForecast(budget, shot, prepared.narrationEngine);
    assertCanReserve(budget, forecastCny);
    const wallet = await runtime.wallet(runtime.key);
    assertGenerationWallet(wallet);
    state = newShotState({
      shot, kind, contentHash, requestId, title, storyboardSha256,
      avatarId: kind === 'presenter' ? storyboard.presenter.avatarId : '',
      voiceId,
      ...(kind === 'illustration' ? {engine: prepared.narrationEngine} : {}),
      ...(kind === 'illustration' ? {language: storyboard.language} : {}),
      forecastCny,
      now: runtime.now().toISOString(),
      walletBefore: wallet.balance,
    });
    await persistShot(runtime, state);
  }

  // From here the ledger phase is prepared / submitting / accepted /
  // submission_unknown / rejected / failed.
  if (state.phase === 'submission_unknown' || state.phase === 'submitting') {
    if (kind === 'illustration')
      fail('step5_submission_unknown', `${shot.id}:narration_cannot_be_list_reconciled`);
    try {
      state = await reconcileGenerationShot({runtime, state, method: 'list'});
      counters.reconciledShots += 1;
    } catch (error) {
      const detail = scrub(error);
      state.phase = 'submission_unknown';
      state.lastError = detail;
      await persistShot(runtime, state);
      fail('step5_submission_unknown', `${shot.id}:${detail}`);
    }
  }
  if (state.phase === 'rejected')
    fail('step5_generation_rejected_no_resubmit:providerrejected', shot.id);
  if (state.phase === 'failed')
    fail('step5_generation_provider_failed:providerrejected', shot.id);

  if (kind === 'presenter') {
    if (state.phase === 'prepared') {
      await submitPresenter({runtime, budget, shot, state, counters});
    }
    if (state.phase !== 'accepted')
      fail('step5_generation_presenter_state_invalid', `${shot.id}:${state.phase}`);
    const completed = await waitForPresenter({runtime, state, counters, shotId: shot.id});
    state.provider = {...state.provider, duration: completed.duration};
    await persistShot(runtime, state);
    await finishPresenter({
      runtime, budget, state, counters,
      url: completed.url, providerDuration: completed.duration,
    });
    return state;
  }

  if (state.phase === 'prepared') {
    await submitNarration({runtime, budget, shot, state, counters});
  }
  if (state.phase !== 'accepted') fail('step5_generation_narration_state_invalid', `${shot.id}:${state.phase}`);
  await finishNarration({runtime, budget, state, counters});
  return state;
}

/**
 * Runs generation for every shot. Returns the local media paths and the
 * sanitized per-shot summaries. Callers must already hold the pipeline lease
 * and must run this inside the durable job execution context so that provider
 * receipts are attributable.
 */
export async function runStep5Generation(input: RunStep5GenerationInput): Promise<Step5GenerationResult> {
  const prepared = input.prepared ?? await prepareStep5Generation({
    store: requireStore(input),
    storyboard: input.storyboard,
    confirmedCapCny: input.confirmedCapCny,
    ...(input.env ? {env: input.env} : {}),
    ...(input.now ? {now: input.now()} : {}),
    ...(input.budgetFile ? {budgetFile: input.budgetFile} : {}),
    ...(input.wallet ? {wallet: input.wallet} : {}),
  });
  const runtime = buildRuntime(input, prepared);

  let budget: Step4Budget;
  try {
    budget = await readBudget(runtime.budgetFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('step5_generation_budget_missing');
    throw error;
  }
  assertBudgetIdentity(budget, {
    approvedCny: prepared.capCny,
    credentialHash: prepared.credentialHash,
    storyboardSha256: budget.storyboardSha256,
  });

  const counters: Step5GenerationCounters = {
    newPaidSubmissions: 0, newChargedCny: 0, statusCalls: 0, downloads: 0,
    reusedShots: 0, presentersGenerated: 0, narrationGenerated: 0, reconciledShots: 0,
  };
  const media: Step5GenerationMedia = {presenters: {}, narration: {}};
  for (const shot of input.storyboard.shots) {
    const state = await generateShot({
      runtime, budget, shot, prepared,
      storyboard: input.storyboard,
      storyboardSha256: input.storyboardSha256,
      counters,
    });
    if (state.phase !== 'downloaded' || !state.mediaFile || !(Number(state.durationSeconds) > 0))
      fail('step5_generation_shot_not_downloaded', shot.id);
    if (shot.kind === 'presenter') {
      media.presenters[shot.id] = {file: state.mediaFile, durationSeconds: Number(state.durationSeconds)};
    } else {
      media.narration[shot.id] = {file: state.mediaFile, durationSeconds: Number(state.durationSeconds)};
    }
  }

  const shots: Step5GenerationShotSummary[] = [];
  for (const shot of input.storyboard.shots) {
    const state = await readGenerationShot(shot.id, runtime.stateRoot);
    if (state) {
      shots.push(summarizeGenerationShot(state));
      // Reused shots carry the same request identity as Step 4; recording a
      // completed receipt makes the whole run attributable in one job.
      await receipt(runtime, {
        state: 'completed', requestId: state.requestId,
        providerTaskId: state.provider?.videoId ?? state.provider?.requestId ?? null,
        metadata: {
          shotId: state.shotId, kind: state.kind, title: state.title,
          contentHash: state.contentHash, source: state.reuse?.from ?? 'generation',
          mediaSha256: state.mediaSha256, chargedCny: state.chargedCny ?? 0,
        },
      });
    }
  }

  return {
    prepared: {
      capCny: prepared.capCny,
      credentialHash: prepared.credentialHash,
      accountRef: prepared.accountRef,
      wallet: {
        balance: prepared.wallet.balance,
        currency: prepared.wallet.currency,
        autoReload: prepared.wallet.autoReload,
      },
      preflight: prepared.preflight,
      publicEvidence: prepared.publicEvidence,
      providerEvidenceRef: prepared.providerEvidenceRef,
      presenterAssetId: prepared.presenterAssetId,
      narrationEngine: prepared.narrationEngine,
    },
    shots,
    media,
    counters,
    budget: {
      approvedCny: budget.approvedCny,
      chargedCny: budget.chargedCny,
      reservedCny: budget.reservedCny,
      remainingCny: roundCny(budget.approvedCny - budget.chargedCny - budget.reservedCny),
      paidSubmissions: budget.paidSubmissions,
    },
  };
}

function requireStore(input: RunStep5GenerationInput): DataStore {
  if (!input.store) fail('step5_generation_store_required_for_prepare');
  return input.store;
}

/* ------------------------------------------------------------------ */
/* Public reconcile entry (page/API)                                   */
/* ------------------------------------------------------------------ */

export interface ReconcileStep5GenerationInput {
  shotId?: string;
  videoId?: string;
  env?: NodeJS.ProcessEnv;
  stateRoot?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

export async function reconcileStep5Generation(
  input: ReconcileStep5GenerationInput,
): Promise<Step5GenerationShotSummary> {
  const env = input.env ?? process.env;
  if (env.INTERVIEW_REAL_MODE !== '1') fail('step5_generation_disabled');
  const key = String(env.HEYGEN_API_KEY || '').trim();
  if (!key) fail('step5_generation_key_missing');
  const stateRoot = input.stateRoot ?? STEP5_GENERATION_ROOT;
  const runtime: ReconcileRuntime = {
    key, stateRoot,
    now: input.now ?? (() => new Date()),
    getVideo: (credential: string, id: string) => getProviderVideo(credential, id, input.fetchImpl ?? fetch),
    listVideos: (credential: string) => listProviderVideos(credential, input.fetchImpl ?? fetch),
  };
  let shotId = String(input.shotId || '').trim();
  const videoId = String(input.videoId || '').trim();

  // A manual video id can identify the shot by its exact, content-addressed
  // title, but only when exactly one unknown presenter shot matches.
  if (!shotId && videoId) {
    const video = await runtime.getVideo(key, videoId);
    if (!video) fail('step5_reconcile_not_found', videoId);
    const summary = await readStep5GenerationSummary(stateRoot);
    const matches = (summary?.shots ?? []).filter(shot =>
      shot.kind === 'presenter' && shot.phase === 'submission_unknown' && shot.title === video.title);
    if (matches.length === 0) fail('step5_reconcile_not_found', 'unknown_shot_for_video');
    if (matches.length > 1) fail('step5_reconcile_ambiguous', 'multiple_unknown_shots');
    shotId = matches[0]!.shotId;
  }
  if (!shotId) fail('step5_reconcile_shot_required');

  const state = await readGenerationShot(shotId, stateRoot);
  if (!state) fail('step5_reconcile_shot_not_found', shotId);
  if (state.kind === 'illustration') fail('step5_reconcile_requires_new_content_revision', shotId);
  await reconcileGenerationShot({
    runtime, state,
    method: videoId ? 'manual' : 'list',
    ...(videoId ? {videoId} : {}),
  });
  return summarizeGenerationShot(state);
}
