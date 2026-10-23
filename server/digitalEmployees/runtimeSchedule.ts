import {
  parseFollowupCadence,
  parseReviewSchedule,
  parseSocialCadence,
  type FollowupCadencePolicy,
  type ReviewCadencePolicy,
  type SocialCadencePolicy,
} from './runtimePolicy.js';

export interface SocialCadenceSchedule {
  cronExpr: string;
  cronLabel: string;
  platforms: string[];
  limit: number;
  dateWindowDays: number;
  dedupeWindowDays: number;
}

export interface ReviewCadenceSchedule {
  weekday: number | null;
  hour: number;
  minute: number;
  timezone: 'Asia/Shanghai';
  label: string;
}

export interface FollowupCadenceSchedule {
  draft: ReviewCadenceSchedule;
  approvalDeadlineHour: number;
  workdaysOnly: boolean;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  contactWindowDays: number;
  maxContactsPerWindow: number;
}

function timeParts(value: string, fallback: { hour: number; minute: number }): { hour: number; minute: number } {
  const [hourText, minuteText] = String(value || '').split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59
    ? { hour, minute }
    : fallback;
}

/** Adapt the canonical runtime policy to node-cron's structured contract. */
export function socialScheduleFromPolicy(policy: SocialCadencePolicy): SocialCadenceSchedule {
  const { hour, minute } = timeParts(policy.time, { hour: 9, minute: 0 });
  return {
    cronExpr: `${minute} ${hour} * * *`,
    cronLabel: `每天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}（北京时间）`,
    platforms: policy.platforms.length ? [...new Set(policy.platforms)] : ['youtube'],
    limit: Math.max(1, Math.min(50, policy.maxItems)),
    dateWindowDays: Math.max(1, Math.min(30, policy.lookbackDays)),
    dedupeWindowDays: Math.max(1, Math.min(365, policy.dedupeDays)),
  };
}

export function socialScheduleFromCadence(value: string): SocialCadenceSchedule {
  return socialScheduleFromPolicy(parseSocialCadence(value));
}

export function reviewScheduleFromPolicy(policy: ReviewCadencePolicy): ReviewCadenceSchedule | null {
  if (!/(?:周|星期)[一二三四五六日天]/.test(policy.raw) && !/每天|每日/.test(policy.raw)) return null;
  const { hour, minute } = timeParts(policy.time, { hour: 17, minute: 30 });
  return {
    weekday: /每天|每日/.test(policy.raw) ? null : policy.weekday,
    hour,
    minute,
    timezone: 'Asia/Shanghai',
    label: policy.raw,
  };
}

export function reviewScheduleFromCadence(value: string): ReviewCadenceSchedule | null {
  return reviewScheduleFromPolicy(parseReviewSchedule(value));
}

export function followupScheduleFromPolicy(policy: FollowupCadencePolicy): FollowupCadenceSchedule {
  const draftTime = timeParts(policy.draftTime, { hour: 9, minute: 0 });
  const deadline = timeParts(policy.approveBy, { hour: 17, minute: 0 });
  const start = timeParts(policy.localSendWindow.start, { hour: 9, minute: 0 });
  const end = timeParts(policy.localSendWindow.end, { hour: 18, minute: 0 });
  return {
    draft: { weekday: policy.draftWeekday, ...draftTime, timezone: 'Asia/Shanghai', label: policy.raw },
    approvalDeadlineHour: deadline.hour,
    workdaysOnly: /工作日/.test(policy.raw),
    sendWindowStartHour: start.hour,
    sendWindowEndHour: Math.max(start.hour + 1, end.hour),
    contactWindowDays: policy.minContactGapDays,
    maxContactsPerWindow: 1,
  };
}

export function followupScheduleFromCadence(value: string): FollowupCadenceSchedule {
  return followupScheduleFromPolicy(parseFollowupCadence(value));
}

/** Most recent due slot, represented as UTC, for the fixed Beijing timezone. */
export function latestDueReviewSlot(schedule: ReviewCadenceSchedule, now = new Date()): Date {
  const offsetMs = 8 * 60 * 60 * 1000;
  const localNow = new Date(now.getTime() + offsetMs);
  let daysAgo = 0;
  if (schedule.weekday !== null) daysAgo = (localNow.getUTCDay() - schedule.weekday + 7) % 7;
  let localSlot = Date.UTC(
    localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() - daysAgo,
    schedule.hour, schedule.minute,
  );
  if (localSlot > localNow.getTime()) localSlot -= schedule.weekday === null ? 86_400_000 : 7 * 86_400_000;
  return new Date(localSlot - offsetMs);
}

export function beijingDate(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
