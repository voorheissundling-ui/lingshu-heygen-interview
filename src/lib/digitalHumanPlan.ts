import { backgroundQualityCheck } from './digitalHumanQuality.js';
import { digitalHumanDecisionIssues } from '../../shared/contracts/smartStoryboardAdmission.js';
import { effectiveDigitalHumanRequirements, type DigitalHumanReferenceCue, type DigitalHumanRequirements } from '../../shared/contracts/digitalHumanRequirements.js';
import { planPersonShotClusters } from './personShotClustering.js';
export type { DigitalHumanReferenceCue, DigitalHumanRequirements } from '../../shared/contracts/digitalHumanRequirements.js';

export type DigitalHumanPipelineId = 'pipeline_1' | 'pipeline_2' | 'pipeline_3';

/**
 * Product route boundary. Keep this mapping centralized so Pipeline 3 quality
 * rules cannot accidentally become global rules for every talking-head job.
 */
export function digitalHumanPipelineFor(requirements?: DigitalHumanRequirements): DigitalHumanPipelineId {
  requirements = effectiveDigitalHumanRequirements(requirements);
  if (!requirements || requirements.method === 'talking') return 'pipeline_1';
  if (requirements.method === 'reenact' && (requirements.replicationMode || 'sentence_first_frame') === 'sentence_first_frame') return 'pipeline_3';
  return 'pipeline_2';
}

export const newDigitalHumanRequirements = (): DigitalHumanRequirements => ({
  workflow: 'material_processing', method: 'talking', preferredProvider: 'auto', replicationMode: 'sentence_first_frame', contentConfirmed: false,
  action: '', scene: '', preserve: '',
});

/** Evidence required before a source video may leave the tenant boundary for generation. */
export function referenceModelInputAuthorization(requirements: DigitalHumanRequirements | undefined, confirmedAt: string): { evidence: string; confirmedAt: string } | null {
  requirements = effectiveDigitalHumanRequirements(requirements);
  if (!requirements || requirements.method === 'talking') return null;
  if (requirements.method === 'reenact' && (requirements.replicationMode || 'sentence_first_frame') === 'sentence_first_frame') return null;
  const reference = requirements.reference;
  const evidence = requirements.method === 'replace' ? reference?.derivativeAuthorizationEvidence : reference?.modelInputAuthorizationEvidence;
  const authorized = requirements.method === 'replace' ? reference?.derivativeAuthorized : reference?.modelInputAuthorized;
  return authorized === true && evidence?.trim() && evidence.trim().length <= 500 ? { evidence: evidence.trim(), confirmedAt } : null;
}

export interface DigitalHumanPlan {
  state: 'needs_input' | 'needs_confirmation' | 'preview_only' | 'ready';
  executable: boolean;
  reasons: string[];
  steps: string[];
  provider: 'heygen' | 'local_head_pipeline' | 'runway_seedance' | 'runway_kling_motion' | 'runway_act_two' | 'self_hosted_video' | null;
}

export type DigitalHumanRouteStepStatus = 'completed' | 'ready' | 'blocked' | 'running' | 'attention' | 'failed';
export interface DigitalHumanRouteStep {
  id: 'source_alignment' | 'generation' | 'automatic_quality' | 'manual_review' | 'assembly';
  label: string;
  actor: 'system' | 'provider' | 'user';
  tool: string | null;
  dependsOn: DigitalHumanRouteStep['id'][];
  status: DigitalHumanRouteStepStatus;
}

export interface DigitalHumanPlanRecord extends DigitalHumanPlan {
  id: string;
  projectId: string;
  assemblyId: string;
  shotId: string;
  fingerprint: string;
  pipeline: DigitalHumanPipelineId;
  workflow: DigitalHumanRequirements['workflow'];
  method: DigitalHumanRequirements['method'];
  presenterId: string;
  presenterAssetVersion: number;
  candidateTools: string[];
  estimatedCostCny: number | null;
  origin?: 'manual' | 'content_agent';
  sourceTaskId?: string;
  sourceTaskVersion?: string;
  inputSnapshot?: DigitalHumanInputSnapshot;
  routeSteps?: DigitalHumanRouteStep[];
  routeDecision?: DigitalHumanRouteDecision | null;
  createdAt: string;
  updatedAt: string;
}

