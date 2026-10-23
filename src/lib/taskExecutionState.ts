export type TaskWaitKind = 'queued' | 'processing' | 'scheduled' | 'data' | 'input' | 'service' | 'approval' | 'manual';
export interface TaskWaitState { kind: TaskWaitKind; message: string; requiresAttention: boolean }
export const taskWaitLabels: Record<TaskWaitKind, string> = {
  queued: '等待执行', processing: '正在处理', scheduled: '等待执行时间', data: '等待业务数据',
  input: '需要补充资料', service: '执行服务异常', approval: '等待审批', manual: '需要人工处理',
};
export function taskNeedsAttention(task: { status: string; blocked_reason?: string; output?: Record<string, unknown> }): boolean {
  if (['succeeded', 'skipped', 'cancelled', 'pending'].includes(task.status)) return false;
  if (['failed', 'handed_off', 'waiting_human'].includes(task.status)) return true;
  // Approvals have their own actionable cards; don't duplicate them as failures.
  if (task.status === 'waiting_approval') return false;
  const state = task.output?.waitState as TaskWaitState | undefined;
  return state ? state.requiresAttention : Boolean(task.blocked_reason);
}
