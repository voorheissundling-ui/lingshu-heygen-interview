import type { SocialReplicationReferenceMode } from '../../shared/contracts/socialContentReplication.js';
import type { SocialReplicationScriptShot } from '../../shared/contracts/socialContentWorkflow.js';
import type { VerifiedSocialScriptContext } from './socialContentScriptBaseline.js';
export interface ReferenceSemanticPlanning {
    /** Missing mode is the historical single-reference fidelity contract. */
    referenceMode?: SocialReplicationReferenceMode;
    targetDurationSeconds: number | null;
    budgetCny: number;
    language?: 'en' | 'zh';
    callToAction?: string | null;
}
/** New authored plan only. Reference analysis and source speech remain intact;
 * this never rewrites an already frozen identity-only plan. */
export function consolidateReferenceSemanticShots(input: {
    shots: SocialReplicationScriptShot[];
    planning: ReferenceSemanticPlanning;
    context: VerifiedSocialScriptContext;
}) {
    // Viral replication is always a shot-for-shot contract. Budget, requested
    // duration and reference mode may change how each slot is fulfilled, but
    // must never merge, omit or retime reference slots.
    return input.shots;
}
