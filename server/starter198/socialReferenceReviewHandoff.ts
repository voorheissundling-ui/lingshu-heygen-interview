import {verifiedNonPresenterReference} from './referencePresenterRequirement.js';
import { createHash } from 'node:crypto';
import { parseAnalysisTimeRange } from '../lib/videoAnalysisCodec.js';
import { reviewShotMaterialRefs } from '../lib/referenceShotReview.js';
import { hookScriptFields, type HookScript } from '../lib/referenceShotReview.js';
import { validateVerifiedSpeechLines } from '../lib/verifiedReferenceSpeech.js';
import { approximateSpeechLines } from '../lib/referenceApproxSpeech.js';

type UnknownRecord = Record<string, unknown>;
const object = (value: unknown): UnknownRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const usable = (value: unknown): boolean => {
  const text = string(value);
  return Boolean(text) && !/[<>]/.test(text) && !/^(?:待填|待核实|待确认|占位|TODO|TBD|placeholder|unknown|N\/A|未提供|未核实|未确认)(?:[：:].*)?$/i.test(text);
};
const parse = (value: unknown): UnknownRecord => {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return {}; }
};

export type ReferenceReviewIssueCode =
  | 'analysis_not_verified' | 'shot_needs_review' | 'shot_timing_missing'
  | 'shot_media_missing' | 'speech_timing_coarse' | 'speech_unassigned'
  | 'hook_missing' | 'hook_action_unverified' | 'hook_script_incomplete' | 'presenter_asset_unlocked'
  | 'reference_claim_unverified' | 'mixed_scene_possible' | 'shot_description_incomplete'
  | 'speech_line_invalid';

export interface ReferenceReviewIssue {
  code: ReferenceReviewIssueCode;
  shotId: string | null;
  evidenceRefs: string[];
  action: string;
}

export interface ReferenceReviewShot {
  shotId: string;
  /** One phrase can span cuts; one continuous picture can carry many phrases. */
  cueIds: string[];
  startSeconds: number | null;
  endSeconds: number | null;
  content: string;
  purpose: string;
  observedFacts: string;
  inferredIntent: string;
  originalSpeech: string | null;
  originalSpeechIsVerified: boolean;
  originalSpeechTimingPrecision: 'phrase' | 'coarse' | 'none';
  evidence: { sourceVideoRef: string | null; clipRef: string | null; firstFrameRef: string | null; extractionStatus: string };
  issues: ReferenceReviewIssueCode[];
}

/** A review handoff can be read by Director and Content Agent for planning.
 * Only production_ready may be consumed by paid/render execution. */
export interface SocialReferenceReviewHandoff {
  schemaVersion: 1;
  referenceRecordId: string;
  analysisRunId: string | null;
  versionHash: string;
  status: 'review_only' | 'production_ready';
  analysisQuality: string;
  sourceVideoRef: string | null;
  selectedHookShotId: string | null;
  /** Source window of the selected hook; it does not attest motion verification. */
  hookActionInterval: { startSeconds: number | null; endSeconds: number | null; sourceVideoRef: string | null };
  hookScript: { shotId: string | null; fields: HookScript; confirmed: boolean; evidenceRefs: string[] };
  presenterLock: { assetId: string; assetVersion: string } | null;
  verifiedEnterpriseFactRefs: string[];
  sourceClaimsAreEnterpriseFacts: false;
  shots: ReferenceReviewShot[];
  issues: ReferenceReviewIssue[];
  directorHandoffReady: boolean;
  productionExecutionAllowed: boolean;
}

