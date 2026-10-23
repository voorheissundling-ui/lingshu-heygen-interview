import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

export interface RenderVisualMetrics {
  sampleCount: number;
  contentFrameCount: number;
  nonBackgroundFrameRatio: number;
  meanBrightness: number;
  meanLumaDeviation: number;
  meanEdgeRatio: number;
  meanFrameDifference: number;
  maxFrameDifference: number;
  motionDetected: boolean;
  estimatedDistinctFrames: number;
  nearDuplicateFrameRatio: number;
  sharpFrameRatio: number;
}

export interface RenderVisualQualityResult {
  passed: boolean;
  failures: string[];
  metrics: RenderVisualMetrics;
  evidenceFrames: string[];
}

const WIDTH = 160;
const HEIGHT = 180;
const FRAME_BYTES = WIDTH * HEIGHT;

export function runVisualFfmpeg(args: string[], captureStdout = false, options: {
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
  logLevel?: 'error' | 'warning' | 'info';
} = {}): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise(resolve => {
    if (!ffmpegStatic) {
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: 'ffmpeg unavailable' });
      return;
    }
    const child = (options.spawnProcess || spawn)(String(ffmpegStatic), ['-hide_banner', '-loglevel', options.logLevel ?? 'error', '-nostdin', ...args], {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const timeoutMs = Math.max(1, Math.min(120_000, Number(options.timeoutMs) || 30_000));
    const finish = (ok: boolean, message = stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: Buffer.concat(stdout), stderr: message });
    };
    const stop = (reason: string) => {
      child.kill('SIGKILL');
      finish(false, reason);
    };
    const timer = setTimeout(() => stop(`visual_ffmpeg_timeout:${timeoutMs}ms`), timeoutMs);
    child.stdout?.on('data', chunk => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      stdoutBytes += buffer.length;
      // Ten 160x180 grayscale samples need only 288 KB. Do not retain
      // unlimited output from corrupt media or an unexpected decoder.
      if (stdoutBytes > 2 * 1024 * 1024) return stop('visual_ffmpeg_output_limit');
      stdout.push(buffer);
    });
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16_384); });
    child.on('error', error => finish(false, String(error)));
    child.on('close', code => finish(code === 0));
  });
}

function frameMetrics(frame: Buffer) {
  let sum = 0;
  let sumSquares = 0;
  let edgePixels = 0;
  const histogram = new Uint32Array(32);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = y * WIDTH + x;
      const value = frame[index] || 0;
      sum += value;
      sumSquares += value * value;
      histogram[Math.min(31, value >> 3)] += 1;
      if (x > 0 && Math.abs(value - (frame[index - 1] || 0)) >= 12) edgePixels += 1;
      if (y > 0 && Math.abs(value - (frame[index - WIDTH] || 0)) >= 12) edgePixels += 1;
    }
  }
  const count = frame.length || 1;
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
  const modalRatio = Math.max(...histogram) / count;
  const edgeRatio = edgePixels / Math.max(1, count * 2 - WIDTH - HEIGHT);
  return { mean, deviation, modalRatio, edgeRatio };
}

function difference(left: Buffer, right: Buffer): number {
  let total = 0;
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) total += Math.abs((left[index] || 0) - (right[index] || 0));
  return total / Math.max(1, count);
}

/**
 * Decode representative frames and reject a technically valid MP4 whose upper
 * visual field is only the renderer's solid fallback background. The subtitle
 * band is deliberately excluded so white glyphs cannot make an empty video
 * look visually complete.
 */
