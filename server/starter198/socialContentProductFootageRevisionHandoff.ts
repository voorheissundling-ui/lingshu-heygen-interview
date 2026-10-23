import { SocialContentTaskBudget } from '../lib/socialContentTaskBudget.js';
import path from 'node:path';
import { CONTENT_CREATION_QUOTA_COLLECTION } from '../socialPrograms/contentCreationQuota.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { withSocialContentSubjectLease, assertSocialContentSubjectLease } from './socialContentMutation.js';
import { readPreparedSocialProductFootageRevision } from './socialContentProductFootageRevisionPrepare.js';
import { readVerifiedProductFootageRevision } from './socialContentProductFootageRevision.js';
import type { SocialAssetSupplyPlan } from '../../shared/contracts/socialContentWorkflow.js';
import { listPresenterFirstFrameApprovalsForReview } from './socialContentPresenterFirstFrameApproval.js';
import { requireSocialTask } from './socialContentRecords.js';
import { socialJson, socialObject, socialRequestHash, socialText, SocialContentWorkflowError } from './socialContentValidation.js';

type Prepared = Parameters<typeof readPreparedSocialProductFootageRevision>[0];
type Guard = { schemaVersion: 'social-product-footage-revision-handoff-guard.v1';
  tenantId: string; taskId: string; sourceRunId: string; revisionRunId: string;
  preparedVersion: string; handoffVersion: string; sourceBriefHash: string; sourceScriptHash: string;
  revisedPlanHash: string; lineageHash: string; budgetLedgerRef: string; originalSlotId: string;
  queueItemId: string; dispatchCommandId: string; ledgerHash: string; retainedMicros: number;
  ledgerAuthorityHash: string;
  oldApprovalHashes: string[]; recordHash: string };
const fail = (reason: string): never => { throw new SocialContentWorkflowError(`product_footage_revision_handoff_${reason}`, 409); };
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ledgerAuthorityHash = (root?: string) => socialRequestHash(path.resolve(root
  ?? process.env.SOCIAL_CONTENT_TASK_BUDGET_DIR ?? 'data/social-content-task-budget'));

function readOriginalLedger(input: { tenantId: string; taskId: string; sourceRunId: string;
  revisionRunId: string; ledgerRoot?: string }) {
  const ledger = new SocialContentTaskBudget(input.ledgerRoot, {
    authorization: async () => fail('read_only'), quote: async () => fail('read_only'),
    assertCurrent: async () => fail('read_only'), verifyRejection: async () => false });
  const status = ledger.status({ tenantId: input.tenantId, taskId: input.taskId,
    runId: input.sourceRunId, planHash: '0'.repeat(64) });
  if (!status) return fail('original_ten_yuan_ledger_missing');
  if (status.limitCny !== 10 || status.authorizedLimitCny !== 10
    || status.hasCorrectionAuthorization || status.retainedCny > 10) return fail('original_ten_yuan_ceiling_invalid');
  if (status.entries.some(entry => (entry.executionTaskId ?? input.taskId) !== input.taskId))
    return fail('ledger_foreign_entry');
  const sourceEntries = status.entries.filter(entry => entry.runId !== input.revisionRunId);
  const revisionEntries = status.entries.filter(entry => entry.runId === input.revisionRunId);
  const retainedMicros = sourceEntries.filter(entry => entry.status !== 'rejected')
    .reduce((sum, entry) => sum + entry.reservedMicros, 0);
  const totalRetainedMicros = status.entries.filter(entry => entry.status !== 'rejected')
    .reduce((sum, entry) => sum + entry.reservedMicros, 0);
  if (!Number.isSafeInteger(retainedMicros) || !Number.isSafeInteger(totalRetainedMicros)
    || totalRetainedMicros > 10e6) return fail('ledger_corrupt');
  return { retainedMicros, ledgerHash: socialRequestHash({ limitCny: status.authorizedLimitCny,
    entries: sourceEntries }), revisionEntries, totalRetainedMicros };
}

