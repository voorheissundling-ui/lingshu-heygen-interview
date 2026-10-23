/** A human-reviewed mapping, bound to exact provider response bytes. A matching
 * TikTok ID and KV key are necessary, but do not themselves prove visual identity. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { DataStore, Record_ } from '../storage/datastore.js';
import {apifyTokenFingerprint,type ApifyTokenFingerprintScheme} from './apifyTokenFingerprint.js';

export const APIFY_RUN_KV_MAPPING_RECEIPTS = 'social_apify_run_kv_mapping_receipts';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const validId = (s: string) => /^[A-Za-z0-9_-]{5,80}$/.test(s);
const validSha = (s: string) => /^[a-f0-9]{64}$/.test(s);
const validKey = (s: string) => s.length > 0 && s.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(s)
  && !s.split('/').some(part => !part || part === '.' || part === '..');
const fail = (reason: string): never => { throw Error(`apify_run_kv_mapping_${reason}`); };

export interface RunKvMappingStatement {
  kind: 'apify-run-kv-mapping-human-review.v1';
  issuerId: string; keyId: string; reviewerId: string; submittedBy: string;
  tenantId: string; packageId: string; packageVersion: number; jobId: string;
  runId: string; datasetId: string; defaultKeyValueStoreId: string;
  datasetOffset: number; datasetVideoId: string; recordKey: string;
  runGetSha256: string; datasetItemGetSha256: string; runKvKeysGetSha256: string;
  mediaSha256: string; mediaByteLength: number;
  reviewedAt: string; expiresAt: string;
}
export interface SignedRunKvMapping { statement: RunKvMappingStatement; signatureBase64url: string }
/** Provisioned outside the submitted receipt/request; reviewer identity is
 * pinned to the trusted key, not merely self-declared in the statement. */
export interface RunKvMappingAuthority { issuerId: string; keyId: string; reviewerId: string; tenantId: string; publicKeyPem: string }
export interface RunKvMappingScope {
  tenantId: string; packageId: string; packageVersion: number; jobId: string;
  runId: string; datasetId: string; defaultKeyValueStoreId: string;
  datasetVideoId: string; recordKey: string;
}
type VerifyInput = {
  store: DataStore; scope: RunKvMappingScope; receiptId: string; token: string;
  authorities: readonly RunKvMappingAuthority[];
  isRevoked: (issuerId: string, keyId: string, receiptId: string) => Promise<boolean | null>;
  fetcher?: typeof fetch; now?: Date;
  paidRead: ApifySameRunPaidReadPermit;
};

/** A commercial authority must supply this separately from the media reader. */
export interface ApifySameRunPaidReadPermit {
  permitsPaidCollection: true;
  /** Absent only for persisted legacy raw-digest permits; new permits must
   * explicitly choose the prepaid JSON-string digest. */
  tokenFingerprintScheme?: ApifyTokenFingerprintScheme;
  tokenFingerprint: string;
  runId: string;
  datasetId: string;
  assertCurrent: (request: {kind:'run_get'|'dataset_item_get'|'kv_keys_get'|'kv_media_get';url:string}) => Promise<void>;
}

export async function assertApifySameRunPaidRead(input:{permit:ApifySameRunPaidReadPermit;token:string;runId:string;datasetId:string;kind:'run_get'|'dataset_item_get'|'kv_keys_get'|'kv_media_get';url:string}):Promise<void>{
 const p=input.permit;
 const scheme=p?.tokenFingerprintScheme??'sha256-raw-v1';
 if(!p||p.permitsPaidCollection!==true||!['sha256-json-string-v1','sha256-raw-v1'].includes(scheme)||p.tokenFingerprint!==apifyTokenFingerprint(input.token,scheme)||p.runId!==input.runId||p.datasetId!==input.datasetId||typeof p.assertCurrent!=='function')fail('paid_read_permit_required');
 await p.assertCurrent({kind:input.kind,url:input.url});
}

export function mappingReceiptId(signed: SignedRunKvMapping): string {
  return hash(JSON.stringify(signed)).slice(0, 15);
}

/** The exact four chargeable reads for one signed dataset-item → KV-media
 * mapping. Shared by preclaim authority checks and the GET adapter so a
 * permission cannot be preflighted for a different URL. */
