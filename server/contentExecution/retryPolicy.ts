export type ContentExecutionFailureClass =
  | 'network_timeout'
  | 'insufficient_balance'
  | 'content_rejected'
  | 'system_fault'
  | 'provider_reconciliation'
  | 'input_required';

export interface ContentExecutionRetryDecision {
  failureClass: ContentExecutionFailureClass;
  disposition: 'retry' | 'block' | 'reconcile';
  retryDelayMs: number | null;
  maxAttempts: number;
  publicReason: string;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), minimum), maximum) : fallback;
}

function delay(schedule: number[], attempt: number): number {
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)]!;
}

export function classifyContentExecutionFailure(error: unknown, input: {
  attempt: number;
  hasUnsettledProviderReceipt?: boolean;
  env?: NodeJS.ProcessEnv;
}): ContentExecutionRetryDecision {
  const env = input.env ?? process.env;
  const raw = String(error instanceof Error ? error.message : error || 'content_execution_failed');
  const lower = raw.toLocaleLowerCase();
  const networkAttempts = boundedInteger(env.CONTENT_NETWORK_MAX_ATTEMPTS, 4, 1, 10);
  const systemAttempts = boundedInteger(env.CONTENT_SYSTEM_MAX_ATTEMPTS, 3, 1, 10);
  const reconciliationAttempts = boundedInteger(env.CONTENT_RECONCILIATION_MAX_ATTEMPTS, 12, 1, 100);

  if (input.hasUnsettledProviderReceipt
    || /provider_submission_(?:uncertain|unknown)|提交结果未知|do not resubmit|unknown submission|not_completed:(?:pending|uncertain)/i.test(raw)) {
    return {
      failureClass: 'provider_reconciliation',
      disposition: input.attempt >= reconciliationAttempts ? 'block' : 'reconcile',
      retryDelayMs: input.attempt >= reconciliationAttempts ? null : delay([15_000, 30_000, 60_000, 120_000, 300_000], input.attempt),
      maxAttempts: reconciliationAttempts,
      publicReason: input.attempt >= reconciliationAttempts ? '供应商任务需要人工确认' : '供应商已受理，正在对账',
    };
  }
  if (/insufficient[_\s-]*(?:balance|credit)|余额不足|quota[_\s-]*(?:exceeded|insufficient)|monthly_budget_exceeded|budget_denied|budget_unavailable|预算不足/i.test(lower)) {
    return {
      failureClass: 'insufficient_balance', disposition: 'block', retryDelayMs: null,
      maxAttempts: 1, publicReason: '余额或预算不足，补充后可恢复',
    };
  }
  if (/content[_\s-]*(?:rejected|moderation)|内容(?:拒绝|违规|不合规)|safety|policy violation|blocked prompt|providerrejected|qwen image (?:400|403|422)|seedance (?:400|403|422)/i.test(lower)) {
    return {
      failureClass: 'content_rejected', disposition: 'block', retryDelayMs: null,
      maxAttempts: 1, publicReason: '内容被模型拒绝，需要修改后恢复',
    };
  }
  // A product-footage finding is bound to the frozen shot plan and exact
  // material bytes. Retrying the same run cannot manufacture a missing signed
  // window or restore revoked rights; a changed plan requires a new revision.
  if (/user_input_required|production_input_required|素材.*(?:缺失|不足)|input_required|director_revision_required|product_scene_|product_footage_|quality.*failed|质量.*失败/i.test(lower)) {
    return {
      failureClass: 'input_required', disposition: 'block', retryDelayMs: null,
      maxAttempts: 1, publicReason: '需要补充素材或人工修改',
    };
  }
  if (/\b(?:etimedout|econnreset|econnrefused|enotfound|eai_again)\b|network|socket|fetch failed|timed?\s*out|timeout|http (?:408|425|429|502|503|504)/i.test(lower)) {
    return {
      failureClass: 'network_timeout',
      disposition: input.attempt >= networkAttempts ? 'block' : 'retry',
      retryDelayMs: input.attempt >= networkAttempts ? null : delay([15_000, 60_000, 300_000, 900_000], input.attempt),
      maxAttempts: networkAttempts,
      publicReason: input.attempt >= networkAttempts ? '网络重试已用尽' : '网络异常，正在分级重试',
    };
  }
  return {
    failureClass: 'system_fault',
    disposition: input.attempt >= systemAttempts ? 'block' : 'retry',
    retryDelayMs: input.attempt >= systemAttempts ? null : delay([30_000, 120_000, 600_000], input.attempt),
    maxAttempts: systemAttempts,
    publicReason: input.attempt >= systemAttempts ? '系统重试已用尽' : '系统异常，正在延迟重试',
  };
}
