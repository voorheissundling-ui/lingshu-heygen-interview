import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { CompareExpected, DataStore, ListQuery, ListResult, Record_ } from './datastore.js';

const { Pool } = pg;

export type DataBackend = 'pocketbase' | 'postgres';

export function selectedDataBackend(env: NodeJS.ProcessEnv = process.env): DataBackend {
  const value = String(env.DATA_BACKEND || 'pocketbase').trim().toLowerCase();
  if (value !== 'pocketbase' && value !== 'postgres') {
    throw new Error(`Unsupported DATA_BACKEND "${value}"; expected pocketbase or postgres`);
  }
  return value;
}

export function postgresConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(String(env.DATABASE_URL || '').trim());
}

function sslConfiguration(env: NodeJS.ProcessEnv): false | { rejectUnauthorized: boolean } {
  const mode = String(env.DATABASE_SSL_MODE || (env.NODE_ENV === 'production' ? 'require' : 'disable')).trim().toLowerCase();
  if (mode === 'disable') return false;
  if (mode !== 'require' && mode !== 'verify-full') throw new Error('DATABASE_SSL_MODE must be disable, require or verify-full');
  return { rejectUnauthorized: mode === 'verify-full' };
}

let sharedPool: pg.Pool | null = null;

export function postgresPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  if (sharedPool) return sharedPool;
  const connectionString = String(env.DATABASE_URL || '').trim();
  if (!connectionString) throw new Error('DATABASE_URL is required when DATA_BACKEND=postgres');
  const max = Number(env.DATABASE_POOL_MAX || 10);
  sharedPool = new Pool({
    connectionString,
    ssl: sslConfiguration(env),
    max: Number.isSafeInteger(max) ? Math.min(Math.max(max, 2), 50) : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: String(env.DATABASE_APPLICATION_NAME || 'lingshu-ai').slice(0, 63),
  });
  sharedPool.on('error', error => console.error('[postgres] idle client error', error.message));
  return sharedPool;
}

export async function closePostgresPool(): Promise<void> {
  if (!sharedPool) return;
  const pool = sharedPool;
  sharedPool = null;
  await pool.end();
}

export interface SqlExecutor {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function assertCollection(collection: string): string {
  if (!IDENTIFIER.test(collection)) throw new Error(`Invalid collection name: ${collection}`);
  return collection;
}

function recordId(): string {
  return randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 15).padEnd(15, '0');
}

