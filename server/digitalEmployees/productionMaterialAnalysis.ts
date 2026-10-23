import {canonicalMaterialAspectRatio,type VerifiedMaterialObservation} from '../lib/weeklyAutomaticMaterialProducer.js';
import type {MaterialAnalysisPaidContext} from './materialAnalysisPaidOperation.js';
import { analyzeMaterialFramesWithQwen, verifyMaterialFramesWithQwen } from '../agents/qwen.js';
import { extractQwenAnalysisFrames } from '../routes/videos.js';
import { normalizeMaterialObservations } from '../lib/materialObservation.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { analyzeImagePostEvidenceWithGemini } from '../agents/gemini.js';
import { analyzeImagePostEvidenceWithQwen } from '../agents/qwen.js';
import { analyzeMaterialVideo, productionAnalysisSegments } from '../routes/studio.js';
import { runVisualFfmpeg, inspectRenderedVisuals } from '../lib/renderVisualQuality.js';
import { resolveSourceDurations } from '../lib/videoSourcePlan.js';
import { objectStorageGetObject } from '../storage/objectStorage.js';
import { fetchCloudMaterial } from '../lib/cloudMaterials.js';
import { evidenceClips, observationStrings } from './sceneEvidence.js';
import type { AssetCandidate } from './contentProduction.js';
import { enrichMaterialSegmentsWithEditBoundaries } from '../lib/videoBoundaryAnalysis.js';

export type MaterialAnalysis = { revision: string; duration: number; observations: string[]; segments: Array<Record<string, unknown>>; automaticVisual?:{sha256:string;model:string;aspectRatio:string;durationSeconds:number;decoded:boolean;qualityPassed:boolean;observations:VerifiedMaterialObservation[]} };
export function materialRevision(asset: AssetCandidate): string {
  let stat: fs.Stats | undefined;
  try { if (asset.localPath) stat = fs.statSync(asset.localPath); } catch { /* missing files invalidate the revision and fail analysis/render explicitly */ }
  return crypto.createHash('sha256').update(JSON.stringify([asset.id, asset.localPath, stat?.size, stat?.mtimeMs,
    asset.objectKey, asset.cloudRecordId, asset.url, asset.duration, asset.segments, asset.visualObservations])).digest('hex');
}
export function applyMaterialAnalysis(asset: AssetCandidate, cached?: MaterialAnalysis): AssetCandidate {
  return cached?.revision === materialRevision(asset) ? { ...asset, duration: cached.duration, visualObservations: cached.observations,
    observations: cached.observations, segments: cached.segments } : asset;
}
const MAX_BYTES = 110 * 1024 * 1024;
type MaterialAnalysisFrame = { base64: string; mimeType: string; timeLabel: string };
function materialFrameSeconds(label: string): number {
  const value = Number.parseFloat(String(label || '').replace(/s$/i, ''));
  return Number.isFinite(value) ? value : 0;
}

export function materialFrameBatches(frames: MaterialAnalysisFrame[], duration: number, limit = 20): Array<{
  frames: MaterialAnalysisFrame[]; start: number; end: number;
}> {
  const ordered = [...frames].sort((left, right) => materialFrameSeconds(left.timeLabel) - materialFrameSeconds(right.timeLabel));
  if (!ordered.length) return [];
  const size = Math.max(4, Math.floor(limit));
  const groups: MaterialAnalysisFrame[][] = [];
  for (let index = 0; index < ordered.length; index += size) groups.push(ordered.slice(index, index + size));
  return groups.map((group, index) => {
    const previous = groups[index - 1];
    const next = groups[index + 1];
    const first = materialFrameSeconds(group[0]!.timeLabel);
    const last = materialFrameSeconds(group.at(-1)!.timeLabel);
    const start = previous ? (materialFrameSeconds(previous.at(-1)!.timeLabel) + first) / 2 : 0;
    const end = next ? (last + materialFrameSeconds(next[0]!.timeLabel)) / 2 : duration;
    return { frames: group, start: Math.max(0, start), end: Math.max(start + 0.05, Math.min(duration, end)) };
  });
}

function boundMaterialAnalysisToWindow(raw: unknown, start: number, end: number): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { segments?: unknown[] }).segments)) return raw;
  const segments = (raw as { segments: Array<Record<string, unknown>> }).segments.flatMap(item => {
    const boundedStart = Math.max(start, Number(item.start));
    const boundedEnd = Math.min(end, Number(item.end));
    if (!Number.isFinite(boundedStart) || !Number.isFinite(boundedEnd) || boundedEnd - boundedStart < 0.08) return [];
    return [{ ...item, start: boundedStart, end: boundedEnd }];
  });
  return { ...(raw as Record<string, unknown>), segments };
}

