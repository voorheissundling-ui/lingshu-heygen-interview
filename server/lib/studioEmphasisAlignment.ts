import {
  normalizeCaptionOccupancy,
  normalizeShotWindows,
  normalizeVisualEvidence,
  type CaptionOccupancy,
  type CaptionSegment,
  type EmphasisEvent,
  type NormalizedBox,
  type ShotWindow,
  type VisualEvidence,
} from '../../shared/contracts/emphasisTimeline.js';

export type StudioEmphasisPreanalysis = {
  shotWindows?: unknown;
  captionOccupancy?: unknown;
  visualEvidence?: unknown;
};

const overlapMs = (startA: number, endA: number, startB: number, endB: number): number =>
  Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));

const boxKey = (box: NormalizedBox): string => [box.x, box.y, box.width, box.height].map(value => value.toFixed(4)).join(':');
const uniqueBoxes = (boxes: NormalizedBox[]): NormalizedBox[] => [...new Map(boxes.map(box => [boxKey(box), box])).values()].slice(0, 24);

const semanticText = (value: unknown): string => String(value || '').toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}%％°℃℉]+/gu, '');

function longestCommonSubstring(left: string, right: string): number {
  if (!left || !right) return 0;
  let best = 0;
  const row = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i++) {
    for (let j = right.length; j >= 1; j--) {
      row[j] = left[i - 1] === right[j - 1] ? row[j - 1] + 1 : 0;
      best = Math.max(best, row[j]);
    }
  }
  return best;
}

const measuredValues = (value: string): string[] => [...value.matchAll(/\d+(?:\.\d+)?\s*(?:%|％|mm|cm|m|kg|g|ml|l|w|v|a|件|支|套|个|盒|年|天|小时|分钟|秒|元|℃|度)/giu)]
  .map(match => match[0]!.toLocaleLowerCase().replace(/\s+/g, ''));

export function emphasisTextRepeats(eventText: unknown, occupiedText: unknown): boolean {
  const left = semanticText(eventText);
  const right = semanticText(occupiedText);
  if (!left || !right) return false;
  const common = longestCommonSubstring(left, right);
  if (common / left.length >= .72 || common / right.length >= .72) return true;
  const leftValues = measuredValues(String(eventText || ''));
  const rightValues = new Set(measuredValues(String(occupiedText || '')));
  return leftValues.some(value => rightValues.has(value));
}

function evidenceWindow(event: EmphasisEvent, captions: CaptionSegment[]): { startMs: number; endMs: number } {
  if (Number.isFinite(event.evidenceStartMs) && Number.isFinite(event.evidenceEndMs)) {
    return { startMs: event.evidenceStartMs!, endMs: event.evidenceEndMs! };
  }
  const best = captions.filter(caption => overlapMs(event.startMs, event.endMs, caption.startMs, caption.endMs) > 0)
    .sort((left, right) => overlapMs(event.startMs, event.endMs, right.startMs, right.endMs)
      - overlapMs(event.startMs, event.endMs, left.startMs, left.endMs))[0];
  return best ? { startMs: best.startMs, endMs: best.endMs } : { startMs: event.startMs, endMs: event.endMs };
}

function bestShot(evidence: { startMs: number; endMs: number }, shots: ShotWindow[]): ShotWindow | undefined {
  return shots.filter(shot => overlapMs(evidence.startMs, evidence.endMs, shot.startMs, shot.endMs) > 0)
    .sort((left, right) => overlapMs(evidence.startMs, evidence.endMs, right.startMs, right.endMs)
      - overlapMs(evidence.startMs, evidence.endMs, left.startMs, left.endMs)
      || right.confidence - left.confidence)[0];
}

function targetRelation(event: EmphasisEvent, evidence: VisualEvidence): NonNullable<EmphasisEvent['targetRelation']> {
  if (evidence.targetRelation) return evidence.targetRelation;
  if (event.type === 'cta') return 'point_to';
  if (evidence.subjectType === 'person') return 'adjacent';
  if (evidence.subjectType === 'unknown') return 'none';
  return 'surround';
}

function bestVisualEvidence(event: EmphasisEvent, shotId: string, evidence: VisualEvidence[]): VisualEvidence | undefined {
  return evidence.filter(item => item.shotId === shotId && (!item.eventId || item.eventId === event.id)
    && (!item.targetId || item.targetId === event.targetId))
    .sort((left, right) => {
      const scope = (item: VisualEvidence) => (item.eventId === event.id ? 4 : 0)
        + (event.targetId && item.targetId === event.targetId ? 2 : 0) + (item.eventId || item.targetId ? 0 : 1);
      return scope(right) - scope(left) || right.confidence - left.confidence;
    })[0];
}

function preferredSide(evidence: VisualEvidence): NonNullable<EmphasisEvent['preferredSide']> {
  if (evidence.preferredSide) return evidence.preferredSide;
  const centerX = evidence.subjectAnchor?.x ?? (evidence.subjectBox ? evidence.subjectBox.x + evidence.subjectBox.width / 2 : .5);
  return centerX < .5 ? 'right' : centerX > .5 ? 'left' : 'auto';
}

