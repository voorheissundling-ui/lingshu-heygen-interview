import type {
  BusinessContentGoal,
  BusinessGoalBuildInput,
  DecisionRecord,
  EnterpriseOperatingInput,
} from '../../shared/contracts/socialOperatingDecision.js';
import type { DataStore } from '../storage/datastore.js';
import { buildBusinessContentGoal } from './businessGoalBuilder.js';
import { analyzeEnterpriseOperatingChange } from './impactAnalysis.js';
import { createSocialOperatingRepository } from './repository.js';
import type { OperatingDecisionRecord } from './capacityPlanner.js';

export class SocialOperatingDecisionError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

export interface SaveBusinessGoalRequest {
  tenantId: string;
  operator: { type: 'user' | 'agent' | 'system'; id: string };
  input: BusinessGoalBuildInput;
  previousEnterprise?: EnterpriseOperatingInput;
  expectedVersion?: number;
}

export function createSocialOperatingDecisionService(dataStore: DataStore, clock: () => string = () => new Date().toISOString()) {
  const repository = createSocialOperatingRepository(dataStore);
  return {
    async buildAndSave(request: SaveBusinessGoalRequest): Promise<{ goal: BusinessContentGoal; decision: DecisionRecord; created: boolean }> {
      const tenantId = request.tenantId.trim();
      const operatorId = request.operator.id.trim();
      if (!tenantId || !operatorId) throw new SocialOperatingDecisionError('identity_required', 400, '租户与操作者不能为空。');
      const programId = request.input.programRef.id.trim();
      if (!programId || request.input.programRef.type !== 'social_program') {
        throw new SocialOperatingDecisionError('program_ref_invalid', 400, '必须提供有效的社媒项目版本引用。');
      }
      const current = await repository.latestGoal(tenantId, programId);
      let candidate = buildBusinessContentGoal(request.input, {
        version: (current?.version ?? 0) + 1, operator: { ...request.operator, id: operatorId }, decidedAt: clock(),
      });
      if (request.previousEnterprise) {
        candidate.decision.impacts = analyzeEnterpriseOperatingChange({
          previous: request.previousEnterprise,
          next: request.input.enterprise,
        });
      }
      if (current?.inputFingerprint === candidate.goal.inputFingerprint && current.ruleVersion === candidate.goal.ruleVersion) {
        const decision = await repository.getDecision(tenantId, programId, current.decisionRecordRef.id);
        if (!decision) throw new SocialOperatingDecisionError('decision_record_missing', 500, '经营目标缺少对应决策记录。');
        return { goal: current, decision, created: false };
      }
      const expected = request.expectedVersion;
      if (current && (!Number.isSafeInteger(expected) || expected !== current.version)) {
        throw new SocialOperatingDecisionError('version_conflict', 409, `经营目标已更新，当前版本为 ${current.version}。`);
      }
      if (!current && expected !== undefined && expected !== 0) {
        throw new SocialOperatingDecisionError('version_conflict', 409, '经营目标尚未创建，期望版本必须为 0。');
      }
      if (!current) {
        const interruptedDecision = await repository.getDecision(tenantId, programId, candidate.decision.decisionId);
        if (interruptedDecision) {
          // The decision may have committed before a process interruption while
          // the goal row did not. Rebuild with the original audit attribution
          // and timestamp so the second step can resume deterministically.
          candidate = buildBusinessContentGoal(request.input, {
            version: candidate.goal.version,
            operator: interruptedDecision.operator,
            decidedAt: interruptedDecision.decidedAt,
          });
          if (request.previousEnterprise) {
            candidate.decision.impacts = analyzeEnterpriseOperatingChange({
              previous: request.previousEnterprise,
              next: request.input.enterprise,
            });
          }
        }
      }
      try {
        await repository.save(tenantId, candidate.goal, candidate.decision);
      } catch (error) {
        if (error instanceof Error && (error.message === 'business_goal_version_conflict' || error.message === 'decision_record_conflict')) {
          const latest = await repository.latestGoal(tenantId, programId);
          throw new SocialOperatingDecisionError('version_conflict', 409, `经营目标已被并发更新，当前版本为 ${latest?.version ?? 0}。`);
        }
        throw error;
      }
      return { ...candidate, created: true };
    },
    async saveOperatingDecision<T>(tenantId: string, programId: string, decision: OperatingDecisionRecord<T>): Promise<{ created: boolean }> {
      if (!tenantId.trim() || !programId.trim()) throw new SocialOperatingDecisionError('identity_required', 400, '租户与项目不能为空。');
      if (decision.subjectRef.type !== 'business_content_goal') {
        throw new SocialOperatingDecisionError('business_goal_ref_invalid', 400, '经营决策必须引用权威经营目标。');
      }
      const normalizedTenantId = tenantId.trim();
      const normalizedProgramId = programId.trim();
      const goal = await repository.getGoal(
        normalizedTenantId,
        normalizedProgramId,
        decision.subjectRef.id,
        decision.subjectRef.version,
      );
      if (!goal) throw new SocialOperatingDecisionError('business_goal_not_found', 404, '经营决策引用的权威经营目标不存在。');
      return repository.saveDecision(normalizedTenantId, normalizedProgramId, decision);
    },
    async getGoal(tenantId: string, programId: string, goalId: string, version?: number): Promise<BusinessContentGoal> {
      const goal = await repository.getGoal(tenantId.trim(), programId.trim(), goalId.trim(), version);
      if (!goal) throw new SocialOperatingDecisionError('business_goal_not_found', 404, '经营目标不存在。');
      return goal;
    },
    async getDecision(tenantId: string, programId: string, decisionId: string): Promise<DecisionRecord> {
      const decision = await repository.getDecision(tenantId.trim(), programId.trim(), decisionId.trim());
      if (!decision) throw new SocialOperatingDecisionError('decision_record_not_found', 404, '决策记录不存在。');
      return decision;
    },
  };
}
