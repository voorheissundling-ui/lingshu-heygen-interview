import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DataStore } from '../storage/datastore.js';
import { acquireDurableOperationLease, releaseDurableOperationLease } from '../runtime/durableLease.js';
import type { DigitalPresenterExecutionRequest, SocialDigitalPresenterBridgePorts, CompletedDigitalPresenterExecution } from './socialContentDigitalPresenterAdapter.js';

type Request = DigitalPresenterExecutionRequest & { reservationRef: string };
const COLLECTION = 'social_seedance_presenter_jobs';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Prepared = {
  firstFrameUrl: string; firstFrameSha256: string;
  motionGuideUrl?: string; motionGuideSourceSha256?: string; motionGuideSha256?: string;
  /** Public, immutable projection of the already-frozen scene audio. Seedance
   * may consume it, but may not become the source of truth for the voice. */
  speechAudioUrl?: string; speechAudioSha256?: string;
  identityRemoved?: true; motionOnly?: true;
};
export interface SeedancePresenterBridgeDependencies {
  store: DataStore;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maximumCostCny: number;
  /** Off by default. Enable only for an explicitly certified model/account
   * combination whose output passes both audio identity and lip-sync QA. */
  preciseSpeechCertified?: boolean;
  resolvePresenter: SocialDigitalPresenterBridgePorts['resolvePresenter'];
  authorizeBudget: SocialDigitalPresenterBridgePorts['authorizeBudget'];
  reconcileBudget?: SocialDigitalPresenterBridgePorts['reconcileBudget'];
  assertCurrent(): Promise<void>;
  /** Server-owned reader verifies persisted Seedream approval, authorization,
   * byte hashes and anonymized motion-guide lineage before returning URLs. */
  prepareInputs(input: DigitalPresenterExecutionRequest): Promise<Prepared>;
  /** Re-read the server-owned audio receipt. A client-provided URL or hash is
   * never sufficient to enable a paid speech generation. */
  verifySpeechAudio?(input: DigitalPresenterExecutionRequest): Promise<boolean>;
  /** Must assert the exact frozen provider/model/account and whole-film paid
   * intent against this real request body, before any provider submission. */
  beforeSubmit(input: Request, body: Record<string, unknown>): Promise<void>;
  /** Decode/probe and inspect actual generated frames. Returns real durable
   * QA evidence, never a model-authored approval supplied by the client. */
  verifyOutput(input: DigitalPresenterExecutionRequest, output: { localPath: string; sha256: string; providerTaskId: string }): Promise<{ passed: boolean; durationSeconds: number; evidenceRefs: string[]; audioTrackMatchesInput?: boolean; lipSyncPassed?: boolean; actualCostCny?: number; deliveredPath?: string }>;
  transport?: typeof fetch;
  pollMs?: number;
  maxPolls?: number;
}

/** Dynamic identity-locked presenter execution. Speech+motion remains a
 * separate capability: a motion video is NEVER certified as precise lip sync.
 * Durable pre-POST claims retain unknown outcomes, including missing task IDs. */
