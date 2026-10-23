import type { BusinessContentGoal } from '../../shared/contracts/socialOperatingDecision.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { deterministicFingerprint } from './businessGoalBuilder.js';

/** A fact-backed outline is not a commercial goal approval or production permit. */
export interface ProductionOutlineReadiness {
  schema: 'production-outline-readiness.v1';
  scope: 'fact_backed_outline';
  ready: boolean;
  goalRef: VersionedSocialRef;
  factRefs: VersionedSocialRef[];
  deferredOutboundBlockers: string[];
  blockingCodes: string[];
  authorizesProduction: false;
  authorizesPublishing: false;
  authorizesCustomerMessages: false;
  evidenceHash: string;
}

const OUTBOUND_ONLY = new Set(['conversion_route_required', 'sales_owner_required', 'account_required']);

/** Keep the original blocked goal intact; only decide whether an outline can exist. */
export function evaluateProductionOutlineReadiness(goal: BusinessContentGoal): ProductionOutlineReadiness {
  const codes = [...new Set(goal.blockers.map(item => item.code))].sort();
  const blockingCodes: string[] = codes.filter(code => !OUTBOUND_ONLY.has(code));
  if (!goal.publicFactRefs.length && !blockingCodes.includes('public_facts_required')) blockingCodes.push('public_facts_required');
  if (goal.status === 'blocked' && !codes.length) blockingCodes.push('business_goal_blocker_evidence_missing');
  if (goal.status !== 'blocked' && goal.status !== 'ready') blockingCodes.push('business_goal_status_invalid');
  const proof = {
    schema: 'production-outline-readiness.v1' as const,
    scope: 'fact_backed_outline' as const,
    ready: blockingCodes.length === 0,
    goalRef: { type: 'business_content_goal', id: goal.goalId, version: goal.version },
    factRefs: goal.publicFactRefs,
    deferredOutboundBlockers: codes.filter(code => OUTBOUND_ONLY.has(code)),
    blockingCodes: blockingCodes.sort(),
    authorizesProduction: false as const,
    authorizesPublishing: false as const,
    authorizesCustomerMessages: false as const,
  };
  return { ...proof, evidenceHash: deterministicFingerprint({ proof, inputFingerprint: goal.inputFingerprint, decisionRecordRef: goal.decisionRecordRef }) };
}
