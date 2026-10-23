import {saveReferenceNarrationBinding} from './referenceNarrationRecovery.js';
export {readExistingReferenceNarration,resumeExistingReferenceNarration} from './referenceNarrationRecovery.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { transcribeWordAudioWithQwen } from './qwenAsr.js';
import { type TimedCue } from '../integrations/qwenAlignment.js';
import { studioPaidBudget } from './studioPaidBudget.js';
import { withPaidOperationLock } from './paidOperationLock.js';
const execute = promisify(execFile);
import {REFERENCE_AUDIO_CLOCK_POLICY} from './referenceNarrationClockPolicy.js';
export {REFERENCE_AUDIO_CLOCK_POLICY} from './referenceNarrationClockPolicy.js';

/** Normalize the same media origin used by video seeking. Pad/trim only the
 * initial audio PTS; async=0 forbids ongoing stretching or gap compensation.
 * A discontinuous source clock is rejected before any paid ASR operation.
 */
export async function extractReferenceSourceAudio(filePath: string, audioPath: string,
  options: { signal?: AbortSignal } = {}) {
  const { stderr } = await execute(ffmpeg || 'ffmpeg', ['-hide_banner','-loglevel','info','-nostdin','-y',
    '-copyts','-start_at_zero','-i',filePath,'-map','0:a:0','-vn',
    '-af','ashowinfo,aresample=16000:async=0:first_pts=0',
    '-ac','1','-ar','16000','-c:a','pcm_s16le',audioPath],
  { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) });
  const sourceMediaStartSeconds = Number(stderr.match(/Duration:.*?start:\s*([-\d.]+)/)?.[1]);
  const frames = [...stderr.matchAll(/\bn:\d+\s+pts:[-\d]+\s+pts_time:([-\d.e+]+).*?\brate:(\d+)\s+nb_samples:(\d+)/g)]
    .map(match => ({ pts: Number(match[1]), rate: Number(match[2]), samples: Number(match[3]) }));
  if (!Number.isFinite(sourceMediaStartSeconds) || !frames.length) throw new Error('源音轨时钟无法验证，未发起词级转写');
  const firstAudioPtsSeconds = frames[0].pts;
  const sampleRate = frames[0].rate;
  let inputSamples = 0;
  let maxAudioClockDeviationSeconds = 0;
  for (const frame of frames) {
    if (!Number.isFinite(frame.pts) || frame.rate !== sampleRate || frame.samples <= 0) throw new Error('源音轨时钟/采样率变化，无法保证源时间对齐');
    maxAudioClockDeviationSeconds = Math.max(maxAudioClockDeviationSeconds,
      Math.abs(frame.pts - (firstAudioPtsSeconds + inputSamples / sampleRate)));
    inputSamples += frame.samples;
  }
  // Allow millisecond container timestamp quantization, not missing packets or
  // changing playback clocks. Never rewrite word timestamps to hide drift.
  if (maxAudioClockDeviationSeconds > 0.01) throw new Error('源音轨时间戳不连续，未建立音画同步证据');
  return { format: 'pcm_s16le' as const, sampleRate: 16000, channels: 1,
    clockPolicy: REFERENCE_AUDIO_CLOCK_POLICY,
    timelineOrigin: 'source_media_start_time' as const,
    sourceMediaStartSeconds, firstAudioPtsSeconds,
    initialPaddingSamples: Math.max(0, Math.round(firstAudioPtsSeconds * 16000)),
    initialTrimSamples: Math.max(0, Math.round(-firstAudioPtsSeconds * 16000)),
    timelineOffsetSeconds: 0, preservesSourceClock: true,
    audioClockContinuityVerified: true, maxAudioClockDeviationSeconds,
    dynamicResampling: false, videoFrameTimingVerified: false,
    limitations: ['asr_word_accuracy_not_measured', 'vfr_frame_clock_not_verified'],
  };
}

