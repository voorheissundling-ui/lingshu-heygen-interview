import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type StoryboardQaPhase = 'first_frame' | 'video';
export type StoryboardQaScene = 'product' | 'factory' | 'usage' | 'general';
export type StoryboardQaVerdict = 'pass' | 'fail' | 'uncertain';
export type StoryboardQaStatus = 'passed' | 'needs_review' | 'retry_first_frame' | 'retry_video' | 'needs_assets';
export type StoryboardQaAction = 'retry_first_frame' | 'retry_video' | 'needs_assets' | 'manual_review';

export interface StoryboardQaObservation {
  key: string;
  verdict: StoryboardQaVerdict;
  evidenceFrames: string[];
  note: string;
  action?: StoryboardQaAction;
}

export interface StoryboardQaFinding extends StoryboardQaObservation {
  code: string;
  severity: 'hard_failure' | 'review';
  message: string;
  action: StoryboardQaAction;
}

export interface StoryboardQaReport {
  reportId: string;
  version: 'storyboard-aigc-qa-v1';
  phase: StoryboardQaPhase;
  sceneType: StoryboardQaScene;
  status: StoryboardQaStatus;
  automatedPassed: boolean;
  passed: boolean;
  requiresHumanReview: boolean;
  reasonCodes: string[];
  findings: StoryboardQaFinding[];
  checks: Record<string, StoryboardQaObservation>;
  evidenceFrameLabels: string[];
  checkedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewDecision?: 'accept' | 'reject';
  acceptanceSource?: 'automatic_policy';
  backgroundCheckPolicy?: 'disabled';
}

const checksByPhase = {
  first_frame: ['product_identity', 'packaging_visibility', 'subject_visibility', 'person_identity', 'environment_fidelity', 'layout', 'contact', 'start_state', 'visual_integrity'],
  video: ['product_identity', 'packaging_visibility', 'subject_visibility', 'person_identity', 'environment_fidelity', 'layout_continuity', 'contact_continuity', 'seam_continuity', 'action_order', 'end_state', 'visual_integrity'],
} as const;

export function storyboardQaRequiredChecks(input: {
  phase: StoryboardQaPhase; sceneType: StoryboardQaScene; hasProduct: boolean;
  hasNamedPerson: boolean; hasEnvironmentReference?: boolean; hasContact: boolean; hasAction: boolean;
  hasSeam?: boolean;
}): string[] {
  const out = new Set<string>();
  if (input.hasProduct || input.sceneType === 'usage') {
    out.add('product_identity');
    out.add('packaging_visibility');
    out.add('subject_visibility');
  }
  if (input.hasNamedPerson) out.add('person_identity');
  if (input.hasEnvironmentReference) out.add('environment_fidelity');
  out.add(input.phase === 'first_frame' ? 'layout' : 'layout_continuity');
  out.add(input.phase === 'first_frame' ? 'visual_integrity' : 'visual_integrity');
  if (input.hasContact || input.sceneType === 'usage') out.add(input.phase === 'first_frame' ? 'contact' : 'contact_continuity');
  if (input.phase === 'first_frame') {
    if (input.hasAction || input.sceneType === 'usage') out.add('start_state');
  } else if (input.hasAction || input.sceneType === 'usage') {
    out.add('action_order');
    out.add('end_state');
  }
  if (input.phase === 'video' && input.hasSeam) out.add('seam_continuity');
  return [...out];
}

/** Reject incomplete/misattributed model output before it can be converted
 * into product or asset failures. Technical checks may satisfy their own key,
 * but model pass/fail claims must cite a real candidate frame. */
export function storyboardQaObservationContractIssues(input: {
  observations: unknown;
  requiredKeys: string[];
  allowedCitationLabels: string[];
  candidateLabels: string[];
  technicalKeys?: string[];
}): string[] {
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const allowed = new Set(input.allowedCitationLabels);
  const candidates = new Set(input.candidateLabels);
  const technical = new Set(input.technicalKeys || []);
  const byKey = new Map<string, Record<string, unknown>>();
  const issues: string[] = [];
  for (const raw of observations) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const key = String(item.key || '');
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  for (const key of input.requiredKeys) {
    if (technical.has(key)) continue;
    const item = byKey.get(key);
    const verdict = String(item?.verdict || '');
    if (!item || !['pass', 'fail', 'uncertain'].includes(verdict)) {
      issues.push(`${key}:missing_or_invalid_verdict`);
      continue;
    }
    const cited = Array.isArray(item.evidenceFrames) ? item.evidenceFrames.map(String) : [];
    if (cited.some(label => !allowed.has(label))) issues.push(`${key}:unknown_evidence_label`);
    if ((verdict === 'pass' || verdict === 'fail') && !cited.some(label => candidates.has(label)))
      issues.push(`${key}:candidate_evidence_required`);
  }
  return issues;
}

function defaultAction(phase: StoryboardQaPhase, key: string): StoryboardQaAction {
  if (key === 'product_identity' || key === 'person_identity') return 'needs_assets';
  return phase === 'first_frame' ? 'retry_first_frame' : 'retry_video';
}

