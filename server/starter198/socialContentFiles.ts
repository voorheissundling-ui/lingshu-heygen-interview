import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SocialContentFile } from '../../shared/contracts/socialContentWorkflow.js';
import type { UpsertSocialTaskCloudMaterialInput } from '../lib/cloudMaterials.js';
import { upsertSocialTaskMaterial, type MaterialRecord } from '../lib/materialLibrary.js';
import {
  materialAssetObjectKey,
  materialAssetTenantKey,
  materialAssetTypeAllowed,
  tenantPrivateObjectKey,
} from '../storage/materialAssets.js';
import { currentDataAuthority } from '../storage/dataAuthority.js';
import { objectStorageEnabled, objectStorageDownload, objectStorageGetObject, objectStorageHead, objectStorageUploadFile } from '../storage/objectStorage.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import { socialTaskFileCapacity } from './socialContentLimits.js';
import { generatedAssetArchive } from '../lib/generatedAssetArchive.js';
import type { GeneratedAssetArchiveInput } from '../../shared/contracts/generatedMaterial.js';
import { requireSocialTask } from './socialContentRecords.js';
import { withSocialContentUploadAdmission } from './socialContentFileAdmission.js';
export { MAX_CONCURRENT_SOCIAL_CONTENT_UPLOADS, withSocialContentUploadAdmission } from './socialContentFileAdmission.js';
import {
  MIME_EXTENSIONS, defaultBackendFilePort, defaultSocialTaskMaterialPort,
  magicAllowed, mime, safeName, socialContentFileDownloadUrl,
  type SocialContentBackendFilePort, type SocialTaskMaterialPort, type StoredSocialContentFile,
} from './socialContentFilePrimitives.js';
export type { SocialContentBackendFilePort, SocialTaskMaterialPort, StoredSocialContentFile } from './socialContentFilePrimitives.js';
export { cleanupTransientSocialContentUpload, durableSocialContentFileDescriptor, socialContentFileDownloadUrl } from './socialContentFilePrimitives.js';
import {
  SocialContentWorkflowError,
  socialPublicId,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';

export const MAX_SOCIAL_CONTENT_FILE_BYTES = 110 * 1024 * 1024;
const ROOT = path.resolve(process.cwd(), 'data', 'social-content-sources');
const TEMP = path.join(os.tmpdir(), 'lingshu-social-content-upload');
const BACKEND_FILE_FIELD = 'backend_file';

export async function storeSocialContentFile(input: {
  stream: Readable;
  tenantId: string;
  name: string;
  mimeType: string;
  declaredLength?: number;
  maximumBytes?: number;
  materialLibrary?: boolean;
}): Promise<StoredSocialContentFile> {
  const name = safeName(input.name);
  const mimeType = mime(input.mimeType);
  const maximumBytes = Math.min(MAX_SOCIAL_CONTENT_FILE_BYTES, Math.max(0, Math.floor(input.maximumBytes ?? MAX_SOCIAL_CONTENT_FILE_BYTES)));
  if (maximumBytes < 1 || (Number.isFinite(input.declaredLength) && Number(input.declaredLength) > maximumBytes)) {
    throw new SocialContentWorkflowError('social_content_file_too_large', 413);
  }
  await fsp.mkdir(TEMP, { recursive: true });
  const temporary = path.join(TEMP, `${socialPublicId('upload')}.part`);
  let retainTemporary = false;
  let byteSize = 0;
  const hash = createHash('sha256');
  const header: Buffer[] = [];
  let headerBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > maximumBytes) {
        callback(Object.assign(new Error('file too large'), { code: 'SOCIAL_FILE_TOO_LARGE' }));
        return;
      }
      hash.update(chunk);
      if (headerBytes < 512) {
        const part = chunk.subarray(0, Math.min(chunk.length, 512 - headerBytes));
        header.push(part);
        headerBytes += part.length;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(input.stream, limiter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (!byteSize || !magicAllowed(mimeType, Buffer.concat(header))) {
      throw new SocialContentWorkflowError('social_content_file_content_invalid', 415);
    }
    const sha256 = hash.digest('hex');
    const storedName = `${sha256}.${MIME_EXTENSIONS[mimeType]}`;
    if (objectStorageEnabled()) {
      // Creative task uploads are the same bytes shown in "My Materials".
      // Store one tenant-private object and let both records reference it;
      // documents remain in the task-only namespace.
      const storageKey = input.materialLibrary && materialAssetTypeAllowed(mimeType)
        ? materialAssetObjectKey(input.tenantId, storedName)
        : tenantPrivateObjectKey('social-content-sources', input.tenantId, storedName);
      const current = await objectStorageHead(storageKey);
      if (!current || current.size !== byteSize || current.contentType !== mimeType) {
        await objectStorageUploadFile({ key: storageKey, filePath: temporary, contentType: mimeType, contentLength: byteSize });
        const verified = await objectStorageHead(storageKey);
        if (!verified || verified.size !== byteSize) throw new SocialContentWorkflowError('social_content_file_storage_unavailable', 503);
      }
      return { storageKind: 'object', storageKey, name, mimeType, byteSize, sha256 };
    }
    // Existing integration tests exercise legacy records without a live
    // PocketBase. Production and local development never take this branch.
    if (process.env.NODE_ENV === 'test' && process.env.SOCIAL_CONTENT_FORCE_BACKEND_FILES !== 'true') {
      const tenantDirectory = path.join(ROOT, materialAssetTenantKey(input.tenantId));
      await fsp.mkdir(tenantDirectory, { recursive: true });
      const finalPath = path.join(tenantDirectory, storedName);
      try { await fsp.link(temporary, finalPath); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error; }
      return {
        storageKind: 'local', storageKey: path.posix.join(materialAssetTenantKey(input.tenantId), storedName),
        name, mimeType, byteSize, sha256,
      };
    }
    // PocketBase owns the durable bytes when external object storage is not
    // configured. Keep the streamed request only in the OS temp directory
    // until registerSocialContentFile attaches it to the backend file field.
    retainTemporary = true;
    return {
      storageKind: 'backend_file',
      storageKey: storedName,
      name,
      mimeType,
      byteSize,
      sha256,
      transientPath: temporary,
    };
  } catch (error) {
    if (error instanceof SocialContentWorkflowError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === 'SOCIAL_FILE_TOO_LARGE') {
      throw new SocialContentWorkflowError('social_content_file_too_large', 413);
    }
    throw new SocialContentWorkflowError('social_content_file_upload_failed', 400);
  } finally {
    if (!retainTemporary) await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Validate and describe a renderer-owned temporary output without copying it
 * into an application data directory. registerSocialContentFile consumes this
 * descriptor and attaches the exact bytes to the backend record's file field.
 */
export async function inspectTransientSocialContentFile(input: {
  filePath: string;
  name: string;
  mimeType: string;
  maximumBytes?: number;
}): Promise<StoredSocialContentFile> {
  const name = safeName(input.name);
  const mimeType = mime(input.mimeType);
  const maximumBytes = Math.min(
    MAX_SOCIAL_CONTENT_FILE_BYTES,
    Math.max(0, Math.floor(input.maximumBytes ?? MAX_SOCIAL_CONTENT_FILE_BYTES)),
  );
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(input.filePath);
  } catch {
    throw new SocialContentWorkflowError('social_content_file_not_found', 404);
  }
  if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) {
    throw new SocialContentWorkflowError(
      stat.size > maximumBytes ? 'social_content_file_too_large' : 'social_content_file_content_invalid',
      stat.size > maximumBytes ? 413 : 415,
    );
  }
  const handle = await fsp.open(input.filePath, 'r');
  try {
    const header = Buffer.alloc(Math.min(512, stat.size));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!magicAllowed(mimeType, header.subarray(0, bytesRead))) {
      throw new SocialContentWorkflowError('social_content_file_content_invalid', 415);
    }
  } finally {
    await handle.close();
  }
  const sha256 = await sha256File(input.filePath);
  return {
    storageKind: 'backend_file',
    storageKey: `${sha256}.${MIME_EXTENSIONS[mimeType]}`,
    name,
    mimeType,
    byteSize: stat.size,
    sha256,
  };
}

