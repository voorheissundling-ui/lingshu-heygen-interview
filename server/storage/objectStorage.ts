import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { signAssetUrl, safeAssetTenantId } from '../lib/assetAccess.js';
import { materialAssetTenantKey } from './materialAssets.js';

export type ObjectStorageDriver = 'local' | 'cos';
export interface StoredObjectHead { size: number; contentType: string; etag?: string }
export interface ObjectStorageStream extends StoredObjectHead { body: AsyncIterable<Uint8Array>; contentLength?: number; contentRange?: string; acceptRanges?: string; lastModified?: Date }
export interface StoredObjectSummary { key: string; size: number; etag?: string; lastModified?: Date }
export interface StoredObjectPage { items: StoredObjectSummary[]; cursor?: string }

const localRoot = () => path.resolve(process.env.LOCAL_OBJECT_STORAGE_ROOT || 'data/media/object-storage');
export function objectStorageLocalRoot(): string { return localRoot(); }
const driver = (): ObjectStorageDriver => {
  const configured = String(process.env.OBJECT_STORAGE_DRIVER || '').trim().toLowerCase();
  if (configured === 'local' || configured === 'cos') return configured;
  return process.env.NODE_ENV === 'production' ? 'cos' : 'local';
};
function safeLocalPath(key: string): string {
  const normalized = String(key || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('对象存储 key 无效');
  const root = localRoot(), resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('对象存储 key 越界');
  return resolved;
}
function cosConfig() {
  const region = String(process.env.COS_REGION || process.env.OBJECT_STORAGE_REGION || '').trim();
  const bucket = String(process.env.COS_BUCKET || process.env.OBJECT_STORAGE_BUCKET_NAME || '').trim();
  const accessKeyId = String(process.env.COS_SECRET_ID || process.env.OBJECT_STORAGE_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.COS_SECRET_KEY || process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || '').trim();
  const endpoint = String(process.env.COS_ENDPOINT || process.env.OBJECT_STORAGE_ENDPOINT || '').trim() || (region ? `https://cos.${region}.myqcloud.com` : '');
  return { region, bucket, accessKeyId, secretAccessKey, endpoint };
}
function cosClient() {
  const config = cosConfig();
  if (!config.region || !config.bucket || !config.accessKeyId || !config.secretAccessKey || !config.endpoint) throw new Error('腾讯 COS 未配置：需要 COS_REGION、COS_BUCKET、COS_SECRET_ID、COS_SECRET_KEY');
  return { bucket: config.bucket, client: new S3Client({ region: config.region, endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }) };
}
export function objectStorageDriver(): ObjectStorageDriver { return driver(); }
export function objectStorageConfigurationIssues(env: NodeJS.ProcessEnv = process.env): string[] {
  const configuredDriver = String(env.OBJECT_STORAGE_DRIVER || '').trim().toLowerCase();
  const effectiveDriver = configuredDriver || (env.NODE_ENV === 'production' ? 'cos' : 'local');
  if (effectiveDriver !== 'local' && effectiveDriver !== 'cos') return ['OBJECT_STORAGE_DRIVER must be local or cos'];
  if (env.NODE_ENV === 'production' && effectiveDriver !== 'cos') return ['production requires OBJECT_STORAGE_DRIVER=cos'];
  if (effectiveDriver === 'local') return [];
  return [
    !String(env.COS_REGION || env.OBJECT_STORAGE_REGION || '').trim() && 'COS_REGION',
    !String(env.COS_BUCKET || env.OBJECT_STORAGE_BUCKET_NAME || '').trim() && 'COS_BUCKET',
    !String(env.COS_SECRET_ID || env.OBJECT_STORAGE_ACCESS_KEY_ID || '').trim() && 'COS_SECRET_ID',
    !String(env.COS_SECRET_KEY || env.OBJECT_STORAGE_SECRET_ACCESS_KEY || '').trim() && 'COS_SECRET_KEY',
  ].filter(Boolean) as string[];
}
export function objectStorageEnabled(): boolean {
  if (driver() === 'local') return true;
  const c = cosConfig(); return Boolean(c.region && c.bucket && c.accessKeyId && c.secretAccessKey && c.endpoint);
}
export function objectStorageSupplierDeliveryReady(): boolean {
  return driver() === 'cos' ? objectStorageEnabled() : /^https:\/\//i.test(String(process.env.LOCAL_OBJECT_STORAGE_PUBLIC_BASE_URL || '').trim());
}
export async function objectStorageUpload(input: { key: string; body: Buffer; contentType: string }): Promise<string> {
  if (driver() === 'local') {
    const file = safeLocalPath(input.key); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, input.body, { mode: 0o600 });
    await fs.writeFile(`${file}.meta.json`, JSON.stringify({ contentType: input.contentType }), { mode: 0o600 }); return objectStoragePublicUrl(input.key);
  }
  const { client, bucket } = cosClient(); await client.send(new PutObjectCommand({ Bucket: bucket, Key: input.key, Body: input.body, ContentType: input.contentType }));
  return objectStoragePublicUrl(input.key);
}
export async function objectStorageUploadFile(input: { key: string; filePath: string; contentType: string; contentLength: number }): Promise<void> {
  if (driver() === 'local') {
    const destination = safeLocalPath(input.key); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(input.filePath, destination); await fs.chmod(destination, 0o600);
    await fs.writeFile(`${destination}.meta.json`, JSON.stringify({ contentType: input.contentType }), { mode: 0o600 }); return;
  }
  const { client, bucket } = cosClient();
  const configuredThreshold = Number(process.env.OBJECT_STORAGE_MULTIPART_THRESHOLD_BYTES || 20 * 1024 * 1024);
  const threshold = Number.isFinite(configuredThreshold) ? Math.max(5 * 1024 * 1024, configuredThreshold) : 20 * 1024 * 1024;
  if (input.contentLength < threshold) {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: input.key, Body: createReadStream(input.filePath), ContentType: input.contentType, ContentLength: input.contentLength }));
    return;
  }

  // COS supports the S3 multipart protocol. Keep at most one part in memory so
  // video ingestion remains stable on the small API nodes. The AWS SDK retries
  // individual UploadPart requests; any caught failure explicitly aborts the
  // upload so fragments do not accumulate in the bucket.
  const partSize = Math.max(8 * 1024 * 1024, Math.ceil(input.contentLength / 9_999));
  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: input.key,
    ContentType: input.contentType,
  }));
  if (!created.UploadId) throw new Error('对象存储未返回分块上传 ID');
  const file = await fs.open(input.filePath, 'r');
  try {
    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    let offset = 0;
    let partNumber = 1;
    while (offset < input.contentLength) {
      const length = Math.min(partSize, input.contentLength - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error('读取待上传文件时意外结束');
      const uploaded = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: input.key,
        UploadId: created.UploadId,
        PartNumber: partNumber,
        Body: buffer,
        ContentLength: bytesRead,
      }));
      if (!uploaded.ETag) throw new Error(`对象存储分块 ${partNumber} 缺少 ETag`);
      parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
      offset += bytesRead;
      partNumber += 1;
    }
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: input.key,
      UploadId: created.UploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: input.key,
      UploadId: created.UploadId,
    })).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
}