export function apifySameRunReadUrls(scope: Pick<RunKvMappingStatement,
  'runId' | 'datasetId' | 'defaultKeyValueStoreId' | 'datasetOffset' | 'recordKey'>) {
  const base = 'https://api.apify.com/v2';
  return {
    runGet: `${base}/actor-runs/${encodeURIComponent(scope.runId)}`,
    datasetItemGet: `${base}/datasets/${encodeURIComponent(scope.datasetId)}/items?format=json&clean=false&offset=${scope.datasetOffset}&limit=1`,
    kvKeysGet: `${base}/key-value-stores/${encodeURIComponent(scope.defaultKeyValueStoreId)}/keys?limit=1000`,
    kvMediaGet: `${base}/key-value-stores/${encodeURIComponent(scope.defaultKeyValueStoreId)}/records/${scope.recordKey.split('/').map(encodeURIComponent).join('%2F')}`,
  };
}

async function getBytes(fetcher: typeof fetch, url: string, token: string, permit:ApifySameRunPaidReadPermit, scope:{runId:string;datasetId:string}, kind:'run_get'|'dataset_item_get'|'kv_keys_get'): Promise<Buffer> {
  await assertApifySameRunPaidRead({permit,token,...scope,kind,url});
  const res = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (!res.ok || !(res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) fail('provider_unavailable');
  const declared = res.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2_000_000)) fail('provider_response_large');
  if (!res.body) fail('provider_response_invalid');
  const reader = res.body!.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2_000_000) fail('provider_response_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = Buffer.concat(chunks, length);
  if (!bytes.length || bytes.length > 2_000_000) fail('provider_response_large');
  return bytes;
}

function providerObject(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Invalid provider JSON is not evidence. */ }
  return fail('provider_response_invalid');
}

async function matchingSnapshots(s: RunKvMappingStatement, token: string, fetcher: typeof fetch, permit:ApifySameRunPaidReadPermit): Promise<boolean> {
  if(s.datasetOffset<0||s.datasetOffset>=5)fail('dataset_page_out_of_scope');
  const urls = apifySameRunReadUrls(s);
  const [runBytes, itemBytes, keysBytes] = await Promise.all([
    getBytes(fetcher, urls.runGet, token, permit, s, 'run_get'), getBytes(fetcher, urls.datasetItemGet, token, permit, s, 'dataset_item_get'), getBytes(fetcher, urls.kvKeysGet, token, permit, s, 'kv_keys_get'),
  ]);
  if (hash(runBytes) !== s.runGetSha256 || hash(itemBytes) !== s.datasetItemGetSha256
    || hash(keysBytes) !== s.runKvKeysGetSha256) return false;
  const runWrapper = providerObject(runBytes), run = (runWrapper.data ?? runWrapper) as Record<string, unknown>;
  if (run.id !== s.runId || run.defaultDatasetId !== s.datasetId
    || run.defaultKeyValueStoreId !== s.defaultKeyValueStoreId || run.status !== 'SUCCEEDED') return false;
  let items: unknown;
  try { items = JSON.parse(itemBytes.toString('utf8')); } catch { return false; }
  if (!Array.isArray(items) || items.length !== 1 || !items[0] || typeof items[0] !== 'object') return false;
  const item = items[0] as Record<string, unknown>;
  if (String(item.id ?? item.videoId ?? '') !== s.datasetVideoId) return false;
  const keyWrapper = providerObject(keysBytes);
  const keyData = (keyWrapper.data ?? keyWrapper) as Record<string, unknown>;
  const keys = keyData.items;
  if (!Array.isArray(keys) || !keys.some(value => value && typeof value === 'object'
    && (value as Record<string, unknown>).key === s.recordKey)) return false;
  return true;
}

