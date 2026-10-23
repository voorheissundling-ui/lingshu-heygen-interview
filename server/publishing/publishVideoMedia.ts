import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { objectStorageUpload } from '../storage/objectStorage.js';
import { normalizeVideoPath, publishError } from './platformPublisherUtils.js';

const execFileAsync = promisify(execFile);

export function validateLocalVideo(videoPath: string | undefined, extensions: string[], maxMb: number): string {
  if (!videoPath) throw publishError('缺少待发布的视频文件', 400);
  const resolved = normalizeVideoPath(videoPath);
  if (!extensions.includes(path.extname(resolved).toLowerCase())) throw publishError('视频格式不受目标平台支持', 400);
  if (!fs.existsSync(resolved)) throw publishError('待发布视频文件不存在，请重新上传或生成', 404);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw publishError('视频路径不是文件', 400);
  if (stat.size > maxMb * 1024 * 1024) throw publishError(`视频超过 ${maxMb}MB`, 413);
  return resolved;
}

function socialVideoContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'video/mp4';
}

export async function publicVideoUrlIfNeeded(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  const publicBase = process.env.R2_PUBLIC_URL?.trim();
  if (!publicBase || !fs.existsSync(filePath)) return undefined;
  const key = `social-publish/${Date.now()}-${path.basename(filePath).replace(/[^\w.-]+/g, '-')}`;
  return objectStorageUpload({ key, body: fs.readFileSync(filePath), contentType: socialVideoContentType(filePath) });
}

export async function instagramCompatibleVideo(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  const parsed = path.parse(filePath);
  const outputPath = path.join(parsed.dir, `${parsed.name}.instagram.mp4`);
  const sourceStat = fs.statSync(filePath);
  try {
    const outputStat = fs.statSync(outputPath);
    if (outputStat.isFile() && outputStat.size > 0 && outputStat.mtimeMs >= sourceStat.mtimeMs) return outputPath;
  } catch {
    // Build a platform-compatible derivative below.
  }
  const temporaryPath = `${outputPath}.${process.pid}.tmp.mp4`;
  try {
    await execFileAsync(String(ffmpegStatic), [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', filePath,
      '-filter_complex',
      '[0:v]split=2[background][foreground];'
        + '[background]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:10[background_ready];'
        + '[foreground]scale=720:1280:force_original_aspect_ratio=decrease[foreground_ready];'
        + '[background_ready][foreground_ready]overlay=(W-w)/2:(H-h)/2,format=yuv420p[video]',
      '-map', '[video]', '-map', '0:a?', '-c:v', 'libx264', '-profile:v', 'high',
      '-level:v', '4.0', '-preset', 'medium', '-crf', '20', '-maxrate', '8M',
      '-bufsize', '16M', '-r', '30', '-g', '60', '-keyint_min', '60',
      '-sc_threshold', '0', '-flags', '+cgop', '-c:a', 'aac',
      '-profile:a', 'aac_low', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      '-movflags', '+faststart', temporaryPath,
    ], { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    fs.renameSync(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    throw publishError(`Instagram 兼容视频生成失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}
