import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import {
  failStarterUsage,
  reserveStarterUsage,
  settleStarterUsage,
  type StarterUsageActualCost,
  type StarterUsageReservation,
  type StarterUsageTerminalResult,
} from '../starter198/usageLedger.js';
import type {
  CreateProductionCostQuoteInput,
  ProductionCostQuote,
  ProductionCostQuoteLine,
  ProductionCostQuoteStatus,
} from '../../shared/contracts/productionCostQuote.js';

export const PRODUCTION_COST_QUOTE_COLLECTION = 'production_cost_quotes';

type ProductionCostQuoteRow = {
  id: string;
  schema_version: string;
  tenant_id: string;
  quote_key: string;
  request_hash: string;
  task_id: string;
  run_id: string;
  currency: string;
  pricing_version: string;
  status: string;
  expected_cost_cny: number;
  upper_bound_cost_cny: number;
  budget_limit_cny: number;
  lines: unknown;
  reservation_id: string;
  actual_cost_cny: number | null;
  actual_lines: unknown;
  created_at: string;
  updated_at: string;
  settled_at: string;
};

export interface ProductionCostLedgerPort {
  reserve(input: {
    tenantId: string;
    runId: string;
    taskId: string;
    idempotencyKey: string;
    expectedCostCny: number;
    upperBoundCostCny: number;
  }): Promise<Pick<StarterUsageReservation, 'reservationId' | 'executable' | 'state'>>;
  settle(input: {
    tenantId: string;
    reservationId: string;
    idempotencyKey: string;
    actualCostCny: number;
    outputCount: number;
  }): Promise<Pick<StarterUsageTerminalResult, 'state'>>;
  fail(input: {
    tenantId: string;
    reservationId: string;
    idempotencyKey: string;
    actualCost: StarterUsageActualCost;
    reason: string;
  }): Promise<Pick<StarterUsageTerminalResult, 'state'>>;
}

export const starterProductionCostLedger: ProductionCostLedgerPort = {
  reserve: input => reserveStarterUsage({
    tenantId: input.tenantId,
    runId: input.runId,
    taskId: input.taskId,
    agentRole: 'content',
    capability: 'workflow.standard.run',
    idempotencyKey: input.idempotencyKey,
    cost: { status: 'known', estimatedCostCny: input.expectedCostCny, reservedCostCny: input.upperBoundCostCny },
  }),
  settle: input => settleStarterUsage({
    tenantId: input.tenantId,
    reservationId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
    tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cacheTokens: 0 },
    cost: { status: 'known', settledCostCny: input.actualCostCny },
    outputCount: input.outputCount,
  }),
  fail: input => failStarterUsage({
    tenantId: input.tenantId,
    reservationId: input.reservationId,
    idempotencyKey: input.idempotencyKey,
    tokens: { status: 'known', inputTokens: 0, outputTokens: 0, cacheTokens: 0 },
    cost: input.actualCost,
    outputCount: 0,
    waitReason: input.reason,
    anomalyCode: 'production_execution_failed',
  }),
};

export class ProductionCostQuoteError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
    this.name = 'ProductionCostQuoteError';
  }
}

const SAFE_ID = /^[a-z0-9:_./-]+$/i;
const QUOTE_STATUSES = new Set<ProductionCostQuoteStatus>(['quoted', 'reserved', 'settled', 'overrun', 'failed']);
const rounded = (value: number): number => Math.round((value + Number.EPSILON) * 10_000) / 10_000;

function id(value: unknown, field: string, min = 1, max = 200): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < min || normalized.length > max || !SAFE_ID.test(normalized)) {
    throw new ProductionCostQuoteError(`production_cost_${field}_invalid`);
  }
  return normalized;
}

function text(value: unknown, field: string, max: number, required = true): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if ((required && !normalized) || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(normalized)) {
    throw new ProductionCostQuoteError(`production_cost_${field}_invalid`);
  }
  return normalized;
}

