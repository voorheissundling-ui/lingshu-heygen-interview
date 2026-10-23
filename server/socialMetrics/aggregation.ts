export const SOCIAL_METRIC_KEYS = [
  'views', 'reach', 'likes', 'comments', 'shares', 'saves',
  'watchTimeMinutes', 'averageViewDurationSeconds', 'averageViewPercentage',
  'followers', 'subscribers', 'profileViews', 'postsPublished',
] as const;

export type SocialMetricKey = typeof SOCIAL_METRIC_KEYS[number];
export type MetricValues = Partial<Record<SocialMetricKey, number>>;

export interface MetricSnapshot {
  id?: string;
  platform: string;
  accountId: string;
  contentId?: string;
  capturedAt: string;
  valueKind?: 'cumulative' | 'daily';
  metrics: MetricValues;
}

export interface MetricTrend {
  key: SocialMetricKey;
  available: boolean;
  current: number | null;
  previous: number | null;
  change: number | null;
  changeRate: number | null;
  reason?: 'no_data' | 'insufficient_history' | 'previous_period_zero';
}

const DAY_MS = 86_400_000;

export function normalizeMetricValues(value: unknown): MetricValues {
  const source = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return {}; } })() : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const result: MetricValues = {};
  for (const key of SOCIAL_METRIC_KEYS) {
    const raw = (source as Record<string, unknown>)[key];
    // Only provider-reported numbers or nonempty numeric strings are evidence.
    // Number(null), Number('') and Number(false) would manufacture zeroes.
    if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) continue;
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  return result;
}

function entityKey(snapshot: MetricSnapshot): string {
  return `${snapshot.platform}:${snapshot.accountId}:${snapshot.contentId || '@account'}`;
}

function utcDay(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

/**
 * Normalized daily increments. Daily interval values are summed as reported;
 * cumulative counters are differenced per entity before cross-platform sums.
 * A cumulative entity's first observation is a baseline, not fabricated traffic.
 */
export function buildDailyTotals(snapshots: MetricSnapshot[], key: SocialMetricKey): Array<{ date: string; value: number }> {
  const valid = snapshots
    .filter(item => typeof item.metrics[key] === 'number' && utcDay(item.capturedAt))
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  // Content counters and account counters often describe the same traffic. Pick
  // a granularity independently for every platform account: one account having
  // content snapshots must not hide account-only snapshots from another source.
  const groupsWithContent = new Set(
    valid.filter(item => Boolean(item.contentId)).map(item => `${item.platform}:${item.accountId}`),
  );
  const selected = valid.filter(item => {
    const prefersContent = groupsWithContent.has(`${item.platform}:${item.accountId}`);
    return prefersContent ? Boolean(item.contentId) : !item.contentId;
  });
  const byDayEntity = new Map<string, MetricSnapshot>();
  for (const snapshot of selected) byDayEntity.set(`${utcDay(snapshot.capturedAt)}:${entityKey(snapshot)}`, snapshot);
  const totals = new Map<string, number>();
  const byEntity = new Map<string, MetricSnapshot[]>();
  for (const snapshot of byDayEntity.values()) {
    const group = byEntity.get(entityKey(snapshot)) || [];
    group.push(snapshot);
    byEntity.set(entityKey(snapshot), group);
  }
  for (const entitySnapshots of byEntity.values()) {
    entitySnapshots.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    for (let index = 0; index < entitySnapshots.length; index += 1) {
      const snapshot = entitySnapshots[index];
      const date = utcDay(snapshot.capturedAt);
      if ((snapshot.valueKind || 'cumulative') === 'daily') {
        totals.set(date, (totals.get(date) || 0) + (snapshot.metrics[key] || 0));
        continue;
      }
      const previous = entitySnapshots[index - 1];
      if (!previous || (previous.valueKind || 'cumulative') !== 'cumulative') continue;
      const delta = Math.max(0, (snapshot.metrics[key] || 0) - (previous.metrics[key] || 0));
      totals.set(date, (totals.get(date) || 0) + delta);
    }
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

function periodTotal(points: Array<{ date: string; value: number }>, from: number, to: number): number | null {
  const eligible = points.filter(point => {
    const time = Date.parse(`${point.date}T00:00:00.000Z`);
    return time > from && time <= to;
  });
  return eligible.length ? eligible.reduce((sum, point) => sum + point.value, 0) : null;
}

export function buildMetricTrend(
  snapshots: MetricSnapshot[],
  key: SocialMetricKey,
  days: number,
  now = new Date(),
): MetricTrend {
  const points = buildDailyTotals(snapshots, key);
  if (!points.length) return { key, available: false, current: null, previous: null, change: null, changeRate: null, reason: 'no_data' };
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const currentStart = end - days * DAY_MS;
  const previousStart = currentStart - days * DAY_MS;
  const current = periodTotal(points, currentStart, end);
  const previous = periodTotal(points, previousStart, currentStart);
  if (current === null || previous === null) {
    return { key, available: false, current, previous, change: null, changeRate: null, reason: 'insufficient_history' };
  }
  const change = current - previous;
  return {
    key,
    available: true,
    current,
    previous,
    change,
    changeRate: previous > 0 ? change / previous : null,
    ...(previous === 0 ? { reason: 'previous_period_zero' as const } : {}),
  };
}

export function currentMetricTotal(snapshots: MetricSnapshot[], key: SocialMetricKey): number | null {
  const valid = snapshots.filter(item => typeof item.metrics[key] === 'number');
  if (!valid.length) return null;
  const groups = new Map<string, MetricSnapshot[]>();
  for (const item of valid) {
    const groupKey = `${item.platform}:${item.accountId}`;
    const group = groups.get(groupKey) || [];
    group.push(item);
    groups.set(groupKey, group);
  }
  let total = 0;
  for (const group of groups.values()) {
    const contentAvailable = group.some(item => Boolean(item.contentId));
    const selected = group.filter(item => contentAvailable ? Boolean(item.contentId) : !item.contentId);
    const entities = new Map<string, MetricSnapshot[]>();
    for (const item of selected) entities.set(entityKey(item), [...(entities.get(entityKey(item)) || []), item]);
    for (const entity of entities.values()) {
      entity.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
      total += entity[0].metrics[key] || 0;
    }
  }
  return total;
}
