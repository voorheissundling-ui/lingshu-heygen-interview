import { randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { acquireDurableOperationLease, releaseDurableOperationLease } from '../runtime/durableLease.js';
import { CONTENT_EXECUTION_JOB_COLLECTION, type ContentExecutionCheckpoints } from './context.js';
import { jobFromRow, requiredIdentity, type ContentExecutionJob, type JobRow } from './durableQueueRecords.js';

export async function bindPristineContentExecutionCheckpoint(input: {
  dataStore: DataStore;
  tenantId: string;
  jobId: string;
  runId: string;
  checkpointKey: string;
  checkpoint: ContentExecutionCheckpoints[string];
}): Promise<ContentExecutionJob> {
  return bindPristineContentExecutionCheckpoints({ ...input, checkpoints: { [input.checkpointKey]: input.checkpoint } });
}

/** Atomically binds a complete executor identity to a historical pristine job.
 * Multiple identity checkpoints must be written together so a crash cannot
 * leave a half-upgraded job that is neither safely legacy nor executable by
 * the selected graph. */
export async function bindPristineContentExecutionCheckpoints(input: {
  dataStore: DataStore;
  tenantId: string;
  jobId: string;
  runId: string;
  checkpoints: ContentExecutionCheckpoints;
}): Promise<ContentExecutionJob> {
  const tenantId = requiredIdentity(input.tenantId, 'tenant');
  const jobId = requiredIdentity(input.jobId, 'job');
  const runId = requiredIdentity(input.runId, 'run');
  const entries = Object.entries(input.checkpoints);
  if (!entries.length) throw new Error('content_execution_pristine_binding_required');
  for (const [key, checkpoint] of entries) {
    requiredIdentity(key, 'checkpoint');
    if (!checkpoint?.inputHash) throw new Error('content_execution_pristine_binding_invalid');
  }
  const lease = await acquireDurableOperationLease({ dataStore: input.dataStore, tenantId,
    subjectId: jobId, scope: 'content_execution_control', ownerId: `content-binding:${randomUUID()}`, leaseDurationMs: 30_000 });
  if (!lease) throw new Error('content_execution_job_control_busy');
  try {
    const row = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, jobId);
    if (!row) throw new Error('content_execution_job_not_found');
    const current = jobFromRow(row);
    if (current.tenantId !== tenantId || current.runId !== runId) throw new Error('content_execution_job_not_found');
    if (entries.every(([key, checkpoint]) => current.checkpoints[key]?.inputHash === checkpoint.inputHash)) return current;
    if (Object.keys(current.checkpoints).length || current.providerState !== 'none' || current.providerReceipts.length || current.completedAt)
      throw new Error('content_execution_pristine_binding_not_allowed');
    const updatedAt = new Date().toISOString();
    if (!await input.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, current.id, {
      checkpoints: input.checkpoints, updated_at: updatedAt,
    })) throw new Error('content_execution_pristine_binding_failed');
    const saved = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, current.id);
    if (!saved) throw new Error('content_execution_pristine_binding_readback_failed');
    const bound = jobFromRow(saved);
    if (entries.some(([key, checkpoint]) => bound.checkpoints[key]?.inputHash !== checkpoint.inputHash))
      throw new Error('content_execution_pristine_binding_readback_failed');
    return bound;
  } finally {
    await releaseDurableOperationLease({ dataStore: input.dataStore, lease }).catch(() => undefined);
  }
}

function zeroOrNull(value: unknown): boolean {
  return value === null || value === undefined || value === 0;
}

/** A failed graph node is removable only when its durable evidence proves that
 * it stopped before provider submission. Missing/partial evidence is treated as
 * unknown and therefore remains immutable. */
function isFailedPreProviderGraphNode(checkpoint: ContentExecutionCheckpoints[string]): boolean {
  const payload = checkpoint?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const row = payload as Record<string, unknown>;
  return row.status === 'failed'
    && row.outputSha256 === null
    && Array.isArray(row.providerReceiptRefs) && row.providerReceiptRefs.length === 0
    && zeroOrNull(row.reservedCny) && zeroOrNull(row.actualCostCny);
}

