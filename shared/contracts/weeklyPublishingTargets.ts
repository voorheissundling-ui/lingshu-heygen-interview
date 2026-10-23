export const WEEKLY_PUBLISHING_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin'] as const;
export type WeeklyPublishingPlatform = (typeof WEEKLY_PUBLISHING_PLATFORMS)[number];

export interface WeeklyPublishingTargetLike {
  platform: WeeklyPublishingPlatform;
  accountId: string;
  weeklyCount?: number;
}

export const MAX_WEEKLY_PUBLISHING_ITEMS = 30;

function normalizedCount(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(MAX_WEEKLY_PUBLISHING_ITEMS, Math.max(0, Math.floor(parsed)));
}

/**
 * Reads the legacy human-readable cadence format. This is a migration bridge;
 * new planning code must consume the structured weeklyCount on each target.
 */
export function platformWeeklyCountsFromCadence(value: unknown): Partial<Record<WeeklyPublishingPlatform, number>> {
  const cadence = String(value || '');
  return Object.fromEntries(WEEKLY_PUBLISHING_PLATFORMS.flatMap(platform => {
    const match = cadence.match(new RegExp(`${platform}\\s*=\\s*(\\d+)`, 'i'));
    const count = normalizedCount(match?.[1]);
    return count === undefined ? [] : [[platform, count]];
  })) as Partial<Record<WeeklyPublishingPlatform, number>>;
}

/**
 * A settings field describes a platform total. Split that total stably across
 * the selected accounts so the account matrix has one unambiguous quota source.
 */
export function allocateWeeklyPublishingTargets<T extends WeeklyPublishingTargetLike>(
  targets: T[],
  platformCounts: Partial<Record<WeeklyPublishingPlatform, number>>,
): Array<T & { weeklyCount: number }> {
  const result: Array<T & { weeklyCount: number }> = [];
  for (const platform of WEEKLY_PUBLISHING_PLATFORMS) {
    const platformTargets = targets.filter(target => target.platform === platform);
    if (!platformTargets.length) continue;
    const requestedTotal = normalizedCount(platformCounts[platform]);
    const existingCounts = platformTargets.map(target => normalizedCount(target.weeklyCount));
    const total = requestedTotal ?? (existingCounts.every(count => count !== undefined)
      ? existingCounts.reduce((sum, count) => sum + (count || 0), 0)
      : undefined);
    if (total === undefined) {
      result.push(...platformTargets.map(target => ({ ...target, weeklyCount: normalizedCount(target.weeklyCount) || 0 })));
      continue;
    }
    const base = Math.floor(total / platformTargets.length);
    const remainder = total % platformTargets.length;
    result.push(...platformTargets.map((target, index) => ({
      ...target,
      weeklyCount: base + (index < remainder ? 1 : 0),
    })));
  }
  return result;
}

/** Preserve legacy defaults unless the persisted cadence contains explicit per-platform totals. */
export function hydrateWeeklyPublishingTargets<T extends WeeklyPublishingTargetLike>(targets: T[], cadence: unknown): T[] {
  const counts = platformWeeklyCountsFromCadence(cadence);
  const hydrated: T[] = [];
  for (const platform of WEEKLY_PUBLISHING_PLATFORMS) {
    const platformTargets = targets.filter(target => target.platform === platform);
    if (!platformTargets.length) continue;
    if (platformTargets.some(target => normalizedCount(target.weeklyCount) !== undefined)) {
      hydrated.push(...platformTargets.map(target => ({
        ...target,
        ...(normalizedCount(target.weeklyCount) !== undefined ? { weeklyCount: normalizedCount(target.weeklyCount) } : { weeklyCount: 0 }),
      })));
      continue;
    }
    if (counts[platform] === undefined) {
      hydrated.push(...platformTargets);
      continue;
    }
    hydrated.push(...allocateWeeklyPublishingTargets(platformTargets, counts));
  }
  return hydrated;
}

export function weeklyPublishingPlatforms(targets: WeeklyPublishingTargetLike[], cadence?: unknown): WeeklyPublishingPlatform[] {
  const legacyCounts = platformWeeklyCountsFromCadence(cadence);
  return WEEKLY_PUBLISHING_PLATFORMS.filter(platform => {
    const platformTargets = targets.filter(target => target.platform === platform);
    if (!platformTargets.length) return false;
    const structuredCounts = platformTargets
      .map(target => normalizedCount(target.weeklyCount))
      .filter((count): count is number => count !== undefined);
    if (structuredCounts.length) return structuredCounts.reduce((sum, count) => sum + count, 0) > 0;
    if (legacyCounts[platform] !== undefined) return legacyCounts[platform]! > 0;
    return true;
  });
}
