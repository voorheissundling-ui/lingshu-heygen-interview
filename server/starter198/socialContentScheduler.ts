import {assessWeeklyOwnedProductIdentity,type WeeklyOwnedProductIdentityPorts} from '../runtime/weeklyOwnedProductIdentityDemand.js';
import {freezeWeeklyReplicationAuthority} from './socialWeeklyReplicationAuthority.js';
import {buildWeeklySchedulerMaterialPlanProof} from './socialWeeklySchedulerMaterialPlan.js';
import { createHash } from 'node:crypto';
import type { SocialTaskSource } from '../../shared/contracts/socialContentWorkflow.js';
import { Starter198QuotaError } from './quota.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import type {
  Starter198OrchestratorQueuePort,
  Starter198OrchestratorQueueResult,
} from './runtimePorts.js';
import { Starter198RuntimePortError } from './runtimePorts.js';
import {
  assertSocialContentSubjectLease,
  withSocialContentSubjectLease,
} from './socialContentMutation.js';
import {
  readSocialTaskDetail,
  requireSocialTask,
  socialTaskReadiness,
  socialTaskSource,
  socialTaskSummary,
} from './socialContentRecords.js';
import {
  SocialContentWorkflowError,
  socialRequestHash,
  socialJson,
  socialObject,
  socialText,
} from './socialContentValidation.js';
import { resolveSelectedPackages } from './socialWorkPackages.js';
import {
  SocialContentAccessError,
  socialContentAccessResolver,
  type SocialContentAccessResolver,
} from './socialContentAccess.js';

type SocialQueueInput = Parameters<Starter198OrchestratorQueuePort['enqueue']>[0];

const STARTABLE_STATUSES = new Set(['draft', 'needs_input', 'plan_review', 'paused', 'attention']);
const SOCIAL_WORKFLOW_PROFILE = 'starter_social_content';
const SOCIAL_WORKFLOW_TASK_KEY = 'social_content_auto_production';

function fail(code: string, status: number): never {
  throw new Starter198RuntimePortError(code, status);
}

function nextVersion(record: StarterRecord): string {
  const current = Number(record.version);
  if (!Number.isSafeInteger(current) || current < 1) {
    fail('social_content_task_record_invalid', 503);
  }
  return String(current + 1);
}

export function socialContentQueueItemId(input: SocialQueueInput): string {
  const digest = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    tenantId: input.tenantId,
    commandId: input.commandId,
    taskId: input.subject?.id,
  })).digest('hex').slice(0, 32);
  return `social-content:${digest}`;
}

function workflowId(namespace: string, tenantId: string, taskId: string): string {
  return createHash('sha256').update(`${namespace}:${tenantId}:${taskId}`).digest('hex').slice(0, 15);
}

async function ensureRecord(input: {
  repository: Starter198Repository;
  collection: Parameters<Starter198Repository['get']>[0];
  tenantId: string;
  id: string;
  data: Record<string, unknown>;
  valid: (record: StarterRecord) => boolean;
}): Promise<StarterRecord> {
  const current = await input.repository.get(input.collection, input.tenantId, input.id);
  if (current) {
    if (!input.valid(current)) fail('social_content_execution_record_integrity_violation', 503);
    return current;
  }
  try {
    const created = await input.repository.create(input.collection, input.tenantId, {
      id: input.id,
      ...input.data,
    });
    if (!input.valid(created)) fail('social_content_execution_record_integrity_violation', 503);
    return created;
  } catch (error) {
    const raced = await input.repository.get(input.collection, input.tenantId, input.id).catch(() => null);
    if (!raced || !input.valid(raced)) throw error;
    return raced;
  }
}

/**
 * Persist an isolated, recoverable automatic production checkpoint. It stays
 * outside the starter_198 sales graph so the sales worker cannot consume a
 * social-content run by mistake.
 */
