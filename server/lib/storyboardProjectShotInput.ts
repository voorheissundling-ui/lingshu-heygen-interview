import { createHash } from 'node:crypto';

type ShotSlot = { id?: unknown; slotId?: unknown; detail?: unknown; duration?: unknown; requirements?: unknown };

function legacyReferenceByExactOrdinal(slots: ShotSlot[], details: Array<Record<string, unknown>>, slotIndex: number) {
  if (slotIndex < 0 || details.length !== slots.length || details.some(item => String(item.shotId || '').trim())) return null;
  const detail = details[slotIndex];
  const match = String(detail?.time || '').match(/^\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*$/i);
  if (!match) return null;
  const start = slots.slice(0, slotIndex).reduce((sum, item) => sum + Number(item.duration || 0), 0);
  const duration = Number(slots[slotIndex]?.duration || 0);
  if (!(duration > 0) || !Number.isFinite(start)) return null;
  return Math.abs(Number(match[1]) - start) <= .2 && Math.abs(Number(match[2]) - start - duration) <= .2 ? detail : null;
}

/** Only the inputs for this shot are included. Generated candidate IDs and QA
 * results are deliberately excluded, so saving a candidate does not stale it. */
export function storyboardProjectShotInput(spec: Record<string, any>, shotId: string) {
  const slots = Array.isArray(spec.shootingSlots) ? spec.shootingSlots as ShotSlot[] : [];
  const slot = slots.find(item => String(item.slotId || '') === shotId || String(item.id || '') === shotId);
  if (!slot) return null;
  const slotId = String(slot.slotId || slot.id || '');
  const plan = (spec.storyboardSourcePlans && typeof spec.storyboardSourcePlans === 'object'
    ? spec.storyboardSourcePlans[slotId] || spec.storyboardSourcePlans[String(slot.id || '')] : null) || {};
  const details = Array.isArray(spec.videoKickoff?.referenceAnalysis?.details)
    ? spec.videoKickoff.referenceAnalysis.details as Array<Record<string, unknown>> : [];
  const reference = details.find(item => String(item.shotId || '') === slotId)
    || legacyReferenceByExactOrdinal(slots, details, slots.indexOf(slot));
  const input = {
    slotId,
    persistedShotId: String(slot.id || ''),
    detail: String(slot.detail || ''),
    duration: Number(slot.duration || 0),
    requirements: String(slot.requirements || ''),
    mode: String(spec.mode || ''),
    ratio: String(spec.ratio || ''),
    assemblyId: String(spec.activeAssemblyId || ''),
    source: {
      mode: String(plan.mode || ''),
      referenceClipId: String(plan.referenceClipId || ''),
      sceneType: String(plan.sceneType || ''),
      productIds: Array.isArray(plan.productIds) ? plan.productIds.map(String) : [],
      environmentMaterialId: String(plan.environmentMaterialId || ''),
      characterMaterialId: String(plan.characterMaterialId || ''),
      actionStartState: String(plan.actionStartState || ''),
      actionBeats: String(plan.actionBeats || ''),
      actionEndState: String(plan.actionEndState || ''),
      ...(String(plan.fallbackMode || '') ? { fallbackMode: String(plan.fallbackMode) } : {}),
      actionKeyStates: String(plan.actionKeyStates || ''),
      placementOverride: plan.placementOverride && typeof plan.placementOverride === 'object'
        ? plan.placementOverride : null,
    },
    reference: reference ? {
      shotId: String(reference.shotId || ''),
      time: String(reference.time || ''),
      firstFrameRef: String(reference.firstFrameRef || ''),
      visual: String(reference.visual || ''),
      camera: String(reference.camera || ''),
      startState: String(reference.startState || ''),
      endState: String(reference.endState || ''),
      beats: Array.isArray(reference.beats) ? reference.beats : [],
      persistentState: String(reference.persistentState || ''),
    } : null,
  };
  return { input, fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
}

export function storyboardProjectShotRequestIssue(input: {
  projectSpec: Record<string, any>; shotId: string; shotDescription: string;
  mode: string; ratio: string; sceneType: string; productIds: string[];
  targetDurationSeconds: number; sourceFirstFrameUrl?: string;
  environmentMaterialId?: string;
  characterMaterialId?: string;
  placement?: { contactScene?: unknown; productBox?: unknown; contactSurfaceY?: unknown };
  action?: { startState?: unknown; beats?: unknown; endState?: unknown; evidence?: unknown };
  keyStates?: Array<{ afterBeat: number; description: string; source: string }>;
}): string | null {
  const current = storyboardProjectShotInput(input.projectSpec, input.shotId)?.input;
  if (!current) return '本片分镜已不存在';
  if (current.detail && !input.shotDescription.includes(current.detail)) return '画面要求与本片已确认分镜不一致';
  if (Number.isFinite(current.duration) && current.duration > 0
    && Math.abs(current.duration - input.targetDurationSeconds) > 0.2) return '时长与本片已确认分镜不一致';
  if (current.ratio && current.ratio !== input.ratio) return '画幅与本片设置不一致';
  const expectedMode = current.mode === 'clone' && current.source.fallbackMode !== 'enterprise_product_display'
    ? 'replication' : 'free_creation';
  if (current.mode && expectedMode !== input.mode) return '创作模式与本片设置不一致';
  if (current.source.sceneType && current.source.sceneType !== input.sceneType) return '场景类型与当前镜头配置不一致';
  if (current.source.productIds.length && JSON.stringify(current.source.productIds) !== JSON.stringify(input.productIds)) return '产品映射与当前镜头配置不一致';
  if (current.source.environmentMaterialId !== String(input.environmentMaterialId || '')) return '环境参考图与当前镜头配置不一致';
  if (current.source.characterMaterialId !== String(input.characterMaterialId || '')) return '指定人物参考图与当前镜头配置不一致';
  const normalize = (value: unknown) => String(value || '').trim();
  if (current.source.actionStartState && normalize(input.action?.startState) !== current.source.actionStartState.trim())
    return '动作起点与已确认分镜不一致';
  if (current.source.actionEndState && normalize(input.action?.endState) !== current.source.actionEndState.trim())
    return '动作终点与已确认分镜不一致';
  const savedBeats = current.source.actionBeats.split(/[；;\n]+/).map(item => item.trim()).filter(Boolean);
  if (savedBeats.length && JSON.stringify(input.action?.beats) !== JSON.stringify(savedBeats))
    return '动作步骤与已确认分镜不一致';
  if (input.mode === 'replication' && input.action?.evidence === 'confirmed_reference_analysis') {
    if (!current.reference) return '原片动作证据缺少当前分镜分析';
    const observedBeats = current.reference.beats.map((beat: any) => normalize(beat?.action)).filter(Boolean);
    if (JSON.stringify(input.action?.beats || []) !== JSON.stringify(observedBeats))
      return '动作步骤与当前原片分镜分析不一致';
    if (normalize(input.action?.startState) !== current.reference.startState.trim())
      return '动作起点与当前原片分镜分析不一致';
    if (normalize(input.action?.endState) !== current.reference.endState.trim())
      return '动作终点与当前原片分镜分析不一致';
  }
  const savedKeyStates = current.source.actionKeyStates.split(/[；;\n]+/).map(item => item.trim()).filter(Boolean);
  if ((savedKeyStates.length || input.keyStates?.length)
    && JSON.stringify((input.keyStates || []).map(item => item.description)) !== JSON.stringify(savedKeyStates))
    return '动作中间状态与已确认分镜不一致';
  if (current.source.placementOverride) {
    const saved = current.source.placementOverride as Record<string, any>;
    const box = saved.productBox || {};
    const requested = (input.placement?.productBox || {}) as Record<string, unknown>;
    if (saved.contactScene !== input.placement?.contactScene || Number(saved.contactSurfaceY) !== Number(input.placement?.contactSurfaceY)
      || ['x', 'y', 'width', 'height'].some(key => Number(box[key]) !== Number(requested[key])))
      return '产品位置与当前镜头配置不一致';
  }
  if (input.mode === 'replication' && !current.reference?.firstFrameRef) return '当前分镜缺少已绑定的原片真实首帧';
  if (current.reference?.firstFrameRef && current.reference.firstFrameRef !== String(input.sourceFirstFrameUrl || '')) return '原片首帧不是当前分镜自己的参考帧';
  return null;
}
