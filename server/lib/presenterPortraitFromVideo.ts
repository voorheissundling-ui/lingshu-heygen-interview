import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { inspectPresenterVideo } from './presenterVideo.js';

const run = promisify(execFile);

/** Selects the sharpest sampled still. The result is an input candidate, not identity or Ark certification. */
export async function selectPresenterPortraitFrame(video: Buffer): Promise<{ bytes: Buffer; atSeconds: number; sharpness: number; sha256: string }> {
  if (!ffmpegStatic) throw new Error('本地视频取帧组件不可用');
  const info = await inspectPresenterVideo(video);
  const times = [...new Set([0.2, 0.8, 1.5, 2.5, 4, 6].filter(t => t < info.duration - 0.05).map(t => Math.round(t * 100) / 100))];
  if (!times.length) times.push(0);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lingshu-presenter-portrait-'));
  try {
    const source = path.join(dir, 'source');
    await fs.writeFile(source, video, { mode: 0o600 });
    let best: { bytes: Buffer; atSeconds: number; sharpness: number; sha256: string } | null = null;
    for (const time of times) {
      const file = path.join(dir, `frame-${time}.jpg`);
      try {
        await run(String(ffmpegStatic), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(time), '-i', source,
          '-frames:v', '1', '-q:v', '2', '-y', file], { timeout: 60_000 });
        const bytes = await fs.readFile(file);
        const { data, info: pixels } = await sharp(bytes).greyscale().resize({ width: 256, height: 256, fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
        let score = 0;
        for (let y = 1; y < pixels.height - 1; y++) for (let x = 1; x < pixels.width - 1; x++) {
          const i = y * pixels.width + x;
          score += Math.abs(4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - pixels.width]! - data[i + pixels.width]!);
        }
        const sharpness = score / ((pixels.width - 2) * (pixels.height - 2));
        if (!best || sharpness > best.sharpness) best = { bytes, atSeconds: time, sharpness, sha256: createHash('sha256').update(bytes).digest('hex') };
      } catch { /* A damaged sampled frame must not hide other usable frames. */ }
    }
    if (!best) throw new Error('人物视频没有可解码的人像帧');
    return best;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
