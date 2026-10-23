import { execFile } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

export interface AvatarMediaCheck { version: 1; width: number; height: number; duration: number; hasAudio: boolean; alphaVerified: boolean; checkedAt: string }
function run(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  const binary = ffmpeg;
  if (!binary) return Promise.reject(new Error('缺少视频检查工具，不能将数字人标记为可用'));
  return new Promise((resolve, reject) => execFile(binary, args, { encoding: 'buffer', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { reject(new Error('数字人文件无法完整解码或透明层不可读取')); return; }
    resolve({ stdout, stderr: stderr.toString() });
  }));
}

/** Technical checks only: do not certify lip sync, visual authenticity or aesthetic quality. */
export async function checkAvatarMedia(file: string, expected: { ratio: string; duration: number; transparent: boolean; resolution?: '480p' | '720p' }): Promise<AvatarMediaCheck> {
  // Force the expected container: an HTML response or playlist must not cause secondary fetches.
  const input = ['-protocol_whitelist', 'file,pipe', '-f', expected.transparent ? 'matroska' : 'mov', '-i', file];
  const decoded = await run(['-hide_banner', '-nostdin', '-xerror', ...input, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-']);
  const videoLine = decoded.stderr.split('\n').find(line => /Stream .*Video:/.test(line));
  const dimensions = videoLine?.match(/\b(\d{2,5})x(\d{2,5})\b/);
  const time = decoded.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!dimensions || !time) throw new Error('数字人文件未返回可核验的宽高和时长');
  const width = Number(dimensions[1]), height = Number(dimensions[2]);
  const sar = videoLine?.match(/SAR (\d+):(\d+)/);
  if ((sar && sar[1] !== sar[2]) || /rotation of (?!-?0\.00 degrees)-?\d/.test(decoded.stderr)) throw new Error('数字人含非标准像素比例或旋转标记，请先规范化画幅后核验');
  const duration = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error('数字人实际时长须在0到180秒之间');
  const ratios: Record<string, number> = { '9:16': 9 / 16, '16:9': 16 / 9, '1:1': 1 };
  if (!ratios[expected.ratio] || Math.abs(width / height / ratios[expected.ratio] - 1) > 0.03) throw new Error(`数字人实际画幅 ${width}×${height} 与请求 ${expected.ratio} 不符`);
  const minimumShortEdge = expected.resolution === '480p' ? 480 : 720;
  if (Math.min(width, height) < minimumShortEdge) throw new Error(`数字人实际分辨率 ${width}×${height} 未达到${minimumShortEdge}p短边要求`);
  if (!Number.isFinite(expected.duration) || Math.abs(duration - expected.duration) > Math.max(0.5, expected.duration * 0.05)) throw new Error('数字人文件实际时长与供应商结果不符，需人工核验');
  const hasAudio = /Stream .*Audio:/.test(decoded.stderr);
  if (!hasAudio) throw new Error('数字人口播文件缺少音轨，不能作为已完成候选');
  let alphaVerified = false;
  if (expected.transparent) {
    const decoder = /Video: vp9\b/.test(videoLine || '') ? 'libvpx-vp9' : /Video: vp8\b/.test(videoLine || '') ? 'libvpx' : '';
    if (!decoder) throw new Error('透明数字人须为可读取alpha层的VP8/VP9视频');
    const alpha = await run(['-hide_banner', '-nostdin', '-v', 'error', '-c:v', decoder, ...input, '-map', '0:v:0', '-an', '-vf', 'fps=1,alphaextract,scale=16:16', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1']);
    alphaVerified = alpha.stdout.some(value => value < 245) && alpha.stdout.some(value => value > 10);
    if (!alphaVerified) throw new Error('未检测到有效透明与可见区域，不能作为去背景人物层');
  }
  return { version: 1, width, height, duration, hasAudio, alphaVerified, checkedAt: new Date().toISOString() };
}
