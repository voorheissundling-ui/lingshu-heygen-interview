import type { AutonomyMode, DigitalEmployeeConfig } from './domain.js';

export type DigitalEmployeeAgent = 'business' | 'industry' | 'content' | 'customer';

export interface SocialCadencePolicy {
  raw: string;
  platforms: Array<'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'linkedin'>;
  time: string;
  lookbackDays: number;
  maxItems: number;
  dedupeDays: number;
  draftsPerWeek: number;
}

export interface FollowupCadencePolicy {
  raw: string;
  draftWeekday: number;
  draftTime: string;
  approveBy: string;
  localSendWindow: { start: string; end: string };
  minContactGapDays: number;
}

export interface ReviewCadencePolicy {
  raw: string;
  weekday: number;
  time: string;
  cutoff: string;
  timeZone: string;
}

export interface EffectiveRuntimePolicy {
  schemaVersion: 1;
  autonomy: {
    mode: AutonomyMode;
    allowInternalExecution: boolean;
    allowDraftCreation: boolean;
    allowScheduling: boolean;
    allowExternalPublish: boolean;
    allowExternalSend: boolean;
  };
  agents: {
    business: {
      approvals: { activatePlan: boolean; changeGoalScope: boolean };
      review: ReviewCadencePolicy;
    };
    industry: {
      approvals: { addUnverifiedSource: boolean; expandCollectionScope: boolean };
      collection: SocialCadencePolicy;
    };
    content: {
      approvals: { contentPublish: boolean; factualClaims: boolean };
      publishDraftsPerWeek: number;
    };
    customer: {
      approvals: { batchFollowup: boolean; commercialCommitment: true };
      followup: FollowupCadencePolicy;
    };
  };
  constraints: string[];
}

const clean = (value: unknown, max = 1000): string => String(value ?? '').trim().slice(0, max);

function numberFrom(raw: string, pattern: RegExp, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(raw.match(pattern)?.[1]);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function timeFrom(raw: string, pattern: RegExp, fallback: string): string {
  const result = raw.match(pattern);
  if (!result) return fallback;
  const hour = Math.min(23, Math.max(0, Number(result[1])));
  const minute = Math.min(59, Math.max(0, Number(result[2] || 0)));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function weekdayFrom(raw: string, fallback: number): number {
  const match = raw.match(/(?:周|星期)([一二三四五六日天])/);
  if (!match) return fallback;
  return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 } as Record<string, number>)[match[1]] ?? fallback;
}

export function parseSocialCadence(value: unknown): SocialCadencePolicy {
  const raw = clean(value);
  const platforms: SocialCadencePolicy['platforms'] = [];
  for (const [pattern, platform] of [
    [/linkedin|linked\s*in/i, 'linkedin'], [/facebook/i, 'facebook'], [/youtube/i, 'youtube'], [/tiktok/i, 'tiktok'], [/instagram/i, 'instagram'],
  ] as const) {
    if (pattern.test(raw)) platforms.push(platform);
  }
  return {
    raw,
    platforms,
    time: timeFrom(raw, /(?:每天|采集时间[^\d]*)?(\d{1,2})(?::|：)(\d{2})/, '09:00'),
    lookbackDays: numberFrom(raw, /(?:近|回看)\s*(\d+)\s*天/, 7, 1, 90),
    maxItems: numberFrom(raw, /每次(?:最多)?\s*(\d+)\s*条/, 20, 1, 500),
    dedupeDays: numberFrom(raw, /去重\s*(\d+)\s*天/, 30, 1, 365),
    draftsPerWeek: numberFrom(raw, /每周(?:生成|发布)?\s*(\d+)\s*条/, 5, 0, 100),
  };
}

