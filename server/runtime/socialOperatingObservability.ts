import { pbListStrict } from '../storage/pb.js';
import { dataBackend, store } from '../storage/index.js';
import type { ListResult } from '../storage/datastore.js';
import type { ProcessRole } from './processRole.js';
import { processRoleStartsBackgroundJobs } from './processRole.js';
import { backgroundJobRuntimeState, SOCIAL_OPERATING_WORKER_HEARTBEATS, type BackgroundJobRuntimeState } from './workerHeartbeat.js';
import { runtimeBuildInfo } from './buildInfo.js';

export const SOCIAL_OPERATING_REQUIRED_COLLECTIONS = [
  'social_programs',
  'social_weekly_operating_packages',
  'social_weekly_agent_planning',
  'social_business_content_goals',
  'social_operating_decisions',
  'social_candidate_evidence',
  'social_reference_selections',
  'social_discovery_gap_tasks',
  'social_weekly_review_snapshots',
  'social_weekly_production_repair_cases',
  'social_weekly_creative_repair_configurations',
  'social_weekly_creative_repair_capacity_reservations',
  'social_weekly_creative_repair_child_executions',
  'social_weekly_creative_repair_stage_evidence',
  'social_weekly_creative_repair_audits',
  SOCIAL_OPERATING_WORKER_HEARTBEATS,
] as const;

type GapRow = {
  status?: string;
  stopReason?: string;
  spentCny?: number;
  budgetLimitCny?: number;
  createdAt?: string;
  updatedAt?: string;
};
type PostRow = { stats?: unknown };
type PackageRow = { status?: string; payload?: unknown };
type HeartbeatRow = { state?: string; last_seen_at?: string; instance_id?: string; details?: unknown };

async function listOperatingRows<T>(
  collection: string,
  options: {
    where?: Record<string, string | number | boolean>;
    pocketBaseFilter?: string;
    sort?: string;
    page?: number;
    perPage?: number;
  } = {},
): Promise<ListResult<T>> {
  if (process.env.NODE_ENV === 'production' && dataBackend === 'pocketbase') {
    return pbListStrict<T>(collection, {
      filter: options.pocketBaseFilter,
      sort: options.sort,
      page: options.page,
      perPage: options.perPage,
    });
  }
  return store.list<T>(collection, {
    where: options.where,
    sort: options.sort,
    page: options.page,
    perPage: options.perPage,
  });
}

export interface SocialOperatingSignals {
  queueBacklog: { count: number; oldestAt: string | null };
  unknownReceipts: { count: number };
  exhaustedBudgets: { count: number };
  invalidAuthorizations: { count: number };
  worker: { ready: boolean; source: 'local' | 'heartbeat'; state: string; lastSeenAt: string | null; buildSha?: string | null; expectedBuildSha?: string | null };
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function hasUnknownReceipt(row: PostRow): boolean {
  const stats = object(row.stats);
  if (stats.status === 'needs_attention') return true;
  return Object.values(object(stats.publishResults)).some(value => {
    const status = object(value).status;
    return status === 'unknown' || status === 'in_flight';
  });
}

function invalidAuthorization(row: PackageRow, today: string): boolean {
  const contentPackage = object(object(row.payload).socialContentPackage);
  const authorization = object(contentPackage.authorization);
  if (authorization.revokedAt) return true;
  if (row.status !== 'active') return false;
  return authorization.allowRealPublishing !== true
    || (typeof authorization.weekEnd === 'string' && authorization.weekEnd < today);
}

function workerMaxAgeMs(): number {
  const configured = Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS || 60_000);
  return Number.isFinite(configured) ? Math.min(Math.max(Math.floor(configured), 10_000), 10 * 60_000) : 60_000;
}

