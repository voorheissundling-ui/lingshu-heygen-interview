import type { SocialInspirationCollectionRun } from '../../shared/contracts/socialContentWorkflow.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';

/** A plan is diagnostic evidence, NOT an execution permit or quota grant. */
export function planTerminalDiscoverySourceRetry(run: SocialInspirationCollectionRun) {
  const quotaLimited = run.status === 'stopped'
    && run.stopReason === 'daily_collection_limit_reached'
    && !(run.failureDetails ?? []).length;
  const terminal = run.status === 'failed' || quotaLimited;
  const resultsExist = Object.values(run.modeStats ?? {}).some(stats => (stats?.fetched ?? 0) > 0 || (stats?.accepted ?? 0) > 0);
  const blockingCodes: string[] = [];
  if (!terminal) blockingCodes.push('discovery_retry_terminal_failure_required');
  if (resultsExist) blockingCodes.push('discovery_retry_existing_results_require_reconciliation');
  const rejectedSources = (run.failureDetails ?? []).filter(source =>
    // Require the provider's explicit pre-launch refusal marker, not just a
    // generic HTTP error, balance guess, run.status, or user-supplied code.
    /not-enough-usage-to-run-paid-actor/.test(source.error)
    && /HTTP\s*402\b/.test(source.error)
    && !/timed?\s*out|timeout|socket|connection reset|run [A-Za-z0-9_-]+ ended/i.test(source.error),
  ).map(source => ({ mode: source.mode, platform: source.platform, queryRef: source.queryRef }));
  const snapshot=run.scopeSnapshot as typeof run.scopeSnapshot&{modePolicies?:Record<string,{platforms?:string[]}>};
  const quotaSources=quotaLimited?Object.entries(run.queryBasis??{}).flatMap(([mode,refs])=>(refs??[]).flatMap(queryRef=>{
    const urlPlatform=/linkedin\.com/i.test(queryRef)?'linkedin':/facebook\.com/i.test(queryRef)?'facebook':/tiktok\.com/i.test(queryRef)?'tiktok':/instagram\.com/i.test(queryRef)?'instagram':/youtu(?:\.be|be\.com)/i.test(queryRef)?'youtube':null;
    const platforms=urlPlatform?[urlPlatform]:(snapshot.modePolicies?.[mode]?.platforms??[]);
    return platforms.map(platform=>({mode:mode as typeof rejectedSources[number]['mode'],platform,queryRef}));
  })):[];
  const eligibleSources=quotaLimited?quotaSources:rejectedSources;
  const keys = new Set(eligibleSources.map(source => socialRequestHash(source)));
  const unresolvedSources = (run.failureDetails ?? []).filter(source => !keys.has(socialRequestHash({ mode: source.mode, platform: source.platform, queryRef: source.queryRef })))
    .map(source => ({ mode: source.mode, platform: source.platform, queryRef: source.queryRef, reason: 'provider_settlement_not_proven' }));
  if (!eligibleSources.length) blockingCodes.push(quotaLimited?'discovery_retry_quota_sources_required':'discovery_retry_definitive_rejection_required');
  return {
    schema: 'terminal-discovery-source-retry-plan.v1' as const,
    parentRunId: run.runId,
    parentRunHash: socialRequestHash(run),
    scopeId: run.discoveryScopeId,
    scopeVersion: run.discoveryScopeVersion,
    eligibleSources: blockingCodes.length ? [] : eligibleSources,
    unresolvedSources,
    blockingCodes,
    // A whole-run retry is forbidden while even one source lacks settlement.
    wholeRunRetryEligible: !blockingCodes.length && !unresolvedSources.length,
    requiresNewAttemptIdentity: true,
    retainsOriginalRunAndQuota: true,
    authorizesExecution: false,
    grantsAdditionalDailyQuota: false,
  };
}
