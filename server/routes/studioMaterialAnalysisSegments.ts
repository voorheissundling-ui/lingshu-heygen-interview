import type { analyzeVideo } from '../agents/gemini.js';

export interface MaterialSegment {
  id: string;
  start: number;
  end: number;
  duration: number;
  poster?: string;
  visualTopic?: string;
  expressionPurpose?: string;
  subject: string[];
  action: string;
  productVisible: boolean;
  productClarity: 'none' | 'low' | 'medium' | 'high';
  shot: string;
  angle: string;
  composition: string;
  camera: string;
  environment: string;
  quality: number;
  ocrText: string;
  hasPerson: boolean;
  hasLogo: boolean;
  logoText: string[];
  recommendedFunctions: string[];
  authenticity: string;
  confidence: number;
  needsReview: boolean;
  manualConfirmed?: boolean;
  posterObjectKey?: string;
}

type Analysis = Awaited<ReturnType<typeof analyzeVideo>>;
type Detail = NonNullable<Analysis['scriptDetails15s']>[number];

function parseAnalysisRange(value: string, fallbackStart: number, totalDuration: number): { start: number; end: number } {
  const values = Array.from(String(value || '').matchAll(/(\d+(?:\.\d+)?)/g)).map(match => Number(match[1]));
  const start = Math.max(0, Math.min(totalDuration || Number.MAX_SAFE_INTEGER, values[0] ?? fallbackStart));
  const fallbackEnd = start + 3;
  const end = Math.max(start + 0.3, Math.min(totalDuration || fallbackEnd, values[1] ?? fallbackEnd));
  return { start: +start.toFixed(2), end: +end.toFixed(2) };
}

function includesAny(text: string, pattern: RegExp): boolean {
  return pattern.test(String(text || '').toLowerCase());
}

export function analysisDetailToSegment(material: { id: string; duration: number }, detail: Detail,
  index: number, fallbackStart: number): MaterialSegment {
  const range = parseAnalysisRange(String(detail.time || ''), fallbackStart, material.duration);
  const visual = `${detail.visual || ''} ${detail.observedFacts || ''}`;
  const productVisible = includesAny(visual, /产品|包装|瓶|罐|盒|膏|液|product|package|bottle|jar|tube/);
  const hasPerson = includesAny(visual, /人物|真人|男性|女性|手|脸|眼|皮肤|person|man|woman|hand|face|eye|skin/);
  const ocrText = String(detail.onScreenText || detail.subtitle || '').trim();
  const logoText = Array.from(new Set((ocrText.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []).slice(0, 6)));
  const purpose = String(detail.purpose || '').trim();
  const clarity: MaterialSegment['productClarity'] = !productVisible ? 'none'
    : includesAny(`${detail.shot} ${visual}`, /大特写|特写|close-up|清晰|完整/) ? 'high'
    : includesAny(`${detail.shot} ${visual}`, /近景|中近景|medium/) ? 'medium' : 'low';
  return {
    id: `${material.id}-segment-${index + 1}`,
    start: range.start,
    end: range.end,
    duration: +(range.end - range.start).toFixed(2),
    subject: [productVisible ? '产品' : '', hasPerson ? '人物' : ''].filter(Boolean),
    action: String(detail.beats?.map(beat => beat.action).filter(Boolean).join(' → ') || detail.visual || ''),
    productVisible,
    productClarity: clarity,
    shot: String(detail.shot || ''),
    angle: String(detail.angle || ''),
    composition: String(detail.composition || ''),
    camera: String(detail.camera || ''),
    environment: String(detail.environment || ''),
    quality: Math.max(0, Math.min(100, Math.round(Number(detail.confidence ?? 0.7) * 100))),
    ocrText,
    hasPerson,
    hasLogo: logoText.length > 0,
    logoText,
    recommendedFunctions: purpose ? [purpose] : [],
    authenticity: String(detail.authenticity || ''),
    confidence: Math.max(0, Math.min(1, Number(detail.confidence ?? 0.7))),
    needsReview: Boolean(detail.needsReview || !purpose || clarity === 'low'),
  };
}

/** Shared conversion for automated production and the material library. */
export function productionAnalysisSegments(id: string, duration: number, analysis: Analysis): Array<Record<string, unknown>> {
  let cursor = 0;
  return (analysis.scriptDetails15s || []).map((detail, index) => {
    const segment = analysisDetailToSegment({ id, duration }, detail, index, cursor);
    cursor = segment.end;
    return { ...segment, observedFacts: detail.observedFacts || '' };
  });
}
