import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { withPaidOperationLock } from './paidOperationLock.js';
import { studioVoicePaidContext, submitStudioVoicePaidRequest, type StudioVoicePaidRequest } from './studioVoicePaidOperation.js';

/** Exact bound voice only; provider errors never reach a generic TTS fallback. */
export async function synthesizeBoundHeyGenVoice(input: { text: string; voiceId: string; language: string; output: string }, ports: { fetch?: typeof fetch; root?: string; key?: string } = {}) {
  const key = ports.key || process.env.HEYGEN_API_KEY?.trim();
  const context = studioVoicePaidContext();
  if (!key || !input.voiceId || !input.text.trim() || !context || context.primaryProvider !== 'heygen') throw Error('selected_presenter_voice_paid_route_required:'+(!key?'credential_missing':!context?'context_missing':context.primaryProvider!=='heygen'?'provider_mismatch':'input_missing'));
  const transport = ports.fetch || fetch;
  const endpoint = 'https://api.heygen.com/v3/voices/speech';
  const body = { text: input.text, voice_id: input.voiceId, engine: 'starfish', language: input.language, speed: 1, input_type: 'text', force_regenerate: false };
  const request: StudioVoicePaidRequest = { stage: 'tts', provider: 'heygen', model: 'starfish', voiceId: input.voiceId, endpoint, accountKeyHash: createHash('sha256').update(key).digest('hex'), request: body };
  const call = await context.forRequest(request);
  request.audioSeconds = call.intent.maximumUnits.audioSeconds;
  if (!(request.audioSeconds! > 0)) throw Error('selected_presenter_voice_duration_budget_required');
  await call.assertProviderBinding(request);
  const root = path.resolve(ports.root || 'data/social-content-bound-voice');
  const id = createHash('sha256').update(JSON.stringify({ operationId: call.intent.operationId, body, accountKeyHash: request.accountKeyHash })).digest('hex');
  const stateFile = path.join(root, id + '.json');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return withPaidOperationLock(path.join(root, '.locks'), id, async () => {
    let state: any;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('selected_presenter_voice_receipt_corrupt_no_repost'); }
    const persist = async (value: unknown) => { const temp = stateFile + '.tmp'; const file = await fs.open(temp, 'w', 0o600); try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); } await fs.rename(temp, stateFile); const directory = await fs.open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); } };
    if (state && (state.voiceId !== input.voiceId || state.operationId !== call.intent.operationId || JSON.stringify(state.body) !== JSON.stringify(body))) throw Error('selected_presenter_voice_receipt_changed');
    if (state?.status === 'submitting') throw Error('selected_presenter_voice_submission_unknown_no_repost');
    if (!state) {
      // Official engine-filtered inventory proves this exact voice is supported.
      let token = ''; let supported = false;
      for (let page = 0; page < 20; page++) {
        const response = await transport('https://api.heygen.com/v3/voices?type=private&engine=starfish&limit=100' + (token ? '&token=' + encodeURIComponent(token) : ''), { headers: { 'x-api-key': key }, redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw Error('selected_presenter_voice_inventory_unavailable');
        const catalog = await response.json();
        if (catalog.data?.some((v: any) => v.voice_id === input.voiceId)) { supported = true; break; }
        if (!catalog.has_more || !catalog.next_token) break;
        token = catalog.next_token;
      }
      if (!supported) throw Error('selected_presenter_bound_voice_engine_unavailable');
      state = { status: 'submitting', voiceId: input.voiceId, body, operationId: call.intent.operationId };
      await persist(state);
      const response = await submitStudioVoicePaidRequest(request, async () => {
        const r = await transport(endpoint, { method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Idempotency-Key': call.intent.operationId }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw Error('selected_presenter_voice_provider_rejected:' + r.status);
        const raw = await r.json(); const result = raw.data || raw;
        if (!result.audio_url || result.engine !== 'starfish' || !Number.isFinite(result.duration) || result.duration <= 0) throw Error('selected_presenter_voice_provider_evidence_invalid');
        await persist({ ...state, status: 'accepted', response: raw });
        return raw;
      });
      state = { ...state, status: 'accepted', response };
    }
    await call.permit.assertRecovery(call.intent.operationId);
    const result = state.response?.data || state.response;
    if (state.status !== 'accepted' || result?.engine !== 'starfish' || !result.audio_url || !Number.isFinite(result.duration) || result.duration <= 0) throw Error('selected_presenter_voice_provider_evidence_invalid');
    // Restore the canonical proof and in-memory cache-proof binding after a
    // crash between supplier acceptance and local receipt completion. No POST.
    const receipt = await call.persistProviderReceipt({requestSha256:createHash('sha256').update(JSON.stringify(body)).digest('hex'),response:state.response,audioSeconds:request.audioSeconds});
    if (!receipt) throw Error('selected_presenter_voice_original_receipt_missing');
    await call.permit.markOutcome(call.intent.operationId, 'completed', receipt);
    const url = new URL(String(result?.audio_url || ''));
    if (url.protocol !== 'https:' || !/(^|\.)heygen\.(ai|com)$/.test(url.hostname)) throw Error('selected_presenter_voice_audio_url_invalid');
    const mp3 = path.join(root, id + '.mp3'), wav = path.join(root, id + '.wav');
    try { await fs.access(wav); } catch {
      const r = await transport(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw Error('selected_presenter_voice_audio_download_failed');
      await fs.writeFile(mp3, new Uint8Array(await r.arrayBuffer()), { mode: 0o600 });
      await promisify(execFile)(ffmpeg || 'ffmpeg', ['-y', '-i', mp3, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeout: 30000 });
    }
    const bytes = await fs.readFile(wav);
    if (bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WAVE') throw Error('selected_presenter_voice_audio_invalid');
    let dataBytes = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + size > bytes.length) throw Error('selected_presenter_voice_audio_invalid');
      if (bytes.toString('ascii',offset,offset+4) === 'data') dataBytes += size;
      offset += 8 + size + (size % 2);
    }
    const duration = dataBytes / 48000;
    const audioSha256 = createHash('sha256').update(bytes).digest('hex');
    if (state.audioSha256 && state.audioSha256 !== audioSha256) throw Error('selected_presenter_voice_cached_audio_changed');
    if (!state.audioSha256) await persist({ ...state, audioSha256 });
    if (!(duration > 0) || duration > request.audioSeconds! || !Number.isFinite(result.duration) || result.duration > request.audioSeconds!) throw Error('selected_presenter_voice_audio_invalid');
    await fs.mkdir(path.dirname(input.output), { recursive: true });
    await fs.copyFile(wav, input.output);
    return { duration, voiceId: input.voiceId };
  });
}