function trustedLocalTarget(event: EmphasisEvent, evidence: VisualEvidence | undefined): boolean {
  if (!evidence?.subjectBox || evidence.confidence < .68) return false;
  const scoped = evidence.eventId === event.id || Boolean(event.targetId && evidence.targetId === event.targetId);
  return scoped && evidence.subjectBox.width * evidence.subjectBox.height <= .35;
}

const mainDecoration = (event: EmphasisEvent): boolean => event.presentationMode === 'graphic_only' || event.presentationMode === 'label';
const eventRank = (event: EmphasisEvent): number => event.importance * 10 + event.confidence
  + (event.source === 'editor' ? 3 : event.source === 'metadata' ? 2 : event.source === 'vision' ? 1 : 0);

export function alignStudioEmphasisEvents(input: {
  durationMs: number;
  events: EmphasisEvent[];
  captions: CaptionSegment[];
  preanalysis?: StudioEmphasisPreanalysis;
}): EmphasisEvent[] {
  const shots = normalizeShotWindows(input.preanalysis?.shotWindows, input.durationMs);
  if (!shots.length) return input.events;
  const suppliedOccupancy = normalizeCaptionOccupancy(input.preanalysis?.captionOccupancy, input.durationMs);
  const projectOccupancy: CaptionOccupancy[] = input.captions.map(caption => ({
    id: `subtitle-${caption.id}`, startMs: caption.startMs, endMs: caption.endMs, text: caption.text,
    boxes: [], confidence: 1, source: 'subtitle', editable: true,
  }));
  const occupancy = [...projectOccupancy, ...suppliedOccupancy];
  const visuals = normalizeVisualEvidence(input.preanalysis?.visualEvidence);

  const aligned = input.events.map(event => {
    const evidence = evidenceWindow(event, input.captions);
    const shot = bestShot(evidence, shots);
    if (!shot) return { ...event, presentationMode: 'none' as const, targetRelation: 'none' as const };
    const startMs = Math.max(event.startMs, evidence.startMs, shot.startMs + 100);
    const endMs = Math.min(event.endMs, evidence.endMs + 250, shot.endMs - 100);
    const concurrent = occupancy.filter(item => item.confidence >= .55 && overlapMs(startMs, endMs, item.startMs, item.endMs) > 0);
    const duplicates = concurrent.filter(item => emphasisTextRepeats(event.text, item.text));
    const editableCaption = duplicates.some(item => item.editable);
    const duplicate = duplicates.length > 0;
    const shotVisuals = visuals.filter(item => item.shotId === shot.id && item.confidence >= .68);
    const shotVisual = bestVisualEvidence(event, shot.id, shotVisuals);
    const visual = shotVisual?.subjectBox || shotVisual?.subjectAnchor ? shotVisual : undefined;
    const occupiedBoxes = uniqueBoxes([...concurrent.flatMap(item => item.boxes), ...shotVisuals.flatMap(item => item.captionBoxes)]);
    const tooShort = endMs - startMs < 500;
    let presentationMode: NonNullable<EmphasisEvent['presentationMode']>;
    if (tooShort) presentationMode = editableCaption ? 'caption_emphasis' : 'none';
    else if (duplicate) presentationMode = editableCaption ? 'caption_emphasis' : 'graphic_only';
    else presentationMode = visual ? 'graphic_only' : event.text ? 'label' : 'none';
    const requestedRelation = presentationMode === 'graphic_only' && visual ? targetRelation(event, visual) : 'none';
    const localTarget = trustedLocalTarget(event, visual);
    const relation = requestedRelation === 'surround' && !localTarget
      ? visual ? 'adjacent' as const : 'none' as const : requestedRelation;
    const assetFamily = presentationMode === 'graphic_only' || presentationMode === 'label'
      ? relation === 'surround' && localTarget ? 'rays' as const : 'corner_marker' as const
      : undefined;
    return {
      ...event, startMs: Math.round(Math.max(startMs, 0)), endMs: Math.round(Math.max(startMs, endMs)),
      shotId: shot.id, evidenceStartMs: evidence.startMs, evidenceEndMs: evidence.endMs,
      presentationMode, targetRelation: relation,
      ...(assetFamily ? { assetFamily } : {}),
      ...(presentationMode !== 'none' && visual ? { preferredSide: preferredSide(visual) } : {}),
      ...(occupiedBoxes.length ? { occupiedBoxes } : {}),
      ...(visual?.subjectBox ? { subjectBox: visual.subjectBox } : {}),
      ...(visual?.subjectAnchor ? { subjectAnchor: visual.subjectAnchor } : {}),
    };
  });

  const winnerByShot = new Map<string, EmphasisEvent>();
  for (const event of aligned.filter(mainDecoration)) {
    const winner = winnerByShot.get(event.shotId!);
    if (!winner || eventRank(event) > eventRank(winner)) winnerByShot.set(event.shotId!, event);
  }
  return aligned.map(event => {
    if (!mainDecoration(event) || winnerByShot.get(event.shotId!) === event) return event;
    const editable = occupancy.some(item => item.editable && overlapMs(event.startMs, event.endMs, item.startMs, item.endMs) > 0
      && emphasisTextRepeats(event.text, item.text));
    return { ...event, presentationMode: editable ? 'caption_emphasis' as const : 'none' as const, targetRelation: 'none' as const,
      preferredSide: undefined, assetFamily: undefined, subjectBox: undefined, subjectAnchor: undefined };
  });
}
