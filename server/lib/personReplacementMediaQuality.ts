import { execFile } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

export interface PersonReplacementTechnicalMetrics {
  source: { width: number; height: number; duration: number; fps: number; hasAudio: boolean };
  candidate: { width: number; height: number; duration: number; fps: number; hasAudio: boolean };
  durationDeltaFrames: number;
  audioCorrelation: number | null;
  wholeFrameSimilarity: number;
  meanFrameDifference: number;
  temporalMotionDifference: number;
  freezeMismatchRatio: number;
  comparedFrames: number;
  limitations: string[];
}

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 96;
const FRAME_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;

function run(args: string[], captureStdout = false, timeout = 120_000): Promise<{ stdout: Buffer; stderr: string }> {
  if (!ffmpeg) return Promise.reject(new Error('ffmpeg-static unavailable'));
  return new Promise((resolve, reject) => execFile(String(ffmpeg), ['-hide_banner', '-nostdin', ...args], {
    encoding: 'buffer', timeout, maxBuffer: 64 * 1024 * 1024,
  }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error))) : resolve({ stdout: captureStdout ? Buffer.from(stdout) : Buffer.alloc(0), stderr: String(stderr || '') })));
}

function parseMedia(stderr: string) {
  const dimensions = stderr.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
  const duration = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const fps = stderr.match(/,\s*([\d.]+) fps\b/);
  if (!dimensions || !duration) throw new Error('media metadata unavailable');
  return {
    width: Number(dimensions[1]), height: Number(dimensions[2]),
    duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    fps: Number(fps?.[1] || 24), hasAudio: /Stream .*Audio:/.test(stderr),
  };
}

async function inspect(file: string) {
  try {
    const result = await run(['-i', file, '-f', 'null', '-']);
    return parseMedia(result.stderr);
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parseMedia(message);
  }
}

async function frames(file: string, duration: number) {
  const sampleFps = Math.min(5, Math.max(1, 30 / Math.max(1, duration)));
  const result = await run(['-v', 'error', '-i', file, '-an', '-vf', `fps=${sampleFps},scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}:flags=area,format=gray`, '-frames:v', '150', '-f', 'rawvideo', 'pipe:1'], true);
  return Array.from({ length: Math.floor(result.stdout.length / FRAME_BYTES) }, (_, index) => result.stdout.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES));
}

async function audio(file: string) {
  const result = await run(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], true);
  return new Float32Array(result.stdout.buffer, result.stdout.byteOffset, Math.floor(result.stdout.byteLength / 4));
}

function meanAbsoluteDifference(left: Uint8Array, right: Uint8Array) {
  const count = Math.min(left.length, right.length);
  let total = 0;
  for (let i = 0; i < count; i += 1) total += Math.abs((left[i] || 0) - (right[i] || 0));
  return total / Math.max(1, count);
}

function correlation(left: Float32Array, right: Float32Array) {
  const count = Math.min(left.length, right.length);
  if (count < 800) return null;
  let sumLeft = 0, sumRight = 0;
  for (let i = 0; i < count; i += 1) { sumLeft += left[i] || 0; sumRight += right[i] || 0; }
  const meanLeft = sumLeft / count, meanRight = sumRight / count;
  let numerator = 0, leftEnergy = 0, rightEnergy = 0;
  for (let i = 0; i < count; i += 1) {
    const a = (left[i] || 0) - meanLeft, b = (right[i] || 0) - meanRight;
    numerator += a * b; leftEnergy += a * a; rightEnergy += b * b;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator > 0 ? numerator / denominator : null;
}

export async function inspectPersonReplacementPair(sourcePath: string, candidatePath: string): Promise<PersonReplacementTechnicalMetrics> {
  const [source, candidate] = await Promise.all([inspect(sourcePath), inspect(candidatePath)]);
  const [sourceFrames, candidateFrames] = await Promise.all([frames(sourcePath, source.duration), frames(candidatePath, candidate.duration)]);
  const count = Math.min(sourceFrames.length, candidateFrames.length);
  const pairedDifferences = Array.from({ length: count }, (_, index) => meanAbsoluteDifference(sourceFrames[index]!, candidateFrames[index]!));
  const sourceMotion = sourceFrames.slice(1, count).map((frame, index) => meanAbsoluteDifference(sourceFrames[index]!, frame));
  const candidateMotion = candidateFrames.slice(1, count).map((frame, index) => meanAbsoluteDifference(candidateFrames[index]!, frame));
  const temporalMotionDifference = sourceMotion.length ? sourceMotion.reduce((sum, value, index) => sum + Math.abs(value - (candidateMotion[index] || 0)), 0) / sourceMotion.length : 0;
  const freezeMismatch = sourceMotion.filter((value, index) => (value < 0.5) !== ((candidateMotion[index] || 0) < 0.5)).length;
  let audioCorrelation: number | null = null;
  if (source.hasAudio && candidate.hasAudio) {
    const [sourceAudio, candidateAudio] = await Promise.all([audio(sourcePath), audio(candidatePath)]);
    audioCorrelation = correlation(sourceAudio, candidateAudio);
  }
  const meanFrameDifference = pairedDifferences.length ? pairedDifferences.reduce((sum, value) => sum + value, 0) / pairedDifferences.length : 255;
  return {
    source, candidate,
    durationDeltaFrames: Math.round(Math.abs(source.duration - candidate.duration) * source.fps),
    audioCorrelation,
    wholeFrameSimilarity: Math.max(0, 1 - meanFrameDifference / 255),
    meanFrameDifference,
    temporalMotionDifference,
    freezeMismatchRatio: sourceMotion.length ? freezeMismatch / sourceMotion.length : 0,
    comparedFrames: count,
    limitations: ['wholeFrameSimilarity 是低分辨率整帧相似度，不等同于人物蒙版外 SSIM', '姿态、手部、人物身份和附件伪影需要视觉模型适配器补充'],
  };
}
