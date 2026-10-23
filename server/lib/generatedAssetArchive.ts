import {generatedAutomaticMaterialEvidence} from './weeklyAutomaticMaterialProducer.js';
import {weeklyAssetRequirementIdentity} from '../../shared/weeklyAutomaticMaterial.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { GeneratedAssetArchiveInput, GeneratedMaterialMetadata } from '../../shared/contracts/generatedMaterial.js';
import { assertGeneratedMaterialMetadata, qualityAllowsReuse } from '../../shared/contracts/generatedMaterial.js';
import { readLocalMaterials, saveLocalMaterials, type MaterialRecord } from './materialLibrary.js';
import { isTenantPrivateObjectKey, materialContentAddressedObjectKey } from '../storage/materialAssets.js';
import { objectStorageDownload, objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';

interface ArchiveDependencies {
  readMaterials: () => MaterialRecord[];
  saveMaterials: (records: MaterialRecord[]) => void;
  downloadObject: typeof objectStorageDownload;
  headObject: typeof objectStorageHead;
  uploadObject: typeof objectStorageUpload;
  now: () => Date;
}
const defaults = (): ArchiveDependencies => ({ readMaterials: readLocalMaterials, saveMaterials: saveLocalMaterials,
  downloadObject: objectStorageDownload, headObject: objectStorageHead, uploadObject: objectStorageUpload, now: () => new Date() });
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const extensionFor = (mime: string) => ({ 'video/mp4': '.mp4', 'video/webm': '.webm', 'image/png': '.png', 'image/jpeg': '.jpg',
  'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a' }[mime.toLowerCase()] || '.bin');

function metadataOf(input: GeneratedAssetArchiveInput, existing?: MaterialRecord): GeneratedMaterialMetadata {
  const eligible = qualityAllowsReuse(input.quality);
  const metadata: GeneratedMaterialMetadata = {
    generation: input.generation, lineage: input.lineage, quality: input.quality,
    reuse: { eligible, reason: eligible ? 'quality_accepted' : `quality_${input.quality.state}`,
      usageCount: Number(existing?.reuse?.usageCount || 0), ...(existing?.reuse?.lastUsedAt ? { lastUsedAt: existing.reuse.lastUsedAt } : {}) },
    rightsScope: input.rightsScope,
  };
  assertGeneratedMaterialMetadata(metadata);
  return metadata;
}

function assertInput(input: GeneratedAssetArchiveInput): void {
  if (!String(input.tenantId || '').trim()) throw new Error('生成素材缺少 tenantId');
  const digest = input.media.contentSha256.toLowerCase();
  if (!validHash(digest)) throw new Error('生成素材内容哈希无效');
  if (!/^\w+[\w.+-]*\/[\w.+-]+$/i.test(input.media.mimeType)) throw new Error('生成素材 MIME 类型无效');
  if (!input.media.localPath && !input.media.objectKey) throw new Error('生成素材缺少可读取媒体');
  metadataOf(input);
}

async function bytesFrom(input: GeneratedAssetArchiveInput, deps: ArchiveDependencies): Promise<Buffer> {
  if (input.media.localPath) {
    const file = path.resolve(input.media.localPath);
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size <= 0) throw new Error('生成素材本地文件无效');
    return fs.promises.readFile(file);
  }
  const key = String(input.media.objectKey);
  if (!isTenantPrivateObjectKey(key, input.tenantId)) throw new Error('生成素材对象不属于当前租户');
  const downloaded = await deps.downloadObject(key);
  if (!downloaded?.buf.length) throw new Error('生成素材对象无法读取');
  return downloaded.buf;
}

function storedAutomaticEvidenceIdentity(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  try {
    return weeklyAssetRequirementIdentity({
      subjectRef: String(evidence.subjectRef || ''),
      action: String(evidence.action || ''),
      scene: String(evidence.scene || ''),
      evidenceRequirement: String(evidence.evidenceRequirement || ''),
      aspectRatio: String(evidence.aspectRatio || ''),
      minimumDurationSeconds: Number(evidence.minimumDurationSeconds),
      authorizationScope: String(evidence.authorizationScope || ''),
    });
  } catch {
    return null;
  }
}

function mergeAutomaticMaterialEvidence(
  existing: MaterialRecord | undefined,
  input: GeneratedAssetArchiveInput,
  digest: string,
): unknown {
  const provenance = existing?.provenance && typeof existing.provenance === 'object'
    ? existing.provenance as Record<string, unknown>
    : {};
  const prior = provenance.weeklyAutomaticMaterialEvidence;
  const next = generatedAutomaticMaterialEvidence(input, digest);
  if (!next) return prior;
  const nextIdentity = weeklyAssetRequirementIdentity(input.automaticMaterial!.requirement);
  const accumulated = (Array.isArray(prior) ? prior : prior == null ? [] : [prior])
    .filter(evidence => storedAutomaticEvidenceIdentity(evidence) !== nextIdentity);
  return [...accumulated, next];
}

