/** PocketBase files locally; PostgreSQL metadata plus COS objects in production. */
import { openAsBlob } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { getPbAdminToken, getPbUrl } from './pb.js';
import { objectStorageDownload, objectStorageEnsureFile, objectStorageHead, objectStorageSignedGetUrl, objectStorageUpload } from './objectStorage.js';
import { postgresStore, selectedDataBackend, updatePostgresObjectFileReference } from './postgres.js';

type ObjectFileReference = {
  key: string;
  etag?: string;
  size: number;
  sha256: string;
  contentType: string;
  originalName: string;
};

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'file';
}

function fileObjectKey(collection: string, recordId: string, field: string, sha256: string, filename: string): string {
  return ['records', safeSegment(collection), safeSegment(recordId), safeSegment(field), `${sha256.slice(0, 16)}-${safeSegment(filename)}`].join('/');
}

function objectFileMap(record: Record<string, unknown>): Record<string, ObjectFileReference[]> {
  const value = record._objectFiles;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, ObjectFileReference[]>
    : {};
}

function findObjectFile(record: Record<string, unknown>, filename: string): ObjectFileReference | null {
  for (const references of Object.values(objectFileMap(record))) {
    const match = Array.isArray(references) ? references.find(reference => reference?.originalName === filename) : undefined;
    if (match?.key) return match;
  }
  return null;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function patchObjectFileReference(input: {
  collection: string;
  recordId: string;
  field: string;
  reference: ObjectFileReference;
}): Promise<string | null> {
  const patched = await updatePostgresObjectFileReference({
    collection: input.collection,
    recordId: input.recordId,
    field: input.field,
    reference: input.reference,
  });
  return patched ? input.reference.originalName : null;
}

async function patchFileField(
  collection: string,
  recordId: string,
  field: string,
  file: { name: string; blob: Blob },
): Promise<string | null> {
  const token = await getPbAdminToken();
  if (!token) return null;

  const form = new FormData();
  form.append(field, file.blob, file.name);

  // NOTE: do not set Content-Type — fetch derives the multipart boundary.
  const res = await fetch(
    `${getPbUrl()}/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(recordId)}`,
    { method: 'PATCH', headers: { Authorization: token }, body: form },
  );
  if (!res.ok) {
    console.error(`[files] attach ${collection}/${recordId}.${field} failed`, res.status, await res.text().catch(() => ''));
    return null;
  }
  const rec = (await res.json()) as Record<string, unknown>;
  const value = rec[field];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length) return String(value[0]);
  return null;
}

/** Create a short-lived native media URL so browsers can use HTTP Range requests. */
export async function createFilePlaybackUrl(
  collection: string,
  recordId: string,
  filename: string,
): Promise<string | null> {
  if (selectedDataBackend() === 'postgres') {
    const record = await postgresStore.getById<Record<string, unknown> & { id: string }>(collection, recordId);
    const reference = record ? findObjectFile(record, filename) : null;
    return reference ? objectStorageSignedGetUrl(reference.key) : null;
  }
  const token = await getPbAdminToken();
  if (!token) return null;
  const response = await fetch(`${getPbUrl()}/api/files/token`, {
    method: 'POST',
    headers: { Authorization: token },
  });
  if (!response.ok) return null;
  const fileToken = ((await response.json()) as { token?: string }).token ?? '';
  if (!fileToken) return null;
  return `${getPbUrl()}/api/files/${encodeURIComponent(collection)}/${encodeURIComponent(recordId)}/${encodeURIComponent(filename)}?token=${encodeURIComponent(fileToken)}`;
}

/** Upload a blob into `record[field]`; returns the stored filename (or null). */
export async function attachFile(
  collection: string,
  recordId: string,
  field: string,
  file: { name: string; buf: Buffer; contentType: string },
): Promise<string | null> {
  if (selectedDataBackend() === 'postgres') {
    const sha256 = createHash('sha256').update(file.buf).digest('hex');
    const key = fileObjectKey(collection, recordId, field, sha256, file.name);
    await objectStorageUpload({ key, body: file.buf, contentType: file.contentType });
    const head = await objectStorageHead(key);
    if (!head || head.size !== file.buf.length) throw new Error('COS attachment verification failed');
    return patchObjectFileReference({
      collection,
      recordId,
      field,
      reference: { key, etag: head.etag, size: head.size, sha256, contentType: file.contentType, originalName: file.name },
    });
  }
  return patchFileField(collection, recordId, field, {
    name: file.name,
    blob: new Blob([file.buf], { type: file.contentType }),
  });
}

/**
 * Upload a local render without loading a potentially 100+ MiB video into the
 * Node heap. The path is only a transient producer input; the configured
 * durable storage owns the bytes after this call succeeds.
 */
export async function attachFileFromPath(
  collection: string,
  recordId: string,
  field: string,
  file: { name: string; path: string; contentType: string },
): Promise<string | null> {
  if (selectedDataBackend() === 'postgres') {
    const sha256 = await hashFile(file.path);
    const fileStat = await stat(file.path);
    const key = fileObjectKey(collection, recordId, field, sha256, file.name || path.basename(file.path));
    const stored = await objectStorageEnsureFile({ key, filePath: file.path, contentType: file.contentType, contentLength: fileStat.size });
    return patchObjectFileReference({
      collection,
      recordId,
      field,
      reference: { key, etag: stored.head.etag, size: fileStat.size, sha256, contentType: file.contentType, originalName: file.name },
    });
  }
  const blob = await openAsBlob(file.path, { type: file.contentType });
  return patchFileField(collection, recordId, field, { name: file.name, blob });
}

/** Download a stored file as a Buffer. Uses a short-lived PB file token. */
export async function fetchFile(
  collection: string,
  recordId: string,
  filename: string,
): Promise<{ buf: Buffer; contentType: string } | null> {
  if (selectedDataBackend() === 'postgres') {
    const record = await postgresStore.getById<Record<string, unknown> & { id: string }>(collection, recordId);
    const reference = record ? findObjectFile(record, filename) : null;
    return reference ? objectStorageDownload(reference.key) : null;
  }
  const token = await getPbAdminToken();
  if (!token) return null;

  // Protected-collection files require a short-lived file token (query param).
  let fileToken = '';
  const tk = await fetch(`${getPbUrl()}/api/files/token`, {
    method: 'POST',
    headers: { Authorization: token },
  });
  if (tk.ok) fileToken = ((await tk.json()) as { token?: string }).token ?? '';

  const url =
    `${getPbUrl()}/api/files/${encodeURIComponent(collection)}/${encodeURIComponent(recordId)}/${encodeURIComponent(filename)}` +
    (fileToken ? `?token=${fileToken}` : '');
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[files] fetch ${collection}/${recordId}/${filename} failed`, res.status);
    return null;
  }
  return {
    buf: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}
