import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import {
  PRODUCT_ASSET_REQUEST_KINDS,
  PRODUCTION_INPUT_CATEGORIES,
  PRODUCTION_INPUT_KINDS,
  productionInputCategoryForKind,
  type CreateProductionInputRequestInput,
  type ProductDimensions,
  type ProductionInputBinding,
  type ProductionInputFulfillment,
  type ProductionInputFulfillmentType,
  type ProductionInputKind,
  type ProductionInputRequest,
  type ProductionInputRequestStatus,
} from '../../shared/contracts/productionInputRequest.js';
import {
  materialAssetV2FromRecord,
  type MaterialContentRoleV2,
} from '../../shared/contracts/materialAssetV2.js';

export const PRODUCTION_INPUT_REQUEST_COLLECTION = 'production_input_requests';
/** Product requests use the same durable collection and state machine. */
export const PRODUCT_ASSET_REQUEST_COLLECTION = PRODUCTION_INPUT_REQUEST_COLLECTION;

type ProductionInputRequestRow = {
  id: string;
  schema_version: string;
  tenant_id: string;
  dedupe_key: string;
  request_hash: string;
  category: string;
  kind: string;
  status: string;
  title: string;
  instructions: string;
  required: boolean;
  blocking: boolean;
  subject_ref: string;
  product_id: string;
  product_name: string;
  bindings: unknown;
  accepted_mime_types: unknown;
  specification: unknown;
  fulfillments: unknown;
  minimum_items: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  fulfilled_at: string;
  waived_at: string;
  waiver_reason: string;
};

export class ProductionInputRequestError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
    this.name = 'ProductionInputRequestError';
  }
}

const SAFE_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:@/+-]*$/u;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const STATUS = new Set<ProductionInputRequestStatus>(['open', 'partial', 'fulfilled', 'waived']);
const FULFILLMENT_TYPES = new Set<ProductionInputFulfillmentType>(['material', 'document', 'structured_data', 'authorization']);

function id(value: unknown, field: string, required = true, max = 240): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if ((!normalized && required) || normalized.length > max || (normalized && !SAFE_ID.test(normalized))) {
    throw new ProductionInputRequestError(`production_input_${field}_invalid`);
  }
  return normalized;
}

function boundedText(value: unknown, field: string, max: number, required = false): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if ((!normalized && required) || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(normalized)) {
    throw new ProductionInputRequestError(`production_input_${field}_invalid`);
  }
  return normalized;
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductionInputRequestError(`production_input_${field}_invalid`);
  }
  let encoded = '';
  try { encoded = JSON.stringify(value); } catch { throw new ProductionInputRequestError(`production_input_${field}_invalid`); }
  if (encoded.length > 64 * 1024) throw new ProductionInputRequestError(`production_input_${field}_too_large`);
  return structuredClone(value as Record<string, unknown>);
}

function parsedJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value === undefined || value === null ? fallback : value as T;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizeBindings(value: unknown): ProductionInputBinding[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200) throw new ProductionInputRequestError('production_input_bindings_invalid');
  const unique = new Map<string, ProductionInputBinding>();
  value.forEach(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProductionInputRequestError('production_input_binding_invalid');
    const binding = raw as Record<string, unknown>;
    const taskId = id(binding.taskId, 'binding_task');
    const shotId = id(binding.shotId, 'binding_shot', false);
    unique.set(`${taskId}\u0000${shotId}`, { taskId, shotId: shotId || null });
  });
  return [...unique.values()].sort((left, right) => left.taskId.localeCompare(right.taskId)
    || String(left.shotId || '').localeCompare(String(right.shotId || '')));
}

function mergeBindings(left: ProductionInputBinding[], right: ProductionInputBinding[]): ProductionInputBinding[] {
  return normalizeBindings([...left, ...right]);
}

function defaultMimeTypes(kind: ProductionInputKind): string[] {
  if (kind === 'product_transparent_png') return ['image/png'];
  if (kind === 'product_packaging_dieline_pdf') return ['application/pdf'];
  if (kind === 'product_label_artwork') return ['image/png', 'image/jpeg', 'application/pdf'];
  if (kind.endsWith('_image') || kind === 'digital_human_portrait') return ['image/png', 'image/jpeg', 'image/webp'];
  if (kind === 'digital_human_voice_sample') return ['audio/wav', 'audio/mpeg', 'audio/mp4'];
  if (kind === 'scene_plate') return ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime'];
  return [];
}

