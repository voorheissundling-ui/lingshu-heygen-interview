import type { SocialCandidateEvidence, SocialDiscoveryMode, SocialInspirationCollectionRun } from '../../shared/contracts/socialContentWorkflow.js';

export type Unknown<T> = T | 'unknown';

export interface DiscoveryQuotaPolicy {
  totalAcceptedTarget: number;
  innovationShare: number;
  accountShare?: number;
  enabledModes?: SocialDiscoveryMode[];
  minimumPerCoreMode?: number;
}

export interface DiscoveryQuotaPlan {
  windowStartedAt: string;
  acceptedByMode: Record<SocialDiscoveryMode, number>;
  remainingByMode: Record<SocialDiscoveryMode, number>;
  targetByMode: Record<SocialDiscoveryMode, number>;
  innovationExperimentShare: number;
  acceptedCandidateIdsByMode: Record<SocialDiscoveryMode, string[]>;
}

const MODES: SocialDiscoveryMode[] = ['momentum', 'account', 'innovation'];

function boundedInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Allocate from accepted inventory in a rolling seven-day window, never raw fetched rows. */
export function planRollingSevenDayQuotas(
  runs: SocialInspirationCollectionRun[],
  policy: DiscoveryQuotaPolicy,
  now = new Date(),
): DiscoveryQuotaPlan {
  if (!Number.isFinite(policy.innovationShare) || policy.innovationShare < 0.1 || policy.innovationShare > 0.2) {
    throw new Error('innovation_share_out_of_experiment_bounds');
  }
  const enabledModes = new Set(policy.enabledModes === undefined ? MODES : policy.enabledModes);
  const accountShare = policy.accountShare ?? 1;
  if (!Number.isFinite(accountShare) || accountShare < 0 || accountShare > 1
    || (enabledModes.has('innovation') && accountShare > 1 - policy.innovationShare)) {
    throw new Error('account_share_out_of_bounds');
  }
  const total = Math.max(1, boundedInteger(policy.totalAcceptedTarget));
  const innovationTarget = enabledModes.has('innovation') ? Math.floor(total * policy.innovationShare) : 0;
  const coreTotal = total - innovationTarget;
  const minimum = Math.min(Math.floor(coreTotal / 2), boundedInteger(policy.minimumPerCoreMode ?? 0));
  const accountEnabled = enabledModes.has('account');
  const momentumEnabled = enabledModes.has('momentum');
  const accountTarget = accountEnabled
    ? momentumEnabled
      ? Math.max(minimum, Math.min(coreTotal - minimum, Math.round(total * accountShare)))
      : coreTotal
    : 0;
  const targets: Record<SocialDiscoveryMode, number> = {
    momentum: momentumEnabled ? coreTotal - accountTarget : 0,
    account: accountTarget,
    innovation: enabledModes.has('innovation') && !accountEnabled && !momentumEnabled ? total : innovationTarget,
  };
  const windowStartMs = now.getTime() - 7 * 86_400_000;
  const accepted = { momentum: 0, account: 0, innovation: 0 };
  const acceptedIds: Record<SocialDiscoveryMode, Set<string>> = {
    momentum: new Set(), account: new Set(), innovation: new Set(),
  };
  for (const run of runs) {
    const timestamp = Date.parse(run.finishedAt || run.startedAt);
    if (!Number.isFinite(timestamp) || timestamp < windowStartMs || timestamp > now.getTime()) continue;
    for (const mode of MODES) {
      const ids = run.evidenceOutcomes?.[mode]?.acceptedCandidateIds;
      if (ids) ids.filter(Boolean).forEach(id => acceptedIds[mode].add(id));
      else accepted[mode] += boundedInteger(run.modeStats[mode]?.accepted ?? 0);
    }
  }
  for (const mode of MODES) accepted[mode] += acceptedIds[mode].size;
  return {
    windowStartedAt: new Date(windowStartMs).toISOString(),
    acceptedByMode: accepted,
    targetByMode: targets,
    remainingByMode: Object.fromEntries(MODES.map(mode => [mode, Math.max(0, targets[mode] - accepted[mode])])) as Record<SocialDiscoveryMode, number>,
    innovationExperimentShare: policy.innovationShare,
    acceptedCandidateIdsByMode: Object.fromEntries(MODES.map(mode => [mode, [...acceptedIds[mode]]])) as Record<SocialDiscoveryMode, string[]>,
  };
}

export interface PerformanceSnapshot {
  observedAt: string;
  value: number | null;
}

export interface MomentumAssessment {
  level: 'rising' | 'high_performance' | 'unknown';
  relativeToAccountBaseline: number | 'unknown';
  consecutiveSnapshotGrowth: boolean | 'unknown';
  reasons: string[];
}

