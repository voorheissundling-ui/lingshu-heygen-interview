import type { MaterialRecord } from '../lib/materialLibrary.js';
import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentWorkflow.js';
import type { Starter198Repository } from './repository.js';
import { STARTER_COLLECTIONS } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import { requireSocialTask } from './socialContentRecords.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';
import { createVerifiedProductAssetFallbackRevision, isAuthorizedProductFallback } from './socialContentProductAssetFallback.js';
import { socialAssetSupplyPlanIdentityHash } from './socialAssetSupplyPlanIdentity.js';
import { createProductAssetFallbackRevision } from './socialContentProductAssetFallback.js';
import { createPresenterFirstFrameAssetProvenance, isPresenterFirstFrameAssetProvenance,
  type PresenterFirstFrameAssetProvenance } from './socialContentPresenterFirstFrameAssetProvenance.js';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** Prepare only: the marker is not production admission. It deliberately does
 * not use the eight-scene creative-revision adapter or alter speechLines. */
export async function prepareSocialProductAssetFallback(input: {
  repository: Starter198Repository; tenantId: string; userId: string; taskId: string;
  expectedVersion: string; sourceRunId: string; productId: string; failedAssetId: string;
  sourcePlan: SocialAssetSupplyPlan; materials: MaterialRecord[]; failedAsset?: MaterialRecord;
  budgetLedgerRef: string; idempotencyKey: string;
  /** Recompute the authoritative plan from the current task and inventory,
   * never trust the command's copy of a formerly displayed plan. */
  readCurrentPlan: () => Promise<SocialAssetSupplyPlan>;
  loadBytes?: (record: MaterialRecord, tenantId: string) => Promise<Buffer>;
}) {
  const sourcePlanHash = socialAssetSupplyPlanIdentityHash(input.sourcePlan);
  const requestHash = socialRequestHash({ tenantId: input.tenantId, taskId: input.taskId,
    expectedVersion: input.expectedVersion, sourceRunId: input.sourceRunId, productId: input.productId,
    failedAssetId: input.failedAssetId, sourcePlanHash, budgetLedgerRef: input.budgetLedgerRef });
  const result = await executeSocialContentMutation({ ...input, operation: 'prepare_social_product_asset_fallback',
    targetId: input.taskId, requestHash,
    replay: async operationId => {
      const row = await requireSocialTask(input);
      const marker = socialObject(socialObject(socialJson(row.brief))?._productAssetFallback);
      if (socialText(row.last_operation_id) !== operationId || marker?.sourcePlanHash !== sourcePlanHash
        || marker?.tenantId !== input.tenantId || marker?.taskId !== input.taskId
        || marker?.sourceTaskVersion !== input.expectedVersion || marker?.productId !== input.productId
        || marker?.failedAssetId !== input.failedAssetId
        || marker?.sourceRunId !== input.sourceRunId || marker?.budgetLedgerRef !== input.budgetLedgerRef
        || socialRequestHash(marker?.revisedPlan) !== marker?.revisedPlanHash)
        throw new SocialContentWorkflowError('product_asset_fallback_recovery_changed', 409);
      return { preparedVersion: socialText(row.version), revisionId: socialText(marker?.revisionId),
        revisedPlanHash: socialText(marker?.revisedPlanHash), authorizesStart: false as const };
    },
    action: async operationId => {
      const row = await requireSocialTask(input);
      const brief = socialObject(socialJson(row.brief));
      const prior = socialObject(brief?._productAssetFallback);
      if (socialText(row.last_operation_id) === operationId && prior?.sourcePlanHash === sourcePlanHash)
        return { preparedVersion: socialText(row.version), revisionId: socialText(prior.revisionId),
          revisedPlanHash: socialText(prior.revisedPlanHash), authorizesStart: false as const };
      if (socialText(row.version) !== input.expectedVersion || socialText(row.run_id) !== input.sourceRunId
        || !brief || prior || !['attention', 'paused'].includes(socialText(row.status)))
        throw new SocialContentWorkflowError('product_asset_fallback_source_changed', 409);
      const store = input.repository.dataStore;
      if (!store?.compareAndSwap) throw new SocialContentWorkflowError('product_asset_fallback_atomic_storage_required', 503);
      const run = await input.repository.get(STARTER_COLLECTIONS.runs, input.tenantId, input.sourceRunId);
      const context = socialObject(socialJson(run?.starter_context));
      if (!run || context?.socialTaskId !== input.taskId || !['failed', 'cancelled', 'completed', 'succeeded'].includes(socialText(run.status)))
        throw new SocialContentWorkflowError('product_asset_fallback_source_run_active', 409);
      const jobs = await store.list<Record<string, unknown>>('content_execution_jobs',
        { where: { tenant_id: input.tenantId, task_id: input.taskId }, page: 1, perPage: 500 });
      if (jobs.totalItems !== jobs.items.length || jobs.items.some(job =>
        ['running', 'queued', 'retry_wait', 'reconciling', 'paused'].includes(String(job.status))
        || Boolean(job.worker_id) || Boolean(job.lease_expires_at)))
        throw new SocialContentWorkflowError('product_asset_fallback_execution_active', 409);
      if (input.sourcePlan.planVersion !== input.expectedVersion || brief.productId !== input.productId)
        throw new SocialContentWorkflowError('product_asset_fallback_product_changed', 409);
      if (socialAssetSupplyPlanIdentityHash(await input.readCurrentPlan()) !== sourcePlanHash)
        throw new SocialContentWorkflowError('product_asset_fallback_source_plan_changed', 409);
      const candidate = await createVerifiedProductAssetFallbackRevision({ ...input, plan: input.sourcePlan });
      if (!candidate) throw new SocialContentWorkflowError('product_asset_fallback_unavailable', 409);
      const version = Number(row.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new SocialContentWorkflowError('product_asset_fallback_version_invalid', 409);
      const revisedPlanHash = socialRequestHash(candidate.plan);
      const marker = { schemaVersion: 'social-product-asset-fallback-prepare.v1',
        tenantId: input.tenantId, taskId: input.taskId, productId: input.productId, failedAssetId: input.failedAssetId,
        sourceRunId: input.sourceRunId,
        sourceTaskVersion: input.expectedVersion, sourcePlanHash, sourcePlan: structuredClone(input.sourcePlan),
        sourceScriptHash: socialRequestHash(socialJson(row.replication_script) ?? null),
        revisionId: candidate.revision.revisionId,
        revisionRecordHash: candidate.revision.recordHash, revision: candidate.revision,
        revisedPlanHash, revisedPlan: candidate.plan,
        budgetLedgerRef: input.budgetLedgerRef, state: 'prepared_not_admitted' };
      const saved = await store.compareAndSwap(STARTER_COLLECTIONS.socialContentTasks, row.id,
        { tenant_id: input.tenantId, version: row.version, last_operation_id: row.last_operation_id, run_id: row.run_id },
        { brief: { ...brief, _productAssetFallback: marker }, version: String(version + 1),
          last_operation_id: operationId, updated_by: input.userId, updated_at: new Date().toISOString() });
      if (!saved) throw new SocialContentWorkflowError('product_asset_fallback_source_changed', 409);
      return { preparedVersion: String(version + 1), revisionId: candidate.revision.revisionId,
        revisedPlanHash, authorizesStart: false as const };
    },
  });
  return result.value;
}

/** Read-side admission for a prepared asset plan. This validates the exact
 * version, same original budget ledger and an affected old first-frame's new
 * provenance, but never enqueues or returns an executable authorization. */
export async function readPreparedSocialProductAssetFallback(input: {
  repository: Starter198Repository; tenantId: string; taskId: string; expectedPreparedVersion: string;
  sourceRunId: string; budgetLedgerRef: string;
  readBudgetLedgerRef: () => Promise<string>;
  readReplacementMaterial: (assetId: string, tenantId: string) => Promise<MaterialRecord | null>;
  readReplacementBytes: (assetId: string, tenantId: string) => Promise<Buffer>;
  oldFirstFrameProvenance?: PresenterFirstFrameAssetProvenance;
}) {
  const row = await requireSocialTask(input);
  const marker = socialObject(socialObject(socialJson(row.brief))?._productAssetFallback);
  const revision = socialObject(marker?.revision);
  const revisedPlan = socialObject(marker?.revisedPlan) as SocialAssetSupplyPlan | null;
  const sourcePlan = socialObject(marker?.sourcePlan) as SocialAssetSupplyPlan | null;
  if (socialText(row.version) !== input.expectedPreparedVersion || !marker || !revision || !revisedPlan
    || marker.schemaVersion !== 'social-product-asset-fallback-prepare.v1'
    || marker.state !== 'prepared_not_admitted' || marker.tenantId !== input.tenantId
    || marker.taskId !== input.taskId || marker.sourceRunId !== input.sourceRunId
    || marker.budgetLedgerRef !== input.budgetLedgerRef || socialText(row.run_id) !== input.sourceRunId
    || !['attention', 'paused'].includes(socialText(row.status))
    || marker.revisionId !== revision.revisionId || marker.revisionRecordHash !== revision.recordHash
    || !sourcePlan || sourcePlan.planVersion !== marker.sourceTaskVersion
    || socialAssetSupplyPlanIdentityHash(sourcePlan) !== marker.sourcePlanHash
    || marker.sourceScriptHash !== socialRequestHash(socialJson(row.replication_script) ?? null)
    || marker.sourcePlanHash === socialAssetSupplyPlanIdentityHash(revisedPlan)
    || socialRequestHash(revisedPlan) !== marker.revisedPlanHash)
    throw new SocialContentWorkflowError('product_asset_fallback_prepared_changed', 409);
  const { recordHash: _recordHash, ...revisionBody } = revision;
  if (socialRequestHash(revisionBody) !== revision.recordHash
    || revision.planVersion !== revisedPlan.planVersion || revision.parentPlanVersion !== sourcePlan.planVersion
    || revision.failedAssetId !== marker.failedAssetId
    || revision.productId !== marker.productId || revision.tenantId !== input.tenantId)
    throw new SocialContentWorkflowError('product_asset_fallback_prepared_corrupt', 409);
  const rebuilt = createProductAssetFallbackRevision({
    tenantId: input.tenantId, productId: String(marker.productId), failedAssetId: String(marker.failedAssetId),
    plan: sourcePlan, materials: [{ id: String(revision.replacementAssetId), tenantId: input.tenantId,
      productId: String(marker.productId), type: 'image', scope: 'own', sourceType: 'enterprise_product_table',
      rightsStatus: 'authorized', rightsEvidenceRef: String(revision.rightsEvidenceRef),
      commercialUseApproved: true, contentSha256: String(revision.replacementSha256) } as MaterialRecord],
    isReadable: () => true, createdAt: String(revision.createdAt),
  });
  if (!rebuilt || socialRequestHash(rebuilt.plan) !== marker.revisedPlanHash
    || rebuilt.revision.recordHash !== marker.revisionRecordHash)
    throw new SocialContentWorkflowError('product_asset_fallback_prepared_corrupt', 409);
  if (await input.readBudgetLedgerRef() !== input.budgetLedgerRef)
    throw new SocialContentWorkflowError('product_asset_fallback_budget_changed', 409);
  const replacement = await input.readReplacementMaterial(String(revision.replacementAssetId), input.tenantId);
  if (!replacement || !isAuthorizedProductFallback(replacement, {
    tenantId: input.tenantId, productId: String(marker.productId), failedAssetId: String(marker.failedAssetId),
  }) || String(replacement.contentSha256 || replacement.contentHash || '').toLowerCase() !== revision.replacementSha256)
    throw new SocialContentWorkflowError('product_asset_fallback_replacement_changed', 409);
  try {
    const bytes = await input.readReplacementBytes(String(revision.replacementAssetId), input.tenantId);
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    if (createHash('sha256').update(bytes).digest('hex') !== revision.replacementSha256
      || !metadata.width || !metadata.height || metadata.width < 64 || metadata.height < 64)
      throw new Error('changed');
  } catch {
    throw new SocialContentWorkflowError('product_asset_fallback_replacement_changed', 409);
  }
  let replacementProvenanceHash: string | null = null;
  if (input.oldFirstFrameProvenance) {
    const old = input.oldFirstFrameProvenance;
    if (!isPresenterFirstFrameAssetProvenance(old))
      throw new SocialContentWorkflowError('product_asset_fallback_old_approval_corrupt', 409);
    const affected = old.products.filter(product => product.productId === marker.productId
      && product.referenceImageIds.includes(String(marker.failedAssetId)));
    if (affected.length !== 1)
      throw new SocialContentWorkflowError('product_asset_fallback_old_approval_unrelated', 409);
    const replacement = String(revision.replacementAssetId);
    const replacementSha = String(revision.replacementSha256);
    const updated = createPresenterFirstFrameAssetProvenance({ presenter: old.presenter, background: old.background,
      products: old.products.map(product => product === affected[0] ? {
        ...product, referenceImageIds: product.referenceImageIds.map(id => id === marker.failedAssetId ? replacement : id),
        referenceImageSha256s: product.referenceImageSha256s.map((sha, index) =>
          product.referenceImageIds[index] === marker.failedAssetId ? replacementSha : sha),
      } : product) });
    if (updated.manifestHash === old.manifestHash)
      throw new SocialContentWorkflowError('product_asset_fallback_old_approval_not_invalidated', 409);
    replacementProvenanceHash = updated.manifestHash;
  }
  return { plan: structuredClone(revisedPlan), preparedVersion: input.expectedPreparedVersion,
    revisedPlanHash: String(marker.revisedPlanHash), budgetLedgerRef: input.budgetLedgerRef,
    replacementProvenanceHash, authorizesStart: false as const };
}
