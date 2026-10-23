/**
 * Versioned, renderer-safe video effect contract.
 *
 * The contract deliberately contains presets rather than raw FFmpeg filters.
 * It may be produced by an agent, but every value is normalized again at the
 * server boundary before it is passed to the desktop renderer.
 */
export const EFFECT_PLAN_SCHEMA_VERSION = 1 as const;

export const EFFECT_PRESETS = ['natural', 'dynamic', 'tech', 'cinematic'] as const;
export const EFFECT_MOTIONS = ['none', 'push_in', 'pull_out', 'pan_left', 'pan_right', 'handheld'] as const;
export const EFFECT_COLORS = ['original', 'clean', 'warm', 'cool', 'cinematic'] as const;
export const EFFECT_TRANSITIONS = ['cut', 'dissolve', 'fade', 'wipe_left', 'wipe_right'] as const;
export const EFFECT_OVERLAYS = ['petal_bloom', 'sparkle', 'heart', 'energy_ring', 'dust', 'fact_card', 'cta'] as const;
export const EFFECT_LAYERS = ['background', 'around_subject', 'foreground'] as const;
export const EFFECT_AUDIO_EVENTS = ['whoosh', 'pop', 'click', 'impact', 'sparkle'] as const;

export type EffectPresetId = typeof EFFECT_PRESETS[number];
export type EffectMotion = typeof EFFECT_MOTIONS[number];
export type EffectColor = typeof EFFECT_COLORS[number];
export type EffectTransition = typeof EFFECT_TRANSITIONS[number];
export type EffectOverlayPreset = typeof EFFECT_OVERLAYS[number];
export type EffectLayer = typeof EFFECT_LAYERS[number];
export type EffectAudioPreset = typeof EFFECT_AUDIO_EVENTS[number];
export type EffectIntensity = 0 | 1 | 2 | 3;

export interface EffectOverlayV1 {
  presetId: EffectOverlayPreset;
  layer: EffectLayer;
  /** Relative to the start of the scene. */
  start: number;
  /** Relative to the start of the scene. */
  end: number;
  /** Only fact_card and cta may contain text. */
  text?: string;
  anchor?: { x: number; y: number };
  scale?: number;
  opacity?: number;
}

export interface EffectSceneV1 {
  sceneId: string;
  enabled: boolean;
  motion: EffectMotion;
  color: EffectColor;
  transitionOut: { type: EffectTransition; duration: number };
  overlays: EffectOverlayV1[];
  spatialEvidence?: SpatialMaskEvidenceV1;
}

export interface SpatialMaskEvidenceV1 {
  schemaVersion: 'spatial-mask.v1';
  provider: 'sam3' | 'manual_reviewed';
  maskRef: string;
  analyzedContentHash: string;
  temporalStability: number;
  safeOverlayAnchors: Array<{ x: number; y: number }>;
}

export interface EffectAudioEventV1 {
  presetId: EffectAudioPreset;
  /** Absolute position on the output timeline. */
  at: number;
  volume: number;
}

export interface BeatGridEvidenceV1 {
  schemaVersion: 'beat-grid.v1';
  source: 'local_onset_grid' | 'essentia' | 'manual_reviewed';
  bpm: number;
  beats: number[];
  confidence: number;
  analyzedSeconds: number;
  sourceHash: string;
}

export interface EffectPlanV1 {
  schemaVersion: typeof EFFECT_PLAN_SCHEMA_VERSION;
  presetId: EffectPresetId;
  intensity: EffectIntensity;
  beatSync: boolean;
  seed: number;
  beatEvidence?: BeatGridEvidenceV1;
  scenes: EffectSceneV1[];
  audioEvents: EffectAudioEventV1[];
}

export interface EffectTimelineScene {
  sceneId?: string;
  clipId?: string;
  targetDuration?: number;
}