async function ensureAutomaticExecution(input: {
  repository: Starter198Repository;
  queue: SocialQueueInput;
  task: StarterRecord;
  sources: SocialTaskSource[];
  now: Date;
  materialEvidencePorts?:Omit<WeeklyOwnedProductIdentityPorts,'repository'>;
}): Promise<string> {
  const tenantId = input.queue.tenantId;
  const taskId = socialText(input.queue.subject?.id);
  const taskSummary = socialTaskSummary(input.task);
  const workflowSubject = `${taskId}:${taskSummary.version}`;
  const goalId = workflowId('social-goal', tenantId, workflowSubject);
  const planId = workflowId('social-plan', tenantId, workflowSubject);
  const runId = workflowId('social-run', tenantId, workflowSubject);
  const executionTaskId = workflowId('social-task', tenantId, workflowSubject);
  const initializationId = createHash('sha256').update(JSON.stringify({
    schemaVersion: 1,
    tenantId,
    taskId,
    sourceRefs: normalizedSources(input.sources.map(source => ({
      id: source.sourceId,
      ...(source.sourceVersion ? { version: source.sourceVersion } : {}),
    }))),
    packageSelection: normalizedPackages(input.queue.subject?.packageSelection ?? []),
  })).digest('hex');
  const createdAt = input.now.toISOString();
  const weeklyTask=Boolean(socialObject(socialObject(socialJson(input.task.brief))?._weeklyAuthority));
  const materialDetail=weeklyTask?await readSocialTaskDetail({repository:input.repository,tenantId,taskId}):null;
  if(materialDetail&&input.repository.dataStore){const authority=socialObject(socialObject(socialJson(input.task.brief))?._weeklyAuthority),pkg=socialObject(authority?.weeklyPackage),pub=socialObject(authority?.publicationTask);if(pkg&&pub){const owned=await assessWeeklyOwnedProductIdentity(input.repository.dataStore,{tenantId,programId:String(pkg.programId),packageId:String(pkg.packageId),packageVersion:Number(pkg.version),publicationTaskId:String(pub.publicationTaskId),contentTaskId:taskId},{...input.materialEvidencePorts,repository:input.repository,startAdmission:{commandId:input.queue.commandId,admissionVersion:String(input.queue.subject?.admissionVersion),actorUserId:input.queue.userId}});if(owned.required&&owned.status!=='ready')throw new SocialContentWorkflowError(owned.gaps[0]??'weekly_owned_product_identity_verification_required',409);}}
  const weeklyReplicationAuthority=materialDetail?await freezeWeeklyReplicationAuthority(input.repository,input.task,materialDetail):null;
  const weeklyMaterialPlan=materialDetail?buildWeeklySchedulerMaterialPlanProof({tenantId,taskId,commandId:input.queue.commandId,row:input.task,detail:materialDetail,sources:input.sources}):null;
  const lineage = {
    schemaVersion: 'starter-social-content.auto-execution.v1',
    socialTaskId: taskId,
    socialTaskVersion: taskSummary.version,
    ...(weeklyMaterialPlan?{weeklyMaterialPlan}:{}),
    ...(socialObject(socialObject(socialJson(input.task.brief))?._weeklyOwnedProductIdentityDemand)?{weeklyOwnedProductIdentityDemand:structuredClone(socialObject(socialObject(socialJson(input.task.brief))?._weeklyOwnedProductIdentityDemand))}:{}),
    ...(weeklyReplicationAuthority?{weeklyReplicationAuthority}:{}),
    sourceRefs: normalizedSources(input.sources.map(source => ({
      id: source.sourceId,
      ...(source.sourceVersion ? { version: source.sourceVersion } : {}),
    }))),
    packageSelection: normalizedPackages(taskSummary.packageSelection),
    executorAvailable: true,
    productionPolicy: 'director_plan_then_content_render',
    workflowStages: ['director_planning', 'content_production', 'rendering', 'quality_check', 'review_ready'],
    userReviewRequired: true,
  };
  await ensureRecord({
    repository: input.repository,
    collection: STARTER_COLLECTIONS.goals,
    tenantId,
    id: goalId,
    data: {
      title: taskSummary.brief.title,
      objective: taskSummary.brief.objective,
      metric: 'approved_social_content_artifacts',
      target: taskSummary.brief.requestedOutputCount ?? 1,
      unit: 'artifact',
      starts_at: createdAt.slice(0, 10),
      ends_at: taskSummary.brief.dueAt?.slice(0, 10) || createdAt.slice(0, 10),
      scope: { socialTaskId: taskId },
      constraints: taskSummary.brief.restrictions,
      owner_id: input.queue.userId,
      status: 'active',
      version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    },
    valid: record => socialText(record.id) === goalId
      && socialText(record.objective) === taskSummary.brief.objective,
  });
  await ensureRecord({
    repository: input.repository,
    collection: STARTER_COLLECTIONS.plans,
    tenantId,
    id: planId,
    data: {
      goal_id: goalId,
      status: 'active',
      plan: lineage,
      created_at: createdAt,
    },
    valid: record => socialText(record.id) === planId && socialText(record.goal_id) === goalId,
  });
  await ensureRecord({
    repository: input.repository,
    collection: STARTER_COLLECTIONS.runs,
    tenantId,
    id: runId,
    data: {
      goal_id: goalId,
      plan_id: planId,
      status: 'running',
      current_controller: 'agent',
      pause_reason: '',
      product_profile: SOCIAL_WORKFLOW_PROFILE,
      starter_initialization_id: initializationId,
      starter_input_version: taskSummary.version,
      starter_plan_version: 1,
      starter_context: lineage,
      started_at: createdAt,
      completed_at: '',
    },
    valid: record => socialText(record.id) === runId
      && socialText(record.goal_id) === goalId
      && socialText(record.plan_id) === planId
      && socialText(record.product_profile) === SOCIAL_WORKFLOW_PROFILE
      && (!weeklyMaterialPlan || socialRequestHash((record.starter_context as {weeklyMaterialPlan?:unknown})?.weeklyMaterialPlan)===socialRequestHash(weeklyMaterialPlan))
      && ['running', 'completed', 'waiting_external'].includes(socialText(record.status)),
  });
  await ensureRecord({
    repository: input.repository,
    collection: STARTER_COLLECTIONS.tasks,
    tenantId,
    id: executionTaskId,
    data: {
      goal_id: goalId,
      plan_id: planId,
      run_id: runId,
      task_key: SOCIAL_WORKFLOW_TASK_KEY,
      title: '编导 Agent 策划并交接内容 Agent 成片',
      description: '编导 Agent 先根据公式／灵感脚本、企业知识和真实素材锁定导演方案；内容 Agent 只执行配音、字幕、剪辑与质检，不重新生成脚本。',
      agent_role: 'content',
      kind: 'production',
      status: 'running',
      sequence: 1,
      priority: 'high',
      requires_approval: false,
      depends_on: [],
      output: lineage,
      blocked_reason: '',
      owner_id: input.queue.userId,
      execution_mode: 'automatic',
      external_effect: 'none',
      automatic_execution_allowed: true,
      policy_source: 'starter_social_content.auto-production.v1',
      task_version: 1,
      correction_version: 0,
      created_at: createdAt,
      updated_at: createdAt,
    },
    valid: record => socialText(record.id) === executionTaskId
      && socialText(record.run_id) === runId
      && socialText(record.task_key) === SOCIAL_WORKFLOW_TASK_KEY,
  });
  return runId;
}

