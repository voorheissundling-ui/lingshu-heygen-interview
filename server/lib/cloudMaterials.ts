import type {MaterialTheme,MaterialSourceCategory,MaterialClassificationStatus} from '../../shared/materialTaxonomy.js';
import { openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import { adminFetch } from '../storage/pb.js';
import { createFilePlaybackUrl } from '../storage/files.js';
import { materialAssetPolicy, type MaterialSourceEntry } from './materialAssetPolicy.js';
import { objectStorageGetObject } from '../storage/objectStorage.js';
import { postgresListWithPocketBaseFilter, postgresStore, selectedDataBackend } from '../storage/postgres.js';
import type { DataStore } from '../storage/datastore.js';
import { materialAssetV2FromRecord, type MaterialAssetV2Metadata } from '../../shared/contracts/materialAssetV2.js';
import { pbStore } from '../storage/pbStore.js';
import { currentDataAuthority } from '../storage/dataAuthority.js';

export interface CloudMaterialRecord extends Record<string, unknown> {
  id: string;
  sourceCategory?:MaterialSourceCategory|null;
  primaryTheme?:MaterialTheme|''|null;
  themeTags?:MaterialTheme[]|string|null;
  classificationStatus?:MaterialClassificationStatus|''|null;
  classificationSource?:string|null;
  classificationEvidence?:unknown[]|string|null;
  videoFile?: string;
  posterFile?: string;
  objectKey?: string;
  posterObjectKey?: string;
  objectEtag?: string;
  posterObjectEtag?: string;
  storageBackend?: string;
}

export type CloudMaterialFileInput = {
  name: string;
  contentType: string;
} & ({ path: string; buf?: never } | { buf: Buffer; path?: never });

export type CloudMaterialObjectInput = {
  key: string;
  etag?: string;
  contentType: string;
};

export interface CreateCloudMaterialInput {
  tenantId: string;
  title: string;
  folder: string;
  type: 'video' | 'image' | 'audio';
  duration?: number;
  width?: number;
  height?: number;
  sizeBytes: number;
  sha256: string;
  scope?: 'own' | 'shared';
  usage?: 'editable' | 'reference_only';
  sourceType?: string;
  sourceName?: string;
  sourceProvider?: string;
  sourceCreator?: string;
  sourceUrl?: string;
  productId?: string;
  productName?: string;
  tags?: string;
  industry?: string;
  shotFunction?: string;
  applicability?: string;
  licenseEvidence?: string;
  licenseName?: string;
  licenseUrl?: string;
  attributionText?: string;
  commercialUseApproved?: boolean;
  derivativesApproved?: boolean;
  rawLibraryUseApproved?: boolean;
  provenance?: Record<string, unknown>;
  materialV2?: MaterialAssetV2Metadata;
  sourceEntry?: MaterialSourceEntry;
  media: CloudMaterialFileInput | CloudMaterialObjectInput;
  poster?: CloudMaterialFileInput | CloudMaterialObjectInput;
}

export interface VerifiedDeduplicatedMaterialUpdate {
  title?: string;
  folder?: string;
  type?: 'video' | 'image' | 'audio';
  duration?: number;
  width?: number;
  height?: number;
  sourceType?: string;
  sourceName?: string;
  productId?: string;
  productName?: string;
  tags?: string;
  shotFunction?: string;
  licenseEvidence?: string;
  commercialUseApproved?: boolean;
  derivativesApproved?: boolean;
  rawLibraryUseApproved?: boolean;
}

function verifiedDeduplicatedMaterialFields(
  value: VerifiedDeduplicatedMaterialUpdate | undefined,
): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(([
    'title', 'folder', 'type', 'duration', 'width', 'height', 'sourceType', 'sourceName',
    'productId', 'productName', 'tags', 'shotFunction', 'licenseEvidence',
    'commercialUseApproved', 'derivativesApproved', 'rawLibraryUseApproved',
  ] satisfies Array<keyof VerifiedDeduplicatedMaterialUpdate>)
    .filter(key => value[key] !== undefined)
    .map(key => [key, value[key]]));
}

const FALLBACK_POSTER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function appendCloudMaterialField(form: FormData, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'object') {
    form.append(key, JSON.stringify(value));
    return;
  }
  form.append(key, String(value));
}

async function cloudMaterialBlob(file: CloudMaterialFileInput): Promise<Blob> {
  return typeof file.path === 'string'
    ? openAsBlob(file.path, { type: file.contentType })
    : new Blob([file.buf!], { type: file.contentType });
}

