import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentWorkflow.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import type { DataStore } from '../storage/datastore.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import { requireSocialTask } from './socialContentRecords.js';
import { createVerifiedProductFootageRevision, readVerifiedProductFootageRevision,
  type ProductFootageRevision } from './socialContentProductFootageRevision.js';
import { socialAssetSupplyPlanIdentityHash } from './socialAssetSupplyPlanIdentity.js';
import { createDurableProductFootageRevisionReaders } from './socialContentProductFootageRevisionDurableRead.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';

type Evidence = ProductFootageRevision['evidence'];
type ProofPorts = {
  store: DataStore;
  ledgerRoot?: string;
  readMaterials: (tenantId: string) => Promise<{ status: 'ready' | 'partial' | 'unavailable'; items: MaterialRecord[] }>;
  readCurrentPlan: () => Promise<SocialAssetSupplyPlan>;
  readBudgetLedgerRef: () => Promise<string>;
  readReviewedSegment?: Parameters<typeof createVerifiedProductFootageRevision>[0]['readReviewedSegment'];
};
type Scope = { repository: Starter198Repository; tenantId: string; taskId: string;
  sourceRunId: string; budgetLedgerRef: string; productId: string; shotId: string; evidence: Evidence } & ProofPorts;
type Marker = { schemaVersion: 'social-product-footage-revision-prepare.v1'; state: 'prepared_not_admitted';
  tenantId: string; taskId: string; sourceRunId: string; sourceTaskVersion: string;
  operationId: string; operationRequestHash: string;
  sourcePlanHash: string; sourceScriptHash: string; budgetLedgerRef: string;
  sourcePlan: SocialAssetSupplyPlan; revisedPlan: SocialAssetSupplyPlan;
  revision: ProductFootageRevision; markerHash: string; };
const fail = (reason: string): never => { throw new SocialContentWorkflowError(`product_footage_revision_prepare_${reason}`, 409); };

async function assertSourceInactive(input: Scope): Promise<void> {
  const run = await input.repository.get(STARTER_COLLECTIONS.runs, input.tenantId, input.sourceRunId);
  const context = socialObject(socialJson(run?.starter_context));
  if (!run || context?.socialTaskId !== input.taskId
    || !['failed', 'cancelled', 'completed', 'succeeded'].includes(socialText(run.status))) fail('source_run_active');
  const jobs = await input.store.list<Record<string, unknown>>('content_execution_jobs',
    { where: { tenant_id: input.tenantId, task_id: input.taskId }, perPage: 500 });
  if (jobs.totalItems !== jobs.items.length || jobs.items.some(job =>
    ['running', 'queued', 'retry_wait', 'reconciling', 'paused'].includes(socialText(job.status))
    || Boolean(job.worker_id) || Boolean(job.lease_expires_at))) fail('execution_active');
}

function markerOf(brief: unknown): Marker | null {
  return socialObject(socialObject(socialJson(brief))?._productFootageRevision) as Marker | null;
}

/** Durable CAS preparation only. It changes neither the original run nor the
 * quota order/slot/ledger, and deliberately creates no executable queue. */
