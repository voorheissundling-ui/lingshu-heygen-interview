import type { DataStore } from '../storage/datastore.js';
import { currentDataAuthority } from '../storage/dataAuthority.js';
import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import { adminFetch } from '../storage/pb.js';
import { pbStore } from '../storage/pbStore.js';

const COLLECTION = 'durable_operation_leases';
const FIELDS = ['tenant_id', 'lease_scope', 'subject_id', 'lease_token', 'owner_id', 'acquired_at', 'expires_at'];
const INDEX = 'create unique index idx_durable_operation_lease_subject on durable_operation_leases (tenant_id, lease_scope, subject_id)';

/** Migration source is not proof that the connected database has the index. */
export function imagePostLeaseSchemaReady(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (row.name !== COLLECTION || row.type !== 'base') return false;
  if (['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule'].some(key => row[key] !== null)) return false;
  const fields = Array.isArray(row.fields) ? row.fields : Array.isArray(row.schema) ? row.schema : [];
  if (!FIELDS.every(name => fields.some(field => field && typeof field === 'object'
    && field.name === name && field.type === 'text' && field.required === true))) return false;
  return Array.isArray(row.indexes) && row.indexes.some(index => typeof index === 'string'
    && index.trim().replace(/[`"\[\]]/g, '').replace(/\s+/g, ' ').toLowerCase() === INDEX);
}

/** Scope this proof to image analysis; do not unlock unrelated paid workers. */
export async function imagePostAtomicLeaseAvailable(dataStore: DataStore): Promise<boolean> {
  if (await dataStore.supportsAtomicOperationLease?.() === true) return true;
  if (dataStore !== pbStore) return false;
  if (currentDataAuthority() === 'local') return localFallbacksEnabled();
  if (currentDataAuthority() !== 'pocketbase'
    || !process.env.PB_ADMIN_EMAIL?.trim() || !process.env.PB_ADMIN_PASSWORD?.trim()) return false;
  try {
    const response = await adminFetch(`/api/collections/${COLLECTION}`);
    return response.ok && imagePostLeaseSchemaReady(await response.json());
  } catch { return false; }
}
