import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';

/** Read the source container clock without rounding seconds or retiming it. */
export async function probeReferenceMediaClock(filePath: string) {
  const { stderr } = await promisify(execFile)(ffmpeg || 'ffmpeg',
    ['-hide_banner', '-i', filePath, '-t', '0', '-f', 'null', '-'],
    { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
  const fps = Number(stderr.match(/Video:[^\n]*?\b(\d+(?:\.\d+)?) fps\b/)?.[1]) || null;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('原片时长不可读取');
  return { duration, fps };
}