function validSigned(signed: SignedRunKvMapping, scope: RunKvMappingScope,
  authorities: readonly RunKvMappingAuthority[], now: Date): boolean {
  const s = signed?.statement;
  if (!s || s.kind !== 'apify-run-kv-mapping-human-review.v1'
    || Object.entries(scope).some(([field, value]) => s[field as keyof RunKvMappingStatement] !== value)
    || !validId(s.runId) || !validId(s.datasetId) || !validId(s.defaultKeyValueStoreId)
    || !validId(s.jobId) || !validId(s.packageId) || !validId(s.tenantId)
    || !/^[0-9]{8,30}$/.test(s.datasetVideoId) || !validKey(s.recordKey)
    || !Number.isSafeInteger(s.packageVersion) || s.packageVersion < 1
    || !Number.isSafeInteger(s.datasetOffset) || s.datasetOffset < 0 || s.datasetOffset >= 5
    || ![s.runGetSha256, s.datasetItemGetSha256, s.runKvKeysGetSha256, s.mediaSha256].every(validSha)
    || !Number.isSafeInteger(s.mediaByteLength) || s.mediaByteLength < 32 || s.mediaByteLength > 500 * 1024 * 1024
    || !s.reviewerId || s.reviewerId === s.submittedBy
    || !Number.isFinite(Date.parse(s.reviewedAt)) || Date.parse(s.reviewedAt) > now.getTime()
    || !Number.isFinite(Date.parse(s.expiresAt)) || Date.parse(s.expiresAt) <= now.getTime()
    || Date.parse(s.expiresAt) <= Date.parse(s.reviewedAt)) return false;
  const roots = authorities.filter(a => a.tenantId === s.tenantId && a.issuerId === s.issuerId
    && a.keyId === s.keyId && a.reviewerId === s.reviewerId);
  if (roots.length !== 1) return false;
  try {
    const key = createPublicKey(roots[0]!.publicKeyPem);
    const signature = Buffer.from(signed.signatureBase64url, 'base64url');
    return key.asymmetricKeyType === 'ed25519' && signature.length === 64
      && verify(null, Buffer.from(JSON.stringify(s)), key, signature);
  } catch { return false; }
}

/** Revalidates immutable storage and live provider bytes on every read. A
 * revocation source that is absent, unavailable or uncertain never authorizes. */
export async function readVerifiedRunKvMapping(input: VerifyInput): Promise<SignedRunKvMapping> {
  const signed = await readLocallyVerifiedRunKvMapping(input);
  if (!input.token.trim() || !await matchingSnapshots(signed.statement, input.token, input.fetcher ?? fetch, input.paidRead))
    fail('provider_evidence_changed');
  return signed;
}

/** Zero-network preclaim check: immutable receipt, independent reviewer key,
 * exact scope and live revocation. Paid GET authorization is checked separately. */
export async function readLocallyVerifiedRunKvMapping(input: Omit<VerifyInput, 'token' | 'fetcher' | 'paidRead'>): Promise<SignedRunKvMapping> {
  const row = await input.store.getById<Record_>(APIFY_RUN_KV_MAPPING_RECEIPTS, input.receiptId);
  const signed = row?.payload as SignedRunKvMapping | undefined;
  if (!row || !signed) throw Error('apify_run_kv_mapping_receipt_invalid');
  if (row.id !== input.receiptId || row.tenant_id !== input.scope.tenantId
    || mappingReceiptId(signed) !== input.receiptId || row.content_hash !== hash(JSON.stringify(signed))
    || !validSigned(signed, input.scope, input.authorities, input.now ?? new Date())) fail('receipt_invalid');
  if (await input.isRevoked(signed.statement.issuerId, signed.statement.keyId, input.receiptId).catch(() => null) !== false)
    fail('revoked_or_unknown');
  return signed;
}

/** Records only a signed independent human review. No auto-review path. */
export async function recordRunKvMapping(input: Omit<VerifyInput, 'receiptId'> & { signed: SignedRunKvMapping }): Promise<string> {
  const receiptId = mappingReceiptId(input.signed);
  if (!validSigned(input.signed, input.scope, input.authorities, input.now ?? new Date())) fail('review_invalid');
  if (await input.isRevoked(input.signed.statement.issuerId, input.signed.statement.keyId, receiptId).catch(() => null) !== false)
    fail('revoked_or_unknown');
  if (!input.token.trim() || !await matchingSnapshots(input.signed.statement, input.token, input.fetcher ?? fetch, input.paidRead))
    fail('provider_evidence_changed');
  const data = { id: receiptId, tenant_id: input.scope.tenantId, package_id: input.scope.packageId,
    job_id: input.scope.jobId, content_hash: hash(JSON.stringify(input.signed)), payload: input.signed };
  const prior = await input.store.getById<Record_>(APIFY_RUN_KV_MAPPING_RECEIPTS, receiptId);
  if (prior) {
    if (prior.tenant_id !== data.tenant_id || prior.package_id !== data.package_id || prior.job_id !== data.job_id
      || prior.content_hash !== data.content_hash || hash(JSON.stringify(prior.payload)) !== data.content_hash)
      fail('receipt_conflict');
  } else {
    try { await input.store.create(APIFY_RUN_KV_MAPPING_RECEIPTS, data); } catch { /* Unknown write outcome: read back. */ }
  }
  await readVerifiedRunKvMapping({ ...input, receiptId });
  return receiptId;
}
