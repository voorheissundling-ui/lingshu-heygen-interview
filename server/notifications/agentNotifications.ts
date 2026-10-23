import { randomUUID } from 'node:crypto';
import { store } from '../storage/index.js';
import type { DataStore } from '../storage/datastore.js';
import {
  AGENT_NOTIFICATION_TYPES,
  type AgentNotification,
  type AgentNotificationChange,
  type AgentNotificationList,
  type AgentNotificationSeverity,
  type AgentNotificationType,
} from '../../shared/contracts/agentNotification.js';

const COLLECTION = 'agent_notifications';
const READ_COLLECTION = 'agent_notification_reads';
const TYPES = new Set<string>(AGENT_NOTIFICATION_TYPES);
const SEVERITIES = new Set<AgentNotificationSeverity>(['info', 'warning', 'critical']);

interface StoredNotification extends Record<string, unknown> {
  id: string;
  notification_id: string;
  tenant_id: string;
  event_key: string;
  type: AgentNotificationType;
  severity: AgentNotificationSeverity;
  title: string;
  summary: string;
  source_agent: string;
  entity_type: string;
  entity_id: string;
  changes: AgentNotificationChange[];
  action: AgentNotification['action'] | null;
  created_at: string;
}

interface StoredNotificationRead extends Record<string, unknown> {
  id: string;
  read_id: string;
  tenant_id: string;
  notification_id: string;
  user_id: string;
  read_at: string;
}

export class AgentNotificationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const clean = (value: unknown, max = 240) => String(value ?? '').trim().slice(0, max);

function normalizeChanges(value: unknown): AgentNotificationChange[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map(item => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const field = clean(row.field, 100);
    if (!field) throw new AgentNotificationError('notification_change_field_required');
    return { field, label: clean(row.label, 120) || field, before: row.before ?? null, after: row.after ?? null };
  });
}

function present(record: StoredNotification, readAt: string | null = null): AgentNotification {
  return {
    id: record.notification_id,
    type: record.type,
    severity: record.severity,
    title: record.title,
    summary: record.summary,
    sourceAgent: record.source_agent,
    entityType: record.entity_type,
    entityId: record.entity_id,
    changes: Array.isArray(record.changes) ? record.changes : [],
    action: record.action || undefined,
    createdAt: record.created_at,
    readAt,
  };
}

export async function createAgentNotification(input: {
  tenantId: string;
  eventKey: string;
  type: AgentNotificationType;
  severity?: AgentNotificationSeverity;
  title: string;
  summary: string;
  sourceAgent: string;
  entityType?: string;
  entityId?: string;
  changes?: AgentNotificationChange[];
  action?: AgentNotification['action'];
}, dataStore: DataStore = store): Promise<{ notification: AgentNotification; created: boolean }> {
  const tenantId = clean(input.tenantId, 120);
  const eventKey = clean(input.eventKey, 180);
  const title = clean(input.title, 160);
  const summary = clean(input.summary, 1000);
  const severity = input.severity || (input.type === 'critical_business_change' || input.type === 'authorization_required' ? 'critical' : 'info');
  if (!tenantId || !eventKey || !TYPES.has(input.type) || !title || !summary || !SEVERITIES.has(severity)) {
    throw new AgentNotificationError('invalid_notification');
  }
  const changes = normalizeChanges(input.changes);
  if (input.type === 'critical_business_change' && changes.length === 0) {
    throw new AgentNotificationError('critical_business_change_requires_changes');
  }
  const existing = await dataStore.list<StoredNotification>(COLLECTION, { where: { tenant_id: tenantId, event_key: eventKey }, perPage: 1 });
  if (existing.items[0]) return { notification: present(existing.items[0]), created: false };
  const now = new Date().toISOString();
  let notification: StoredNotification | null;
  try {
    notification = await dataStore.create<StoredNotification>(COLLECTION, {
      notification_id: `notification_${randomUUID()}`,
      tenant_id: tenantId,
      event_key: eventKey,
      type: input.type,
      severity,
      title,
      summary,
      source_agent: clean(input.sourceAgent, 100) || 'system',
      entity_type: clean(input.entityType, 100),
      entity_id: clean(input.entityId, 180),
      changes,
      action: input.action ? { label: clean(input.action.label, 80), page: clean(input.action.page, 80), href: clean(input.action.href, 500) || undefined } : null,
      created_at: now,
      updated_at: now,
    });
  } catch (error) {
    // A concurrent producer may have won the unique tenant/event key race.
    const raced = await dataStore.list<StoredNotification>(COLLECTION, { where: { tenant_id: tenantId, event_key: eventKey }, perPage: 1 });
    if (raced.items[0]) return { notification: present(raced.items[0]), created: false };
    throw error;
  }
  if (!notification) throw new AgentNotificationError('notification_write_failed', 503);
  return { notification: present(notification), created: true };
}