function normalizeMimeTypes(value: unknown, kind: ProductionInputKind): string[] {
  const source = value === undefined ? defaultMimeTypes(kind) : value;
  if (!Array.isArray(source) || source.length > 30) throw new ProductionInputRequestError('production_input_mime_types_invalid');
  const normalized = [...new Set(source.map(item => typeof item === 'string' ? item.trim().toLowerCase() : ''))];
  if (normalized.some(item => !MIME.test(item))) throw new ProductionInputRequestError('production_input_mime_types_invalid');
  return normalized.sort();
}

function normalizeCreateInput(input: CreateProductionInputRequestInput): {
  normalized: Omit<ProductionInputRequest, 'id' | 'status' | 'fulfillments' | 'createdAt' | 'updatedAt' | 'fulfilledAt' | 'waivedAt' | 'waiverReason'>;
  dedupeKey: string;
  requestHash: string;
} {
  const kind = String(input.kind || '') as ProductionInputKind;
  if (!PRODUCTION_INPUT_KINDS.includes(kind)) throw new ProductionInputRequestError('production_input_kind_invalid');
  const inferredCategory = productionInputCategoryForKind(kind);
  const category = String(input.category || inferredCategory) as typeof inferredCategory;
  if (!PRODUCTION_INPUT_CATEGORIES.includes(category) || category !== inferredCategory) {
    throw new ProductionInputRequestError('production_input_category_kind_mismatch');
  }
  const productId = id(input.productId, 'product_id', false);
  if ((PRODUCT_ASSET_REQUEST_KINDS as readonly string[]).includes(kind) && !productId) {
    throw new ProductionInputRequestError('production_input_product_id_required');
  }
  const subjectRef = id(input.subjectRef, 'subject_ref', false);
  const bindings = normalizeBindings(input.bindings);
  if (!productId && !subjectRef && bindings.length === 0) {
    throw new ProductionInputRequestError('production_input_subject_or_binding_required');
  }
  const minimumItems = input.minimumItems === undefined ? 1 : Number(input.minimumItems);
  if (!Number.isSafeInteger(minimumItems) || minimumItems < 1 || minimumItems > 50) {
    throw new ProductionInputRequestError('production_input_minimum_items_invalid');
  }
  const title = boundedText(input.title, 'title', 200, true);
  const instructions = boundedText(input.instructions, 'instructions', 4_000);
  const specification = jsonObject(input.specification, 'specification');
  if (kind === 'production_choice') {
    const options = specification.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > 50) {
      throw new ProductionInputRequestError('production_input_choice_options_required');
    }
    const normalizedOptions = [...new Set(options.map(option => boundedText(option, 'choice_option', 200, true)))];
    if (normalizedOptions.length !== options.length) {
      throw new ProductionInputRequestError('production_input_choice_options_invalid');
    }
    specification.options = normalizedOptions;
  }
  const acceptedMimeTypes = normalizeMimeTypes(input.acceptedMimeTypes, kind);
  const normalized = {
    schemaVersion: 'production-input-request.v1' as const,
    category,
    kind,
    title,
    instructions,
    required: input.required !== false,
    blocking: input.blocking === true,
    subjectRef: subjectRef || null,
    productId: productId || null,
    productName: boundedText(input.productName, 'product_name', 300) || null,
    bindings,
    acceptedMimeTypes,
    specification,
    minimumItems,
  };
  // Bindings, title and urgency are intentionally excluded: one reusable input
  // gap can satisfy many tasks/shots and is promoted to blocking if any caller
  // needs it. Requirement details remain part of the identity.
  const requestIdentity = {
    category, kind, productId: productId || null, subjectRef: subjectRef || null,
    instructions, acceptedMimeTypes, specification, minimumItems,
  };
  return {
    normalized,
    dedupeKey: `pir_${sha256(requestIdentity).slice(0, 40)}`,
    requestHash: sha256(requestIdentity),
  };
}

