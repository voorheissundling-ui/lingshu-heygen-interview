import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPresenterVideo } from '../lib/presenterVideo.js';
import type { DataStore } from '../storage/datastore.js';
import { apifySameRunReadUrls, assertApifySameRunPaidRead, readVerifiedRunKvMapping, type ApifySameRunPaidReadPermit, type RunKvMappingAuthority } from './apifyRunKvMappingReceipt.js';

/**
 * Read-only recovery of media already downloaded by the exact Actor run.
 * The Clockworks public schema does not specify how dataset IDs map to KV keys.
 * A caller must first establish and persist that mapping from run evidence;
 * this adapter never guesses a key from a TikTok ID or follows a TikTok URL.
 */
export interface VerifiedRunKvMediaBinding {
  tenantId: string;
  packageId: string;
  packageVersion: number;
  jobId: string;
  runId: string;
  datasetId: string;
  defaultKeyValueStoreId: string;
  datasetVideoId: string;
  recordKey: string;
  /** ID of a persisted, independently signed human-review receipt. */
  mappingReceiptId: string;
}

export interface RunKvMediaReceipt extends VerifiedRunKvMediaBinding {
  filePath: string;
  contentSha256: string;
  byteLength: number;
  durationSeconds: number;
  width: number;
  height: number;
}

const id = (value: string) => /^[A-Za-z0-9_-]{5,80}$/.test(value);
const key = (value: string) => value.length > 0 && value.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(value)
  && !value.split('/').some(part => !part || part === '.' || part === '..');
const fail = (reason: string): never => { throw Error(`apify_run_kv_media_${reason}`); };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provider_response_invalid');
  return value as Record<string, unknown>;
}

function validateBinding(binding: VerifiedRunKvMediaBinding): void {
  if (!id(binding.tenantId) || !id(binding.packageId) || !id(binding.jobId)
      || !Number.isSafeInteger(binding.packageVersion) || binding.packageVersion < 1
      || !id(binding.runId) || !id(binding.datasetId) || !id(binding.defaultKeyValueStoreId)
      || !/^[0-9]{8,30}$/.test(binding.datasetVideoId) || !key(binding.recordKey)
      || !/^[a-f0-9]{15}$/.test(binding.mappingReceiptId)) fail('mapping_unverified');
}

function mp4(bytes: Buffer): boolean {
  if (bytes.length < 32 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  const size = bytes.readUInt32BE(0);
  if (size < 16 || size > bytes.length || size > 4096) return false;
  const brands = bytes.toString('ascii', 8, Math.min(size, 64));
  return /(?:isom|iso2|mp41|mp42|avc1|M4V |dash)/.test(brands) && !brands.startsWith('qt  ');
}

async function request(fetcher: typeof fetch, url: string, token: string, accept: string): Promise<Response> {
  const response = await fetcher(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
  });
  if (!response.ok) fail(`provider_http_${response.status}`);
  return response;
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) fail('size_limit');
  const body = response.body;
  if (!body) fail('empty_body');
  const reader = body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail('size_limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (!size) fail('empty_body');
  return Buffer.concat(chunks, size);
}

/** GET only: run identity, run's default KV record, local validation and atomic SHA-addressed file. */
export async function readSameRunApifyKvVideo(input: {
  binding: VerifiedRunKvMediaBinding;
  store: DataStore;
  mappingAuthorities: readonly RunKvMappingAuthority[];
  isMappingRevoked: (issuerId: string, keyId: string, receiptId: string) => Promise<boolean | null>;
  token: string;
  outputDirectory: string;
  maxBytes?: number;
  fetcher?: typeof fetch;
  paidRead: ApifySameRunPaidReadPermit;
}): Promise<RunKvMediaReceipt> {
  const { binding } = input;
  validateBinding(binding);
  if (!input.token.trim()) fail('credentials_required');
  if (!path.isAbsolute(input.outputDirectory)) fail('output_directory_invalid');
  const maxBytes = input.maxBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 32 || maxBytes > 500 * 1024 * 1024) fail('size_limit_invalid');
  const fetcher = input.fetcher ?? fetch;
  const { mappingReceiptId: _receiptId, ...scope } = binding;
  const mapping = await readVerifiedRunKvMapping({ store: input.store, scope,
    receiptId: binding.mappingReceiptId, token: input.token,
    authorities: input.mappingAuthorities, isRevoked: input.isMappingRevoked, fetcher, paidRead:input.paidRead });
  const urls = apifySameRunReadUrls(mapping.statement);
  const runUrl = urls.runGet;
  await assertApifySameRunPaidRead({permit:input.paidRead,token:input.token,runId:binding.runId,datasetId:binding.datasetId,kind:'run_get',url:runUrl});
  const runResponse = await request(fetcher, runUrl, input.token, 'application/json');
  const wrapped = object(await runResponse.json());
  const run = object(wrapped.data ?? wrapped);
  if (run.id !== binding.runId || run.defaultDatasetId !== binding.datasetId
      || run.defaultKeyValueStoreId !== binding.defaultKeyValueStoreId || run.status !== 'SUCCEEDED') fail('run_identity_mismatch');

  const recordUrl = urls.kvMediaGet;
  await assertApifySameRunPaidRead({permit:input.paidRead,token:input.token,runId:binding.runId,datasetId:binding.datasetId,kind:'kv_media_get',url:recordUrl});
  const response = await request(fetcher, recordUrl, input.token, 'video/mp4');
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.toLowerCase();
  if (!['video/mp4', 'application/octet-stream'].includes(contentType)) fail('mime_invalid');
  const bytes = await boundedBytes(response, maxBytes);
  if (bytes.length !== mapping.statement.mediaByteLength
    || createHash('sha256').update(bytes).digest('hex') !== mapping.statement.mediaSha256)
    fail('mapping_media_changed');
  if (!mp4(bytes)) fail('mp4_invalid');
  const info = await inspectPresenterVideo(bytes).catch(() => fail('decode_invalid'));
  const contentSha256 = createHash('sha256').update(bytes).digest('hex');
  await fs.mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(input.outputDirectory, `${contentSha256}.mp4`);
  const temp = path.join(input.outputDirectory, `.${contentSha256}.${randomUUID()}.tmp`);
  let opened = false;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    opened = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      const existing = await fs.readFile(filePath);
      if (createHash('sha256').update(existing).digest('hex') !== contentSha256) fail('existing_file_mismatch');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.rename(temp, filePath);
      const directory = await fs.open(input.outputDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { if (opened) await fs.rm(temp, { force: true }); }
  return { ...binding, filePath, contentSha256, byteLength: bytes.length,
    durationSeconds: info.duration, width: info.width, height: info.height };
}