export interface SentenceReplicationResult {
  cues: DigitalHumanReferenceCue[];
  materialId: string;
  candidateUrl?: string;
  providerTaskIds?: string[];
  executionId?: string;
  sentenceJobId?: string;
  candidateOutput?: { materialId: string; objectKey?: string; localFile?: string; contentSha256: string; objectEtag?: string };
  cueQuality?: SentenceCueQuality[];
  failedCueIds?: string[];
  state: 'completed';
}

export interface SentenceCueQuality {
  cueId: string;
  kind: 'person_generated' | 'non_person_material';
  state: 'manual_review' | 'failed' | 'accepted';
  checks: Array<{ key: 'media' | 'identity' | 'motion' | 'product_brand_text' | 'background' | 'audio_sync' | 'reuse_risk'; status: 'passed' | 'failed' | 'pending'; evidence: string }>;
}

export interface SentenceFirstFrameDraftResult {
  cues: DigitalHumanReferenceCue[];
  operationIds: string[];
  estimatedCostCny: number;
  provider: 'qwen';
  state: 'completed';
}

export interface DigitalHumanRouteDecision {
  targetDurationSeconds: number | null;
  budgetLimitCny?: number | null;
  requiredPreservation: string[];
  selectedTool: string | null;
  evaluations: Array<{ tool: string; compatible: boolean; reasons: string[]; qualityInspection: boolean; estimatedCostCny: number | null }>;
}

export interface DigitalHumanInputSnapshot {
  narration: string;
  language: string;
  ratio: string;
  targetDurationSeconds: number | null;
  sound: 'voiceover' | 'source' | 'silent';
  presenterId: string;
  presenterAssetVersion: number;
  presenterReferenceMaterialIds: string[];
  presenterInput?: { materialId: string; objectKey: string; type?: 'image' | 'video'; objectEtag?: string } | null;
  voiceMapping: { avatarId: string; voiceId: string } | null;
  productId: string;
  productMaterialId: string;
  backgroundMaterialId: string;
  requirements: DigitalHumanRequirements | null;
  revisionFeedback?: string | null;
  audioSegment?: { segmentId: string; checksumSha256: string; start: number; duration: number } | null;
  referenceInput?: { materialId: string; clipObjectKey: string; start: number; duration: number; sourceObjectEtag?: string; clipObjectEtag?: string } | null;
  derivativeAuthorization?: { evidence: string; confirmedAt: string } | null;
  modelInputAuthorization?: { evidence: string; confirmedAt: string } | null;
}

export interface DigitalHumanExecutionRecord {
  id: string;
  planId: string;
  jobId: string;
  projectId: string;
  assemblyId: string;
  shotId: string;
  fingerprint: string;
  tool: string;
  provider: string;
  model: string | null;
  presenterAssetVersion: number;
  /** Whether the supplier task was created. Missing on legacy records and counted conservatively. */
  submissionOutcome?: 'created' | 'unknown' | 'rejected';
  inputSnapshot?: DigitalHumanInputSnapshot;
  candidateOutput?: { materialId: string; objectKey?: string; localFile?: string; contentSha256: string; objectEtag?: string } | null;
  routeSteps?: DigitalHumanRouteStep[];
  adoption?: { candidateId: string; materialId: string; assemblyVersion: string; adoptedAt: string; planId?: string; fingerprint?: string; presenterAssetVersion?: number; qualityReviewedAt?: string; candidateObjectKey?: string; candidateLocalFile?: string; candidateContentSha256?: string; candidateObjectEtag?: string } | null;
  state: 'submitting' | 'pending' | 'completed' | 'failed' | 'uncertain' | 'cancelled';
  externalTaskId: string | null;
  materialId: string | null;
  estimatedCostCny: number | null;
  actualCostCny: number | null;
  costStatus: 'estimated' | 'awaiting_invoice' | 'reconciled';
  costSourceRef: string | null;
  error: string;
  quality: import('./digitalHumanQuality').DigitalHumanQualityReport;
  createdAt: string;
  updatedAt: string;
}

export function digitalHumanRouteSteps(method: DigitalHumanRequirements['method'], provider: string | null, executable: boolean, planState?: DigitalHumanPlan['state']): DigitalHumanRouteStep[] {
  const generationLabel = method === 'talking' ? '生成人物口播' : method === 'replace' ? '执行人物替换' : '生成参考重演';
  const inputStatus: DigitalHumanRouteStepStatus = planState === 'needs_input' ? 'attention' : planState === 'needs_confirmation' ? 'ready' : 'completed';
  return [
    { id: 'source_alignment', label: method === 'talking' ? '确认人物与口播输入' : '确认原片、逐句映射与保留要求', actor: 'system', tool: null, dependsOn: [], status: inputStatus },
    { id: 'generation', label: generationLabel, actor: 'provider', tool: provider, dependsOn: ['source_alignment'], status: executable ? 'ready' : 'blocked' },
    { id: 'automatic_quality', label: '自动媒体与画面检查', actor: 'system', tool: null, dependsOn: ['generation'], status: 'blocked' },
    { id: 'assembly', label: '自动采用合格候选并填入分镜', actor: 'system', tool: null, dependsOn: ['automatic_quality'], status: 'blocked' },
  ];
}

