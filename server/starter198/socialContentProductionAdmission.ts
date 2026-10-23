import type { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import { assertStoredWeeklyProductionCoverage } from '../runtime/weeklyProductionCoverageAdmission.js';
import { objectStorageEnabled } from '../storage/objectStorage.js';
import { readWeeklyReplicationAuthority } from './socialWeeklyReplicationAuthority.js';
import { readWeeklySchedulerMaterialPlan } from './socialWeeklySchedulerMaterialPlan.js';
import { assertWeeklyProductionMaterialAdmission } from './socialWeeklyProductionMaterialGate.js';
import { bindCanonicalTypeAwareRouting } from './socialContentExecutionPlan.js';
import { replicationExecutionGaps, selectPresenterExecutions, verifyNamedPresenterLock } from './socialContentPresenterExecutionPolicy.js';
import { createEnvironmentSocialHeyGenBridge } from './socialContentHeyGenBridge.js';
import { socialContentReviewAdmissionAllowed } from './socialContentTestBypass.js';
import { AUTO_SCHEMA } from './socialContentProductionMaterials.js';
import { finishExecution, writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import { SOCIAL_SHOOTING_PLAN_SCHEMA } from './socialContentShootingPlan.js';
import { finishShootingPlanExecution } from './socialContentShootingPlanExecution.js';
import { readSocialTaskDetail, requireSocialTask } from './socialContentRecords.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialText } from './socialContentValidation.js';
import { socialExecutionExternalCost } from './socialContentAgentWorkflow.js';

type Input = Parameters<typeof runSocialContentAutoProduction>[0];

/** No supplier or render work may start before this original-run admission. */
export async function admitSocialContentProduction(input: Input) {
  await assertWeeklyProductionMaterialAdmission(input, input.materialEvidencePorts?.materialPorts,
    input.materialEvidencePorts);
  const admissionRow = await requireSocialTask(input);
  const admissionAuthority = socialObject(socialObject(socialJson(admissionRow.brief))?._weeklyAuthority);
  if (socialObject(socialObject(socialJson(admissionRow.brief))?._productionRevision)
    && socialText(admissionRow.run_id) !== input.runId) {
    throw new SocialContentWorkflowError('social_revision_run_superseded', 409);
  }
  if (admissionAuthority || String(admissionRow.create_idempotency_key ?? '').startsWith('weekly-production:')) {
    if (!admissionAuthority) throw new SocialContentWorkflowError('weekly_production_start_authority_invalid', 409);
    if (!input.repository.dataStore) throw new SocialContentWorkflowError('weekly_production_planning_missing', 409);
    const pkg = socialObject(admissionAuthority.weeklyPackage) as unknown as
      import('../../shared/contracts/socialProgram.js').WeeklyOperatingPackage;
    const publication = socialObject(admissionAuthority.publicationTask);
    if (!pkg || !publication?.publicationTaskId) {
      throw new SocialContentWorkflowError('weekly_production_start_authority_invalid', 409);
    }
    await assertStoredWeeklyProductionCoverage({ store: input.repository.dataStore,
      tenantId: input.tenantId, package: pkg,
      publicationTaskId: String(publication.publicationTaskId), frozenPlanning: pkg.agentPlanning });
  }
  let detail = await readSocialTaskDetail(input);
  if (!detail) throw new Error('社媒内容任务不存在');
  const usesTypeAwareRouting = ['type-aware.v1', 'type-aware.v2']
    .includes(detail.brief.materialRoutingPolicyVersion ?? '')
    && (detail.brief.productionApproach ?? 'ai_enhanced') === 'ai_enhanced';
  const canonicalTypeAwareSupplyPlan = usesTypeAwareRouting ? detail.assetSupplyPlan : null;
  if (input.graphPhase && input.graphApprovedContext) {
    detail = { ...detail, ...structuredClone(input.graphApprovedContext) };
  }
  const originalReplication = await readWeeklyReplicationAuthority(input.repository, admissionRow);
  const replicationContext = originalReplication?.context;
  if (originalReplication && detail.agentWorkflow) detail.agentWorkflow.replicationJob = originalReplication.job;
  const frozenSchedulerPlan = await readWeeklySchedulerMaterialPlan(input.repository, admissionRow, detail);
  if (frozenSchedulerPlan) detail.assetSupplyPlan = frozenSchedulerPlan;
  else if (input.repository.dataStore) {
    const originalRun = await input.repository.dataStore.getById<Record<string, unknown>>('workflow_runs', input.runId);
    if (socialObject(socialObject(socialJson(originalRun?.starter_context))?.weeklyMaterialPlan)) {
      throw new SocialContentWorkflowError('weekly_scheduler_material_plan_changed', 409);
    }
  }
  // The planner's reviewed route is authoritative over older graph/scheduler overlays.
  if (usesTypeAwareRouting) {
    if (!detail.assetSupplyPlan || !canonicalTypeAwareSupplyPlan) throw Error('type_aware_frozen_plan_missing');
    detail.assetSupplyPlan = bindCanonicalTypeAwareRouting(detail.assetSupplyPlan, canonicalTypeAwareSupplyPlan);
  }
  const productionApproach = detail.brief.productionApproach ?? 'ai_enhanced';
  if (detail.brief.creationMode === 'viral_replication' && productionApproach !== 'shooting_plan') {
    const gaps = replicationExecutionGaps(detail);
    if (gaps.length) {
      await writeExecutionStage({ ...input, stage: 'replication_handoff_gate',
        message: '编导交接物缺少逐镜可执行证据，已停止成片制作和付费供应商调用。',
        extra: { gateVersion: '1', gaps } });
      throw new Error(`user_input_required:replication_handoff_blocked:${gaps
        .map(gap => `${gap.sceneId}:${gap.reasonCodes.join(',')}`).join(';')}`);
    }
  }
  const targetArtifactKind = productionApproach === 'shooting_plan' ? 'shooting_plan' : 'short_video';
  const targetWorkflowSchema = productionApproach === 'shooting_plan' ? SOCIAL_SHOOTING_PLAN_SCHEMA : AUTO_SCHEMA;
  let revisionParent = productionApproach === 'shooting_plan' ? undefined
    : [...detail.artifacts].reverse().find(artifact => artifact.kind === 'short_video'
      && artifact.status === 'changes_requested');
  const existing = detail.artifacts.find(artifact => artifact.origin === 'agent'
    && artifact.kind === targetArtifactKind
    && socialText(artifact.content?.workflowSchema) === targetWorkflowSchema
    && !['superseded', 'changes_requested'].includes(artifact.status)
    && (!input.graphPhase || socialObject(artifact.content?.productionWorkspaceSource)?.runId === input.runId)
    && (!input.graphCorrectionHash
      || socialObject(artifact.content?.productionWorkspaceSource)?.correctionHash === input.graphCorrectionHash));
  if (input.graphCorrectionHash && !existing && !revisionParent) {
    revisionParent = [...detail.artifacts].reverse().find(artifact => artifact.kind === 'short_video'
      && socialObject(artifact.content?.productionWorkspaceSource)?.runId === input.runId);
  }
  if (!revisionParent && existing) {
    if (!input.graphPhase) {
      if (productionApproach === 'shooting_plan') {
        await finishShootingPlanExecution({ ...input, backendFilePort: input.runtime?.backendFilePort }, existing.artifactId);
      } else {
        await finishExecution({ ...input, backendFilePort: input.runtime?.backendFilePort,
          artifactId: existing.artifactId });
      }
    }
    return { completed: true as const };
  }
  const agentWorkflow = detail.agentWorkflow;
  if (!agentWorkflow || !socialContentReviewAdmissionAllowed({
    approved: agentWorkflow.executionPlanReview.approved,
    reasonCodes: agentWorkflow.executionPlanReview.reasonCodes,
  })) {
    const required = agentWorkflow?.executionPlanReview.requiredRevision.join('；')
      || '内容执行方案尚未通过编导逐镜审核';
    throw new Error(`user_input_required:${required}`);
  }
  let presenterExecutions: ReturnType<typeof selectPresenterExecutions> = [];
  if (detail.brief.creationMode === 'viral_replication') {
    if (agentWorkflow.directorBrief.scenes.some(scene => scene.productionRouting?.needsPreciseLipSync
      || scene.productionRouting?.presenterIdentityReplacementRequired)) {
      const namedPresenter = await verifyNamedPresenterLock({ store: input.repository.dataStore ?? null,
        tenantId: input.tenantId, name: detail.brief.requestedPresenterName,
        requestedPresenterAssetId: detail.brief.requestedPresenterAssetId,
        selectedEnterprisePresenterAssetId: detail.brief.presenterAssetId,
        provider: agentWorkflow.directorBrief.scenes.some(scene => scene.productionRouting?.needsPreciseLipSync)
          ? 'heygen' : 'volcengine_ark', lock: agentWorkflow.directorBrief.accountPresenterLock });
      if (!namedPresenter.ok) {
        await writeExecutionStage({ ...input, stage: 'presenter_stack_selection',
          message: '指定人物未能与已发布的账号人物版本唯一匹配，已停止自动付费调用。',
          extra: { policyVersion: '1', reason: namedPresenter.reason } });
        throw new Error(`user_input_required:presenter_identity_blocked:${namedPresenter.reason}`);
      }
    }
    const heygenBridge = input.repository.dataStore
      ? createEnvironmentSocialHeyGenBridge(input.repository.dataStore, input.tenantId) : null;
    const wholeFilmPresenterConfigured = ['type-aware.v1', 'type-aware.v2']
      .includes(detail.brief.materialRoutingPolicyVersion || '')
      && process.env.SOCIAL_CONTENT_HEYGEN_ENABLED === 'true'
      && process.env.HEYGEN_GENERATION_ENABLED === 'true'
      && Boolean(process.env.HEYGEN_API_KEY?.trim()) && objectStorageEnabled();
    presenterExecutions = selectPresenterExecutions({ detail,
      heygenReady: productionApproach === 'ai_enhanced'
        && (wholeFilmPresenterConfigured || Boolean(heygenBridge?.readiness.ready && heygenBridge.ports)),
      seedancePresenterReady: productionApproach === 'ai_enhanced'
        && process.env.SEEDANCE_VIDEO_ENABLED === 'true'
        && Boolean(process.env.SEEDANCE_API_KEY?.trim()) && objectStorageEnabled(),
      budgetReady: productionApproach === 'ai_enhanced'
        && (wholeFilmPresenterConfigured || Boolean(heygenBridge?.readiness.ready)
          || process.env.SEEDANCE_VIDEO_ENABLED === 'true'
            && Boolean(process.env.SEEDANCE_API_KEY?.trim()) && objectStorageEnabled()),
    });
    if (presenterExecutions.length) {
      await writeExecutionStage({ ...input, stage: 'presenter_stack_selection',
        message: presenterExecutions.every(item => item.executionStatus === 'ready')
          ? '内容 Agent 已依据逐镜测量证据锁定人物技术栈。'
          : '逐镜人物技术栈缺少可执行证据或能力，已停止自动付费调用。',
        extra: { policyVersion: '1', presenterExecutions } });
      if (presenterExecutions.some(item => item.executionStatus === 'blocked')) {
        throw new Error(`user_input_required:presenter_stack_blocked:${presenterExecutions
          .filter(item => item.executionStatus === 'blocked')
          .map(item => `${item.sceneId}:${item.reasonCodes.join(',')}`).join(';')}`);
      }
    }
  }
  await writeExecutionStage({ ...input, stage: 'execution_plan_approved',
    message: '内容 Agent 已提交逐镜执行方案，编导 Agent 自动审核通过，开始锁定并执行。',
    extra: { agentWorkflowSchema: agentWorkflow.schemaVersion,
      directorBriefId: agentWorkflow.directorBrief.directorBriefId,
      directorBriefVersion: agentWorkflow.directorBrief.version,
      executionPlanId: agentWorkflow.executionPlan.executionPlanId,
      executionPlanVersion: agentWorkflow.executionPlan.version,
      executionPlanReviewId: agentWorkflow.executionPlanReview.reviewId,
      reviewRound: agentWorkflow.executionPlan.reviewRound,
      maxReviewRounds: agentWorkflow.executionPlan.maxReviewRounds,
      plannedCostCny: socialExecutionExternalCost(agentWorkflow.executionPlan, agentWorkflow.directorBrief),
      plannedSeconds: agentWorkflow.executionPlan.scenes.reduce((sum, scene) => sum + scene.estimatedSeconds, 0) } });
  return { completed: false as const, detail, productionApproach, originalReplication,
    replicationContext, usesTypeAwareRouting, canonicalTypeAwareSupplyPlan,
    revisionParent, agentWorkflow, presenterExecutions };
}
