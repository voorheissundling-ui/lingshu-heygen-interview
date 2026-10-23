import fs from 'node:fs';
import {exactQwenScope} from '../agents/exactQwenScope.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import type { VideoAiAnalysis } from '../types/index.js';
import { benchmarkTimeRange } from '../../shared/benchmarkAnalysis.js';
import { classifyReferenceCriticalShots, restoreReferenceCriticalResponse, ReferenceCriticalValidationError,
  REFERENCE_CRITICAL_RULE_VERSION, REFERENCE_CRITICAL_EVIDENCE_VERSION } from './referenceCriticalShots.js';
import { withPaidOperationLock } from './paidOperationLock.js';

const execute = promisify(execFile);
export const CRITICAL_SHOT_FRAME_POLICY = 'decoded-source-pts-frames-v2';

export function firstDecodedReferenceFrameSeconds(stderr: string): number | null {
  const match = stderr.match(/\bn:\s*0\s+pts:\s*[-\d]+\s+pts_time:\s*([-\d.e+]+)/);
  const seconds = match ? Number(match[1]) : NaN;
  return Number.isFinite(seconds) ? seconds : null;
}

/** Frame timestamps are sampled source evidence, not interpolated action times. */
export function referenceCriticalFrameSchedule(analysis: VideoAiAnalysis, duration: number) {
  return (analysis.scriptDetails15s || []).flatMap((shot, index) => {
    const range = benchmarkTimeRange(shot.time || shot.timestamp);
    if (!range || range.start >= duration) return [];
    const end = Math.min(range.end, duration), span = end - range.start;
    const times = index === 0 ? [range.start + .04, range.start + .16, range.start + .32,
      range.start + .56, range.start + .8, range.start + 1.04, range.start + 1.28,
      range.start + span / 2, end - Math.min(.12, span / 4)]
      : [range.start + .04, range.start + span / 2, end - Math.min(.12, span / 4)];
    return [...new Set(times.filter(seconds => seconds >= range.start && seconds < end)
      .map(seconds => Number(seconds.toFixed(3))))].sort((a, b) => a - b)
      .map(seconds => ({ shotId: `shot-${index + 1}`, seconds }));
  });
}

/** Used by the real product route and every new exact analysis. Cache covers
 * source, words, actions, shot clock, frame policy, rule and provider model. */
