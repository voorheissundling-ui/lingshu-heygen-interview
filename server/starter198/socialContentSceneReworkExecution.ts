import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Record_ } from '../storage/datastore.js';
import type { ContentExecutionJob } from '../contentExecution/durableQueue.js';
import type { Starter198Repository } from './repository.js';
import { MEDIA_ROOT } from './socialContentProductionMaterials.js';
import { runSocialSceneReworkJob } from './socialContentSceneReworkWorker.js';
import { createSocialSceneReworkSupplyPorts } from './socialContentSceneReworkSupplyPorts.js';
import { createSocialSceneReworkOutputPort } from './socialContentSceneReworkOutput.js';
import { socialJson, socialObject, socialRequestHash } from './socialContentValidation.js';
import { createSocialSceneReworkService } from './socialContentSceneReworkService.js';
import { openSocialArtifactPreviewMedia } from './socialArtifactMedia.js';
import { readSocialSceneReworkStatus } from './socialContentSceneReworkRead.js';

export const isSocialSceneReworkJob = (job: Pick<ContentExecutionJob, 'taskType'>) =>
  /^social_scene_rework:scene_rework_[a-f0-9]{24}$/.test(job.taskType);

/** Dedicated entry. It never calls ordinary full-video production or changes the source task's run. */
export async function executeSocialSceneReworkJob(repository: Starter198Repository, job: ContentExecutionJob): Promise<void> {
  if (!isSocialSceneReworkJob(job) || !repository.dataStore) throw new Error('scene_rework_job_type_invalid');
  const context = await createSocialSceneReworkService(repository).readForJob({ tenantId: job.tenantId,
    taskId: job.taskId, runId: job.runId, actorUserId: job.userId, operationId: job.taskType.slice('social_scene_rework:'.length) });
  const supply = createSocialSceneReworkSupplyPorts({ repository, job });
  // Restore existing render authority without submitting anything. Without a
  // checkpoint the worker reconciles pending supplier receipts before budget
  // admission; a fresh quote must never prevent recovery of an accepted result.
  await supply.restoreBudgetForRender();
  const output = await runSocialSceneReworkJob({ repository, job,
    outputDirectory: path.join(MEDIA_ROOT, 'scene-rework', socialRequestHash({ tenant: job.tenantId, operation: context.intent.operationId })),
    ports: { ...supply, persistOutput: createSocialSceneReworkOutputPort({ repository }) } });
  await supply.settleOutput();
  const store = repository.dataStore;
  const actual = await store.getById<Record_>('content_execution_jobs', job.id);
  const run = await store.getById<Record_>('workflow_runs', job.runId);
  if (!actual || actual.status !== 'running' || actual.worker_id !== job.workerId || !run
    || run.tenant_id !== job.tenantId || run.status !== 'running') throw new Error('scene_rework_output_run_changed');
  const starterContext = socialObject(socialJson(run.starter_context));
  if (!starterContext) throw new Error('scene_rework_execution_authorization_required');
  const receipt = { operationId: context.intent.operationId, jobId: job.id, executionRunId: job.runId,
    ...output };
  if (!await store.update('workflow_runs', job.runId, { starter_context: { ...starterContext,
    sceneReworkOutput: { ...receipt, recordHash: socialRequestHash(receipt) } } })) throw new Error('scene_rework_run_output_save_failed');
}

/** Run completion follows the durable job completion, never the clock or a render return alone. */
export async function completeSocialSceneReworkRun(repository: Starter198Repository, job: ContentExecutionJob) {
  const store = repository.dataStore;
  if (!store || !isSocialSceneReworkJob(job)) throw new Error('scene_rework_job_type_invalid');
  const actual = await store.getById<Record_>('content_execution_jobs', job.id);
  const run = await store.getById<Record_>('workflow_runs', job.runId);
  const output = socialObject(socialObject(socialJson(run?.starter_context))?.sceneReworkOutput);
  if (!actual || actual.status !== 'succeeded' || actual.tenant_id !== job.tenantId || actual.run_id !== job.runId
    || !run || run.tenant_id !== job.tenantId || !output) throw new Error('scene_rework_run_completion_evidence_missing');
  const { recordHash, ...receipt } = output;
  if (recordHash !== socialRequestHash(receipt) || receipt.jobId !== job.id || receipt.executionRunId !== job.runId
    || receipt.operationId !== job.taskType.slice('social_scene_rework:'.length)) throw new Error('scene_rework_run_completion_evidence_invalid');
  await readSocialSceneReworkStatus({ repository, tenantId: job.tenantId, actorUserId: job.userId,
    taskId: job.taskId, operationId: String(receipt.operationId) });
  const artifacts = await store.list<Record_>('starter_social_content_artifacts', { where: {
    tenant_id: job.tenantId, task_id: job.taskId, artifact_id: String(receipt.artifactId) }, perPage: 2 });
  const artifact = artifacts.items[0];
  const content = socialObject(socialJson(artifact?.content));
  if (artifacts.totalItems !== 1 || artifacts.items.length !== 1 || !artifact || !content
    || artifact.parent_artifact_id !== receipt.parentArtifactId || artifact.resource_ref !== receipt.fileRef
    || artifact.content_hash !== socialRequestHash({ resourceRef: artifact.resource_ref, content })) {
    throw new Error('scene_rework_run_output_artifact_invalid');
  }
  const media = await openSocialArtifactPreviewMedia({ repository, tenantId: job.tenantId, taskId: job.taskId,
    artifactId: String(receipt.artifactId) });
  const digest = createHash('sha256');
  for await (const bytes of media.body) digest.update(bytes);
  if (digest.digest('hex') !== receipt.sha256 || media.file.sha256 !== receipt.sha256) {
    throw new Error('scene_rework_run_output_bytes_invalid');
  }
  if (['completed', 'succeeded'].includes(String(run.status))) return;
  if (run.status !== 'running') throw new Error('scene_rework_output_run_changed');
  if (!await store.update('workflow_runs', job.runId, { status: 'completed', completed_at: new Date().toISOString(),
    pause_reason: '局部重制产物与独立质检已保存，等待验收。' })) throw new Error('scene_rework_run_completion_save_failed');
}
