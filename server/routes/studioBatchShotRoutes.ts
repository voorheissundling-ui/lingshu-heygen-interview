import { digitalHumanDecisionIssues, enterpriseMaterialIssue } from '../../shared/contracts/smartStoryboardAdmission.js';
import { recognizePresenterShot, salesPresenterRecognition, confirmedSalesPresenterRoute } from '../../shared/contracts/presenterShotRecognition.js';
import { effectiveDigitalHumanRequirements } from '../../shared/contracts/digitalHumanRequirements.js';
import { createHash } from 'node:crypto';
import { shotFingerprint, type ShotProduction } from '../../src/lib/shotProduction.js';

/** Server-loaded material metadata, never a client-supplied material snapshot. */
export interface StudioBudgetMaterial {
  id: string;
  tenantId?: string;
  tenant_id?: string;
  scope?: string;
  type?: string;
  sourceType?: string;
  contentSha256?: string;
  duration?: number;
  provenance?: Record<string, any>;
}

/** The caller must run current assignment/KB checks and hash the actual video
 * bytes before including an ID in this map. This is not a paid-call receipt. */
export interface StudioVerifiedAdoptionContext {
  tenantId: string;
  projectId: string;
  materials: readonly StudioBudgetMaterial[];
  verifiedContentSha256ByMaterialId: Readonly<Record<string, string>>;
  /** Current-input/KB/source validation and actual bytes must both pass. */
  verifiedFirstFrameContentSha256ByMaterialId?: Readonly<Record<string, string>>;
}

export function batchShotRequestId(input: {
  projectId: string; batchId: string; assemblyId: string; shotId: string; fingerprint: string;
}): string {
  return `batch:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 40)}`;
}

export function uniqueAuthorizedSalesPresenter<T extends { id: string; name: string; authorized: boolean }>(presenters: T[]): T | null {
  const sales = presenters.filter(item => item.authorized && item.name.trim() === '销售');
  return sales.length === 1 ? sales[0]! : null;
}

export interface StudioBatchShotRoute {
  shotId: string;
  slotId: string;
  order: number;
  visualTopic: 'presenter' | 'factory' | 'product' | 'usage_scene' | 'other';
  expressionPurpose: string;
  route: 'digital_human' | 'local_material' | 'seedance_action' | 'aigc_first_frame' | 'unresolved';
  status: 'matched' | 'needs_material' | 'needs_plan' | 'blocked';
  matchedMaterialId: string | null;
  /** Server-verified persistent identity metadata for the matched material. */
  matchedProductId: string | null;
  matchedProductIdentityLevel: 'exact' | 'category' | 'none' | null;
  matchedSegmentId: string | null;
  trimStart: number | null;
  trimEnd: number | null;
  reason: string;
  /** This is a planning result, never evidence that a provider job completed. */
  generated: false;
}

interface BatchShotSpec {
  mode?: string;
  activeAssemblyId?: string;
  ratio?: string;
  shootingSlots?: Array<{ id?: string; slotId?: string; detail?: string; duration?: number; requirements?: string; observedPresenterRole?: import('../../shared/contracts/presenterShotRecognition.js').ObservedPresenterRole; personContinuityId?: string; salesPresenterConfirmed?: boolean; locked?: boolean; blocker?: string }>;
  shotProductions?: Record<string, ShotProduction>;
  storyboardAssignments?: Record<string, string>;
  storyboardSourcePlans?: Record<string, { userSource?: string; mode?: string; shotTopic?: 'presenter' | 'factory' | 'product' | 'consumer_demo' | 'general'; sceneType?: 'product' | 'factory' | 'usage' | 'general'; confirmed?: boolean; firstFrameMaterialId?: string; firstFrameConfirmed?: boolean; generatedClipId?: string; videoResolution?: '480p' | '720p'; videoResolutionPinned?: boolean; blocker?: string }>;
  clipEdits?: Record<string, { segmentId?: string; trimStart?: number; trimEnd?: number }>;
  materialSnapshots?: Array<{ id?: string; usage?: string; name?: string; type?: string; url?: string; duration?: number; width?: number; height?: number; aspectRatio?: number; transcript?: string }>;
  automation?: { managedBy?: string };
  shotProductionContext?: string;
  selectedProductIds?: string[];
  automatedReplicationPlan?: { tenantId?: string };
  automatedReplicationShots?: Array<{ shotId: string; slotId: string; kind: string; start: number; end: number; fingerprintContext?: string; firstFrameRequest?: Record<string, any> }>;
  automatedReplicationProgress?: Record<string, { adopted?: boolean; qualityChecked?: boolean; materialId?: string; videoMaterialId?: string; videoContentSha256?: string; fingerprint?: string; firstFrameMaterialId?: string; firstFrameFingerprint?: string }>;
}

