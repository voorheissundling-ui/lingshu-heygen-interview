/**
 * PocketBase Admin client — fetch-based, no SDK dependency.
 * Pattern: cached admin token, auto-refresh on 401.
 */

import { createHash } from 'node:crypto';
import { assertPocketBaseDataAuthority } from './dataAuthority.js';
import { postgresListWithPocketBaseFilter, postgresStore, selectedDataBackend } from './postgres.js';

function recordsUsePostgres(collection: string): boolean {
  // Password hashes and refresh-token semantics stay in PocketBase until all
  // active users have exchanged their sessions. All other business records can
  // cut over to PostgreSQL immediately.
  return selectedDataBackend() === 'postgres' && collection !== 'users' && collection !== '_superusers';
}

export function getPbUrl(): string {
  return (process.env.PB_URL ?? 'http://localhost:8090').replace(/\/$/, '');
}

let cachedToken: string | null = null;
let cachedIdentityKey: string | null = null;
let adminTokenRequest: { key: string; promise: Promise<string | null> } | null = null;

type VerifiedIdentity = { userId: string; tenantId: string };
const verifiedIdentityCache = new Map<string, { value: VerifiedIdentity | null; expiresAt: number }>();
const verifiedIdentityRequests = new Map<string, Promise<VerifiedIdentity | null>>();
const MAX_VERIFIED_IDENTITIES = 5_000;

export class PbAuthUnavailableError extends Error {
  constructor(message = 'PocketBase authentication is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PbAuthUnavailableError';
  }
}

function authCacheTtlMs(): number {
  const configured = Number(process.env.PB_AUTH_CACHE_TTL_MS ?? 5_000);
  return Number.isFinite(configured) ? Math.min(Math.max(configured, 0), 30_000) : 5_000;
}

export function pbRequestTimeoutMs(): number {
  const configured = Number(process.env.PB_REQUEST_TIMEOUT_MS ?? 10_000);
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.floor(configured), 500), 60_000)
    : 10_000;
}

