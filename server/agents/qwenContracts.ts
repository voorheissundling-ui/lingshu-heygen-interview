import type { VideoAiAnalysis } from '../types/index.js';
import type { SocialImageReferenceLayerBlueprint, SocialImageReferenceLayerRole, SocialImageReferenceMaskShape } from '../../shared/contracts/socialImageCreation.js';

export interface QwenAsrSegment { start: number; end: number; text: string; confidence?: number }

export interface QwenTimelineBoundary {
  id: string;
  start: number;
  end: number;
  reason: string;
  evidence: string;
}

export interface QwenTimelinePlan {
  theme: string;
  identityEntities: NonNullable<VideoAiAnalysis['identityEntities']>;
  hooks: string[];
  sellingPoints: string[];
  mood: string;
  structure: string;
  baseRequirements: string;
  firstTenSeconds: NonNullable<VideoAiAnalysis['firstTenSeconds']>;
  coarseStructure: NonNullable<VideoAiAnalysis['coarseStructure']>;
  scriptSummary15s: NonNullable<VideoAiAnalysis['scriptSummary15s']>;
  recommendedScriptType: 'voiceover' | 'storyboard';
  boundaries: QwenTimelineBoundary[];
}

export interface ImagePostEvidenceAnalysis {
  version: 2;
  status: 'analyzed';
  observedFacts: Array<{ imageIndex: number; subjects: string[]; scene: string; composition: string; colors: string[]; visibleText: string[]; confidence: number }>;
  carouselFlow: Array<{ imageIndex: number; role: 'attention' | 'product' | 'detail' | 'proof' | 'process' | 'cta' | 'unknown'; evidence: string; confidence: number }>;
  copyEvidence: { hooks: Array<{ text: string; source: 'caption' | 'ocr'; evidence: string }>; sellingPoints: Array<{ text: string; source: 'caption' | 'ocr'; evidence: string }>; cta: string[] };
  reusableModules: Array<{ module: string; evidence: string; preserve: string; replace: string; confidence: number }>;
  layerBlueprints?: SocialImageReferenceLayerBlueprint[];
  uncertainties: string[];
  routing?: { primaryProvider: 'qwen'; finalProvider: 'qwen' | 'openai'; primaryModel: string; reviewModel?: string; reviewReasons: string[]; reviewed: boolean };
}

const clamp = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(1, Number(value))) : 0;
const rect = (value: unknown) => {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const x = clamp(row.x), y = clamp(row.y);
  return { x, y, width: Math.min(1 - x, clamp(row.width)), height: Math.min(1 - y, clamp(row.height)) };
};

