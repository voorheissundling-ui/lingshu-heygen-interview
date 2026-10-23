export type DiscoverySourceFailureCode = 'model_unavailable' | 'provider_budget_exhausted' | 'provider_authorization_required' | 'downloader_missing' | 'source_media_unavailable' | 'source_rate_limited' | 'source_failed';

/** Machine classification only: never forward command lines, credentials or
 * provider response bodies to task actions, and never imply a result exists. */
export function classifyDiscoverySourceFailure(error: unknown): DiscoverySourceFailureCode {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/\b404\b.*(?:model.*(?:not.exist|not.found|unavailable)|model_not_found)|model_not_found|unsupported.model/i.test(message)) return 'model_unavailable';
  if (/not-enough-usage-to-run-paid-actor|payment.required|insufficient.(?:funds|balance|credits)|quota.exceeded.*billing|HTTP\s*402\b/i.test(message)) return 'provider_budget_exhausted';
  if (/video_downloader_not_installed|No module named\s+['"]?yt_dlp|(?:yt-dlp|yt_dlp).*?(?:ENOENT|not found)|missingDownloader/i.test(message)) return 'downloader_missing';
  if (/HTTP\s*40[13]\b|invalid.(?:token|api.?key)|unauthorized|authentication.required/i.test(message)) return 'provider_authorization_required';
  if (/HTTP\s*429\b|rate.limit|too.many.requests/i.test(message)) return 'source_rate_limited';
  if (/download.failed|video.unavailable|media.unavailable|cookie.fallback.failed|sign.in.to.confirm/i.test(message)) return 'source_media_unavailable';
  return 'source_failed';
}

/** Read historical receipts without mutating or upgrading their status. */
export function discoveryRunFailureCode(run: {error?: string | null;failureDetails?: Array<{error:string;errorCode?:string}>}): DiscoverySourceFailureCode {
  const errors = run.failureDetails?.map(item => item.error) ?? [];
  const codes = [...errors, run.error ?? ''].map(classifyDiscoverySourceFailure);
  return codes.find(code => code === 'provider_budget_exhausted') ?? codes.find(code => code !== 'source_failed') ?? 'source_failed';
}
