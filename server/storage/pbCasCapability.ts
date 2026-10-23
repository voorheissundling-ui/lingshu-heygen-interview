import { adminFetch } from './pb.js';

const CLAIM_COLLECTION = 'datastore_cas_claims';
const REQUIRED_TEXT_FIELDS = [
  'target_key', 'expected_fingerprint', 'operation_fingerprint',
  'owner_token', 'created_at', 'lease_expires_at',
] as const;

type CollectionMetadata = {
  name?: unknown;
  type?: unknown;
  listRule?: unknown;
  viewRule?: unknown;
  createRule?: unknown;
  updateRule?: unknown;
  deleteRule?: unknown;
  fields?: unknown;
  schema?: unknown;
  indexes?: unknown;
};

function exactUniqueTargetIndex(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/[`"\[\]]/g, '').replace(/\s+/g, ' ').toLowerCase();
  return normalized === 'create unique index idx_datastore_cas_claim_target on datastore_cas_claims (target_key)';
}

/** The collection metadata must describe the exact arbitration index and
 * admin-only claim rows. Migration source files alone are not evidence that
 * the connected PocketBase instance has applied them. */
export function pocketBaseCasClaimSchemaReady(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const collection = value as CollectionMetadata;
  if (collection.name !== CLAIM_COLLECTION || collection.type !== 'base') return false;
  if (['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule'].some(key =>
    (collection as Record<string, unknown>)[key] !== null)) return false;
  const fields = Array.isArray(collection.fields) ? collection.fields : Array.isArray(collection.schema) ? collection.schema : [];
  if (!REQUIRED_TEXT_FIELDS.every(name => fields.some(field =>
    field && typeof field === 'object' && (field as { name?: unknown }).name === name
      && (field as { type?: unknown }).type === 'text' && (field as { required?: unknown }).required === true))) return false;
  return Array.isArray(collection.indexes) && collection.indexes.some(exactUniqueTargetIndex);
}

/** Read-only remote proof. Network/auth/schema uncertainty always means false. */
export async function pocketBaseCasClaimSchemaVerified(): Promise<boolean> {
  if (!process.env.PB_ADMIN_EMAIL?.trim() || !process.env.PB_ADMIN_PASSWORD?.trim()) return false;
  try {
    const response = await adminFetch(`/api/collections/${CLAIM_COLLECTION}`);
    if (!response.ok) return false;
    return pocketBaseCasClaimSchemaReady(await response.json());
  } catch {
    return false;
  }
}
