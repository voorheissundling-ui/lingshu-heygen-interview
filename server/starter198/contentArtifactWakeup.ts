import type { DataStore } from '../storage/datastore.js';
import {
  managedContentProjectIsReviewable,
  requireIndexedContentProjectLineage,
} from '../digitalEmployees/contentProjectLineage.js';
import { STARTER_198_PROFILE_VERSION } from '../../shared/contracts/starter198.js';
import {
  createStarter198Repository,
  STARTER_COLLECTIONS,
  Starter198RepositoryError,
  type Starter198Repository,
  type StarterRecord,
} from './repository.js';
import {
  listStarter198PendingApprovals,
  starter198RunInScope,
  starter198TaskInScope,
} from './workflowScope.js';
import {
  Starter198RunMutationLeaseError,
  withStarter198RunMutationLease,
} from './runMutationLease.js';

const STUDIO_COLLECTION = 'studio_projects';
const PRODUCTION_TASK_KEY = 'starter_content_production';
const QUALITY_TASK_KEY = 'starter_content_quality_gate';
const WAIT_SCHEMA = 'starter-198.content-adapter-wait.v1';
const WAIT_ADAPTER = 'indexed_studio_artifact_read_v2';
const WAKE_SCHEMA = 'starter-198.content-artifact-wakeup.v1';
const RECOVERABLE_WAIT_REASONS = new Set([
  'tenant_content_pipeline_not_connected',
  'tenant_content_artifact_not_ready',
]);
const CLOSED_RUN_STATUSES = new Set([
  'cancelling', 'cancelled', 'failed', 'succeeded', 'completed', 'waiting_human',
]);
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

export interface StarterContentArtifactWakeupResult {
  state: 'ignored' | 'ready';
  reason: string;
  resetTaskIds: string[];
  runResumed: boolean;
}

export interface StarterContentArtifactWakeupBatchResult {
  readyProjectIds: string[];
  ignoredProjectIds: string[];
  deferred: Array<{ projectId: string; code: string; retryable: boolean }>;
}

export class StarterContentArtifactWakeupError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'StarterContentArtifactWakeupError';
  }
}

const ignored = (reason: string): StarterContentArtifactWakeupResult => ({
  state: 'ignored', reason, resetTaskIds: [], runResumed: false,
});

function deferredWakeup(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof Starter198RunMutationLeaseError) {
    return { code: error.code, retryable: true };
  }
  if (error instanceof StarterContentArtifactWakeupError) {
    return {
      code: error.code,
      retryable: [
        'starter_content_wakeup_storage_unavailable',
        'starter_content_wakeup_task_write_lost',
        'starter_content_wakeup_run_write_lost',
      ].includes(error.code),
    };
  }
  if (error instanceof Starter198RepositoryError) {
    return {
      code: error.code,
      retryable: error.code === 'starter_198_storage_unavailable',
    };
  }
  return { code: 'starter_content_wakeup_unavailable', retryable: false };
}

function indexedReviewableProject(
  project: StarterRecord | null,
  tenantId: string,
): ReturnType<typeof requireIndexedContentProjectLineage> | null {
  if (!project || text(project.tenant_id) !== tenantId || !managedContentProjectIsReviewable(project)) return null;
  try { return requireIndexedContentProjectLineage(project); } catch { return null; }
}

async function readProject(dataStore: DataStore, projectId: string): Promise<StarterRecord | null> {
  try { return await dataStore.getById<StarterRecord>(STUDIO_COLLECTION, projectId); }
  catch { throw new StarterContentArtifactWakeupError('starter_content_wakeup_storage_unavailable'); }
}

function starterProductionTaskMatches(input: {
  task: StarterRecord | null;
  tenantId: string;
  runId: string;
}): input is { task: StarterRecord; tenantId: string; runId: string } {
  return starter198TaskInScope(input.task, input.tenantId, input.runId)
    && text(input.task.task_key) === PRODUCTION_TASK_KEY
    && text(input.task.policy_source) === STARTER_198_PROFILE_VERSION;
}

function starterQualityTaskMatches(input: {
  task: StarterRecord | null;
  tenantId: string;
  runId: string;
}): input is { task: StarterRecord; tenantId: string; runId: string } {
  return starter198TaskInScope(input.task, input.tenantId, input.runId)
    && text(input.task.task_key) === QUALITY_TASK_KEY
    && text(input.task.policy_source) === STARTER_198_PROFILE_VERSION;
}