export interface EffectIntentScene extends EffectTimelineScene {
  purpose?: string;
  targetVisual?: string;
  action?: string;
  caption?: string;
  music?: string;
  pace?: 'slow' | 'medium' | 'fast' | string;
  /** Real product, face, logo or on-screen text must keep source color and may
   * not receive decorative overlays without a spatial protection mask. */
  protectedVisual?: boolean;
  spatialEvidence?: SpatialMaskEvidenceV1 | null;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};
const oneOf = <T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] =>
  allowed.includes(String(value) as T[number]) ? String(value) as T[number] : fallback;
const finite = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  Math.max(min, Math.min(max, finite(value, fallback)));
const cleanId = (value: unknown, fallback: string): string => {
  const id = String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 96);
  return id || fallback;
};
const cleanText = (value: unknown): string => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120);

export const DEFAULT_EFFECT_PLAN: EffectPlanV1 = Object.freeze({
  schemaVersion: 1,
  presetId: 'natural',
  intensity: 0,
  beatSync: false,
  seed: 1,
  scenes: [],
  audioEvents: [],
});

function normalizeOverlay(value: unknown, duration: number): EffectOverlayV1 | null {
  const item = asRecord(value);
  const presetId = oneOf(item.presetId, EFFECT_OVERLAYS, '' as EffectOverlayPreset);
  if (!presetId) return null;
  const start = clamp(item.start, 0, duration, 0);
  const end = clamp(item.end, start, duration, Math.min(duration, start + 1.5));
  if (end - start < .05) return null;
  const layer = oneOf(item.layer, EFFECT_LAYERS, 'foreground');
  const text = (presetId === 'fact_card' || presetId === 'cta') ? cleanText(item.text) : '';
  if ((presetId === 'fact_card' || presetId === 'cta') && !text) return null;
  const anchor = asRecord(item.anchor);
  return {
    presetId,
    layer,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    ...(text ? { text } : {}),
    anchor: {
      x: Number(clamp(anchor.x, .05, .95, .5).toFixed(4)),
      y: Number(clamp(anchor.y, .05, .95, .5).toFixed(4)),
    },
    scale: Number(clamp(item.scale, .5, 2, 1).toFixed(3)),
    opacity: Number(clamp(item.opacity, .05, 1, .75).toFixed(3)),
  };
}

function normalizeBeatEvidence(value: unknown): BeatGridEvidenceV1 | null {
  const raw = asRecord(value);
  if (raw.schemaVersion !== 'beat-grid.v1'
    || !['local_onset_grid', 'essentia', 'manual_reviewed'].includes(String(raw.source))) return null;
  const beats = (Array.isArray(raw.beats) ? raw.beats : [])
    .map(Number).filter(value => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right).slice(0, 512);
  const confidence = clamp(raw.confidence, 0, 1, 0);
  const sourceHash = cleanId(raw.sourceHash, '');
  if (beats.length < 4 || confidence < .45 || !sourceHash) return null;
  return {
    schemaVersion: 'beat-grid.v1',
    source: raw.source as BeatGridEvidenceV1['source'],
    bpm: Number(clamp(raw.bpm, 40, 260, 120).toFixed(3)),
    beats: beats.map(value => Number(value.toFixed(3))),
    confidence: Number(confidence.toFixed(4)),
    analyzedSeconds: Number(clamp(raw.analyzedSeconds, 1, 3_600, beats.at(-1) || 1).toFixed(3)),
    sourceHash,
  };
}

