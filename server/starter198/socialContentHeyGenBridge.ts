import { readAdoptedMvpHeyGenSpeech } from '../lib/mvpHeyGenSpeechAdoption.js';
import {socialRequestHash, socialJson, socialObject} from './socialContentValidation.js';
import { readMvpHeyGenSpeech } from '../lib/mvpHeyGenSpeech.js';
import {assertSocialAccountProductionConstraints} from './socialAccountProductionConstraints.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import type { DataStore } from '../storage/datastore.js';
import { HeyGenClient } from '../lib/heygen.js';
import { studioPaidBudget, type StudioPaidBudget } from '../lib/studioPaidBudget.js';
import { objectStorageEnabled, objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';
import { materialAssetObjectKey } from '../storage/materialAssets.js';
import { readLocalMaterials, saveLocalMaterials } from '../lib/materialLibrary.js';
import { assertPresenterSpeechAudio } from './socialContentDigitalPresenterAdapter.js';
import type {
  AuthorizedDigitalPresenter,
  SocialDigitalPresenterBridgePorts,
} from './socialContentDigitalPresenterAdapter.js';
import {
  validateHeyGenPresenterRecord,
  validatePublicHeyGenPresenterRecord,
  type PublicPresenterEvidence,
} from '../lib/presenterAssetTrust.js';
import { recordCurrentContentProviderReceipt, ContentExecutionStoppedError } from '../contentExecution/context.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

type PresenterRecord = Record<string, unknown> & {
  id?: string; name?: string; authorized?: boolean; assetVersion?: number;
  avatarId?: string; voiceId?: string; authorizationRef?: string; consentRef?: string;
  socialAccountId?: string; presenterProfileId?: string; presenterProfileVersion?: string; consistencyKey?: string;
  rightsEvidence?: unknown;
  toolMappings?: { heygen?: { avatarId?: string; voiceId?: string } };
};

export function socialPresenterReservationExceedsInternalBudget(
  tenantId: string, reservationCny: number, maximumCostCny: number,
): boolean {
  return !isInternalBudgetExemptTenant(tenantId) && reservationCny > maximumCostCny;
}

export interface SocialHeyGenPresenterAudit {
  total: number;
  executable: number;
  missingByPresenter: Array<{ presenterAssetId: string; requirements: string[] }>;
}

/** Audits tenant-scoped presenter mappings without returning provider IDs or
 * authorization references. This is safe to expose in readiness diagnostics. */
export function auditSocialHeyGenPresenters(items: PresenterRecord[]): SocialHeyGenPresenterAudit {
  const missingByPresenter = items.map((item, index) => {
    const requirements = [
      item.authorized !== true && 'authorized=true',
      !String(item.toolMappings?.heygen?.avatarId || item.avatarId || '').trim() && 'HeyGen avatarId',
      !String(item.toolMappings?.heygen?.voiceId || item.voiceId || '').trim() && 'HeyGen voiceId',
      !String(item.authorizationRef || '').trim() && 'authorizationRef',
      !String(item.consentRef || '').trim() && 'consentRef',
    ].filter(Boolean) as string[];
    return { presenterAssetId: String(item.id || `presenter-${index + 1}`), requirements };
  }).filter(item => item.requirements.length > 0);
  return { total: items.length, executable: items.length - missingByPresenter.length, missingByPresenter };
}

export interface SocialHeyGenBridgeDependencies {
  store: DataStore;
  wholeBudget?: {
    maximumCostCny: number;
    authorize(input: Parameters<SocialDigitalPresenterBridgePorts['authorizeBudget']>[0]): ReturnType<SocialDigitalPresenterBridgePorts['authorizeBudget']>;
    recover(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest, record: any): Promise<string>;
    completed(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest, output:{providerTaskId:string;contentHash:string;duration:number;objectKey:string}): Promise<void>;
  };
  /** Server-owned persistent TTS/upload reader, including byte hash and probe verification. */
  speechAudio?: {
    resolve(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest): Promise<import('./socialContentDigitalPresenterAdapter.js').VerifiedPresenterSpeechAudio>;
    verify(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest, audio: import('./socialContentDigitalPresenterAdapter.js').VerifiedPresenterSpeechAudio): Promise<boolean>;
  };
  approvedFirstFrame?: {
    resolve(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest): Promise<{imageAssetId:string;sha256:string;approvalRecordHash:string}>;
    verify(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest, value:{imageAssetId:string;sha256:string;approvalRecordHash:string}): Promise<boolean>;
  };
  client: Pick<HeyGenClient, 'create' | 'status'>;
  budget: Pick<StudioPaidBudget, 'status' | 'reserve'>;
  storageReady: () => boolean;
  download: (url: string) => Promise<Buffer>;
  upload: typeof objectStorageUpload;
  head: typeof objectStorageHead;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export type PresenterHookAudioSource = Omit<import('./socialContentDigitalPresenterAdapter.js').PresenterHookSpeechAudio, 'audioAssetId'> & { filePath: string };

/** Trusted receipt loaders must re-read current task revision, voice/person and
 * the hook receipt from server storage. Clients cannot supply this dependency.
 * Uploads have their own durable claim, and an uncertain claim never re-POSTs. */
export function createSocialHeyGenHookAudioPort(options: {
  store: DataStore;
  client: Pick<HeyGenClient, 'uploadAudio'>;
  load(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest): Promise<PresenterHookAudioSource>;
  authorizeUpload(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest, source: PresenterHookAudioSource): Promise<boolean>;
}): NonNullable<SocialHeyGenBridgeDependencies['speechAudio']> {
  async function checked(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest) {
    const source = await options.load(input);
    assertPresenterSpeechAudio(input, { ...source, audioAssetId: 'pending-server-upload' });
    const bytes = fs.readFileSync(source.filePath);
    if (!bytes.length || bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== source.clipSha256)
      throw new Error('digital_presenter_hook_bytes_changed');
    if (!ffmpegStatic) throw new Error('digital_presenter_hook_probe_unavailable');
    // Decode the full file to PCM: duration comes from actual sample count,
    // not an estimated text length or rounded input-container header.
    const decoded = await promisify(execFile)(ffmpegStatic, ['-hide_banner', '-loglevel', 'info', '-i', source.filePath,
      '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 45_000 });
    if (createHash('sha256').update(fs.readFileSync(source.filePath)).digest('hex') !== source.clipSha256)
      throw new Error('digital_presenter_hook_bytes_changed');
    const codec = String(decoded.stderr).match(/Audio: ([a-z0-9_]+)/)?.[1];
    const mimeType = codec === 'mp3' ? 'audio/mpeg' as const : codec?.startsWith('pcm_') ? 'audio/wav' as const : null;
    if (!mimeType) throw new Error('digital_presenter_hook_audio_format_unsupported');
    const measured = decoded.stdout.length / (48000 * 2);
    if (!(measured > 0) || measured > (source.adoptedSpeech === true && source.frozenHookDurationSeconds === 5.6 ? 5.6 : 4) || Math.abs(measured - source.durationSeconds) > 0.02)
      throw new Error('digital_presenter_hook_probe_duration_invalid');
    const { filePath, ...identity } = source;
    void filePath;
    const key = `social-presenter-audio:${socialRequestHash(identity)}`;
    return { source, bytes, identity, key, mimeType };
  }
  return {
    async resolve(input) {
      const actual = await checked(input);
      const rows = await options.store.list<any>('studio_social_presenter_jobs',
        { where: { tenant_id: input.tenantId, request_id: actual.key }, perPage: 2 });
      if (rows.totalItems !== rows.items.length || rows.items.length > 1) throw new Error('digital_presenter_hook_upload_ambiguous');
      let row = rows.items[0];
      if (row) {
        if (row.task_id !== input.taskId || row.shot_id !== input.shotId || row.presenter_asset_id !== input.presenter.presenterAssetId
          || socialRequestHash(row.visual_control?.hookAudio) !== socialRequestHash(actual.identity))
          throw new Error('digital_presenter_hook_upload_scope_changed');
        const assetId = row.visual_control?.audioAssetId;
        if (row.status !== 'audio_uploaded' || typeof assetId !== 'string' || !assetId)
          throw new Error('digital_presenter_hook_upload_unknown');
        return { ...actual.identity, audioAssetId: assetId };
      }
      if (!await options.authorizeUpload(input, actual.source)) throw new Error('digital_presenter_hook_upload_budget_denied');
      row = await options.store.create<any>('studio_social_presenter_jobs', {
        tenant_id: input.tenantId, task_id: input.taskId, shot_id: input.shotId, request_id: actual.key,
        provider: 'heygen', presenter_asset_id: input.presenter.presenterAssetId, status: 'audio_uploading',
        authorization_ref: input.presenter.authorizationRef, consent_ref: input.presenter.consentRef,
        visual_control: { hookAudio: actual.identity }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      if (!row) throw new Error('digital_presenter_hook_upload_claim_failed');
      try {
        const audioAssetId = await options.client.uploadAudio(actual.bytes, actual.key, actual.mimeType);
        if (!audioAssetId) throw new Error('digital_presenter_hook_upload_asset_missing');
        if (!await options.store.update('studio_social_presenter_jobs', row.id, {
          status: 'audio_uploaded', visual_control: { hookAudio: actual.identity, audioAssetId }, updated_at: new Date().toISOString(),
        })) throw new Error('digital_presenter_hook_upload_receipt_write_failed');
        return { ...actual.identity, audioAssetId };
      } catch (error) {
        await options.store.update('studio_social_presenter_jobs', row.id, { status: 'audio_upload_unknown', updated_at: new Date().toISOString() }).catch(() => undefined);
        throw error;
      }
    },
    async verify(input, audio) {
      const actual = await checked(input);
      const rows = await options.store.list<any>('studio_social_presenter_jobs',
        { where: { tenant_id: input.tenantId, request_id: actual.key }, perPage: 2 });
      const row = rows.items[0];
      if (!await options.authorizeUpload(input, actual.source)) return false;
      return rows.totalItems === 1 && rows.items.length === 1 && row.status === 'audio_uploaded'
        && row.task_id === input.taskId && row.shot_id === input.shotId && row.presenter_asset_id === input.presenter.presenterAssetId
        && row.visual_control?.audioAssetId === audio.audioAssetId
        && socialRequestHash(row.visual_control?.hookAudio) === socialRequestHash(actual.identity)
        && socialRequestHash({ ...actual.identity, audioAssetId: audio.audioAssetId }) === socialRequestHash(audio);
    },
  };
}

/** Concrete MVP mapper: reads persisted speech plus current business records,
 * not request-body paths, durations or externally supplied audio asset IDs. */
export function createMvpSocialHeyGenHookAudioPort(options: {
  store: DataStore; client: Pick<HeyGenClient, 'uploadAudio'>; speechRoot?: string; adoptionRoot?: string; useAdoptedSpeech?: true;
  /** Frozen server-side original presenter version; never read from an HTTP body. */
  presenterAssetVersion: number;
  receiptRef(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest): Promise<string>;
  authorizeUpload(input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest, source: PresenterHookAudioSource): Promise<boolean>;
}): NonNullable<SocialHeyGenBridgeDependencies['speechAudio']> {
  return createSocialHeyGenHookAudioPort({ ...options, load: async input => {
    if(!input.presenter.providerPresenterId||!input.presenter.providerVoiceId)throw Error('heygen_avatar_voice_mapping_required');
    const ref = await options.receiptRef(input);
    const adoption = options.useAdoptedSpeech === true ? readAdoptedMvpHeyGenSpeech(ref, options.adoptionRoot) : null;
    const result = adoption || readMvpHeyGenSpeech(ref, options.speechRoot);
    const rows = await options.store.list<any>('starter_social_content_tasks',
      { where: { tenant_id: input.tenantId, task_id: input.taskId }, perPage: 2 });
    const task = rows.items[0], brief = socialObject(socialJson(task?.brief));
    const script = socialObject(socialJson(task?.replication_script));
    const shot = Array.isArray(script?.shots) ? script.shots.find((x:any)=>x.shotId===input.shotId) : null;
    const adopted = options.useAdoptedSpeech === true;
    const marker = socialObject(brief?._productionRevision);
    const { planHash, preparedBy: _preparedBy, preparedAt: _preparedAt, ...immutable } = marker || {};
    const frozenScript = socialObject(socialObject(marker?.resolved)?.replicationScript);
    const frozen = Array.isArray(frozenScript?.shots) ? frozenScript.shots.find((x:any)=>x.shotId===input.shotId) : null;
    if(adopted && (!marker || !planHash || socialRequestHash(immutable)!==planHash || marker.tenantId!==input.tenantId || marker.taskId!==input.taskId
      || !frozen || Number(frozen.endSeconds)-Number(frozen.startSeconds)!==5.6 || frozen.spokenText!==input.script || !adoption || adoption.adoption !== true || result.maxDurationSeconds !== 5.6
      || !shot || Number(shot.endSeconds)-Number(shot.startSeconds)!==5.6 || shot.spokenText!==input.script
      || adoption!.presenter.presenterAssetId!==input.presenter.presenterAssetId || adoption!.presenter.presenterAssetVersion!==input.presenter.assetVersion
      || adoption!.presenter.providerAvatarId!==input.presenter.providerPresenterId || adoption!.presenter.voiceId!==input.presenter.providerVoiceId))
      throw new Error('digital_presenter_mvp_adoption_authority_changed');
    const run = result.runId ? await options.store.getById<any>('workflow_runs', result.runId) : null;
    if (rows.totalItems !== 1 || rows.items.length !== 1 || result.operationRole !== 'hook' || result.maxDurationSeconds > (adopted ? 5.6 : 4)
      || result.tenantId !== input.tenantId || result.taskId !== input.taskId || result.shotId !== input.shotId
      || String(task.version) !== String(result.taskVersion) || task.run_id !== result.runId
      || result.accountId !== (socialObject(brief?.targetAccountRef)?.id ?? null)
      || !run || run.tenant_id !== input.tenantId || ['cancelled','cancelling','paused','pausing','failed'].includes(String(run.status))
      || brief?.presenterAssetId !== input.presenter.presenterAssetId
      || brief?.requestedPresenterAssetId !== input.presenter.providerPresenterId
      || input.presenter.assetVersion !== options.presenterAssetVersion || result.voiceId !== input.presenter.providerVoiceId
      || result.scriptSha256 !== createHash('sha256').update(input.script).digest('hex'))
      throw new Error('digital_presenter_mvp_speech_authority_changed');
    return { tenantId: result.tenantId, taskId: result.taskId, taskVersion: String(result.taskVersion), shotId: result.shotId,
      presenterAssetId: input.presenter.presenterAssetId, presenterAssetVersion: input.presenter.assetVersion,
      providerAvatarId: input.presenter.providerPresenterId, voiceId: result.voiceId, operationRole: 'hook',
      scriptSha256: result.scriptSha256, clipSha256: result.clipSha256, durationSeconds: result.durationSeconds,
      ...(adopted ? {adoptedSpeech:true as const,frozenHookDurationSeconds:5.6} : {}), receiptRef: result.receiptRef, receiptHash: result.receiptHash, engine: 'avatar_iv', filePath: result.filePath };
  } });
}

export interface SocialHeyGenBridgeReadiness {
  ready: boolean;
  reasons: string[];
}

export function socialHeyGenBridgeReadiness(input: {
  enabled?: string; generationEnabled?: string; apiKey?: string; storageReady: boolean;
  budget: { allowed: boolean; reservationCny: number | null; reason: string };
}): SocialHeyGenBridgeReadiness {
  const reasons = [
    ...(input.enabled === 'true' ? [] : ['SOCIAL_CONTENT_HEYGEN_ENABLED']),
    ...(input.generationEnabled === 'true' ? [] : ['HEYGEN_GENERATION_ENABLED']),
    ...(String(input.apiKey || '').trim() ? [] : ['HEYGEN_API_KEY']),
    ...(input.storageReady ? [] : ['对象存储']),
    ...(Number(input.budget.reservationCny) > 0 ? [] : [`付费预算：${input.budget.reason || '未配置正数预留额'}`]),
  ];
  return { ready: reasons.length === 0, reasons };
}

function safeOutputUrl(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /(^|\.)heygen\.(ai|com)$/i.test(url.hostname);
  } catch { return false; }
}

export async function defaultDownload(raw: string): Promise<Buffer> {
  if (!safeOutputUrl(raw)) throw new Error('heygen_output_url_untrusted');
  const response = await fetch(raw, { redirect: 'error', signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body) throw new Error(`heygen_output_download_failed:${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 10_000 || bytes.length > 110 * 1024 * 1024) throw new Error('heygen_output_size_invalid');
  return bytes;
}

function configuredPresenter(item: PresenterRecord, presenterAssetId: string): AuthorizedDigitalPresenter | null {
  if (String(item.id || '') !== presenterAssetId) return null;
  const validated = validateHeyGenPresenterRecord(item);
  if (!validated.ok) return null;
  return { presenterAssetId, providerId: 'heygen', providerPresenterId: validated.avatarId, providerVoiceId: validated.voiceId,
    authorizationRef: validated.rights.authorizationRef, consentRef: validated.rights.consentRef,
    assetVersion: validated.assetVersion, authorized: true,
    socialAccountId: String(item.socialAccountId || '') || undefined,
    presenterProfileId: String(item.presenterProfileId || '') || undefined,
    presenterProfileVersion: String(item.presenterProfileVersion || '') || undefined,
    consistencyKey: String(item.consistencyKey || '') || undefined };
}

/** Public catalog presenters are supplier stock assets, not cloned people.
 * This shape deliberately has no authorizationRef/consentRef fields. */
export interface PublicHeyGenPresenter {
  presenterAssetId: string;
  providerId: 'heygen';
  providerPresenterId: string;
  providerVoiceId: string;
  assetVersion: number;
  ownership: 'public';
  publicEvidence: PublicPresenterEvidence;
}

export interface SocialHeyGenAdoptionEvent {
  state: 'accepted' | 'checking' | 'pending' | 'downloaded' | 'uploaded' | 'completed' | 'failed';
  providerTaskId: string;
  providerStatus?: string;
  durationSeconds?: number;
  contentHash?: string;
  localPath?: string;
  bytes?: number;
  objectKey?: string;
  error?: string;
}

export interface SocialHeyGenAdoptionRequest {
  tenantId: string;
  taskId: string;
  runId: string;
  shotId: string;
  presenter: PublicHeyGenPresenter;
  /** Step 4's persisted request id. It is the provider receipt identity. */
  idempotencyKey: string;
  /** Step 4's already accepted video_id. Adoption never creates a new task. */
  adoptedProviderTaskId: string;
  script: string;
  expectedDurationSeconds?: number;
  expectedMediaSha256?: string;
  expectedMediaBytes?: number;
  outputDirectory: string;
  onProviderEvent?: (event: SocialHeyGenAdoptionEvent) => void | Promise<void>;
}

export interface SocialHeyGenAdoptionResult {
  status: 'completed' | 'pending' | 'failed' | 'uncertain';
  providerTaskId: string;
  localPath?: string;
  contentHash?: string;
  duration?: number;
  bytes?: number;
  error?: string;
}

/** Additive ports. The clone/whole-track execute() path above is unchanged. */
export interface SocialHeyGenAdoptionPorts {
  resolvePublicPresenter(input: { tenantId: string; presenterAssetId: string }): Promise<PublicHeyGenPresenter | null>;
  adoptProviderTask(input: SocialHeyGenAdoptionRequest): Promise<SocialHeyGenAdoptionResult>;
}

export type SocialHeyGenBridgePorts = SocialDigitalPresenterBridgePorts & SocialHeyGenAdoptionPorts;

export function configuredPublicPresenter(
  item: Record<string, unknown>,
  presenterAssetId: string,
): PublicHeyGenPresenter | null {
  if (String(item.id || '') !== presenterAssetId) return null;
  const validated = validatePublicHeyGenPresenterRecord(item);
  if (!validated.ok) return null;
  return {
    presenterAssetId,
    providerId: 'heygen',
    providerPresenterId: validated.avatarId,
    providerVoiceId: validated.voiceId,
    assetVersion: validated.assetVersion,
    ownership: 'public',
    publicEvidence: validated.evidence,
  };
}

/** Registry payload for a verified public catalog presenter. It contains the
 * catalog/terms evidence and provider ids only; it never fabricates clone
 * authorization or subject consent. */
export function buildPublicPresenterRecord(
  evidence: PublicPresenterEvidence,
  avatarId: string,
  voiceId: string,
  id = 'presenter-public-storyboard',
): Record<string, unknown> {
  return {
    id,
    name: 'HeyGen 公共授权形象',
    ownership: 'public',
    assetVersion: 1,
    avatarId,
    voiceId,
    publicCatalogRef: evidence.publicCatalogRef,
    providerTermsRef: evidence.providerTermsRef,
    verifiedAt: evidence.verifiedAt,
    accountId: evidence.accountId,
    toolMappings: { heygen: { avatarId, voiceId } },
  };
}

/** Creates the concrete ports used by the social adapter. The environment
 * gate lives outside this function so tests and alternate runtimes can inject
 * deterministic dependencies without enabling a paid supplier. */
export function createSocialHeyGenBridgePorts(deps: SocialHeyGenBridgeDependencies): SocialHeyGenBridgePorts {
  const polls = Math.max(1, Math.min(240, deps.maxPolls ?? 120));
  const pollInterval = Math.max(0, deps.pollIntervalMs ?? 5_000);
  const adoptionError = (input: SocialHeyGenAdoptionRequest, event: Omit<SocialHeyGenAdoptionEvent, 'providerTaskId' | 'state'>, state: 'failed' = 'failed') =>
    input.onProviderEvent?.({ state, providerTaskId: input.adoptedProviderTaskId, ...event });
  const ports: SocialHeyGenBridgePorts = {
    ...(deps.speechAudio ? { resolveSpeechAudio: (input: import('./socialContentDigitalPresenterAdapter.js').DigitalPresenterExecutionRequest) => deps.speechAudio!.resolve(input) } : {}),
    maximumCostCny: deps.wholeBudget?.maximumCostCny ?? (Number(deps.budget.status('heygen').reservationCny) || 0),
    // This bridge is the current talking-presenter integration. It does not
    // claim guided body action, product contact, face application, reference
    // motion, custom environment or camera-path support.
    capabilities: {
      methods: ['talking'],
      controls: ['scripted_speech', 'timing_control'],
    },
    async resolvePresenter({ tenantId, presenterAssetId, socialAccountId }) {
      const result = await deps.store.list<{ payload?: { presenters?: PresenterRecord[] } }>('studio_production_defaults',
        { where: { tenant_id: tenantId }, perPage: 2 });
      if (result.totalItems !== 1 || result.items.length !== 1) return null;
      return (result.items[0]?.payload?.presenters || [])
        .filter(item => !socialAccountId || item.socialAccountId === socialAccountId)
        .map(item => configuredPresenter(item, presenterAssetId)).find(Boolean) || null;
    },
    async authorizeBudget(input) {
      if(deps.wholeBudget)return deps.wholeBudget.authorize(input);
      const {idempotencyKey,maximumCostCny}=input;
      if (!deps.storageReady()) return { allowed: false, reason: 'object_storage_unavailable' };
      const status = deps.budget.status('heygen', undefined, input.tenantId);
      if (!(Number(status.reservationCny) > 0)) return { allowed: false, reason: status.reason || 'budget_unavailable' };
      if (socialPresenterReservationExceedsInternalBudget(input.tenantId,
        Number(status.reservationCny), maximumCostCny)) return { allowed: false, reason: 'reservation_exceeds_shot_limit' };
      try {
        // reserve() is idempotent for an existing request key. Always let it
        // decide so an already-paid provider task remains recoverable even
        // when the remaining budget is too small for a new generation.
        await deps.budget.reserve('heygen', idempotencyKey, undefined, input.tenantId);
        return { allowed: true, reservationRef: idempotencyKey };
      } catch (error) {
        return { allowed: false, reason: error instanceof Error ? error.message : status.reason || 'budget_unavailable' };
      }
    },
    async recoverExisting(input) {
      const records = await deps.store.list<any>('studio_social_presenter_jobs',
        { where: { tenant_id: input.tenantId, request_id: input.idempotencyKey }, perPage: 2 });
      if (records.totalItems === 0 && records.items.length === 0) return null;
      return ports.execute({ ...input, recoveryOnly: true, reservationRef: input.idempotencyKey });
    },
    async execute(input) {
      if(!input.presenter.providerPresenterId||!input.presenter.providerVoiceId)throw Error('heygen_avatar_voice_mapping_required');
      if(input.accountPlaybookConstraints)assertSocialAccountProductionConstraints(input.accountPlaybookConstraints);
      const existing = await deps.store.list<any>('studio_social_presenter_jobs',
        { where: { tenant_id: input.tenantId, request_id: input.idempotencyKey }, perPage: 2 });
      if (existing.totalItems > 1 || existing.items.length > 1 || existing.totalItems !== existing.items.length) return { status: 'uncertain', error: 'duplicate_provider_job_records' };
      let record = existing.items[0];
      if(deps.wholeBudget && record && (record.task_id!==input.taskId||record.shot_id!==input.shotId||record.provider!=='heygen'||record.presenter_asset_id!==input.presenter.presenterAssetId))return {status:'uncertain',error:'whole_track_provider_job_scope_changed'};
      if(deps.wholeBudget && record && !input.speechAudio && record.visual_control?.speechAudio?.operationRole==='production_scene'){
        input={...input,speechAudio:await deps.speechAudio!.resolve(input)};
      }
      if(deps.wholeBudget && !input.speechAudio)return {status:'uncertain',error:'whole_track_presenter_audio_required'};
      if (input.speechAudio) {
        assertPresenterSpeechAudio(input, input.speechAudio);
        if (!deps.speechAudio || !await deps.speechAudio.verify(input, input.speechAudio))
          return { status: 'uncertain', error: 'digital_presenter_audio_receipt_unverified' };
      }
      if(!deps.approvedFirstFrame)return {status:'uncertain',error:'digital_presenter_approved_first_frame_port_missing'};
      const approvedFirstFrame=await deps.approvedFirstFrame.resolve(input);
      if(!await deps.approvedFirstFrame.verify(input,approvedFirstFrame))return {status:'uncertain',error:'digital_presenter_approved_first_frame_unverified'};
      if (record && socialRequestHash(record.visual_control?.speechAudio ?? null) !== socialRequestHash(input.speechAudio ?? null))
        return { status: 'uncertain', error: 'digital_presenter_audio_binding_changed' };

      if(record && socialRequestHash(record.visual_control?.accountPlaybookConstraints??null)!==socialRequestHash(input.accountPlaybookConstraints??null))return {status:'uncertain',error:'digital_presenter_account_constraints_changed'};
      if(record&&socialRequestHash(record.visual_control?.approvedFirstFrame??null)!==socialRequestHash({...input.approvedFirstFrame,imageAssetId:approvedFirstFrame.imageAssetId}))return {status:'uncertain',error:'digital_presenter_approved_first_frame_binding_changed'};
      let providerTaskId = String(record?.provider_task_id || '').trim();
      if(deps.wholeBudget && record)providerTaskId=await deps.wholeBudget.recover(input,record);
      // Empty recovery is permitted only by the whole-plan gate proving that
      // no write-ahead paid claim exists. Retain the earlier audit row.
      if(deps.wholeBudget&&record&&!providerTaskId&&!input.recoveryOnly) {
        await deps.store.update('studio_social_presenter_jobs',record.id,{request_id:record.request_id+':unsubmitted:'+record.id,status:'not_submitted',updated_at:new Date().toISOString()});
        record=undefined;
      }
      if (input.recoveryOnly && (!record || !providerTaskId)) return { status: 'uncertain', error: 'accepted_provider_job_required_for_recovery' };
      if (input.recoveryOnly && (record.task_id !== input.taskId || record.shot_id !== input.shotId
        || record.presenter_asset_id !== input.presenter.presenterAssetId || record.provider !== 'heygen'))
        return { status: 'uncertain', error: 'accepted_provider_job_scope_changed' };

      if (!record) {
        record = await deps.store.create<any>('studio_social_presenter_jobs', { tenant_id: input.tenantId,
          task_id: input.taskId, shot_id: input.shotId, request_id: input.idempotencyKey, status: 'submitting',
          provider: 'heygen', presenter_asset_id: input.presenter.presenterAssetId, authorization_ref: input.presenter.authorizationRef,
          consent_ref: input.presenter.consentRef, social_account_id: input.presenter.socialAccountId || '',
          presenter_profile_id: input.presenter.presenterProfileId || '', presenter_profile_version: input.presenter.presenterProfileVersion || '',
          presenter_consistency_key: input.presenter.consistencyKey || '', visual_control: {...input.visualControl,approvedFirstFrame:{...structuredClone(input.approvedFirstFrame),imageAssetId:approvedFirstFrame.imageAssetId},...(input.speechAudio ? { speechAudio: structuredClone(input.speechAudio) } : {}),...(input.accountPlaybookConstraints?{accountPlaybookConstraints:structuredClone(input.accountPlaybookConstraints)}:{})},
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        if (!record) return { status: 'uncertain', error: 'provider_job_claim_failed' };
        try {
          await recordCurrentContentProviderReceipt({
            provider: 'heygen', requestId: input.idempotencyKey, state: 'submitting',
            metadata: { reservationRef: input.reservationRef },
          });
          if(!input.presenter.providerVoiceId)throw Error('heygen_voice_mapping_required');
          providerTaskId = await deps.client.create({ avatarId: '',imageAssetId:approvedFirstFrame.imageAssetId,
            ...(input.speechAudio ? { voiceId: '', script: '', audioAssetId: input.speechAudio.audioAssetId, engine: 'avatar_iv' as const } : { voiceId: input.presenter.providerVoiceId, script: input.script }), ratio: input.aspectRatio,
            transparent: false, title: `灵枢社媒镜头 ${input.shotId}` }, input.idempotencyKey);
          await deps.store.update('studio_social_presenter_jobs', record.id, { provider_task_id: providerTaskId,
            status: 'pending', updated_at: new Date().toISOString() });
          await recordCurrentContentProviderReceipt({
            provider: 'heygen', requestId: input.idempotencyKey, state: 'accepted', providerTaskId,
            metadata: { reservationRef: input.reservationRef },
          });
        } catch (error) {
          if (error instanceof ContentExecutionStoppedError) throw error;
          await deps.store.update('studio_social_presenter_jobs', record.id, { status: 'uncertain',
            error: String(error instanceof Error ? error.message : error), updated_at: new Date().toISOString() });
          await recordCurrentContentProviderReceipt({
            provider: 'heygen', requestId: input.idempotencyKey, state: 'unknown',
            metadata: { reservationRef: input.reservationRef },
          });
          return { status: 'uncertain', error: 'provider_submission_uncertain' };
        }
      }
      if (!providerTaskId) {
        await recordCurrentContentProviderReceipt({
          provider: 'heygen', requestId: input.idempotencyKey, state: 'unknown',
          metadata: { reservationRef: input.reservationRef },
        });
        return { status: 'uncertain', error: 'provider_task_id_missing' };
      }
      await recordCurrentContentProviderReceipt({
        provider: 'heygen', requestId: input.idempotencyKey, state: 'accepted', providerTaskId,
        metadata: { reservationRef: input.reservationRef },
      });
      let completed: Awaited<ReturnType<HeyGenClient['status']>> | null = null;
      for (let index = 0; index < polls; index += 1) {
        const status = await deps.client.status(providerTaskId);
        if (status.status === 'failed') {
          await recordCurrentContentProviderReceipt({
            provider: 'heygen', requestId: input.idempotencyKey, state: 'failed', providerTaskId,
            metadata: { providerError: status.error || 'provider_failed' },
          });
          return { status: 'failed', providerTaskId, error: status.error || 'provider_failed' };
        }
        if (status.status === 'completed') { completed = status; break; }
        if (pollInterval) await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      const duration = Number(completed?.duration);
      if (!completed?.url || !(duration > 0)) return { status: 'pending', providerTaskId, error: 'provider_still_processing' };
      const bytes = await deps.download(completed.url);
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      const filename = `social-presenter-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}.mp4`;
      fs.mkdirSync(input.outputDirectory,{recursive:true,mode:0o700});
      const localPath = path.join(input.outputDirectory, filename);
      fs.writeFileSync(localPath, bytes, { mode: 0o600 });
      const objectKey = materialAssetObjectKey(input.tenantId, filename);
      await deps.upload({ key: objectKey, body: bytes, contentType: 'video/mp4' });
      const stored = await deps.head(objectKey);
      if (!stored?.size || !stored.etag) throw new Error('digital_presenter_object_storage_verification_failed');
      const materialId = `social-presenter-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}`;
      const materials = readLocalMaterials();
      saveLocalMaterials([...materials.filter(item => !(item.id === materialId && item.tenantId === input.tenantId)), {
        id: materialId, name: `社媒数字人口播 · ${input.shotId}`, folder: 'presenter', type: 'video',
        duration, size: `${bytes.length} B`, file: '', url: '', objectKey,
        objectEtag: String(stored.etag), contentSha256: contentHash, scope: 'own', tenantId: input.tenantId,
        usage: 'editable', sourceType: 'heygen', sourceExecutionId: providerTaskId, createdAt: new Date().toISOString(),
      }]);
      await deps.store.update('studio_social_presenter_jobs', record.id, { status: 'completed', provider_task_id: providerTaskId,
        material_id: materialId, object_key: objectKey, content_sha256: contentHash, updated_at: new Date().toISOString() });
      await recordCurrentContentProviderReceipt({
        provider: 'heygen', requestId: input.idempotencyKey, state: 'completed', providerTaskId,
        metadata: { reservationRef: input.reservationRef, materialId, objectKey, contentHash, duration },
      });
      await deps.wholeBudget?.completed(input,{providerTaskId,contentHash,duration,objectKey});
      return { status: 'completed', providerTaskId, localPath, contentHash, duration };
    },
    async resolvePublicPresenter({ tenantId, presenterAssetId }) {
      const result = await deps.store.list<{ payload?: { presenters?: Record<string, unknown>[] } }>('studio_production_defaults',
        { where: { tenant_id: tenantId }, perPage: 2 });
      if (result.totalItems !== 1 || result.items.length !== 1) throw new Error('public_presenter_registry_ambiguous');
      return (result.items[0]?.payload?.presenters || [])
        .map(item => configuredPublicPresenter(item, presenterAssetId)).find(Boolean) || null;
    },
    /** Takes over an already-accepted provider task. It never calls
     * client.create, never reserves budget and never settles a whole-track
     * plan; the only paid work happened before this call. */
    async adoptProviderTask(input) {
      if (!String(input.adoptedProviderTaskId || '').trim())
        return { status: 'uncertain', providerTaskId: '', error: 'accepted_provider_task_required' };
      if (!input.presenter.providerPresenterId || !input.presenter.providerVoiceId)
        throw new Error('heygen_avatar_voice_mapping_required');
      if (input.presenter.ownership !== 'public')
        throw new Error('public_presenter_evidence_required');
      const existing = await deps.store.list<any>('studio_social_presenter_jobs',
        { where: { tenant_id: input.tenantId, request_id: input.idempotencyKey }, perPage: 2 });
      if (existing.totalItems > 1 || existing.items.length > 1 || existing.totalItems !== existing.items.length)
        return { status: 'uncertain', providerTaskId: input.adoptedProviderTaskId, error: 'duplicate_provider_job_records' };
      let record = existing.items[0];
      if (record) {
        if (record.task_id !== input.taskId || record.shot_id !== input.shotId || record.provider !== 'heygen'
          || record.presenter_asset_id !== input.presenter.presenterAssetId
          || record.visual_control?.adoption !== true
          || String(record.provider_task_id || '') !== input.adoptedProviderTaskId)
          return { status: 'uncertain', providerTaskId: input.adoptedProviderTaskId, error: 'adopted_provider_job_scope_changed' };
      } else {
        record = await deps.store.create<any>('studio_social_presenter_jobs', {
          tenant_id: input.tenantId, task_id: input.taskId, shot_id: input.shotId, request_id: input.idempotencyKey,
          status: 'accepted', provider: 'heygen', presenter_asset_id: input.presenter.presenterAssetId,
          provider_task_id: input.adoptedProviderTaskId,
          visual_control: {
            adoption: true,
            publicEvidence: structuredClone(input.presenter.publicEvidence),
            scriptSha256: createHash('sha256').update(input.script).digest('hex'),
          },
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
        if (!record) return { status: 'uncertain', providerTaskId: input.adoptedProviderTaskId, error: 'provider_job_claim_failed' };
      }
      await recordCurrentContentProviderReceipt({
        provider: 'heygen', requestId: input.idempotencyKey, state: 'accepted',
        providerTaskId: input.adoptedProviderTaskId, metadata: { adoption: true },
      });
      await input.onProviderEvent?.({ state: 'accepted', providerTaskId: input.adoptedProviderTaskId });

      let completed: Awaited<ReturnType<HeyGenClient['status']>> | null = null;
      for (let index = 0; index < polls; index += 1) {
        const status = await deps.client.status(input.adoptedProviderTaskId);
        await input.onProviderEvent?.({ state: 'checking', providerTaskId: input.adoptedProviderTaskId,
          providerStatus: status.status, durationSeconds: Number(status.duration) > 0 ? Number(status.duration) : undefined });
        if (status.status === 'failed') {
          await deps.store.update('studio_social_presenter_jobs', record.id, {
            status: 'failed', error: status.error || 'provider_failed', updated_at: new Date().toISOString() });
          await recordCurrentContentProviderReceipt({
            provider: 'heygen', requestId: input.idempotencyKey, state: 'failed',
            providerTaskId: input.adoptedProviderTaskId, metadata: { adoption: true, providerError: status.error || 'provider_failed' },
          });
          await adoptionError(input, { error: status.error || 'provider_failed', providerStatus: status.status });
          return { status: 'failed', providerTaskId: input.adoptedProviderTaskId, error: status.error || 'provider_failed' };
        }
        if (status.status === 'completed') { completed = status; break; }
        if (pollInterval) await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      const duration = Number(completed?.duration);
      if (completed && duration > 0 && input.expectedDurationSeconds !== undefined
        && Math.abs(duration - input.expectedDurationSeconds) > 0.2) {
        await deps.store.update('studio_social_presenter_jobs', record.id, {
          status: 'failed', error: 'provider_duration_mismatch', updated_at: new Date().toISOString() });
        await adoptionError(input, { error: 'provider_duration_mismatch', providerStatus: completed.status, durationSeconds: duration });
        return { status: 'failed', providerTaskId: input.adoptedProviderTaskId, error: 'provider_duration_mismatch', duration };
      }
      if (!completed?.url || !(duration > 0)) {
        await input.onProviderEvent?.({ state: 'pending', providerTaskId: input.adoptedProviderTaskId,
          providerStatus: completed?.status || 'pending', error: 'provider_still_processing' });
        return { status: 'pending', providerTaskId: input.adoptedProviderTaskId, error: 'provider_still_processing' };
      }
      let bytes: Buffer;
      try {
        bytes = await deps.download(completed.url);
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        await deps.store.update('studio_social_presenter_jobs', record.id,
          { status: 'accepted', error: message, updated_at: new Date().toISOString() }).catch(() => undefined);
        await adoptionError(input, { error: message, providerStatus: completed.status, durationSeconds: duration });
        return { status: 'uncertain', providerTaskId: input.adoptedProviderTaskId, error: message };
      }
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      if (input.expectedMediaSha256 && contentHash !== input.expectedMediaSha256) {
        await deps.store.update('studio_social_presenter_jobs', record.id, {
          status: 'failed', error: 'provider_content_hash_mismatch', updated_at: new Date().toISOString() });
        await adoptionError(input, { error: 'provider_content_hash_mismatch', providerStatus: completed.status,
          durationSeconds: duration, contentHash, bytes: bytes.length });
        return { status: 'failed', providerTaskId: input.adoptedProviderTaskId, error: 'provider_content_hash_mismatch', contentHash, duration };
      }
      await input.onProviderEvent?.({ state: 'downloaded', providerTaskId: input.adoptedProviderTaskId,
        providerStatus: completed.status, durationSeconds: duration, contentHash, bytes: bytes.length });

      const filename = `social-presenter-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}.mp4`;
      const objectKey = materialAssetObjectKey(input.tenantId, filename);
      let localPath: string;
      let objectEtag = '';
      try {
        fs.mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
        localPath = path.join(input.outputDirectory, filename);
        fs.writeFileSync(localPath, bytes, { mode: 0o600 });
        await deps.upload({ key: objectKey, body: bytes, contentType: 'video/mp4' });
        const stored = await deps.head(objectKey);
        if (!stored?.size || !stored.etag) throw new Error('digital_presenter_object_storage_verification_failed');
        objectEtag = String(stored.etag);
        await input.onProviderEvent?.({ state: 'uploaded', providerTaskId: input.adoptedProviderTaskId,
          providerStatus: completed.status, durationSeconds: duration, contentHash, bytes: bytes.length, localPath, objectKey });
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        await deps.store.update('studio_social_presenter_jobs', record.id,
          { status: 'accepted', error: message, updated_at: new Date().toISOString() }).catch(() => undefined);
        await adoptionError(input, { error: message, providerStatus: completed.status, durationSeconds: duration });
        return { status: 'uncertain', providerTaskId: input.adoptedProviderTaskId, error: message, contentHash, duration };
      }
      const materialId = `social-presenter-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}`;
      const materials = readLocalMaterials();
      saveLocalMaterials([...materials.filter(item => !(item.id === materialId && item.tenantId === input.tenantId)), {
        id: materialId, name: `社媒数字人口播 · ${input.shotId}`, folder: 'presenter', type: 'video',
        duration, size: `${bytes.length} B`, file: '', url: '', objectKey,
        objectEtag, contentSha256: contentHash, scope: 'own', tenantId: input.tenantId,
        usage: 'editable', sourceType: 'heygen', sourceExecutionId: input.adoptedProviderTaskId, createdAt: new Date().toISOString(),
      }]);
      await deps.store.update('studio_social_presenter_jobs', record.id, { status: 'completed',
        provider_task_id: input.adoptedProviderTaskId, material_id: materialId, object_key: objectKey,
        content_sha256: contentHash, updated_at: new Date().toISOString() });
      await recordCurrentContentProviderReceipt({
        provider: 'heygen', requestId: input.idempotencyKey, state: 'completed',
        providerTaskId: input.adoptedProviderTaskId,
        metadata: { adoption: true, materialId, objectKey, contentHash, duration },
      });
      await input.onProviderEvent?.({ state: 'completed', providerTaskId: input.adoptedProviderTaskId,
        providerStatus: completed.status, durationSeconds: duration, contentHash, bytes: bytes.length, localPath, objectKey });
      return { status: 'completed', providerTaskId: input.adoptedProviderTaskId, localPath, contentHash, duration, bytes: bytes.length };
    },
  };
  return ports;
}

export function createEnvironmentSocialHeyGenBridge(store: DataStore, tenantId?: string): {
  readiness: SocialHeyGenBridgeReadiness;
  ports: SocialDigitalPresenterBridgePorts | null;
} {
  const budget = studioPaidBudget.status('heygen', undefined, tenantId);
  const readiness = socialHeyGenBridgeReadiness({ enabled: process.env.SOCIAL_CONTENT_HEYGEN_ENABLED,
    generationEnabled: process.env.HEYGEN_GENERATION_ENABLED, apiKey: process.env.HEYGEN_API_KEY,
    storageReady: objectStorageEnabled(), budget });
  if (!readiness.ready) return { readiness, ports: null };
  return { readiness, ports: createSocialHeyGenBridgePorts({ store,
    client: new HeyGenClient(process.env.HEYGEN_API_KEY || ''), budget: studioPaidBudget,
    storageReady: objectStorageEnabled, download: defaultDownload, upload: objectStorageUpload, head: objectStorageHead }) };
}
