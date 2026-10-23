import fs from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * This module is deliberately detector-agnostic. It evaluates auditable
 * evidence produced by deterministic rules, CV/audio workers or a human
 * reviewer; it never turns an absent detector result into a successful check.
 */

export type ReplicationFactorPolicy =
  | 'lock'
  | 'equivalent'
  | 'bounded'
  | 'replace_identity'
  | 'prohibit_reuse'
  | 'free';

export type ReplicationImportance = 'critical' | 'high' | 'medium' | 'low';

export interface ReplicationFactorSpec {
  factorId: string;
  sceneId: string;
  referenceShotId?: string | null;
  category: string;
  description: string;
  causalRole?: string;
  policy: ReplicationFactorPolicy;
  importance: ReplicationImportance;
  expected?: unknown;
  tolerance?: {
    min?: number;
    max?: number;
    target?: number;
    maxAbsoluteDeviation?: number;
    maxRelativeDeviation?: number;
  };
}

export interface EvidenceProvenance {
  producer: 'deterministic_rule' | 'cv_worker' | 'audio_worker' | 'multimodal_worker' | 'human_review';
  detector?: string;
  detectorVersion?: string;
  createdAt?: string;
}

export interface ReplicationFactorEvidence {
  factorId: string;
  sceneId?: string;
  outcome: 'pass' | 'fail' | 'unknown';
  actual?: unknown;
  confidence?: number | null;
  evidenceRefs: string[];
  explanation?: string;
  provenance: EvidenceProvenance;
}

export interface TimelineShot {
  shotId: string;
  referenceShotId?: string | null;
  startSeconds: number;
  endSeconds: number;
  purpose?: string | null;
}

export interface IdentityReplacementRequirement {
  requirementId: string;
  identityType: 'product' | 'face' | 'brand' | 'voice' | 'other';
  originalIdentity?: string | null;
  expectedReplacement?: string | null;
  sceneIds?: string[];
  required?: boolean;
}

export interface IdentityReplacementEvidence {
  requirementId: string;
  outcome: 'replaced' | 'not_replaced' | 'unknown';
  detectedOriginal?: boolean | null;
  detectedReplacement?: string | null;
  confidence?: number | null;
  evidenceRefs: string[];
  explanation?: string;
  provenance: EvidenceProvenance;
}

export type ReuseRiskEvidenceKind =
  | 'exact_media_hash'
  | 'text_similarity'
  | 'consecutive_frame_similarity'
  | 'audio_fingerprint_similarity';

export interface ReuseRiskEvidence {
  evidenceId: string;
  kind: ReuseRiskEvidenceKind;
  /** 0 means no detected reuse; 1 means identical for this detector. */
  similarity: number | null;
  riskThreshold: number;
  status: 'available' | 'unavailable' | 'error';
  authorization?: 'authorized' | 'unauthorized' | 'unknown';
  sceneId?: string;
  evidenceRefs: string[];
  explanation?: string;
  provenance: EvidenceProvenance;
}

export interface AccountProductFitCheck {
  checkId: string;
  label: string;
  outcome: 'pass' | 'fail' | 'unknown';
  required?: boolean;
  evidenceRefs: string[];
  explanation?: string;
}

export interface ReplicationMediaInput {
  referenceVideoPath?: string | null;
  outputVideoPath?: string | null;
  referenceText?: string | null;
  outputText?: string | null;
  textRiskThreshold?: number;
}