function normalizeSpatialEvidence(value: unknown): SpatialMaskEvidenceV1 | null {
  const raw = asRecord(value);
  if (raw.schemaVersion !== 'spatial-mask.v1' || !['sam3', 'manual_reviewed'].includes(String(raw.provider))) return null;
  const maskRef = cleanText(raw.maskRef);
  const analyzedContentHash = cleanId(raw.analyzedContentHash, '');
  const temporalStability = clamp(raw.temporalStability, 0, 1, 0);
  const safeOverlayAnchors = (Array.isArray(raw.safeOverlayAnchors) ? raw.safeOverlayAnchors : [])
    .map(value => asRecord(value))
    .map(anchor => ({ x: Number(clamp(anchor.x, .05, .95, .5).toFixed(4)), y: Number(clamp(anchor.y, .05, .95, .5).toFixed(4)) }))
    .slice(0, 8);
  if (!maskRef || !analyzedContentHash || temporalStability < .85) return null;
  return {
    schemaVersion: 'spatial-mask.v1',
    provider: raw.provider as SpatialMaskEvidenceV1['provider'],
    maskRef,
    analyzedContentHash,
    temporalStability: Number(temporalStability.toFixed(4)),
    safeOverlayAnchors,
  };
}

/**
 * Normalize untrusted agent/client input to the only values accepted by the
 * renderer. Unknown keys, arbitrary expressions and asset paths are dropped.
 */
export function normalizeEffectPlan(input: unknown, timeline: EffectTimelineScene[] = []): EffectPlanV1 {
  const raw = asRecord(input);
  const presetId = oneOf(raw.presetId, EFFECT_PRESETS, 'natural');
  const intensity = Math.round(clamp(raw.intensity, 0, 3, 0)) as EffectIntensity;
  const beatEvidence = normalizeBeatEvidence(raw.beatEvidence);
  const byId = new Map<string, Record<string, unknown>>();
  for (const [index, sceneValue] of (Array.isArray(raw.scenes) ? raw.scenes : []).entries()) {
    const scene = asRecord(sceneValue);
    byId.set(cleanId(scene.sceneId, String(index)), scene);
  }
  const sceneInputs: EffectTimelineScene[] = timeline.length
    ? timeline
    : [...byId.entries()].map(([sceneId]) => ({ sceneId, targetDuration: 3 }));
  const scenes = sceneInputs.slice(0, 120).map((timelineScene, index): EffectSceneV1 => {
    const sceneId = cleanId(timelineScene.sceneId || timelineScene.clipId, String(index));
    const duration = clamp(timelineScene.targetDuration, .5, 300, 3);
    const scene = byId.get(sceneId) || asRecord((Array.isArray(raw.scenes) ? raw.scenes : [])[index]);
    const transition = asRecord(scene.transitionOut);
    const spatialEvidence = normalizeSpatialEvidence(scene.spatialEvidence);
    const transitionType = oneOf(transition.type, EFFECT_TRANSITIONS, 'cut');
    const maxTransition = Math.max(0, Math.min(1.2, duration * .35));
    return {
      sceneId,
      enabled: scene.enabled !== false && intensity > 0,
      motion: oneOf(scene.motion, EFFECT_MOTIONS, 'none'),
      color: oneOf(scene.color, EFFECT_COLORS, 'original'),
      transitionOut: {
        type: transitionType,
        duration: transitionType === 'cut' ? 0 : Number(clamp(transition.duration, .1, maxTransition, Math.min(.35, maxTransition)).toFixed(3)),
      },
      overlays: (Array.isArray(scene.overlays) ? scene.overlays : [])
        .slice(0, 12)
        .map(item => normalizeOverlay(item, duration))
        .filter((item): item is EffectOverlayV1 => Boolean(item)),
      ...(spatialEvidence ? { spatialEvidence } : {}),
    };
  });
  const totalDuration = timeline.reduce((sum, item) => sum + clamp(item.targetDuration, 0, 300, 0), 0) || 3600;
  const audioEvents = (Array.isArray(raw.audioEvents) ? raw.audioEvents : [])
    .slice(0, 64)
    .map(value => {
      const event = asRecord(value);
      const presetId = oneOf(event.presetId, EFFECT_AUDIO_EVENTS, '' as EffectAudioPreset);
      if (!presetId) return null;
      return {
        presetId,
        at: Number(clamp(event.at, 0, totalDuration, 0).toFixed(3)),
        volume: Number(clamp(event.volume, 0, 1, .5).toFixed(3)),
      } satisfies EffectAudioEventV1;
    })
    .filter((item): item is EffectAudioEventV1 => Boolean(item));
  return {
    schemaVersion: 1,
    presetId,
    intensity,
    beatSync: raw.beatSync === true && Boolean(beatEvidence && beatEvidence.confidence >= .65),
    seed: Math.round(clamp(raw.seed, 0, 2_147_483_647, 1)),
    ...(beatEvidence ? { beatEvidence } : {}),
    scenes,
    audioEvents,
  };
}

