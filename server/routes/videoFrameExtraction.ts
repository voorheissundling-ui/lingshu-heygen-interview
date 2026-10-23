import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import type { ReferenceFrameSamplingProfile, ReferenceFrameSamplingRange } from '../lib/referenceFrameSamplingPolicy.js';

const execFileAsync = promisify(execFile);
const ffmpegBin = ffmpegStatic as unknown as string | null;
const ANALYSIS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/analysis-temp');

export async function extractQwenAnalysisFrames(filePath: string, maxFrames = 30, duration = 0, analysisMode: 'strategy' | 'exact' = 'exact', physicalCuts: number[] = [], samplingProfile: ReferenceFrameSamplingProfile = 'coarse', denseRanges: ReferenceFrameSamplingRange[] = []): Promise<Array<{ base64: string; mimeType: string; timeLabel: string }>> {
  if (!ffmpegBin) throw new Error('ffmpeg is not available for Qwen frame analysis');
  if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });

  const frameDir = path.join(ANALYSIS_DIR, `qwen-frames-${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(frameDir, { recursive: true });
  try {
    // Sub-second sampling is reserved for footage already classified as a real
    // presenter shot. Factory, product and D2C footage retain the less costly
    // scene-cut/uniform evidence below.
    const denseFps = analysisMode === 'exact' && samplingProfile === 'talking_head_dense'
      ? 2
      : 0;
    const densePlan = denseFps ? denseRanges.flatMap((range, rangeIndex) => {
      const count = Math.max(1, Math.ceil((range.endSeconds - range.startSeconds) * denseFps));
      return Array.from({ length: count }, (_, frameIndex) => ({
        file: `dense-${String(rangeIndex).padStart(3, '0')}-${String(frameIndex + 1).padStart(3, '0')}.jpg`,
        time: Math.min(range.endSeconds - 0.001, range.startSeconds + frameIndex / denseFps), dense: true,
      }));
    }) : [];
    const denseCount = densePlan.length;
    if (denseCount > 120) throw new Error('presenter_dense_sampling_budget_exceeded');
    for (const [rangeIndex, range] of denseRanges.entries()) {
      const count = Math.max(1, Math.ceil((range.endSeconds - range.startSeconds) * denseFps));
      await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-ss', String(range.startSeconds), '-i', filePath,
        '-t', String(range.endSeconds - range.startSeconds), '-vf', `fps=${denseFps},scale=384:-1`,
        '-frames:v', String(count), '-q:v', '4', path.join(frameDir, `dense-${String(rangeIndex).padStart(3, '0')}-%03d.jpg`)], { timeout: 90_000 });
    }
    const uniformPattern = path.join(frameDir, 'uniform-%02d.jpg');
    const strategyInterval = 5;
    const uniformCount = analysisMode === 'strategy'
      ? Math.max(1, Math.min(maxFrames, Math.ceil(Math.max(duration, 1) / strategyInterval) + 1))
      : Math.max(8, Math.min(42, Math.ceil((maxFrames - denseCount) * 0.6)));
    const uniformInterval = analysisMode === 'strategy'
      ? strategyInterval
      : duration > 4 ? Math.max(1, (duration - 1) / Math.max(1, uniformCount - 1)) : 4;
    await execFileAsync(ffmpegBin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-vf', `fps=1/${uniformInterval},scale=384:-1`,
      '-frames:v', String(uniformCount),
      '-q:v', '4',
      uniformPattern,
    ], { timeout: 90_000 });
    const scenePattern = path.join(frameDir, 'scene-%02d.jpg');
    let sceneTimes: number[] = [];
    try {
      if (analysisMode !== 'exact') throw new Error('scene extraction disabled for strategy analysis');
      const sceneCount = Math.max(6, maxFrames - denseCount - uniformCount);
      const sceneRun = await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'info', '-i', filePath, '-vf', "select='gt(scene,0.12)',showinfo,scale=384:-1", '-fps_mode', 'vfr', '-frames:v', String(sceneCount), '-q:v', '4', scenePattern], { timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
      sceneTimes = Array.from(sceneRun.stderr.matchAll(/pts_time:([0-9.]+)/g)).map(match => Number(match[1])).filter(Number.isFinite).slice(0, sceneCount);
    } catch { /* retain uniform frames */ }
    // A transition frame can be blurred or show both products. Observe the
    // middle of each short physical shot so the product label and item survive
    // the handoff as one distinct visual requirement.
    const cutCandidates = physicalCuts.length ? physicalCuts : sceneTimes;
    const distinctCuts = cutCandidates.filter((time, index) => index === 0 || time - cutCandidates[index - 1]! >= 0.18);
    const cutBounds = [0, ...distinctCuts, duration].filter(value => Number.isFinite(value));
    const midpointRows: Array<{ file: string; time: number; dense: boolean }> = [];
    if (analysisMode === 'exact') {
      const shortIntervals = Array.from({ length: Math.max(0, cutBounds.length - 1) }, (_, index) => index)
        .filter(index => cutBounds[index + 1]! - cutBounds[index]! >= 0.35 && cutBounds[index + 1]! - cutBounds[index]! <= 2.5);
      const sampledIntervals = shortIntervals.length <= 24 ? shortIntervals : Array.from({ length: 24 }, (_, index) => shortIntervals[Math.round(index * (shortIntervals.length - 1) / 23)]!);
      for (const index of sampledIntervals) {
        const start = cutBounds[index]!, end = cutBounds[index + 1]!;
        const time = +(start + (end - start) / 2).toFixed(2);
        const file = `midpoint-${String(index).padStart(3, '0')}.jpg`;
        try {
          await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', filePath,
            '-frames:v', '1', '-vf', 'scale=384:-1', '-q:v', '4', path.join(frameDir, file)], { timeout: 15_000 });
          midpointRows.push({ file, time, dense: false });
        } catch { /* keep the other sampled frames */ }
      }
    }
    const denseRows = densePlan.filter(row => fs.existsSync(path.join(frameDir, row.file)));
    const supplementalRows = [
      ...fs.readdirSync(frameDir).filter(file => /^uniform-\d+\.jpg$/i.test(file)).sort().map((file, index) => ({ file, time: index * uniformInterval, dense: false })),
      ...fs.readdirSync(frameDir).filter(file => /^scene-\d+\.jpg$/i.test(file)).sort().map((file, index) => ({ file, time: sceneTimes[index] ?? index * 3, dense: false })),
    ].sort((a, b) => a.time - b.time)
      .filter(row => !denseRows.some(dense => Math.abs(dense.time - row.time) < 0.45))
      .filter(row => !midpointRows.some(midpoint => Math.abs(midpoint.time - row.time) < 0.35))
      .filter((row, index, all) => index === 0 || Math.abs(row.time - all[index - 1].time) >= 0.45);
    const rows = [...denseRows, ...midpointRows, ...supplementalRows.slice(0, Math.max(0, maxFrames - denseRows.length - midpointRows.length))]
      .sort((a, b) => a.time - b.time)
      .slice(0, maxFrames);
    // FFmpeg's fps=1/5 sampler can emit no output for a clip shorter than its
    // first sampling interval. Preserve at least one observed source frame.
    if (!rows.length) {
      const file = 'first-frame.jpg';
      await execFileAsync(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-ss', '0', '-i', filePath,
        '-frames:v', '1', '-vf', 'scale=384:-1', '-q:v', '4', path.join(frameDir, file)], { timeout: 15_000 });
      if (!fs.existsSync(path.join(frameDir, file))) throw new Error('video_frame_extraction_empty');
      rows.push({ file, time: 0, dense: false });
    }
    return rows.map(row => ({ base64: fs.readFileSync(path.join(frameDir, row.file)).toString('base64'), mimeType: 'image/jpeg', timeLabel: `${row.time.toFixed(2)}s` }));
  } finally {
    try {
      for (const file of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, file));
      fs.rmdirSync(frameDir);
    } catch {
      // best effort cleanup
    }
  }
}

/** Keep hook motion evidence independent of the lower-density whole-video sample.
 * Twelve real frames in the first second preserve the approach/gesture sequence. */
export async function extractOpeningHookFrames(filePath: string): Promise<Array<{ base64: string; mimeType: string; timeLabel: string }>> {
  if (!ffmpegBin) throw new Error('ffmpeg is not available for opening hook analysis');
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const frameDir = path.join(ANALYSIS_DIR, `hook-frames-${randomUUID()}`);
  fs.mkdirSync(frameDir, { recursive: true });
  try {
    await execFileAsync(ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-vf', 'trim=duration=1,fps=12,scale=720:-1', '-frames:v', '12',
      '-q:v', '3', path.join(frameDir, 'hook-%02d.jpg'),
    ], { timeout: 30_000 });
    return fs.readdirSync(frameDir).filter(file => /^hook-\d+\.jpg$/i.test(file)).sort()
      .map((file, index) => ({ base64: fs.readFileSync(path.join(frameDir, file)).toString('base64'),
        mimeType: 'image/jpeg', timeLabel: `${(index / 12).toFixed(3)}s` }));
  } finally {
    for (const file of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, file));
    fs.rmdirSync(frameDir);
  }
}

export async function detectVideoSceneCuts(filePath: string): Promise<number[]> {
  if (!ffmpegBin) return [];
  try {
    const result = await execFileAsync(ffmpegBin, [
      '-hide_banner', '-loglevel', 'info', '-i', filePath,
      // Product montages often use wipes over similar bright backgrounds.
      // A stricter threshold swallowed the individual product shots in a
      // real six-item sequence; nearby transition frames are collapsed below.
      '-vf', "select='gt(scene,0.12)',showinfo", '-fps_mode', 'vfr', '-f', 'null', '-',
    ], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
    const candidates = [...new Set(Array.from(result.stderr.matchAll(/pts_time:([0-9.]+)/g), match => Number(match[1]))
      .filter(value => Number.isFinite(value) && value > 0.2).map(value => +value.toFixed(2)))].sort((a, b) => a - b);
    return candidates.filter((value, index) => index === 0 || value - candidates[index - 1]! >= 0.18);
  } catch (error) {
    console.warn('[videos] scene cut detection unavailable; retaining continuous observation windows:', error instanceof Error ? error.message : error);
    return [];
  }
}
