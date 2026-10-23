import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';

export type NormalizedCaptionBox = { x: number; y: number; width: number; height: number };
export type CaptionToken = { text: string; confidence: number; box: NormalizedCaptionBox };
export type CaptionFrameObservation = { frameId: string; shotId?: string; timeMs: number; ocrTokens: CaptionToken[]; visualBoxes: NormalizedCaptionBox[]; ocrFailed?: boolean };
export type CaptionOccupancyEvidence = { captionBoxes: NormalizedCaptionBox[]; texts: string[]; source: 'ocr' | 'visual' | 'none'; ocrFailed: boolean };

const require = createRequire(import.meta.url);
export const STUDIO_CAPTION_OCCUPANCY_VERSION = 'studio-caption-occupancy.v1';
let sharedWorker: Promise<Worker> | null = null;

function localLanguageDirectory(): string {
  const target = path.join(os.tmpdir(), 'lingshu-tesseract-data-v1');
  fs.mkdirSync(target, { recursive: true });
  for (const language of [require('@tesseract.js-data/chi_sim'), require('@tesseract.js-data/eng')] as Array<{ code: string; langPath: string }>) {
    const source = path.join(language.langPath, `${language.code}.traineddata.gz`);
    const destination = path.join(target, `${language.code}.traineddata.gz`);
    if (!fs.existsSync(source)) throw new Error(`missing local OCR language:${language.code}`);
    if (!fs.existsSync(destination) || fs.statSync(destination).size !== fs.statSync(source).size) fs.copyFileSync(source, destination);
  }
  return target;
}

async function captionWorker(): Promise<Worker> {
  if (!sharedWorker) sharedWorker = createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY,
    { langPath: localLanguageDirectory(), gzip: true, cacheMethod: 'none' }).then(async worker => {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return worker;
    }).catch(error => { sharedWorker = null; throw error; });
  return sharedWorker;
}

export async function terminateStudioCaptionWorker(): Promise<void> {
  const worker = sharedWorker ? await sharedWorker.catch(() => null) : null;
  sharedWorker = null;
  if (worker) await worker.terminate();
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const normalizedBox = (box: NormalizedCaptionBox): NormalizedCaptionBox | null => {
  const values = [box.x, box.y, box.width, box.height];
  if (!values.every(Number.isFinite) || box.width <= 0 || box.height <= 0) return null;
  const x = clamp01(box.x), y = clamp01(box.y);
  return { x, y, width: Math.min(1 - x, box.width), height: Math.min(1 - y, box.height) };
};
const iou = (left: NormalizedCaptionBox, right: NormalizedCaptionBox): number => {
  const x1 = Math.max(left.x, right.x), y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width), y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
};
const unionBox = (left: NormalizedCaptionBox, right: NormalizedCaptionBox): NormalizedCaptionBox => {
  const x = Math.min(left.x, right.x), y = Math.min(left.y, right.y);
  return { x, y, width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y };
};

/** Requires the same region in adjacent frames; OCR evidence additionally needs confidence >=55. */
export function consolidateCaptionOccupancy(observations: CaptionFrameObservation[]): CaptionOccupancyEvidence {
  const confirmedOcr: Array<{ box: NormalizedCaptionBox; text: string }> = [];
  const confirmedVisual: NormalizedCaptionBox[] = [];
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1]!, current = observations[index]!;
    if (previous.shotId && current.shotId && previous.shotId !== current.shotId) continue;
    for (const token of current.ocrTokens.filter(item => item.confidence >= 55 && item.text.trim())) {
      const match = previous.ocrTokens.find(item => item.confidence >= 55 && item.text.trim() && iou(item.box, token.box) >= .4);
      if (match) confirmedOcr.push({ box: unionBox(match.box, token.box), text: token.text.trim() });
    }
    for (const box of current.visualBoxes) {
      const match = previous.visualBoxes.find(item => iou(item, box) >= .5);
      if (match) confirmedVisual.push(unionBox(match, box));
    }
  }
  const dedupe = (boxes: NormalizedCaptionBox[]): NormalizedCaptionBox[] => boxes.reduce<NormalizedCaptionBox[]>((all, box) => {
    const existing = all.findIndex(item => iou(item, box) >= .5);
    if (existing >= 0) all[existing] = unionBox(all[existing]!, box); else all.push(box);
    return all;
  }, []).map(box => ({ x: Number(box.x.toFixed(4)), y: Number(box.y.toFixed(4)),
    width: Number(box.width.toFixed(4)), height: Number(box.height.toFixed(4)) }));
  const ocrBoxes = dedupe(confirmedOcr.map(item => item.box));
  const visualBoxes = dedupe(confirmedVisual);
  return {
    captionBoxes: ocrBoxes.length ? ocrBoxes : visualBoxes,
    texts: [...new Set(confirmedOcr.map(item => item.text))].slice(0, 24),
    source: ocrBoxes.length ? 'ocr' : visualBoxes.length ? 'visual' : 'none',
    ocrFailed: observations.some(item => item.ocrFailed),
  };
}

