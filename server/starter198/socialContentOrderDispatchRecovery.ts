import { withWeeklyProductionStartGuard } from '../runtime/weeklyProductionStartGuard.js';
import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';
import { reserveSocialContentOrder, type SocialContentDispatchEnvelope, type SocialContentOrderBinding } from './socialContentOrderAdmission.js';
import { withSocialContentSubjectLease } from './socialContentMutation.js';
import { readSocialTaskDetail, requireSocialTask } from './socialContentRecords.js';
import { socialContentQueueItemId } from './socialContentScheduler.js';
import { socialContentReviewAdmissionAllowed } from './socialContentTestBypass.js';
import { nextVersion } from './socialContentTaskSupport.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import type { Starter198OrchestratorQueuePort } from './runtimePorts.js';

/** Replay only a committed server-frozen start. Provider recovery remains owned by the durable execution job. */
export async function recoverSocialContentOrderDispatch(input: { repository: Starter198Repository;
  orchestratorQueue: Starter198OrchestratorQueuePort; tenantId: string; taskId: string; commandId: string; now?: Date;
}): Promise<SocialContentTaskDetail> {
  return withSocialContentSubjectLease({ ...input, subjectId: input.taskId, action: async () => {
    let row = await requireSocialTask(input);
    const order = socialObject(socialJson(row.content_order)) as unknown as SocialContentOrderBinding | null;
    const envelopes = [order?.dispatch, ...(order?.dispatchHistory ?? [])]
      .filter((value): value is SocialContentDispatchEnvelope => Boolean(value && value.commandId === input.commandId));
    if (envelopes.length !== 1) throw new SocialContentWorkflowError('social_content_order_dispatch_missing_or_ambiguous', 409);
    const dispatch = envelopes[0]!, { requestHash, ...frozen } = dispatch, queueRequest = dispatch.queueRequest;
    if (dispatch.schemaVersion !== 'social-content-dispatch.v1' || requestHash !== socialRequestHash(frozen)
      || queueRequest.tenantId !== input.tenantId || queueRequest.subject?.id !== input.taskId || queueRequest.commandId !== input.commandId
      || queueRequest.userId !== dispatch.userId || queueRequest.idempotencyKey !== dispatch.idempotencyKey
      || queueRequest.subject.admissionVersion !== dispatch.expectedVersion || queueRequest.workflowScope !== 'social_content') {
      throw new SocialContentWorkflowError('social_content_order_dispatch_invalid', 409);
    }
    const operations = await input.repository.list(STARTER_COLLECTIONS.socialContentOperations, input.tenantId,
      { where: { operation_id: input.commandId }, perPage: 2 });
    const operation = operations.items[0];
    if (operations.totalItems !== 1 || operations.items.length !== 1 || !operation || operation.operation !== 'start_social_content_task'
      || operation.target_id !== input.taskId || operation.created_by !== dispatch.userId || operation.idempotency_key !== dispatch.idempotencyKey
      || operation.request_hash !== socialRequestHash({ expectedVersion: dispatch.expectedVersion })
      || !['processing', 'succeeded'].includes(socialText(operation.status))) {
      throw new SocialContentWorkflowError('social_content_order_original_start_required', 409);
    }
    if (['paused', 'cancelled', 'cancelling', 'pausing'].includes(socialText(row.status))) {
      throw new SocialContentWorkflowError('social_content_order_dispatch_stopped', 409);
    }
    if (order?.dispatch?.commandId !== input.commandId) throw new SocialContentWorkflowError('social_content_order_dispatch_superseded', 409);
    const receipt = await reserveSocialContentOrder({ repository: input.repository, tenantId: input.tenantId,
      userId: dispatch.userId, task: row, commandId: input.commandId, dispatch, now: input.now });
    if (!receipt || receipt.dispatchCommandId !== input.commandId) throw new SocialContentWorkflowError('social_content_order_identity_invalid', 409);
    const expectedQueueId = socialContentQueueItemId(queueRequest);
    const alreadyScheduled = socialText(row.orchestrator_item_id) === expectedQueueId && Boolean(socialText(row.run_id));
    const submit = async () => {
      row = await requireSocialTask(input);
      if (alreadyScheduled && socialText(row.last_operation_id) !== input.commandId) {
        const run = await input.repository.get(STARTER_COLLECTIONS.runs, input.tenantId, socialText(row.run_id));
        const context = socialObject(socialJson(run?.starter_context));
        const jobs = await input.repository.dataStore?.list<any>('content_execution_jobs', {
          where: { tenant_id: input.tenantId, task_id: input.taskId, run_id: socialText(row.run_id) }, perPage: 100,
        });
        if (context?.schemaVersion !== 'starter-social-content.auto-execution.v1' || context.socialTaskId !== input.taskId
          || !jobs?.items.length || jobs.totalItems !== jobs.items.length) {
          throw new SocialContentWorkflowError('social_content_order_dispatch_run_receipt_required', 409);
        }
        return (await readSocialTaskDetail(input))!;
      }
      if (!alreadyScheduled) {
        if (socialText(row.version) !== queueRequest.subject!.version) throw new SocialContentWorkflowError('social_content_order_dispatch_inputs_changed', 409);
        const detail = await readSocialTaskDetail(input);
        if (!detail?.readiness.complete || !detail.agentWorkflow || !socialContentReviewAdmissionAllowed(detail.agentWorkflow.executionPlanReview)) {
          throw new SocialContentWorkflowError('social_content_order_dispatch_admission_changed', 409);
        }
      }
      const result = await input.orchestratorQueue.enqueue(structuredClone(queueRequest));
      if (!result.queueItemId || result.queueItemId !== expectedQueueId || (alreadyScheduled && result.runId !== socialText(row.run_id))) {
        throw new SocialContentWorkflowError('social_content_order_dispatch_receipt_changed', 503);
      }
      const current = await requireSocialTask(input);
      if (socialText(current.orchestrator_item_id) !== result.queueItemId) {
        if (socialText(current.version) !== queueRequest.subject!.version) throw new SocialContentWorkflowError('social_content_order_dispatch_projection_changed', 409);
        await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, current.id, {
          status: result.disposition === 'awaiting_initial_confirmation' ? 'plan_review' : result.disposition === 'requires_manual_production' ? 'attention' : 'producing',
          run_id: result.runId ?? '', orchestrator_item_id: result.queueItemId, version: nextVersion(current),
          last_operation_id: input.commandId, updated_by: dispatch.userId, updated_at: (input.now ?? new Date()).toISOString(),
        });
      }
      return (await readSocialTaskDetail(input))!;
    };
    let submitted = false;
    await withWeeklyProductionStartGuard(input, async () => { submitted = true; return submit(); });
    if (!submitted) {
      if (!alreadyScheduled) throw new SocialContentWorkflowError('social_content_order_dispatch_run_changed', 409);
      await submit();
    }
    await receipt.acknowledge();
    await input.repository.update(STARTER_COLLECTIONS.socialContentOperations, input.tenantId, operation.id, {
      status: 'succeeded', result: { schemaVersion: 'social-content.operation-result.v1', operationId: input.commandId, targetId: input.taskId },
      http_status: 200, error_code: '', updated_at: (input.now ?? new Date()).toISOString(),
    });
    return (await readSocialTaskDetail(input))!;
  } });
}
