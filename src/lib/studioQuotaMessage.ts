type StudioHttpErrorPayload = {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  quota?: unknown;
  retryAfterSeconds?: unknown;
};

export interface StudioHttpErrorContext {
  status?: number;
  retryAfter?: string | null;
  nowMs?: number;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function retryAfterSeconds(value: unknown, nowMs: number): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - nowMs) / 1_000));
}

/**
 * Format 402/429 responses without confusing provider throttling, project
 * budgets, or subscription errors with the product's own demo allowance.
 */
export function formatStudioHttpError(
  value: unknown,
  context: StudioHttpErrorContext = {},
): string {
  const payload = value && typeof value === 'object' ? value as StudioHttpErrorPayload : {};
  const error = nonEmptyString(payload.error);
  const code = nonEmptyString(payload.code);
  const hasCode = (expected: string) => error === expected || code === expected;

  if (hasCode('demo_expired')) return '试用已到期，请联系服务顾问开通或延长试用。';
  if (hasCode('demo_token_quota_exceeded')) {
    return '今日 Token 额度已用完，请明天再试或联系服务顾问开通更多额度。';
  }
  if (hasCode('demo_quota_exceeded')) {
    if (payload.quota === 'generation') {
      return '今日普通生成额度已用完，脚本/封面/配音等 AI 生成请明天再试或联系服务顾问开通更多额度。';
    }
    if (payload.quota === 'render') {
      return '今日成片预览额度已用完，请明天再试或联系服务顾问开通更多额度。';
    }
    if (payload.quota === 'videoGeneration') {
      return '今日视频生成额度已用完，请明天再试或联系服务顾问开通更多额度。';
    }
    return '今日试用额度已用完，请明天再试或联系服务顾问开通更多额度。';
  }

  if (hasCode('rate_limit_exceeded')) {
    const nowMs = context.nowMs ?? Date.now();
    const retrySeconds = retryAfterSeconds(payload.retryAfterSeconds, nowMs)
      ?? retryAfterSeconds(context.retryAfter, nowMs);
    return retrySeconds === null
      ? '请求过于频繁，请稍后重试。'
      : `请求过于频繁，请在 ${retrySeconds} 秒后重试。`;
  }

  return nonEmptyString(payload.message)
    || error
    || code
    || (context.status ? `请求失败（HTTP ${context.status}）` : '请求失败，请稍后重试。');
}

export async function readStudioHttpError(response: Response): Promise<string> {
  const rawBody = await response.text().catch(() => '');
  let payload: unknown = {};
  if (rawBody.trim()) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = { message: rawBody };
    }
  }
  return formatStudioHttpError(payload, {
    status: response.status,
    retryAfter: response.headers.get('Retry-After'),
  });
}

/** @deprecated Prefer formatStudioHttpError with an HTTP status/context. */
export function formatDemoQuotaError(value: unknown): string {
  return formatStudioHttpError(value);
}
