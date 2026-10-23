import type { DigitalHumanRequirements } from './digitalHumanPlan';

export type DigitalHumanQualityCheck = {
  key: string;
  label: string;
  mode: 'automatic' | 'manual';
  status: 'pending' | 'passed' | 'failed';
  evidence: string | null;
};

export interface DigitalHumanQualityReport {
  state: 'pending' | 'failed' | 'manual_review' | 'accepted';
  checks: DigitalHumanQualityCheck[];
  reviewNote?: string | null;
  reviewedAt?: string | null;
  updatedAt: string;
}

/** Production admission is separate from optional human review. Pending manual
 * observations stay pending; background similarity is diagnostic only. */
export function backgroundQualityCheck(key: string): boolean {
  return key === 'reference_background_proxy' || key === 'background' || key.endsWith(':background');
}
export function digitalHumanQualityState(checks: DigitalHumanQualityCheck[]): DigitalHumanQualityReport['state'] {
  const required = checks.filter(check => !backgroundQualityCheck(check.key));
  if (required.some(check => check.status === 'failed')) return 'failed';
  if (!required.some(check => check.key === 'media_import' && check.status === 'passed')
    || required.some(check => check.mode === 'automatic' && check.status === 'pending')) return 'pending';
  return 'accepted';
}

/** Preserve every cue decision without fabricating a human review timestamp. */
export function sentenceExecutionQuality(cues: import('./digitalHumanPlan').SentenceCueQuality[] | undefined, materialId: string, now = new Date().toISOString()): DigitalHumanQualityReport {
  const checks: DigitalHumanQualityCheck[] = [
    {key:'media_import', label:'候选媒体有效',mode:'automatic',status: cues?.length ? 'passed' : 'pending',evidence: `material:${materialId}`},
    ...(cues || []).flatMap(cue => cue.checks.map(check => ({key:`${cue.cueId}:${check.key}`, label:`${cue.cueId} · ${check.key}`,mode:check.status === 'pending' ? 'manual' as const : 'automatic' as const,status:check.status,evidence:check.evidence}))),
  ];
  return {state:digitalHumanQualityState(checks), checks, updatedAt:now};
}

export interface ReferenceTechnicalMetrics {
  durationDeltaFrames: number;
  audioCorrelation: number | null;
  temporalMotionDifference: number;
  freezeMismatchRatio: number;
  comparedFrames: number;
}

export interface ReferenceVisualMetrics {
  normalizedPoseError: number | null;
  posePairCount: number;
  handPckAt008: number | null;
  handPairCount: number;
  wristSeparationMae: number | null;
  wristMotionCorrelation: number | null;
  wristPosePairCount: number;
  backgroundSsim: number | null;
  landmarkArtifactCount: number;
  /** Appearance proxy is evidence for review only and never passes identity. */
  faceAppearanceCorrelationProxy?: number | null;
  facePairCount?: number;
}

export type ModelQualityKey = 'identity' | 'product_fidelity' | 'local_artifacts';
export interface ModelQualityDecision {
  passed: boolean;
  confidence: number;
  evidence: string;
  model: string;
}

function manual(key: string, label: string): DigitalHumanQualityCheck {
  return { key, label, mode: 'manual', status: 'pending', evidence: null };
}

