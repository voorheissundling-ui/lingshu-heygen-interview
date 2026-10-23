import { createHash } from 'node:crypto';
import {
  STARTER_198_CAPABILITIES,
  STARTER_AGENT_ROLES,
  type Starter198Capability,
  type StarterAgentRole,
} from '../../shared/contracts/starter198.js';
import { buildStarter198CapabilityManifest, starter198CapabilityAllowed } from './profile.js';
import {
  STARTER_COLLECTIONS,
  Starter198RepositoryError,
  starter198Repository,
  type Starter198Repository,
  type StarterRecord,
} from './repository.js';
import { parseUsageLedgerRecord } from './usage.js';
import { withStarterQuotaScope } from './quota.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

export interface StarterUsageResourceUnits {
  contentArtifacts: number;
  contentRevisions: number;
  inquiryAi: number;
}

export type StarterUsageReservationCost =
  | { status: 'known'; estimatedCostCny: number; reservedCostCny: number }
  | { status: 'unknown'; anomalyCode: string };

export type StarterUsageTokenMeasurement =
  | { status: 'known'; inputTokens: number; outputTokens: number; cacheTokens: number }
  | { status: 'unknown'; anomalyCode: string };

export type StarterUsageActualCost =
  | { status: 'known'; settledCostCny: number }
  | { status: 'unknown'; anomalyCode: string };

export interface StarterUsageReservation {
  reservationId: string;
  created: boolean;
  executable: boolean;
  costStatus: 'known' | 'unknown';
  state: 'reserved' | 'settled' | 'failed';
}

export interface StarterUsageTerminalResult {
  reservationId: string;
  state: 'settled' | 'failed';
  created: boolean;
  costStatus: 'known' | 'unknown';
}

export class Starter198UsageLedgerError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'Starter198UsageLedgerError';
  }
}

type UsageEvent = {
  row: StarterRecord;
  reservationId: string;
  eventType: 'reserve' | 'terminal';
  state: 'reserved' | 'settled' | 'failed';
  role: StarterAgentRole;
  reservedCostCny: number | null;
  settledCostCny: number | null;
  resourceUnits: StarterUsageResourceUnits;
};

const ZERO_UNITS: StarterUsageResourceUnits = Object.freeze({
  contentArtifacts: 0,
  contentRevisions: 0,
  inquiryAi: 0,
});
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);
const stableHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = (value: string): boolean => /^[a-z0-9:_-]{1,200}$/i.test(value);
const validKey = (value: string): boolean => /^[a-z0-9:_.-]{8,200}$/i.test(value);
const money = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
);
const count = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);
const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

function usageObject(row: StarterRecord): Record<string, unknown> | null {
  if (typeof row.usage === 'string') {
    try { return object(JSON.parse(row.usage) as unknown); } catch { return null; }
  }
  return object(row.usage);
}

function parseUnits(value: unknown): StarterUsageResourceUnits | null {
  const source = object(value);
  if (!source) return null;
  if (!count(source.contentArtifacts) || !count(source.contentRevisions) || !count(source.inquiryAi)) return null;
  return {
    contentArtifacts: source.contentArtifacts,
    contentRevisions: source.contentRevisions,
    inquiryAi: source.inquiryAi,
  };
}

function assertUnits(value: StarterUsageResourceUnits): StarterUsageResourceUnits {
  const parsed = parseUnits(value);
  if (!parsed) throw new Starter198UsageLedgerError('starter_198_usage_units_invalid', 400);
  return parsed;
}

function assertIdentity(input: {
  tenantId: string;
  runId: string;
  taskId: string;
  agentRole: StarterAgentRole;
  capability: Starter198Capability;
  idempotencyKey: string;
}): void {
  if (!validId(input.tenantId) || !validId(input.runId) || !validId(input.taskId)
    || !validKey(input.idempotencyKey)
    || !STARTER_AGENT_ROLES.includes(input.agentRole)
    || !STARTER_198_CAPABILITIES.includes(input.capability)) {
    throw new Starter198UsageLedgerError('starter_198_usage_input_invalid', 400);
  }
}

