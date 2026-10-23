import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { socialAssetSupplyPlanIdentityHash } from './socialAssetSupplyPlanIdentity.js';
import { createDurableProductFootageRevisionReaders } from './socialContentProductFootageRevisionDurableRead.js';
import { readSocialProductFootageRevisionHandoffGuard } from './socialContentProductFootageRevisionHandoff.js';
import { socialJson, socialObject, socialText, SocialContentWorkflowError } from './socialContentValidation.js';

const fail = (reason: string): never => {
  throw new SocialContentWorkflowError(`product_footage_revision_projection_${reason}`, 409);
};

/** Exact revised supply is visible only after the original task's durable
 * handoff. The guard rereads current media bytes, rights, finding and ledger;
 * this projection does not make a blocked run claimable. */
export async function readHandoffProductFootageRevisionSupply(input: {
  repository: Starter198Repository; tenantId: string; taskId: string;
  task: StarterRecord; ledgerRoot?: string;
}): Promise<{ plan: SocialAssetSupplyPlan; planHash: string } | null> {
  const { repository, tenantId, taskId, task } = input;
  const marker = socialObject(socialObject(socialJson(task.brief))?._productFootageRevision);
  if (!marker) return null;
  if (socialText(task.run_id) === marker.sourceRunId) return null;
  const store = repository.dataStore;
  const revision = socialObject(marker.revision);
  const evidence = socialObject(revision?.evidence);
  const revisedPlanHash = socialText(revision?.revisedPlanHash);
  const sourcePlan = socialObject(marker.sourcePlan) as SocialAssetSupplyPlan | null;
  const revisedPlan = socialObject(marker.revisedPlan) as SocialAssetSupplyPlan | null;
  const preparedVersion = String(Number(marker.sourceTaskVersion) + 1);
  if (!store || !sourcePlan || !revisedPlan || !revision || !evidence
    || !Number.isSafeInteger(Number(marker.sourceTaskVersion))
    || marker.schemaVersion !== 'social-product-footage-revision-prepare.v1'
    || marker.tenantId !== tenantId || marker.taskId !== taskId
    || !socialText(marker.sourceRunId) || !socialText(marker.budgetLedgerRef)
    || !socialText(revision.productId) || !socialText(revision.shotId)
    || !/^[a-f0-9]{64}$/.test(revisedPlanHash)
    || socialAssetSupplyPlanIdentityHash(revisedPlan) !== revisedPlanHash)
    return fail('marker_invalid');
  const runId = socialText(task.run_id);
  const run = await repository.get(STARTER_COLLECTIONS.runs, tenantId, runId);
  const context = socialObject(socialJson(run?.starter_context));
  const guard = socialObject(context?.paidGuard);
  if (!run || context?.schemaVersion !== 'social-product-footage-revision-schedule.v1'
    || context.taskId !== taskId || context.sourceRunId !== marker.sourceRunId
    || !socialText(context.queueItemId) || !socialText(guard?.recordHash)) return fail('handoff_missing');
  const readers = createDurableProductFootageRevisionReaders({ repository, tenantId, taskId,
    sourceRunId: String(marker.sourceRunId), expectedSourcePlanHash: String(marker.sourcePlanHash),
    expectedBudgetLedgerRef: String(marker.budgetLedgerRef), ledgerRoot: input.ledgerRoot });
  await readSocialProductFootageRevisionHandoffGuard({ repository,
    prepared: { repository, store, tenantId, taskId, sourceRunId: String(marker.sourceRunId),
      budgetLedgerRef: String(marker.budgetLedgerRef), productId: String(revision.productId),
      shotId: String(revision.shotId), evidence: evidence as any,
      expectedPreparedVersion: preparedVersion, ...readers },
    revisionRunId: runId, queueItemId: String(context.queueItemId),
    expectedRecordHash: String(guard!.recordHash), ledgerRoot: input.ledgerRoot });
  return { plan: structuredClone(revisedPlan), planHash: revisedPlanHash };
}
