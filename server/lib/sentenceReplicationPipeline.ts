import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DigitalHumanReferenceCue } from '../../src/lib/digitalHumanPlan.js';

const run = promisify(execFile);
export interface SentencePipelineArtifact { materialId: string; filePath: string; url?: string; duration?: number; inputFingerprint?: string }

/** Provider-neutral durable orchestration: source frames never become video-provider inputs. */
export async function runSentenceReplicationPipeline(input: {
  cues: DigitalHumanReferenceCue[];
  outputPath: string;
  ffmpegPath: string;
  useGeneratedDuration?: boolean;
  createTargetFrame: (cue: DigitalHumanReferenceCue) => Promise<SentencePipelineArtifact>;
  createSentenceVideo: (cue: DigitalHumanReferenceCue, targetFrame: SentencePipelineArtifact) => Promise<SentencePipelineArtifact>;
  createNonPersonClip?: (cue: DigitalHumanReferenceCue) => Promise<SentencePipelineArtifact>;
  reuseCompletedClip?: (cue: DigitalHumanReferenceCue) => Promise<SentencePipelineArtifact | null>;
  onProgress?: (cues: DigitalHumanReferenceCue[]) => Promise<void> | void;
}): Promise<{ cues: DigitalHumanReferenceCue[]; outputPath: string }> {
  if (!input.cues.length || input.cues.some(cue => cue.personShot !== false && !cue.sourceFirstFrame?.materialId)) throw new Error('所有人物镜头的逐句源首帧必须先完成提取');
  let cues = input.cues.map(cue => structuredClone(cue)); const clips: string[] = [];
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]!; if (cue.personShot !== false && cue.targetFirstFrame?.state !== 'ready') cue.targetFirstFrame = { ...cue.targetFirstFrame, state: 'pending' }; await input.onProgress?.(cues);
    try {
      let clip: SentencePipelineArtifact;
      const reused = await input.reuseCompletedClip?.(cue);
      if (reused) {
        clip=reused;
        if(cue.personShot!==false && cue.targetFirstFrame?.materialId) cue.targetFirstFrame={...cue.targetFirstFrame,state:'ready'};
        cue.generatedClip={materialId:reused.materialId,videoUrl:reused.url,state:'pending'};
      } else if (cue.personShot === false) {
        if (!input.createNonPersonClip) throw new Error(`非人物镜头 ${cue.id} 缺少替换素材编排器`);
        cue.generatedClip = { state: 'pending' }; clip = await input.createNonPersonClip(cue);
      } else {
        const frame = await input.createTargetFrame(cue); cue.targetFirstFrame = { materialId: frame.materialId, imageUrl: frame.url, state: 'ready' };
        cue.generatedClip = { state: 'pending' }; await input.onProgress?.(cues); clip = await input.createSentenceVideo(cue, frame);
      }
      const duration = Number((input.useGeneratedDuration && clip.duration !== undefined ? clip.duration : cue.end - cue.start).toFixed(3));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`句 ${cue.id} 生成素材时长无效`);
      if (!fs.existsSync(clip.filePath) || fs.statSync(clip.filePath).size < 100) throw new Error(`句 ${cue.id} 视频产物不存在`);
      const normalized = path.join(path.dirname(input.outputPath), `.sentence-${index + 1}-${cue.id.replace(/[^a-z0-9_-]+/gi, '-')}.mp4`);
      await run(input.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', clip.filePath,
        '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', normalized], { timeout: 120_000 });
      if (!fs.existsSync(normalized) || fs.statSync(normalized).size < 100) throw new Error(`句 ${cue.id} 时长归一结果为空`);
      cue.generatedClip = { materialId: clip.materialId, videoUrl: clip.url, state: 'ready', duration, inputFingerprint: clip.inputFingerprint }; clips.push(normalized); await input.onProgress?.(cues);
    } catch (error) {
      if (cue.targetFirstFrame?.state !== 'ready') cue.targetFirstFrame = { ...cue.targetFirstFrame, state: 'failed' };
      else cue.generatedClip = { ...cue.generatedClip, state: 'failed' }; await input.onProgress?.(cues); throw error;
    }
  }
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  const manifest = path.join(path.dirname(input.outputPath), `.${path.basename(input.outputPath)}.concat.txt`);
  fs.writeFileSync(manifest, clips.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'), { mode: 0o600 });
  try {
    await run(input.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', manifest,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', input.outputPath], { timeout: 120_000 });
  } finally {
    fs.rmSync(manifest, { force: true });
    for (const clip of clips) fs.rmSync(clip, { force: true });
  }
  if (!fs.existsSync(input.outputPath) || fs.statSync(input.outputPath).size < 100) throw new Error('逐句视频拼接结果为空');
  return { cues, outputPath: input.outputPath };
}
