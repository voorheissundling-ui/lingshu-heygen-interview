import { createHash, randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import {
  consumeAgentNotificationDomainEvent,
  type AgentNotificationDomainEvent,
} from './agentNotifications.js';

export const AGENT_NOTIFICATION_OUTBOX = 'agent_notification_outbox';

type OutboxStatus = 'pending' | 'processing' | 'delivered' | 'dead';
type OutboxRow = {
  id: string;
  tenant_id: string;
  event_id: string;
  event_kind: AgentNotificationDomainEvent['kind'];
  payload_digest: string;
  payload: AgentNotificationDomainEvent;
  status: OutboxStatus;
  attempts: number;
  available_at: string;
  claim_token?: string;
  claimed_until?: string;
  delivered_notification_id?: string;
  delivered_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
};

const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
    : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clean = (value: unknown, max = 240) => String(value ?? '').trim().slice(0, max);

function validate(event: AgentNotificationDomainEvent): void {
  if (!clean(event.eventId, 180) || !clean(event.tenantId, 120) || !clean(event.programId, 180)
    || !clean(event.entityId, 180) || !clean(event.title, 160) || !clean(event.summary, 1_000)
    || !Number.isFinite(Date.parse(event.occurredAt)) || !Array.isArray(event.changes) || !event.changes.length) {
    throw new Error('invalid_notification_outbox_event');
  }
}

/**
 * Durable producer boundary for R2/R3/R5/R6. The unique tenant/event key is
 * the replay authority; a retry either returns the original row or reports a
 * payload conflict. Domain producers never call the presentation consumer.
 */
export async function enqueueAgentNotificationDomainEvent(
  event: AgentNotificationDomainEvent,
  dataStore: DataStore = store,
): Promise<{ eventId: string; created: boolean }> {
  validate(event);
  const tenantId = clean(event.tenantId, 120);
  const eventId = clean(event.eventId, 180);
  const payloadDigest = digest(event);
  const existing = await dataStore.list<OutboxRow>(AGENT_NOTIFICATION_OUTBOX, {
    where: { tenant_id: tenantId, event_id: eventId }, perPage: 2,
  });
  if (existing.items.length > 1) throw new Error('notification_outbox_integrity_violation');
  if (existing.items[0]) {
    if (existing.items[0].payload_digest !== payloadDigest) throw new Error('notification_outbox_event_conflict');
    return { eventId, created: false };
  }
  const now = new Date().toISOString();
  try {
    const created = await dataStore.create<OutboxRow>(AGENT_NOTIFICATION_OUTBOX, {
      tenant_id: tenantId,
      event_id: eventId,
      event_kind: event.kind,
      payload_digest: payloadDigest,
      payload: event,
      status: 'pending',
      attempts: 0,
      available_at: now,
      claim_token: '',
      claimed_until: '',
      delivered_notification_id: '',
      delivered_at: '',
      last_error: '',
      created_at: now,
      updated_at: now,
    });
    if (created) return { eventId, created: true };
  } catch {
    // Unique-index contention is resolved by verifying the winning payload.
  }
  const raced = await dataStore.list<OutboxRow>(AGENT_NOTIFICATION_OUTBOX, {
    where: { tenant_id: tenantId, event_id: eventId }, perPage: 2,
  });
  if (raced.items.length === 1 && raced.items[0].payload_digest === payloadDigest) return { eventId, created: false };
  if (raced.items.length === 1) throw new Error('notification_outbox_event_conflict');
  throw new Error('notification_outbox_write_unavailable');
}

export interface AgentNotificationOutboxBatchResult {
  inspected: number;
  delivered: number;
  failed: number;
  skipped: number;
}

/** At-least-once delivery. Notification event-key idempotency closes the crash window. */
export async function consumeAgentNotificationOutboxBatch(input: {
  dataStore?: DataStore;
  now?: Date;
  limit?: number;
  claimDurationMs?: number;
  maxAttempts?: number;
  consume?: typeof consumeAgentNotificationDomainEvent;
} = {}): Promise<AgentNotificationOutboxBatchResult> {
  const dataStore = input.dataStore ?? store;
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('notification_outbox_time_invalid');
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 30)));
  const claimDurationMs = Math.max(30_000, Math.min(10 * 60_000, Math.floor(input.claimDurationMs ?? 120_000)));
  const maxAttempts = Math.max(1, Math.min(100, Math.floor(input.maxAttempts ?? 20)));
  const consumer = input.consume ?? consumeAgentNotificationDomainEvent;
  const rows = await dataStore.list<OutboxRow>(AGENT_NOTIFICATION_OUTBOX, { sort: 'created_at', page: 1, perPage: 500 });
  const candidates = rows.items.filter(row => {
    if (row.status === 'pending') return Date.parse(row.available_at) <= nowMs;
    return row.status === 'processing' && Date.parse(row.claimed_until || '') <= nowMs;
  }).slice(0, limit);
  const result: AgentNotificationOutboxBatchResult = { inspected: candidates.length, delivered: 0, failed: 0, skipped: 0 };
  for (const row of candidates) {
    const claimToken = randomUUID();
    const claimedUntil = new Date(nowMs + claimDurationMs).toISOString();
    const claimed = await dataStore.update(AGENT_NOTIFICATION_OUTBOX, row.id, {
      status: 'processing', claim_token: claimToken, claimed_until: claimedUntil, updated_at: now.toISOString(),
    });
    if (!claimed) { result.skipped += 1; continue; }
    try {
      const consumed = await consumer(row.payload, dataStore);
      if (!await dataStore.update(AGENT_NOTIFICATION_OUTBOX, row.id, {
        status: 'delivered', attempts: Number(row.attempts || 0) + 1,
        delivered_notification_id: consumed.notification.id,
        delivered_at: now.toISOString(), claim_token: '', claimed_until: '', last_error: '', updated_at: now.toISOString(),
      })) throw new Error('notification_outbox_ack_unavailable');
      result.delivered += 1;
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const terminal = attempts >= maxAttempts;
      const backoffMs = Math.min(60 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 8)));
      await dataStore.update(AGENT_NOTIFICATION_OUTBOX, row.id, {
        status: terminal ? 'dead' : 'pending', attempts,
        available_at: new Date(nowMs + backoffMs).toISOString(),
        claim_token: '', claimed_until: '',
        last_error: clean(error instanceof Error ? error.message : error, 500) || 'notification_consume_failed',
        updated_at: now.toISOString(),
      });
      result.failed += 1;
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function initAgentNotificationOutboxWorker(): void {
  if (timer || process.env.AGENT_NOTIFICATION_OUTBOX_WORKER_ENABLED === 'false') return;
  const intervalMs = Math.max(5_000, Number(process.env.AGENT_NOTIFICATION_OUTBOX_INTERVAL_MS) || 15_000);
  const tick = () => {
    if (running) return;
    running = true;
    void consumeAgentNotificationOutboxBatch().catch(error => {
      console.error('[agent-notification-outbox]', clean(error instanceof Error ? error.message : error, 300));
    }).finally(() => { running = false; });
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
}