function safeVerdict(value: unknown): StoryboardQaVerdict {
  return value === 'pass' || value === 'fail' ? value : 'uncertain';
}

function safeAction(value: unknown, phase: StoryboardQaPhase, key: string): StoryboardQaAction {
  if (value === 'needs_assets' || value === 'retry_first_frame' || value === 'retry_video' || value === 'manual_review') return value;
  return defaultAction(phase, key);
}

function hasSufficientTemporalEvidence(phase: StoryboardQaPhase, key: string, labels: string[], cited: string[]): boolean {
  if (phase !== 'video') return cited.length > 0;
  const unique = [...new Set(cited)];
  if (key === 'seam_continuity') return unique.includes('上一段合格末帧') && unique.some(label => label !== '上一段合格末帧');
  // A single still cannot establish a changing state or identity continuity.
  if (['product_identity', 'packaging_visibility', 'subject_visibility', 'person_identity', 'environment_fidelity', 'layout_continuity', 'contact_continuity', 'action_order'].includes(key))
    return unique.length >= 2;
  // The final state must be visible near the end, not inferred from a middle frame.
  if (key === 'end_state') return unique.some(label => labels.indexOf(label) >= Math.floor(labels.length * .75));
  return unique.length > 0;
}

export function buildStoryboardQaReport(input: {
  phase: StoryboardQaPhase; sceneType: StoryboardQaScene; hasProduct: boolean;
  hasNamedPerson: boolean; hasEnvironmentReference?: boolean; hasContact: boolean; hasAction: boolean;
  hasSeam?: boolean;
  observations: unknown; evidenceFrameLabels: string[]; checkedAt?: string;
}): StoryboardQaReport {
  const allowed = new Set<string>(checksByPhase[input.phase]);
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const byKey = new Map<string, StoryboardQaObservation>();
  for (const raw of observations) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const key = String(item.key || '');
    if (!allowed.has(key) || byKey.has(key)) continue;
    const evidenceFrames = Array.isArray(item.evidenceFrames) ? item.evidenceFrames.map(String).filter(label => input.evidenceFrameLabels.includes(label)).slice(0, 5) : [];
    const verdict = safeVerdict(item.verdict);
    byKey.set(key, {
      key, verdict: verdict === 'pass' && !hasSufficientTemporalEvidence(input.phase, key, input.evidenceFrameLabels, evidenceFrames)
        ? 'uncertain' : verdict,
      evidenceFrames,
      note: String(item.note || '').slice(0, 500),
      action: safeAction(item.action, input.phase, key),
    });
  }
  const required = storyboardQaRequiredChecks(input);
  const checks: Record<string, StoryboardQaObservation> = {};
  const findings: StoryboardQaFinding[] = [];
  for (const key of required) {
    const observed = byKey.get(key) || { key, verdict: 'uncertain' as const, evidenceFrames: [], note: '模型未返回此项检查结论' };
    checks[key] = observed;
    if (observed.verdict === 'pass') continue;
    const severity = observed.verdict === 'fail' ? 'hard_failure' : 'review';
    const action = observed.verdict === 'fail' ? safeAction(observed.action, input.phase, key) : 'manual_review';
    findings.push({ ...observed, code: `${key.toUpperCase()}_${observed.verdict === 'fail' ? 'FAILED' : 'UNCERTAIN'}`,
      severity, action, message: observed.note || `${key} 缺少可靠视觉证据` });
  }
  const hard = findings.filter(item => item.severity === 'hard_failure');
  const status: StoryboardQaStatus = hard.some(item => item.action === 'needs_assets') ? 'needs_assets'
    : hard.length ? input.phase === 'first_frame' ? 'retry_first_frame' : 'retry_video'
    : 'needs_review';
  const checkedAt = input.checkedAt || new Date().toISOString();
  const canonical = JSON.stringify({ phase: input.phase, sceneType: input.sceneType, checkedAt, findings, checks, evidenceFrameLabels: input.evidenceFrameLabels });
  return {
    reportId: createHash('sha256').update(canonical).digest('hex').slice(0, 24),
    version: 'storyboard-aigc-qa-v1', phase: input.phase, sceneType: input.sceneType,
    status, automatedPassed: findings.length === 0, passed: false, requiresHumanReview: true,
    reasonCodes: findings.map(item => item.code), findings, checks,
    evidenceFrameLabels: [...input.evidenceFrameLabels], checkedAt,
  };
}

/** Automatic admission needs complete QA evidence. A generated environment is
 * never exempt from fidelity checks, and automation cannot sign human review. */
