import { videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import { buildVideoAnalysisProgress } from '../lib/videoAnalysisProgress.js';
import { publicVideoPipelineError } from './videoAnalysisRecovery.js';
import { youtubeThumbnailFromUrl } from './videoCrawlerSourceUrls.js';
import { parseJsonRecord } from './videoCrawlerNormalization.js';

function evidenceRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  const parsed = parseJsonRecord<unknown>(value, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** Removes private evidence details while preserving the public progress contract. */
export function publicVideoRecord<T extends Record<string, unknown>>(
  record: T,
  progressOptions: { queuePosition?: number | null; nowMs?: number } = {},
): T {
  const stableYouTubeThumbnail = record.platform === 'youtube'
    ? youtubeThumbnailFromUrl(String(record.sourceUrl || ''))
    : '';
  const publicRecord = stableYouTubeThumbnail
    ? { ...record, thumbnailUrl: stableYouTubeThumbnail } as T
    : record;
  const analysis = videoAnalysisOf(record);
  if (!Object.keys(analysis).length) return publicRecord;
  const scrubbed: Record<string, unknown> = {
    ...analysis,
    analysisProgress: buildVideoAnalysisProgress({
      analysis,
      recordStatus: record.status,
      recordUpdatedAt: record.updated || record.updatedAt || record.crawledAt,
      duration: record.duration,
      queuePosition: progressOptions.queuePosition,
      failureMessage: publicVideoPipelineError(analysis.analysisError || analysis.videoLevelFailureStatus || analysis.downloadError),
      nowMs: progressOptions.nowMs,
    }),
  };
  const gemini = evidenceRecord(analysis.gemini);
  if (Array.isArray(gemini.scriptDetails15s)) {
    scrubbed.gemini = {
      ...gemini,
      scriptDetails15s: gemini.scriptDetails15s.map(raw => {
        const detail = evidenceRecord(raw);
        const evidence = evidenceRecord(detail.materialEvidence);
        if (!Object.keys(evidence).length) return detail;
        const { clipObjectKey: _clipObjectKey, firstFrameObjectKey: _firstFrameObjectKey, ...publicEvidence } = evidence;
        return { ...detail, materialEvidence: publicEvidence };
      }),
    };
  }
  for (const key of [
    'adminOnlyVideoFailure',
    'userVisible',
    'videoLevelFailureStatus',
    'manualRequiredReason',
    'replacementForRecordId',
    'backfillReason',
    'downloadError',
    'analysisError',
    'crawlerOpsLastError',
    'youtubeDirectError',
  ]) {
    delete scrubbed[key];
  }
  return { ...publicRecord, aiAnalysis: JSON.stringify(scrubbed) };
}

/** Stable visible queue numbering; metadata-only jobs do not take a position. */
export function analysisQueuePositions(records: Record<string, unknown>[], nowMs = Date.now()): Map<string, number> {
  const queued = records.flatMap(record => {
    const analysis = videoAnalysisOf(record);
    if (!['material', 'stored_video'].includes(String(analysis.analysisQueueKind || ''))) return [];
    const progress = buildVideoAnalysisProgress({
      analysis,
      recordStatus: record.status,
      recordUpdatedAt: record.updated || record.updatedAt || record.crawledAt,
      duration: record.duration,
      nowMs,
    });
    if (progress.stage !== 'queued' || !progress.backendAccepted) return [];
    return [{ id: String(record.id || ''), queuedAt: Date.parse(progress.queuedAt || '') || Number.MAX_SAFE_INTEGER }];
  }).filter(item => item.id).sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  return new Map(queued.map((item, index) => [item.id, index + 1]));
}

function recordKeywordText(record: Record<string, unknown>): string {
  const analysis = videoAnalysisOf(record);
  const tags = parseJsonRecord<string[]>(record.tags, []);
  const gemini = typeof analysis.gemini === 'object' && analysis.gemini
    ? analysis.gemini as Record<string, unknown>
    : {};
  return [
    record.title,
    tags.join(' '),
    analysis.keyword,
    gemini.theme,
    Array.isArray(gemini.hooks) ? gemini.hooks.join(' ') : '',
    Array.isArray(gemini.sellingPoints) ? gemini.sellingPoints.join(' ') : '',
  ].join(' ').toLowerCase();
}

export function recordMatchesKeyword(record: Record<string, unknown>, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized || /^https?:\/\//i.test(normalized)) return true;
  const tokens = normalized
    .split(/[\s,;，；、]+/)
    .map(token => token.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(token => token.length >= 2);
  if (tokens.length === 0) return true;
  const text = recordKeywordText(record);
  return tokens.some(token => text.includes(token));
}
