import type { ContentExecutionRuntime, ContentExecutionRuntimeStatus } from '../../src/lib/digitalEmployees.js';
import {
  contentExecutionDefaults,
  listContentExecutionJobs,
  listContentExecutionLimits,
  type ContentExecutionJob,
  type ContentExecutionLimit,
  type ContentExecutionLimitScope,
} from '../contentExecution/durableQueue.js';
import type { DataStore } from '../storage/datastore.js';

const STATUSES: ContentExecutionRuntimeStatus[] = [
  'queued',
  'running',
  'retry_wait',
  'reconciling',
  'blocked',
  'paused',
  'succeeded',
  'cancelled',
  'dead_letter',
];

function bounded(value: unknown, fallback: number, maximum = 100): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), maximum) : fallback;
}

function effectiveLimit(
  limits: ContentExecutionLimit[],
  scope: ContentExecutionLimitScope,
  key: string,
  fallback: number,
): number {
  return limits.find(item => item.scope === scope && item.scopeKey === key)?.maxRunning
    ?? limits.find(item => item.scope === scope && item.scopeKey === '*')?.maxRunning
    ?? fallback;
}

function maxAttempts(retryClass: string | null, env: NodeJS.ProcessEnv): number {
  if (retryClass === 'network_timeout') return bounded(env.CONTENT_NETWORK_MAX_ATTEMPTS, 4, 10);
  if (retryClass === 'system_fault') return bounded(env.CONTENT_SYSTEM_MAX_ATTEMPTS, 3, 10);
  if (retryClass === 'provider_reconciliation') return bounded(env.CONTENT_RECONCILIATION_MAX_ATTEMPTS, 12);
  return 1;
}

function publicReason(job: ContentExecutionJob): string {
  if (job.status === 'queued') return '等待后台工作槽；关闭或刷新网页不会中断';
  if (job.status === 'running') return '后台正在制作，结果会持续保存';
  if (job.status === 'succeeded') return '后台制作已完成';
  if (job.status === 'cancelled') return '任务已取消';
  if (job.status === 'paused') return hasUnsettledProviderWork(job)
    ? '已暂停后续步骤；供应商当前任务仍会对账，恢复时不会重复提交'
    : '任务已暂停，进度和已完成结果已保留';
  if (job.status === 'dead_letter') return '自动恢复已停止，需要人工处理';
  const reasonByClass: Record<string, string> = {
    network_timeout: job.status === 'blocked' ? '网络重试已用尽，需要人工恢复' : '网络异常，正在分级重试',
    insufficient_balance: '余额或预算不足，补充后可恢复',
    content_rejected: '内容被模型拒绝，需要修改后恢复',
    system_fault: job.status === 'blocked' ? '系统重试已用尽，需要人工恢复' : '系统异常，正在延迟重试',
    provider_reconciliation: job.status === 'blocked' ? '供应商任务需要人工确认' : '供应商已受理，正在对账，不会重复提交',
    input_required: '需要补充素材或人工修改',
  };
  return reasonByClass[job.retryClass || ''] || (job.status === 'blocked' ? '任务需要人工处理' : '等待自动恢复');
}

function hasUnsettledProviderWork(job: ContentExecutionJob): boolean {
  return job.providerReceipts.some(receipt => ['submitting', 'accepted', 'unknown'].includes(receipt.state));
}

function waitingOn(input: {
  job: ContentExecutionJob;
  running: ContentExecutionJob[];
  limits: ContentExecutionLimit[];
  defaults: ReturnType<typeof contentExecutionDefaults>;
}): 'tenant' | 'account' | 'task_type' | 'worker' | null {
  if (!['queued', 'retry_wait', 'reconciling'].includes(input.job.status)) return null;
  const tenantActive = input.running.length;
  if (tenantActive >= effectiveLimit(input.limits, 'tenant', '*', input.defaults.tenantMaxRunning)) return 'tenant';
  const accountActive = input.running.filter(item => item.accountId === input.job.accountId).length;
  if (accountActive >= effectiveLimit(input.limits, 'account', input.job.accountId, input.defaults.accountMaxRunning)) return 'account';
  const taskTypeActive = input.running.filter(item => item.taskType === input.job.taskType).length;
  if (taskTypeActive >= effectiveLimit(input.limits, 'task_type', input.job.taskType, input.defaults.taskTypeMaxRunning)) return 'task_type';
  return 'worker';
}