function recoverableWait(task: StarterRecord, runId: string): string | null {
  if (text(task.status) !== 'waiting_external') return null;
  const output = object(task.output);
  const reason = text(output?.reasonCode);
  return output?.schemaVersion === WAIT_SCHEMA
    && text(output.executionStatus) === 'waiting_external'
    && text(output.adapter) === WAIT_ADAPTER
    && text(output.runId) === runId
    && text(output.taskId) === task.id
    && text(output.taskKey) === text(task.task_key)
    && RECOVERABLE_WAIT_REASONS.has(reason)
    ? reason
    : null;
}

function wakeMarker(input: {
  task: StarterRecord;
  runId: string;
  projectId: string;
  lineageHash: string;
  priorReasonCode: string;
  resetAt: string;
}): Record<string, unknown> {
  const priorOutput = object(input.task.output);
  return {
    schemaVersion: WAKE_SCHEMA,
    executionStatus: 'pending',
    wakeSource: WAIT_ADAPTER,
    taskKey: text(input.task.task_key),
    runId: input.runId,
    taskId: input.task.id,
    projectId: input.projectId,
    lineageHash: input.lineageHash,
    priorReasonCode: input.priorReasonCode,
    resetAt: input.resetAt,
    ...(object(priorOutput?.metering) ? { metering: priorOutput?.metering } : {}),
  };
}

function exactWakeMarker(input: {
  task: StarterRecord;
  runId: string;
  projectId: string;
  lineageHash: string;
}): boolean {
  if (text(input.task.status) !== 'pending') return false;
  const output = object(input.task.output);
  return output?.schemaVersion === WAKE_SCHEMA
    && text(output.executionStatus) === 'pending'
    && text(output.wakeSource) === WAIT_ADAPTER
    && text(output.taskKey) === text(input.task.task_key)
    && text(output.runId) === input.runId
    && text(output.taskId) === input.task.id
    && text(output.projectId) === input.projectId
    && text(output.lineageHash) === input.lineageHash
    && RECOVERABLE_WAIT_REASONS.has(text(output.priorReasonCode))
    && Number.isFinite(Date.parse(text(output.resetAt)));
}

/**
 * Internal production-event hook. It never generates content or invokes a
 * provider. A correctly indexed, already reviewable project only wakes the
 * fixed Starter graph so its read-only adapters can verify the artifact.
 */
