import type { Starter198ResourceLimits } from '../../shared/contracts/starter198.js';
import { parseUsageLedgerRecord } from './usage.js';
import {
  STARTER_COLLECTIONS,
  type Starter198Repository,
  type StarterRecord,
} from './repository.js';
import { starter198AccessCycleOpen, type Starter198AccessSnapshot } from './profile.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

// waiting_human and cancelling are still active: the user or a worker must
// drive either state to a terminal outcome before another cycle is admitted.
const ACTIVE_RUN_STATUSES = new Set(['initializing', 'queued', 'planning', 'running', 'waiting_external', 'waiting_approval', 'waiting_human', 'paused', 'cancelling']);
const scopeQueues = new Map<string, Promise<void>>();
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export class Starter198QuotaError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'Starter198QuotaError';
  }
}

/** Access-cycle admission is checked before any durable command/inbox/run row. */
export function assertStarter198AccessCycleOpen(input: {
  access: Pick<Starter198AccessSnapshot, 'cycleStartedAt' | 'cycleEndsAt'>;
  now?: Date;
}): void {
  const startsAt = Date.parse(input.access.cycleStartedAt);
  const endsAt = Date.parse(input.access.cycleEndsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
    throw new Starter198QuotaError('starter_198_access_cycle_invalid', 503);
  }
  if (!starter198AccessCycleOpen(input.access, input.now)) {
    throw new Starter198QuotaError('starter_198_access_cycle_closed', 409);
  }
}

/** Process-local serialization complements database uniqueness; it is not a distributed lock. */
export async function withStarterQuotaScope<T>(scope: string, operation: () => Promise<T>): Promise<T> {
  const prior = scopeQueues.get(scope) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = prior.catch(() => undefined).then(() => gate);
  scopeQueues.set(scope, tail);
  await prior.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (scopeQueues.get(scope) === tail) scopeQueues.delete(scope);
  }
}

function assertComplete(result: { items: StarterRecord[]; totalItems: number }, code: string): void {
  if (result.totalItems > result.items.length) throw new Starter198QuotaError(code, 503);
}

export async function assertPublicationPackageQuota(input: {
  repository: Starter198Repository;
  tenantId: string;
  contentId: string;
  limits: Starter198ResourceLimits;
}): Promise<void> {
  const limit = input.limits.publicationPackageCountPerContent;
  const result = await input.repository.list(STARTER_COLLECTIONS.publicationPackages, input.tenantId, {
    where: { content_id: input.contentId }, perPage: Math.min(Math.max(limit + 1, 2), 500),
  });
  if (result.totalItems >= limit) {
    throw new Starter198QuotaError('starter_198_publication_package_quota_exceeded', 409);
  }
  assertComplete(result, 'starter_198_publication_quota_unavailable');
}

function currentRun(records: StarterRecord[]): StarterRecord | null {
  return records
    .filter(record => ACTIVE_RUN_STATUSES.has(text(record.status)))
    .sort((left, right) => text(right.started_at).localeCompare(text(left.started_at)))[0] ?? null;
}

export async function assertOrchestratorAdmissionQuota(input: {
  repository: Starter198Repository;
  tenantId: string;
  limits: Starter198ResourceLimits;
}): Promise<{ activeRunCount: number; capacityAvailable: boolean }> {
  const perStatus = await Promise.all([...ACTIVE_RUN_STATUSES].map(status => (
    input.repository.list(STARTER_COLLECTIONS.runs, input.tenantId, {
      where: { status }, sort: '-started_at',
      perPage: Math.min(Math.max(input.limits.concurrentRunCount + 1, 2), 500),
    })
  )));
  const activeRunCount = perStatus.reduce((sum, result) => sum + result.totalItems, 0);
  if (activeRunCount >= input.limits.concurrentRunCount) {
    throw new Starter198QuotaError('starter_198_concurrent_run_quota_exceeded', 409);
  }
  for (const result of perStatus) assertComplete(result, 'starter_198_run_quota_unavailable');
  const active = perStatus.flatMap(result => result.items);
  const run = currentRun(active);
  if (run) await assertBudgetAvailable({
    repository: input.repository,
    tenantId: input.tenantId,
    run,
    budgetCny: input.limits.budgetCnyPerCycle,
  });
  return {
    activeRunCount,
    capacityAvailable: true,
  };
}