function iso(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function tenantIdOf(data: Record<string, unknown>): string | null {
  const value = data.tenantId ?? data.tenant_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedRecord(collection: string, id: string, data: Record<string, unknown>, now = new Date().toISOString()): Record_ {
  return {
    ...data,
    id,
    collectionId: typeof data.collectionId === 'string' ? data.collectionId : collection,
    collectionName: typeof data.collectionName === 'string' ? data.collectionName : collection,
    created: iso(data.created ?? data.created_at ?? data.createdAt, now),
    updated: iso(data.updated ?? data.updated_at ?? data.updatedAt, now),
  } as Record_;
}

export const POSTGRES_CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS lingshu_records (
  collection text NOT NULL,
  id text NOT NULL,
  tenant_id text,
  data jsonb NOT NULL,
  source_hash text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  migrated_at timestamptz,
  PRIMARY KEY (collection, id),
  CHECK (collection ~ '^[A-Za-z_][A-Za-z0-9_]{0,62}$'),
  CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_lingshu_records_collection_tenant
  ON lingshu_records (collection, tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lingshu_records_data_gin
  ON lingshu_records USING gin (data jsonb_path_ops);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_durable_operation_lease_subject
  ON lingshu_records ((data ->> 'tenant_id'), (data ->> 'lease_scope'), (data ->> 'subject_id'))
  WHERE collection = 'durable_operation_leases';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_content_execution_job_key
  ON lingshu_records ((data ->> 'tenant_id'), (data ->> 'job_key'))
  WHERE collection = 'content_execution_jobs';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_content_execution_task_run
  ON lingshu_records ((data ->> 'tenant_id'), (data ->> 'task_id'), (data ->> 'run_id'))
  WHERE collection = 'content_execution_jobs';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_content_execution_limit_scope
  ON lingshu_records ((data ->> 'tenant_id'), (data ->> 'limit_scope'), (data ->> 'scope_key'))
  WHERE collection = 'content_execution_limits';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_assistant_thread_owner
  ON lingshu_records ((data ->> 'tenantId'), (data ->> 'userId'), (data ->> 'agentId'))
  WHERE collection = 'assistant_threads' AND COALESCE(data ->> 'userId', '') <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_social_presenter_job_request
  ON lingshu_records ((data ->> 'tenant_id'), (data ->> 'request_id'))
  WHERE collection = 'studio_social_presenter_jobs';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_materials_owned_hash
  ON lingshu_records ((data ->> 'tenantId'), (data ->> 'scope'), (data ->> 'sha256'))
  WHERE collection = 'materials' AND (data ->> 'scope') = 'own' AND COALESCE(data ->> 'sha256', '') <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_production_input_request_dedupe
  ON lingshu_records ((data ->> 'tenant_id'), (data ->> 'dedupe_key'))
  WHERE collection = 'production_input_requests' AND COALESCE(data ->> 'dedupe_key', '') <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_lingshu_production_cost_quote_key
  ON lingshu_records ((data ->> 'tenant_id'), (data ->> 'quote_key'))
  WHERE collection = 'production_cost_quotes' AND COALESCE(data ->> 'quote_key', '') <> '';
CREATE TABLE IF NOT EXISTS lingshu_migration_runs (
  id text PRIMARY KEY,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('planning','running','verifying','completed','failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  report jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS lingshu_migration_collections (
  run_id text NOT NULL REFERENCES lingshu_migration_runs(id) ON DELETE CASCADE,
  collection text NOT NULL,
  source_count bigint NOT NULL DEFAULT 0,
  target_count bigint NOT NULL DEFAULT 0,
  source_digest text NOT NULL DEFAULT '',
  target_digest text NOT NULL DEFAULT '',
  copied_files bigint NOT NULL DEFAULT 0,
  copied_bytes bigint NOT NULL DEFAULT 0,
  verified_files bigint NOT NULL DEFAULT 0,
  applied_indexes bigint NOT NULL DEFAULT 0,
  error text,
  PRIMARY KEY (run_id, collection)
);
ALTER TABLE lingshu_migration_collections ADD COLUMN IF NOT EXISTS applied_indexes bigint NOT NULL DEFAULT 0;
ALTER TABLE lingshu_migration_collections ADD COLUMN IF NOT EXISTS verified_files bigint NOT NULL DEFAULT 0;
`;

export async function ensurePostgresSchema(executor: SqlExecutor = postgresPool()): Promise<void> {
  await executor.query('SELECT pg_advisory_lock($1)', [1_987_091_103]);
  try {
    await executor.query(POSTGRES_CORE_SCHEMA);
  } finally {
    await executor.query('SELECT pg_advisory_unlock($1)', [1_987_091_103]);
  }
}

function whereSql(query: ListQuery, values: unknown[]): string {
  const clauses = ['collection = $1'];
  for (const [key, value] of Object.entries(query.where || {})) {
    if (!IDENTIFIER.test(key)) throw new Error(`Invalid filter field: ${key}`);
    values.push(JSON.stringify({ [key]: value }));
    clauses.push(`data @> $${values.length}::jsonb`);
  }
  return clauses.join(' AND ');
}

function sortTerm(raw: string): { sql: string; key: string } {
  const descending = raw.startsWith('-');
  const key = descending ? raw.slice(1) : raw;
  if (!IDENTIFIER.test(key)) throw new Error(`Invalid sort field: ${key}`);
  if (key === 'id') return { key, sql: `id ${descending ? 'DESC' : 'ASC'}` };
  if (key === 'created' || key === 'created_at' || key === 'createdAt') {
    return { key, sql: `created_at ${descending ? 'DESC' : 'ASC'}` };
  }
  if (key === 'updated' || key === 'updated_at' || key === 'updatedAt') {
    return { key, sql: `updated_at ${descending ? 'DESC' : 'ASC'}` };
  }
  const direction = descending ? 'DESC' : 'ASC';
  return { key, sql: `
    CASE WHEN jsonb_typeof(data -> '${key}') = 'number' THEN (data ->> '${key}')::numeric END ${direction} NULLS LAST,
    CASE WHEN jsonb_typeof(data -> '${key}') <> 'number' THEN data ->> '${key}' END ${direction} NULLS LAST
  ` };
}

function sortSql(sort?: string): string {
  if (!sort) return 'updated_at DESC, id ASC';
  const rawTerms = sort.split(',').map(value => value.trim()).filter(Boolean);
  if (!rawTerms.length || rawTerms.length > 5) throw new Error('Sort must contain between 1 and 5 fields');
  const terms = rawTerms.map(sortTerm);
  return [...terms.map(term => term.sql), ...(terms.some(term => term.key === 'id') ? [] : ['id ASC'])].join(', ');
}

export class PostgresStore implements DataStore {
  supportsAtomicCompareAndSwap(): boolean {
    return true;
  }

  async supportsAtomicOperationLease(): Promise<boolean> {
    try {
      const result = await this.db().query<{valid:boolean;key1:string;key2:string;key3:string;predicate:string}>(`
        SELECT i.indisvalid AND i.indisready AND i.indimmediate AND i.indisunique AND i.indnkeyatts = 3 AS valid,
               pg_get_indexdef(i.indexrelid, 1, true) AS key1,
               pg_get_indexdef(i.indexrelid, 2, true) AS key2,
               pg_get_indexdef(i.indexrelid, 3, true) AS key3,
               pg_get_expr(i.indpred, i.indrelid) AS predicate
        FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_class tab ON tab.oid = i.indrelid
        WHERE idx.relname = 'idx_lingshu_durable_operation_lease_subject'
          AND tab.oid = to_regclass('lingshu_records')
      `);
      if (result.rows.length !== 1 || result.rows[0]?.valid !== true) return false;
      const canonical = (value:string) => value.replace(/::text/g, '').replace(/[()\s]/g, '');
      const row = result.rows[0];
      return canonical(row.key1) === "data->>'tenant_id'"
        && canonical(row.key2) === "data->>'lease_scope'"
        && canonical(row.key3) === "data->>'subject_id'"
        && canonical(row.predicate) === "collection='durable_operation_leases'";
    } catch { return false; }
  }
  constructor(private readonly configuredDb?: SqlExecutor) {}

  private db(): SqlExecutor {
    return this.configuredDb ?? postgresPool();
  }

  async getById<T = Record_>(collection: string, id: string): Promise<T | null> {
    assertCollection(collection);
    const result = await this.db().query<{ data: T }>('SELECT data FROM lingshu_records WHERE collection = $1 AND id = $2', [collection, id]);
    return result.rows[0]?.data ?? null;
  }

  async create<T = Record_>(collection: string, data: Record<string, unknown>): Promise<T | null> {
    assertCollection(collection);
    const id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : recordId();
    const record = normalizedRecord(collection, id, data);
    const result = await this.db().query<{ data: T }>(`
      INSERT INTO lingshu_records (collection, id, tenant_id, data, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz)
      ON CONFLICT (collection, id) DO NOTHING
      RETURNING data
    `, [collection, id, tenantIdOf(record), JSON.stringify(record), record.created, record.updated]);
    return result.rows[0]?.data ?? null;
  }

  async update(collection: string, id: string, data: Record<string, unknown>): Promise<boolean> {
    assertCollection(collection);
    const updated = new Date().toISOString();
    const patch = { ...data, id, updated };
    const result = await this.db().query(`
      UPDATE lingshu_records
      SET data = data || $3::jsonb,
          tenant_id = COALESCE($4, tenant_id),
          updated_at = $5::timestamptz
      WHERE collection = $1 AND id = $2
    `, [collection, id, JSON.stringify(patch), tenantIdOf(patch), updated]);
    return (result.rowCount ?? 0) === 1;
  }

  async compareAndSwap(
    collection: string,
    id: string,
    expected: CompareExpected,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    assertCollection(collection);
    const updated = new Date().toISOString();
    const patch = { ...data, id, updated };
    const result = await this.db().query(`
      UPDATE lingshu_records
      SET data = data || $4::jsonb,
          tenant_id = COALESCE($5, tenant_id),
          updated_at = $6::timestamptz
      WHERE collection = $1 AND id = $2
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_each($3::jsonb) AS guard(key, value)
          WHERE data -> guard.key IS DISTINCT FROM guard.value
        )
    `, [collection, id, JSON.stringify(expected), JSON.stringify(patch), tenantIdOf(patch), updated]);
    return (result.rowCount ?? 0) === 1;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    assertCollection(collection);
    const result = await this.db().query('DELETE FROM lingshu_records WHERE collection = $1 AND id = $2', [collection, id]);
    return (result.rowCount ?? 0) === 1;
  }

  async list<T = Record_>(collection: string, query: ListQuery = {}): Promise<ListResult<T>> {
    assertCollection(collection);
    const page = Number.isSafeInteger(query.page) && Number(query.page) > 0 ? Number(query.page) : 1;
    const perPage = Number.isSafeInteger(query.perPage) && Number(query.perPage) > 0
      ? Math.min(Number(query.perPage), 500)
      : 20;
    const values: unknown[] = [collection];
    const where = whereSql(query, values);
    const count = await this.db().query<{ count: string }>(`SELECT count(*)::text AS count FROM lingshu_records WHERE ${where}`, [...values]);
    values.push(perPage, (page - 1) * perPage);
    const rows = await this.db().query<{ data: T }>(`
      SELECT data FROM lingshu_records
      WHERE ${where}
      ORDER BY ${sortSql(query.sort)}
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    const totalItems = Number(count.rows[0]?.count || 0);
    return { items: rows.rows.map(row => row.data), totalItems, totalPages: Math.ceil(totalItems / perPage), page, perPage };
  }
}

export const postgresStore: DataStore = new PostgresStore();

export async function updatePostgresObjectFileReference(input: {
  collection: string;
  recordId: string;
  field: string;
  reference: Record<string, unknown> & { originalName: string };
}): Promise<boolean> {
  assertCollection(input.collection);
  if (!IDENTIFIER.test(input.field)) throw new Error(`Invalid file field: ${input.field}`);
  const client = await postgresPool().connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ data: Record<string, unknown> }>(
      'SELECT data FROM lingshu_records WHERE collection = $1 AND id = $2 FOR UPDATE',
      [input.collection, input.recordId],
    );
    const record = locked.rows[0]?.data;
    if (!record) {
      await client.query('ROLLBACK');
      return false;
    }
    const rawFiles = record._objectFiles;
    const files = rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)
      ? rawFiles as Record<string, Array<Record<string, unknown>>>
      : {};
    const current = Array.isArray(files[input.field]) ? files[input.field] : [];
    const next = [
      ...current.filter(reference => reference?.originalName !== input.reference.originalName),
      input.reference,
    ];
    const updated = new Date().toISOString();
    const patch = {
      [input.field]: input.reference.originalName,
      _objectFiles: { ...files, [input.field]: next },
      updated,
    };
    await client.query(`
      UPDATE lingshu_records
      SET data = data || $3::jsonb, updated_at = $4::timestamptz
      WHERE collection = $1 AND id = $2
    `, [input.collection, input.recordId, JSON.stringify(patch), updated]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type PocketBasePredicate = { field: string; operator: '=' | '!='; value: string | number | boolean };

export function parsePocketBaseEqualityFilter(filter?: string): PocketBasePredicate[] {
  if (!filter?.trim()) return [];
  return filter.split(/\s*&&\s*/).map(raw => {
    const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(!=|=)\s*(.+)$/);
    if (!match) throw new Error(`Unsupported PocketBase filter during PostgreSQL cutover: ${raw}`);
    const [, field, operator, encoded] = match;
    let value: string | number | boolean;
    try {
      const parsed = JSON.parse(encoded);
      if (!['string', 'number', 'boolean'].includes(typeof parsed)) throw new Error('unsupported value');
      value = parsed;
    } catch {
      if (/^-?\d+(?:\.\d+)?$/.test(encoded)) value = Number(encoded);
      else if (encoded === 'true' || encoded === 'false') value = encoded === 'true';
      else throw new Error(`Unsupported PocketBase filter value during PostgreSQL cutover: ${encoded}`);
    }
    return { field, operator: operator as '=' | '!=', value };
  });
}

export async function postgresListWithPocketBaseFilter<T = Record_>(
  collection: string,
  options: { filter?: string; sort?: string; page?: number; perPage?: number },
): Promise<ListResult<T>> {
  const predicates = parsePocketBaseEqualityFilter(options.filter);
  const equalWhere = Object.fromEntries(predicates.filter(item => item.operator === '=').map(item => [item.field, item.value]));
  const excluded = predicates.filter(item => item.operator === '!=');
  const page = Math.max(1, Math.floor(options.page || 1));
  const perPage = Math.min(500, Math.max(1, Math.floor(options.perPage || 20)));
  if (!excluded.length) return postgresStore.list<T>(collection, { where: equalWhere, sort: options.sort, page, perPage });

  const matching: T[] = [];
  for (let sourcePage = 1; sourcePage <= 100; sourcePage += 1) {
    const result = await postgresStore.list<T>(collection, { where: equalWhere, sort: options.sort, page: sourcePage, perPage: 500 });
    matching.push(...result.items.filter(item => excluded.every(predicate => String((item as Record<string, unknown>)[predicate.field] ?? '') !== String(predicate.value))));
    if (sourcePage >= result.totalPages) break;
    if (sourcePage === 100) throw new Error('PostgreSQL compatibility filter exceeded 50000 records');
  }
  const offset = (page - 1) * perPage;
  return {
    items: matching.slice(offset, offset + perPage),
    totalItems: matching.length,
    totalPages: Math.ceil(matching.length / perPage),
    page,
    perPage,
  };
}

export async function checkPostgres(): Promise<void> {
  const result = await postgresPool().query<{ ok: number }>('SELECT 1 AS ok');
  if (result.rows[0]?.ok !== 1) throw new Error('postgres_health_check_failed');
  const schema = await postgresPool().query<{ present: string | null }>("SELECT to_regclass('public.lingshu_records')::text AS present");
  if (!schema.rows[0]?.present) throw new Error('postgres_schema_not_applied');
}
