export interface VoiceListeningSample {
  sampleId: string;
  language: string;
  voiceProfileId: string;
  votes: number;
  mos: number;
  naturalness: number;
  personality: number;
  marketingNaturalness: number;
  trust: number;
  pronunciationErrors: number;
  evaluatedWords: number;
  criticalFailure?: boolean;
}

export interface MarketingExperimentResult {
  experimentId: string;
  control: { impressions: number; conversions: number; negativeEvents: number };
  treatment: { impressions: number; conversions: number; negativeEvents: number };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}

export function assessVoiceListeningSet(samples: VoiceListeningSample[]): {
  passed: boolean;
  failures: string[];
  metrics: Record<string, number>;
} {
  const failures: string[] = [];
  const valid = samples.filter(sample => sample.sampleId && sample.language && sample.voiceProfileId
    && sample.votes >= 8 && !sample.criticalFailure);
  const unique = new Set(valid.map(sample => sample.sampleId)).size;
  const totalWords = valid.reduce((sum, sample) => sum + Math.max(0, sample.evaluatedWords), 0);
  const pronunciationErrors = valid.reduce((sum, sample) => sum + Math.max(0, sample.pronunciationErrors), 0);
  const metrics = {
    sampleCount: unique,
    averageVotes: mean(valid.map(sample => sample.votes)),
    mos: mean(valid.map(sample => bounded(sample.mos, 1, 5))),
    naturalness: mean(valid.map(sample => bounded(sample.naturalness, 1, 5))),
    personality: mean(valid.map(sample => bounded(sample.personality, 1, 5))),
    marketingNaturalness: mean(valid.map(sample => bounded(sample.marketingNaturalness, 1, 5))),
    trust: mean(valid.map(sample => bounded(sample.trust, 1, 5))),
    pronunciationErrorRate: totalWords ? pronunciationErrors / totalWords : 1,
  };
  if (samples.some(sample => sample.criticalFailure)) failures.push('存在严重错读、杂音或身份漂移');
  if (unique < 30) failures.push('有效母语听审样本少于30条');
  if (metrics.averageVotes < 8) failures.push('单条平均有效评分少于8人');
  if (metrics.mos < 4) failures.push('MOS低于4.0');
  if (metrics.naturalness < 4) failures.push('自然度低于4.0');
  if (metrics.personality < 3.8) failures.push('人物感低于3.8');
  if (metrics.marketingNaturalness < 3.8) failures.push('营销自然度低于3.8');
  if (metrics.trust < 4) failures.push('可信度低于4.0');
  if (metrics.pronunciationErrorRate > .02) failures.push('发音错误率高于2%');
  return { passed: failures.length === 0, failures, metrics };
}

function rate(group: MarketingExperimentResult['control'], field: 'conversions' | 'negativeEvents'): number {
  return group.impressions > 0 ? group[field] / group.impressions : 0;
}

export function assessMarketingExperiment(experiment: MarketingExperimentResult): {
  passed: boolean;
  failures: string[];
  conversionLift: number;
  zScore: number;
  negativeRateDelta: number;
} {
  const failures: string[] = [];
  const controlRate = rate(experiment.control, 'conversions');
  const treatmentRate = rate(experiment.treatment, 'conversions');
  const pooled = (experiment.control.conversions + experiment.treatment.conversions)
    / Math.max(1, experiment.control.impressions + experiment.treatment.impressions);
  const error = Math.sqrt(Math.max(1e-12, pooled * (1 - pooled)
    * (1 / Math.max(1, experiment.control.impressions) + 1 / Math.max(1, experiment.treatment.impressions))));
  const zScore = (treatmentRate - controlRate) / error;
  const conversionLift = controlRate > 0 ? (treatmentRate - controlRate) / controlRate : 0;
  const negativeRateDelta = rate(experiment.treatment, 'negativeEvents') - rate(experiment.control, 'negativeEvents');
  if (experiment.control.impressions < 2_000 || experiment.treatment.impressions < 2_000) failures.push('每个实验组曝光少于2000');
  if (conversionLift < .05) failures.push('主转化指标提升低于5%');
  if (zScore < 1.96) failures.push('转化提升未达到95%置信门槛');
  if (negativeRateDelta > .002) failures.push('负向反馈率上升超过0.2个百分点');
  return {
    passed: failures.length === 0,
    failures,
    conversionLift: Number(conversionLift.toFixed(4)),
    zScore: Number(zScore.toFixed(4)),
    negativeRateDelta: Number(negativeRateDelta.toFixed(4)),
  };
}

export function voiceLearningReadiness(input: {
  technicalPassed: boolean;
  listeningSamples?: VoiceListeningSample[];
  experiments?: MarketingExperimentResult[];
}) {
  const listening = assessVoiceListeningSet(input.listeningSamples ?? []);
  const experiments = (input.experiments ?? []).map(assessMarketingExperiment);
  const repeatedBusinessSupport = experiments.filter(result => result.passed).length >= 2;
  return {
    schemaVersion: 'voice-learning-readiness.v1',
    technicalPassed: input.technicalPassed,
    listening,
    experiments,
    status: !input.technicalPassed ? 'rejected'
      : !listening.passed ? 'technical_only'
        : repeatedBusinessSupport ? 'business_validated' : 'listening_validated',
    canPromoteToTenantStyleLibrary: input.technicalPassed && listening.passed && repeatedBusinessSupport,
  } as const;
}