/** A single observation can be high-performing, but only two consecutive increases can be rising. */
export function assessAccountRelativeMomentum(input: {
  currentPerformance: number | null | undefined;
  accountPlatformBaseline: number | null | undefined;
  snapshots?: PerformanceSnapshot[];
  threshold?: number;
}): MomentumAssessment {
  const current = input.currentPerformance;
  const baseline = input.accountPlatformBaseline;
  const relative = typeof current === 'number' && Number.isFinite(current) && current >= 0
    && typeof baseline === 'number' && Number.isFinite(baseline) && baseline > 0 ? current / baseline : 'unknown';
  const ordered = (input.snapshots ?? [])
    .filter((item): item is PerformanceSnapshot & { value: number } => typeof item.value === 'number' && Number.isFinite(item.value) && Number.isFinite(Date.parse(item.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const growth = ordered.length < 3
    ? 'unknown'
    : ordered.slice(-3).every((item, index, values) => index === 0 || item.value > values[index - 1]!.value);
  const above = relative !== 'unknown' && relative >= (input.threshold ?? 1.5);
  return {
    level: above && growth === true ? 'rising' : above ? 'high_performance' : 'unknown',
    relativeToAccountBaseline: relative,
    consecutiveSnapshotGrowth: growth,
    reasons: [
      relative === 'unknown' ? '缺少同账号同平台基线' : `相对同账号基线 ${relative.toFixed(2)} 倍`,
      growth === 'unknown' ? '连续快照不足' : growth ? '连续三次快照增长' : '快照未呈连续增长',
    ],
  };
}

export type InnovationEvidence =
  | { kind: 'adjacent_industry'; businessAnchor: string | null; independentSourceRefs: string[]; userConfirmed: boolean }
  | { kind: 'comment_question'; commentRefs: string[]; contentRefs: string[] };

export function evaluateInnovationGate(evidence: InnovationEvidence): { qualified: boolean; status: 'accepted' | 'suggestion'; reasons: string[] } {
  const unique = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
  if (evidence.kind === 'adjacent_industry') {
    const sources = unique(evidence.independentSourceRefs);
    const qualified = Boolean(evidence.businessAnchor?.trim()) && (sources.length >= 2 || evidence.userConfirmed);
    return { qualified, status: qualified ? 'accepted' : 'suggestion', reasons: qualified
      ? ['有业务锚点，且获得两个独立来源或用户确认']
      : ['相邻行业迁移需要业务锚点及两个独立来源，或用户确认'] };
  }
  const qualified = unique(evidence.commentRefs).length >= 3 && unique(evidence.contentRefs).length >= 2;
  return { qualified, status: qualified ? 'accepted' : 'suggestion', reasons: qualified
    ? ['至少三条评论问题且跨两条内容']
    : ['评论扩展需要至少三条评论问题且跨两条内容'] };
}

export interface CandidateG1 {
  runId: string;
  queryRef: string;
  discoveryMode: SocialDiscoveryMode;
  sourceType: Unknown<'account' | 'keyword' | 'comment' | 'adjacent_industry'>;
  sourceUrl: Unknown<string>;
  observedAt: Unknown<string>;
  publishedAt: Unknown<string>;
  followerCount: Unknown<number>;
  commentText: Unknown<string>;
  missingFields: string[];
}

export function buildCandidateG1(input: Partial<CandidateG1> & Pick<CandidateG1, 'runId' | 'queryRef' | 'discoveryMode'>): CandidateG1 {
  const unknown = <T>(value: T | null | undefined | ''): Unknown<T> => value === null || value === undefined || value === '' ? 'unknown' : value;
  const result: CandidateG1 = {
    runId: input.runId,
    queryRef: input.queryRef,
    discoveryMode: input.discoveryMode,
    sourceType: unknown(input.sourceType),
    sourceUrl: unknown(input.sourceUrl),
    observedAt: unknown(input.observedAt),
    publishedAt: unknown(input.publishedAt),
    followerCount: unknown(input.followerCount),
    commentText: unknown(input.commentText),
    missingFields: [],
  };
  result.missingFields = (['sourceType', 'sourceUrl', 'observedAt', 'publishedAt', 'followerCount', 'commentText'] as const)
    .filter(field => result[field] === 'unknown');
  return result;
}

export interface VersionedCandidateEvidence {
  evidenceId: string;
  version: number;
  tenantId: string;
  candidateId: string;
  inputFingerprint: string;
  evidence: SocialCandidateEvidence;
  g1: CandidateG1;
  completeness: 'complete' | 'partial' | 'unknown';
  createdAt: string;
  supersedesEvidenceId: string | null;
}

/** Stable evidence may recommend tracking, but never performs long-term promotion. */
export function recommendAccountTracking(input: {
  evidenceVideoIds: string[];
  consecutiveQualifiedWindows: number;
  minimumVideos?: number;
  minimumWindows?: number;
}): { decision: 'track' | 'watch'; resultingStatus: 'trial' | 'watching'; businessConfirmationRequired: boolean; reasons: string[] } {
  const videos = [...new Set(input.evidenceVideoIds.filter(Boolean))];
  const qualified = videos.length >= (input.minimumVideos ?? 3)
    && input.consecutiveQualifiedWindows >= (input.minimumWindows ?? 2);
  return qualified
    ? { decision: 'track', resultingStatus: 'trial', businessConfirmationRequired: true, reasons: ['持续证据达到长期对标建议门槛，等待经营确认'] }
    : { decision: 'watch', resultingStatus: 'watching', businessConfirmationRequired: false, reasons: ['稳定性证据不足，保持观察'] };
}