export function createSocialSeedancePresenterBridge(deps: SeedancePresenterBridgeDependencies): SocialDigitalPresenterBridgePorts {
  if (!deps.apiKey.trim() || !deps.model.trim() || !(deps.maximumCostCny > 0)) throw Error('seedance_presenter_configuration_missing');
  const transport = deps.transport ?? fetch;
  async function execute(input: Request, recoveryOnly = false) {
    await deps.assertCurrent();
    if (input.presenter.providerId !== 'seedance' || !input.presenter.authorized || !input.presenter.authorizationRef || !input.presenter.consentRef)
      throw Error('seedance_presenter_authorization_missing');
    const manifest=input.approvedFirstFrame.assetProvenance;
    if(!manifest||manifest.presenter.assetId!==input.presenter.presenterAssetId||manifest.presenter.assetVersion!==input.presenter.assetVersion)
      throw Error('seedance_presenter_composite_source_manifest_missing');
    const product=manifest.products.find(item=>item.productId===input.visualControl.product.productId);
    if(input.visualControl.product.required&&(!product
      ||product.enterpriseFactRef!==input.visualControl.product.enterpriseFactRef
      ||JSON.stringify([...new Set(product.referenceImageIds)].sort())!==JSON.stringify([...new Set(input.visualControl.product.referenceAssetIds)].sort())))
      throw Error('seedance_presenter_composite_product_binding_changed');
    const needsSpeech = Boolean(input.speechAudio || input.visualControl.requiredCapabilities.includes('scripted_speech'));
    if (needsSpeech && (!deps.preciseSpeechCertified || !input.speechAudio || !deps.verifySpeechAudio || !await deps.verifySpeechAudio(input)))
      throw Error('seedance_presenter_precise_speech_capability_unverified');
    const duration = input.speechAudio?.durationSeconds ?? input.visualControl.timing.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 15) throw Error('seedance_presenter_duration_invalid');
    const frame = await fs.readFile(input.approvedFirstFrame.localPath);
    if (sha(frame) !== input.approvedFirstFrame.sha256) throw Error('seedance_presenter_first_frame_bytes_changed');
    const prepared = await deps.prepareInputs(input);
    if (prepared.firstFrameSha256 !== input.approvedFirstFrame.sha256 || !/^https:\/\//.test(prepared.firstFrameUrl)
      || prepared.motionGuideUrl && (prepared.identityRemoved !== true || prepared.motionOnly !== true
      || !/^[a-f0-9]{64}$/.test(prepared.motionGuideSourceSha256 || '') || !/^[a-f0-9]{64}$/.test(prepared.motionGuideSha256 || '')
      || prepared.motionGuideSourceSha256 === prepared.motionGuideSha256 || !/^https:\/\//.test(prepared.motionGuideUrl))) throw Error('seedance_presenter_verified_inputs_missing');
    if (needsSpeech && (!/^https:\/\//.test(prepared.speechAudioUrl || '')
      || prepared.speechAudioSha256 !== input.speechAudio!.clipSha256)) throw Error('seedance_presenter_verified_speech_input_missing');
    const body = { model: deps.model, content: [
      { type: 'text', text: needsSpeech
        ? `Animate only the supplied authorized enterprise presenter. Preserve identity, clothing and scene. Match mouth movement to the supplied frozen speech audio without rewriting words, timing, voice or pauses. The identity-removed reference is motion guidance only. No source face, captions or fabricated product interaction. Follow this frozen direction: ${JSON.stringify(input.visualControl)}`
        : `Animate only the supplied authorized enterprise presenter. Preserve identity, clothing and scene. The identity-removed reference is motion guidance only. No source face, source voice, captions or fabricated product interaction. Follow this frozen direction: ${JSON.stringify(input.visualControl)}` },
      { type: 'image_url', image_url: { url: prepared.firstFrameUrl }, role: prepared.motionGuideUrl ? 'reference_image' : 'first_frame' },
      ...(prepared.motionGuideUrl ? [{ type: 'video_url', video_url: { url: prepared.motionGuideUrl }, role: 'reference_video' }] : []),
      ...(needsSpeech ? [{ type: 'audio_url', audio_url: { url: prepared.speechAudioUrl! }, role: 'reference_audio' }] : []),
    ], duration: Math.max(4, Math.ceil(duration)), ratio: '9:16', resolution: '720p', generate_audio: needsSpeech, watermark: false };
    // Signed URLs expire; immutable byte identities, not URL query parameters,
    // are the durable recovery identity.
    const requestHash = sha(JSON.stringify({ ...input, outputDirectory: undefined, reservationRef: undefined, recoveryOnly: undefined, approvedFirstFrame: { ...input.approvedFirstFrame, url: undefined, localPath: undefined }, prepared: { ...prepared, firstFrameUrl: undefined, motionGuideUrl: undefined }, model: deps.model }));
    const subjectId = sha(`${input.tenantId}:${input.idempotencyKey}`), ownerId = randomUUID();
    const lease = await acquireDurableOperationLease({ dataStore: deps.store, tenantId: input.tenantId, scope: 'seedance_presenter_submission', subjectId, ownerId, leaseDurationMs: 900_000, reclaimGraceMs: 5_000 });
    if (!lease) throw Error('seedance_presenter_execution_busy');
    try {
      const found = await deps.store.list<any>(COLLECTION, { where: { tenant_id: input.tenantId, request_id: input.idempotencyKey }, perPage: 2 });
      if (found.totalItems !== found.items.length || found.items.length > 1) throw Error('seedance_presenter_receipt_ambiguous');
      let row = found.items[0];
      if (row && row.request_hash !== requestHash) throw Error('seedance_presenter_recovery_inputs_changed');
      if (!row && recoveryOnly) return null;
      if (row?.status === 'completed') {
        const output = row.output as CompletedDigitalPresenterExecution;
        if (!output?.localPath || sha(await fs.readFile(output.localPath)) !== output.contentHash) throw Error('seedance_presenter_cached_output_changed');
        return output;
      }
      if (row && !row.provider_task_id) throw Error('seedance_presenter_submission_unknown_do_not_resubmit');
      const base = (deps.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
      const json = async (url: string, init?: RequestInit) => {
        const response = await transport(url, { ...init, headers: { Authorization: `Bearer ${deps.apiKey}`, 'Content-Type': 'application/json', ...init?.headers }, signal: AbortSignal.timeout(45_000) });
        const value = await response.json() as any;
        if (!response.ok) throw Error(`seedance_presenter_provider_http_${response.status}`);
        return value;
      };
      if (!row) {
        await deps.beforeSubmit(input, body);
        await deps.assertCurrent();
        row = await deps.store.create<any>(COLLECTION, { tenant_id: input.tenantId, task_id: input.taskId, shot_id: input.shotId, request_id: input.idempotencyKey, request_hash: requestHash, status: 'submitting', reservation_ref: input.reservationRef, created_at: new Date().toISOString() });
        if (!row) throw Error('seedance_presenter_submission_claim_failed');
        try {
          const result = await json(`${base}/contents/generations/tasks`, { method: 'POST', headers: { 'X-Client-Request-Id': input.idempotencyKey }, body: JSON.stringify(body) });
          const id = String(result.id || '').trim();
          if (!id) throw Error('seedance_presenter_provider_task_id_missing');
          if (!await deps.store.update(COLLECTION, row.id, { status: 'accepted', provider_task_id: id })) throw Error('seedance_presenter_receipt_write_failed');
          row.provider_task_id = id;
        } catch (error) {
          await deps.store.update(COLLECTION, row.id, { status: 'unknown' }).catch(() => undefined);
          throw error;
        }
      }
      for (let attempt = 0; attempt < (deps.maxPolls ?? 60); attempt++) {
        await deps.assertCurrent();
        const result = await json(`${base}/contents/generations/tasks/${encodeURIComponent(row.provider_task_id)}`);
        if (['failed', 'expired', 'cancelled'].includes(result.status)) throw Error('seedance_presenter_provider_failed');
        if (result.status === 'succeeded') {
          const url = String(result.content?.video_url || '');
          if (!/^https:\/\//.test(url)) throw Error('seedance_presenter_output_url_missing');
          const response = await transport(url, { signal: AbortSignal.timeout(120_000) });
          if (!response.ok) throw Error('seedance_presenter_download_failed');
          const bytes = Buffer.from(await response.arrayBuffer());
          if (!bytes.length) throw Error('seedance_presenter_output_empty');
          await fs.mkdir(input.outputDirectory, { recursive: true });
          const localPath = path.join(input.outputDirectory, `${subjectId}.mp4`), contentHash = sha(bytes);
          await fs.writeFile(localPath, bytes, { mode: 0o600 });
          const qa = await deps.verifyOutput(input, { localPath, sha256: contentHash, providerTaskId: row.provider_task_id });
          if (!qa.passed || !qa.evidenceRefs.length || !Number.isFinite(qa.durationSeconds) || Math.abs(qa.durationSeconds - duration) > 1 / 24 + .01
            || needsSpeech && (qa.audioTrackMatchesInput !== true || qa.lipSyncPassed !== true)
            || qa.actualCostCny !== undefined && (!Number.isFinite(qa.actualCostCny) || qa.actualCostCny < 0 || qa.actualCostCny > input.maximumCostCny)) throw Error('seedance_presenter_dynamic_quality_failed');
          const deliveredPath = qa.deliveredPath ?? localPath;
          const deliveredBytes = await fs.readFile(deliveredPath);
          if (!deliveredBytes.length) throw Error('seedance_presenter_delivery_empty');
          const output: CompletedDigitalPresenterExecution = { status: 'completed', providerTaskId: row.provider_task_id, localPath: deliveredPath, contentHash: sha(deliveredBytes), duration: qa.durationSeconds, ...(qa.actualCostCny !== undefined ? { actualCostCny: qa.actualCostCny } : {}) };
          if (!await deps.store.update(COLLECTION, row.id, { status: 'completed', output, qa })) throw Error('seedance_presenter_output_receipt_write_failed');
          return output;
        }
        if (attempt + 1 < (deps.maxPolls ?? 60)) await new Promise(resolve => setTimeout(resolve, deps.pollMs ?? 8_000));
      }
      return { status: 'pending' as const, providerTaskId: row.provider_task_id, error: 'seedance_presenter_provider_pending' };
    } finally { await releaseDurableOperationLease({ dataStore: deps.store, lease }); }
  }
  return { maximumCostCny: deps.maximumCostCny, capabilities: { methods: ['reenact', 'replace'], controls: ['reference_motion', 'guided_action', 'environment_control', 'camera_control', 'timing_control', ...(deps.preciseSpeechCertified ? ['scripted_speech' as const] : [])] }, resolvePresenter: deps.resolvePresenter,
    authorizeBudget: deps.authorizeBudget, reconcileBudget: deps.reconcileBudget,
    execute: input => execute(input) as ReturnType<SocialDigitalPresenterBridgePorts['execute']>,
    recoverExisting: input => execute({ ...input, reservationRef: '' }, true),
  };
}