export interface ReplicationEvaluationInput {
  referenceTimeline: TimelineShot[];
  outputTimeline: TimelineShot[];
  factors: ReplicationFactorSpec[];
  /** The caller deliberately projected the source factor set onto the final
   * output contract. An empty projection is valid when every source-specific
   * factor was functionally replaced; the timeline and global safety gates
   * remain independently enforceable. */
  factorScopeDeclared?: boolean;
  factorEvidence: ReplicationFactorEvidence[];
  identityRequirements?: IdentityReplacementRequirement[];
  identityEvidence?: IdentityReplacementEvidence[];
  reuseRiskEvidence?: ReuseRiskEvidence[];
  accountProductFitChecks?: AccountProductFitCheck[];
  media?: ReplicationMediaInput;
  timelineTolerance?: {
    maxStartDriftSeconds?: number;
    maxDurationDriftRatio?: number;
    maxShotCountDifference?: number;
    requirePurposeMatch?: boolean;
  };
  /**
   * Omitted checks stay visibly incomplete. Passing an empty array is an
   * explicit integration choice and should only be used before a release gate.
   */
  requiredReuseChecks?: ReuseRiskEvidenceKind[];
}

export type EvaluationStatus = 'pass' | 'fail' | 'incomplete' | 'not_applicable';
export type EvaluationDimensionName =
  | 'viralFactorFidelity'
  | 'identityReplacement'
  | 'originalityDifference'
  | 'unauthorizedReuseRisk'
  | 'accountProductFit';

export interface EvaluationDimension {
  name: EvaluationDimensionName;
  status: EvaluationStatus;
  /** Higher is better, except unauthorizedReuseRisk where higher is riskier. */
  score: number | null;
  checked: number;
  required: number;
  evidenceCoverage: number;
  findings: string[];
}

export interface ReplicationEvaluationIssue {
  code: string;
  message: string;
  severity: 'blocker' | 'review';
  sceneId?: string;
  referenceShotId?: string;
  factorId?: string;
  evidenceId?: string;
}

export interface ReplicationShotEvaluation {
  sceneId: string;
  referenceShotId?: string | null;
  status: 'pass' | 'fail' | 'incomplete';
  issues: ReplicationEvaluationIssue[];
}

export interface ReplicationEvaluationReport {
  version: '1.0';
  releaseDecision: 'pass' | 'blocked' | 'review_required';
  dimensions: Record<EvaluationDimensionName, EvaluationDimension>;
  shotResults: ReplicationShotEvaluation[];
  blockers: ReplicationEvaluationIssue[];
  reviewItems: ReplicationEvaluationIssue[];
  evidenceInventory: {
    factorEvidence: number;
    identityEvidence: number;
    reuseRiskEvidence: number;
    unavailableReuseChecks: ReuseRiskEvidenceKind[];
  };
  limitations: string[];
}

const DEFAULT_REQUIRED_REUSE_CHECKS: ReuseRiskEvidenceKind[] = [
  'exact_media_hash',
  'text_similarity',
  'consecutive_frame_similarity',
  'audio_fingerprint_similarity',
];

const round = (value: number) => Math.round(value * 100) / 100;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const coverage = (checked: number, required: number) => required ? round(checked / required) : 1;

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ngramSimilarity(left: string, right: string, size = 2): number {
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, '').replace(/[\p{P}\p{S}]/gu, '');
  const grams = (value: string) => {
    const normalized = normalize(value);
    if (!normalized) return new Set<string>();
    if (normalized.length <= size) return new Set([normalized]);
    return new Set(Array.from({ length: normalized.length - size + 1 }, (_, index) => normalized.slice(index, index + size)));
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  if (!leftGrams.size && !rightGrams.size) return 0;
  let intersection = 0;
  for (const item of leftGrams) if (rightGrams.has(item)) intersection += 1;
  return intersection / Math.max(1, leftGrams.size + rightGrams.size - intersection);
}

