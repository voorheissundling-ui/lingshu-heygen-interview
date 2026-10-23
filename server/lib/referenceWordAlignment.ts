/** Maps observed ASR word clocks to picture cuts. It never interpolates word times. */
export interface ReferenceTimedWord {
  start: number;
  end: number;
  text: string;
  confidence?: number | null;
  provenance?: string;
  timingPrecision?: 'word' | 'point' | 'phrase' | 'coarse';
}
export interface ReferenceWordWindow { start: number; end: number }
export interface ReferenceWordBeat extends ReferenceWordWindow { beatId: string }
export interface ReferenceWordShot extends ReferenceWordWindow {
  shotId: string;
  beats?: ReferenceWordBeat[];
}
export interface ReferenceWordEvidence extends ReferenceTimedWord {
  wordId: string;
  confidence: number | null;
  provenance: string;
  timingPrecision: 'word' | 'point';
  /** Original ASR time is retained in start/end; these are the actual intersection. */
  overlapStart: number;
  overlapEnd: number;
  boundaryCrossing: boolean;
  /** All intersections remain evidence, while dialogue has only one owner. */
  overlappingShotIds: string[];
  frameRange?: { startInclusive: number; endExclusive: number; fps: number };
  syncEligible: boolean;
  limitations: string[];
}
export interface ReferenceWordSpeechAlignment {
  schemaVersion: 1;
  timingPrecision: 'word' | 'point' | 'phrase' | 'coarse' | 'unavailable';
  provenance: string[];
  timestampResolutionMs: number | null;
  /** Timestamp encoding resolution does not establish clock accuracy. */
  accuracyMs: number | null;
  confidence: number | null;
  words: ReferenceWordEvidence[];
  coarseEvidence: Array<ReferenceWordWindow & { text: string; provenance?: string }>;
  syncEligible: boolean;
  limitations: string[];
}
export interface ReferenceWordAlignedBeat extends ReferenceWordBeat {
  dialogue: string;
  speechAlignment: ReferenceWordSpeechAlignment;
}
export interface ReferenceWordAlignedShot extends ReferenceWordShot {
  dialogue: string;
  speechAlignment: ReferenceWordSpeechAlignment;
  beats: ReferenceWordAlignedBeat[];
}
export interface ReferenceWordAlignmentResult {
  schemaVersion: 1;
  shots: ReferenceWordAlignedShot[];
  acceptedWordCount: number;
  invalidWordCount: number;
  unassignedWordIds: string[];
  limitations: string[];
}

const validWindow = (value: ReferenceWordWindow) => Number.isFinite(value.start)
  && Number.isFinite(value.end) && value.start >= 0 && value.end > value.start;
const overlap = (a: ReferenceWordWindow, b: ReferenceWordWindow) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const unique = <T>(items: T[]) => [...new Set(items)];
/** CJK tokens join directly; punctuation attaches to its preceding token. */
export function joinReferenceWords(words: Array<{ text: string }>): string {
  return words.reduce((output, word) => {
    const token = word.text.trim();
    if (!token) return output;
    if (!output || /^[,.;:!?，。；：！？、)\]】]/u.test(token)
      || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(output)
      || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(token)) return output + token;
    return `${output} ${token}`;
  }, '');
}

function owner<T extends ReferenceWordWindow>(word: ReferenceWordWindow, windows: T[]): T | undefined {
  if (word.start === word.end) return windows.find(window => word.start >= window.start && word.start < window.end);
  const midpoint = (word.start + word.end) / 2;
  return windows.map((window, index) => ({ window, index, seconds: overlap(word, window),
    containsMidpoint: midpoint >= window.start && midpoint < window.end }))
    .filter(item => item.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds || Number(b.containsMidpoint) - Number(a.containsMidpoint)
      || a.window.start - b.window.start || a.index - b.index)[0]?.window;
}

/**
 * Words crossing a cut have one dialogue owner (largest real overlap, then the
 * half-open midpoint). Other intersections are recorded by ID, never by copying
 * a phrase to every shot. Missing clocks and coarse windows cannot assert sync.
 */
