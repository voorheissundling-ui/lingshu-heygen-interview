import type { BenchmarkAnalysis } from './benchmarkAnalysis.js';

export interface ProductionReferenceAdmission {
  /** Admission for a new whole-video plan, not permission to redo paid work. */
  ready: boolean;
  blockers: string[];
  blockingShotIds: string[];
  executableShotIds: string[];
  reviewShotIds: string[];
}

/** A completed analysis job can still contain unresolved observations. Keep
 * those two facts separate, and expose per-shot evidence so an existing run
 * can retain finished assets and advance its other executable shots. This
 * pure rule never queues analysis, changes a classification or edits a plan. */
export function productionReferenceAdmission(analysis: BenchmarkAnalysis | null | undefined): ProductionReferenceAdmission {
  if (!analysis) return { ready: false, blockers: ['参考视频缺少可核验的逐镜分析'], blockingShotIds: [], executableShotIds: [], reviewShotIds: [] };
  const blockers: string[] = [];
  const reviewBlockers: string[] = [];
  const blockingShotIds: string[] = [];
  const executableShotIds: string[] = [];
  const reviewShotIds: string[] = [];
  for (const shot of analysis.shots) {
    const reasons: string[] = [];
    if (shot.granularity !== 'shot') reasons.push('物理镜头边界未确认，当前仅为观察片段');
    if (shot.start === null || shot.end === null || !Number.isFinite(shot.start) || !Number.isFinite(shot.end) || shot.start < 0 || shot.end <= shot.start) reasons.push('镜头起止时间无效');
    if (shot.materialType === 'unknown') reasons.push('镜头类型未确认');
    if (!shot.visual.trim() || /^(?:未分析|尚未分析|未知|待分析|无法确认|unknown)$/i.test(shot.visual.trim())) reasons.push('缺少可用画面证据');
    if (reasons.length) {
      blockingShotIds.push(shot.shotId);
      blockers.push(`第 ${shot.index} 镜：${reasons.join('、')}`);
    } else executableShotIds.push(shot.shotId);
    if (shot.needsReview || shot.narrativeRole === 'unknown' || !shot.classificationEvidence.trim()) {
      reviewShotIds.push(shot.shotId);
      if (!reasons.length) reviewBlockers.push(`第 ${shot.index} 镜：画面、用途或分类依据待复核`);
    }
  }
  blockers.push(...reviewBlockers);
  if (!analysis.shots.length) blockers.push('参考视频尚无逐镜分析');
  if (analysis.source.analysisMode !== 'exact') blockers.push('参考视频尚未完成全片精确分析');
  if (!analysis.timelineComplete) blockers.push('全片物理镜头时间线未完整覆盖原片');
  if (analysis.status === 'failed') blockers.push('原片分析失败，需先核对原分析任务');
  if (analysis.status === 'pending') blockers.push('原片分析尚未完成或已暂停');
  if (analysis.status === 'needs_review') blockers.push('原片分析已生成，但编导交接仍待复核');
  // Do not make UI-only source revision metadata a production gate. The
  // server validates its own tenant/version binding at the call boundary.
  if (!['needs_review', 'pending', 'failed'].includes(analysis.status)
    && analysis.gaps.includes('缺少已完成的原片分析状态')) blockers.push('原片分析的完成状态尚未核验');
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)], blockingShotIds, executableShotIds, reviewShotIds };
}