export function applyStoryboardReplicationAutomation(report: StoryboardQaReport): StoryboardQaReport {
  const findings = report.findings.map(item =>
    item.key === 'product_identity' && item.severity !== 'hard_failure'
      ? { ...item, severity: 'hard_failure' as const, action: 'needs_assets' as const,
        code: item.code.replace(/_UNCERTAIN$/, '_UNVERIFIED'),
        message: item.message || '企业产品身份未被可靠验证' }
      : item);
  const hard = findings.filter(item => item.severity === 'hard_failure');
  const { reviewedAt: _at, reviewedBy: _by, reviewDecision: _decision,
    backgroundCheckPolicy: _background, acceptanceSource: _source, ...original } = report;
  const passed = findings.length === 0;
  const requiresHumanReview = !hard.length && !passed;
  return { ...original, checks: { ...report.checks }, findings, reasonCodes: findings.map(item => item.code),
    automatedPassed: passed, passed, requiresHumanReview,
    status: hard.some(item => item.action === 'needs_assets') ? 'needs_assets'
      : hard.length ? report.phase === 'first_frame' ? 'retry_first_frame' : 'retry_video'
      : requiresHumanReview ? 'needs_review' : 'passed',
    ...(passed ? { acceptanceSource: 'automatic_policy' as const } : {}) };
}

export function automaticStoryboardFrameAdmission(provenance: Record<string, any> | undefined): boolean {
  const spec = provenance?.shotSpec;
  if (spec?.mode !== 'replication' || spec?.constraints?.includes('person_identity') || !provenance?.firstFrameQuality) return false;
  return applyStoryboardReplicationAutomation(provenance.firstFrameQuality).passed;
}

/** A managed clone may deliberately fall back to an enterprise-product-only
 * scene when the reference frame is not authorized as model input.  The frame
 * is still eligible for automatic admission, but only after the caller has
 * verified the current server-owned source plan.  Keeping the plan argument
 * outside provenance prevents an arbitrary free-creation request from
 * promoting itself into the automated production path. */
export function automaticManagedFallbackFrameAdmission(
  provenance: Record<string, any> | undefined,
  currentSourcePlan: Record<string, any> | undefined,
): boolean {
  const spec = provenance?.shotSpec;
  if (currentSourcePlan?.fallbackMode !== 'enterprise_product_display'
    || currentSourcePlan?.mode !== 'ai'
    || provenance?.mode !== 'free_creation'
    || spec?.mode !== 'free_creation'
    || spec?.constraints?.includes('person_identity')
    || !spec?.constraints?.includes('product_identity')
    || provenance?.firstFrameQualityState !== 'evaluated'
    || !provenance?.firstFrameQuality) return false;
  return applyStoryboardReplicationAutomation(provenance.firstFrameQuality).passed;
}

/** The same server-owned fallback contract also applies to the generated
 * video.  It is intentionally separate from the frame check so a passing
 * first frame can never stand in for real video QA evidence. */
export function automaticManagedFallbackVideoAdmission(
  provenance: Record<string, any> | undefined,
  currentSourcePlan: Record<string, any> | undefined,
): boolean {
  const spec = provenance?.shotSpec;
  const report = provenance?.storyboardQualityReport as StoryboardQaReport | undefined;
  if (currentSourcePlan?.fallbackMode !== 'enterprise_product_display'
    || currentSourcePlan?.mode !== 'ai'
    || spec?.mode !== 'free_creation'
    || spec?.constraints?.includes('person_identity')
    || !spec?.constraints?.includes('product_identity')
    || report?.phase !== 'video') return false;
  return applyStoryboardReplicationAutomation(report).passed;
}

export function reviewStoryboardQaReport(report: StoryboardQaReport, input: { decision: 'accept' | 'reject'; reviewedBy: string; reviewedAt?: string }): StoryboardQaReport {
  if (report.status !== 'needs_review' || report.findings.some(item => item.severity === 'hard_failure')) {
    throw new Error('存在硬失败项，不能人工通过；请重做首帧、视频或补充素材');
  }
  if (!input.reviewedBy) throw new Error('缺少复核人');
  return {
    ...report,
    status: input.decision === 'accept' ? 'passed' : report.phase === 'first_frame' ? 'retry_first_frame' : 'retry_video',
    passed: input.decision === 'accept', requiresHumanReview: false,
    reviewDecision: input.decision, reviewedBy: input.reviewedBy, reviewedAt: input.reviewedAt || new Date().toISOString(),
  };
}

/** Detect a fully blank frame before asking a vision model to interpret it. */
export async function inspectStoryboardTechnicalFrames(
  phase: StoryboardQaPhase,
  frames: Array<{ bytes: Buffer; timeLabel: string }>,
): Promise<StoryboardQaObservation[]> {
  const blank: string[] = [];
  for (const frame of frames) {
    const { data, info } = await sharp(frame.bytes).resize({ width: 160, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
    if (info.width < 32 || info.height < 32) {
      blank.push(frame.timeLabel);
      continue;
    }
    let sum = 0;
    let dark = 0;
    for (const value of data) { sum += value; if (value < 10) dark += 1; }
    if (sum / data.length < 5 && dark / data.length > 0.995) blank.push(frame.timeLabel);
  }
  return blank.length ? [{ key: 'visual_integrity', verdict: 'fail', evidenceFrames: blank,
    note: `候选出现黑帧或无效小图：${blank.join('、')}`, action: phase === 'first_frame' ? 'retry_first_frame' : 'retry_video' }] : [];
}
