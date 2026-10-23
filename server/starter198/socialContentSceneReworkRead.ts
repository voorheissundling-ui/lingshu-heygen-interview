import type { Record_ } from '../storage/datastore.js';
import type { Starter198Repository, StarterRecord } from './repository.js';
import { parseSocialProductionReceiptRecord } from './socialContentProductionHandoff.js';
import { resolveSceneCacheSourceRun } from './socialContentSceneCacheSource.js';
import { requireSocialTask } from './socialContentRecords.js';
import { socialJson, socialObject, socialRequestHash } from './socialContentValidation.js';
import { createSocialSceneReworkService, SOCIAL_SCENE_INTENT_COLLECTION } from './socialContentSceneReworkService.js';
import type { SocialSceneReworkIntent } from './socialContentSceneRework.js';
import type { SocialSceneReworkAvailability, SocialSceneReworkStatus } from '../../shared/contracts/socialSceneRework.js';
import { readSocialProductionWorkspaceBinding } from './socialContentProductionWorkspace.js';

const fail = (code: string): never => { throw new Error(code); };

/** Internal media locations and supplier credentials are deliberately excluded from UI state. */
export async function readSocialSceneReworkAvailability(input: {
  repository: Starter198Repository; tenantId: string; taskId: string; parentArtifactId: string; actorUserId?: string;
}): Promise<SocialSceneReworkAvailability> {
  await requireSocialTask(input);
  const sourceRunId = await resolveSceneCacheSourceRun(input.repository, input);
  const context = await createSocialSceneReworkService(input.repository).readCache({ tenantId: input.tenantId,
    taskId: input.taskId, runId: sourceRunId, parentArtifactId: input.parentArtifactId });
  const run = await input.repository.dataStore!.getById<Record_>('workflow_runs', sourceRunId);
  const blockingReasons: string[] = [];
  if (!run || run.tenant_id !== input.tenantId || !['succeeded', 'completed', 'failed'].includes(String(run.status))) {
    blockingReasons.push('scene_rework_source_run_not_terminal');
  }
  if (context.cache.scenes.some(scene => scene.status === 'review_required')) blockingReasons.push('scene_rework_quality_review_required');
  if (!context.cache.scenes.some(scene => scene.status === 'failed')) blockingReasons.push('scene_rework_failed_receipt_required');
  const checks = new Map<string, Array<{ code: string; passed: boolean; message: string }>>();
  for (const scene of context.cache.scenes) {
    const rows = await input.repository.dataStore!.list<Record_>('starter_social_production_receipts', { where: {
      tenant_id: input.tenantId, receipt_id: scene.technicalReceiptId }, perPage: 2 });
    if (rows.totalItems !== 1 || rows.items.length !== 1) return fail('scene_rework_receipt_missing');
    const receipt = parseSocialProductionReceiptRecord(rows.items[0]! as StarterRecord);
    if (receipt.sceneId !== scene.productionSceneId || receipt.status !== scene.status) return fail('scene_rework_receipt_scope');
    checks.set(scene.sceneId, receipt.checks.map(check => ({ code: check.code, passed: check.passed, message: check.message })));
  }
  const existingOperations: SocialSceneReworkStatus[] = [];
  if (input.actorUserId) {
    const rows = await input.repository.dataStore!.list<Record_>(SOCIAL_SCENE_INTENT_COLLECTION, { where: {
      tenant_id: input.tenantId, task_id: input.taskId, parent_artifact_id: input.parentArtifactId }, perPage: 100 });
    if (rows.totalItems !== rows.items.length) return fail('scene_rework_status_list_incomplete');
    for (const row of rows.items) {
      const intent = socialObject(socialJson(row.payload));
      if (!intent || row.content_hash !== socialRequestHash(intent)) return fail('scene_rework_record_corrupt');
      if (intent.actorUserId !== input.actorUserId) continue;
      existingOperations.push(await readSocialSceneReworkStatus({ repository: input.repository, tenantId: input.tenantId,
        actorUserId: input.actorUserId, taskId: input.taskId, operationId: String(intent.operationId) }));
    }
  }
  let productionWorkspaceBinding: SocialSceneReworkAvailability['productionWorkspaceBinding'] = null;
  let productionWorkspaceGap: string | null = null;
  try {
    productionWorkspaceBinding = await readSocialProductionWorkspaceBinding({ repository: input.repository,
      tenantId: input.tenantId, taskId: input.taskId, runId: sourceRunId, artifactId: input.parentArtifactId });
  } catch (error) {
    productionWorkspaceGap = error instanceof Error && /^social_workspace_[a-z0-9_]+$/.test(error.message)
      ? error.message : 'social_workspace_read_failed';
  }
  return { tenantId: input.tenantId, taskId: input.taskId, sourceRunId, parentArtifactId: input.parentArtifactId,
    productionWorkspaceBinding, productionWorkspaceGap,
    parentArtifactHash: context.cache.parentArtifactHash, cacheHash: context.cache.recordHash,
    scenes: context.cache.scenes.map(scene => {
      const baseline = context.baseline.scenes.filter(item => item.sceneId === scene.sceneId);
      const shots = context.plan.shots.filter(shot => shot.shotId === scene.sceneId);
      if (baseline.length !== 1 || shots.length !== 1) return fail('scene_rework_scene_mapping_missing');
      return { sceneId: scene.sceneId, shotId: shots[0]!.shotId, referenceShotId: baseline[0]!.inspirationNodeId ?? null,
        sourceTiming: baseline[0]!.referenceStructure?.sourceTiming ?? null, status: scene.status,
        technicalReceiptId: scene.technicalReceiptId, checks: checks.get(scene.sceneId) };
    }), canRequest: blockingReasons.length === 0, blockingReasons, existingOperations };
}