async function readSchedule(input: { repository: Starter198Repository; prepared: Prepared;
  revisionRunId: string; queueItemId: string }) {
  const { repository, prepared } = input, store = repository.dataStore;
  if (!store || prepared.repository !== repository || prepared.store !== store) return fail('store_changed');
  const run = await repository.get(STARTER_COLLECTIONS.runs, prepared.tenantId, input.revisionRunId);
  const context = socialObject(socialJson(run?.starter_context));
  const queue = await repository.list(STARTER_COLLECTIONS.tasks, prepared.tenantId,
    { where: { run_id: input.revisionRunId, task_key: 'social_product_footage_revision_admission' }, perPage: 2 });
  const task = queue.items[0];
  const { paidGuard: _paidGuard, paidPlanFreeze: _paidPlanFreeze, ...scheduleContext } = context ?? {};
  if (!run || run.status !== 'waiting_external' || !context
    || context.schemaVersion !== 'social-product-footage-revision-schedule.v1'
    || context.tenantId !== prepared.tenantId || context.taskId !== prepared.taskId
    || context.sourceRunId !== prepared.sourceRunId || context.preparedVersion !== prepared.expectedPreparedVersion
    || context.budgetLedgerRef !== prepared.budgetLedgerRef || context.queueItemId !== input.queueItemId
    || !sha(context.revisedPlanHash) || !sha(context.lineageHash)
    || !socialText(context.originalSlotId) || !socialText(context.dispatchCommandId)
    || queue.totalItems !== 1 || queue.items.length !== 1 || !task || task.status !== 'blocked'
    || task.automatic_execution_allowed !== false || task.external_effect !== 'none'
    || socialRequestHash(socialJson(task.output)) !== socialRequestHash(scheduleContext))
    return fail('schedule_changed');
  const bindingTask = await requireSocialTask({ repository, tenantId: prepared.tenantId, taskId: prepared.taskId });
  const binding = socialObject(socialJson(bindingTask.content_order));
  const dispatch = socialObject(binding?.footageRevisionDispatch);
  const original = socialObject(binding?.dispatch);
  const originalQueue = socialObject(original?.queueRequest);
  const originalSubject = socialObject(originalQueue?.subject);
  const originalOperation = await repository.list(STARTER_COLLECTIONS.socialContentOperations, prepared.tenantId,
    { where: { operation_id: String(original?.commandId ?? '') }, perPage: 2 });
  const sourceRun = await repository.get(STARTER_COLLECTIONS.runs, prepared.tenantId, prepared.sourceRunId);
  const sourceContext = socialObject(socialJson(sourceRun?.starter_context));
  if (!binding || !dispatch || dispatch.schemaVersion !== 'social-product-footage-revision-dispatch.v1'
    || dispatch.commandId !== context.dispatchCommandId || dispatch.lineageHash !== context.lineageHash
    || dispatch.revisedPlanHash !== context.revisedPlanHash || dispatch.tenantId !== prepared.tenantId
    || dispatch.taskId !== prepared.taskId || dispatch.sourceRunId !== prepared.sourceRunId
    || dispatch.preparedVersion !== prepared.expectedPreparedVersion
    || socialRequestHash((({ recordHash: _, ...body }) => body)(dispatch)) !== dispatch.recordHash
    || !original || !originalQueue || !originalSubject
    || original.schemaVersion !== 'social-content-dispatch.v1'
    || socialRequestHash((({ requestHash: _, ...body }) => body)(original)) !== original.requestHash
    || originalQueue.tenantId !== prepared.tenantId || originalQueue.workflowScope !== 'social_content'
    || originalSubject.id !== prepared.taskId || original.commandId !== originalQueue.commandId
    || originalOperation.totalItems !== 1 || originalOperation.items.length !== 1
    || originalOperation.items[0]?.operation !== 'start_social_content_task'
    || originalOperation.items[0]?.target_id !== prepared.taskId
    || originalOperation.items[0]?.created_by !== original.userId
    || originalOperation.items[0]?.idempotency_key !== original.idempotencyKey
    || originalOperation.items[0]?.request_hash !== socialRequestHash({ expectedVersion: original.expectedVersion })
    || !['processing', 'succeeded'].includes(socialText(originalOperation.items[0]?.status))
    || !sourceRun || !['failed', 'cancelled', 'completed', 'succeeded'].includes(socialText(sourceRun.status))
    || sourceContext?.socialTaskId !== prepared.taskId)
    return fail('dispatch_changed');
  const pools = await store.list<any>(CONTENT_CREATION_QUOTA_COLLECTION,
    { where: { tenant_id: prepared.tenantId, program_id: String(binding.programId),
      week_start: String(binding.originWeek) }, perPage: 2 });
  const pool = pools.items[0]?.payload;
  const order = pool?.orders?.[prepared.taskId];
  const revision = order?.revisions?.filter((item: any) => item.executionTaskId === prepared.taskId
    && item.lineageHash === context.lineageHash && item.commandId === context.dispatchCommandId);
  const outbox = pool?.outbox?.filter((item: any) => item.kind === 'dispatch'
    && item.contentId === prepared.taskId && item.executionTaskId === prepared.taskId
    && item.commandId === context.dispatchCommandId);
  if (pools.totalItems !== 1 || pools.items.length !== 1 || !pool || !order
    || pool.scope?.tenantId !== prepared.tenantId || pool.scope?.programId !== binding.programId
    || pool.scope?.weekStart !== binding.originWeek || binding.contentId !== prepared.taskId
    || binding.budgetTaskId !== prepared.taskId || binding.cancellation || binding.replacedByContentId
    || binding.supersededByContentId || order.slotId !== context.originalSlotId
    || !pool.outbox?.some((item: any) => item.kind === 'dispatch' && item.contentId === prepared.taskId
      && item.commandId === original.commandId && !item.executionTaskId)
    || pool.slots?.find((slot: any) => slot.contentId === prepared.taskId)?.slotId !== order.slotId
    || revision?.length !== 1 || outbox?.length !== 1 || outbox[0].state !== 'pending') return fail('quota_changed');
  return { context, run, task: bindingTask, pool, order };
}

