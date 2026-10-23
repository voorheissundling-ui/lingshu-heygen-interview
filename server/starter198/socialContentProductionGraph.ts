import {readGraphContextSnapshot,compactGraphContextSnapshot} from './socialContentGraphContextSnapshots.js';
import {readBoundPresenterVoice} from './socialContentBoundPresenterVoice.js';
import {SocialContentTaskBudget} from '../lib/socialContentTaskBudget.js';
import type { DataStore } from '../storage/datastore.js';
import type { ContentExecutionJob } from '../contentExecution/durableQueue.js';
import { controlContentExecutionJob } from '../contentExecution/durableQueue.js';
import { assertCurrentContentExecutionActive, recordCurrentContentExecutionCheckpoint } from '../contentExecution/context.js';
import { runLangGraphProduction } from '../contentExecution/langgraphEngine.js';
import {
  CONTENT_GRAPH_VERSION,
  LEGACY_CONTENT_GRAPH_VERSION,
  SUPPORTED_CONTENT_GRAPH_VERSIONS,
  type ContentGraphVersion,
} from '../contentExecution/langgraphIdentity.js';
import type { SocialProductionGraphPhase } from './socialContentProductionStages.js';
import { runSocialContentAutoProduction, type SocialContentAutoProductionRuntime, type SocialGraphApprovedContext } from './socialContentProductionExecution.js';
import type { SocialAssetSupplyProviderAdapter } from './socialContentAssetSupplyExecution.js';
import { readSocialTaskDetail, requireSocialTask } from './socialContentRecords.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';
import { assertStudioSocialArtifactGeneration } from './socialContentOutputSupport.js';
import { writeExecutionStage } from './socialContentAutoProduction.js';
import { createSocialDeliveryPackage } from './socialContentOutputs.js';
import { graphRuntimeInventoryVisible, readCanonicalGraphRuntimeMedia } from './socialContentGraphRuntimeInventory.js';
import { withStarter198RunMutationLease } from './runMutationLease.js';
import { socialAssetSupplyPlanIdentityHash } from './socialAssetSupplyPlanIdentity.js';
import { assertSocialContentReleaseQuality } from './socialContentReleaseQuality.js';
import { socialTaskSummary } from './socialContentRecords.js';
import { assertSocialContentGraphQuality } from './socialContentGraphQualityGate.js';

type Detail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;

/**
 * Version the correction execution policy in one place.  The same identity is
 * consumed by graph execution and by the post-crash completion reconciler; a
 * drift between the two would leave an otherwise completed single-shot repair
 * permanently unable to cross the completion boundary.
 */
export const SOCIAL_CONTENT_CORRECTION_POLICY_VERSION = 'bound-voice-strict-approved-intro.v4';

export function socialContentCorrectionRuntimeHash(grantHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(grantHash)) throw new Error('content_graph_correction_identity_invalid');
  return socialRequestHash({ grantHash, policyVersion: SOCIAL_CONTENT_CORRECTION_POLICY_VERSION });
}
/** Compare business authority, excluding only identifiers derived from task projection versions. */
function graphAuthority(workflow: NonNullable<Detail['agentWorkflow']>) {
  const director = structuredClone(workflow.directorBrief) as unknown as Record<string, unknown>;
  const plan = structuredClone(workflow.executionPlan) as unknown as Record<string, unknown>;
  const review = structuredClone(workflow.executionPlanReview) as unknown as Record<string, unknown>;
  delete director.version;
  const replicationJobRef = director.replicationJobRef as Record<string, unknown> | undefined;
  if (replicationJobRef) {
    delete replicationJobRef.version;
    delete replicationJobRef.factorSpecVersion;
  }
  // Task status projection increments the task version and re-stamps every
  // derived factor without changing its frozen value. Ignore that projection
  // stamp while retaining the factor id, value, source and confidence so a
  // business edit still invalidates the admitted graph.
  for (const scene of (director.scenes ?? []) as Array<Record<string, unknown>>) {
    for (const factor of (scene.replicationFactors ?? []) as Array<Record<string, unknown>>) delete factor.factorSpecVersion;
  }
  for (const key of ['version', 'directorBriefVersion']) delete plan[key];
  for (const key of ['version', 'executionPlanVersion', 'directorBriefVersion', 'reviewId']) delete review[key];
  const scenes = plan.scenes as Array<Record<string, unknown>>;
  for (const scene of scenes ?? []) {
    delete scene.idempotencyKey;
    for (const candidate of (scene.candidates ?? []) as Array<Record<string, unknown>>) {
      const provenance = candidate.provenance as Record<string, unknown> | undefined;
      if (provenance) delete provenance.inputVersion;
    }
  }
  return { director, plan, review };
}

