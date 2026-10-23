import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { speechText, validateSpeechCues } from '../../src/lib/narrationAlignment.js';
import type { SubCue } from '../../src/lib/studioApi.js';
import { withPaidOperationLock } from './paidOperationLock.js';
import { studioPaidBudget } from './studioPaidBudget.js';

export const ASR_MODEL = 'qwen3-asr-flash-filetrans';
export interface QwenMeasuredWord {
  text: string;
  start: number;
  end: number;
  /** Zero-duration unstressed words remain measured points, never padded. */
  timingPrecision: 'word' | 'point';
  confidence?: number;
}
export interface QwenMeasuredSentence {
  text: string;
  start: number;
  end: number;
  words: QwenMeasuredWord[];
  timingPrecision: 'phrase';
  provenance: 'qwen_filetrans:measured_words';
  confidence?: number;
}
const measuredText = (value: any) => {
  const text = String(value?.text || '');
  const punctuation = String(value?.punctuation || '');
  return punctuation && !text.trimEnd().endsWith(punctuation) ? text + punctuation : text;
};
const measuredConfidence = (value: unknown): { confidence?: number } =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? { confidence: value } : {};

/** Parse only provider-measured words. Sentence timestamps cannot stand in for words. */
export function qwenMeasuredWordTimeline(raw: any, duration: number): {
  text: string; words: QwenMeasuredWord[]; segments: QwenMeasuredSentence[]; warnings: string[];
} {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('音频时长无效');
  if (!Array.isArray(raw?.transcripts) || raw.transcripts.length !== 1) throw new Error('需要单声道转写结果');
  const transcript = raw.transcripts[0];
  if (!Array.isArray(transcript?.sentences) || !transcript.sentences.length) throw new Error('千问未返回真实字词时间戳');
  const words: QwenMeasuredWord[] = [];
  const segments: QwenMeasuredSentence[] = [];
  const warnings: string[] = [];
  let previousEnd = 0;
  let previousStart = 0;
  for (const sentence of transcript.sentences) {
    if (!Array.isArray(sentence.words) || !sentence.words.length) throw new Error('千问未返回真实字词时间戳');
    const sentenceWords: QwenMeasuredWord[] = sentence.words.map((word: any) => {
      // Do not coerce null/missing/string timestamps into measured zeroes.
      if (typeof word?.begin_time !== 'number' || typeof word?.end_time !== 'number') throw new Error('千问字词时间戳无效');
      const start = word.begin_time / 1000;
      const end = word.end_time / 1000;
      const text = measuredText(word);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !speechText(text)
        || start < 0 || start < previousStart || start < previousEnd - 0.03 || end < start || end > duration + 0.03) {
        throw new Error('千问字词时间戳越界或顺序无效');
      }
      previousStart = start;
      previousEnd = Math.max(previousEnd, end);
      if (start === end) warnings.push('provider_zero_duration_word');
      return { text, start, end, timingPrecision: start === end ? 'point' : 'word', ...measuredConfidence(word.confidence) };
    });
    const text = measuredText(sentence) || sentenceWords.map(word => word.text).join(' ');
    if (speechText(sentenceWords.map(word => word.text).join('')) !== speechText(text)) throw new Error('千问句子与字词文本不一致');
    const start = sentenceWords[0].start;
    const end = sentenceWords.at(-1)!.end;
    if (end <= start) throw new Error('千问未返回具有时长的口播句子');
    segments.push({ text, start, end, words: sentenceWords, timingPrecision: 'phrase', provenance: 'qwen_filetrans:measured_words', ...measuredConfidence(sentence.confidence) });
    words.push(...sentenceWords);
  }
  const text = String(transcript.text || segments.map(segment => segment.text).join(' '));
  if (speechText(words.map(word => word.text).join('')) !== speechText(text)) throw new Error('千问全文与字词文本不一致');
  return { text, words, segments, warnings: [...new Set(warnings)] };
}
export function qwenAsrCues(raw: any, duration: number, expected = ''): { text: string; cues: SubCue[]; matches: boolean } {
  if (raw?.transcripts?.length !== 1) throw new Error('需要单声道转写结果');
  const transcript = raw.transcripts[0];
  const words: SubCue[] = (transcript.sentences || []).flatMap((s: any) => (s.words || []).map((w: any) => ({ text: String(w.text || '') + String(w.punctuation || ''), start: w.begin_time / 1000, end: w.end_time / 1000 })));
  if (!validateSpeechCues(words, transcript.text, duration)) throw new Error('千问未返回有效字词时间戳，不能作为精确对齐');
  const matches = !expected || speechText(expected) === speechText(transcript.text);
  const lines = (matches && expected ? expected : transcript.text).match(/[^。！？!?\n]+[。！？!?]?/g) || [transcript.text];
  let cursor = 0;
  const cues = lines.filter((line: string) => speechText(line)).map((line: string) => {
    const selected: SubCue[] = []; let actual = '';
    while (cursor < words.length && actual.length < speechText(line).length) { const word = words[cursor++]; selected.push(word); actual += speechText(word.text); }
    if (actual !== speechText(line)) throw new Error('台词边界跨越识别词，请人工核验');
    return { text: line.trim(), start: selected[0].start, end: selected.at(-1)!.end, words: selected };
  });
  if (cursor !== words.length) throw new Error('存在未匹配识别词');
  return { text: transcript.text, cues, matches };
}

