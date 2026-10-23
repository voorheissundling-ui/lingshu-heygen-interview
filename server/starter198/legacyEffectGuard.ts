import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { store } from '../storage/index.js';
import type { DataStore } from '../storage/datastore.js';
import {
  acquireDurableOperationLease,
  assertDurableOperationLease,
  releaseDurableOperationLease,
  renewDurableOperationLease,
  type DurableOperationLease,
} from '../runtime/durableLease.js';
import {
  Starter198RepositoryError,
  starter198Repository,
  type Starter198Repository,
} from './repository.js';

export type Starter198LegacyEffectErrorCode =
  | 'starter_198_orchestrator_only'
  | 'starter_198_access_unavailable';

export class Starter198LegacyEffectError extends Error {
  constructor(readonly code: Starter198LegacyEffectErrorCode, readonly status: 403 | 503) {
    super(code);
    this.name = 'Starter198LegacyEffectError';
  }
}

const tenantQueues = new Map<string, Promise<void>>();
const PROFILE_TRANSITION_LEASE_SCOPE = 'product-profile-transition';
const DEFAULT_TRANSITION_LEASE_MS = 30 * 60_000;
const heldTransition = new AsyncLocalStorage<{
  tenantId: string;
  dataStore: DataStore;
  guard: Starter198TransitionLeaseGuard;
}>();

export interface Starter198TransitionLeaseGuard {
  /** Renew and fence immediately before an irreversible write or provider call. */
  beforeEffect(now?: Date): Promise<void>;
}

export interface Starter198TransitionLeaseOptions {
  ownerId?: string;
  now?: () => Date;
  leaseDurationMs?: number;
  reclaimGraceMs?: number;
  heartbeatIntervalMs?: number;
}

function transitionLeaseDurationMs(value: unknown = process.env.LEGACY_EXTERNAL_EFFECT_LEASE_MS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.floor(parsed), 30_000), 2 * 60 * 60_000)
    : DEFAULT_TRANSITION_LEASE_MS;
}

function transitionHeartbeatIntervalMs(leaseDurationMs: number, value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.floor(parsed), 5), Math.max(5, Math.floor(leaseDurationMs / 2)))
    : Math.max(1_000, Math.floor(leaseDurationMs / 3));
}

/**
 * Serializes starter provisioning with legacy effects. The local queue avoids
 * needless contention; the durable database lease is the cross-process
 * authority that closes the final access-check/effect transition race.
 */
export async function withStarter198TenantTransitionLock<T>(
  tenantId: string,
  action: (guard: Starter198TransitionLeaseGuard) => Promise<T>,
  dataStore: DataStore = store,
  options: Starter198TransitionLeaseOptions = {},
): Promise<T> {
  const inherited = heldTransition.getStore();
  if (inherited?.tenantId === tenantId && inherited.dataStore === dataStore) {
    await inherited.guard.beforeEffect();
    return action(inherited.guard);
  }
  const prior = tenantQueues.get(tenantId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => gate);
  tenantQueues.set(tenantId, tail);
  await prior.catch(() => undefined);
  const now = options.now ?? (() => new Date());
  const leaseDurationMs = transitionLeaseDurationMs(options.leaseDurationMs);
  let lease: DurableOperationLease | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let leaseLost = false;
  let renewalTail: Promise<void> = Promise.resolve();
  try {
    try {
      lease = await acquireDurableOperationLease({
        dataStore,
        tenantId,
        scope: PROFILE_TRANSITION_LEASE_SCOPE,
        subjectId: tenantId,
        ownerId: options.ownerId ?? `profile-transition:${process.pid}:${randomUUID()}`,
        now: now(),
        leaseDurationMs,
        reclaimGraceMs: options.reclaimGraceMs,
      });
    } catch {
      throw new Starter198LegacyEffectError('starter_198_access_unavailable', 503);
    }
    if (!lease) throw new Starter198LegacyEffectError('starter_198_access_unavailable', 503);
    const renewAndFence = async (effectNow?: Date): Promise<void> => {
      const operation = renewalTail.then(async () => {
        if (leaseLost || !lease) throw new Starter198LegacyEffectError('starter_198_access_unavailable', 503);
        const renewalNow = effectNow ?? now();
        try {
          lease = await renewDurableOperationLease({ dataStore, lease, now: renewalNow, leaseDurationMs });
          await assertDurableOperationLease({
            dataStore,
            lease,
            now: renewalNow,
            minimumRemainingMs: Math.min(30_000, Math.max(1_000, Math.floor(leaseDurationMs / 3))),
          });
        } catch {
          leaseLost = true;
          throw new Starter198LegacyEffectError('starter_198_access_unavailable', 503);
        }
      });
      renewalTail = operation.then(() => undefined, () => undefined);
      return operation;
    };
    const guard: Starter198TransitionLeaseGuard = { beforeEffect: renewAndFence };
    await guard.beforeEffect();
    const heartbeatIntervalMs = transitionHeartbeatIntervalMs(
      leaseDurationMs,
      options.heartbeatIntervalMs ?? process.env.LEGACY_EXTERNAL_EFFECT_HEARTBEAT_MS,
    );
    heartbeat = setInterval(() => { void renewAndFence().catch(() => undefined); }, heartbeatIntervalMs);
    heartbeat.unref?.();
    return await heldTransition.run({ tenantId, dataStore, guard }, () => action(guard));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await renewalTail;
    if (lease) {
      try {
        await releaseDurableOperationLease({ dataStore, lease });
      } catch {
        // The action outcome is authoritative. A release failure leaves a
        // bounded lease that expires and is reclaimed; it must not mask the
        // completed provider/provisioning result and invite a blind retry.
      }
    }
    release();
    if (tenantQueues.get(tenantId) === tail) tenantQueues.delete(tenantId);
  }
}

/**
 * A missing starter access row means the tenant remains on the legacy product.
 * Every other read outcome is denied: a valid row is starter-only, while an
 * invalid/ambiguous/unavailable row cannot safely authorize a legacy effect.
 */
export async function assertLegacyExternalEffectAllowed(
  tenantId: string,
  repository: Starter198Repository = starter198Repository,
): Promise<void> {
  try {
    await repository.access(tenantId);
  } catch (error) {
    if (error instanceof Starter198RepositoryError && error.code === 'starter_198_not_provisioned') return;
    throw new Starter198LegacyEffectError('starter_198_access_unavailable', 503);
  }
  throw new Starter198LegacyEffectError('starter_198_orchestrator_only', 403);
}

/** Hold the local transition lock from the final authority read through the effect. */
export function withLegacyExternalEffectAllowed<T>(
  tenantId: string,
  action: (guard: Starter198TransitionLeaseGuard) => Promise<T>,
  repository: Starter198Repository = starter198Repository,
  dataStore: DataStore = store,
): Promise<T> {
  return withStarter198TenantTransitionLock(tenantId, async guard => {
    await assertLegacyExternalEffectAllowed(tenantId, repository);
    await guard.beforeEffect();
    return action(guard);
  }, dataStore);
}