/**
 * Persist a renderer-owned output using the same tenant-private object store as
 * ordinary task uploads. Local development's object-store driver writes to
 * disk; production uses the configured remote object store. When no object
 * store is available, the caller can still attach the inspected transient file
 * to the backend record field.
 */
export async function storeTransientSocialContentFile(input: {
  filePath: string;
  tenantId: string;
  name: string;
  mimeType: string;
  maximumBytes?: number;
}): Promise<StoredSocialContentFile> {
  const inspected = await inspectTransientSocialContentFile(input);
  if (!objectStorageEnabled()) return inspected;

  const storageKey = tenantPrivateObjectKey(
    'social-content-sources',
    input.tenantId,
    inspected.storageKey,
  );
  const current = await objectStorageHead(storageKey);
  if (!current
    || current.size !== inspected.byteSize
    || current.contentType !== inspected.mimeType) {
    await objectStorageUploadFile({
      key: storageKey,
      filePath: input.filePath,
      contentType: inspected.mimeType,
      contentLength: inspected.byteSize,
    });
  }
  const verified = await objectStorageHead(storageKey);
  if (!verified
    || verified.size !== inspected.byteSize
    || verified.contentType !== inspected.mimeType) {
    throw new SocialContentWorkflowError('social_content_file_storage_unavailable', 503);
  }
  return { ...inspected, storageKind: 'object', storageKey };
}