export function createPbRequestSignal(signal?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(pbRequestTimeoutMs());
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function pruneVerifiedIdentityCache(now = Date.now()): void {
  for (const [key, entry] of verifiedIdentityCache) {
    if (entry.expiresAt <= now) verifiedIdentityCache.delete(key);
  }
  while (verifiedIdentityCache.size > MAX_VERIFIED_IDENTITIES) {
    const oldest = verifiedIdentityCache.keys().next().value as string | undefined;
    if (!oldest) break;
    verifiedIdentityCache.delete(oldest);
  }
}

function adminCreds(): { email: string; password: string } | null {
  const email = process.env.PB_ADMIN_EMAIL?.trim();
  const password = process.env.PB_ADMIN_PASSWORD?.trim();
  if (!email || !password) return null;
  return { email, password };
}

export async function getPbAdminToken(signal?: AbortSignal | null): Promise<string | null> {
  const creds = adminCreds();
  if (!creds) return null;

  const key = `${creds.email}\0${creds.password}`;
  if (cachedToken && cachedIdentityKey === key) return cachedToken;
  if (adminTokenRequest?.key === key) return adminTokenRequest.promise;

  cachedToken = null;
  cachedIdentityKey = key;
  const promise = (async () => {
    const pbUrl = getPbUrl();
    const body = JSON.stringify({ identity: creds.email, password: creds.password });
    const requestSignal = createPbRequestSignal(signal);

    for (const path of [
      '/api/collections/_superusers/auth-with-password',
      '/api/admins/auth-with-password',
    ]) {
      try {
        const res = await fetch(`${pbUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body, signal: requestSignal,
        });
        if (!res.ok) continue;
        const json = (await res.json()) as { token?: string };
        if (json.token) {
          cachedToken = json.token;
          cachedIdentityKey = key;
          return cachedToken;
        }
      } catch {
        continue;
      }
    }
    return null;
  })();
  adminTokenRequest = { key, promise };
  try {
    return await promise;
  } finally {
    if (adminTokenRequest?.promise === promise) adminTokenRequest = null;
  }
}

/** Invalidate cached token (call on 401 response) */
export function invalidatePbAdminToken(): void {
  cachedToken = null;
}

export function invalidatePbIdentityCache(): void {
  verifiedIdentityCache.clear();
  verifiedIdentityRequests.clear();
}

export async function adminFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  assertPocketBaseDataAuthority();
  const signal = createPbRequestSignal(options.signal);
  const perform = async (): Promise<Response> => {
    const token = await getPbAdminToken(signal);
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string> ?? {}),
      ...(token ? { Authorization: token } : {}),
    };
    return fetch(`${getPbUrl()}${path}`, { ...options, headers, signal });
  };

  let res = await perform();
  const staleAdminToken = res.status === 401 || (
    res.status === 403 && /superuser/i.test(await res.clone().text().catch(() => ''))
  );
  if (!staleAdminToken) return res;

  invalidatePbAdminToken();
  res = await perform();
  if (res.status === 401) invalidatePbAdminToken();
  return res;
}

/** Resolve user's tenantId from PocketBase JWT token */
export async function getTenantIdFromToken(
  authHeader: string | undefined,
): Promise<{ userId: string; tenantId: string } | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  // Authentication is itself a PocketBase data access. Check the request's
  // locked authority before consulting even the in-memory PB identity cache:
  // otherwise a local-authenticated request could probe PB with a second token
  // and discover the conflict only after the remote request completed.
  assertPocketBaseDataAuthority();
  const key = tokenCacheKey(token);
  const now = Date.now();
  const cached = verifiedIdentityCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  verifiedIdentityCache.delete(key);
  const inFlight = verifiedIdentityRequests.get(key);
  if (inFlight) return inFlight;

  const request = (async (): Promise<VerifiedIdentity | null> => {
    try {
      const res = await fetch(`${getPbUrl()}/api/collections/users/auth-refresh`, {
        method: 'POST',
        headers: { Authorization: token },
        signal: createPbRequestSignal(),
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new PbAuthUnavailableError(`PocketBase auth-refresh failed (${res.status})`);
      const json = (await res.json()) as { record?: { id?: string; tenantId?: string } };
      const userId = json.record?.id;
      const tenantId = json.record?.tenantId;
      if (!userId || !tenantId) throw new PbAuthUnavailableError('PocketBase auth-refresh returned an invalid identity');
      return { userId, tenantId };
    } catch (error) {
      if (error instanceof PbAuthUnavailableError) throw error;
      throw new PbAuthUnavailableError('PocketBase auth-refresh request failed', {
        cause: error instanceof Error ? error : undefined,
      });
    }
  })();
  verifiedIdentityRequests.set(key, request);
  try {
    const value = await request;
    const ttl = authCacheTtlMs();
    if (ttl > 0) {
      verifiedIdentityCache.set(key, { value, expiresAt: Date.now() + (value ? ttl : Math.min(ttl, 1_000)) });
      pruneVerifiedIdentityCache();
    }
    return value;
  } finally {
    if (verifiedIdentityRequests.get(key) === request) verifiedIdentityRequests.delete(key);
  }
}

/** GET /api/collections/:col/records/:id */
export async function pbGet(
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (recordsUsePostgres(collection)) return postgresStore.getById(collection, id);
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
  );
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

/** Read a record while preserving the difference between not-found and outage. */
export async function pbGetStrict(
  collection: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  if (recordsUsePostgres(collection)) return postgresStore.getById(collection, id);
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${collection}/${id} read failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** POST /api/collections/:col/records */
export async function pbCreate(
  collection: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (recordsUsePostgres(collection)) return postgresStore.create(collection, data);
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) {
    console.error(`[pb] create ${collection} failed`, res.status, await res.text().catch(() => ''));
    return null;
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function pbCreateStrict(
  collection: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (recordsUsePostgres(collection)) {
    const created = await postgresStore.create(collection, data);
    if (!created) throw new Error(`${collection} create failed (409): duplicate id`);
    return created;
  }
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${collection} create failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** PATCH /api/collections/:col/records/:id */
export async function pbPatch(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (recordsUsePostgres(collection)) return postgresStore.update(collection, id, data);
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) {
    console.error(`[pb] patch ${collection}/${id} failed`, res.status, await res.text().catch(() => ''));
  }
  return res.ok;
}

export async function pbPatchStrict(
  collection: string,
  id: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (recordsUsePostgres(collection)) return postgresStore.update(collection, id, data);
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${collection}/${id} update failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return true;
}

/** DELETE /api/collections/:col/records/:id */
export async function pbDelete(collection: string, id: string): Promise<boolean> {
  if (recordsUsePostgres(collection)) return postgresStore.delete(collection, id);
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  return res.ok;
}

export async function pbDeleteStrict(collection: string, id: string): Promise<boolean> {
  if (recordsUsePostgres(collection)) return postgresStore.delete(collection, id);
  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${collection}/${id} delete failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return true;
}

export interface PbListOptions {
  filter?: string;
  sort?: string;
  page?: number;
  perPage?: number;
  expand?: string;
}

export interface PbListResult<T = Record<string, unknown>> {
  items: T[];
  totalItems: number;
  totalPages: number;
  page: number;
  perPage: number;
}

/** GET /api/collections/:col/records with filter/sort/pagination */
export async function pbList<T = Record<string, unknown>>(
  collection: string,
  opts: PbListOptions = {},
): Promise<PbListResult<T>> {
  if (recordsUsePostgres(collection)) return postgresListWithPocketBaseFilter<T>(collection, opts);
  const params = new URLSearchParams();
  if (opts.filter) params.set('filter', opts.filter);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.perPage) params.set('perPage', String(opts.perPage));
  if (opts.expand) params.set('expand', opts.expand);

  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records?${params}`,
  );
  if (!res.ok) {
    return { items: [], totalItems: 0, totalPages: 0, page: 1, perPage: 20 };
  }
  const json = (await res.json()) as {
    items?: T[];
    totalItems?: number;
    totalPages?: number;
    page?: number;
    perPage?: number;
  };
  return {
    items: json.items ?? [],
    totalItems: json.totalItems ?? 0,
    totalPages: json.totalPages ?? 0,
    page: json.page ?? 1,
    perPage: json.perPage ?? 20,
  };
}

export async function pbListStrict<T = Record<string, unknown>>(
  collection: string,
  opts: PbListOptions = {},
): Promise<PbListResult<T>> {
  if (recordsUsePostgres(collection)) return postgresListWithPocketBaseFilter<T>(collection, opts);
  const params = new URLSearchParams();
  if (opts.filter) params.set('filter', opts.filter);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.perPage) params.set('perPage', String(opts.perPage));
  if (opts.expand) params.set('expand', opts.expand);

  const res = await adminFetch(
    `/api/collections/${encodeURIComponent(collection)}/records?${params}`,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${collection} read failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const json = (await res.json()) as {
    items?: T[];
    totalItems?: number;
    totalPages?: number;
    page?: number;
    perPage?: number;
  };
  return {
    items: json.items ?? [],
    totalItems: json.totalItems ?? 0,
    totalPages: json.totalPages ?? 0,
    page: json.page ?? 1,
    perPage: json.perPage ?? 20,
  };
}