function normalizedSources(sources: Array<{ id: string; version?: string }>): Array<{ id: string; version: string }> {
  return sources.map(source => ({ id: socialText(source.id), version: socialText(source.version) }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.version.localeCompare(right.version));
}

function normalizedPackages(
  packages: Array<{ kind: string; packageKey: string; version: string }>,
): Array<{ kind: string; packageKey: string; version: string }> {
  return packages.map(item => ({
    kind: socialText(item.kind),
    packageKey: socialText(item.packageKey),
    version: socialText(item.version),
  })).sort((left, right) => left.kind.localeCompare(right.kind));
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function requireStartOperation(input: {
  repository: Starter198Repository;
  queue: SocialQueueInput;
}): Promise<StarterRecord> {
  const result = await input.repository.list(
    STARTER_COLLECTIONS.socialContentOperations,
    input.queue.tenantId,
    { where: { operation_id: input.queue.commandId }, perPage: 2 },
  );
  if (result.totalItems !== result.items.length || result.items.length > 1) {
    fail('social_content_schedule_receipt_integrity_violation', 503);
  }
  const operation = result.items[0];
  const subjectId = socialText(input.queue.subject?.id);
  if (!operation) fail('social_content_schedule_receipt_not_found', 409);
  if (socialText(operation.operation_id) !== input.queue.commandId
    || socialText(operation.idempotency_key) !== input.queue.idempotencyKey
    || socialText(operation.operation) !== 'start_social_content_task'
    || socialText(operation.target_id) !== subjectId
    || socialText(operation.request_hash) !== socialRequestHash({ expectedVersion: input.queue.subject?.admissionVersion })
    || socialText(operation.created_by) !== input.queue.userId
    || !['processing', 'succeeded'].includes(socialText(operation.status))) {
    fail('social_content_schedule_receipt_integrity_violation', 503);
  }
  return operation;
}

async function activeSources(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
}): Promise<SocialTaskSource[]> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialTaskSources, input.tenantId, {
    where: { task_id: input.taskId, status: 'active' },
    sort: 'source_id',
    perPage: 101,
  });
  if (result.totalItems !== result.items.length || result.totalItems > 100) {
    fail('social_content_source_integrity_violation', 503);
  }
  return result.items.map(socialTaskSource);
}