export function parseFollowupCadence(value: unknown): FollowupCadencePolicy {
  const raw = clean(value, 500);
  const windowMatch = raw.match(/(?:工作日\s*)?(\d{1,2})(?::|：)(\d{2})\s*[–—~-]\s*(\d{1,2})(?::|：)(\d{2})/);
  return {
    raw,
    draftWeekday: weekdayFrom(raw, 5),
    draftTime: timeFrom(raw, /(?:周|星期)[一二三四五六日天]\s*(\d{1,2})(?::|：)(\d{2})/, '09:00'),
    approveBy: timeFrom(raw, /(\d{1,2})(?::|：)(\d{2})\s*前审批/, '17:00'),
    localSendWindow: windowMatch
      ? {
        start: `${String(Math.min(23, Number(windowMatch[1]))).padStart(2, '0')}:${windowMatch[2]}`,
        end: `${String(Math.min(23, Number(windowMatch[3]))).padStart(2, '0')}:${windowMatch[4]}`,
      }
      : { start: '09:00', end: '18:00' },
    minContactGapDays: numberFrom(raw, /同一客户\s*(\d+)\s*天/, 7, 1, 90),
  };
}

export function parseReviewSchedule(value: unknown): ReviewCadencePolicy {
  const raw = clean(value, 300);
  const timeZoneMatch = raw.match(/[（(]([^）)]+)[）)]/);
  return {
    raw,
    weekday: weekdayFrom(raw, 5),
    time: timeFrom(raw, /(?:周|星期)[一二三四五六日天]\s*(\d{1,2})(?::|：)(\d{2})/, '17:30'),
    cutoff: timeFrom(raw, /数据截止\s*(\d{1,2})(?::|：)(\d{2})/, '17:00'),
    timeZone: clean(timeZoneMatch?.[1], 80) || 'Asia/Shanghai',
  };
}

function autonomyPolicy(mode: AutonomyMode): EffectiveRuntimePolicy['autonomy'] {
  return {
    mode,
    // "Suggest" means analysis-only: reading facts and producing internal
    // analysis is safe, while every write-like effect remains disabled.
    allowInternalExecution: true,
    allowDraftCreation: mode !== 'suggest',
    allowScheduling: mode === 'managed' || mode === 'automatic',
    // These flags describe autonomy eligibility only. Agent redlines below can
    // still require approval and always win over the autonomy level.
    allowExternalPublish: mode === 'automatic',
    allowExternalSend: mode === 'automatic',
  };
}

export function resolveRuntimePolicy(config: DigitalEmployeeConfig): EffectiveRuntimePolicy {
  const social = parseSocialCadence(config.socialCadence);
  return {
    schemaVersion: 1,
    autonomy: autonomyPolicy(config.autonomyMode),
    agents: {
      business: {
        approvals: { ...config.agentApprovalPolicies.business },
        review: parseReviewSchedule(config.reviewSchedule),
      },
      industry: {
        approvals: { ...config.agentApprovalPolicies.industry },
        collection: social,
      },
      content: {
        approvals: { ...config.agentApprovalPolicies.content, contentPublish: true },
        publishDraftsPerWeek: social.draftsPerWeek,
      },
      customer: {
        approvals: { batchFollowup: true, commercialCommitment: true },
        followup: parseFollowupCadence(config.followupCadence),
      },
    },
    constraints: [...config.constraints],
  };
}

export function approvalRequiredFor(policy: EffectiveRuntimePolicy, agent: DigitalEmployeeAgent, action: string): boolean {
  const approvals = policy.agents[agent].approvals as Record<string, boolean>;
  return approvals[action] !== false;
}

export function automaticExecutionAllowed(
  policy: EffectiveRuntimePolicy,
  effect: 'none' | 'draft' | 'schedule' | 'publish' | 'send',
): boolean {
  if (effect === 'none') return policy.autonomy.allowInternalExecution;
  if (effect === 'draft') return policy.autonomy.allowDraftCreation;
  if (effect === 'schedule') return policy.autonomy.allowScheduling;
  if (effect === 'publish') return policy.autonomy.allowExternalPublish && !policy.agents.content.approvals.contentPublish;
  return policy.autonomy.allowExternalSend && !policy.agents.customer.approvals.batchFollowup;
}