export async function inspectRenderedVisuals(input: {
  outputPath: string;
  expectedDuration?: number;
  evidenceDir?: string;
  expectedUniqueScenes?: number;
  minSharpFrameRatio?: number;
}): Promise<RenderVisualQualityResult> {
  const emptyMetrics: RenderVisualMetrics = {
    sampleCount: 0, contentFrameCount: 0, nonBackgroundFrameRatio: 0,
    meanBrightness: 0, meanLumaDeviation: 0, meanEdgeRatio: 0,
    meanFrameDifference: 0, maxFrameDifference: 0, motionDetected: false,
    estimatedDistinctFrames: 0, nearDuplicateFrameRatio: 0, sharpFrameRatio: 0,
  };
  if (!input.outputPath || !fs.existsSync(input.outputPath)) {
    return { passed: false, failures: ['成片文件不存在'], metrics: emptyMetrics, evidenceFrames: [] };
  }

  const duration = Math.max(1, Number(input.expectedDuration || 20));
  const sampleTarget = 10;
  const fps = Math.max(0.05, sampleTarget / duration);
  // Only inspect the upper half. The renderer places subtitles around the
  // lower third; including that band would let glyph edges disguise a solid
  // fallback background as genuine visual material.
  const filter = `fps=${fps.toFixed(6)},crop=iw:floor(ih*0.5):0:0,scale=${WIDTH}:${HEIGHT}:flags=area,format=gray`;
  const decoded = await runVisualFfmpeg([
    '-i', input.outputPath, '-map', '0:v:0', '-vf', filter,
    '-frames:v', String(sampleTarget), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ], true);
  if (!decoded.ok) {
    return { passed: false, failures: [`成片视频帧无法解码：${decoded.stderr.slice(-240)}`], metrics: emptyMetrics, evidenceFrames: [] };
  }

  const frames: Buffer[] = [];
  for (let offset = 0; offset + FRAME_BYTES <= decoded.stdout.length && frames.length < sampleTarget; offset += FRAME_BYTES) {
    frames.push(decoded.stdout.subarray(offset, offset + FRAME_BYTES));
  }
  const measured = frames.map(frameMetrics);
  const differences = frames.slice(1).map((frame, index) => difference(frames[index]!, frame));
  const representatives: Buffer[] = [];
  for (const frame of frames) {
    if (!representatives.some(candidate => difference(candidate, frame) < 1.25)) representatives.push(frame);
  }
  const sharpFrames = measured.filter(item => item.deviation >= 10 && item.edgeRatio >= 0.008).length;
  const contentFrameCount = measured.filter(item => (
    item.mean >= 5 && item.mean <= 250
    && item.deviation >= 6
    && item.edgeRatio >= 0.004
    && item.modalRatio <= 0.97
  )).length;
  const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const metrics: RenderVisualMetrics = {
    sampleCount: frames.length,
    contentFrameCount,
    nonBackgroundFrameRatio: frames.length ? contentFrameCount / frames.length : 0,
    meanBrightness: average(measured.map(item => item.mean)),
    meanLumaDeviation: average(measured.map(item => item.deviation)),
    meanEdgeRatio: average(measured.map(item => item.edgeRatio)),
    meanFrameDifference: average(differences),
    maxFrameDifference: differences.length ? Math.max(...differences) : 0,
    motionDetected: differences.some(value => value >= 0.75),
    estimatedDistinctFrames: representatives.length,
    nearDuplicateFrameRatio: frames.length ? Number(((frames.length - representatives.length) / frames.length).toFixed(3)) : 0,
    sharpFrameRatio: frames.length ? Number((sharpFrames / frames.length).toFixed(3)) : 0,
  };

  const failures: string[] = [];
  if (frames.length < 3) failures.push(`只解码到 ${frames.length} 个可验证视频帧`);
  if (metrics.nonBackgroundFrameRatio < 0.6) failures.push('成片多数抽样帧仅有单色/近单色背景，未检出已绑定素材的视觉内容');
  if (metrics.meanBrightness < 5 || metrics.meanBrightness > 250) failures.push('成片整体亮度异常');
  if (metrics.meanLumaDeviation < 6 || metrics.meanEdgeRatio < 0.004) failures.push('成片缺少可辨识的纹理和边缘');
  const expectedUniqueScenes = Math.max(0, Math.floor(Number(input.expectedUniqueScenes || 0)));
  if (expectedUniqueScenes > 1 && metrics.estimatedDistinctFrames < Math.min(3, expectedUniqueScenes)) {
    failures.push(`成片抽样画面只有 ${metrics.estimatedDistinctFrames} 组可区分内容，未达到 ${Math.min(3, expectedUniqueScenes)} 组最低镜头差异`);
  }
  const minSharpFrameRatio = Math.max(0, Math.min(1, Number(input.minSharpFrameRatio || 0)));
  if (minSharpFrameRatio > 0 && metrics.sharpFrameRatio < minSharpFrameRatio) {
    failures.push(`可辨识清晰帧比例 ${Math.round(metrics.sharpFrameRatio * 100)}%，低于 ${Math.round(minSharpFrameRatio * 100)}%`);
  }

  const evidenceDir = input.evidenceDir || `${input.outputPath}.quality-frames`;
  let evidenceFrames: string[] = [];
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidence = await runVisualFfmpeg([
      '-i', input.outputPath, '-map', '0:v:0', '-vf', `fps=${Math.max(0.05, 5 / duration).toFixed(6)},scale=360:-2:flags=lanczos`,
      '-frames:v', '5', '-q:v', '3', '-y', path.join(evidenceDir, 'frame-%02d.jpg'),
    ]);
    if (evidence.ok) evidenceFrames = fs.readdirSync(evidenceDir).filter(name => /^frame-\d+\.jpg$/.test(name)).sort().map(name => path.join(evidenceDir, name));
  } catch { /* metrics still decide the gate when evidence persistence fails */ }

  return { passed: failures.length === 0, failures, metrics, evidenceFrames };
}