/**
 * Stable producer boundary for Operating Agent / Director Agent adjustments.
 * Upstream tasks own their domain mutation; this helper only records the
 * resulting, user-visible version difference and its navigation target.
 */
export async function createAgentAdjustmentNotification(input: {
  tenantId: string;
  eventKey: string;
  type: Extract<AgentNotificationType, 'scope_changed' | 'weekly_package_adjusted' | 'critical_business_change' | 'authorization_required' | 'content_task_blocked'>;
  title: string;
  summary: string;
  sourceAgent: string;
  entityType: string;
  entityId: string;
  changes: AgentNotificationChange[];
  action: NonNullable<AgentNotification['action']>;
  severity?: AgentNotificationSeverity;
}, dataStore: DataStore = store) {
  if (!input.changes.length) throw new AgentNotificationError('agent_adjustment_requires_changes');
  return createAgentNotification(input, dataStore);
}

/**
 * Narrow, presentation-only event contract shared by domain producers.
 *
 * Producers remain responsible for deciding that a scope, package, business
 * fact, authorization or review changed.  This consumer deliberately does no
 * domain calculation: it only turns an already-decided event into one durable
 * notification and a precise workbench link.  T7 can therefore publish review
 * events without coupling its promotion/review rules to notifications.
 */
export type AgentNotificationDomainEvent = {
  eventId: string;
  kind:
    | 'scope.changed'
    | 'weekly_package.adjusted'
    | 'business_information.changed'
    | 'authorization.required'
    | 'review.updated'
    | 'weekly_execution.blocked';
  tenantId: string;
  programId: string;
  packageId?: string | null;
  packageVersion?: number | null;
  taskId?: string | null;
  entityId: string;
  title: string;
  summary: string;
  sourceAgent: string;
  changes: AgentNotificationChange[];
  occurredAt: string;
};

const DOMAIN_NOTIFICATION_TYPE: Record<
  AgentNotificationDomainEvent['kind'],
  Extract<AgentNotificationType, 'scope_changed' | 'weekly_package_adjusted' | 'critical_business_change' | 'authorization_required' | 'content_task_blocked'>
> = {
  'scope.changed': 'scope_changed',
  'weekly_package.adjusted': 'weekly_package_adjusted',
  'business_information.changed': 'critical_business_change',
  'authorization.required': 'authorization_required',
  // The public notification taxonomy remains frozen while T7 is parallel.
  // Review is a weekly-package lifecycle update, not a second review model.
  'review.updated': 'weekly_package_adjusted',
  'weekly_execution.blocked': 'content_task_blocked',
};

function workbenchHref(event: AgentNotificationDomainEvent): string {
  const query = new URLSearchParams({ page: event.kind === 'scope.changed' ? 'socialInspiration' : 'socialWorkspace', programId: clean(event.programId, 180) });
  if (event.packageId) query.set('packageId', clean(event.packageId, 180));
  if (Number.isInteger(event.packageVersion) && Number(event.packageVersion) > 0) query.set('version', String(event.packageVersion));
  if (event.taskId) query.set('taskId', clean(event.taskId, 180));
  if (event.kind === 'weekly_execution.blocked' && event.taskId) query.set('executionTaskId', clean(event.taskId, 180));
  return `/?${query.toString()}`;
}

