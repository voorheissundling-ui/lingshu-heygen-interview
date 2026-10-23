import { createHash } from 'node:crypto';

export const VIDEO_PRODUCTION_GRAPH_SCHEMA = 'video-production-graph.v1' as const;

export const VIDEO_PRODUCTION_NODES = [
  'brief',
  'material_index',
  'material_match',
  'trim',
  'voice',
  'effects',
  'render',
  'quality',
  'approval',
] as const;

export type VideoProductionNodeId = typeof VIDEO_PRODUCTION_NODES[number];
export type VideoProductionNodeStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'skipped';
export type VideoProductionRuntimeOrigin = 'starter198' | 'digital_employee';

export interface VideoProductionGraphNode {
  nodeId: VideoProductionNodeId;
  status: VideoProductionNodeStatus;
  updatedAt: string | null;
  evidenceRefs: string[];
  blocker: string | null;
}

export interface VideoProductionGraphV1 {
  schemaVersion: typeof VIDEO_PRODUCTION_GRAPH_SCHEMA;
  graphId: string;
  runtimeOrigin: VideoProductionRuntimeOrigin;
  activeNode: VideoProductionNodeId;
  nodes: VideoProductionGraphNode[];
  updatedAt: string;
  lineageHash: string;
}

const text = (value: unknown, maximum = 240): string => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function withoutHash(graph: VideoProductionGraphV1): Omit<VideoProductionGraphV1, 'lineageHash'> {
  const { lineageHash: _lineageHash, ...payload } = graph;
  return payload;
}

function withHash(graph: Omit<VideoProductionGraphV1, 'lineageHash'>): VideoProductionGraphV1 {
  return { ...graph, lineageHash: hash(graph) };
}

export function assertVideoProductionGraph(graph: VideoProductionGraphV1): void {
  if (graph.schemaVersion !== VIDEO_PRODUCTION_GRAPH_SCHEMA
    || !text(graph.graphId)
    || graph.nodes.length !== VIDEO_PRODUCTION_NODES.length
    || graph.nodes.some((node, index) => node.nodeId !== VIDEO_PRODUCTION_NODES[index])
    || hash(withoutHash(graph)) !== graph.lineageHash) {
    throw new Error('video_production_graph_invalid');
  }
}

export function parseVideoProductionGraph(value: unknown): VideoProductionGraphV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const graph = value as VideoProductionGraphV1;
    assertVideoProductionGraph(graph);
    return graph;
  } catch {
    return null;
  }
}

export function createVideoProductionGraph(input: {
  graphId: string;
  runtimeOrigin: VideoProductionRuntimeOrigin;
  now?: string;
}): VideoProductionGraphV1 {
  const updatedAt = new Date(input.now ?? Date.now()).toISOString();
  return withHash({
    schemaVersion: VIDEO_PRODUCTION_GRAPH_SCHEMA,
    graphId: text(input.graphId, 180),
    runtimeOrigin: input.runtimeOrigin,
    activeNode: 'brief',
    nodes: VIDEO_PRODUCTION_NODES.map((nodeId, index) => ({
      nodeId,
      status: index === 0 ? 'running' : 'pending',
      updatedAt: index === 0 ? updatedAt : null,
      evidenceRefs: [],
      blocker: null,
    })),
    updatedAt,
  });
}

export function advanceVideoProductionGraph(input: {
  graph?: VideoProductionGraphV1 | null;
  graphId: string;
  runtimeOrigin: VideoProductionRuntimeOrigin;
  activeNode: VideoProductionNodeId;
  status?: 'running' | 'completed' | 'blocked';
  evidenceRefs?: string[];
  blocker?: string | null;
  now?: string;
}): VideoProductionGraphV1 {
  const current = input.graph ?? createVideoProductionGraph(input);
  assertVideoProductionGraph(current);
  if (current.runtimeOrigin !== input.runtimeOrigin || current.graphId !== text(input.graphId, 180)) {
    throw new Error('video_production_graph_identity_mismatch');
  }
  const updatedAt = new Date(input.now ?? Date.now()).toISOString();
  const activeIndex = VIDEO_PRODUCTION_NODES.indexOf(input.activeNode);
  const previousActiveIndex = VIDEO_PRODUCTION_NODES.indexOf(current.activeNode);
  const rewinding = activeIndex < previousActiveIndex;
  const status = input.status ?? 'running';
  const evidenceRefs = [...new Set((input.evidenceRefs ?? []).map(value => text(value, 240)).filter(Boolean))].slice(0, 32);
  const nodes = current.nodes.map((node, index): VideoProductionGraphNode => {
    if (index < activeIndex) return node.status === 'skipped'
      ? node
      : { ...node, status: 'completed', updatedAt: node.updatedAt ?? updatedAt, blocker: null };
    if (index > activeIndex) return rewinding
      ? { ...node, status: 'pending', updatedAt: null, evidenceRefs: [], blocker: null }
      : node;
    return {
      ...node,
      status,
      updatedAt,
      evidenceRefs: [...new Set([...node.evidenceRefs, ...evidenceRefs])].slice(-32),
      blocker: status === 'blocked' ? text(input.blocker, 1_000) || 'blocked' : null,
    };
  });
  return withHash({
    schemaVersion: VIDEO_PRODUCTION_GRAPH_SCHEMA,
    graphId: current.graphId,
    runtimeOrigin: current.runtimeOrigin,
    activeNode: input.activeNode,
    nodes,
    updatedAt,
  });
}

const STARTER_STAGE_MAP: Record<string, VideoProductionNodeId> = {
  execution_plan_approved: 'brief',
  director_planning: 'material_index',
  asset_supply_completed: 'material_match',
  content_production: 'voice',
  director_revision_required: 'voice',
  rendering: 'render',
  quality_check: 'quality',
  media_evaluation: 'quality',
  creative_review: 'quality',
  review_ready: 'approval',
  waiting_review: 'approval',
  delivery_prepared: 'approval',
};

const DIGITAL_EMPLOYEE_STAGE_MAP: Record<string, VideoProductionNodeId> = {
  script: 'brief',
  material_match: 'material_match',
  voice_subtitles: 'voice',
  heygen: 'render',
  render: 'render',
  quality: 'quality',
  completed: 'approval',
};

export function productionNodeForRuntimeStage(
  origin: VideoProductionRuntimeOrigin,
  stage: string,
  resumeStage?: string,
): VideoProductionNodeId {
  const source = stage === 'blocked' && resumeStage ? resumeStage : stage;
  return (origin === 'starter198' ? STARTER_STAGE_MAP : DIGITAL_EMPLOYEE_STAGE_MAP)[source] ?? 'brief';
}