export async function readMaterialBytes(body: AsyncIterable<Uint8Array>, options: { limit?: number; timeoutMs?: number; cancel?: () => void | Promise<unknown> } = {}): Promise<Buffer> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let size = 0, complete = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('素材下载超时，请稍后重试')), options.timeoutMs || 30000); });
  try {
    for (;;) {
      const item = await Promise.race([iterator.next(), timeout]);
      if (item.done) { complete = true; return Buffer.concat(chunks); }
      size += item.value.byteLength;
      if (size > (options.limit || MAX_BYTES)) throw Error('production_input_required:素材超过自动分析大小限制，请先在素材库分段处理');
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    clearTimeout(timer!);
    if (!complete) {
      if (options.cancel) void Promise.resolve().then(options.cancel).catch(() => {});
      else void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }
}
/** Called for one asset per worker tick. No display-name facts enter the vision prompt. */
export async function analyzeProductionMaterial(asset: AssetCandidate, tenantId: string, allowReview = false, paidOperationContext?: MaterialAnalysisPaidContext): Promise<MaterialAnalysis> {
  let bytes: Buffer;
  if (asset.localPath) {
    if (fs.statSync(asset.localPath).size > MAX_BYTES) throw Error('production_input_required:素材超过110MB上传限制，请先拆分文件');
    bytes = fs.readFileSync(asset.localPath);
  } else if (asset.objectKey) {
    const media = await objectStorageGetObject(asset.objectKey, `bytes=0-${MAX_BYTES}`);
    if (!media) throw Error('素材文件不可读');
    bytes = await readMaterialBytes(media.body, { cancel: () => { (media.body as { destroy?: () => void }).destroy?.(); } });
  } else if (asset.cloudRecordId) {
    const response = await fetchCloudMaterial(asset.cloudRecordId, 'videoFile', undefined, tenantId);
    if (!response?.ok || !response.body) throw Error('素材文件不可读');
    const reader = response.body.getReader();
    const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => reader.read() as Promise<IteratorResult<Uint8Array>> }) };
    try { bytes = await readMaterialBytes(body, { cancel: () => reader.cancel() }); }
    finally { reader.releaseLock(); }
  } else throw Error('production_input_required:请将外链素材导入当前租户素材库后分析，不能只凭链接名称生成分镜');
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error('production_input_required:素材为空或超过110MB上传限制，请先拆分文件');
  const revision = materialRevision(asset);
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  if(paidOperationContext&&(process.env.VIDEO_ANALYSIS_PROVIDER||'qwen').trim().toLowerCase()!=='qwen')throw Error('material_paid_gemini_request_guard_missing');
  const paid = async(stage:'material_image_analysis'|'material_video_analysis'|'material_video_review',batchIndex:number,model:string)=>{
    if(!paidOperationContext)return undefined;
    const call=await paidOperationContext.forRequest({assetId:asset.id,sourceSha256:digest,stage,batchIndex,provider:'qwen',model});
    const requirementKey=stage==='material_image_analysis'?`asset:${asset.id}:image`:`asset:${asset.id}:${batchIndex}:${stage==='material_video_analysis'?'analysis':'review'}`;
    if(call.requirementKey!==requirementKey||call.intent.stage!==stage||call.intent.model!==model||call.intent.provider!=='qwen')throw Error('material_paid_frozen_operation_changed');
    return call;
  };
  const visualModel=(process.env.VIDEO_ANALYSIS_PROVIDER||'qwen').toLowerCase() === 'qwen'?'qwen_visual_material_review':'gemini_visual_material_review';
  if (asset.type === 'image') {
    const mimeType = /\.png$/i.test(asset.localPath || asset.name) ? 'image/png' : /\.webp$/i.test(asset.localPath || asset.name) ? 'image/webp' : 'image/jpeg';
    const analyze = (process.env.VIDEO_ANALYSIS_PROVIDER || 'qwen').toLowerCase() === 'qwen' ? analyzeImagePostEvidenceWithQwen : analyzeImagePostEvidenceWithGemini;
    const result = await analyze({ images: [{ base64: bytes.toString('base64'), mimeType, imageIndex: 1 }],
      paidOperation:await paid('material_image_analysis',0,(process.env.QWEN_VL_MODEL??'qwen-vl-max').trim()) });
    const observations = result.observedFacts
      .filter(fact => Number(fact.confidence) >= .65)
      .flatMap(fact => [
        ...(Array.isArray(fact.subjects) ? fact.subjects : []),
        fact.scene,
        fact.composition,
      ])
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (!observations.length) throw Error('production_input_required:图片没有足够可信的视觉观察，请补充清晰素材');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lingshu-image-quality-'));
    try{const original=path.join(dir,mimeType==='image/png'?'source.png':'source.jpg');fs.writeFileSync(original,bytes);
      const probe=await runVisualFfmpeg(['-i',original,'-vf','showinfo','-frames:v','1','-f','null','-'],false,{logLevel:'info'});
      const size=probe.stderr.match(/s:(\d+)x(\d+)/);
      const proxy=path.join(dir,'quality.mp4');const prepared=await runVisualFfmpeg(['-loop','1','-i',original,'-t','1','-vf','scale=720:-2','-c:v','libx264','-pix_fmt','yuv420p','-y',proxy]);
      const quality=prepared.ok?await inspectRenderedVisuals({outputPath:proxy,expectedDuration:1,minSharpFrameRatio:.6}):null;
      return {revision,duration:0,observations,segments:[],automaticVisual:{sha256:digest,model:visualModel,aspectRatio:size?canonicalMaterialAspectRatio(Number(size[1]),Number(size[2])):'',durationSeconds:0,decoded:probe.ok,qualityPassed:quality?.passed===true,observations:result.observedFacts.flatMap(fact=>(fact.subjects??[]).map(subjectRef=>({subjectRef,action:'static',scene:String(fact.scene||''),confidence:Number(fact.confidence),needsReview:Number(fact.confidence)<.85})))}};
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-material-analysis-'));
  try {
    const file = path.join(dir, 'source.mp4');
    fs.writeFileSync(file, bytes);
    const [resolved] = await resolveSourceDurations([{ ...asset, localPath: file }]);
    if (!resolved.duration) throw Error('production_input_required:无法验证素材视频时长，请检查文件');
    const proxy = path.join(dir, 'analysis-proxy.mp4');
    const prepared = await runVisualFfmpeg(['-i', file, '-map', '0:v:0', '-an', '-vf', "scale='min(960,iw)':-2", '-r', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-y', proxy], false, { timeoutMs: 120000 });
    if (!prepared.ok || !fs.existsSync(proxy)) throw Error('分析代理视频生成失败，请重试');
    // Time stays in original seconds. The high-resolution original remains the render source.
    let segments: Array<Record<string, unknown>>;
    if ((process.env.VIDEO_ANALYSIS_PROVIDER || 'qwen').trim().toLowerCase() === 'qwen') {
      // Pay the visual-analysis cost once at ingestion. Short clips keep a small
      // request; longer reels receive enough temporal samples to locate clean
      // action boundaries instead of asking every production task to re-analyse.
      const frameBudget = Math.max(18, Math.min(48, Math.ceil(resolved.duration * 2)));
      const frames = await extractQwenAnalysisFrames(proxy, frameBudget, resolved.duration);
      const batches = materialFrameBatches(frames, resolved.duration);
      const reviewedSegments: Array<Record<string, unknown>> = [];
      for (const [batchIndex,batch] of batches.entries()) {
        const model=(process.env.QWEN_MATERIAL_VL_MODEL||(process.env.QWEN_EXACT_VL_MODEL??'qwen3-vl-plus')).trim();
        const draftRaw = await analyzeMaterialFramesWithQwen({ frames: batch.frames, duration: resolved.duration,
          windowStart: batch.start, windowEnd: batch.end,paidOperation:await paid('material_video_analysis',batchIndex,model) });
        const draft = boundMaterialAnalysisToWindow(draftRaw, batch.start, batch.end);
        normalizeMaterialObservations(asset.id, resolved.duration, draft);
        const reviewedRaw = await verifyMaterialFramesWithQwen({ frames: batch.frames, duration: resolved.duration, draft,
          windowStart: batch.start, windowEnd: batch.end,paidOperation:await paid('material_video_review',batchIndex,model) });
        const reviewed = boundMaterialAnalysisToWindow(reviewedRaw, batch.start, batch.end);
        reviewedSegments.push(...normalizeMaterialObservations(asset.id, resolved.duration, reviewed));
      }
      segments = reviewedSegments
        .sort((left, right) => Number(left.start) - Number(right.start))
        .map((segment, index) => ({ ...segment, id: `${asset.id}-segment-${index + 1}` }));
    } else segments = productionAnalysisSegments(asset.id, resolved.duration, await analyzeMaterialVideo(proxy, fs.readFileSync(proxy), resolved.duration));
    segments = await enrichMaterialSegmentsWithEditBoundaries({ inputPath: file, duration: resolved.duration, segments });
    if (!allowReview && !evidenceClips({ ...asset, duration: resolved.duration, segments }).length) throw Error('production_input_required:视频分析缺少已确认的可用片段，请复核素材分析');
    const probe=await runVisualFfmpeg(['-i',file,'-vf','showinfo','-frames:v','1','-f','null','-'],false,{logLevel:'info'});
    const size=probe.stderr.match(/s:(\d+)x(\d+)/);
    const quality=await inspectRenderedVisuals({outputPath:file,expectedDuration:resolved.duration,minSharpFrameRatio:.6});
    return { revision, duration: resolved.duration, segments, observations: segments.flatMap(observationStrings),automaticVisual:{sha256:digest,model:visualModel,aspectRatio:size?canonicalMaterialAspectRatio(Number(size[1]),Number(size[2])):'',durationSeconds:resolved.duration,decoded:probe.ok,qualityPassed:quality.passed,observations:segments.flatMap(segment=>(Array.isArray(segment.subject)?segment.subject:[]).map(subject=>({subjectRef:String(subject),action:String(segment.action||''),scene:String(segment.environment||''),confidence:Number(segment.confidence),needsReview:segment.needsReview!==false})))}};
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
