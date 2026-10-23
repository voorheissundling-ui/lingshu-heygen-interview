import { SocialContentTaskBudget, type SocialTaskBudgetScope } from '../lib/socialContentTaskBudget.js';
import { socialPaidIntentOperation, type SocialApprovedBudgetPlan } from '../lib/socialContentTaskBudgetAuthority.js';
import type { SocialTaskBudgetQuote } from '../lib/socialContentTaskBudget.js';
import type { BoundPaidRoute, PaidStageRequirement } from './socialContentPaidOperationPlan.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { readSocialProductFootageRevisionHandoffGuard } from './socialContentProductFootageRevisionHandoff.js';
import { requireSocialTask } from './socialContentRecords.js';
import { socialJson, socialObject, socialRequestHash, socialText, SocialContentWorkflowError } from './socialContentValidation.js';

type GuardInput = Parameters<typeof readSocialProductFootageRevisionHandoffGuard>[0];
export type SocialProductFootageRevisionCanonicalPlan = SocialApprovedBudgetPlan & { revisionGuardHash: string;
  revisedPlanHash: string; footageEvidenceHash: string;
  productionAdapter?: { schemaVersion: 'social-product-footage-revision-production-budget.v1';
    requirements: PaidStageRequirement[]; routeBindings: Record<string, BoundPaidRoute>;
    quotes: Record<string, SocialTaskBudgetQuote> } };
const fail = (reason: string): never => { throw new SocialContentWorkflowError(`product_footage_revision_paid_preflight_${reason}`, 409); };

/** Read-only paid-operation preflight. This does not issue a permit or wake a
 * blocked worker. Every future provider call must repeat this check and add
 * its own canonical worker/approval/permit checks. */
export async function readSocialProductFootageRevisionPaidPreflight(input: {
  repository: Starter198Repository; guard: GuardInput; ledgerRoot?: string;
  readCanonicalPlan(scope: SocialTaskBudgetScope): Promise<SocialProductFootageRevisionCanonicalPlan>;
}): Promise<{ scope: SocialTaskBudgetScope; guardHash: string; canonicalPlanHash: string;
  retainedCny: number; remainingCny: number; operationIds: string[];
  authorizesQueue: false; authorizesProvider: false; authorizesProduction: false }> {
  const { repository, guard } = input;
  if (guard.repository !== repository || guard.prepared.repository !== repository
    || guard.prepared.store !== repository.dataStore) return fail('scope_changed');
  const frozen = await readSocialProductFootageRevisionHandoffGuard(guard);
  const task = await requireSocialTask({ repository, tenantId: guard.prepared.tenantId,
    taskId: guard.prepared.taskId });
  const run = await repository.get(STARTER_COLLECTIONS.runs, guard.prepared.tenantId, guard.revisionRunId);
  const context = socialObject(socialJson(run?.starter_context));
  const queue = await repository.list(STARTER_COLLECTIONS.tasks, guard.prepared.tenantId,
    { where: { run_id: guard.revisionRunId, task_key: 'social_product_footage_revision_admission' }, perPage: 2 });
  if (socialText(task.run_id) !== guard.revisionRunId || task.status !== 'paused'
    || socialText(task.version) !== frozen.guard.handoffVersion
    || socialText(task.orchestrator_item_id) !== guard.queueItemId
    || run?.status !== 'waiting_external' || socialObject(context?.paidGuard)?.recordHash !== frozen.guard.recordHash
    || queue.totalItems !== 1 || queue.items.length !== 1 || queue.items[0]?.status !== 'blocked'
    || queue.items[0]?.automatic_execution_allowed !== false) return fail('worker_not_admitted');
  const scope: SocialTaskBudgetScope = { tenantId: guard.prepared.tenantId, taskId: guard.prepared.taskId,
    runId: guard.revisionRunId, planHash: frozen.guard.revisedPlanHash };
  const plan = await input.readCanonicalPlan(scope);
  const revision = socialObject(socialObject(socialJson(task.brief))?._productFootageRevision);
  const evidenceHash = socialObject(revision?.revision)?.recordHash;
  if (!plan || plan.scope?.tenantId !== scope.tenantId || plan.scope?.taskId !== scope.taskId
    || plan.scope?.runId !== scope.runId || plan.scope?.planHash !== scope.planHash
    || plan.scope?.budgetTaskId !== undefined || plan.maximumCny !== 10
    || plan.authorizationRef !== `footage-revision:${frozen.guard.recordHash}`
    || plan.revisionGuardHash !== frozen.guard.recordHash
    || plan.revisedPlanHash !== frozen.guard.revisedPlanHash
    || plan.footageEvidenceHash !== evidenceHash
    || !Array.isArray(plan.paidOperations) || !plan.paidOperations.length) return fail('canonical_plan_invalid');
  const operations = plan.paidOperations.map(intent => socialPaidIntentOperation(scope, intent));
  if (new Set(operations.map(item => item.operationId)).size !== operations.length) return fail('duplicate_operation');
  const ledger = new SocialContentTaskBudget(input.ledgerRoot, {
    authorization: async () => fail('read_only'), quote: async () => fail('read_only'),
    assertCurrent: async () => fail('read_only'), verifyRejection: async () => false });
  const status = ledger.status(scope);
  if (!status || status.authorizedLimitCny !== 10 || status.limitCny !== 10
    || status.hasCorrectionAuthorization || status.retainedCny > 10
    || status.entries.some(entry => (entry.executionTaskId ?? scope.taskId) !== scope.taskId))
    return fail('original_ten_yuan_ledger_changed');
  const revised = status.entries.filter(entry => entry.runId === scope.runId && entry.status !== 'rejected');
  if (revised.length !== operations.length || operations.some(operation => {
    const entry = revised.find(item => item.operationId === operation.operationId);
    return !entry || entry.planHash !== scope.planHash || entry.status !== 'reserved'
      || entry.receiptRef !== null || !Number.isSafeInteger(entry.reservedMicros)
      || entry.reservedMicros <= 0
      || (['fingerprint', 'provider', 'model', 'accountRef', 'stage', 'shotId'] as const)
        .some(key => entry[key] !== operation[key]);
  })) return fail('complete_new_run_reservation_required');
  // The guard independently rereads the source ledger, rights, visual finding,
  // actual media bytes and old/new approval scopes. Avoid a caller swapping
  // the canonical plan or budget between those reads and this return.
  const again = await readSocialProductFootageRevisionHandoffGuard(guard);
  if (again.guard.recordHash !== frozen.guard.recordHash
    || socialRequestHash(await input.readCanonicalPlan(scope)) !== socialRequestHash(plan))
    return fail('authority_changed');
  const latest = ledger.status(scope);
  if (!latest || socialRequestHash(latest.entries) !== socialRequestHash(status.entries)
    || latest.retainedCny !== status.retainedCny) return fail('ledger_changed');
  return { scope, guardHash: frozen.guard.recordHash, canonicalPlanHash: socialRequestHash(plan),
    retainedCny: status.retainedCny, remainingCny: status.remainingCny,
    operationIds: operations.map(item => item.operationId), authorizesQueue: false,
    authorizesProvider: false, authorizesProduction: false };
}
