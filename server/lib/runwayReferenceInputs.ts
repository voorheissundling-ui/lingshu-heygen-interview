import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import ffmpegStatic from 'ffmpeg-static';
import type { PresenterAsset, ShotProduction } from '../../src/lib/shotProduction.js';
import { accessibleMaterial, readLocalMaterials, type MaterialRecord } from './materialLibrary.js';
import { objectStorageDownload, objectStorageHead, objectStorageSignedGetUrl, objectStorageUploadFile } from '../storage/objectStorage.js';
import { tenantPrivateObjectKey } from '../storage/materialAssets.js';

type Dependencies = {
  materials: () => MaterialRecord[];
  download: typeof objectStorageDownload;
  head: typeof objectStorageHead;
  uploadFile: typeof objectStorageUploadFile;
  sign: typeof objectStorageSignedGetUrl;
  ffmpegPath: string;
};
const defaults = (): Dependencies => ({ materials: readLocalMaterials, download: objectStorageDownload, head: objectStorageHead, uploadFile: objectStorageUploadFile, sign: objectStorageSignedGetUrl, ffmpegPath: String(ffmpegStatic || '') });
const run = (file: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(file, args, { timeout: 120_000 }, error => error ? reject(error) : resolve()));

function ownedMaterial(records: MaterialRecord[], id: string, tenantId: string, type?: string): MaterialRecord {
  const item = records.find(record => String(record.id) === id && accessibleMaterial(record, tenantId));
  if (!item || (type && item.type !== type)) throw new Error('当前企业无权使用所选 Runway 输入素材');
  if (!String(item.objectKey || '')) throw new Error('Runway 输入素材必须先保存到对象存储');
  return item;
}

const RUNWAY_CHARACTER_MIN_ASPECT_RATIO = 0.5;
const RUNWAY_CHARACTER_MAX_ASPECT_RATIO = 2.358;
const RUNWAY_CHARACTER_MAX_BYTES = { image: 16 * 1024 * 1024, video: 32 * 1024 * 1024 } as const;

function numericAspectRatio(material: MaterialRecord): number | undefined {
  const explicit = Number(material.aspectRatio);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const width = Number(material.width); const height = Number(material.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : undefined;
}

function knownRunwayIncompatibility(material: MaterialRecord): string | undefined {
  const type = String(material.type) as keyof typeof RUNWAY_CHARACTER_MAX_BYTES;
  if (!(type in RUNWAY_CHARACTER_MAX_BYTES)) return '素材须为图片或视频';
  const ratio = numericAspectRatio(material);
  if (ratio !== undefined && (ratio < RUNWAY_CHARACTER_MIN_ASPECT_RATIO || ratio > RUNWAY_CHARACTER_MAX_ASPECT_RATIO)) return '画幅比例不符合 Act-Two 要求';
  const bytes = Number(material.sizeBytes);
  if (Number.isFinite(bytes) && bytes > RUNWAY_CHARACTER_MAX_BYTES[type]) return `${type === 'image' ? '图片' : '视频'}超过 Act-Two 输入大小上限`;
  return undefined;
}

function runwayInputUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Runway 输入签名地址无效'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.') || isIP(parsed.hostname) !== 0 || parsed.username || parsed.password) {
    throw new Error('Runway 输入须使用可访问的 HTTPS 域名地址');
  }
  return parsed.toString();
}

export function selectRunwayCharacterMaterial(records: MaterialRecord[], ids: string[], tenantId: string): MaterialRecord {
  // Validate every configured asset first. A stale or cross-tenant mapping must not silently
  // change the identity input used by an already-approved presenter version.
  const configured = [...new Set(ids.map(String))].map(id => ownedMaterial(records, id, tenantId));
  const compatible = configured.filter(material => !knownRunwayIncompatibility(material));
  if (!compatible.length) throw new Error('企业人物绑定的素材均不符合 Runway Act-Two 输入要求');
  return compatible.sort((left, right) => {
    const leftKnown = numericAspectRatio(left) !== undefined && Number(left.sizeBytes) > 0 ? 0 : 1;
    const rightKnown = numericAspectRatio(right) !== undefined && Number(right.sizeBytes) > 0 ? 0 : 1;
    const typeOrder = (value: MaterialRecord) => value.type === 'image' ? 0 : 1;
    const leftId = String(left.id); const rightId = String(right.id);
    return leftKnown - rightKnown || typeOrder(left) - typeOrder(right) || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
  })[0]!;
}