function isObjectInput(file: CloudMaterialFileInput | CloudMaterialObjectInput): file is CloudMaterialObjectInput {
  return 'key' in file;
}

function usePostgresMaterials(request: typeof adminFetch): boolean {
  return request === adminFetch
    && currentDataAuthority() !== 'local'
    && selectedDataBackend() === 'postgres';
}

/**
 * Material metadata must follow the authority selected by authentication.
 *
 * Most of this module predates local-authenticated preview accounts and used
 * `adminFetch` directly. That is correct for a PocketBase-authenticated
 * request, but a local-authenticated request is deliberately forbidden from
 * reaching PocketBase. New uploads already store their bytes in object
 * storage, so their metadata can safely use the same local DataStore as the
 * rest of the request instead of crossing that authority boundary.
 *
 * A caller-supplied request remains an explicit test/adapter port and must not
 * be replaced with an implicit store.
 */
function materialMetadataStore(
  request: typeof adminFetch,
  explicit?: DataStore,
): DataStore | undefined {
  if (explicit) return explicit;
  if (request !== adminFetch) return undefined;
  if (currentDataAuthority() === 'local') return pbStore;
  return selectedDataBackend() === 'postgres' ? postgresStore : undefined;
}

function assertMaterialV2ProductBinding(
  metadata: MaterialAssetV2Metadata | null | undefined,
  productIdValue: unknown,
): void {
  if (!metadata) return;
  const productId = String(productIdValue || '').trim();
  if ((metadata.enterpriseCommon || metadata.assetRole === 'generic_scene_plate') && productId) {
    throw new Error('enterprise common material cannot bind a product');
  }
  if (metadata.productIdentityLevel === 'exact' && !productId) {
    throw new Error('exact product material requires a product binding');
  }
}

/**
 * Exact-SKU identity belongs to the content-addressed material bytes, not to
 * the screen or task that happens to reference them. Once those bytes have an
 * exact product binding, neither a metadata edit nor a same-hash upload may
 * move them to another product (or clear the binding).
 */
export function assertExactMaterialProductBindingImmutable(
  existing: Record<string, unknown>,
  nextProductIdValue: unknown,
  nextMetadata?: MaterialAssetV2Metadata | null,
): void {
  const currentProductId = String(existing.productId || existing.product_id || '').trim();
  const nextProductId = String(nextProductIdValue || '').trim();
  const currentMetadata = materialAssetV2FromRecord(existing);
  const exactBefore = currentMetadata?.productIdentityLevel === 'exact';
  const exactAfter = nextMetadata?.productIdentityLevel === 'exact';
  if (exactBefore && nextMetadata && !exactAfter) {
    throw new Error('exact_product_binding_immutable');
  }
  if (currentProductId && currentProductId !== nextProductId && (exactBefore || exactAfter)) {
    throw new Error('exact_product_binding_immutable');
  }
}

/**
 * Create one material metadata record. New uploads may keep their bytes in
 * object storage while legacy callers can still attach PocketBase file fields.
 * The application server only supplies transient paths, buffers or object keys.
 *
 * `videoFile` is the historical collection field name. It stores the original
 * media for video, image and audio records; `type` remains the media authority.
 */