async function readOldApprovals(input: { repository: Starter198Repository; prepared: Prepared;
  revisionRunId: string; revisedPlanHash: string }) {
  const store = input.repository.dataStore;
  if (!store) return fail('store_missing');
  const old = await listPresenterFirstFrameApprovalsForReview(store, {
    tenantId: input.prepared.tenantId, taskId: input.prepared.taskId, runId: input.prepared.sourceRunId });
  const current = await listPresenterFirstFrameApprovalsForReview(store, {
    tenantId: input.prepared.tenantId, taskId: input.prepared.taskId, runId: input.revisionRunId });
  const hashes = old.map(item => item.recordHash).sort();
  if (current.some(item => item.planHash !== input.revisedPlanHash || hashes.includes(item.recordHash)))
    return fail('old_approval_reused');
  return hashes;
}

/** Freeze original ten-yuan ledger and old first-frame approvals onto the
 * isolated run before changing the content task's run pointer. */
export async function freezeSocialProductFootageRevisionHandoff(input: {
  repository: Starter198Repository; prepared: Prepared; revisionRunId: string;
  queueItemId: string; ledgerRoot?: string }): Promise<{ recordHash: string; retainedCny: number;
  authorizesProvider: false; authorizesProduction: false }> {
  const { repository, prepared } = input, store = repository.dataStore;
  if (!store?.compareAndSwap || !await store.supportsAtomicCompareAndSwap?.()
    || prepared.repository !== repository || prepared.store !== store) return fail('atomic_store_required');
  const compareAndSwap = store.compareAndSwap.bind(store);
  return withSocialContentSubjectLease({ repository, tenantId: prepared.tenantId,
    subjectId: prepared.taskId, action: async () => {
      const candidate = await readPreparedSocialProductFootageRevision(prepared);
      const scheduled = await readSchedule(input);
      if (scheduled.context.revisedPlanHash !== candidate.revisedPlanHash
        || socialText(scheduled.task.run_id) !== prepared.sourceRunId
        || socialText(scheduled.task.version) !== prepared.expectedPreparedVersion) return fail('prepared_changed');
      const budget = readOriginalLedger({ ...input, tenantId: prepared.tenantId, taskId: prepared.taskId,
        sourceRunId: prepared.sourceRunId });
      if (budget.revisionEntries.length) return fail('revision_ledger_already_started');
      const oldApprovalHashes = await readOldApprovals({ ...input, revisedPlanHash: candidate.revisedPlanHash });
      const handoffVersion = String(Number(prepared.expectedPreparedVersion) + 1);
      if (!Number.isSafeInteger(Number(handoffVersion)) || Number(handoffVersion) < 2) return fail('version_invalid');
      const body = { schemaVersion: 'social-product-footage-revision-handoff-guard.v1' as const,
        tenantId: prepared.tenantId, taskId: prepared.taskId, sourceRunId: prepared.sourceRunId,
        revisionRunId: input.revisionRunId, preparedVersion: prepared.expectedPreparedVersion,
        handoffVersion, sourceBriefHash: socialRequestHash(socialJson(scheduled.task.brief)),
        sourceScriptHash: socialRequestHash(socialJson(scheduled.task.replication_script) ?? null),
        revisedPlanHash: candidate.revisedPlanHash, lineageHash: String(scheduled.context.lineageHash),
        budgetLedgerRef: prepared.budgetLedgerRef, originalSlotId: String(scheduled.context.originalSlotId),
        queueItemId: input.queueItemId, dispatchCommandId: String(scheduled.context.dispatchCommandId),
        ledgerHash: budget.ledgerHash, retainedMicros: budget.retainedMicros,
        ledgerAuthorityHash: ledgerAuthorityHash(input.ledgerRoot), oldApprovalHashes };
      const guard: Guard = { ...body, recordHash: socialRequestHash(body) };
      const prior = socialObject(scheduled.context.paidGuard);
      if (prior) { if (socialRequestHash(prior) !== socialRequestHash(guard)) return fail('guard_changed'); }
      else {
        await assertSocialContentSubjectLease({ repository, tenantId: prepared.tenantId, subjectId: prepared.taskId });
        if (!await compareAndSwap(STARTER_COLLECTIONS.runs, scheduled.run.id,
          { tenant_id: prepared.tenantId, status: scheduled.run.status,
            starter_context: scheduled.run.starter_context },
          { starter_context: { ...scheduled.context, paidGuard: guard } })) return fail('guard_conflict');
      }
      await readSocialProductFootageRevisionHandoffGuard({ ...input, expectedRecordHash: guard.recordHash });
      return { recordHash: guard.recordHash, retainedCny: budget.retainedMicros / 1e6,
        authorizesProvider: false as const, authorizesProduction: false as const };
    } });
}

