import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DigitalHumanReferenceCue } from '../../shared/contracts/digitalHumanRequirements.js';

const run = promisify(execFile);

/** Detect strong physical cuts in the source video before any paid cue generation. */
export async function hardSceneCutTimes(ffmpegPath: string, sourcePath: string): Promise<number[]> {
  if (!ffmpegPath || !sourcePath) throw new Error('逐句镜头切点预检缺少本地视频或 FFmpeg');
  let stderr: string;
  try {
    ({ stderr } = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'info', '-nostats', '-nostdin', '-i', sourcePath,
      '-map', '0:v:0', '-vf', "select='gt(scene,0.35)',metadata=print", '-an', '-f', 'null', '-',
    ], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }));
  } catch {
    throw new Error('逐句镜头切点预检失败；请检查参考视频，未调用供应商');
  }
  return [...stderr.matchAll(/frame:\d+\s+pts:\s*-?\d+\s+pts_time:(\d+(?:\.\d+)?)/g)]
    .map(match => Number(match[1]))
    .filter(Number.isFinite);
}

export function assertSplitCueAssignments(cues: DigitalHumanReferenceCue[]): void {
  for (const cue of cues) {
    if (cue.splitFromCueId && (!cue.originalText.trim() || cue.personShot === undefined || (cue.personShot === true && !cue.targetText.trim()))) {
      throw new Error(`拆分镜头 ${cue.id} 须填写原片语句、指定镜头类型，并为人物镜头填写本片对应语句，未调用供应商`);
    }
  }
}

export function assertPersonCueShotBoundaries(cues: DigitalHumanReferenceCue[], cuts: number[]): void {
  assertSplitCueAssignments(cues);
  for (const cue of cues) {
    if (cue.personShot === false) continue;
    const cut = cuts.find(time => time > cue.start + 0.05 && time < cue.end - 0.05);
    if (cut !== undefined) {
      throw new Error(`人物逐句镜头 ${cue.id} 在原片 ${cut.toFixed(2)}s 存在硬切；请按物理镜头拆分并分别指定人物或非人物素材，未调用供应商`);
    }
  }
}

const cueTokens = (value: string): string[] => /\s/.test(value.trim()) ? value.trim().split(/\s+/) : Array.from(value.trim());

/** Split managed person cues on locally measured physical cuts before any paid work. */
export function splitPersonCuesAtHardCuts(cues: DigitalHumanReferenceCue[], cuts: number[]): DigitalHumanReferenceCue[] {
  return cues.flatMap(cue => {
    if (cue.personShot === false) return [cue];
    const boundaries = [cue.start, ...cuts.filter(time => time > cue.start + 0.05 && time < cue.end - 0.05), cue.end]
      .sort((a, b) => a - b);
    if (boundaries.length === 2) return [cue];
    const target = cueTokens(cue.targetText);
    if (target.length < boundaries.length - 1) throw new Error(`人物逐句镜头 ${cue.id} 跨越 ${boundaries.length - 1} 个物理镜头，但本片台词不足以无重复拆分，未调用供应商`);
    let tokenCursor = 0;
    return boundaries.slice(0, -1).map((start, index) => {
      const end = boundaries[index + 1]!;
      const remainingParts = boundaries.length - 2 - index;
      const remainingTokens = target.length - tokenCursor;
      const proportional = index === boundaries.length - 2 ? remainingTokens
        : Math.round(((end - start) / (cue.end - cue.start)) * target.length);
      const take = Math.max(1, Math.min(remainingTokens - remainingParts, proportional));
      const partText = target.slice(tokenCursor, tokenCursor + take).join(/\s/.test(cue.targetText.trim()) ? ' ' : '');
      tokenCursor += take;
      return {
        ...cue,
        id: `${cue.id}:part-${index + 1}`,
        splitFromCueId: cue.splitFromCueId || cue.id,
        start, end,
        originalText: cue.originalText.trim() || '原片无可用口播（物理镜头）',
        targetText: partText,
        classificationSource: 'analysis' as const,
        sourceFirstFrame: { time: start },
        targetFirstFrame: undefined,
        generatedClip: undefined,
        generationDurationSeconds: Math.max(4, end - start),
        outputDurationSeconds: end - start,
      };
    });
  });
}

/** Seedance's current image-video adapter requests 4–15 seconds per person cue. */
export function assertSeedanceCueDurations(cues: DigitalHumanReferenceCue[]): void {
  for (const cue of cues) {
    if (cue.personShot === false) continue;
    const duration = Number(cue.generationDurationSeconds ?? (cue.end - cue.start));
    if (!Number.isFinite(duration) || duration < 4 - 1e-6 || duration > 15 + 1e-6) {
      throw new Error(`人物镜头 ${cue.id} 为 ${duration.toFixed(2)}s，当前 Seedance 逐句视频仅支持 4–15s；请改用已验收的短镜头制作路径或调整方案，未调用供应商`);
    }
  }
}