function firstAuthorityDifference(left: unknown, right: unknown, path = 'root'): string | null {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstAuthorityDifference(left[index], right[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(leftRecord, key) || !Object.hasOwn(rightRecord, key)) return `${path}.${key}`;
      const difference = firstAuthorityDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return path;
}

export function socialProductionGraphInput(detail: Detail, approvedContext?: SocialGraphApprovedContext) {
  const approved = approvedContext ?? detail;
  if (detail.footageRevisionPlanHash && (!approved.assetSupplyPlan
    || approvedContext && approvedContext.footageRevisionPlanHash !== detail.footageRevisionPlanHash
    || socialAssetSupplyPlanIdentityHash(approved.assetSupplyPlan) !== detail.footageRevisionPlanHash))
    throw new Error('user_input_required:graph_footage_revision_plan_changed');
  if (!detail.footageRevisionPlanHash && approvedContext?.footageRevisionPlanHash)
    throw new Error('user_input_required:graph_footage_revision_plan_changed');
  if (!approved.agentWorkflow) throw new Error('user_input_required:production_execution_plan_missing');
  if (approvedContext && !detail.agentWorkflow) throw new Error('user_input_required:graph_production_plan_changed:business_authority_missing');
  if (approvedContext && detail.agentWorkflow) {
    const liveAuthority = graphAuthority(detail.agentWorkflow), admittedAuthority = graphAuthority(approved.agentWorkflow);
    if (socialRequestHash(liveAuthority) !== socialRequestHash(admittedAuthority)) throw new Error(
      `user_input_required:graph_production_plan_changed:business_authority:${firstAuthorityDifference(liveAuthority, admittedAuthority) || 'hash'}`,
    );
  }
  return {
    planVersion: String(approved.agentWorkflow.executionPlan.version),
    inputHash: socialRequestHash({ brief: detail.brief, executionPlan: approved.agentWorkflow.executionPlan,
      executionPlanReview: approved.agentWorkflow.executionPlanReview,
      directorBrief: approved.agentWorkflow.directorBrief, sources: detail.sources,
      ...(detail.footageRevisionPlanHash ? { footageRevisionPlanHash: detail.footageRevisionPlanHash } : {}),
      ...((approved as SocialGraphApprovedContext).revisionPlanHash ? { revisionPlanHash: (approved as SocialGraphApprovedContext).revisionPlanHash } : {}) }),
  };
}

/** Self-generated runtime inventory cannot rewrite the admitted business plan.
 * Previously admitted sources remain visible and retain all normal validation. */
export async function readSocialProductionGraphDetail(input: { repository: Starter198Repository; tenantId: string; taskId: string }, approvedContext: SocialGraphApprovedContext) {
  if (approvedContext.revisionPlanHash) {
    const row = await requireSocialTask(input), marker = socialObject(socialObject(socialJson(row.brief))?._productionRevision);
    const { planHash, preparedBy: _actor, preparedAt: _time, ...immutable } = marker ?? {};
    if (planHash !== approvedContext.revisionPlanHash || socialRequestHash(immutable) !== planHash)
      throw new Error('user_input_required:graph_revision_plan_changed');
  }
  const admittedRefs = new Set<string>([
    ...(approvedContext.agentWorkflow?.executionPlan.scenes.flatMap(scene => scene.candidates.map(candidate => candidate.sourceRef).filter(Boolean)) ?? []),
    ...(approvedContext.assetSupplyPlan?.shots.flatMap(shot=>shot.sourceRefs || []) ?? []),
    ...(approvedContext.agentWorkflow?.executionPlan.productionOptions?.flatMap(option=>option.selectedMaterialIds) ?? []),
  ].filter((ref): ref is string => typeof ref === 'string' && Boolean(ref)));
  const task = await requireSocialTask(input);
  const canonical = input.repository.dataStore && task.run_id ? await readCanonicalGraphRuntimeMedia({dataStore:input.repository.dataStore,tenantId:input.tenantId,taskId:input.taskId,runId:String(task.run_id),approvedContext}) : [];
  const library = input.repository.materialLibrary;
  const repository: Starter198Repository = library ? { ...input.repository, materialLibrary: async (...args) => {
    const result = await library(...args);
    return { ...result, items: result.items.filter(item => graphRuntimeInventoryVisible(item,{tenantId:input.tenantId,taskId:input.taskId,admittedRefs,canonical,freezeToAdmitted:true})) };
  } } : input.repository;
  return readSocialTaskDetail({ ...input, repository });
}

export function createSocialProductionExecutorCheckpoint(detail: Detail, env: NodeJS.ProcessEnv = process.env, revisionPlanHash?: string) {
  if (revisionPlanHash && !/^[a-f0-9]{64}$/.test(revisionPlanHash)) throw new Error('user_input_required:graph_revision_plan_changed');
  // A confirmed weekly package is the formal production path. Its execution
  // contract must not change with a process-local feature flag: every new
  // weekly run is frozen into the durable queue + LangGraph bridge. The flag
  // remains available for instant/manual tasks while shooting plans continue
  // to be non-producing instructions.
  const graphEnabled = detail.brief.productionApproach !== 'shooting_plan'
    && ((detail.mode ?? 'weekly') === 'weekly' || env.SOCIAL_CONTENT_EXECUTOR === 'langgraph');
  const identity = graphEnabled ? socialProductionGraphInput(detail, revisionPlanHash ? { ...detail, revisionPlanHash } : undefined) : { planVersion: 'legacy', inputHash: 'legacy' };
  const approvedContext: SocialGraphApprovedContext | null = graphEnabled ? structuredClone({
    version: detail.version, agentWorkflow: detail.agentWorkflow, assetSupplyPlan: detail.assetSupplyPlan,
    ...(detail.footageRevisionPlanHash ? { footageRevisionPlanHash: detail.footageRevisionPlanHash } : {}),
    ...(revisionPlanHash ? { revisionPlanHash } : {}) }) : null;
  if (approvedContext?.agentWorkflow) {
    approvedContext.agentWorkflow.productionResult = null;
    approvedContext.agentWorkflow.replicationEvaluation = null;
  }
  return { version: '1', inputHash: identity.inputHash, updatedAt: new Date().toISOString(),
    payload: { executor: graphEnabled ? 'langgraph' : 'legacy', ...identity,
      ...(graphEnabled ? { graphVersion: CONTENT_GRAPH_VERSION } : {}),
      ...(approvedContext ? { approvedContext } : {}) } };
}

export function socialProductionExecutor(job: ContentExecutionJob, rawCheckpoints?: unknown): 'legacy' | 'langgraph' {
  const binding = job.checkpoints['social.executor'];
  const raw = socialObject(socialJson(rawCheckpoints));
  if (!binding) {
    if (Object.hasOwn(raw ?? {}, 'social.executor') || job.checkpoints['langgraph.v1'] || Object.hasOwn(raw ?? {}, 'langgraph.v1'))
      throw new Error('user_input_required:production_executor_binding_invalid');
    return 'legacy';
  }
  const payload = socialObject(binding.payload);
  if (binding.version !== '1' || !payload || !['legacy', 'langgraph'].includes(String(payload.executor))
    || !socialText(payload.planVersion) || binding.inputHash !== payload.inputHash
    || payload.executor === 'langgraph' && payload.graphVersion !== undefined
      && !SUPPORTED_CONTENT_GRAPH_VERSIONS.includes(payload.graphVersion as ContentGraphVersion)
    || payload.executor === 'langgraph' && !/^[a-f0-9]{64}$/.test(String(payload.inputHash))) throw new Error('user_input_required:production_executor_binding_invalid');
  return payload.executor as 'legacy' | 'langgraph';
}

async function productionArtifact(repository: Starter198Repository, job: ContentExecutionJob) {
  const rows = await repository.list(STARTER_COLLECTIONS.socialContentArtifacts, job.tenantId, { where: { task_id: job.taskId }, perPage: 500 });
  const candidates = rows.items.filter(row => {
    const content = socialObject(socialJson(row.content));
    const source = socialObject(content?.productionWorkspaceSource);
    return row.origin === 'agent' && row.artifact_kind === 'short_video' && source?.runId === job.runId
      && !['superseded', 'changes_requested', 'rejected'].includes(String(row.status));
  });
  if (candidates.length !== 1) throw new Error('user_input_required:graph_production_artifact_not_unique');
  return candidates[0]!;
}

function artifactEvidence(row: StarterRecord) {
  const content = socialJson(row.content);
  const source = socialObject(socialObject(content)?.productionWorkspaceSource);
  const outputSha256 = socialText(source?.outputSha256);
  if (outputSha256 && !/^[a-f0-9]{64}$/.test(outputSha256)) throw new Error('graph_production_artifact_sha_invalid');
  return { artifactId: socialText(row.artifact_id), contentHash: socialRequestHash(content),
    version: socialText(row.version), outputSha256: outputSha256 || null };
}

/** A restored review checkpoint is only authority for its original film bytes. */
export function assertCurrentGraphReviewSubject(checkpoint: ContentExecutionJob['checkpoints'][string] | undefined,
  artifact: StarterRecord, runId: string, approved = false): void {
  const subject = socialObject(checkpoint?.payload);
  const current = artifactEvidence(artifact);
  if (checkpoint?.version !== '1' || !subject || subject.runId !== runId
    || subject.artifactId !== current.artifactId
    || (approved ? Number(current.version) !== Number(subject.version) + 1 : subject.version !== current.version)
    || subject.contentHash !== current.contentHash || subject.outputSha256 !== current.outputSha256
    || !current.outputSha256) throw new Error('graph_review_subject_changed');
}

function assertGraphArtifactQuality(artifact: StarterRecord, job: ContentExecutionJob): void {
  const content = socialObject(socialJson(artifact.content));
  if (socialObject(content?.productionWorkspaceSource)?.runId !== job.runId)
    throw new Error('social_graph_quality_failed:artifact_run_changed');
  assertSocialContentGraphQuality(content);
}

/** Read the canonical business decision and its completed operation. A graph
 * checkpoint, client approval flag or an unrelated approved asset grants nothing. */
export async function loadSocialProductionGraphApproval(repository: Starter198Repository, job: ContentExecutionJob) {
  const artifact = await productionArtifact(repository, job);
  if (socialObject(socialJson(artifact.content))?.workflowSchema === 'social-content.auto-production.v3')
    assertGraphArtifactQuality(artifact, job);
  if (artifact.status !== 'approved') return null;
  const checkpoint = job.checkpoints['social.graph_review'];
  const expected = socialObject(checkpoint?.payload);
  const evidence = artifactEvidence(artifact);
  if (socialObject(socialJson(artifact.content))?.workflowSchema === 'social-content.auto-production.v3') {
    // Approval advances the artifact version once; all other subject fields
    // must still identify the exact film admitted to human review.
    assertCurrentGraphReviewSubject(checkpoint, artifact, job.runId, true);
  }
  if (!expected || expected.artifactId !== evidence.artifactId || expected.contentHash !== evidence.contentHash
    || expected.runId !== job.runId) throw new Error('user_input_required:graph_review_subject_changed');
  if (!Number.isSafeInteger(Number(expected.version)) || Number(evidence.version) !== Number(expected.version) + 1)
    throw new Error('user_input_required:graph_review_version_changed');
  const receiptRef = socialText(artifact.last_operation_id);
  if (!receiptRef) throw new Error('user_input_required:graph_review_receipt_missing');
  const receipts = await repository.list(STARTER_COLLECTIONS.socialContentOperations, job.tenantId,
    { where: { operation_id: receiptRef }, perPage: 2 });
  const receipt = receipts.items[0];
  if (receipts.totalItems !== 1 || !receipt || receipt.status !== 'succeeded'
    || !['decide_social_content_artifact', 'decide_social_content_artifact_batch'].includes(String(receipt.operation))
    || receipt.target_id !== job.taskId)
    throw new Error('user_input_required:graph_review_receipt_invalid');
  await assertStudioSocialArtifactGeneration(job.tenantId, socialText(artifact.artifact_kind), artifact.content);
  const content = socialJson(artifact.content);
  if (socialObject(content)?.workflowSchema === 'social-content.auto-production.v3') {
    const task = await requireSocialTask({ repository, tenantId: job.tenantId, taskId: job.taskId });
    assertSocialContentReleaseQuality({ tenantId: job.tenantId, brief: socialTaskSummary(task).brief, content, mode: 'human' });
  }
  return { approved: true, receiptRef, subjectVersion: evidence.version, contentHash: evidence.contentHash };
}

/** A server-owned correction plan may update local material ranking, never
 * narration, timing, people, paid visual routes or the original financial scope. */
export async function prepareAuthorizedSocialCorrectionContext(input:{repository:Starter198Repository;dataStore:DataStore;jobId:string;tenantId:string}) {
 const row=await input.dataStore.getById<StarterRecord>('content_execution_jobs',input.jobId);
 if(!row||row.tenant_id!==input.tenantId||row.worker_id||row.lease_expires_at||!['paused','blocked','retry_wait','dead_letter'].includes(String(row.status)))throw Error('correction_context_job_not_settled');
 const checkpoints=socialObject(row.checkpoints)||{},binding=socialObject(socialObject(checkpoints['social.executor'])?.payload);
 const original=readGraphContextSnapshot(binding);const originalInputHash=String(binding?.inputHash||'');
 if(!original?.agentWorkflow||!/^[a-f0-9]{64}$/.test(originalInputHash))throw Error('correction_context_original_missing');
 const scope={tenantId:input.tenantId,taskId:String(row.task_id),runId:String(row.run_id),planHash:originalInputHash};
 const ledger=new SocialContentTaskBudget(undefined,{authorization:async()=>{throw Error('read_only')},quote:async()=>{throw Error('read_only')},assertCurrent:async()=>{},verifyRejection:async()=>false});
 const grant=ledger.status(scope)?.correctionAuthorization;
 if(!grant||grant.correctionCause!=='approved_first_frame_not_consumed_and_bound_voice_mismatch')throw Error('correction_context_authorization_missing');
 const prior=socialObject(socialObject(checkpoints['social.corrected_executor'])?.payload);
 if(prior&&socialObject(checkpoints['social.corrected_executor'])?.inputHash===grant.recordHash){
  const compactParent=compactGraphContextSnapshot(binding!),compactPrior=compactGraphContextSnapshot(prior);
  if(!input.dataStore.compareAndSwap||!await input.dataStore.compareAndSwap('content_execution_jobs',row.id,{status:row.status,checkpoints:row.checkpoints,worker_id:row.worker_id,lease_expires_at:row.lease_expires_at},{checkpoints:{...checkpoints,'social.executor':{...socialObject(checkpoints['social.executor']),payload:compactParent},'social.corrected_executor':{...socialObject(checkpoints['social.corrected_executor']),payload:compactPrior}},updated_at:new Date().toISOString()}))throw Error('correction_context_write_conflict');
  return compactPrior;
 }
 const live=await readSocialProductionGraphDetail({repository:input.repository,tenantId:scope.tenantId,taskId:scope.taskId},original);
 if(!live?.agentWorkflow||!live.assetSupplyPlan||!original.assetSupplyPlan)throw Error('correction_context_live_missing');
 if(socialRequestHash(graphAuthority(live.agentWorkflow).director)!==socialRequestHash(graphAuthority(original.agentWorkflow).director))throw Error('correction_context_director_changed');
 const originalShots=new Map(original.assetSupplyPlan.shots.map(shot=>[shot.shotId,shot]));
 if(originalShots.size!==live.assetSupplyPlan.shots.length)throw Error('correction_context_scene_set_changed');
 for(const shot of live.assetSupplyPlan.shots){const old=originalShots.get(shot.shotId);if(!old||old.sourceStrategy!==shot.sourceStrategy)throw Error('correction_context_route_changed');
  if(!['owned_exact_local_video','customer_real_asset','customer_product_image_animation','motion_graphics','verified_fact_card'].includes(shot.sourceStrategy)&&socialRequestHash({sourceRefs:old.sourceRefs,digitalHumanPlan:old.digitalHumanPlan,productSceneReplication:old.productSceneReplication})!==socialRequestHash({sourceRefs:shot.sourceRefs,digitalHumanPlan:shot.digitalHumanPlan,productSceneReplication:shot.productSceneReplication}))throw Error('correction_context_paid_route_changed');}
 const ids=live.assetSupplyPlan.shots.filter(shot=>shot.sourceStrategy==='authorized_digital_presenter').flatMap(shot=>shot.digitalHumanPlan?.presenterAssetIds?.length?shot.digitalHumanPlan.presenterAssetIds:shot.sourceRefs);
 const voice=await readBoundPresenterVoice(input.dataStore,scope.tenantId,ids);
 if(voice?.voiceId!==grant.selectedVoiceId||voice?.fingerprint!==grant.selectedVoiceFingerprint)throw Error('correction_context_voice_changed');
 const approvedContext:SocialGraphApprovedContext={version:live.version,agentWorkflow:structuredClone(live.agentWorkflow),assetSupplyPlan:structuredClone(live.assetSupplyPlan),...(original.revisionPlanHash?{revisionPlanHash:original.revisionPlanHash}:{})};
 const payload=compactGraphContextSnapshot({originalInputHash,originalApprovedContextHash:socialRequestHash(original),approvedContext,graphInputHash:socialProductionGraphInput(live,approvedContext).inputHash,authorizationRef:grant.authorizationRef});
 if(!input.dataStore.compareAndSwap||!await input.dataStore.compareAndSwap('content_execution_jobs',row.id,{status:row.status,checkpoints:row.checkpoints,worker_id:row.worker_id,lease_expires_at:row.lease_expires_at},{checkpoints:{...checkpoints,'social.executor':{...socialObject(checkpoints['social.executor']),payload:compactGraphContextSnapshot(binding!)},'social.corrected_executor':{version:'1',inputHash:grant.recordHash,payload,updatedAt:new Date().toISOString()}},updated_at:new Date().toISOString()}))throw Error('correction_context_write_conflict');
 return payload;
}
export function matchesAuthorizedCorrectionContext(job:ContentExecutionJob,context:SocialGraphApprovedContext,financialPlanHash:string,grantHash:string|undefined,graphInputHash?:string){
 const entry=job.checkpoints['social.corrected_executor'],payload=socialObject(entry?.payload),parent=socialObject(job.checkpoints['social.executor']?.payload);
 return (graphInputHash===undefined||payload?.graphInputHash===graphInputHash)&&!!grantHash&&entry?.inputHash===grantHash&&payload?.originalInputHash===financialPlanHash&&parent?.inputHash===financialPlanHash&&payload?.originalApprovedContextHash===socialRequestHash(readGraphContextSnapshot(parent))&&socialRequestHash(readGraphContextSnapshot(payload))===socialRequestHash(context);
}

export async function executeSocialProductionGraph(input: { repository: Starter198Repository; dataStore: DataStore; job: ContentExecutionJob;
  runtime?: SocialContentAutoProductionRuntime; assetSupplyAdapters?: SocialAssetSupplyProviderAdapter[]; assetSupplyRecoveryOnly?: boolean;
  materialEvidencePorts?: Parameters<typeof runSocialContentAutoProduction>[0]['materialEvidencePorts']; }) {
  const { repository, dataStore, job } = input;
  const binding = socialObject(job.checkpoints['social.executor']?.payload);
  const parentContext = readGraphContextSnapshot(binding);
  const correctionLedger=new SocialContentTaskBudget(undefined,{authorization:async()=>{throw Error('read_only')},quote:async()=>{throw Error('read_only')},assertCurrent:async()=>{},verifyRejection:async()=>false});
  const graphCorrection=correctionLedger.status({tenantId:job.tenantId,taskId:job.taskId,runId:job.runId,planHash:String(binding?.inputHash||'')})?.correctionAuthorization || null;
  const corrected=readGraphContextSnapshot(socialObject(job.checkpoints['social.corrected_executor']?.payload));
  const approvedContext=corrected&&matchesAuthorizedCorrectionContext(job,corrected,String(binding?.inputHash||''),graphCorrection?.recordHash)?corrected:parentContext;
  if (!approvedContext?.agentWorkflow || !approvedContext.version) throw new Error('user_input_required:graph_approved_context_missing');
  let detail: Detail | null;
  try {
    detail = await readSocialProductionGraphDetail({ repository, tenantId: job.tenantId, taskId: job.taskId }, approvedContext);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}:initial_detail`);
  }
  if (!detail) throw new Error('user_input_required:graph_task_missing');
  const current = socialProductionGraphInput(detail, approvedContext);
  if(corrected&&matchesAuthorizedCorrectionContext(job,corrected,String(binding?.inputHash||''),graphCorrection?.recordHash)&&!matchesAuthorizedCorrectionContext(job,corrected,String(binding?.inputHash||''),graphCorrection?.recordHash,current.inputHash))throw Error('user_input_required:graph_corrected_context_changed');
  if (!matchesAuthorizedCorrectionContext(job,approvedContext,String(binding?.inputHash||''),graphCorrection?.recordHash,current.inputHash)&&(binding?.inputHash !== current.inputHash || binding?.planVersion !== current.planVersion))
    throw new Error('user_input_required:graph_production_plan_changed:executor_binding');
  const correctionRuntimeHash=graphCorrection?socialContentCorrectionRuntimeHash(graphCorrection.recordHash):null;
  const graphVersion = (SUPPORTED_CONTENT_GRAPH_VERSIONS.includes(binding?.graphVersion as ContentGraphVersion)
    ? binding?.graphVersion : LEGACY_CONTENT_GRAPH_VERSION) as ContentGraphVersion;
  const identity = { tenantId: job.tenantId, taskId: job.taskId, runId: job.runId, jobId: job.id,
    ...current,...(graphCorrection?{inputHash:socialRequestHash({originalInputHash:current.inputHash,correctionHash:correctionRuntimeHash})}:{}), graphVersion };
  const refreshedJob = async () => {
    const { readContentExecutionJob } = await import('../contentExecution/durableQueue.js');
    const actual = await readContentExecutionJob(dataStore, job.tenantId, job.taskId, job.runId);
    if (!actual || actual.id !== job.id) throw new Error('graph_job_scope_changed');
    return actual;
  };
  const approval = () => refreshedJob().then(actual => loadSocialProductionGraphApproval(repository, actual));
  const newCorrectionGraph=graphCorrection&&!job.checkpoints[`lg.fix.${correctionRuntimeHash}.v1`];
  const resume = !newCorrectionGraph&&job.checkpoints['social.graph_review'] ? await approval() : null;
  const phase = async (graphPhase: SocialProductionGraphPhase) => {
    await assertCurrentContentExecutionActive();
    let latest: Detail | null;
    try {
      latest = await readSocialProductionGraphDetail({ repository, tenantId: job.tenantId, taskId: job.taskId }, approvedContext);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}:${graphPhase}_detail`);
    }
    if (!latest || socialProductionGraphInput(latest, approvedContext).inputHash !== current.inputHash) throw new Error('user_input_required:graph_production_plan_changed:phase_input');
    await runSocialContentAutoProduction({ repository, tenantId: job.tenantId, userId: job.userId,
      taskId: job.taskId, runId: job.runId, graphPhase, runtime: input.runtime,
      assetSupplyAdapters: input.assetSupplyAdapters, assetSupplyRecoveryOnly: input.assetSupplyRecoveryOnly, materialEvidencePorts: input.materialEvidencePorts, graphApprovedContext: approvedContext,...(graphCorrection?{graphCorrectionHash:correctionRuntimeHash!}:{}) });
    if (graphPhase === 'quality' || graphPhase === 'creative_quality') {
      const artifact = await productionArtifact(repository, job);
      assertGraphArtifactQuality(artifact, job);
      const evidence = artifactEvidence(artifact);
      await recordCurrentContentExecutionCheckpoint({ stage: 'social.graph_review', version: '1', inputHash: current.inputHash,
        payload: { ...evidence, runId: job.runId } });
      return { artifactRefs: [evidence.artifactId], inputHash: current.inputHash,
        metadata: { contentHash: evidence.contentHash, ...(evidence.outputSha256 ? { outputSha256: evidence.outputSha256 } : {}) } };
    }
    const actual = await refreshedJob();
    const checkpointStage: Record<Exclude<SocialProductionGraphPhase, 'quality' | 'creative_quality'>, string> = {
      assets: 'social.asset_supply', voice: 'social.graph_voice', trim: 'social.graph_trim',
      effects: 'social.graph_effects', render: 'social.graph_render', technical_quality: 'social.graph_technical_quality',
    };
    const stage = checkpointStage[graphPhase];
    const checkpoint = actual.checkpoints[stage];
    return { artifactRefs: [], inputHash: checkpoint?.inputHash || current.inputHash,
      metadata: { checkpointStage: stage, ...(socialObject(checkpoint?.payload)?.outputSha256
        ? { outputSha256: socialObject(checkpoint?.payload)!.outputSha256 } : {}) } };
  };
  const phases = graphVersion === LEGACY_CONTENT_GRAPH_VERSION
    ? { assets: () => phase('assets'), render: () => phase('render'), quality: () => phase('quality') }
    : {
      assets: () => phase('assets'), voice: () => phase('voice'), trim: () => phase('trim'), effects: () => phase('effects'),
      render: () => phase('render'), technical_quality: () => phase('technical_quality'), creative_quality: () => phase('creative_quality'),
    };
  const result = await runLangGraphProduction({ identity, dataStore,...(graphCorrection?{correctionHash:correctionRuntimeHash!}:{}), assertActive: assertCurrentContentExecutionActive,
    phases: { ...phases,
      delivery: async () => {
        const accepted = await approval();
        if (!accepted) throw new Error('user_input_required:graph_delivery_review_required');
        const artifact = await productionArtifact(repository, job);
        const evidence = artifactEvidence(artifact);
        const task = await readSocialProductionGraphDetail({ repository, tenantId: job.tenantId, taskId: job.taskId }, approvedContext);
        if (!task) throw new Error('graph_task_missing');
        if (socialProductionGraphInput(task, approvedContext).inputHash !== current.inputHash)
          throw new Error('user_input_required:graph_production_plan_changed:delivery_input');
        const packaged = await createSocialDeliveryPackage({ repository, tenantId: job.tenantId, userId: job.userId,
          taskId: job.taskId, idempotencyKey: `graph-delivery:${job.id}:${accepted.contentHash}`,
          backendFilePort: input.runtime?.backendFilePort,
          value: { expectedTaskVersion: task.version, artifactIds: [socialText(artifact.artifact_id)] } });
        await writeExecutionStage({ repository, tenantId: job.tenantId, runId: job.runId, stage: 'delivery_prepared',
          message: '已核对人工审核回执，成片可以进入现有交付打包流程。',
          extra: { artifactId: socialText(artifact.artifact_id), approvalReceipt: accepted.receiptRef, externalPublishPerformed: false } });
        return { artifactRefs: [socialText(artifact.artifact_id), packaged.deliveryPackage.packageId], inputHash: current.inputHash,
          metadata: { artifactId: socialText(artifact.artifact_id), packageId: packaged.deliveryPackage.packageId,
            approvalReceipt: accepted.receiptRef, externalPublishPerformed: false,
            ...(evidence.outputSha256 ? { outputSha256: evidence.outputSha256 } : {}) } };
      } },
    review: { loadApproval: approval, verifyResume: async proposed => {
      const accepted = await approval();
      return !!accepted && socialRequestHash(accepted) === socialRequestHash(proposed);
    } }, ...(resume ? { resume } : {}) });
  if (result.status === 'waiting_review') {
    await assertCurrentContentExecutionActive();
    // A restored checkpoint may already sit at review from an older worker.
    // Recheck the immutable media and QA subject before projecting that state.
    const artifact = await productionArtifact(repository, job);
    assertGraphArtifactQuality(artifact, job);
    const actual = await refreshedJob();
    assertCurrentGraphReviewSubject(actual.checkpoints['social.graph_review'], artifact, job.runId);
    const expected = socialObject(actual.checkpoints['social.graph_review']?.payload);
    if (!expected) throw new Error('graph_review_subject_missing');
    await recordCurrentContentExecutionCheckpoint({ stage: 'social.graph_review', version: '1', inputHash: current.inputHash,
      payload: { ...expected, waitingReview: true } });
    await controlContentExecutionJob({ dataStore, tenantId: job.tenantId, jobId: job.id, action: 'pause', pauseOrigin: 'workflow_review' });
    await withStarter198RunMutationLease({ dataStore, tenantId: job.tenantId, runId: job.runId, action: async () => {
      const run = await repository.get(STARTER_COLLECTIONS.runs, job.tenantId, job.runId);
      if (run && ['running', 'waiting_external', 'waiting_approval', 'planning'].includes(String(run.status)))
        await repository.update(STARTER_COLLECTIONS.runs, job.tenantId, run.id,
          { status: 'waiting_human', current_controller: 'human', pause_reason: 'langgraph_artifact_review_required' });
    } });
  } else {
    const delivery = result.state.evidence.delivery;
    const metadata = socialObject(delivery?.metadata);
    if (!metadata?.artifactId || !metadata.packageId || !result.state.approval) throw new Error('graph_completion_business_evidence_missing');
    await recordCurrentContentExecutionCheckpoint({ stage: 'social.graph_completion', version: '1', inputHash: identity.inputHash,
      payload: { ...identity,...(graphCorrection?{financialPlanHash:String(binding?.inputHash),correctionHash:graphCorrection.recordHash,correctionRuntimeHash}:{}), approval: result.state.approval, artifactIds: [metadata.artifactId], packageIds: [metadata.packageId], externalPublishPerformed: false } });
  }
  return result;
}

