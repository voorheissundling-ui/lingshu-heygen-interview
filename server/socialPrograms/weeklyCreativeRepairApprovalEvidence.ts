import type { DataStore, Record_ } from '../storage/datastore.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import type { WeeklyProductionRepairCase } from '../../shared/contracts/weeklyProductionRepairCase.js';
import type { WeeklyCreativeRepairAuditReceipt } from '../../shared/contracts/weeklyCreativeRepairAudit.js';
import type { WeeklyCreativeRepairChildExecution } from '../../shared/contracts/weeklyCreativeRepairExecution.js';
import { socialJson, socialObject, socialRequestHash } from '../starter198/socialContentValidation.js';
import { createStarter198Repository } from '../starter198/repository.js';
import { createSocialSceneReworkService } from '../starter198/socialContentSceneReworkService.js';
import { assertSocialDirectorG5Audit } from '../starter198/socialDirectorG5ReviewService.js';
import { resolveWeeklyCreativeRepairAuthority } from '../runtime/weeklyCreativeRepairAuthority.js';
import { assertNoFrozenTechnicalFailure } from '../runtime/weeklyContentQualityAudit.js';
import { SocialProgramError } from './service.js';

export interface WeeklyCreativeRepairApprovalScope {
  tenantId: string; programId: string; packageId: string; packageVersion: number; publicationTaskId?: string | null;
}
export interface WeeklyCreativeRepairApprovalEvidence {
  caseItem: WeeklyProductionRepairCase;
  audit: WeeklyCreativeRepairAuditReceipt;
  mapping: WeeklyCreativeRepairChildExecution;
  contentTask: Record_;
  artifact: Record_;
  artifactRef: VersionedSocialRef;
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new SocialProgramError(`weekly_creative_repair_approval_${code}`, 409, '创意修订尚未完成，或当前子成片与服务端复检证据不一致。');
}
function sealed<T extends { recordHash: string }>(row: Record_): T {
  const value = socialObject(socialJson(row.payload));
  need(value && row.content_hash === socialRequestHash(value), 'corrupt');
  const { recordHash, ...body } = value;
  need(recordHash === socialRequestHash(body), 'corrupt');
  return value as unknown as T;
}
async function one(store: DataStore, collection: string, where: Record<string, string | number>) {
  const rows = await store.list<Record_>(collection, { where, perPage: 2 });
  need(rows.totalItems === 1 && rows.items.length === 1, 'source_ambiguous');
  const row = rows.items[0]!;
  need(Object.entries(where).every(([key, value]) => row[key] === value), 'source_scope_changed');
  return row;
}

