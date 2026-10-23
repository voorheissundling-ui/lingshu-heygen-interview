import type { SocialAssetSupplyPlan, SocialAssetSupplyShotPlan } from '../../shared/contracts/socialContentWorkflow.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import type { DataStore } from '../storage/datastore.js';
import { readProductionProductFootageSegment } from './socialProductFootageAdmission.js';
import { socialAssetSupplyPlanIdentityHash } from './socialAssetSupplyPlanIdentity.js';
import { socialRequestHash } from './socialContentValidation.js';

type Segment = NonNullable<SocialAssetSupplyShotPlan['selectedMaterialSegment']>;
type Evidence = NonNullable<Segment['footageEvidence']>;

export interface ProductFootageRevision {
  schemaVersion: 'social-product-footage-revision.v1';
  tenantId: string;
  taskId: string;
  sourceRunId: string;
  sourceTaskVersion: string;
  sourcePlanHash: string;
  planVersion: string;
  revisedPlanHash: string;
  budgetLedgerRef: string;
  productId: string;
  shotId: string;
  sourceRef: string;
  segmentId: string;
  evidence: Evidence;
  recordHash: string;
}

type Input = {
  store: DataStore;
  readMaterials: (tenantId: string) => Promise<{ status: 'ready' | 'partial' | 'unavailable'; items: MaterialRecord[] }>;
  tenantId: string;
  taskId: string;
  sourceRunId: string;
  sourceTaskVersion: string;
  budgetLedgerRef: string;
  productId: string;
  sourcePlan: SocialAssetSupplyPlan;
  shotId: string;
  evidence: Evidence;
  /** The authoritative task/plan/ledger reader must be repeated at durable CAS and paid admission. */
  readCurrentPlan: () => Promise<SocialAssetSupplyPlan>;
  readBudgetLedgerRef: () => Promise<string>;
  readReviewedSegment?: typeof readProductionProductFootageSegment;
};

const sha = (value: string) => /^[a-f0-9]{64}$/.test(value);
const fail = (reason: string): never => { throw Error(`product_footage_revision_${reason}`); };

/** Compile an exact-window, same-SKU replacement for a frozen plan that was
 * missing its independent footage finding. This is a candidate, not a task
 * transition, approval, queue admission or provider permit. */
