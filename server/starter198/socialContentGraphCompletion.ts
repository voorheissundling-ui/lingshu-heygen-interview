import {SocialContentTaskBudget} from '../lib/socialContentTaskBudget.js';
import {readGraphContextSnapshot} from './socialContentGraphContextSnapshots.js';
import {matchesAuthorizedCorrectionContext, socialContentCorrectionRuntimeHash} from './socialContentProductionGraph.js';
import type { ContentExecutionJob } from '../contentExecution/durableQueue.js';
import { readContentExecutionJob } from '../contentExecution/durableQueue.js';
import { graphIdentityHash, graphThreadId, LEGACY_CONTENT_GRAPH_VERSION, SUPPORTED_CONTENT_GRAPH_VERSIONS, type ContentGraphVersion } from '../contentExecution/langgraphIdentity.js';
import { ContentJobCheckpointSaver, createJobGraphCheckpointPort } from '../contentExecution/langgraphCheckpoint.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { loadSocialProductionGraphApproval } from './socialContentProductionGraph.js';
import { socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';
import { withStarter198RunMutationLease } from './runMutationLease.js';
import { writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import { assertProductionGraphCompletionBoundary, PRODUCTION_GRAPH_BRIDGE_CHECKPOINT } from '../contentExecution/productionGraphBridge.js';

/** A graph terminal checkpoint does not replace business completion evidence.
 * Project only after the durable worker settles success; this function is safe
 * to replay when a process dies between queue settlement and UI projection. */
export async function completeSocialContentGraphRun(repository: Starter198Repository, claimed: ContentExecutionJob): Promise<boolean> {
  if (!repository.dataStore) throw new Error('content_graph_completion_store_required');
  const job = await readContentExecutionJob(repository.dataStore, claimed.tenantId, claimed.taskId, claimed.runId);
  if (!job || job.id !== claimed.id || job.status !== 'succeeded') return false;
  const checkpoint = job.checkpoints['social.graph_completion'];
  const receipt = socialObject(checkpoint?.payload);
  const binding = socialObject(job.checkpoints['social.executor']?.payload);
  const correctedContext=readGraphContextSnapshot(socialObject(job.checkpoints['social.corrected_executor']?.payload));
  const ledger=new SocialContentTaskBudget(undefined,{authorization:async()=>{throw Error('read_only')},quote:async()=>{throw Error('read_only')},assertCurrent:async()=>{},verifyRejection:async()=>false});
  const grant=binding?.inputHash?ledger.status({tenantId:job.tenantId,taskId:job.taskId,runId:job.runId,planHash:String(binding.inputHash)})?.correctionAuthorization:null;
  const correctionHash=grant?socialContentCorrectionRuntimeHash(grant.recordHash):null;
  const correctedPayload=socialObject(job.checkpoints['social.corrected_executor']?.payload);
  const validCorrection=!!receipt&&!!correctedContext&&!!grant&&matchesAuthorizedCorrectionContext(job,correctedContext,String(binding?.inputHash),grant.recordHash)&&receipt.correctionHash===grant.recordHash&&receipt.correctionRuntimeHash===correctionHash&&receipt.financialPlanHash===binding?.inputHash;
  const expectedInputHash=validCorrection?socialRequestHash({originalInputHash:correctedPayload?.graphInputHash,correctionHash}):binding?.inputHash;
  const expectedPlanVersion=validCorrection?String(correctedContext!.agentWorkflow!.executionPlan.version):binding?.planVersion;
  const expectedGraphVersion = (SUPPORTED_CONTENT_GRAPH_VERSIONS.includes(binding?.graphVersion as ContentGraphVersion)
    ? binding?.graphVersion : LEGACY_CONTENT_GRAPH_VERSION) as ContentGraphVersion;
  // Historical graph jobs predate the bridge checkpoint and retain their
  // existing detailed terminal validation below. Every newly admitted graph
  // job must additionally cross the unified queue/identity boundary.
  if (job.checkpoints[PRODUCTION_GRAPH_BRIDGE_CHECKPOINT]) assertProductionGraphCompletionBoundary(
    job, { planVersion: String(expectedPlanVersion), inputHash: String(expectedInputHash) },
  );
  if (!receipt || checkpoint?.version !== '1' || binding?.executor !== 'langgraph'
    || checkpoint.inputHash !== expectedInputHash || receipt.inputHash !== expectedInputHash
    || receipt.planVersion !== expectedPlanVersion || receipt.graphVersion !== expectedGraphVersion
    || receipt.tenantId !== job.tenantId || receipt.taskId !== job.taskId || receipt.runId !== job.runId || receipt.jobId !== job.id) {
    throw new Error('content_graph_completion_receipt_invalid');
  }
  const identity = { tenantId: job.tenantId, taskId: job.taskId, runId: job.runId, jobId: job.id,
    planVersion: String(receipt.planVersion), inputHash: String(receipt.inputHash), graphVersion: expectedGraphVersion };
  graphIdentityHash(identity);
  const saver = new ContentJobCheckpointSaver(identity, createJobGraphCheckpointPort({
    dataStore: repository.dataStore, identity,...(validCorrection?{correctionHash:correctionHash!}:{}), assertActive: async () => undefined,
  }));
  const terminal = await saver.getTuple({ configurable: { thread_id: graphThreadId(identity) } });
  const state = terminal?.checkpoint.channel_values;
  if (state?.completed !== true || socialRequestHash(state.identity) !== socialRequestHash(identity)
    || socialRequestHash(state.approval) !== socialRequestHash(receipt.approval)) throw new Error('content_graph_completion_not_terminal');
  const accepted = await loadSocialProductionGraphApproval(repository, job);
  if (!accepted || socialRequestHash(accepted) !== socialRequestHash(receipt.approval)) throw new Error('content_graph_completion_approval_changed');
  const artifactIds = receipt.artifactIds, packageIds = receipt.packageIds;
  if (!Array.isArray(artifactIds) || artifactIds.length !== 1 || !artifactIds.every(id => typeof id === 'string' && id)
    || !Array.isArray(packageIds) || packageIds.length !== 1 || !packageIds.every(id => typeof id === 'string' && id)) {
    throw new Error('content_graph_completion_delivery_invalid');
  }
  const graphDelivery = socialObject(socialObject(state.evidence)?.delivery);
  if (socialRequestHash(graphDelivery?.artifactRefs) !== socialRequestHash([...artifactIds, ...packageIds])) throw new Error('content_graph_completion_delivery_invalid');
  const packages = await repository.list(STARTER_COLLECTIONS.socialDeliveryPackages, job.tenantId,
    { where: { task_id: job.taskId, package_id: String(packageIds[0]) }, perPage: 2 });
  const prepared = packages.items[0];
  const manifest = socialObject(socialJson(prepared?.manifest));
  const storedArtifactIds = socialJson(prepared?.artifact_ids);
  if (packages.totalItems !== 1 || !prepared || !['ready', 'confirmed'].includes(socialText(prepared.status))
    || !manifest || manifest.taskId !== job.taskId || manifest.packageId !== packageIds[0]
    || prepared.package_hash !== socialRequestHash(manifest)
    || socialRequestHash(storedArtifactIds) !== socialRequestHash(artifactIds)) throw new Error('content_graph_completion_delivery_invalid');
  return withStarter198RunMutationLease({ tenantId: job.tenantId, runId: job.runId, dataStore: repository.dataStore, action: async () => {
    const run = await repository.get(STARTER_COLLECTIONS.runs, job.tenantId, job.runId);
    if (!run) throw new Error('content_graph_completion_run_missing');
    if (['paused', 'pausing', 'cancelling', 'cancelled', 'failed', 'dead_letter'].includes(socialText(run.status))) return false;
    if (['completed', 'succeeded'].includes(socialText(run.status))) return true;
    await writeExecutionStage({ repository, tenantId: job.tenantId, runId: job.runId, stage: 'delivery_prepared', status: 'completed',
      message: '成片已通过人工审核，交付包已准备完成。', extra: { artifactIds, packageIds, externalPublishPerformed: false } });
    await repository.update(STARTER_COLLECTIONS.runs, job.tenantId, run.id, { status: 'completed', current_controller: 'system',
      pause_reason: '', completed_at: new Date().toISOString() });
    return true;
  } });
}

export async function recoverSocialContentGraphCompletions(repository: Starter198Repository): Promise<void> {
  const dataStore = repository.dataStore;
  if (!dataStore) return;
  for (let page = 1; page <= 100; page++) {
    const rows = await dataStore.list<Record<string, unknown>>('content_execution_jobs',
      { where: { status: 'succeeded' }, page, perPage: 100, sort: 'id' });
    for (const row of rows.items) {
      if (!socialObject(socialObject(socialJson(row.checkpoints))?.['social.graph_completion'])) continue;
      const run = await dataStore.getById<Record<string, unknown>>(STARTER_COLLECTIONS.runs, socialText(row.run_id));
      if (!run || run.tenant_id !== row.tenant_id || ['completed', 'succeeded', 'cancelled', 'failed'].includes(socialText(run.status))) continue;
      try {
        const job = await readContentExecutionJob(dataStore, socialText(row.tenant_id), socialText(row.task_id), socialText(row.run_id));
        if (job && job.id === row.id) await completeSocialContentGraphRun(repository, job);
      } catch {
        console.warn('[content-execution] graph completion still requires evidence reconciliation');
      }
    }
    if (page >= rows.totalPages || !rows.items.length) break;
  }
}
