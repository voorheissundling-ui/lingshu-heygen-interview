import type { Platform } from '../types/index.js';

export interface CrawlerOpsTask {
  id: string;
  recordId: string;
  tenantId?: string;
  platform: Platform;
  sourceUrl: string;
  title: string;
  status: 'queued' | 'pushed' | 'processing' | 'resolved' | 'failed';
  reason: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  lastStrategy?: string;
  apifyFallbackAt?: string;
  recoveryCount?: number;
  recoveredAt?: string;
  retryResetCount?: number;
  retryResetAt?: string;
  retryResetBy?: string;
}

export function filterCrawlerOpsTasksForRecordIds(
  tasks: CrawlerOpsTask[],
  visibleRecordIds?: Set<string>,
): CrawlerOpsTask[] {
  return visibleRecordIds ? tasks.filter(task => visibleRecordIds.has(task.recordId)) : tasks;
}

/**
 * `attempts` counts attempts that were actually started. A process crash must
 * not consume the in-flight attempt: return that single slot before queueing
 * the task again. Once queued, another restart must not decrement it again.
 */
export function recoverInterruptedCrawlerOpsTask(task: CrawlerOpsTask, now = new Date().toISOString()): CrawlerOpsTask {
  const legacyRecoveredZombie = task.status === 'queued'
    && task.reason === 'recovered_after_restart'
    && !task.recoveredAt;
  if (task.status !== 'processing' && !legacyRecoveredZombie) return task;
  return {
    ...task,
    status: 'queued',
    attempts: Math.max(0, Number(task.attempts || 0) - 1),
    reason: 'recovered_after_restart',
    recoveryCount: Number(task.recoveryCount || 0) + 1,
    recoveredAt: now,
    updatedAt: now,
  };
}

export function terminalizeExhaustedCrawlerOpsTask(
  task: CrawlerOpsTask,
  maxAttempts: number,
  now = new Date().toISOString(),
): CrawlerOpsTask {
  if (task.status === 'resolved' || task.attempts < maxAttempts) return task;
  return {
    ...task,
    status: 'failed',
    reason: 'max_attempts_exhausted',
    lastError: task.lastError || 'max_attempts_exhausted',
    updatedAt: now,
  };
}

export function resetCrawlerOpsTaskForExplicitRetryState(
  task: CrawlerOpsTask,
  input: { tenantId: string; userId: string; usesSourceQueue: boolean; now?: string },
): CrawlerOpsTask {
  const now = input.now || new Date().toISOString();
  return {
    ...task,
    tenantId: task.tenantId || input.tenantId,
    // The explicit request owns the immediate analysis attempt. Retire the old
    // ops task so the background worker cannot run the same record in parallel;
    // a retryable failure will enqueue a fresh task starting at attempt zero.
    status: 'resolved',
    attempts: 0,
    reason: input.usesSourceQueue ? 'explicit_reanalyze_replaced_task' : 'explicit_reanalyze_uses_local_file',
    lastError: undefined,
    lastStrategy: input.usesSourceQueue ? 'explicit_reanalyze' : 'local_file',
    retryResetCount: Number(task.retryResetCount || 0) + 1,
    retryResetAt: now,
    retryResetBy: input.userId,
    updatedAt: now,
  };
}

export function selectPendingCrawlerOpsTasks(
  tasks: CrawlerOpsTask[],
  maxAttempts: number,
  visibleRecordIds?: Set<string>,
  now = Date.now(),
): CrawlerOpsTask[] {
  return filterCrawlerOpsTasksForRecordIds(tasks, visibleRecordIds)
    .filter(task => {
      if (task.status === 'resolved') return false;
      if (task.attempts >= maxAttempts) return false;
      if (task.status === 'processing') {
        const updatedAt = Date.parse(task.updatedAt);
        return Number.isFinite(updatedAt) && now - updatedAt > 10 * 60 * 1000;
      }
      if (task.status === 'failed') return true;
      return task.status === 'queued' || task.status === 'pushed';
    })
    .sort((a, b) => {
      const ap = platformOpsPriority(a.platform);
      const bp = platformOpsPriority(b.platform);
      if (ap !== bp) return ap - bp;
      return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    });
}

function platformOpsPriority(platform: Platform): number {
  if (platform === 'youtube') return 0;
  if (platform === 'tiktok') return 1;
  if (platform === 'instagram') return 2;
  if (platform === 'facebook') return 3;
  return 9;
}

export function crawlerRetryDelayMs(attemptNo: number): number {
  return Math.min(30 * 60_000, Math.max(30_000, attemptNo * attemptNo * 30_000));
}

export function classifyCrawlerFailure(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('incomplete_gemini_video_analysis')) return 'incomplete_gemini_video_analysis';
  if (lower.includes('requested format is not available')) return 'format_unavailable';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'network_timeout';
  if (lower.includes('cookies') || lower.includes('login') || lower.includes('sign in')) return 'login_required';
  if (lower.includes('private') || lower.includes('permission')) return 'permission_required';
  if (lower.includes('429') || lower.includes('rate')) return 'rate_limited';
  if (lower.includes('gemini') || lower.includes('api_key')) return 'gemini_failed';
  return 'download_failed';
}
