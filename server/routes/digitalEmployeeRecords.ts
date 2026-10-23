import type { WorkflowTaskStatus } from '../digitalEmployees/domain.js';

export type StoredRecord = { id: string; [key: string]: unknown };
export type ConfigRecord = StoredRecord & { tenant_id: string; config: unknown; status: string; config_version?: number; policy_version?: string; facts_version?: string; effective_config?: unknown; activated_at?: string };
export type GoalRecord = StoredRecord & { tenant_id: string; business_line?: string; content_platforms?: unknown; title: string; objective: string; metric: string; baseline: number; target: number; unit: string; starts_at: string; ends_at: string; scope: unknown; constraints: unknown; owner_id: string; status: string; version: number; created_at: string; updated_at: string };
export type PlanRecord = StoredRecord & { tenant_id: string; goal_id: string; status: string; plan: unknown; created_at: string };
export type RunRecord = StoredRecord & { tenant_id: string; goal_id: string; plan_id: string; status: string; current_controller: string; pause_reason: string; started_at: string; completed_at: string };
export type TaskRecord = StoredRecord & {
  tenant_id: string; goal_id: string; plan_id: string; run_id: string; task_key: string; title: string;
  description: string; agent_role: string; kind: string; status: WorkflowTaskStatus; sequence: number;
  priority: string; requires_approval: boolean; depends_on: unknown; output: unknown; blocked_reason: string;
  owner_id: string; created_at: string; updated_at: string; business_domain?: string; capability_key?: string;
  destination?: string; destination_view?: string; status_source?: string;
  execution_mode?: 'internal' | 'observe' | 'draft_executor' | 'approval';
  external_effect?: 'none' | 'draft' | 'schedule' | 'publish' | 'send'; automatic_execution_allowed?: boolean;
  policy_source?: string; business_refs?: unknown; task_version?: number; correction_version?: number;
};
export type EventRecord = StoredRecord & { tenant_id: string; run_id: string; task_id: string; sequence: number; type: string; level: string; summary: string; payload: unknown; occurred_at: string };
export type ApprovalRecord = StoredRecord & { tenant_id: string; goal_id: string; run_id: string; task_id: string; status: string; action_summary: string; risk_level: string; evidence: unknown; requested_by_agent: string; decided_by: string; decision_note: string; created_at: string; decided_at: string; subject_version?: number; content_hash?: string };
export type HandoffRecord = StoredRecord & { tenant_id: string; run_id: string; task_id: string; status: string; taken_by: string; snapshot: unknown; started_at: string; returned_at: string };
export type CorrectionRecord = StoredRecord & { tenant_id: string; goal_id: string; run_id: string; task_id: string; version: number; scope: 'one_off' | 'rule_candidate'; instruction: string; rerun_downstream: boolean; before_state: unknown; after_state: unknown; affected_task_ids: unknown; business_refs: unknown; status: string; created_by: string; created_at: string };
export type ContentBatchPlanRecord = StoredRecord & { tenant_id: string; goal_id: string; plan_id: string; run_id: string; task_id: string; status: string; orders: unknown; routing: unknown; config_version: number; policy_version: string; facts_version: string; created_at: string; updated_at: string };

export const DIGITAL_EMPLOYEE_COLLECTION = {
  config: 'digital_employee_configs', configVersions: 'digital_employee_config_versions', goals: 'weekly_goals',
  plans: 'weekly_plans', runs: 'workflow_runs', tasks: 'workflow_tasks', events: 'run_events',
  approvals: 'approval_requests', handoffs: 'handoff_sessions', reviews: 'weekly_reviews',
  corrections: 'workflow_corrections', segments: 'customer_segments', segmentMembers: 'customer_segment_members',
  followupBatches: 'followup_batches', followupItems: 'followup_batch_items', contentBatchPlans: 'content_batch_plans',
} as const;

export async function withLocalQueue<T>(queue: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const prior = queue.get(key) || Promise.resolve(); const operation = prior.catch(() => undefined).then(action);
  const tail = operation.then(() => undefined, () => undefined); queue.set(key, tail);
  try { return await operation; } finally { if (queue.get(key) === tail) queue.delete(key); }
}
export function jsonObject<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value as T;
}
