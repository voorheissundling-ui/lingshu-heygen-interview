import { authHeader } from './auth';
import { readStudioHttpError } from './studioQuotaMessage';
import { failedAiGeneration } from './studioAiFailure';

const VERIFIED_AI_GENERATION_PATHS = new Set([
  'script',
  'covers',
  'caption',
  'fb-poster',
  'lead-content-package',
  'insight',
  'select',
]);

export async function post<T>(path: string, body: unknown, fallback: T, signal?: AbortSignal): Promise<T & { source?: string }> {
  const retryablePaths = new Set(['script', 'translate', 'translate/batch', 'tts', 'tts/batch']);
  const maxAttempts = path === 'script' ? 4 : retryablePaths.has(path) ? 2 : 1;
  let lastError = 'request_failed';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const r = await fetch(`/api/overseas/studio/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify(body),
        signal,
      });
      if (r.status === 402 || r.status === 429) {
        throw new Error(await readStudioHttpError(r));
      }
      if (!r.ok) {
        const payload = await r.json().catch(() => ({})) as Record<string, unknown> & { error?: string; source?: string; code?: string; retryable?: boolean };
        // Project conflicts carry diagnostics and a server snapshot. Keep them
        // structured, but never advance the client's revision on a rejected save.
        if (path === 'projects') return { ...fallback, ...payload, ok: false } as T & { source?: string };
        if (path === 'fb-poster/render' && payload.code?.startsWith('social_image_')) {
          return { ...fallback, ...payload, ok: false } as T & { source?: string };
        }
        // Quality and fact gates are expected structured responses. Keep their
        // diagnostics, but never merge them with a local/previous draft.
        if (VERIFIED_AI_GENERATION_PATHS.has(path) && r.status === 422) {
          if (path === 'script' && typeof payload.script === 'string') {
            return {
              ...payload,
              ok: false,
              source: payload.source || 'ai_rejected',
              provenance: 'ai_rejected',
              publishable: false,
              qualityStatus: 'rejected',
            } as unknown as T & { source?: string };
          }
          return failedAiGeneration<T>(path, { ...payload, source: payload.source || 'ai_rejected' });
        }
        if (payload.retryable === false || /UPSTREAM_(QUOTA|AUTH)/.test(payload.code || '')
          || /额度不足|额度已|授权暂不可用/.test(payload.error || '')) {
          if (VERIFIED_AI_GENERATION_PATHS.has(path)) return failedAiGeneration<T>(path, payload);
          return { ...fallback, ...payload } as T & { source?: string };
        }
        const message = payload.error || `HTTP ${r.status}`;
        if ([502, 503, 504].includes(r.status) && attempt < maxAttempts) {
          await new Promise(resolve => window.setTimeout(resolve, [0, 2000, 5000, 10000][attempt] || 10000));
          continue;
        }
        throw Object.assign(new Error(message), { status: r.status, payload });
      }
      const payload = await r.json() as T & { source?: string; ok?: boolean; error?: string };
      if (VERIFIED_AI_GENERATION_PATHS.has(path) && (payload.ok !== true || payload.source !== 'ai')) {
        return failedAiGeneration<T>(path, payload as Record<string, unknown>, payload.error || '服务端未返回可验证的 AI 生成结果');
      }
      return payload;
    } catch (err: any) {
      const message = String(err?.message || '');
      if (message.includes('Demo') || message.includes('试用') || message.includes('额度') || message.includes('到期')) throw err;
      if (signal?.aborted) throw err;
      lastError = message || 'request_failed';
      const transientNetworkError = /fetch|network|failed|load|eof|502|503|504/i.test(lastError);
      if (retryablePaths.has(path) && transientNetworkError && attempt < maxAttempts) {
        await new Promise(resolve => window.setTimeout(resolve, [0, 2000, 5000, 10000][attempt] || 10000));
        continue;
      }
      break;
    }
  }
  if (VERIFIED_AI_GENERATION_PATHS.has(path)) return failedAiGeneration<T>(path, {}, lastError);
  return { ...fallback, source: 'local', error: lastError };
}
