import type { SocialContentAgentWorkflow } from '../../shared/contracts/socialContentAgentContract.js';
import type { SocialDirectorContentHandoff } from './socialContentDirectorPlan.js';
import type { SocialReferenceVideoAnalysis } from '../../shared/contracts/socialContentReplication.js';

export interface SocialProductionFidelityContext {
  referenceAnalysis?: SocialReferenceVideoAnalysis | null;
  renderedDurationSeconds?: number;
  renderedTimeline?: Array<{ sceneId: string; startSeconds: number; endSeconds: number }>;
}

/** Source analysis is the denominator; a reduced DirectorBrief cannot certify itself. */
export function socialProductionReferenceFidelityFailures(
  workflow: SocialContentAgentWorkflow,
  handoff: SocialDirectorContentHandoff,
  context: SocialProductionFidelityContext = {},
): string[] {
  if (!workflow.replicationJob && !workflow.directorBrief.referenceMode && !workflow.directorBrief.referenceAnalysis) return [];
  const analysis = context.referenceAnalysis;
  if (!analysis?.shots?.length) return ['单一参考保真验收缺少完整原始镜头分析'];
  const failures: string[] = [];
  const reference = analysis.shots;
  const near = (a: number, b: number, tolerance = 0.08) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  if (workflow.directorBrief.referenceAnalysis?.analysisId && workflow.directorBrief.referenceAnalysis.analysisId !== analysis.analysisId)
    failures.push('终审原参考分析与锁定编导分析身份不一致');
  if (new Set(reference.map(shot => shot.shotId)).size !== reference.length || reference.some((shot, index) =>
    !Number.isFinite(shot.startSeconds) || !Number.isFinite(shot.endSeconds) || shot.endSeconds <= shot.startSeconds
    || !near(shot.startSeconds, index ? reference[index - 1]!.endSeconds : 0)))
    failures.push('原参考镜头分析包含重复身份、无效区间或时间线缺口');
  const scenes = handoff.scenes.map(scene => directorSceneForFinal(workflow, scene.sceneId));
  const ids = scenes.map(scene => scene?.referenceShotId);
  if (reference.length !== scenes.length || new Set(ids).size !== reference.length
    || reference.some(shot => !ids.includes(shot.shotId))) failures.push(`参考镜头覆盖不完整：必须保留全部 ${reference.length} 个原始镜头`);
  if (reference.some((shot, index) => ids[index] !== shot.shotId)) failures.push('最终镜头顺序与原参考时间线不一致');
  if (reference.some((shot, index) => {
    const scene = scenes[index];
    return !scene || !near(scene.duration?.startSeconds, shot.startSeconds) || !near(scene.duration?.endSeconds, shot.endSeconds);
  })) failures.push('编导镜头时间区间与原参考不一致');
  const total = analysis.durationSeconds ?? analysis.coverage?.fullDurationSeconds;
  if (!total || !near(reference.at(-1)!.endSeconds, total)) failures.push('原参考镜头分析未覆盖完整视频时长');
  if (!total || !near(handoff.outputSpec?.targetDurationSeconds, total)
    || !near(workflow.directorBrief.totalDurationSeconds, total)) failures.push('锁定成片总时长与原参考不一致');
  if (context.renderedDurationSeconds !== undefined && (!total || !near(context.renderedDurationSeconds, total, 0.25))) failures.push('实际成片时长未覆盖原参考时间线');
  if (context.renderedTimeline && (context.renderedTimeline.length !== reference.length || reference.some((shot, index) => {
    const rendered = context.renderedTimeline![index];
    return !rendered || rendered.sceneId !== handoff.scenes[index]?.sceneId
      || !near(rendered.startSeconds, shot.startSeconds) || !near(rendered.endSeconds, shot.endSeconds);
  }))) failures.push('实际渲染镜头时间区间或顺序与原参考不一致');
  return failures;
}

function directorSceneForFinal(workflow: SocialContentAgentWorkflow, finalSceneId: string) {
  const direct = workflow.directorBrief.scenes.find(scene => scene.sceneId === finalSceneId);
  if (direct) return direct;
  const ordinal = /^scene-(\d+)$/.exec(finalSceneId)?.[1];
  return ordinal
    ? workflow.directorBrief.scenes.find(scene => scene.order === Number(ordinal)) ?? null
    : null;
}

export function socialProductionExecutionSceneForFinal(
  workflow: SocialContentAgentWorkflow,
  finalSceneId: string,
) {
  const directorScene = directorSceneForFinal(workflow, finalSceneId);
  if (!directorScene) return null;
  return workflow.executionPlan.scenes.find(scene => scene.sceneId === directorScene.sceneId) ?? null;
}

export function socialProductionCollaborationFailures(
  workflow: SocialContentAgentWorkflow,
  handoff: SocialDirectorContentHandoff,
  context: SocialProductionFidelityContext = {},
): string[] {
  const reviewById = new Map(workflow.executionPlanReview.sceneResults.map(scene => [scene.sceneId, scene]));
  const finalSceneIds = handoff.scenes.map(scene => scene.sceneId);
  const uniqueFinalSceneIds = new Set(finalSceneIds);
  return [
    ...socialProductionReferenceFidelityFailures(workflow, handoff, context),
    ...(workflow.executionPlanReview.approved ? [] : ['内容执行方案未通过编导审核']),
    ...(handoff.scenes.length > 0 ? [] : ['成片没有可验收的镜头']),
    ...(uniqueFinalSceneIds.size === finalSceneIds.length ? [] : ['最终成片包含重复镜头身份']),
    ...(handoff.scenes.every(scene => Boolean(directorSceneForFinal(workflow, scene.sceneId))) ? [] : ['最终镜头未全部来自 DirectorBrief']),
    ...(handoff.scenes.every(scene => Boolean(socialProductionExecutionSceneForFinal(workflow, scene.sceneId))) ? [] : ['最终镜头未全部来自 ContentExecutionPlan']),
    ...(handoff.scenes.every(scene => {
      const execution = socialProductionExecutionSceneForFinal(workflow, scene.sceneId);
      return execution && reviewById.get(execution.sceneId)?.approved === true;
    })
      ? [] : ['最终逐镜链路未全部经过编导审核']),
    ...(handoff.scenes.every(scene => (directorSceneForFinal(workflow, scene.sceneId)?.acceptanceCriteria.length ?? 0) > 0)
      ? [] : ['存在没有可观察验收条件的分镜']),
  ];
}

export function socialProductionCollaborationTrace(
  workflow: SocialContentAgentWorkflow,
  handoff: SocialDirectorContentHandoff,
) {
  return {
    ...(handoff.collaboration ?? {}),
    finalExecutionLock: {
      directorPlanId: handoff.directorPlanId,
      version: handoff.planVersion,
      lineageHash: handoff.lineageHash,
      handoffHash: handoff.handoffHash,
    },
    sceneLineage: handoff.scenes.map((scene, index) => {
      const directorScene = directorSceneForFinal(workflow, scene.sceneId);
      const executionScene = socialProductionExecutionSceneForFinal(workflow, scene.sceneId);
      return {
        order: index + 1,
        finalSceneId: scene.sceneId,
        directorSceneId: directorScene?.sceneId ?? null,
        executionSceneId: executionScene?.sceneId ?? null,
        reviewApproved: workflow.executionPlanReview.sceneResults
          .find(item => item.sceneId === executionScene?.sceneId)?.approved === true,
        assetId: scene.source.assetId,
        clipId: scene.source.clipId,
      };
    }),
  };
}