export async function createCloudMaterial(
  input: CreateCloudMaterialInput,
  request: typeof adminFetch = adminFetch,
): Promise<CloudMaterialRecord> {
  if (!input.tenantId.trim()) throw new Error('material tenant is required');
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error('material sha256 is invalid');
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) throw new Error('material size is invalid');
  assertMaterialV2ProductBinding(input.materialV2, input.productId);

  if (!('path' in input.media) && !('buf' in input.media) && !isObjectInput(input.media)) {
    throw new Error('material media reference is invalid');
  }
  const form = new FormData();
  const fields: Record<string, unknown> = {
    tenantId: input.tenantId,
    title: input.title,
    folder: input.folder,
    type: input.type,
    duration: Math.max(0, Number(input.duration || 0)),
    width: Math.max(0, Math.round(Number(input.width || 0))),
    height: Math.max(0, Math.round(Number(input.height || 0))),
    sizeBytes: input.sizeBytes,
    sha256: input.sha256.toLowerCase(),
    scope: input.scope || 'own',
    usage: input.usage || 'editable',
    sourceType: input.sourceType || 'tenant_upload',
    sourceName: input.sourceName || input.title,
    sourceProvider: input.sourceProvider,
    sourceCreator: input.sourceCreator,
    sourceUrl: input.sourceUrl,
    productId: input.productId,
    productName: input.productName,
    tags: input.tags,
    industry: input.industry,
    shotFunction: input.shotFunction,
    applicability: input.applicability,
    licenseEvidence: input.licenseEvidence,
    licenseName: input.licenseName,
    licenseUrl: input.licenseUrl,
    attributionText: input.attributionText,
    commercialUseApproved: input.commercialUseApproved,
    derivativesApproved: input.derivativesApproved,
    rawLibraryUseApproved: input.rawLibraryUseApproved,
    provenance: {
      ...(input.provenance || {}),
      ...(input.materialV2 ? { materialAssetV2: input.materialV2 } : {}),
      sourceEntry: input.sourceEntry || input.provenance?.sourceEntry || materialAssetPolicy({
        scope: input.scope,
        tenantId: input.tenantId,
        sourceType: input.sourceType,
      }).sourceEntry,
    },
    ...(isObjectInput(input.media) ? {
      objectKey: input.media.key,
      objectEtag: input.media.etag,
      storageBackend: 'object_storage',
    } : {}),
    ...(input.poster && isObjectInput(input.poster) ? {
      posterObjectKey: input.poster.key,
      posterObjectEtag: input.poster.etag,
    } : {}),
  };
  for (const [key, value] of Object.entries(fields)) appendCloudMaterialField(form, key, value);
  if (!isObjectInput(input.media)) form.append('videoFile', await cloudMaterialBlob(input.media), input.media.name);
  const poster = input.poster || {
    name: `${input.sha256.slice(0, 16)}.poster.png`,
    contentType: 'image/png',
    buf: FALLBACK_POSTER_PNG,
  };
  if (!isObjectInput(poster)) form.append('posterFile', await cloudMaterialBlob(poster), poster.name);

  const metadataStore = materialMetadataStore(request);
  if (metadataStore) {
    if (!isObjectInput(input.media) || !isObjectInput(poster)) {
      throw new Error('Material metadata requires media and poster bytes to be stored in object storage first');
    }
    const record = await metadataStore.create<CloudMaterialRecord>('materials', fields);
    if (!record?.id || materialTenantId(record) !== input.tenantId) throw new Error('material database returned an invalid tenant record');
    return record;
  }

  const response = await request('/api/collections/materials/records', { method: 'POST', body: form });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`material database write failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  const record = await response.json() as CloudMaterialRecord;
  if (!record.id || materialTenantId(record) !== input.tenantId) {
    throw new Error('material database returned an invalid tenant record');
  }
  return record;
}

const PLAYBACK_URL_CACHE_TTL_MS = 45_000;
const playbackUrlCache = new Map<string, { url: string; expiresAt: number }>();
const playbackUrlRequests = new Map<string, Promise<string | null>>();

async function resolveCloudMaterialPlaybackUrl(
  id: string,
  field: 'videoFile' | 'posterFile',
  tenantId?: string,
  forceRefresh = false,
): Promise<string | null> {
  const cacheKey = `${tenantId || 'unscoped'}:${id}:${field}`;
  if (forceRefresh) playbackUrlCache.delete(cacheKey);
  const cached = playbackUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const pending = playbackUrlRequests.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const metadataStore = materialMetadataStore(adminFetch);
    const record = metadataStore
      ? await metadataStore.getById<CloudMaterialRecord>('materials', id)
      : await (async () => {
        const response = await adminFetch(`/api/collections/materials/records/${encodeURIComponent(id)}`);
        return response.ok ? response.json() as Promise<CloudMaterialRecord> : null;
      })();
    if (!record) return null;
    if (tenantId && !canAccessCloudMaterial(record, tenantId)) return null;
    const filename = String(record[field] || '');
    if (!filename) return null;
    const url = await createFilePlaybackUrl('materials', id, filename);
    if (url) playbackUrlCache.set(cacheKey, { url, expiresAt: Date.now() + PLAYBACK_URL_CACHE_TTL_MS });
    return url;
  })().finally(() => playbackUrlRequests.delete(cacheKey));
  playbackUrlRequests.set(cacheKey, request);
  return request;
}

function materialTenantId(item: Record<string, unknown>): string {
  return String(item.tenantId || item.tenant_id || '').trim();
}

function canAccessCloudMaterial(item: Record<string, unknown>, tenantId: string): boolean {
  const scope = String(item.scope || 'own');
  return scope === 'shared' || Boolean(tenantId && materialTenantId(item) === tenantId);
}

export function cloudMaterialView(item: CloudMaterialRecord): Record<string, unknown> {
  const provenance = item.provenance && typeof item.provenance === 'object'
    ? item.provenance as Record<string, unknown>
    : parseObject(item.provenance);
  const width = Number(item.width || 0);
  const height = Number(item.height || 0);
  const policy = materialAssetPolicy({ ...item, provenance });
  const materialV2 = materialAssetV2FromRecord({ ...item, provenance });
  return {
    id: `pb-${item.id}`, cloudRecordId: String(item.id), name: String(item.title || item.sourceName || item.name || '云端素材'),
    folder: String(item.folder || 'upload'), type: String(item.type || 'video'), duration: Number(item.duration || 0),
    width: width || undefined, height: height || undefined,
    aspectRatio: width > 0 && height > 0 ? +(width / height).toFixed(4) : undefined,
    size: humanSize(Number(item.sizeBytes || 0)), sizeBytes: Number(item.sizeBytes || 0), file: String(item.videoFile || item.objectKey || ''),
    url: `/studio-media/${item.id}/media.mp4`, poster: `/studio-media/${item.id}/poster.jpg`,
    scope: String(item.scope || 'own'), tenantId: materialTenantId(item), usage: String(item.usage || 'editable'),
    sourceCategory:item.sourceCategory,
    primaryTheme:item.primaryTheme,
    themeTags:parseSegments(item.themeTags),
    classificationStatus:item.classificationStatus,
    classificationSource:item.classificationSource,
    classificationEvidence:parseSegments(item.classificationEvidence),
    sourceType: String(item.sourceType || 'licensed_upload'), sourceName: String(item.sourceName || ''),
    sourceProvider: String(item.sourceProvider || ''), sourceCreator: String(item.sourceCreator || ''),
    sourceUrl: String(item.sourceUrl || ''),
    productId: String(item.productId || ''), productName: String(item.productName || ''),
    productRef: String(provenance?.productRef || ''),
    productRefs: Array.isArray(provenance?.productRefs) ? provenance.productRefs : [],
    sourceTaskIds: Array.isArray(provenance?.sourceTaskIds) ? provenance.sourceTaskIds : [],
    sourceTaskFileRefs: Array.isArray(provenance?.sourceTaskFileRefs) ? provenance.sourceTaskFileRefs : [],
    contentSha256: String(item.sha256 || ''), sha256: String(item.sha256 || ''),
    licenseEvidence: String(item.licenseEvidence || item.license || ''),
    licenseName: String(item.licenseName || ''), licenseUrl: String(item.licenseUrl || ''),
    attributionText: String(item.attributionText || ''), licenseEvidenceCapturedAt: String(item.licenseEvidenceCapturedAt || ''),
    licenseEvidenceTextSha256: String(item.licenseEvidenceTextSha256 || ''), importBatchId: String(item.importBatchId || ''),
    manifestSha256: String(item.manifestSha256 || ''), importedAt: String(item.importedAt || ''), commercialUseApproved: Boolean(item.commercialUseApproved),
    derivativesApproved: Boolean(item.derivativesApproved), rawLibraryUseApproved: Boolean(item.rawLibraryUseApproved),
    provenance,
    materialV2,
    enterpriseCommon: materialV2?.enterpriseCommon ?? (
      item.enterpriseCommon === true || item.enterprise_common === true || item.isEnterpriseCommon === true
    ),
    ownership: policy.ownership,
    visibility: policy.visibility,
    knowledgeEligible: policy.knowledgeEligible,
    sourceEntry: policy.sourceEntry,
    transcript: String(provenance?.avatarSourceTranscript || ''),
    transcriptCues: parseSegments(provenance?.avatarSourceCues),
    transcriptCuesProvenance: String(provenance?.avatarSourceCuesProvenance || ''),
    transcriptSourceHash: String(provenance?.avatarSourceHash || ''),
    industry: String(item.industry || ''), shotFunction: String(item.shotFunction || ''),
    applicability: String(item.applicability || ''), tags: String(item.tags || ''),
    createdAt: String(item.created || ''), updatedAt: String(item.updated || ''),
    analysisSourceRevision: String(item.analysisSourceRevision || ''), sourceRevision: String(item.sha256 || item.objectEtag || item.videoFile || ''),
    pinned: Boolean(item.pinned), segmentAnalysisStatus: item.segmentAnalysisStatus ? String(item.segmentAnalysisStatus) : undefined,
    segmentAnalysisError: item.segmentAnalysisError ? String(item.segmentAnalysisError) : undefined,
    visualObservations: parseSegments(item.visualObservations), segments: parseSegments(item.segments),
    scriptAnalysis: parseObject(item.scriptAnalysis) || parseObject(provenance?.materialScriptAnalysis),
  };
}

export type MaterialSourceStatus = { source: 'server' | 'database'; state: 'ready' | 'unavailable' | 'unauthorized'; message: string };
export async function readCloudMaterialLibrary(tenantId: string, request: typeof adminFetch = adminFetch, dataStore?: DataStore): Promise<{ items: Array<Record<string, unknown>>; source: MaterialSourceStatus }> {
  try {
    const rows: CloudMaterialRecord[] = [];
    const metadataStore = materialMetadataStore(request, dataStore);
    if (metadataStore) {
      for (let page = 1; ; page += 1) {
        const data = await metadataStore.list<CloudMaterialRecord>('materials', { page, perPage: 500 });
        rows.push(...data.items.filter(item => canAccessCloudMaterial(item, tenantId)));
        if (page >= data.totalPages) break;
        if (page >= 100) throw Error('material_pagination_limit');
      }
      return { items: rows.map(cloudMaterialView), source: { source: 'database', state: 'ready', message: '素材数据库已连接' } };
    }
    const signal = AbortSignal.timeout(8000);
    for (let page = 1; ; page++) {
      const response = await request(`/api/collections/materials/records?perPage=500&page=${page}`, { signal });
      if (!response.ok) return { items: [], source: { source: 'database', state: [401,403].includes(response.status) ? 'unauthorized' : 'unavailable',
        message: [401,403].includes(response.status) ? '素材数据库访问权限异常，请联系管理员' : '素材数据库暂时不可用，请重试' } };
      const data = await response.json() as { items?: CloudMaterialRecord[]; totalPages?: number };
      if (!Array.isArray(data.items)) throw Error('invalid_material_response');
      rows.push(...data.items.filter(item => canAccessCloudMaterial(item, tenantId)));
      if (page >= Number(data.totalPages || 1)) break;
      if (page >= 100) throw Error('material_pagination_limit');
    }
    const items = rows.map(cloudMaterialView);
    return { items, source: { source: 'database', state: 'ready', message: '素材数据库已连接' } };
  } catch {
    return { items: [], source: { source: 'database', state: 'unavailable', message: '素材数据库连接失败，当前仅能使用已读取的服务端素材；请重试或联系管理员' } };
  }
}
/** Legacy consumers retain the array API; user-facing inventory uses the status envelope. */
export async function listCloudMaterials(tenantId: string): Promise<Array<Record<string, unknown>>> {
  return (await readCloudMaterialLibrary(tenantId)).items;
}

export async function getCloudMaterialRecord(id: string, tenantId?: string): Promise<Record<string, unknown> | null> {
  const metadataStore = materialMetadataStore(adminFetch);
  if (metadataStore) {
    const record = await metadataStore.getById<CloudMaterialRecord>('materials', id);
    return record && (!tenantId || canAccessCloudMaterial(record, tenantId)) ? record : null;
  }
  const response = await adminFetch(`/api/collections/materials/records/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const record = await response.json() as Record<string, unknown>;
  return tenantId && !canAccessCloudMaterial(record, tenantId) ? null : record;
}

