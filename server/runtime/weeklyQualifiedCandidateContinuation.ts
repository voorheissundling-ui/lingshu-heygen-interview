import { socialRequestHash } from '../starter198/socialContentValidation.js';

export interface WeeklyQualifiedSource {
  mode: string;
  platform: string;
  queryRef: string;
  limit: number;
}

export interface WeeklyQualifiedAttempt {
  runId: string;
  status: 'running' | 'unknown' | 'succeeded' | 'partial' | 'failed' | 'stopped';
  finishedAt: string | null;
  sourceKeys: string[];
}

export interface WeeklyQualifiedCandidate {
  candidateId: string;
  evidenceRef: string | null;
  exactHandoffRef: string | null;
  accountId: string | null;
  postAdmission: 'pending' | 'rejected' | 'accepted';
}

export interface WeeklyQualifiedContinuationInput {
  parentRunId: string;
  parentRunHash: string;
  attempts: WeeklyQualifiedAttempt[]; // Original run first; children in immutable lineage order.
  candidates: WeeklyQualifiedCandidate[]; // Current-week lineage only, already verified by caller.
  sources: WeeklyQualifiedSource[]; // Frozen, approved source order.
  reservedSourceKeys: string[]; // Every submitted/unknown source in the lineage or daily ledger.
  remainingAuthorizedCapacity: number; // Read from the existing quota/grant ledger, never inferred from attempt count.
  now: string;
  minimumIntervalMs: number;
  /** Only a verified five-video account target may repeat its frozen source
   * under a new attempt/run identity. This never reuses a provider operation. */
  repeatableSourceKey?: string;
}

export function weeklyQualifiedSourceKey(source: Pick<WeeklyQualifiedSource, 'mode' | 'platform' | 'queryRef'>) {
  return `${source.mode}:${source.platform}:${source.queryRef}`;
}

/** Diagnostic plan only. The package gate, retry authorization, quota reservation,
 * and provider submission remain exclusively in their existing owners. */
export function planWeeklyQualifiedCandidateContinuation(input: WeeklyQualifiedContinuationInput) {
  const target = 5, maximumAttempts = 10;
  if (!Number.isSafeInteger(input.remainingAuthorizedCapacity) || input.remainingAuthorizedCapacity < 0
    || !Number.isSafeInteger(input.minimumIntervalMs) || input.minimumIntervalMs < 1
    || !Number.isFinite(Date.parse(input.now)) || !input.parentRunId || !input.parentRunHash
    || !input.attempts.length || input.attempts[0]?.runId !== input.parentRunId
    || new Set(input.attempts.map(a => a.runId)).size !== input.attempts.length
    || input.attempts.some(a => !a.runId || !Array.isArray(a.sourceKeys) || (a.finishedAt !== null && !Number.isFinite(Date.parse(a.finishedAt))))
    || input.sources.some(s => !s.mode || !s.platform || !s.queryRef || !Number.isSafeInteger(s.limit) || s.limit < 1)
    || (input.repeatableSourceKey !== undefined && (input.sources.length !== 1
      || weeklyQualifiedSourceKey(input.sources[0]!) !== input.repeatableSourceKey
      || input.sources[0]!.mode !== 'account' || input.sources[0]!.platform !== 'tiktok'))) {
    throw Error('weekly_qualified_continuation_input_invalid');
  }
  const qualified = new Set<string>();
  let pending = false;
  for (const candidate of input.candidates) {
    if (!candidate.candidateId) throw Error('weekly_qualified_candidate_invalid');
    if (candidate.postAdmission === 'pending') pending = true;
    if (candidate.postAdmission === 'accepted') {
      if (!candidate.evidenceRef || !candidate.exactHandoffRef || !candidate.accountId)
        throw Error('weekly_qualified_candidate_evidence_incomplete');
      qualified.add(candidate.candidateId);
    }
  }
  const base = { schema: 'weekly-qualified-candidate-continuation-plan.v1' as const,
    target, qualifiedCount: qualified.size, attemptCount: input.attempts.length,
    remainingAuthorizedCapacity: input.remainingAuthorizedCapacity,
    authorizesExecution: false as const, grantsAdditionalDailyQuota: false as const };
  const result = (code: string, source: WeeklyQualifiedSource | null = null, notBefore: string | null = null) => ({
    ...base, code, ready: code === 'weekly_qualified_continuation_ready', source, notBefore,
    planHash: socialRequestHash({ ...base, code, parentRunId: input.parentRunId, parentRunHash: input.parentRunHash,
      runIds: input.attempts.map(a => a.runId), qualifiedIds: [...qualified].sort(), repeatableSourceKey: input.repeatableSourceKey ?? null, source, notBefore }),
  });
  if (input.attempts.length > maximumAttempts) throw Error('weekly_qualified_attempt_limit_exceeded');
  if (qualified.size >= target) return result('weekly_qualified_target_met');
  if (input.attempts.length === maximumAttempts) return result('weekly_qualified_attempts_exhausted');
  if (pending) return result('weekly_qualified_post_admission_pending');
  const latest = input.attempts.at(-1)!;
  if (latest.status === 'running' || latest.status === 'unknown' || !latest.finishedAt)
    return result('weekly_qualified_prior_attempt_unsettled');
  const notBefore = new Date(Date.parse(latest.finishedAt) + input.minimumIntervalMs).toISOString();
  if (Date.parse(input.now) < Date.parse(notBefore)) return result('weekly_qualified_interval_pending', null, notBefore);
  if (!input.remainingAuthorizedCapacity) return result('weekly_qualified_quota_exhausted');
  const used = new Set([...input.reservedSourceKeys, ...input.attempts.flatMap(a => a.sourceKeys)]);
  const available = input.sources.find(s => weeklyQualifiedSourceKey(s) === input.repeatableSourceKey || !used.has(weeklyQualifiedSourceKey(s)));
  if (!available) return result('weekly_qualified_sources_exhausted');
  return result('weekly_qualified_continuation_ready', {
    ...available, limit: Math.min(available.limit, input.remainingAuthorizedCapacity, target - qualified.size),
  }, notBefore);
}