function assertSubjectMatches(input: {
  record: StarterRecord;
  sources: SocialTaskSource[];
  queue: SocialQueueInput;
}): void {
  const subject = input.queue.subject;
  if (!subject || subject.type !== 'social_content_task') fail('social_content_orchestrator_subject_invalid', 400);
  const task = socialTaskSummary(input.record);
  if (task.taskId !== subject.id) fail('social_content_orchestrator_subject_invalid', 400);
  if (task.version !== subject.version) fail('social_content_task_version_conflict', 409);
  // Public admission already rejected a direct start from asset_review. A
  // rejected-artifact retry may legitimately project back to asset_review
  // before enqueue because the rejected artifact remains immutable history;
  // only a receipt whose admitted and reconciled versions differ can carry
  // that internal retry state.
  if (!STARTABLE_STATUSES.has(task.status)
    && !(task.status === 'asset_review' && subject.admissionVersion !== subject.version)) {
    fail('social_content_task_not_startable', 409);
  }
  if (input.sources.length !== task.sourceCount) fail('social_content_source_integrity_violation', 503);
  if (input.sources.some(source => !socialText(source.sourceId))
    || subject.sourceRefs.some(source => !source || !socialText(source.id))
    || subject.packageSelection.some(item => !item || !socialText(item.kind)
      || !socialText(item.packageKey) || !socialText(item.version))) {
    fail('social_content_orchestrator_lineage_invalid', 409);
  }
  const readiness = socialTaskReadiness(task.brief, {
    total: input.sources.length,
    knowledge: input.sources.filter(source => source.kind === 'knowledge').length,
    // A web link may inspire the script, but it is not renderable, owned
    // product footage. Publish-ready tasks require an explicitly linked
    // material record.
    material: input.sources.filter(source => source.kind === 'material').length,
  }, task.theme ? {
    theme: task.theme,
    materialReadiness: task.materialReadiness ?? {
      complete: true,
      requiredCount: 0,
      satisfiedRequiredCount: 0,
      blockingRequirementIds: [],
    },
  } : undefined);
  if (!readiness.complete) fail('social_content_task_inputs_incomplete', 409);

  const expectedSources = normalizedSources(input.sources.map(source => ({
    id: source.sourceId,
    ...(source.sourceVersion ? { version: source.sourceVersion } : {}),
  })));
  const receivedSources = normalizedSources(subject.sourceRefs);
  if (new Set(receivedSources.map(source => `${source.id}\u0000${source.version}`)).size !== receivedSources.length
    || !exactJson(receivedSources, expectedSources)) {
    fail('social_content_orchestrator_source_lineage_invalid', 409);
  }

  const expectedPackages = normalizedPackages(task.packageSelection);
  const receivedPackages = normalizedPackages(subject.packageSelection);
  if (receivedPackages.length !== 3
    || new Set(receivedPackages.map(item => item.kind)).size !== 3
    || !exactJson(receivedPackages, expectedPackages)) {
    fail('social_content_orchestrator_package_lineage_invalid', 409);
  }
  if (subject.conversionObjective !== Boolean(task.brief.callToAction)) {
    fail('social_content_orchestrator_objective_lineage_invalid', 409);
  }
}

function automaticResult(input: SocialQueueInput, runId: string): Starter198OrchestratorQueueResult {
  return {
    queueItemId: socialContentQueueItemId(input),
    runId,
    disposition: 'queued',
    missingFacts: [],
  };
}

/**
 * Durable social-content admission path. The content worker runs against the
 * selected formula/script baseline and never routes the customer through the
 * legacy Studio authoring flow.
 */