export async function createVerifiedProductFootageRevision(input: Input): Promise<{
  plan: SocialAssetSupplyPlan; revision: ProductFootageRevision;
  authorizesQueue: false; authorizesProvider: false; authorizesProduction: false;
}> {
  if (!input.tenantId || !input.taskId || !input.sourceRunId || !input.sourceTaskVersion
    || !input.budgetLedgerRef || !input.productId || !input.shotId
    || !sha(input.evidence?.contentSha256 ?? '') || input.evidence.productId !== input.productId)
    return fail('input_invalid');
  const sourcePlanHash = socialAssetSupplyPlanIdentityHash(input.sourcePlan);
  if (input.sourcePlan.planVersion !== input.sourceTaskVersion
    || socialAssetSupplyPlanIdentityHash(await input.readCurrentPlan()) !== sourcePlanHash)
    return fail('source_plan_changed');
  if (await input.readBudgetLedgerRef() !== input.budgetLedgerRef) return fail('budget_changed');
  const matches = input.sourcePlan.shots.filter(shot => shot.shotId === input.shotId);
  if (matches.length !== 1) return fail('shot_missing_or_ambiguous');
  const sourceShot = matches[0]!;
  const segment = sourceShot.selectedMaterialSegment;
  if (!segment || segment.footageEvidence || !sourceShot.sourceRefs.includes(segment.sourceRef)
    || sourceShot.materialRouting?.materialType !== 'product'
    || sourceShot.materialRouting?.policy !== 'local_only'
    || sourceShot.materialRouting.localMatch.productRef !== input.productId
    || sourceShot.materialRouting.localMatch.state !== 'matched'
    || !sourceShot.materialRouting.localMatch.sourceRefs.includes(segment.sourceRef))
    return fail('source_shot_not_reviewable');
  const read = input.readReviewedSegment ?? readProductionProductFootageSegment;
  const admitted = await read({
    store: input.store, readMaterials: input.readMaterials,
    tenantId: input.tenantId, productId: input.productId, materialId: segment.sourceRef,
    sceneFunction: input.evidence.sceneFunction, segmentId: segment.segmentId,
    startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
    expectedContentSha256: input.evidence.contentSha256,
    expectedApprovalId: input.evidence.approvalId,
    expectedVisualFindingId: input.evidence.visualFindingId,
  }).catch(() => null);
  if (!admitted || admitted.segmentId !== segment.segmentId
    || admitted.startSeconds !== segment.startSeconds || admitted.endSeconds !== segment.endSeconds
    || admitted.material.id !== segment.sourceRef
    || admitted.material.productId !== input.productId
    || admitted.material.contentSha256 !== input.evidence.contentSha256)
    return fail('review_not_current');
  // No creative rewrite, alternate footage window or altered speech ownership.
  const revisedPlan: SocialAssetSupplyPlan = structuredClone(input.sourcePlan);
  const target = revisedPlan.shots.find(shot => shot.shotId === input.shotId)!;
  target.selectedMaterialSegment = { ...structuredClone(segment), footageEvidence: structuredClone(input.evidence) };
  const identity = { tenantId: input.tenantId, taskId: input.taskId, sourceRunId: input.sourceRunId,
    sourceTaskVersion: input.sourceTaskVersion, sourcePlanHash, budgetLedgerRef: input.budgetLedgerRef,
    productId: input.productId, shotId: input.shotId, sourceRef: segment.sourceRef,
    segmentId: segment.segmentId, evidence: structuredClone(input.evidence) };
  revisedPlan.planVersion = `${input.sourcePlan.planVersion}:footage-review:${socialRequestHash(identity).slice(0, 12)}`;
  const revisedPlanHash = socialAssetSupplyPlanIdentityHash(revisedPlan);
  if (revisedPlanHash === sourcePlanHash) return fail('revision_not_distinct');
  // Admission may be revoked between compilation and return. A later durable
  // handoff must call this reader again; this second check narrows that race.
  if (socialAssetSupplyPlanIdentityHash(await input.readCurrentPlan()) !== sourcePlanHash
    || await input.readBudgetLedgerRef() !== input.budgetLedgerRef) return fail('source_changed');
  const checked = await read({
    store: input.store, readMaterials: input.readMaterials,
    tenantId: input.tenantId, productId: input.productId, materialId: segment.sourceRef,
    sceneFunction: input.evidence.sceneFunction, segmentId: segment.segmentId,
    startSeconds: segment.startSeconds, endSeconds: segment.endSeconds,
    expectedContentSha256: input.evidence.contentSha256,
    expectedApprovalId: input.evidence.approvalId,
    expectedVisualFindingId: input.evidence.visualFindingId,
  }).catch(() => null);
  if (!checked || checked.segmentId !== segment.segmentId
    || checked.startSeconds !== segment.startSeconds || checked.endSeconds !== segment.endSeconds
    || checked.material.id !== segment.sourceRef || checked.material.productId !== input.productId
    || checked.material.contentSha256 !== input.evidence.contentSha256) return fail('review_changed');
  const body = { schemaVersion: 'social-product-footage-revision.v1' as const,
    ...identity, planVersion: revisedPlan.planVersion, revisedPlanHash };
  return { plan: revisedPlan, revision: { ...body, recordHash: socialRequestHash(body) },
    authorizesQueue: false, authorizesProvider: false, authorizesProduction: false };
}

/** Reconstruct a stored candidate from current source and signed evidence.
 * A persisted marker's own hash cannot authorize a revoked visual finding. */
export async function readVerifiedProductFootageRevision(input: Input & {
  storedPlan: SocialAssetSupplyPlan; storedRevision: ProductFootageRevision;
}): Promise<{ plan: SocialAssetSupplyPlan; revision: ProductFootageRevision;
  authorizesQueue: false; authorizesProvider: false; authorizesProduction: false }> {
  const { recordHash, ...body } = input.storedRevision;
  if (recordHash !== socialRequestHash(body)
    || input.storedRevision.schemaVersion !== 'social-product-footage-revision.v1'
    || input.storedRevision.tenantId !== input.tenantId
    || input.storedRevision.taskId !== input.taskId
    || input.storedRevision.sourceRunId !== input.sourceRunId
    || input.storedRevision.sourceTaskVersion !== input.sourceTaskVersion
    || input.storedRevision.productId !== input.productId
    || input.storedRevision.shotId !== input.shotId
    || input.storedRevision.budgetLedgerRef !== input.budgetLedgerRef
    || socialRequestHash(input.storedRevision.evidence) !== socialRequestHash(input.evidence))
    return fail('stored_identity_changed');
  const current = await createVerifiedProductFootageRevision(input);
  if (socialRequestHash(current.revision) !== socialRequestHash(input.storedRevision)
    || socialAssetSupplyPlanIdentityHash(current.plan) !== socialAssetSupplyPlanIdentityHash(input.storedPlan)
    || current.revision.revisedPlanHash !== socialAssetSupplyPlanIdentityHash(input.storedPlan))
    return fail('stored_candidate_changed');
  return current;
}
