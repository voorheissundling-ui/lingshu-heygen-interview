import {
  STARTER_198_PROFILE,
  STARTER_198_PROFILE_VERSION,
  STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY,
} from '../../shared/contracts/starter198.js';
import {
  STARTER_COLLECTIONS,
  type Starter198Repository,
  type StarterRecord,
} from './repository.js';

export const STARTER_198_STANDARD_TASK_KEYS = [
  'starter_context_snapshot',
  'starter_content_research',
  'starter_content_production',
  'starter_content_quality_gate',
  STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY,
  'starter_publication_package',
  'starter_publication_evidence',
  'starter_inquiry_intake',
  'starter_quote_draft',
  'starter_result_summary',
] as const;

const STARTER_TASK_KEY_SET = new Set<string>(STARTER_198_STANDARD_TASK_KEYS);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export class Starter198WorkflowScopeError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'Starter198WorkflowScopeError';
  }
}

export function starter198RunInScope(run: StarterRecord | null, tenantId: string): run is StarterRecord {
  return Boolean(run
    && text(run.tenant_id) === tenantId
    && text(run.product_profile) === STARTER_198_PROFILE);
}

export function starter198TaskInScope(
  task: StarterRecord | null,
  tenantId: string,
  runId: string,
): task is StarterRecord {
  return Boolean(task
    && text(task.tenant_id) === tenantId
    && text(task.run_id) === runId
    && text(task.policy_source) === STARTER_198_PROFILE_VERSION
    && STARTER_TASK_KEY_SET.has(text(task.task_key)));
}

export async function requireStarter198Run(
  repository: Starter198Repository,
  tenantId: string,
  runId: string,
): Promise<StarterRecord> {
  const run = await repository.get(STARTER_COLLECTIONS.runs, tenantId, runId);
  if (!starter198RunInScope(run, tenantId)) {
    // A caller must not be able to distinguish a same-tenant legacy/advanced
    // run from an absent starter run through the starter command surface.
    throw new Starter198WorkflowScopeError('starter_198_run_not_found', 404);
  }
  return run;
}

export async function listStarter198TasksForRun(
  repository: Starter198Repository,
  tenantId: string,
  runId: string,
): Promise<StarterRecord[]> {
  const result = await repository.list(STARTER_COLLECTIONS.tasks, tenantId, {
    where: { run_id: runId, policy_source: STARTER_198_PROFILE_VERSION },
    sort: 'sequence',
    perPage: 500,
  });
  if (result.totalItems > result.items.length
    || result.items.some(task => !starter198TaskInScope(task, tenantId, runId))) {
    throw new Starter198WorkflowScopeError('starter_198_workflow_scope_invalid', 503);
  }
  const keys = result.items.map(task => text(task.task_key));
  if (new Set(keys).size !== keys.length) {
    throw new Starter198WorkflowScopeError('starter_198_workflow_scope_invalid', 503);
  }
  return result.items;
}

export async function requireStarter198Approval(input: {
  repository: Starter198Repository;
  tenantId: string;
  approvalId: string;
}): Promise<{ approval: StarterRecord; run: StarterRecord; task: StarterRecord }> {
  const approval = await input.repository.get(
    STARTER_COLLECTIONS.approvals,
    input.tenantId,
    input.approvalId,
  );
  const runId = text(approval?.run_id);
  const taskId = text(approval?.task_id);
  if (!approval || !runId || !taskId) {
    throw new Starter198WorkflowScopeError('approval_not_found', 404);
  }
  const [run, task] = await Promise.all([
    input.repository.get(STARTER_COLLECTIONS.runs, input.tenantId, runId),
    input.repository.get(STARTER_COLLECTIONS.tasks, input.tenantId, taskId),
  ]);
  if (!starter198RunInScope(run, input.tenantId)
    || !starter198TaskInScope(task, input.tenantId, runId)
    || text(task.task_key) !== STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY) {
    throw new Starter198WorkflowScopeError('approval_not_found', 404);
  }
  return { approval, run, task };
}

export async function listStarter198PendingApprovals(input: {
  repository: Starter198Repository;
  tenantId: string;
  run: StarterRecord;
  tasks?: StarterRecord[];
}): Promise<StarterRecord[]> {
  if (!starter198RunInScope(input.run, input.tenantId)) {
    throw new Starter198WorkflowScopeError('starter_198_run_not_found', 404);
  }
  const tasks = input.tasks
    ?? await listStarter198TasksForRun(input.repository, input.tenantId, input.run.id);
  const approvalTask = tasks.find(task => text(task.task_key) === STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY);
  if (!approvalTask) return [];
  const result = await input.repository.list(STARTER_COLLECTIONS.approvals, input.tenantId, {
    where: { run_id: input.run.id, task_id: approvalTask.id, status: 'pending' },
    sort: '-created_at',
    perPage: 2,
  });
  if (result.totalItems > result.items.length || result.totalItems > 1
    || result.items.some(approval => text(approval.run_id) !== input.run.id
      || text(approval.task_id) !== approvalTask.id)) {
    throw new Starter198WorkflowScopeError('starter_198_workflow_scope_invalid', 503);
  }
  return result.items;
}

/**
 * Cancellation cascades through every task and pending approval in the generic
 * runtime. Reject the whole operation if any row attached to the run is not a
 * starter fixed-graph object, instead of mutating mixed legacy/advanced state.
 */
export async function assertStarter198CancellationGraph(input: {
  repository: Starter198Repository;
  tenantId: string;
  run: StarterRecord;
}): Promise<{ tasks: StarterRecord[]; approvals: StarterRecord[] }> {
  if (!starter198RunInScope(input.run, input.tenantId)) {
    throw new Starter198WorkflowScopeError('starter_198_run_not_found', 404);
  }
  const [tasksResult, approvalsResult] = await Promise.all([
    input.repository.list(STARTER_COLLECTIONS.tasks, input.tenantId, {
      where: { run_id: input.run.id }, perPage: 500,
    }),
    input.repository.list(STARTER_COLLECTIONS.approvals, input.tenantId, {
      where: { run_id: input.run.id, status: 'pending' }, perPage: 500,
    }),
  ]);
  if (tasksResult.totalItems > tasksResult.items.length
    || approvalsResult.totalItems > approvalsResult.items.length
    || approvalsResult.totalItems > 1
    || new Set(tasksResult.items.map(task => text(task.task_key))).size !== tasksResult.items.length
    || tasksResult.items.some(task => !starter198TaskInScope(task, input.tenantId, input.run.id))) {
    throw new Starter198WorkflowScopeError('starter_198_workflow_scope_invalid', 409);
  }
  const taskById = new Map(tasksResult.items.map(task => [task.id, task]));
  if (approvalsResult.items.some(approval => {
    const task = taskById.get(text(approval.task_id));
    return text(approval.run_id) !== input.run.id
      || !task
      || text(task.task_key) !== STARTER_CONTENT_RELEASE_APPROVAL_TASK_KEY;
  })) {
    throw new Starter198WorkflowScopeError('starter_198_workflow_scope_invalid', 409);
  }
  return { tasks: tasksResult.items, approvals: approvalsResult.items };
}
