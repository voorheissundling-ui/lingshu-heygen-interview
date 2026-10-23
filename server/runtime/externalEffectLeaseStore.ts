import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import type { DataStore, ListQuery, Record_ } from '../storage/datastore.js';
import { store } from '../storage/index.js';

/**
 * Durable leases protecting real external writes must never be satisfied by
 * the per-process JSON development adapter. The active PocketBase store is
 * strict whenever local fallback is disabled; this wrapper makes that runtime
 * precondition explicit and fail-closed at every lease operation.
 */
function assertDatabaseAuthority(): void {
  const isolatedTestAuthority = process.env.NODE_ENV === 'test'
    && process.env.TEST_ONLY_EXTERNAL_EFFECT_LEASE_FALLBACK === 'true';
  if (localFallbacksEnabled() && !isolatedTestAuthority) {
    throw new Error('external_effect_requires_database_lease_authority');
  }
}

export const externalEffectLeaseStore: DataStore = {
  async getById<T = Record_>(collection: string, id: string) {
    assertDatabaseAuthority();
    return store.getById<T>(collection, id);
  },
  async create<T = Record_>(collection: string, data: Record<string, unknown>) {
    assertDatabaseAuthority();
    return store.create<T>(collection, data);
  },
  async update(collection: string, id: string, data: Record<string, unknown>) {
    assertDatabaseAuthority();
    return store.update(collection, id, data);
  },
  async delete(collection: string, id: string) {
    assertDatabaseAuthority();
    return store.delete(collection, id);
  },
  async list<T = Record_>(collection: string, query: ListQuery = {}) {
    assertDatabaseAuthority();
    return store.list<T>(collection, query);
  },
};