function removablePreProviderGraphKeys(checkpoints: ContentExecutionCheckpoints, checkpointKey: string): Set<string> | null {
  const extra = Object.keys(checkpoints).filter(key => key !== checkpointKey && key !== 'runtime.retry');
  if (!extra.length) return new Set();
  const nodeKeys = extra.filter(key => /^langgraph\.node\.(?:assets|render|quality|delivery)$/.test(key));
  if (!extra.includes('langgraph.v1') || nodeKeys.length === 0
    || extra.some(key => key !== 'langgraph.v1' && !nodeKeys.includes(key))
    || nodeKeys.some(key => !isFailedPreProviderGraphNode(checkpoints[key]!))) return null;
  const graph = checkpoints['langgraph.v1'];
  const document = graph?.payload as Record<string, unknown> | undefined;
  if (graph?.version !== 'langgraph-checkpoints.v1' || !document
    || document.format !== 'langgraph-checkpoints.v1' || typeof document.identityHash !== 'string'
    || !Array.isArray(document.checkpoints) || !document.writes || typeof document.writes !== 'object') return null;
  return new Set(extra);
}

/** Replace an executor binding after a pre-provider admission failure. Failed
 * graph attempts may also be discarded when every durable node proves that no
 * provider request, cost, or output exists. The retry marker is preserved. */
export async function refreshUnspentContentExecutionCheckpoint(input: {
  dataStore: DataStore; tenantId: string; jobId: string; runId: string;
  checkpointKey: string; checkpoint: ContentExecutionCheckpoints[string];
}): Promise<ContentExecutionJob> {
  const tenantId = requiredIdentity(input.tenantId, 'tenant'), jobId = requiredIdentity(input.jobId, 'job');
  const runId = requiredIdentity(input.runId, 'run'), checkpointKey = requiredIdentity(input.checkpointKey, 'checkpoint');
  const lease = await acquireDurableOperationLease({ dataStore: input.dataStore, tenantId, subjectId: jobId,
    scope: 'content_execution_control', ownerId: `content-binding-refresh:${randomUUID()}`, leaseDurationMs: 30_000 });
  if (!lease) throw new Error('content_execution_job_control_busy');
  try {
    const row = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, jobId);
    if (!row) throw new Error('content_execution_job_not_found');
    const current = jobFromRow(row);
    if (current.tenantId !== tenantId || current.runId !== runId) throw new Error('content_execution_job_not_found');
    const removable = removablePreProviderGraphKeys(current.checkpoints, checkpointKey);
    if (current.status !== 'blocked' || current.providerState !== 'none' || current.providerReceipts.length || current.completedAt
      || removable === null)
      throw new Error('content_execution_unspent_binding_refresh_not_allowed');
    const checkpoints = Object.fromEntries(Object.entries(current.checkpoints).filter(([key]) => !removable.has(key)));
    checkpoints[checkpointKey] = input.checkpoint;
    if (!await input.dataStore.update(CONTENT_EXECUTION_JOB_COLLECTION, current.id, { checkpoints, updated_at: new Date().toISOString() }))
      throw new Error('content_execution_unspent_binding_refresh_failed');
    const saved = await input.dataStore.getById<JobRow>(CONTENT_EXECUTION_JOB_COLLECTION, current.id);
    if (!saved) throw new Error('content_execution_unspent_binding_refresh_readback_failed');
    const refreshed = jobFromRow(saved);
    if (refreshed.checkpoints[checkpointKey]?.inputHash !== input.checkpoint.inputHash)
      throw new Error('content_execution_unspent_binding_refresh_readback_failed');
    return refreshed;
  } finally { await releaseDurableOperationLease({ dataStore: input.dataStore, lease }).catch(() => undefined); }
}
