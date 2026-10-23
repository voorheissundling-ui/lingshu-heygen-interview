/**
 * Step 4 explainer narration.
 *
 * The three illustration shots need a real voice track, not subtitle-only
 * silence. This harness calls HeyGen's speech endpoint with the same public
 * voice used by the presenter shots (engine selected from the catalog's
 * available_engines), downloads the audio, and records the paid operation in
 * the shared Step 4 budget ledger.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import {readStoryboardFile} from './storyboard.js';
import {
  assertBudgetIdentity, assertCanReserve, readBudget, reserve, release, settle, persistBudget,
  type Step4Budget,
} from './step4Budget.js';

const STEP_ROOT = path.resolve('.interview-data/step4-narration');
const BUDGET_FILE = path.resolve('.interview-data/step4-shots/budget.json');
const RUN_LOCK = path.join(STEP_ROOT, 'execution.lock');
const EVIDENCE_DIR = path.resolve('evidence');
const STORYBOARD_FILE = 'assets/storyboard.json';
const PREFLIGHT_FILE = path.resolve('.interview-data/provider-preflight.json');
const MAX_AUDIO_BYTES = 20_000_000;
const execFileAsync = promisify(execFile);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

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

function safeAudioUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { fail('narration_audio_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    fail('narration_audio_url_invalid');
  if (!/(^|\.)heygen\.(ai|com)$/i.test(url.hostname)) fail('narration_audio_host_untrusted');
  return url.href;
}

async function apiGet(key: string, route: string): Promise<any> {
  const response = await fetch('https://api.heygen.com' + route, {
    headers: {'x-api-key': key}, redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || value.error || value.data == null) throw new Error(`heygen_read_${response.status}`);
  return value.data;
}

async function readWallet(key: string): Promise<{balance: number}> {
  const account = await apiGet(key, '/v3/users/me');
  const wallet = account?.wallet;
  if (account?.billing_type !== 'wallet' || String(wallet?.currency).toUpperCase() !== 'USD'
    || !Number.isFinite(wallet?.remaining_balance) || wallet.remaining_balance < 0
    || wallet?.auto_reload?.enabled !== false)
    fail('step4_wallet_not_safe_for_paid_operation');
  return {balance: Number(wallet.remaining_balance)};
}

async function probeAudio(file: string): Promise<{duration: number; codec: string; sampleRate: number | null}> {
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
  const audio = stderr.match(/Audio:\s*([^,\s]+)[^\n]*?(\d+)\s*Hz/);
  if (!duration || !audio) fail('narration_audio_probe_failed');
  return {
    duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    codec: audio[1].toLowerCase(),
    sampleRate: Number(audio[2]),
  };
}

async function main(): Promise<void> {
  await fs.mkdir(STEP_ROOT, {recursive: true, mode: 0o700});
  await fs.mkdir(EVIDENCE_DIR, {recursive: true});
  let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    lock = await fs.open(RUN_LOCK, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      fail('step4_narration_execution_lock_exists_confirm_no_process_then_remove_lock');
    throw error;
  }

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
    const shotId = (process.argv.find(value => value.startsWith('--shot='))?.split('=')[1] || '').trim();
    const shot = storyboard.shots.find(item => item.id === shotId && item.kind === 'illustration');
    if (!shot) fail('step4_illustration_shot_not_found_use_--shot=');
    const text = shot.speech.trim();
    if (!text || text.length > 5000) fail('step4_narration_text_invalid');
    const voiceId = storyboard.presenter.voiceId;

    const preflight = JSON.parse(await fs.readFile(PREFLIGHT_FILE, 'utf8')) as any;
    if (preflight.mode !== 'read_only_no_generation' || preflight.preflightOk !== true)
      fail('step4_read_only_preflight_not_complete');
    const preflightVoice = (preflight.publicVoices || []).find((item: any) => item.id === voiceId);
    if (!preflightVoice || !Array.isArray(preflightVoice.engines)) fail('step4_public_voice_evidence_invalid');
    const engine = preflightVoice.engines.includes('orca') ? 'orca'
      : preflightVoice.engines.includes('starfish') ? 'starfish' : '';
    if (!engine) fail('step4_public_voice_has_no_supported_speech_engine');

    const requestedCap = Number(process.env.HEYGEN_INTERVIEW_MAX_CNY);
    if (!(requestedCap > 0 && requestedCap <= 30)) fail('step4_explicit_budget_CNY_required_maximum_30');

    const walletBeforeCheck = await readWallet(key);
    let budget: Step4Budget;
    try {
      budget = await readBudget(BUDGET_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fail('step4_budget_missing_run_presenter_prepare_first');
    }
    assertBudgetIdentity(budget, {
      approvedCny: requestedCap, credentialHash, storyboardSha256: storyboardRead.sha256,
    });

    const shotRoot = path.join(STEP_ROOT, shotId);
    const stateFile = path.join(shotRoot, 'state.json');
    const audioFile = path.join(shotRoot, 'narration.mp3');
    await fs.mkdir(shotRoot, {recursive: true, mode: 0o700});
    const persist = async (state: any) => {
      const temp = stateFile + '.tmp';
      await fs.writeFile(temp, JSON.stringify(state, null, 2), {mode: 0o600});
      await fs.rename(temp, stateFile);
    };

    let state: any = null;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('step4_narration_state_unreadable'); }

    if (state) {
      if (state.credentialHash !== credentialHash) fail('step4_credential_changed');
      if (state.storyboardSha256 !== storyboardRead.sha256 || state.shotId !== shotId
        || state.voiceId !== voiceId || state.text !== text || state.engine !== engine)
        fail('step4_narration_state_storyboard_changed_no_new_submission');
    } else {
      const forecastCny = engine === 'orca'
        ? budget.speechUsdPerMillionChars * text.length / 1_000_000 * budget.fx.cnyPerUsd
        : 0.12 * (shot.durationSeconds + 3) / 60 * budget.fx.cnyPerUsd;
      assertCanReserve(budget, forecastCny);
      state = {
        schemaVersion: 1, mode: 'step4_explainer_narration', phase: 'prepared',
        requestId: `interview-step4-tts-${shotId}-${randomUUID()}`, credentialHash,
        storyboardSha256: storyboardRead.sha256, shotId, text, voiceId, engine,
        language: 'en', shotDurationSeconds: shot.durationSeconds,
        forecastCny, walletBefore: walletBeforeCheck.balance,
        paidSubmissions: 0, createdAt: now(),
      };
      await persist(state);
    }

    if (process.argv.includes('--prepare-only')) {
      if (state.phase !== 'prepared' || state.paidSubmissions !== 0)
        fail('step4_narration_prepare_only_requires_an_unsubmitted_prepared_state');
      console.log(JSON.stringify({
        status: 'prepared_no_provider_post', requestId: state.requestId, shotId, voiceId,
        engine, characters: text.length, forecastCny: Number(state.forecastCny.toFixed(6)),
        budgetCommittedCny: budget.chargedCny + budget.reservedCny, approvedCny: budget.approvedCny,
      }));
      return;
    }

    if (state.phase === 'failed') fail('step4_narration_previous_failure_no_resubmission');
    if (state.phase === 'rejected') fail('step4_narration_previous_rejection_no_resubmission');
    if (state.phase === 'submitting') fail('step4_narration_submission_unknown_reconcile_do_not_resubmit');
    if (state.phase === 'accepted') fail('step4_narration_accepted_audio_url_missing_do_not_resubmit');

    if (state.phase === 'prepared') {
      if (!process.argv.includes('--submit-approved-shot')) fail('step4_narration_explicit_submission_flag_required');
      reserve(budget, state.forecastCny);
      await persistBudget(BUDGET_FILE, budget);
      state.reservationActive = true;
      state.phase = 'submitting';
      state.request = {text, voice_id: voiceId, input_type: 'text', speed: 1, language: 'en',
        force_regenerate: false, engine};
      state.requestHash = sha(JSON.stringify(state.request));
      state.paidSubmissions = 1;
      state.submittedAt = now();
      await persist(state);
      let response: Response;
      try {
        response = await fetch('https://api.heygen.com/v3/voices/speech', {
          method: 'POST',
          headers: {'x-api-key': key, 'Content-Type': 'application/json'},
          body: JSON.stringify(state.request),
          redirect: 'error', signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        state.phase = 'submitting';
        state.lastError = scrub(error);
        await persist(state);
        throw error;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const knownRejection = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
        state.phase = knownRejection ? 'rejected' : 'submitting';
        state.httpStatus = response.status;
        state.lastError = scrub(payload?.error?.message || payload?.error?.code || `speech_http_${response.status}`);
        if (knownRejection && state.reservationActive) {
          release(budget, state.forecastCny);
          await persistBudget(BUDGET_FILE, budget);
          delete state.reservationActive;
        }
        await persist(state);
        fail(`step4_narration_provider_rejected_or_unknown_${response.status}`);
      }
      const data = payload?.data || payload;
      if (!data || typeof data.audio_url !== 'string' || !Number.isFinite(data.duration) || data.duration <= 0
        || !['orca', 'starfish'].includes(String(data.engine)))
        fail('step4_narration_provider_receipt_invalid');
      state.phase = 'accepted';
      state.provider = {
        engine: String(data.engine), requestId: data.request_id ?? null,
        audioUrlHost: new URL(safeAudioUrl(data.audio_url)).hostname,
        duration: Number(data.duration),
      };
      state.audioUrl = safeAudioUrl(data.audio_url);
      state.acceptedAt = now();
      await persist(state);
    }

    if (!state.audioUrl) fail('step4_narration_audio_url_missing_do_not_resubmit');
    const audioResponse = await fetch(state.audioUrl, {redirect: 'error', signal: AbortSignal.timeout(60_000)});
    if (!audioResponse.ok || !audioResponse.body) fail(`step4_narration_download_http_${audioResponse.status}`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = audioResponse.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_AUDIO_BYTES) { await reader.cancel(); fail('step4_narration_audio_too_large'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    await fs.writeFile(audioFile, bytes, {mode: 0o600});
    const probe = await probeAudio(audioFile);
    if (!(probe.duration > 0) || probe.duration > 20) fail('step4_narration_audio_duration_invalid');

    const walletAfter = await readWallet(key);
    const observedWalletDeltaUsd = state.walletBefore - walletAfter.balance;
    const observedWalletDeltaCny = observedWalletDeltaUsd * budget.fx.cnyPerUsd;
    const estimatedCostCny = state.engine === 'orca'
      ? budget.speechUsdPerMillionChars * text.length / 1_000_000 * budget.fx.cnyPerUsd
      : 0.12 * probe.duration / 60 * budget.fx.cnyPerUsd;
    const settled = settle(budget, {
      kind: 'explainer_speech', id: shotId, at: now(), requestedAt: state.submittedAt,
      forecastCny: state.forecastCny, estimatedCny: estimatedCostCny,
      observedDeltaCny: observedWalletDeltaCny, walletBefore: state.walletBefore,
      walletAfter: walletAfter.balance, providerRef: state.provider?.requestId ?? null,
    });
    await persistBudget(BUDGET_FILE, budget);
    delete state.reservationActive;

    state.phase = 'downloaded';
    state.audioBytes = bytes.length;
    state.audioSha256 = sha(bytes);
    state.audioProbe = probe;
    state.estimatedCostCny = estimatedCostCny;
    state.observedWalletDeltaUsd = observedWalletDeltaUsd;
    state.observedWalletDeltaCny = observedWalletDeltaCny;
    state.chargedCny = settled.chargedCny;
    state.walletAfter = walletAfter.balance;
    state.withinApprovedCap = budget.chargedCny <= budget.approvedCny;
    state.completedAt = now();
    await persist(state);

    await fs.copyFile(audioFile, path.join(EVIDENCE_DIR, `step4-narration-${shotId}.mp3`));
    const sanitized = {
      schemaVersion: 1, mode: state.mode, phase: state.phase,
      requestId: state.requestId, requestHash: state.requestHash, request: state.request,
      shotId: state.shotId, text: state.text, voiceId: state.voiceId, engine: state.engine,
      language: state.language, storyboardSha256: state.storyboardSha256,
      provider: state.provider, providerDuration: state.provider?.duration,
      audioBytes: state.audioBytes, audioSha256: state.audioSha256, audioProbe: state.audioProbe,
      approvedCny: budget.approvedCny, forecastCny: state.forecastCny,
      estimatedCostCny: state.estimatedCostCny, chargedCny: state.chargedCny,
      walletBefore: state.walletBefore, walletAfter: state.walletAfter,
      observedWalletDeltaUsd: state.observedWalletDeltaUsd,
      observedWalletDeltaCny: state.observedWalletDeltaCny,
      withinApprovedCap: state.withinApprovedCap, paidSubmissions: state.paidSubmissions,
      createdAt: state.createdAt, submittedAt: state.submittedAt,
      acceptedAt: state.acceptedAt, completedAt: state.completedAt,
      note: 'Step 4 explainer narration via the public voice. Audio only; the visual is an original local illustration.',
    };
    await fs.writeFile(path.join(EVIDENCE_DIR, `step4-narration-${shotId}.json`), JSON.stringify(sanitized, null, 2), {mode: 0o600});
    console.log(JSON.stringify({
      status: 'downloaded', shotId, engine: state.engine, providerDuration: state.provider?.duration,
      audioBytes: state.audioBytes, audioSha256: state.audioSha256, audioProbe: state.audioProbe,
      estimatedCostCny: Number(state.estimatedCostCny.toFixed(6)), chargedCny: state.chargedCny,
      walletBefore: state.walletBefore, walletAfter: state.walletAfter,
      budgetCommittedCny: budget.chargedCny + budget.reservedCny, approvedCny: budget.approvedCny,
      paidSubmissions: state.paidSubmissions,
      evidence: {audio: `evidence/step4-narration-${shotId}.mp3`, json: `evidence/step4-narration-${shotId}.json`},
    }));
  } finally {
    if (lock) {
      await lock.close();
      await fs.rm(RUN_LOCK, {force: true});
    }
  }
}

main().catch(error => {
  console.error(scrub(error));
  process.exitCode = 1;
});