export function alignReferenceWordsToShots(input: {
  words: ReferenceTimedWord[];
  shots: ReferenceWordShot[];
  coarseSegments?: Array<ReferenceWordWindow & { text: string; provenance?: string }>;
  provenance?: string;
  fps?: number;
  timestampResolutionMs?: number;
  accuracyMs?: number | null;
  confidenceThreshold?: number;
}): ReferenceWordAlignmentResult {
  const shots = input.shots.filter(validWindow).sort((a, b) => a.start - b.start);
  const coarseSegments = (input.coarseSegments || []).filter(segment => validWindow(segment) && segment.text.trim());
  const accepted = input.words.flatMap((word, index) => (validWindow(word)
    || (word.timingPrecision === 'point' && Number.isFinite(word.start) && word.start >= 0 && word.end === word.start))
    && word.text.trim() && (!word.timingPrecision || ['word', 'point'].includes(word.timingPrecision))
    ? [{ ...word, text: word.text.trim(), wordId: `word-${String(index + 1).padStart(4, '0')}` }] : [])
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const threshold = input.confidenceThreshold ?? 0.6;
  const resolution = Number.isFinite(input.timestampResolutionMs) && input.timestampResolutionMs! > 0
    ? input.timestampResolutionMs! : null;
  const fps = Number.isFinite(input.fps) && input.fps! > 0 ? input.fps! : null;
  const accuracyMs = typeof input.accuracyMs === 'number' && Number.isFinite(input.accuracyMs) && input.accuracyMs >= 0
    ? input.accuracyMs : null;
  const limitations: string[] = [];
  if (accepted.length !== input.words.length) limitations.push('invalid_or_non_word_timestamps_discarded');
  if (!accepted.length) limitations.push('word_timestamps_unavailable');
  if (shots.length !== input.shots.length) limitations.push('invalid_shot_ranges_discarded');
  if (shots.some((shot, index) => index > 0 && shot.start < shots[index - 1]!.end)) limitations.push('overlapping_shot_ranges');
  if (resolution === null) limitations.push('timestamp_resolution_unspecified');
  if (accuracyMs === null) limitations.push('clock_accuracy_unverified');
  const assigned = new Map<string, typeof accepted>();
  const unassignedWordIds: string[] = [];
  for (const word of accepted) {
    const shot = owner(word, shots);
    if (!shot) { unassignedWordIds.push(word.wordId); continue; }
    assigned.set(shot.shotId, [...(assigned.get(shot.shotId) || []), word]);
  }
  const evidence = (word: typeof accepted[number], window: ReferenceWordWindow): ReferenceWordEvidence => {
    const provenance = word.provenance?.trim() || input.provenance?.trim() || '';
    const confidence = typeof word.confidence === 'number' && Number.isFinite(word.confidence)
      && word.confidence >= 0 && word.confidence <= 1 ? word.confidence : null;
    const reasons: string[] = [];
    if (!provenance) reasons.push('missing_asr_provenance');
    if (confidence !== null && confidence < threshold) reasons.push('low_asr_confidence');
    if (confidence === null) reasons.push('asr_confidence_unavailable');
    if (resolution === null) reasons.push('timestamp_resolution_unspecified');
    if (resolution !== null && resolution > 200) reasons.push('timestamp_resolution_too_coarse_for_sync');
    if (accuracyMs === null) reasons.push('clock_accuracy_unverified');
    if (accuracyMs !== null && accuracyMs > 200) reasons.push('clock_accuracy_too_coarse_for_sync');
    if (word.timingPrecision === 'point') reasons.push('point_timestamp_has_no_duration');
    const overlapStart = Math.max(word.start, window.start);
    const overlapEnd = Math.min(word.end, window.end);
    return { ...word, timingPrecision: word.timingPrecision === 'point' ? 'point' : 'word', confidence, provenance, overlapStart, overlapEnd,
      boundaryCrossing: word.start < window.start || word.end > window.end,
      overlappingShotIds: shots.filter(shot => overlap(word, shot) > 0
        || (word.start === word.end && word.start >= shot.start && word.start < shot.end)).map(shot => shot.shotId),
      ...(fps ? { frameRange: { startInclusive: Math.floor(overlapStart * fps),
        endExclusive: word.start === word.end ? Math.floor(overlapEnd * fps) + 1 : Math.ceil(overlapEnd * fps), fps } } : {}),
      // An unavailable provider confidence remains null, not a fabricated score.
      // It does not invalidate a real clock, but is exposed as a limitation.
      syncEligible: Boolean(provenance && resolution !== null && resolution <= 200
        && word.timingPrecision !== 'point' && (accuracyMs === null || accuracyMs <= 200)
        && (confidence === null || confidence >= threshold)), limitations: reasons };
  };
  const alignment = (words: ReferenceWordEvidence[], window: ReferenceWordWindow): ReferenceWordSpeechAlignment => {
    const coarseEvidence = coarseSegments.filter(segment => overlap(segment, window) > 0);
    const knownConfidence = words.map(word => word.confidence).filter((value): value is number => value !== null);
    const reasons = unique(words.flatMap(word => word.limitations));
    if (!words.length) reasons.push(coarseEvidence.length ? 'coarse_audio_window_only' : 'no_owned_words_in_window');
    return { schemaVersion: 1, timingPrecision: words.some(word => word.timingPrecision === 'word') ? 'word'
      : words.length ? 'point' : coarseEvidence.length ? 'coarse' : 'unavailable',
      provenance: unique([...words.map(word => word.provenance), ...coarseEvidence.map(segment => segment.provenance || '')].filter(Boolean)),
      timestampResolutionMs: resolution, accuracyMs, confidence: knownConfidence.length ? Math.min(...knownConfidence) : null,
      words, coarseEvidence, syncEligible: words.some(word => word.syncEligible), limitations: unique(reasons) };
  };
  return { schemaVersion: 1, acceptedWordCount: accepted.length,
    invalidWordCount: input.words.length - accepted.length, unassignedWordIds, limitations,
    shots: shots.map(shot => {
      const words = (assigned.get(shot.shotId) || []).map(word => evidence(word, shot));
      const beats = (shot.beats || []).filter(beat => validWindow(beat) && overlap(beat, shot) > 0)
        .map(beat => ({ ...beat, start: Math.max(beat.start, shot.start), end: Math.min(beat.end, shot.end) }));
      return { ...shot, dialogue: joinReferenceWords(words), speechAlignment: alignment(words, shot),
        beats: beats.map(beat => {
          const beatWords = words.filter(word => owner(word, beats)?.beatId === beat.beatId).map(word => evidence(word, beat));
          return { ...beat, dialogue: joinReferenceWords(beatWords), speechAlignment: alignment(beatWords, beat) };
        }) };
    }) };
}