function mergeProvenance(
  existing: MaterialRecord | undefined,
  input: GeneratedAssetArchiveInput,
  digest: string,
): Record<string, unknown> {
  const provenance = existing?.provenance && typeof existing.provenance === 'object'
    ? existing.provenance as Record<string, unknown>
    : {};
  const evidence = mergeAutomaticMaterialEvidence(existing, input, digest);
  return evidence === undefined
    ? { ...provenance }
    : { ...provenance, weeklyAutomaticMaterialEvidence: evidence };
}

function mergeRecord(existing: MaterialRecord | undefined, input: GeneratedAssetArchiveInput, metadata: GeneratedMaterialMetadata,
  storage: { objectKey: string; objectEtag?: string }, now: string): MaterialRecord {
  const digest = input.media.contentSha256.toLowerCase();
  const id = existing?.id || `generated-${createHash('sha256').update(`${input.tenantId}:${digest}`).digest('hex').slice(0, 24)}`;
  return {
    ...existing, id, tenantId: input.tenantId, scope: 'own', folder: existing?.folder || 'generated',
    name: input.name || existing?.name || `AI 生成${input.media.type === 'video' ? '视频' : input.media.type === 'image' ? '图片' : '音频'}`,
    type: input.media.type, mimeType: input.media.mimeType, duration: input.media.duration ?? existing?.duration ?? 0,
    ...(input.media.width ? { width: input.media.width } : {}), ...(input.media.height ? { height: input.media.height } : {}),
    contentSha256: digest, objectKey: storage.objectKey, objectEtag: storage.objectEtag || existing?.objectEtag,
    url: existing?.url || '', sourceType: existing?.sourceType || 'ai-generated',
    generation: metadata.generation, lineage: metadata.lineage, quality: metadata.quality, reuse: metadata.reuse,
    rightsScope: metadata.rightsScope, generationState: 'archived',
    provenance: mergeProvenance(existing, input, digest),
    createdAt: existing?.createdAt || now, updatedAt: now,
  };
}

export function createGeneratedAssetArchiveService(overrides: Partial<ArchiveDependencies> = {}) {
  const deps = { ...defaults(), ...overrides };
  return {
    async archiveNewMedia(input: GeneratedAssetArchiveInput): Promise<MaterialRecord> {
      assertInput(input);
      const bytes = await bytesFrom(input, deps);
      const digest = sha256(bytes);
      if (digest !== input.media.contentSha256.toLowerCase()) throw new Error('生成素材内容哈希与文件不一致');
      const records = deps.readMaterials();
      const existing = records.find(item => String(item.tenantId || item.tenant_id || '') === input.tenantId
        && String(item.contentSha256 || '').toLowerCase() === digest);
      const filename = `${digest}${extensionFor(input.media.mimeType)}`;
      const objectKey = materialContentAddressedObjectKey(input.tenantId, digest, filename);
      let head = await deps.headObject(objectKey);
      if (!head) {
        await deps.uploadObject({ key: objectKey, body: bytes, contentType: input.media.mimeType });
        head = await deps.headObject(objectKey);
      }
      if (!head || head.size !== bytes.length) throw new Error('生成素材持久化校验失败');
      const metadata = metadataOf(input, existing);
      const record = mergeRecord(existing, input, metadata, { objectKey, objectEtag: head.etag }, deps.now().toISOString());
      const next = existing ? records.map(item => item.id === existing.id ? record : item) : [...records, record];
      deps.saveMaterials(next);
      return record;
    },

    async attachExistingMaterial(materialId: string, input: GeneratedAssetArchiveInput): Promise<MaterialRecord> {
      assertInput(input);
      const records = deps.readMaterials();
      const index = records.findIndex(item => item.id === materialId && String(item.tenantId || item.tenant_id || '') === input.tenantId);
      if (index < 0) throw new Error('待归档素材不存在或不属于当前租户');
      const existing = records[index]!;
      if (String(existing.contentSha256 || '').toLowerCase() !== input.media.contentSha256.toLowerCase()) throw new Error('待归档素材内容版本不一致');
      const bytes = await bytesFrom({ ...input, media: { ...input.media,
        localPath: input.media.localPath || (existing.file ? path.resolve(process.cwd(), 'data/media', String(existing.file)) : undefined),
        objectKey: input.media.objectKey || existing.objectKey } }, deps);
      if (sha256(bytes) !== input.media.contentSha256.toLowerCase()) throw new Error('待归档素材内容哈希校验失败');
      const metadata = metadataOf(input, existing);
      const record = { ...existing, generation: metadata.generation, lineage: metadata.lineage, quality: metadata.quality,
        reuse: metadata.reuse, rightsScope: metadata.rightsScope, generationState: 'archived',
        provenance: mergeProvenance(existing, input, input.media.contentSha256.toLowerCase()), updatedAt: deps.now().toISOString() };
      records[index] = record;
      deps.saveMaterials(records);
      return record;
    },
  };
}

export const generatedAssetArchive = createGeneratedAssetArchiveService();
