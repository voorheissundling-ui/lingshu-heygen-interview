import { randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';

export const DURABLE_OPERATION_LEASE_COLLECTION = 'durable_operation_leases';

const MIN_LEASE_MS = 30_000;
const MAX_LEASE_MS = 2 * 60 * 60_000;
const MIN_RECLAIM_GRACE_MS = 5_000;
const MAX_RECLAIM_GRACE_MS = 5 * 60_000;
const SAFE_ID = /^[a-z0-9._:-]+$/i;

type LeaseRow = {
  id: string;
  tenant_id: string;
  lease_scope: string;
  subject_id: string;
  lease_token: string;
  owner_id: string;
  acquired_at: string;
  expires_at: string;
};

export interface DurableOperationLease {
  id: string;
  tenantId: string;
  scope: string;
  subjectId: string;
  token: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export class DurableOperationLeaseError extends Error {
  constructor(readonly code: string, readonly retryable = true) {
    super(code);
    this.name = 'DurableOperationLeaseError';
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.floor(parsed), minimum), maximum)
    : fallback;
}

function identity(value: unknown, field: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max || !SAFE_ID.test(normalized)) {
    throw new DurableOperationLeaseError(`durable_lease_${field}_invalid`, false);
  }
  return normalized;
}

function timestamp(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function rowMatches(row: LeaseRow, input: {
  tenantId: string;
  scope: string;
  subjectId: string;
}): boolean {
  return row.tenant_id === input.tenantId
    && row.lease_scope === input.scope
    && row.subject_id === input.subjectId
    && Boolean(row.id && row.lease_token && row.owner_id)
    && timestamp(row.acquired_at) !== null
    && timestamp(row.expires_at) !== null;
}

function leaseFromRow(row: LeaseRow): DurableOperationLease {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.lease_scope,
    subjectId: row.subject_id,
    token: row.lease_token,
    ownerId: row.owner_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

async function matchingRows(dataStore: DataStore, input: {
  tenantId: string;
  scope: string;
  subjectId: string;
}): Promise<LeaseRow[]> {
  const result = await dataStore.list<LeaseRow>(DURABLE_OPERATION_LEASE_COLLECTION, {
    where: {
      tenant_id: input.tenantId,
      lease_scope: input.scope,
      subject_id: input.subjectId,
    },
    perPage: 100,
  });
  if (!Array.isArray(result.items) || result.totalItems > result.items.length) {
    throw new DurableOperationLeaseError('durable_lease_integrity_violation');
  }
  return result.items;
}

/**
 * Acquire one database-arbitrated lease. The unique database index is the
 * authority; process-local locks may still be used to reduce contention but
 * are never relied on for correctness.
 */
export async function acquireDurableOperationLease(input: {
  dataStore: DataStore;
  tenantId: string;
  scope: string;
  subjectId: string;
  ownerId: string;
  now?: Date;
  leaseDurationMs?: number;
  reclaimGraceMs?: number;
}): Promise<DurableOperationLease | null> {
  const tenantId = identity(input.tenantId, 'tenant', 200);
  const scope = identity(input.scope, 'scope', 80);
  const subjectId = identity(input.subjectId, 'subject', 200);
  const ownerId = identity(input.ownerId, 'owner', 200);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new DurableOperationLeaseError('durable_lease_time_invalid', false);
  const leaseDurationMs = boundedInteger(input.leaseDurationMs, 30 * 60_000, MIN_LEASE_MS, MAX_LEASE_MS);
  const reclaimGraceMs = boundedInteger(
    input.reclaimGraceMs,
    30_000,
    MIN_RECLAIM_GRACE_MS,
    MAX_RECLAIM_GRACE_MS,
  );
  const key = { tenantId, scope, subjectId };
  let rows = await matchingRows(input.dataStore, key);
  // File-backed local previews cannot enforce the production unique index. A
  // hard-killed worker may therefore leave an expired generation beside its
  // successor. Remove only generations that are safely beyond the reclaim
  // grace period; multiple live owners still fail closed.
  if (rows.length > 1) {
    for (const row of rows) {
      if (!rowMatches(row, key)) throw new DurableOperationLeaseError('durable_lease_integrity_violation');
      const expiresAt = timestamp(row.expires_at)!;
      if (expiresAt + reclaimGraceMs > now.getTime()) continue;
      const latest = await input.dataStore.getById<LeaseRow>(DURABLE_OPERATION_LEASE_COLLECTION, row.id);
      if (latest && rowMatches(latest, key) && latest.lease_token === row.lease_token
        && timestamp(latest.expires_at)! + reclaimGraceMs <= now.getTime()) {
        await input.dataStore.delete(DURABLE_OPERATION_LEASE_COLLECTION, row.id);
      }
    }
    rows = await matchingRows(input.dataStore, key);
    if (rows.length > 1) throw new DurableOperationLeaseError('durable_lease_integrity_violation');
  }
  const current = rows[0];
  if (current) {
    if (!rowMatches(current, key)) throw new DurableOperationLeaseError('durable_lease_integrity_violation');
    const expiresAt = timestamp(current.expires_at)!;
    if (expiresAt + reclaimGraceMs > now.getTime()) return null;

    // Re-read the exact generation before deleting an abandoned row. A stale
    // owner can never delete its successor because every generation has a new
    // record id and token.
    const latest = await input.dataStore.getById<LeaseRow>(DURABLE_OPERATION_LEASE_COLLECTION, current.id);
    if (latest) {
      if (!rowMatches(latest, key) || latest.lease_token !== current.lease_token) return null;
      if (!await input.dataStore.delete(DURABLE_OPERATION_LEASE_COLLECTION, current.id)) {
        throw new DurableOperationLeaseError('durable_lease_reclaim_failed');
      }
    }
  }

  const acquiredAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  const token = randomUUID();
  let created: LeaseRow | null = null;
  try {
    created = await input.dataStore.create<LeaseRow>(DURABLE_OPERATION_LEASE_COLLECTION, {
      tenant_id: tenantId,
      lease_scope: scope,
      subject_id: subjectId,
      lease_token: token,
      owner_id: ownerId,
      acquired_at: acquiredAt,
      expires_at: expiresAt,
    });
  } catch {
    // A unique-index winner is normal contention. Verify that exactly one
    // well-formed owner exists rather than treating arbitrary storage errors as
    // a successful busy result.
  }
  if (created) {
    if (!rowMatches(created, key) || created.lease_token !== token
      || created.owner_id !== ownerId || created.expires_at !== expiresAt) {
      throw new DurableOperationLeaseError('durable_lease_create_integrity_violation');
    }
    return leaseFromRow(created);
  }
  const winner = (await matchingRows(input.dataStore, key))[0];
  if (winner && rowMatches(winner, key)) return null;
  throw new DurableOperationLeaseError('durable_lease_storage_unavailable');
}

export async function assertDurableOperationLease(input: {
  dataStore: DataStore;
  lease: DurableOperationLease;
  now?: Date;
  minimumRemainingMs?: number;
}): Promise<void> {
  const now = input.now ?? new Date();
  const minimumRemainingMs = boundedInteger(input.minimumRemainingMs, 1_000, 0, MAX_LEASE_MS);
  const row = await input.dataStore.getById<LeaseRow>(DURABLE_OPERATION_LEASE_COLLECTION, input.lease.id);
  if (!row
    || !rowMatches(row, input.lease)
    || row.lease_token !== input.lease.token
    || row.owner_id !== input.lease.ownerId
    || row.expires_at !== input.lease.expiresAt
    || timestamp(row.expires_at)! < now.getTime() + minimumRemainingMs) {
    throw new DurableOperationLeaseError('durable_lease_lost');
  }
}

/** Extend only the currently owned, still-live generation. */
export async function renewDurableOperationLease(input: {
  dataStore: DataStore;
  lease: DurableOperationLease;
  now?: Date;
  leaseDurationMs?: number;
}): Promise<DurableOperationLease> {
  const now = input.now ?? new Date();
  const leaseDurationMs = boundedInteger(input.leaseDurationMs, 30 * 60_000, MIN_LEASE_MS, MAX_LEASE_MS);
  await assertDurableOperationLease({ dataStore: input.dataStore, lease: input.lease, now, minimumRemainingMs: 1 });
  const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
  if (!await input.dataStore.update(DURABLE_OPERATION_LEASE_COLLECTION, input.lease.id, { expires_at: expiresAt })) {
    throw new DurableOperationLeaseError('durable_lease_renew_failed');
  }
  const renewed = { ...input.lease, expiresAt };
  await assertDurableOperationLease({ dataStore: input.dataStore, lease: renewed, now, minimumRemainingMs: 1 });
  return renewed;
}

export async function releaseDurableOperationLease(input: {
  dataStore: DataStore;
  lease: DurableOperationLease;
}): Promise<void> {
  const row = await input.dataStore.getById<LeaseRow>(DURABLE_OPERATION_LEASE_COLLECTION, input.lease.id);
  if (!row) return;
  if (!rowMatches(row, input.lease)
    || row.lease_token !== input.lease.token
    || row.owner_id !== input.lease.ownerId) return;
  if (!await input.dataStore.delete(DURABLE_OPERATION_LEASE_COLLECTION, input.lease.id)) {
    throw new DurableOperationLeaseError('durable_lease_release_failed');
  }
}
