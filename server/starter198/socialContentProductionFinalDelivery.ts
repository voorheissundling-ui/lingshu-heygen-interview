import type { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import type { SocialProductionResult } from '../../shared/contracts/socialContentWorkflow.js';
import { assertCurrentContentExecutionActive } from '../contentExecution/context.js';
import { socialExecutionExternalCost } from './socialContentAgentWorkflow.js';
import { socialExecutedSceneMediaArtifact, type SocialAssetSupplyExecution } from './socialContentAssetSupplyExecution.js';
import { AUTO_SCHEMA } from './socialContentProductionMaterials.js';
import { summarizeSelectedProviderCosts } from './socialContentProductionCost.js';
import { socialProductionCollaborationFailures, socialProductionExecutionSceneForFinal } from './socialContentProductionCollaboration.js';
import { evaluateSocialProductionReplication } from './socialContentProductionReplicationEvaluation.js';
import { writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import { socialReplicationHardQualityFailures } from './socialContentGraphQualityGate.js';
import { archiveGeneratedSocialContentFile, registerSocialContentFile,
  storeTransientSocialContentFile } from './socialContentFiles.js';
import { resolveSocialDirectorArtifactLineage, type SocialDirectorArtifactReference } from './socialContentDirectorPlanVersions.js';
import type { StoredSocialDirectorPlan, SocialDirectorContentHandoff } from './socialContentDirectorPlan.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';
import type { readSocialTaskDetail } from './socialContentRecords.js';
import type { executeSocialQualityStage } from './socialContentProductionStages.js';
import { socialRequestHash } from './socialContentValidation.js';

type Input = Parameters<typeof runSocialContentAutoProduction>[0];
type Detail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;
type Quality = Awaited<ReturnType<typeof executeSocialQualityStage>>;

/** Persist the rendered bytes and honest review state before creating the final artifact. */
export async function prepareSocialContentFinalDelivery(input: {
  execution: Input;
  detail: Detail;
  agentWorkflow: NonNullable<Detail['agentWorkflow']>;
  outputDir: string;
  outputPath: string;
  duration: number;
  coverTimestamp: number;
  createCover: NonNullable<NonNullable<Input['runtime']>['createCover']>;
  directorPlan: StoredSocialDirectorPlan;
  directorPlanReference: SocialDirectorArtifactReference;
  contentHandoff: SocialDirectorContentHandoff;
  rawAssets: SocialProductionAsset[];
  assets: SocialProductionAsset[];
  assetSupplyExecution: SocialAssetSupplyExecution | null;
  adaptedScript: string;
  timeline: Array<{ sceneId: string; targetStart: number; targetEnd: number }>;
  measuredDurationSeconds: number | null | undefined;
  technicalApproved: boolean;
  technicalFailures: string[];
  quality: Quality['quality'];
  sceneQuality: Quality['sceneQuality'];
  audio: Quality['audio'];
  productionMode: NonNullable<Detail['brief']['productionMode']>;
}) {
  const { execution, detail, agentWorkflow, contentHandoff, directorPlan, quality, sceneQuality,
    audio, technicalApproved, technicalFailures, assetSupplyExecution, assets } = input;
  const coverPath = await input.createCover({ videoPath: input.outputPath,
    outputDirectory: input.outputDir, timestamp: input.coverTimestamp });
  await assertCurrentContentExecutionActive();
  const stored = await storeTransientSocialContentFile({ filePath: input.outputPath,
    tenantId: execution.tenantId, name: `${detail.brief.title || '社媒内容'}-成品.mp4`, mimeType: 'video/mp4' });
  const file = await registerSocialContentFile({ repository: execution.repository,
    tenantId: execution.tenantId, userId: execution.userId, taskId: execution.taskId,
    usage: 'artifact_media',
    idempotencyKey: `social-auto-file:v2:${execution.taskId}:${stored.sha256}:${stored.storageKind}`,
    stored, ...(stored.storageKind === 'backend_file' ? { transientPath: input.outputPath } : {}),
    backendFilePort: execution.runtime?.backendFilePort });
  const storedCover = await storeTransientSocialContentFile({ filePath: coverPath,
    tenantId: execution.tenantId, name: `${detail.brief.title || '社媒内容'}-封面.jpg`, mimeType: 'image/jpeg' });
  const coverFile = await registerSocialContentFile({ repository: execution.repository,
    tenantId: execution.tenantId, userId: execution.userId, taskId: execution.taskId,
    usage: 'artifact_media',
    idempotencyKey: `social-auto-cover:v2:${execution.taskId}:${storedCover.sha256}:${storedCover.storageKind}`,
    stored: storedCover, ...(storedCover.storageKind === 'backend_file' ? { transientPath: coverPath } : {}),
    backendFilePort: execution.runtime?.backendFilePort });
  await resolveSocialDirectorArtifactLineage({ repository: execution.repository,
    tenantId: execution.tenantId, taskId: execution.taskId, reference: input.directorPlanReference });
  const productionResultId = `production_result_${socialRequestHash({ taskId: execution.taskId,
    runId: execution.runId, executionPlanId: agentWorkflow.executionPlan.executionPlanId }).slice(0, 20)}`;
  const replicationEvaluation = await evaluateSocialProductionReplication({
    repository: execution.repository, tenantId: execution.tenantId, taskId: execution.taskId,
    runId: execution.runId, runtime: execution.runtime, detail, agentWorkflow,
    rawAssets: input.rawAssets, productionResultId, outputPath: input.outputPath,
    adaptedScript: input.adaptedScript,
  });
  const creativeReviewFailures = socialProductionCollaborationFailures(agentWorkflow, contentHandoff, {
    referenceAnalysis: detail.referenceVideoAnalysis,
    renderedDurationSeconds: input.measuredDurationSeconds ?? input.duration,
    renderedTimeline: input.timeline.map(clip => ({ sceneId: clip.sceneId,
      startSeconds: clip.targetStart, endSeconds: clip.targetEnd })),
  });
  const replicationHardFailures = detail.brief.creationMode === 'viral_replication' && !replicationEvaluation
    ? ['reference_evaluation_missing'] : socialReplicationHardQualityFailures(replicationEvaluation);
  const replicationHumanReviewPending = replicationEvaluation?.status === 'review_required'
    && !replicationHardFailures.length;
  await writeExecutionStage({ ...execution, stage: 'creative_review',
    message: creativeReviewFailures.length
      ? '编导 Agent 的结构与表达验收未通过，正在停止提交并保留当前结果。'
      : !technicalApproved || creativeReviewFailures.length || replicationHardFailures.length
        ? '成片已保留为候选；独立媒体检测尚未自动放行，等待编导逐镜复核或局部返工。'
        : replicationHumanReviewPending
          ? '事实、权利、时间线和技术硬门禁通过；主观复刻效果留待用户最终验收。'
          : '技术质检和独立媒体检测通过，编导 Agent 已按 DirectorBrief 完成结构与表达验收。',
    extra: { directorBriefId: agentWorkflow.directorBrief.directorBriefId,
      checkedSceneCount: contentHandoff.scenes.length, failedCriteria: creativeReviewFailures,
      replicationEvaluationId: replicationEvaluation?.evaluationId ?? null,
      replicationEvaluationStatus: replicationEvaluation?.status ?? null,
      replicationHumanReviewPending } });
  const evaluationFailures = [...creativeReviewFailures,
    ...(replicationEvaluation?.status === 'passed' ? []
      : replicationEvaluation?.directorDecision.failedCriteria ?? [])];
  const plannedCostCny = socialExecutionExternalCost(agentWorkflow.executionPlan, agentWorkflow.directorBrief);
  const selectedAssetIds = new Set(contentHandoff.scenes.map(scene => scene.source.assetId));
  const archivedMaterialIdByAssetId = new Map((assetSupplyExecution?.shots ?? [])
    .filter(shot => shot.archivedMaterial)
    .map(shot => [shot.assetId, shot.archivedMaterial!.materialId]));
  const finalInputMaterialIds = [...selectedAssetIds]
    .map(assetId => archivedMaterialIdByAssetId.get(assetId) || assetId);
  const providerCostSummary = summarizeSelectedProviderCosts({ assets, selectedAssetIds });
  const deliverableStatus = input.productionMode === 'concept_preview' ? 'concept_preview'
    : !technicalApproved || creativeReviewFailures.length > 0 || replicationHardFailures.length > 0
      ? 'requires_revision' : 'publish_candidate';
  const finalQualityAccepted = technicalApproved && !creativeReviewFailures.length
    && !replicationHardFailures.length;
  const finalGeneratedMaterial = await archiveGeneratedSocialContentFile({ file, stored,
    archiveMedia: execution.runtime?.archiveGeneratedMedia,
    archive: { tenantId: execution.tenantId, name: `${detail.brief.title || '社媒内容'}-成品.mp4`,
      media: { type: 'video', localPath: input.outputPath,
        ...(stored.storageKind === 'object' ? { objectKey: stored.storageKey } : {}), duration: input.duration },
      generation: { pipelineId: 'non_person_generation', assetGenerationKind: 'final_video',
        pipelineVersion: AUTO_SCHEMA, executionId: productionResultId, provider: 'local_compositor',
        model: 'desktop/render.cjs', idempotencyKey: `social-auto-final:${execution.taskId}:${stored.sha256}`,
        inputFingerprint: socialRequestHash({ taskId: execution.taskId,
          directorPlanHash: directorPlan.lineageHash, selectedAssetIds: finalInputMaterialIds }),
        promptOrSpecHash: directorPlan.lineageHash, inputMaterialIds: finalInputMaterialIds,
        estimatedCostCny: plannedCostCny,
        // Visual reservations omit audio, QA and unknown invoices.
        actualCostCny: undefined },
      lineage: { sourceTaskId: execution.taskId, sourceAssemblyId: productionResultId },
      quality: { state: finalQualityAccepted ? 'accepted' : 'repair_required',
        policyVersion: 'social-final-video.v1', checkedAt: new Date().toISOString(),
        checks: [
          { key: 'visual_decode', status: quality.passed && sceneQuality.passed ? 'passed' : 'failed',
            evidence: `checked_scenes:${sceneQuality.checkedScenes}` },
          { key: 'audio_decode', status: audio.ok ? 'passed' : 'failed',
            evidence: audio.ok ? 'ffmpeg_audio_decode_passed' : 'ffmpeg_audio_decode_failed' },
          { key: 'director_review', status: creativeReviewFailures.length ? 'failed' : 'passed',
            evidence: agentWorkflow.directorBrief.directorBriefId },
          ...(replicationEvaluation ? [{ key: 'replication_evaluation',
            status: replicationHardFailures.length ? 'failed' as const : 'passed' as const,
            evidence: replicationEvaluation.evaluationId }] : []),
        ], rawReport: { visual: quality, scenes: sceneQuality, replicationEvaluation } },
      rightsScope: 'tenant_generated_reusable' },
  });
  const productionResult: SocialProductionResult = {
    productionResultId, version: detail.version,
    executionPlanId: agentWorkflow.executionPlan.executionPlanId,
    executionPlanVersion: agentWorkflow.executionPlan.version,
    executionPlanReviewId: agentWorkflow.executionPlanReview.reviewId,
    artifactId: null,
    creativeReviewId: `creative_review_${socialRequestHash({ taskId: execution.taskId,
      runId: execution.runId, directorBriefId: agentWorkflow.directorBrief.directorBriefId }).slice(0, 20)}`,
    publishAssignmentId: null, status: 'asset_review',
    sceneResults: contentHandoff.scenes.map(finalScene => {
      const scene = socialProductionExecutionSceneForFinal(agentWorkflow, finalScene.sceneId)!;
      const mediaArtifact = socialExecutedSceneMediaArtifact({ sceneId: finalScene.sceneId,
        execution: assetSupplyExecution, assets });
      return { sceneId: scene.sceneId, idempotencyKey: scene.idempotencyKey,
        sourceStrategy: scene.selectedSourceStrategy, feasibility: scene.feasibility,
        provenanceCandidateIds: scene.recommendedCandidateIds,
        ...(mediaArtifact ? { mediaArtifact } : {}) };
    }),
    technicalReview: { approved: technicalApproved, checkedScenes: sceneQuality.checkedScenes,
      failures: technicalFailures },
    creativeReview: { approved: !creativeReviewFailures.length && !replicationHardFailures.length,
      failedCriteria: evaluationFailures, reviewedBy: 'director_agent' },
    artifactResourceRef: file.fileRef, createdAt: new Date().toISOString(),
  };
  return { stored, file, storedCover, coverFile, productionResultId, replicationEvaluation,
    creativeReviewFailures, replicationHardFailures, replicationHumanReviewPending, plannedCostCny,
    providerCostSummary, deliverableStatus, finalQualityAccepted, finalGeneratedMaterial, productionResult };
}