export async function prepareSocialProductFootageRevision(input: Scope & {
  userId: string; idempotencyKey: string; expectedVersion: string; sourcePlan: SocialAssetSupplyPlan; now?: Date;
}): Promise<{ preparedVersion: string; revisedPlanHash: string; authorizesQueue: false; authorizesProvider: false }> {
  if (input.repository.dataStore !== input.store || !input.store.compareAndSwap
    || !await input.store.supportsAtomicCompareAndSwap?.()) return fail('atomic_store_required');
  const compareAndSwap = input.store.compareAndSwap.bind(input.store);
  const sourcePlanHash = socialAssetSupplyPlanIdentityHash(input.sourcePlan);
  const requestHash = socialRequestHash({ tenantId: input.tenantId, taskId: input.taskId,
    sourceRunId: input.sourceRunId, expectedVersion: input.expectedVersion, sourcePlanHash,
    budgetLedgerRef: input.budgetLedgerRef, productId: input.productId,
    shotId: input.shotId, evidence: input.evidence });
  const result = await executeSocialContentMutation({ repository: input.repository, tenantId: input.tenantId,
    userId: input.userId, idempotencyKey: input.idempotencyKey, requestHash,
    operation: 'prepare_social_product_footage_revision', targetId: input.taskId, now: input.now,
    processingReceipt: { sourcePlanHash, sourceRunId: input.sourceRunId },
    replay: async operationId => {
      const row = await requireSocialTask(input);
      if (socialText(row.last_operation_id) !== operationId) fail('replay_changed');
      const prepared = await readPreparedSocialProductFootageRevision({ ...input,
        expectedPreparedVersion: socialText(row.version) });
      return { preparedVersion: socialText(row.version), revisedPlanHash: prepared.revisedPlanHash,
        authorizesQueue: false as const, authorizesProvider: false as const };
    },
    action: async operationId => {
      const row = await requireSocialTask(input), prior = markerOf(row.brief);
      if (socialText(row.last_operation_id) === operationId && prior) {
        const prepared = await readPreparedSocialProductFootageRevision({ ...input,
          expectedPreparedVersion: socialText(row.version) });
        return { preparedVersion: socialText(row.version), revisedPlanHash: prepared.revisedPlanHash,
          authorizesQueue: false as const, authorizesProvider: false as const };
      }
      const brief = socialObject(socialJson(row.brief));
      if (!brief || prior || brief._productAssetFallback || brief._productionRevision
        || socialText(row.version) !== input.expectedVersion || socialText(row.run_id) !== input.sourceRunId
        || !['attention', 'paused'].includes(socialText(row.status)) || brief.productId !== input.productId
        || input.sourcePlan.planVersion !== input.expectedVersion) fail('source_changed');
      await assertSourceInactive(input);
      await createDurableProductFootageRevisionReaders({ repository: input.repository,
        tenantId: input.tenantId, taskId: input.taskId, sourceRunId: input.sourceRunId,
        expectedSourcePlanHash: sourcePlanHash,
        expectedBudgetLedgerRef: input.budgetLedgerRef, ledgerRoot: input.ledgerRoot }).assertDurableSource();
      const candidate = await createVerifiedProductFootageRevision({ ...input,
        sourceTaskVersion: input.expectedVersion, sourcePlan: input.sourcePlan });
      const version = Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) fail('version_invalid');
      const body = { schemaVersion: 'social-product-footage-revision-prepare.v1' as const,
        state: 'prepared_not_admitted' as const, tenantId: input.tenantId, taskId: input.taskId,
        operationId, operationRequestHash: requestHash,
        sourceRunId: input.sourceRunId, sourceTaskVersion: input.expectedVersion,
        sourcePlanHash, sourceScriptHash: socialRequestHash(socialJson(row.replication_script) ?? null),
        budgetLedgerRef: input.budgetLedgerRef, sourcePlan: structuredClone(input.sourcePlan),
        revisedPlan: candidate.plan, revision: candidate.revision };
      const marker: Marker = { ...body, markerHash: socialRequestHash(body) };
      const saved = await compareAndSwap(STARTER_COLLECTIONS.socialContentTasks, row.id,
        { tenant_id: input.tenantId, version: row.version, run_id: row.run_id,
          status: row.status, brief: row.brief, replication_script: row.replication_script,
          last_operation_id: row.last_operation_id },
        { brief: { ...brief, _productFootageRevision: marker }, version: String(version + 1),
          last_operation_id: operationId, updated_by: input.userId,
          updated_at: (input.now ?? new Date()).toISOString() });
      if (!saved) fail('task_conflict');
      return { preparedVersion: String(version + 1), revisedPlanHash: candidate.revision.revisedPlanHash,
        authorizesQueue: false as const, authorizesProvider: false as const };
    },
  });
  return result.value;
}

