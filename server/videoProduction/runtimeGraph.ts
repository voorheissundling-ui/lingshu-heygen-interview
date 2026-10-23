import {
  advanceVideoProductionGraph,
  parseVideoProductionGraph,
  productionNodeForRuntimeStage,
} from '../../shared/contracts/videoProductionGraph.js';

const text = (value: unknown, maximum = 240): string => String(value ?? '').trim().slice(0, maximum);

export function digitalEmployeeProductionGraph(input: {
  automation: Record<string, unknown>;
  stage: string;
  extra?: Record<string, unknown>;
  now: string;
}) {
  const extra = input.extra ?? {};
  const resumeStage = text(extra.resumeStage || input.automation.resumeStage);
  const productionGraphId = text(input.automation.productionGraphId, 180)
    || `digital-employee:${text(input.automation.route, 40) || 'video'}:${text(input.automation.slot, 40) || '0'}`;
  return {
    productionGraphId,
    productionGraph: advanceVideoProductionGraph({
      graph: parseVideoProductionGraph(input.automation.productionGraph),
      graphId: productionGraphId,
      runtimeOrigin: 'digital_employee',
      activeNode: productionNodeForRuntimeStage('digital_employee', input.stage, resumeStage),
      status: input.stage === 'completed' ? 'completed' : input.stage === 'blocked' ? 'blocked' : 'running',
      blocker: input.stage === 'blocked' ? text(extra.blocker, 1_000) : null,
      evidenceRefs: [text(extra.renderOutputPath, 500), text(extra.narrationHash, 200)].filter(Boolean),
      now: input.now,
    }),
  };
}