export function initialDigitalHumanQuality(requirements?: DigitalHumanRequirements, now = new Date().toISOString()): DigitalHumanQualityReport {
  const referenceDriven = requirements?.method === 'replace' || requirements?.method === 'reenact';
  return {
    state: 'pending',
    checks: [
      { key: 'media_import', label: '视频文件、画幅、分辨率与音轨通过入库检查', mode: 'automatic', status: 'pending', evidence: null },
      manual('identity', '企业人物身份与资产版本一致'),
      manual('speech', '口播语句完整，声音与音画同步可接受'),
      manual('lip_sync', '口型与发音观感可接受'),
      ...(referenceDriven ? [
        { key: 'reference_duration', label: '候选视频时长与参考分镜一致', mode: 'automatic' as const, status: 'pending' as const, evidence: null },
        { key: 'reference_audio', label: '参考音轨保留或替换结果符合制作要求', mode: 'automatic' as const, status: 'pending' as const, evidence: null },
        { key: 'reference_motion', label: '未发现明显停帧或运动节奏异常', mode: 'automatic' as const, status: 'pending' as const, evidence: null },
        { key: 'reference_pose_proxy', label: '姿态与手部时间轴代理指标通过', mode: 'automatic' as const, status: 'pending' as const, evidence: null },
        { key: 'reference_background_proxy', label: '人物区域外背景结构代理指标通过', mode: 'automatic' as const, status: 'pending' as const, evidence: null },
        { key: 'reference_artifacts_proxy', label: '未检测到明显关键点跳变代理异常', mode: 'automatic' as const, status: 'pending' as const, evidence: null },
        manual('reference_timing', '逐句时间与参考分镜对齐'),
        manual('action_scene', '动作与场景满足本镜头要求'),
        manual('product_fidelity', '产品与附件外观、文字和结构保持正确'),
        manual('local_artifacts', '人物边缘、手部与产品交界处无局部伪影'),
        manual('preservation', '产品、背景、构图等保留约束满足要求'),
      ] : []),
    ],
    updatedAt: now,
  };
}

/** Accepts only explicit model decisions with traceable evidence; absent model output stays manual. */
export function recordModelQualityChecks(
  report: DigitalHumanQualityReport,
  decisions: Partial<Record<ModelQualityKey, ModelQualityDecision>>,
  now = new Date().toISOString(),
): DigitalHumanQualityReport {
  const checks = report.checks.map(check => {
    const decision = decisions[check.key as ModelQualityKey];
    if (!decision) return check;
    const confidence = Number(decision.confidence); const evidence = String(decision.evidence || '').trim(); const model = String(decision.model || '').trim();
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !evidence || !model) return check;
    return { ...check, mode: 'automatic' as const, status: decision.passed ? 'passed' as const : 'failed' as const,
      evidence: `${model} · 置信度 ${confidence.toFixed(3)} · ${evidence}` };
  });
  const state = digitalHumanQualityState(checks);
  return { ...report, state, checks, updatedAt: now };
}

export function deferUnavailableVisualChecksToManual(report: DigitalHumanQualityReport, now = new Date().toISOString()): DigitalHumanQualityReport {
  const keys = new Set(['reference_pose_proxy', 'reference_background_proxy', 'reference_artifacts_proxy']);
  const checks = report.checks.map(check => keys.has(check.key) && check.status === 'pending'
    ? { ...check, mode: 'manual' as const, evidence: '当前执行未配置可核验的视觉模型，仅保留未核验诊断，不阻断生产' }
    : check);
  const state = digitalHumanQualityState(checks);
  return { ...report, state, checks, updatedAt: now };
}

export function recordReferenceVisualChecks(
  report: DigitalHumanQualityReport,
  metrics: ReferenceVisualMetrics,
  now = new Date().toISOString(),
): DigitalHumanQualityReport {
  const poseEvidenceAvailable = metrics.posePairCount >= 5 && metrics.normalizedPoseError !== null;
  const wristEvidenceAvailable = metrics.wristPosePairCount >= 5 && metrics.wristSeparationMae !== null;
  const handPassed = metrics.handPairCount === 0 || (metrics.handPckAt008 !== null && metrics.handPckAt008 >= 0.7);
  const posePassed = poseEvidenceAvailable && metrics.normalizedPoseError! <= 0.08
    && (!wristEvidenceAvailable || metrics.wristSeparationMae! <= 0.35) && handPassed;
  const backgroundPassed = metrics.backgroundSsim !== null && metrics.backgroundSsim >= 0.85;
  const artifactPassed = poseEvidenceAvailable && metrics.landmarkArtifactCount === 0;
  const decisions: Record<string, { passed: boolean; evidence: string }> = {
    reference_pose_proxy: { passed: posePassed, evidence: `姿态配对 ${metrics.posePairCount} 帧，归一化误差 ${metrics.normalizedPoseError?.toFixed(3) ?? '缺失'}；手部配对 ${metrics.handPairCount} 帧，PCK ${metrics.handPckAt008?.toFixed(3) ?? '未检出'}；双腕配对 ${metrics.wristPosePairCount} 帧，间距误差 ${metrics.wristSeparationMae?.toFixed(3) ?? '缺失'}` },
    reference_background_proxy: { passed: backgroundPassed, evidence: `人物区域外背景 SSIM ${metrics.backgroundSsim?.toFixed(3) ?? '缺失'}` },
    reference_artifacts_proxy: { passed: artifactPassed, evidence: `姿态配对 ${metrics.posePairCount} 帧，关键点异常 ${metrics.landmarkArtifactCount} 次` },
  };
  const checks = report.checks.map(check => {
    const decision = decisions[check.key];
    if (!decision || check.mode !== 'automatic') return check;
    return { ...check, status: decision.passed ? 'passed' as const : 'failed' as const, evidence: decision.evidence };
  });
  const state = digitalHumanQualityState(checks);
  return { state, checks, updatedAt: now };
}