export function buildSocialReferenceReviewHandoff(input: {
  record: UnknownRecord;
  presenter?: { assetId: string; assetVersion: string; rightsVerified?: boolean; rightsEvidenceRef?: string } | null;
  verifiedEnterpriseFactRefs?: string[];
}): SocialReferenceReviewHandoff {
  const analysis = parse(input.record.aiAnalysis);
  const gemini = parse(analysis.gemini);
  const recordId = string(input.record.id);
  const reviewed = parse(input.record.referenceShotReview);
  const reviewedShots = list(reviewed.shots).map(object);
  const reviewCurrent = string(reviewed.sourceAnalysisRunId) === string(analysis.analysisRunId)
    && string(reviewed.referenceRecordId) === recordId;
  const reviewComplete = reviewCurrent && reviewed.reviewComplete === true && list(reviewed.sections).length === 6
    && reviewedShots.length > 0;
  const allRawDetails: UnknownRecord[] = list(gemini.scriptDetails15s).map((item, index) => ({ ...object(item), shotId: string(object(item).shotId) || `shot-${index + 1}` }));
  const rawDetails = allRawDetails.filter(detail => {
    const range = parseAnalysisTimeRange(string(detail.time || detail.timestamp));
    return range && range.end - range.start >= .2;
  });
  const details: UnknownRecord[] = reviewComplete ? reviewedShots.filter(shot => string(shot.reviewStatus) !== 'discarded').map(shot => {
    const ids = list(shot.sourceShotIds).map(string);
    const source = ids.length === 1 ? allRawDetails[Number(ids[0]?.replace(/^shot-/, '')) - 1] : null;
    const originalRange = source ? parseAnalysisTimeRange(string(source.time || source.timestamp)) : null;
    const sameRange = originalRange && Math.abs(originalRange.start - Number(shot.start)) < .06 && Math.abs(originalRange.end - Number(shot.end)) < .06;
    const refs = reviewShotMaterialRefs(input.record, {shotId:string(shot.shotId),start:Number(shot.start),end:Number(shot.end)});
    const generated = refs.every(ref => list(shot.evidenceRefs).includes(ref));
    const materialEvidence = generated ? {clipRef:refs[0],firstFrameRef:refs[1],extractionStatus:'ready'}
      : sameRange ? source?.materialEvidence : {};
    return { ...shot, time: `${shot.start}-${shot.end}`, visual: shot.content, purpose: shot.purpose, materialEvidence,
      observedFacts: source?.observedFacts, inferredIntent: shot.purpose, needsReview: false,
      hookMotionEvidence: source?.hookMotionEvidence, dialogue: source?.dialogue };
  }) : rawDetails;
  const sourceVideoRef = recordId ? `/api/overseas/videos/${recordId}/media` : null;
  const sceneCuts = list(gemini.detectedSceneCuts).concat(list(analysis.detectedSceneCuts))
    .map(Number).filter(Number.isFinite);
  const issues: ReferenceReviewIssue[] = [];
  const add = (code: ReferenceReviewIssueCode, shotId: string | null, evidenceRefs: string[], action: string) => {
    issues.push({ code, shotId, evidenceRefs, action });
  };
  if (string(analysis.analysisMode) !== 'exact' || !['video', 'video_review_required'].includes(string(analysis.analysisQuality))) {
    add('analysis_not_verified', null, sourceVideoRef ? [sourceVideoRef] : [], '编导 Agent 需自动补齐全片精确分析与物理分镜证据');
  }
  if (!details.length) add('shot_timing_missing', null, sourceVideoRef ? [sourceVideoRef] : [], '完成全片物理分镜切分');
  const verified = parse(input.record.referenceVerifiedSpeech);
  const verifiedLines = list(verified.lines).map(object);
  // The verified-speech record itself is the phrase-level evidence. Its saved
  // lines intentionally have no timingPrecision field; coarse ASR lives only
  // in the analysis candidate and must never satisfy this validation.
  const finalShotRange = parseAnalysisTimeRange(string(details.at(-1)?.time || details.at(-1)?.timestamp));
  const duration = Number(analysis.durationSeconds || input.record.durationSeconds || finalShotRange?.end || 0);
  let validVerifiedLines = false;
  try {
    validateVerifiedSpeechLines(verifiedLines, duration);
    validVerifiedLines = verifiedLines.every(line => usable(line.text)
      && (line.timingPrecision === undefined || line.timingPrecision === 'phrase'));
  } catch { /* leave the handoff in review_only */ }
  const verifiedSpeech = verified.schemaVersion === 1
    && string(verified.analysisRunId) === string(analysis.analysisRunId)
    && string(verified.sourceSha256) === string(analysis.contentSha256)
    && verified.coverageConfirmed === true && usable(verified.reviewerId) && usable(verified.verifiedAt)
    && validVerifiedLines;
  if (verifiedLines.length && !validVerifiedLines) {
    add('speech_line_invalid', null, sourceVideoRef ? [sourceVideoRef] : [], '逐条核对口播原文、精确句级起止时间及占位符；不能用手填覆盖确认代替逐句证据');
  }
  const speech: UnknownRecord[] = verifiedSpeech ? verifiedLines : approximateSpeechLines(object(gemini.audioTranscript).segments).map(object);
  if (!speech.length) add('speech_unassigned', null, sourceVideoRef ? [sourceVideoRef] : [], '原片缺少可用的口播文本与大致时间码');
  const shots: ReferenceReviewShot[] = details.map((detail, index) => {
    const shotId = string(detail.shotId) || `shot-${index + 1}`;
    const range = parseAnalysisTimeRange(string(detail.time || detail.timestamp));
    const material = object(detail.materialEvidence);
    const clipRef = string(material.clipRef) || null;
    const firstFrameRef = string(material.firstFrameRef) || null;
    const rowIssues: ReferenceReviewIssueCode[] = [];
    const flag = (code: ReferenceReviewIssueCode, refs: string[], action: string) => {
      rowIssues.push(code); add(code, shotId, refs, action);
    };
    if (!range || range.end <= range.start) flag('shot_timing_missing', sourceVideoRef ? [sourceVideoRef] : [], '校正分镜起止时间');
    if (range) {
      const interiorCuts = reviewComplete ? [] : sceneCuts.filter(cut => cut > range.start + 0.15 && cut < range.end - 0.15);
      if (interiorCuts.length) flag('mixed_scene_possible', [clipRef, sourceVideoRef].filter((ref): ref is string => Boolean(ref)),
        `在 ${interiorCuts.map(cut => cut.toFixed(2)).join('、')} 秒检查疑似场景切点；如为物理切镜，拆分后重新关联台词和首帧`);
    }
    // A model review hint is not a request for user labor. Concrete missing
    // description, timing, or media evidence is checked below instead.
    if (!usable(detail.visual) || !usable(detail.purpose)) {
      flag('shot_description_incomplete', [clipRef, sourceVideoRef].filter((ref): ref is string => Boolean(ref)), '逐镜核实视觉主题、可见主体及表达目的，不得提交空值或占位符');
    }
    if (string(material.extractionStatus) !== 'ready' || !usable(clipRef) || !usable(firstFrameRef)) {
      flag('shot_media_missing', [clipRef, firstFrameRef, sourceVideoRef].filter((ref): ref is string => Boolean(ref)), '补抽原分镜切片和真实首帧；短闪帧可标为仅参考，不进入复刻制作');
    }
    const overlappingLines = range ? speech
      .map((item, speechIndex) => ({ item, speechIndex }))
      .filter(({ item }) => Number(item.start) < range.end && Number(item.end) > range.start) : [];
    const cueIds = overlappingLines.map(({ item, speechIndex }) =>
      string(item.cueId) || `speech-${String(speechIndex + 1).padStart(3, '0')}`);
    const dialogue = overlappingLines.map(({ item }) => string(item.text)).filter(Boolean).join(' ');
    if (!dialogue && speech.some(item => {
      const start = Number(item.start), end = Number(item.end);
      return range && Number.isFinite(start) && Number.isFinite(end) && start < range.end && end > range.start;
    })) flag('speech_unassigned', [clipRef, sourceVideoRef].filter((ref): ref is string => Boolean(ref)), '将可用 ASR 口播的大致时间码关联本镜');
    return {
      shotId, cueIds, startSeconds: range?.start ?? null, endSeconds: range?.end ?? null,
      content: string(detail.visual), purpose: string(detail.purpose),
      observedFacts: string(detail.observedFacts), inferredIntent: string(detail.inferredIntent),
      originalSpeech: dialogue || null, originalSpeechIsVerified: Boolean(dialogue) && Boolean(verifiedSpeech) && detail.needsReview !== true,
      originalSpeechTimingPrecision: dialogue ? (verifiedSpeech ? 'phrase' : 'coarse') : 'none',
      evidence: { sourceVideoRef, clipRef, firstFrameRef, extractionStatus: string(material.extractionStatus) || 'unavailable' },
      issues: rowIssues,
    };
  });
  const selectedHook = (reviewComplete && string(reviewed.selectedHookShotId)
    ? shots.find(shot => shot.shotId === string(reviewed.selectedHookShotId)
      && shot.startSeconds !== null && shot.endSeconds !== null
      && shot.startSeconds < 1 && shot.endSeconds > 0 && shot.endSeconds - shot.startSeconds >= .2) : null)
    ?? shots.find(shot => shot.startSeconds !== null && shot.endSeconds !== null
    && shot.startSeconds < 1 && shot.endSeconds > 0 && shot.endSeconds - shot.startSeconds >= .2) ?? null;
  if (!selectedHook) add('hook_missing', null, sourceVideoRef ? [sourceVideoRef] : [], '检查 0–1 秒快速截流动作；排除不足 0.2 秒的封面闪帧，必要时重划视觉切点');
  else {
    const raw = details[shots.indexOf(selectedHook)]!;
    const reviewedHookReady = reviewComplete && string(raw.shotId) === string(reviewed.selectedHookShotId)
      && raw.reviewStatus === 'confirmed' && raw.hookMotionConfirmed === true
      && usable(raw.hookAction) && string(raw.hookAction).length >= 20
      && selectedHook.evidence.extractionStatus === 'ready'
      && usable(selectedHook.evidence.clipRef) && usable(selectedHook.evidence.firstFrameRef);
    const automaticMotion = object(raw.hookMotionEvidence);
    const machineHookReady = !reviewComplete && string(automaticMotion.status) === 'verified'
      && selectedHook.evidence.extractionStatus === 'ready'
      && usable(selectedHook.evidence.clipRef) && usable(selectedHook.evidence.firstFrameRef);
    if (!reviewedHookReady && !machineHookReady) {
      add('hook_action_unverified', selectedHook.shotId,
        [selectedHook.evidence.firstFrameRef, selectedHook.evidence.clipRef].filter((ref): ref is string => Boolean(ref)),
        '编导 Agent 需核验所选开场镜头的逐帧动作、节奏变化与声音进入点，按原片标注动作和口播时间');
    }
  }
  const reviewedHook = reviewedShots.find(shot => string(shot.shotId) === selectedHook?.shotId);
  const rawHook = selectedHook ? details[shots.indexOf(selectedHook)] : undefined;
  const rawHookRange = parseAnalysisTimeRange(string(rawHook?.time || rawHook?.timestamp));
  const transcriptSegments = list(object(gemini.audioTranscript).segments).map(object);
  const hookTranscriptSpeech = rawHookRange ? transcriptSegments.filter(segment =>
    usable(segment.text) && Number(segment.start) < rawHookRange.end && Number(segment.end) > rawHookRange.start)
    .map(segment => string(segment.text)).filter(Boolean).join(' ') : '';
  const hookHasObservedSpeech = Boolean(hookTranscriptSpeech);
  const observedSpeech = string(rawHook?.voiceover) || string(rawHook?.dialogue) || hookTranscriptSpeech;
  const observedSoundEffects = list(rawHook?.soundEffects).map(string).filter(Boolean).join('；');
  const rawCandidates: HookScript = {
    camera: string(rawHook?.camera), visual: string(rawHook?.visual),
    subject: string(rawHook?.observedFacts) || string(rawHook?.visual),
    music: string(rawHook?.bgm),
    // Providers do not agree on whether visible presenter speech belongs in
    // `voiceover` or `dialogue`. Both fields are source evidence, so preserve
    // the observed line in both review dimensions instead of manufacturing a
    // false "missing voiceover" gate for an on-camera hook.
    voiceover: observedSpeech || (!hookHasObservedSpeech && transcriptSegments.length
      ? '无（原片该镜头未检测到口播）' : ''),
    soundEffects: observedSoundEffects || (Array.isArray(rawHook?.soundEffects)
      ? '无（原片该镜头未检测到独立音效）' : ''),
    spokenWords: observedSpeech || (!hookHasObservedSpeech && transcriptSegments.length
      ? '无（原片该镜头未检测到人物台词）' : ''),
    subjectAction: list(rawHook?.beats).map(object).map(beat => string(beat.action)).filter(Boolean).join('；'),
  };
  const scriptFields = Object.fromEntries(hookScriptFields.map(key => [key,
    string(object(reviewedHook?.hookScript)[key]) || rawCandidates[key]])) as HookScript;
  const hookScriptConfirmed = (reviewComplete ? reviewedHook?.hookScriptConfirmed === true
    : string(object(rawHook?.hookMotionEvidence).status) === 'verified')
    && hookScriptFields.every(key => usable(scriptFields[key]));
  if (!hookScriptConfirmed) add('hook_script_incomplete', selectedHook?.shotId ?? null,
    [selectedHook?.evidence.firstFrameRef, selectedHook?.evidence.clipRef, sourceVideoRef].filter((ref): ref is string => Boolean(ref)),
    '编导 Agent 需自动补齐运镜、画面、出镜主体、配乐、配音、音效、主体话术和主体动作；没有证据的字段不能猜测');
  const presenter = usable(input.presenter?.assetId) && usable(input.presenter?.assetVersion)
    && input.presenter?.rightsVerified === true && usable(input.presenter?.rightsEvidenceRef) ? {
    assetId: input.presenter.assetId, assetVersion: input.presenter.assetVersion,
  } : null;
  const presenterDuration = Number(input.record.durationSeconds || input.record.duration || analysis.durationSeconds || 0);
  const presenterDurationConsistent = [input.record.durationSeconds, input.record.duration, analysis.durationSeconds]
    .filter(value => value !== undefined && value !== null && value !== '').every(value => Number.isFinite(Number(value)) && Math.abs(Number(value) - presenterDuration) <= .01);
  if (!presenter && !(presenterDurationConsistent && verifiedNonPresenterReference({sourceSha256:analysis.contentSha256,duration:presenterDuration,originalDetails:allRawDetails,retainedDetails:details,reviewComplete}))) add('presenter_asset_unlocked', null, [], '提供已授权企业人物资产 ID、不可变版本及可核验授权证据；不能仅靠 rightsVerified 声明');
  const verifiedEnterpriseFactRefs = [...new Set((input.verifiedEnterpriseFactRefs ?? []).filter(usable))].sort();
  if (details.some(detail => string(detail.dialogue) || string(detail.onScreenText)) && !verifiedEnterpriseFactRefs.length) {
    add('reference_claim_unverified', null, sourceVideoRef ? [sourceVideoRef] : [], '年限、功效、交期等经营事实暂不设交接门槛；保留待核验标记，生成脚本时不得将未经核实的原片宣称写成企业事实');
  }
  // Reference claims remain labelled for Content Agent rewriting, but a
  // missing enterprise fact reference does not block the Director handoff.
  // The generated script still must not present an unverified source claim as
  // an enterprise fact.
  const blockingIssues = issues.filter(issue => issue.code !== 'reference_claim_unverified');
  const status = blockingIssues.length ? 'review_only' : 'production_ready';
  // Content Agent may begin the faithful narration draft while it plans how to
  // reproduce an uncertain opening motion. Render still uses the stricter gate.
  const directorHandoffReady = !issues.some(issue => ![
    'presenter_asset_unlocked', 'reference_claim_unverified',
    'hook_action_unverified', 'hook_script_incomplete',
  ].includes(issue.code));
  const stable = { recordId, analysisRunId: string(analysis.analysisRunId), sourceSha256: string(analysis.contentSha256),
    shotReviewVersion: string(reviewed.version), presenter, presenterDuration, presenterDurationConsistent, presenterEvidence: allRawDetails.map(detail=>({shotId:detail.shotId,time:detail.time||detail.timestamp,criticalShot:detail.criticalShot,presenterContinuityEvidence:detail.presenterContinuityEvidence})), verifiedEnterpriseFactRefs, shots, issues, status };
  return {
    schemaVersion: 1, referenceRecordId: recordId, analysisRunId: string(analysis.analysisRunId) || null,
    versionHash: createHash('sha256').update(JSON.stringify(stable)).digest('hex'), status,
    analysisQuality: string(analysis.analysisQuality), sourceVideoRef,
    selectedHookShotId: selectedHook?.shotId ?? null, presenterLock: presenter,
    hookActionInterval: { startSeconds: selectedHook?.startSeconds ?? null, endSeconds: selectedHook?.endSeconds ?? null, sourceVideoRef },
    hookScript: { shotId: selectedHook?.shotId ?? null, fields: scriptFields, confirmed: hookScriptConfirmed,
      evidenceRefs: [selectedHook?.evidence.firstFrameRef, selectedHook?.evidence.clipRef].filter((ref): ref is string => Boolean(ref)) },
    verifiedEnterpriseFactRefs, sourceClaimsAreEnterpriseFacts: false,
    shots, issues, directorHandoffReady, productionExecutionAllowed: status === 'production_ready',
  };
}
