import { gzipSync, gunzipSync } from 'node:zlib';
import type { VideoAiAnalysis } from '../types/index.js';
import { benchmarkAnalysisForRecord } from './benchmarkAnalysis.js';

function parseJsonRecord<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
const textPresent = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function parseAnalysisTimeRange(value: string): { start: number; end: number } | null {
  const numbers = String(value || '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  return numbers.length ? { start: numbers[0], end: numbers[1] ?? numbers[0] + 3 } : null;
}
export function videoAnalysisOf(record: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {}); const compressed = typeof parsed.imageEvidenceGzip === 'string' ? parsed.imageEvidenceGzip : '';
  if (!parsed.imageEvidence && compressed) try { parsed.imageEvidence = JSON.parse(gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8')); } catch { /* explicitly unavailable */ }
  delete parsed.imageEvidenceGzip; delete parsed.imageEvidenceEncoding;
  if (parsed.contentFormat !== 'image' && Object.keys(parsed).length) parsed.benchmarkAnalysis = benchmarkAnalysisForRecord(record, parsed);
  return parsed;
}
/** A review-required exact analysis is completed evidence, not an invitation
 * to fetch the reference again. Review completion is a separate gate. */
export function hasCompletedExactVideoEvidence(analysis: Record<string, unknown>): boolean {
  if (analysis.analysisMode !== 'exact'
    || !['video', 'video_review_required'].includes(String(analysis.analysisQuality || ''))) return false;
  const gemini = objectRecord(parseJsonRecord(analysis.gemini, {}));
  const details = Array.isArray(gemini.scriptDetails15s) ? gemini.scriptDetails15s : [];
  return details.length > 0 && details.every(detail => {
    const row = objectRecord(detail);
    const range = parseAnalysisTimeRange(String(row.time || row.timestamp || ''));
    return Boolean(range && range.end > range.start);
  });
}
export function serializeImagePostAnalysis(analysis: Record<string, unknown>): string {
  const clean = analysis.contentFormat === 'image' ? { ...analysis, gemini: undefined } : analysis; const plain = JSON.stringify(clean);
  if (Buffer.byteLength(plain, 'utf8') <= 4_500 || !clean.imageEvidence) return plain;
  return JSON.stringify({ ...clean, imageEvidence: undefined, imageEvidenceEncoding: 'gzip-base64', imageEvidenceGzip: gzipSync(JSON.stringify(clean.imageEvidence)).toString('base64') });
}
export function hasCompleteVideoGeminiAnalysis(gemini: unknown, duration = 0): boolean {
  const analysis = objectRecord(gemini); if (!Object.keys(analysis).length) return false; const firstTen = objectRecord(analysis.firstTenSeconds);
  const firstTenCount = ['atmosphere', 'audioVisual', 'camera', 'visuals', 'voiceMusic'].filter(key => textPresent(firstTen[key])).length;
  const coarseStructure = Array.isArray(analysis.coarseStructure) ? analysis.coarseStructure.filter(item => { const frame = objectRecord(item); return textPresent(frame.description || frame.desc || frame.frame); }) : [];
  const scriptDetails = Array.isArray(analysis.scriptDetails15s) ? analysis.scriptDetails15s.filter(item => { const detail = objectRecord(item); return textPresent(detail.visual) || textPresent(detail.subtitle); }) : [];
  const analyzedUntil = scriptDetails.reduce((max, item) => { const detail = objectRecord(item); const values = String(detail.time || detail.timestamp || '').match(/\d+(?:\.\d+)?/g)?.map(Number) || []; return Math.max(max, values[1] ?? values[0] ?? 0); }, 0);
  const tolerance = duration > 0 ? Math.max(1, Math.min(3, duration * 0.03)) : 0;
  return textPresent(analysis.theme) && firstTenCount >= 3 && coarseStructure.length >= 1 && scriptDetails.length >= 1 && (duration <= 0 || analyzedUntil + tolerance >= duration);
}
export function analysisTimelineQualityError(analysis: VideoAiAnalysis, duration: number, mode: 'strategy' | 'exact'): string | null {
  const details = (analysis.scriptDetails15s || []).map(detail => ({ detail, range: parseAnalysisTimeRange(String(detail.time || detail.timestamp || '')) }))
    .filter((item): item is { detail: NonNullable<VideoAiAnalysis['scriptDetails15s']>[number]; range: { start: number; end: number } } => Boolean(item.range)).sort((a, b) => a.range.start - b.range.start);
  if (!details.length) return 'no_valid_storyboard_segments'; const effectiveDuration = duration > 0 ? duration : details.at(-1)!.range.end;
  const requiredSegments = effectiveDuration > 5 ? Math.max(2, Math.ceil(effectiveDuration / 5)) : 1; if (details.length < requiredSegments) return `insufficient_segment_density_${details.length}_of_${requiredSegments}`;
  const boundaryTolerance = mode === 'exact' ? 0.75 : 1.25; const maxSegmentSeconds = mode === 'exact' ? 5.5 : 6.25;
  if (details[0].range.start > boundaryTolerance) return `timeline_starts_at_${details[0].range.start.toFixed(2)}s`;
  for (let index = 0; index < details.length; index += 1) { const { start, end } = details[index].range; if (end <= start) return `invalid_segment_${index + 1}`; if (end - start > maxSegmentSeconds) return `segment_${index + 1}_too_long_${(end - start).toFixed(2)}s`; if (index > 0) { const previousEnd = details[index - 1].range.end; if (start - previousEnd > boundaryTolerance) return `timeline_gap_at_${previousEnd.toFixed(2)}s`; if (previousEnd - start > boundaryTolerance) return `timeline_overlap_at_${start.toFixed(2)}s`; } }
  const analyzedUntil = details.at(-1)!.range.end;
  if (duration > 0 && analyzedUntil + boundaryTolerance < duration) return `timeline_ends_at_${analyzedUntil.toFixed(2)}s_of_${duration.toFixed(2)}s`;
  if (duration > 0 && analyzedUntil - boundaryTolerance > duration) return `timeline_exceeds_${analyzedUntil.toFixed(2)}s_of_${duration.toFixed(2)}s`;
  if (mode === 'exact') {
    const classificationError = exactVideoClassificationQualityError(analysis);
    if (classificationError) return classificationError;
  }
  return null;
}

/** Exact analysis is only complete when every server-owned shot can cross the
 * same classification contract consumed by production. A provider returning
 * a valid timeline but omitting these fields is a partial response, not a
 * successful analysis. */
export function exactVideoClassificationQualityError(analysis: VideoAiAnalysis): string | null {
  const details = analysis.scriptDetails15s || [];
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index]!;
    if (!detail.materialType || detail.materialType === 'unknown') return `shot_${index + 1}_material_type_missing`;
    if (!detail.narrativeRole || detail.narrativeRole === 'unknown') return `shot_${index + 1}_narrative_role_missing`;
    if (!String(detail.classificationEvidence || '').trim()) return `shot_${index + 1}_classification_evidence_missing`;
  }
  return null;
}