/** Resolve only server-owned, fully audited replacement production. Never changes historical quality output. */
export async function resolveWeeklyCreativeRepairApprovalEvidence(
  store: DataStore, scope: WeeklyCreativeRepairApprovalScope,
): Promise<WeeklyCreativeRepairApprovalEvidence | null> {
  if (!scope.publicationTaskId) return null;
  const rows = await store.list<Record_>('social_weekly_production_repair_cases', {
    where: { tenant_id: scope.tenantId, program_id: scope.programId, package_id: scope.packageId,
      package_version: scope.packageVersion, publication_task_id: scope.publicationTaskId }, perPage: 500,
  });
  need(rows.totalItems === rows.items.length, 'cases_incomplete');
  const cases = rows.items.map(row => sealed<WeeklyProductionRepairCase>(row));
  for (const item of cases) need(item.tenantId === scope.tenantId && item.programId === scope.programId &&
    item.packageId === scope.packageId && item.packageVersion === scope.packageVersion &&
    item.publicationTaskId === scope.publicationTaskId, 'scope_changed');
  const creative = cases.filter(item => item.kind === 'creative_revision' && item.state !== 'cancelled');
  if (!creative.length) return null;
  need(cases.every(item => ['resolved', 'cancelled'].includes(item.state)), 'case_open');
  need(creative.length === 1, 'case_ambiguous');
  const repairCase = creative[0]!;
  need(repairCase.state === 'resolved' && repairCase.execution && repairCase.childArtifactRef, 'case_open');
  const { createWeeklyCreativeRepairCompletionService } = await import('./weeklyCreativeRepairCompletion.js');
  const mapped = await createWeeklyCreativeRepairCompletionService(store).execution(scope.tenantId, repairCase.caseId);
  need(mapped.state === 'running' && mapped.tenantId === scope.tenantId && mapped.caseId === repairCase.caseId && mapped.caseRequestHash === repairCase.requestHash &&
    mapped.parentTaskId === repairCase.parent.taskId && mapped.parentRunId === repairCase.parent.runId &&
    mapped.parentArtifactHash === repairCase.parent.artifactHash && mapped.childTaskId === repairCase.execution.operationId &&
    mapped.runId === repairCase.execution.runId && mapped.jobId === repairCase.execution.jobId, 'mapping_changed');
  const audit = sealed<WeeklyCreativeRepairAuditReceipt>(await one(store, 'social_weekly_creative_repair_audits',
    { tenant_id: scope.tenantId, case_id: repairCase.caseId }));
  need(audit.childArtifactRef?.type === 'starter_social_content_artifact' &&
    typeof audit.childArtifactRef.id === 'string' && audit.childArtifactRef.id.trim().length > 0 &&
    Number.isSafeInteger(audit.childArtifactRef.version) && audit.childArtifactRef.version > 0, 'artifact_ref_invalid');
  need(audit.schemaVersion === 'weekly-creative-repair-audit.v1' && audit.version === 1 &&
    audit.tenantId === scope.tenantId && audit.programId === scope.programId && audit.packageId === scope.packageId &&
    audit.packageVersion === scope.packageVersion && audit.caseId === repairCase.caseId && audit.caseRequestHash === repairCase.requestHash &&
    audit.executionRecordHash === mapped.recordHash && audit.childTaskId === mapped.childTaskId &&
    audit.childRunId === mapped.runId && audit.childJobId === mapped.jobId &&
    socialRequestHash(audit.childArtifactRef) === socialRequestHash(repairCase.childArtifactRef), 'audit_changed');
  const contentTask = await one(store, 'starter_social_content_tasks', { tenant_id: scope.tenantId, task_id: audit.childTaskId });
  const authority = await resolveWeeklyCreativeRepairAuthority({ store, tenantId: scope.tenantId, task: contentTask });
  need(authority && authority.proof.caseId === repairCase.caseId && authority.proof.originalAuthorityHash === mapped.authorityHash &&
    authority.configuration.recordHash === mapped.configurationHash && contentTask.run_id === mapped.runId &&
    !['cancelled', 'failed', 'dead_letter', 'paused', 'attention', 'needs_input'].includes(String(contentTask.status)), 'authority_changed');
  const run = await store.getById<Record_>('workflow_runs', audit.childRunId);
  const job = await store.getById<Record_>('content_execution_jobs', audit.childJobId);
  need(run?.tenant_id === scope.tenantId && job?.tenant_id === scope.tenantId && job.task_id === audit.childTaskId &&
    job.run_id === audit.childRunId && job.status === 'succeeded' && job.completed_at &&
    (['succeeded', 'completed'].includes(String(run.status)) && run.completed_at ||
      run.status === 'waiting_external' && run.pause_reason === 'automatic_acceptance_evidence_incomplete'), 'execution_changed');
  const artifactRow = await one(store, 'starter_social_content_artifacts',
    { tenant_id: scope.tenantId, task_id: audit.childTaskId, artifact_id: audit.childArtifactRef.id });
  const content = socialObject(socialJson(artifactRow.content));
  const currentVersion = Number(String(artifactRow.version).replace(/^v/, ''));
  need(content && artifactRow.content_hash === audit.childArtifactHash &&
    artifactRow.content_hash === socialRequestHash({ resourceRef: artifactRow.resource_ref, content }) &&
    artifactRow.origin === 'agent' && artifactRow.artifact_kind === 'short_video' &&
    ['review_required', 'approved'].includes(String(artifactRow.status)) &&
    Number.isSafeInteger(currentVersion) && currentVersion > 0 &&
    (artifactRow.status === 'review_required' && currentVersion === audit.childArtifactRef.version ||
      artifactRow.status === 'approved' && currentVersion === audit.childArtifactRef.version + 1) &&
    socialObject(content.render)?.completed === true, 'artifact_changed');
  if (artifactRow.status === 'approved') {
    const operation = await one(store, 'starter_social_content_operations',
      { tenant_id: scope.tenantId, operation_id: String(artifactRow.last_operation_id ?? '') });
    const approvalInput = { decision: 'approved', expectedVersion: `${String(artifactRow.version).startsWith('v') ? 'v' : ''}${audit.childArtifactRef.version}`,
      note: '用户在周工作台确认本条真实成片' };
    need(operation.operation === 'decide_social_content_artifact' && operation.target_id === audit.childTaskId &&
      operation.idempotency_key === `weekly-content-approval:${repairCase.approvalTaskId}:${audit.childArtifactRef.id}` &&
      operation.status === 'succeeded' && operation.request_hash === socialRequestHash(approvalInput), 'approval_changed');
  }
  assertNoFrozenTechnicalFailure(content);
  const repository = createStarter198Repository(store);
  const cache = await createSocialSceneReworkService(repository).readCache({ tenantId: scope.tenantId,
    taskId: audit.childTaskId, runId: audit.childRunId, parentArtifactId: audit.childArtifactRef.id });
  need(cache.cache.recordHash === audit.sceneCacheHash && cache.cache.parentArtifactHash === audit.childArtifactHash &&
    cache.cache.scenes.length > 0 && cache.cache.scenes.every(scene => scene.status === 'passed'), 'g4_changed');
  const g5 = await assertSocialDirectorG5Audit(repository, { tenantId: scope.tenantId, taskId: audit.childTaskId,
    runId: audit.childRunId, artifactId: audit.childArtifactRef.id, artifactHash: audit.childArtifactHash });
  need(g5.review.reviewId === audit.g5ReviewId && g5.review.recordHash === audit.g5ReviewHash &&
    g5.receipt.receiptId === audit.g5ReceiptId && g5.receipt.recordHash === audit.g5ReceiptHash &&
    g5.receipt.gate === 'G5' && g5.receipt.status === 'passed', 'g5_changed');
  return { caseItem: repairCase, audit, mapping: mapped, contentTask, artifact: artifactRow,
    artifactRef: { type: 'starter_social_content_artifact', id: audit.childArtifactRef.id, version: currentVersion } };
}
