import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVisualFfmpeg } from './renderVisualQuality.js';
import type { BeatGridEvidenceV1 } from '../../shared/contracts/effectPlan.js';

const SAMPLE_RATE = 11_025;
const HOP = 512;
const WINDOW = 1_024;

function pcmSamples(buffer: Buffer): Float32Array {
  const output = new Float32Array(Math.floor(buffer.length / 2));
  for (let index = 0; index < output.length; index += 1) output[index] = buffer.readInt16LE(index * 2) / 32768;
  return output;
}

export function detectBeatGridFromPcm(buffer: Buffer): Omit<BeatGridEvidenceV1, 'sourceHash'> | null {
  const samples = pcmSamples(buffer);
  if (samples.length < SAMPLE_RATE * 4) return null;
  const energies: number[] = [];
  for (let offset = 0; offset + WINDOW <= samples.length; offset += HOP) {
    let energy = 0;
    for (let index = offset; index < offset + WINDOW; index += 1) energy += samples[index]! * samples[index]!;
    energies.push(Math.sqrt(energy / WINDOW));
  }
  const onset = energies.map((value, index) => Math.max(0, value - (energies[index - 1] ?? value)));
  const mean = onset.reduce((sum, value) => sum + value, 0) / Math.max(1, onset.length);
  const centered = onset.map(value => Math.max(0, value - mean * .6));
  const minLag = Math.max(1, Math.round((60 / 180) * SAMPLE_RATE / HOP));
  const maxLag = Math.max(minLag, Math.round((60 / 65) * SAMPLE_RATE / HOP));
  let bestLag = minLag;
  let bestCorrelation = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let index = lag; index < centered.length; index += 1) {
      const left = centered[index]!;
      const right = centered[index - lag]!;
      dot += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const correlation = dot / Math.max(1e-9, Math.sqrt(leftPower * rightPower));
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  let bestPhase = 0;
  let bestPhaseEnergy = 0;
  for (let phase = 0; phase < bestLag; phase += 1) {
    let phaseEnergy = 0;
    for (let index = phase; index < centered.length; index += bestLag) phaseEnergy += centered[index]!;
    if (phaseEnergy > bestPhaseEnergy) {
      bestPhaseEnergy = phaseEnergy;
      bestPhase = phase;
    }
  }
  const confidence = Math.max(0, Math.min(1, bestCorrelation));
  if (confidence < .45) return null;
  const analyzedSeconds = samples.length / SAMPLE_RATE;
  const interval = bestLag * HOP / SAMPLE_RATE;
  const first = bestPhase * HOP / SAMPLE_RATE;
  const beats = Array.from({ length: Math.ceil((analyzedSeconds - first) / interval) }, (_, index) => first + index * interval)
    .filter(value => value >= 0 && value <= analyzedSeconds)
    .map(value => Number(value.toFixed(3)))
    .slice(0, 512);
  if (beats.length < 4) return null;
  return {
    schemaVersion: 'beat-grid.v1',
    source: 'local_onset_grid',
    bpm: Number((60 / interval).toFixed(2)),
    beats,
    confidence: Number(confidence.toFixed(4)),
    analyzedSeconds: Number(analyzedSeconds.toFixed(3)),
  };
}

export async function analyzeAudioBeatGrid(audioSource: string): Promise<BeatGridEvidenceV1 | null> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-beat-'));
  try {
    let source = audioSource;
    if (/^data:audio\//i.test(audioSource)) {
      const match = audioSource.match(/^data:[^;]+;base64,(.+)$/s);
      if (!match) return null;
      source = path.join(temporaryDirectory, 'source-audio');
      fs.writeFileSync(source, Buffer.from(match[1], 'base64'));
    }
    const decoded = await runVisualFfmpeg([
      '-i', source, '-t', '45', '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
    ], true, { timeoutMs: 60_000 });
    if (!decoded.ok || !decoded.stdout.length) return null;
    const grid = detectBeatGridFromPcm(decoded.stdout);
    return grid ? {
      ...grid,
      sourceHash: createHash('sha256').update(decoded.stdout).digest('hex'),
    } : null;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