export function classifyWorkerHeartbeat(lastSeenAt: string | null, now: Date, maxAgeMs = workerMaxAgeMs()): { ready: boolean; state: string } {
  if (!lastSeenAt) return { ready: false, state: 'missing' };
  const ageMs = now.getTime() - Date.parse(lastSeenAt);
  if (!Number.isFinite(ageMs)) return { ready: false, state: 'invalid_timestamp' };
  if (ageMs < 0) return { ready: false, state: 'clock_skew' };
  if (ageMs > maxAgeMs) return { ready: false, state: 'stale' };
  return { ready: true, state: 'ready' };
}

export async function inspectSocialOperatingSignals(input: {
  role: ProcessRole;
  now?: Date;
  localWorker?: BackgroundJobRuntimeState;
}): Promise<SocialOperatingSignals> {
  const now = input.now ?? new Date();
  const [backlog, blocked, posts, packages] = await Promise.all([
    listOperatingRows<GapRow>('social_discovery_gap_tasks', { where: { status: 'collecting' }, pocketBaseFilter: 'status = "collecting"', sort: 'createdAt', page: 1, perPage: 1 }),
    listOperatingRows<GapRow>('social_discovery_gap_tasks', { where: { status: 'blocked' }, pocketBaseFilter: 'status = "blocked"', page: 1, perPage: 200 }),
    listOperatingRows<PostRow>('posts', { sort: '-published_at', page: 1, perPage: 200 }),
    listOperatingRows<PackageRow>('social_weekly_operating_packages', { sort: '-updated_at', page: 1, perPage: 200 }),
  ]);
  const exhaustedBudgets = blocked.items.filter(row => row.stopReason === 'budget_exhausted'
    || (Number.isFinite(Number(row.budgetLimitCny)) && Number(row.spentCny) >= Number(row.budgetLimitCny))).length;
  const local = input.localWorker ?? backgroundJobRuntimeState();
  let worker: SocialOperatingSignals['worker'];
  if (processRoleStartsBackgroundJobs(input.role)) {
    worker = { ready: local.state === 'ready', source: 'local', state: local.state, lastSeenAt: local.readyAt };
  } else {
    const heartbeats = await listOperatingRows<HeartbeatRow>(SOCIAL_OPERATING_WORKER_HEARTBEATS, {
      where: { state: 'ready' }, pocketBaseFilter: 'state = "ready"', sort: '-last_seen_at', page: 1, perPage: 20,
    });
    const expectedBuildSha = runtimeBuildInfo().commitSha;
    const heartbeat = expectedBuildSha === 'unknown'
      ? heartbeats.items[0]
      : heartbeats.items.find(item => String(object(item.details).build && object(object(item.details).build).commitSha || '') === expectedBuildSha);
    const latestHeartbeat = heartbeats.items[0];
    const lastSeen = typeof heartbeat?.last_seen_at === 'string' ? heartbeat.last_seen_at : null;
    const freshness = classifyWorkerHeartbeat(lastSeen, now);
    const latestBuildSha = String(object(object(latestHeartbeat?.details).build).commitSha || '') || null;
    const versionMismatch = !heartbeat && Boolean(latestHeartbeat) && expectedBuildSha !== 'unknown';
    worker = {
      ready: !versionMismatch && freshness.ready,
      source: 'heartbeat', state: versionMismatch ? 'version_mismatch' : freshness.state, lastSeenAt: lastSeen,
      buildSha: versionMismatch ? latestBuildSha : (expectedBuildSha === 'unknown' ? latestBuildSha : expectedBuildSha),
      expectedBuildSha,
    };
  }
  return {
    queueBacklog: { count: backlog.totalItems, oldestAt: backlog.items[0]?.createdAt || null },
    unknownReceipts: { count: posts.items.filter(hasUnknownReceipt).length },
    exhaustedBudgets: { count: exhaustedBudgets },
    invalidAuthorizations: { count: packages.items.filter(row => invalidAuthorization(row, now.toISOString().slice(0, 10))).length },
    worker,
  };
}

export async function assertSocialOperatingCollections(): Promise<void> {
  await Promise.all(SOCIAL_OPERATING_REQUIRED_COLLECTIONS.map(collection => (
    listOperatingRows(collection, { page: 1, perPage: 1 }).then(() => undefined)
  )));
}
