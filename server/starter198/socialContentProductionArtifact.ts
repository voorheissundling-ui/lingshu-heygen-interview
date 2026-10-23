import { assertCurrentContentExecutionActive } from '../contentExecution/context.js';
import { voiceLearningReadiness } from '../videoProduction/voiceQualityLearning.js';
import type { admitSocialContentProduction } from './socialContentProductionAdmission.js';
import type { prepareSocialContentProductionDirector } from './socialContentProductionDirectorPreparation.js';
import type { prepareSocialContentFinalDelivery } from './socialContentProductionFinalDelivery.js';
import type { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import type { inspectSocialContentProductionTechnicalQuality } from './socialContentProductionTechnicalQuality.js';
import type { prepareSocialContentProductionVoice } from './socialContentProductionVoicePreparation.js';
import type { PreparedWholeVoice } from './socialContentPreparedWholeVoice.js';
import { initialSceneCacheInputFingerprint, initialSceneSourceHashes } from './socialContentInitialSceneCache.js';
import { socialProductionCollaborationTrace, socialProductionExecutionSceneForFinal } from './socialContentProductionCollaboration.js';
import { socialDirectorVoiceAlignedCaptionCues } from './socialContentDirectorPlan.js';
import { socialContentFileDownloadUrl } from './socialContentFiles.js';
import { createSocialContentArtifact } from './socialContentOutputs.js';
import { AUTO_SCHEMA } from './socialContentProductionMaterials.js';
import type { productionAdaptation, resolveLockedBgm, socialReviewRevisionDirective } from './socialContentAutoProduction.js';
import type { SocialAssetSupplyExecution } from './socialContentAssetSupplyExecution.js';
import type { SocialProductionAsset, SocialProductionPlan } from './socialContentProductionPlan.js';
import type { readSocialTaskDetail } from './socialContentRecords.js';
import type { assertMeasuredCaptionTiming } from './socialContentCaptionTiming.js';
import type { StarterRecord } from './repository.js';
import { socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';

type Execution = Parameters<typeof runSocialContentAutoProduction>[0];
type Detail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;
type Director = Awaited<ReturnType<typeof prepareSocialContentProductionDirector>>;
type Delivery = Awaited<ReturnType<typeof prepareSocialContentFinalDelivery>>;
type Technical = Awaited<ReturnType<typeof inspectSocialContentProductionTechnicalQuality>>;
type Voice = Awaited<ReturnType<typeof prepareSocialContentProductionVoice>>;

/** Persist the user-reviewable artifact with exact media, cost, lineage and QA evidence. */
export async function createSocialContentProductionArtifact(scope: {
  execution: Execution;
  detail: Detail;
  taskRecord: StarterRecord;
  revisionParent: Awaited<ReturnType<typeof admitSocialContentProduction>>['revisionParent'];
  reviewDirective: ReturnType<typeof socialReviewRevisionDirective> | null;
  agentWorkflow: NonNullable<Detail['agentWorkflow']>;
  baseline: Parameters<typeof initialSceneCacheInputFingerprint>[0]['baseline'];
  manifest: Record<string, unknown>;
  contentHandoff: Director['contentHandoff'];
  directorPlan: Director['directorPlan'];
  directorSummary: Director['directorSummary'];
  directorPlanReference: Director['persistedDirectorPlan']['reference'];
  delivery: Delivery;
  technical: Technical;
  voice: Voice['voice'];
  voiceDuration: number;
  captionCues: ReturnType<typeof socialDirectorVoiceAlignedCaptionCues>;
  captionTiming: ReturnType<typeof assertMeasuredCaptionTiming> | null;
  preparedWholeVoice: PreparedWholeVoice | null;
  adaptation: ReturnType<typeof productionAdaptation>;
  plan: SocialProductionPlan;
  executedSupplyPlan: Parameters<typeof initialSceneCacheInputFingerprint>[0]['plan'] | null;
  assetSupplyExecution: SocialAssetSupplyExecution | null;
  assets: SocialProductionAsset[];
  bgm: Awaited<ReturnType<typeof resolveLockedBgm>>;
  adaptedScript: string;
}) {
  const input = scope.execution;
  const { detail, taskRecord, revisionParent, reviewDirective, agentWorkflow,
    contentHandoff, directorPlan, directorSummary, voice, voiceDuration, captionCues,
    captionTiming, preparedWholeVoice, adaptation, plan, executedSupplyPlan,
    assetSupplyExecution, assets, bgm, adaptedScript } = scope;
  const activeBaseline = scope.baseline;
  const compositeManifest = scope.manifest;
  const persistedDirectorPlan = { reference: scope.directorPlanReference };
  const { stored, file, storedCover, coverFile, productionResultId, replicationEvaluation,
    creativeReviewFailures, replicationHardFailures, replicationHumanReviewPending, plannedCostCny,
    providerCostSummary, deliverableStatus, finalQualityAccepted, finalGeneratedMaterial,
    productionResult } = scope.delivery;
  const { technicalQualityReport, technicalApproved, quality, sceneQuality, audio } = scope.technical;
  let initialSceneSourceEvidence:Awaited<ReturnType<typeof initialSceneSourceHashes>>|null=null;
  if(assetSupplyExecution){try{initialSceneSourceEvidence=await initialSceneSourceHashes({assets,execution:assetSupplyExecution,voicePath:voice.localPath,bgmUrl:bgm.url||null});}catch{/* Actual output remains reviewable; missing source bytes cannot create a cache. */}}
  await assertCurrentContentExecutionActive();
  const artifactResult = await createSocialContentArtifact({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.taskId,
    // A failed local render may be rebuilt within the same durable run after
    // QA identifies a deterministic compositor defect. Bind artifact creation
    // to the actual media bytes so the corrected render is reviewable while
    // provider work and the run identity remain unchanged.
    idempotencyKey: `social-auto-artifact:${input.runId}:${stored.sha256}`,
    trustedAgentOrigin: true,
    requireHumanReview: Boolean(input.graphPhase),
    now: input.now,
	backendFilePort: input.runtime?.backendFilePort,
    value: {
      kind: 'short_video',
      platform: contentHandoff.outputSpec.platform,
      language: contentHandoff.outputSpec.language,
      origin: 'agent',
      parentArtifactId: (input.graphPhase && input.graphApprovedContext?.revisionPlanHash ? socialText(socialObject(socialObject(socialJson(taskRecord.brief))?._productionRevision)?.parentArtifactId) : '') || revisionParent?.artifactId,
      resourceRef: file.fileRef,
      content: {
        workflowSchema: AUTO_SCHEMA,
        productionWorkspaceSource: {type:'actual_social_render',creationMode:detail.brief.creationMode||'material_processing',runId:input.runId,...(input.graphCorrectionHash?{correctionHash:input.graphCorrectionHash}:{}),baselineHash:socialRequestHash(activeBaseline),manifestHash:socialRequestHash(compositeManifest),outputSha256:file.sha256},
        technicalQualityReport,
        initialSceneSourceHashes:initialSceneSourceEvidence,
        ...(executedSupplyPlan&&assetSupplyExecution?{initialSceneCacheInput:initialSceneCacheInputFingerprint({plan:executedSupplyPlan,baseline:activeBaseline,execution:assetSupplyExecution,manifest:compositeManifest as unknown as Record<string,unknown>,productionSceneIds:contentHandoff.scenes.map(scene=>socialProductionExecutionSceneForFinal(agentWorkflow,scene.sceneId)!.sceneId)})}:{}),
        sourceKey: `social_task_auto:${input.taskId}`,
        contentType: 'short_video',
        mediaStorage: {
          provider: stored.storageKind === 'object' ? 'object_storage' : 'pocketbase_file',
          video: {
            fileRef: file.fileRef,
            fileId: file.fileId,
            sha256: file.sha256,
            url: file.downloadUrl || socialContentFileDownloadUrl(file.fileId),
          },
          cover: {
            fileRef: coverFile.fileRef,
            fileId: coverFile.fileId,
            sha256: coverFile.sha256,
            url: coverFile.downloadUrl || socialContentFileDownloadUrl(coverFile.fileId),
          },
        },
        generatedMaterial: {
          materialId: finalGeneratedMaterial.id,
          materialRevision: stored.sha256,
          generationExecutionId: productionResultId,
          adoptedAt: new Date().toISOString(),
        },
        // G5 compares the rendered artifact against the exact frozen baseline
        // used to build the scene cache. A lossy summary cannot prove that
        // account constraints, fact keys, template structure, or timing stayed
        // unchanged through rendering.
        scriptBaseline: structuredClone(activeBaseline),
        directorPlan: directorSummary,
        directorPlanReference: persistedDirectorPlan.reference,
        productionResult,
        ...(replicationEvaluation ? { replicationEvaluation } : {}),
        costSummary: {
          currency: 'CNY',
          estimatedBeforeGenerationCny: plannedCostCny,
          // Compatibility total: actual charges plus estimates whose provider
          // bill is still pending. The split fields and status prevent this
          // number from being mistaken for a fully settled amount.
          recordedProviderCostCny: providerCostSummary.recordedCostCny,
          actualProviderCostCny: providerCostSummary.actualCostCny,
          estimatedUnsettledProviderCostCny: providerCostSummary.estimatedUnsettledCostCny,
          providerSegmentCount: providerCostSummary.providerSegmentCount,
          settlementStatus: providerCostSummary.settlementStatus,
          note: providerCostSummary.settlementStatus === 'settled'
            ? '实际费用只统计本次已记录的媒体供应商调用；存储、带宽和人工审核未计入。'
            : '部分供应商费用仍为预计或未知，不能视为最终结算；存储、带宽和人工审核未计入。',
        },
        delivery: {
          status: deliverableStatus,
          label: deliverableStatus === 'publish_candidate'
            ? replicationHumanReviewPending ? '硬门禁通过，复刻效果待用户验收' : '待用户验收；验收后可主动发布'
            : deliverableStatus === 'concept_preview'
              ? '概念样片，不可直接发布'
              : '需要修改后再发布',
        },
        adaptedScript,
        scriptAdaptation: adaptation,
	    ...(assetSupplyExecution ? { assetSupplyExecution } : {}),
        narration: {
          changedFromBaseline: adaptation.narrationChanged,
          source: voice.source || 'unknown',
          duration: voiceDuration,
          cueCount: captionCues.length,
          ...(captionTiming&&preparedWholeVoice?{timingProof:{...captionTiming,audioSha256:preparedWholeVoice.wholeTrackSha256,alignmentReceiptRef:preparedWholeVoice.alignmentReceiptRef}}:{}),
          alignmentSource: voice.alignmentSource || 'unknown',
          qualityReport: voice.qualityReport ?? null,
          learningReadiness: voiceLearningReadiness({ technicalPassed: voice.qualityReport?.passed === true }),
        },
        agentCollaboration: socialProductionCollaborationTrace(agentWorkflow, contentHandoff),
        materialLearning: plan.materialLearning ?? null,
        effectPlan: contentHandoff.effectPlan,
        render: {
          completed: true,
          materialSourceIds: [...new Set(contentHandoff.scenes.map(scene => scene.source.sourceId))],
          selectedAssetIds: [...new Set(contentHandoff.scenes.map(scene => scene.source.assetId))],
          unusedAssets: directorPlan.unusedAssets,
          sourceClipSeconds: contentHandoff.scenes.reduce((sum, scene) => (
            sum + Math.max(0, scene.source.sourceEnd - scene.source.sourceStart)
          ), 0),
          materialAnalysisConfidence: directorPlan.scenes.reduce((sum, scene) => (
            sum + scene.shotPlan.confidence
          ), 0) / Math.max(1, directorPlan.scenes.length),
          materialMatchScore: directorPlan.scenes.reduce((sum, scene) => (
            sum + scene.shotPlan.semanticScore
          ), 0) / Math.max(1, directorPlan.scenes.length),
          qualityPassed: technicalApproved,
          qualityMetrics: quality.metrics,
          checkedScenes: sceneQuality.checkedScenes,
          audioDecoded: audio.ok,
          bgm: {
            id: bgm.id,
            volume: contentHandoff.bgmSelection.volume,
            mood: [contentHandoff.bgmSelection.primary, ...contentHandoff.bgmSelection.fallbacks]
              .find(track => track.trackId === bgm.id)?.mood ?? contentHandoff.direction.music.mood,
            authorization: [contentHandoff.bgmSelection.primary, ...contentHandoff.bgmSelection.fallbacks]
              .find(track => track.trackId === bgm.id)?.authorization ?? null,
          },
          coverIntent: contentHandoff.coverIntent,
          degradation: adaptation.limitedMaterialFallback ? adaptation.notes : [],
        },
        review: {
          state: deliverableStatus === 'publish_candidate' ? 'requires_user_approval' : 'requires_revision',
          deliverableStatus,
          replicationHumanReviewPending,
          technicalChecksPassed: technicalApproved,
          creativeChecksPassed: !creativeReviewFailures.length&&!replicationHardFailures.length,
          automatedChecksPassed: finalQualityAccepted,
        },
        ...(revisionParent && reviewDirective ? {
          reviewRevision: {
            parentArtifactId: revisionParent.artifactId,
            feedbackHash: reviewDirective.feedbackHash,
            categories: reviewDirective.categories,
          },
        } : {}),
        productionHash: socialRequestHash({
          directorPlan,
          adaptation,
          videoSha256: stored.sha256,
          coverSha256: storedCover.sha256,
        }),
      },
    },
  });
  return artifactResult;
}