function creativeMaterialType(mimeType: string): 'video' | 'image' | 'audio' | null {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function upsertLocalSocialTaskCreativeMaterial(input: {
  tenantId: string;
  taskId: string;
  productId?: string | null;
  productRef?: string | null;
  file: SocialContentFile;
  stored: StoredSocialContentFile;
  type: 'video' | 'image' | 'audio';
}): MaterialRecord {
  const timestamp = input.file.createdAt || new Date().toISOString();
  const productId = String(input.productId || '').trim();
  const productRef = String(input.productRef || '').trim();
  const record: MaterialRecord = {
    id: `social-${createHash('sha256').update(`${input.tenantId}\0${input.file.sha256}`).digest('hex').slice(0, 32)}`,
    name: input.file.name,
    folder: '任务素材',
    type: input.type,
    duration: 0,
    size: humanFileSize(input.file.size),
    sizeBytes: input.file.size,
    file: path.basename(input.stored.storageKey),
    url: input.file.downloadUrl,
    ...(input.type === 'image' ? { poster: input.file.downloadUrl } : {}),
    ...(input.stored.storageKind === 'object' ? {
      objectKey: input.stored.storageKey,
      ...(input.type === 'image' ? { posterObjectKey: input.stored.storageKey } : {}),
    } : {}),
    scope: 'own',
    tenantId: input.tenantId,
    usage: 'editable',
    sourceType: 'social_task_upload',
    sourceName: input.file.name,
    sourceProvider: 'tenant',
    licenseEvidence: 'tenant_upload_unverified',
    sourceTaskId: input.taskId,
    sourceFileRef: input.file.fileRef,
    contentSha256: input.file.sha256,
    sha256: input.file.sha256,
    sourceRevision: input.file.sha256,
    productId,
    ...(productRef ? { productRef, productName: productRef } : {}),
    createdAt: timestamp,
  };
  return upsertSocialTaskMaterial({
    id: record.id,
    tenantId: input.tenantId,
    taskId: input.taskId,
    taskFileRef: input.file.fileRef,
    contentSha256: input.file.sha256,
    productId,
    productRef,
    productName: productRef,
    record,
  });
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Bridge a user-provided task source into the canonical creative inventory.
 * PDF/office/text evidence never reaches this function because it has no
 * creative media type. Task-file ownership remains authoritative for reads.
 */
export async function registerSocialTaskCreativeMaterial(input: {
  tenantId: string;
  taskId: string;
  productId?: string | null;
  productRef?: string | null;
  file: SocialContentFile;
  stored: StoredSocialContentFile;
  transientPath?: string;
  materialPort?: SocialTaskMaterialPort;
}): Promise<Record<string, any> | null> {
  const type = creativeMaterialType(input.file.mimeType);
  if (!type) return null;
  if (input.file.sha256 !== input.stored.sha256) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
  let media: UpsertSocialTaskCloudMaterialInput['media'];
  if (input.stored.storageKind === 'backend_file') {
    if (!input.transientPath) throw new SocialContentWorkflowError('social_content_material_storage_unavailable', 503);
    media = { name: path.basename(input.stored.storageKey), contentType: input.file.mimeType, path: input.transientPath };
  } else if (input.stored.storageKind === 'object') {
    const object = await objectStorageDownload(input.stored.storageKey);
    if (!object?.buf.length || createHash('sha256').update(object.buf).digest('hex') !== input.stored.sha256) {
      throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
    }
    media = { name: path.basename(input.stored.storageKey), contentType: input.file.mimeType, buf: object.buf };
  } else {
    // Backward-compatible migration path for task files created before the PB
    // file field became authoritative. New uploads never write this directory.
    const source = path.resolve(ROOT, input.stored.storageKey);
    if (!source.startsWith(`${ROOT}${path.sep}`) || await sha256File(source) !== input.stored.sha256) {
      throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
    }
    media = { name: path.basename(input.stored.storageKey), contentType: input.file.mimeType, path: source };
  }
  const materialInput: UpsertSocialTaskCloudMaterialInput = {
    tenantId: input.tenantId,
    taskId: input.taskId,
    taskFileRef: input.file.fileRef,
    sha256: input.file.sha256,
    productRef: input.productRef,
    productName: input.productRef || undefined,
    title: input.file.name,
    type,
    duration: 0,
    sizeBytes: input.file.size,
    // Keep the Enterprise Center stable ID separate from the display name so
    // later material matching cannot confuse an identifier with user-facing
    // product text.
    productId: input.productId || '',
    media,
  };
  try {
    return await (input.materialPort ?? defaultSocialTaskMaterialPort).upsert(materialInput);
  } catch (error) {
    // Local-authenticated development requests are intentionally forbidden
    // from touching PocketBase. Keep the already-durable task file canonical
    // and index it in the local material library instead. Production must stay
    // fail-closed so an unavailable material database is never hidden.
    if (process.env.NODE_ENV === 'production' || currentDataAuthority() !== 'local') throw error;
    return upsertLocalSocialTaskCreativeMaterial({ ...input, type });
  }
}

export function socialContentFileView(record: StarterRecord): SocialContentFile {
  const fileId = socialText(record.file_id);
  const usage = socialText(record.usage) as SocialContentFile['usage'];
  const size = Number(record.byte_size);
  const sha256 = socialText(record.content_sha256);
  if (!fileId || !['source', 'metric_evidence', 'artifact_media'].includes(usage) || !Number.isSafeInteger(size) || size < 1
    || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new SocialContentWorkflowError('social_content_file_record_invalid', 503);
  }
  return {
    fileId,
    taskId: socialText(record.task_id),
    usage,
    fileRef: `socialfile:${fileId}`,
    name: socialText(record.name),
    mimeType: socialText(record.mime_type),
    size,
    sha256,
    createdAt: socialText(record.created_at),
    downloadUrl: socialContentFileDownloadUrl(fileId),
  };
}

export async function findSocialContentFile(input: {
  repository: Starter198Repository;
  tenantId: string;
  fileId: string;
  taskId?: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentFiles, input.tenantId, {
    where: { file_id: input.fileId, ...(input.taskId ? { task_id: input.taskId } : {}) }, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  return result.items[0] ?? null;
}

async function fileByContent(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  usage: SocialContentFile['usage'];
  sha256: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentFiles, input.tenantId, {
    where: { task_id: input.taskId, usage: input.usage, content_sha256: input.sha256 },
    perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

function backendFilename(record: StarterRecord): string {
  const value = record[BACKEND_FILE_FIELD];
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && value.length) return socialText(value[0]);
  return socialText(record.storage_kind) === 'backend_file' ? socialText(record.storage_key) : '';
}

async function recoverPendingSocialContentFile(input: {
  repository: Starter198Repository;
  tenantId: string;
  record: StarterRecord;
  stored: StoredSocialContentFile;
}): Promise<void> {
  if (socialText(input.record.storage_kind) !== 'backend_pending'
    || input.stored.storageKind === 'backend_file') return;
  await input.repository.update(
    STARTER_COLLECTIONS.socialContentFiles,
    input.tenantId,
    input.record.id,
    { storage_kind: input.stored.storageKind, storage_key: input.stored.storageKey },
  );
  input.record.storage_kind = input.stored.storageKind;
  input.record.storage_key = input.stored.storageKey;
}

async function assertBackendPayload(input: {
  record: StarterRecord;
  stored: StoredSocialContentFile;
  filename: string;
  backendFilePort: SocialContentBackendFilePort;
}): Promise<void> {
  const downloaded = await input.backendFilePort.fetch({
    collection: STARTER_COLLECTIONS.socialContentFiles,
    recordId: input.record.id,
    filename: input.filename,
  });
  const receivedMime = downloaded?.contentType.toLowerCase().split(';', 1)[0] ?? '';
  // PocketBase sniffs ISO-BMFF files and may serve an uploaded .mp4 as
  // video/quicktime even when the original request correctly declared
  // video/mp4. They share the same validated `ftyp` container family, so this
  // is not a content-type downgrade.
  const mimeMatches = receivedMime === input.stored.mimeType
    || (['video/mp4', 'video/quicktime'].includes(receivedMime)
      && ['video/mp4', 'video/quicktime'].includes(input.stored.mimeType));
  if (!downloaded
    || downloaded.buf.length !== input.stored.byteSize
    || !mimeMatches
    || createHash('sha256').update(downloaded.buf).digest('hex') !== input.stored.sha256) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
}

export async function persistTransientSocialContentBackendFile(input: {
  repository: Starter198Repository;
  tenantId: string;
  record: StarterRecord;
  stored: StoredSocialContentFile;
  transientPath: string;
  backendFilePort: SocialContentBackendFilePort;
}): Promise<void> {
  const inspected = await inspectTransientSocialContentFile({
    filePath: input.transientPath,
    name: input.stored.name,
    mimeType: input.stored.mimeType,
    maximumBytes: input.stored.byteSize,
  });
  if (inspected.byteSize !== input.stored.byteSize || inspected.sha256 !== input.stored.sha256) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }

  let filename = backendFilename(input.record);
  if (filename) {
    try {
      await assertBackendPayload({ ...input, filename });
    } catch {
      filename = '';
    }
  }
  if (!filename) {
    filename = await input.backendFilePort.attach({
      collection: STARTER_COLLECTIONS.socialContentFiles,
      recordId: input.record.id,
      field: BACKEND_FILE_FIELD,
      name: input.stored.storageKey,
      path: input.transientPath,
      contentType: input.stored.mimeType,
    }) ?? '';
    if (!filename) {
      throw new SocialContentWorkflowError('social_content_backend_file_storage_unavailable', 503);
    }
    await assertBackendPayload({ ...input, filename });
  }
  await input.repository.update(STARTER_COLLECTIONS.socialContentFiles, input.tenantId, input.record.id, {
    storage_kind: 'backend_file',
    storage_key: filename,
  });
}

export async function registerSocialContentFile(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  usage: SocialContentFile['usage'];
  idempotencyKey: string;
  stored: StoredSocialContentFile;
  transientPath?: string;
  backendFilePort?: SocialContentBackendFilePort;
  now?: Date;
}): Promise<SocialContentFile> {
  const isBackendFile = input.stored.storageKind === 'backend_file';
  if (isBackendFile !== Boolean(input.transientPath)) {
    throw new SocialContentWorkflowError('social_content_backend_file_input_invalid', 500);
  }
  const backendFilePort = input.backendFilePort ?? defaultBackendFilePort;
  await requireSocialTask(input);
  const mutation = await executeSocialContentMutation<{ file: SocialContentFile }>({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash({ taskId: input.taskId, usage: input.usage, ...input.stored }),
    operation: 'upload_social_content_file',
    targetId: input.taskId,
    now: input.now,
    replay: async () => {
      const existing = await fileByContent({ ...input, sha256: input.stored.sha256 });
      if (!existing) {
        throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
      }
      return { file: socialContentFileView(existing) };
    },
    action: async operationId => {
      const existing = await input.repository.list(STARTER_COLLECTIONS.socialContentFiles, input.tenantId, {
        where: { last_operation_id: operationId }, perPage: 2,
      });
      if (existing.totalItems > 1 || existing.items.length > 1) {
        throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
      }
      if (existing.items[0]) {
        if (isBackendFile) {
          await persistTransientSocialContentBackendFile({
            repository: input.repository,
            tenantId: input.tenantId,
            record: existing.items[0],
            stored: input.stored,
            transientPath: input.transientPath!,
            backendFilePort,
          });
        } else {
          await recoverPendingSocialContentFile({
            repository: input.repository,
            tenantId: input.tenantId,
            record: existing.items[0],
            stored: input.stored,
          });
        }
        return { file: socialContentFileView(existing.items[0]) };
      }
      const duplicate = await fileByContent({ ...input, sha256: input.stored.sha256 });
      if (duplicate) {
        if (isBackendFile) {
          await persistTransientSocialContentBackendFile({
            repository: input.repository,
            tenantId: input.tenantId,
            record: duplicate,
            stored: input.stored,
            transientPath: input.transientPath!,
            backendFilePort,
          });
        } else {
          await recoverPendingSocialContentFile({
            repository: input.repository,
            tenantId: input.tenantId,
            record: duplicate,
            stored: input.stored,
          });
        }
        return { file: socialContentFileView(duplicate) };
      }
      const capacity = await socialTaskFileCapacity(input);
      if (input.stored.byteSize > capacity.remainingBytes) {
        throw new SocialContentWorkflowError('social_content_file_task_bytes_exceeded', 413);
      }
      const timestamp = (input.now ?? new Date()).toISOString();
      const created = await input.repository.create(STARTER_COLLECTIONS.socialContentFiles, input.tenantId, {
        file_id: socialPublicId('socialfile'),
        task_id: input.taskId,
        usage: input.usage,
        name: input.stored.name,
        mime_type: input.stored.mimeType,
        byte_size: input.stored.byteSize,
        content_sha256: input.stored.sha256,
        storage_kind: isBackendFile ? 'backend_pending' : input.stored.storageKind,
        storage_key: input.stored.storageKey,
        last_operation_id: operationId,
        created_by: input.userId,
        created_at: timestamp,
      });
      if (isBackendFile) {
        await persistTransientSocialContentBackendFile({
          repository: input.repository,
          tenantId: input.tenantId,
          record: created,
          stored: input.stored,
          transientPath: input.transientPath!,
          backendFilePort,
        });
      }
      return { file: socialContentFileView(created) };
    },
  });
  return mutation.value.file;
}

/** Join a durable social task file to the reusable generated-material index.
 * The task file remains the artifact's delivery record; the returned material
 * is the cross-task reference used by “我的生成”. */
export async function archiveGeneratedSocialContentFile(input: {
  file: SocialContentFile;
  stored: StoredSocialContentFile;
  archiveMedia?: typeof generatedAssetArchive.archiveNewMedia;
  archive: Omit<GeneratedAssetArchiveInput, 'media'> & {
    media: Omit<GeneratedAssetArchiveInput['media'], 'contentSha256' | 'mimeType' | 'type'> & {
      type: GeneratedAssetArchiveInput['media']['type'];
    };
  };
}): Promise<MaterialRecord> {
  if (input.file.sha256 !== input.stored.sha256) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
  return (input.archiveMedia ?? generatedAssetArchive.archiveNewMedia)({
    ...input.archive,
    media: {
      ...input.archive.media,
      mimeType: input.file.mimeType,
      contentSha256: input.file.sha256,
    },
  });
}

export async function requireOwnedSocialFileRef(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  fileRef: string;
  usage?: SocialContentFile['usage'];
}): Promise<StarterRecord> {
  const match = /^socialfile:(socialfile_[a-f0-9]{24})$/.exec(input.fileRef);
  if (!match) throw new SocialContentWorkflowError('social_content_file_ref_invalid', 400);
  const record = await findSocialContentFile({ ...input, fileId: match[1]! });
  if (!record || (input.usage && socialText(record.usage) !== input.usage)) {
    throw new SocialContentWorkflowError('social_content_file_not_found', 404);
  }
  return record;
}

export async function readSocialContentFile(input: {
  repository: Starter198Repository;
  tenantId: string;
  fileId: string;
  backendFilePort?: SocialContentBackendFilePort;
}): Promise<{
  view: SocialContentFile;
  localPath?: string;
  object?: Awaited<ReturnType<typeof objectStorageGetObject>>;
  backend?: { buf: Buffer; contentType: string };
}> {
  const record = await findSocialContentFile(input);
  if (!record) throw new SocialContentWorkflowError('social_content_file_not_found', 404);
  const view = socialContentFileView(record);
  const kind = socialText(record.storage_kind);
  const key = socialText(record.storage_key);
  if (kind === 'object') {
    const object = await objectStorageGetObject(key);
    if (!object) throw new SocialContentWorkflowError('social_content_file_not_found', 404);
    return { view, object };
  }
  if (kind === 'backend_file') {
    const backend = await (input.backendFilePort ?? defaultBackendFilePort).fetch({
      collection: STARTER_COLLECTIONS.socialContentFiles,
      recordId: record.id,
      filename: key,
    });
    if (!backend) throw new SocialContentWorkflowError('social_content_file_not_found', 404);
    const backendMime = backend.contentType.toLowerCase().split(';', 1)[0];
    if (backend.buf.length !== view.size
      || backendMime !== view.mimeType
      || createHash('sha256').update(backend.buf).digest('hex') !== view.sha256) {
      throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
    }
    return { view, backend };
  }
  if (kind !== 'local' || process.env.NODE_ENV === 'production') {
    throw new SocialContentWorkflowError('social_content_file_storage_unavailable', 503);
  }
  const localPath = path.resolve(ROOT, key);
  let exists = false;
  if (localPath.startsWith(`${ROOT}${path.sep}`)) {
    try { exists = (await fsp.stat(localPath)).isFile(); } catch { exists = false; }
  }
  if (!exists) {
    throw new SocialContentWorkflowError('social_content_file_not_found', 404);
  }
  return { view, localPath };
}

/** Verify that a registered file still points at the immutable, content-addressed bytes. */
export async function assertSocialContentFilePersisted(input: {
  record: StarterRecord;
  tenantId: string;
  backendFilePort?: SocialContentBackendFilePort;
}): Promise<SocialContentFile> {
  if (socialText(input.record.tenant_id) !== input.tenantId) {
    throw new SocialContentWorkflowError('social_content_file_not_found', 404);
  }
  const view = socialContentFileView(input.record);
  const key = socialText(input.record.storage_key);
  const kind = socialText(input.record.storage_kind);
  if (kind !== 'backend_file' && !path.basename(key).startsWith(`${view.sha256}.`)) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
  if (kind === 'backend_file') {
    await assertBackendPayload({
      record: input.record,
      stored: {
        storageKind: 'backend_file',
        storageKey: key,
        name: view.name,
        mimeType: view.mimeType,
        byteSize: view.size,
        sha256: view.sha256,
      },
      filename: key,
      backendFilePort: input.backendFilePort ?? defaultBackendFilePort,
    });
    return view;
  }
  if (kind === 'object') {
    const head = await objectStorageHead(key);
    if (!head || head.size !== view.size || head.contentType !== view.mimeType) {
      throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
    }
    return view;
  }
  if (kind !== 'local' || process.env.NODE_ENV === 'production') {
    throw new SocialContentWorkflowError('social_content_file_storage_unavailable', 503);
  }
  const localPath = path.resolve(ROOT, key);
  if (!localPath.startsWith(`${ROOT}${path.sep}`)) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
  try {
    const stat = await fsp.stat(localPath);
    if (!stat.isFile() || stat.size !== view.size) throw new Error('invalid social file');
  } catch {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
  return view;
}
