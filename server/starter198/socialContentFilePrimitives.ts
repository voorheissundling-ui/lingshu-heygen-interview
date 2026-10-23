import { attachFileFromPath, fetchFile } from '../storage/files.js';
import { upsertSocialTaskCloudMaterial, type UpsertSocialTaskCloudMaterialInput } from '../lib/cloudMaterials.js';
import { SocialContentWorkflowError, socialText } from './socialContentValidation.js';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

const TEMP = path.join(os.tmpdir(), 'lingshu-social-content-upload');
const SOCIAL_CONTENT_API_ROOT = '/api/overseas/starter-198/social-content';

export function socialContentFileDownloadUrl(fileId: string): string {
  return `${SOCIAL_CONTENT_API_ROOT}/files/${encodeURIComponent(fileId)}`;
}

export async function cleanupTransientSocialContentUpload(upload: StoredSocialContentFile): Promise<void> {
  const transientPath = upload.transientPath;
  if (!transientPath) return;
  const resolved = path.resolve(transientPath);
  const root = path.resolve(TEMP);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new SocialContentWorkflowError('social_content_file_integrity_violation', 503);
  }
  await fsp.rm(resolved, { force: true });
}

export function durableSocialContentFileDescriptor(upload: StoredSocialContentFile): StoredSocialContentFile {
  const { transientPath: _transientPath, ...stored } = upload;
  return stored;
}

export const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

export interface StoredSocialContentFile {
  storageKind: 'local' | 'object' | 'backend_file';
  storageKey: string;
  name: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  /** OS-temp producer input. Never write this path into a backend record. */
  transientPath?: string;
}

export interface SocialContentBackendFilePort {
  attach(input: { collection: string; recordId: string; field: string; name: string; path: string; contentType: string }): Promise<string | null>;
  fetch(input: { collection: string; recordId: string; filename: string }): Promise<{ buf: Buffer; contentType: string } | null>;
}

export const defaultBackendFilePort: SocialContentBackendFilePort = {
  attach: input => attachFileFromPath(input.collection, input.recordId, input.field, {
    name: input.name, path: input.path, contentType: input.contentType,
  }),
  fetch: input => fetchFile(input.collection, input.recordId, input.filename),
};

export interface SocialTaskMaterialPort {
  upsert(input: UpsertSocialTaskCloudMaterialInput): Promise<Record<string, any>>;
}

export const defaultSocialTaskMaterialPort: SocialTaskMaterialPort = {
  upsert: input => upsertSocialTaskCloudMaterial(input),
};

export function safeName(value: unknown): string {
  const name = path.basename(socialText(value));
  if (!name || name.length > 240 || /[\u0000-\u001f]/.test(name)) {
    throw new SocialContentWorkflowError('social_content_file_name_invalid', 400);
  }
  return name;
}

export function mime(value: unknown): string {
  const type = socialText(value).toLowerCase().split(';', 1)[0];
  if (!MIME_EXTENSIONS[type]) throw new SocialContentWorkflowError('social_content_file_type_unsupported', 415);
  return type;
}

export function magicAllowed(type: string, bytes: Buffer): boolean {
  if (!bytes.length) return false;
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/gif') return /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'));
  if (type === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (type === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (type === 'video/mp4' || type === 'video/quicktime' || type === 'audio/mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (type === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (type === 'audio/mpeg') return bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  if (type.includes('officedocument')) return bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (type.startsWith('text/')) return !bytes.includes(0);
  return type === 'audio/wav' || type === 'audio/x-wav'
    ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE'
    : false;
}
