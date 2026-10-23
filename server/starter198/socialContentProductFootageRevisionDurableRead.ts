import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentWorkflow.js';
import { readMaterialLibrary } from '../lib/materialLibrary.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import { SocialContentTaskBudget } from '../lib/socialContentTaskBudget.js';
import { socialPaidIntentOperation, type SocialApprovedBudgetPlan } from '../lib/socialContentTaskBudgetAuthority.js';
import { paidProductionHash } from './socialContentPaidOperationPlan.js';
import { readContentExecutionJob } from '../contentExecution/durableQueue.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { socialAssetSupplyPlanIdentityHash } from './socialAssetSupplyPlanIdentity.js';
import { socialJson, socialObject, socialText, SocialContentWorkflowError } from './socialContentValidation.js';

const fail = (reason: string): never => {
  throw new SocialContentWorkflowError(`product_footage_revision_durable_source_${reason}`, 409);
};

/** Rebuild only the read side from durable source-run identities. In particular,
 * neither a prepared marker nor the caller's remembered plan/ledger string is
 * authority. The exact-window read continues through the signed review ledger
 * and object-storage SHA check in readProductionProductFootageSegment. */
export function createDurableProductFootageRevisionReaders(input: {
  repository: Starter198Repository; tenantId: string; taskId: string; sourceRunId: string;
  expectedSourcePlanHash: string; expectedBudgetLedgerRef: string;
  ledgerRoot?: string;
  /** Server-owned inventory reader for isolated storage tests only. The
   * production path uses the shared current library by default. */
  readMaterials?: (tenantId: string) => Promise<{ status: 'ready' | 'partial' | 'unavailable'; items: MaterialRecord[] }>;
}) {
  const { repository, tenantId, taskId, sourceRunId } = input;
  const store = repository.dataStore;
  if (!store || !/^[a-f0-9]{64}$/.test(input.expectedSourcePlanHash)
    || !input.expectedBudgetLedgerRef) return fail('input_invalid');
  const source = async () => {
    const run = await repository.get(STARTER_COLLECTIONS.runs, tenantId, sourceRunId);
    const context = socialObject(socialJson(run?.starter_context));
    const job = await readContentExecutionJob(store, tenantId, taskId, sourceRunId);
    const binding = socialObject(job?.checkpoints['social.executor']?.payload);
    const approved = socialObject(binding?.approvedContext);
    const plan = socialObject(approved?.assetSupplyPlan) as SocialAssetSupplyPlan | null;
    if (!run || context?.socialTaskId !== taskId || !job || !binding
      || job.runId !== sourceRunId || job.taskId !== taskId
      || job.checkpoints['social.executor']?.version !== '1'
      || job.checkpoints['social.executor']?.inputHash !== binding.inputHash
      || !plan || !Array.isArray(plan.shots)) return fail('frozen_plan_missing');
    if (socialAssetSupplyPlanIdentityHash(plan) !== input.expectedSourcePlanHash)
      return fail('frozen_plan_changed');
    if (/^ledger:[a-f0-9]{64}$/.test(input.expectedBudgetLedgerRef)
      || socialText(context.budgetLedgerRef) !== input.expectedBudgetLedgerRef) {
      const budget = job.checkpoints['social.whole_film_budget'];
      const payload = socialObject(budget?.payload);
      const frozen = socialObject(payload?.plan) as SocialApprovedBudgetPlan | null;
      const scope = frozen?.scope;
      if (!budget || budget.version !== '1' || !payload || !frozen || !scope
        || budget.inputHash !== scope.planHash || scope.tenantId !== tenantId
        || payload.scopeHash !== paidProductionHash(scope)
        || scope.taskId !== taskId || scope.runId !== sourceRunId
        || scope.budgetTaskId !== undefined || frozen.maximumCny !== 10
        || !Array.isArray(frozen.paidOperations) || !frozen.paidOperations.length
        || !Array.isArray(payload.operationIds)
        || payload.operationIds.length !== frozen.paidOperations.length
        || new Set(payload.operationIds).size !== payload.operationIds.length)
        return fail('budget_ledger_identity_missing_or_changed');
      let operations;
      try { operations = frozen.paidOperations.map(intent => socialPaidIntentOperation(scope, intent)); }
      catch { return fail('budget_ledger_identity_missing_or_changed'); }
      const operationIds = payload.operationIds as string[];
      if (operations.some(operation => !operationIds.includes(operation.operationId)))
        return fail('budget_ledger_identity_missing_or_changed');
      const ledger = new SocialContentTaskBudget(input.ledgerRoot, {
        authorization: async () => fail('read_only'), quote: async () => fail('read_only'),
        assertCurrent: async () => fail('read_only'), verifyRejection: async () => false });
      if (ledger.attestOriginalReservation(scope, frozen.authorizationRef, operations)
        !== input.expectedBudgetLedgerRef) return fail('budget_ledger_identity_missing_or_changed');
    }
    return { plan, budgetLedgerRef: input.expectedBudgetLedgerRef };
  };
  return {
    assertDurableSource: source,
    readCurrentPlan: async () => structuredClone((await source()).plan),
    readBudgetLedgerRef: async () => (await source()).budgetLedgerRef,
    readMaterials: async (requestedTenantId: string) => {
      if (requestedTenantId !== tenantId) return fail('tenant_changed');
      return input.readMaterials ? input.readMaterials(tenantId)
        : readMaterialLibrary(tenantId, { dataStore: store });
    },
  };
}