function money(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000) {
    throw new ProductionCostQuoteError(`production_cost_${field}_invalid`);
  }
  return rounded(parsed);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function parsedJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value === undefined || value === null ? fallback : value as T;
}

export function buildProductionCostQuote(input: CreateProductionCostQuoteInput): Omit<ProductionCostQuote,
  'id' | 'quoteKey' | 'status' | 'reservationId' | 'actualCostCny' | 'actualLines' | 'createdAt' | 'updatedAt' | 'settledAt'> {
  const taskId = id(input.taskId, 'task_id');
  const runId = id(input.runId, 'run_id');
  const pricingVersion = id(input.pricingVersion, 'pricing_version');
  id(input.idempotencyKey, 'idempotency_key', 8);
  const budgetLimitCny = money(input.budgetLimitCny, 'budget_limit');
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 500) {
    throw new ProductionCostQuoteError('production_cost_lines_invalid');
  }
  const seen = new Set<string>();
  const lines: ProductionCostQuoteLine[] = input.lines.map(raw => {
    const lineKey = id(raw.lineKey, 'line_key');
    if (seen.has(lineKey)) throw new ProductionCostQuoteError('production_cost_line_key_duplicate');
    seen.add(lineKey);
    const quantity = raw.quantity === undefined ? 1 : Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      throw new ProductionCostQuoteError('production_cost_quantity_invalid');
    }
    const expectedUnitCostCny = money(raw.expectedUnitCostCny, 'expected_unit_cost');
    const upperBoundUnitCostCny = money(raw.upperBoundUnitCostCny, 'upper_bound_unit_cost');
    const reused = raw.reused === true;
    if (upperBoundUnitCostCny < expectedUnitCostCny) {
      throw new ProductionCostQuoteError('production_cost_line_upper_bound_below_expected');
    }
    if (reused && (expectedUnitCostCny !== 0 || upperBoundUnitCostCny !== 0)) {
      throw new ProductionCostQuoteError('production_cost_reused_line_must_be_free');
    }
    return {
      lineKey,
      label: text(raw.label, 'line_label', 200),
      quantity,
      unit: text(raw.unit || '次', 'line_unit', 40),
      expectedUnitCostCny,
      upperBoundUnitCostCny,
      expectedCostCny: rounded(expectedUnitCostCny * quantity),
      upperBoundCostCny: rounded(upperBoundUnitCostCny * quantity),
      pricingSource: text(raw.pricingSource, 'pricing_source', 300),
      explanation: text(raw.explanation, 'explanation', 1_000),
      reused,
    };
  });
  const expectedCostCny = rounded(lines.reduce((sum, line) => sum + line.expectedCostCny, 0));
  const upperBoundCostCny = rounded(lines.reduce((sum, line) => sum + line.upperBoundCostCny, 0));
  if (upperBoundCostCny > budgetLimitCny) {
    throw new ProductionCostQuoteError('production_cost_upper_bound_exceeds_budget', 409);
  }
  return {
    schemaVersion: 'production-cost-quote.v1',
    taskId,
    runId,
    currency: 'CNY',
    pricingVersion,
    expectedCostCny,
    upperBoundCostCny,
    budgetLimitCny,
    lines,
  };
}

function quoteFromRow(row: ProductionCostQuoteRow): ProductionCostQuote {
  const status = row.status as ProductionCostQuoteStatus;
  const lines = parsedJson<ProductionCostQuoteLine[]>(row.lines, []);
  const actualLines = parsedJson<ProductionCostQuote['actualLines']>(row.actual_lines, []);
  if (!row.id || row.schema_version !== 'production-cost-quote.v1' || row.currency !== 'CNY'
    || !QUOTE_STATUSES.has(status) || !Array.isArray(lines) || !Array.isArray(actualLines)) {
    throw new ProductionCostQuoteError('production_cost_quote_record_invalid', 503);
  }
  return {
    id: row.id,
    schemaVersion: 'production-cost-quote.v1',
    quoteKey: row.quote_key,
    taskId: row.task_id,
    runId: row.run_id,
    currency: 'CNY',
    pricingVersion: row.pricing_version,
    status,
    expectedCostCny: Number(row.expected_cost_cny),
    upperBoundCostCny: Number(row.upper_bound_cost_cny),
    budgetLimitCny: Number(row.budget_limit_cny),
    lines,
    reservationId: row.reservation_id || null,
    actualCostCny: status === 'settled' || status === 'overrun'
      ? Number(row.actual_cost_cny || 0)
      : status === 'failed' && row.actual_cost_cny !== null
        ? Number(row.actual_cost_cny)
        : null,
    actualLines,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at || null,
  };
}

