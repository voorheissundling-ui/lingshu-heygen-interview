import { persistCandidateEvidence, type CandidateEvidenceInput } from './orchestration.js';
import { evaluateInnovationGate, type InnovationEvidence, type VersionedCandidateEvidence } from './qualityOrchestration.js';

export interface CandidateEvidenceWorkItem extends CandidateEvidenceInput {
  innovationEvidence?: InnovationEvidence;
  productionEligibilityIssues?: string[];
}

export interface CandidateEvidenceWorkResult {
  accepted: VersionedCandidateEvidence[];
  suggestions: Array<{ candidateId: string; reasons: string[] }>;
  failed: Array<{ candidateId: string; error: string }>;
}

/**
 * Persists evidence after collection. Innovation candidates that miss their
 * evidence gate remain suggestions and never fill an accepted quota.
 */
export async function runCandidateEvidenceWorker(
  items: CandidateEvidenceWorkItem[],
  persist: typeof persistCandidateEvidence = persistCandidateEvidence,
): Promise<CandidateEvidenceWorkResult> {
  const result: CandidateEvidenceWorkResult = { accepted: [], suggestions: [], failed: [] };
  for (const item of items) {
    if (item.productionEligibilityIssues?.length) {
      result.suggestions.push({ candidateId: item.candidateId, reasons: [...new Set(item.productionEligibilityIssues)] });
      continue;
    }
    if (!item.evidenceRefs?.length || !item.g1.sourceUrl || item.g1.sourceUrl === 'unknown') {
      result.suggestions.push({ candidateId: item.candidateId, reasons: ['候选缺少可追溯来源或证据引用'] });
      continue;
    }
    if (item.discoveryPath.includes('innovation')) {
      if (!item.innovationEvidence) {
        result.suggestions.push({ candidateId: item.candidateId, reasons: ['创新候选缺少门槛证据'] });
        continue;
      }
      const gate = evaluateInnovationGate(item.innovationEvidence);
      if (!gate.qualified) {
        result.suggestions.push({ candidateId: item.candidateId, reasons: gate.reasons });
        continue;
      }
    }
    try {
      const persisted = await persist(item);
      const decision = persisted.evidence.qualityScore?.decision;
      if (decision === undefined || decision === 'accepted') result.accepted.push(persisted);
      else result.suggestions.push({
        candidateId: item.candidateId,
        reasons: persisted.evidence.qualityScore?.blockers.length
          ? persisted.evidence.qualityScore.blockers
          : persisted.evidence.qualityScore?.reasons ?? ['候选评分未达到自动入选阈值'],
      });
    } catch (cause) {
      result.failed.push({ candidateId: item.candidateId, error: cause instanceof Error ? cause.message : 'candidate_evidence_failed' });
    }
  }
  return result;
}
