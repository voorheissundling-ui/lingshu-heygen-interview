import type { ObservedPresenterRole } from '../../shared/contracts/presenterShotRecognition.js';
export const SALES_REVIEW_VERSION = 7;
export type SalesShot = { time: string; visual?: string; dialogue?: string; observedPresenterRole?: ObservedPresenterRole; personContinuityId?: string; needsReview?: boolean };
export function salesReviewKey(sourceSha: string, shots: SalesShot[]): string {
  return JSON.stringify([SALES_REVIEW_VERSION, 'qwen', sourceSha, shots.map(s => [s.time, s.visual, s.dialogue])]);
}
export function validateSalesReview(raw: unknown, count: number) {
  const result = raw as { shots?: Array<{ index: number; role: ObservedPresenterRole; personId?: string; confidence?: number; evidence?: string }> };
  if (!Array.isArray(result?.shots) || result.shots.length !== count) throw new Error('销售人物复核结果不完整');
  const seen = new Set<number>();
  const rows = result.shots.map(row => {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= count || seen.has(row.index)) throw new Error('销售人物复核镜头索引无效');
    seen.add(row.index);
    if (!['sales_presenter', 'presenter_action', 'background', 'none', 'unknown'].includes(row.role)) throw new Error('销售人物复核角色无效');
    const confidence = Number(row.confidence);
    const personId = String(row.personId || '').trim();
    const reliable = Number.isFinite(confidence) && confidence >= .85 && confidence <= 1 && Boolean(String(row.evidence || '').trim());
    const role = reliable && (!['sales_presenter', 'presenter_action'].includes(row.role) || personId) ? row.role : 'unknown';
    return { index: row.index, observedPresenterRole: role as ObservedPresenterRole, personContinuityId: role === 'sales_presenter' || role === 'presenter_action' ? personId : '', needsReview: role === 'unknown', confidence: reliable ? confidence : 0, evidence: String(row.evidence || '').slice(0, 180) };
  }).sort((a,b) => a.index-b.index);
  const groups = new Map<string, number[]>();
  for (const row of rows) if (row.observedPresenterRole === 'sales_presenter') groups.set(row.personContinuityId, [...(groups.get(row.personContinuityId) || []), row.index]);
  // Multiple unrelated speakers must not silently become one enterprise identity.
  const primary = [...groups].sort((a,b)=>b[1].length-a[1].length);
  if (primary.length > 1 && primary[0][1].length === primary[1][1].length) {
    for (const row of rows) if (row.observedPresenterRole === 'sales_presenter') { row.observedPresenterRole = 'unknown'; row.needsReview = true; }
  } else if (primary.length > 1) {
    for (const row of rows) if (row.observedPresenterRole === 'sales_presenter' && row.personContinuityId !== primary[0][0]) { row.observedPresenterRole = 'unknown'; row.needsReview = true; }
  }
  return rows;
}

export function hasOnCameraSpeechEvidence(row: { faceVisible?: unknown; frontFacing?: unknown; speakingVisible?: unknown; confidence?: unknown; evidence?: unknown } | undefined): boolean {
  const confidence = Number(row?.confidence);
  return row?.faceVisible === true && row.frontFacing === true && row.speakingVisible === true
    && Number.isFinite(confidence) && confidence >= .85 && confidence <= 1 && typeof row.evidence === 'string' && Boolean(row.evidence.trim());
}