export function usesDirectReferenceVideo(requirements?: DigitalHumanRequirements): boolean {
  requirements = effectiveDigitalHumanRequirements(requirements);
  if (!requirements || requirements.method === 'talking') return false;
  if (requirements.method === 'replace') return true;
  return requirements.replicationMode === 'direct_reference';
}

export function cueFirstFrameTime(cue: DigitalHumanReferenceCue): number {
  const explicit = Number(cue.sourceFirstFrame?.time);
  return Number.isFinite(explicit) && explicit >= cue.start && explicit < cue.end ? explicit : cue.start;
}

export function routeStepsForExecution(
  steps: DigitalHumanRouteStep[],
  state: DigitalHumanExecutionRecord['state'],
  quality: import('./digitalHumanQuality').DigitalHumanQualityReport,
  assembled = false,
): DigitalHumanRouteStep[] {
  const automatic = quality.checks.filter(check => check.mode === 'automatic' && !backgroundQualityCheck(check.key));
  const automaticFailed = automatic.some(check => check.status === 'failed');
  const automaticPassed = automatic.length > 0 && automatic.every(check => check.status === 'passed');
  return steps.map(step => {
    if (step.id === 'source_alignment') return { ...step, status: 'completed' };
    if (step.id === 'generation') return { ...step, status: state === 'completed' ? 'completed' : state === 'failed' || state === 'cancelled' ? 'failed' : state === 'uncertain' ? 'attention' : 'running' };
    if (step.id === 'automatic_quality') return { ...step, status: automaticFailed ? 'failed' : automaticPassed ? 'completed' : state === 'completed' ? 'running' : 'blocked' };
    if (step.id === 'manual_review') return { ...step, status: quality.reviewedAt ? 'completed' : state === 'completed' ? 'ready' : 'blocked' };
    return { ...step, status: assembled ? 'completed' : quality.state === 'accepted' ? 'ready' : 'blocked' };
  });
}

export function candidateToolsFor(requirements?: DigitalHumanRequirements): string[] {
  requirements = effectiveDigitalHumanRequirements(requirements);
  if (!requirements || requirements.method === 'talking') return ['heygen'];
  const preference = requirements.preferredProvider || 'auto';
  if (preference === 'kling') return ['runway_kling_motion'];
  if (preference === 'sd') return ['runway_seedance'];
  if (preference === 'runway') return requirements.method === 'reenact' ? ['runway_act_two'] : [];
  if (preference === 'self_hosted') return requirements.method === 'replace' ? ['local_head_pipeline'] : ['self_hosted_video'];
  // Act-Two creates a new performance from a character asset and a driving video. It does
  // not replace the person inside the original pixels, so it must never be advertised for
  // the keep-the-original-shot replacement route.
  if (requirements.method === 'replace') return ['local_head_pipeline', 'runway_kling_motion'];
  return ['runway_kling_motion', 'runway_seedance', 'runway_act_two', 'self_hosted_video'];
}

export function referenceCues(requirements?: DigitalHumanRequirements): DigitalHumanReferenceCue[] {
  const reference = requirements?.reference;
  if (!reference) return [];
  if (Array.isArray(reference.cues) && reference.cues.length) return reference.cues;
  if (!reference.originalText.trim() || !Number.isFinite(reference.start) || !Number.isFinite(reference.end) || reference.end <= reference.start) return [];
  return [{ id: 'legacy-reference', start: reference.start, end: reference.end, originalText: reference.originalText, targetText: '', shotIds: [] }];
}

/**
 * A manually confirmed sales-presenter slot is stronger evidence than a stale
 * or missing per-cue classifier result. Keep the override deliberately narrow:
 * only a whole-slot manual confirmation can create a cue or reclassify the
 * sole cue. Multi-cut analysis and unconfirmed slots remain untouched.
 */