export async function resumeApprovedSocialProductionGraph(input: {
  repository: Starter198Repository; tenantId: string; userId: string; taskId: string; artifactId: string;
}): Promise<string | null> {
  const dataStore = input.repository.dataStore;
  if (!dataStore) return null;
  const { listContentExecutionJobs } = await import('../contentExecution/durableQueue.js');
  const jobs = await listContentExecutionJobs(dataStore, input.tenantId);
  const candidates = jobs.filter(job => job.taskId === input.taskId && socialProductionExecutor(job) === 'langgraph'
    && job.status === 'paused' && !!job.checkpoints['social.graph_review']);
  if (candidates.length !== 1) return null;
  const job = candidates[0]!;
  const expected = socialObject(job.checkpoints['social.graph_review']?.payload);
  const pause = socialObject(job.checkpoints['runtime.pause']?.payload);
  if (pause?.origin !== 'workflow_review' || expected?.waitingReview !== true || expected.artifactId !== input.artifactId
    || !await loadSocialProductionGraphApproval(input.repository, job)) return null;
  const binding = socialObject(job.checkpoints['social.executor']?.payload);
  const ledger=new SocialContentTaskBudget(undefined,{authorization:async()=>{throw Error('read_only')},quote:async()=>{throw Error('read_only')},assertCurrent:async()=>{},verifyRejection:async()=>false});
  const grant=ledger.status({tenantId:job.tenantId,taskId:job.taskId,runId:job.runId,planHash:String(binding?.inputHash)})?.correctionAuthorization;
  const corrected=readGraphContextSnapshot(socialObject(job.checkpoints['social.corrected_executor']?.payload));
  const approvedContext=corrected&&matchesAuthorizedCorrectionContext(job,corrected,String(binding?.inputHash),grant?.recordHash)?corrected:readGraphContextSnapshot(binding);
  const detail = approvedContext?.agentWorkflow ? await readSocialProductionGraphDetail(input, approvedContext) : null;
  if (!detail || !approvedContext?.agentWorkflow || (socialProductionGraphInput(detail, approvedContext).inputHash !== binding?.inputHash&&!matchesAuthorizedCorrectionContext(job,approvedContext,String(binding?.inputHash),grant?.recordHash,socialProductionGraphInput(detail,approvedContext).inputHash))) throw new Error('user_input_required:graph_production_plan_changed');
  if (job.workerId !== null || job.leaseExpiresAt !== null) return null;
  const resumed = await withStarter198RunMutationLease({ dataStore, tenantId: job.tenantId, runId: job.runId, action: async () => {
    const run = await input.repository.get(STARTER_COLLECTIONS.runs, job.tenantId, job.runId);
    if (!run || run.status !== 'waiting_human' || run.pause_reason !== 'langgraph_artifact_review_required') return false;
    await controlContentExecutionJob({ dataStore, tenantId: job.tenantId, jobId: job.id, action: 'resume' });
    if (run?.status === 'waiting_human' && run.pause_reason === 'langgraph_artifact_review_required')
      await input.repository.update(STARTER_COLLECTIONS.runs, job.tenantId, run.id,
        { status: 'waiting_external', current_controller: 'agent', pause_reason: null });
    return true;
  } });
  return resumed ? job.id : null;
}