async function visualCaptionBands(bytes: Buffer): Promise<NormalizedCaptionBox[]> {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) return [];
  const top = Math.round(metadata.height * .35), bottom = Math.round(metadata.height * .92);
  const { data, info } = await sharp(bytes).extract({ left: 0, top, width: metadata.width, height: Math.max(1, bottom - top) })
    .resize({ width: 512, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const active: number[] = [];
  for (let y = 0; y < info.height; y += 1) {
    let edges = 0;
    for (let x = 1; x < info.width; x += 1) if (Math.abs(data[y * info.width + x]! - data[y * info.width + x - 1]!) >= 48) edges += 1;
    if (edges / info.width >= .12) active.push(y);
  }
  if (!active.length) return [];
  const groups: Array<{ start: number; end: number }> = [];
  for (const row of active) {
    const previous = groups.at(-1);
    if (previous && row <= previous.end + 2) previous.end = row; else groups.push({ start: row, end: row });
  }
  return groups.filter(group => group.end - group.start >= 4).slice(0, 4).map(group => ({
    x: .04, y: .35 + (group.start / info.height) * .57, width: .92,
    height: Math.max(.02, ((group.end - group.start + 1) / info.height) * .57),
  }));
}

async function defaultRecognize(bytes: Buffer): Promise<CaptionToken[]> {
  const worker = await captionWorker();
  const result = await worker.recognize(bytes);
  type Word = { text?: string; confidence?: number; bbox?: { x0: number; y0: number; x1: number; y1: number } };
  const data = result.data as unknown as { words?: Word[]; blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ words?: Word[] }> }> }> };
  const words = data.words || (data.blocks || []).flatMap(block => (block.paragraphs || [])
    .flatMap(paragraph => (paragraph.lines || []).flatMap(line => line.words || [])));
  const metadata = await sharp(bytes).metadata();
  const width = metadata.width || 1, height = metadata.height || 1;
  return words.flatMap(word => {
    const box = word.bbox;
    if (!box) return [];
    const normalized = normalizedBox({ x: box.x0 / width, y: .35 + (box.y0 / height) * .57,
      width: (box.x1 - box.x0) / width, height: ((box.y1 - box.y0) / height) * .57 });
    return normalized ? [{ text: String(word.text || ''), confidence: Number(word.confidence || 0), box: normalized }] : [];
  });
}

export async function analyzeStudioCaptionOccupancy(input: {
  frames: Array<{ frameId: string; shotId?: string; timeMs: number; bytes: Buffer }>;
  recognize?: (cropped: Buffer) => Promise<CaptionToken[]>;
  detectVisual?: (bytes: Buffer) => Promise<NormalizedCaptionBox[]>;
}): Promise<CaptionOccupancyEvidence> {
  const observations: CaptionFrameObservation[] = [];
  for (const frame of input.frames.slice(0, 18)) {
    let visualBoxes: NormalizedCaptionBox[] = [];
    try { visualBoxes = await (input.detectVisual || visualCaptionBands)(frame.bytes); } catch { /* conservative empty */ }
    let ocrTokens: CaptionToken[] = [], ocrFailed = false;
    try {
      const metadata = await sharp(frame.bytes).metadata();
      if (!metadata.width || !metadata.height) throw new Error('invalid frame');
      const top = Math.round(metadata.height * .35), height = Math.max(1, Math.round(metadata.height * .57));
      const cropped = await sharp(frame.bytes).extract({ left: 0, top, width: metadata.width, height: Math.min(height, metadata.height - top) }).png().toBuffer();
      ocrTokens = await (input.recognize || defaultRecognize)(cropped);
    } catch { ocrFailed = true; }
    observations.push({ frameId: frame.frameId, ...(frame.shotId ? { shotId: frame.shotId } : {}), timeMs: frame.timeMs, ocrTokens, visualBoxes, ocrFailed });
  }
  return consolidateCaptionOccupancy(observations);
}
