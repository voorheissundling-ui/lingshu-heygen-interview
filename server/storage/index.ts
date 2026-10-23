/**
 * Active backend selection — the single swap point.
 *
 * Routes import `store` and `auth` from here. To move to a different backend
 * (e.g. Supabase), implement DataStore + AuthProvider in a new file and switch
 * the assignments below (optionally gated on an env var like DATA_BACKEND).
 */
import type { AuthProvider, DataStore } from './datastore.js';
import { pbStore, pbAuth } from './pbStore.js';
import { postgresStore, selectedDataBackend } from './postgres.js';

// import { supabaseStore, supabaseAuth } from './supabaseStore.js';
// const backend = process.env.DATA_BACKEND ?? 'pocketbase';

export const dataBackend = selectedDataBackend();
const postgresCutoverStore: DataStore = {
  supportsAtomicCompareAndSwap: () => postgresStore.supportsAtomicCompareAndSwap?.() ?? false,
  supportsAtomicOperationLease: () => postgresStore.supportsAtomicOperationLease?.() ?? false,
  getById: (collection, id) => collection === 'users' ? pbStore.getById(collection, id) : postgresStore.getById(collection, id),
  create: (collection, data) => collection === 'users' ? pbStore.create(collection, data) : postgresStore.create(collection, data),
  update: (collection, id, data) => collection === 'users' ? pbStore.update(collection, id, data) : postgresStore.update(collection, id, data),
  compareAndSwap: (collection, id, expected, data) => collection === 'users'
    ? (pbStore.compareAndSwap?.(collection, id, expected, data) ?? Promise.resolve(false))
    : (postgresStore.compareAndSwap?.(collection, id, expected, data) ?? Promise.resolve(false)),
  delete: (collection, id) => collection === 'users' ? pbStore.delete(collection, id) : postgresStore.delete(collection, id),
  list: (collection, query) => collection === 'users' ? pbStore.list(collection, query) : postgresStore.list(collection, query),
};
export const store: DataStore = dataBackend === 'postgres' ? postgresCutoverStore : pbStore;
// Authentication remains on PocketBase during the verified token-exchange
// window. Business records can cut over independently without invalidating
// active customer sessions; a later auth migration can replace this port.
export const auth: AuthProvider = pbAuth;

export type { DataStore, AuthProvider } from './datastore.js';
export type { ListQuery, ListResult, Identity, Where, Record_ } from './datastore.js';
