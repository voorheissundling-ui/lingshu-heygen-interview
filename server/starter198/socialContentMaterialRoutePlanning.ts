import type { ResolvedSocialTaskReference } from './socialContentScriptSources.js';
import type { Starter198Repository, StarterRecord } from './repository.js';
import { STARTER_COLLECTIONS } from './repository.js';
import { readSocialTaskDetail, socialTaskSummary } from './socialContentRecords.js';
import { socialJson, socialObject } from './socialContentValidation.js';
import { planTypeAwareProductScriptTiming } from '../../shared/socialContentMaterialTiming.js';

/** Prepare a new plan against the real inventory before freezing or persisting it. */
export async function planNewSocialMaterialRoutes(input: {
  repository: Starter198Repository;
  tenantId: string;
  task: StarterRecord;
  resolved: ResolvedSocialTaskReference;
  readDetail?: typeof readSocialTaskDetail;
}): Promise<ResolvedSocialTaskReference> {
  const summary = socialTaskSummary(input.task), brief = summary.brief;
  if ((brief.materialRoutingPolicyVersion !== 'type-aware.v1' && brief.materialRoutingPolicyVersion !== 'type-aware.v2') || brief.productionApproach !== 'ai_enhanced'
    || socialObject(socialJson(input.task.brief))?._productionRevision
    || ['confirmed', 'superseded'].includes(input.resolved.replicationScript.status)) return input.resolved;
  const task = { ...input.task, replication_script: input.resolved.replicationScript,
    reference_video_analysis: input.resolved.referenceVideoAnalysis };
  const repository: Starter198Repository = {
    dataStore: input.repository.dataStore,
    materialLibrary: input.repository.materialLibrary,
    list: async (collection, tenantId, query) => {
      const result = await input.repository.list(collection, tenantId, query);
      return collection === STARTER_COLLECTIONS.socialContentTasks && tenantId === input.tenantId
        ? { ...result, items: result.items.map(row => row.id === task.id ? task : row) } : result;
    },
    create: input.repository.create.bind(input.repository),
    update: input.repository.update.bind(input.repository),
    access: input.repository.access.bind(input.repository),
    get: async (collection, tenantId, id) => collection === STARTER_COLLECTIONS.socialContentTasks
      && tenantId === input.tenantId && (id === task.id || id === summary.taskId) ? task : input.repository.get(collection, tenantId, id),
  };
  const detail = await (input.readDetail ?? readSocialTaskDetail)({ repository, tenantId: input.tenantId, taskId: summary.taskId });
  if (!detail?.assetSupplyPlan) throw Error('material_route_new_plan_missing');
  const script = structuredClone(input.resolved.replicationScript);
  for (const shot of script.shots) {
    const matches = detail.assetSupplyPlan.shots.filter(plan => plan.shotId === shot.shotId);
    if (matches.length !== 1) throw Error(`material_route_new_plan_shot_missing:${shot.shotId}`);
    shot.materialPlan = structuredClone(matches[0]!);
  }
  const timed = planTypeAwareProductScriptTiming({ policyVersion: brief.materialRoutingPolicyVersion, referenceMode: brief.referenceMode,
    script, referenceShots: input.resolved.referenceVideoAnalysis.shots });
  return { ...input.resolved, replicationScript: timed.script,
    shotMaterialMap: input.resolved.shotMaterialMap.map(row => {
      const plan = timed.script.shots.find(shot => shot.shotId === row.shotId)?.materialPlan;
      return plan ? { ...row, sourceStrategy: plan.sourceStrategy, truthBoundary: structuredClone(plan.truthBoundary) } : row;
    }) };
}
