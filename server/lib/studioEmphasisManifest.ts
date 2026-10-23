import {
  emphasisBudgetForDuration,
  EMPHASIS_PROFILES,
  normalizeCaptionSegments,
  normalizeEmphasisPlan,
  normalizeMotionEvents,
  type CaptionSegment,
  type EmphasisEvent,
  type EmphasisPlanV1,
  type EmphasisProfile,
  type EmphasisPlacementWindow,
  type MotionEvent,
  type VisualTarget,
} from '../../shared/contracts/emphasisTimeline.js';
import { normalizeGeminiMotionCandidates, resolveMotionEventWindows } from './studioMotionSemantics.js';
import { alignStudioEmphasisEvents, type StudioEmphasisPreanalysis } from './studioEmphasisAlignment.js';

export type StudioEmphasisPlan = EmphasisPlanV1;

type Cue = { start?: unknown; end?: unknown; text?: unknown; kind?: unknown; speakerId?: unknown; keywords?: unknown };
type TimelineShot = {
  name?: unknown;
  purpose?: unknown;
  caption?: unknown;
  targetVisual?: unknown;
  action?: unknown;
  targetStart?: unknown;
  targetEnd?: unknown;
  targetDuration?: unknown;
};
export type StudioEmphasisPlanInput = {
  profile?: unknown;
  captions?: unknown;
  events?: unknown;
  placementWindows?: unknown;
  motionEvents?: unknown;
  maxEvents?: unknown;
  /** Optional analysis supplied by the background prepass. */
  preanalysis?: StudioEmphasisPreanalysis;
};

const text = (value: unknown): string => String(value || '').replace(/\s+/g, ' ').trim();

const metadataField = /(?:环境|景别|运镜|构图|镜头功能|画面|配乐|台词|字幕)[：:]/;

function shortTimelineLabel(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const subtitle = raw.match(/字幕[：:]\s*(.+)$/)?.[1]?.trim();
  if (subtitle) return subtitle.slice(0, 48);
  const overlay = raw.match(/(?:后期)?叠加文字[‘'“"]([^’'”"]{2,48})[’'”"]/)?.[1]?.trim();
  if (overlay) return overlay;
  const purpose = raw.match(/镜头功能[：:]\s*(.+?)(?=\s+(?:环境|景别|运镜|构图|画面|配乐|台词|字幕)[：:]|$)/)?.[1]?.trim();
  if (purpose) return purpose.slice(0, 32);
  return raw.length <= 48 && !metadataField.test(raw) ? raw : '';
}

function semanticTimelineEvent(label: string): { type: EmphasisEvent['type']; text: string; importance: 1 | 2 | 3 } | null {
  const quantity = label.match(/(?:起订量[^，。！？!?]{0,10})?(\d+)\s*(件|支|套|个|盒)\s*(?:起订)?/i);
  if (quantity && /起订|MOQ|最低|只要/i.test(label)) {
    return { type: 'key_fact', text: `${quantity[1]}${quantity[2]}起订`, importance: 3 };
  }
  if (/私信|咨询|联系|扫码|点击|留言|戳我|contact|shop now|learn more/i.test(label)) {
    const messenger = label.match(/Messenger[^，。！？!?]{0,12}/i)?.[0];
    return { type: 'cta', text: messenger || label.slice(0, 24), importance: 3 };
  }
  if (/成品效果|前后对比|完成|亮灯|开灯|揭晓|reveal|result/i.test(label)) {
    const concise = label.match(/成品效果|前后对比|亮灯看效果|开灯看效果|揭晓效果/i)?.[0];
    return { type: 'reveal', text: concise || label.slice(0, 24), importance: 2 };
  }
  return null;
}

function businessFactTexts(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number') return text(value) ? [text(value)] : [];
  if (Array.isArray(value)) return value.flatMap(item => businessFactTexts(item, depth + 1)).slice(0, 100);
  if (typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const values = businessFactTexts(item, depth + 1);
    return values.flatMap(valueText => [valueText, `${text(key)}：${valueText}`]);
  }).slice(0, 100);
}