/** Flags evidence that is structurally valid JSON but unsafe to hand to the
 * production agents as an exact, per-shot reading of the source video. These
 * checks deliberately target strong contradictions; normal refrains and
 * recurring product shots are not enough by themselves. */
export function exactVideoReviewReasons(
  analysis: VideoAiAnalysis,
  duration = 0,
  sceneCuts: number[] = [],
  openingFrame?: { scene: string; confidence: number } | null,
): string[] {
  const rows = (analysis.scriptDetails15s || []).map(detail => ({
    detail,
    range: parseAnalysisTimeRange(String(detail.time || detail.timestamp || '')),
  })).filter((row): row is { detail: NonNullable<VideoAiAnalysis['scriptDetails15s']>[number]; range: { start: number; end: number } } => Boolean(row.range));
  if (!rows.length) return ['missing_exact_shots'];
  const reasons: string[] = [];
  const fullDuration = duration > 0 ? duration : Math.max(...rows.map(row => row.range.end));
  const reviewCount = rows.filter(row => row.detail.needsReview === true).length;
  if (reviewCount >= Math.max(2, Math.ceil(rows.length * 0.5))) reasons.push(`unverified_shots_${reviewCount}_of_${rows.length}`);
  const shortRows = rows.filter(row => row.range.end - row.range.start < 0.2);
  if (shortRows.length) reasons.push(`sub_200ms_shots_${shortRows.length}`);
  const normalized = (value: unknown): string => typeof value === 'string'
    ? value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') : '';
  const repeatedAcrossTimeline = (field: 'dialogue' | 'visual', minimumLength: number, minimumRows: number): number => {
    const groups = new Map<string, Array<{ start: number; end: number }>>();
    for (const row of rows) {
      const value = normalized(row.detail[field]);
      if (value.length < minimumLength) continue;
      groups.set(value, [...(groups.get(value) || []), row.range]);
    }
    for (const matches of groups.values()) {
      if (matches.length < minimumRows) continue;
      const span = Math.max(...matches.map(match => match.end)) - Math.min(...matches.map(match => match.start));
      if (span >= Math.min(8, fullDuration * 0.3)) return matches.length;
    }
    return 0;
  };
  const duplicateDialogue = repeatedAcrossTimeline('dialogue', 18, Math.max(3, Math.ceil(rows.length * 0.2)));
  if (duplicateDialogue) reasons.push(`repeated_full_dialogue_${duplicateDialogue}_shots`);
  const duplicateVisual = repeatedAcrossTimeline('visual', 18, Math.max(4, Math.ceil(rows.length * 0.45)));
  if (duplicateVisual) reasons.push(`repeated_visual_description_${duplicateVisual}_shots`);
  const meaningfulCuts = sceneCuts.filter(cut => cut > 0.2 && cut < fullDuration - 0.2);
  const boundaries = rows.flatMap(row => [row.range.start, row.range.end]);
  const uncovered = meaningfulCuts.filter(cut => !boundaries.some(boundary => Math.abs(boundary - cut) <= 0.45));
  if (meaningfulCuts.length >= 3 && uncovered.length >= Math.max(2, Math.ceil(meaningfulCuts.length * 0.3))) {
    reasons.push(`uncovered_scene_cuts_${uncovered.length}_of_${meaningfulCuts.length}`);
  }
  const shortSequenceCuts = meaningfulCuts.filter((cut, index) =>
    (index > 0 && cut - meaningfulCuts[index - 1]! <= 2.5)
    || (index < meaningfulCuts.length - 1 && meaningfulCuts[index + 1]! - cut <= 2.5));
  const missingShortSequenceCuts = shortSequenceCuts.filter(cut => !boundaries.some(boundary => Math.abs(boundary - cut) <= 0.12));
  if (shortSequenceCuts.length >= 3 && missingShortSequenceCuts.length) {
    reasons.push(`uncovered_short_sequence_cuts_${missingShortSequenceCuts.length}_of_${shortSequenceCuts.length}`);
  }
  if (openingFrame && openingFrame.confidence >= 0.8 && rows[0]!.range.start <= 0.3) {
    const openingText = [rows[0]!.detail.visual, rows[0]!.detail.environment, rows[0]!.detail.observedFacts]
      .filter(textPresent).join(' ').toLocaleLowerCase();
    if (openingFrame.scene === 'showroom' && /工厂|车间|产线|生产线|factory|workshop|assembly.line/i.test(openingText)) {
      reasons.push('opening_frame_factory_showroom_conflict');
    }
    if (openingFrame.scene === 'factory' && /展厅|陈列室|门店|showroom|retail.store/i.test(openingText)) {
      reasons.push('opening_frame_showroom_factory_conflict');
    }
  }
  return reasons;
}
export function canPromoteExistingAnalysisToExact(gemini: unknown, duration = 0): boolean {
  if (!hasCompleteVideoGeminiAnalysis(gemini, 0)) return false; const analysis = objectRecord(gemini); const details = Array.isArray(analysis.scriptDetails15s) ? analysis.scriptDetails15s : [];
  const analyzedUntil = details.reduce((max, item) => { const detail = objectRecord(item); const values = String(detail.time || detail.timestamp || '').match(/\d+(?:\.\d+)?/g)?.map(Number) || []; return Math.max(max, values[1] ?? values[0] ?? 0); }, 0);
  const requiredSegments = duration > 0 ? Math.max(2, Math.ceil(duration / 5)) : 3; const tolerance = duration > 0 ? Math.max(1.5, Math.min(3, duration * 0.1)) : 0;
  return details.length >= requiredSegments && (duration <= 0 || analyzedUntil + tolerance >= duration);
}
export function isAutoSeededVideo(record: Record<string, unknown>): boolean {
  const analysis = videoAnalysisOf(record);
  return Boolean(analysis.seededFromRecordId || analysis.analysisSource === 'demo-local-video' || String(analysis.crawlRule || '').includes('演示素材'));
}
export function isVideoLevelAnalysis(analysis: Record<string, unknown>): boolean {
  const geminiStatus = String(analysis.geminiStatus || ''); const downloadStatus = String(analysis.downloadStatus || '');
  const videoFetchStatus = String(analysis.videoFetchStatus || ''); const analysisSource = String(analysis.analysisSource || '');
  if (analysis.analysisQuality !== 'video' || !analysis.gemini) return false;
  if (analysisSource === 'metadata-fallback' || geminiStatus === 'metadata_fallback' || downloadStatus === 'metadata_only') return false;
  return (!geminiStatus || geminiStatus === 'analyzed') && (!downloadStatus || downloadStatus === 'analyzed' || videoFetchStatus === 'direct_url' || videoFetchStatus === 'fetched');
}
