import { Annotation, StateGraph, START, END, interrupt, Command } from '@langchain/langgraph';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AsyncLocalStorageProviderSingleton } from 'langsmith/singletons/traceable';
import { withRunTree } from 'langsmith/traceable';
import { RunTree } from 'langsmith/run_trees';
import { LocalOnlyContentGraphCallbacks } from './langgraphTracing.js';
import { createHash } from 'node:crypto';
import {
  assertCurrentContentExecutionJobContext,
  currentContentProviderReceipts,
  readCurrentContentExecutionCheckpoint,
  recordCurrentContentExecutionCheckpoint,
} from './context.js';
import type { DataStore } from '../storage/datastore.js';
import { ContentJobCheckpointSaver, createJobGraphCheckpointPort, type ContentGraphCheckpointPort } from './langgraphCheckpoint.js';
import { assertGraphJobScope, graphIdentityHash, graphThreadId, LEGACY_CONTENT_GRAPH_VERSION, type ProductionGraphIdentity } from './langgraphIdentity.js';
import {
  assertVideoProductionSupervisorDefinition,
  type VideoProductionGraphPhase,
} from '../../shared/contracts/videoProductionSupervisor.js';

export interface PhaseEvidence {
  artifactRefs: string[];
  inputHash: string;
  metadata?: Record<string, unknown>;
}
export type ProductionGraphNodeEvidence = {
  node: ProductionGraphPhase;
  nodeVersion: string;
  graphVersion: string;
  planVersion: string;
  inputHash: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'running' | 'completed' | 'failed';
  attempt: number;
  failureCode: string | null;
  failureReason: string | null;
  outputSha256: string | null;
  providerReceiptRefs: string[];
  reservedCny: number | null;
  actualCostCny: number | null;
};
const NODE_EVIDENCE_VERSION = '1';
export interface GraphApproval {
  approved: boolean;
  receiptRef: string;
  subjectVersion: string;
  contentHash: string;
}
export type ProductionGraphPhase = VideoProductionGraphPhase;
const GraphState = Annotation.Root({
  identity: Annotation<ProductionGraphIdentity>(),
  evidence: Annotation<Partial<Record<ProductionGraphPhase, PhaseEvidence>>>({ reducer: (prior,next) => ({...prior,...next}), default: () => ({}) }),
  approval: Annotation<GraphApproval | null>({ reducer: (_prior,next) => next, default: () => null }),
  completed: Annotation<boolean>({ reducer: (_prior,next)=>next, default:()=>false }),
});
export type ProductionGraphState = typeof GraphState.State;
export interface LangGraphProductionInput {
  identity: ProductionGraphIdentity;
  dataStore: DataStore;
  /** The durable worker must verify its current attempt/owner/lease before new work. */
  assertActive: () => Promise<void>;
  phases: Partial<Record<ProductionGraphPhase, (state: ProductionGraphState) => Promise<PhaseEvidence>>>;
  review: {
    /** Must reload canonical business approval with tenant, artifact hash and version checks. */
    loadApproval: (state: ProductionGraphState) => Promise<GraphApproval | null>;
    /** A client-supplied boolean cannot resume. This callback validates stored receipt authority. */
    verifyResume: (resume: unknown, identity: ProductionGraphIdentity) => Promise<boolean>;
  };
  resume?: unknown;
  /** Server-owned correction authorization hash; preserves the original graph history. */
  correctionHash?: string;
  /** Isolated tests may supply an independent durable port; production uses job context. */
  checkpointPort?: ContentGraphCheckpointPort;
}
export interface LangGraphProductionResult {
  status: 'waiting_review' | 'completed';
  state: ProductionGraphState;
  interrupts: unknown[];
}
function evidence(value: PhaseEvidence): PhaseEvidence {
  if (!value || !Array.isArray(value.artifactRefs) || value.artifactRefs.length > 100
    || value.artifactRefs.some(ref => typeof ref !== 'string' || !ref || ref.length > 512 || /^(?:\/|[a-z]:\\)/i.test(ref))
    || typeof value.inputHash !== 'string' || !value.inputHash || value.inputHash.length > 240) {
    throw new Error('content_graph_phase_evidence_invalid');
  }
  // Only compact business projections enter graph state; full provider results,
  // prompts, credentials and filesystem paths remain in their existing stores.
  const allowedMetadata = new Set(['contentHash','checkpointStage','approvalReceipt','externalPublishPerformed',
    'artifactId','packageId','sceneCount','durationSeconds','qualityPassed','outputSha256','providerReceiptRefs',
    'reservedCny','actualCostCny']);
  if (value.metadata && Object.entries(value.metadata).some(([key,item]) => !allowedMetadata.has(key)
    || key === 'outputSha256' && (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item))
    || ['reservedCny','actualCostCny'].includes(key) && (typeof item !== 'number' || !Number.isFinite(item) || item < 0)
    || !(typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)
      || typeof item === 'string' && item.length <= 512 && !/^(?:\/|[a-z]:\\)/i.test(item)
      || key === 'providerReceiptRefs' && Array.isArray(item) && item.length <= 100
        && item.every(ref=>typeof ref === 'string' && ref.length <= 512 && !ref.startsWith('/'))))) {
    throw new Error('content_graph_phase_metadata_invalid');
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 32_768) throw new Error('content_graph_phase_evidence_too_large');
  return JSON.parse(serialized) as PhaseEvidence;
}
/** Actual graph nodes call separately recoverable stages; no provider retry loop is added here. */
export async function runLangGraphProduction(input: LangGraphProductionInput): Promise<LangGraphProductionResult> {
  const identityHash = graphIdentityHash(input.identity);
  if(input.correctionHash && !/^[a-f0-9]{64}$/.test(input.correctionHash)) throw Error('content_graph_correction_identity_invalid');
  if (!input.checkpointPort) await assertCurrentContentExecutionJobContext(input.identity.jobId);
  await assertGraphJobScope(input.dataStore, input.identity);
  await input.assertActive();
  const checkpointer = new ContentJobCheckpointSaver(input.identity, input.checkpointPort ?? createJobGraphCheckpointPort(input));
  const active = async (state: ProductionGraphState) => {
    if (graphIdentityHash(state.identity) !== identityHash) throw new Error('content_graph_state_identity_changed');
    await assertGraphJobScope(input.dataStore, input.identity);
    await input.assertActive();
  };
  const phase = (name: ProductionGraphPhase) => async (state: ProductionGraphState) => {
    await active(state);
    const nodeInputHash = createHash('sha256').update(`${identityHash}\0${name}`).digest('hex');
    const stage = input.correctionHash?`lg.fix.${input.correctionHash}.${name}`:`langgraph.node.${name}`;
    const previous = readCurrentContentExecutionCheckpoint<ProductionGraphNodeEvidence>({
      stage, version: NODE_EVIDENCE_VERSION, inputHash: nodeInputHash,
    });
    const attempt = Math.max(0, Number(previous?.attempt) || 0) + 1;
    const startedAt = new Date().toISOString();
    const receiptEvidence = () => {
      const receipts = currentContentProviderReceipts();
      const amount = (key: 'reservedCny' | 'actualCostCny') => {
        const values = receipts.map(row => Number(row.metadata[key])).filter(value => Number.isFinite(value) && value >= 0);
        return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
      };
      return {
        providerReceiptRefs: receipts.map(row => `${row.provider}:${row.requestId}`).sort(),
        reservedCny: amount('reservedCny'), actualCostCny: amount('actualCostCny'),
      };
    };
    const base = (): ProductionGraphNodeEvidence => ({
      node: name, nodeVersion: NODE_EVIDENCE_VERSION, graphVersion: input.identity.graphVersion,
      planVersion: input.identity.planVersion, inputHash: input.identity.inputHash,
      startedAt, endedAt: null, durationMs: null, status: 'running', attempt,
      failureCode: null, failureReason: null, outputSha256: null, ...receiptEvidence(),
    });
    await recordCurrentContentExecutionCheckpoint({ stage, version: NODE_EVIDENCE_VERSION,
      inputHash: nodeInputHash, payload: base() });
    try {
      const handler = input.phases[name];
      if (!handler) throw new Error(`content_graph_phase_handler_missing:${name}`);
      const result = evidence(await handler(state));
      await active(state);
      const endedAt = new Date().toISOString();
      const completed: ProductionGraphNodeEvidence = {
        ...base(), ...receiptEvidence(), endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)), status: 'completed',
        outputSha256: typeof result.metadata?.outputSha256 === 'string' ? result.metadata.outputSha256 : null,
        providerReceiptRefs: Array.isArray(result.metadata?.providerReceiptRefs)
          ? [...new Set([...receiptEvidence().providerReceiptRefs, ...result.metadata.providerReceiptRefs as string[]])].sort()
          : receiptEvidence().providerReceiptRefs,
        reservedCny: typeof result.metadata?.reservedCny === 'number' ? result.metadata.reservedCny : receiptEvidence().reservedCny,
        actualCostCny: typeof result.metadata?.actualCostCny === 'number' ? result.metadata.actualCostCny : receiptEvidence().actualCostCny,
      };
      await recordCurrentContentExecutionCheckpoint({ stage, version: NODE_EVIDENCE_VERSION,
        inputHash: nodeInputHash, payload: completed });
      return { evidence: { [name]: result }, ...(name === 'delivery' ? { completed: true } : {}) };
    } catch (error) {
      const endedAt = new Date().toISOString();
      const reason = String(error instanceof Error ? error.message : error || 'content_graph_node_failed').slice(0, 2000);
      const explicitCode = error && typeof error === 'object' && typeof (error as {code?:unknown}).code === 'string'
        ? String((error as {code:string}).code) : reason.split(':', 1)[0] || '';
      const failureCode = explicitCode.trim().slice(0, 120).replace(/[^a-zA-Z0-9_.-]+/g, '_') || 'content_graph_node_failed';
      await recordCurrentContentExecutionCheckpoint({ stage, version: NODE_EVIDENCE_VERSION,
        inputHash: nodeInputHash, payload: { ...base(), ...receiptEvidence(), endedAt,
          durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)), status: 'failed',
          failureCode, failureReason: reason } satisfies ProductionGraphNodeEvidence });
      throw error;
    }
  };
  // withRunTree uses a no-op ALS until LangSmith is initialized. Initialize its
  // public singleton with a real Node ALS so tracing=false reaches core callbacks.
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage<ReturnType<Parameters<typeof AsyncLocalStorageProviderSingleton.initializeGlobalInstance>[0]['getStore']>>());
  // Explicitly scoped tracing=false overrides LANGSMITH_TRACING and any inherited
  // tracer without mutating process-wide environment or exposing business state.
  return withRunTree(new RunTree({ name: 'content-production-local', tracingEnabled: false }), async (): Promise<LangGraphProductionResult> => {
    const reviewNode = async (state: ProductionGraphState) => {
      await active(state);
      let receipt = await input.review.loadApproval(state);
      if (!receipt?.approved) {
        interrupt({ kind: 'content_review', tenantId: input.identity.tenantId, taskId: input.identity.taskId,
          runId: input.identity.runId, planVersion: input.identity.planVersion, inputHash: input.identity.inputHash,
          artifacts: state.evidence.creative_quality?.artifactRefs ?? state.evidence.quality?.artifactRefs ?? [] });
        // interrupt resumes by restarting this node. Always read authority again;
        // the resume payload is never used as an approval or a business result.
        receipt = await input.review.loadApproval(state);
      }
      if (!receipt?.approved || !receipt.receiptRef || !receipt.contentHash || !receipt.subjectVersion) {
        throw new Error('content_graph_review_receipt_required');
      }
      return { approval: receipt };
    };
    const deliveryNode = async (state: ProductionGraphState) => {
      await active(state);
      const receipt = await input.review.loadApproval(state);
      if (!receipt?.approved || receipt.receiptRef !== state.approval?.receiptRef
        || receipt.subjectVersion !== state.approval.subjectVersion || receipt.contentHash !== state.approval.contentHash) {
        throw new Error('content_graph_review_changed');
      }
      return phase('delivery')(state);
    };
    const graph: any = input.identity.graphVersion === LEGACY_CONTENT_GRAPH_VERSION
      ? new StateGraph(GraphState)
        .addNode('assets',phase('assets')).addNode('render',phase('render')).addNode('quality',phase('quality'))
        .addNode('review',reviewNode).addNode('delivery',deliveryNode)
        .addEdge(START,'assets').addEdge('assets','render').addEdge('render','quality').addEdge('quality','review')
        .addEdge('review','delivery').addEdge('delivery',END).compile({checkpointer})
      : (() => {
        assertVideoProductionSupervisorDefinition();
        return new StateGraph(GraphState)
          .addNode('assets',phase('assets')).addNode('voice',phase('voice')).addNode('trim',phase('trim'))
          .addNode('effects',phase('effects')).addNode('render',phase('render'))
          .addNode('technical_quality',phase('technical_quality')).addNode('creative_quality',phase('creative_quality'))
          .addNode('review',reviewNode).addNode('delivery',deliveryNode)
          .addEdge(START,'assets').addEdge('assets','voice').addEdge('voice','trim').addEdge('trim','effects')
          .addEdge('effects','render').addEdge('render','technical_quality').addEdge('technical_quality','creative_quality')
          .addEdge('creative_quality','review').addEdge('review','delivery').addEdge('delivery',END).compile({checkpointer});
      })();
    const config = { configurable: { thread_id: graphThreadId(input.identity) }, callbacks: [new LocalOnlyContentGraphCallbacks()], recursionLimit: 32, durability: 'sync' as const };
    const previous = await checkpointer.getTuple(config);
    if (previous) {
      const restored = await graph.getState(config);
      if (restored.values.identity && graphIdentityHash(restored.values.identity as ProductionGraphIdentity) !== identityHash) {
        throw new Error('content_graph_restored_identity_changed');
      }
    }
    const priorSnapshot = previous ? await graph.getState(config) : null;
    if (input.resume !== undefined && (!previous || !await input.review.verifyResume(input.resume, input.identity))) {
      throw new Error('content_graph_resume_not_authorized');
    }
    if (priorSnapshot?.values.completed && !priorSnapshot.next.length) {
      const restored = priorSnapshot.values as ProductionGraphState;
      const receipt = await input.review.loadApproval(restored);
      if (!receipt?.approved || receipt.receiptRef !== restored.approval?.receiptRef || receipt.contentHash !== restored.approval.contentHash
        || receipt.subjectVersion !== restored.approval.subjectVersion) throw new Error('content_graph_review_changed');
      return {status:'completed',state:restored,interrupts:[]};
    }
    const resumeInterrupt = input.resume !== undefined && priorSnapshot?.tasks.some((task: {interrupts?: unknown[]})=>task.interrupts?.length);
    await graph.invoke(resumeInterrupt ? new Command({resume: input.resume})
      : previous ? null : { identity: input.identity, evidence: {}, approval: null, completed: false }, config);
    const snapshot = await graph.getState(config);
    const state = snapshot.values as ProductionGraphState;
    const interrupts = snapshot.tasks.flatMap((task: {interrupts?: unknown[]}) => task.interrupts ?? []);
    if (snapshot.next.length || interrupts.length || !state.completed) return {status:'waiting_review',state,interrupts};
    return {status:'completed',state,interrupts:[]};
  });
}