export async function notifyStarterContentArtifactReady(input: {
  dataStore: DataStore;
  tenantId: string;
  projectId: string;
  repository?: Starter198Repository;
  now?: () => Date;
}): Promise<StarterContentArtifactWakeupResult> {
  const initialProject = await readProject(input.dataStore, input.projectId);
  const initialLineage = indexedReviewableProject(initialProject, input.tenantId);
  if (!initialLineage) return ignored('project_not_indexed_or_reviewable');
  if (initialLineage.tenantId !== input.tenantId) return ignored('project_scope_mismatch');
  const repository = input.repository ?? createStarter198Repository(input.dataStore);
  const initialRun = await repository.get(
    STARTER_COLLECTIONS.runs,
    input.tenantId,
    initialLineage.runId,
  );
  if (!starter198RunInScope(initialRun, input.tenantId)) return ignored('run_not_starter_198');

  return withStarter198RunMutationLease({
    dataStore: input.dataStore,
    tenantId: input.tenantId,
    runId: initialLineage.runId,
    action: async () => {
      const project = await readProject(input.dataStore, input.projectId);
      const lineage = indexedReviewableProject(project, input.tenantId);
      if (!lineage || lineage.lineageHash !== initialLineage.lineageHash) {
        return ignored('project_changed_before_wakeup');
      }
      const run = await repository.get(STARTER_COLLECTIONS.runs, input.tenantId, lineage.runId);
      if (!starter198RunInScope(run, input.tenantId)) return ignored('run_not_starter_198');
      if (CLOSED_RUN_STATUSES.has(text(run.status))) return ignored(`run_${text(run.status) || 'closed'}`);

      const productionTask = await repository.get(
        STARTER_COLLECTIONS.tasks,
        input.tenantId,
        lineage.taskId,
      );
      if (!starterProductionTaskMatches({
        task: productionTask,
        tenantId: input.tenantId,
        runId: lineage.runId,
      })) return ignored('production_task_not_starter_198');
      const boundProductionTask = productionTask!;

      const qualityResult = await repository.list(STARTER_COLLECTIONS.tasks, input.tenantId, {
        where: { run_id: lineage.runId, task_key: QUALITY_TASK_KEY },
        perPage: 2,
      });
      if (qualityResult.totalItems !== 1 || qualityResult.items.length !== 1
        || !starterQualityTaskMatches({
          task: qualityResult.items[0] ?? null,
          tenantId: input.tenantId,
          runId: lineage.runId,
        })) {
        throw new StarterContentArtifactWakeupError('starter_content_wakeup_graph_integrity_violation');
      }
      const pendingApprovals = await listStarter198PendingApprovals({
        repository,
        tenantId: input.tenantId,
        run,
      });
      const now = (input.now?.() ?? new Date()).toISOString();
      const resetTaskIds: string[] = [];
      const alreadyResetTaskIds: string[] = [];
      let unrecoverableWaitFound = false;
      for (const task of [boundProductionTask, qualityResult.items[0]!]) {
        const priorReasonCode = recoverableWait(task, lineage.runId);
        if (!priorReasonCode) {
          if (text(task.status) === 'waiting_external') unrecoverableWaitFound = true;
          if (exactWakeMarker({
            task,
            runId: lineage.runId,
            projectId: project!.id,
            lineageHash: lineage.lineageHash,
          })) alreadyResetTaskIds.push(task.id);
          continue;
        }
        const output = wakeMarker({
          task,
          runId: lineage.runId,
          projectId: project!.id,
          lineageHash: lineage.lineageHash,
          priorReasonCode,
          resetAt: now,
        });
        await repository.update(STARTER_COLLECTIONS.tasks, input.tenantId, task.id, {
          status: 'pending',
          blocked_reason: '',
          output,
          updated_at: now,
        });
        const written = await repository.get(STARTER_COLLECTIONS.tasks, input.tenantId, task.id);
        if (!written || !exactWakeMarker({
          task: written,
          runId: lineage.runId,
          projectId: project!.id,
          lineageHash: lineage.lineageHash,
        })) throw new StarterContentArtifactWakeupError('starter_content_wakeup_task_write_lost');
        resetTaskIds.push(task.id);
      }
      const wakeEvidenceFound = resetTaskIds.length > 0 || alreadyResetTaskIds.length > 0;
      if (!wakeEvidenceFound) return ignored('no_recoverable_content_wait');
      const currentRun = await repository.get(STARTER_COLLECTIONS.runs, input.tenantId, run.id);
      const runResumed = !unrecoverableWaitFound
        && pendingApprovals.length === 0
        && starter198RunInScope(currentRun, input.tenantId)
        && text(currentRun.status) === 'waiting_external';
      if (runResumed) {
        await repository.update(STARTER_COLLECTIONS.runs, input.tenantId, run.id, {
          status: 'running',
          current_controller: 'agent',
          pause_reason: '',
          completed_at: '',
        });
        const writtenRun = await repository.get(STARTER_COLLECTIONS.runs, input.tenantId, run.id);
        if (!starter198RunInScope(writtenRun, input.tenantId) || text(writtenRun.status) !== 'running') {
          throw new StarterContentArtifactWakeupError('starter_content_wakeup_run_write_lost');
        }
      }
      return {
        state: 'ready',
        reason: resetTaskIds.length ? 'starter_content_tasks_woken' : 'starter_content_tasks_already_rearmed',
        resetTaskIds,
        runResumed,
      };
    },
  });
}

/**
 * Best-effort bridge used by the trusted producer only after project storage
 * has committed. The strict single-project hook above remains the retryable
 * event-consumer API. This batch bridge reports every deferred notification
 * instead of converting a completed content artifact into a failed production
 * result; a later producer tick or event redelivery can retry the same id.
 */
export async function notifyStarterReviewableContentProjects(input: {
  dataStore: DataStore;
  tenantId: string;
  projects: StarterRecord[];
}): Promise<StarterContentArtifactWakeupBatchResult> {
  const readyProjectIds: string[] = [];
  const ignoredProjectIds: string[] = [];
  const deferred: StarterContentArtifactWakeupBatchResult['deferred'] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    if (!managedContentProjectIsReviewable(project) || seen.has(project.id)) continue;
    seen.add(project.id);
    try {
      const result = await notifyStarterContentArtifactReady({
        dataStore: input.dataStore,
        tenantId: input.tenantId,
        projectId: project.id,
      });
      (result.state === 'ready' ? readyProjectIds : ignoredProjectIds).push(project.id);
    } catch (error) {
      const failure = deferredWakeup(error);
      deferred.push({ projectId: project.id, ...failure });
      console.warn('[starter-198-content-wakeup] deferred', {
        projectId: project.id,
        code: failure.code,
        retryable: failure.retryable,
      });
    }
  }
  return { readyProjectIds, ignoredProjectIds, deferred };
}
