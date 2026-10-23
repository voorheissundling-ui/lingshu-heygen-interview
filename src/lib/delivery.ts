import type { DigitalEmployeeDeepLink, WorkflowTask } from './digitalEmployees';

export type DeliveryColumn = 'todo' | 'active' | 'human' | 'done';
export interface DeliveryArtifact {
  id: string;
  label: string;
  kind: 'text' | 'video' | 'audio' | 'image' | 'link';
  text?: string;
  url?: string;
  version?: string;
}
export interface DeliveryResource {
  narrationEdit?: { hash: string; lines: string[] };
  contentApproval?: { hash: string; approved: boolean };
  id: string;
  taskIds: string[];
  taskId: string;
  runId: string;
  title: string;
  subject: string;
  kind: string;
  acceptance: string;
  stage: string;
  column: DeliveryColumn;
  reason: string;
  exception: boolean;
  priority?: string;
  updatedAt: string;
  deliveredAt?: string;
  artifacts: DeliveryArtifact[];
  steps: Array<{ label: string; state: 'pending' | 'active' | 'done' }>;
  link?: DigitalEmployeeDeepLink;
  actionLabel: string;
  effect: string;
  metrics: Array<{ label: string; value: number | null }>;
}

export function safeDeliveryUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  return /^(https?:\/\/|\/(?!\/))/.test(value) ? value : '';
}

// Missing resources, skipped tasks and unknown states must stay visible, never become deliveries.
export function fallbackDelivery(task: WorkflowTask, goalTitle: string): DeliveryResource {
  const waiting = ['waiting_human', 'waiting_approval', 'handed_off', 'failed', 'paused', 'cancelled', 'skipped', 'succeeded', 'completed'].includes(task.status);
  return {
    id: `task:${task.id}`, taskIds: [task.id], taskId: task.id, runId: task.run_id,
    title: task.title, subject: goalTitle || '当前经营目标', kind: '准备工作', acceptance: task.description,
    stage: task.status === 'skipped' ? '已跳过' : task.status === 'cancelled' ? '已取消' : task.title,
    column: waiting ? 'human' : ['pending', 'planning'].includes(task.status) ? 'todo' : 'active',
    reason: task.blocked_reason || (['succeeded', 'completed'].includes(task.status) ? '步骤已结束，交付结果尚未核验。' : ['skipped', 'cancelled'].includes(task.status) ? '该任务未交付；可查看记录或调整计划。' : ''),
    exception: task.status === 'failed', priority: task.priority, updatedAt: task.updated_at, artifacts: [], steps: [],
    actionLabel: waiting ? '查看问题并处理' : '查看生产实况', effect: '', metrics: [],
  };
}

export function isDeliveryStale(card: DeliveryResource, now: number): boolean {
  const updated = Date.parse(card.updatedAt);
  return card.column === 'active' && Number.isFinite(updated) && now - updated > 30 * 60_000;
}
export function filterDeliveries(cards: DeliveryResource[], options: {
  query: string; kind: string; subject: string; period: string; exceptions: boolean; now: number;
}): DeliveryResource[] {
  const start = new Date(options.now); start.setHours(0, 0, 0, 0);
  const cutoff = options.period === 'today' ? start.getTime() : options.period === 'week' ? options.now - 7 * 86400_000 : 0;
  const priority = (card: DeliveryResource) => ({ urgent: 3, high: 2, normal: 1, low: 0 }[card.priority || 'normal'] ?? 1);
  return cards.filter(card =>
    (!options.query || `${card.title} ${card.subject} ${card.stage}`.toLowerCase().includes(options.query.toLowerCase())) &&
    (options.kind === 'all' || card.kind === options.kind) &&
    (options.subject === 'all' || card.subject === options.subject) &&
    (!cutoff || Date.parse(card.deliveredAt || card.updatedAt) >= cutoff) &&
    (!options.exceptions || card.exception || isDeliveryStale(card, options.now))
  ).sort((a, b) => Number(b.exception) - Number(a.exception) || priority(b) - priority(a) || Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''));
}