function assertReservationCost(cost: StarterUsageReservationCost): void {
  if (cost.status === 'known') {
    if (!money(cost.estimatedCostCny) || !money(cost.reservedCostCny)) {
      throw new Starter198UsageLedgerError('starter_198_usage_cost_invalid', 400);
    }
    return;
  }
  if (!text(cost.anomalyCode) || text(cost.anomalyCode).length > 160) {
    throw new Starter198UsageLedgerError('starter_198_usage_unknown_cost_reason_required', 400);
  }
}

function assertTerminalMeasurement(input: {
  tokens: StarterUsageTokenMeasurement;
  cost: StarterUsageActualCost;
  outputCount: number;
}): void {
  if (input.tokens.status === 'known') {
    if (!count(input.tokens.inputTokens) || !count(input.tokens.outputTokens) || !count(input.tokens.cacheTokens)) {
      throw new Starter198UsageLedgerError('starter_198_usage_tokens_invalid', 400);
    }
  } else if (!text(input.tokens.anomalyCode) || text(input.tokens.anomalyCode).length > 160) {
    throw new Starter198UsageLedgerError('starter_198_usage_unknown_tokens_reason_required', 400);
  }
  if (input.cost.status === 'known') {
    if (!money(input.cost.settledCostCny)) throw new Starter198UsageLedgerError('starter_198_usage_cost_invalid', 400);
  } else if (!text(input.cost.anomalyCode) || text(input.cost.anomalyCode).length > 160) {
    throw new Starter198UsageLedgerError('starter_198_usage_unknown_cost_reason_required', 400);
  }
  if (!count(input.outputCount)) throw new Starter198UsageLedgerError('starter_198_usage_output_count_invalid', 400);
}

function parseEvent(row: StarterRecord, tenantId: string): UsageEvent | null {
  const parsed = parseUsageLedgerRecord(row, tenantId);
  const usage = usageObject(row);
  const reservationId = text(row.reservation_id);
  const eventType = text(row.event_type);
  const state = text(row.state);
  const resourceUnits = parseUnits(usage?.resource_units);
  if (!parsed || !validId(reservationId) || !resourceUnits
    || !['reserve', 'terminal'].includes(eventType)
    || !['reserved', 'settled', 'failed'].includes(state)
    || (eventType === 'reserve') !== (state === 'reserved')) return null;
  return {
    row,
    reservationId,
    eventType: eventType as UsageEvent['eventType'],
    state: state as UsageEvent['state'],
    role: parsed.agentRole,
    reservedCostCny: parsed.reservedCostDeltaCny,
    settledCostCny: parsed.settledCostCny,
    resourceUnits,
  };
}