/** Use measured words to anchor complete sentences; never divide duration by word count. */
export function alignNarrationSentences(sentences: Array<{text: string; needsReview?: boolean}>, words: TimedCue[]) {
  const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (normalize(sentences.map(s => s.text).join('')) !== normalize(words.map(w => w.text).join(''))) throw new Error('原音频与校对口播不一致，需复核');
  let cursor = 0;
  return sentences.map(sentence => {
    const wanted = normalize(sentence.text); let actual = ''; const matched: TimedCue[] = [];
    while (cursor < words.length && actual.length < wanted.length) { const word = words[cursor++]; matched.push(word); actual += normalize(word.text); }
    if (actual !== wanted || !matched.length) throw new Error('口播句界无法精确对齐');
    return {...sentence, start: matched[0].start, end: matched[matched.length - 1].end, words: matched, timingPrecision: 'phrase', provenance: 'qwen_filetrans:verified_words'};
  });
}
export function parseProofreadNarration(raw: string) {
  const value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!Array.isArray(value.sentences) || !value.sentences.length || value.sentences.some((s: any) => !s || typeof s.text !== 'string' || !s.text.trim())) throw new Error('校对未返回有效逐句口播');
  const sentences = value.sentences.map((s: any) => ({ text: s.text.trim(), needsReview: s.needsReview === true }));
  const strings = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string' && !!s.trim()).map(s => s.trim()))] : [];
  const products = strings(value.products).filter(p => sentences.some((s: any) => s.text.toLowerCase().includes(p.toLowerCase())));
  const brands = strings(value.brands).filter(p => sentences.some((s: any) => s.text.includes(p)));
  return { sentences, products, brands, uncertainties: strings(value.uncertainties), removedFragments: strings(value.removedFragments) };
}
/** Read existing measured-word cache only. Never creates a directory, lock,
 * audio probe, extraction or provider request. Actual original bytes bind cache. */
export function readCachedReferenceNarration(filePath: string, tenantId: string) {
  const sourceVideoSha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const hash = createHash('sha256').update(`${tenantId}:${sourceVideoSha256}:measured-word-v2:${REFERENCE_AUDIO_CLOCK_POLICY}`).digest('hex');
  const cache = path.resolve('data/analysis-output/narration-cache', `${hash}.json`);
  if (!fs.existsSync(cache)) return null;
  let saved;
  try { saved = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { return null; }
  return saved?.version === 2 && saved.sourceVideoSha256 === sourceVideoSha256
    && saved.sourceHash === hash && saved.alignmentStatus === 'aligned'
    && Array.isArray(saved.words) && saved.words.length > 0
    && Array.isArray(saved.segments) && typeof saved.text === 'string' ? saved : null;
}

/** The single reference-analysis ASR entry point. Text correction can never
 * create timestamps. Legacy proofread/equal-duration caches are not promoted. */
export async function prepareReferenceNarration(filePath: string, duration: number, options: {
  tenantId?: string; signal?: AbortSignal; manualSubmission?: boolean; request?: typeof fetch;
} = {}) {
  if (!(duration > 0 && duration <= 180)) throw new Error('真实词级转写支持 180 秒以内视频');
  const sourceVideoSha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  const tenant = options.tenantId || filePath.match(/[/\\]tenants[/\\]([^/\\]+)/)?.[1] || 'reference_analysis';
  const hash = createHash('sha256').update(`${tenant}:${sourceVideoSha256}:measured-word-v2:${REFERENCE_AUDIO_CLOCK_POLICY}`).digest('hex');
  const dir = path.resolve('data/analysis-output/narration-cache'); fs.mkdirSync(dir, { recursive: true });
  const cache = path.join(dir, `${hash}.json`);
  return withPaidOperationLock(path.join(dir, '.locks'), hash, async () => {
    const saved = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null;
    if (saved?.version === 2 && saved.sourceVideoSha256 === sourceVideoSha256
      && saved.alignmentStatus === 'aligned' && saved.words?.length) return saved;
    // PCM avoids MP3 encoder delay. No scaling/tempo transformation is applied.
    const audioPath = path.join(dir, `${hash}.wav`);
    try {
      const audioExtraction = await extractReferenceSourceAudio(filePath, audioPath, options);
      const measured = await transcribeWordAudioWithQwen({ tenant, audio: fs.readFileSync(audioPath),
        mimeType: 'audio/wav', duration, signal: options.signal, request: options.request, onRecord: record => saveReferenceNarrationBinding({tenantId:tenant,filePath,expectedSourceSha256:sourceVideoSha256},duration,audioExtraction,record), ...(options.manualSubmission ? {automaticSubmission:false,reserve:(id:string)=>studioPaidBudget.reserve('qwen_asr',id,undefined,tenant)} : {}) });
      const result = { ...measured, version: 2, sourceVideoSha256, sourceHash: hash,
        rawText: measured.text, alignmentError: '', durationSeconds: duration,
        audioExtraction, createdAt: new Date().toISOString() };
      fs.writeFileSync(cache, JSON.stringify(result, null, 2), { mode: 0o600 });
      return result;
    } finally { try { fs.unlinkSync(audioPath); } catch {} }
  });
}
