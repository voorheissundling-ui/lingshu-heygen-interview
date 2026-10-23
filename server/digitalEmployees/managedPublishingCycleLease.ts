import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { acquireDurableOperationLease, assertDurableOperationLease, releaseDurableOperationLease, type DurableOperationLease } from '../runtime/durableLease.js';

const held = new AsyncLocalStorage<Map<string, { dataStore: DataStore; lease: DurableOperationLease }>>();

/** Shared by ordinary operating plans and social artifact bridge admissions. */
export async function withManagedPublishingCycleLease<T>(input: {
  tenantId: string; runId: string; dataStore: DataStore; now?: Date;
}, action: (lease: DurableOperationLease) => Promise<T>): Promise<T> {
  const key = JSON.stringify([input.tenantId, input.runId]);
  const current = held.getStore()?.get(key);
  if (current) {
    if (current.dataStore !== input.dataStore) throw new Error('managed_publishing_storage_authority_mismatch');
    await assertDurableOperationLease({ dataStore: input.dataStore, lease: current.lease, now: input.now });
    return action(current.lease);
  }
  const lease = await acquireDurableOperationLease({ dataStore: input.dataStore, tenantId: input.tenantId,
    scope: 'social_managed_publishing', subjectId: input.runId, ownerId: `managed-${randomUUID()}`,
    now: input.now, leaseDurationMs: 10 * 60_000 });
  if (!lease) throw new Error('managed_publishing_cycle_busy');
  try {
    const inherited = new Map(held.getStore());
    inherited.set(key, { dataStore: input.dataStore, lease });
    return await held.run(inherited, () => action(lease));
  } finally { await releaseDurableOperationLease({ dataStore: input.dataStore, lease }); }
}

const object = (value: unknown): Record<string, any> => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
};

/** A pending social binding reserves one item until its exact artifact/target
 * becomes a calendar post. Replaying or consuming that reservation costs zero. */
export function managedPublishingCapacity(input: {
  maxPublishItems: number;
  posts: Array<{ id: string; stats?: unknown }>;
  bindings: Array<{ payload?: unknown }>;
  additions: Array<{ sourceProjectId: string; accountIds: string[]; sourceClaim: { artifactId?: string } }>;
}): { used: number; allowed: boolean } {
  const matches = (binding: Record<string, any>, item: { sourceProjectId: string; accountIds: string[]; sourceClaim: { artifactId?: string } }) =>
    item.sourceProjectId === binding.socialTaskId && item.sourceClaim.artifactId === binding.artifactId && item.accountIds.includes(binding.accountId);
  const pending = new Set(input.bindings.map(row => object(row.payload)).filter(binding => {
    if (input.additions.some(item => matches(binding, item))) return false;
    return !input.posts.some(post => { const stats = object(post.stats); return matches(binding, {
      sourceProjectId: String(stats.sourceProjectId || ''), accountIds: Array.isArray(stats.targetAccountIds) ? stats.targetAccountIds : [], sourceClaim: object(stats.publishSourceClaim),
    }); });
  }).map(binding => JSON.stringify([binding.socialTaskId, binding.artifactId, binding.accountId])));
  const used = input.posts.length + pending.size + input.additions.length;
  return { used, allowed: Number.isSafeInteger(input.maxPublishItems) && input.maxPublishItems > 0 && used <= input.maxPublishItems };
}
