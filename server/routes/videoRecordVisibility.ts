import type { Platform } from '../types/index.js';
import { hasCompletedExactVideoEvidence, isVideoLevelAnalysis, videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import { hasRealThumbnail, inferPlatformFromUrl, isPlatformUrl, type CrawledVideo } from './videoCrawlerNormalization.js';

export type ContentFormat = 'video' | 'image';

export function isVisibleVideoPipelineRecord(record: Record<string, unknown>): boolean {
  const analysis = videoAnalysisOf(record);
  if (analysis.usage === 'reference_only' && typeof analysis.contentSha256 === 'string') return true;
  if (hasCompletedExactVideoEvidence(analysis)) return true;
  return Boolean(analysis.requestedAnalysisMode)
    || Boolean(analysis.materialId && (
      analysis.analysisError
      || analysis.videoLevelFailureStatus
      || ['queued', 'analyzing', 'waiting_for_video', 'analysis_retryable', 'video_failed'].includes(String(analysis.geminiStatus || ''))
    ));
}

export function isPublicTestTenantVideo(record: Record<string, unknown>): boolean {
  const analysis = videoAnalysisOf(record);
  if (analysis.userVisible === false) return false;
  return isVideoLevelAnalysis(analysis);
}

export function isDisplayableTestTenantVideo(record: Record<string, unknown>): boolean {
  const analysis = videoAnalysisOf(record);
  if (analysis.usage === 'reference_only' && typeof analysis.contentSha256 === 'string') return true;
  if (analysis.contentFormat === 'image' || String(record.status || '') === 'failed') return false;
  if (hasCompletedExactVideoEvidence(analysis)) return analysis.userVisible !== false;
  if (analysis.adminOnlyVideoFailure || analysis.userVisible === true) {
    return analysis.userVisible === true && isPublicTestTenantVideo(record);
  }
  const downloadStatus = String(analysis.downloadStatus || '');
  const videoFetchStatus = String(analysis.videoFetchStatus || '');
  const geminiStatus = String(analysis.geminiStatus || '');
  const terminalFailures = new Set([
    'failed', 'download_failed', 'manual_required', 'metadata_only',
    'unavailable', 'url_failed', 'ops_failed', 'video_failed', 'metadata_fallback',
  ]);
  if ([downloadStatus, videoFetchStatus, geminiStatus].some(status => terminalFailures.has(status))) return false;
  const sourceUrl = String(record.sourceUrl || '').trim();
  const platform = (record.platform || inferPlatformFromUrl(sourceUrl)) as Platform;
  const thumbnailUrl = String(record.thumbnailUrl || '').trim();
  const pendingStatuses = new Set([
    'queued', 'downloading', 'download_retrying', 'ops_queued',
    'ops_processing', 'analyzing', 'waiting_for_video',
  ]);
  const paused = Boolean(analysis.analysisPausedAt)
    || [downloadStatus, videoFetchStatus, geminiStatus].some(status => status === 'paused');
  return isPlatformUrl(sourceUrl, platform)
    && Boolean(String(record.title || '').trim())
    && hasRealThumbnail({ thumbnailUrl } as CrawledVideo)
    && (paused || [downloadStatus, videoFetchStatus, geminiStatus].some(status => pendingStatuses.has(status)));
}

export function compareCrawledAtDesc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aTime = Date.parse(String(a.crawledAt || ''));
  const bTime = Date.parse(String(b.crawledAt || ''));
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

export function recordContentFormat(record: Record<string, unknown>): ContentFormat {
  if (record.contentFormat === 'image' || record.contentFormat === 'video') return record.contentFormat;
  const analysis = videoAnalysisOf(record);
  return analysis.contentFormat === 'image' ? 'image' : 'video';
}

export function isPublicImageRecord(record: Record<string, unknown>): boolean {
  const analysis = videoAnalysisOf(record);
  return analysis.contentFormat === 'image'
    && analysis.userVisible !== false
    && isValidImagePostRecord(record);
}

export function isValidImagePostRecord(record: Record<string, unknown>): boolean {
  const sourceUrl = String(record.sourceUrl || '').trim();
  const thumbnailUrl = String(record.thumbnailUrl || '').trim();
  const analysis = videoAnalysisOf(record);
  const hasCollectedImage = Array.isArray(analysis.imageUrls)
    && analysis.imageUrls.some(url => typeof url === 'string' && url.trim());
  // A failed visual-analysis attempt must not hide a successfully collected
  // post. The first collected image remains a valid preview and gives the user
  // an entry point to inspect the failure and retry analysis.
  if (!sourceUrl || (!thumbnailUrl && !hasCollectedImage)) return false;
  if (/\/(?:search|explore\/tags)\b/i.test(sourceUrl)) return false;
  const platform = (record.platform || inferPlatformFromUrl(sourceUrl)) as Platform;
  if (platform === 'instagram') return /\/p\//i.test(sourceUrl);
  if (platform === 'facebook') return !/\/(?:watch|reel|videos)\b/i.test(sourceUrl);
  if (platform === 'linkedin') return /\/posts\//i.test(sourceUrl) || /activity[:-]\d+/i.test(sourceUrl);
  return true;
}
