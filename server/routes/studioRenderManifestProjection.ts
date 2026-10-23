import { normalizeEffectPlan, type EffectPlanV1 } from '../../shared/contracts/effectPlan.js';
import { buildStudioEmphasisPlan, type StudioEmphasisPlan, type StudioEmphasisPlanInput } from '../lib/studioEmphasisManifest.js';
import type { StudioEmphasisPreanalysis } from '../lib/studioEmphasisAlignment.js';

export interface SubCue { start: number; end: number; text: string; zh?: string }
interface SubtitleSpec { mode: 'off' | 'target' | 'bilingual'; cues: SubCue[]; style: Record<string, unknown> }

export interface RenderSpec {
  materials?: string[];
  timeline?: {
    sceneId?: string;
    clipId?: string;
    name: string;
    url?: string;
    type?: 'video' | 'image' | 'audio';
    trimStart?: number;
    trimEnd?: number;
    speed?: number;
    targetStart?: number;
    targetEnd?: number;
    targetDuration?: number;
    purpose?: string;
    caption?: string;
    targetVisual?: string;
    action?: string;
  }[];
  script?: string;
  voice?: string;
  bgm?: string;
  bgmVol?: number;
  voiceVol?: number;
  coverId?: string;
  coverTitle?: string;
  coverUrl?: string;
  ratio?: string;
  duration?: number;
  platform?: string;
  language?: string;
  voiceoverUrl?: string;
  subtitles?: SubtitleSpec;
  effectPlan?: EffectPlanV1;
  emphasisPlan?: StudioEmphasisPlanInput;
}

export interface RenderManifest {
  jobId: string;
  requireVisualAssets: true;
  spec: { ratio: string; resolution?: string; duration: number; platform: string; language: string; bgmVol: number; voiceVol: number };
  script: string;
  timeline: {
    index: number;
    name: string;
    url: string | null;
    trimStart?: number;
    trimEnd?: number;
    speed?: number;
    targetStart?: number;
    targetEnd?: number;
    targetDuration?: number;
  }[];
  voiceover: { voice: string | null; url: string | null };
  cover: { id: string | null; title: string; url: string | null };
  bgm: { id: string | null; url: string | null };
  subtitles?: SubtitleSpec;
  effectPlan?: EffectPlanV1;
  emphasisPlan: StudioEmphasisPlan;
}

function absoluteAssetUrl(base: string, value?: string | null): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
  return `${base}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

/** Pure projection; tenant-scoped material and BGM reads remain in the route. */
export function buildStudioRenderManifest(input: {
  jobId: string;
  spec: RenderSpec;
  base: string;
  materialUrlByName: ReadonlyMap<string, string>;
  bgmUrl: string | null;
  emphasisPreanalysis?: StudioEmphasisPreanalysis;
}): RenderManifest {
  const { jobId, spec, base, materialUrlByName, bgmUrl, emphasisPreanalysis } = input;
  const rawTimeline: NonNullable<RenderSpec['timeline']> = spec.timeline?.length
    ? spec.timeline
    : (spec.materials ?? []).map(name => ({ name }));
  const normalizedEffectPlan = spec.effectPlan ? normalizeEffectPlan(spec.effectPlan, rawTimeline.map((item, index) => ({
    sceneId: item.sceneId || item.clipId || String(index),
    clipId: item.clipId,
    targetDuration: item.targetDuration,
  }))) : undefined;
  const emphasisPlan = buildStudioEmphasisPlan({
    durationSeconds: spec.duration ?? 20,
    script: spec.script,
    subtitles: spec.subtitles,
    timeline: rawTimeline,
    emphasisPlan: spec.emphasisPlan,
    emphasisPreanalysis,
  });
  return {
    jobId,
    requireVisualAssets: true,
    spec: {
      ratio: spec.ratio || '9:16',
      duration: spec.duration ?? 20,
      platform: spec.platform || 'tiktok',
      language: spec.language || 'en',
      bgmVol: spec.bgmVol ?? 35,
      resolution: (spec as any).resolution || '1080p',
      voiceVol: spec.voiceVol ?? 100,
    },
    script: spec.script ?? '',
    timeline: rawTimeline.map((item, index) => {
      const rel = materialUrlByName.get(item.name);
      const directUrl = 'url' in item && typeof item.url === 'string' ? item.url : undefined;
      const resolvedUrl = absoluteAssetUrl(base, directUrl || rel);
      return { index, ...item, url: resolvedUrl,
        productUrl: absoluteAssetUrl(base, 'productUrl' in item ? String(item.productUrl || '') : ''),
        backgroundUrl: absoluteAssetUrl(base, 'backgroundUrl' in item ? String(item.backgroundUrl || '') : ''),
      };
    }),
    voiceover: { voice: spec.voice ?? null, url: absoluteAssetUrl(base, spec.voiceoverUrl) },
    cover: { id: spec.coverId ?? null, title: spec.coverTitle ?? '', url: absoluteAssetUrl(base, spec.coverUrl) },
    bgm: { id: spec.bgm ?? null, url: absoluteAssetUrl(base, bgmUrl) },
    subtitles: spec.subtitles && spec.subtitles.mode !== 'off' ? spec.subtitles : undefined,
    effectPlan: normalizedEffectPlan,
    emphasisPlan,
  };
}