/** Reuse is a conjunction of current inputs, adoption, QA and actual byte
 * identity. An invalid old adoption blocks this shot instead of silently
 * consuming another image/video budget allocation. */
function verifiedAutomatedAdoption(spec: BatchShotSpec, shotId: string, slotId: string, context?: StudioVerifiedAdoptionContext) {
  if (spec.automation?.managedBy !== 'digital_employee') return { state: 'none' as const };
  const state = spec.automatedReplicationProgress?.[shotId];
  if (state?.adopted !== true) return { state: 'none' as const };
  const invalid = { state: 'invalid' as const };
  const entry = spec.automatedReplicationShots?.find(item => item.shotId === shotId && item.slotId === slotId);
  const shot = spec.shotProductions?.[`${spec.activeAssemblyId}:${shotId}`];
  const assigned = spec.storyboardAssignments?.[slotId];
  // Enterprise footage and the separate digital-human executor have their
  // own validation paths; this guard concerns generated storyboard videos.
  if (entry?.kind === 'person' || (!state.videoMaterialId && !state.firstFrameMaterialId
    && !shot?.candidates?.some(candidate => candidate.id === shot.adoptedId && candidate.source === 'ai'))) return { state: 'none' as const };
  if (!context?.tenantId || !context.projectId || spec.automatedReplicationPlan?.tenantId !== context.tenantId
    || !entry || entry.kind !== 'nonperson' || !shot || !assigned
    || state.qualityChecked !== true || state.materialId !== assigned || state.videoMaterialId !== assigned) return invalid;
  const fingerprint = shotFingerprint(shot, String(entry.fingerprintContext || spec.shotProductionContext || ''), shotId);
  if (!state.fingerprint || state.fingerprint !== fingerprint
    || !shot.candidates?.some(candidate => candidate.id === shot.adoptedId && candidate.materialId === assigned
      && candidate.source === 'ai' && candidate.fingerprint === fingerprint)) return invalid;
  const material = context.materials.find(item => item.id === assigned);
  const actualHash = context.verifiedContentSha256ByMaterialId[assigned];
  const provenance = material?.provenance;
  const qa = provenance?.storyboardQualityReport;
  if (!material || String(material.tenantId || material.tenant_id || '') !== context.tenantId
    || material.scope !== 'own' || material.type !== 'video'
    || !/^[a-f0-9]{64}$/.test(actualHash || '') || actualHash !== material.contentSha256 || actualHash !== state.videoContentSha256
    || provenance?.storyboardAigc !== true || provenance.projectId !== context.projectId || provenance.shotId !== slotId
    || !state.firstFrameMaterialId || provenance.firstFrameMaterialId !== state.firstFrameMaterialId
    || !state.firstFrameFingerprint || provenance.firstFrameFingerprint !== state.firstFrameFingerprint
    || qa?.phase !== 'video' || qa.status !== 'passed' || qa.passed !== true || qa.requiresHumanReview === true) return invalid;
  const request = entry.firstFrameRequest;
  const produced = provenance.shotSpec;
  const slot = spec.shootingSlots?.find(item => item.id === shotId && String(item.slotId || item.id) === slotId);
  const duration = entry.end - entry.start;
  if (!request || request.projectId !== context.projectId || !produced || produced.shotId !== slotId
    || produced.description !== request.shotDescription || produced.layout?.ratio !== spec.ratio
    || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(material.duration) || Number(material.duration) + 0.05 < duration
    || !Number.isFinite(slot?.duration)
    || Math.abs(Number(slot?.duration) - duration) > 0.01
    || produced.startSeconds !== entry.start || produced.endSeconds !== entry.end
    || request.startSeconds !== entry.start || request.endSeconds !== entry.end) return invalid;
  return { state: 'reused' as const, materialId: assigned };
}

