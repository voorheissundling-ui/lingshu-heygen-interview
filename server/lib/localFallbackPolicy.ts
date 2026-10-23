/**
 * Local JSON/auth fallbacks are an explicit demo/test capability.
 *
 * Historically every non-production process enabled them implicitly. That made
 * a healthy, empty PocketBase tenant indistinguishable from a seeded demo and
 * could also hide database outages. Keep the legacy flag as an explicit opt-in
 * for existing isolated tests, but default normal development to fail closed.
 */
export function localFallbacksEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.ENABLE_LOCAL_DEV_FALLBACK === 'true') return true;
  return process.env.DISABLE_LOCAL_AUTH_FALLBACK === 'false';
}
