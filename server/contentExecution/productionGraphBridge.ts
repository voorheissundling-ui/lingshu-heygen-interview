import type { DataStore } from '../storage/datastore.js';
import type { ContentExecutionCheckpoint, ContentExecutionCheckpoints } from './context.js';
import { admitContentExecutionJob, type ContentExecutionJob } from './durableQueue.js';
import { CONTENT_GRAPH_VERSION, SUPPORTED_CONTENT_GRAPH_VERSIONS, graphIdentityHash, type ContentGraphVersion, type ProductionGraphIdentity } from './langgraphIdentity.js';

export const PRODUCTION_GRAPH_BRIDGE_CHECKPOINT = 'content.production_bridge';
export const PRODUCTION_GRAPH_BRIDGE_VERSION = '1';

export interface ProductionGraphBridgeBinding {
  schemaVersion: 'content-production-bridge.v1';
  planVersion: string;
  inputHash: string;
  graphVersion: ContentGraphVersion;
  approvalAuthority: 'canonical_business_receipt';
  completionAuthority: 'terminal_graph_and_delivery_receipt';
}

function required(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 240) throw new Error(code);
  return value;
}

export function createProductionGraphBridgeCheckpoint(input: {
  planVersion: string;
  inputHash: string;
  now?: Date;
}): ContentExecutionCheckpoint<ProductionGraphBridgeBinding> {
  const planVersion = required(input.planVersion, 'content_production_bridge_plan_version_invalid');
  const inputHash = required(input.inputHash, 'content_production_bridge_input_hash_invalid');
  if (!/^[a-f0-9]{64}$/.test(inputHash)) throw new Error('content_production_bridge_input_hash_invalid');
  return {
    version: PRODUCTION_GRAPH_BRIDGE_VERSION,
    inputHash,
    updatedAt: (input.now ?? new Date()).toISOString(),
    payload: {
      schemaVersion: 'content-production-bridge.v1', planVersion, inputHash,
      graphVersion: CONTENT_GRAPH_VERSION,
      approvalAuthority: 'canonical_business_receipt',
      completionAuthority: 'terminal_graph_and_delivery_receipt',
    },
  };
}

export function productionGraphIdentityFromJob(job: ContentExecutionJob): ProductionGraphIdentity {
  const checkpoint = job.checkpoints[PRODUCTION_GRAPH_BRIDGE_CHECKPOINT];
  const binding = checkpoint?.payload as Partial<ProductionGraphBridgeBinding> | undefined;
  if (!checkpoint || checkpoint.version !== PRODUCTION_GRAPH_BRIDGE_VERSION
    || binding?.schemaVersion !== 'content-production-bridge.v1'
    || checkpoint.inputHash !== binding.inputHash
    || !SUPPORTED_CONTENT_GRAPH_VERSIONS.includes(binding.graphVersion as ContentGraphVersion)
    || binding.approvalAuthority !== 'canonical_business_receipt'
    || binding.completionAuthority !== 'terminal_graph_and_delivery_receipt') {
    throw new Error('content_production_bridge_binding_invalid');
  }
  const identity = {
    tenantId: job.tenantId, taskId: job.taskId, runId: job.runId, jobId: job.id,
    planVersion: required(binding.planVersion, 'content_production_bridge_plan_version_invalid'),
    inputHash: required(binding.inputHash, 'content_production_bridge_input_hash_invalid'),
    graphVersion: binding.graphVersion as ContentGraphVersion,
  };
  graphIdentityHash(identity);
  return identity;
}

/** One admission boundary for weekly/manual production. The durable job key owns
 * idempotency; the frozen plan binding makes a replay with changed inputs fail. */
export async function admitProductionGraphJob(input: {
  dataStore: DataStore;
  tenantId: string;
  userId: string;
  taskId: string;
  runId: string;
  accountId?: string | null;
  taskType: string;
  planVersion: string;
  inputHash: string;
  initialCheckpoints?: ContentExecutionCheckpoints;
  now?: Date;
}): Promise<ContentExecutionJob> {
  const bridge = createProductionGraphBridgeCheckpoint(input);
  const job = await admitContentExecutionJob({ ...input, initialCheckpoints: {
    ...(input.initialCheckpoints ?? {}), [PRODUCTION_GRAPH_BRIDGE_CHECKPOINT]: bridge,
  } });
  const identity = productionGraphIdentityFromJob(job);
  if (identity.planVersion !== input.planVersion || identity.inputHash !== input.inputHash) {
    throw new Error('content_production_bridge_replay_changed');
  }
  return job;
}

/** Completion projection may run only after the durable lease has settled the
 * job and a graph-produced receipt proves the same frozen identity. Business
 * approval remains external and is subsequently reloaded by the domain port. */
export function assertProductionGraphCompletionBoundary(job: ContentExecutionJob, completionIdentity?: {
  planVersion: string; inputHash: string;
}): ProductionGraphIdentity {
  const admitted = productionGraphIdentityFromJob(job);
  const identity = completionIdentity ? { ...admitted,
    planVersion: required(completionIdentity.planVersion, 'content_production_bridge_plan_version_invalid'),
    inputHash: required(completionIdentity.inputHash, 'content_production_bridge_input_hash_invalid'),
  } : admitted;
  graphIdentityHash(identity);
  if (job.status !== 'succeeded' || job.workerId || job.leaseExpiresAt) {
    throw new Error('content_production_bridge_job_not_settled');
  }
  const completion = job.checkpoints['social.graph_completion'];
  const receipt = completion?.payload as Record<string, unknown> | undefined;
  if (!completion || completion.version !== '1' || completion.inputHash !== identity.inputHash
    || receipt?.tenantId !== identity.tenantId || receipt.taskId !== identity.taskId
    || receipt.runId !== identity.runId || receipt.jobId !== identity.jobId
    || receipt.planVersion !== identity.planVersion || receipt.inputHash !== identity.inputHash
    || receipt.graphVersion !== identity.graphVersion || !receipt.approval) {
    throw new Error('content_production_bridge_completion_invalid');
  }
  return identity;
}
