export interface AdReport {
  source?: string; stale?: boolean; currency: string; reportedAt?: string; dataNote?: string; reason?: string;
  window?: { since: string; until: string };
  spend: number | null; clicks: number | null; impressions: number | null;
  daily?: Array<{ date: string; spend: number | null; clicks: number | null; impressions: number | null }>;
}
export type ReportEntry = { id: string; name: string; currency: string; budget: string | number; report?: AdReport; error?: string };
// Always retain all current plans: a pending request is missing coverage, not a
// reason to shrink the denominator or report a complete period prematurely.
export function overviewEntries(tasks: Omit<ReportEntry, 'report' | 'error'>[], reports: ReportEntry[]): ReportEntry[] {
  const byId = new Map(reports.map(entry => [entry.id, entry]));
  return tasks.map(task => ({ ...task, report: byId.get(task.id)?.report, error: byId.get(task.id)?.error }));
}
export const validMetric = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export function dayRange(since: string, until: string): string[] {
  const start = Date.parse(since + 'T00:00:00Z'), end = Date.parse(until + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return [];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 365 * 86400000) return [];
  if (new Date(start).toISOString().slice(0, 10) !== since || new Date(end).toISOString().slice(0, 10) !== until) return [];
  return Array.from({ length: Math.round((end - start) / 86400000) + 1 }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}
export function overviewData(entries: ReportEntry[], currency: string, since: string, until: string) {
  const selected = entries.filter(e => e.currency === currency);
  const usable = selected.filter(e => e.report && e.report.currency === currency && ['provider', 'provider_snapshot'].includes(e.report.source || ''));
  const daily = dayRange(since, until).map(date => {
    const rows = usable.flatMap(e => (e.report?.daily || []).filter(r => r.date === date));
    const sum = (key: 'spend' | 'clicks' | 'impressions') => {
      const values = rows.map(r => r[key]).filter(validMetric);
      return values.length ? values.reduce((a, b) => a + b, 0) : null;
    };
    return { date, spend: sum('spend'), clicks: sum('clicks'), impressions: sum('impressions'), reportingTasks: usable.filter(e => e.report?.daily?.some(r => r.date === date)).length };
  });
  const total = (key: 'spend' | 'clicks' | 'impressions') => {
    const values = daily.map(r => r[key]).filter(validMetric);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const complete = selected.length > 0 && daily.length > 0 && selected.every(e => e.report?.currency === currency && e.report.source === 'provider' && !e.report.stale && dayRange(since, until).every(date => e.report?.daily?.some(r => r.date === date && validMetric(r.spend) && validMetric(r.clicks) && validMetric(r.impressions))));
  return { selected, usable, daily, spend: total('spend'), clicks: total('clicks'), impressions: total('impressions'), complete, stale: usable.some(e => e.report?.stale || e.report?.source === 'provider_snapshot') };
}
export function percentChange(current: number | null, previous: number | null, complete: boolean): string {
  if (!complete || current === null || previous === null || previous === 0) return '上期可比数据不足';
  const value = (current - previous) / previous * 100;
  return `较上期 ${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}
