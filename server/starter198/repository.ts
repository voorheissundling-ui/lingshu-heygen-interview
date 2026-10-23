import {readMaterialLibrary} from '../lib/materialLibrary.js';
import type { DataStore, ListQuery, ListResult } from '../storage/datastore.js';
import { dataBackend, store } from '../storage/index.js';
import { pbListStrict } from '../storage/pb.js';
import { parseStarter198AccessRecord, type Starter198AccessSnapshot } from './profile.js';

export const STARTER_COLLECTIONS = {
  access: 'starter_198_access',
  usage: 'starter_usage_ledger',
  commands: 'starter_commands',
  orchestratorInbox: 'starter_orchestrator_inbox',
  configurations: 'digital_employee_configs',
  agentTasks: 'starter_agent_tasks',
  handoffs: 'starter_agent_handoffs',
  publicationPackages: 'starter_publication_packages',
  quoteRuleSets: 'quote_rule_sets',
  quoteInquiries: 'starter_quote_inquiries',
  quoteDrafts: 'quote_drafts',
  quoteApprovalEvidence: 'quote_approval_evidence',
  quoteArtifacts: 'starter_quote_artifacts',
  quoteSendEvidence: 'quote_external_send_evidence',
  plans: 'weekly_plans',
  runs: 'workflow_runs',
  tasks: 'workflow_tasks',
  approvals: 'approval_requests',
  events: 'run_events',
  goals: 'weekly_goals',
  reviews: 'weekly_reviews',
  socialContentTasks: 'starter_social_content_tasks',
  socialTaskSources: 'starter_social_task_sources',
  socialContentFiles: 'starter_social_content_files',
  socialWorkPackageVersions: 'starter_social_work_package_versions',
  socialDirectorPlanVersions: 'starter_social_director_plan_versions',
  socialProductionHandoffs: 'starter_social_production_handoffs',
  socialProductionReceipts: 'starter_social_production_receipts',
  socialInspirationHandoffVersions: 'starter_social_inspiration_handoff_versions',
  socialDirectorBriefVersions: 'starter_social_director_brief_versions',
  socialContentLineage: 'starter_social_content_lineage',
  socialContentReworkQueue: 'starter_social_content_rework_queue',
  socialContentArtifacts: 'starter_social_content_artifacts',
  socialDeliveryPackages: 'starter_social_delivery_packages',
  socialPublications: 'starter_social_publications',
  socialMetricSubmissions: 'starter_social_metric_submissions',
  socialContentOperations: 'starter_social_content_operations',
} as const;

export type StarterCollection = typeof STARTER_COLLECTIONS[keyof typeof STARTER_COLLECTIONS];
export type StarterRecord = { id: string } & Record<string, unknown>;

export class Starter198RepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'Starter198RepositoryError';
  }
}

