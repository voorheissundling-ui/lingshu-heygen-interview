import type { VideoAiAnalysis } from '../types/index.js';
import { alignReferenceWordsToShots, type ReferenceTimedWord, type ReferenceWordSpeechAlignment } from './referenceWordAlignment.js';
import { benchmarkTimeRange } from '../../shared/benchmarkAnalysis.js';

export interface ReferenceSpeechTranscript {
  text: string;
  words?: ReferenceTimedWord[];
  segments: Array<{ start: number; end: number; text: string; words?: ReferenceTimedWord[];
    timingPrecision?: 'phrase' | 'coarse'; provenance?: string; needsReview?: boolean }>;
  provenance?: string;
  timestampResolutionMs?: number;
  accuracyMs?: number | null;
  [key: string]: unknown;
}

/** Replaces both shot and beat model guesses with measured source speech.
 * A legacy phrase can remain readable, but cannot establish word/audio sync. */
export function lockReferenceSpeechTimeline(analysis: VideoAiAnalysis, transcript?: ReferenceSpeechTranscript,
  options: { duration?: number; fps?: number } = {}): VideoAiAnalysis {
  if (!transcript || !analysis.scriptDetails15s?.length) return analysis;
  const words = transcript.words?.length ? transcript.words : transcript.segments.flatMap(segment => segment.words || []);
  const duration = Number.isFinite(options.duration) && options.duration! > 0 ? options.duration! : Infinity;
  const unknownAlignment: ReferenceWordSpeechAlignment = { schemaVersion: 1, timingPrecision: 'unavailable',
    provenance: [], timestampResolutionMs: transcript.timestampResolutionMs ?? null, accuracyMs: transcript.accuracyMs ?? null,
    confidence: null, words: [], coarseEvidence: [], syncEligible: false, limitations: ['invalid_or_missing_time_window'] };
  const normalized = analysis.scriptDetails15s.map((detail, index) => {
    const range = benchmarkTimeRange(String(detail.time || detail.timestamp || ''));
    const end = range ? Math.min(range.end, duration) : 0;
    return { detail, range: range && end > range.start ? { start: range.start, end } : null, index,
      clipped: Boolean(range && range.end > duration) };
  });
  const result = alignReferenceWordsToShots({ words,
    shots: normalized.flatMap(row => row.range ? [{ shotId: `shot-${row.index + 1}`, ...row.range,
      beats: (row.detail.beats || []).flatMap((beat, beatIndex) => {
        const range = benchmarkTimeRange(String(beat.time || ''));
        return range ? [{ beatId: `beat-${beatIndex + 1}`, ...range }] : [];
      }) }] : []),
    coarseSegments: transcript.segments.filter(segment => segment.timingPrecision !== 'phrase'),
    provenance: transcript.provenance,
    timestampResolutionMs: transcript.timestampResolutionMs,
    accuracyMs: transcript.accuracyMs,
    fps: options.fps,
  });
  // Do not copy a legacy complete phrase across multiple physical shots.
  const legacyPhrases = new Map<number, string[]>();
  if (!words.length) for (const segment of transcript.segments) {
    if (segment.timingPrecision !== 'phrase' || segment.end <= segment.start) continue;
    const candidates = normalized.flatMap(row => row.range ? [{ row, overlap:
      Math.max(0, Math.min(row.range.end, segment.end) - Math.max(row.range.start, segment.start)) }] : [])
      .filter(item => item.overlap > 0).sort((a, b) => b.overlap - a.overlap);
    const owner = candidates[0]?.row;
    if (owner && segment.end - segment.start <= Math.max(5, owner.range!.end - owner.range!.start + 1))
      legacyPhrases.set(owner.index, [...(legacyPhrases.get(owner.index) || []), segment.text]);
  }
  return { ...analysis, criticalShotSummary: undefined, referenceProductionRoutingSummary: undefined,
    audioTranscript: { ...transcript, segments: transcript.segments.map(segment => ({ ...segment,
      timingPrecision: segment.timingPrecision === 'phrase' ? 'phrase' : 'coarse',
      needsReview: segment.needsReview ?? segment.timingPrecision !== 'phrase' })) },
    speechAlignmentSummary: { schemaVersion: 1, acceptedWordCount: result.acceptedWordCount,
      invalidWordCount: result.invalidWordCount, unassignedWordIds: result.unassignedWordIds,
      clippedShotIds: normalized.filter(row => row.clipped).map(row => `shot-${row.index + 1}`),
      limitations: result.limitations, fps: options.fps ?? null },
    scriptDetails15s: normalized.map(row => {
      const aligned = result.shots.find(shot => shot.shotId === `shot-${row.index + 1}`);
      if (!aligned) return { ...row.detail, criticalShot: undefined, referenceProductionRouting: undefined, dialogue: '', audio: '分镜时间范围无效，未建立口播对齐',
        speechAlignment: unknownAlignment,
        beats: row.detail.beats?.map(beat => ({ ...beat, dialogue: '', speechAlignment: unknownAlignment,
          speechSyncStatus: 'insufficient_evidence' as const })) };
      const coarse = aligned.speechAlignment.timingPrecision === 'coarse';
      const legacyText = (legacyPhrases.get(row.index) || []).join(' ');
      return { ...row.detail, criticalShot: undefined, referenceProductionRouting: undefined, ...(row.clipped ? { originalTime: row.detail.time,
        time: `${row.range!.start.toFixed(2)}s–${row.range!.end.toFixed(2)}s`,
        timelineCorrection: 'clipped_to_measured_video_duration' } : {}),
        dialogue: words.length ? aligned.dialogue : legacyText,
        ...(coarse ? { needsReview: true } : {}),
        subtitle: row.detail.onScreenText || row.detail.subtitle || '',
        audio: aligned.speechAlignment.words.length ? `原音频${aligned.speechAlignment.timingPrecision === 'point' ? '词起点' : '词级'}对齐口播：${aligned.dialogue}`
          : coarse ? '检测到口播，但仅有粗时间窗，不能确定逐镜台词'
          : legacyText ? `原音频句级口播：${legacyText}；缺少词级时间戳`
          : '该分镜未检测到具有时间戳的口播',
        speechAlignment: legacyText ? { ...aligned.speechAlignment, timingPrecision: 'phrase' as const,
          syncEligible: false, limitations: [...aligned.speechAlignment.limitations, 'legacy_phrase_only'] }
          : aligned.speechAlignment,
        beats: row.detail.beats?.map((beat, beatIndex) => {
          const mapped = aligned.beats.find(item => item.beatId === `beat-${beatIndex + 1}`);
          const originalRange = benchmarkTimeRange(String(beat.time || ''));
          const beatClipped = mapped && originalRange && (mapped.start !== originalRange.start || mapped.end !== originalRange.end);
          return { ...beat, ...(beatClipped ? { originalTime: beat.time,
            time: `${mapped.start.toFixed(2)}s–${mapped.end.toFixed(2)}s` } : {}),
            dialogue: mapped?.dialogue || '', speechAlignment: mapped?.speechAlignment || unknownAlignment,
            // Concurrency alone is evidence, not a semantic synchronization verdict.
            speechSyncStatus: mapped?.speechAlignment.syncEligible ? 'candidate' : 'insufficient_evidence' };
        }),
      };
    }),
  };
}
