import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { withDigitalEmployeeRunLock } from '../digitalEmployees/runControl.js';
import type { DataStore } from '../storage/datastore.js';
import {
  acquireDurableOperationLease,
  assertDurableOperationLease,
  releaseDurableOperationLease,
  type DurableOperationLease,
} from '../runtime/durableLease.js';

const RUN_MUTATION_SCOPE = 'starter-run-mutation';
const DEFAULT_LEASE_MS = 5 * 60_000;
const heldLeases = new AsyncLocalStorage<ReadonlyMap<string, DurableOperationLease>>();

export class Starter198RunMutationLeaseError extends Error {
  constructor(readonly code: 'starter_run_mutation_busy' | 'starter_run_mutation_unavailable') {
    super(code);
    this.name = 'Starter198RunMutationLeaseError';
  }
}

function leaseDurationMs(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.floor(parsed), 30_000), 2 * 60 * 60_000)
    : DEFAULT_LEASE_MS;
}

function key(tenantId: string, runId: string): string {
  return JSON.stringify([tenantId, runId]);
}

/**
 * Coordinate every short workflow-run mutation through one database lease.
 * The existing process lock reduces local contention and makes this helper
 * re-entrant. The durable lease is the multi-instance authority.
 *
 * A missing dataStore is supported only for isolated repository unit tests;
 * production repositories expose their backing store through `dataStore`.
 */
export async function withStarter198RunMutationLease<T>(input: {
  tenantId: string;
  runId: string;
  action: () => Promise<T>;
  dataStore?: DataStore;
  ownerId?: string;
  leaseDurationMs?: number;
}): Promise<T> {
  return withDigitalEmployeeRunLock(input.tenantId, input.runId, async () => {
    const mutationKey = key(input.tenantId, input.runId);
    if (heldLeases.getStore()?.has(mutationKey)) return input.action();
    // Unit-test repositories can remain storage-agnostic. Production must
    // never silently downgrade to a process-only lock when an adapter forgets
    // to expose its backing datastore.
    if (!input.dataStore) {
      if (process.env.NODE_ENV === 'production') {
        throw new Starter198RunMutationLeaseError('starter_run_mutation_unavailable');
      }
      return input.action();
    }

    let lease: DurableOperationLease | null;
    try {
      lease = await acquireDurableOperationLease({
        dataStore: input.dataStore,
        tenantId: input.tenantId,
        scope: RUN_MUTATION_SCOPE,
        subjectId: input.runId,
        ownerId: input.ownerId ?? `starter-run:${process.pid}:${randomUUID()}`,
        leaseDurationMs: leaseDurationMs(
          input.leaseDurationMs ?? process.env.STARTER_RUN_MUTATION_LEASE_MS,
        ),
      });
    } catch {
      throw new Starter198RunMutationLeaseError('starter_run_mutation_unavailable');
    }
    if (!lease) throw new Starter198RunMutationLeaseError('starter_run_mutation_busy');
    try {
      await assertDurableOperationLease({
        dataStore: input.dataStore,
        lease,
        minimumRemainingMs: 1_000,
      });
      const inherited = heldLeases.getStore() ?? new Map<string, DurableOperationLease>();
      return await heldLeases.run(new Map([...inherited, [mutationKey, lease]]), input.action);
    } finally {
      try {
        await releaseDurableOperationLease({ dataStore: input.dataStore, lease });
      } catch {
        // The mutation result must not be masked by cleanup failure. The lease
        // is bounded and will be reclaimed after expiry plus grace.
      }
    }
  });
}
