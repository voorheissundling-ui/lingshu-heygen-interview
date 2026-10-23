import {
  STARTER_198_CAPABILITIES,
  STARTER_AGENT_ROLES,
  type Starter198Capability,
  type Starter198ResourceLimits,
  type StarterAgentRole,
  type StarterAgentUsage,
  type StarterRunStatus,
  type StarterUsageLedgerEntryV1,
} from '../../shared/contracts/starter198.js';
import type { StarterRecord } from './repository.js';

const DISPLAY: Record<StarterAgentRole, { name: string; stage: string; site: StarterAgentUsage['productionSite'] }> = {
  orchestrator: { name: '灵小枢', stage: '经营编排', site: null },
  content: { name: '灵小图', stage: '灵感与内容', site: 'content' },
  traffic: { name: '灵小量', stage: '发布与流量', site: 'traffic' },
  sales: { name: '灵小售', stage: '询盘与报价', site: 'sales' },
};

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const PUBLIC_ANOMALY_CODES = new Set([
  'usage_cost_unknown',
  'usage_ledger_record_invalid',
  'usage_reservation_negative',
  'starter_198_usage_actual_cost_exceeds_reservation',
  'starter_198_usage_cycle_stale',
  'starter_198_usage_terminal_projection_unavailable',
  'starter_198_budget_exhausted',
]);

function publicAnomalyCode(value: unknown): string | null {
  const code = text(value);
  if (!code) return null;
  return PUBLIC_ANOMALY_CODES.has(code) ? code : 'usage_anomaly_unknown';
}

function anomalyCodes(record: StarterRecord, fallback: string | null): string[] {
  const details = object(json(record.usage)) ?? record;
  const stored = Array.isArray(details.anomaly_codes) ? details.anomaly_codes : [];
  return unique([
    ...stored.map(publicAnomalyCode),
    publicAnomalyCode(fallback),
  ]);
}

