import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';

export interface NormalizedTenantMedia {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  duration: number;
  poster?: { buffer: Buffer; filename: string; mimeType: string };
  normalization: { version: 'tenant-media-v1'; originalMimeType: string; standardFormat: string; metadataStripped: true };
}

function runFfmpeg(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    if (!ffmpegStatic) { resolve({ ok: false, stderr: 'ffmpeg unavailable' }); return; }
    const child = spawn(ffmpegStatic as string, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => resolve({ ok: false, stderr: error.message }));
    child.on('close', code => resolve({ ok: code === 0, stderr }));
  });
}

function videoMetadata(stderr: string): { width: number; height: number; duration: number } {
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const dimensions = stderr.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/s);
  return {
    width: Number(dimensions?.[1] || 0), height: Number(dimensions?.[2] || 0),
    duration: duration ? Number((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])).toFixed(3)) : 0,
  };
}

export async function normalizeTenantMedia(input: {
  buffer: Buffer;
  originalName: string;
  declaredMimeType: string;
  kind: 'image' | 'video' | 'audio';
  temporaryDirectory: string;
}): Promise<NormalizedTenantMedia> {
  const originalMimeType = String(input.declaredMimeType || '').split(';', 1)[0].toLowerCase();
  if (input.kind === 'image') {
    const metadata = await sharp(input.buffer, { failOn: 'error' }).metadata()
      .catch(() => { throw new Error('uploaded image bytes are invalid'); });
    const alpha = Boolean(metadata.hasAlpha);
    const buffer = alpha
      ? await sharp(input.buffer).rotate().png({ compressionLevel: 9 }).toBuffer()
      : await sharp(input.buffer).rotate().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    const clean = await sharp(buffer).metadata();
    const extension = alpha ? '.png' : '.jpg';
    const filename = `${path.basename(input.originalName, path.extname(input.originalName)).slice(0, 80) || randomUUID()}${extension}`;
    return {
      buffer, filename, mimeType: alpha ? 'image/png' : 'image/jpeg',
      sha256: createHash('sha256').update(buffer).digest('hex'), width: Number(clean.width || 0), height: Number(clean.height || 0), duration: 0,
      poster: { buffer, filename: `poster${extension}`, mimeType: alpha ? 'image/png' : 'image/jpeg' },
      normalization: { version: 'tenant-media-v1', originalMimeType, standardFormat: alpha ? 'png' : 'jpeg', metadataStripped: true },
    };
  }

  if (input.kind === 'video') {
    const source = path.join(input.temporaryDirectory, `source-${randomUUID()}${path.extname(input.originalName) || '.video'}`);
    const output = path.join(input.temporaryDirectory, `normalized-${randomUUID()}.mp4`);
    const posterPath = path.join(input.temporaryDirectory, `poster-${randomUUID()}.jpg`);
    fs.writeFileSync(source, input.buffer, { mode: 0o600 });
    const converted = await runFfmpeg(['-loglevel', 'info', '-i', source, '-map_metadata', '-1', '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', output]);
    if (!converted.ok || !fs.existsSync(output) || !fs.statSync(output).size) throw new Error('uploaded video cannot be decoded and normalized');
    const probed = await runFfmpeg(['-loglevel', 'info', '-i', output, '-f', 'null', '-']);
    const metadata = videoMetadata(probed.stderr);
    await runFfmpeg(['-loglevel', 'error', '-ss', metadata.duration > 1 ? '1' : '0', '-i', output, '-frames:v', '1', '-q:v', '3', '-y', posterPath]);
    const buffer = fs.readFileSync(output);
    const poster = fs.existsSync(posterPath) && fs.statSync(posterPath).size
      ? { buffer: fs.readFileSync(posterPath), filename: 'poster.jpg', mimeType: 'image/jpeg' }
      : undefined;
    return {
      buffer, filename: `${path.basename(input.originalName, path.extname(input.originalName)).slice(0, 80) || randomUUID()}.mp4`, mimeType: 'video/mp4',
      sha256: createHash('sha256').update(buffer).digest('hex'), ...metadata, poster,
      normalization: { version: 'tenant-media-v1', originalMimeType, standardFormat: 'mp4-h264-aac', metadataStripped: true },
    };
  }

  const buffer = input.buffer;
  return {
    buffer, filename: path.basename(input.originalName), mimeType: originalMimeType,
    sha256: createHash('sha256').update(buffer).digest('hex'), width: 0, height: 0, duration: 0,
    normalization: { version: 'tenant-media-v1', originalMimeType, standardFormat: path.extname(input.originalName).slice(1).toLowerCase(), metadataStripped: true },
  };
}