async function assertBudgetAvailable(input: {
  repository: Starter198Repository;
  tenantId: string;
  run: StarterRecord;
  budgetCny: number;
}): Promise<void> {
  const ledger = await input.repository.list(STARTER_COLLECTIONS.usage, input.tenantId, {
    where: { run_id: input.run.id }, sort: 'occurred_at', perPage: 500,
  });
  assertComplete(ledger, 'starter_198_budget_ledger_incomplete');
  if (ledger.items.length === 0) {
    if (!['initializing', 'planning'].includes(text(input.run.status))) {
      throw new Starter198QuotaError('starter_198_budget_ledger_unavailable', 503);
    }
    return;
  }
  const lifecycle = new Map<string, Array<{
    record: StarterRecord;
    entry: NonNullable<ReturnType<typeof parseUsageLedgerRecord>>;
    eventType: 'reserve' | 'terminal';
    state: string;
  }>>();
  let used = 0;
  let reserved = 0;
  for (const record of ledger.items) {
    const entry = parseUsageLedgerRecord(record, input.tenantId);
    if (!entry) throw new Starter198QuotaError('starter_198_budget_ledger_unavailable', 503);
    const reservationId = text(record.reservation_id);
    const eventType = text(record.event_type);
    const state = text(record.state);
    const hasLifecycleMetadata = Boolean(reservationId || eventType || state);
    if (!hasLifecycleMetadata) {
      if (entry.costStatus !== 'known' || entry.settledCostCny === null || entry.reservedCostDeltaCny === null) {
        throw new Starter198QuotaError('starter_198_budget_ledger_unavailable', 503);
      }
      used += entry.settledCostCny;
      reserved += entry.reservedCostDeltaCny;
      continue;
    }
    if (!reservationId || !['reserve', 'terminal'].includes(eventType)
      || !['reserved', 'settled', 'failed'].includes(state)
      || (eventType === 'reserve') !== (state === 'reserved')) {
      throw new Starter198QuotaError('starter_198_budget_ledger_unavailable', 503);
    }
    const events = lifecycle.get(reservationId) ?? [];
    events.push({
      record,
      entry,
      eventType: eventType as 'reserve' | 'terminal',
      state,
    });
    lifecycle.set(reservationId, events);
  }
  for (const events of lifecycle.values()) {
    const reserves = events.filter(event => event.eventType === 'reserve');
    const terminals = events.filter(event => event.eventType === 'terminal');
    if (reserves.length !== 1 || terminals.length > 1 || events.length !== reserves.length + terminals.length) {
      throw new Starter198QuotaError('starter_198_budget_ledger_unavailable', 503);
    }
    const reserve = reserves[0];
    const terminal = terminals[0];
    if (terminal) {
      const reservationReleaseMatches = reserve.entry.reservedCostDeltaCny === null
        ? terminal.entry.reservedCostDeltaCny === null
        : terminal.entry.reservedCostDeltaCny !== null
          && Math.abs(terminal.entry.reservedCostDeltaCny + reserve.entry.reservedCostDeltaCny) < 0.000001;
      if (terminal.entry.runId !== reserve.entry.runId
        || terminal.entry.taskId !== reserve.entry.taskId
        || terminal.entry.agentRole !== reserve.entry.agentRole
        || terminal.entry.capability !== reserve.entry.capability
        || text(terminal.record.cycle_id) !== text(reserve.record.cycle_id)
        || !reservationReleaseMatches
        || terminal.entry.costStatus !== 'known'
        || terminal.entry.settledCostCny === null) {
        throw new Starter198QuotaError('starter_198_budget_ledger_unavailable', 503);
      }
      used += terminal.entry.settledCostCny;
      continue;
    }
    if (reserve.entry.costStatus !== 'known' || reserve.entry.reservedCostDeltaCny === null) {
      throw new Starter198QuotaError('starter_198_budget_ledger_unavailable', 503);
    }
    reserved += reserve.entry.reservedCostDeltaCny;
  }
  if (!Number.isFinite(used) || !Number.isFinite(reserved) || reserved < 0) {
    throw new Starter198QuotaError('starter_198_budget_ledger_invalid', 503);
  }
  if (!isInternalBudgetExemptTenant(input.tenantId) && used + reserved >= input.budgetCny) {
    throw new Starter198QuotaError('starter_198_budget_exhausted', 409);
  }
}

export async function assertQuoteDraftQuota(input: {
  repository: Pick<Starter198Repository, 'list'>;
  tenantId: string;
  cycleStartedAt: string;
  cycleEndsAt: string;
  limits: Starter198ResourceLimits;
  idempotencyKey?: string;
  now?: Date;
}): Promise<void> {
  const cycleStart = Date.parse(input.cycleStartedAt);
  const cycleEnd = Date.parse(input.cycleEndsAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(cycleStart) || !Number.isFinite(cycleEnd) || cycleEnd <= cycleStart) {
    throw new Starter198QuotaError('starter_198_quote_cycle_invalid', 503);
  }
  if (input.idempotencyKey) {
    const prior = await input.repository.list(STARTER_COLLECTIONS.quoteDrafts, input.tenantId, {
      where: { idempotency_key: input.idempotencyKey }, perPage: 2,
    });
    if (prior.totalItems > 1 || prior.items.length > 1) {
      throw new Starter198QuotaError('starter_198_quote_quota_unavailable', 503);
    }
    if (prior.items.length === 1) return;
  }
  if (now < cycleStart || now >= cycleEnd) {
    throw new Starter198QuotaError('starter_198_quote_cycle_closed', 409);
  }
  const result = await input.repository.list(STARTER_COLLECTIONS.quoteDrafts, input.tenantId, {
    sort: '-created_at', perPage: 500,
  });
  const inCycle = result.items.filter(record => {
    const createdAt = Date.parse(text(record.created_at));
    if (!Number.isFinite(createdAt)) throw new Starter198QuotaError('starter_198_quote_quota_unavailable', 503);
    return createdAt >= cycleStart && createdAt < cycleEnd;
  });
  if (inCycle.length >= input.limits.quoteDraftCountPerCycle) {
    throw new Starter198QuotaError('starter_198_quote_draft_quota_exceeded', 409);
  }
  if (result.totalItems > result.items.length) {
    const oldestLoaded = Date.parse(text(result.items.at(-1)?.created_at));
    if (!Number.isFinite(oldestLoaded) || oldestLoaded >= cycleStart) {
      throw new Starter198QuotaError('starter_198_quote_quota_unavailable', 503);
    }
  }
}
