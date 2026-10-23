import type { WeeklyDirectorPlanningAnalysis, WeeklyReferenceSourcePolicy } from '../../shared/contracts/socialProgram.js';
import type { SocialInspirationHandoff } from '../../shared/contracts/socialContentWorkflow.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';

/** Content feedback only: plays and interaction counts never establish inquiries or sales effectiveness. */
export function diagnoseOwnedReference(input: {
  policy: WeeklyReferenceSourcePolicy;
  performance: WeeklyDirectorPlanningAnalysis['historicalPerformance'];
  handoff?: SocialInspirationHandoff | null;
  handoffRef?: NonNullable<WeeklyDirectorPlanningAnalysis['ownedReferenceDiagnosis']>['handoffRef'];
  now: Date;
}): NonNullable<WeeklyDirectorPlanningAnalysis['ownedReferenceDiagnosis']> {
  if (input.policy.profile !== 'b2b_established' || !Number.isFinite(input.now.getTime())) throw Error('owned_reference_diagnosis_policy_invalid');
  const performance = input.performance;
  const trusted = performance && Boolean(performance.source.trim()) && Number.isFinite(Date.parse(performance.capturedAt)) && Date.parse(performance.capturedAt) <= input.now.getTime() && !/^(?:unknown|mock|simulated|demo|fixture)$/i.test(performance.source);
  const numeric = (key: 'views' | 'likes' | 'shares' | 'comments') => trusted && typeof performance.metrics[key] === 'number' && Number.isFinite(performance.metrics[key]) && performance.metrics[key]! >= 0 ? performance.metrics[key] : null;
  const observedMetrics = { views: numeric('views'), likes: numeric('likes'), shares: numeric('shares'), comments: numeric('comments') };
  const missingMetrics = (['views', 'likes', 'shares', 'comments'] as const).filter(key => observedMetrics[key] === null);
  const handoff = input.handoff; const ref = input.handoffRef;
  const logic = handoff?.reusableLogic;
  const toneVerified = Boolean(handoff && ref && handoff.inspirationId === ref.inspirationId
    && String(handoff.version ?? handoff.analysisVersion) === ref.version && socialRequestHash(handoff) === ref.recordHash
    && handoff.rights?.mayAnalyze === true && handoff.rights?.mayAdapt === true
    && handoff.readiness === 'production_reference'
    && logic && Array.isArray(logic.hookTypes) && logic.hookTypes.some(value => typeof value === 'string' && value.trim())
    && Array.isArray(logic.proofPlacement) && logic.proofPlacement.every(value => typeof value === 'string')
    && typeof logic.emotionalProgression === 'string' && logic.emotionalProgression.trim()
    && Array.isArray(logic.revealOrder) && logic.revealOrder.some(value => typeof value === 'string' && value.trim())
    && typeof logic.pacing === 'string' && logic.pacing.trim() && typeof logic.ctaPosition === 'string' && logic.ctaPosition.trim()
    && Array.isArray(handoff.evidenceRefs) && handoff.evidenceRefs.some(evidence => evidence.needsReview === false && Number.isFinite(evidence.confidence) && evidence.confidence >= 0.7 && evidence.description?.trim()));
  const diagnostic = {
    policy: structuredClone(input.policy),
    performanceStatus: missingMetrics.length === 0 ? 'complete' as const : missingMetrics.length === 4 ? 'unavailable' as const : 'partial' as const,
    observedMetrics, missingMetrics,
    performanceSnapshot: trusted ? { ref: structuredClone(performance.snapshotRef), capturedAt: performance.capturedAt, source: performance.source } : null,
    interactionRate: missingMetrics.length === 0 && observedMetrics.views! > 0 ? (observedMetrics.likes! + observedMetrics.shares! + observedMetrics.comments!) / observedMetrics.views! : null,
    acquisitionConclusion: 'not_measured' as const,
    toneStatus: toneVerified ? 'verified' as const : 'pending' as const,
    tone: toneVerified ? structuredClone(logic!) : null,
    handoffRef: toneVerified ? structuredClone(ref!) : null,
    checkedAt: input.now.toISOString(),
  };
  return { ...diagnostic, evidenceHash: socialRequestHash(diagnostic) };
}

export function ownedDiagnosisReady(analysis: WeeklyDirectorPlanningAnalysis): boolean {
  const diagnosis = analysis.ownedReferenceDiagnosis;
  if (!diagnosis || diagnosis.performanceStatus !== 'complete' || diagnosis.toneStatus !== 'verified' || !diagnosis.handoffRef || !diagnosis.tone) return false;
  const performance = analysis.historicalPerformance;
  if (!performance || !diagnosis.performanceSnapshot || diagnosis.missingMetrics.length || diagnosis.acquisitionConclusion !== 'not_measured'
    || diagnosis.policy.profile !== 'b2b_established'
    || !performance.source.trim() || /^(?:unknown|mock|simulated|demo|fixture)$/i.test(performance.source)
    || !Number.isFinite(Date.parse(performance.capturedAt))
    || JSON.stringify(diagnosis.observedMetrics) !== JSON.stringify(performance.metrics)
    || JSON.stringify(diagnosis.performanceSnapshot.ref) !== JSON.stringify(performance.snapshotRef)
    || diagnosis.performanceSnapshot.capturedAt !== performance.capturedAt || diagnosis.performanceSnapshot.source !== performance.source
    || !Number.isFinite(Date.parse(diagnosis.checkedAt)) || Date.parse(performance.capturedAt) > Date.parse(diagnosis.checkedAt)
    || Object.values(diagnosis.observedMetrics).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    || !analysis.benchmarkVideoRefs.some(ref => ref.id === diagnosis.handoffRef!.inspirationId)) return false;
  const { evidenceHash, ...payload } = diagnosis;
  return socialRequestHash(payload) === evidenceHash && analysis.frozenHandoffRefs?.some(ref => ref.inspirationId === diagnosis.handoffRef!.inspirationId && ref.version === diagnosis.handoffRef!.version && ref.recordHash === diagnosis.handoffRef!.recordHash) === true;
}
