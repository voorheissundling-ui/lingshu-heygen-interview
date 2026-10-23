import {
  normalizeMotionEvents,
  type CaptionSegment,
  type MotionEvent,
  type SemanticAnchor,
} from '../../shared/contracts/emphasisTimeline.js';

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function resolveSemanticAnchorMs(anchor: SemanticAnchor, captions: CaptionSegment[]): number | null {
  const cue = captions.find(caption => caption.id === anchor.cueId);
  if (!cue) return null;
  const selectedWords = anchor.wordIds?.length
    ? (cue.words || []).filter(word => Boolean(word.id && anchor.wordIds!.includes(word.id))) : [];
  let startMs = selectedWords.length ? Math.min(...selectedWords.map(word => word.startMs)) : cue.startMs;
  let endMs = selectedWords.length ? Math.max(...selectedWords.map(word => word.endMs)) : cue.endMs;
  if (!selectedWords.length && anchor.phrase) {
    const phraseStart = cue.text.toLocaleLowerCase().indexOf(anchor.phrase.toLocaleLowerCase());
    if (phraseStart >= 0 && cue.text.length) {
      const duration = cue.endMs - cue.startMs;
      startMs = cue.startMs + duration * phraseStart / cue.text.length;
      endMs = cue.startMs + duration * (phraseStart + anchor.phrase.length) / cue.text.length;
    }
  }
  const base = anchor.boundary === 'start' ? startMs : anchor.boundary === 'end' ? endMs : (startMs + endMs) / 2;
  return Math.round(clamp(base + (anchor.offsetMs || 0), cue.startMs, cue.endMs));
}

/** Adds compatibility millisecond windows after semantic selection, never before it. */
export function resolveMotionEventWindows(
  events: MotionEvent[],
  captions: CaptionSegment[],
  defaultDurationMs = 900,
): MotionEvent[] {
  return events.flatMap((event): MotionEvent[] => {
    const cue = captions.find(caption => caption.id === event.anchor.cueId);
    const instant = resolveSemanticAnchorMs(event.anchor, captions);
    if (!cue || instant === null) return [];
    const duration = clamp(Math.round(defaultDurationMs), 200, 3_000);
    const startMs = event.anchor.boundary === 'end'
      ? Math.max(cue.startMs, instant - duration) : event.anchor.boundary === 'center'
        ? Math.max(cue.startMs, instant - duration / 2) : instant;
    const endMs = event.anchor.boundary === 'end' ? instant : Math.min(cue.endMs, startMs + duration);
    if (endMs <= startMs) return [];
    return [{ ...event, startMs: Math.round(startMs), endMs: Math.round(endMs) }];
  });
}

/** Gemini is restricted to semantic anchors, targets and roles. */
export function normalizeGeminiMotionCandidates(input: unknown, captions: CaptionSegment[]): MotionEvent[] {
  return normalizeMotionEvents(input, { cueIds: new Set(captions.map(caption => caption.id)) });
}
