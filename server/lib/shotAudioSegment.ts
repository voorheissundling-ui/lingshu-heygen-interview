import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

export interface PreparedShotAudioSegment {
  bytes: Uint8Array;
  segmentId: string;
  checksumSha256: string;
  start: number;
  duration: number;
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 30_000 }, error => error ? reject(error) : resolve()));
}

export async function materializeShotAudioSegment(input: {
  sourcePath: string;
  outputDir: string;
  start: number;
  duration: number;
  ffmpegPath: string;
}): Promise<PreparedShotAudioSegment> {
  const start = Number(input.start); const duration = Number(input.duration);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error('分镜音频时间段无效');
  if (!fs.existsSync(input.sourcePath) || !fs.statSync(input.sourcePath).isFile()) throw new Error('统一旁白源文件不存在');
  const sourceHash = hash(fs.readFileSync(input.sourcePath));
  const segmentId = hash(`${sourceHash}:${start.toFixed(3)}:${duration.toFixed(3)}:wav16k-mono-v1`).slice(0, 32);
  fs.mkdirSync(input.outputDir, { recursive: true });
  const output = path.join(input.outputDir, `${segmentId}.wav`);
  if (!fs.existsSync(output) || fs.statSync(output).size <= 44) {
    const temporary = path.join(input.outputDir, `.${segmentId}.${randomUUID()}.tmp.wav`);
    try {
      await run(input.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input.sourcePath, '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-vn', '-ac', '1', '-ar', '16000', temporary]);
      if (!fs.existsSync(temporary) || fs.statSync(temporary).size <= 44) throw new Error('分镜音频切片为空');
      fs.renameSync(temporary, output);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  const bytes = fs.readFileSync(output);
  return { bytes, segmentId, checksumSha256: hash(bytes), start: Number(start.toFixed(3)), duration: Number(duration.toFixed(3)) };
}
