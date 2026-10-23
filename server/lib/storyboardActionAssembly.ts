import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import type { StoryboardActionSegment } from '../../shared/storyboardActionSegments';

const run = promisify(execFile);

export interface VerifiedStoryboardSegment {
  plan: StoryboardActionSegment;
  videoPath: string;
  qualityPassed: true;
  /** Required when discarding the provider's extra tail after the action. */
  terminalStateVerified: boolean;
}

export interface AssembledStoryboardActionVideo {
  outputPath: string;
  durationSeconds: number;
  width: number;
  height: number;
  bytes: number;
  segmentCount: number;
  trimmedTailSeconds: number;
}

const durationPattern = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const videoPattern = /Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/;
const round = (value: number): number => Math.round(value * 1000) / 1000;

async function probeVideo(ffmpegPath: string, filePath: string): Promise<{ duration: number; width: number; height: number }> {
  const result = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-i', filePath], {
    timeout: 20_000, maxBuffer: 1024 * 1024,
  }).catch(error => error as { stderr?: string });
  const stderr = String(result.stderr || '');
  const duration = durationPattern.exec(stderr);
  const video = videoPattern.exec(stderr);
  if (!duration || !video) throw new Error('storyboard_segment_invalid_video');
  const seconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  const width = Number(video[1]);
  const height = Number(video[2]);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(width) || !Number.isInteger(height))
    throw new Error('storyboard_segment_invalid_video');
  return { duration: seconds, width, height };
}

/**
 * Join sequentially verified action clips. This does not perform visual QA:
 * callers must pass only clips whose per-segment identity, contact and end-state
 * gates passed. Extra provider time is removed only after the end state is seen.
 */
export async function assembleStoryboardActionSegments(input: {
  segments: VerifiedStoryboardSegment[];
  outputPath: string;
  ffmpegPath?: string;
  timeoutMs?: number;
}): Promise<AssembledStoryboardActionVideo> {
  const ffmpegPath = input.ffmpegPath || String(ffmpegStatic || '');
  if (!ffmpegPath) throw new Error('storyboard_ffmpeg_unavailable');
  if (!Array.isArray(input.segments) || !input.segments.length) throw new Error('storyboard_segments_missing');
  if (!input.outputPath || path.extname(input.outputPath).toLowerCase() !== '.mp4') throw new Error('storyboard_output_must_be_mp4');
  const outputPath = path.resolve(input.outputPath);
  const seen = new Set<string>();
  const probed: Array<{ duration: number; width: number; height: number }> = [];
  for (const [index, item] of input.segments.entries()) {
    if (!item?.qualityPassed || item.plan?.index !== index || !item.videoPath)
      throw new Error('storyboard_segment_not_verified_or_out_of_order');
    const planned = item.plan;
    if (!(planned.targetDurationSeconds > 0) || !(planned.providerDurationSeconds >= planned.targetDurationSeconds)
        || Math.abs(planned.providerDurationSeconds - planned.targetDurationSeconds - planned.trimTailSeconds) > .002)
      throw new Error('storyboard_segment_invalid_duration_plan');
    if (planned.trimTailSeconds > .001 && !item.terminalStateVerified)
      throw new Error('storyboard_segment_tail_unverified');
    const source = path.resolve(item.videoPath);
    if (source === outputPath || seen.has(source)) throw new Error('storyboard_segment_path_conflict');
    seen.add(source);
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size < 100) throw new Error('storyboard_segment_invalid_file');
    const metadata = await probeVideo(ffmpegPath, source);
    if (metadata.duration + .12 < planned.targetDurationSeconds)
      throw new Error('storyboard_segment_too_short');
    probed.push(metadata);
  }
  const first = probed[0]!;
  const width = first.width % 2 ? first.width - 1 : first.width;
  const height = first.height % 2 ? first.height - 1 : first.height;
  if (width < 64 || height < 64 || probed.some(item => Math.abs(item.width / item.height - first.width / first.height) > .03))
    throw new Error('storyboard_segment_aspect_mismatch');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp.mp4`);
  const sources = input.segments.map(item => path.resolve(item.videoPath));
  const filters = input.segments.map((item, index) =>
    `[${index}:v:0]trim=start=0:duration=${item.plan.targetDurationSeconds},setpts=PTS-STARTPTS,fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`);
  filters.push(`${input.segments.map((_, index) => `[v${index}]`).join('')}concat=n=${input.segments.length}:v=1:a=0[out]`);
  try {
    await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...sources.flatMap(source => ['-i', source]),
      '-filter_complex', filters.join(';'), '-map', '[out]', '-an',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', temporary,
    ], { timeout: input.timeoutMs ?? 180_000, maxBuffer: 2 * 1024 * 1024 });
    const assembled = await probeVideo(ffmpegPath, temporary);
    const target = input.segments.reduce((sum, item) => sum + item.plan.targetDurationSeconds, 0);
    if (Math.abs(assembled.duration - target) > Math.max(.15, input.segments.length / 24 + .05))
      throw new Error('storyboard_assembled_duration_mismatch');
    await fs.rename(temporary, outputPath);
    const stat = await fs.stat(outputPath);
    return {
      outputPath, durationSeconds: assembled.duration, width: assembled.width, height: assembled.height,
      bytes: stat.size, segmentCount: input.segments.length,
      trimmedTailSeconds: round(input.segments.reduce((sum, item) => sum + item.plan.trimTailSeconds, 0)),
    };
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
