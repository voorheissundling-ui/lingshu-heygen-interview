import { createHash } from 'node:crypto';
import type {
  SocialContentAgentWorkflow,
  SocialReplicationEvaluation,
  SocialReplicationScriptVersion,
  SocialReferenceVideoAnalysis,
} from '../../shared/contracts/socialContentWorkflow.js';
import {
  evaluateReplication,
  type AccountProductFitCheck,
  type IdentityReplacementEvidence,
  type ReplicationFactorEvidence,
  type ReplicationEvaluationReport,
  type ReuseRiskEvidence,
} from '../lib/replicationEvaluation.js';
import { inspectReplicationMediaEvidence } from '../lib/replicationMediaEvidenceWorker.js';

type AdapterEvidence = {
  factorEvidence?: ReplicationFactorEvidence[];
  identityEvidence?: IdentityReplacementEvidence[];
  reuseRiskEvidence?: ReuseRiskEvidence[];
  accountProductFitChecks?: AccountProductFitCheck[];
  referenceVideoPath?: string | null;
  referenceText?: string | null;
  outputText?: string | null;
};

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);

function contractStatus(status: ReplicationEvaluationReport['dimensions']['viralFactorFidelity']['status']) {
  if (status === 'pass') return 'passed' as const;
  if (status === 'fail') return 'failed' as const;
  if (status === 'not_applicable') return 'not_applicable' as const;
  return 'review_required' as const;
}

function dimension(
  report: ReplicationEvaluationReport,
  name: keyof ReplicationEvaluationReport['dimensions'],
): SocialReplicationEvaluation['viralFactorFidelity'] {
  const source = report.dimensions[name];
  const relatedIssues = [...report.blockers, ...report.reviewItems].filter(issue => (
    name === 'viralFactorFidelity' ? Boolean(issue.factorId || issue.referenceShotId)
      : name === 'identityReplacement' ? issue.code.includes('identity')
        : name === 'unauthorizedReuseRisk' || name === 'originalityDifference' ? issue.code.includes('reuse')
          : issue.code.includes('account') || issue.code.includes('product') || issue.code.includes('fit')
  ));
  return {
    status: contractStatus(source.status),
    score: source.score,
    blockingFactorIds: [...new Set(relatedIssues.flatMap(issue => issue.factorId ? [issue.factorId] : []))],
    evidenceRefs: [...new Set(relatedIssues.flatMap(issue => issue.evidenceId ? [issue.evidenceId] : []))],
    summary: source.findings.join('；') || `${source.checked}/${source.required} 项已获得可审计证据`,
  };
}

