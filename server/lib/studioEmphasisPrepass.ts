import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  normalizeCaptionOccupancy, normalizeShotWindows, normalizeVisualEvidence,
  type CaptionOccupancy, type EmphasisEvent, type ShotWindow, type VisualEvidence,
} from '../../shared/contracts/emphasisTimeline.js';
import type { StudioEmphasisPreanalysis } from './studioEmphasisAlignment.js';
import { detectStudioShotWindows, STUDIO_SHOT_ANALYZER_VERSION } from './studioShotWindows.js';
import {
  buildStudioFrameContactSheet, extractStudioContactFrames, selectStudioFrameSamples, STUDIO_CONTACT_SHEET_VERSION,
  type StudioContactFrame,
} from './studioFrameContactSheet.js';
import { analyzeStudioCaptionOccupancy, STUDIO_CAPTION_OCCUPANCY_VERSION, type CaptionOccupancyEvidence } from './studioCaptionOccupancy.js';
import { analyzeStudioVisualEvidence, STUDIO_VISUAL_ANALYZER_VERSION, type StudioVisualAnalyzer } from './studioVisualEvidence.js';

export const STUDIO_EMPHASIS_PREPASS_VERSION = 'studio-emphasis-prepass.v1';
export type StudioEmphasisPrepassResult = StudioEmphasisPreanalysis & {
  shotWindows: ShotWindow[];
  captionOccupancy: CaptionOccupancy[];
  visualEvidence: VisualEvidence[];
};

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const cachePayload = (input: { sourceHash: string; durationMs: number; storyboard?: unknown; candidateEvents?: EmphasisEvent[] }) => JSON.stringify({
  sourceHash: input.sourceHash, durationMs: input.durationMs,
  versions: [STUDIO_EMPHASIS_PREPASS_VERSION, STUDIO_SHOT_ANALYZER_VERSION, STUDIO_CONTACT_SHEET_VERSION,
    STUDIO_CAPTION_OCCUPANCY_VERSION, STUDIO_VISUAL_ANALYZER_VERSION],
  storyboard: input.storyboard || null,
  events: (input.candidateEvents || []).slice(0, 8).map(event => [event.id, event.type, event.startMs, event.endMs, event.text]),
});

function readCache(filePath: string, durationMs: number): StudioEmphasisPrepassResult | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const shotWindows = normalizeShotWindows(raw.shotWindows, durationMs);
    if (!shotWindows.length) return null;
    return { shotWindows, captionOccupancy: normalizeCaptionOccupancy(raw.captionOccupancy, durationMs),
      visualEvidence: normalizeVisualEvidence(raw.visualEvidence) } satisfies StudioEmphasisPrepassResult;
  } catch { return null; }
}

function writeCache(filePath: string, result: StudioEmphasisPrepassResult): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch { /* Analysis cache must never block rendering. */ }
}