export async function buildContentExecutionRuntime(input: {
  dataStore: DataStore;
  tenantId: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<ContentExecutionRuntime> {
  const env = input.env ?? process.env;
  const defaults = contentExecutionDefaults(env);
  const [jobs, limits] = await Promise.all([
    listContentExecutionJobs(input.dataStore, input.tenantId),
    listContentExecutionLimits(input.dataStore, input.tenantId),
  ]);
  const running = jobs.filter(job => job.status === 'running');
  const claimable = jobs
    .filter(job => ['queued', 'retry_wait', 'reconciling'].includes(job.status))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  const queuePosition = new Map(claimable.map((job, index) => [job.id, index + 1]));
  const accountIds = [...new Set([
    ...jobs.map(job => job.accountId),
    ...limits.filter(item => item.scope === 'account' && item.scopeKey !== '*').map(item => item.scopeKey),
  ])].sort();
  const taskTypes = [...new Set([
    ...jobs.map(job => job.taskType),
    ...limits.filter(item => item.scope === 'task_type' && item.scopeKey !== '*').map(item => item.scopeKey),
  ])].sort();
  const counts = Object.fromEntries(STATUSES.map(status => [status, jobs.filter(job => job.status === status).length])) as Record<ContentExecutionRuntimeStatus, number>;

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    sourceStatus: 'available',
    sourceNote: jobs.length
      ? '状态来自正式任务数据库；排队、公平并发、分级重试和供应商对账均由后台服务执行。'
      : '正式任务队列已连接，当前客户暂无后台制作任务。',
    capacity: {
      tenant: {
        active: running.length,
        max: effectiveLimit(limits, 'tenant', '*', defaults.tenantMaxRunning),
      },
      accountDefaultMaxRunning: effectiveLimit(limits, 'account', '*', defaults.accountMaxRunning),
      workerMaxRunning: defaults.workerConcurrency,
      accounts: accountIds.map(accountId => ({
        accountId,
        active: running.filter(job => job.accountId === accountId).length,
        max: effectiveLimit(limits, 'account', accountId, defaults.accountMaxRunning),
      })),
      taskTypes: taskTypes.map(taskType => ({
        taskType,
        active: running.filter(job => job.taskType === taskType).length,
        max: effectiveLimit(limits, 'task_type', taskType, defaults.taskTypeMaxRunning),
      })),
    },
    counts,
    jobs: jobs.slice(0, 100).map(job => ({
      id: job.id,
      taskId: job.taskId,
      runId: job.runId,
      accountId: job.accountId,
      taskType: job.taskType,
      status: job.status,
      attempt: job.attempt,
      maxAttempts: maxAttempts(job.retryClass, env),
      nextAttemptAt: job.nextAttemptAt,
      retryClass: job.retryClass,
      publicReason: publicReason(job),
      queuePosition: queuePosition.get(job.id) ?? null,
      waitingOn: waitingOn({ job, running, limits, defaults }),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })),
  };
}

export function unavailableContentExecutionRuntime(note = '后台任务状态暂时无法读取，请刷新重试'): ContentExecutionRuntime {
  return {
    generatedAt: new Date().toISOString(),
    sourceStatus: 'unavailable',
    sourceNote: note,
    capacity: {
      tenant: { active: 0, max: 0 },
      accountDefaultMaxRunning: 0,
      workerMaxRunning: 0,
      accounts: [],
      taskTypes: [],
    },
    counts: Object.fromEntries(STATUSES.map(status => [status, 0])) as Record<ContentExecutionRuntimeStatus, number>,
    jobs: [],
  };
}