/** Normalize untrusted model geometry before it can influence deterministic rendering. */
export function normalizeImageLayerBlueprints(value: unknown, imageCount: number): SocialImageReferenceLayerBlueprint[] {
  const roles = new Set<SocialImageReferenceLayerRole>(['background', 'mask', 'product', 'text', 'logo', 'decoration']);
  const shapes = new Set<SocialImageReferenceMaskShape>(['rectangle', 'rounded_rectangle', 'ellipse', 'polygon', 'linear_gradient']);
  if (!Array.isArray(value)) return [];
  return value.slice(0, Math.max(0, imageCount)).flatMap((raw, offset) => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const imageIndex = Number.isInteger(Number(row.imageIndex)) ? Math.max(1, Math.min(imageCount, Number(row.imageIndex))) : offset + 1;
    const layers = (Array.isArray(row.layers) ? row.layers : []).slice(0, 20).flatMap((item, index) => {
      if (!item || typeof item !== 'object') return [];
      const layer = item as Record<string, unknown>, role = String(layer.role) as SocialImageReferenceLayerRole;
      const bounds = rect(layer.bounds);
      if (!roles.has(role) || bounds.width <= 0 || bounds.height <= 0) return [];
      return [{ id: String(layer.id || `${role}-${index + 1}`).slice(0, 80), role, zIndex: Math.max(0, Math.min(100, Math.round(Number(layer.zIndex) || index))), bounds, confidence: clamp(layer.confidence) }];
    });
    const masks = (Array.isArray(row.masks) ? row.masks : []).slice(0, 12).flatMap((item, index) => {
      if (!item || typeof item !== 'object') return [];
      const mask = item as Record<string, unknown>, shape = String(mask.shape) as SocialImageReferenceMaskShape;
      const bounds = rect(mask.bounds);
      if (!shapes.has(shape) || bounds.width <= 0 || bounds.height <= 0) return [];
      const points = Array.isArray(mask.points) ? mask.points.slice(0, 24).flatMap(point => {
        if (!point || typeof point !== 'object') return [];
        const normalized = rect({ ...point, width: 0, height: 0 });
        return [{ x: normalized.x, y: normalized.y }];
      }) : undefined;
      return [{ id: String(mask.id || `mask-${index + 1}`).slice(0, 80), shape, bounds, opacity: clamp(mask.opacity),
        color: /^#[0-9a-f]{6}$/i.test(String(mask.color || '')) ? String(mask.color) : undefined,
        cornerRadius: mask.cornerRadius === undefined ? undefined : clamp(mask.cornerRadius), feather: mask.feather === undefined ? undefined : clamp(mask.feather),
        angle: Number.isFinite(Number(mask.angle)) ? Math.max(-360, Math.min(360, Number(mask.angle))) : undefined,
        points: points?.length && points.length >= 3 ? points : undefined,
        zIndex: Math.max(0, Math.min(100, Math.round(Number(mask.zIndex) || index + 1))), confidence: clamp(mask.confidence) }];
    });
    return layers.length || masks.length ? [{ imageIndex, layers, masks }] : [];
  }).sort((a, b) => a.imageIndex - b.imageIndex);
}

/** Pure review signal. It never authorizes or submits a paid fallback. */
export function imageEvidenceReviewReasons(analysis: ImagePostEvidenceAnalysis, imageCount: number): string[] {
  const reasons = new Set<string>();
  const facts = analysis.observedFacts || [];
  const blueprints = analysis.layerBlueprints || [];
  if (facts.length < imageCount) reasons.add('missing_image_facts');
  if (blueprints.length < imageCount) reasons.add('missing_layer_blueprints');
  const confidence = [
    ...facts.map(item => item.confidence),
    ...(analysis.carouselFlow || []).map(item => item.confidence),
    ...(analysis.reusableModules || []).map(item => item.confidence),
    ...blueprints.flatMap(item => [...item.layers.map(layer => layer.confidence), ...item.masks.map(mask => mask.confidence)]),
  ].filter(value => Number.isFinite(value));
  if (!confidence.length || confidence.reduce((sum, value) => sum + value, 0) / confidence.length < .72) reasons.add('low_confidence');
  if (blueprints.some(item => !item.layers.some(layer => layer.role === 'background'))) reasons.add('missing_background_layer');
  if (blueprints.some(item => {
    const ids = item.layers.map(layer => layer.id);
    const z = item.layers.map(layer => layer.zIndex);
    return new Set(ids).size !== ids.length || (item.layers.length > 1 && new Set(z).size === 1);
  })) reasons.add('layer_order_conflict');
  if ((analysis.uncertainties || []).length >= 4) reasons.add('excessive_uncertainty');
  return [...reasons];
}

export function normalizeQwenQualityScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.max(0, Math.min(100, score <= 10 ? score * 10 : score));
}

export function storyboardQaProviderFallbackEligible(error: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.GEMINI_API_KEY?.trim()) return false;
  const record = error && typeof error === 'object' ? error as Record<string, any> : {};
  const code = String(record.code || record.type || record.error?.code || record.error?.type || '').trim();
  const message = error instanceof Error ? error.message : String(error || '');
  return ['Arrearage', 'InvalidApiKey', 'AccessDenied', 'Forbidden'].includes(code)
    || /overdue-payment|account is in good standing|arrearage|free quota exhausted|use free tier only|invalid api key|access denied/i.test(message);
}
