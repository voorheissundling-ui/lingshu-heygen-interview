/**
 * Step 3 controlled single-shot closed loop.
 *
 * This is a real paid path, not the offline sandbox:
 *   storyboard + public catalog evidence -> one HeyGen POST -> same video_id
 *   -> poll -> download -> ffmpeg decode/layout evidence.
 *
 * Safety properties:
 * - the API key is read from a file outside the repository and never printed;
 * - the first POST needs both a positive CNY cap and --submit-approved-shot;
 * - request identity and the paid-submission count are persisted before POST;
 * - a restart never POSTs again; it only queries the saved video_id;
 * - no database row or review state is changed by this harness.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import {HeyGenClient, HeyGenRequestError} from '../server/lib/heygen.js';
import {parseHeyGenPublishedPrice, parseEcbUsdCny, HEYGEN_PRICE_URL, ECB_FX_URL} from '../server/lib/heygenPublishedPricing.js';
import {readStoryboardFile} from './storyboard.js';
import {productionBillingAccountRef} from '../server/starter198/socialContentProductionBudgetRoutes.js';
import {readTrustedPublicHeyGenRuntimeBinding} from '../server/starter198/socialContentHeyGenRuntimeBinding.js';

const ROOT = path.resolve('.interview-data/step3-single-shot');
const STATE_FILE = path.join(ROOT, 'state.json');
const OUTPUT_FILE = path.join(ROOT, 'provider-output.mp4');
const FRAME_DIR = path.join(ROOT, 'frames');
const EVIDENCE_DIR = path.resolve('evidence');
const PREFLIGHT_FILE = path.resolve('.interview-data/provider-preflight.json');
const STORYBOARD_FILE = 'assets/storyboard.json';
const PROVIDER_TERMS_REF = 'https://www.heygen.com/terms';
const MAX_MEDIA_BYTES = 110 * 1024 * 1024;
const MAX_WAIT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;
const execFileAsync = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fail(message: string): never {
  throw new Error(message);
}

function scrub(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/https?:\/\/\S+/g, '[redacted-url]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted-token]')
    .slice(0, 800);
}

function insideRepository(file: string): boolean {
  const root = path.resolve('.');
  const absolute = path.resolve(file);
  return absolute === root || absolute.startsWith(root + path.sep);
}

function languageCode(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const names: Record<string, string> = {
    english: 'en', chinese: 'zh', spanish: 'es', french: 'fr', german: 'de',
    japanese: 'ja', korean: 'ko', portuguese: 'pt', italian: 'it', arabic: 'ar',
    hindi: 'hi', russian: 'ru',
  };
  return names[raw] ?? raw.split(/[-_]/)[0];
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error(`upstream_read_${response.status}`);
  return response.text();
}

async function apiGet(key: string, route: string): Promise<any> {
  const response = await fetch('https://api.heygen.com' + route, {
    headers: {'x-api-key': key}, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error || value.data == null) throw new Error(`heygen_read_${response.status}`);
  return value.data;
}

function safeDownloadUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { fail('provider_download_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    fail('provider_download_url_invalid');
  if (!/(^|\.)heygen\.(ai|com)$/i.test(url.hostname)) fail('provider_download_host_untrusted');
  return url.href;
}

async function readMedia(file: string): Promise<Buffer> {
  const buffer = await fs.readFile(file);
  if (buffer.length < 10_000) fail('provider_media_file_too_small');
  if (buffer.length > MAX_MEDIA_BYTES) fail('provider_media_file_too_large');
  return buffer;
}

interface MediaMetadata {
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  fps: number | null;
}

function parseFfmpegMetadata(stderr: string): MediaMetadata {
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const video = stderr.match(/Video:\s*([^,\s]+)[^\n]*?(\d{2,5})x(\d{2,5})/);
  const audio = stderr.match(/Audio:\s*([^,\s]+)[^\n]*?(\d+)\s*Hz/);
  const fps = stderr.match(/(\d+(?:\.\d+)?)\s*fps/);
  return {
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
    videoCodec: video ? video[1].toLowerCase() : null,
    audioCodec: audio ? audio[1].toLowerCase() : null,
    sampleRate: audio ? Number(audio[2]) : null,
    fps: fps ? Number(fps[1]) : null,
  };
}

async function ffmpegRun(args: string[]): Promise<{code: number; stderr: string}> {
  if (!ffmpegStatic) fail('ffmpeg_static_missing');
  try {
    const result = await execFileAsync(ffmpegStatic, args, {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    return {code: 0, stderr: String(result.stderr || '')};
  } catch (error) {
    const value = error as {code?: number; stderr?: string};
    return {code: typeof value.code === 'number' ? value.code : 1, stderr: String(value.stderr || '')};
  }
}

async function validateMedia(file: string, providerDuration: number): Promise<{
  bytes: number; sha256: string; metadata: MediaMetadata; validation: Record<string, unknown>;
}> {
  const bytes = await readMedia(file);
  const metadataRun = await ffmpegRun(['-hide_banner', '-nostdin', '-i', file]);
  const metadata = parseFfmpegMetadata(metadataRun.stderr);
  const decode = await ffmpegRun(['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-']);
  const errors: string[] = [];
  if (!(Number(metadata.duration) > 0)) errors.push('duration_missing');
  if (!(metadata.duration! > 0) || Math.abs(metadata.duration! - providerDuration) > 1) errors.push('provider_duration_mismatch');
  if (!metadata.width || !metadata.height || metadata.width * 16 !== metadata.height * 9) errors.push('aspect_ratio_not_9_16');
  if (![720, 1080].includes(metadata.width || 0)) errors.push('unexpected_width');
  if (metadata.videoCodec !== 'h264') errors.push('video_codec_not_h264');
  if (!metadata.audioCodec) errors.push('audio_stream_missing');
  if (!(Number(metadata.fps) > 0)) errors.push('fps_missing');
  if (decode.code !== 0) errors.push('ffmpeg_decode_failed');
  const decodeTail = decode.stderr.trim().split('\n').slice(-3).join(' | ');
  return {
    bytes: bytes.length,
    sha256: sha(bytes),
    metadata,
    validation: {
      durationMatchesProvider: !errors.includes('provider_duration_mismatch'),
      decodable: decode.code === 0,
      resolution: metadata.width && metadata.height ? `${metadata.width}x${metadata.height}` : null,
      videoCodec: metadata.videoCodec,
      audioCodec: metadata.audioCodec,
      sampleRate: metadata.sampleRate,
      fps: metadata.fps,
      errors,
      ...(decodeTail ? {decodeTail} : {}),
    },
  };
}

async function extractFrames(file: string, duration: number): Promise<Array<{at: number; file: string; bytes: number}>> {
  await fs.mkdir(FRAME_DIR, {recursive: true, mode: 0o700});
  const ats = [Math.min(0.5, duration / 2), Math.max(0.1, duration / 2), Math.max(0.1, duration - 0.5)];
  const frames: Array<{at: number; file: string; bytes: number}> = [];
  for (let index = 0; index < ats.length; index += 1) {
    const at = Math.round(ats[index] * 1000) / 1000;
    const output = path.join(FRAME_DIR, `frame-${index}.png`);
    const run = await ffmpegRun(['-y', '-hide_banner', '-nostdin', '-ss', String(at), '-i', file,
      '-frames:v', '1', '-vf', 'scale=360:-1', output]);
    if (run.code !== 0) continue;
    const stat = await fs.stat(output).catch(() => null);
    if (stat?.isFile() && stat.size > 0) frames.push({at, file: output, bytes: stat.size});
  }
  return frames;
}

async function main(): Promise<void> {
  await fs.mkdir(ROOT, {recursive: true, mode: 0o700});
  await fs.mkdir(EVIDENCE_DIR, {recursive: true});
  let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    lock = await fs.open(path.join(ROOT, 'execution.lock'), 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail('step3_execution_lock_exists_confirm_no_process_then_remove_lock');
    throw error;
  }

  const persist = async (state: any) => {
    const temp = STATE_FILE + '.tmp';
    await fs.writeFile(temp, JSON.stringify(state, null, 2), {mode: 0o600});
    await fs.rename(temp, STATE_FILE);
  };

  try {
    const keyFile = process.env.HEYGEN_KEY_FILE;
    if (!keyFile) fail('missing_HEYGEN_KEY_FILE');
    if (insideRepository(keyFile)) fail('key_file_inside_repository_refused');
    const key = (await fs.readFile(keyFile, 'utf8')).trim();
    if (!key || key.length < 16 || key.length > 512 || /\s/.test(key)) fail('key_file_must_contain_one_line_API_key');
    const credentialHash = sha(key);

    const storyboardRead = await readStoryboardFile(STORYBOARD_FILE, {checkLocalFiles: true});
    if (!storyboardRead.ok || !storyboardRead.storyboard || !storyboardRead.sha256)
      fail('storyboard_invalid');
    const storyboard = storyboardRead.storyboard;
    const shotId = (process.argv.find(value => value.startsWith('--shot='))?.split('=')[1] || 'hook').trim();
    const shot = storyboard.shots.find(item => item.id === shotId && item.kind === 'presenter');
    if (!shot) fail('step3_presenter_shot_not_found');
    if (!(shot.durationSeconds >= 3 && shot.durationSeconds <= 8)) fail('step3_shot_duration_must_be_3_to_8_seconds');
    const avatarId = storyboard.presenter.avatarId;
    const voiceId = storyboard.presenter.voiceId;
    const speech = shot.speech.trim();
    if (!speech) fail('step3_speech_missing');

    const preflight = JSON.parse(await fs.readFile(PREFLIGHT_FILE, 'utf8')) as any;
    if (preflight.mode !== 'read_only_no_generation' || preflight.preflightOk !== true)
      fail('step3_read_only_preflight_not_complete');
    const checkedAtMs = Date.parse(preflight.checkedAt);
    if (!Number.isFinite(checkedAtMs) || checkedAtMs > Date.now() + 60_000 || Date.now() - checkedAtMs > 7 * 24 * 3600_000)
      fail('step3_preflight_evidence_stale_or_in_future');
    const catalogSha256 = String(preflight.catalog?.sha256 || '');
    if (!/^[a-f0-9]{64}$/.test(catalogSha256)) fail('step3_public_catalog_digest_missing');
    const preflightAvatar = (preflight.publicAvatars || []).find((item: any) => item.id === avatarId);
    const preflightVoice = (preflight.publicVoices || []).find((item: any) => item.id === voiceId);
    if (!preflightAvatar || !preflightAvatar.supportedEngines?.includes('avatar_iv')
      || preflightAvatar.status !== 'completed' || preflightAvatar.avatarType !== 'photo_avatar')
      fail('step3_public_avatar_evidence_invalid');
    if (!preflightVoice || languageCode(preflightVoice.language) !== languageCode(storyboard.language))
      fail('step3_public_voice_evidence_invalid');

    const accountRef = productionBillingAccountRef('heygen', 'https://api.heygen.com/v3/videos', credentialHash);
    const verifiedAt = String(preflight.checkedAt);
    const publicRecord = {
      id: 'presenter-public-storyboard', ownership: 'public', assetVersion: 1,
      avatarId, voiceId, publicCatalogRef: `heygen-public-catalog:${catalogSha256}`,
      providerTermsRef: PROVIDER_TERMS_REF, verifiedAt, accountId: accountRef,
    };
    const syntheticStore = {
      list: async () => ({
        items: [{tenant_id: 'interview-step3', payload: {presenters: [publicRecord]}}],
        totalItems: 1,
      }),
    } as any;
    const publicBinding = await readTrustedPublicHeyGenRuntimeBinding({
      tenantId: 'interview-step3', presenterAssetId: publicRecord.id, language: storyboard.language,
    }, {
      store: syntheticStore,
      env: () => ({HEYGEN_API_KEY: key}),
      assertCurrent: async () => undefined,
    });
    if (!publicBinding) fail('step3_public_presenter_live_binding_invalid');
    if (publicBinding.avatarId !== avatarId || publicBinding.voiceId !== voiceId)
      fail('step3_public_presenter_binding_drift');

    const account = await apiGet(key, '/v3/users/me');
    const wallet = account?.wallet;
    if (account?.billing_type !== 'wallet' || String(wallet?.currency).toUpperCase() !== 'USD'
      || !Number.isFinite(wallet?.remaining_balance) || wallet.remaining_balance < 0
      || wallet?.auto_reload?.enabled !== false)
      fail('step3_wallet_not_safe_for_paid_shot');
    const walletBefore = Number(wallet.remaining_balance);

    let state: any = null;
    try { state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('step3_state_unreadable'); }

    const requestedCap = Number(process.env.HEYGEN_INTERVIEW_MAX_CNY);
    if (state) {
      if (state.credentialHash !== credentialHash) fail('step3_credential_changed');
      if (state.storyboardSha256 !== storyboardRead.sha256 || state.shotId !== shotId
        || state.avatarId !== avatarId || state.voiceId !== voiceId || state.speech !== speech)
        fail('step3_state_storyboard_changed_no_new_submission');
      if (Number.isFinite(requestedCap) && requestedCap > 0 && requestedCap !== state.approvedCny)
        fail('step3_approved_budget_changed');
    } else {
      if (!process.argv.includes('--submit-approved-shot')) fail('step3_explicit_submit_flag_required');
      if (!(requestedCap > 0 && requestedCap <= 30)) fail('step3_explicit_budget_CNY_required_maximum_30');
      const [priceBody, fxBody] = await Promise.all([fetchText(HEYGEN_PRICE_URL), fetchText(ECB_FX_URL)]);
      const price = parseHeyGenPublishedPrice(priceBody, 'photo_avatar');
      const fx = parseEcbUsdCny(fxBody);
      if (!price || !fx) fail('step3_official_price_or_fx_unavailable');
      const forecastSeconds = shot.durationSeconds + 3;
      const forecastCny = price * fx.cnyPerUsd * forecastSeconds / 60;
      const walletCoverageCny = walletBefore * fx.cnyPerUsd;
      if (forecastCny > requestedCap) fail('step3_forecast_exceeds_approved_budget');
      if (requestedCap > walletCoverageCny) fail('step3_approved_budget_exceeds_wallet_coverage');
      await fs.writeFile(path.join(ROOT, 'pricing-source.html'), priceBody, {mode: 0o600});
      await fs.writeFile(path.join(ROOT, 'fx-source.xml'), fxBody, {mode: 0o600});
      state = {
        schemaVersion: 1, mode: 'step3_single_shot_closed_loop', phase: 'prepared',
        requestId: 'interview-step3-' + randomUUID(), credentialHash,
        approvedCny: requestedCap, priceUsdPerMinute: price, fx,
        forecastSeconds, forecastCny, walletCoverageCny, walletBefore,
        storyboardPath: STORYBOARD_FILE, storyboardSha256: storyboardRead.sha256,
        shotId, speech, shotDurationSeconds: shot.durationSeconds,
        avatarId, voiceId, title: `LingShu Step 3 ${shotId} ${storyboardRead.sha256.slice(0, 8)}`,
        publicEvidence: publicBinding.publicEvidence,
        providerEvidenceRef: publicBinding.providerEvidenceRef,
        preflight: {file: '.interview-data/provider-preflight.json', checkedAt: verifiedAt,
          catalogSha256, avatar: preflightAvatar, voice: preflightVoice},
        paidSubmissions: 0, createdAt: now(),
      };
      await persist(state);
    }
    if (state.publicEvidence?.ownership !== 'public' || 'consentRef' in state.publicEvidence
      || 'authorizationRef' in state.publicEvidence)
      fail('step3_public_evidence_must_not_fake_clone_consent');

    if (process.argv.includes('--prepare-only')) {
      if (state.phase !== 'prepared' || state.paidSubmissions !== 0)
        fail('step3_prepare_only_requires_an_unsubmitted_prepared_state');
      console.log(JSON.stringify({
        status: 'prepared_no_provider_post', requestId: state.requestId,
        shotId: state.shotId, speech: state.speech, avatarId: state.avatarId, voiceId: state.voiceId,
        approvedCny: state.approvedCny, forecastSeconds: state.forecastSeconds,
        forecastCny: Number(state.forecastCny.toFixed(6)), walletBefore: state.walletBefore,
        walletCoverageCny: Number(state.walletCoverageCny.toFixed(6)),
        publicEvidence: state.publicEvidence, paidSubmissions: state.paidSubmissions,
      }));
      return;
    }

    const callbacks = {
      async beforeSubmit(body: Record<string, unknown>, requestId: string) {
        if (state.phase !== 'prepared' || state.paidSubmissions !== 0 || requestId !== state.requestId)
          fail('step3_submission_not_authorized');
        if (body.type !== 'avatar' || body.avatar_id !== state.avatarId || body.voice_id !== state.voiceId
          || body.script !== state.speech || body.aspect_ratio !== '9:16' || body.output_format !== 'mp4'
          || body.engine)
          fail('step3_submission_body_drift');
        state.requestHash = sha(JSON.stringify(body));
        state.request = body;
        state.phase = 'submitting';
        state.paidSubmissions = 1;
        state.submittedAt = now();
        await persist(state);
      },
      async onAccepted(videoId: string, requestId: string, receipt?: Record<string, unknown>) {
        if (requestId !== state.requestId) fail('step3_request_identity_drift');
        state.phase = 'accepted';
        state.videoId = videoId;
        state.providerReceipt = receipt ? {
          id: receipt.id, status: receipt.status, title: receipt.title,
          keys: Object.keys(receipt).sort(),
        } : null;
        state.acceptedAt = now();
        await persist(state);
      },
      async onStatus(videoId: string, receipt: Record<string, any>) {
        if (videoId !== state.videoId) fail('step3_video_identity_drift');
        state.providerStatus = receipt.status ?? null;
        state.providerDuration = Number.isFinite(receipt.duration) ? receipt.duration : null;
        state.lastCheckedAt = now();
        if (typeof receipt.video_url === 'string') {
          try { state.providerVideoHost = new URL(receipt.video_url).hostname; } catch { /* no URL retained */ }
        }
        await persist(state);
      },
    };
    const client = new HeyGenClient(key, fetch, callbacks);

    if (state.phase === 'failed') fail('step3_previous_generation_failed_no_resubmission');
    if (state.phase === 'rejected') fail('step3_previous_submission_rejected_no_resubmission');
    if (state.phase === 'submission_unknown') fail('step3_submission_unknown_reconcile_do_not_resubmit');
    if (state.phase === 'submitting') fail('step3_submission_state_unknown_reconcile_do_not_resubmit');

    if (state.phase === 'prepared') {
      if (!process.argv.includes('--submit-approved-shot')) fail('step3_explicit_submission_flag_required');
      try {
        await client.create({
          avatarId: state.avatarId, voiceId: state.voiceId, script: state.speech,
          ratio: '9:16', transparent: false, title: state.title,
        }, state.requestId);
      } catch (error) {
        // A callback can reject before the HTTP POST is attempted. In that
        // case the persisted phase is still "prepared"; do not falsely mark
        // an accepted provider task as unknown.
        if (state.phase === 'prepared') {
          state.lastError = scrub(error);
          await persist(state);
          throw error;
        }
        const knownRejection = error instanceof HeyGenRequestError
          && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
        state.phase = knownRejection ? 'rejected' : 'submission_unknown';
        state.lastError = scrub(error);
        await persist(state);
        throw error;
      }
    }
    if (!state.videoId) fail('step3_video_id_missing_do_not_resubmit');

    if (state.phase === 'downloaded') {
      const existing = await fs.stat(OUTPUT_FILE).catch(() => null);
      if (existing?.isFile() && existing.size > 0 && state.mediaSha256) {
        const bytes = await fs.readFile(OUTPUT_FILE);
        if (sha(bytes) === state.mediaSha256) {
          console.log(JSON.stringify({
            status: 'already_downloaded', videoId: state.videoId, requestId: state.requestId,
            requestHash: state.requestHash, duration: state.duration, bytes: state.mediaBytes,
            sha256: state.mediaSha256, estimatedCostCny: state.estimatedCostCny,
            walletBefore: state.walletBefore, walletAfter: state.walletAfter,
            paidSubmissions: state.paidSubmissions, note: 'no provider POST or download repeated',
          }));
          return;
        }
      }
      state.phase = 'accepted';
      delete state.mediaSha256;
      await persist(state);
    }

    let completed: {status: 'pending' | 'completed' | 'failed'; url?: string; duration?: number; error?: string} | null = null;
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const result = await client.status(state.videoId);
      if (result.status === 'failed') {
        state.phase = 'failed';
        state.lastError = String(result.error || 'provider_generation_failed');
        await persist(state);
        fail('step3_provider_generation_failed_no_resubmission');
      }
      if (result.status === 'completed') { completed = result; break; }
      if (process.argv.includes('--once') || Date.now() >= deadline) {
        console.log(JSON.stringify({
          status: 'pending', videoId: state.videoId, requestId: state.requestId,
          paidSubmissions: state.paidSubmissions, providerStatus: state.providerStatus ?? null,
          note: 're-run without --submit-approved-shot to query the same video_id',
        }));
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!completed?.url || !(Number(completed.duration) > 0)) fail('step3_completed_without_media');

    const downloadUrl = safeDownloadUrl(completed.url);
    const response = await fetch(downloadUrl, {redirect: 'error', signal: AbortSignal.timeout(120_000)});
    if (!response.ok || !response.body) fail(`step3_download_http_${response.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_MEDIA_BYTES) {
          await reader.cancel();
          fail('step3_media_too_large');
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    await fs.writeFile(OUTPUT_FILE, bytes, {mode: 0o600});

    const media = await validateMedia(OUTPUT_FILE, Number(completed.duration));
    const frames = await extractFrames(OUTPUT_FILE, Number(completed.duration));
    const walletAfterAccount = await apiGet(key, '/v3/users/me');
    const walletAfter = Number(walletAfterAccount?.wallet?.remaining_balance);
    const observedWalletDeltaUsd = Number.isFinite(walletAfter) ? state.walletBefore - walletAfter : null;
    const observedWalletDeltaCny = observedWalletDeltaUsd === null ? null : observedWalletDeltaUsd * state.fx.cnyPerUsd;
    const estimatedCostCny = Number(completed.duration) * state.priceUsdPerMinute / 60 * state.fx.cnyPerUsd;

    state.phase = 'downloaded';
    state.duration = Number(completed.duration);
    state.mediaBytes = media.bytes;
    state.mediaSha256 = media.sha256;
    state.mediaMetadata = media.metadata;
    state.validation = media.validation;
    state.frames = frames.map(frame => ({at: frame.at, file: path.relative(process.cwd(), frame.file), bytes: frame.bytes}));
    state.estimatedCostCny = estimatedCostCny;
    state.walletAfter = Number.isFinite(walletAfter) ? walletAfter : null;
    state.observedWalletDeltaUsd = observedWalletDeltaUsd;
    state.observedWalletDeltaCny = observedWalletDeltaCny;
    state.withinApprovedCap = estimatedCostCny <= state.approvedCny
      && (observedWalletDeltaCny === null || observedWalletDeltaCny <= state.approvedCny);
    state.completedAt = now();
    await persist(state);

    await fs.copyFile(OUTPUT_FILE, path.join(EVIDENCE_DIR, 'step3-single-shot.mp4'));
    for (const frame of frames) {
      await fs.copyFile(frame.file, path.join(EVIDENCE_DIR, `step3-frame-${frame.at}s.png`));
    }
    const sanitized = {
      schemaVersion: 1, mode: state.mode, phase: state.phase,
      requestId: state.requestId, requestHash: state.requestHash, request: state.request,
      videoId: state.videoId, providerStatus: state.providerStatus, providerDuration: state.duration,
      title: state.title, storyboardPath: state.storyboardPath, storyboardSha256: state.storyboardSha256,
      shotId: state.shotId, speech: state.speech, avatarId: state.avatarId, voiceId: state.voiceId,
      publicEvidence: state.publicEvidence, providerEvidenceRef: state.providerEvidenceRef,
      preflight: state.preflight,
      approvedCny: state.approvedCny, forecastSeconds: state.forecastSeconds,
      forecastCny: state.forecastCny, priceUsdPerMinute: state.priceUsdPerMinute, fx: state.fx,
      walletBefore: state.walletBefore, walletAfter: state.walletAfter,
      observedWalletDeltaUsd: state.observedWalletDeltaUsd,
      observedWalletDeltaCny: state.observedWalletDeltaCny,
      estimatedCostCny: state.estimatedCostCny, withinApprovedCap: state.withinApprovedCap,
      paidSubmissions: state.paidSubmissions, mediaBytes: state.mediaBytes, mediaSha256: state.mediaSha256,
      mediaMetadata: state.mediaMetadata, validation: state.validation,
      frames: state.frames, createdAt: state.createdAt, submittedAt: state.submittedAt,
      acceptedAt: state.acceptedAt, completedAt: state.completedAt,
      completeEmployeeFlowVerified: false,
      note: 'Isolated Step 3 real shot. It proves submit/query/download/decode; it does not write a business task or set review_required.',
    };
    await fs.writeFile(path.join(EVIDENCE_DIR, 'step3-single-shot.json'), JSON.stringify(sanitized, null, 2), {mode: 0o600});
    console.log(JSON.stringify({
      status: 'downloaded', videoId: state.videoId, requestId: state.requestId,
      requestHash: state.requestHash, duration: state.duration, bytes: state.mediaBytes,
      sha256: state.mediaSha256, resolution: state.validation.resolution,
      videoCodec: state.validation.videoCodec, audioCodec: state.validation.audioCodec,
      validationErrors: state.validation.errors,
      estimatedCostCny: Number(state.estimatedCostCny.toFixed(6)),
      walletBefore: state.walletBefore, walletAfter: state.walletAfter,
      observedWalletDeltaUsd: state.observedWalletDeltaUsd,
      observedWalletDeltaCny: state.observedWalletDeltaCny === null ? null : Number(state.observedWalletDeltaCny.toFixed(6)),
      withinApprovedCap: state.withinApprovedCap, paidSubmissions: state.paidSubmissions,
      evidence: {
        mp4: 'evidence/step3-single-shot.mp4', json: 'evidence/step3-single-shot.json',
        frames: frames.map(frame => path.relative(process.cwd(), frame.file)),
      },
    }));
    if (state.validation.errors?.length) process.exitCode = 1;
  } finally {
    if (lock) {
      await lock.close();
      await fs.rm(path.join(ROOT, 'execution.lock'), {force: true});
    }
  }
}

main().catch(error => {
  console.error(scrub(error));
  process.exitCode = 1;
});
