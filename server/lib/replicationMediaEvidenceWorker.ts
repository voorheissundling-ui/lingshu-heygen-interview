import { inspectPersonReplacementPair } from './personReplacementMediaQuality.js';
import type { ReplicationFactorEvidence, ReuseRiskEvidence } from './replicationEvaluation.js';

export interface ReplicationMediaEvidenceWorkerResult {
  factorEvidence: ReplicationFactorEvidence[];
  reuseRiskEvidence: ReuseRiskEvidence[];
  limitations: string[];
}

const provenance = {
  producer: 'cv_worker' as const,
  detector: 'ffmpeg-replication-media-proxy',
  detectorVersion: '1.0',
};

/**
 * Produce deterministic media evidence that can be generated locally without
 * asking the production model to grade its own output. These measurements are
 * deliberately proxies: they cover timing/motion/background/audio reuse, but
 * never claim face, product or brand identity recognition.
 */
export async function inspectReplicationMediaEvidence(input: {
  referenceVideoPath: string;
  outputVideoPath: string;
  factors?: Array<{ factorId: string; sceneId: string; category: string; policy: string }>;
}): Promise<ReplicationMediaEvidenceWorkerResult> {
  const metrics = await inspectPersonReplacementPair(input.referenceVideoPath, input.outputVideoPath);
  const evidenceRefs = [input.referenceVideoPath, input.outputVideoPath];
  const reuseRiskEvidence: ReuseRiskEvidence[] = [
    {
      evidenceId: 'media-proxy-consecutive-frames',
      kind: 'consecutive_frame_similarity',
      similarity: metrics.wholeFrameSimilarity,
      riskThreshold: 0.92,
      status: metrics.comparedFrames > 0 ? 'available' : 'unavailable',
      authorization: 'unknown',
      evidenceRefs,
      explanation: `低分辨率整帧代理相似度；比较 ${metrics.comparedFrames} 帧。该指标不能替代区域级身份或产品检测。`,
      provenance,
    },
    {
      evidenceId: 'media-proxy-audio-fingerprint',
      kind: 'audio_fingerprint_similarity',
      similarity: metrics.audioCorrelation === null ? null : Math.abs(metrics.audioCorrelation),
      riskThreshold: 0.9,
      status: metrics.audioCorrelation === null ? 'unavailable' : 'available',
      authorization: 'unknown',
      evidenceRefs,
      explanation: metrics.audioCorrelation === null
        ? '参考或成片缺少可比较音轨，无法生成音频相关性代理。'
        : '基于单声道 8kHz 波形相关性的音频复用代理；不能替代声纹或音乐指纹服务。',
      provenance: { ...provenance, producer: 'audio_worker', detector: 'ffmpeg-waveform-correlation' },
    },
  ];

  const factorEvidence: ReplicationFactorEvidence[] = [];
  for (const factor of input.factors ?? []) {
    if (factor.policy === 'free' || factor.policy === 'replace_identity' || factor.policy === 'prohibit_reuse') continue;
    if (['rhythm', 'camera', 'interaction'].includes(factor.category)) {
      // This inspector samples the entire film. Applying one global motion
      // number to every scene invents scene-level failures or passes. Preserve
      // the measurement as a review item until a scene-window detector exists.
      factorEvidence.push({
        factorId: factor.factorId,
        sceneId: factor.sceneId,
        outcome: 'unknown',
        actual: metrics.temporalMotionDifference,
        confidence: null,
        evidenceRefs,
        explanation: `全片时序运动差 ${metrics.temporalMotionDifference.toFixed(3)}，冻结状态不一致比例 ${metrics.freezeMismatchRatio.toFixed(3)}；尚无逐镜测量，不能据此判断本镜头。`,
        provenance,
      });
    }
    if (factor.category === 'audio') {
      factorEvidence.push({
        factorId: factor.factorId,
        sceneId: factor.sceneId,
        outcome: metrics.audioCorrelation === null ? 'unknown' : 'pass',
        actual: metrics.audioCorrelation,
        confidence: metrics.audioCorrelation === null ? null : 0.7,
        evidenceRefs,
        explanation: '只验证音轨可比较性；原声音禁止复用由独立音频风险门禁判断。',
        provenance: { ...provenance, producer: 'audio_worker', detector: 'ffmpeg-waveform-correlation' },
      });
    }
  }
  return { factorEvidence, reuseRiskEvidence, limitations: [...metrics.limitations] };
}