export type SceneVisualIssue = { sceneIndex: number; start: number; end: number; code: 'decode' | 'blank' | 'blur' | 'duplicate'; reason: string; duplicateOf?: number };
/** Sample each actual render interval so a brief broken shot cannot hide between global samples. */
export async function inspectRenderedScenes(input: {
  outputPath: string; scenes: Array<{ start: number; end: number }>; requireDistinct?: boolean;
}): Promise<{ passed: boolean; issues: SceneVisualIssue[]; checkedScenes: number }> {
  const issues: SceneVisualIssue[] = [];
  const previous: Array<{ sceneIndex: number; frames: Buffer[] }> = [];
  // Reference-driven edits can legitimately contain many short cuts. The
  // inspector runs one bounded ffmpeg decode at a time, so a 32-scene cap did
  // not protect memory; it only rejected valid finished videos before looking
  // at any bytes. Keep a generous abuse bound while checking every scene.
  if (!input.scenes.length || input.scenes.length > 128) return { passed: false, issues: [{ sceneIndex: 0, start: 0, end: 0, code: 'decode', reason: '缺少有效分镜时间轴或超过128镜检查上限' }], checkedScenes: 0 };
  for (const [sceneIndex, scene] of input.scenes.entries()) {
    const add = (code: SceneVisualIssue['code'], reason: string, duplicateOf?: number) => issues.push({ sceneIndex, ...scene, code, reason, ...(duplicateOf !== undefined ? { duplicateOf } : {}) });
    const duration = scene.end - scene.start;
    if (!Number.isFinite(scene.start) || !Number.isFinite(duration) || scene.start < 0 || duration <= 0) { add('decode', '分镜时间区间无效'); continue; }
    const decoded = await runVisualFfmpeg(['-ss', String(scene.start), '-i', input.outputPath, '-t', String(duration), '-map', '0:v:0',
      '-vf', `fps=${3 / duration},crop=iw:floor(ih*0.5):0:0,scale=${WIDTH}:${HEIGHT}:flags=area,format=gray`,
      '-frames:v', '3', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], true);
    const frames = Array.from({ length: Math.min(3, Math.floor(decoded.stdout.length / FRAME_BYTES)) }, (_, i) => decoded.stdout.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
    if (!decoded.ok || frames.length < 3) { add('decode', '镜头帧无法完整解码，可能缺失或被截断'); continue; }
    const measured = frames.map(frameMetrics);
    if (measured.filter(m => m.mean < 5 || m.mean > 250 || m.deviation < 6 || m.edgeRatio < .004 || m.modalRatio > .97).length >= 2) add('blank', '镜头多数抽样帧缺少可辨识内容');
    else if (measured.filter(m => m.deviation >= 10 && m.edgeRatio >= .008).length < 2) add('blur', '镜头多数抽样帧清晰度不足');
    if (input.requireDistinct) {
      const duplicate = previous.find(other => frames.every((frame, i) => difference(frame, other.frames[i]) < 1.25));
      if (duplicate) add('duplicate', `画面与第 ${duplicate.sceneIndex + 1} 镜重复`, duplicate.sceneIndex);
    }
    previous.push({ sceneIndex, frames });
  }
  return { passed: issues.length === 0, issues, checkedScenes: previous.length };
}