export function referenceCuesForConfirmedPresenter(
  requirements: DigitalHumanRequirements | undefined,
  context: {
    shotId: string;
    slotId?: string;
    start?: number;
    end?: number;
    duration?: number;
    narration?: string;
    salesPresenterConfirmed?: boolean;
    observedPresenterRole?: string;
    needsReview?: boolean;
    personContinuityId?: string;
  },
): DigitalHumanReferenceCue[] {
  const cues = referenceCues(requirements);
  const manuallyConfirmed = context.salesPresenterConfirmed === true
    && context.observedPresenterRole === 'sales_presenter'
    && context.needsReview !== true
    && Boolean(context.personContinuityId?.trim());
  if (!manuallyConfirmed) return cues;
  const narration = String(context.narration || '').trim();
  const markConfirmed = (cue: DigitalHumanReferenceCue): DigitalHumanReferenceCue => ({
    ...cue,
    personShot: true,
    classificationSource: 'manual',
    compositionClusterId: cue.compositionClusterId || `${context.shotId}:confirmed-sales-presenter`,
    targetText: cue.targetText?.trim() || narration,
    shotIds: Array.isArray(cue.shotIds) && cue.shotIds.length ? cue.shotIds : [context.slotId || context.shotId],
  });
  if (cues.length === 1) {
    const cue = cues[0]!;
    const confirmedText = cue.targetText?.trim() || narration;
    if (!confirmedText || confirmedText === '无') return cues;
    const slotIdentity = context.slotId || context.shotId;
    const mappedToSlot = !Array.isArray(cue.shotIds) || !cue.shotIds.length
      || cue.shotIds.includes(slotIdentity) || cue.shotIds.includes(context.shotId);
    const duration = Number(context.duration);
    const coversWholeSlot = !Number.isFinite(duration) || duration <= 0
      || Math.abs((cue.end - cue.start) - duration) < 0.2;
    const slotStart = Number(context.start);
    const slotEnd = Number(context.end);
    const hasSlotWindow = Number.isFinite(slotStart) && Number.isFinite(slotEnd) && slotEnd > slotStart;
    const cueDuration = cue.end - cue.start;
    const overlap = hasSlotWindow ? Math.max(0, Math.min(cue.end, slotEnd) - Math.max(cue.start, slotStart)) : 0;
    const coversSameWindow = !hasSlotWindow || (cueDuration > 0
      && overlap / Math.max(cueDuration, slotEnd - slotStart) >= 0.9);
    return mappedToSlot && coversWholeSlot && coversSameWindow ? [markConfirmed(cue)] : cues;
  }
  if (cues.length > 1 || !narration || narration === '无') return cues;

  const reference = requirements?.reference;
  const referenceStart = Number(reference?.start);
  const slotStart = Number(context.start);
  const start = Number.isFinite(referenceStart) && referenceStart >= 0
    ? referenceStart
    : Number.isFinite(slotStart) && slotStart >= 0 ? slotStart : 0;
  const referenceEnd = Number(reference?.end);
  const slotEnd = Number(context.end);
  const duration = Number(context.duration);
  const end = Number.isFinite(referenceEnd) && referenceEnd > start
    ? referenceEnd
    : Number.isFinite(slotEnd) && slotEnd > start
      ? slotEnd
      : Number.isFinite(duration) && duration > 0 ? start + duration : NaN;
  if (!Number.isFinite(end) || end <= start) return cues;
  return [markConfirmed({
    id: `${context.shotId}:confirmed-sales-presenter`,
    start,
    end,
    originalText: String(reference?.originalText || narration).trim(),
    targetText: narration,
    shotIds: [context.slotId || context.shotId],
  })];
}

