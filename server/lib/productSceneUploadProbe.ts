import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import ffmpegStatic from 'ffmpeg-static';

export type ProductSceneUploadProbeErrorCode =
  | 'product_scene_media_probe_unavailable'
  | 'product_scene_media_invalid';

export class ProductSceneUploadProbeError extends Error {
  readonly code: ProductSceneUploadProbeErrorCode;

  constructor(code: ProductSceneUploadProbeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductSceneUploadProbeError';
    this.code = code;
  }
}

export interface ProductSceneUploadVideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  decodedFrameCount: number;
  verificationMethod: 'ffmpeg_full_decode';
}

interface ProbeProcessResult {
  stdout: string;
  stderr: string;
}

function runProbeProcess(ffmpegPath: string, filePath: string, timeoutMs: number): Promise<ProbeProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'info',
      '-nostdin',
      '-xerror',
      '-i', filePath,
      '-map', '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-f', 'null',
      '-',
      '-progress', 'pipe:1',
      '-nostats',
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { probeStdout: String(stdout || ''), probeStderr: String(stderr || '') }));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function maximumNumericProgressValue(output: string, key: string): number {
  let maximum = 0;
  for (const match of output.matchAll(new RegExp(`(?:^|\\n)${key}=(\\d+)`, 'g'))) {
    maximum = Math.max(maximum, Number(match[1]) || 0);
  }
  return maximum;
}

function clockSeconds(value: string): number {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function maximumDecodedSeconds(output: string): number {
  let maximum = 0;
  for (const match of output.matchAll(/(?:^|\n)out_time=(\d+:\d+:\d+(?:\.\d+)?)/g)) {
    maximum = Math.max(maximum, clockSeconds(match[1] || ''));
  }
  return maximum;
}

function videoDimensions(stderr: string): { width: number; height: number } | null {
  const match = /Stream #\d+:\d+(?:\([^\r\n)]*\))?[^\r\n]*Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/**
 * Verifies the actual uploaded bytes for a reusable product-scene clip.
 *
 * ffmpeg decodes the complete first video stream instead of trusting the
 * browser's duration, MIME type, file extension or container header alone.
 * The returned values are therefore the authority persisted by the caller.
 */
export async function probeProductSceneUploadVideo(
  filePath: string,
  options: { ffmpegPath?: string; timeoutMs?: number } = {},
): Promise<ProductSceneUploadVideoMetadata> {
  const ffmpegPath = String(options.ffmpegPath ?? ffmpegStatic ?? '').trim();
  if (!ffmpegPath) {
    throw new ProductSceneUploadProbeError(
      'product_scene_media_probe_unavailable',
      '产品素材视频校验服务暂不可用',
    );
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (cause) {
    throw new ProductSceneUploadProbeError('product_scene_media_invalid', '产品素材视频文件不可读取', { cause });
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw new ProductSceneUploadProbeError('product_scene_media_invalid', '产品素材视频文件不可读取');
  }

  let result: ProbeProcessResult;
  try {
    result = await runProbeProcess(ffmpegPath, filePath, options.timeoutMs ?? 60_000);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new ProductSceneUploadProbeError(
        'product_scene_media_probe_unavailable',
        '产品素材视频校验服务暂不可用',
        { cause },
      );
    }
    throw new ProductSceneUploadProbeError(
      'product_scene_media_invalid',
      '视频文件无法完整解码，请重新导出后上传',
      { cause },
    );
  }

  const decodedFrames = maximumNumericProgressValue(result.stdout, 'frame');
  const duration = maximumDecodedSeconds(result.stdout);
  const dimensions = videoDimensions(result.stderr);
  if (!dimensions || decodedFrames < 1 || !Number.isFinite(duration) || duration <= 0) {
    throw new ProductSceneUploadProbeError(
      'product_scene_media_invalid',
      '视频文件没有可用的画面轨道',
    );
  }
  return {
    durationSeconds: Math.round(duration * 1_000) / 1_000,
    width: dimensions.width,
    height: dimensions.height,
    decodedFrameCount: decodedFrames,
    verificationMethod: 'ffmpeg_full_decode',
  };
}
