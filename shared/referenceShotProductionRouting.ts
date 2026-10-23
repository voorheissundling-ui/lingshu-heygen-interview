import { benchmarkTimeRange } from './benchmarkAnalysis.js';
import type { ObservedPresenterRole } from './contracts/presenterShotRecognition.js';

export const REFERENCE_PRODUCTION_ROUTING_VERSION = 'reference_identity_first_v1';
export type ReferencePersonPresence = 'person' | 'hands_only' | 'none' | 'unknown';
export interface ReferencePresenterContinuityEvidence {
  time: string; personPresence: ReferencePersonPresence; observedPresenterRole: ObservedPresenterRole;
  personContinuityId?: string | null; confidence: number; evidence: string | string[]; frameSeconds: number[];
  model: string; provenance: string; sourceSha256: string;
}
export interface ReferenceProductionRouteInput {
  shotId: string; time: string;
  criticalShot?: { classification: 'critical' | 'non_critical'; model?: string; provenance?: string; primaryHook?: boolean; uniqueVisualMechanism?: boolean; explicitAudioVisualSync?: boolean };
  presenterContinuityEvidence?: ReferencePresenterContinuityEvidence;
}
export interface ReferenceShotProductionRouting {
  version: typeof REFERENCE_PRODUCTION_ROUTING_VERSION;
  state: 'ready' | 'awaiting_automatic_analysis';
  route: 'reference_frame_presenter' | 'library_match' | 'aigc_video'
    | 'non_presenter_library_match' | 'non_presenter_aigc_video' | 'undetermined';
  tier: 'high' | 'standard' | null;
  observedPresenterRole: ObservedPresenterRole; personPresence: ReferencePersonPresence;
  personContinuityId: string | null; criticality: 'critical' | 'non_critical' | 'unknown';
  reason: string; evidence: string[];
  source: { model: string; provenance: string; sourceSha256: string };
  identityLock: { required: true; sourcePersonId: string; groupKey: string;
    samePersonShotIds: string[]; targetPresenterAssetId: string | null } | null;
  constraints: { forbidGenericPersonMatch: boolean; mustUseReferenceFrames: boolean; nonPresenterBrollOnly: boolean };
  automaticAnalysisRequired: boolean;
}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const evidenceText = (value: string | string[] | undefined): string[] => (Array.isArray(value) ? value : [value])
  .map(text).filter(Boolean);

/** Independent identity admission, not the historical shot-wide confidence.
 * Old v6 `none` meant no foreground face, so only explicit new presence evidence
 * admits no-person/background/hands material. No prose inference is performed. */
function verifiedEvidence(shot: ReferenceProductionRouteInput, sourceSha256: string) {
  const evidence = shot.presenterContinuityEvidence;
  if (!evidence) return { evidence: null, reason: '缺少独立的人物连续性证据，系统需自动识别。' };
  if (!sourceSha256 || evidence.sourceSha256 !== sourceSha256) return { evidence: null, reason: '人物证据与当前原片指纹不一致，系统需自动重新识别。' };
  const range = benchmarkTimeRange(shot.time), sourceRange = benchmarkTimeRange(evidence.time);
  if (!range || !sourceRange || Math.abs(range.start - sourceRange.start) > .01 || Math.abs(range.end - sourceRange.end) > .01)
    return { evidence: null, reason: '人物证据时间窗与当前分镜不一致，系统需自动重新识别。' };
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < .85 || evidence.confidence > 1
    || !text(evidence.model) || !text(evidence.provenance) || !evidenceText(evidence.evidence).length)
    return { evidence: null, reason: '人物模型证据不足或置信度不足，系统需自动补充识别。' };
  const frames = Array.isArray(evidence.frameSeconds) ? evidence.frameSeconds : [];
  if (new Set(frames).size < 2 || !frames.every(seconds => Number.isFinite(seconds) && seconds >= range.start && seconds < range.end))
    return { evidence: null, reason: '缺少当前镜头内的真实连续抽帧证据，系统需自动补充识别。' };
  if (!['person', 'hands_only', 'none', 'unknown'].includes(evidence.personPresence)
    || !['sales_presenter', 'presenter_action', 'background', 'none', 'unknown'].includes(evidence.observedPresenterRole))
    return { evidence: null, reason: '人物角色或出镜证据结构无效，系统需自动识别。' };
  return { evidence, reason: '' };
}

/** Source-person identity precedes cost/criticality routing. `ready` means a
 * planning decision, not that an account identity asset is bound or generated. */