/** Legacy talking shots keep their existing confirmation flow. No implicit fallback. */
export function planDigitalHumanShot(input: {
  requirements?: DigitalHumanRequirements;
  narration: string;
  hasAuthorizedPresenter: boolean;
  talkingAvailable: boolean;
  /** True only when the sentence-first-frame Seedream + Seedance runtime passed preflight. */
  seedanceSentenceAvailable?: boolean;
  presenterCapabilities?: Array<'talking' | 'reference_image' | 'reference_video' | 'person_replacement'>;
}): DigitalHumanPlan {
  const r = effectiveDigitalHumanRequirements(input.requirements);
  const reasons: string[] = digitalHumanDecisionIssues(r);
  if (!input.hasAuthorizedPresenter) reasons.push('请选择已授权的企业人物');
  if (input.presenterCapabilities && r?.method === 'talking' && !input.presenterCapabilities.includes('talking')) reasons.push('所选人物缺少口播能力，请补充人物与声音映射');
  if (input.presenterCapabilities && r && r.method !== 'talking' && !input.presenterCapabilities.some(item => ['reference_image', 'reference_video', 'person_replacement'].includes(item))) reasons.push('所选人物缺少参考图片或视频资产');
  if (!input.narration?.trim()) reasons.push('请填写本镜头口播');
  if (r && (!['material_processing', 'viral_replication'].includes(r.workflow) || !['talking', 'replace', 'reenact'].includes(r.method))) reasons.push('镜头制作方式无效');
  const referenceDriven = r && (r.workflow === 'viral_replication' || r.method !== 'talking');
  if (referenceDriven) {
    const ref = r.reference;
    if (!ref?.videoUrl?.trim() || !Number.isFinite(ref.start) || !Number.isFinite(ref.end) || ref.start < 0 || ref.end <= ref.start) reasons.push('请补齐原片与有效的镜头时间段');
    if (!ref?.originalText?.trim()) reasons.push('请补齐原片对应语句');
    const cues = referenceCues(r);
    if (!cues.length || cues.some(cue => !cue.id?.trim() || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || !cue.originalText?.trim())) reasons.push('原片逐句时间轴不完整');
    if (cues.some(cue => cue.splitFromCueId && (cue.personShot === undefined || (cue.personShot === true && !cue.targetText.trim())))) reasons.push('拆分后的每个物理镜头须指定类型，并为人物镜头填写本片对应语句');
    if (cues.some(cue => !Array.isArray(cue.shotIds))) reasons.push('原片语句与分镜映射无效');
    if (r.method === 'reenact' && (r.replicationMode || 'sentence_first_frame') === 'sentence_first_frame' && cues.length) reasons.push(...planPersonShotClusters(cues,3).blockers);
    if (r.method !== 'talking' && (!r.action?.trim() || !r.scene?.trim())) reasons.push('请补齐人物动作与场景要求');
    if (r.method !== 'talking' && !r.preserve?.trim()) reasons.push('请明确需要保留的画面内容');
    if (r.method === 'replace' && ref?.derivativeAuthorized !== true) reasons.push('保留原镜头替换人物需要确认源视频派生使用授权');
    if (r.method === 'replace' && ref?.derivativeAuthorized === true && (!ref.derivativeAuthorizationEvidence?.trim() || ref.derivativeAuthorizationEvidence.trim().length > 500)) reasons.push('请填写有效的源视频派生授权依据');
  }
  const steps = r?.method === 'replace'
    ? ['对齐原片语句与镜头', '制作目标人物层', '核验动作、产品与背景保真', '预览确认后填入分镜']
    : r?.method === 'reenact' && (r.replicationMode || 'sentence_first_frame') === 'sentence_first_frame'
      ? ['按口播逐句切分原片并提取首帧', '将每句首帧重建为目标企业人物', '按目标口播逐句生成短视频', '按实际片长拼接并自动检测']
      : r?.method === 'reenact'
        ? ['对齐原片语句与镜头', '将授权原片提交为动作参考', '生成动作视频与口播', '预览确认后填入分镜']
      : ['使用已确认人物与口播', '生成数字人口播', '核验音画与时长', '预览确认后填入分镜'];
  if (reasons.length) return { state: 'needs_input', executable: false, reasons, steps, provider: null };
  if (r?.method === 'reenact' && (r.replicationMode || 'sentence_first_frame') === 'sentence_first_frame') {
    if (input.seedanceSentenceAvailable) return { state: 'ready', executable: true, reasons: [], steps, provider: 'runway_seedance' };
    return { state: 'preview_only', executable: false, reasons: ['Seedream + Seedance 逐句复刻服务尚未通过运行环境预检'], steps, provider: null };
  }
  if (r && r.method !== 'talking') return { state: 'preview_only', executable: false, reasons: ['仅支持方案预览：参考人物制作链尚未接通，不会改用口播接口生成'], steps, provider: null };
  // Talking APIs do not honor custom motion or scene constraints.
  if (r && [r.action, r.scene, r.preserve].some(value => value?.trim())) return { state: 'preview_only', executable: false, reasons: ['当前口播链无法执行自定义动作、场景或画面保留要求，仅支持方案预览'], steps, provider: null };
  if (!input.talkingAvailable) return { state: 'preview_only', executable: false, reasons: ['数字人口播服务尚未配置或启用'], steps, provider: null };
  return { state: 'ready', executable: true, reasons: [], steps, provider: 'heygen' };
}