export type QwenAsrRecord = { id: string; sourceSha256: string; model: string; status: string; providerEndpoint?: string; taskId?: string; raw?: any; usage?: any; error?: string };
type RecordData = QwenAsrRecord;
export class QwenAsrService {
  private locks = new Map<string, Promise<RecordData>>();
  constructor(private root: string, private request: typeof fetch = fetch, private reserve: (id: string, tenant?: string) => Promise<void> = (id, tenant) => studioPaidBudget.reserve('qwen_asr', id, undefined, tenant), private options: { automaticSubmission?: boolean; signal?: AbortSignal; onRecord?:(record:QwenAsrRecord)=>Promise<void> } = {}) {}
  async run(tenant: string, bytes: Buffer, mimeType: string, confirmed = false): Promise<RecordData> {
    if (!/^[\w-]{1,128}$/.test(tenant)) throw new Error('企业身份无效');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('转写音频需小于20MB');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const key = `${tenant}:${hash}`;
    const active = this.locks.get(key); if (active) return active;
    const promise = withPaidOperationLock(path.join(this.root, '.locks'), key, () => this.perform(tenant, hash, bytes, mimeType, confirmed));
    this.locks.set(key, promise);
    try { return await promise; } finally { this.locks.delete(key); }
  }
  async pollExisting(tenant:string,audioSha:string,taskId:string):Promise<QwenAsrRecord> {
    if(!/^[\w-]{1,128}$/.test(tenant)||!/^[a-f0-9]{64}$/.test(audioSha)||!taskId)throw new Error('原转写任务身份无效');
    return withPaidOperationLock(path.join(this.root,'.locks'),`${tenant}:${audioSha}`,async()=>{
      const file=path.join(this.root,tenant,`${audioSha}.json`);
      if(!fs.existsSync(file))throw new Error('原转写任务记录缺失');
      const record:QwenAsrRecord=JSON.parse(fs.readFileSync(file,'utf8'));
      if(record.id!==audioSha||record.sourceSha256!==audioSha||record.model!==ASR_MODEL||record.taskId!==taskId||!record.providerEndpoint||record.providerEndpoint!==(process.env.QWEN_ASR_BASE_URL||'https://dashscope.aliyuncs.com/api/v1'))throw new Error('原转写任务身份或地域已变化');
      if(['uncertain','submitting','needs_confirmation'].includes(record.status))throw new Error('原提交状态未知，不能重新提交');
      return this.perform(tenant,audioSha,Buffer.alloc(0),'audio/wav',false,true);
    });
  }
  private async perform(tenant: string, hash: string, bytes: Buffer, mime: string, confirmed: boolean, existingOnly=false): Promise<RecordData> {
    const dir = path.join(this.root, tenant); const file = path.join(dir, `${hash}.json`);
    let record: RecordData = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id: hash, sourceSha256: hash, model: ASR_MODEL, status: 'needs_confirmation' };
    if (record.sourceSha256 !== hash || record.model !== ASR_MODEL) throw new Error('转写缓存不匹配');
    if (['SUCCEEDED', 'FAILED', 'uncertain', 'submitting'].includes(record.status)) return record;
    if(existingOnly&&!record.taskId)throw new Error('原转写任务ID缺失');
    if (!record.taskId && !confirmed) return record;
    const save = async () => { fs.mkdirSync(dir, { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 }); fs.renameSync(temp, file); await this.options.onRecord?.({...record}); };
    const endpoint = process.env.QWEN_ASR_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
    if (!['https://dashscope.aliyuncs.com/api/v1', 'https://dashscope-intl.aliyuncs.com/api/v1'].includes(endpoint)) throw new Error('ASR地域端点不在许可列表');
    if(record.providerEndpoint&&record.providerEndpoint!==endpoint)throw new Error('原转写地域已变化');
    record.providerEndpoint=endpoint;
    let apiKey = process.env.DASHSCOPE_API_KEY?.trim() || '';
    if (!apiKey) { try { apiKey = fs.readFileSync(process.env.DASHSCOPE_API_KEY_FILE || path.join(os.homedir(), '.config/lingshu/dashscope.key'), 'utf8').trim(); } catch {} }
    if (!apiKey) throw new Error('未配置 DashScope 密钥');
    const json = async (url: string, init: RequestInit = {}) => {
      const timeout = AbortSignal.timeout(20000);
      const response = await this.request(url, { ...init, signal: this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout });
      if (!response.ok) throw new Error(`千问ASR HTTP ${response.status}`);
      return response.json();
    };
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    if (!record.taskId) {
      if (!this.options.automaticSubmission && process.env.QWEN_ASR_GENERATION_ENABLED !== 'true') throw new Error('付费转写尚未启用；已有缓存仍可使用');
      await this.reserve(`${tenant}:${hash}`, tenant);
      record.status = 'submitting'; await save(); // Persist before any external operation; never auto-resubmit after crash.
      try {
        const { data: policy } = await json(`${endpoint}/uploads?action=getPolicy&model=${ASR_MODEL}`, { headers });
        const host = new URL(policy.upload_host);
        if (host.protocol !== 'https:' || !host.hostname.endsWith('.aliyuncs.com')) throw new Error('上传地址不安全');
        const extension = ({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/aac': 'aac' } as Record<string, string>)[mime];
        if (!extension) throw new Error('不支持此音频格式');
        const objectKey = `${policy.upload_dir}/${hash}.${extension}`; const form = new FormData();
        for (const [key, value] of Object.entries({ OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy, 'x-oss-object-acl': policy.x_oss_object_acl, 'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite, key: objectKey, success_action_status: '200' })) form.append(key, String(value));
        form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), `${hash}.${extension}`);
        const uploadTimeout = AbortSignal.timeout(20000);
        const upload = await this.request(host.href, { method: 'POST', body: form, signal: this.options.signal ? AbortSignal.any([this.options.signal, uploadTimeout]) : uploadTimeout });
        if (!upload.ok) throw new Error(`音频上传 HTTP ${upload.status}`);
        const submitted = await json(`${endpoint}/services/audio/asr/transcription`, { method: 'POST', headers: { ...headers, 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' }, body: JSON.stringify({ model: ASR_MODEL, input: { file_url: `oss://${objectKey}` }, parameters: { channel_id: [0], enable_words: true, enable_itn: false } }) });
        if (!submitted.output?.task_id) throw new Error('未返回任务ID，禁止自动重试');
        record = { ...record, taskId: submitted.output.task_id, status: 'PENDING' }; await save(); return record;
      } catch (error) { record.status = 'uncertain'; record.error = error instanceof Error ? error.message : '提交状态未知'; await save(); return record; }
    }
    const result = await json(`${endpoint}/tasks/${encodeURIComponent(record.taskId)}`, { headers });
    if (result.output?.task_status === 'SUCCEEDED') {
      const url = new URL(result.output.result?.transcription_url);
      if (!url.hostname.endsWith('.aliyuncs.com') || !['http:', 'https:'].includes(url.protocol)) throw new Error('转写结果地址不安全');
      url.protocol = 'https:';
      const raw = await json(url.href);
      record.raw = { audio_info: raw.audio_info, transcripts: raw.transcripts }; record.usage = result.usage;
    }
    record.status = result.output?.task_status || 'PENDING';
    if (record.status === 'FAILED') record.error = '千问转写任务失败；请核对供应商任务，不自动重新扣费';
    await save(); return record;
  }
}

/** Internal reference-analysis path: one durable paid task per tenant/audio hash.
 * The product's automatic analysis is the authorization; studio's separate
 * confirmation and budget behavior remains unchanged. Failed/uncertain tasks
 * are never silently resubmitted. Provider timestamps are not frame accuracy.
 */
export async function transcribeWordAudioWithQwen(input: {
  tenant: string; audio: Buffer; mimeType: string; duration: number; cacheRoot?: string;
  signal?: AbortSignal; timeoutMs?: number; pollIntervalMs?: number;
  request?: typeof fetch; reserve?: (id: string) => Promise<void>; automaticSubmission?: boolean; onRecord?:(record:QwenAsrRecord)=>Promise<void>;
}) {
  if (!Number.isFinite(input.duration) || input.duration <= 0) throw new Error('音频时长无效');
  const service = new QwenAsrService(input.cacheRoot || path.resolve('data/analysis-output/qwen-word-asr-v1'), input.request || fetch, input.reserve || (async () => {}), { automaticSubmission: input.automaticSubmission ?? true, signal: input.signal, onRecord: input.onRecord });
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  let record: QwenAsrRecord;
  while (true) {
    input.signal?.throwIfAborted();
    record = await service.run(input.tenant, input.audio, input.mimeType, true);
    if (record.status === 'SUCCEEDED') break;
    if (['FAILED', 'uncertain', 'submitting'].includes(record.status)) throw new Error(`千问词级对齐${record.status}: ${record.error || '任务状态待核对；不会重新提交扣费'}`);
    if (Date.now() >= deadline) throw new Error(`千问词级对齐仍在处理，任务 ${record.taskId || 'unknown'}；下次从缓存继续，不重新提交`);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(input.signal?.reason || new Error('音频对齐已取消')); };
      const timer = setTimeout(() => { input.signal?.removeEventListener('abort', abort); resolve(); }, Math.min(input.pollIntervalMs ?? 1_500, Math.max(1, deadline - Date.now())));
      input.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  return { ...qwenMeasuredWordTimeline(record.raw, input.duration),
    alignmentStatus: 'aligned' as const, provider: 'qwen' as const, model: record.model,
    timingPrecision: 'word' as const, provenance: 'qwen_filetrans:measured_words' as const,
    sourceSha256: record.sourceSha256, taskId: record.taskId!, usage: record.usage,
    timestampResolutionMs: 1, accuracyMs: null, confidence: null,
  };
}