export async function evaluateSocialReplicationResult(input: {
  workflow: SocialContentAgentWorkflow;
  replicationScript: SocialReplicationScriptVersion | null;
  referenceAnalysis?: SocialReferenceVideoAnalysis | null;
  productionResultId: string;
  outputVideoPath: string;
  evidence?: AdapterEvidence;
  now?: Date;
}): Promise<{ evaluation: SocialReplicationEvaluation | null; report: ReplicationEvaluationReport | null }> {
  const job = input.workflow.replicationJob;
  if (!job) return { evaluation: null, report: null };
  const fidelity = job.referenceMode === 'single_source_fidelity'
    || input.workflow.directorBrief.referenceMode === 'single_source_fidelity';
  const sceneByFactor = new Map<string, string>();
  const applicableFactorIds = new Set<string>();
  for (const scene of input.workflow.directorBrief.scenes) {
    for (const factor of scene.replicationFactors ?? []) {
      sceneByFactor.set(factor.factorId, scene.sceneId);
      // Budget semantic revisions deliberately retain the source factor in the
      // lineage while replacing its visual implementation with a shorter,
      // functionally equivalent scene. Such a factor is not a claim that the
      // output reproduces the original detector target, so grading it would
      // incorrectly apply every factor from the long reference to the compact
      // output. Legacy briefs without semanticAdaptation remain applicable.
      if (fidelity || factor.semanticAdaptation?.status !== 'functionally_replaced') {
        applicableFactorIds.add(factor.factorId);
      }
    }
  }
  const activeSourceFactors = job.factorSpecs
    .filter(factor => fidelity || applicableFactorIds.has(factor.factorId))
    .map(factor => ({ source: factor, sceneId: sceneByFactor.get(factor.factorId) || factor.beatId }));
  // Identity replacement and prohibited reuse are evaluated by their own
  // dimensions below. Sending the same source factors through fidelity as
  // well would require evidence that the media worker intentionally does not
  // produce and would multiply one global requirement into hundreds of false
  // blockers.
  const factorSpecs = activeSourceFactors
    .filter(({ source }) => source.policy !== 'replace_identity'
      && source.policy !== 'prohibit_reuse' && source.category !== 'identity')
    .map(({ source: factor, sceneId }) => ({
    factorId: factor.factorId,
    sceneId,
    referenceShotId: factor.referenceShotId,
    category: factor.category,
    description: factor.description,
    causalRole: factor.causalRole,
    policy: factor.policy,
    importance: factor.importance,
    expected: factor.target.value,
    tolerance: {
      min: factor.tolerance.minimum ?? undefined,
      max: factor.tolerance.maximum ?? undefined,
      maxAbsoluteDeviation: factor.tolerance.maximumDeviation ?? undefined,
    },
    }));
  const scriptShots = input.replicationScript?.shots ?? [];
  // The reference analysis can contain hundreds of shots, while a budget
  // semantic revision explicitly selects a compact authored subset. Only
  // shots selected into the final director brief form the output contract.
  const selectedScriptShots = input.workflow.directorBrief.scenes.flatMap(scene => {
    const selected = scriptShots.find(shot => shot.shotId === scene.sceneId)
      ?? scriptShots.find(shot => Boolean(scene.referenceShotId) && shot.referenceShotId === scene.referenceShotId);
    return selected ? [selected] : [];
  }).filter((shot, index, shots) => shots.findIndex(item => item.shotId === shot.shotId) === index);
  const referenceTimeline = fidelity && input.referenceAnalysis
    ? input.referenceAnalysis.shots.map(shot => ({
      shotId: shot.shotId, startSeconds: shot.startSeconds, endSeconds: shot.endSeconds, purpose: shot.purpose,
    })) : (fidelity ? scriptShots : selectedScriptShots).map(shot => ({
    shotId: shot.referenceShotId || shot.shotId,
    startSeconds: shot.startSeconds,
    endSeconds: shot.endSeconds,
    purpose: shot.purpose,
  }));
  const outputTimeline = input.workflow.directorBrief.scenes.map(scene => ({
    shotId: scene.sceneId,
    referenceShotId: scene.referenceShotId,
    startSeconds: scene.duration.startSeconds,
    endSeconds: scene.duration.endSeconds,
    purpose: scene.purpose,
  }));
  const replacementFactors = activeSourceFactors.filter(({ source }) => (
    source.policy === 'replace_identity' || source.category === 'identity'));
  const identityByScene = new Map<string, typeof replacementFactors[number]>();
  for (const factor of replacementFactors) if (!identityByScene.has(factor.sceneId)) identityByScene.set(factor.sceneId, factor);
  const identityRequirements = [...identityByScene.values()].map(({ source: factor, sceneId }) => ({
    requirementId: factor.factorId,
    identityType: 'other' as const,
    originalIdentity: String(factor.target.value ?? ''),
    expectedReplacement: job.target.productRef || job.target.accountRef?.id || null,
    sceneIds: [sceneId],
    required: factor.importance === 'critical' || factor.importance === 'high',
  }));
  const defaultFitChecks: AccountProductFitCheck[] = [
    {
      checkId: 'fact-source-binding', label: '导演方案绑定企业事实来源',
      outcome: input.workflow.directorBrief.factSourceRefs.length ? 'pass' : 'unknown', required: true,
      evidenceRefs: input.workflow.directorBrief.factSourceRefs,
      explanation: input.workflow.directorBrief.factSourceRefs.length ? '已绑定版本化事实来源' : '未发现事实来源引用',
    },
    {
      checkId: 'account-playbook-binding', label: '成片绑定目标账号 Playbook',
      outcome: job.target.accountPlaybookRef ? 'pass' : 'unknown', required: true,
      evidenceRefs: job.target.accountPlaybookRef ? [`account_playbook:${job.target.accountPlaybookRef.id}:${job.target.accountPlaybookRef.version}`] : [],
      explanation: job.target.accountPlaybookRef ? '使用冻结的账号规则版本' : '即时任务未绑定账号规则',
    },
  ];
  let automaticFactorEvidence: ReplicationFactorEvidence[] = [];
  let automaticReuseRiskEvidence: ReuseRiskEvidence[] = [];
  if (input.evidence?.referenceVideoPath && input.evidence.referenceVideoPath !== input.outputVideoPath) {
    try {
      const inspected = await inspectReplicationMediaEvidence({
        referenceVideoPath: input.evidence.referenceVideoPath,
        outputVideoPath: input.outputVideoPath,
        factors: factorSpecs.map(factor => ({
          factorId: factor.factorId,
          sceneId: factor.sceneId,
          category: factor.category,
          policy: factor.policy,
        })),
      });
      automaticFactorEvidence = inspected.factorEvidence;
      automaticReuseRiskEvidence = inspected.reuseRiskEvidence;
    } catch {
      // The evaluation kernel will keep the affected checks incomplete. Media
      // inspection failure must never be converted into a passing result.
    }
  }
  const suppliedFactorIds = new Set((input.evidence?.factorEvidence ?? []).map(item => item.factorId));
  const suppliedReuseKinds = new Set((input.evidence?.reuseRiskEvidence ?? []).map(item => item.kind));
  const report = await evaluateReplication({
    referenceTimeline,
    outputTimeline,
    factors: factorSpecs,
    factorScopeDeclared: true,
    ...(fidelity ? { timelineTolerance: { maxStartDriftSeconds: 0.08, maxDurationDriftRatio: 0.01, maxShotCountDifference: 0 } } : {}),
    factorEvidence: [
      ...(input.evidence?.factorEvidence ?? []),
      ...automaticFactorEvidence.filter(item => !suppliedFactorIds.has(item.factorId)),
    ],
    identityRequirements,
    identityEvidence: input.evidence?.identityEvidence ?? [],
    reuseRiskEvidence: [
      ...(input.evidence?.reuseRiskEvidence ?? []),
      ...automaticReuseRiskEvidence.filter(item => !suppliedReuseKinds.has(item.kind)),
    ],
    accountProductFitChecks: input.evidence?.accountProductFitChecks ?? defaultFitChecks,
    media: {
      referenceVideoPath: input.evidence?.referenceVideoPath ?? null,
      outputVideoPath: input.outputVideoPath,
      referenceText: input.evidence?.referenceText ?? null,
      outputText: input.evidence?.outputText ?? null,
    },
  });
  // A script is an authored derivative, never authoritative reference evidence.
  // Historic artifacts without the original analysis must return to review.
  if (fidelity && !input.referenceAnalysis?.shots.length) {
    report.releaseDecision = 'blocked';
    report.blockers.push({
      code: 'fidelity_reference_analysis_missing', severity: 'blocker',
      message: '单一参考复刻缺少原始逐镜分析，不能用执行方案代替参考分母',
    });
  }
  const generatedAt = (input.now ?? new Date()).toISOString();
  const evaluationId = `replication_evaluation_${hash({ job: job.replicationJobId, result: input.productionResultId, generatedAt })}`;
  const status: SocialReplicationEvaluation['status'] = report.releaseDecision === 'pass'
    ? 'passed'
    : report.releaseDecision === 'blocked' ? 'failed' : 'review_required';
  const evaluation: SocialReplicationEvaluation = {
    evaluationId,
    version: '1',
    replicationJobId: job.replicationJobId,
    replicationJobVersion: job.version,
    factorSpecVersion: job.factorSpecVersion,
    productionResultId: input.productionResultId,
    attemptId: `attempt_${hash({ evaluationId, outputVideoPath: input.outputVideoPath })}`,
    status,
    referenceTimelineAudit: {
      referenceShotCount: referenceTimeline.length,
      referenceDurationSeconds: referenceTimeline.reduce((total, shot) => total + Math.max(0, shot.endSeconds - shot.startSeconds), 0),
      outputShotCount: outputTimeline.length,
      fullCoverageValidated: Boolean(referenceTimeline.length)
        && referenceTimeline.length === outputTimeline.length
        && referenceTimeline.every((shot, index) => {
          const output = outputTimeline[index];
          return output?.referenceShotId === shot.shotId
            && (!fidelity || (Math.abs(output.startSeconds - shot.startSeconds) <= 0.08
              && Math.abs(output.endSeconds - shot.endSeconds) <= 0.08));
        }),
    },
    viralFactorFidelity: dimension(report, 'viralFactorFidelity'),
    identityReplacement: dimension(report, 'identityReplacement'),
    originalityDifference: dimension(report, 'originalityDifference'),
    unauthorizedReuseRisk: dimension(report, 'unauthorizedReuseRisk'),
    accountAndFactFit: dimension(report, 'accountProductFit'),
    sceneResults: report.shotResults.map(shot => ({
      sceneId: shot.sceneId,
      factorResults: shot.issues.map(issue => ({
        factorId: issue.factorId || `timeline:${issue.code}`,
        status: issue.severity === 'blocker' ? 'failed' : 'review_required',
        measuredValue: null,
        evidenceRefs: issue.evidenceId ? [issue.evidenceId] : [],
        repairAction: issue.message,
      })),
    })),
    generatedBy: 'media_evaluation_worker',
    generatedAt,
    directorDecision: {
      status: 'pending', reviewedBy: 'director_agent', failedCriteria: report.blockers.map(issue => issue.message), reviewedAt: null,
    },
  };
  return { evaluation, report };
}
