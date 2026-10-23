import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import type { StudioShotWindow } from './studioShotWindows.js';

const run = promisify(execFile);
export const STUDIO_CONTACT_SHEET_VERSION = 'studio-contact-sheet.v1';
export type StudioFrameSample = { shotId: string; timeMs: number };
export type StudioContactFrame = StudioFrameSample & { bytes: Buffer };

export function selectStudioFrameSamples(input: {
  shotWindows: StudioShotWindow[];
  eventTimesMs?: number[];
  maxFrames?: number;
}): StudioFrameSample[] {
  const maxFrames = Math.max(1, Math.min(18, Math.round(input.maxFrames ?? 18)));
  const events = (input.eventTimesMs || []).filter(Number.isFinite);
  const rankedShots = input.shotWindows.filter(shot => shot.endMs > shot.startMs).map(shot => ({
    shot,
    distance: events.length ? Math.min(...events.map(at => at < shot.startMs ? shot.startMs - at : at > shot.endMs ? at - shot.endMs : 0)) : 0,
  })).sort((left, right) => left.distance - right.distance || left.shot.startMs - right.shot.startMs);
  const shotLimit = Math.max(1, Math.floor(maxFrames / 3));
  const selectedIds = new Set((rankedShots.length > shotLimit ? rankedShots.slice(0, shotLimit) : rankedShots).map(item => item.shot.id));
  return input.shotWindows.filter(shot => selectedIds.has(shot.id)).flatMap(shot => {
    const duration = shot.endMs - shot.startMs;
    return [.2, .5, .8].map(ratio => ({ shotId: shot.id, timeMs: Math.round(shot.startMs + duration * ratio) }));
  }).slice(0, maxFrames);
}

export async function extractStudioContactFrames(input: {
  sourcePath: string;
  samples: StudioFrameSample[];
  ffmpegPath?: string | null;
  execute?: (file: string, args: string[]) => Promise<{ stdout: Buffer }>;
}): Promise<StudioContactFrame[]> {
  const ffmpeg = input.ffmpegPath === undefined ? ffmpegStatic : input.ffmpegPath;
  if (!ffmpeg || !input.sourcePath) return [];
  const output: StudioContactFrame[] = [];
  for (const sample of input.samples.slice(0, 18)) {
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', (sample.timeMs / 1_000).toFixed(3), '-i', input.sourcePath,
        '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=256:-2:flags=lanczos', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'];
      const result = input.execute ? await input.execute(ffmpeg, args)
        : await run(ffmpeg, args, { encoding: 'buffer', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }) as unknown as { stdout: Buffer };
      if (result.stdout?.length) output.push({ ...sample, bytes: Buffer.from(result.stdout) });
    } catch { /* A missing analysis frame must not block export. */ }
  }
  return output;
}

export async function buildStudioFrameContactSheet(frames: StudioContactFrame[]): Promise<{
  bytes: Buffer;
  width: number;
  height: number;
  frames: Array<{ shotId: string; timeMs: number; column: number; row: number }>;
} | null> {
  const selected = frames.filter(frame => frame.bytes?.length).slice(0, 18);
  if (!selected.length) return null;
  const cellWidth = 256, imageHeight = 144, labelHeight = 28, cellHeight = imageHeight + labelHeight;
  const columns = Math.min(3, selected.length), rows = Math.ceil(selected.length / columns);
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  const manifest: Array<{ shotId: string; timeMs: number; column: number; row: number }> = [];
  for (const [index, frame] of selected.entries()) {
    const column = index % columns, row = Math.floor(index / columns), left = column * cellWidth, top = row * cellHeight;
    const image = await sharp(frame.bytes).rotate().resize(cellWidth, imageHeight, { fit: 'cover', position: 'centre' }).jpeg({ quality: 82 }).toBuffer();
    const label = `${frame.shotId}  ${(frame.timeMs / 1_000).toFixed(2)}s`.replace(/[<>&]/g, '');
    const svg = Buffer.from(`<svg width="${cellWidth}" height="${labelHeight}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111827"/><text x="8" y="19" font-size="14" font-family="Arial" fill="#fff">${label}</text></svg>`);
    composites.push({ input: image, left, top }, { input: svg, left, top: top + imageHeight });
    manifest.push({ shotId: frame.shotId, timeMs: frame.timeMs, column, row });
  }
  const width = columns * cellWidth, height = rows * cellHeight;
  const bytes = await sharp({ create: { width, height, channels: 3, background: '#111827' } })
    .composite(composites).jpeg({ quality: 72, chromaSubsampling: '4:2:0' }).toBuffer();
  return { bytes, width, height, frames: manifest };
}
