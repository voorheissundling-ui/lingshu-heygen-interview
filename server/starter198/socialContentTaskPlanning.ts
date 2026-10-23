import type {
  CreateSocialWeeklyPlanInput, SelectSocialWorkPackagesInput, SocialContentTaskDetail, SocialWeeklyPlan,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import { readSocialTaskDetail, requireSocialTask, socialTaskSummary } from './socialContentRecords.js';
import { SocialContentWorkflowError, socialJson, socialObject, socialPublicId, socialRequestHash, socialText } from './socialContentValidation.js';
import { resolveSelectedPackages } from './socialWorkPackages.js';
import { assertVersion, nextVersion, socialWeeklyPlan } from './socialContentTaskSupport.js';

export async function selectSocialWorkPackages(input: {
  repository: Starter198Repository; tenantId: string; userId: string; taskId: string;
  idempotencyKey: string; value: SelectSocialWorkPackagesInput; now?: Date;
}): Promise<SocialContentTaskDetail> {
  const selection = await resolveSelectedPackages({ repository: input.repository, selections: input.value.selections, now: input.now });
  const mutation = await executeSocialContentMutation<{ task: SocialContentTaskDetail }>({
    repository: input.repository, tenantId: input.tenantId, userId: input.userId,
    idempotencyKey: input.idempotencyKey, requestHash: socialRequestHash(input.value),
    operation: 'select_social_work_packages', targetId: input.taskId, now: input.now,
    replay: async () => ({ task: (await readSocialTaskDetail(input))! }),
    action: async operationId => {
      const record = await requireSocialTask(input);
      if (socialText(record.last_operation_id) === operationId) return { task: (await readSocialTaskDetail(input))! };
      assertVersion(record, input.value.expectedVersion);
      if (!['draft', 'needs_input', 'plan_review'].includes(socialText(record.status))) {
        throw new SocialContentWorkflowError('social_package_selection_locked', 409);
      }
      await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, record.id, {
        package_selection: selection,
        status: socialTaskSummary(record).readiness.complete ? 'plan_review' : socialText(record.status),
        version: nextVersion(record), last_operation_id: operationId, updated_by: input.userId,
        updated_at: (input.now ?? new Date()).toISOString(),
      });
      return { task: (await readSocialTaskDetail(input))! };
    },
  });
  return mutation.value.task;
}

export type CreateSocialWeeklyPlanCommand = {
  repository: Starter198Repository; tenantId: string; userId: string;
  idempotencyKey: string; value: CreateSocialWeeklyPlanInput; now?: Date;
};

/** Parent-first and child-idempotent weekly planning, with task creation injected to avoid a module cycle. */
export async function createSocialWeeklyPlanWithTasks(
  input: CreateSocialWeeklyPlanCommand,
  createTask: typeof import('./socialContentTasks.js').createSocialContentTask,
): Promise<{ weeklyPlan: SocialWeeklyPlan; tasks: SocialContentTaskDetail[] }> {
  const existingPlans = await input.repository.list(STARTER_COLLECTIONS.plans, input.tenantId, {
    sort: '-created_at', page: 1, perPage: 500,
  });
  let planRecord = existingPlans.items.find(record => {
    const plan = socialObject(socialJson(record.plan));
    return socialText(plan?.schemaVersion) === 'social-content-weekly-plan.v1'
      && socialText(plan?.createIdempotencyKey) === input.idempotencyKey;
  });
  const timestamp = (input.now ?? new Date()).toISOString();
  if (!planRecord) {
    const weeklyPlanId = socialPublicId('socialweek');
    planRecord = await input.repository.create(STARTER_COLLECTIONS.plans, input.tenantId, {
      id: weeklyPlanId, goal_id: `social-content:${weeklyPlanId}`, status: 'draft',
      plan: {
        schemaVersion: 'social-content-weekly-plan.v1', weeklyPlanId,
        createIdempotencyKey: input.idempotencyKey,
        title: input.value.title, objective: input.value.objective,
        productId: input.value.productId ?? null, productRef: input.value.productRef ?? null,
        audience: input.value.audience ?? null, taskIds: [], version: '1',
      },
      created_at: timestamp, updated_at: timestamp,
    });
  }
  const currentPlan = socialWeeklyPlan(planRecord);
  if (!currentPlan) throw new SocialContentWorkflowError('social_weekly_plan_record_invalid', 503);
  const tasks: SocialContentTaskDetail[] = [];
  for (const [index, item] of input.value.items.entries()) {
    tasks.push(await createTask({
      repository: input.repository, tenantId: input.tenantId, userId: input.userId,
      idempotencyKey: `${input.idempotencyKey}:content-task:${index + 1}`,
      value: {
        title: item.title, objective: item.objective,
        productId: input.value.productId ?? null, productRef: input.value.productRef ?? null,
        audience: input.value.audience ?? null, mode: 'weekly', weeklyPlanId: currentPlan.weeklyPlanId,
        themeId: item.themeId ?? null, customTopic: item.customTopic ?? null,
        topic: item.topic ?? null, requestedOutputCount: 1,
      },
      now: input.now,
    }));
  }
  const storedPlan = socialObject(socialJson(planRecord.plan));
  if (!storedPlan) throw new SocialContentWorkflowError('social_weekly_plan_record_invalid', 503);
  const taskIds = tasks.map(task => task.taskId);
  const storedTaskIds = socialJson(storedPlan.taskIds);
  const alreadyCurrent = socialText(planRecord.status) === 'active'
    && Array.isArray(storedTaskIds)
    && storedTaskIds.map(socialText).join('|') === taskIds.join('|');
  if (!alreadyCurrent) {
    const nextPlanVersion = String(Math.max(1, Number(storedPlan.version) || 1) + 1);
    await input.repository.update(STARTER_COLLECTIONS.plans, input.tenantId, planRecord.id, {
      status: 'active', plan: { ...storedPlan, taskIds, version: nextPlanVersion }, updated_at: timestamp,
    });
  }
  const updated = await input.repository.get(STARTER_COLLECTIONS.plans, input.tenantId, planRecord.id);
  const weeklyPlan = updated && socialWeeklyPlan(updated);
  if (!weeklyPlan) throw new SocialContentWorkflowError('social_weekly_plan_record_invalid', 503);
  return { weeklyPlan, tasks };
}
