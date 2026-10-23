export type CreationMode = 'viral_remix' | 'material_first' | 'product_first';
export type TransformationMode = 'talking_avatar' | 'face_swap' | 'head_swap' | 'person_replace' | 'product_replace' | 'structure_remake';
export type PresenterMode = 'original' | 'digital_human' | 'voiceover_broll' | 'none';
export type PersonStrategyMode = 'fast' | 'expert' | 'creative';
export type PersonStrategyFeasibility = 'full_fidelity' | 'functional_equivalent' | 'goal_degraded' | 'blocked_for_facts_or_rights';
export type PersonSourceKind = 'customer_asset' | 'licensed_asset' | 'external_reference';
export type ShotPurpose = 'hook' | 'need' | 'feature' | 'value' | 'proof' | 'cta';

export interface RightsDeclaration {
  referenceVideo: 'cleared' | 'unknown' | 'not_required';
  sourcePerson: 'cleared' | 'unknown' | 'not_required';
  targetPerson: 'cleared' | 'unknown' | 'not_required';
  voice: 'cleared' | 'unknown' | 'not_required';
  productBrand: 'cleared' | 'unknown' | 'not_required';
}

export interface PersonExecutionStrategyInput {
  requestedMode: PersonStrategyMode | 'auto';
  sourceKind: PersonSourceKind;
  rights: RightsDeclaration;
  source: TransformationAssessmentInput['source'];
  targetDurationSeconds: number;
  budgetCredits?: number;
  maxAttempts?: number;
}

export interface PersonExecutionStrategy {
  mode: PersonStrategyMode;
  transformationMode: 'head_swap' | 'person_replace' | 'structure_remake';
  feasibility: PersonStrategyFeasibility;
  status: 'ready' | 'review' | 'blocked';
  publicMethodLabel: string;
  lockedElements: string[];
  internalProviderRoute: string[];
  estimatedCredits: number;
  maxAttempts: number;
  fallbackMode?: 'expert' | 'creative';
  blockers: string[];
  warnings: string[];
  requiredQa: string[];
}

export interface ShotRequirement {
  id: string;
  purpose: ShotPurpose;
  narration: string;
  requiredEvidence: string[];
  truthCritical: boolean;
  presenterAllowed: boolean;
  aiVisualAllowed: boolean;
  targetDurationSeconds: number;
  targetRatio: string;
}

export interface MaterialCandidate {
  id: string;
  semanticScore: number;
  evidenceScore: number;
  actionScore: number;
  durationScore: number;
  formatScore: number;
  isAuthenticEvidence: boolean;
  rightsCleared: boolean;
}

export interface MaterialMatch {
  shotId: string;
  materialId: string;
  semanticScore: number;
  evidenceScore: number;
  actionScore: number;
  durationScore: number;
  formatScore: number;
  totalScore: number;
  decision: 'direct' | 'process' | 'blocked';
  blockers: string[];
  allowedFallbacks: Array<'replace_material' | 'reshoot' | 'digital_human' | 'voiceover_broll' | 'ai_assist' | 'delete_or_merge'>;
}

const clampScore = (value: number, maximum: number) => Math.max(0, Math.min(maximum, Number(value) || 0));

export function assessMaterialCandidate(shot: ShotRequirement, material: MaterialCandidate): MaterialMatch {
  const semanticScore = clampScore(material.semanticScore, 40);
  const evidenceScore = clampScore(material.evidenceScore, 25);
  const actionScore = clampScore(material.actionScore, 15);
  const durationScore = clampScore(material.durationScore, 10);
  const formatScore = clampScore(material.formatScore, 10);
  const totalScore = semanticScore + evidenceScore + actionScore + durationScore + formatScore;
  const blockers: string[] = [];
  if (!material.rightsCleared) blockers.push('素材授权状态未确认');
  if (shot.truthCritical && !material.isAuthenticEvidence) blockers.push('事实证明镜头缺少真实证据');
  if (shot.truthCritical && evidenceScore < 15) blockers.push('事实支撑能力不足');

  let decision: MaterialMatch['decision'] = totalScore >= 80 ? 'direct' : totalScore >= 60 ? 'process' : 'blocked';
  if (blockers.length) decision = 'blocked';
  const allowedFallbacks: MaterialMatch['allowedFallbacks'] = ['replace_material', 'reshoot'];
  if (!shot.truthCritical && shot.presenterAllowed) allowedFallbacks.push('digital_human', 'voiceover_broll');
  if (!shot.truthCritical && shot.aiVisualAllowed) allowedFallbacks.push('ai_assist');
  if (!shot.truthCritical) allowedFallbacks.push('delete_or_merge');
  return {
    shotId: shot.id,
    materialId: material.id,
    semanticScore,
    evidenceScore,
    actionScore,
    durationScore,
    formatScore,
    totalScore,
    decision,
    blockers,
    allowedFallbacks,
  };
}