export async function scheduleSocialContentWork(input: {
  repository: Starter198Repository;
  queue: SocialQueueInput;
  now: Date;
  accessResolver?: SocialContentAccessResolver;
  materialEvidencePorts?:Omit<WeeklyOwnedProductIdentityPorts,'repository'>;
  productionRunner?: (input: {
    repository: Starter198Repository;
    tenantId: string;
    userId: string;
    taskId: string;
    runId: string;
  }) => void | Promise<void>;
}): Promise<Starter198OrchestratorQueueResult> {
  const subject = input.queue.subject;
  if (!subject || subject.type !== 'social_content_task' || !socialText(subject.id)
    || !socialText(subject.admissionVersion)
    || !socialText(subject.version)
    || !Array.isArray(subject.sourceRefs)
    || !Array.isArray(subject.packageSelection)
    || typeof subject.conversionObjective !== 'boolean') {
    fail('social_content_orchestrator_subject_invalid', 400);
  }
  return withSocialContentSubjectLease({
    repository: input.repository,
    tenantId: input.queue.tenantId,
    subjectId: subject.id,
    action: async () => {
      await requireStartOperation(input);
      try {
        await (input.accessResolver ?? socialContentAccessResolver).resolve({
          repository: input.repository,
          tenantId: input.queue.tenantId,
          requiredCapabilities: ['orchestrator.command.submit', 'workflow.standard.run'],
          now: input.now,
          requireOpenCycle: true,
        });
      } catch (error) {
        if (error instanceof Starter198QuotaError) fail(error.code, error.status);
        if (error instanceof SocialContentAccessError) fail(error.code, error.status);
        throw error;
      }

      let record: StarterRecord;
      try {
        record = await requireSocialTask({
          repository: input.repository,
          tenantId: input.queue.tenantId,
          taskId: subject.id,
        });
      } catch (error) {
        if (error instanceof SocialContentWorkflowError) fail(error.code, error.status);
        throw error;
      }
      if (socialText(record.last_operation_id) === input.queue.commandId) {
        const existingRunId = socialText(record.run_id);
        const result = automaticResult(input.queue, existingRunId);
        if (!existingRunId || socialText(record.orchestrator_item_id) !== result.queueItemId
          || !['producing', 'asset_review', 'packaging', 'delivered'].includes(socialText(record.status))) {
          fail('social_content_schedule_state_integrity_violation', 503);
        }
        if (socialText(record.status) === 'producing') await input.productionRunner?.({
          repository: input.repository,
          tenantId: input.queue.tenantId,
          userId: input.queue.userId,
          taskId: subject.id,
          runId: existingRunId,
        });
        return result;
      }

      const sources = await activeSources({
        repository: input.repository,
        tenantId: input.queue.tenantId,
        taskId: subject.id,
      });
      assertSubjectMatches({ record, sources, queue: input.queue });
      try {
        await resolveSelectedPackages({
          repository: input.repository,
          selections: socialTaskSummary(record).packageSelection,
          now: input.now,
        });
      } catch (error) {
        if (error instanceof SocialContentWorkflowError) fail(error.code, error.status);
        throw error;
      }

      const runId = await ensureAutomaticExecution({
        repository: input.repository,
        queue: input.queue,
        task: record,
        materialEvidencePorts:input.materialEvidencePorts,
        sources,
        now: input.now,
      });
      const result = automaticResult(input.queue, runId);

      await assertSocialContentSubjectLease({
        repository: input.repository,
        tenantId: input.queue.tenantId,
        subjectId: subject.id,
      });
      await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.queue.tenantId, record.id, {
        status: 'producing',
        run_id: runId,
        orchestrator_item_id: result.queueItemId,
        version: nextVersion(record),
        last_operation_id: input.queue.commandId,
        updated_by: input.queue.userId,
        updated_at: input.now.toISOString(),
      });
      const written = await requireSocialTask({
        repository: input.repository,
        tenantId: input.queue.tenantId,
        taskId: subject.id,
      });
      if (socialText(written.status) !== 'producing'
        || socialText(written.run_id) !== runId
        || socialText(written.last_operation_id) !== input.queue.commandId
        || socialText(written.orchestrator_item_id) !== result.queueItemId) {
        fail('social_content_schedule_state_integrity_violation', 503);
      }
      await input.productionRunner?.({
        repository: input.repository,
        tenantId: input.queue.tenantId,
        userId: input.queue.userId,
        taskId: subject.id,
        runId,
      });
      return result;
    },
  });
}