async function exactEvent(input: {
  repository: Starter198Repository;
  tenantId: string;
  where: Record<string, string>;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.usage, input.tenantId, {
    where: input.where,
    perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new Starter198UsageLedgerError('starter_198_usage_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

function sameEvent(row: StarterRecord, idempotencyKey: string, requestHash: string): boolean {
  return text(row.idempotency_key) === idempotencyKey && text(row.request_hash) === requestHash;
}

function lifecycleUsage(events: UsageEvent[]): {
  settled: number;
  reserved: number;
  byRole: Record<StarterAgentRole, { settled: number; reserved: number }>;
  units: StarterUsageResourceUnits;
} {
  const byReservation = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const records = byReservation.get(event.reservationId) ?? [];
    records.push(event);
    byReservation.set(event.reservationId, records);
  }
  const byRole = Object.fromEntries(STARTER_AGENT_ROLES.map(role => [role, { settled: 0, reserved: 0 }])) as Record<StarterAgentRole, { settled: number; reserved: number }>;
  const units = { ...ZERO_UNITS };
  let settled = 0;
  let reserved = 0;
  for (const records of byReservation.values()) {
    const reserve = records.filter(record => record.eventType === 'reserve');
    const terminal = records.filter(record => record.eventType === 'terminal');
    if (reserve.length !== 1 || terminal.length > 1 || records.length !== reserve.length + terminal.length) {
      throw new Starter198UsageLedgerError('starter_198_usage_integrity_violation', 503);
    }
    const initial = reserve[0];
    const final = terminal[0];
    if (final && final.role !== initial.role) {
      throw new Starter198UsageLedgerError('starter_198_usage_integrity_violation', 503);
    }
    if (final) {
      if (final.settledCostCny === null) throw new Starter198UsageLedgerError('starter_198_budget_ledger_unavailable', 503);
      settled = rounded(settled + final.settledCostCny);
      byRole[initial.role].settled = rounded(byRole[initial.role].settled + final.settledCostCny);
      units.contentArtifacts += final.resourceUnits.contentArtifacts;
      units.contentRevisions += final.resourceUnits.contentRevisions;
      units.inquiryAi += final.resourceUnits.inquiryAi;
    } else {
      if (initial.reservedCostCny === null) throw new Starter198UsageLedgerError('starter_198_budget_ledger_unavailable', 503);
      reserved = rounded(reserved + initial.reservedCostCny);
      byRole[initial.role].reserved = rounded(byRole[initial.role].reserved + initial.reservedCostCny);
      units.contentArtifacts += initial.resourceUnits.contentArtifacts;
      units.contentRevisions += initial.resourceUnits.contentRevisions;
      units.inquiryAi += initial.resourceUnits.inquiryAi;
    }
  }
  return { settled, reserved, byRole, units };
}

async function cycleUsage(input: {
  repository: Starter198Repository;
  tenantId: string;
  cycleId: string;
  excludeReservationId?: string;
}): Promise<ReturnType<typeof lifecycleUsage>> {
  const result = await input.repository.list(STARTER_COLLECTIONS.usage, input.tenantId, {
    where: { cycle_id: input.cycleId }, sort: 'occurred_at', perPage: 500,
  });
  if (result.totalItems > result.items.length) {
    throw new Starter198UsageLedgerError('starter_198_budget_ledger_incomplete', 503);
  }
  const considered = input.excludeReservationId
    ? result.items.filter(row => text(row.reservation_id) !== input.excludeReservationId)
    : result.items;
  const parsed = considered.map(row => parseEvent(row, input.tenantId));
  if (parsed.some(event => !event)) {
    throw new Starter198UsageLedgerError('starter_198_budget_ledger_unavailable', 503);
  }
  return lifecycleUsage(parsed as UsageEvent[]);
}

function assertProjectedLimits(input: {
  tenantId: string;
  usage: ReturnType<typeof lifecycleUsage>;
  role: StarterAgentRole;
  reservedCostCny: number;
  units: StarterUsageResourceUnits;
  limits: Awaited<ReturnType<Starter198Repository['access']>>['resourceLimits'];
}): void {
  const violation = projectedLimitViolations(input)[0];
  if (violation) throw new Starter198UsageLedgerError(violation, 409);
}

function projectedLimitViolations(input: {
  tenantId: string;
  usage: ReturnType<typeof lifecycleUsage>;
  role: StarterAgentRole;
  reservedCostCny: number;
  units: StarterUsageResourceUnits;
  limits: Awaited<ReturnType<Starter198Repository['access']>>['resourceLimits'];
}): string[] {
  const violations: string[] = [];
  if (!isInternalBudgetExemptTenant(input.tenantId)
    && (rounded(input.usage.settled + input.usage.reserved + input.reservedCostCny) > input.limits.budgetCnyPerCycle
    || rounded(input.usage.byRole[input.role].settled + input.usage.byRole[input.role].reserved + input.reservedCostCny)
      > input.limits.agentBudgetCny[input.role])) {
    violations.push('starter_198_budget_exhausted');
  }
  if (input.usage.units.contentArtifacts + input.units.contentArtifacts > input.limits.contentArtifactCountPerCycle) {
    violations.push('starter_198_content_artifact_quota_exceeded');
  }
  if (input.usage.units.contentRevisions + input.units.contentRevisions > input.limits.contentRevisionCountPerCycle) {
    violations.push('starter_198_content_revision_quota_exceeded');
  }
  if (input.usage.units.inquiryAi + input.units.inquiryAi > input.limits.inquiryAiCountPerCycle) {
    violations.push('starter_198_inquiry_ai_quota_exceeded');
  }
  return violations;
}

function cycleId(access: Awaited<ReturnType<Starter198Repository['access']>>): string {
  return `cycle:${stableHash({ recordId: access.recordId, startedAt: access.cycleStartedAt, endsAt: access.cycleEndsAt }).slice(0, 32)}`;
}

export async function reserveStarterUsage(input: {
  tenantId: string;
  runId: string;
  taskId: string;
  agentRole: StarterAgentRole;
  capability: Starter198Capability;
  idempotencyKey: string;
  cost: StarterUsageReservationCost;
  resourceUnits?: StarterUsageResourceUnits;
  repository?: Starter198Repository;
  now?: Date;
}): Promise<StarterUsageReservation> {
  assertIdentity(input);
  assertReservationCost(input.cost);
  const units = assertUnits(input.resourceUnits ?? ZERO_UNITS);
  const repository = input.repository ?? starter198Repository;
  const now = input.now ?? new Date();
  const request = {
    runId: input.runId, taskId: input.taskId, agentRole: input.agentRole,
    capability: input.capability, cost: input.cost, resourceUnits: units,
  };
  const requestHash = stableHash(request);
  return withStarterQuotaScope(`usage:${input.tenantId}`, async () => {
    const prior = await exactEvent({ repository, tenantId: input.tenantId, where: { idempotency_key: input.idempotencyKey } });
    if (prior) {
      if (!sameEvent(prior, input.idempotencyKey, requestHash) || text(prior.event_type) !== 'reserve') {
        throw new Starter198UsageLedgerError('starter_198_usage_idempotency_conflict', 409);
      }
      const parsed = parseEvent(prior, input.tenantId);
      if (!parsed) throw new Starter198UsageLedgerError('starter_198_usage_integrity_violation', 503);
      const terminal = await exactEvent({
        repository,
        tenantId: input.tenantId,
        where: { reservation_id: parsed.reservationId, event_type: 'terminal' },
      });
      const terminalState = text(terminal?.state);
      if (terminal && !['settled', 'failed'].includes(terminalState)) {
        throw new Starter198UsageLedgerError('starter_198_usage_integrity_violation', 503);
      }
      return {
        reservationId: parsed.reservationId,
        created: false,
        executable: input.cost.status === 'known' && !terminal,
        costStatus: input.cost.status,
        state: terminal ? terminalState as 'settled' | 'failed' : 'reserved',
      };
    }
    const access = await repository.access(input.tenantId);
    const manifest = buildStarter198CapabilityManifest(access, now);
    if (!starter198CapabilityAllowed(manifest, input.capability)) {
      throw new Starter198UsageLedgerError('starter_198_usage_capability_forbidden', 403);
    }
    const start = Date.parse(access.cycleStartedAt);
    const end = Date.parse(access.cycleEndsAt);
    if (now.getTime() < start || now.getTime() >= end) {
      throw new Starter198UsageLedgerError('starter_198_usage_cycle_closed', 409);
    }
    const currentCycleId = cycleId(access);
    if (input.cost.status === 'known') {
      const usage = await cycleUsage({ repository, tenantId: input.tenantId, cycleId: currentCycleId });
      assertProjectedLimits({ tenantId: input.tenantId, usage, role: input.agentRole,
        reservedCostCny: input.cost.reservedCostCny, units, limits: access.resourceLimits });
    }
    const reservationId = `starter_usage_${stableHash(`${input.tenantId}:${input.idempotencyKey}`).slice(0, 32)}`;
    const usage = {
      input_tokens: null,
      output_tokens: null,
      cache_tokens: null,
      estimated_cost_cny: input.cost.status === 'known' ? input.cost.estimatedCostCny : null,
      reserved_cost_delta_cny: input.cost.status === 'known' ? input.cost.reservedCostCny : null,
      settled_cost_cny: input.cost.status === 'known' ? 0 : null,
      cost_status: input.cost.status,
      output_count: 0,
      wait_reason: input.cost.status === 'unknown' ? '等待成本定价' : null,
      anomaly_code: input.cost.status === 'unknown' ? text(input.cost.anomalyCode) : null,
      resource_units: units,
    };
    try {
      await repository.create(STARTER_COLLECTIONS.usage, input.tenantId, {
        schema_version: 'starter-198.usage.v1',
        run_id: input.runId,
        task_id: input.taskId,
        agent_role: input.agentRole,
        capability: input.capability,
        reservation_id: reservationId,
        idempotency_key: input.idempotencyKey,
        request_hash: requestHash,
        cycle_id: currentCycleId,
        event_type: 'reserve',
        state: 'reserved',
        usage,
        occurred_at: now.toISOString(),
      });
    } catch (error) {
      if (!(error instanceof Starter198RepositoryError)) throw error;
      const raced = await exactEvent({ repository, tenantId: input.tenantId, where: { idempotency_key: input.idempotencyKey } });
      if (!raced || !sameEvent(raced, input.idempotencyKey, requestHash) || text(raced.event_type) !== 'reserve') {
        throw new Starter198UsageLedgerError(raced ? 'starter_198_usage_idempotency_conflict' : 'starter_198_usage_storage_unavailable', raced ? 409 : 503);
      }
    }
    return {
      reservationId,
      created: true,
      executable: input.cost.status === 'known',
      costStatus: input.cost.status,
      state: 'reserved',
    };
  });
}

async function terminalStarterUsage(input: {
  tenantId: string;
  reservationId: string;
  idempotencyKey: string;
  state: 'settled' | 'failed';
  tokens: StarterUsageTokenMeasurement;
  cost: StarterUsageActualCost;
  outputCount: number;
  resourceUnits?: StarterUsageResourceUnits;
  waitReason?: string;
  anomalyCode?: string;
  repository?: Starter198Repository;
  now?: Date;
}): Promise<StarterUsageTerminalResult> {
  if (!validId(input.tenantId) || !validId(input.reservationId) || !validKey(input.idempotencyKey)) {
    throw new Starter198UsageLedgerError('starter_198_usage_input_invalid', 400);
  }
  assertTerminalMeasurement(input);
  const units = assertUnits(input.resourceUnits ?? ZERO_UNITS);
  const waitReason = text(input.waitReason).slice(0, 500);
  const explicitAnomaly = text(input.anomalyCode).slice(0, 160);
  const measurementAnomalies = [
    explicitAnomaly,
    input.tokens.status === 'unknown' ? text(input.tokens.anomalyCode) : '',
    input.cost.status === 'unknown' ? text(input.cost.anomalyCode) : '',
  ].filter(Boolean);
  const request = {
    reservationId: input.reservationId, state: input.state, tokens: input.tokens,
    cost: input.cost, outputCount: input.outputCount, resourceUnits: units,
    // Preserve the v1 request hash shape: derived terminal anomalies are
    // observability metadata and must not make an identical replay conflict.
    waitReason, anomalyCode: measurementAnomalies[0] ?? '',
  };
  const requestHash = stableHash(request);
  const repository = input.repository ?? starter198Repository;
  return withStarterQuotaScope(`usage:${input.tenantId}`, async () => {
    const reserveRow = await exactEvent({
      repository, tenantId: input.tenantId,
      where: { reservation_id: input.reservationId, event_type: 'reserve' },
    });
    const reserve = reserveRow ? parseEvent(reserveRow, input.tenantId) : null;
    if (!reserve || reserve.eventType !== 'reserve') {
      throw new Starter198UsageLedgerError('starter_198_usage_reservation_not_found', 404);
    }
    const priorTerminal = await exactEvent({
      repository, tenantId: input.tenantId,
      where: { reservation_id: input.reservationId, event_type: 'terminal' },
    });
    if (priorTerminal) {
      if (!sameEvent(priorTerminal, input.idempotencyKey, requestHash) || text(priorTerminal.state) !== input.state) {
        throw new Starter198UsageLedgerError('starter_198_usage_terminal_conflict', 409);
      }
      return { reservationId: input.reservationId, state: input.state, created: false, costStatus: input.cost.status };
    }
    const cycle = text(reserveRow?.cycle_id);
    if (!cycle) throw new Starter198UsageLedgerError('starter_198_usage_integrity_violation', 503);
    const terminalAnomalies = [...measurementAnomalies];
    if (input.cost.status === 'known' && reserve.reservedCostCny !== null
      && rounded(input.cost.settledCostCny - reserve.reservedCostCny) > 0) {
      terminalAnomalies.push('starter_198_usage_actual_cost_exceeds_reservation');
    }
    try {
      const access = await repository.access(input.tenantId);
      if (cycle !== cycleId(access)) {
        terminalAnomalies.push('starter_198_usage_cycle_stale');
      } else if (input.cost.status === 'known') {
        const withoutReservation = await cycleUsage({
          repository,
          tenantId: input.tenantId,
          cycleId: cycle,
          excludeReservationId: input.reservationId,
        });
        terminalAnomalies.push(...projectedLimitViolations({
          tenantId: input.tenantId,
          usage: withoutReservation,
          role: reserve.role,
          reservedCostCny: input.cost.settledCostCny,
          units,
          limits: access.resourceLimits,
        }));
      }
    } catch (error) {
      if (!(error instanceof Starter198RepositoryError) && !(error instanceof Starter198UsageLedgerError)) throw error;
      terminalAnomalies.push('starter_198_usage_terminal_projection_unavailable');
    }
    const anomalyCodes = [...new Set(terminalAnomalies)];
    const usage = {
      input_tokens: input.tokens.status === 'known' ? input.tokens.inputTokens : null,
      output_tokens: input.tokens.status === 'known' ? input.tokens.outputTokens : null,
      cache_tokens: input.tokens.status === 'known' ? input.tokens.cacheTokens : null,
      estimated_cost_cny: input.cost.status === 'known' ? 0 : null,
      reserved_cost_delta_cny: reserve.reservedCostCny === null ? null : -reserve.reservedCostCny,
      settled_cost_cny: input.cost.status === 'known' ? input.cost.settledCostCny : null,
      cost_status: input.cost.status,
      output_count: input.outputCount,
      wait_reason: waitReason || null,
      anomaly_code: anomalyCodes[0] ?? null,
      anomaly_codes: anomalyCodes,
      resource_units: units,
    };
    let created = true;
    try {
      await repository.create(STARTER_COLLECTIONS.usage, input.tenantId, {
        schema_version: 'starter-198.usage.v1',
        run_id: text(reserveRow?.run_id),
        task_id: text(reserveRow?.task_id),
        agent_role: reserve.role,
        capability: text(reserveRow?.capability),
        reservation_id: input.reservationId,
        idempotency_key: input.idempotencyKey,
        request_hash: requestHash,
        cycle_id: cycle,
        event_type: 'terminal',
        state: input.state,
        usage,
        occurred_at: (input.now ?? new Date()).toISOString(),
      });
    } catch (error) {
      if (!(error instanceof Starter198RepositoryError)) throw error;
      const raced = await exactEvent({ repository, tenantId: input.tenantId, where: { reservation_id: input.reservationId, event_type: 'terminal' } });
      if (!raced || !sameEvent(raced, input.idempotencyKey, requestHash) || text(raced.state) !== input.state) {
        throw new Starter198UsageLedgerError(raced ? 'starter_198_usage_terminal_conflict' : 'starter_198_usage_storage_unavailable', raced ? 409 : 503);
      }
      created = false;
    }
    return { reservationId: input.reservationId, state: input.state, created, costStatus: input.cost.status };
  });
}

export function settleStarterUsage(input: Omit<Parameters<typeof terminalStarterUsage>[0], 'state' | 'waitReason'>): Promise<StarterUsageTerminalResult> {
  return terminalStarterUsage({ ...input, state: 'settled' });
}

export function failStarterUsage(input: Omit<Parameters<typeof terminalStarterUsage>[0], 'state'>): Promise<StarterUsageTerminalResult> {
  return terminalStarterUsage({ ...input, state: 'failed' });
}