/** 写操作只能落在当前租户自己的私有素材上；共享素材对普通租户只读。 */
export async function getOwnedCloudMaterialRecord(id: string, tenantId: string): Promise<Record<string, unknown> | null> {
  const metadataStore = materialMetadataStore(adminFetch);
  if (metadataStore) {
    const record = await metadataStore.getById<CloudMaterialRecord>('materials', id);
    return record && String(record.scope || 'own') !== 'shared' && materialTenantId(record) === tenantId ? record : null;
  }
  const response = await adminFetch(`/api/collections/materials/records/${encodeURIComponent(id)}`);
  if (!response.ok) return null;
  const record = await response.json() as Record<string, unknown>;
  return String(record.scope || 'own') !== 'shared' && materialTenantId(record) === tenantId ? record : null;
}

export async function findOwnedCloudMaterialByHash(
  tenantId: string,
  sha256: string,
  request: typeof adminFetch = adminFetch,
): Promise<CloudMaterialRecord | null> {
  if (!tenantId.trim() || !/^[a-f0-9]{64}$/i.test(sha256)) return null;
  const filter = `tenantId="${pocketBaseFilterValue(tenantId)}" && scope="own" && sha256="${sha256.toLowerCase()}"`;
  const metadataStore = materialMetadataStore(request);
  if (metadataStore && !usePostgresMaterials(request)) {
    const result = await metadataStore.list<CloudMaterialRecord>('materials', {
      where: { tenantId, scope: 'own', sha256: sha256.toLowerCase() },
      page: 1,
      perPage: 1,
    });
    return result.items[0] || null;
  }
  if (usePostgresMaterials(request)) {
    const result = await postgresListWithPocketBaseFilter<CloudMaterialRecord>('materials', { filter, page: 1, perPage: 1 });
    return result.items[0] || null;
  }
  const response = await request(`/api/collections/materials/records?perPage=1&page=1&filter=${encodeURIComponent(filter)}`);
  if (!response.ok) throw new Error(`material database lookup failed (${response.status})`);
  const result = await response.json() as { items?: CloudMaterialRecord[] };
  const record = result.items?.[0];
  return record && materialTenantId(record) === tenantId && String(record.scope || 'own') !== 'shared' ? record : null;
}

function pocketBaseFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function ownedCloudMaterialByHash(
  tenantId: string,
  sha256: string,
  request: typeof adminFetch,
): Promise<CloudMaterialRecord | null> {
  const filter = `tenantId = "${pocketBaseFilterValue(tenantId)}" && sha256 = "${sha256.toLowerCase()}" && scope != "shared"`;
  const metadataStore = materialMetadataStore(request);
  if (metadataStore && !usePostgresMaterials(request)) {
    const result = await metadataStore.list<CloudMaterialRecord>('materials', {
      where: { tenantId, scope: 'own', sha256: sha256.toLowerCase() },
      page: 1,
      perPage: 2,
    });
    if (result.totalItems > 1) throw new Error('duplicate tenant material hash records');
    return result.items[0] || null;
  }
  if (usePostgresMaterials(request)) {
    const result = await postgresListWithPocketBaseFilter<CloudMaterialRecord>('materials', { filter, page: 1, perPage: 2 });
    if (result.totalItems > 1) throw new Error('duplicate tenant material hash records');
    return result.items[0] || null;
  }
  const response = await request(`/api/collections/materials/records?perPage=2&filter=${encodeURIComponent(filter)}`);
  if (!response.ok) throw new Error(`material database lookup failed (${response.status})`);
  const payload = await response.json() as { items?: CloudMaterialRecord[] };
  const items = Array.isArray(payload.items) ? payload.items.filter(item => materialTenantId(item) === tenantId) : [];
  if (items.length > 1) throw new Error('duplicate tenant material hash records');
  return items[0] || null;
}