async function exactByKey(store: DataStore, tenantId: string, quoteKey: string): Promise<ProductionCostQuoteRow | null> {
  const result = await store.list<ProductionCostQuoteRow>(PRODUCTION_COST_QUOTE_COLLECTION, {
    where: { tenant_id: tenantId, quote_key: quoteKey }, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) throw new ProductionCostQuoteError('production_cost_quote_integrity_violation', 503);
  return result.items[0] ?? null;
}

export async function createOrReuseProductionCostQuote(input: {
  store: DataStore;
  tenantId: string;
  quote: CreateProductionCostQuoteInput;
  now?: Date;
}): Promise<{ quote: ProductionCostQuote; created: boolean }> {
  const tenantId = id(input.tenantId, 'tenant_id');
  const built = buildProductionCostQuote(input.quote);
  const idempotencyKey = id(input.quote.idempotencyKey, 'idempotency_key', 8);
  const quoteKey = `pcq_${hash({ tenantId, idempotencyKey }).slice(0, 40)}`;
  const requestHash = hash(built);
  const previous = await exactByKey(input.store, tenantId, quoteKey);
  if (previous) {
    if (previous.request_hash !== requestHash) throw new ProductionCostQuoteError('production_cost_quote_idempotency_conflict', 409);
    return { quote: quoteFromRow(previous), created: false };
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  let row: ProductionCostQuoteRow | null = null;
  try {
    row = await input.store.create<ProductionCostQuoteRow>(PRODUCTION_COST_QUOTE_COLLECTION, {
      schema_version: built.schemaVersion,
      tenant_id: tenantId,
      quote_key: quoteKey,
      request_hash: requestHash,
      task_id: built.taskId,
      run_id: built.runId,
      currency: built.currency,
      pricing_version: built.pricingVersion,
      status: 'quoted',
      expected_cost_cny: built.expectedCostCny,
      upper_bound_cost_cny: built.upperBoundCostCny,
      budget_limit_cny: built.budgetLimitCny,
      lines: built.lines,
      reservation_id: '',
      actual_cost_cny: null,
      actual_lines: [],
      created_at: timestamp,
      updated_at: timestamp,
      settled_at: '',
    });
  } catch {
    // A unique-index race is resolved by the authoritative re-read below.
  }
  if (row) return { quote: quoteFromRow(row), created: true };
  const raced = await exactByKey(input.store, tenantId, quoteKey);
  if (raced?.request_hash === requestHash) return { quote: quoteFromRow(raced), created: false };
  throw new ProductionCostQuoteError(raced ? 'production_cost_quote_idempotency_conflict' : 'production_cost_quote_create_failed', raced ? 409 : 503);
}

export async function getProductionCostQuote(input: {
  store: DataStore;
  tenantId: string;
  quoteId: string;
}): Promise<ProductionCostQuote | null> {
  const tenantId = id(input.tenantId, 'tenant_id');
  const row = await input.store.getById<ProductionCostQuoteRow>(PRODUCTION_COST_QUOTE_COLLECTION, id(input.quoteId, 'quote_id'));
  return row?.tenant_id === tenantId ? quoteFromRow(row) : null;
}

export async function listProductionCostQuotes(input: {
  store: DataStore;
  tenantId: string;
  taskId?: string;
}): Promise<ProductionCostQuote[]> {
  const tenantId = id(input.tenantId, 'tenant_id');
  const result = await input.store.list<ProductionCostQuoteRow>(PRODUCTION_COST_QUOTE_COLLECTION, {
    where: { tenant_id: tenantId, ...(input.taskId ? { task_id: id(input.taskId, 'task_id') } : {}) },
    sort: '-updated_at', perPage: 500,
  });
  if (result.totalItems > result.items.length) throw new ProductionCostQuoteError('production_cost_quote_list_incomplete', 503);
  return result.items.map(quoteFromRow);
}

/** Must be called before a paid provider request; it never treats an estimate as permission. */
export function assertProductionSpendWithinQuote(quote: ProductionCostQuote, proposedTotalCostCny: number): void {
  const proposed = money(proposedTotalCostCny, 'proposed_spend');
  if (quote.status !== 'reserved' || !quote.reservationId) {
    throw new ProductionCostQuoteError('production_cost_quote_not_reserved', 409);
  }
  if (proposed > quote.upperBoundCostCny || proposed > quote.budgetLimitCny) {
    throw new ProductionCostQuoteError('production_cost_upper_bound_exceeded', 409);
  }
}

export async function reserveProductionCostQuote(input: {
  store: DataStore;
  ledger: ProductionCostLedgerPort;
  tenantId: string;
  quoteId: string;
  now?: Date;
}): Promise<ProductionCostQuote> {
  const quote = await getProductionCostQuote(input);
  if (!quote) throw new ProductionCostQuoteError('production_cost_quote_not_found', 404);
  if (quote.status === 'reserved') return quote;
  if (quote.status !== 'quoted') throw new ProductionCostQuoteError('production_cost_quote_not_reservable', 409);
  const reserved = await input.ledger.reserve({
    tenantId: input.tenantId,
    runId: quote.runId,
    taskId: quote.taskId,
    idempotencyKey: `pcq.reserve.${hash(quote.quoteKey).slice(0, 32)}`,
    expectedCostCny: quote.expectedCostCny,
    upperBoundCostCny: quote.upperBoundCostCny,
  });
  if (!reserved.executable || reserved.state !== 'reserved') throw new ProductionCostQuoteError('production_cost_ledger_not_executable', 409);
  const updatedAt = (input.now ?? new Date()).toISOString();
  if (!await input.store.update(PRODUCTION_COST_QUOTE_COLLECTION, quote.id, {
    status: 'reserved', reservation_id: reserved.reservationId, updated_at: updatedAt,
  })) throw new ProductionCostQuoteError('production_cost_quote_update_failed', 503);
  return { ...quote, status: 'reserved', reservationId: reserved.reservationId, updatedAt };
}

export async function settleProductionCostQuote(input: {
  store: DataStore;
  ledger: ProductionCostLedgerPort;
  tenantId: string;
  quoteId: string;
  actualLines: Array<{ lineKey: string; actualCostCny: number; receiptRef?: string | null }>;
  now?: Date;
}): Promise<ProductionCostQuote> {
  const quote = await getProductionCostQuote(input);
  if (!quote) throw new ProductionCostQuoteError('production_cost_quote_not_found', 404);
  const terminal = quote.status === 'settled' || quote.status === 'overrun';
  if (!terminal && (quote.status !== 'reserved' || !quote.reservationId)) throw new ProductionCostQuoteError('production_cost_quote_not_reserved', 409);
  if (!Array.isArray(input.actualLines) || input.actualLines.length !== quote.lines.length) {
    throw new ProductionCostQuoteError('production_cost_actual_lines_incomplete');
  }
  const quotedKeys = new Set(quote.lines.map(line => line.lineKey));
  const seen = new Set<string>();
  const actualLines = input.actualLines.map(line => {
    const lineKey = id(line.lineKey, 'actual_line_key');
    if (!quotedKeys.has(lineKey) || seen.has(lineKey)) throw new ProductionCostQuoteError('production_cost_actual_line_invalid');
    seen.add(lineKey);
    return {
      lineKey,
      actualCostCny: money(line.actualCostCny, 'actual_cost'),
      receiptRef: line.receiptRef ? text(line.receiptRef, 'receipt_ref', 500) : null,
    };
  });
  const actualCostCny = rounded(actualLines.reduce((sum, line) => sum + line.actualCostCny, 0));
  if (terminal) {
    if (canonical(actualLines) !== canonical(quote.actualLines)) {
      throw new ProductionCostQuoteError('production_cost_settlement_idempotency_conflict', 409);
    }
    return quote;
  }
  const reservationId = quote.reservationId;
  if (!reservationId) throw new ProductionCostQuoteError('production_cost_quote_not_reserved', 409);
  await input.ledger.settle({
    tenantId: input.tenantId,
    reservationId,
    idempotencyKey: `pcq.settle.${hash(quote.quoteKey).slice(0, 32)}`,
    actualCostCny,
    outputCount: actualLines.length,
  });
  // Settlement records the provider truth even when it exceeds the approved
  // upper bound. The overrun state is explicit; future execution is not allowed.
  const status: ProductionCostQuoteStatus = actualCostCny > quote.upperBoundCostCny ? 'overrun' : 'settled';
  const settledAt = (input.now ?? new Date()).toISOString();
  if (!await input.store.update(PRODUCTION_COST_QUOTE_COLLECTION, quote.id, {
    status, actual_cost_cny: actualCostCny, actual_lines: actualLines,
    settled_at: settledAt, updated_at: settledAt,
  })) throw new ProductionCostQuoteError('production_cost_quote_update_failed', 503);
  return { ...quote, status, actualCostCny, actualLines, settledAt, updatedAt: settledAt };
}

export async function failProductionCostQuote(input: {
  store: DataStore;
  ledger: ProductionCostLedgerPort;
  tenantId: string;
  quoteId: string;
  actualCostCny?: number | null;
  reason: string;
  now?: Date;
}): Promise<ProductionCostQuote> {
  const quote = await getProductionCostQuote(input);
  if (!quote) throw new ProductionCostQuoteError('production_cost_quote_not_found', 404);
  const actualCostCny = input.actualCostCny === undefined || input.actualCostCny === null
    ? null
    : money(input.actualCostCny, 'actual_cost');
  if (quote.status === 'failed') {
    if (actualCostCny === null) return quote;
    if (quote.actualCostCny !== null) {
      if (quote.actualCostCny === actualCostCny) return quote;
      throw new ProductionCostQuoteError('production_cost_failure_reconciliation_conflict', 409);
    }
    if (!quote.reservationId) throw new ProductionCostQuoteError('production_cost_quote_not_reserved', 409);
  } else if (quote.status !== 'reserved' || !quote.reservationId) {
    throw new ProductionCostQuoteError('production_cost_quote_not_reserved', 409);
  }
  const reason = text(input.reason, 'failure_reason', 500);
  // When the supplier has not returned a bill, keep the budget reservation
  // open. Releasing it as a fake zero (or terminalising it as unknown) would
  // either understate spend or make a later verified receipt impossible to
  // reconcile in the immutable usage ledger. A trusted reconciliation worker
  // can call this function again with the actual amount and close the reserve.
  if (actualCostCny !== null) {
    await input.ledger.fail({
      tenantId: input.tenantId,
      reservationId: quote.reservationId!,
      idempotencyKey: `pcq.fail.${hash(quote.quoteKey).slice(0, 32)}`,
      actualCost: { status: 'known', settledCostCny: actualCostCny },
      reason,
    });
  }
  const updatedAt = (input.now ?? new Date()).toISOString();
  if (!await input.store.update(PRODUCTION_COST_QUOTE_COLLECTION, quote.id, {
    status: 'failed', actual_cost_cny: actualCostCny, updated_at: updatedAt,
  })) throw new ProductionCostQuoteError('production_cost_quote_update_failed', 503);
  return { ...quote, status: 'failed', actualCostCny, updatedAt };
}