export async function consumeAgentNotificationDomainEvent(event: AgentNotificationDomainEvent, dataStore: DataStore = store) {
  const eventId = clean(event.eventId, 180);
  const programId = clean(event.programId, 180);
  const occurredAt = Date.parse(event.occurredAt);
  if (!eventId || !programId || !Number.isFinite(occurredAt)) {
    throw new AgentNotificationError('invalid_notification_domain_event');
  }
  return createAgentAdjustmentNotification({
    tenantId: event.tenantId,
    eventKey: `domain:${event.kind}:${eventId}`,
    type: DOMAIN_NOTIFICATION_TYPE[event.kind],
    severity: event.kind === 'business_information.changed' || event.kind === 'authorization.required' ? 'critical'
      : event.kind === 'weekly_execution.blocked' ? 'warning' : 'info',
    title: event.title,
    summary: event.summary,
    sourceAgent: event.sourceAgent,
    entityType: event.kind === 'scope.changed' ? 'discovery_scope'
      : event.kind === 'review.updated' ? 'weekly_review'
        : event.kind === 'weekly_execution.blocked' ? 'weekly_execution_task' : 'weekly_operating_package',
    entityId: event.entityId,
    changes: event.changes,
    action: {
      label: event.kind === 'scope.changed' ? '查看发现范围' : event.kind === 'authorization.required' ? '处理授权' : event.kind === 'review.updated' ? '查看复盘任务' : event.kind === 'weekly_execution.blocked' ? '进入任务详情处理' : '查看周工作台',
      page: event.kind === 'scope.changed' ? 'socialInspiration' : 'socialWorkspace',
      href: workbenchHref(event),
    },
  }, dataStore);
}

async function listTenantRecords(tenantId: string): Promise<StoredNotification[]> {
  const records: StoredNotification[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const result = await store.list<StoredNotification>(COLLECTION, {
      where: { tenant_id: tenantId }, sort: '-created_at', page, perPage: 100,
    });
    records.push(...result.items);
    if (page >= result.totalPages) break;
  }
  return records;
}

async function listUserReads(tenantId: string, userId: string): Promise<Map<string, string>> {
  const reads = new Map<string, string>();
  for (let page = 1; page <= 100; page += 1) {
    const result = await store.list<StoredNotificationRead>(READ_COLLECTION, {
      where: { tenant_id: tenantId, user_id: userId }, sort: '-read_at', page, perPage: 100,
    });
    for (const item of result.items) reads.set(item.notification_id, item.read_at);
    if (page >= result.totalPages) break;
  }
  return reads;
}

export async function listAgentNotifications(tenantId: string, userId: string, limit = 30): Promise<AgentNotificationList> {
  const records = await listTenantRecords(clean(tenantId, 120));
  const reads = await listUserReads(clean(tenantId, 120), clean(userId, 180));
  const items = records.slice(0, Math.min(100, Math.max(1, limit))).map(item => present(item, reads.get(item.notification_id) || null));
  return {
    items,
    unreadCount: records.reduce((count, item) => count + (reads.has(item.notification_id) ? 0 : 1), 0),
    latestAt: records[0]?.created_at || null,
  };
}

export async function markAgentNotificationRead(tenantId: string, userId: string, id: string): Promise<AgentNotification> {
  const result = await store.list<StoredNotification>(COLLECTION, {
    where: { tenant_id: clean(tenantId, 120), notification_id: clean(id, 180) }, perPage: 1,
  });
  const record = result.items[0];
  if (!record) throw new AgentNotificationError('notification_not_found', 404);
  const identity = { tenant_id: clean(tenantId, 120), notification_id: record.notification_id, user_id: clean(userId, 180) };
  const existing = await store.list<StoredNotificationRead>(READ_COLLECTION, { where: identity, perPage: 1 });
  const readAt = existing.items[0]?.read_at || new Date().toISOString();
  if (!existing.items[0]) {
    try {
      const created = await store.create<StoredNotificationRead>(READ_COLLECTION, {
        read_id: `notification_read_${randomUUID()}`, ...identity, read_at: readAt,
      });
      if (!created) throw new AgentNotificationError('notification_read_write_failed', 503);
    } catch (error) {
      const raced = await store.list<StoredNotificationRead>(READ_COLLECTION, { where: identity, perPage: 1 });
      if (!raced.items[0]) throw error;
      return present(record, raced.items[0].read_at);
    }
  }
  return present(record, readAt);
}

export async function markAllAgentNotificationsRead(tenantId: string, userId: string): Promise<number> {
  const cleanTenantId = clean(tenantId, 120);
  const cleanUserId = clean(userId, 180);
  const [records, reads] = await Promise.all([listTenantRecords(cleanTenantId), listUserReads(cleanTenantId, cleanUserId)]);
  const unread = records.filter(item => !reads.has(item.notification_id));
  const readAt = new Date().toISOString();
  await Promise.all(unread.map(item => markAgentNotificationRead(cleanTenantId, cleanUserId, item.notification_id)));
  return unread.length;
}