export async function runStudioEmphasisPrepass(input: {
  sourcePath: string;
  durationMs: number;
  sourceHash?: string;
  storyboard?: unknown;
  candidateEvents?: EmphasisEvent[];
  cacheDir?: string;
  analyzer?: StudioVisualAnalyzer;
  dependencies?: {
    detectShots?: typeof detectStudioShotWindows;
    selectSamples?: typeof selectStudioFrameSamples;
    extractFrames?: typeof extractStudioContactFrames;
    buildContactSheet?: typeof buildStudioFrameContactSheet;
    analyzeOccupancy?: typeof analyzeStudioCaptionOccupancy;
    analyzeVisual?: typeof analyzeStudioVisualEvidence;
  };
}): Promise<StudioEmphasisPrepassResult> {
  const durationMs = Math.max(0, Math.round(Number(input.durationMs) || 0));
  let sourceHash = String(input.sourceHash || '').trim();
  if (!sourceHash) {
    try { sourceHash = await sha256File(input.sourcePath); } catch { sourceHash = createHash('sha256').update(String(input.sourcePath)).digest('hex'); }
  }
  const cacheKey = createHash('sha256').update(cachePayload({ sourceHash, durationMs, storyboard: input.storyboard,
    candidateEvents: input.candidateEvents })).digest('hex');
  const cacheDir = input.cacheDir || path.join(os.homedir(), '.cache', 'lingshu-ai', 'emphasis-analysis');
  const cacheFile = path.join(cacheDir, `${cacheKey}.json`);
  const cached = readCache(cacheFile, durationMs);
  if (cached) return cached;

  const dependencies = input.dependencies || {};
  const detectShots = dependencies.detectShots || detectStudioShotWindows;
  let shotWindows: ShotWindow[];
  try {
    shotWindows = normalizeShotWindows(await detectShots({ sourcePath: input.sourcePath, durationMs, storyboard: input.storyboard }), durationMs);
  } catch { shotWindows = []; }
  if (!shotWindows.length && durationMs > 0) shotWindows = [{ id: 'shot-1', startMs: 0, endMs: durationMs, confidence: 0, source: 'fallback' }];

  const eventTimesMs = (input.candidateEvents || []).flatMap(event => [event.startMs, event.endMs]);
  let frames: StudioContactFrame[] = [];
  try {
    const samples = (dependencies.selectSamples || selectStudioFrameSamples)({ shotWindows, eventTimesMs, maxFrames: 18 });
    frames = await (dependencies.extractFrames || extractStudioContactFrames)({ sourcePath: input.sourcePath, samples });
  } catch { frames = []; }

  const captionOccupancy: CaptionOccupancy[] = [];
  const occupancyByShot = new Map<string, CaptionOccupancyEvidence>();
  for (const shot of shotWindows) {
    const shotFrames = frames.filter(frame => frame.shotId === shot.id)
      .map((frame, index) => ({ frameId: `${shot.id}-${index + 1}`, shotId: shot.id, timeMs: frame.timeMs, bytes: frame.bytes }));
    if (!shotFrames.length) continue;
    try {
      const evidence = await (dependencies.analyzeOccupancy || analyzeStudioCaptionOccupancy)({ frames: shotFrames });
      occupancyByShot.set(shot.id, evidence);
      if (evidence.captionBoxes.length) captionOccupancy.push({ id: `ocr-${shot.id}`, startMs: shot.startMs, endMs: shot.endMs,
        ...(evidence.texts.length ? { text: evidence.texts.join(' ').slice(0, 500) } : {}), boxes: evidence.captionBoxes,
        confidence: evidence.source === 'ocr' ? .8 : .55, source: 'ocr', editable: false });
    } catch { /* no occupancy for this shot */ }
  }

  let contactSheet: Awaited<ReturnType<typeof buildStudioFrameContactSheet>> = null;
  try { contactSheet = await (dependencies.buildContactSheet || buildStudioFrameContactSheet)(frames); } catch { contactSheet = null; }
  let visualEvidence: VisualEvidence[] = [];
  if (contactSheet) {
    try {
      visualEvidence = await (dependencies.analyzeVisual || analyzeStudioVisualEvidence)({
        contactSheet: contactSheet.bytes, shotWindows, contactFrames: contactSheet.frames, captionOccupancy,
        candidateEvents: (input.candidateEvents || []).slice(0, 8),
      }, { ...(input.analyzer ? { analyzer: input.analyzer } : {}) });
    } catch { visualEvidence = []; }
  }
  visualEvidence = normalizeVisualEvidence(visualEvidence).map(evidence => {
    const occupancy = occupancyByShot.get(evidence.shotId);
    return occupancy?.captionBoxes.length ? { ...evidence, captionBoxes: occupancy.captionBoxes } : evidence;
  });
  for (const evidence of visualEvidence) {
    if (!evidence.captionText) continue;
    const shot = shotWindows.find(item => item.id === evidence.shotId);
    if (!shot) continue;
    const boxes = evidence.captionBoxes.length ? evidence.captionBoxes : occupancyByShot.get(shot.id)?.captionBoxes || [];
    captionOccupancy.push({ id: `vision-caption-${shot.id}-${evidence.eventId || 'general'}`, startMs: shot.startMs, endMs: shot.endMs,
      text: evidence.captionText, boxes, confidence: Math.max(.75, evidence.confidence), source: 'ocr', editable: false });
  }
  const result: StudioEmphasisPrepassResult = {
    shotWindows,
    captionOccupancy: normalizeCaptionOccupancy(captionOccupancy, durationMs),
    visualEvidence,
  };
  writeCache(cacheFile, result);
  return result;
}
