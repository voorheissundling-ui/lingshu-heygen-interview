import { allocateEvidenceClips, mediaIdentity, type EvidenceAsset, type EvidenceRequest } from './sceneEvidence.js';
import type { SceneVisualIssue } from '../lib/renderVisualQuality.js';
export const MAX_SCENE_REPAIR_ATTEMPTS = 2;
export function planSceneRepair(input: {
  scenes: EvidenceRequest[]; assets: EvidenceAsset[]; issues: SceneVisualIssue[];
  current: Array<{ sceneIndex: number; assetId: string; sourceStart?: number }>;
  attempts: number; userLocked: boolean; previousFailures?: Array<{ identity: string; start: number; end?: number }>;
}) {
  const failed = new Set(input.issues.map(issue => issue.sceneIndex));
  if (!failed.size) return { plan: [], gaps: ['没有可定位的问题镜头'] };
  if (input.userLocked) return { plan: [], gaps: ['问题镜头使用了用户指定素材，请确认替换素材后重试'] };
  if (input.attempts >= MAX_SCENE_REPAIR_ATTEMPTS) return { plan: [], gaps: ['已达到两轮镜头自动修复上限，请复核素材后重试'] };
  const excluded = input.current.flatMap(item => {
    const asset = input.assets.find(asset => asset.id === item.assetId);
    const scene = input.scenes.find(scene => scene.sceneIndex === item.sceneIndex);
    if (!asset || !scene) return [];
    // Preserve good shots; never try the same failing interval again.
    const start = asset.type === 'image' ? 0 : item.sourceStart || 0;
    return [{ identity: mediaIdentity(asset), start, end: asset.type === 'image' ? Infinity : start + scene.duration }];
  });
  const failedSources = input.current.flatMap(item => {
    if (!failed.has(item.sceneIndex)) return [];
    const asset = input.assets.find(asset => asset.id === item.assetId);
    const scene = input.scenes.find(scene => scene.sceneIndex === item.sceneIndex);
    if (!asset || !scene) return [];
    return [{ identity: mediaIdentity(asset), start: asset.type === 'image' ? 0 : item.sourceStart || 0,
      ...(asset.type === 'video' ? { end: (item.sourceStart || 0) + scene.duration } : {}) }];
  });
  const history = (input.previousFailures || []).map(item => ({ ...item, end: item.end ?? Infinity }));
  return { ...allocateEvidenceClips({ scenes: input.scenes.filter(scene => failed.has(scene.sceneIndex)).map(scene => ({ ...scene, materialId: undefined, trimStart: undefined })), assets: input.assets, excluded: [...excluded, ...history] }), failedSources };
}
/** Visual-only repairs keep the verified narration and subtitle timing. */
export function applySceneRepair(spec: Record<string, any>, repair: ReturnType<typeof planSceneRepair>, issues: SceneVisualIssue[]): Record<string, any> {
  if (repair.gaps.length || !repair.plan.length) throw Error('没有可执行的镜头修复方案');
  const replacements = new Map(repair.plan.map(clip => [clip.sceneIndex, clip]));
  const sourcePlan = spec.sceneSourcePlan.map((item: any) => {
    const clip = replacements.get(item.sceneIndex);
    return clip ? { ...item, assetId: clip.assetId, sourceStart: clip.start, sourceEnd: Number.isFinite(clip.end) ? clip.end : undefined,
      evidenceSegmentId: clip.segmentId, observations: clip.observations, score: clip.score, reasons: ['成片镜头质检失败后按已确认片段替换', ...clip.observations] } : item;
  });
  const automation = spec.automation || {};
  const previousPath = automation.renderOutputPath || spec.renderOutputPath;
  return { ...spec, contentAcceptance: null, coverImagePath: '', sceneSourcePlan: sourcePlan,
    selectedMaterialIds: [...new Set(sourcePlan.map((item: any) => item.assetId))],
    sceneOverrides: sourcePlan.map((item: any) => ({ ...spec.sceneOverrides?.[item.sceneIndex], source: 'material', materialId: item.assetId, trimStart: item.sourceStart || 0 })),
    materialInfos: sourcePlan.map((item: any) => ({ name: item.assetId, targetStart: item.start, targetEnd: item.end, observations: item.observations || [] })),
    contentOrder: { ...spec.contentOrder, videoPlan: { ...spec.contentOrder?.videoPlan,
      materialIds: [...new Set(sourcePlan.map((item: any) => item.assetId))], scenePlan: sourcePlan.map((item: any) => ({ source: 'material', materialId: item.assetId })) } },
    renderOutputPath: '', languageRenderOutputs: {}, languageRenderVersions: {}, sourceSegments: [],
    invalidatedRenders: [...(spec.invalidatedRenders || []), ...(previousPath ? [{ path: previousPath, contentVersion: automation.contentVersion, reason: '镜头质检失败，替换后重新渲染' }] : [])].slice(-20),
    automation: { ...automation, stage: 'render', status: 'queued', blocker: '', retryPolicy: '', retryAfter: '',
      renderOutputPath: '', renderedAt: '', completedAt: '', approvalState: 'not_ready', quality: {},
      contentVersion: Number(automation.contentVersion || 1) + 1,
      sceneRepairAttempts: Number(automation.sceneRepairAttempts || 0) + 1,
      sceneRepairHistory: [...(automation.sceneRepairHistory || []), { issues, failedSources: 'failedSources' in repair ? repair.failedSources : [], replacements: repair.plan.map(clip => ({ sceneIndex: clip.sceneIndex, assetId: clip.assetId, start: clip.start, segmentId: clip.segmentId })) }].slice(-MAX_SCENE_REPAIR_ATTEMPTS),
    } };
}