/** Upload a content-addressed file once and verify the resulting object. */
export async function objectStorageEnsureFile(input: { key: string; filePath: string; contentType: string; contentLength: number }): Promise<{ head: StoredObjectHead; reused: boolean }> {
  const existing = await objectStorageHead(input.key);
  if (existing) {
    if (existing.size !== input.contentLength) throw new Error('对象存储内容地址冲突：同一 key 的文件大小不同');
    return { head: existing, reused: true };
  }
  await objectStorageUploadFile(input);
  const head = await objectStorageHead(input.key);
  if (!head || head.size !== input.contentLength) throw new Error('对象存储上传后的完整性检查失败');
  return { head, reused: false };
}
async function localContentType(file: string): Promise<string> { try { return String(JSON.parse(await fs.readFile(`${file}.meta.json`, 'utf8')).contentType || 'application/octet-stream'); } catch { return 'application/octet-stream'; } }
export async function objectStorageHead(key: string): Promise<StoredObjectHead | null> {
  if (driver() === 'local') { try { const file = safeLocalPath(key), stat = await fs.stat(file); return { size: stat.size, contentType: await localContentType(file), etag: `local-${stat.size}-${Math.round(stat.mtimeMs)}` }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
  try { const { client, bucket } = cosClient(), r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return { size: r.ContentLength ?? 0, contentType: r.ContentType || 'application/octet-stream', etag: r.ETag }; }
  catch (e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
}
export async function objectStorageDownload(key: string): Promise<{ buf: Buffer; contentType: string } | null> {
  if (driver() === 'local') { try { const file = safeLocalPath(key); return { buf: await fs.readFile(file), contentType: await localContentType(file) }; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
  const stream = await objectStorageGetObject(key); if (!stream) return null; const chunks: Uint8Array[] = []; for await (const chunk of stream.body) chunks.push(chunk); return { buf: Buffer.concat(chunks), contentType: stream.contentType };
}
export async function objectStorageGetObject(key: string, range?: string): Promise<ObjectStorageStream | null> {
  if (driver() === 'local') {
    try { const file = safeLocalPath(key), stat = await fs.stat(file), match = /^bytes=(\d+)-(\d*)$/.exec(range || ''); const start = match ? Number(match[1]) : 0, end = match?.[2] ? Number(match[2]) : stat.size - 1;
      return { body: createReadStream(file, { start, end }), size: end - start + 1, contentLength: end - start + 1, contentType: await localContentType(file), contentRange: range ? `bytes ${start}-${end}/${stat.size}` : undefined, acceptRanges: 'bytes', etag: `local-${stat.size}-${Math.round(stat.mtimeMs)}`, lastModified: stat.mtime }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  try { const { client, bucket } = cosClient(), r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(range ? { Range: range } : {}) })); if (!r.Body) return null;
    return { body: r.Body as AsyncIterable<Uint8Array>, size: r.ContentLength ?? 0, contentLength: r.ContentLength, contentType: r.ContentType || 'application/octet-stream', contentRange: r.ContentRange, acceptRanges: r.AcceptRanges, etag: r.ETag, lastModified: r.LastModified }; }
  catch (e) { if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null; throw e; }
}
export async function objectStorageDelete(key: string): Promise<void> {
  if (driver() === 'local') { const file = safeLocalPath(key); await fs.rm(file, { force: true }); await fs.rm(`${file}.meta.json`, { force: true }); return; }
  const { client, bucket } = cosClient(); await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** Read-only inventory primitive used by maintenance dry-runs. */
export async function objectStorageList(input: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<StoredObjectPage> {
  const prefix = String(input.prefix || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const limit = Math.max(1, Math.min(1_000, Math.round(input.limit || 500)));
  if (driver() === 'local') {
    const root = localRoot();
    const base = prefix ? safeLocalPath(prefix) : root;
    const items: StoredObjectSummary[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && !entry.name.endsWith('.meta.json')) {
          const stat = await fs.stat(file);
          items.push({ key: path.relative(root, file).split(path.sep).join('/'), size: stat.size, lastModified: stat.mtime });
        }
      }
    };
    await visit(base);
    items.sort((a, b) => a.key.localeCompare(b.key));
    const cursorIndex = input.cursor ? items.findIndex(item => item.key > input.cursor!) : 0;
    const start = cursorIndex < 0 ? items.length : cursorIndex;
    const page = items.slice(start, start + limit);
    return { items: page, ...(start + limit < items.length && page.length ? { cursor: page.at(-1)!.key } : {}) };
  }
  const { client, bucket } = cosClient();
  const response = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix || undefined,
    ContinuationToken: input.cursor || undefined,
    MaxKeys: limit,
  }));
  return {
    items: (response.Contents || []).flatMap(item => item.Key ? [{ key: item.Key, size: item.Size || 0, etag: item.ETag, lastModified: item.LastModified }] : []),
    ...(response.IsTruncated && response.NextContinuationToken ? { cursor: response.NextContinuationToken } : {}),
  };
}
export async function objectStorageSignedGetUrl(key: string, expiresIn = 900): Promise<string> {
  if (driver() === 'local') {
    const parts = String(key).split('/');
    const relative = `/media/object-storage/${parts.map(encodeURIComponent).join('/')}`;
    const base = String(process.env.LOCAL_OBJECT_STORAGE_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    if (parts.length >= 4 && parts[1] === 'tenants') {
      const tenantKey = String(parts[2] || '');
      const decoded = Buffer.from(tenantKey, 'base64url').toString('utf8');
      const tenantId = materialAssetTenantKey(decoded) === tenantKey
        ? safeAssetTenantId(decoded)
        : safeAssetTenantId(tenantKey);
      const signed = signAssetUrl(relative, tenantId, Math.max(60, Math.min(3600, Math.round(expiresIn))) * 1000);
      return base ? `${base}${signed}` : signed;
    }
    return base ? `${base}${relative}` : relative;
  }
  const { client, bucket } = cosClient(); return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: Math.max(60, Math.min(3600, Math.round(expiresIn))) });
}
export function objectStoragePublicUrl(key: string): string {
  if (driver() === 'local') { const base = String(process.env.LOCAL_OBJECT_STORAGE_PUBLIC_BASE_URL || '').replace(/\/$/, ''); return `${base}/media/object-storage/${key.split('/').map(encodeURIComponent).join('/')}`; }
  const configured = String(process.env.COS_PUBLIC_URL || process.env.OBJECT_STORAGE_PUBLIC_URL || '').replace(/\/$/, ''); if (configured) return `${configured}/${key}`;
  const c = cosConfig(); return `https://${c.bucket}.cos.${c.region}.myqcloud.com/${key}`;
}