export function buildReferenceShotProductionRouting(input: {
  shots: ReferenceProductionRouteInput[]; sourceSha256: string; identityTargets?: Record<string, string>;
}): {
  version: typeof REFERENCE_PRODUCTION_ROUTING_VERSION;
  shots: Array<{ shotId: string; productionRouting: ReferenceShotProductionRouting }>;
  presenterGroups: Array<{ personContinuityId: string; shotIds: string[]; targetPresenterAssetId: string | null }>;
} {
  const verified = input.shots.map(shot => verifiedEvidence(shot, input.sourceSha256));
  const speakerIds = new Set(verified.flatMap(row => row.evidence?.personPresence === 'person'
    && row.evidence.observedPresenterRole === 'sales_presenter' && text(row.evidence.personContinuityId)
    ? [text(row.evidence.personContinuityId)] : []));
  const groupShots = (personId: string) => input.shots.flatMap((shot, index) => {
    const evidence = verified[index].evidence;
    return evidence?.personPresence === 'person' && ['sales_presenter', 'presenter_action'].includes(evidence.observedPresenterRole)
      && text(evidence.personContinuityId) === personId ? [shot.shotId] : [];
  });
  const shots = input.shots.map((shot, index) => {
    const checked = verified[index], evidence = checked.evidence;
    const classification = shot.criticalShot?.classification;
    // Director's actual hook and audiovisual evidence takes precedence over a coarse noncritical label.
    const criticality = shot.criticalShot?.primaryHook === true || shot.criticalShot?.uniqueVisualMechanism === true
      || shot.criticalShot?.explicitAudioVisualSync === true ? 'critical'
      : classification === 'critical' || classification === 'non_critical' ? classification : 'unknown';
    const source = { model: text(evidence?.model), provenance: text(evidence?.provenance), sourceSha256: input.sourceSha256 };
    const base: ReferenceShotProductionRouting = { version: REFERENCE_PRODUCTION_ROUTING_VERSION,
      state: 'awaiting_automatic_analysis', route: 'undetermined', tier: null,
      observedPresenterRole: evidence?.observedPresenterRole || 'unknown', personPresence: evidence?.personPresence || 'unknown',
      personContinuityId: text(evidence?.personContinuityId) || null, criticality,
      reason: checked.reason, evidence: evidenceText(evidence?.evidence), source, identityLock: null,
      constraints: { forbidGenericPersonMatch: true, mustUseReferenceFrames: false, nonPresenterBrollOnly: false },
      automaticAnalysisRequired: true };
    const unresolved = (reason: string) => ({ shotId: shot.shotId, productionRouting: { ...base, reason } });
    if (!evidence) return unresolved(checked.reason);
    const role = evidence.observedPresenterRole, presence = evidence.personPresence, personId = text(evidence.personContinuityId);
    if (presence === 'unknown' || role === 'unknown') return unresolved('人物角色或身份仍未确定，系统需自动补充抽帧识别，不能直接匹配人物素材。');
    if (criticality === 'unknown') return unresolved('关键镜头判定尚未完成，系统需自动补充分析。');
    const tier = criticality === 'critical' ? 'high' as const : 'standard' as const;
    if (role === 'sales_presenter' || role === 'presenter_action') {
      if (presence !== 'person' || !personId) return unresolved('主讲人物缺少可确认的出镜身份，系统需自动补充识别。');
      if (role === 'presenter_action' && !speakerIds.has(personId)) return unresolved('动作人物尚未与销售主讲者绑定同一身份，系统需自动比对人物连续性。');
      return { shotId: shot.shotId, productionRouting: { ...base, state: 'ready' as const,
        route: 'reference_frame_presenter' as const, tier, automaticAnalysisRequired: false,
        reason: criticality === 'critical'
          ? '已确认主讲人物及连续身份，按原片人物动作与背景生成高保真镜头。'
          : '已确认主讲人物及连续身份，使用原片参考帧生成标准档镜头；非关键性不允许改为普通人物素材匹配。',
        identityLock: { required: true as const, sourcePersonId: personId,
          groupKey: `${input.sourceSha256}:${personId}`, samePersonShotIds: groupShots(personId),
          targetPresenterAssetId: text(input.identityTargets?.[personId]) || null },
        constraints: { forbidGenericPersonMatch: true, mustUseReferenceFrames: true, nonPresenterBrollOnly: false } } };
    }
    if (presence === 'person' && role === 'background') {
      if (personId && speakerIds.has(personId)) return unresolved('背景人物与主讲人物身份出现冲突，系统需自动核对，不可直接匹配其他人物。');
      return { shotId: shot.shotId, productionRouting: { ...base, state: 'ready' as const,
        route: criticality === 'critical' ? 'non_presenter_aigc_video' as const : 'non_presenter_library_match' as const,
        tier, automaticAnalysisRequired: false,
        reason: criticality === 'critical' ? '确认是非主讲背景人物镜头，生成关键画面，不作为销售口播人物替换。'
          : '确认是工人或其他非主讲背景人物说明镜头，可匹配素材库中的非口播人物 B-roll。',
        constraints: { forbidGenericPersonMatch: false, mustUseReferenceFrames: criticality === 'critical', nonPresenterBrollOnly: true } } };
    }
    if (role === 'none' && presence === 'hands_only') return { shotId: shot.shotId,
      productionRouting: { ...base, state: 'ready' as const,
        route: criticality === 'critical' ? 'non_presenter_aigc_video' as const : 'non_presenter_library_match' as const,
        tier, automaticAnalysisRequired: false,
        reason: criticality === 'critical' ? '确认只有手部展示，没有已识别主讲人物；生成关键产品动作镜头。'
          : '确认只有手部展示，不属于主讲人物口播；可匹配产品使用或手部展示素材。',
        constraints: { forbidGenericPersonMatch: false, mustUseReferenceFrames: criticality === 'critical', nonPresenterBrollOnly: true } } };
    if (role === 'none' && presence === 'none') return { shotId: shot.shotId, productionRouting: { ...base,
      state: 'ready' as const, route: criticality === 'critical' ? 'aigc_video' as const : 'library_match' as const,
      tier, automaticAnalysisRequired: false,
      reason: criticality === 'critical' ? '独立视觉证据确认无人出镜，关键镜头使用视频生成。' : '独立视觉证据确认无人出镜，普通说明镜头匹配库内素材。',
      constraints: { forbidGenericPersonMatch: true, mustUseReferenceFrames: criticality === 'critical', nonPresenterBrollOnly: true } } };
    return unresolved('人物出现状态与角色证据矛盾，系统需自动重新识别。');
  });
  return { version: REFERENCE_PRODUCTION_ROUTING_VERSION, shots, presenterGroups: [...speakerIds].map(personContinuityId => ({
    personContinuityId, shotIds: groupShots(personContinuityId), targetPresenterAssetId: text(input.identityTargets?.[personContinuityId]) || null })) };
}