/**
 * Register tenant-owned bytes in the single material inventory. Re-uploading
 * the same bytes from Knowledge or Studio reuses the record and records every
 * entry point, instead of creating competing copies with different ownership.
 */
export async function upsertTenantUploadCloudMaterial(
  input: CreateCloudMaterialInput & {
    sourceEntry: Exclude<MaterialSourceEntry, 'platform_operations'>;
    /**
     * Metadata revalidated by the application server from the uploaded bytes.
     * It is applied only when hash deduplication reuses an existing row, so a
     * repeated upload cannot retain stale product binding, duration or rights.
     */
    verifiedDeduplicatedUpdate?: VerifiedDeduplicatedMaterialUpdate;
  },
  request: typeof adminFetch = adminFetch,
): Promise<Record<string, unknown>> {
  if (input.scope === 'shared') throw new Error('tenant upload cannot be platform shared');
  const existing = await ownedCloudMaterialByHash(input.tenantId, input.sha256, request);
  if (!existing) return cloudMaterialView(await createCloudMaterial({ ...input, scope: 'own' }, request));

  const current = existing.provenance && typeof existing.provenance === 'object'
    ? existing.provenance as Record<string, unknown>
    : parseObject(existing.provenance) || {};
  const effectiveMaterialV2 = input.materialV2 || materialAssetV2FromRecord(existing);
  const effectiveProductId = input.productId || existing.productId || existing.product_id;
  assertExactMaterialProductBindingImmutable(existing, effectiveProductId, effectiveMaterialV2);
  assertMaterialV2ProductBinding(effectiveMaterialV2, effectiveProductId);
  const sourceEntries = Array.from(new Set([
    ...(Array.isArray(current.sourceEntries) ? current.sourceEntries : []),
    current.sourceEntry,
    input.sourceEntry,
  ].map(String).filter(Boolean)));
  const provenance = {
    ...current,
    ...(input.provenance || {}),
    ...(input.materialV2 ? { materialAssetV2: input.materialV2 } : {}),
    sourceEntry: input.sourceEntry === 'enterprise_knowledge' ? input.sourceEntry : current.sourceEntry || input.sourceEntry,
    sourceEntries,
  };
  const updateFields = {
    ...verifiedDeduplicatedMaterialFields(input.verifiedDeduplicatedUpdate),
    provenance,
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.productName ? { productName: input.productName } : {}),
  };
  const metadataStore = materialMetadataStore(request);
  if (metadataStore) {
    const saved = await metadataStore.update('materials', existing.id, updateFields);
    if (!saved) throw new Error('material entry association update failed');
    return cloudMaterialView({ ...existing, ...updateFields } as CloudMaterialRecord);
  }
  const response = await request(`/api/collections/materials/records/${encodeURIComponent(existing.id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updateFields),
  });
  if (!response.ok) throw new Error(`material entry association update failed (${response.status})`);
  const updated = await response.json() as CloudMaterialRecord;
  if (materialTenantId(updated) !== input.tenantId || String(updated.scope || 'own') === 'shared') {
    throw new Error('material database returned an invalid tenant record');
  }
  return cloudMaterialView(updated);
}

export interface UpsertSocialTaskCloudMaterialInput extends Omit<CreateCloudMaterialInput,
  'folder' | 'scope' | 'usage' | 'sourceType' | 'sourceName' | 'sourceProvider' | 'licenseEvidence' | 'provenance'> {
  taskId: string;
  taskFileRef: string;
  productRef?: string | null;
}

/**
 * Bridge a creative task upload into My Materials without mirroring it under
 * `data/media`. One tenant/hash pair owns one immutable file; task associations
 * are merged into provenance when the same bytes are reused by another task.
 */
export async function upsertSocialTaskCloudMaterial(
  input: UpsertSocialTaskCloudMaterialInput,
  request: typeof adminFetch = adminFetch,
): Promise<Record<string, unknown>> {
  const existing = await ownedCloudMaterialByHash(input.tenantId, input.sha256, request);
  const productRef = String(input.productRef || '').trim();
  const productId = String(input.productId || '').trim();
  if (existing) {
    const current = existing.provenance && typeof existing.provenance === 'object'
      ? existing.provenance as Record<string, unknown>
      : parseObject(existing.provenance) || {};
    const effectiveMaterialV2 = input.materialV2 || materialAssetV2FromRecord(existing);
    const effectiveProductId = productId || existing.productId || existing.product_id;
    assertExactMaterialProductBindingImmutable(existing, effectiveProductId, effectiveMaterialV2);
    assertMaterialV2ProductBinding(effectiveMaterialV2, effectiveProductId);
    const merged = {
      ...current,
      ...(input.materialV2 ? { materialAssetV2: input.materialV2 } : {}),
      sourceTaskIds: Array.from(new Set([
        ...(Array.isArray(current.sourceTaskIds) ? current.sourceTaskIds : []),
        input.taskId,
      ].map(String).filter(Boolean))),
      sourceTaskFileRefs: Array.from(new Set([
        ...(Array.isArray(current.sourceTaskFileRefs) ? current.sourceTaskFileRefs : []),
        input.taskFileRef,
      ].map(String).filter(Boolean))),
      productRefs: Array.from(new Set([
        ...(Array.isArray(current.productRefs) ? current.productRefs : []),
        productRef,
      ].map(String).filter(Boolean))),
      ...(productRef ? { productRef } : {}),
    };
    const metadataStore = materialMetadataStore(request);
    if (metadataStore) {
      const updated = await metadataStore.update('materials', existing.id, { provenance: merged, ...(productId ? { productId } : {}) });
      if (!updated) throw new Error('material association update failed (404)');
      const record = await metadataStore.getById<CloudMaterialRecord>('materials', existing.id);
      if (!record) throw new Error('material association update returned no record');
      return cloudMaterialView(record);
    }
    const response = await request(`/api/collections/materials/records/${encodeURIComponent(existing.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provenance: merged, ...(productId ? { productId } : {}) }),
    });
    if (!response.ok) throw new Error(`material association update failed (${response.status})`);
    return cloudMaterialView(await response.json() as CloudMaterialRecord);
  }

  const provenance = {
    sourceTaskIds: [input.taskId],
    sourceTaskFileRefs: [input.taskFileRef],
    productRefs: productRef ? [productRef] : [],
    ...(productRef ? { productRef } : {}),
    uploadedAt: new Date().toISOString(),
  };
  const created = await createCloudMaterial({
    ...input,
    folder: '任务素材',
    scope: 'own',
    usage: 'editable',
    sourceType: 'social_task_upload',
    sourceName: input.title,
    sourceProvider: 'tenant',
    licenseEvidence: 'tenant_upload_unverified',
    productName: input.productName,
    provenance,
  }, request);
  return cloudMaterialView(created);
}