export async function prepareRunwayReferenceInputs(input: { shot: ShotProduction; presenter: PresenterAsset; tenantId: string }, overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults(), ...overrides }; const records = deps.materials();
  const reference = input.shot.digitalHuman?.reference;
  if (!reference?.materialId) throw new Error('请先从素材库绑定当前分镜的参考视频');
  const duration = Number(reference.end) - Number(reference.start);
  if (!Number.isFinite(duration) || duration < 3 || duration > 30) throw new Error('Runway Act-Two 参考片段须为 3–30 秒');
  const presenterIds = input.presenter.toolMappings?.runway?.referenceMaterialIds || input.presenter.referenceMaterialIds || [];
  if (!presenterIds.length) throw new Error('企业人物尚未绑定 Runway 参考图片或视频');
  const character = selectRunwayCharacterMaterial(records, presenterIds.map(String), input.tenantId);
  const characterObject = await deps.head(String(character.objectKey));
  if (!characterObject?.size) throw new Error('Runway 企业人物对象不存在或为空');
  if (!String(characterObject.contentType || '').toLowerCase().startsWith(`${character.type}/`)) throw new Error('Runway 企业人物对象类型与素材记录不一致');
  const characterLimit = RUNWAY_CHARACTER_MAX_BYTES[String(character.type) as keyof typeof RUNWAY_CHARACTER_MAX_BYTES];
  if (characterObject.size > characterLimit) throw new Error(`Runway 企业人物${character.type === 'image' ? '图片' : '视频'}超过输入大小上限`);
  if (!String(characterObject.etag || '').trim()) throw new Error('Runway 企业人物对象缺少版本标识');
  const source = ownedMaterial(records, reference.materialId, input.tenantId, 'video');
  if (!deps.ffmpegPath) throw new Error('参考视频裁切服务不可用');
  const sourceObject = await deps.head(String(source.objectKey));
  if (!sourceObject?.size || !String(sourceObject.contentType || '').toLowerCase().startsWith('video/')) throw new Error('Runway 原片对象不存在、为空或类型无效');
  if (!String(sourceObject.etag || '').trim()) throw new Error('Runway 原片对象缺少版本标识');
  const identity = createHash('sha256').update(`${source.objectKey}:${sourceObject.etag}:${Number(reference.start).toFixed(3)}:${Number(reference.end).toFixed(3)}:runway-act-two-v2`).digest('hex').slice(0, 32);
  const clipKey = tenantPrivateObjectKey('runway-reference', input.tenantId, `${identity}.mp4`);
  let existingClip = await deps.head(clipKey);
  if (existingClip && (!existingClip.size || existingClip.size > RUNWAY_CHARACTER_MAX_BYTES.video)) throw new Error('Runway 参考片段为空或超过 32 MB 输入上限');
  if (existingClip && !String(existingClip.contentType || '').toLowerCase().startsWith('video/')) throw new Error('Runway 参考片段对象类型无效');
  if (!existingClip) {
    const original = await deps.download(String(source.objectKey));
    if (!original?.buf.length) throw new Error('参考视频对象不存在或为空');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-reference-'));
    const sourcePath = path.join(dir, 'source'); const clipPath = path.join(dir, 'clip.mp4');
    try {
      fs.writeFileSync(sourcePath, original.buf, { mode: 0o600 });
      await run(deps.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', Number(reference.start).toFixed(3), '-i', sourcePath, '-t', duration.toFixed(3), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-movflags', '+faststart', clipPath]);
      if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size < 1024) throw new Error('参考视频裁切结果为空');
      const clipBytes = fs.statSync(clipPath).size;
      if (clipBytes > RUNWAY_CHARACTER_MAX_BYTES.video) throw new Error('Runway 参考片段超过 32 MB 输入上限');
      await deps.uploadFile({ key: clipKey, filePath: clipPath, contentType: 'video/mp4', contentLength: clipBytes });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    existingClip = await deps.head(clipKey);
  }
  if (!existingClip?.size || !String(existingClip.etag || '').trim()) throw new Error('Runway 参考片段上传后缺少对象版本证据');
  const characterUrl = runwayInputUrl(await deps.sign(String(character.objectKey), 3600));
  const referenceVideoUrl = runwayInputUrl(await deps.sign(clipKey, 3600));
  return { characterUrl, characterType: character.type as 'image' | 'video', characterMaterialId: String(character.id), characterObjectKey: String(character.objectKey), characterObjectEtag: String(characterObject.etag),
    referenceVideoUrl, referenceClipKey: clipKey, referenceClipObjectEtag: String(existingClip.etag), referenceSourceObjectEtag: String(sourceObject.etag),
    referenceMaterialId: reference.materialId, referenceStart: Number(reference.start), referenceDuration: duration };
}
