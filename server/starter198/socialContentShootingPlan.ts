import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';

export const SOCIAL_SHOOTING_PLAN_SCHEMA = 'social-content.shooting-plan.v1';

/** The non-rendering option projects Director controls without calling providers. */
export function buildSocialShootingPlanArtifactContent(
  detail: Pick<SocialContentTaskDetail, 'taskId' | 'version' | 'brief' | 'agentWorkflow' | 'referenceVideoAnalysis'>,
): Record<string, unknown> {
  const workflow = detail.agentWorkflow;
  if (!workflow) throw new Error('shooting_plan_director_brief_missing');
  const director = workflow.directorBrief;
  return {
    workflowSchema: SOCIAL_SHOOTING_PLAN_SCHEMA,
    sourceKey: `social_task_shooting_plan:${detail.taskId}`,
    contentType: 'shooting_plan',
    taskVersion: detail.version,
    title: `${detail.brief.title || '社媒内容'}·代拍清单`,
    estimatedOutputDurationSeconds: director.totalDurationSeconds,
    productionMode: 'non_rendering_checklist',
    providerCallsRequired: false,
    product: director.contentRequirements?.product ?? {
      required: Boolean(detail.brief.productRef),
      productRef: detail.brief.productRef,
      confidence: detail.brief.productRef ? 1 : 0,
      reason: detail.brief.productRef ? '任务已指定产品' : '未锁定产品，代拍可使用现场可用产品',
    },
    hook: {
      intervalSeconds: [0, Math.min(3, director.totalDurationSeconds)],
      precision: 'hook_high',
      referenceAnalysisId: director.referenceAnalysis?.analysisId ?? detail.referenceVideoAnalysis?.analysisId ?? null,
      instruction: '前三秒必须逐帧复核第一帧主体、人物动作、人物-产品-环境交互、镜头轨迹、字幕和声音触发',
    },
    scenes: director.scenes.map(scene => ({
      sceneId: scene.sceneId,
      order: scene.order,
      timing: structuredClone(scene.duration),
      purpose: scene.purpose,
      voiceover: scene.audioLayers.voiceover,
      caption: scene.audioLayers.captionIntent,
      targetVisual: scene.targetVisual,
      action: structuredClone(scene.action),
      shotLanguage: structuredClone(scene.shotLanguage),
      spaceAndContinuity: [...scene.spaceAndContinuity],
      requiredEvidence: [...scene.requiredEvidence],
      productSceneReplication: scene.productSceneReplication
        ? structuredClone(scene.productSceneReplication) : null,
      truthBoundary: structuredClone(scene.truthBoundary),
      acceptanceCriteria: [...scene.acceptanceCriteria],
      hookPrecision: scene.duration.startSeconds < 3,
    })),
    createdBy: 'content_agent',
  };
}
