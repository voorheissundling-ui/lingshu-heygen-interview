import { runVisualFfmpeg } from './renderVisualQuality.js';

const FRAME_WIDTH = 96;
const FRAME_HEIGHT = 54;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT;
const SAMPLE_FPS = 12;

type BoundaryCandidate = { at: number; motion: number; isShotBoundary?: boolean };

const finite = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

function frameDifference(left: Buffer, right: Buffer): number {
  let total = 0;
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) total += Math.abs((left[index] || 0) - (right[index] || 0));
  return total / Math.max(1, count);
}

export function selectEditBoundary(input: {
  candidates: BoundaryCandidate[];
  target: number;
  minimum: number;
  maximum: number;
}): { at: number; motion: number; confidence: number; basis: 'shot_boundary' | 'low_motion' | 'fallback' } {
  const allowed = input.candidates.filter(candidate => Number.isFinite(candidate.at)
    && candidate.at >= input.minimum && candidate.at <= input.maximum);
  const ranked = allowed.map(candidate => ({
    ...candidate,
    score: candidate.isShotBoundary
      ? Math.abs(candidate.at - input.target) * .08
      : Math.min(1, candidate.motion / 18) + Math.abs(candidate.at - input.target) * .12,
  })).sort((left, right) => left.score - right.score || Math.abs(left.at - input.target) - Math.abs(right.at - input.target));
  const selected = ranked[0];
  if (!selected) return { at: clamp(input.target, input.minimum, input.maximum), motion: 255, confidence: 0, basis: 'fallback' };
  if (selected.isShotBoundary) return { at: selected.at, motion: selected.motion, confidence: .9, basis: 'shot_boundary' };
  const confidence = selected.motion <= 3 ? .86 : selected.motion <= 6 ? .74 : selected.motion <= 10 ? .62 : .42;
  return { at: selected.at, motion: selected.motion, confidence, basis: 'low_motion' };
}

async function detectedShotBoundaries(inputPath: string): Promise<number[]> {
  const detected = await runVisualFfmpeg([
    '-i', inputPath,
    '-map', '0:v:0',
    '-vf', "select='gt(scene,0.20)',showinfo",
    '-an', '-f', 'null', '-',
  ], false, { timeoutMs: 120_000, logLevel: 'info' });
  if (!detected.ok) return [];
  return [...detected.stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map(match => Number(match[1]))
    .filter(Number.isFinite)
    .slice(0, 500);
}

async function motionCandidates(inputPath: string, minimum: number, maximum: number): Promise<BoundaryCandidate[]> {
  const duration = maximum - minimum;
  if (duration < .08) return [];
  const decoded = await runVisualFfmpeg([
    '-ss', String(Math.max(0, minimum)), '-i', inputPath, '-t', String(duration),
    '-map', '0:v:0', '-vf', `fps=${SAMPLE_FPS},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=area,format=gray`,
    '-an', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ], true, { timeoutMs: 30_000 });
  if (!decoded.ok) return [];
  const frameCount = Math.floor(decoded.stdout.length / FRAME_BYTES);
  const frames = Array.from({ length: frameCount }, (_, index) => (
    decoded.stdout.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES)
  ));
  return frames.slice(1).map((frame, index) => ({
    at: minimum + (index + 1) / SAMPLE_FPS,
    motion: frameDifference(frames[index]!, frame),
  }));
}

async function refinePoint(input: {
  inputPath: string;
  target: number;
  minimum: number;
  maximum: number;
  shotBoundaries: number[];
}) {
  const motion = await motionCandidates(input.inputPath, input.minimum, input.maximum);
  const shots = input.shotBoundaries
    .filter(at => at >= input.minimum && at <= input.maximum)
    .map(at => ({ at, motion: 0, isShotBoundary: true }));
  return selectEditBoundary({ ...input, candidates: [...shots, ...motion] });
}

/**
 * Adds deterministic FFmpeg scene/motion evidence to model-proposed edit
 * windows. It never expands beyond a verified segment or cuts into the model's
 * observed action interval. Failure keeps the conservative model boundaries.
 */
export async function enrichMaterialSegmentsWithEditBoundaries(input: {
  inputPath: string;
  duration: number;
  segments: Array<Record<string, unknown>>;
}): Promise<Array<Record<string, unknown>>> {
  const shotBoundaries = await detectedShotBoundaries(input.inputPath).catch(() => []);
  const output: Array<Record<string, unknown>> = [];
  for (const segment of input.segments) {
    const start = clamp(finite(segment.start, 0), 0, input.duration);
    const end = clamp(finite(segment.end, input.duration), start, input.duration);
    const actionStart = clamp(finite(segment.actionStart, start), start, end);
    const actionEnd = clamp(finite(segment.actionEnd, end), actionStart, end);
    const proposedStart = clamp(finite(segment.cleanStart, actionStart), start, actionStart);
    const proposedEnd = clamp(finite(segment.cleanEnd, actionEnd), actionEnd, end);
    const startMinimum = start;
    const startMaximum = Math.max(start, Math.min(actionStart, proposedStart + .6));
    const endMinimum = Math.min(end, Math.max(actionEnd, proposedEnd - .6));
    const endMaximum = end;
    try {
      const [entry, exit] = await Promise.all([
        refinePoint({ inputPath: input.inputPath, target: proposedStart, minimum: startMinimum, maximum: startMaximum, shotBoundaries }),
        refinePoint({ inputPath: input.inputPath, target: proposedEnd, minimum: endMinimum, maximum: endMaximum, shotBoundaries }),
      ]);
      const cvConfidence = Math.min(entry.confidence, exit.confidence);
      const modelConfidence = clamp(finite(segment.boundaryConfidence, 0), 0, 1);
      const boundaryConfidence = modelConfidence > 0 ? Math.min(modelConfidence, cvConfidence) : cvConfidence;
      const trusted = boundaryConfidence >= .6 && entry.at <= actionStart + .05 && exit.at >= actionEnd - .05;
      output.push({
        ...segment,
        cleanStart: trusted ? Number(entry.at.toFixed(3)) : proposedStart,
        cleanEnd: trusted ? Number(exit.at.toFixed(3)) : proposedEnd,
        cleanEntry: trusted,
        cleanExit: trusted,
        boundaryConfidence: Number(boundaryConfidence.toFixed(3)),
        boundaryAnalysis: {
          schemaVersion: 'ffmpeg-scene-motion.v1',
          entry: { at: Number(entry.at.toFixed(3)), motion: Number(entry.motion.toFixed(3)), basis: entry.basis },
          exit: { at: Number(exit.at.toFixed(3)), motion: Number(exit.motion.toFixed(3)), basis: exit.basis },
          shotBoundaryCount: shotBoundaries.filter(at => at >= start && at <= end).length,
        },
      });
    } catch {
      output.push(segment);
    }
  }
  return output;
}