export async function deleteOwnedCloudMaterial(
  id: string,
  tenantId: string,
  request: typeof adminFetch = adminFetch,
): Promise<'deleted' | 'not_found'> {
  const metadataStore = materialMetadataStore(request);
  if (metadataStore) {
    const record = await metadataStore.getById<CloudMaterialRecord>('materials', id);
    if (!record || String(record.scope || 'own') === 'shared' || materialTenantId(record) !== tenantId) return 'not_found';
    const deleted = await metadataStore.delete('materials', id);
    if (!deleted) return 'not_found';
    playbackUrlCache.delete(`${tenantId}:${id}:videoFile`);
    playbackUrlCache.delete(`${tenantId}:${id}:posterFile`);
    return 'deleted';
  }
  const response = await request(`/api/collections/materials/records/${encodeURIComponent(id)}`);
  if (response.status === 404) return 'not_found';
  if (!response.ok) throw new Error(`material database read failed (${response.status})`);
  const record = await response.json() as CloudMaterialRecord;
  if (String(record.scope || 'own') === 'shared' || materialTenantId(record) !== tenantId) return 'not_found';
  const deleted = await request(`/api/collections/materials/records/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (deleted.status === 404) return 'not_found';
  if (!deleted.ok) throw new Error(`material database delete failed (${deleted.status})`);
  playbackUrlCache.delete(`${tenantId}:${id}:videoFile`);
  playbackUrlCache.delete(`${tenantId}:${id}:posterFile`);
  return 'deleted';
}

export async function updateCloudMaterial(id: string, fields: Record<string, unknown>): Promise<boolean> {
  const metadataStore = materialMetadataStore(adminFetch);
  if (metadataStore) return metadataStore.update('materials', id, fields);
  const response = await adminFetch(`/api/collections/materials/records/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  return response.ok;
}

/** PocketBase 的 json 字段可能回传数组本身，也可能回传字符串，两种都要接住。 */
function parseSegments(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function fetchCloudMaterial(
  id: string,
  field: 'videoFile' | 'posterFile',
  range?: string,
  tenantId?: string,
  request: typeof adminFetch = adminFetch,
): Promise<Response | null> {
  const metadataStore = materialMetadataStore(request);
  const record = metadataStore
    ? await metadataStore.getById<CloudMaterialRecord>('materials', id)
    : await (async () => {
      const recordResponse = await request(`/api/collections/materials/records/${encodeURIComponent(id)}`);
      return recordResponse.ok ? recordResponse.json() as Promise<CloudMaterialRecord> : null;
    })();
  if (!record) return null;
  if (tenantId && !canAccessCloudMaterial(record, tenantId)) return null;
  const objectKey = field === 'videoFile' ? String(record.objectKey || '') : String(record.posterObjectKey || '');
  if (objectKey) {
    const object = await objectStorageGetObject(objectKey, range);
    if (!object) return null;
    const headers = new Headers({
      'content-type': object.contentType,
      'content-length': String(object.contentLength ?? object.size),
      ...(object.contentRange ? { 'content-range': object.contentRange } : {}),
      ...(object.acceptRanges ? { 'accept-ranges': object.acceptRanges } : { 'accept-ranges': 'bytes' }),
      ...(object.etag ? { etag: object.etag } : {}),
      ...(object.lastModified ? { 'last-modified': object.lastModified.toUTCString() } : {}),
    });
    return new Response(Readable.toWeb(Readable.from(object.body)) as ReadableStream, {
      status: object.contentRange ? 206 : 200,
      headers,
    });
  }
  let url = await resolveCloudMaterialPlaybackUrl(id, field, tenantId);
  if (!url) return null;
  let upstream = await fetch(url, { headers: range ? { Range: range } : undefined });
  if (upstream.status === 401 || upstream.status === 403) {
    url = await resolveCloudMaterialPlaybackUrl(id, field, tenantId, true);
    if (!url) return null;
    upstream = await fetch(url, { headers: range ? { Range: range } : undefined });
  }
  return upstream.ok ? upstream : null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