/** A completed or paused repair remains observable; observing never revives or submits it. */
export async function readSocialSceneReworkStatus(input: {
  repository: Starter198Repository; tenantId: string; actorUserId: string; taskId: string; operationId: string;
}): Promise<SocialSceneReworkStatus> {
  await requireSocialTask(input);
  const store = input.repository.dataStore;
  if (!store) return fail('scene_rework_persistent_store_required');
  if (!/^scene_rework_[a-f0-9]{24}$/.test(input.operationId)) return fail('scene_rework_operation_invalid');
  const rows = await store.list<Record_>(SOCIAL_SCENE_INTENT_COLLECTION, { where: { tenant_id: input.tenantId,
    task_id: input.taskId, operation_id: input.operationId }, perPage: 2 });
  if (rows.totalItems !== 1 || rows.items.length !== 1) return fail('scene_rework_intent_missing');
  const row = rows.items[0]!;
  const payload = socialObject(socialJson(row.payload));
  if (!payload || row.content_hash !== socialRequestHash(payload)) return fail('scene_rework_record_corrupt');
  const intent = payload as unknown as SocialSceneReworkIntent;
  if (intent.tenantId !== input.tenantId || intent.taskId !== input.taskId || intent.operationId !== input.operationId
    || intent.actorUserId !== input.actorUserId || row.run_id !== intent.executionRunId) return fail('scene_rework_intent_scope');
  const jobs = await store.list<Record_>('content_execution_jobs', { where: { tenant_id: input.tenantId,
    task_id: input.taskId, run_id: intent.executionRunId, task_type: `social_scene_rework:${input.operationId}` }, perPage: 2 });
  const run = await store.getById<Record_>('workflow_runs', intent.executionRunId);
  const authorization = socialObject(socialObject(socialJson(run?.starter_context))?.sceneReworkAuthorization);
  if (!run || run.tenant_id !== input.tenantId || !authorization || jobs.totalItems !== 1 || jobs.items.length !== 1
    || jobs.items[0]!.user_id !== input.actorUserId) return fail('scene_rework_status_scope');
  const { recordHash, ...proof } = authorization;
  if (recordHash !== socialRequestHash(proof) || proof.operationId !== intent.operationId
    || proof.executionRunId !== intent.executionRunId || proof.sourceRunId !== intent.sourceRunId
    || proof.taskId !== input.taskId || proof.tenantId !== input.tenantId || proof.actorUserId !== input.actorUserId
    || proof.parentArtifactId !== intent.parentArtifactId || proof.parentArtifactHash !== intent.parentArtifactHash
    || proof.cacheHash !== intent.cacheHash || proof.planHash !== intent.planHash) return fail('scene_rework_status_authorization_invalid');
  const job = jobs.items[0]!;
  const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  const saved = socialObject(socialObject(socialJson(run.starter_context))?.sceneReworkOutput);
  let output: NonNullable<SocialSceneReworkStatus['output']> | null = null;
  if (saved) {
    const { recordHash, ...result } = saved;
    if (recordHash !== socialRequestHash(result) || result.operationId !== intent.operationId
      || result.executionRunId !== intent.executionRunId || result.jobId !== job.id
      || result.parentArtifactId !== intent.parentArtifactId || typeof result.artifactId !== 'string'
      || typeof result.fileRef !== 'string' || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)
      || !['review_required', 'changes_requested'].includes(String(result.reviewStatus))
      || !Array.isArray(result.qualityReceiptIds) || !result.qualityReceiptIds.length
      || result.qualityReceiptIds.some(id => typeof id !== 'string' || !id)) return fail('scene_rework_output_receipt_invalid');
    const artifacts = await store.list<Record_>('starter_social_content_artifacts', { where: {
      tenant_id: input.tenantId, task_id: input.taskId, artifact_id: result.artifactId }, perPage: 2 });
    const artifact = artifacts.items[0];
    const content = socialObject(socialJson(artifact?.content));
    if (artifacts.totalItems !== 1 || artifacts.items.length !== 1 || !artifact || !content
      || artifact.parent_artifact_id !== intent.parentArtifactId || artifact.resource_ref !== result.fileRef
      || artifact.content_hash !== socialRequestHash({ resourceRef: artifact.resource_ref, content })) return fail('scene_rework_output_artifact_invalid');
    if (await resolveSceneCacheSourceRun(input.repository, { tenantId: input.tenantId, taskId: input.taskId,
      parentArtifactId: result.artifactId }) !== intent.executionRunId) return fail('scene_rework_output_lineage_invalid');
    const media = socialObject(socialObject(content.mediaStorage)?.video);
    const productionResult = socialObject(content.productionResult);
    const handoffRef = socialObject(socialObject(content.sceneRework)?.handoffRef);
    if (media?.sha256 !== result.sha256 || !productionResult || !handoffRef || !Array.isArray(productionResult.sceneResults)
      || new Set(result.qualityReceiptIds).size !== result.qualityReceiptIds.length) return fail('scene_rework_output_receipt_invalid');
    const expectedScenes = productionResult.sceneResults.map(raw => socialObject(raw)?.sceneId);
    if (expectedScenes.some(id => typeof id !== 'string' || !id) || new Set(expectedScenes).size !== expectedScenes.length) {
      return fail('scene_rework_output_quality_invalid');
    }
    const observedScenes = new Set<string>();
    for (const id of result.qualityReceiptIds as string[]) {
      const receipts = await store.list<Record_>('starter_social_production_receipts', { where: {
        tenant_id: input.tenantId, receipt_id: id }, perPage: 2 });
      if (receipts.totalItems !== 1 || receipts.items.length !== 1) return fail('scene_rework_output_quality_missing');
      const receipt = parseSocialProductionReceiptRecord(receipts.items[0]! as StarterRecord);
      if (receipt.gate !== 'G4' || receipt.actor !== 'content_agent' || !receipt.sceneId || observedScenes.has(receipt.sceneId)
        || !expectedScenes.includes(receipt.sceneId) || receipt.handoffId !== handoffRef.id || receipt.handoffVersion !== handoffRef.version
        || !receipt.artifactRefs.includes(result.fileRef) || receipt.productionResultRef.id !== productionResult.productionResultId
        || receipt.productionResultRef.version !== productionResult.version
        || receipt.productionResultRef.recordHash !== socialRequestHash(productionResult)) return fail('scene_rework_output_quality_invalid');
      observedScenes.add(receipt.sceneId);
    }
    if (observedScenes.size !== expectedScenes.length) return fail('scene_rework_output_quality_incomplete');
    const savedAt = timestamp(artifact.created_at);
    if (!savedAt) return fail('scene_rework_output_time_evidence_missing');
    output = { artifactId: result.artifactId, fileRef: result.fileRef, sha256: result.sha256,
      parentArtifactId: intent.parentArtifactId, reviewStatus: result.reviewStatus as 'review_required' | 'changes_requested',
      qualityReceiptIds: result.qualityReceiptIds as string[], savedAt };
  }
  return { tenantId: input.tenantId, taskId: input.taskId, operationId: input.operationId,
    sourceRunId: intent.sourceRunId, executionRunId: intent.executionRunId, parentArtifactId: intent.parentArtifactId,
    affectedSceneIds: intent.affectedSceneIds, jobId: job.id, jobStatus: String(job.status),
    runStatus: String(run.status), lastError: typeof job.last_error === 'string' ? job.last_error : null,
    completedAt: timestamp(job.completed_at), runCompletedAt: timestamp(run.completed_at), output };
}
