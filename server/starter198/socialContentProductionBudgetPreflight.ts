import {readHeyGenPublishedTariff} from '../lib/heygenPublishedPricing.js';
import {heyGenRuntimeRouteEvidence,readTrustedHeyGenRuntimeBinding,type TrustedHeyGenRuntimeBinding} from './socialContentHeyGenRuntimeBinding.js';
import {readSeedreamPublishedTariff} from '../lib/seedreamPublishedPricing.js';
import {readNativeVoicePublishedTariff} from '../lib/studioVoicePublishedPricing.js';
import {readWanPublishedTariff} from '../lib/wanPublishedPricing.js';
import fs from 'node:fs';
import {getQwenProviderBinding} from '../agents/qwen.js';
import {createQwenMaaSPublishedTariffReader,createSocialContentLocalPublishedTariffReader} from '../lib/socialContentPublishedTariffs.js';
import path from 'node:path';
import os from 'node:os';
import {createProductionBudgetRouteReaders,type CanonicalProductBudgetBounds} from './socialContentProductionBudgetRoutes.js';
import {readProductReplacementRequestBounds} from './socialContentProductReplacementEnvironment.js';
import {createSocialContentLocalSupplyBudgetProofReader} from './socialContentLocalSupplyBudgetProof.js';
import { createSocialContentPaidOperationPermit } from '../lib/socialContentPaidOperationPermit.js';
import { createHash } from 'node:crypto';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { readSocialTaskDetail, requireSocialTask } from './socialContentRecords.js';
import { socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';
import { hasCompleteFootageRevisionProductionAdmission, readContentExecutionJob } from '../contentExecution/durableQueue.js';
import { assertCurrentContentExecutionActive, assertSocialContentOrderActive, recordCurrentContentExecutionCheckpoint } from '../contentExecution/context.js';
import { socialMaterialAnalysisInputHash } from './socialContentProductionCheckpoints.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';
import type { StoredSocialScriptBaseline } from './socialContentScriptBaseline.js';
import type { SocialGraphApprovedContext } from './socialContentProductionExecution.js';
import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentReplication.js';
import { appendPresenterFirstFrameCorrectionAttempts, createSocialContentPaidOperationPlanner, paidProductionApprovalHash, paidProductionRecordHash, paidProductionHash, presenterGroupContractHash, type FrozenPaidProduction, type FrozenPresenterGroup, type PaidOperationPlannerPorts, type BoundPaidRoute, type PaidStageRequirement } from './socialContentPaidOperationPlan.js';
import { createSocialContentTaskBudgetAuthority, quoteSocialPaidOperationTariff, socialPaidIntentOperation, type SocialApprovedBudgetPlan, type SocialPaidOperationIntent, type SocialVerifiedAccountTariff } from '../lib/socialContentTaskBudgetAuthority.js';
import { createSocialContentVerifiedTariffReader } from '../lib/socialContentVerifiedTariffs.js';
import { SocialContentTaskBudget, type SocialTaskBudgetScope } from '../lib/socialContentTaskBudget.js';
import {resolveSocialContentCostLineage} from './socialContentCostLineage.js';
import {automaticallyConfirmPresenterFirstFrameApproval,readConfirmedPresenterFirstFrameApproval} from './socialContentPresenterFirstFrameApproval.js';
import {isInternalBudgetExemptTenant} from '../lib/tenantBudgetExemption.js';
import {currentPresenterFirstFrameAssetProvenanceHash} from './socialContentPresenterFirstFrameRuntime.js';
import {carryForwardWeeklyCandidateExactProductionCost} from '../runtime/weeklyCandidateExactProductionEscrowPorts.js';
export interface ProductionBudgetReadPorts {
    /** Trusted readonly runtime/account readers. Never task/body supplied manifests. */
    resolveBoundRoute?: PaidOperationPlannerPorts['resolveBoundRoute'];
    readVerifiedLocalExecution?: PaidOperationPlannerPorts['readVerifiedLocalExecution'];
    readProductFrameBounds?: PaidOperationPlannerPorts['readProductFrameBounds'];
    readVoicePlan?: (baseline: StoredSocialScriptBaseline) => Promise<FrozenPaidProduction['voice'] | null>;
    readAnalysisFrames?: (asset: SocialProductionAsset) => Promise<{
        frameCount: number;
        batchFrameCounts: number[];
    } | null>;
    readTariff?: (operation: Parameters<ReturnType<typeof createSocialContentVerifiedTariffReader>['read']>[0]) => Promise<SocialVerifiedAccountTariff | null>;
    readDirectedProductRetryShotIds?: (input: {scope: SocialTaskBudgetScope; shots: SocialAssetSupplyPlan['shots']; priorPlan: unknown}) => Promise<string[]>;
    /** Trusted explicit-user decision reader. A task/body `confirmed:true` is never authority. */
    readConfirmedPresenterFirstFrame?: (input:{scope:SocialTaskBudgetScope;group:FrozenPresenterGroup})=>Promise<Awaited<ReturnType<typeof readConfirmedPresenterFirstFrameApproval>>>;
    /** Produces the paid review images only after the complete whole-film
     * reservation exists. Dynamic presenter video remains confirmation-gated. */
    preparePresenterFirstFrameReviews?: (input:{scope:SocialTaskBudgetScope;groups:FrozenPresenterGroup[];requirements:PaidStageRequirement[];intents:SocialApprovedBudgetPlan['paidOperations'];paidPermit:ReturnType<typeof createSocialContentPaidOperationPermit>})=>Promise<void>;
    ledgerRoot?: string;
    carryForwardWeeklyExactCost?: typeof carryForwardWeeklyCandidateExactProductionCost;
    /** Pre-bound server-only v2 carry seam. The composition layer must close
     * over integrity/audit/head dependencies; task and request data can never
     * supply them through this narrow business-context port. */
    carryForwardWeeklyExactCostV2?: (input:{
        store: NonNullable<Starter198Repository['dataStore']>;
        scope: SocialTaskBudgetScope;
        taskRow: Awaited<ReturnType<typeof requireSocialTask>>;
        budget: SocialContentTaskBudget;
        mode: 'read'|'carry';
    })=>Promise<unknown>;
    /** Authoritative weekly claim recheck immediately before any new paid POST claim. */
    assertNewSubmit?: () => Promise<void>;
}
export interface ProductionBudgetPreflightInput {
    repository: Starter198Repository;
    tenantId: string;
    taskId: string;
    runId: string;
    baseline: StoredSocialScriptBaseline;
    assets: SocialProductionAsset[];
    /** Exact owned inputs consumed by a local supply adapter without requiring
     * a separate semantic-analysis purchase. */
    localSupplyAssets?: SocialProductionAsset[];
    supplyPlan: SocialAssetSupplyPlan | null;
    graphApprovedContext?: SocialGraphApprovedContext;
    recoveryOnly?: boolean;
    /** Read canonical prices and retained spend without reservations, checkpoints
     * or provider submissions. Used to allocate the whole-film residual. */
    quoteOnly?: boolean;
    ports?: ProductionBudgetReadPorts;
}
const STAGE = 'social.whole_film_budget';
const error = (gap: string): never => { throw Error(`user_input_required:whole_film_budget_preflight:${gap}`); };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export function formalPaidRouteExceedsInternalBudget(tenantId: string, amountCny: number, maximumCny: number) {
    return !isInternalBudgetExemptTenant(tenantId) && (amountCny > maximumCny || amountCny > 10);
}
async function readOrAutomaticallyConfirmPresenterFirstFrame(store:NonNullable<Starter198Repository['dataStore']>,scope:SocialTaskBudgetScope,group:FrozenPresenterGroup){const approvals=await store.list<any>('social_presenter_first_frame_approvals',{where:{tenant_id:scope.tenantId,task_id:scope.taskId,run_id:scope.runId,plan_hash:scope.planHash,group_id:group.groupId},perPage:2});if(approvals.totalItems!==1||approvals.items.length!==1)return null;const approval=approvals.items[0]?.payload;if(!approval?.qa?.passed||approval.presenterGroupContractHash!==group.contractHash||approval.presenter?.assetId!==group.presenterAssetId||approval.recordHash!==approvals.items[0]?.record_hash)return null;const expectedAssetProvenanceHash=await currentPresenterFirstFrameAssetProvenanceHash(store,{tenantId:scope.tenantId,approval});if(!expectedAssetProvenanceHash)return null;const query={scope,groupId:group.groupId,presenterGroupContractHash:group.contractHash,presenterAssetId:group.presenterAssetId,expectedAssetProvenanceHash};const existing=await readConfirmedPresenterFirstFrameApproval(store,query);if(existing)return existing;await automaticallyConfirmPresenterFirstFrameApproval(store,{scope,groupId:group.groupId,expectedRecordHash:approval.recordHash});return readConfirmedPresenterFirstFrameApproval(store,query);}
const paidBaselineContractHash = (baseline: StoredSocialScriptBaseline) => socialRequestHash({
  language: baseline.language,
  scenes: baseline.scenes.map(scene => ({sceneId: scene.sceneId,
    narration: scene.narration || '', voiceover: scene.voiceover || ''})),
});
function readDirectedProductRetryShotIds(input: {scope: SocialTaskBudgetScope; shots: SocialAssetSupplyPlan['shots']; priorPlan: unknown}) {
    const prior = socialObject(input.priorPlan), operations = Array.isArray(prior?.paidOperations) ? prior.paidOperations.map(socialObject) : [];
    const root = path.resolve('data/social-product-replacement-executions');
    const prefix = path.join(root, sha(input.scope.tenantId), sha(input.scope.taskId), sha(input.scope.runId));
    const retryShots: string[] = [];
    for (const shot of input.shots) {
        if (shot.sourceStrategy !== 'aigc_product_scene_replication' || shot.productSceneReplication?.validation.singleShotRetryOnFailure !== true) continue;
        const attempt0 = operations.find(operation => operation?.shotId === shot.shotId && operation?.stage === 'video_qa');
        const shotRoot = path.join(prefix, sha(shot.shotId));
        if (!attempt0?.operationId || !fs.existsSync(shotRoot)) continue;
        let proven = false;
        for (const execution of fs.readdirSync(shotRoot)) {
            const qaRoot = path.join(shotRoot, execution, 'video-qa');
            if (!fs.existsSync(qaRoot)) continue;
            for (const name of fs.readdirSync(qaRoot).filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
                try {
                    const receipt = socialObject(JSON.parse(fs.readFileSync(path.join(qaRoot, name), 'utf8'))), report = socialObject(receipt?.report), funding = socialObject(receipt?.funding);
                    if (receipt?.state === 'completed' && funding?.paidOperationId === attempt0.operationId && funding?.inputContractHash === attempt0.inputContractHash
                        && report?.passed === false && report?.status === 'retry_video') proven = true;
                } catch { /* malformed evidence never authorizes a retry */ }
            }
        }
        if (proven) retryShots.push(shot.shotId);
    }
    return retryShots;
}
export function productRetryReservationShotIds(shots: SocialAssetSupplyPlan['shots'], priorFailureShotIds: string[]) {
    const eligible = shots.filter(shot => shot.sourceStrategy === 'aigc_product_scene_replication'
        && shot.productSceneReplication?.validation.singleShotRetryOnFailure === true).map(shot => shot.shotId);
    return [...new Set([...eligible, ...priorFailureShotIds])].filter(id => eligible.includes(id));
}
async function bytesHash(asset: SocialProductionAsset) {
    if (!asset.localPath)
        return null;
    try {
        const h = createHash('sha256');
        for await (const part of fs.createReadStream(asset.localPath))
            h.update(part);
        return h.digest('hex');
    }
    catch {
        return null;
    }
}
/** Called BEFORE material analysis, not merely before video submission. This
 * gate reads approved task facts and never creates prices, approvals or media. */
export async function prepareSocialContentProductionBudget(input: ProductionBudgetPreflightInput) {
    const row = await requireSocialTask(input), brief = socialObject(socialJson(row.brief));
    if(input.repository.dataStore)await assertSocialContentOrderActive(input.repository.dataStore,input.tenantId,input.taskId);
    const footageRevision=socialObject(brief?._productFootageRevision);
    // Historical frozen jobs retain their existing admission and recovery contracts.
    if (!['type-aware.v1', 'type-aware.v2'].includes(String(brief?.materialRoutingPolicyVersion))&&!brief?._productionRevision&&!brief?._weeklyCreativeRepairProof&&!brief?._weeklyAuthority
        &&!(footageRevision&&input.runId!==socialText(footageRevision.sourceRunId)))
        return { status: 'legacy' as const };
    const store = input.repository.dataStore;
    if (!store)
        return error('canonical_store_missing');
    const costLineage=await resolveSocialContentCostLineage(input);
    const inheritedBudgetScope=costLineage.budgetTaskId===input.taskId?{}:{budgetTaskId:costLineage.budgetTaskId};
    if(costLineage.kind==='creative_repair'){
      const order=socialObject(socialJson(row.content_order));
      if(order?.contentId!==costLineage.contentId||order?.budgetTaskId!==costLineage.budgetTaskId)return error('revision_content_order_not_bound');
      const childLedger=new SocialContentTaskBudget(input.ports?.ledgerRoot,{authorization:async()=>error('read_only'),quote:async()=>error('read_only'),assertCurrent:async()=>{},verifyRejection:async()=>false})
        .status({tenantId:input.tenantId,taskId:input.taskId,runId:input.runId,planHash:'0'.repeat(64)});
      if(childLedger?.entries.length)return error('revision_existing_child_ledger_requires_reconciliation');
    }
    const job = await readContentExecutionJob(store, input.tenantId, input.taskId, input.runId);
    if (!job)
        return error('canonical_job_missing');
    if(footageRevision&&input.runId!==socialText(footageRevision.sourceRunId)){
      if(!hasCompleteFootageRevisionProductionAdmission(job,footageRevision))return error('product_footage_revision_admission_changed');
      const run=await input.repository.get(STARTER_COLLECTIONS.runs,input.tenantId,input.runId);
      const freeze=socialObject(socialObject(socialJson(run?.starter_context))?.paidPlanFreeze);
      const plan=socialObject(freeze?.canonicalPlan) as import('./socialContentProductFootageRevisionPaidPreflight.js').SocialProductFootageRevisionCanonicalPlan|null;
      const adapter=socialObject(plan?.productionAdapter),scope=plan?.scope;
      const admission=socialObject(job.checkpoints['social.footage_revision_worker_admission']?.payload);
      if(!freeze||freeze.schemaVersion!=='social-product-footage-revision-paid-plan-freeze.v1'||!plan||!scope
        ||socialRequestHash(plan)!==freeze.planHash||admission?.paidPlanFreezeHash!==freeze.recordHash
        ||admission?.canonicalPlanHash!==socialRequestHash(plan)||scope.tenantId!==input.tenantId
        ||scope.taskId!==input.taskId||scope.runId!==input.runId||scope.planHash!==plan.revisedPlanHash
        ||scope.budgetTaskId!==undefined||plan.maximumCny!==10
        ||adapter?.schemaVersion!=='social-product-footage-revision-production-budget.v1')
        return error('product_footage_revision_paid_plan_adapter_invalid');
      const requirements=Array.isArray(adapter.requirements)?adapter.requirements as PaidStageRequirement[]:[];
      const routeBindings=socialObject(adapter.routeBindings) as Record<string,BoundPaidRoute>|null;
      const quotes=socialObject(adapter.quotes) as Record<string,import('../lib/socialContentTaskBudget.js').SocialTaskBudgetQuote>|null;
      if(!requirements.length||!routeBindings||!quotes||requirements.length!==plan.paidOperations.length)
        return error('product_footage_revision_paid_plan_adapter_invalid');
      const operations=plan.paidOperations.map(intent=>socialPaidIntentOperation(scope,intent));
      for(const intent of plan.paidOperations){
        const matches=requirements.filter(requirement=>requirement.stage===intent.stage&&requirement.shotId===intent.shotId);
        const requirement=matches[0],route=requirement&&routeBindings[requirement.key];
        if(matches.length!==1||!route||intent.provider!==route.provider||intent.model!==route.model
          ||intent.accountRef!==route.accountRef||paidProductionHash(intent.maximumUnits)!==paidProductionHash(route.maximumUnits)
          ||intent.inputContractHash!==paidProductionHash({requirement,route,attempt:0})
          ||intent.operationId!==`paid-plan:${paidProductionHash({scope,key:requirement.key,attempt:0})}`
          ||!quotes[intent.operationId])return error('product_footage_revision_paid_plan_adapter_invalid');
      }
      const ledger=new SocialContentTaskBudget(input.ports?.ledgerRoot,{authorization:async()=>error('product_footage_revision_never_authorizes'),
        quote:async()=>error('product_footage_revision_never_quotes'),assertCurrent:async()=>{},verifyRejection:async()=>false});
      const status=ledger.status(scope);
      const entries=status?.entries.filter(entry=>entry.runId===scope.runId&&entry.planHash===scope.planHash&&entry.status!=='rejected')??[];
      if(!status||status.limitCny!==10||status.authorizedLimitCny!==10||status.hasCorrectionAuthorization
        ||entries.length!==operations.length||operations.some(operation=>{const entry=entries.find(row=>row.operationId===operation.operationId),quote=quotes[operation.operationId];return !entry||entry.fingerprint!==operation.fingerprint
          ||!quote||quote.quoteRef!==entry.quoteRef||Math.round(quote.upperBoundCny*1e6)!==entry.reservedMicros
          ||!Number.isFinite(Date.parse(quote.validUntil));}))
        return error('product_footage_revision_original_ten_yuan_ledger_changed');
      const assertRevisionCurrent=async()=>{
        await assertCurrentContentExecutionActive();
        const current=await readContentExecutionJob(store,input.tenantId,input.taskId,input.runId);
        const currentRun=await input.repository.get(STARTER_COLLECTIONS.runs,input.tenantId,input.runId);
        const currentFreeze=socialObject(socialObject(socialJson(currentRun?.starter_context))?.paidPlanFreeze);
        if(!current||current.id!==job.id||!hasCompleteFootageRevisionProductionAdmission(current,footageRevision)
          ||socialRequestHash(currentFreeze)!==socialRequestHash(freeze))return error('product_footage_revision_authority_changed');
      };
      const paidPermit=createSocialContentPaidOperationPermit({scope,operations:entries,intents:plan.paidOperations,ledger,
        root:path.join(input.ports?.ledgerRoot||process.env.SOCIAL_CONTENT_TASK_BUDGET_DIR||'data/social-content-task-budget','.permits'),
        assertCurrent:assertRevisionCurrent,
        assertNewSubmit:async()=>{
          await assertRevisionCurrent();
          if(!input.ports?.assertNewSubmit)
            return error('product_footage_revision_current_provider_authority_adapter_required');
          await input.ports.assertNewSubmit();
        }});
      return {status:'reserved' as const,scope,reserved:{scope,operations:entries,intents:plan.paidOperations,
        quotes,status,ledger},paidPermit,requirements,routeBindings};
    }
    if (socialText(row.run_id) !== input.runId)
        return error('run_superseded');
    const graph = await import('./socialContentProductionGraph.js');
    const loadDetail = () => input.graphApprovedContext ? graph.readSocialProductionGraphDetail(input, input.graphApprovedContext) : readSocialTaskDetail(input);
    const detail = await loadDetail();
    if (!detail?.agentWorkflow || !input.supplyPlan)
        return error('approved_execution_missing');
    const approved = input.graphApprovedContext?.agentWorkflow || detail.agentWorkflow, review = approved.executionPlanReview, plan = approved.executionPlan;
    if (!review.approved || review.executionPlanId !== plan.executionPlanId || review.executionPlanVersion !== plan.version || review.directorBriefId !== approved.directorBrief.directorBriefId || review.directorBriefVersion !== approved.directorBrief.version)
        return error('approved_review_changed');
    const baselineHash = socialRequestHash(input.baseline);
    if (socialRequestHash(socialJson(row.script_baseline)) !== baselineHash)
        return error('baseline_authority_changed');
    const binding = socialObject(job.checkpoints['social.executor']?.payload);
    const prior = job.checkpoints[STAGE];
    const priorPayload = socialObject(prior?.payload);
    // A retry of the same run must retain its original paid-operation scope.
    // Task status timestamps and legacy version counters are not provider
    // inputs and must never create a second set of reservations.
    const priorPlanHash = prior?.inputHash && /^[a-f0-9]{64}$/.test(prior.inputHash)
      && priorPayload?.baselineHash === baselineHash ? prior.inputHash : null;
    const calculatedPlanHash = priorPlanHash || (typeof binding?.inputHash === 'string' && /^[a-f0-9]{64}$/.test(binding.inputHash) ? binding.inputHash : paidProductionHash({ baselineHash, plan, review, supplyPlan: input.supplyPlan }));
    // The ledger is the durable financial authority. If an interrupted worker
    // wrote a newer planning checkpoint through a different working directory,
    // keep the single already-funded scope for this same run.
    let ledgerProbe = new SocialContentTaskBudget(input.ports?.ledgerRoot, {
      authorization: async()=>{throw Error('budget_probe_read_only');}, quote:async()=>{throw Error('budget_probe_read_only');},
      assertCurrent:async()=>{},verifyRejection:async()=>false,
    }).status({tenantId:input.tenantId,taskId:input.taskId,...inheritedBudgetScope,runId:input.runId,planHash:calculatedPlanHash});
    const fundedPlanHashes=[...new Set((ledgerProbe?.entries||[]).filter(entry=>(entry.executionTaskId??costLineage.budgetTaskId)===input.taskId&&entry.runId===input.runId&&entry.status!=='rejected').map(entry=>entry.planHash))];
    const planHash = fundedPlanHashes.length===1 ? fundedPlanHashes[0]! : calculatedPlanHash;
    const graphBindingHash=input.graphApprovedContext?graph.socialProductionGraphInput(detail,input.graphApprovedContext).inputHash:null;
    if (input.graphApprovedContext && graphBindingHash !== planHash&&!graph.matchesAuthorizedCorrectionContext(job,input.graphApprovedContext,planHash,ledgerProbe?.correctionAuthorization?.recordHash,graphBindingHash || undefined))
        return error('graph_binding_changed');
    const initialWorkflowHash = socialRequestHash({ plan: detail.agentWorkflow.executionPlan, review: detail.agentWorkflow.executionPlanReview, director: detail.agentWorkflow.directorBrief });
    const scope: SocialTaskBudgetScope = { tenantId: input.tenantId, taskId: input.taskId, ...inheritedBudgetScope,runId: input.runId, planHash };
    const assertCurrent = async () => {
        await assertCurrentContentExecutionActive();
        await assertSocialContentOrderActive(store,input.tenantId,input.taskId);
        const liveLineage=await resolveSocialContentCostLineage(input);
        if(liveLineage.lineageHash!==costLineage.lineageHash)return error('revision_cost_lineage_changed');
        const current = await requireSocialTask(input);
        if (socialText(current.run_id) !== input.runId || socialRequestHash(socialObject(socialJson(current.brief))) !== socialRequestHash(brief))
            return error('task_authority_changed');
        const live = await loadDetail();
        if (!live?.agentWorkflow || (input.graphApprovedContext ? graph.socialProductionGraphInput(live, input.graphApprovedContext).inputHash !== graphBindingHash : socialRequestHash({ plan: live.agentWorkflow.executionPlan, review: live.agentWorkflow.executionPlanReview, director: live.agentWorkflow.directorBrief }) !== initialWorkflowHash))
            return error('approved_review_changed');
        const active = await readContentExecutionJob(store, input.tenantId, input.taskId, input.runId);
        if (!active || active.id !== job.id || ['cancelled', 'failed'].includes(active.status))
            return error('job_authority_changed');
    };
    const exactCostWeeklyAuthority=socialObject(brief?._weeklyAuthority);
    if(exactCostWeeklyAuthority&&costLineage.kind==='original'){
      const preproductionBudget=new SocialContentTaskBudget(input.ports?.ledgerRoot,{
        authorization:async()=>({maximumCny:Number(brief?.perItemBudgetCny),authorizationRef:`weekly-production:${socialRequestHash(exactCostWeeklyAuthority)}`}),
        quote:async()=>{throw Error('weekly_preproduction_carry_never_quotes');},assertCurrent,verifyRejection:async()=>false,
      });
      const carryMode=input.quoteOnly?'read':'carry';
      if(input.ports?.carryForwardWeeklyExactCostV2){
        await input.ports.carryForwardWeeklyExactCostV2({store,scope,taskRow:row,budget:preproductionBudget,mode:carryMode});
      }else{
        const exactEscrowRoot=process.env.WEEKLY_CANDIDATE_EXACT_LEDGER_ROOT?.trim()||process.env.SOCIAL_CONTENT_TASK_BUDGET_DIR?.trim()||'';
        await (input.ports?.carryForwardWeeklyExactCost??carryForwardWeeklyCandidateExactProductionCost)({store,escrowRoot:exactEscrowRoot,scope,taskRow:row,budget:preproductionBudget,mode:carryMode});
      }
      ledgerProbe=preproductionBudget.status(scope);
    }
    // Once this run has a frozen whole-film reservation, every later execution
    // is recovery. Re-planning could append newly priced operations after local
    // code or routing changes and spend beyond the user's original cap.
    if (input.quoteOnly && (input.recoveryOnly || prior)) return error('quote_requires_unfunded_plan');
    if (input.recoveryOnly || prior) {
        // Read-only recovery cannot obtain a new quote, reserve or reset task expenses.
        if (!prior || prior.inputHash !== planHash)
            return error('existing_whole_film_reservation_missing');
        const payload = socialObject(prior.payload);
        if (payload?.scopeHash !== paidProductionHash(scope))
            return error('existing_reservation_scope_changed');
        const frozenRequirements = Array.isArray(payload.requirements) ? payload.requirements as PaidStageRequirement[] : null;
        const currentPaidBaselineHash = paidBaselineContractHash(input.baseline);
        let baselineCompatible = payload?.baselineHash === baselineHash
          || payload?.paidBaselineContractHash === currentPaidBaselineHash;
        // Checkpoints created before the paid-field contract was introduced can
        // be recovered only when the currently resolved voice route produces
        // the exact same frozen TTS request text. This accepts harmless record
        // serialization drift while still rejecting any paid speech change.
        if (!baselineCompatible && !payload?.paidBaselineContractHash && frozenRequirements && input.ports?.readVoicePlan) {
          const currentVoice = await input.ports.readVoicePlan(input.baseline);
          const frozenTts = frozenRequirements.filter(item => item.stage === 'tts').map(item => item.text || '');
          const currentTts = currentVoice?.mode === 'sentences' ? currentVoice.lines
            : currentVoice && currentVoice.mode !== 'none' && currentVoice.mode !== 'reuse'
              ? [currentVoice.lines.join(' ').trim()] : [];
          baselineCompatible = frozenTts.length === currentTts.length
            && frozenTts.every((text, index) => text === currentTts[index]);
        }
        if (!baselineCompatible)
          return error('existing_reservation_paid_baseline_changed');
        const ledger = new SocialContentTaskBudget(input.ports?.ledgerRoot, { authorization: async () => { throw Error('recovery_never_authorizes'); }, quote: async () => { throw Error('recovery_never_quotes'); }, assertCurrent, verifyRejection: async () => false });
        const status = ledger.status(scope);
        if (!status || !Array.isArray(payload.operationIds) || payload.operationIds.some(id => !status.entries.some(e => e.operationId === id && e.runId === scope.runId && e.planHash === scope.planHash)))
            return error('existing_reservation_corrupt');
        const frozenPlan = payload.plan as SocialApprovedBudgetPlan | undefined;
        const requirements = frozenRequirements;
        const routeBindings = socialObject(payload.routeBindings) as Record<string, BoundPaidRoute> | null;
        const quotes = socialObject(payload.quotes) as Record<string, import('../lib/socialContentTaskBudget.js').SocialTaskBudgetQuote> | null;
        if (!frozenPlan || paidProductionHash(frozenPlan.scope) !== paidProductionHash(scope)
          || !Array.isArray(frozenPlan.paidOperations) || !requirements || !routeBindings || !quotes)
            return error('existing_reservation_contract_missing');
        const correction=status.correctionAuthorization;
        const currentVoice = await input.ports?.readVoicePlan?.(input.baseline);
        if(correction?.correctionCause==='approved_first_frame_not_consumed_and_bound_voice_mismatch'&&!currentVoice?.presenterBinding)return error('presenter_correction_bound_voice_missing');
        if (currentVoice?.presenterBinding) {
          const bound = currentVoice.presenterBinding;
          const combined=correction?.correctionCause==='approved_first_frame_not_consumed_and_bound_voice_mismatch';
          // Historic checkpoints predate presenterVoiceBinding and froze the
          // wrong generic TTS route. The scope-bound combined correction is
          // the formal authorization to replace that route, so it must be
          // validated against the correction record instead of the stale
          // checkpoint. Ordinary recovery remains exact and fail closed.
          if (!combined && paidProductionHash(payload.presenterVoiceBinding || null) !== paidProductionHash(bound)) return error('selected_presenter_voice_changed_requires_formal_replan');
          const voiceRequirement = requirements.find(item=>item.key==='voice:0:tts');
          if (!voiceRequirement) return error('selected_presenter_voice_changed_requires_formal_replan');
          const currentRoute = await input.ports?.resolveBoundRoute?.(voiceRequirement);
          if (!currentRoute || !bound.voiceId || (combined?(bound.voiceId!==correction.selectedVoiceId||bound.fingerprint!==correction.selectedVoiceFingerprint||currentRoute.provider!=='heygen'||currentRoute.model!=='starfish'):paidProductionHash(currentRoute) !== paidProductionHash(routeBindings['voice:0:tts']))) return error('selected_presenter_voice_changed_requires_formal_replan');
        }
        const operationIds = payload.operationIds as string[];
        const recoveryPresenterGroups=frozenPlan.presenterGroups?.length ? frozenPlan.presenterGroups : requirements
          .filter(requirement => requirement.stage === 'presenter_video' && requirement.presenterGroupId
            && requirement.presenterGroupShotIds?.length && requirement.presenterAssetId
            && requirement.presenterGroupContractHash && requirement.durationSeconds && requirement.text)
          .map(requirement => ({groupId: requirement.presenterGroupId!, shotIds: [...requirement.presenterGroupShotIds!],
            durationSeconds: requirement.durationSeconds!, spokenText: requirement.text!,
            presenterAssetId: requirement.presenterAssetId!, contractHash: requirement.presenterGroupContractHash!}));
        const approvalReader=input.ports?.readConfirmedPresenterFirstFrame??(async({scope,group}:{scope:SocialTaskBudgetScope;group:FrozenPresenterGroup})=>readOrAutomaticallyConfirmPresenterFirstFrame(store,scope,group));
        const confirmedApprovals=new Map<string,Awaited<ReturnType<typeof readConfirmedPresenterFirstFrameApproval>>>();
        for(const group of recoveryPresenterGroups){const confirmed=await approvalReader({scope,group});if(!confirmed)return error(`presenter_first_frame_confirmation_missing:${group.groupId}`);confirmedApprovals.set(group.groupId,confirmed);}
        let activeIntents=structuredClone(frozenPlan.paidOperations),activeStatus=status,activeRouteBindings=structuredClone(routeBindings);
        const correctedBudgetStage='social.corrected_whole_film_budget';
        const correctedPrior=job.checkpoints[correctedBudgetStage];
        const correctedPayload=correction&&correctedPrior?.inputHash===correction.recordHash?socialObject(correctedPrior.payload):null;
        const activeQuotes:Record<string,import('../lib/socialContentTaskBudget.js').SocialTaskBudgetQuote>={...quotes,...(correctedPayload?.scopeHash===paidProductionHash(scope)?socialObject(correctedPayload.quotes)||{}:{})} as Record<string,import('../lib/socialContentTaskBudget.js').SocialTaskBudgetQuote>;
        const rememberCorrectionQuote=async(intent:SocialApprovedBudgetPlan['paidOperations'][number],tariff:SocialVerifiedAccountTariff)=>{
          const quote=quoteSocialPaidOperationTariff(intent,tariff);activeQuotes[intent.operationId]=quote;
          await recordCurrentContentExecutionCheckpoint({stage:correctedBudgetStage,version:'1',inputHash:correction!.recordHash,payload:{scopeHash:paidProductionHash(scope),authorization:correction,presenterVoiceBinding:currentVoice?.presenterBinding || null,routeBindings:activeRouteBindings,intents:activeIntents,quotes:activeQuotes,status:'quoted'}});
          return quote;
        };
        if(correction){
          if(correction.maximumCny>(correction.correctionCause==='approved_first_frame_not_consumed'?16.5:20)||correction.affectedPresenterGroupIds.length!==3
            ||correction.affectedPresenterGroupIds.some(groupId=>confirmedApprovals.get(groupId)?.approval.recordHash!==correction.presenterApprovalBindings.find(item=>item.groupId===groupId)?.approvalRecordHash))
            return error('presenter_correction_approval_changed');
          if(correction.correctionCause==='approved_first_frame_not_consumed_and_bound_voice_mismatch')for(const stage of ['tts','voice_alignment'] as const){const requirement=requirements.find(item=>item.stage===stage);if(!requirement){if(stage==='voice_alignment')continue;return error('presenter_correction_voice_requirement_missing');}const route=await input.ports?.resolveBoundRoute?.(requirement);if(!route)return error('presenter_correction_voice_route_missing');activeRouteBindings[requirement.key]=route;}
          activeIntents=appendPresenterFirstFrameCorrectionAttempts({scope,requirements,routeBindings:activeRouteBindings,intents:activeIntents,authorization:correction,
            rejectedCorrectionOperationIds:status.entries.filter(entry=>entry.status==='rejected').map(entry=>entry.operationId)});
          const allOperations=activeIntents.map(intent=>socialPaidIntentOperation(scope,intent));
          const correctionLedger=new SocialContentTaskBudget(input.ports?.ledgerRoot,{
            assertCurrent,authorization:async()=>({maximumCny:correction.maximumCny,authorizationRef:correction.authorizationRef}),
            quote:async(_candidate,operation)=>{
              const intent=activeIntents.find(item=>item.operationId===operation.operationId),binding=intent?.correction;
              if(!intent||!binding)throw Error('presenter_correction_quote_missing');
              if(binding.kind!=='presenter_video'){
                const quoteIntent=activeIntents.find(item=>item.operationId===operation.operationId)!;
                const presenterBinding=correction.correctionCause==='approved_first_frame_not_consumed_and_bound_voice_mismatch'
                  ?await readTrustedHeyGenRuntimeBinding({tenantId:scope.tenantId,presenterAssetId:recoveryPresenterGroups[0]!.presenterAssetId},{store,assertCurrent}):null;
                const tariff=await input.ports?.readTariff?.(quoteIntent)
                  ||(quoteIntent.provider==='heygen'&&quoteIntent.stage==='tts'&&presenterBinding?await readHeyGenPublishedTariff(quoteIntent,{readBinding:async()=>({...presenterBinding,accountRef:quoteIntent.accountRef})}):null)
                  ||(['voice_alignment'].includes(quoteIntent.stage)?await readNativeVoicePublishedTariff(quoteIntent):null);
                if(!tariff)throw Error('presenter_correction_voice_tariff_missing');
                return rememberCorrectionQuote(quoteIntent,tariff);
              }
              const requirement=requirements.find(item=>item.stage==='presenter_video'&&item.presenterGroupId===binding.presenterGroupId);
              if(!requirement)throw Error('presenter_correction_requirement_missing');
              const originalId=`paid-plan:${paidProductionHash({scope,key:requirement.key,attempt:0})}`,original=status.entries.find(item=>item.operationId===originalId);
              if(!original||original.stage!=='presenter_video'||original.status!=='completed'||!original.receiptRef)throw Error('presenter_correction_original_receipt_missing');
              const liveBinding=await readTrustedHeyGenRuntimeBinding({tenantId:scope.tenantId,presenterAssetId:recoveryPresenterGroups.find(group=>group.groupId===binding.presenterGroupId)!.presenterAssetId},{store,assertCurrent});
              const tariff=await input.ports?.readTariff?.(intent)||(liveBinding?await readHeyGenPublishedTariff(intent,{readBinding:async()=>liveBinding}):null);
              if(!tariff)throw Error('presenter_correction_video_tariff_missing');
              return rememberCorrectionQuote(intent,tariff);
            },verifyRejection:async()=>false,
          });
          activeStatus=await correctionLedger.reserveBatch(scope,allOperations);
          await recordCurrentContentExecutionCheckpoint({stage:correctedBudgetStage,version:'1',inputHash:correction.recordHash,payload:{scopeHash:paidProductionHash(scope),authorization:correction,presenterVoiceBinding:currentVoice?.presenterBinding || null,routeBindings:activeRouteBindings,intents:activeIntents,quotes:activeQuotes,status:'reserved',wholeTaskRetainedCny:activeStatus.retainedCny}});
        }
        const activeOperationIds=[...new Set([...operationIds,...activeIntents.map(intent=>intent.operationId)])];
        const operations=activeOperationIds.map(id=>activeStatus.entries.find(entry=>entry.operationId===id)).filter((entry):entry is NonNullable<typeof entry>=>Boolean(entry));
        if(operations.length!==activeOperationIds.length)return error('presenter_correction_reservation_missing');
        const paidPermit = createSocialContentPaidOperationPermit({scope,operations,intents:activeIntents,
          ledger,root:path.join(input.ports?.ledgerRoot || process.env.SOCIAL_CONTENT_TASK_BUDGET_DIR || 'data/social-content-task-budget','.permits'),assertCurrent,
          assertNewSubmit:input.ports?.assertNewSubmit});
        await input.ports?.preparePresenterFirstFrameReviews?.({scope,groups:recoveryPresenterGroups,requirements,intents:activeIntents,paidPermit});
        await assertCurrent();
        return {status:'reserved' as const,scope,reserved:{scope,operations,intents:activeIntents,quotes:activeQuotes,status:activeStatus,ledger},paidPermit,requirements,routeBindings:activeRouteBindings};
    }
    const ports = input.ports, assetInputs: FrozenPaidProduction['assets'] = [];
    const cached = job.checkpoints['social.material_analysis'];
    const cachedPayload = socialObject(cached?.payload), cacheRows = Array.isArray(cachedPayload?.analyzedAssets) ? cachedPayload.analyzedAssets : [];
    const cacheBound = cached?.inputHash === socialMaterialAnalysisInputHash({ tenantId: input.tenantId, assets: input.assets });
    const verifiedAssets = new Map<string, string>();
    for (const asset of input.assets) {
        const sha = await bytesHash(asset);
        if (!sha || asset.contentHash !== sha)
            return error(`material_bytes_unverified:${asset.id}`);
        verifiedAssets.set(asset.id, sha);
        const cachedRow = cacheBound ? cacheRows.find(value => socialObject(value)?.assetId === asset.id) : null;
        const reuseRef = cachedRow ? `job:${job.id}:social.material_analysis:${cached!.inputHash}` : null;
        let frameCount: number | null = asset.type === 'image' ? 1 : null, batches: number[] | null = null;
        if (asset.type === 'video' && !reuseRef) {
            const extracted = await ports?.readAnalysisFrames?.(asset);
            if (extracted) {
                frameCount = extracted.frameCount;
                batches = extracted.batchFrameCounts;
            }
        }
        assetInputs.push({ assetId: asset.id, contentHash: sha, type: asset.type, verifiedAnalysisRef: reuseRef, analysisMode: asset.type === 'image' ? 'image' : 'qwen_batches', frameCount, analysisBatchFrameCounts: batches });
    }
    const lines = input.baseline.scenes.map(scene => (scene.voiceover || scene.narration || '').trim()).filter(Boolean);
    const voice = lines.length ? await (ports?.readVoicePlan || (async () => null))(input.baseline) : { mode: 'none' as const, lines: [], requiresClone: false, allowFallback: false, requiresAsr: false, reuseReceiptRef: null };
    if (!voice)
        return error('selected_voice_runtime_route_missing');
    // Repair allowance bounds incremental work, not a new whole-film ceiling.
    // The original lower ceiling and every retained charge remain authoritative.
    const amount = costLineage.kind==='creative_repair'?costLineage.originalMaximumCny??ledgerProbe?.limitCny??NaN:Number(brief?.perItemBudgetCny), retry = Number(brief?.retryReserveCny || 0);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(retry) || retry < 0)
        return error('task_budget_missing');
    const priorPlan = socialObject(priorPayload?.plan);
    const directedRetryShotIds = await (ports?.readDirectedProductRetryShotIds
      ? ports.readDirectedProductRetryShotIds({scope,shots:input.supplyPlan.shots,priorPlan})
      : Promise.resolve(readDirectedProductRetryShotIds({scope,shots:input.supplyPlan.shots,priorPlan})));
    // The paid plan is immutable once the first supplier request is admitted.
    // Therefore the one allowed product-video correction must be priced and
    // reserved before attempt zero; waiting for failed-QA evidence would make
    // the retry impossible because recovery is deliberately read-only. Runtime
    // still exposes attempt one only after attempt-zero QA fails.
    const authorizedRetryShots = productRetryReservationShotIds(input.supplyPlan.shots, directedRetryShotIds);
    const frozenScenes:FrozenPaidProduction['scenes']=approved.directorBrief.scenes.map(scene => ({ ...(voice.mode === 'continuous' && voice.requiresAlignment && input.supplyPlan?.shots.some(shot => shot.shotId === scene.sceneId && shot.sourceStrategy === 'authorized_digital_presenter'&&shot.digitalHumanPlan?.method!=='reenact') ? {presenterSpeech:'whole_track' as const} : {}), shotId: scene.sceneId, durationSeconds: scene.duration.endSeconds - scene.duration.startSeconds, spokenText: input.baseline.scenes.find(s => s.sceneId === scene.sceneId)?.voiceover || input.baseline.scenes.find(s => s.sceneId === scene.sceneId)?.narration || '' }));
    const presenterGroups:FrozenPresenterGroup[]=[];
    let pending:{presenterAssetId:string;scenes:typeof frozenScenes}|null=null;
    const flushPresenterGroup=()=>{if(!pending?.scenes.length)return;const value={shotIds:pending.scenes.map(scene=>scene.shotId),durationSeconds:pending.scenes.reduce((sum,scene)=>sum+scene.durationSeconds,0),spokenText:pending.scenes.map(scene=>scene.spokenText).join(' '),presenterAssetId:pending.presenterAssetId};const groupId=`presenter-mother-${presenterGroups.length+1}`;const group={groupId,...value,contractHash:''};group.contractHash=presenterGroupContractHash(group);presenterGroups.push(group);pending=null;};
    for(const scene of frozenScenes){const shot=input.supplyPlan.shots.find(item=>item.shotId===scene.shotId);const ids=[...new Set(shot?.digitalHumanPlan?.presenterAssetIds?.length?shot.digitalHumanPlan.presenterAssetIds:shot?.sourceRefs||[])];const eligible=scene.presenterSpeech==='whole_track'&&shot?.sourceStrategy==='authorized_digital_presenter'&&ids.length===1;if(!eligible){flushPresenterGroup();continue;}if(pending&&pending.presenterAssetId!==ids[0])flushPresenterGroup();if(!pending)pending={presenterAssetId:ids[0]!,scenes:[]};pending.scenes.push(scene);}
    flushPresenterGroup();
    for(const scene of frozenScenes){const shot=input.supplyPlan.shots.find(item=>item.shotId===scene.shotId);if(shot?.sourceStrategy!=='authorized_digital_presenter'||shot.digitalHumanPlan?.method!=='reenact'||(shot.digitalHumanPlan as typeof shot.digitalHumanPlan&{silentMotion?:boolean}).silentMotion!==true)continue;const ids=[...new Set(shot.digitalHumanPlan.presenterAssetIds)];if(ids.length!==1)return error('motion_presenter_identity_ambiguous');const group:FrozenPresenterGroup={groupId:`presenter-motion:${scene.shotId}`,shotIds:[scene.shotId],durationSeconds:scene.durationSeconds,spokenText:scene.spokenText,presenterAssetId:ids[0]!,executionKind:'seedance_motion',contractHash:''};group.contractHash=presenterGroupContractHash(group);presenterGroups.push(group);}
    presenterGroups.sort((a,b)=>frozenScenes.findIndex(scene=>scene.shotId===a.shotIds[0])-frozenScenes.findIndex(scene=>scene.shotId===b.shotIds[0]));
    let automaticWeeklyG5=false;
    const weeklyAuthority=socialObject(brief?._weeklyAuthority),frozenWeek=socialObject(weeklyAuthority?.weeklyPackage),frozenPublication=socialObject(weeklyAuthority?.publicationTask);
    if(costLineage.kind==='original'&&frozenWeek&&frozenPublication){
      const weeklyScope={tenantId:input.tenantId,programId:String(frozenWeek.programId??''),packageId:String(frozenWeek.packageId??''),packageVersion:Number(frozenWeek.version)};
      const rows=await store.list<{payload:import('../../shared/contracts/socialProgram.js').WeeklyOperatingPackage}>('social_weekly_operating_packages',{where:{tenant_id:input.tenantId,program_id:weeklyScope.programId,package_id:weeklyScope.packageId,version:weeklyScope.packageVersion},perPage:2});
      if(rows.totalItems!==1||rows.items.length!==1)return error('weekly_g5_original_package_missing');
      const {createWeeklyPlanningAuthority}=await import('../socialPrograms/planningAuthority.js');
      const planning=await createWeeklyPlanningAuthority(store).get(weeklyScope.tenantId,weeklyScope.programId,weeklyScope.packageId,weeklyScope.packageVersion);
      if(planning.automaticTemplateAdoption){
        const {readWeeklyAutomaticProductionIntent}=await import('../socialPrograms/weeklyAutomaticProductionPlanning.js');
        if(!await readWeeklyAutomaticProductionIntent(store,weeklyScope,rows.items[0]!.payload,String(frozenPublication.publicationTaskId??'')))return error('weekly_g5_automatic_intent_missing');
        automaticWeeklyG5=true;
      }
    }
    const snapshot: FrozenPaidProduction = { scope, baselineHash, recordHash: '', approval: { approved: true, reviewRef: review.reviewId, sourceHash: '', planHash }, authorization: { ref: `task-budget:${socialRequestHash({ tenantId: input.tenantId, taskId: input.taskId, createdBy: row.created_by, budget: amount, retry })}`, maximumCny: Math.min(15, amount) }, maximumRetries: authorizedRetryShots.length ? 1 : 0, directedRetryShotIds: authorizedRetryShots,
        scenes:frozenScenes, presenterGroups, shots: input.supplyPlan.shots, assets: assetInputs, voice, finalReview: automaticWeeklyG5?'paid_capacity':'local' };
    if(costLineage.maximumAdditionalCostCny!==null)snapshot.authorization.maximumExecutionCny=costLineage.maximumAdditionalCostCny;
    snapshot.approval.sourceHash = paidProductionApprovalHash(snapshot);
    snapshot.recordHash = paidProductionRecordHash(snapshot);
    const localSupplyProof=createSocialContentLocalSupplyBudgetProofReader({scope,supplyPlan:input.supplyPlan,baseline:input.baseline,
      assets:[...input.assets,...(input.localSupplyAssets??[])],repository:input.repository,assertCurrent});
    const productBounds=new Map<string,CanonicalProductBudgetBounds>();
    const canonicalRoutes=createProductionBudgetRouteReaders({readCanonicalProductBounds:async req=>{
      if(!req.shotId)return null;const shot=input.supplyPlan!.shots.find(s=>s.shotId===req.shotId);
      if(!shot?.materialRouting||!shot.productSceneReplication)return null;
      await assertCurrent();
      const value=await readProductReplacementRequestBounds({tenantId:input.tenantId,taskId:input.taskId,shotId:req.shotId,idempotencyKey:`budget-read:${planHash}:${req.shotId}`,spec:shot.productSceneReplication,materialRouting:shot.materialRouting,referenceImages:[],outputDirectory:os.tmpdir(),maximumCostCny:Math.min(15,amount)}, {
        dataStore:store,
        materials:input.repository.materialLibrary,
        assertCurrent,
        frozenSupplyPlan:input.supplyPlan!,
        frozenSupplyPlanBinding:{planVersion:String(input.supplyPlan!.planVersion),planHash:socialRequestHash(input.supplyPlan)},
      });
      const previous=productBounds.get(req.shotId);if(previous&&socialRequestHash(previous)!==socialRequestHash(value))return error('product_input_authority_changed');
      productBounds.set(req.shotId,value);return value;
    }});
    const presenterBindings = new Map<string, TrustedHeyGenRuntimeBinding>();
    const readPresenterRoute = async (requirement: Parameters<PaidOperationPlannerPorts['resolveBoundRoute']>[0]): Promise<BoundPaidRoute | null> => {
      if (!requirement.presenterGroupId || !['first_frame','first_frame_qa','presenter_video','video_qa'].includes(requirement.stage)) return null;
      const memberIds=requirement.presenterGroupId?requirement.presenterGroupShotIds:requirement.shotId?[requirement.shotId]:null;
      if(!memberIds?.length)return null;
      const frozenGroup=requirement.presenterGroupId?snapshot.presenterGroups?.find(group=>group.groupId===requirement.presenterGroupId):null;
      if(requirement.presenterGroupId&&(!frozenGroup||paidProductionHash(frozenGroup.shotIds)!==paidProductionHash(memberIds)||frozenGroup.presenterAssetId!==requirement.presenterAssetId))return null;
      const memberShots=memberIds.map(id=>input.supplyPlan?.shots.find(item=>item.shotId===id));
      if(memberShots.some(shot=>!shot||shot.sourceStrategy!=='authorized_digital_presenter'))return null;
      const presenterIds=[...new Set(memberShots.flatMap(shot=>shot?.digitalHumanPlan?.presenterAssetIds?.length?shot.digitalHumanPlan.presenterAssetIds:shot?.sourceRefs||[]))];
      if (presenterIds.length !== 1 || (requirement.presenterAssetId&&requirement.presenterAssetId!==presenterIds[0])) return null;
      if(frozenGroup?.executionKind==='seedance_motion'&&requirement.stage==='video_qa'){
        const qaReader=createProductionBudgetRouteReaders({readCanonicalProductBounds:async()=>({qaModel:'qwen3-vl-plus',firstFrameMaximumFrames:3,videoMaximumFrames:4,productSha256s:[frozenGroup.contractHash],providerDurationSeconds:Math.max(4,Math.ceil(frozenGroup.durationSeconds)),evidenceRef:`presenter-motion-qa:${frozenGroup.contractHash}`})});
        return qaReader.resolveBoundRoute(requirement);
      }
      // Seedance needs a trusted enforced usage/charge ceiling. Do not quote
      // HeyGen pricing for this route, or invent a hard bound from a token
      // estimate. A deployment can supply the exact route through ports.
      if(frozenGroup?.executionKind==='seedance_motion'&&requirement.stage==='presenter_video')return null;
      if(requirement.stage==='first_frame'||requirement.stage==='first_frame_qa'){
        const generic=await canonicalRoutes.resolveBoundRoute(requirement);
        if(generic)return generic;
        const staticReaders=createProductionBudgetRouteReaders({readCanonicalProductBounds:async()=>({qaModel:'qwen3-vl-plus',firstFrameMaximumFrames:3,videoMaximumFrames:3,productSha256s:[requirement.presenterGroupContractHash!],providerDurationSeconds:4,evidenceRef:`presenter-first-frame:${requirement.presenterGroupContractHash}`})});
        return staticReaders.resolveBoundRoute(requirement);
      }
      if (!requirement.durationSeconds || requirement.durationSeconds <= 0) return null;
      let binding = presenterBindings.get(presenterIds[0]!);
      if (!binding) {
        const resolved = await readTrustedHeyGenRuntimeBinding({tenantId:input.tenantId,presenterAssetId:presenterIds[0]!},{store,assertCurrent});
        if (!resolved) return null;
        binding = resolved; presenterBindings.set(presenterIds[0]!,binding);
      }
      return {provider:'heygen',model:'avatar_iv',accountRef:binding.accountRef,
        routeEvidenceRef:heyGenRuntimeRouteEvidence(binding),
        usageBoundRef:(requirement.presenterGroupId?'measured-presenter-group:':'measured-whole-track-scene:')+requirement.inputContractHash,
        maximumAttempts:1,maximumUnits:{providerSeconds:Math.ceil(requirement.durationSeconds)}};
    };
    const routeBindings: Record<string, BoundPaidRoute> = {};
    const planner = createSocialContentPaidOperationPlanner({ readFrozenProduction: async () => { await assertCurrent(); return snapshot; }, assertCurrent,
        resolveBoundRoute: async (requirement) => {
          const route = await ports?.resolveBoundRoute?.(requirement) || await readPresenterRoute(requirement) || await canonicalRoutes.resolveBoundRoute(requirement);
          if (route) routeBindings[requirement.key] = structuredClone(route); return route;
        },
        readProductFrameBounds: async req=>await ports?.readProductFrameBounds?.(req)||await canonicalRoutes.readProductFrameBounds(req),
        readVerifiedLocalExecution: async (req) => {
            const trusted = await ports?.readVerifiedLocalExecution?.(req); if(trusted)return trusted;
            if (req.stage === 'material_analysis_cache') {
                const asset = assetInputs.find(a => a.contentHash === req.sourceRef && a.verifiedAnalysisRef);
                if (asset)
                    return { kind: 'analysis_cache', scopeHash: paidProductionHash(scope), inputContractHash: req.inputContractHash, receiptRef: asset.verifiedAnalysisRef!, sourceSha256: asset.contentHash, sourceRef: asset.assetId };
            }
            // A source strategy alone never proves a free local executor. The selected
            // local provider reader must bind real bytes and exact scene requirements.
            return localSupplyProof(req);
        } });
    const planned = await planner.plan(scope);
    if (!planned.plan)
        return error(planned.gaps.join('|'));
    if (!planned.plan.paidOperations.length) {
        if (input.quoteOnly) return {status: 'quoted' as const, scope, items: [], maximumCny: Math.min(15, amount, ledgerProbe?.limitCny ?? 15), retainedCny: ledgerProbe?.retainedCny || 0, wholeTaskUpperBoundCny: ledgerProbe?.retainedCny || 0};
        return { status: 'local' as const, scope };
    }
    const reader = createSocialContentVerifiedTariffReader(store, input.tenantId);
    const readPublishedQwenBinding=async (intent:SocialPaidOperationIntent)=>{
      if(intent.provider!=='qwen')return null;let b:ReturnType<typeof getQwenProviderBinding>;try{b=getQwenProviderBinding();}catch{return null;}
      const model=intent.stage==='material_image_analysis'?b.imageModel:['material_video_analysis','material_video_review'].includes(intent.stage)?b.materialModel:intent.stage==='director_review_capacity'?intent.model:['first_frame_qa','video_qa'].includes(intent.stage)?(intent.model==='qwen3-vl-plus'?intent.model:process.env.QWEN_VL_MODEL||'qwen3-vl-plus'):null;
      return model?{provider:'qwen',model,baseUrl:b.baseUrl,credentialSha256:b.credentialSha256}:null;
    };
    const publishedReader=createSocialContentLocalPublishedTariffReader({readProviderBinding:readPublishedQwenBinding});
    const maasPublishedReader=createQwenMaaSPublishedTariffReader({readProviderBinding:readPublishedQwenBinding});
    const authority = createSocialContentTaskBudgetAuthority({ ledgerRoot: ports?.ledgerRoot, ports: { assertCurrent, readApprovedPlan: async () => { await assertCurrent(); return planned.plan!; }, readVerifiedTariff: async intent=>await ports?.readTariff?.(intent)||await reader.read(intent)||(intent.provider==='heygen' && intent.stage==='tts' ? await readHeyGenPublishedTariff(intent,{readBinding:async operation=>{const binding=[...presenterBindings.values()].find(b=>operation.accountRef==='heygen:'+createHash('sha256').update(JSON.stringify({baseUrl:'https://api.heygen.com/v3/voices/speech',credentialSha256:b.credentialSha256})).digest('hex'));return binding?{...binding,accountRef:operation.accountRef}:null;}}) : ['tts','voice_asr','voice_alignment'].includes(intent.stage)?await readNativeVoicePublishedTariff(intent):intent.provider==='seedream'?await readSeedreamPublishedTariff(intent,{baseUrl:process.env.SEEDREAM_BASE_URL||process.env.SEEDANCE_BASE_URL||'https://ark.cn-beijing.volces.com/api/v3',credentialSha256:createHash('sha256').update((process.env.SEEDREAM_API_KEY||process.env.SEEDANCE_API_KEY||'').trim()).digest('hex')}):intent.provider==='wan'?await readWanPublishedTariff(intent,{baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',credentialSha256:getQwenProviderBinding().credentialSha256}):intent.provider==='heygen'?await readHeyGenPublishedTariff(intent,{readBinding:async operation=>[...presenterBindings.values()].find(binding=>binding.accountRef===operation.accountRef)||null}):await maasPublishedReader.read(intent)||await publishedReader.read(intent)), verifyRejection: async () => false } });
    // Quote the complete frozen plan before mutating the task ledger.  Besides
    // keeping over-budget retries free, the stage breakdown is durable in the
    // graph node failure reason and makes the degradation decision auditable.
    const preview = await authority.prepare(scope);
    const previewItems = planned.plan.paidOperations.map(intent => {
      const quote=preview.quotes.get(intent.operationId);
      if(!quote || !Number.isFinite(quote.upperBoundCny) || quote.upperBoundCny<=0 || !quote.quoteRef) return error(`formal_paid_route_quote_missing:${intent.operationId}`);
      return ({
      operationId: intent.operationId,
      stage: intent.stage,
      shotId: intent.shotId,
      provider: intent.provider,
      model: intent.model,
      upperBoundCny: quote.upperBoundCny,
      quoteRef: quote.quoteRef,
    }); });
    const previewUpperBoundCny = previewItems.reduce((sum, item) => sum + item.upperBoundCny, 0);
    const retained = ledgerProbe?.retainedCny || 0;
    const existingOperationIds = new Set((ledgerProbe?.entries || []).filter(entry => entry.status !== 'rejected').map(entry => entry.operationId));
    const wholeTaskUpperBoundCny = retained + previewItems.filter(item => !existingOperationIds.has(item.operationId)).reduce((sum, item) => sum + item.upperBoundCny, 0);
    const childRetained=(ledgerProbe?.entries||[]).filter(entry=>entry.executionTaskId===input.taskId&&entry.status!=='rejected').reduce((sum,entry)=>sum+entry.reservedMicros/1e6,0);
    const internalBudgetExempt=isInternalBudgetExemptTenant(input.tenantId);
    const revisionCeiling=internalBudgetExempt||costLineage.maximumAdditionalCostCny===null?Infinity:retained+costLineage.maximumAdditionalCostCny-childRetained;
    if (input.quoteOnly) return { status: 'quoted' as const, scope, items: previewItems,
      maximumCny: internalBudgetExempt
        ? Math.max(planned.plan.maximumCny,ledgerProbe?.limitCny??0,wholeTaskUpperBoundCny)
        : Math.min(15, planned.plan.maximumCny, ledgerProbe?.limitCny ?? 15,revisionCeiling),
      retainedCny: retained, wholeTaskUpperBoundCny };
    if(!internalBudgetExempt&&wholeTaskUpperBoundCny>revisionCeiling)return error('revision_incremental_allowance_exceeded');
    if (formalPaidRouteExceedsInternalBudget(input.tenantId, wholeTaskUpperBoundCny, planned.plan.maximumCny)) {
      const stageTotals = Object.entries(previewItems.reduce<Record<string, number>>((totals, item) => {
        totals[item.stage] = (totals[item.stage] || 0) + item.upperBoundCny;
        return totals;
      }, {})).sort(([left], [right]) => left.localeCompare(right));
      return error(`formal_paid_route_budget_exceeded:${previewUpperBoundCny.toFixed(6)}:${JSON.stringify(stageTotals)}`);
    }
    const reserved = await authority.prepareAndReserve(scope);
    const formalPaidRouteUpperBoundCny=Object.values(reserved.quotes).reduce((sum,quote)=>sum+quote.upperBoundCny,0);
    if(formalPaidRouteExceedsInternalBudget(input.tenantId, formalPaidRouteUpperBoundCny, planned.plan.maximumCny))
      return error(`formal_paid_route_budget_exceeded:${formalPaidRouteUpperBoundCny.toFixed(6)}`);
    await recordCurrentContentExecutionCheckpoint({ stage: STAGE, version: '1', inputHash: planHash, payload: { scopeHash: paidProductionHash(scope), baselineHash,
      paidBaselineContractHash: paidBaselineContractHash(input.baseline), presenterVoiceBinding:voice.presenterBinding || null, operationIds: reserved.operations.map(o => o.operationId), requirements: planned.requirements, routeBindings, quotes: reserved.quotes, formalPaidRouteUpperBoundCny, wholeTaskRetainedCny:reserved.status.retainedCny, plan: planned.plan } });
    const paidPermit = createSocialContentPaidOperationPermit({ ...reserved, root: path.join(ports?.ledgerRoot || process.env.SOCIAL_CONTENT_TASK_BUDGET_DIR || 'data/social-content-task-budget', '.permits'), assertCurrent,
      assertNewSubmit:ports?.assertNewSubmit });
    await input.ports?.preparePresenterFirstFrameReviews?.({scope,groups:presenterGroups,requirements:planned.requirements,intents:planned.plan.paidOperations,paidPermit});
    const approvalReader=input.ports?.readConfirmedPresenterFirstFrame??(async({scope,group}:{scope:SocialTaskBudgetScope;group:FrozenPresenterGroup})=>readOrAutomaticallyConfirmPresenterFirstFrame(store,scope,group));
    for(const group of presenterGroups)if(!await approvalReader({scope,group}))return error(`presenter_first_frame_confirmation_missing:${group.groupId}`);
    return { status: 'reserved' as const, scope, reserved, paidPermit, requirements: planned.requirements, routeBindings };
}