/** Rebuild the frozen candidate against current rights, bytes, finding,
 * source plan and original ledger after any restart or duplicate request. */
export async function readPreparedSocialProductFootageRevision(input: Scope & {
  expectedPreparedVersion: string;
}): Promise<{ plan: SocialAssetSupplyPlan; revisedPlanHash: string; preparedVersion: string;
  budgetLedgerRef: string; authorizesQueue: false; authorizesProvider: false }> {
  if (input.repository.dataStore !== input.store) fail('store_changed');
  const row = await requireSocialTask(input), marker = markerOf(row.brief);
  const brief = socialObject(socialJson(row.brief));
  if (!marker || marker.schemaVersion !== 'social-product-footage-revision-prepare.v1'
    || marker.state !== 'prepared_not_admitted' || socialText(row.version) !== input.expectedPreparedVersion
    || socialText(row.run_id) !== input.sourceRunId || !['attention', 'paused'].includes(socialText(row.status))
    || socialText(row.last_operation_id) !== marker.operationId || brief?.productId !== input.productId
    || brief?._productAssetFallback || brief?._productionRevision
    || marker.tenantId !== input.tenantId || marker.taskId !== input.taskId
    || marker.sourceRunId !== input.sourceRunId || marker.budgetLedgerRef !== input.budgetLedgerRef
    || marker.revision.productId !== input.productId || marker.revision.shotId !== input.shotId
    || socialRequestHash(marker.revision.evidence) !== socialRequestHash(input.evidence)
    || marker.sourceScriptHash !== socialRequestHash(socialJson(row.replication_script) ?? null)) return fail('marker_changed');
  const { markerHash, ...body } = marker;
  if (socialRequestHash(body) !== markerHash
    || socialAssetSupplyPlanIdentityHash(marker.sourcePlan) !== marker.sourcePlanHash
    || marker.sourcePlan.planVersion !== marker.sourceTaskVersion) fail('marker_corrupt');
  const operations = await input.repository.list(STARTER_COLLECTIONS.socialContentOperations, input.tenantId,
    { where: { operation_id: marker.operationId }, perPage: 2 });
  const operation = operations.items[0];
  if (operations.totalItems !== 1 || operations.items.length !== 1 || !operation
    || operation.operation !== 'prepare_social_product_footage_revision'
    || operation.target_id !== input.taskId || operation.request_hash !== marker.operationRequestHash
    || !['processing', 'succeeded'].includes(socialText(operation.status))
    || marker.operationRequestHash !== socialRequestHash({ tenantId: input.tenantId, taskId: input.taskId,
      sourceRunId: input.sourceRunId, expectedVersion: marker.sourceTaskVersion,
      sourcePlanHash: marker.sourcePlanHash, budgetLedgerRef: input.budgetLedgerRef,
      productId: input.productId, shotId: input.shotId, evidence: input.evidence })) fail('operation_changed');
  await assertSourceInactive(input);
  if (/^ledger:[a-f0-9]{64}$/.test(marker.budgetLedgerRef))
    await createDurableProductFootageRevisionReaders({ repository: input.repository,
      tenantId: input.tenantId, taskId: input.taskId, sourceRunId: input.sourceRunId,
      expectedSourcePlanHash: marker.sourcePlanHash,
      expectedBudgetLedgerRef: marker.budgetLedgerRef, ledgerRoot: input.ledgerRoot }).assertDurableSource();
  const current = await readVerifiedProductFootageRevision({ ...input,
    sourceTaskVersion: marker.sourceTaskVersion, sourcePlan: marker.sourcePlan,
    storedPlan: marker.revisedPlan, storedRevision: marker.revision });
  return { plan: current.plan, revisedPlanHash: current.revision.revisedPlanHash,
    preparedVersion: input.expectedPreparedVersion, budgetLedgerRef: input.budgetLedgerRef,
    authorizesQueue: false, authorizesProvider: false };
}