function requestFromRow(row: ProductionInputRequestRow): ProductionInputRequest {
  const kind = row.kind as ProductionInputKind;
  const category = row.category as ProductionInputRequest['category'];
  const status = row.status as ProductionInputRequestStatus;
  if (!row.id || row.schema_version !== 'production-input-request.v1'
    || !PRODUCTION_INPUT_KINDS.includes(kind) || !PRODUCTION_INPUT_CATEGORIES.includes(category)
    || category !== productionInputCategoryForKind(kind) || !STATUS.has(status)) {
    throw new ProductionInputRequestError('production_input_record_invalid', 503);
  }
  const bindings = normalizeBindings(parsedJson(row.bindings, []));
  const acceptedMimeTypes = normalizeMimeTypes(parsedJson(row.accepted_mime_types, []), kind);
  const specification = jsonObject(parsedJson(row.specification, {}), 'specification');
  const fulfillments = parsedJson<ProductionInputFulfillment[]>(row.fulfillments, []);
  if (!Array.isArray(fulfillments)) throw new ProductionInputRequestError('production_input_record_invalid', 503);
  return {
    id: row.id,
    schemaVersion: 'production-input-request.v1',
    category,
    kind,
    status,
    title: row.title,
    instructions: row.instructions || '',
    required: Boolean(row.required),
    blocking: Boolean(row.blocking),
    subjectRef: row.subject_ref || null,
    productId: row.product_id || null,
    productName: row.product_name || null,
    bindings,
    acceptedMimeTypes,
    specification,
    fulfillments,
    minimumItems: Number(row.minimum_items || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    fulfilledAt: row.fulfilled_at || null,
    waivedAt: row.waived_at || null,
    waiverReason: row.waiver_reason || null,
  };
}

async function exactByDedupe(store: DataStore, tenantId: string, dedupeKey: string): Promise<ProductionInputRequestRow | null> {
  const result = await store.list<ProductionInputRequestRow>(PRODUCTION_INPUT_REQUEST_COLLECTION, {
    where: { tenant_id: tenantId, dedupe_key: dedupeKey }, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new ProductionInputRequestError('production_input_dedupe_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

export async function createOrReuseProductionInputRequest(input: {
  store: DataStore;
  tenantId: string;
  userId: string;
  request: CreateProductionInputRequestInput;
  now?: Date;
}): Promise<{ request: ProductionInputRequest; created: boolean }> {
  const tenantId = id(input.tenantId, 'tenant');
  const userId = id(input.userId, 'user');
  const { normalized, dedupeKey, requestHash } = normalizeCreateInput(input.request);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ProductionInputRequestError('production_input_time_invalid');
  const current = await exactByDedupe(input.store, tenantId, dedupeKey);
  if (current) {
    if (current.request_hash !== requestHash) throw new ProductionInputRequestError('production_input_dedupe_conflict', 409);
    const previous = requestFromRow(current);
    const bindings = mergeBindings(previous.bindings, normalized.bindings);
    const hasNewBinding = bindings.length !== previous.bindings.length;
    const reopen = previous.status === 'waived' && hasNewBinding;
    const changes = hasNewBinding || reopen
      || (normalized.required && !previous.required) || (normalized.blocking && !previous.blocking)
      || (!previous.productName && Boolean(normalized.productName));
    if (changes) {
      const updatedAt = now.toISOString();
      if (!await input.store.update(PRODUCTION_INPUT_REQUEST_COLLECTION, current.id, {
        bindings,
        required: previous.required || normalized.required,
        blocking: previous.blocking || normalized.blocking,
        product_name: previous.productName || normalized.productName || '',
        ...(reopen ? { status: 'open', waived_at: '', waiver_reason: '' } : {}),
        updated_at: updatedAt,
      })) throw new ProductionInputRequestError('production_input_update_failed', 503);
      return { request: { ...previous, bindings, required: previous.required || normalized.required, blocking: previous.blocking || normalized.blocking, productName: previous.productName || normalized.productName, ...(reopen ? { status: 'open' as const, waivedAt: null, waiverReason: null } : {}), updatedAt }, created: false };
    }
    return { request: previous, created: false };
  }
  const timestamp = now.toISOString();
  let row: ProductionInputRequestRow | null = null;
  try {
    row = await input.store.create<ProductionInputRequestRow>(PRODUCTION_INPUT_REQUEST_COLLECTION, {
      schema_version: normalized.schemaVersion,
      tenant_id: tenantId,
      dedupe_key: dedupeKey,
      request_hash: requestHash,
      category: normalized.category,
      kind: normalized.kind,
      status: 'open',
      title: normalized.title,
      instructions: normalized.instructions,
      required: normalized.required,
      blocking: normalized.blocking,
      subject_ref: normalized.subjectRef || '',
      product_id: normalized.productId || '',
      product_name: normalized.productName || '',
      bindings: normalized.bindings,
      accepted_mime_types: normalized.acceptedMimeTypes,
      specification: normalized.specification,
      fulfillments: [],
      minimum_items: normalized.minimumItems,
      created_by: userId,
      created_at: timestamp,
      updated_at: timestamp,
      fulfilled_at: '',
      waived_at: '',
      waiver_reason: '',
    });
  } catch {
    // Expected when another process wins the database unique index. Re-read
    // below; an unrelated storage failure remains a 503 when no winner exists.
  }
  if (row) return { request: requestFromRow(row), created: true };
  // A database unique-index winner may have committed between lookup/create.
  const raced = await exactByDedupe(input.store, tenantId, dedupeKey);
  if (raced?.request_hash === requestHash) return { request: requestFromRow(raced), created: false };
  throw new ProductionInputRequestError(raced ? 'production_input_dedupe_conflict' : 'production_input_create_failed', raced ? 409 : 503);
}

export async function listProductionInputRequests(input: {
  store: DataStore;
  tenantId: string;
  category?: ProductionInputRequest['category'];
  productId?: string;
  taskId?: string;
  includeResolved?: boolean;
}): Promise<ProductionInputRequest[]> {
  const tenantId = id(input.tenantId, 'tenant');
  const rows: ProductionInputRequestRow[] = [];
  for (let page = 1; ; page += 1) {
    const result = await input.store.list<ProductionInputRequestRow>(PRODUCTION_INPUT_REQUEST_COLLECTION, {
      where: { tenant_id: tenantId, ...(input.category ? { category: input.category } : {}), ...(input.productId ? { product_id: id(input.productId, 'product_id') } : {}) },
      sort: '-updated_at', page, perPage: 200,
    });
    rows.push(...result.items);
    if (page >= result.totalPages) break;
    if (page >= 100) throw new ProductionInputRequestError('production_input_list_too_large', 503);
  }
  return rows.map(requestFromRow)
    .filter(request => input.includeResolved || request.status === 'open' || request.status === 'partial')
    .filter(request => !input.taskId || request.bindings.some(binding => binding.taskId === input.taskId));
}

export async function getProductionInputRequest(input: {
  store: DataStore;
  tenantId: string;
  requestId: string;
}): Promise<ProductionInputRequest | null> {
  const tenantId = id(input.tenantId, 'tenant');
  const row = await input.store.getById<ProductionInputRequestRow>(PRODUCTION_INPUT_REQUEST_COLLECTION, id(input.requestId, 'request_id'));
  return row?.tenant_id === tenantId ? requestFromRow(row) : null;
}

function normalizeDimensions(value: unknown): ProductDimensions {
  const data = jsonObject(value, 'dimensions');
  const width = Number(data.width);
  const height = Number(data.height);
  const depth = data.depth === undefined || data.depth === null ? null : Number(data.depth);
  const unit = String(data.unit || '') as ProductDimensions['unit'];
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0
    || (depth !== null && (!Number.isFinite(depth) || depth <= 0)) || !['mm', 'cm', 'in'].includes(unit)) {
    throw new ProductionInputRequestError('production_input_dimensions_invalid');
  }
  return { width, height, depth, unit };
}

function normalizeFulfillment(input: {
  type: ProductionInputFulfillmentType;
  sourceId: string;
  materialId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  data?: Record<string, unknown> | null;
  suppliedBy?: ProductionInputFulfillment['suppliedBy'];
  fulfillmentKey?: string;
}, request: ProductionInputRequest, now: Date): ProductionInputFulfillment {
  const type = String(input.type || '') as ProductionInputFulfillmentType;
  if (!FULFILLMENT_TYPES.has(type)) throw new ProductionInputRequestError('production_input_fulfillment_type_invalid');
  const sourceId = id(input.sourceId, 'fulfillment_source');
  const materialId = id(input.materialId, 'material_id', false);
  if (type === 'material' && !materialId) throw new ProductionInputRequestError('production_input_material_id_required');
  const mimeType = input.mimeType ? String(input.mimeType).trim().toLowerCase() : '';
  if (mimeType && !MIME.test(mimeType)) throw new ProductionInputRequestError('production_input_fulfillment_mime_invalid');
  if (mimeType && request.acceptedMimeTypes.length && !request.acceptedMimeTypes.includes(mimeType)) {
    throw new ProductionInputRequestError('production_input_fulfillment_mime_not_accepted', 409);
  }
  if (type === 'document' && request.acceptedMimeTypes.length && !mimeType) {
    throw new ProductionInputRequestError('production_input_fulfillment_mime_required');
  }
  const data = input.data === undefined || input.data === null ? null : jsonObject(input.data, 'fulfillment_data');
  const normalizedData = request.kind === 'product_dimensions' ? normalizeDimensions(data) as unknown as Record<string, unknown> : data;
  if (request.kind === 'product_dimensions' && type !== 'structured_data') {
    throw new ProductionInputRequestError('production_input_dimensions_structured_data_required');
  }
  if (request.kind === 'person_authorization' && type !== 'authorization' && type !== 'document') {
    throw new ProductionInputRequestError('production_input_authorization_evidence_required');
  }
  if (request.kind === 'person_authorization') {
    const authorizationRef = boundedText(normalizedData?.authorizationRef, 'authorization_ref', 1_000);
    const consentRef = boundedText(normalizedData?.consentRef, 'consent_ref', 1_000);
    if (!authorizationRef || !consentRef) {
      throw new ProductionInputRequestError('production_input_authorization_evidence_required');
    }
  }
  if (request.kind === 'account_authorization') {
    if (type !== 'authorization') {
      throw new ProductionInputRequestError('production_input_account_authorization_required');
    }
    const accountId = id(normalizedData?.accountId, 'authorized_account');
    const authorizationRef = boundedText(normalizedData?.authorizationRef, 'authorization_ref', 1_000);
    if (!accountId || !authorizationRef) {
      throw new ProductionInputRequestError('production_input_account_authorization_required');
    }
  }
  if (request.kind === 'production_choice' || request.kind === 'content_clarification') {
    if (type !== 'structured_data') {
      throw new ProductionInputRequestError('production_input_structured_answer_required');
    }
    const field = request.kind === 'production_choice' ? 'choice' : 'answer';
    const answer = boundedText(normalizedData?.[field], field, 4_000);
    if (!answer) {
      throw new ProductionInputRequestError('production_input_structured_answer_required');
    }
    if (request.kind === 'production_choice' && Array.isArray(request.specification.options)) {
      const options = request.specification.options
        .map(option => typeof option === 'string' ? option.trim() : '')
        .filter(Boolean);
      if (!options.includes(answer)) {
        throw new ProductionInputRequestError('production_input_choice_not_allowed', 409);
      }
    }
  }
  if (request.kind === 'product_transparent_png' && type !== 'material'
    && normalizedData?.transparentBackgroundConfirmed !== true) {
    throw new ProductionInputRequestError('production_input_transparency_confirmation_required');
  }
  const suppliedBy = input.suppliedBy ?? 'user';
  if (!['user', 'material_library', 'system'].includes(suppliedBy)) throw new ProductionInputRequestError('production_input_supplier_invalid');
  const fulfillmentKey = id(input.fulfillmentKey || `${type}:${sourceId}`, 'fulfillment_key');
  return {
    fulfillmentKey,
    type,
    sourceId,
    materialId: materialId || null,
    fileName: boundedText(input.fileName, 'file_name', 500) || null,
    mimeType: mimeType || null,
    data: normalizedData,
    suppliedBy,
    suppliedAt: now.toISOString(),
  };
}

export async function fulfillProductionInputRequest(input: {
  store: DataStore;
  tenantId: string;
  requestId: string;
  fulfillment: Parameters<typeof normalizeFulfillment>[0];
  now?: Date;
}): Promise<{ request: ProductionInputRequest; changed: boolean }> {
  const request = await getProductionInputRequest(input);
  if (!request) throw new ProductionInputRequestError('production_input_not_found', 404);
  if (request.status === 'waived') throw new ProductionInputRequestError('production_input_waived', 409);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ProductionInputRequestError('production_input_time_invalid');
  const fulfillment = normalizeFulfillment(input.fulfillment, request, now);
  const existing = request.fulfillments.find(item => item.fulfillmentKey === fulfillment.fulfillmentKey);
  if (existing) {
    const comparable = (value: ProductionInputFulfillment) => ({ ...value, suppliedAt: '' });
    if (canonical(comparable(existing)) !== canonical(comparable(fulfillment))) {
      throw new ProductionInputRequestError('production_input_fulfillment_idempotency_conflict', 409);
    }
    return { request, changed: false };
  }
  const fulfillments = [...request.fulfillments, fulfillment];
  const status: ProductionInputRequestStatus = fulfillments.length >= request.minimumItems ? 'fulfilled' : 'partial';
  const updatedAt = now.toISOString();
  const fulfilledAt = status === 'fulfilled' ? updatedAt : null;
  if (!await input.store.update(PRODUCTION_INPUT_REQUEST_COLLECTION, request.id, {
    fulfillments,
    status,
    updated_at: updatedAt,
    fulfilled_at: fulfilledAt || '',
  })) throw new ProductionInputRequestError('production_input_update_failed', 503);
  return { request: { ...request, fulfillments, status, updatedAt, fulfilledAt }, changed: true };
}

export async function waiveProductionInputRequest(input: {
  store: DataStore;
  tenantId: string;
  requestId: string;
  reason: string;
  now?: Date;
}): Promise<ProductionInputRequest> {
  const request = await getProductionInputRequest(input);
  if (!request) throw new ProductionInputRequestError('production_input_not_found', 404);
  if (request.status === 'fulfilled') throw new ProductionInputRequestError('production_input_already_fulfilled', 409);
  const reason = boundedText(input.reason, 'waiver_reason', 1_000, true);
  if (request.status === 'waived') {
    if (request.waiverReason !== reason) throw new ProductionInputRequestError('production_input_waiver_conflict', 409);
    return request;
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  if (!await input.store.update(PRODUCTION_INPUT_REQUEST_COLLECTION, request.id, {
    status: 'waived', waiver_reason: reason, waived_at: timestamp, updated_at: timestamp,
  })) throw new ProductionInputRequestError('production_input_update_failed', 503);
  return { ...request, status: 'waived', waiverReason: reason, waivedAt: timestamp, updatedAt: timestamp };
}

const MATERIAL_CONTENT_ROLE_BY_KIND: Partial<Record<ProductionInputKind, MaterialContentRoleV2>> = {
  product_front_image: 'product_front',
  product_side_image: 'product_side',
  product_back_image: 'product_back',
  product_detail_image: 'product_detail',
  product_transparent_png: 'transparent_cutout',
  product_label_artwork: 'label_artwork',
  product_packaging_dieline_pdf: 'packaging_dieline',
  fact_evidence: 'fact_evidence',
  scene_plate: 'scene_plate',
  digital_human_portrait: 'digital_human_portrait',
  digital_human_voice_sample: 'digital_human_voice',
};

export function productionInputRequestMatchesMaterial(
  request: ProductionInputRequest,
  material: Record<string, unknown>,
): boolean {
  if (!['open', 'partial'].includes(request.status)) return false;
  const metadata = materialAssetV2FromRecord(material);
  if (!metadata) return false;
  const expectedRole = MATERIAL_CONTENT_ROLE_BY_KIND[request.kind];
  if (!expectedRole || metadata.contentRole !== expectedRole) return false;
  const materialProductId = String(material.productId || material.product_id || '').trim();
  if (request.category === 'product_asset') {
    if (!request.productId || materialProductId !== request.productId) return false;
    if (metadata.productIdentityLevel !== 'exact' || metadata.assetRole !== 'exact_product') return false;
  } else {
    // General inputs can be reused, but never across unrelated presenters,
    // facts or scene needs merely because their broad role happens to match.
    if (!request.subjectRef || !metadata.subjectRefs.includes(request.subjectRef)) return false;
  }
  if (request.kind === 'scene_plate' && !metadata.enterpriseCommon && metadata.assetRole !== 'generic_scene_plate') return false;
  const type = String(material.type || '').trim();
  if (request.kind.endsWith('_image') || request.kind === 'product_transparent_png'
    || request.kind === 'digital_human_portrait') return type === 'image';
  if (request.kind === 'digital_human_voice_sample') return type === 'audio';
  return true;
}

/** Resolve every compatible open request after a material is classified or rebound. */
export async function autoFulfillProductionInputRequestsForMaterial(input: {
  store: DataStore;
  tenantId: string;
  material: Record<string, unknown>;
  now?: Date;
}): Promise<ProductionInputRequest[]> {
  const materialId = id(input.material.id, 'material_id');
  const requests = await listProductionInputRequests({ store: input.store, tenantId: input.tenantId });
  const matched: ProductionInputRequest[] = [];
  for (const request of requests) {
    if (!productionInputRequestMatchesMaterial(request, input.material)) continue;
    const result = await fulfillProductionInputRequest({
      store: input.store,
      tenantId: input.tenantId,
      requestId: request.id,
      now: input.now,
      fulfillment: {
        type: 'material',
        sourceId: materialId,
        materialId,
        mimeType: typeof input.material.mimeType === 'string' ? input.material.mimeType : null,
        suppliedBy: 'material_library',
        fulfillmentKey: `material:${materialId}`,
      },
    });
    matched.push(result.request);
  }
  return matched;
}
