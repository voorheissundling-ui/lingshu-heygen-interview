import {readWeeklyReplicationAuthority} from './socialWeeklyReplicationAuthority.js';
import {assertWeeklyProductionMaterialAdmission} from './socialWeeklyProductionMaterialGate.js';
import type {WeeklyOwnedProductIdentityPorts} from '../runtime/weeklyOwnedProductIdentityDemand.js';
import { existsSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import type {
  SocialContentTaskBrief,
  SocialContentThemeId,
  SocialProductionResult,
  SocialTaskSource,
} from '../../shared/contracts/socialContentWorkflow.js';
import { inspectRenderedScenes, inspectRenderedVisuals, runVisualFfmpeg } from '../lib/renderVisualQuality.js';
import { readMaterialLibrary, type MaterialRecord } from '../lib/materialLibrary.js';
import { resolveSourceDurations } from '../lib/videoSourcePlan.js';
import {
  automationBgmAudio,
  automationBgmCatalog,
  readTenantEnterpriseProfile,
  synthesizeStudioVoiceForAutomation,
} from '../lib/socialContentLegacyPorts.js';
import { analyzeProductionMaterial } from '../digitalEmployees/productionMaterialAnalysis.js';
import { objectStorageEnabled, objectStorageSignedGetUrl } from '../storage/objectStorage.js';
import { store, dataBackend } from '../storage/index.js';
import type {DataStore} from '../storage/datastore.js';
import { currentDataAuthority, runWithDataAuthority } from '../storage/dataAuthority.js';
import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import { createAgentNotification } from '../notifications/agentNotifications.js';
import { enqueueBullJob, selectedQueueBackend, startBullWorker } from '../queues/bullmq.js';
import {
  admitContentExecutionJob,
  bindPristineContentExecutionCheckpoints,
  DurableContentExecutionWorker,
  hasCompleteFootageRevisionProductionAdmission,
  readContentExecutionJob,
  type ContentExecutionJob,
} from '../contentExecution/durableQueue.js';
import { admitProductionGraphJob, createProductionGraphBridgeCheckpoint, productionGraphIdentityFromJob, PRODUCTION_GRAPH_BRIDGE_CHECKPOINT } from '../contentExecution/productionGraphBridge.js';
import { createSocialContentArtifact } from './socialContentOutputs.js';
import {
  inspectTransientSocialContentFile,
  registerSocialContentFile,
  socialContentFileDownloadUrl,
  type SocialContentBackendFilePort,
} from './socialContentFiles.js';
import {
  materializeSocialContentCloudMaterial,
  socialContentCloudMaterialRecordId,
  type SocialContentCloudMaterialPort,
} from './socialContentMaterialAccess.js';
import { withSocialContentRenderWorkspace } from './socialContentRenderWorkspace.js';
import { readSocialTaskDetail, requireSocialTask, socialTaskSummary } from './socialContentRecords.js';
import { createStarter198Repository, STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';
import {
  freezeSocialScriptBaseline,
  parseStoredSocialScriptBaseline,
  SOCIAL_SCRIPT_GROUNDING_VERSION,
  verifiedSocialScriptContext,
  type StoredSocialScriptBaseline,
} from './socialContentScriptBaseline.js';
import { resolveSocialContentFormulaReference } from './socialContentFormulas.js';
import { runOutsideSocialContentMutationScope } from './socialContentMutation.js';
import { resolveSocialInspirationScript } from './socialContentScriptSources.js';
import {
  buildSocialProductionPlan,
  type SocialProductionAsset,
  type SocialProductionPlan,
} from './socialContentProductionPlan.js';
import { evaluateSocialReplicationResult } from './replicationEvaluationAdapter.js';
import {
  executeSocialAssetSupplyPlan,
  type SocialAssetSupplyExecution,
  type SocialAssetSupplyProviderAdapter,
} from './socialContentAssetSupplyExecution.js';
import { createConfiguredSocialAiVisualAdapter } from './socialContentAiVisualAdapter.js';
import { createSocialDigitalPresenterAdapter } from './socialContentDigitalPresenterAdapter.js';
import { createEnvironmentSocialHeyGenBridge } from './socialContentHeyGenBridge.js';
import {
  buildSocialDirectorPlan,
  parseStoredSocialDirectorPlan,
  publicSocialDirectorPlanSummary,
  reviseSocialDirectorPlanForVoiceoverFit,
  socialDirectorContentHandoff,
  socialDirectorCoverTimestamp,
  socialDirectorRenderTimeline,
  socialDirectorSceneTimingCues,
  socialDirectorScriptText,
  type SocialDirectorBgmSelection,
  type SocialDirectorBgmTrack,
  type SocialDirectorContentHandoff,
} from './socialContentDirectorPlan.js';
import {
  persistSocialDirectorPlanVersion,
  resolveSocialDirectorArtifactLineage,
} from './socialContentDirectorPlanVersions.js';
import type { InternalSocialContentFormula } from './socialContentThemes.js';

const require = createRequire(import.meta.url);
const { composite } = require('../../desktop/render.cjs') as {
  composite: (
    manifest: unknown,
    onProgress?: (progress: number) => void,
    outputDir?: string,
  ) => Promise<{ ok: boolean; outputPath?: string; error?: string }>;
};

import { MEDIA_ROOT, type ProductionAsset, type SocialProductionBaseline, type SocialProductionAdaptation, type SocialReviewRevisionDirective, automaticSocialMaterialEligible, detectDistinctTaskVideoSegments, hasExactTaskProductAssociation, resolveTaskProductionMaterialLocation, taskProductionAssets, systemThemeGraphicAssets, applyZeroAssetTruthSafeNarration, socialReviewRevisionDirective, applySocialReviewRevision, createVideoCover, type SocialContentAutoProductionRuntime } from './socialContentAutoProduction.js';
import { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import { createSocialProductionExecutorCheckpoint, executeSocialProductionGraph, resumeApprovedSocialProductionGraph, socialProductionExecutor } from './socialContentProductionGraph.js';
import { completeSocialContentGraphRun, recoverSocialContentGraphCompletions } from './socialContentGraphCompletion.js';
import { failExecution, writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import { executeSocialSceneReworkJob, completeSocialSceneReworkRun, isSocialSceneReworkJob } from './socialContentSceneReworkExecution.js';
import { createPresenterFirstFrameProductionRuntime,createPresenterFirstFrameStaticExecutor } from './socialContentPresenterFirstFrameRuntime.js';
export async function runSocialContentAutoProductionWithRetry(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  runId: string;
  materialEvidencePorts?:WeeklyOwnedProductIdentityPorts;
  runtime?: SocialContentAutoProductionRuntime;
}): Promise<void> {
  // The durable queue owns retry classification and delay. Keeping retries in
  // one layer prevents one paid failure from multiplying across nested loops.
  await runSocialContentAutoProduction(input);
}

export function assertWeeklyProductionGraphJob(input:{taskMode:string;requestedExecutor:unknown;job:ContentExecutionJob}):void{
  if(input.taskMode!=='weekly')return;
  if(input.requestedExecutor!=='langgraph')throw new Error('weekly_production_graph_executor_required');
  const historicalExecutor=socialObject(input.job.checkpoints['social.executor']?.payload)?.executor;
  if(input.job.checkpoints[PRODUCTION_GRAPH_BRIDGE_CHECKPOINT])productionGraphIdentityFromJob(input.job);
  else if(!(historicalExecutor==='legacy'&&input.job.lastStartedAt))throw new Error('weekly_production_graph_bridge_required');
}

let productionWorker: DurableContentExecutionWorker | null = null;
const dedicatedExecutors = new Map<string, (repository: Starter198Repository, job: ContentExecutionJob) => Promise<void>>([
  ['social_scene_rework', executeSocialSceneReworkJob],
]);

export async function assertSocialSceneReworkQueueRegistered(): Promise<void> {
  if (dedicatedExecutors.get('social_scene_rework') !== executeSocialSceneReworkJob) {
    throw new Error('scene_rework_worker_not_registered');
  }
}

export async function wakeSocialSceneReworkJob(jobId: string): Promise<void> {
  await assertSocialSceneReworkQueueRegistered();
  if (selectedQueueBackend() === 'bullmq') {
    await enqueueBullJob({ queue: 'social-content-production', name: 'wake-durable-job', data: { jobId }, jobId });
  }
  await productionWorker?.drain();
}

async function executePersistedProduction(job: ContentExecutionJob, dataStore:DataStore=store): Promise<void> {
  const repository = createStarter198Repository(dataStore);
  const runtime = createPresenterFirstFrameProductionRuntime(dataStore,createPresenterFirstFrameStaticExecutor(dataStore));
  if (job.taskType.startsWith('social_scene_rework:')) {
    if (!isSocialSceneReworkJob(job)) throw new Error('scene_rework_job_type_invalid');
    await assertSocialSceneReworkQueueRegistered();
    await dedicatedExecutors.get('social_scene_rework')!(repository, job);
    return;
  }
  let record = await requireSocialTask({ repository, tenantId: job.tenantId, taskId: job.taskId });
  const footageRevision = socialObject(socialObject(socialJson(record.brief))?._productFootageRevision);
  if (footageRevision && job.runId !== socialText(footageRevision.sourceRunId)
    && !hasCompleteFootageRevisionProductionAdmission(job, footageRevision))
    throw new Error('user_input_required:product_footage_revision_worker_admission_required');
  const {reconcileSocialContentOrderProjection}=await import('./socialContentOrderProjection.js');
  await reconcileSocialContentOrderProjection({repository,tenantId:job.tenantId,taskId:job.taskId});
  const rawJob = await dataStore.getById<StarterRecord>('content_execution_jobs', job.id);
  const explicitRetry = socialObject(socialObject(rawJob?.checkpoints)?.['runtime.retry']);
  if (socialText(record.status) === 'paused'
    && socialText(record.run_id) === job.runId
    && socialText(explicitRetry?.inputHash) === job.id) {
    const timestamp = new Date().toISOString();
    await repository.update(STARTER_COLLECTIONS.socialContentTasks, job.tenantId, record.id, {
      status: 'producing',
      updated_by: job.userId,
      updated_at: timestamp,
    });
    const run = await repository.get(STARTER_COLLECTIONS.runs, job.tenantId, job.runId);
    if (run && socialText(run.status) === 'waiting_external') await repository.update(
      STARTER_COLLECTIONS.runs, job.tenantId, run.id,
      { status: 'running', current_controller: 'agent', pause_reason: '', updated_at: timestamp },
    );
    record = await requireSocialTask({ repository, tenantId: job.tenantId, taskId: job.taskId });
  }
  const task = socialTaskSummary(record);
  if (socialProductionExecutor(job, rawJob?.checkpoints) === 'langgraph') {
    await runOutsideSocialContentMutationScope(() => executeSocialProductionGraph({ repository, dataStore, job, runtime }));
    return;
  }
  if (['asset_review', 'packaging', 'delivered', 'awaiting_publish', 'awaiting_metrics', 'reviewed'].includes(task.status)) return;
  if (task.status !== 'producing') throw new Error(`user_input_required:content_task_${task.status}`);
  await runOutsideSocialContentMutationScope(() => runSocialContentAutoProductionWithRetry({
    repository,
    tenantId: job.tenantId,
    userId: job.userId,
    taskId: job.taskId,
    runId: job.runId,
    runtime,
  }));
}

function ensureProductionWorker(): DurableContentExecutionWorker {
  if (!productionWorker) productionWorker = createProductionWorker();
  return productionWorker;
}

/** Runs the normal product executor and settlement callbacks for an explicitly
 * selected durable job set, without enabling unrelated scheduler/recovery loops. */
export function createScopedSocialContentProductionWorker(jobIds: readonly string[], dataStore:DataStore=store): DurableContentExecutionWorker {
  if (!jobIds.length || jobIds.some(id => typeof id !== 'string' || !id.trim() || id !== id.trim()))
    throw new Error('scoped_production_job_ids_required');
  return createProductionWorker([...new Set(jobIds)],dataStore);
}

function createProductionWorker(allowedJobIds?: string[], workerStore:DataStore=store): DurableContentExecutionWorker {
  return new DurableContentExecutionWorker({
    ...(allowedJobIds === undefined ? {} : {allowedJobIds}),
    ...(process.env.LINGSHU_LOCAL_PREVIEW === '1' && localFallbacksEnabled() && dataBackend === 'pocketbase'
      ? { dataAuthority: 'local' as const } : {}),
    dataStore: workerStore,
    execute: job=>executePersistedProduction(job,workerStore),
    async onSucceeded(job) {
      if (isSocialSceneReworkJob(job)) await completeSocialSceneReworkRun(createStarter198Repository(workerStore), job);
      if (socialProductionExecutor(job) === 'langgraph') {
        await completeSocialContentGraphRun(createStarter198Repository(workerStore), job);
        await createAgentNotification({ tenantId: job.tenantId, eventKey: `content-execution:${job.id}:delivery-prepared`,
          type: 'content_task_review_ready', severity: 'info', title: '一条内容已完成审核与交付准备',
          summary: '人工审核和交付包已核验，后续可进入发布确认。', sourceAgent: '内容 Agent',
          entityType: 'social_content_task', entityId: job.taskId,
          action: { label: '查看交付内容', page: 'smartAssets', href: `/?page=smartAssets&taskId=${encodeURIComponent(job.taskId)}` },
        }, workerStore).catch(() => undefined);
        return;
      }
      await createAgentNotification({
        tenantId: job.tenantId,
        eventKey: `content-execution:${job.id}:review-ready`,
        type: 'content_task_review_ready',
        severity: 'info',
        title: '一条内容已经完成制作',
        summary: '成片和质检结果已保存，等待你验收；验收后再进入发布确认。',
        sourceAgent: '内容 Agent',
        entityType: 'social_content_task',
        entityId: job.taskId,
        action: {
          label: '验收内容',
          page: 'smartAssets',
          href: `/?page=smartAssets&taskId=${encodeURIComponent(job.taskId)}`,
        },
      }, workerStore).catch(notificationError => console.warn('[content-execution] review notification failed', {
        jobId: job.id,
        error: notificationError instanceof Error ? notificationError.message : String(notificationError),
      }));
    },
    async onRetry(job, error, decision) {
      const repository = createStarter198Repository(workerStore);
      await writeExecutionStage({
        repository, tenantId: job.tenantId, runId: job.runId,
        stage: decision.failureClass === 'provider_reconciliation' ? 'provider_reconciliation' : 'automatic_recovery',
        status: 'running',
        message: decision.publicReason,
        extra: {
          retryClass: decision.failureClass,
          retryAttempt: job.attempt,
          retryLimit: decision.maxAttempts,
          failure: String(error instanceof Error ? error.message : error || '').slice(0, 400),
        },
      }).catch(() => undefined);
    },
    async onBlocked(job, error, decision) {
      const repository = createStarter198Repository(workerStore);
      if (isSocialSceneReworkJob(job)) {
        // Repair failures belong to the independent run. The original reviewed
        // content task and its passed scenes must remain intact.
        const run = await workerStore.getById<Record<string, unknown>>('workflow_runs', job.runId);
        if (run?.tenant_id === job.tenantId && run.status === 'running') await workerStore.update('workflow_runs', job.runId, {
          current_controller: 'human', pause_reason: decision.publicReason,
        });
      } else await failExecution({
        repository, tenantId: job.tenantId, userId: job.userId, taskId: job.taskId, runId: job.runId,
        error: new Error(`${decision.failureClass}:${decision.publicReason}:${String(error instanceof Error ? error.message : error || '').slice(0, 800)}`),
      }).catch(() => undefined);
      await createAgentNotification({
        tenantId: job.tenantId,
        eventKey: `content-execution:${job.id}:blocked:${decision.failureClass}:${job.attempt}`,
        type: 'content_task_blocked',
        severity: decision.failureClass === 'insufficient_balance' ? 'critical' : 'warning',
        title: '一条内容任务需要处理',
        summary: `${decision.publicReason}。已完成结果会保留，处理后可从当前任务继续。`,
        sourceAgent: '内容 Agent',
        entityType: 'social_content_task',
        entityId: job.taskId,
        action: {
          label: '进入内容制作',
          page: 'smartAssets',
          href: `/?page=smartAssets&taskId=${encodeURIComponent(job.taskId)}`,
        },
      }, workerStore).catch(notificationError => console.warn('[content-execution] blocked notification failed', {
        jobId: job.id,
        error: notificationError instanceof Error ? notificationError.message : String(notificationError),
      }));
    },
  });
}

/** Admission returns only after the database row exists; execution remains asynchronous. */
export async function enqueueSocialContentAutoProduction(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  runId: string;
  materialEvidencePorts?:Omit<WeeklyOwnedProductIdentityPorts,'repository'>;
}): Promise<void> {
  const dataStore = input.repository.dataStore ?? store;
  const admissionTask = await requireSocialTask(input);
  const footageRevision = socialObject(socialObject(socialJson(admissionTask.brief))?._productFootageRevision);
  if (footageRevision && input.runId !== socialText(footageRevision.sourceRunId))
    throw new Error('user_input_required:product_footage_revision_worker_admission_required');
  // Admission gaps precede all execution writes; an unqueued owned run has not failed production.
  await assertWeeklyProductionMaterialAdmission(input,input.materialEvidencePorts?.materialPorts,input.materialEvidencePorts?{...input.materialEvidencePorts,repository:input.repository}:undefined);
  await readWeeklyReplicationAuthority(input.repository,await requireSocialTask(input));
  try {
    const record = await requireSocialTask(input);
    const task = socialTaskSummary(record);
    const detail = await readSocialTaskDetail(input);
    if (!detail) throw new Error('social_content_task_not_found');
    const executorCheckpoint = createSocialProductionExecutorCheckpoint(detail, process.env, socialText(socialObject(socialObject(socialJson(record.brief))?._productionRevision)?.planHash) || undefined);
    const executorPayload = socialObject(executorCheckpoint.payload);
    const executorPlanVersion = socialText(executorPayload?.planVersion);
    const existingJob=await readContentExecutionJob(dataStore,input.tenantId,input.taskId,input.runId);
    let job = executorPayload?.executor === 'langgraph'&&existingJob&&!existingJob.checkpoints['social.executor'] ? await bindPristineContentExecutionCheckpoints({dataStore,tenantId:input.tenantId,jobId:existingJob.id,runId:input.runId,checkpoints:{'social.executor':executorCheckpoint,[PRODUCTION_GRAPH_BRIDGE_CHECKPOINT]:createProductionGraphBridgeCheckpoint({planVersion:executorPlanVersion,inputHash:executorCheckpoint.inputHash})}}) : executorPayload?.executor === 'langgraph' ? await admitProductionGraphJob({
      dataStore,
      tenantId: input.tenantId,
      userId: input.userId,
      taskId: input.taskId,
      runId: input.runId,
      accountId: task.brief.targetAccountRef?.id,
      taskType: `social_content_${task.mode}`,
      planVersion: executorPlanVersion, inputHash: executorCheckpoint.inputHash,
      initialCheckpoints: { 'social.executor': executorCheckpoint },
    }) : await admitContentExecutionJob({
      dataStore, tenantId: input.tenantId, userId: input.userId, taskId: input.taskId, runId: input.runId,
      accountId: task.brief.targetAccountRef?.id, taskType: `social_content_${task.mode}`,
      initialCheckpoints: { 'social.executor': executorCheckpoint },
    });
    // Historic admissions predate the executor binding. They may be upgraded
    // in place only before any durable execution/provider evidence exists. The
    // executor and bridge identities are written atomically.
    if (!job.checkpoints['social.executor'] && executorCheckpoint.payload && (executorCheckpoint.payload as { executor?: unknown }).executor === 'langgraph') {
      job = await bindPristineContentExecutionCheckpoints({ dataStore, tenantId: input.tenantId,
        jobId: job.id, runId: input.runId, checkpoints: {
          'social.executor': executorCheckpoint,
          [PRODUCTION_GRAPH_BRIDGE_CHECKPOINT]: createProductionGraphBridgeCheckpoint({
            planVersion: executorPlanVersion, inputHash: executorCheckpoint.inputHash,
          }),
        } });
    }
    // Weekly production is the formal Agent handoff. It may never fall back to
    // the historical direct executor because that would create two competing
    // completion authorities for the same weekly item.
    assertWeeklyProductionGraphJob({taskMode:task.mode ?? 'weekly',requestedExecutor:executorPayload?.executor,job});
    if (job.status === 'queued' && !job.lastStartedAt) {
      await writeExecutionStage({
        repository: input.repository,
        tenantId: input.tenantId,
        runId: input.runId,
        stage: 'queued',
        status: 'running',
        message: '任务已进入后台制作队列，关闭或刷新网页不会中断。',
        extra: { queueJobId: job.id, queueStatus: job.status, accountId: job.accountId, taskType: job.taskType },
      }).catch(() => undefined);
    }
    if (dataStore === store && selectedQueueBackend() === 'bullmq') {
      void enqueueBullJob({
        queue: 'social-content-production',
        name: 'wake-durable-job',
        data: { jobId: job.id },
        jobId: job.id,
      }).catch(error => {
        // Redis is a latency optimization only. The database scanner remains
        // authoritative and will claim this queued row after a Redis outage.
        console.warn('[content-execution] BullMQ wake-up failed; durable scan will recover', {
          jobId: job.id, error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    // Only a background process initializes this worker. On a web-only
    // process the database row remains queued until a worker claims it.
    if (dataStore === store) await productionWorker?.drain();
  } catch (error) {
    await failExecution({ ...input, error }).catch(failure => {
      console.error('[content-execution] durable admission failed', {
        taskId: input.taskId,
        error: error instanceof Error ? error.message : String(error),
        reportingError: failure instanceof Error ? failure.message : String(failure),
      });
    });
    throw error;
  }
}

export function initSocialContentProductionBullWorker(): void {
  const durableWorker = ensureProductionWorker();
  durableWorker.start();
  startBullWorker<{ jobId: string }>({
    queue: 'social-content-production',
    concurrency: Number(process.env.SOCIAL_CONTENT_PRODUCTION_CONCURRENCY || 4),
    processor: async () => durableWorker.drain(),
  });
  if (!graphApprovalRecoveryTimer) {
    graphApprovalRecoveryTimer = setInterval(() => void recoverSocialContentLangGraphApprovals()
      .catch(() => console.warn('[content-execution] graph approval recovery unavailable')), 5_000);
    graphApprovalRecoveryTimer.unref();
  }
}

let graphApprovalRecoveryTimer: NodeJS.Timeout | null = null;
let graphApprovalRecoveryRunning = false;
/** Durable approval recovery covers a decision committed while the original
 * worker is still releasing its lease, or a server restart before the wake-up. */
export async function recoverSocialContentLangGraphApprovals(): Promise<void> {
  if (process.env.LINGSHU_LOCAL_PREVIEW === '1' && localFallbacksEnabled() && dataBackend === 'pocketbase'
    && currentDataAuthority() !== 'local') return runWithDataAuthority('local', recoverSocialContentLangGraphApprovals);
  if (graphApprovalRecoveryRunning) return;
  graphApprovalRecoveryRunning = true;
  try {
    const repository = createStarter198Repository(store);
    for (let page = 1; page <= 100; page++) {
      const rows = await store.list<StarterRecord>('content_execution_jobs', { where: { status: 'paused' }, page, perPage: 100, sort: 'id' });
      for (const row of rows.items) {
        const checkpoints = socialObject(socialJson(row.checkpoints));
        const review = socialObject(socialObject(checkpoints?.['social.graph_review'])?.payload);
        if (review?.waitingReview !== true) continue;
        await resumeSocialContentLangGraphAfterApproval({ repository, tenantId: socialText(row.tenant_id),
          userId: socialText(row.user_id), taskId: socialText(row.task_id), artifactId: socialText(review.artifactId) })
          .catch(() => undefined); // Changed/rejected subjects remain paused for explicit rework.
      }
      if (page >= rows.totalPages || !rows.items.length) break;
    }
    await recoverSocialContentGraphCompletions(repository);
  } finally { graphApprovalRecoveryRunning = false; }
}

export async function resumeSocialContentLangGraphAfterApproval(input: {
  repository: Starter198Repository; tenantId: string; userId: string; taskId: string; artifactId: string;
}): Promise<boolean> {
  const jobId = await resumeApprovedSocialProductionGraph(input);
  if (!jobId) return false;
  await wakeSocialSceneReworkJob(jobId);
  return true;
}

export function socialContentAutoProductionActive(tenantId: string, taskId: string): boolean {
  return productionWorker?.isLocallyActive(tenantId, taskId) ?? false;
}