/** Records measurable media facts only; identity, pose and scene fidelity stay manual. */
export function recordReferenceTechnicalChecks(
  report: DigitalHumanQualityReport,
  metrics: ReferenceTechnicalMetrics,
  now = new Date().toISOString(),
): DigitalHumanQualityReport {
  const decisions: Record<string, { passed: boolean; evidence: string }> = {
    reference_duration: {
      passed: metrics.durationDeltaFrames <= 1,
      evidence: `时长相差 ${metrics.durationDeltaFrames} 帧`,
    },
    reference_audio: metrics.audioCorrelation === null
      ? { passed: false, evidence: '源视频或候选视频缺少可比较音轨，需人工确认声音策略后重新检查' }
      : { passed: metrics.audioCorrelation >= 0.98, evidence: `音轨相关度 ${metrics.audioCorrelation.toFixed(3)}` },
    reference_motion: {
      passed: metrics.comparedFrames >= 5 && metrics.freezeMismatchRatio <= 0.1 && metrics.temporalMotionDifference <= 15,
      evidence: `对比 ${metrics.comparedFrames} 帧；停帧差异 ${(metrics.freezeMismatchRatio * 100).toFixed(1)}%；运动差异 ${metrics.temporalMotionDifference.toFixed(2)}`,
    },
  };
  const checks = report.checks.map(check => {
    const decision = decisions[check.key];
    if (!decision || check.mode !== 'automatic') return check;
    return { ...check, status: decision.passed ? 'passed' as const : 'failed' as const, evidence: decision.evidence };
  });
  const state = digitalHumanQualityState(checks);
  return { state, checks, updatedAt: now };
}

export function recordDigitalHumanMediaCheck(report: DigitalHumanQualityReport, input: { passed: boolean; evidence: string; now?: string }): DigitalHumanQualityReport {
  const checks = report.checks.map(check => check.key === 'media_import'
    ? { ...check, status: input.passed ? 'passed' as const : 'failed' as const, evidence: input.evidence }
    : check);
  return { state: digitalHumanQualityState(checks), checks, updatedAt: input.now ?? new Date().toISOString() };
}

export function reviewDigitalHumanQuality(report: DigitalHumanQualityReport, decisions: Record<string, { passed: boolean; evidence: string }>, now = new Date().toISOString(), reviewNote?: string): DigitalHumanQualityReport {
  const checks = report.checks.map(check => {
    if (check.mode !== 'manual' || !decisions[check.key]) return check;
    const decision = decisions[check.key]!;
    return { ...check, status: decision.passed ? 'passed' as const : 'failed' as const, evidence: decision.evidence.trim() || null };
  });
  const state = digitalHumanQualityState(checks);
  return { ...report, state, checks, reviewNote: reviewNote?.trim().slice(0, 1000) || report.reviewNote || null, reviewedAt: now, updatedAt: now };
}
