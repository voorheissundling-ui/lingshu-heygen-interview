/** Evidence-preserving speech alignment for a reference video's director handoff. */
export type ReferenceSpeechPrecision = 'phrase' | 'coarse';
export type ReferenceSpeechVisibility = 'on_camera' | 'voiceover' | 'unknown';

export interface ReferenceSpeechInput {
  start: number;
  end: number;
  text: string;
  timingPrecision: ReferenceSpeechPrecision;
  provenance?: string;
  speakerId?: string | null;
  visibility?: ReferenceSpeechVisibility;
}

export interface ReferenceShotInput {
  shotId: string;
  start: number;
  end: number;
  content?: string;
  purpose?: string;
}

export interface ReferenceStructureInput {
  sectionId: string;
  title: string;
  start: number;
  end: number;
  purpose?: string;
}

export interface ReferenceAlignedSpeech extends ReferenceSpeechInput {
  speechId: string;
  primaryShotId: string | null;
  shotIds: string[];
  sectionIds: string[];
  needsReview: boolean;
  reviewReasons: string[];
}

export interface ReferenceStructureSummary extends ReferenceStructureInput {
  shotIds: string[];
  speechIds: string[];
  transcript: string;
  coarseEvidenceIds: string[];
}

/** The observed picture cut is the production unit; speech lines are timing anchors. */
export interface ReferenceProductionShot extends ReferenceShotInput {
  cueIds: string[];
  coarseEvidenceIds: string[];
  speechMode: 'phrase_aligned' | 'approximate_aligned' | 'silent_opening_hook' | 'unverified';
  needsReview: boolean;
  reviewReasons: string[];
}

export interface ReferenceSpeechTimeline {
  schemaVersion: 1;
  lines: ReferenceAlignedSpeech[];
  coarseWindows: ReferenceAlignedSpeech[];
  productionShots: ReferenceProductionShot[];
  sections: ReferenceStructureSummary[];
  reviewQuestions: string[];
  phraseTimedCount: number;
  productionReady: boolean;
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const validRange = (item: { start: number; end: number }) =>
  Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end > item.start;

/**
 * The six section boundaries are editorial hypotheses. They must be supplied from
 * observed shot ranges; no transcript text is invented to fill a section.
 * Coarse ASR windows remain explicitly approximate when used as speech lines.
 */
export function buildReferenceSpeechTimeline(input: {
  speech: ReferenceSpeechInput[];
  shots: ReferenceShotInput[];
  sections: ReferenceStructureInput[];
  speechCoverageVerified?: boolean;
  shotCutsVerified?: boolean;
}): ReferenceSpeechTimeline {
  const shots = input.shots.filter(validRange).sort((a, b) => a.start - b.start);
  const sections = input.sections.filter(validRange).sort((a, b) => a.start - b.start);
  const reviewQuestions: string[] = [];
  const lines: ReferenceAlignedSpeech[] = [];
  const coarseWindows: ReferenceAlignedSpeech[] = [];

  input.speech.forEach((item, index) => {
    if (!validRange(item) || !item.text.trim()) {
      reviewQuestions.push(`ASR 第 ${index + 1} 条缺少有效文本或时间范围，请回听原片。`);
      return;
    }
    const rankedShots = shots.map(shot => ({ shot, seconds: overlap(item, shot) }))
      .filter(entry => entry.seconds > 0).sort((a, b) => b.seconds - a.seconds);
    const rankedSections = sections.map(section => ({ section, seconds: overlap(item, section) }))
      .filter(entry => entry.seconds > 0).sort((a, b) => b.seconds - a.seconds);
    const reasons: string[] = [];
    if (!rankedShots.length) reasons.push('口播未覆盖任何分镜');
    if (!rankedSections.length) reasons.push('口播未覆盖任何结构段');
    if (!item.provenance?.trim()) reasons.push('缺少ASR证据来源');
    const aligned: ReferenceAlignedSpeech = {
      ...item,
      text: item.text.trim(),
      speechId: `speech-${String(index + 1).padStart(3, '0')}`,
      primaryShotId: rankedShots[0]?.shot.shotId ?? null,
      shotIds: rankedShots.map(entry => entry.shot.shotId),
      sectionIds: rankedSections.map(entry => entry.section.sectionId),
      needsReview: reasons.length > 0,
      reviewReasons: reasons,
    };
    lines.push(aligned);
    if (item.timingPrecision === 'coarse') coarseWindows.push(aligned);
  });

  const summaries: ReferenceStructureSummary[] = sections.map(section => {
    const matching = lines.filter(line => line.sectionIds.includes(section.sectionId));
    const coarseEvidence = coarseWindows.filter(window => window.sectionIds.includes(section.sectionId));
    return {
      ...section,
      shotIds: shots.filter(shot => overlap(shot, section) > 0).map(shot => shot.shotId),
      speechIds: matching.map(line => line.speechId),
      transcript: matching.map(line => line.text).join(' '),
      coarseEvidenceIds: coarseEvidence.map(window => window.speechId),
    };
  });
  const productionShots: ReferenceProductionShot[] = shots.map((shot, index) => {
    const matchingLines = lines.filter(line => line.shotIds.includes(shot.shotId));
    const cueIds = matchingLines.map(line => line.speechId);
    const coarseEvidenceIds = coarseWindows.filter(window => window.shotIds.includes(shot.shotId))
      .map(window => window.speechId);
    // A silent action before the first spoken phrase remains its own picture cut.
    // Coarse ASR overlapping it cannot prove silence, so it still needs review.
    const silentOpeningHook = index === 0 && shot.start === 0 && cueIds.length === 0
      && coarseEvidenceIds.length === 0 && lines.some(line => line.start >= shot.end);
    const reasons: string[] = [];
    if (!cueIds.length && !silentOpeningHook) reasons.push('该分镜暂无口播关联，需确认是否为无口播画面');
    return {
      ...shot,
      cueIds,
      coarseEvidenceIds,
      speechMode: matchingLines.some(line => line.timingPrecision === 'phrase') ? 'phrase_aligned'
        : cueIds.length ? 'approximate_aligned' : silentOpeningHook ? 'silent_opening_hook' : 'unverified',
      needsReview: reasons.length > 0,
      reviewReasons: reasons,
    };
  });
  for (const line of lines) {
    if (line.needsReview) reviewQuestions.push(`${line.speechId}：${line.reviewReasons.join('；')}。`);
  }
  for (const shot of productionShots) {
    if (shot.needsReview) reviewQuestions.push(`${shot.shotId}：${shot.reviewReasons.join('；')}。`);
  }
  if (sections.length !== 6) reviewQuestions.push(`内容结构共有 ${sections.length} 段，需确认是否覆盖六段叙事骨架。`);
  const observedCutsCoverVideo = shots.length > 0 && sections.length > 0 && Math.abs(shots[0]!.start - sections[0]!.start) <= .1
    && Math.abs(shots.at(-1)!.end - sections.at(-1)!.end) <= .1
    && shots.every((shot, index) => index === 0 || Math.abs(shots[index - 1]!.end - shot.start) <= .1);
  if (!observedCutsCoverVideo) reviewQuestions.push('镜头时间线有缺口或重叠，需由编导 Agent 重新定位视觉切点。');
  return {
    schemaVersion: 1,
    lines,
    coarseWindows,
    productionShots,
    sections: summaries,
    reviewQuestions,
    phraseTimedCount: lines.filter(line => line.timingPrecision === 'phrase').length,
    productionReady: Boolean(lines.length && sections.length === 6 && !reviewQuestions.length),
  };
}
