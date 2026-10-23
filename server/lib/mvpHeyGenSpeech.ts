import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withPaidOperationLock } from './paidOperationLock.js';
import { mvpBudgetAdmission, type MvpBudgetAdmission } from './mvpBudgetAdmission.js';
import { studioPaidBudget, type StudioPaidBudget } from './studioPaidBudget.js';
import type { MvpExecutionScope } from '../../shared/mvpExecutionScope.js';
const hash = (x: string | Uint8Array) => createHash('sha256').update(x).digest('hex');
const defaultRoot = () => path.resolve('data/mvp-heygen-speech');
export interface MvpHeyGenSpeechInput {
  scope: MvpExecutionScope; shotId: string; operationRole: 'hook' | 'body'; voiceId: string; text: string;
  maxDurationSeconds: number; reservationCny: number;
}
export interface MvpHeyGenSpeechResult {
  receiptRef: string; receiptHash: string; tenantId: string; taskId: string; taskVersion: number; accountId: string | null;
  runId: string; shotId: string; operationRole: 'hook' | 'body'; maxDurationSeconds: number; voiceId: string; scriptSha256: string; clipSha256: string;
  durationSeconds: number; filePath: string; providerRequestId: string | null; providerEvidenceSha256?: string;
  usage: { reportedDurationSeconds: number; actualCostCny: null };
}
interface Receipt { schemaVersion: 1; fingerprint: string; input: MvpHeyGenSpeechInput;
  state: 'prepared' | 'unknown' | 'accepted' | 'completed';
  provider?: { requestId: string | null; audioUrl: string; duration: number; engine: 'starfish'; responseEvidence: unknown };
  failure?: { httpStatus: number; code: string | null; message: string | null };
  result?: MvpHeyGenSpeechResult;
}
export interface MvpHeyGenSpeechPorts {
  apiKey: string; root?: string; fetch?: typeof fetch;
  /** Reload task/run/person/voice/version from authoritative server records; throw on drift. */
  assertCurrentScope: (input: MvpHeyGenSpeechInput) => Promise<void>;
  admission?: Pick<MvpBudgetAdmission, 'reserve'>; legacyBudget?: Pick<StudioPaidBudget, 'reserve'>;
  probe?: (filePath: string) => Promise<number>;
  /** Server command only: an explicitly authorized original-voice compatibility probe, not verified metadata. */
  authorizedOriginalVoiceProbe?: { authorizationRef: string; voiceId: string };
}
export function mvpHeyGenSpeechFingerprint(input: MvpHeyGenSpeechInput) {
  return hash(JSON.stringify({ scope: input.scope, shotId: input.shotId, voiceId: input.voiceId,
    text: input.text, operationRole:input.operationRole, maxDurationSeconds: input.maxDurationSeconds, reservationCny: input.reservationCny,
    engine: 'starfish', input_type: 'text', speed: 1, language: 'en', force_regenerate: false }));
}
function readReceipt(id: string, root: string): Receipt {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('speech_receipt_invalid');
  const x = JSON.parse(fs.readFileSync(path.join(root, `${id}.json`), 'utf8')) as Receipt;
  if (x.schemaVersion !== 1 || x.fingerprint !== id || mvpHeyGenSpeechFingerprint(x.input) !== id
    || !['prepared','unknown','accepted','completed'].includes(x.state)) throw Error('speech_receipt_corrupt');
  return x;
}
function resultHash(result: Omit<MvpHeyGenSpeechResult, 'receiptHash'>) { return hash(JSON.stringify(result)); }
export function readMvpHeyGenSpeech(receiptRef: string, root = defaultRoot()): MvpHeyGenSpeechResult {
  const row = readReceipt(receiptRef, root); const r = row.result;
  if (row.state !== 'completed' || !r) throw Error('speech_receipt_not_completed');
  const { receiptHash, ...body } = r;
  const expectedPath = path.join(path.resolve(root), 'audio', hash(r.tenantId), `${receiptRef}.mp3`);
  if (!row.provider || r.tenantId !== row.input.scope.tenantId || r.taskId !== row.input.scope.taskId
    || r.accountId !== row.input.scope.accountId || r.accountId === undefined || r.taskVersion !== row.input.scope.version || r.runId !== row.input.scope.runId
    || r.shotId !== row.input.shotId || r.voiceId !== row.input.voiceId || r.operationRole !== row.input.operationRole
    || r.scriptSha256 !== hash(row.input.text) || r.maxDurationSeconds !== row.input.maxDurationSeconds
    || !r.providerEvidenceSha256 || r.providerEvidenceSha256 !== hash(JSON.stringify(row.provider.responseEvidence))
    || r.providerRequestId !== row.provider.requestId || r.usage.reportedDurationSeconds !== row.provider.duration
    || r.usage.actualCostCny !== null || r.receiptRef !== receiptRef || path.resolve(r.filePath) !== expectedPath || resultHash(body) !== receiptHash
    || hash(fs.readFileSync(r.filePath)) !== r.clipSha256 || !Number.isFinite(r.durationSeconds)
    || r.durationSeconds <= 0 || r.durationSeconds > row.input.maxDurationSeconds) throw Error('speech_audio_corrupt');
  return r;
}
export function readMvpHeyGenSpeechProviderEvidence(receiptRef: string, root = defaultRoot()): unknown {
  readMvpHeyGenSpeech(receiptRef, root);
  return readReceipt(receiptRef, root).provider!.responseEvidence;
}
async function probeAudio(filePath: string) {
  const { stderr } = await promisify(execFile)(process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg', ['-v','info','-i',filePath,'-vn','-f','null','-'], { maxBuffer: 4_000_000 });
  const m = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m || !/Audio:/.test(stderr)) throw Error('speech_audio_probe_failed');
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
/** No HTTP request/body authorization path. Call only with a server-recorded scope.
 * Shared-volume crash locks and unknown receipts deliberately require reconciliation. */
export async function generateMvpHeyGenSpeech(input: MvpHeyGenSpeechInput, ports: MvpHeyGenSpeechPorts): Promise<MvpHeyGenSpeechResult> {
  if (!input.scope || input.scope.provider !== 'heygen' || input.scope.model !== 'starfish'
    || !['hook','body'].includes(input.operationRole) || !input.text.trim() || input.text.length > 2000 || !input.voiceId.trim() || !ports.apiKey.trim()
    || !Number.isFinite(input.maxDurationSeconds) || input.maxDurationSeconds <= 0 || input.maxDurationSeconds > (input.operationRole === 'hook' ? 4 : 20)
    || !Number.isFinite(input.reservationCny) || input.reservationCny <= 0) throw Error('speech_input_invalid');
  const id = mvpHeyGenSpeechFingerprint(input), root = path.resolve(ports.root || defaultRoot());
  const request = ports.fetch || fetch; const headers = { 'X-Api-Key': ports.apiKey };
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return withPaidOperationLock(path.join(root, '.locks'), id, async () => {
    await ports.assertCurrentScope(input);
    const file = path.join(root, `${id}.json`);
    const write = (row: Receipt) => { const temp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(row), { mode: 0o600 }); fs.renameSync(temp, file); };
    let row: Receipt | undefined = fs.existsSync(file) ? readReceipt(id, root) : undefined;
    if (row?.state === 'completed') return readMvpHeyGenSpeech(id, root);
    if (row && ['prepared','unknown'].includes(row.state)) throw Error('provider_submission_unknown:heygen_speech');
    if (!row) {
      // Explicit engine membership is required; default voice engines are not evidence.
      let token: string | undefined; let compatible = false;
      for (let page = 0; page < 1; page++) {
        const url = new URL('https://api.heygen.com/v3/voices');
        url.search = new URLSearchParams({ engine:'starfish',language:'English',limit:'100', ...(token ? { token } : {}) }).toString();
        const response = await request(url, { headers, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw Error('speech_voice_compatibility_unverified');
        const payload = await response.json(); const data = Array.isArray(payload.data) ? payload : payload.data;
        const voices = Array.isArray(data?.data) ? data.data : [];
        const voice = voices.find((v: { voice_id?: string }) => v.voice_id === input.voiceId);
        if (voice && Array.isArray(voice.available_engines) && voice.available_engines.includes('starfish')) { compatible = true; break; }
        if (!data?.has_more) break;
        if (!data.next_token || token === data.next_token) throw Error('speech_voice_pagination_invalid');
        token = data.next_token;
      }
      if (!compatible && (ports.authorizedOriginalVoiceProbe?.authorizationRef !== input.scope.authorizationRef
        || ports.authorizedOriginalVoiceProbe.voiceId !== input.voiceId)) throw Error('speech_voice_starfish_not_verified');
      const s = input.scope;
      await (ports.admission || mvpBudgetAdmission).reserve({ scope:s,tenantId:s.tenantId,taskId:s.taskId,version:s.version,
        session:s.session,accountId:s.accountId,productId:s.productId,runId:s.runId,action:'generate_media',
        provider:'heygen',model:'starfish',shotId:input.shotId,estimatedCostCny:input.reservationCny,operationId:`mvp-tts:${id}`,fingerprint:id });
      await (ports.legacyBudget || studioPaidBudget).reserve('heygen', `mvp-tts:${id}`, input.reservationCny, input.scope.tenantId);
      await ports.assertCurrentScope(input);
      row = { schemaVersion:1,fingerprint:id,input,state:'prepared' }; write(row);
      try {
        const response = await request('https://api.heygen.com/v3/voices/speech', { method:'POST',headers:{ ...headers,'Content-Type':'application/json' },
          body:JSON.stringify({ text:input.text,voice_id:input.voiceId,input_type:'text',speed:1,language:'en',force_regenerate:false,engine:'starfish' }), signal:AbortSignal.timeout(60_000) });
        if (!response.ok) {
          const rejection = await response.json().catch(() => ({}));
          const error = rejection.error || rejection;
          row.failure = { httpStatus:response.status,code:typeof error.code === 'string' ? error.code.slice(0,180) : null,
            message:typeof error.message === 'string' ? error.message.slice(0,500) : null };
          throw Error('speech_provider_rejected_or_unknown');
        }
        const x = await response.json();
        if (JSON.stringify(x).length > 256_000) throw Error('speech_provider_receipt_oversized');
        const p = x.data || x;
        if (p.engine !== 'starfish' || (p.request_id != null && (typeof p.request_id !== 'string' || !p.request_id)) || typeof p.audio_url !== 'string'
          || !Number.isFinite(p.duration) || p.duration <= 0) throw Error('speech_provider_receipt_invalid');
        row.provider = { requestId:p.request_id ?? null,audioUrl:p.audio_url,duration:p.duration,engine:'starfish',responseEvidence:x }; row.state='accepted'; write(row);
      } catch (error) { row.state='unknown'; write(row); throw error; }
    }
    if (!row.provider) throw Error('speech_provider_receipt_missing');
    const url = new URL(row.provider.audioUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)heygen\.(ai|com)$/.test(url.hostname)) throw Error('speech_audio_origin_invalid');
    const response = await request(url, { redirect:'error',signal:AbortSignal.timeout(60_000) });
    if (!response.ok) throw Error('speech_audio_download_failed');
    const bytes = new Uint8Array(await response.arrayBuffer()); if (!bytes.length || bytes.length > 20_000_000) throw Error('speech_audio_size_invalid');
    const dir = path.join(root,'audio',hash(input.scope.tenantId)); fs.mkdirSync(dir,{ recursive:true,mode:0o700 });
    const filePath = path.join(dir,`${id}.mp3`); const temp = `${filePath}.${randomUUID()}.tmp`; fs.writeFileSync(temp,bytes,{ mode:0o600 }); fs.renameSync(temp,filePath);
    const durationSeconds = await (ports.probe || probeAudio)(filePath);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > input.maxDurationSeconds) throw Error('speech_audio_duration_exceeded');
    const body = { receiptRef:id,tenantId:input.scope.tenantId,taskId:input.scope.taskId,taskVersion:input.scope.version,accountId:input.scope.accountId,
      runId:input.scope.runId,shotId:input.shotId,operationRole:input.operationRole,maxDurationSeconds:input.maxDurationSeconds,voiceId:input.voiceId,scriptSha256:hash(input.text),clipSha256:hash(bytes),durationSeconds,
      filePath,providerRequestId:row.provider.requestId,providerEvidenceSha256:hash(JSON.stringify(row.provider.responseEvidence)),usage:{ reportedDurationSeconds:row.provider.duration,actualCostCny:null } };
    row.result = { ...body,receiptHash:resultHash(body) }; row.state='completed'; write(row); return row.result;
  });
}
