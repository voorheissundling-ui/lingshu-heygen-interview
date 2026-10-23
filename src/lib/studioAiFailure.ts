/** Keep failed AI responses unpublishable and free of stale draft content. */
export function failedAiGeneration<T>(
  path: string,
  payload: Record<string, unknown> = {},
  fallbackError = 'AI generation request failed',
): T & { source?: string } {
  const rejected = payload.source === 'ai_rejected';
  const common = {
    ok: false,
    source: rejected ? 'ai_rejected' : 'ai_failed',
    provenance: rejected ? 'ai_rejected' : 'ai_failed',
    publishable: false,
    qualityStatus: rejected ? 'rejected' : 'failed',
    error: String(payload.error || fallbackError),
    ...(payload.code ? { code: String(payload.code) } : {}),
    ...(typeof payload.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
    ...(Array.isArray(payload.validationIssues) ? { validationIssues: payload.validationIssues.map(String) } : {}),
    ...(Array.isArray(payload.validationWarnings) ? { validationWarnings: payload.validationWarnings.map(String) } : {}),
    ...(Array.isArray(payload.fieldsToConfirm) ? { fieldsToConfirm: payload.fieldsToConfirm.map(String) } : {}),
  };
  const emptyPayload: Record<string, unknown> = path === 'script'
    ? { script: '' }
    : path === 'covers'
      ? { covers: [] }
      : path === 'caption'
        ? { caption: '', hashtags: [] }
        : path === 'fb-poster'
          ? { caption: '', hashtags: [], commentCta: '', dmOpening: '', fieldsToConfirm: [], imagePrompt: '' }
          : path === 'lead-content-package'
            ? { strategySummary: '', referenceModulesUsed: [], items: [], fieldsToConfirm: [] }
            : path === 'insight'
              ? { summary: '', actions: [] }
              : path === 'select'
                ? { selectedIds: [], reason: '' }
                : {};
  return { ...emptyPayload, ...common } as unknown as T & { source?: string };
}
