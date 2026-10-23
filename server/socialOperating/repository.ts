import type {
  BusinessContentGoal,
  DecisionRecord,
  OperatingAuthoritySnapshot,
  SocialOperatingConstraints,
} from '../../shared/contracts/socialOperatingDecision.js';
import type { OperatingDecisionRecord } from './capacityPlanner.js';
import type { DataStore } from '../storage/datastore.js';

const GOALS = 'social_business_content_goals';
const DECISIONS = 'social_operating_decisions';

type GoalRow = { id: string; tenant_id: string; program_id: string; goal_id: string; version: number; input_fingerprint: string; payload: BusinessContentGoal };
type StoredDecision = DecisionRecord | OperatingDecisionRecord<unknown>;
type DecisionRow = { id: string; tenant_id: string; program_id: string; decision_id: string; payload: StoredDecision };
type SnapshotRow = { id: string; tenant_id: string; program_id: string; snapshot_id: string; version: number; payload: OperatingAuthoritySnapshot };
type ConstraintsRow = { id: string; tenant_id: string; program_id: string; constraints_id: string; version: number; payload: SocialOperatingConstraints };

const stable = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
    : JSON.stringify(value);

function same(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

export function createSocialOperatingRepository(dataStore: DataStore) {
  return {
    async latestGoal(tenantId: string, programId: string): Promise<BusinessContentGoal | null> {
      const result = await dataStore.list<GoalRow>(GOALS, { where: { tenant_id: tenantId, program_id: programId }, sort: '-version', page: 1, perPage: 1 });
      return result.items[0]?.payload ?? null;
    },
    async getGoal(tenantId: string, programId: string, goalId: string, version?: number): Promise<BusinessContentGoal | null> {
      const where: Record<string, string | number> = { tenant_id: tenantId, program_id: programId, goal_id: goalId };
      if (version !== undefined) where.version = version;
      const result = await dataStore.list<GoalRow>(GOALS, { where, sort: '-version', page: 1, perPage: 1 });
      return result.items[0]?.payload ?? null;
    },
    async saveDecision(tenantId: string, programId: string, decision: StoredDecision): Promise<{ created: boolean }> {
      const read = async () => {
        const result = await dataStore.list<DecisionRow>(DECISIONS, {
          where: { tenant_id: tenantId, program_id: programId, decision_id: decision.decisionId }, page: 1, perPage: 1,
        });
        return result.items[0] ?? null;
      };
      const existing = await read();
      if (existing) {
        if (!same(existing.payload, decision)) throw new Error('decision_record_conflict');
        return { created: false };
      }
      try {
        const stored = await dataStore.create<DecisionRow>(DECISIONS, {
          tenant_id: tenantId, program_id: programId, decision_id: decision.decisionId,
          subject_id: decision.subjectRef.id, subject_version: decision.subjectRef.version, outcome: decision.outcome,
          input_fingerprint: decision.inputFingerprint, payload: decision, decided_at: decision.decidedAt,
        });
        if (stored) return { created: true };
      } catch {
        // A concurrent writer may have won the immutable unique key. Re-read
        // before classifying this as unavailable.
      }
      const raced = await read();
      if (raced) {
        if (!same(raced.payload, decision)) throw new Error('decision_record_conflict');
        return { created: false };
      }
      throw new Error('decision_record_storage_unavailable');
    },
    async save(tenantId: string, goal: BusinessContentGoal, decision: DecisionRecord): Promise<void> {
      // Decision first is intentional: a visible goal must never point at a
      // decision that has not committed. Both writes are idempotent, so a
      // retry resumes after either interruption point.
      await this.saveDecision(tenantId, goal.programId, decision);
      const readGoal = async () => {
        const result = await dataStore.list<GoalRow>(GOALS, {
          where: { tenant_id: tenantId, program_id: goal.programId, goal_id: goal.goalId, version: goal.version },
          page: 1, perPage: 1,
        });
        return result.items[0] ?? null;
      };
      const existing = await readGoal();
      if (existing) {
        if (!same(existing.payload, goal)) throw new Error('business_goal_version_conflict');
        return;
      }
      try {
        const storedGoal = await dataStore.create<GoalRow>(GOALS, {
          tenant_id: tenantId, program_id: goal.programId, goal_id: goal.goalId, version: goal.version,
          input_fingerprint: goal.inputFingerprint, status: goal.status, payload: goal, created_at: goal.createdAt,
        });
        if (storedGoal) return;
      } catch {
        // Resolve immutable-key races by reading the committed value.
      }
      const raced = await readGoal();
      if (raced) {
        if (!same(raced.payload, goal)) throw new Error('business_goal_version_conflict');
        return;
      }
      throw new Error('business_goal_storage_unavailable');
    },
    async getDecision(tenantId: string, programId: string, decisionId: string): Promise<DecisionRecord | null> {
      const result = await dataStore.list<DecisionRow>(DECISIONS, { where: { tenant_id: tenantId, program_id: programId, decision_id: decisionId }, page: 1, perPage: 1 });
      const payload = result.items[0]?.payload;
      return payload?.decisionType === 'business_content_goal' ? payload as DecisionRecord : null;
    },
    async getOperatingDecision<T>(tenantId: string, programId: string, decisionId: string): Promise<OperatingDecisionRecord<T> | null> {
      const result = await dataStore.list<DecisionRow>(DECISIONS, { where: { tenant_id: tenantId, program_id: programId, decision_id: decisionId }, page: 1, perPage: 1 });
      const payload = result.items[0]?.payload;
      return payload && payload.decisionType !== 'business_content_goal' ? payload as OperatingDecisionRecord<T> : null;
    },
    async saveOperatingDecision(tenantId: string, programId: string, decision: OperatingDecisionRecord<unknown>): Promise<void> {
      const existing = await dataStore.list<DecisionRow>(DECISIONS, {
        where: { tenant_id: tenantId, program_id: programId, decision_id: decision.decisionId }, page: 1, perPage: 1,
      });
      if (existing.items[0]) {
        if (existing.items[0].payload.inputFingerprint !== decision.inputFingerprint) throw new Error('operating_decision_identity_collision');
        return;
      }
      const saved = await dataStore.create(DECISIONS, {
        tenant_id: tenantId, program_id: programId, decision_id: decision.decisionId,
        subject_id: decision.subjectRef.id, subject_version: decision.subjectRef.version,
        outcome: decision.outcome, input_fingerprint: decision.inputFingerprint,
        payload: decision, decided_at: decision.decidedAt,
      });
      if (!saved) throw new Error('operating_decision_storage_unavailable');
    },
    async latestSnapshot(tenantId: string, programId: string): Promise<OperatingAuthoritySnapshot | null> {
      const result = await dataStore.list<SnapshotRow>('social_operating_authority_snapshots', {
        where: { tenant_id: tenantId, program_id: programId }, sort: '-version', page: 1, perPage: 1,
      });
      return result.items[0]?.payload ?? null;
    },
    async getSnapshot(tenantId: string, programId: string, snapshotId: string, version?: number): Promise<OperatingAuthoritySnapshot | null> {
      const where: Record<string, string | number> = { tenant_id: tenantId, program_id: programId, snapshot_id: snapshotId };
      if (version !== undefined) where.version = version;
      const result = await dataStore.list<SnapshotRow>('social_operating_authority_snapshots', { where, sort: '-version', page: 1, perPage: 1 });
      return result.items[0]?.payload ?? null;
    },
    async saveSnapshot(tenantId: string, snapshot: OperatingAuthoritySnapshot): Promise<void> {
      const saved = await dataStore.create('social_operating_authority_snapshots', {
        tenant_id: tenantId, program_id: snapshot.programId, snapshot_id: snapshot.snapshotId,
        version: snapshot.version, status: snapshot.status, input_fingerprint: snapshot.inputFingerprint,
        payload: snapshot, created_by: snapshot.createdBy, created_at: snapshot.createdAt,
      });
      if (!saved) throw new Error('operating_snapshot_storage_unavailable');
    },
    async latestConstraints(tenantId: string, programId: string): Promise<SocialOperatingConstraints | null> {
      const result = await dataStore.list<ConstraintsRow>('social_operating_constraints', {
        where: { tenant_id: tenantId, program_id: programId }, sort: '-version', page: 1, perPage: 1,
      });
      return result.items[0]?.payload ?? null;
    },
    async saveConstraints(tenantId: string, constraints: SocialOperatingConstraints): Promise<void> {
      const saved = await dataStore.create('social_operating_constraints', {
        tenant_id: tenantId, program_id: constraints.programId, constraints_id: constraints.constraintsId,
        version: constraints.version, payload: constraints, created_by: constraints.createdBy, created_at: constraints.createdAt,
      });
      if (!saved) throw new Error('operating_constraints_storage_unavailable');
    },
  };
}
