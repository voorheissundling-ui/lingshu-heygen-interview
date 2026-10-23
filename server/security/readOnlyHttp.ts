import type { Request } from 'express';

export interface SideEffectingReadRule {
  /** Stable audit identifier; do not reuse it for a different route. */
  id: string;
  path: RegExp;
  /** Every listed query value must match for the rule to apply. */
  query?: Readonly<Record<string, string>>;
}

/**
 * Explicit deny registry for GET/HEAD handlers that are not genuinely read-only.
 *
 * Keep this list narrow: remote reads and ordinary projections stay readable,
 * while handlers that persist/lease data, generate paid AI output, or force a
 * refresh are denied to support and browser-read sessions before route logic.
 */
export const SIDE_EFFECTING_READ_RULES: readonly SideEffectingReadRule[] = [
  { id: 'digital_employee_browser_stream', path: /\/runs\/[^/]+\/tasks\/[^/]+\/browser-stream\/?$/i },
  { id: 'agent_memory_backup_audit', path: /\/agent-memory\/backup\/?$/i },
  { id: 'social_insights_snapshot', path: /\/social\/accounts\/[^/]+\/insights\/?$/i },
  { id: 'social_video_snapshot', path: /\/social\/accounts\/[^/]+\/videos\/?$/i },
  { id: 'youtube_analytics_snapshot', path: /\/youtube\/accounts\/[^/]+\/analytics\/?$/i },
  { id: 'studio_cloud_poster_generation', path: /\/studio\/materials\/pb\/[^/]+\/poster\/?$/i },
  { id: 'studio_bgm_signed_url_generation', path: /\/studio\/bgm\/?$/i },
  { id: 'video_thumbnail_generation', path: /\/videos\/[^/]+\/thumbnail\/?$/i },
  { id: 'customer_ai_suggestions', path: /\/customers\/[^/]+\/suggestions\/?$/i },
  {
    id: 'forced_business_dynamics_refresh',
    path: /\/scheduler\/business-dynamics\/?$/i,
    query: { refresh: '1' },
  },
  { id: 'crawl_worker_job_lease', path: /\/crawl-worker\/next\/?$/i },
  { id: 'social_oauth_callback_write', path: /\/social\/oauth\/[^/]+\/callback\/?$/i },
  { id: 'youtube_oauth_callback_write', path: /\/youtube\/oauth\/callback\/?$/i },
];

export function isSideEffectingReadPath(req: Pick<Request, 'originalUrl' | 'url'>): boolean {
  const requestUrl = new URL(req.originalUrl || req.url, 'http://local');
  return SIDE_EFFECTING_READ_RULES.some(rule => (
    rule.path.test(requestUrl.pathname)
    && (!rule.query || Object.entries(rule.query).every(([key, value]) => (
      requestUrl.searchParams.get(key) === value
    )))
  ));
}