const normalizedSemanticText = (value: string): string => value.toLocaleLowerCase()
  .replace(/[\s，。！？；：、,.!?;:'"“”‘’()（）【】\[\]-]/g, '');

function eventHasSemanticEvidence(
  event: { type: EmphasisEvent['type']; text: string },
  evidence: string[],
): boolean {
  const relevant = evidence.map(text).filter(Boolean);
  if (!relevant.length) return false;
  if (event.type === 'cta') {
    const actionGroup = (value: string): string => /messenger/i.test(value) ? 'messenger'
      : /私信|咨询|联系|留言|contact/i.test(value) ? 'contact'
        : /查看|了解|详情|learn more/i.test(value) ? 'view'
          : /扫码|点击/i.test(value) ? 'interact'
            : /下单|购买|shop now/i.test(value) ? 'purchase' : '';
    const expected = actionGroup(event.text);
    return Boolean(expected) && relevant.some(item => actionGroup(item) === expected
      || (expected === 'contact' && actionGroup(item) === 'messenger'));
  }
  if (event.type === 'reveal') return relevant.some(item => /成品|效果|前后对比|完成|亮灯|开灯|揭晓|reveal|result/i.test(item));
  const eventText = normalizedSemanticText(event.text);
  return relevant.some(item => {
    const evidenceText = normalizedSemanticText(item);
    if (!eventText || !evidenceText) return false;
    if (evidenceText.includes(eventText) || eventText.includes(evidenceText)) return true;
    const eventQuantity = event.text.match(/(\d+(?:\.\d+)?)\s*(件|支|套|个|盒)/i);
    return Boolean(eventQuantity && new RegExp(`${eventQuantity[1]}\\s*${eventQuantity[2]}`).test(item)
      && /起订|MOQ|最低|只要/i.test(item));
  });
}

export function recommendStudioSubtitleProfile(input: { script?: unknown; cues?: Cue[]; timeline?: TimelineShot[] }): EmphasisProfile {
  const corpus = [text(input.script), ...(input.cues || []).map(cue => text(cue.text)), ...(input.timeline || []).map(shot => text(shot.name))].join(' ');
  if (/工厂|厂区|车间|产线|流水线|设备|加工|质检|仓库|机械|machine|factory|production line/i.test(corpus)) return 'factory_process';
  if (/剧情|角色|柜姐|对话|种草|正装|优惠|折扣|到手价|买[一二两\d].*送|限时|疯狂|爆闪|氛围感/i.test(corpus)) return 'd2c_dialogue';
  if (/产品|材质|尺寸|规格|功能|成品|实拍|展厅|台面|结构|颜色|product|material|size/i.test(corpus)) return 'product_showcase';
  return 'talking_head';
}

function captionsFromCues(cues: Cue[], durationMs: number): CaptionSegment[] {
  return normalizeCaptionSegments(cues.map((cue, index) => ({
    id: `caption-${index + 1}`,
    startMs: Number(cue.start) * 1_000,
    endMs: Number(cue.end) * 1_000,
    text: text(cue.text),
    speakerId: cue.speakerId,
    keywords: cue.keywords,
  })), durationMs);
}

function conciseTranscriptFact(value: string): string {
  const raw = text(value);
  const useCase = raw.match(/(?:可以|可)?用于\s*([^，。！？!?]{2,14})/i)?.[1]
    || raw.match(/适合\s*([^，。！？!?]{2,14})/i)?.[1];
  if (useCase) return text(useCase).replace(/(?:使用|场景)$/i, '').slice(0, 16);
  const attribute = raw.match(/(?:采用|配备|支持)\s*([^，。！？!?]{2,14})/i)?.[1]
    || raw.match(/(?:是|为)\s*(独立包装|单独包装|一次性包装)/i)?.[1];
  return attribute ? text(attribute).slice(0, 16) : '';
}

function conciseTranscriptCta(value: string): string {
  const raw = text(value);
  return raw.match(/查看详细介绍|查看详情|了解更多|私信咨询|联系我们|联系咨询|扫码查看|点击查看|到店看样|立即购买|立即下单/i)?.[0]
    || raw.match(/(?:请|欢迎)?\s*(私信|咨询|联系|扫码|点击|留言|购买|下单|到店)[^，。！？!?]{0,10}/i)?.[0]?.replace(/^(?:请|欢迎)\s*/i, '')
    || '';
}

function inferredCandidates(captions: CaptionSegment[], cues: Cue[]): EmphasisEvent[] {
  if (!captions.length) return [];
  const candidates: EmphasisEvent[] = [{
    id: 'auto-hook', type: 'hook', startMs: captions[0]!.startMs,
    endMs: Math.min(captions[0]!.endMs, captions[0]!.startMs + 2_400), text: captions[0]!.text,
    importance: 3, confidence: .86, source: 'transcript',
  }];
  captions.forEach((caption, index) => {
    const cue = cues[index];
    const conciseFact = conciseTranscriptFact(caption.text);
    if (/\d|价格|优惠|折扣|免费|规格|尺寸|产能|交付|质保|认证|price|free|%/i.test(caption.text) || conciseFact) {
      candidates.push({ id: `auto-fact-${index + 1}`, type: 'key_fact', startMs: caption.startMs,
        endMs: conciseFact ? Math.min(caption.endMs, caption.startMs + 1_800) : caption.endMs,
        text: conciseFact || caption.text, importance: 2, confidence: .8, source: 'transcript' });
    }
    const conciseCta = conciseTranscriptCta(caption.text);
    if (conciseCta || /contact|shop now|learn more/i.test(caption.text)) {
      candidates.push({ id: `auto-cta-${index + 1}`, type: 'cta', startMs: caption.startMs,
        endMs: Math.min(caption.endMs, caption.startMs + 2_000),
        text: conciseCta || caption.text, importance: 2, confidence: .82, source: 'transcript' });
    }
    if (String(cue?.kind || '') === 'screen') {
      candidates.push({ id: `auto-section-${index + 1}`, type: 'section_label', startMs: caption.startMs,
        endMs: caption.endMs, text: caption.text, importance: 1, confidence: .8, source: 'metadata' });
    }
  });
  return candidates;
}

function timelineCandidates(shots: TimelineShot[], captions: CaptionSegment[], explicitBusinessFacts: string[]): EmphasisEvent[] {
  let cursorMs = 0;
  return shots.flatMap((shot, index) => {
    const startMs = Number.isFinite(Number(shot.targetStart)) ? Number(shot.targetStart) * 1_000 : cursorMs;
    const durationMs = Number.isFinite(Number(shot.targetDuration)) ? Number(shot.targetDuration) * 1_000 : 2_000;
    const endMs = Number.isFinite(Number(shot.targetEnd)) ? Number(shot.targetEnd) * 1_000 : startMs + durationMs;
    cursorMs = Math.max(cursorMs, endMs);
    const label = shortTimelineLabel(shot.caption || shot.purpose);
    const visual = text(shot.targetVisual || shot.action || shot.name);
    const events: EmphasisEvent[] = [];
    const semantic = label && !/^(无|none)$/i.test(label) ? semanticTimelineEvent(label) : null;
    // Storyboard fields are production instructions, not content truth. They
    // may position an overlay only when nearby spoken captions or explicit
    // user-owned business facts independently support the same semantics.
    const nearbyCaptionEvidence = captions
      .filter(caption => caption.endMs >= startMs - 2_500 && caption.startMs <= endMs + 2_500)
      .map(caption => caption.text);
    const evidence = [...nearbyCaptionEvidence, ...explicitBusinessFacts];
    if (semantic && eventHasSemanticEvidence(semantic, evidence)) {
      const semanticStart = semantic.type === 'key_fact' && startMs === 0
        ? Math.min(Math.max(startMs, endMs - 1_800), startMs + 3_600)
        : startMs;
      events.push({
        id: `auto-shot-${semantic.type}-${index + 1}`, type: semantic.type,
        startMs: semanticStart, endMs: Math.min(endMs, semanticStart + 1_800),
        text: semantic.text, importance: semantic.importance, confidence: .84, source: 'metadata',
      });
    }
    if (visual && /成品|效果|前后对比|完成|亮灯|开灯|揭晓|reveal|result/i.test(visual)) {
      const reveal = { type: 'reveal' as const, text: label || visual, importance: 2 as const };
      if (eventHasSemanticEvidence(reveal, evidence)) events.push({
        id: `auto-shot-reveal-${index + 1}`, type: 'reveal', startMs, endMs: Math.min(endMs, startMs + 2_000),
        text: reveal.text, importance: 2, confidence: .76, source: 'vision',
      });
    }
    return events;
  });
}

function semanticCueForEvent(event: EmphasisEvent, captions: CaptionSegment[]): CaptionSegment | undefined {
  const overlapping = captions.filter(caption => caption.startMs < event.endMs && event.startMs < caption.endMs);
  if (event.text) {
    const eventText = normalizedSemanticText(event.text);
    const exact = overlapping.find(caption => normalizedSemanticText(caption.text).includes(eventText));
    if (exact) return exact;
  }
  return overlapping[0] || captions.find(caption => caption.startMs <= event.startMs && caption.endMs >= event.startMs);
}

function visualTargetForEvent(event: EmphasisEvent): VisualTarget {
  if (event.type === 'cta' || event.type === 'section_label') {
    return { kind: 'frame', targetId: event.targetId, label: event.text, confidence: event.confidence };
  }
  if (event.targetId) {
    const kind = /机|设备|产线|工序|machine|process/i.test(`${event.targetId} ${event.text || ''}`) ? 'machine'
      : /人|主播|人物|person|speaker/i.test(`${event.targetId} ${event.text || ''}`) ? 'person' : 'product';
    return { kind, targetId: event.targetId, label: event.text, confidence: event.confidence };
  }
  return { kind: 'caption', label: event.text, confidence: event.confidence };
}

/** Builds semantic candidates only; asset IDs and placement coordinates are resolved downstream. */
export function motionCandidatesFromEvents(events: EmphasisEvent[], captions: CaptionSegment[]): MotionEvent[] {
  const cueIds = new Set(captions.map(caption => caption.id));
  const candidates = events.flatMap((event): unknown[] => {
    const cue = semanticCueForEvent(event, captions);
    if (!cue) return [];
    const target = visualTargetForEvent(event);
    const visualRole = target.kind === 'caption' ? 'caption_companion'
      : target.kind === 'frame' ? 'corner_badge'
        : event.type === 'reveal' ? 'surround' : 'adjacent';
    return [{ id: `motion-${event.id}`, emphasisType: event.type,
      anchor: { cueId: cue.id, ...(event.text ? { phrase: event.text } : {}), boundary: event.type === 'reveal' ? 'center' : 'start' },
      target, visualRole }];
  });
  return normalizeMotionEvents(candidates, { cueIds });
}

export function buildStudioEmphasisPlan(input: {
  durationSeconds: number;
  script?: unknown;
  subtitles?: { cues?: Cue[] };
  timeline?: TimelineShot[];
  emphasisPlan?: StudioEmphasisPlanInput;
  /** Optional shot/OCR/visual evidence; callers may add the prepass later. */
  emphasisPreanalysis?: StudioEmphasisPreanalysis;
  /** Confirmed user/business data. Storyboard production notes are excluded. */
  businessFacts?: unknown;
}): StudioEmphasisPlan {
  const durationMs = Math.max(0, Math.round(Number(input.durationSeconds || 0) * 1_000));
  const cues = Array.isArray(input.subtitles?.cues) ? input.subtitles!.cues! : [];
  const supplied = input.emphasisPlan || {};
  const captions = normalizeCaptionSegments(supplied.captions, durationMs);
  const normalizedCaptions = captions.length ? captions : captionsFromCues(cues, durationMs);
  const profile = EMPHASIS_PROFILES.includes(String(supplied.profile) as EmphasisProfile)
    ? supplied.profile as EmphasisProfile
    : recommendStudioSubtitleProfile({ script: input.script, cues, timeline: input.timeline });
  const candidates = Array.isArray(supplied.events) && supplied.events.length
    ? supplied.events : [...inferredCandidates(normalizedCaptions, cues), ...timelineCandidates(
      input.timeline || [], normalizedCaptions, businessFactTexts(input.businessFacts),
    )];
  const defaultBudget = emphasisBudgetForDuration(durationMs);
  const requestedMax = Number(supplied.maxEvents);
  const maxEvents = Number.isFinite(requestedMax)
    ? Math.max(0, Math.min(40, Math.round(requestedMax))) : defaultBudget.max;
  const placementWindows = Array.isArray(supplied.placementWindows)
    ? supplied.placementWindows as EmphasisPlacementWindow[] : undefined;
  const normalized = normalizeEmphasisPlan({ profile, captions: normalizedCaptions, events: candidates, maxEvents }, durationMs, placementWindows);
  const suppliedMotionEvents = normalizeGeminiMotionCandidates(supplied.motionEvents, normalized.captions);
  const semanticMotionEvents = suppliedMotionEvents.length
    ? suppliedMotionEvents : motionCandidatesFromEvents(normalized.events, normalized.captions);
  const motionEvents = resolveMotionEventWindows(semanticMotionEvents, normalized.captions);
  const preanalysis = input.emphasisPreanalysis || supplied.preanalysis;
  const events = preanalysis ? alignStudioEmphasisEvents({ durationMs, events: normalized.events, captions: normalized.captions, preanalysis }) : normalized.events;
  return { ...normalized, events, ...(motionEvents.length ? { motionEvents } : {}) };
}
