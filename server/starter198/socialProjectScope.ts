import type { AuthLocals } from '../middleware/auth.js';

type ProjectRecord = { spec?: unknown };

function projectSpec(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function socialProjectTaskId(locals: Partial<AuthLocals>): string {
  return locals.starter198SocialContext?.taskId || '';
}

export function bindSocialProjectSpec(value: unknown, taskId: string): unknown {
  return taskId ? { ...projectSpec(value), socialContentTaskId: taskId } : value;
}

export function socialProjectBelongs(project: ProjectRecord, taskId: string): boolean {
  return !taskId || String(projectSpec(project.spec).socialContentTaskId || '') === taskId;
}

/** Exact cross-workbench access for a trusted digital-employee project. */
export function digitalEmployeeProjectBelongs(project: ProjectRecord, runId: string, taskId: string): boolean {
  if (!runId || !taskId) return false;
  const spec = projectSpec(project.spec);
  const automation = projectSpec(spec.automation);
  return automation.managedBy === 'digital_employee'
    && String(spec.workflowRunId || '') === runId
    && String(spec.workflowTaskId || '') === taskId;
}