/** Reread after CAS without requiring the task to remain on its source run.
 * New-run approvals are never inherited from the old run/plan. */
export async function readSocialProductFootageRevisionHandoffGuard(input: {
  repository: Starter198Repository; prepared: Prepared; revisionRunId: string;
  queueItemId: string; ledgerRoot?: string; expectedRecordHash: string }) {
  const { repository, prepared } = input;
  const scheduled = await readSchedule(input);
  const guard = socialObject(scheduled.context.paidGuard) as Guard | null;
  if (!guard || guard.schemaVersion !== 'social-product-footage-revision-handoff-guard.v1'
    || guard.recordHash !== input.expectedRecordHash || guard.tenantId !== prepared.tenantId
    || guard.taskId !== prepared.taskId || guard.sourceRunId !== prepared.sourceRunId
    || guard.revisionRunId !== input.revisionRunId || guard.preparedVersion !== prepared.expectedPreparedVersion
    || guard.queueItemId !== input.queueItemId || guard.lineageHash !== scheduled.context.lineageHash
    || guard.revisedPlanHash !== scheduled.context.revisedPlanHash
    || guard.originalSlotId !== scheduled.context.originalSlotId
    || guard.dispatchCommandId !== scheduled.context.dispatchCommandId
    || guard.ledgerAuthorityHash !== ledgerAuthorityHash(input.ledgerRoot)
    || guard.budgetLedgerRef !== prepared.budgetLedgerRef) return fail('guard_changed');
  const { recordHash, ...body } = guard;
  if (socialRequestHash(body) !== recordHash) return fail('guard_corrupt');
  const task = scheduled.task, brief = socialObject(socialJson(task.brief));
  const marker = socialObject(brief?._productFootageRevision);
  if (!marker || socialRequestHash(socialJson(task.brief)) !== guard.sourceBriefHash
    || socialRequestHash(socialJson(task.replication_script) ?? null) !== guard.sourceScriptHash
    || marker.sourceRunId !== prepared.sourceRunId || marker.budgetLedgerRef !== prepared.budgetLedgerRef
    || marker.sourceTaskVersion !== String(Number(prepared.expectedPreparedVersion) - 1)
    || socialObject(marker.revision)?.revisedPlanHash !== guard.revisedPlanHash) return fail('task_changed');
  const newRun = socialText(task.run_id) === input.revisionRunId;
  if (!newRun && (socialText(task.run_id) !== prepared.sourceRunId
    || socialText(task.version) !== prepared.expectedPreparedVersion
    || !['attention', 'paused'].includes(socialText(task.status)))) return fail('task_changed');
  if (newRun && (socialText(task.version) !== guard.handoffVersion
    || task.status !== 'paused' || socialText(task.orchestrator_item_id) !== input.queueItemId)) return fail('task_changed');
  const budget = readOriginalLedger({ ...input, tenantId: prepared.tenantId, taskId: prepared.taskId,
    sourceRunId: prepared.sourceRunId });
  if (budget.ledgerHash !== guard.ledgerHash || budget.retainedMicros !== guard.retainedMicros)
    return fail('ledger_changed');
  if (budget.revisionEntries.some(entry => entry.planHash !== guard.revisedPlanHash
    || !newRun && entry.status !== 'rejected')) return fail('revision_ledger_changed');
  const approvals = await readOldApprovals({ ...input, revisedPlanHash: guard.revisedPlanHash });
  if (socialRequestHash(approvals) !== socialRequestHash(guard.oldApprovalHashes)) return fail('old_approvals_changed');
  const sourcePlan = marker.sourcePlan as SocialAssetSupplyPlan;
  const revisedPlan = marker.revisedPlan as SocialAssetSupplyPlan;
  const revision = marker.revision as Parameters<typeof readVerifiedProductFootageRevision>[0]['storedRevision'];
  const candidate = await readVerifiedProductFootageRevision({ ...prepared,
    sourceTaskVersion: marker.sourceTaskVersion, sourcePlan,
    storedPlan: revisedPlan, storedRevision: revision });
  if (candidate.revision.revisedPlanHash !== guard.revisedPlanHash) return fail('review_changed');
  const jobs = await prepared.store.list<any>('content_execution_jobs',
    { where: { tenant_id: prepared.tenantId, task_id: prepared.taskId }, perPage: 500 });
  const admittedQueued = (job: any) => {
    if (!newRun || socialText(job.run_id) !== input.revisionRunId || socialText(job.status) !== 'queued'
      || Boolean(job.worker_id) || Boolean(job.lease_expires_at)
      || socialText(job.provider_state) !== 'none'
      || (Array.isArray(job.provider_receipts) && job.provider_receipts.length)) return false;
    const checkpoints = socialObject(socialJson(job.checkpoints));
    const checkpoint = socialObject(checkpoints?.['social.footage_revision_worker_admission']);
    const admission = socialObject(checkpoint?.payload);
    const { recordHash, ...body } = admission ?? {};
    return checkpoint?.version === '1' && checkpoint?.inputHash === recordHash
      && admission?.schemaVersion === 'social-product-footage-revision-worker-admission.v1'
      && admission.tenantId === prepared.tenantId && admission.taskId === prepared.taskId
      && admission.runId === input.revisionRunId && admission.guardHash === guard.recordHash
      && admission.planHash === guard.revisedPlanHash && admission.workerLane === 'social_content_production'
      && typeof recordHash === 'string' && socialRequestHash(body) === recordHash;
  };
  if (jobs.totalItems !== jobs.items.length || jobs.items.some(job => {
    const active = ['running', 'queued', 'retry_wait', 'reconciling', 'paused'].includes(socialText(job.status))
      || Boolean(job.worker_id) || Boolean(job.lease_expires_at);
    return active && !admittedQueued(job);
  })) return fail('execution_active');
  return { guard, retainedCny: guard.retainedMicros / 1e6,
    authorizesProvider: false as const, authorizesProduction: false as const };
}

