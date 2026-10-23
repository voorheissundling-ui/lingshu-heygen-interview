import type {
  SocialDiscoveryBrief,
  SocialDiscoveryMode,
  SocialDiscoveryModePolicy,
  SocialDiscoveryModeRunStats,
  SocialDiscoverySummary,
  SocialInspirationCollectionRun,
} from '../../shared/contracts/socialContentWorkflow.js';

export const DISCOVERY_MODES: SocialDiscoveryMode[] = ['momentum', 'account', 'innovation'];
const SUPPORTED_PLATFORMS = new Set(['linkedin', 'facebook', 'tiktok', 'instagram', 'youtube']);

const emptyStats = (): SocialDiscoveryModeRunStats => ({
  requested: 0,
  fetched: 0,
  deduplicated: 0,
  accepted: 0,
  momentumCandidates: 0,
  failed: 0,
  costCny: null,
  effectiveRate: null,
});

function finiteLimit(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.floor(parsed))) : fallback;
}

export function normalizeModePolicies(
  value: unknown,
  enabledModes: SocialDiscoveryMode[],
  fallbackLimit: number,
  fallbackPlatforms: string[] = [],
): Partial<Record<SocialDiscoveryMode, SocialDiscoveryModePolicy>> {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result: Partial<Record<SocialDiscoveryMode, SocialDiscoveryModePolicy>> = {};
  for (const mode of DISCOVERY_MODES) {
    const raw = source[mode] && typeof source[mode] === 'object' ? source[mode] as Record<string, unknown> : {};
    const sourceRefs = Array.isArray(raw.sourceRefs)
      ? [...new Set(raw.sourceRefs.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 200)
      : [];
    const configuredPlatforms = Array.isArray(raw.platforms)
      ? [...new Set(raw.platforms.map(item => String(item || '').trim().toLowerCase()).filter(item => SUPPORTED_PLATFORMS.has(item)))].slice(0, 10)
      : [];
    const platforms = configuredPlatforms.length ? configuredPlatforms : [...new Set(fallbackPlatforms.map(item => item.toLowerCase()).filter(item => SUPPORTED_PLATFORMS.has(item)))];
    result[mode] = {
      enabled: raw.enabled === undefined ? enabledModes.includes(mode) : Boolean(raw.enabled),
      sourceRefs,
      platforms,
      resultLimit: finiteLimit(raw.resultLimit, fallbackLimit, 200),
      refreshIntervalMinutes: finiteLimit(raw.refreshIntervalMinutes, 24 * 60, 30 * 24 * 60),
      budgetLimitCny: raw.budgetLimitCny === null || raw.budgetLimitCny === undefined || raw.budgetLimitCny === '' || !Number.isFinite(Number(raw.budgetLimitCny))
        ? null : Math.max(0, Number(raw.budgetLimitCny)),
    };
  }
  return result;
}

export function validateDiscoveryBrief(brief: SocialDiscoveryBrief): string[] {
  const issues: string[] = [];
  for (const mode of brief.discoveryModes) {
    const policy = brief.modePolicies?.[mode];
    if (!policy?.enabled) issues.push(`${mode}: 未启用或缺少调度配置`);
    if (!policy?.platforms.length && !brief.platforms.length) issues.push(`${mode}: 请至少配置一个采集平台`);
    if (mode === 'account' && !policy?.sourceRefs.length && !brief.competitorAccounts.length) issues.push('account: 请先确认至少一个对标账号');
  }
  return issues;
}

function runTime(run: SocialInspirationCollectionRun): number {
  const value = Date.parse(run.finishedAt || run.startedAt);
  return Number.isFinite(value) ? value : 0;
}

export function nextDiscoveryRunAt(brief: SocialDiscoveryBrief, runs: SocialInspirationCollectionRun[]): string | null {
  const nextTimes = brief.discoveryModes.flatMap(mode => {
    const policy = brief.modePolicies?.[mode];
    if (!policy?.enabled) return [];
    const latest = runs.filter(run => run.modeStats[mode]).reduce((max, run) => Math.max(max, runTime(run)), 0);
    if (!latest) return [0];
    return [latest + policy.refreshIntervalMinutes * 60_000];
  });
  if (!nextTimes.length) return null;
  const next = Math.min(...nextTimes);
  return new Date(next || Date.now()).toISOString();
}

export function dueDiscoveryModes(
  brief: SocialDiscoveryBrief,
  runs: SocialInspirationCollectionRun[],
  now = new Date(),
): SocialDiscoveryMode[] {
  const nowMs = now.getTime();
  return brief.discoveryModes.filter(mode => {
    const policy = brief.modePolicies?.[mode];
    if (!policy?.enabled) return false;
    const latest = runs.filter(run => run.modeStats[mode]).reduce((max, run) => Math.max(max, runTime(run)), 0);
    return !latest || latest + policy.refreshIntervalMinutes * 60_000 <= nowMs;
  });
}

function addStats(target: SocialDiscoveryModeRunStats, value?: SocialDiscoveryModeRunStats): void {
  if (!value) return;
  target.requested += value.requested;
  target.fetched += value.fetched;
  target.deduplicated += value.deduplicated;
  if(value.exactDuplicates!==undefined)target.exactDuplicates=(target.exactDuplicates??0)+value.exactDuplicates;
  if(value.nearDuplicates!==undefined)target.nearDuplicates=(target.nearDuplicates??0)+value.nearDuplicates;
  if(value.nearDuplicateUnchecked!==undefined)target.nearDuplicateUnchecked=(target.nearDuplicateUnchecked??0)+value.nearDuplicateUnchecked;
  if(value.analyzed!==undefined)target.analyzed=(target.analyzed??0)+value.analyzed;
  target.accepted += value.accepted;
  target.momentumCandidates += value.momentumCandidates;
  target.failed += value.failed;
  if (value.costCny !== null) target.costCny = (target.costCny ?? 0) + value.costCny;
  target.effectiveRate = target.fetched > 0 ? target.accepted / target.fetched : null;
}

export function buildDiscoverySummary(input: {
  keywordSetId: string;
  keywordSetVersion: number;
  runs: SocialInspirationCollectionRun[];
  nextRunAt?: string | null;
  pendingBusinessConfirmations?: number;
  enabledModes?: SocialDiscoveryMode[];
}): SocialDiscoverySummary {
  const byMode: SocialDiscoverySummary['byMode'] = {};
  const totals = emptyStats();
  for (const run of input.runs) {
    for (const mode of DISCOVERY_MODES) {
      const stats = run.modeStats[mode];
      if (!stats) continue;
      byMode[mode] ??= emptyStats();
      addStats(byMode[mode]!, stats);
      addStats(totals, stats);
    }
  }
  const latest = input.runs.map(run => run.finishedAt || run.startedAt).filter(Boolean).sort().at(-1) ?? null;
  const enabledModes = input.enabledModes ?? DISCOVERY_MODES;
  const coverageGaps = enabledModes.filter(mode => !byMode[mode] || byMode[mode]!.accepted === 0);
  const costStats = Object.values(byMode).filter((value): value is SocialDiscoveryModeRunStats => Boolean(value));
  return {
    keywordSetId: input.keywordSetId,
    keywordSetVersion: input.keywordSetVersion,
    runCount: input.runs.length,
    latestRunAt: latest,
    nextRunAt: input.nextRunAt ?? null,
    totals,
    byMode,
    coverageGaps,
    totalKnownCostCny: costStats.reduce((sum, value) => sum + (value.costCny ?? 0), 0),
    costComplete: costStats.length === enabledModes.length && costStats.every(value => value.costCny !== null),
    accountDecisionsPendingBusinessConfirmation: Math.max(0, input.pendingBusinessConfirmations ?? 0),
  };
}