const PRESET_STYLE: Record<EffectPresetId, { motions: EffectMotion[]; color: EffectColor; transition: EffectTransition; overlay?: EffectOverlayPreset }> = {
  natural: { motions: ['none', 'push_in'], color: 'clean', transition: 'dissolve' },
  dynamic: { motions: ['push_in', 'pan_left', 'pan_right'], color: 'clean', transition: 'wipe_left', overlay: 'sparkle' },
  tech: { motions: ['push_in', 'pull_out'], color: 'cool', transition: 'fade', overlay: 'energy_ring' },
  cinematic: { motions: ['push_in', 'pan_right'], color: 'cinematic', transition: 'dissolve', overlay: 'dust' },
};

/** Build a deterministic safe preset for a timeline; useful for UI and agents. */
export function createPresetEffectPlan(
  presetId: EffectPresetId,
  intensity: EffectIntensity,
  timeline: EffectTimelineScene[],
  seed = 1,
): EffectPlanV1 {
  if (intensity === 0) return normalizeEffectPlan({ ...DEFAULT_EFFECT_PLAN, presetId, intensity, seed }, timeline);
  const style = PRESET_STYLE[presetId];
  let cursor = 0;
  const scenes = timeline.map((scene, index) => {
    const duration = clamp(scene.targetDuration, .5, 300, 3);
    const overlay = style.overlay && intensity >= 2 && (index === 0 || index === timeline.length - 1)
      ? [{ presetId: style.overlay, layer: 'around_subject', start: .05, end: Math.min(duration, intensity === 3 ? 1.8 : 1.1), anchor: { x: .5, y: .48 }, opacity: .55 + intensity * .1 }]
      : [];
    const motion = style.motions[(seed + index) % style.motions.length];
    const transition = index === timeline.length - 1 || intensity === 1 ? 'cut' : style.transition;
    const result = {
      sceneId: cleanId(scene.sceneId || scene.clipId, String(index)),
      enabled: true,
      motion,
      color: style.color,
      transitionOut: { type: transition, duration: transition === 'cut' ? 0 : Math.min(.22 + intensity * .08, duration * .3) },
      overlays: overlay,
    };
    cursor += duration;
    return result;
  });
  const audioEvents = intensity >= 2
    ? timeline.slice(1).map((scene, index) => ({ presetId: presetId === 'dynamic' ? 'whoosh' : 'pop', at: timeline.slice(0, index + 1).reduce((sum, item) => sum + clamp(item.targetDuration, .5, 300, 3), 0), volume: .25 + intensity * .1 }))
    : [];
  void cursor;
  return normalizeEffectPlan({ schemaVersion: 1, presetId, intensity, beatSync: false, seed, scenes, audioEvents }, timeline);
}

/**
 * Conservative scene-aware effects for automated production. The plan derives
 * from Director-owned intent instead of rotating a global preset by scene index.
 * It deliberately leaves beatSync=false until real audio beat timestamps exist.
 */
