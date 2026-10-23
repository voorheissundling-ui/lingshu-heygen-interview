import type { DataStore, ListQuery } from '../storage/datastore.js';
import { dataBackend, store } from '../storage/index.js';
import { pbListStrict } from '../storage/pb.js';

type RecordRow = { id: string; [key: string]: unknown };

export type Starter198ProvisioningBlocker =
  | 'product_api_credentials'
  | 'tenant_platform_credentials'
  | 'social_account_credentials'
  | 'youtube_account_credentials'
  | 'scheduled_publications'
  | 'followup_dispatches';

export interface Starter198ProvisioningCompatibility {
  blockers: Array<{ kind: Starter198ProvisioningBlocker; count: number }>;
}

export class Starter198ProvisioningCompatibilityError extends Error {
  constructor(
    readonly code: 'starter_198_legacy_state_requires_cleanup' | 'starter_198_migration_compatibility_unavailable',
    readonly status: 409 | 503,
    readonly blockers: Starter198ProvisioningCompatibility['blockers'] = [],
  ) {
    super(code);
    this.name = 'Starter198ProvisioningCompatibilityError';
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch { return {}; }
  }
  return {};
}

async function allTenantRows(
  dataStore: DataStore,
  collection: string,
  tenantField: 'tenant_id' | 'tenantId',
  tenantId: string,
): Promise<RecordRow[]> {
  const rows: RecordRow[] = [];
  let expectedTotal: number | null = null;
  for (let page = 1; ; page += 1) {
    const query: ListQuery = { where: { [tenantField]: tenantId }, page, perPage: 500 };
    const result = process.env.NODE_ENV === 'production' && dataStore === store && dataBackend === 'pocketbase'
      ? await pbListStrict<RecordRow>(collection, {
        filter: `${tenantField} = "${tenantId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
        page,
        perPage: 500,
      })
      : await dataStore.list<RecordRow>(collection, query);
    if (!Array.isArray(result.items) || !Number.isFinite(result.totalItems)
      || !Number.isFinite(result.totalPages) || result.totalItems < 0 || result.totalPages < 0) {
      throw new Error('starter_198_compatibility_scan_invalid');
    }
    if (expectedTotal === null) expectedTotal = result.totalItems;
    if (expectedTotal !== result.totalItems
      || result.items.some(row => !row.id || String(row[tenantField] || '') !== tenantId)) {
      throw new Error('starter_198_compatibility_scan_changed');
    }
    rows.push(...result.items);
    if (!result.items.length || page >= result.totalPages) break;
  }
  if (rows.length !== expectedTotal) throw new Error('starter_198_compatibility_scan_incomplete');
  return rows;
}

function pendingPublication(row: RecordRow): boolean {
  const stats = jsonObject(row.stats);
  const status = String(stats.status || '').trim();
  return ['scheduled', 'publishing', 'failed', 'finalize_pending', 'needs_attention'].includes(status);
}

function pendingFollowupBatch(row: RecordRow): boolean {
  return ['approved', 'needs_attention'].includes(String(row.status || '').trim());
}

function pendingFollowupItem(row: RecordRow): boolean {
  return ['approved', 'retry_wait', 'sending'].includes(String(row.status || '').trim());
}

/**
 * Starter is not an in-place toggle for a tenant that can still invoke legacy
 * providers. An internal operator must revoke/migrate credentials and settle
 * every queued or ambiguous effect before creating starter access.
 */
export async function inspectStarter198ProvisioningCompatibility(
  tenantId: string,
  dataStore: DataStore = store,
): Promise<Starter198ProvisioningCompatibility> {
  try {
    const [productKeys, platformApps, socialAccounts, youtubeAccounts, posts, batches, items] = await Promise.all([
      allTenantRows(dataStore, 'tenant_api_keys', 'tenant_id', tenantId),
      allTenantRows(dataStore, 'tenant_platform_apps', 'tenant_id', tenantId),
      allTenantRows(dataStore, 'social_accounts', 'tenantId', tenantId),
      allTenantRows(dataStore, 'youtube_accounts', 'tenantId', tenantId),
      allTenantRows(dataStore, 'posts', 'tenant_id', tenantId),
      allTenantRows(dataStore, 'followup_batches', 'tenant_id', tenantId),
      allTenantRows(dataStore, 'followup_batch_items', 'tenant_id', tenantId),
    ]);
    const counts: Array<[Starter198ProvisioningBlocker, number]> = [
      ['product_api_credentials', productKeys.length],
      ['tenant_platform_credentials', platformApps.length],
      ['social_account_credentials', socialAccounts.length],
      ['youtube_account_credentials', youtubeAccounts.length],
      ['scheduled_publications', posts.filter(pendingPublication).length],
      ['followup_dispatches', batches.filter(pendingFollowupBatch).length + items.filter(pendingFollowupItem).length],
    ];
    return { blockers: counts.filter(([, count]) => count > 0).map(([kind, count]) => ({ kind, count })) };
  } catch (error) {
    if (error instanceof Starter198ProvisioningCompatibilityError) throw error;
    throw new Starter198ProvisioningCompatibilityError('starter_198_migration_compatibility_unavailable', 503);
  }
}

export async function assertStarter198ProvisioningCompatible(
  tenantId: string,
  dataStore: DataStore = store,
): Promise<void> {
  const compatibility = await inspectStarter198ProvisioningCompatibility(tenantId, dataStore);
  if (compatibility.blockers.length) {
    throw new Starter198ProvisioningCompatibilityError(
      'starter_198_legacy_state_requires_cleanup',
      409,
      compatibility.blockers,
    );
  }
}