export async function produceReferenceCriticalShots(input: {
  filePath: string; analysis: VideoAiAnalysis; videoId: string; sourceSha256: string;
  duration: number; tenantId?: string;
}, options: { cacheRoot?: string; classify?: typeof classifyReferenceCriticalShots } = {}): Promise<VideoAiAnalysis> {
  // Identity/routing enrichment cannot invalidate a paid criticality result:
  // they are independent dimensions and are not inputs to its prompt.
  const mergeCritical = (cached: VideoAiAnalysis): VideoAiAnalysis => ({ ...input.analysis,
    criticalShotSummary: cached.criticalShotSummary,
    scriptDetails15s: input.analysis.scriptDetails15s?.map((shot,index)=>({ ...shot,
      criticalShot: cached.scriptDetails15s?.[index]?.criticalShot })) });
  const criticalInputs = (value: VideoAiAnalysis) => JSON.stringify({ audioTranscript:value.audioTranscript,
    shots:value.scriptDetails15s?.map(s=>({time:s.time||s.timestamp,visual:s.visual,camera:s.camera,purpose:s.purpose,
      dialogue:s.dialogue,beats:s.beats?.map(b=>({time:b.time,action:b.action,dialogue:b.dialogue})),speechAlignment:s.speechAlignment})) });
  const priorSummary = input.analysis.criticalShotSummary as any;
  if (priorSummary?.sourceSha256 === input.sourceSha256 && priorSummary.evidenceVersion === REFERENCE_CRITICAL_EVIDENCE_VERSION
    && /^[a-f0-9]{64}$/.test(String(priorSummary.cacheKey))) {
    const priorFile = path.join(options.cacheRoot || path.resolve('data/analysis-output/critical-shots'), `${priorSummary.cacheKey}.json`);
    if (fs.existsSync(priorFile)) {
      const prior = JSON.parse(fs.readFileSync(priorFile,'utf8'));
      if (prior.analysis && criticalInputs(prior.analysis) === criticalInputs(input.analysis)) return mergeCritical(prior.analysis);
    }
  }
  const cleanAnalysis = { ...input.analysis, criticalShotSummary: undefined,
    scriptDetails15s: input.analysis.scriptDetails15s?.map(shot => ({ ...shot, criticalShot: undefined })) };
  const model = (exactQwenScope()?.model || process.env.QWEN_CRITICAL_SHOT_MODEL || 'qwen3-vl-plus').trim();
  const cacheKey = createHash('sha256').update(JSON.stringify({ version: 1,
    framePolicy: CRITICAL_SHOT_FRAME_POLICY, ruleVersion: REFERENCE_CRITICAL_RULE_VERSION,
    evidenceVersion: REFERENCE_CRITICAL_EVIDENCE_VERSION, model,
    sourceSha256: input.sourceSha256, duration: input.duration, tenantId: input.tenantId, videoId: input.videoId,
    shots: cleanAnalysis.scriptDetails15s, transcript: cleanAnalysis.audioTranscript })).digest('hex');
  const dir = options.cacheRoot || path.resolve('data/analysis-output/critical-shots'); fs.mkdirSync(dir, { recursive: true });
  const cache = path.join(dir, `${cacheKey}.json`);
  const saved = () => fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : null;
  const recoverable = (value: any) => value?.cacheKey === cacheKey
    && value.status === 'failed_validation' && typeof value.providerResponse?.raw === 'string'
    && value.providerResponse.model === model;
  const existing = saved();
  if (existing?.cacheKey === cacheKey) {
    if (existing.analysis) return mergeCritical(existing.analysis as VideoAiAnalysis);
    if (!recoverable(existing)) throw new Error('该版本的千问卡点调用状态未确认；保留原记录，不重复提交');
  }
  return withPaidOperationLock(path.join(dir, '.locks'), cacheKey, async () => {
    const reusable = saved();
    if (reusable?.cacheKey === cacheKey) {
      if (reusable.analysis) return mergeCritical(reusable.analysis as VideoAiAnalysis);
      if (!recoverable(reusable)) throw new Error('该版本的千问卡点调用状态未确认；不重复提交');
    }
    const schedule = referenceCriticalFrameSchedule(input.analysis, input.duration);
    const frameDir = fs.mkdtempSync(path.join(dir, 'frames-'));
    try {
      const frames = await extractReferenceEvidenceFrames(input.filePath, cleanAnalysis, input.duration, schedule, dir);
      const classificationInput = { analysis: cleanAnalysis, frames, videoId: input.videoId, sourceSha256: input.sourceSha256 };
      let classified: VideoAiAnalysis;
      if (recoverable(reusable)) {
        classified = restoreReferenceCriticalResponse(classificationInput, reusable.providerResponse);
      } else {
        fs.writeFileSync(cache, JSON.stringify({ cacheKey, status: 'submitting', startedAt: new Date().toISOString() }), { mode: 0o600 });
        classified = await (options.classify || classifyReferenceCriticalShots)(classificationInput);
      }
      if (!classified.criticalShotSummary) throw new Error('千问没有返回完整分类来源');
      const analysis = { ...classified, criticalShotSummary: { ...classified.criticalShotSummary,
        cacheKey, framePolicy: CRITICAL_SHOT_FRAME_POLICY,
        frameEvidence: frames.map(({ shotId, seconds, requestedSeconds }) => ({ shotId, seconds, requestedSeconds })),
        sourceSha256: input.sourceSha256 } };
      const temp = `${cache}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ cacheKey, analysis, ...(recoverable(reusable)
        ? { recoveredAt: new Date().toISOString(), recoveredFrom: reusable } : {}) }, null, 2), { mode: 0o600 });
      fs.renameSync(temp, cache);
      return analysis;
    } catch (error) {
      if (fs.existsSync(cache)) {
        const previous = JSON.parse(fs.readFileSync(cache, 'utf8'));
        fs.writeFileSync(cache, JSON.stringify({ ...previous,
          status: error instanceof ReferenceCriticalValidationError ? 'failed_validation' : 'uncertain',
          error: error instanceof Error ? error.message : String(error), failedAt: new Date().toISOString(),
          ...(error instanceof ReferenceCriticalValidationError ? { providerResponse: error.providerResponse } : {}),
        }, null, 2), { mode: 0o600 });
      }
      throw error;
    } finally { fs.rmSync(frameDir, { recursive: true, force: true }); }
  });
}

/** Shared original-media evidence extractor; source PTS is retained. */
export async function extractReferenceEvidenceFrames(filePath: string, analysis: VideoAiAnalysis,
  duration: number, schedule = referenceCriticalFrameSchedule(analysis, duration), root = path.resolve('data/analysis-output/critical-shots')) {
  fs.mkdirSync(root, { recursive: true });
  const frameDir = fs.mkdtempSync(path.join(root, 'frames-'));
  try {
    const frames = [];
      for (let index = 0; index < schedule.length; index++) {
        const target = path.join(frameDir, `${index}.jpg`), frame = schedule[index]!;
        const { stderr } = await execute(ffmpeg || 'ffmpeg', ['-hide_banner','-loglevel','info',
          '-copyts','-start_at_zero','-ss',String(frame.seconds), '-i',filePath,
          '-frames:v','1','-vf','showinfo,scale=384:-2','-q:v','5','-y',target], { timeout: 20_000 });
        const actualSeconds = firstDecodedReferenceFrameSeconds(stderr);
        const shot = analysis.scriptDetails15s?.[Number(frame.shotId.replace('shot-', '')) - 1];
        const range = benchmarkTimeRange(shot?.time || shot?.timestamp);
        if (!fs.existsSync(target) || actualSeconds === null || !range
          || actualSeconds < range.start || actualSeconds >= Math.min(range.end, duration)) {
          throw new Error(`原片 ${frame.shotId} 在 ${frame.seconds}s 没有可验证的解码帧；未提交千问`);
        }
        frames.push({ ...frame, seconds: actualSeconds, requestedSeconds: frame.seconds,
          base64: fs.readFileSync(target).toString('base64'), mimeType: 'image/jpeg' });
      }
    return frames;
  } finally { fs.rmSync(frameDir, { recursive: true, force: true }); }
}