export function createIntentEffectPlan(
  timeline: EffectIntentScene[],
  intensity: EffectIntensity = 1,
  seed = 1,
  beatEvidence?: BeatGridEvidenceV1 | null,
): EffectPlanV1 {
  let cursor = 0;
  const audioEvents: EffectAudioEventV1[] = [];
  const scenes = timeline.map((item, index): EffectSceneV1 => {
    const duration = clamp(item.targetDuration, .5, 300, 3);
    const intent = [item.purpose, item.targetVisual, item.action, item.music].filter(Boolean).join(' ').toLowerCase();
    const hook = index === 0 || /hook|钩子|开场|problem|痛点/.test(intent);
    const proof = /proof|trust|证据|证明|质检|参数|事实/.test(intent);
    const demo = /demonstration|demo|演示|操作|过程|使用/.test(intent);
    const cta = /call.to.action|cta|行动|收尾|咨询|私信/.test(intent);
    const transitionPurpose = /transition|转场|过渡/.test(intent);
    const fast = item.pace === 'fast' || /快速|明快|卡点|fast|dynamic/.test(intent);
    const technical = /技术|设备|参数|工厂|生产|tech|factory/.test(intent);
    const motion: EffectMotion = proof ? 'none'
      : hook || cta ? 'push_in'
        : demo ? (fast ? 'handheld' : 'pan_right')
          : transitionPurpose ? 'pull_out' : 'none';
    const color: EffectColor = item.protectedVisual ? 'original'
      : technical ? 'cool' : proof ? 'clean' : /温暖|生活|warm/.test(intent) ? 'warm' : 'original';
    const transition: EffectTransition = index === timeline.length - 1 ? 'cut'
      : transitionPurpose ? 'dissolve' : fast ? 'cut' : 'fade';
    const overlays: EffectOverlayV1[] = [];
    const caption = cleanText(item.caption);
    const spatialEvidence = normalizeSpatialEvidence(item.spatialEvidence);
    const safeAnchor = spatialEvidence?.safeOverlayAnchors[0];
    if ((!item.protectedVisual || safeAnchor) && intensity >= 2 && caption && (proof || cta)) {
      overlays.push({ presetId: cta ? 'cta' : 'fact_card', layer: 'foreground', start: .12,
        end: Math.min(duration, Math.max(.8, duration - .12)), text: caption,
        anchor: safeAnchor ?? { x: .5, y: cta ? .72 : .2 }, scale: 1, opacity: .82 });
    }
    const nearestBeat = beatEvidence?.beats.slice().sort((left, right) => Math.abs(left - cursor) - Math.abs(right - cursor))[0];
    const eventAt = beatEvidence && beatEvidence.confidence >= .65 && nearestBeat !== undefined && Math.abs(nearestBeat - cursor) <= .18
      ? nearestBeat : cursor;
    if (intensity >= 2 && hook) audioEvents.push({ presetId: 'impact', at: eventAt, volume: .42 });
    else if (intensity >= 2 && transitionPurpose) audioEvents.push({ presetId: 'whoosh', at: eventAt, volume: .3 });
    else if (intensity >= 2 && index > 0) audioEvents.push({ presetId: 'pop', at: eventAt, volume: .2 });
    const scene: EffectSceneV1 = {
      sceneId: cleanId(item.sceneId || item.clipId, String(index)),
      enabled: intensity > 0,
      motion,
      color,
      transitionOut: { type: transition, duration: transition === 'cut' ? 0 : Math.min(.28, duration * .2) },
      overlays,
      ...(spatialEvidence ? { spatialEvidence } : {}),
    };
    cursor += duration;
    return scene;
  });
  const presetId: EffectPresetId = timeline.some(item => /技术|设备|参数|工厂|tech|factory/i.test([item.purpose, item.targetVisual].join(' ')))
    ? 'tech' : timeline.some(item => item.pace === 'fast') ? 'dynamic' : 'natural';
  return normalizeEffectPlan({
    schemaVersion: 1, presetId, intensity,
    beatSync: Boolean(beatEvidence && beatEvidence.confidence >= .65),
    ...(beatEvidence ? { beatEvidence } : {}),
    seed, scenes, audioEvents,
  }, timeline);
}