/** Read-only planning for the workbench. Actual provider work must go through
 * the existing per-shot production plan and job endpoints. */
export function planStudioBatchShotRoutes(spec: BatchShotSpec, options: {
  talkingExecutorReady: boolean;
  actionExecutorReady: boolean;
  authorizedPresenterIds: string[];
  /** Configured assets stay distinguishable from a genuinely missing person.
   * Invalid trust evidence is still fail-closed through preflight issues. */
  configuredPresenterIds?: string[];
  presenterPreflightIssues?: Readonly<Record<string, readonly string[]>>;
  presenterNamesById?: Readonly<Record<string, string>>;
  presenterNativeOrientationsById?: Readonly<Record<string, string>>;
  defaultSalesPresenterId?: string | null;
  verifiedAdoptionContext?: StudioVerifiedAdoptionContext;
  materialIdentityEvidence?: Record<string, { productId: string; productIdentityLevel: 'exact' | 'category' | 'none' }>;
}): StudioBatchShotRoute[] {
  const slots = Array.isArray(spec.shootingSlots) ? spec.shootingSlots : [];
  const production = spec.shotProductions ?? {};
  const assignments = spec.storyboardAssignments ?? {};
  const snapshots = new Map((spec.materialSnapshots ?? []).map(item => [item.id, item]));
  const assemblyId = String(spec.activeAssemblyId || '');
  return slots.map((slot, index): StudioBatchShotRoute => {
    const shotId = String(slot.id || '');
    const slotId = String(slot.slotId || shotId);
    const shot = production[`${assemblyId}:${shotId}`];
    const digitalHuman = effectiveDigitalHumanRequirements(shot?.digitalHuman);
    // `requirements` is a JSON snapshot that often contains the entire
    // product profile. `shot.source=avatar` may be an imported placeholder for
    // every reference cut. Neither is reliable evidence of what is on screen.
    const description = String(slot.detail || '').split('镜头功能：')[0] || String(slot.detail || '');
    const purpose = String(slot.detail || '').match(/镜头功能：([^\s]+)/)?.[1] || String(slot.requirements || '').slice(0, 120);
    const sourcePlan = spec.storyboardSourcePlans?.[slotId];
    const explicitScene = sourcePlan?.sceneType;
    const recognition = confirmedSalesPresenterRoute(slot);
    const selectedTopic = spec.storyboardSourcePlans?.[slotId]?.shotTopic;
    const factoryScene = selectedTopic === 'factory' || (!selectedTopic && recognition !== 'presenter' && (explicitScene === 'factory' || /工厂|车间|生产线|流水线|灌装|工人|factory|manufactur/i.test(description)));
    const spokenOnScreen = !factoryScene && (recognition === 'presenter' || spec.storyboardSourcePlans?.[slotId]?.userSource === 'avatar');
    const action = !factoryScene && recognition === 'motion';
    const visualTopic: StudioBatchShotRoute['visualTopic'] = factoryScene ? 'factory' : action || spokenOnScreen ? 'presenter'
      : explicitScene === 'general' ? 'other'
        : selectedTopic === 'consumer_demo' || explicitScene === 'usage' || /消费者|顾客|用户|使用|试用|安装|操作|涂抹|喷涂|上脸|妆效|粉底覆盖|使用前后|consumer|usage/i.test(description) ? 'usage_scene'
          : explicitScene === 'product' || /产品|包装|瓶身|质地|粉底液|product/i.test(description) ? 'product' : 'other';
    const assignedId = String(assignments[slotId] || '').trim();
    const assigned = assignedId && snapshots.has(assignedId) && snapshots.get(assignedId)?.usage !== 'reference_only' ? assignedId : null;
    const identityEvidence = assigned ? options.materialIdentityEvidence?.[assigned] : undefined;
    const edit = assigned ? spec.clipEdits?.[`${slotId}:${assigned}`] : undefined;
    const trimStart = Number(edit?.trimStart);
    const trimEnd = Number(edit?.trimEnd);
    const base = { shotId, slotId, order: index + 1, visualTopic, expressionPurpose: purpose,
      matchedMaterialId: assigned, matchedSegmentId: assigned ? String(edit?.segmentId || '') || null : null,
      matchedProductId: identityEvidence?.productId || null,
      matchedProductIdentityLevel: identityEvidence?.productIdentityLevel || null,
      trimStart: assigned && Number.isFinite(trimStart) ? trimStart : null,
      trimEnd: assigned && Number.isFinite(trimEnd) && trimEnd > trimStart ? trimEnd : null,
      generated: false as const };
    const choice = sourcePlan?.userSource;
    if (sourcePlan?.mode === 'blocked' || slot.locked) return { ...base, route: 'unresolved', status: 'blocked',
      reason: sourcePlan?.blocker || slot.blocker || '镜头证据待确认，未提交智能生成' };
    const adoption = verifiedAutomatedAdoption(spec, shotId, slotId, options.verifiedAdoptionContext);
    if (adoption.state === 'reused') return { ...base, route: 'local_material', status: 'matched',
      matchedMaterialId: adoption.materialId!, reason: '复用已质检且当前输入、企业归属及视频内容校验一致的镜头，不重复分配生成预算' };
    if (adoption.state === 'invalid') return { ...base, route: 'unresolved', status: 'blocked', matchedMaterialId: null,
      reason: '原已采用镜头需要核对当前输入、归属或视频版本，保留原资产且不重复付费' };
    if (!['material', 'shoot'].includes(choice || '') && slot.personContinuityId && salesPresenterRecognition(slot) === 'confirmed') {
      const identityAssets = new Set(slots.filter(peer => peer.personContinuityId === slot.personContinuityId && salesPresenterRecognition(peer) === 'confirmed'
        && !['material', 'shoot'].includes(spec.storyboardSourcePlans?.[String(peer.slotId || peer.id || '')]?.userSource || ''))
        .map(peer => production[`${assemblyId}:${peer.id}`]?.presenterId).filter(Boolean));
      if (identityAssets.size > 1) return { ...base, route: 'digital_human', status: 'blocked', reason: '同一销售主讲人的分镜必须使用同一个企业人物资产' };
    }

    const materialIssue = enterpriseMaterialIssue({ material: assigned ? snapshots.get(assigned) : undefined, duration: Number(slot.duration) || 0, ratio: spec.ratio, sound: (choice === 'material' || choice === 'shoot') && shot?.source === 'avatar' ? 'voiceover' : shot?.sound, narration: shot?.narration });
    if (shot?.locked) return { ...base, route: assigned ? 'local_material' : 'unresolved',
      status: assigned ? (materialIssue ? 'needs_material' : 'matched') : 'blocked',
      reason: assigned ? materialIssue || '镜头已锁定，保留已绑定素材' : '镜头已锁定，未提交智能生成' };
    if (choice === 'material' || choice === 'shoot') return { ...base, route: 'local_material', status: assigned && !materialIssue ? 'matched' : 'needs_material', reason: materialIssue || (assigned ? '采用用户选择的企业素材' : choice === 'shoot' ? '待拍任务尚未上传回填' : '请选择企业素材') };
    // An assigned image may be a generation reference. It is not a finished
    // matched clip when the user explicitly chose the intelligent route.
    if (choice !== 'avatar' && !spokenOnScreen && !action
      && (sourcePlan?.mode === 'ai' || sourcePlan?.mode === 'hybrid' || shot?.source === 'ai')) {
      if (sourcePlan?.generatedClipId && sourcePlan.confirmed && assignedId === sourcePlan.generatedClipId) {
        return { ...base, route: 'local_material', status: 'matched', reason: '采用已确认的 AIGC 分镜候选' };
      }
      return { ...base, route: 'aigc_first_frame', status: 'needs_plan', reason: spec.mode === 'clone'
        ? sourcePlan?.firstFrameMaterialId ? '目标首帧已生成，按自动质检结果继续生成视频候选' : '需要先生成目标首帧，自动质检后继续制作视频'
        : sourcePlan?.firstFrameConfirmed && sourcePlan.firstFrameMaterialId
          ? '目标首帧已确认，等待生成视频候选并逐镜验收'
          : '需要先生成并确认目标首帧；批量入口不得跳过确认直接提交视频' };
    }
    // An unusable association is not a reason to make the user choose between
    // shooting and AIGC. Only an explicitly selected material/shooting route
    // keeps the material task open; otherwise non-presenter shots generate.
    if ((shot?.source !== 'avatar' || spec.storyboardSourcePlans?.[slotId]?.confirmed) && assigned && !materialIssue)
      return { ...base, route: 'local_material', status: 'matched', reason: '采用已绑定的企业素材' };
    if (visualTopic === 'presenter' || choice === 'avatar') {
      const missing = digitalHumanDecisionIssues(digitalHuman);
      if (!shot?.presenterId) missing.unshift('请选择企业人物');
      if (!digitalHuman?.presenterMode && (!digitalHuman?.replacementScope || !digitalHuman?.targetEffect)) {
        if (!missing.length) missing.push('请选择数字人替换范围和生成效果');
      }
      if (missing.length) return { ...base, route: 'digital_human', status: 'blocked', reason: missing.join('；') };
    }
    if (choice !== 'avatar' && salesPresenterRecognition(slot) === 'candidate') return { ...base, route: 'unresolved', status: 'blocked', reason: '系统人物识别复核尚未完成，暂不提交数字人生成' };
    if (visualTopic === 'presenter' && action) {
      return { ...base, route: 'seedance_action', status: 'blocked', reason: options.actionExecutorReady
        ? '动作镜头需建立逐镜首帧重建计划与授权后再提交现有执行接口'
        : '人物动作复刻执行器尚未接通，不能当作普通数字人口播生成' };
    }
    if (visualTopic === 'presenter') {
      if (digitalHuman && digitalHuman.method !== 'talking')
        return { ...base, route: 'seedance_action', status: 'needs_plan', reason: '已选择场景重建方案，请在数字人工作面板完成首帧和模型预检；批量制作保留该选择，不改用 HeyGen' };
      const presenterId = shot?.presenterId;
      const configuredPresenterIds = options.configuredPresenterIds ?? options.authorizedPresenterIds;
      if (!presenterId || !configuredPresenterIds.includes(presenterId))
        return { ...base, route: 'digital_human', status: 'blocked', reason: '缺少已授权且具备 HeyGen 人物、声音映射的企业销售资产' };
      const preflightIssues = options.presenterPreflightIssues?.[presenterId] ?? [];
      const presenterIssues = preflightIssues.length
        ? [`HeyGen 人物、音色或授权预检未通过：${preflightIssues.join('、')}`]
        : options.authorizedPresenterIds.includes(presenterId) ? [] : ['所选企业人物尚未通过 HeyGen 人物、音色或授权预检'];
      const orientation = options.presenterNativeOrientationsById?.[presenterId] || 'unknown';
      if (spec.ratio === '9:16' && digitalHuman?.presenterMode !== 'photo_talking' && !shot?.transparent && orientation !== 'portrait') {
        const name = options.presenterNamesById?.[presenterId] || '所选人物';
        presenterIssues.push(orientation === 'landscape'
          ? `${name} 的原生画幅为横屏；请选择竖屏人物，或将成片画幅改为 16:9`
          : `${name} 尚未确认原生竖屏画幅；请先完成人物画幅确认，选择竖屏人物，或将成片画幅改为 16:9`);
      }
      if (!options.talkingExecutorReady) presenterIssues.push('数字人口播执行器不可用');
      if (presenterIssues.length) return { ...base, route: 'digital_human', status: 'blocked', reason: presenterIssues.join('；') };
      if (!String(shot?.narration || '').trim() || String(shot?.narration || '').trim() === '无')
        return { ...base, route: 'digital_human', status: 'blocked', reason: '该镜缺少逐句口播文案' };
      return { ...base, route: 'digital_human', status: 'needs_plan', reason: '可在保存草稿后逐镜创建数字人计划，执行器预检通过才可提交生成' };
    }
    if (assigned && !materialIssue) return { ...base, route: 'local_material', status: 'matched', reason: '已有可用本地素材关联' };
    return { ...base, route: 'aigc_first_frame', status: 'needs_plan', reason: assigned
      ? `已关联本地素材不可用（${materialIssue}），自动准备目标首帧`
      : '没有可用本地素材，自动准备目标首帧' };
  });
}