export interface TransformationAssessmentInput {
  mode: TransformationMode;
  rights: RightsDeclaration;
  source: {
    personCount?: number;
    continuousShot?: boolean;
    durationSeconds?: number;
    faceForwardRatio?: number;
    maximumOcclusionRatio?: number;
    productVisibleRatio?: number;
    productCount?: number;
    productCategory?: string;
    targetProductCategory?: string;
    gripSimilarity?: number;
    transparentOrReflective?: boolean;
  };
}

export interface TransformationAssessment {
  status: 'compatible' | 'review' | 'blocked';
  blockers: string[];
  warnings: string[];
  requiredQa: string[];
  recommendedMode: TransformationMode;
}

function requireRight(value: RightsDeclaration[keyof RightsDeclaration], label: string, blockers: string[]) {
  if (value === 'unknown') blockers.push(`${label}授权未确认`);
}

export function assessTransformation(input: TransformationAssessmentInput): TransformationAssessment {
  const { mode, rights, source } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  requireRight(rights.referenceVideo, '参考视频', blockers);
  requireRight(rights.voice, '声音', blockers);
  if (['talking_avatar', 'face_swap', 'head_swap', 'person_replace'].includes(mode)) requireRight(rights.targetPerson, '目标人物', blockers);
  if (['face_swap', 'head_swap', 'person_replace'].includes(mode)) requireRight(rights.sourcePerson, '原出镜人物', blockers);
  if (mode === 'product_replace') requireRight(rights.productBrand, '商品与品牌', blockers);

  if ((source.personCount || 1) !== 1 && mode !== 'structure_remake') blockers.push('MVP只支持单人物');
  if (source.continuousShot === false && ['face_swap', 'head_swap', 'product_replace'].includes(mode)) warnings.push('多镜头必须拆分后逐镜处理');
  if ((source.durationSeconds || 0) > 15 && mode !== 'structure_remake') warnings.push('MVP建议先截取15秒以内片段');

  if (mode === 'face_swap' || mode === 'head_swap') {
    if ((source.faceForwardRatio || 0) < 0.8) blockers.push('正脸至轻侧脸覆盖率低于80%');
    if ((source.maximumOcclusionRatio || 0) > 0.2) blockers.push('面部遮挡超过20%');
  }
  if (mode === 'product_replace') {
    if ((source.productCount || 0) !== 1) blockers.push('商品替换MVP只支持单商品');
    if ((source.productVisibleRatio || 0) < 0.8) blockers.push('商品可见帧低于80%');
    if (source.transparentOrReflective) blockers.push('透明、镜面或高反光商品暂不自动替换');
    if ((source.gripSimilarity || 0) < 0.75) blockers.push('新旧商品握持方式差异过大');
    if (source.productCategory && source.targetProductCategory && source.productCategory !== source.targetProductCategory) {
      warnings.push('跨品类替换需要人工确认握持与比例');
    }
  }
  if (mode === 'person_replace') warnings.push('完整人物替换进入云端实验线，不承诺本地自动交付');

  const requiredQa = mode === 'product_replace'
    ? ['原商品残留', '商品轨迹', '手部遮挡', '接触点', '品牌外观', '光照与运动模糊']
    : ['人物身份', '脸颈肤色', '口型同步', '牙齿与唇缘', '遮挡', '跨帧闪烁'];
  return {
    status: blockers.length ? 'blocked' : warnings.length ? 'review' : 'compatible',
    blockers,
    warnings,
    requiredQa,
    recommendedMode: blockers.length && mode !== 'structure_remake' ? 'structure_remake' : mode,
  };
}

