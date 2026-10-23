import type { StoryboardQaReport } from './storyboardAigcQuality.js';

export interface StoryboardAigcMetricMaterial {
  id: string;
  sourceType?: string;
  createdAt: string;
  provenance?: Record<string, unknown>;
}

const rate = (numerator: number, denominator: number): number | null => denominator ? Math.round(numerator / denominator * 1000) / 1000 : null;
const amount = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Project-scoped, evidence-based counters. Null rates mean no sample exists. */
export function storyboardAigcMetrics(materials: StoryboardAigcMetricMaterial[], adoptedMaterialIds: Iterable<string>) {
  const firstFrames = materials.filter(item => item.sourceType === 'ai-storyboard-first-frame');
  const videos = materials.filter(item => item.sourceType === 'ai-seedance' && item.provenance?.storyboardAigc === true);
  const byShot = new Map<string, StoryboardAigcMetricMaterial[]>();
  for (const item of firstFrames) {
    const shotId = String(item.provenance?.shotId || '');
    if (!shotId) continue;
    byShot.set(shotId, [...(byShot.get(shotId) || []), item]);
  }
  const firstAttempts = [...byShot.values()].map(items => items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!);
  const firstPasses = firstAttempts.filter(item => (item.provenance?.firstFrameQuality as StoryboardQaReport | undefined)?.passed === true).length;
  const adopted = new Set(adoptedMaterialIds);
  const adoptedVideos = videos.filter(item => adopted.has(item.id));
  const reports = videos.map(item => item.provenance?.storyboardQualityReport as StoryboardQaReport | undefined).filter((item): item is StoryboardQaReport => !!item);
  const identityErrors = reports.filter(report => report.reasonCodes.includes('PRODUCT_IDENTITY_FAILED')).length;
  const actionReports = reports.filter(report => report.checks.action_order || report.checks.end_state);
  const actionComplete = actionReports.filter(report => report.checks.end_state?.verdict === 'pass' && report.checks.action_order?.verdict === 'pass').length;
  const attemptsByShot = new Map<string, number>();
  for (const item of videos) {
    const shotId = String(item.provenance?.shotId || '');
    if (shotId) attemptsByShot.set(shotId, (attemptsByShot.get(shotId) || 0) + 1);
  }
  const elapsed = [...firstFrames, ...videos].map(item => amount(item.provenance?.generationLatencyMs)).filter(Boolean);
  return {
    firstFrameCandidates: firstFrames.length, firstFrameShots: byShot.size,
    firstFrameFirstPassRate: rate(firstPasses, firstAttempts.length),
    videoCandidates: videos.length, videoAdopted: adoptedVideos.length,
    videoAdoptionRate: rate(adoptedVideos.length, videos.length),
    productIdentityErrorRate: rate(identityErrors, reports.length),
    actionCompletionRate: rate(actionComplete, actionReports.length),
    averageVideoAttemptsPerShot: attemptsByShot.size ? Math.round(videos.length / attemptsByShot.size * 100) / 100 : null,
    averageGenerationSeconds: elapsed.length ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length / 10) / 100 : null,
    estimatedCostCny: Math.round([...firstFrames, ...videos].reduce((sum, item) => sum + amount(item.provenance?.estimatedCostCny), 0) * 100) / 100,
    note: '费用为提交时预估，采用率以项目当前分镜绑定为准；空样本率返回 null。',
  };
}
