export const AGENT_NOTIFICATION_TYPES = [
  'scope_changed',
  'weekly_package_adjusted',
  'critical_business_change',
  'authorization_required',
  'content_task_blocked',
  'content_task_review_ready',
] as const;

export type AgentNotificationType = (typeof AGENT_NOTIFICATION_TYPES)[number];
export type AgentNotificationSeverity = 'info' | 'warning' | 'critical';

export interface AgentNotificationChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface AgentNotification {
  id: string;
  type: AgentNotificationType;
  severity: AgentNotificationSeverity;
  title: string;
  summary: string;
  sourceAgent: string;
  entityType: string;
  entityId: string;
  changes: AgentNotificationChange[];
  action?: { label: string; page: string; href?: string };
  createdAt: string;
  readAt: string | null;
}

export interface AgentNotificationList {
  items: AgentNotification[];
  unreadCount: number;
  latestAt: string | null;
}