async function fileSha256(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function deriveMediaEvidence(media: ReplicationMediaInput | undefined): Promise<ReuseRiskEvidence[]> {
  if (!media) return [];
  const evidence: ReuseRiskEvidence[] = [];
  const base = { provenance: { producer: 'deterministic_rule' as const, detector: 'replication-evaluation', detectorVersion: '1.0' } };

  if (media.referenceVideoPath || media.outputVideoPath) {
    const paths = [media.referenceVideoPath, media.outputVideoPath];
    if (paths.every(item => item && fs.existsSync(item))) {
      try {
        const [referenceHash, outputHash] = await Promise.all(paths.map(item => fileSha256(String(item))));
        const matched = referenceHash === outputHash;
        evidence.push({
          evidenceId: 'derived-exact-media-hash', kind: 'exact_media_hash', similarity: matched ? 1 : 0,
          riskThreshold: 1, status: 'available', authorization: 'unknown',
          evidenceRefs: paths.map(String),
          explanation: matched
            ? '参考文件与成片文件的 SHA-256 完全相同'
            : '容器文件哈希不同；这只能排除整文件原样复制，不能排除转码后的连续帧或音频复用',
          ...base,
        });
      } catch (error) {
        evidence.push({
          evidenceId: 'derived-exact-media-hash', kind: 'exact_media_hash', similarity: null,
          riskThreshold: 1, status: 'error', authorization: 'unknown', evidenceRefs: paths.filter(Boolean).map(String),
          explanation: `媒体哈希计算失败：${String(error)}`, ...base,
        });
      }
    } else {
      evidence.push({
        evidenceId: 'derived-exact-media-hash', kind: 'exact_media_hash', similarity: null,
        riskThreshold: 1, status: 'unavailable', authorization: 'unknown', evidenceRefs: paths.filter(Boolean).map(String),
        explanation: '参考文件或成片文件不存在，无法计算整文件哈希', ...base,
      });
    }
  }

  if (media.referenceText !== undefined || media.outputText !== undefined) {
    const available = Boolean(media.referenceText?.trim()) && Boolean(media.outputText?.trim());
    evidence.push({
      evidenceId: 'derived-text-similarity', kind: 'text_similarity',
      similarity: available ? round(ngramSimilarity(String(media.referenceText), String(media.outputText))) : null,
      riskThreshold: clamp01(media.textRiskThreshold ?? 0.86),
      status: available ? 'available' : 'unavailable', authorization: 'unknown', evidenceRefs: ['referenceText', 'outputText'],
      explanation: available ? '基于规范化二元字符 Jaccard 的文案复用风险；不代表语义级抄袭检测' : '参考文案或成片文案为空',
      ...base,
    });
  }

  return evidence;
}

function evaluateTimeline(input: ReplicationEvaluationInput): {
  score: number | null;
  checked: number;
  required: number;
  issues: ReplicationEvaluationIssue[];
  matchedSceneIds: Set<string>;
} {
  const issues: ReplicationEvaluationIssue[] = [];
  const matchedSceneIds = new Set<string>();
  const reference = input.referenceTimeline;
  const output = input.outputTimeline;
  if (!reference.length || !output.length) {
    issues.push({ code: 'timeline_missing', message: '参考或成片缺少可比较的逐镜时间轴', severity: 'blocker' });
    return { score: null, checked: 0, required: Math.max(reference.length, 1), issues, matchedSceneIds };
  }

  const tolerance = {
    maxStartDriftSeconds: Math.max(0, input.timelineTolerance?.maxStartDriftSeconds ?? 0.35),
    maxDurationDriftRatio: Math.max(0, input.timelineTolerance?.maxDurationDriftRatio ?? 0.2),
    maxShotCountDifference: Math.max(0, Math.floor(input.timelineTolerance?.maxShotCountDifference ?? 0)),
    requirePurposeMatch: input.timelineTolerance?.requirePurposeMatch ?? true,
  };
  if (Math.abs(reference.length - output.length) > tolerance.maxShotCountDifference) {
    issues.push({ code: 'shot_count_mismatch', message: `参考 ${reference.length} 镜，成片 ${output.length} 镜，超过允许差值 ${tolerance.maxShotCountDifference}`, severity: 'blocker' });
  }

  let passedComparisons = 0;
  let comparisons = 0;
  for (const [index, referenceShot] of reference.entries()) {
    const outputShot = output.find(item => item.referenceShotId === referenceShot.shotId) ?? output[index];
    if (!outputShot) {
      issues.push({ code: 'shot_missing', message: `缺少参考镜头 ${referenceShot.shotId} 的成片镜头`, severity: 'blocker', referenceShotId: referenceShot.shotId });
      continue;
    }
    matchedSceneIds.add(outputShot.shotId);
    const sceneIssue = (code: string, message: string) => issues.push({ code, message, severity: 'blocker', sceneId: outputShot.shotId, referenceShotId: referenceShot.shotId });
    const startDrift = Math.abs(outputShot.startSeconds - referenceShot.startSeconds);
    comparisons += 1;
    if (startDrift <= tolerance.maxStartDriftSeconds) passedComparisons += 1;
    else sceneIssue('shot_start_drift', `镜头起点偏差 ${round(startDrift)} 秒，超过 ${tolerance.maxStartDriftSeconds} 秒`);

    const referenceDuration = referenceShot.endSeconds - referenceShot.startSeconds;
    const outputDuration = outputShot.endSeconds - outputShot.startSeconds;
    const durationDrift = referenceDuration > 0 ? Math.abs(outputDuration - referenceDuration) / referenceDuration : Number.POSITIVE_INFINITY;
    comparisons += 1;
    if (referenceDuration > 0 && outputDuration > 0 && durationDrift <= tolerance.maxDurationDriftRatio) passedComparisons += 1;
    else sceneIssue('shot_duration_drift', `镜头时长偏差 ${Number.isFinite(durationDrift) ? `${Math.round(durationDrift * 100)}%` : '不可计算'}，超过 ${Math.round(tolerance.maxDurationDriftRatio * 100)}%`);

    if (tolerance.requirePurposeMatch && referenceShot.purpose) {
      comparisons += 1;
      if (outputShot.purpose === referenceShot.purpose) passedComparisons += 1;
      else sceneIssue('shot_purpose_mismatch', `镜头功能应为「${referenceShot.purpose}」，实际为「${outputShot.purpose || '未标注'}」`);
    }
  }
  return {
    score: comparisons ? round(passedComparisons / comparisons * 100) : null,
    checked: reference.length - issues.filter(item => item.code === 'shot_missing').length,
    required: reference.length,
    issues,
    matchedSceneIds,
  };
}

function evaluateFactor(spec: ReplicationFactorSpec, evidence: ReplicationFactorEvidence | undefined): {
  result: 'pass' | 'fail' | 'incomplete' | 'skip';
  issue?: ReplicationEvaluationIssue;
} {
  if (spec.policy === 'free') return { result: 'skip' };
  const issue = (code: string, message: string, severity: 'blocker' | 'review' = 'blocker'): ReplicationEvaluationIssue => ({
    code, message, severity, sceneId: spec.sceneId, referenceShotId: spec.referenceShotId ?? undefined, factorId: spec.factorId,
  });
  if (!evidence || evidence.outcome === 'unknown') {
    return { result: 'incomplete', issue: issue('factor_evidence_missing', `「${spec.description}」缺少可审计检测证据`) };
  }
  if (!evidence.evidenceRefs.length) {
    return { result: 'incomplete', issue: issue('factor_evidence_untraceable', `「${spec.description}」有结论但没有证据引用`) };
  }
  if (evidence.outcome === 'fail') return { result: 'fail', issue: issue('factor_gate_failed', `「${spec.description}」未达到 ${spec.policy} 要求${evidence.explanation ? `：${evidence.explanation}` : ''}`) };

  if (spec.policy === 'bounded') {
    const actual = Number(evidence.actual);
    if (!Number.isFinite(actual)) return { result: 'incomplete', issue: issue('bounded_value_missing', `「${spec.description}」缺少可计算的数值结果`) };
    const { min, max, target, maxAbsoluteDeviation, maxRelativeDeviation } = spec.tolerance ?? {};
    const outsideRange = (min !== undefined && actual < min) || (max !== undefined && actual > max);
    const outsideAbsolute = target !== undefined && maxAbsoluteDeviation !== undefined && Math.abs(actual - target) > maxAbsoluteDeviation;
    const outsideRelative = target !== undefined && target !== 0 && maxRelativeDeviation !== undefined && Math.abs(actual - target) / Math.abs(target) > maxRelativeDeviation;
    if (outsideRange || outsideAbsolute || outsideRelative) {
      return { result: 'fail', issue: issue('bounded_value_outside_tolerance', `「${spec.description}」实测 ${actual} 超出允许范围`) };
    }
  }
  if (spec.policy === 'lock' && spec.expected !== undefined && evidence.actual !== undefined && stableValue(spec.expected) !== stableValue(evidence.actual)) {
    return { result: 'fail', issue: issue('locked_value_mismatch', `「${spec.description}」锁定值与实测结果不一致`) };
  }
  return { result: 'pass' };
}

function dimension(input: Omit<EvaluationDimension, 'evidenceCoverage'>): EvaluationDimension {
  return { ...input, evidenceCoverage: coverage(input.checked, input.required) };
}

export async function evaluateReplication(input: ReplicationEvaluationInput): Promise<ReplicationEvaluationReport> {
  const blockers: ReplicationEvaluationIssue[] = [];
  const reviewItems: ReplicationEvaluationIssue[] = [];
  const limitations = [
    '整文件哈希不同只能排除原文件逐字节复制，不能排除转码后的画面或声音复用。',
    '连续帧、音频指纹、身份和等价因素必须由上游检测器或人工复核提供证据；本内核不会臆造检测结果。',
    '相似度用于验证冻结规格，不代表平台传播结果，也不能承诺视频必爆。',
  ];
  const addIssue = (item: ReplicationEvaluationIssue) => (item.severity === 'blocker' ? blockers : reviewItems).push(item);

  const timeline = evaluateTimeline(input);
  timeline.issues.forEach(addIssue);
  if (!input.factors.length && !input.factorScopeDeclared) addIssue({ code: 'factor_spec_missing', message: '缺少冻结的爆点因素规格，无法验证高保真复刻', severity: 'blocker' });

  const factorEvidenceById = new Map(input.factorEvidence.map(item => [item.factorId, item]));
  let checkedFactors = 0;
  let passedFactors = 0;
  let requiredFactors = 0;
  const factorFindings: string[] = [];
  for (const spec of input.factors) {
    const result = evaluateFactor(spec, factorEvidenceById.get(spec.factorId));
    if (result.result === 'skip') continue;
    requiredFactors += 1;
    if (result.result === 'pass') { checkedFactors += 1; passedFactors += 1; }
    else if (result.result === 'fail') checkedFactors += 1;
    if (result.issue) {
      addIssue(result.issue);
      factorFindings.push(result.issue.message);
    }
  }
  const timelineFailed = timeline.issues.length > 0;
  const factorFailed = blockers.some(item => item.code.startsWith('factor_') || item.code.startsWith('bounded_') || item.code.startsWith('locked_'));
  const fidelityRequired = timeline.required + requiredFactors;
  const fidelityChecked = timeline.checked + checkedFactors;
  const fidelityScoreParts = [timeline.score, requiredFactors ? round(passedFactors / requiredFactors * 100) : null].filter((item): item is number => item !== null);
  const fidelity = dimension({
    name: 'viralFactorFidelity',
    status: timelineFailed || factorFailed ? 'fail' : fidelityChecked < fidelityRequired ? 'incomplete' : 'pass',
    score: fidelityScoreParts.length ? round(fidelityScoreParts.reduce((sum, value) => sum + value, 0) / fidelityScoreParts.length) : null,
    checked: fidelityChecked, required: fidelityRequired,
    findings: [...timeline.issues.map(item => item.message), ...factorFindings],
  });

  const identityRequirements = input.identityRequirements ?? [];
  const identityEvidenceById = new Map((input.identityEvidence ?? []).map(item => [item.requirementId, item]));
  let checkedIdentities = 0;
  let replacedIdentities = 0;
  const identityFindings: string[] = [];
  for (const requirement of identityRequirements.filter(item => item.required !== false)) {
    const item = identityEvidenceById.get(requirement.requirementId);
    let issue: ReplicationEvaluationIssue | null = null;
    if (!item || item.outcome === 'unknown' || !item.evidenceRefs.length) {
      issue = { code: 'identity_evidence_missing', message: `${requirement.identityType} 身份替换缺少可审计证据`, severity: 'blocker', sceneId: requirement.sceneIds?.[0] };
    } else {
      checkedIdentities += 1;
      if (item.outcome === 'replaced' && item.detectedOriginal !== true) replacedIdentities += 1;
      else issue = { code: 'identity_replacement_failed', message: `${requirement.identityType} 身份未完成替换或仍检出原身份`, severity: 'blocker', sceneId: requirement.sceneIds?.[0] };
    }
    if (issue) { addIssue(issue); identityFindings.push(issue.message); }
  }
  const requiredIdentities = identityRequirements.filter(item => item.required !== false).length;
  const identityFailed = blockers.some(item => item.code.startsWith('identity_'));
  const identity = dimension({
    name: 'identityReplacement',
    status: !requiredIdentities ? 'not_applicable' : identityFailed ? 'fail' : checkedIdentities < requiredIdentities ? 'incomplete' : 'pass',
    score: requiredIdentities ? round(replacedIdentities / requiredIdentities * 100) : null,
    checked: checkedIdentities, required: requiredIdentities, findings: identityFindings,
  });

  const derivedRiskEvidence = await deriveMediaEvidence(input.media);
  const riskEvidence = [...(input.reuseRiskEvidence ?? []), ...derivedRiskEvidence];
  const requiredRiskChecks = input.requiredReuseChecks ?? DEFAULT_REQUIRED_REUSE_CHECKS;
  const unavailableReuseChecks: ReuseRiskEvidenceKind[] = [];
  const riskFindings: string[] = [];
  const availableKinds = new Set<ReuseRiskEvidenceKind>();
  const numericRisks: number[] = [];
  for (const item of riskEvidence) {
    if (item.status === 'available' && item.similarity !== null) {
      availableKinds.add(item.kind);
      numericRisks.push(clamp01(item.similarity));
      if (item.similarity >= item.riskThreshold && item.authorization !== 'authorized') {
        const issue: ReplicationEvaluationIssue = {
          code: `reuse_risk_${item.kind}`, message: `${item.kind} 检出高复用风险：${Math.round(item.similarity * 100)}% ≥ ${Math.round(item.riskThreshold * 100)}%`,
          severity: 'blocker', sceneId: item.sceneId, evidenceId: item.evidenceId,
        };
        addIssue(issue); riskFindings.push(issue.message);
      }
    } else if (requiredRiskChecks.includes(item.kind) && !availableKinds.has(item.kind)) {
      const issue: ReplicationEvaluationIssue = {
        code: `reuse_check_unavailable_${item.kind}`, message: `${item.kind} 检测不可用${item.explanation ? `：${item.explanation}` : ''}`,
        severity: 'review', sceneId: item.sceneId, evidenceId: item.evidenceId,
      };
      addIssue(issue); riskFindings.push(issue.message);
    }
  }
  for (const kind of requiredRiskChecks) {
    if (!availableKinds.has(kind)) {
      unavailableReuseChecks.push(kind);
      if (!reviewItems.some(item => item.code === `reuse_check_unavailable_${kind}`)) {
        const issue: ReplicationEvaluationIssue = { code: `reuse_check_missing_${kind}`, message: `缺少 ${kind} 检测证据`, severity: 'review' };
        addIssue(issue); riskFindings.push(issue.message);
      }
    }
  }
  const riskBlocked = blockers.some(item => item.code.startsWith('reuse_risk_'));
  const riskScore = numericRisks.length ? round(Math.max(...numericRisks) * 100) : null;
  const risk = dimension({
    name: 'unauthorizedReuseRisk',
    status: riskBlocked ? 'fail' : unavailableReuseChecks.length ? 'incomplete' : 'pass',
    score: riskScore,
    checked: requiredRiskChecks.filter(kind => availableKinds.has(kind)).length,
    required: requiredRiskChecks.length,
    findings: riskFindings,
  });
  const originality = dimension({
    name: 'originalityDifference',
    status: risk.status,
    score: riskScore === null ? null : round(100 - riskScore),
    checked: risk.checked, required: risk.required,
    findings: riskFindings,
  });

  const fitChecks = input.accountProductFitChecks ?? [];
  const requiredFit = fitChecks.filter(item => item.required !== false);
  let checkedFit = 0;
  let passedFit = 0;
  const fitFindings: string[] = [];
  for (const item of requiredFit) {
    if (item.outcome === 'unknown' || !item.evidenceRefs.length) {
      const issue: ReplicationEvaluationIssue = { code: 'account_fit_evidence_missing', message: `「${item.label}」缺少适配证据`, severity: 'review', evidenceId: item.checkId };
      addIssue(issue); fitFindings.push(issue.message);
    } else {
      checkedFit += 1;
      if (item.outcome === 'pass') passedFit += 1;
      else {
        const issue: ReplicationEvaluationIssue = { code: 'account_fit_failed', message: `「${item.label}」未通过账号/产品适配检查`, severity: 'blocker', evidenceId: item.checkId };
        addIssue(issue); fitFindings.push(issue.message);
      }
    }
  }
  const fitFailed = blockers.some(item => item.code === 'account_fit_failed');
  const fit = dimension({
    name: 'accountProductFit',
    status: !requiredFit.length ? 'not_applicable' : fitFailed ? 'fail' : checkedFit < requiredFit.length ? 'incomplete' : 'pass',
    score: requiredFit.length ? round(passedFit / requiredFit.length * 100) : null,
    checked: checkedFit, required: requiredFit.length, findings: fitFindings,
  });

  const dimensions: ReplicationEvaluationReport['dimensions'] = {
    viralFactorFidelity: fidelity,
    identityReplacement: identity,
    originalityDifference: originality,
    unauthorizedReuseRisk: risk,
    accountProductFit: fit,
  };
  const allIssues = [...blockers, ...reviewItems];
  const sceneIds = new Set([
    ...input.outputTimeline.map(item => item.shotId),
    ...input.factors.map(item => item.sceneId),
    ...allIssues.map(item => item.sceneId).filter((item): item is string => Boolean(item)),
  ]);
  const shotResults = [...sceneIds].map(sceneId => {
    const issues = allIssues.filter(item => item.sceneId === sceneId);
    return {
      sceneId,
      referenceShotId: input.outputTimeline.find(item => item.shotId === sceneId)?.referenceShotId
        ?? input.factors.find(item => item.sceneId === sceneId)?.referenceShotId,
      status: issues.some(item => item.severity === 'blocker') ? 'fail' as const : issues.length ? 'incomplete' as const : 'pass' as const,
      issues,
    };
  });
  const incomplete = Object.values(dimensions).some(item => item.status === 'incomplete');
  return {
    version: '1.0',
    releaseDecision: blockers.length ? 'blocked' : incomplete || reviewItems.length ? 'review_required' : 'pass',
    dimensions,
    shotResults,
    blockers,
    reviewItems,
    evidenceInventory: {
      factorEvidence: input.factorEvidence.length,
      identityEvidence: input.identityEvidence?.length ?? 0,
      reuseRiskEvidence: riskEvidence.length,
      unavailableReuseChecks,
    },
    limitations,
  };
}
