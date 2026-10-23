import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { CONTENT_EXECUTION_JOB_COLLECTION } from './context.js';

export const LEGACY_CONTENT_GRAPH_VERSION = 'content-production.v1';
export const CONTENT_GRAPH_VERSION = 'content-production.v2';
export const SUPPORTED_CONTENT_GRAPH_VERSIONS = [LEGACY_CONTENT_GRAPH_VERSION, CONTENT_GRAPH_VERSION] as const;
export type ContentGraphVersion = typeof SUPPORTED_CONTENT_GRAPH_VERSIONS[number];
export interface ProductionGraphIdentity {
  tenantId: string;
  taskId: string;
  runId: string;
  jobId: string;
  planVersion: string;
  inputHash: string;
  graphVersion: ContentGraphVersion;
}
export function graphIdentityHash(identity: ProductionGraphIdentity): string {
  for (const value of [identity.tenantId, identity.taskId, identity.runId, identity.jobId, identity.planVersion, identity.inputHash, identity.graphVersion]) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 240) {
      throw new Error('content_graph_identity_invalid');
    }
  }
  if (!SUPPORTED_CONTENT_GRAPH_VERSIONS.includes(identity.graphVersion)) throw new Error('content_graph_version_unsupported');
  return createHash('sha256').update(JSON.stringify([
    identity.tenantId, identity.taskId, identity.runId, identity.jobId,
    identity.planVersion, identity.inputHash, identity.graphVersion,
  ])).digest('hex');
}
export function graphThreadId(identity: ProductionGraphIdentity): string {
  return `content:${graphIdentityHash(identity)}`;
}
/** Identity is supplied by the authenticated runner, not by a checkpoint client. */
export async function assertGraphJobScope(dataStore: DataStore, identity: ProductionGraphIdentity): Promise<Record<string, unknown>> {
  graphIdentityHash(identity);
  const job = await dataStore.getById<Record<string, unknown>>(CONTENT_EXECUTION_JOB_COLLECTION, identity.jobId);
  if (!job || job.id !== identity.jobId || job.tenant_id !== identity.tenantId
    || job.run_id !== identity.runId || job.task_id !== identity.taskId) {
    throw new Error('content_graph_job_scope_mismatch');
  }
  return job;
}