export function buildPersonExecutionStrategy(input: PersonExecutionStrategyInput): PersonExecutionStrategy {
  const strictSource = input.sourceKind !== 'external_reference';
  const inferred: PersonStrategyMode = input.sourceKind === 'external_reference'
    ? 'creative'
    : /full|全身/i.test(String((input.source as Record<string, unknown>).framing || '')) ? 'expert' : 'fast';
  const mode = input.requestedMode === 'auto' ? inferred : input.requestedMode;
  const transformationMode = mode === 'fast' ? 'head_swap' : mode === 'expert' ? 'person_replace' : 'structure_remake';
  const assessment = assessTransformation({ mode: transformationMode, rights: input.rights, source: input.source });
  const blockers = [...assessment.blockers];
  if (!strictSource && mode !== 'creative') blockers.push('外部参考仅可用于结构分析，不能直接编辑原画面');
  const feasibility: PersonStrategyFeasibility = blockers.length
    ? 'blocked_for_facts_or_rights'
    : mode === 'creative' && input.sourceKind === 'external_reference'
      ? 'functional_equivalent'
      : assessment.status === 'review' ? 'goal_degraded' : 'full_fidelity';
  const seconds = Math.max(0, Math.min(30, Number(input.targetDurationSeconds) || 0));
  const estimatedCredits = mode === 'fast' ? 0 : Math.ceil(seconds * (mode === 'expert' ? 5 : 30));
  if (Number.isFinite(input.budgetCredits) && estimatedCredits > Number(input.budgetCredits)) blockers.push('预计生成积分超过本镜头预算');
  const finalFeasibility = blockers.length ? 'blocked_for_facts_or_rights' : feasibility;
  return {
    mode,
    transformationMode,
    feasibility: finalFeasibility,
    status: blockers.length ? 'blocked' : assessment.status === 'compatible' ? 'ready' : 'review',
    publicMethodLabel: mode === 'fast' ? '保留原表演，精准替换头部人物特征' : mode === 'expert' ? '保留原表演，更换完整人物' : '按参考镜头功能重新演绎',
    lockedElements: mode === 'creative' ? ['原口播核心信息', '品牌禁用项与授权边界', '目标人物身份'] : ['构图与机位', '人物位置与姿势', '身体动作与手势节奏', '口播与口型时序', '时长、剪辑点与原音轨'],
    internalProviderRoute: mode === 'fast' ? ['local_head_pipeline'] : mode === 'expert' ? ['runway_kling_motion'] : ['runway_seedance', 'runway_kling_motion', 'runway_act_two'],
    estimatedCredits,
    maxAttempts: Math.max(1, Math.min(3, Math.floor(Number(input.maxAttempts) || 2))),
    ...(mode === 'fast' ? { fallbackMode: 'expert' as const } : mode === 'expert' ? { fallbackMode: 'creative' as const } : {}),
    blockers,
    warnings: assessment.warnings,
    requiredQa: assessment.requiredQa,
  };
}

export function commercialDigitalHumanGate(report: {
  passed?: boolean;
  lipSyncScore?: number;
  avOffsetFrames?: number;
  freezeSegments?: number;
  faceDetectionRate?: number;
  mouthJumpP95?: number;
}, quality: 'fast' | 'quality') {
  const failures: string[] = [];
  const confidenceMin = quality === 'quality' ? 7 : 4;
  const offsetMax = quality === 'quality' ? 1 : 2;
  if (report.passed !== true) failures.push('底层质量报告未通过');
  if (!Number.isFinite(report.lipSyncScore) || Number(report.lipSyncScore) < confidenceMin) failures.push(`SyncNet置信度低于${confidenceMin}`);
  if (!Number.isFinite(report.avOffsetFrames) || Math.abs(Number(report.avOffsetFrames)) > offsetMax) failures.push(`音画偏移超过${offsetMax}帧`);
  if (Number(report.freezeSegments || 0) > 0) failures.push('检测到冻结片段');
  if (report.faceDetectionRate != null && Number(report.faceDetectionRate) < 0.98) failures.push('人脸跟踪率低于98%');
  if (report.mouthJumpP95 != null && Number(report.mouthJumpP95) > 0.085) failures.push('嘴部时序跳变超标');
  return { passed: failures.length === 0, failures, thresholds: { confidenceMin, offsetMax } };
}
