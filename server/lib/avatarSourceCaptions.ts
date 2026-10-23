import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';
import { transcribeAudioWithQwen } from '../agents/qwen.js';
import { alignQwenFile } from '../integrations/qwenAlignment.js';
import { objectStorageSupplierDeliveryReady, objectStorageSignedGetUrl, objectStorageUpload } from '../storage/objectStorage.js';
import { materialAssetObjectKey } from '../storage/materialAssets.js';
import { readTenantMaterialBytes } from './sentenceReplicationProduction.js';
import type { MaterialRecord } from './materialLibrary.js';
import { sourceCuesForShot } from '../../src/lib/narrationTimeline.js';

const run = promisify(execFile);

export function legacyAvatarSourceObjectKey(url: string, materialId: string, tenantId: string): string {
  const pathOnly = String(url || '').split('?', 1)[0];
  const file = /^\/api\/overseas\/studio\/private-assets\/materials\/([\w.-]+\.mp4)$/.exec(pathOnly)?.[1];
  if (!file || !file.startsWith(materialId + '-')) throw new Error('旧数字人素材地址未通过租户私有路由校验');
  return materialAssetObjectKey(tenantId, file);
}

/** Transcribe the selected source video itself and require measured file-transcription words. */
export async function measureAvatarSourceCaptions(material: MaterialRecord, tenantId: string, sourceBytes?: Buffer) {
  const duration = Number(material.duration);
  if (material.type !== 'video' || !(duration > 0 && duration <= 180)) throw new Error('数字人源片时长无效');
  if (!objectStorageSupplierDeliveryReady()) throw new Error('数字人原声字幕需配置可供千问读取的 HTTPS 对象存储地址');
  const bytes = sourceBytes || (await readTenantMaterialBytes(material, tenantId)).bytes;
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-avatar-captions-'));
  try {
    const video = path.join(dir, 'source.mp4');
    const audio = path.join(dir, 'source.mp3');
    fs.writeFileSync(video, bytes, { mode: 0o600 });
    await run(String(ffmpegStatic || 'ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', video,
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-y', audio], { timeout: 90_000 });
    const audioBytes = fs.readFileSync(audio);
    const cacheDir = path.resolve('data/analysis-output/avatar-source-captions', createHash('sha256').update(tenantId).digest('hex').slice(0, 16));
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const asrCache = path.join(cacheDir, `${hash}.asr.json`);
    const asr = fs.existsSync(asrCache) ? JSON.parse(fs.readFileSync(asrCache, 'utf8'))
      : await transcribeAudioWithQwen({ audio: audioBytes, fileName: 'source.mp3', signal: AbortSignal.timeout(90_000) });
    if (!fs.existsSync(asrCache) && asr.text?.trim()) fs.writeFileSync(asrCache, JSON.stringify(asr), { mode: 0o600 });
    const transcript = asr.text.trim();
    if (!transcript) throw new Error('数字人源片没有可识别的原声口播');
    const key = materialAssetObjectKey(tenantId, `avatar-captions-${hash}.mp3`);
    await objectStorageUpload({ key, body: audioBytes, contentType: 'audio/mpeg' });
    const measured = await alignQwenFile(await objectStorageSignedGetUrl(key, 900), transcript, duration,
      path.join(cacheDir, `${hash}.alignment.json`));
    const cues = sourceCuesForShot(measured, duration);
    if (!cues.length) throw new Error('数字人源片词级字幕时间码无效，请复核口播');
    return { transcript, cues, provenance: 'qwen_filetrans:source_material', sourceHash: hash };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
