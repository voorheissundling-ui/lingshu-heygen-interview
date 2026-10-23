import type { SocialExecutionPlanReviewReason } from '../../shared/contracts/socialContentAgentContract.js';

const SAFETY_BLOCKERS = new Set<SocialExecutionPlanReviewReason>([
  'facts_missing',
  'rights_missing',
  'budget_exceeded',
]);

/** Retained compatibility API: local walkthroughs obey the same task ceiling. */
export function socialContentTestBypassEnabled(_environment: NodeJS.ProcessEnv = process.env): boolean {
  return false;
}

export function socialContentHasSafetyBlocker(
  reasonCodes: readonly SocialExecutionPlanReviewReason[] | null | undefined,
): boolean {
  return Boolean(reasonCodes?.some(reason => SAFETY_BLOCKERS.has(reason)));
}

export function socialContentReviewAdmissionAllowed(input: {
  approved: boolean;
  reasonCodes?: readonly SocialExecutionPlanReviewReason[] | null;
  environment?: NodeJS.ProcessEnv;
}): boolean {
  if (socialContentHasSafetyBlocker(input.reasonCodes)) return false;
  if (input.approved) return true;
  return false;
}
