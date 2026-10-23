import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { withDigitalEmployeeRunLock } from './runControl.js';

type Row = { id: string } & Record<string, unknown>;

export class DigitalEmployeeRunCancellationError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'DigitalEmployeeRunCancellationError';
  }
}

const text = (value: unknown): string => String(value ?? '').trim();

export function digitalEmployeeRunVersion(run: Row): string {
  return text(run.version)
    || text(run.updated_at)
    || text(run.updated)
    || [text(run.status), text(run.started_at), text(run.completed_at)].join(':');
}

async function requiredUpdate(
  dataStore: DataStore,
  collection: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!await dataStore.update(collection, id, patch)) {
    throw new DigitalEmployeeRunCancellationError('workflow_cancellation_storage_unavailable', 503);
  }
}

async function requiredCreate(
  dataStore: DataStore,
  collection: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!await dataStore.create(collection, data)) {
    throw new DigitalEmployeeRunCancellationError('workflow_cancellation_storage_unavailable', 503);
  }
}

async function allRunRows(dataStore: DataStore, collection: string, where: Record<string, string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 1; ; page++) {
    const result = await dataStore.list<Row>(collection, { where, sort: 'id', page, perPage: 500 });
    rows.push(...result.items.filter(row => Object.entries(where).every(([key, value]) => row[key] === value)));
    if (page >= result.totalPages || !result.items.length) return rows;
  }
}

export async function cancelDigitalEmployeeRun(input: {
  tenantId: string;
  userId: string;
  runId: string;
  reason?: string;
  expectedVersion?: string;
  dataStore?: DataStore;
  now?: Date;
}): Promise<{ alreadyCancelled: boolean }> {
  const dataStore = input.dataStore ?? store;
  return withDigitalEmployeeRunLock(input.tenantId, input.runId, async () => {
    const run = await dataStore.getById<Row>('workflow_runs', input.runId);
    if (!run || text(run.tenant_id) !== input.tenantId) {
      throw new DigitalEmployeeRunCancellationError('run_not_found', 404);
    }
    if (input.expectedVersion && digitalEmployeeRunVersion(run) !== input.expectedVersion) {
      throw new DigitalEmployeeRunCancellationError('starter_198_version_conflict', 409);
    }
    if (run.status === 'cancelled') return { alreadyCancelled: true };
    if (['succeeded', 'failed', 'completed'].includes(text(run.status))) {
      throw new DigitalEmployeeRunCancellationError('workflow_run_not_cancellable', 409);
    }
    const now = (input.now ?? new Date()).toISOString();
    if (run.status !== 'cancelling') {
      await requiredUpdate(dataStore, 'workflow_runs', run.id, {
        status: 'cancelling',
        current_controller: 'human',
        pause_reason: text(input.reason).slice(0, 500) || '用户通过灵小枢取消',
      });
    }
    const tasks = await allRunRows(dataStore, 'workflow_tasks', { tenant_id: input.tenantId, run_id: run.id });
    const approvals = await allRunRows(dataStore, 'approval_requests', { tenant_id: input.tenantId, run_id: run.id, status: 'pending' });
    for (const task of tasks) {
      if (['succeeded', 'failed', 'cancelled'].includes(text(task.status))) continue;
      await requiredUpdate(dataStore, 'workflow_tasks', task.id, { status: 'cancelled', updated_at: now });
    }
    for (const approval of approvals) {
      await requiredUpdate(dataStore, 'approval_requests', approval.id, { status: 'superseded', decision_note: '运行已取消，审批失效', decided_at: now });
    }
    if (text(run.goal_id)) {
      await requiredUpdate(dataStore, 'weekly_goals', text(run.goal_id), { status: 'cancelled', updated_at: now });
    }
    const events = await dataStore.list<Row>('run_events', {
      where: { tenant_id: input.tenantId, run_id: run.id }, sort: '-sequence', perPage: 1,
    });
    const sequence = Number(events.items[0]?.sequence || 0) + 1;
    const existingCancellation = await dataStore.list<Row>('run_events', { where: { tenant_id: input.tenantId, run_id: run.id, type: 'workflow.cancelled' }, page: 1, perPage: 1 });
    if (!existingCancellation.totalItems) {
    await requiredCreate(dataStore, 'run_events', {
      tenant_id: input.tenantId,
      run_id: run.id,
      task_id: '',
      sequence,
      type: 'workflow.cancelled',
      level: 'warning',
      summary: '运行已通过灵小枢取消',
      payload: {},
      occurred_at: now,
    });
    }
    const existingAudit = await dataStore.list<Row>('audit_logs', { where: { tenantId: input.tenantId, targetId: run.id, action: 'workflow.cancelled' }, page: 1, perPage: 1 });
    if (!existingAudit.totalItems) {
    await requiredCreate(dataStore, 'audit_logs', {
      tenantId: input.tenantId,
      actorUserId: input.userId,
      actorEmail: '',
      action: 'workflow.cancelled',
      targetType: 'workflow_run',
      targetId: run.id,
      metadata: { source: 'starter_198_orchestrator' },
      createdAt: now,
    });
    }
    await requiredUpdate(dataStore, 'workflow_runs', run.id, {
      status: 'cancelled',
      current_controller: 'human',
      pause_reason: text(input.reason).slice(0, 500) || '用户通过灵小枢取消',
      completed_at: now,
    });
    return { alreadyCancelled: false };
  });
}
