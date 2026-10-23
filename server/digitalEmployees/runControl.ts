import { AsyncLocalStorage } from 'node:async_hooks';
import { store } from '../storage/index.js';

type ControlledRun = { id: string; tenant_id: string; status: string; [key: string]: unknown };
const activeStatuses = new Set(['running', 'waiting_external', 'waiting_approval']);
const runQueues = new Map<string, Promise<void>>();
const heldRunLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** One process / single-active-worker lock shared by execution and human control. */
export async function withDigitalEmployeeRunLock<T>(tenantId: string, runId: string, action: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([tenantId, runId]);
  const held = heldRunLocks.getStore();
  if (held?.has(key)) return action();
  const prior = runQueues.get(key) || Promise.resolve();
  const operation = prior.catch(() => undefined).then(() => heldRunLocks.run(new Set([...(held || []), key]), action));
  const tail = operation.then(() => undefined, () => undefined);
  runQueues.set(key, tail);
  try { return await operation; }
  finally { if (runQueues.get(key) === tail) runQueues.delete(key); }
}

export function runExternalActionBlockedReason(run: ControlledRun | null, tenantId: string): string {
  if (!run || run.tenant_id !== tenantId) return 'workflow_run_unavailable';
  return activeStatuses.has(run.status) ? '' : `workflow_run_${run.status || 'inactive'}`;
}

export async function digitalEmployeeRunBlockedReason(tenantId: string, runId: string): Promise<string> {
  if (!tenantId || !runId) return 'workflow_run_unavailable';
  const run = await store.getById<ControlledRun>('workflow_runs', runId);
  return runExternalActionBlockedReason(run, tenantId);
}

export class WorkflowRunBlockedError extends Error {
  constructor(public reason: string) { super(reason); this.name = 'WorkflowRunBlockedError'; }
}

/** The check and one external operation are atomic with respect to local controls. */
export async function withDigitalEmployeeExternalAction<T>(tenantId: string, runId: string, action: () => Promise<T>): Promise<T> {
  return withDigitalEmployeeRunLock(tenantId, runId, async () => {
    const reason = await digitalEmployeeRunBlockedReason(tenantId, runId);
    if (reason) throw new WorkflowRunBlockedError(reason);
    return action();
  });
}

export function approvalRunBlockedReason(run: ControlledRun | null, tenantId: string, taskStatus: string): string {
  return runExternalActionBlockedReason(run, tenantId) || (taskStatus === 'waiting_approval' ? '' : 'approval_task_not_waiting');
}