/** Atomic identity handoff only. The workflow remains paused/blocked; a
 * separate verified permit and paid-worker contract are still required. */
export async function handoffSocialProductFootageRevision(input: {
  repository: Starter198Repository; prepared: Prepared; revisionRunId: string;
  queueItemId: string; ledgerRoot?: string; expectedRecordHash: string;
  actorId: string; now?: Date }): Promise<{ taskVersion: string; runId: string; repeated: boolean;
  authorizesProvider: false; authorizesProduction: false }> {
  const { repository, prepared } = input, store = repository.dataStore;
  if (!store?.compareAndSwap || !await store.supportsAtomicCompareAndSwap?.()
    || prepared.repository !== repository || prepared.store !== store || !socialText(input.actorId))
    return fail('atomic_store_required');
  const compareAndSwap = store.compareAndSwap.bind(store);
  return withSocialContentSubjectLease({ repository, tenantId: prepared.tenantId,
    subjectId: prepared.taskId, action: async () => {
      const checked = await readSocialProductFootageRevisionHandoffGuard(input);
      const task = await requireSocialTask({ repository, tenantId: prepared.tenantId, taskId: prepared.taskId });
      if (socialText(task.run_id) === input.revisionRunId) return {
        taskVersion: checked.guard.handoffVersion, runId: input.revisionRunId, repeated: true,
        authorizesProvider: false as const, authorizesProduction: false as const };
      const version = Number(task.version);
      if (!Number.isSafeInteger(version) || version < 1 || String(version + 1) !== checked.guard.handoffVersion)
        return fail('version_changed');
      await assertSocialContentSubjectLease({ repository, tenantId: prepared.tenantId, subjectId: prepared.taskId });
      if (!await compareAndSwap(STARTER_COLLECTIONS.socialContentTasks, task.id,
        { tenant_id: prepared.tenantId, version: task.version, run_id: task.run_id,
          status: task.status, brief: task.brief, replication_script: task.replication_script,
          content_order: task.content_order, orchestrator_item_id: task.orchestrator_item_id },
        { run_id: input.revisionRunId, orchestrator_item_id: input.queueItemId,
          status: 'paused', version: checked.guard.handoffVersion,
          updated_by: input.actorId, updated_at: (input.now ?? new Date()).toISOString() })) return fail('task_conflict');
      await readSocialProductFootageRevisionHandoffGuard(input);
      return { taskVersion: checked.guard.handoffVersion, runId: input.revisionRunId,
        repeated: false, authorizesProvider: false as const, authorizesProduction: false as const };
    } });
}