function optionalNonNegative(value: unknown): number | null | undefined {
  if (value === null || value === '' || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalFinite(value: unknown): number | null | undefined {
  if (value === null || value === '' || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function starterAgentRole(value: unknown, task?: StarterRecord): StarterAgentRole | null {
  if (value === 'orchestrator' || value === 'content' || value === 'traffic' || value === 'sales') return value;
  if (value === 'business' || value === 'planner' || value === 'knowledge' || value === 'review') return 'orchestrator';
  if (value === 'industry') return 'content';
  if (value === 'customer') return 'sales';
  if (value === 'channel') {
    return ['scheduled_source_collection', 'viral_analysis'].includes(text(task?.task_key)) ? 'content' : 'traffic';
  }
  if (value === 'risk') return text(task?.business_domain) === 'customer' ? 'sales' : 'content';
  const domain = text(task?.business_domain);
  if (domain === 'publishing') return 'traffic';
  if (domain === 'customer') return 'sales';
  if (domain === 'content') return 'content';
  if (domain === 'foundation' || domain === 'review') return 'orchestrator';
  return null;
}

export function parseUsageLedgerRecord(
  record: StarterRecord,
  tenantId: string,
): StarterUsageLedgerEntryV1 | null {
  const details = object(json(record.usage)) ?? record;
  const agentRole = starterAgentRole(record.agent_role);
  const capability = text(record.capability) as Starter198Capability;
  const inputTokens = optionalNonNegative(details.input_tokens ?? details.inputTokens);
  const outputTokens = optionalNonNegative(details.output_tokens ?? details.outputTokens);
  const cacheTokens = optionalNonNegative(details.cache_tokens ?? details.cacheTokens);
  const estimatedCostCny = optionalNonNegative(details.estimated_cost_cny ?? details.estimatedCostCny);
  const reservedCostDeltaCny = optionalFinite(details.reserved_cost_delta_cny ?? details.reservedCostDeltaCny);
  const settledCostCny = optionalNonNegative(details.settled_cost_cny ?? details.settledCostCny);
  const outputCount = optionalNonNegative(details.output_count ?? details.outputCount);
  const occurredAt = text(record.occurred_at);
  const costStatus = details.cost_status ?? details.costStatus;
  if (
    record.schema_version !== 'starter-198.usage.v1'
    || text(record.tenant_id) !== tenantId
    || !text(record.run_id)
    || !text(record.task_id)
    || !agentRole
    || !STARTER_198_CAPABILITIES.includes(capability)
    || inputTokens === undefined
    || outputTokens === undefined
    || cacheTokens === undefined
    || estimatedCostCny === undefined
    || reservedCostDeltaCny === undefined
    || settledCostCny === undefined
    || outputCount === undefined
    || outputCount === null
    || !Number.isInteger(outputCount)
    || (costStatus !== 'known' && costStatus !== 'unknown')
    || !occurredAt
    || !Number.isFinite(Date.parse(occurredAt))
  ) return null;
  return {
    schemaVersion: 'starter-198.usage.v1',
    tenantId,
    runId: text(record.run_id),
    taskId: text(record.task_id),
    agentRole,
    capability,
    inputTokens,
    outputTokens,
    cacheTokens,
    estimatedCostCny,
    reservedCostDeltaCny,
    settledCostCny,
    costStatus,
    outputCount,
    // Only the presence of a wait is part of the customer projection. Raw
    // provider errors, prompts and operator notes stay in the internal ledger.
    waitReason: text(details.wait_reason ?? details.waitReason) ? 'usage_wait_recorded' : null,
    anomalyCode: publicAnomalyCode(details.anomaly_code ?? details.anomalyCode),
    occurredAt,
  };
}

interface UsageRollup {
  agentRole: StarterAgentRole;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  estimatedCostCny: number | null;
  reservedCostCny: number | null;
  settledCostCny: number | null;
  outputCount: number;
  pending: boolean;
  waitReasons: string[];
  anomalyCodes: string[];
  occurredAt: string;
}

function usageLifecycleMetadata(record: StarterRecord): {
  reservationId: string;
  eventType: 'reserve' | 'terminal';
  state: 'reserved' | 'settled' | 'failed';
} | null {
  const reservationId = text(record.reservation_id);
  const eventType = text(record.event_type);
  const state = text(record.state);
  if (!reservationId || !['reserve', 'terminal'].includes(eventType)
    || !['reserved', 'settled', 'failed'].includes(state)
    || (eventType === 'reserve') !== (state === 'reserved')) return null;
  return {
    reservationId,
    eventType: eventType as 'reserve' | 'terminal',
    state: state as 'reserved' | 'settled' | 'failed',
  };
}

function rollupUsageRecords(records: StarterRecord[], tenantId: string): {
  items: UsageRollup[];
  invalidCount: number;
} {
  const legacy: UsageRollup[] = [];
  const lifecycle = new Map<string, Array<{
    entry: StarterUsageLedgerEntryV1;
    eventType: 'reserve' | 'terminal';
    state: string;
    anomalyCodes: string[];
  }>>();
  let invalidCount = 0;
  for (const record of records) {
    const entry = parseUsageLedgerRecord(record, tenantId);
    if (!entry) { invalidCount += 1; continue; }
    const metadata = usageLifecycleMetadata(record);
    const recordAnomalies = anomalyCodes(record, entry.anomalyCode);
    if (!metadata) {
      legacy.push({
        agentRole: entry.agentRole,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheTokens: entry.cacheTokens,
        estimatedCostCny: entry.estimatedCostCny,
        reservedCostCny: entry.reservedCostDeltaCny,
        settledCostCny: entry.settledCostCny,
        outputCount: entry.outputCount,
        pending: entry.reservedCostDeltaCny !== null && entry.reservedCostDeltaCny > 0,
        waitReasons: entry.waitReason ? [entry.waitReason] : [],
        anomalyCodes: recordAnomalies,
        occurredAt: entry.occurredAt,
      });
      continue;
    }
    const entries = lifecycle.get(metadata.reservationId) ?? [];
    entries.push({ entry, eventType: metadata.eventType, state: metadata.state, anomalyCodes: recordAnomalies });
    lifecycle.set(metadata.reservationId, entries);
  }
  const items = [...legacy];
  for (const entries of lifecycle.values()) {
    const reserves = entries.filter(item => item.eventType === 'reserve');
    const terminals = entries.filter(item => item.eventType === 'terminal');
    if (reserves.length !== 1 || terminals.length > 1 || entries.length !== reserves.length + terminals.length) {
      invalidCount += entries.length;
      continue;
    }
    const reserve = reserves[0].entry;
    const terminal = terminals[0]?.entry;
    if (terminal && terminal.agentRole !== reserve.agentRole) {
      invalidCount += entries.length;
      continue;
    }
    items.push({
      agentRole: reserve.agentRole,
      inputTokens: terminal?.inputTokens ?? null,
      outputTokens: terminal?.outputTokens ?? null,
      cacheTokens: terminal?.cacheTokens ?? null,
      estimatedCostCny: reserve.estimatedCostCny,
      reservedCostCny: terminal ? 0 : reserve.reservedCostDeltaCny,
      settledCostCny: terminal?.settledCostCny ?? (reserve.costStatus === 'known' ? 0 : null),
      outputCount: terminal?.outputCount ?? 0,
      pending: !terminal,
      waitReasons: unique(entries.map(item => item.entry.waitReason)),
      anomalyCodes: unique(entries.flatMap(item => item.anomalyCodes)),
      occurredAt: entries.map(item => item.entry.occurredAt).sort().at(-1) ?? reserve.occurredAt,
    });
  }
  return { items, invalidCount };
}

function completeSum(values: Array<number | null>): number | null {
  return values.length > 0 && values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function unavailableRegisteredHandler(task: StarterRecord): boolean {
  const output = object(json(task.output));
  return text(task.status) === 'waiting_external'
    && output?.schemaVersion === 'starter-198.registered-handler-wait.v1'
    && output.implementationAvailable === false;
}

function roleStatus(tasks: StarterRecord[], runStatus: StarterRunStatus): StarterRunStatus {
  if (tasks.some(unavailableRegisteredHandler)) return 'blocked';
  if (tasks.some(task => ['running', 'waiting_external'].includes(text(task.status)))) return 'running';
  if (tasks.some(task => ['waiting_approval', 'handed_off'].includes(text(task.status)))) return 'waiting_user';
  if (tasks.some(task => text(task.status) === 'failed')) return 'error';
  if (tasks.length > 0 && tasks.every(task => ['succeeded', 'skipped', 'cancelled'].includes(text(task.status)))) return 'completed';
  return runStatus;
}

export function aggregateStarterAgentUsage(input: {
  tenantId: string;
  runStatus: StarterRunStatus;
  resourceLimits: Starter198ResourceLimits;
  ledgerRecords: StarterRecord[];
  tasks: StarterRecord[];
}): StarterAgentUsage[] {
  const rolled = rollupUsageRecords(input.ledgerRecords, input.tenantId);
  return STARTER_AGENT_ROLES.map(role => {
    const entries = rolled.items.filter(entry => entry.agentRole === role);
    const tasks = input.tasks.filter(task => starterAgentRole(task.agent_role ?? task.background_capability, task) === role);
    const inputTokens = completeSum(entries.map(entry => entry.inputTokens));
    const outputTokens = completeSum(entries.map(entry => entry.outputTokens));
    const cacheTokens = completeSum(entries.map(entry => entry.cacheTokens));
    const tokenTotal = inputTokens === null || outputTokens === null || cacheTokens === null
      ? null
      : inputTokens + outputTokens + cacheTokens;
    const estimated = completeSum(entries.map(entry => entry.estimatedCostCny));
    const reservedRaw = completeSum(entries.map(entry => entry.reservedCostCny));
    const reserved = reservedRaw !== null && reservedRaw >= 0 ? reservedRaw : null;
    const settled = completeSum(entries.map(entry => entry.settledCostCny));
    const budget = input.resourceLimits.agentBudgetCny[role];
    const budgetKnown = settled !== null && reserved !== null;
    const remaining = budgetKnown ? budget - settled - reserved : null;
    const waits = unique([
      ...(entries.some(entry => entry.waitReasons.length > 0) ? ['有用量记录正在等待前置条件'] : []),
      ...tasks.filter(task => ['waiting_external', 'waiting_approval', 'handed_off'].includes(text(task.status)))
        .map(task => text(task.status) === 'waiting_approval' || text(task.status) === 'handed_off'
          ? '等待用户确认标准工作流节点'
          : '等待标准工作流前置条件'),
    ]);
    const anomalies = unique([
      ...entries.flatMap(entry => entry.anomalyCodes),
      ...(entries.length === 0 || settled === null || reserved === null ? ['usage_cost_unknown'] : []),
      ...(reservedRaw !== null && reservedRaw < 0 ? ['usage_reservation_negative'] : []),
      ...(rolled.invalidCount > 0 ? ['usage_ledger_record_invalid'] : []),
    ]);
    const completed = tasks.length ? tasks.filter(task => text(task.status) === 'succeeded').length : null;
    const awaitingDecision = tasks.length
      ? tasks.filter(task => ['waiting_approval', 'handed_off'].includes(text(task.status))).length
      : null;
    const outputCount = entries.length ? entries.reduce((sum, entry) => sum + entry.outputCount, 0) : null;
    const latest = entries.map(entry => entry.occurredAt).sort().at(-1) ?? null;
    return {
      role,
      displayName: DISPLAY[role].name,
      stage: DISPLAY[role].stage,
      status: roleStatus(tasks, input.runStatus),
      tokens: { input: inputTokens, output: outputTokens, cache: cacheTokens, total: tokenTotal },
      costCny: {
        estimated,
        reserved,
        settled,
        settlementStatus: settled === null || reserved === null ? 'unknown' : entries.some(entry => entry.pending) ? 'pending' : 'settled',
        updatedAt: latest,
      },
      budgetCny: {
        total: budget,
        used: settled,
        reserved,
        remaining,
        projectedOverrun: remaining === null ? null : remaining < 0,
      },
      outputs: {
        completed,
        usable: outputCount,
        awaitingDecision,
        summary: tasks.length ? `${tasks.length} 个任务，${completed ?? 0} 个完成` : null,
      },
      waits: { count: waits.length, reasons: waits },
      anomalies,
      productionSite: DISPLAY[role].site,
    };
  });
}

export function parseUsagePayload(value: unknown): Record<string, unknown> | null {
  return object(json(value));
}
