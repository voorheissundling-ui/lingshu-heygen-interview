import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import { fetchCloudMaterial } from '../lib/cloudMaterials.js';
import { SocialContentWorkflowError, socialText } from './socialContentValidation.js';

const MAX_MATERIAL_BYTES = 110 * 1024 * 1024;
const POCKETBASE_RECORD_ID = /^[a-z0-9]{15}$/;

const MATERIAL_MIME: Record<string, { extension: string; family: 'image' | 'video' }> = {
  'image/jpeg': { extension: 'jpg', family: 'image' },
  'image/png': { extension: 'png', family: 'image' },
  'image/webp': { extension: 'webp', family: 'image' },
  'video/mp4': { extension: 'mp4', family: 'video' },
  'video/quicktime': { extension: 'mov', family: 'video' },
  'video/webm': { extension: 'webm', family: 'video' },
};

const EXTENSION_MIME: Record<string, keyof typeof MATERIAL_MIME> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export interface SocialContentCloudMaterialPort {
  fetch(input: { tenantId: string; recordId: string }): Promise<Response | null>;
}

const defaultCloudMaterialPort: SocialContentCloudMaterialPort = {
  // `videoFile` is the historical field name for every original material,
  // including still images. `posterFile` can be a generated placeholder.
  fetch: input => fetchCloudMaterial(input.recordId, 'videoFile', undefined, input.tenantId),
};

export type MaterializedSocialContentMaterial = {
  url: string;
  localPath: string;
  cloudRecordId: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
};

/**
 * Resolve only the canonical server-produced identity. A URL, filename or
 * display label is never accepted as an authority for a PocketBase read.
 */
export function socialContentCloudMaterialRecordId(record: MaterialRecord): string {
  const viewId = socialText(record.id).match(/^pb-([a-z0-9]{15})$/)?.[1] || '';
  const explicitId = socialText(record.cloudRecordId);
  if (!viewId || (explicitId && explicitId !== viewId)) return '';
  return POCKETBASE_RECORD_ID.test(explicitId || viewId) ? (explicitId || viewId) : '';
}

function responseMimeType(record: MaterialRecord, response: Response): string {
  const header = socialText(response.headers.get('content-type')).toLowerCase().split(';', 1)[0];
  if (MATERIAL_MIME[header]) return header;
  // PocketBase/object-store proxies may legitimately omit a MIME type. The
  // stored filename is only used to select an allowlisted decoder; it is never
  // used as a path or network destination.
  if (!header || header === 'application/octet-stream') {
    return EXTENSION_MIME[path.extname(socialText(record.file)).toLowerCase()] || '';
  }
  return '';
}

function materialAccessError(code = 'social_content_material_unavailable', status = 422): SocialContentWorkflowError {
  return new SocialContentWorkflowError(code, status);
}

async function* responseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = body.getReader();
  let complete = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        return;
      }
      yield Buffer.from(item.value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Fetch a PocketBase material through the tenant-aware backend port and copy
 * it into the render's OS-temporary workspace. The caller owns that workspace
 * and must remove it in a finally block (withSocialContentRenderWorkspace does).
 */
export async function materializeSocialContentCloudMaterial(input: {
  tenantId: string;
  record: MaterialRecord;
  type: 'image' | 'video';
  outputDirectory: string;
  index: number;
  port?: SocialContentCloudMaterialPort;
}): Promise<MaterializedSocialContentMaterial> {
  const recordId = socialContentCloudMaterialRecordId(input.record);
  if (!recordId || !input.tenantId.trim()) throw materialAccessError('social_content_material_identity_invalid', 409);

  const root = path.resolve(input.outputDirectory);
  let rootStat: Awaited<ReturnType<typeof fsp.stat>>;
  try { rootStat = await fsp.stat(root); }
  catch { throw materialAccessError('social_content_material_workspace_invalid', 503); }
  if (!rootStat.isDirectory()) throw materialAccessError('social_content_material_workspace_invalid', 503);

  const response = await (input.port || defaultCloudMaterialPort).fetch({
    tenantId: input.tenantId,
    recordId,
  });
  if (!response?.ok || !response.body) throw materialAccessError();

  const mimeType = responseMimeType(input.record, response);
  const media = MATERIAL_MIME[mimeType];
  if (!media || media.family !== input.type) throw materialAccessError('social_content_material_content_invalid', 415);

  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MATERIAL_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw materialAccessError('social_content_material_too_large', 413);
  }

  const filename = `pb-material-${Math.max(0, Math.floor(input.index))}-${recordId}.${media.extension}`;
  const localPath = path.resolve(root, filename);
  if (!localPath.startsWith(`${root}${path.sep}`)) throw materialAccessError('social_content_material_workspace_invalid', 503);

  let byteSize = 0;
  const hash = createHash('sha256');
  const headerChunks: Buffer[] = [];
  let headerBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > MAX_MATERIAL_BYTES) {
        callback(Object.assign(new Error('material too large'), { code: 'SOCIAL_MATERIAL_TOO_LARGE' }));
        return;
      }
      hash.update(chunk);
      if (headerBytes < 16) {
        const part = chunk.subarray(0, Math.min(chunk.length, 16 - headerBytes));
        headerChunks.push(part);
        headerBytes += part.length;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(responseChunks(response.body), limiter, fs.createWriteStream(localPath, { flags: 'wx', mode: 0o600 }));
    if (!byteSize || (declaredLength > 0 && byteSize !== declaredLength)) {
      throw materialAccessError('social_content_material_integrity_violation', 503);
    }
    const header = Buffer.concat(headerChunks);
    const magicValid = mimeType === 'image/jpeg' ? header[0] === 0xff && header[1] === 0xd8
      : mimeType === 'image/png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === 'image/webp' ? header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP'
          : mimeType === 'video/webm' ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
            : header.subarray(4, 8).toString('ascii') === 'ftyp';
    if (!magicValid) throw materialAccessError('social_content_material_content_invalid', 415);

    const sha256 = hash.digest('hex');
    const expectedHash = socialText(input.record.contentSha256 || input.record.sha256).toLowerCase();
    if (expectedHash && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== sha256)) {
      throw materialAccessError('social_content_material_integrity_violation', 503);
    }
    const expectedSize = Number(input.record.sizeBytes || 0);
    if (Number.isSafeInteger(expectedSize) && expectedSize > 0 && expectedSize !== byteSize) {
      throw materialAccessError('social_content_material_integrity_violation', 503);
    }
    return { url: localPath, localPath, cloudRecordId: recordId, mimeType, byteSize, sha256 };
  } catch (error) {
    await fsp.rm(localPath, { force: true }).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === 'SOCIAL_MATERIAL_TOO_LARGE') {
      throw materialAccessError('social_content_material_too_large', 413);
    }
    if (error instanceof SocialContentWorkflowError) throw error;
    throw materialAccessError('social_content_material_unavailable', 503);
  }
}