export interface Starter198Repository {
  /**
   * Storage authority used by cross-process mutation coordinators. Custom
   * repositories may omit it for isolated tests, but production adapters must
   * expose the exact store that backs their reads and writes.
   */
  readonly dataStore?: DataStore;
  /** Trusted server inventory reader; never supplied by content-task JSON. */
  readonly materialLibrary?: typeof readMaterialLibrary;
  list(
    collection: StarterCollection,
    tenantId: string,
    query?: Omit<ListQuery, 'where'> & { where?: Record<string, string | number | boolean> },
  ): Promise<ListResult<StarterRecord>>;
  get(collection: StarterCollection, tenantId: string, id: string): Promise<StarterRecord | null>;
  create(collection: StarterCollection, tenantId: string, data: Record<string, unknown>): Promise<StarterRecord>;
  update(collection: StarterCollection, tenantId: string, id: string, data: Record<string, unknown>): Promise<void>;
  access(tenantId: string): Promise<Starter198AccessSnapshot>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * PocketBase number fields are returned as numbers while older stores may
 * persist versions as strings. Commands always carry the canonical string so
 * optimistic concurrency compares the same value without treating 0 as empty.
 */
export function starterVersionString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

export function starterRecordVersion(record: StarterRecord): string {
  return starterVersionString(record.version)
    || text(record.updated_at)
    || text(record.updated)
    || [text(record.status), text(record.started_at), text(record.completed_at)].join(':');
}

function validIdentity(value: string): boolean {
  return Boolean(value) && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
}

function pbValue(value: string | number | boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function pbFilter(where: Record<string, string | number | boolean>): string {
  return Object.entries(where).map(([key, value]) => `${key} = ${pbValue(value)}`).join(' && ');
}

function assertScopedRecord(record: StarterRecord, tenantId: string): void {
  if (!text(record.id) || text(record.tenant_id) !== tenantId) {
    throw new Starter198RepositoryError('starter_198_storage_integrity_violation');
  }
}

export function createStarter198Repository(dataStore: DataStore = store, ports: {materialLibrary?:typeof readMaterialLibrary} = {}): Starter198Repository {
  async function list(
    collection: StarterCollection,
    tenantId: string,
    query: Omit<ListQuery, 'where'> & { where?: Record<string, string | number | boolean> } = {},
  ): Promise<ListResult<StarterRecord>> {
    if (!validIdentity(tenantId)) throw new Starter198RepositoryError('starter_198_tenant_invalid');
    const perPage = Math.min(Math.max(query.perPage ?? 500, 1), 500);
    // The caller may narrow a tenant-scoped query, but can never replace its
    // tenant boundary through an accidentally forwarded `where.tenant_id`.
    const where = { ...(query.where ?? {}), tenant_id: tenantId };
    try {
      const result = process.env.NODE_ENV === 'production' && dataStore === store && dataBackend === 'pocketbase'
        ? await pbListStrict<StarterRecord>(collection, {
          filter: pbFilter(where), sort: query.sort, page: query.page ?? 1, perPage,
        })
        : await dataStore.list<StarterRecord>(collection, {
          where, sort: query.sort, page: query.page ?? 1, perPage,
        });
      if (!Array.isArray(result.items) || !Number.isFinite(result.totalItems)) {
        throw new Starter198RepositoryError('starter_198_storage_integrity_violation');
      }
      result.items.forEach(record => assertScopedRecord(record, tenantId));
      return result;
    } catch (error) {
      if (error instanceof Starter198RepositoryError) throw error;
      console.error('[starter-198] storage list failed', {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Starter198RepositoryError('starter_198_storage_unavailable');
    }
  }

  async function get(collection: StarterCollection, tenantId: string, id: string): Promise<StarterRecord | null> {
    if (!validIdentity(id)) throw new Starter198RepositoryError('starter_198_target_invalid');
    const result = await list(collection, tenantId, { where: { id }, perPage: 2 });
    if (result.totalItems > 1 || result.items.length > 1) {
      throw new Starter198RepositoryError('starter_198_storage_integrity_violation');
    }
    return result.items[0] ?? null;
  }

  async function create(
    collection: StarterCollection,
    tenantId: string,
    data: Record<string, unknown>,
  ): Promise<StarterRecord> {
    if (!validIdentity(tenantId)) throw new Starter198RepositoryError('starter_198_tenant_invalid');
    if ('tenant_id' in data && text(data.tenant_id) !== tenantId) {
      throw new Starter198RepositoryError('starter_198_tenant_mismatch');
    }
    try {
      const created = await dataStore.create<StarterRecord>(collection, { ...data, tenant_id: tenantId });
      if (!created) throw new Starter198RepositoryError('starter_198_storage_unavailable');
      assertScopedRecord(created, tenantId);
      return created;
    } catch (error) {
      if (error instanceof Starter198RepositoryError) throw error;
      console.error('[starter-198] storage create failed', {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Starter198RepositoryError('starter_198_storage_unavailable');
    }
  }

  async function update(
    collection: StarterCollection,
    tenantId: string,
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const current = await get(collection, tenantId, id);
    if (!current) throw new Starter198RepositoryError('starter_198_target_not_found');
    if ('tenant_id' in data && text(data.tenant_id) !== tenantId) {
      throw new Starter198RepositoryError('starter_198_tenant_mismatch');
    }
    try {
      if (!await dataStore.update(collection, id, { ...data, tenant_id: tenantId })) {
        throw new Starter198RepositoryError('starter_198_storage_unavailable');
      }
    } catch (error) {
      if (error instanceof Starter198RepositoryError) throw error;
      throw new Starter198RepositoryError('starter_198_storage_unavailable');
    }
  }

  async function access(tenantId: string): Promise<Starter198AccessSnapshot> {
    const records = await list(STARTER_COLLECTIONS.access, tenantId, { perPage: 2 });
    if (records.totalItems !== 1 || records.items.length !== 1) {
      throw new Starter198RepositoryError(records.totalItems > 1
        ? 'starter_198_access_integrity_violation'
        : 'starter_198_not_provisioned');
    }
    const parsed = parseStarter198AccessRecord(records.items[0], tenantId);
    if (!parsed) throw new Starter198RepositoryError('starter_198_access_invalid');
    return parsed;
  }

  return { materialLibrary: ports.materialLibrary ?? ((tenantId, adapters = {}) => readMaterialLibrary(tenantId, {...adapters, dataStore})), dataStore, list, get, create, update, access };
}

export const starter198Repository = createStarter198Repository();
