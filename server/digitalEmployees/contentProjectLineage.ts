import { createHash } from 'node:crypto';

export const DIGITAL_EMPLOYEE_CONTENT_LINEAGE_SCHEMA = 'digital-employee.studio-project-lineage.v1' as const;
export const DIGITAL_EMPLOYEE_CONTENT_TASK_KEYS = new Set([
  'content_production',
  'starter_content_production',
]);

export interface DigitalEmployeeContentProjectLineage {
  tenantId: string;
  runId: string;
  taskId: string;
  taskKey: string;
  lineageHash: string;
}

export class DigitalEmployeeContentProjectLineageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DigitalEmployeeContentProjectLineageError';
  }
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

function identity(value: unknown): string {
  const candidate = text(value);
  return candidate && candidate.length <= 200 && !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : '';
}

function hash(subject: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(subject)).digest('hex');
}

export function contentProjectLineageHash(input: {
  tenantId: string;
  runId: string;
  taskId: string;
  taskKey: string;
}): string {
  return hash({ schemaVersion: DIGITAL_EMPLOYEE_CONTENT_LINEAGE_SCHEMA, ...input });
}

/**
 * Build the database-indexed projection from the immutable workflow fields in
 * the project spec. Only trusted backend production paths may call this for a
 * managed project; customer studio writes must reject `managedBy` instead.
 */
export function digitalEmployeeContentProjectLineage(input: {
  tenantId: unknown;
  spec: unknown;
}): DigitalEmployeeContentProjectLineage {
  const spec = object(input.spec);
  const automation = object(spec?.automation);
  const tenantId = identity(input.tenantId);
  const runId = identity(spec?.workflowRunId);
  const taskId = identity(spec?.workflowTaskId);
  const taskKey = identity(spec?.workflowTaskKey);
  if (!tenantId || !spec || !automation
    || text(automation.managedBy) !== 'digital_employee'
    || !runId || !taskId || !DIGITAL_EMPLOYEE_CONTENT_TASK_KEYS.has(taskKey)) {
    throw new DigitalEmployeeContentProjectLineageError('digital_employee_content_lineage_invalid');
  }
  return {
    tenantId,
    runId,
    taskId,
    taskKey,
    lineageHash: contentProjectLineageHash({ tenantId, runId, taskId, taskKey }),
  };
}

export function contentProjectLineageFields(input: {
  tenantId: unknown;
  spec: unknown;
  current?: Record<string, unknown> | null;
}): Record<string, string> {
  const lineage = digitalEmployeeContentProjectLineage(input);
  const fields = {
    workflow_run_id: lineage.runId,
    workflow_task_id: lineage.taskId,
    workflow_task_key: lineage.taskKey,
    workflow_lineage_hash: lineage.lineageHash,
  };
  for (const [field, expected] of Object.entries(fields)) {
    const stored = text(input.current?.[field]);
    if (stored && stored !== expected) {
      throw new DigitalEmployeeContentProjectLineageError('digital_employee_content_lineage_mismatch');
    }
  }
  return fields;
}

/** Require the indexed projection and nested spec to describe the same owner. */
export function requireIndexedContentProjectLineage(
  project: Record<string, unknown>,
): DigitalEmployeeContentProjectLineage {
  const lineage = digitalEmployeeContentProjectLineage({
    tenantId: project.tenant_id,
    spec: project.spec,
  });
  const expected = contentProjectLineageFields({
    tenantId: lineage.tenantId,
    spec: project.spec,
  });
  if (Object.entries(expected).some(([field, value]) => text(project[field]) !== value)) {
    throw new DigitalEmployeeContentProjectLineageError('digital_employee_content_lineage_unindexed');
  }
  return lineage;
}

export function managedContentProjectIsReviewable(project: Record<string, unknown>): boolean {
  try { requireIndexedContentProjectLineage(project); } catch { return false; }
  const spec = object(project.spec);
  const automation = object(spec?.automation);
  const quality = object(automation?.quality);
  return ['ready_for_approval', 'completed'].includes(text(project.status))
    && text(automation?.stage) === 'completed'
    && text(automation?.status) === 'ready_for_approval'
    && text(automation?.renderOutputPath).length > 0
    && quality?.passed === true
    && Number(quality.ruleVersion) === 9
    && Number(quality.outputBytes) > 0
    && automation?.synthetic !== true
    && text(spec?.source) !== 'demo_data';
}

/** A managed project must be scoped by its immutable indexed lineage. Task
 * business refs are mutable projections and may still contain a historical
 * draft; trusting them would keep a completed run falsely "in progress". */
export function managedContentProjectBelongsToWorkflowScope(
  project: Record<string, unknown>,
  runId: string,
  taskIds: ReadonlySet<string>,
): boolean | null {
  const spec = object(project.spec);
  const automation = object(spec?.automation);
  if (text(automation?.managedBy) !== 'digital_employee') return null;
  try {
    const lineage = requireIndexedContentProjectLineage(project);
    return lineage.runId === runId && taskIds.has(lineage.taskId);
  } catch {
    return false;
  }
}

/** Studio drafts can be opened from an upstream routing screen and carry that
 * screen's run/task ids. Once any explicit workflow identity is present, only
 * a production-task identity can make the draft production evidence. */
export function contentProjectExplicitWorkflowScope(
  project: Record<string, unknown>,
  runId: string,
  taskIds: ReadonlySet<string>,
): boolean | null {
  const spec = object(project.spec);
  if (!spec || !text(spec.contentMode)) return null;
  const explicitRunId = identity(spec.workflowRunId);
  const explicitTaskId = identity(spec.workflowTaskId);
  const explicitTaskKey = identity(spec.workflowTaskKey);
  if (!explicitRunId && !explicitTaskId && !explicitTaskKey) return null;
  return explicitRunId === runId
    && taskIds.has(explicitTaskId)
    && DIGITAL_EMPLOYEE_CONTENT_TASK_KEYS.has(explicitTaskKey);
}
