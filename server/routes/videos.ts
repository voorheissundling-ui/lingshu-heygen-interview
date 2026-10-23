import {createReferenceReviewReadHandlers} from '../lib/referenceReviewReadHandlers.js';
import { apifyFacebookPostToCrawledVideo, apifyInstagramItemToCrawledVideo, apifyTikTokItemToCrawledVideo, asRecord, cleanupAnalysisTitle, compactNumber, firstImageUrl, normalizeThumbnailUrl } from './videoCrawlerProviderProjection.js';
import { apifyFacebookPostToImagePost, apifyInstagramItemToImagePost, apifyTikTokItemToImagePost } from './videoCrawlerImageProjection.js';
import { crawlFailureMessage, cleanSearchResultUrl, mergeCrawledVideos, metaToCrawledVideo, normalizeCrawledVideo, thumbnailForPlatform, softDownloadFailure, isNonRetryableVideoFetch } from './videoCrawlerPublicProjection.js';
import { projectVideoPipelineStats } from './videoPipelineStatsProjection.js';
import { crawlYouTubePublicSearch, fetchPublicText as fetchText, searchPublicVideoUrls, searchPublicVideoUrlsByQuery } from './videoCrawlerPublicDiscovery.js';
export { crawlFailureMessage, youtubeHtmlSearchUrl } from './videoCrawlerPublicProjection.js';
import { metadataFallbackAnalysis } from './videoCrawlerMetadataFallback.js';
import { analysisQueuePositions, publicVideoRecord, recordMatchesKeyword } from './videoPublicRecordProjection.js';
import { isPublicTestTenantVideo, isVisibleVideoPipelineRecord, recordContentFormat, type ContentFormat } from './videoRecordVisibility.js';
export { isDisplayableTestTenantVideo } from './videoRecordVisibility.js';
import { createVideoTenantListing } from './videoTenantListing.js';
import { registerVideoListingRoutes } from './videoListingRoutes.js';
import { createVideoThumbnailPersistence, fetchThumbnailBuffer, isExpiredSignedThumbnail, isSignedExpiringThumbnail, publicSourceThumbnail } from './videoThumbnailPersistence.js';
export { recordThumbnailUrl } from './videoThumbnailPersistence.js';
export { matchesVideoSearch, matchesCrawlRange } from './videoTenantListing.js';
import { videoLevelSuccessPatch, videoSuccessVisibilityPatch } from './videoAnalysisSuccessPatch.js';
import { tiktokKeywordSources, verifiedKeywordSeedItems, verifiedSeedUrls } from './videoCrawlerSeedCatalog.js';
import { groupExactObservationWindows, qwenFrameSeconds, selectFramesForPhysicalCuts, shiftedTimelineLabel, splitExactGeminiShotsAtSceneCuts } from './videoAnalysisTimelineProjection.js';
export { groupExactObservationWindows, selectFramesForPhysicalCuts, splitExactGeminiShotsAtSceneCuts } from './videoAnalysisTimelineProjection.js';
import { compactVideoPipelineError, describeVideoAnalysisRecovery, publicVideoPipelineError, queuedMaterialFailureRequiresSourceFallback, queuedVideoAnalysisFailurePatch, videoAnalysisRetryQueuePatch, type VideoAnalysisRetryQueueKind } from './videoAnalysisRecovery.js';
export { describeVideoAnalysisRecovery, queuedMaterialFailureRequiresSourceFallback, queuedVideoAnalysisFailurePatch, videoAnalysisRetryQueuePatch } from './videoAnalysisRecovery.js';
export type { VideoAnalysisRecovery, VideoAnalysisRetryQueueKind } from './videoAnalysisRecovery.js';
import { accountLabelFromUrl, accountListUrlCandidates, canonicalSourceUrl, looksLikeAccountUrl, looksLikeVideoUrl, normalizeAccountListUrl, stripTrackingParams, youtubeThumbnailFromUrl } from './videoCrawlerSourceUrls.js';
export { accountLabelFromUrl, looksLikeAccountUrl } from './videoCrawlerSourceUrls.js';
import { classifyCrawlerFailure, crawlerRetryDelayMs, filterCrawlerOpsTasksForRecordIds, recoverInterruptedCrawlerOpsTask, resetCrawlerOpsTaskForExplicitRetryState, selectPendingCrawlerOpsTasks, terminalizeExhaustedCrawlerOpsTask, type CrawlerOpsTask } from './videoCrawlerOpsTaskState.js';
export { filterCrawlerOpsTasksForRecordIds, recoverInterruptedCrawlerOpsTask, resetCrawlerOpsTaskForExplicitRetryState, selectPendingCrawlerOpsTasks, terminalizeExhaustedCrawlerOpsTask } from './videoCrawlerOpsTaskState.js';
import {classifyDiscoverySourceFailure} from '../socialDiscovery/sourceFailure.js';
import {createImagePostEvidenceAnalyzer, type CrawledImagePost} from '../socialDiscovery/imagePostEvidenceAnalysis.js';
import {importNewImagePost} from '../socialDiscovery/imagePostImport.js';
import {refreshExistingImagePost} from '../socialDiscovery/imagePostRefresh.js';
import {reanalyzeStoredImagePost} from '../socialDiscovery/imagePostReanalysis.js';
import {createImagePostAnalysisQueue} from '../socialDiscovery/imagePostAnalysisQueue.js';
import {createImagePostMediaPersistence} from '../socialDiscovery/imagePostMediaPersistence.js';
import { runPaidApifyTikTokDataset, type PaidApifyTikTokPermit } from './apifyPaidTikTokTransport.js';
import { buildApifyTikTokInput } from './apifyTikTokInput.js';
export { buildApifyTikTokInput } from './apifyTikTokInput.js';
import { buildVideoDownloaderArgs } from './videoDownloaderArgs.js';
export { platformReferer } from './videoDownloaderArgs.js';
import { browserUserAgent, cookieBrowsers, cookieFiles, cookiesBrowser, crawlerExecutionEnv,
  crawlerProxyPool, crawlerProxyUrl, redactProxy, selectCrawlerProxy, usesServerCookiesForCrawl } from './videoCrawlerRuntimeConfig.js';
import { assertConfiguredLinkedInCompanyPaidCollection, runConfiguredLinkedInCompanyPaidCollection, type LinkedInCompanyPaidPermit } from './linkedinCompanyPostPaidCollection.js';
import {frozenWeeklyAccountFiveVideoActorInput} from '../socialDiscovery/weeklyAccountCollectionBudget.js';
import {readVerifiedWeeklyOriginalDatasetReplay,type VerifiedWeeklyOriginalDatasetReplay} from '../socialDiscovery/weeklyAccountCollectionDatasetContinuation.js';
import type {DataStore} from '../storage/datastore.js';
import {discoveryVideoRecordId,loadKnownVideoSourceIdentities,sourceAccountFromProviderMetadata,sourceAccountFromVideoUrl,videoSourceIdentity} from './videoSourceIdentity.js';
import {canFingerprintThumbnailUrl,fingerprintVideoThumbnail,likelySameVideoThumbnail,loadKnownVideoThumbnailFingerprints} from './videoThumbnailDuplicate.js';
import {acquireDurableOperationLease,assertDurableOperationLease,releaseDurableOperationLease} from '../runtime/durableLease.js';
import {executeExactChunks} from '../lib/exactChunkExecution.js';
import {exactQwenScope} from '../agents/exactQwenScope.js';
import {createCandidateContextAssessment,type CandidateContextInput} from '../socialDiscovery/candidateContextAssessment.js';
import {assessCandidateSemantics} from '../socialDiscovery/candidateSemanticAssessment.js';
import {resolveCandidateSemanticPaidCall} from '../socialDiscovery/candidateSemanticBudgetResolver.js';
import {createReferencePhraseAsrHandler} from './referencePhraseAsr.js';
import { registerReferenceExactShotMaterializationRoutes } from './referenceExactShotMaterialization.js';
import { prepareReferenceNarration, readCachedReferenceNarration } from '../lib/referenceNarration.js';
import { lockReferenceSpeechTimeline, type ReferenceSpeechTranscript } from '../lib/referenceSpeechAnalysis.js';
import { joinReferenceWords } from '../lib/referenceWordAlignment.js';
import { probeReferenceMediaClock } from '../lib/referenceMediaClock.js';
import { produceReferenceCriticalShots } from '../lib/referenceCriticalShotProduction.js';
import { produceReferenceProductionRouting } from '../lib/referenceProductionRouting.js';
import { AnalysisAlreadyRunningError, AnalysisLeaseRegistry } from '../lib/analysisLease.js';
import { DownloadBudget, RecordWorkRegistry, terminalDownloadFailure } from '../lib/downloadExecution.js';
import { Router, type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { createVideoDownloaderPythonResolver } from '../lib/videoDownloaderPython.js';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { presenterDenseSamplingRanges, requiresPresenterDenseSampling, type ReferenceFrameSamplingRange } from '../lib/referenceFrameSamplingPolicy.js';
import { detectVideoSceneCuts, extractOpeningHookFrames, extractQwenAnalysisFrames } from './videoFrameExtraction.js';
export { extractQwenAnalysisFrames } from './videoFrameExtraction.js';
import { requireAuth, type AuthLocals } from '../middleware/auth.js';
import { store } from '../storage/index.js';
import { attachFile, fetchFile } from '../storage/files.js';
import { objectStorageEnabled, objectStorageDownload, objectStorageGetObject, objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';
import { analyzeVideo, analyzeYouTubeUrl } from '../agents/gemini.js';
import { analyzeVideoFramesWithQwen, analyzeVideoTimelineDetailsWithQwen, inspectVideoOpeningFrameWithQwen, repairVideoShotClassificationsWithQwen, transcribeAudioWithQwen, type QwenTimelinePlan } from '../agents/qwen.js';
import { inspectOpeningHookMotionWithGemini } from '../agents/geminiHookMotion.js';
import type { Platform, VideoAiAnalysis, VideoStatus } from '../types/index.js';
import type { SocialDiscoveryMode } from '../../shared/contracts/socialContentWorkflow.js';
import { isDemoMode } from '../lib/demo.js';
import { buildSocialReferenceReviewHandoff } from '../starter198/socialReferenceReviewHandoff.js';
import { assertSalesPresenterQwenConfigured, reviewSalesPresenterFramesWithQwen } from '../agents/qwen.js';
import { salesReviewKey, validateSalesReview, SALES_REVIEW_VERSION, type SalesShot } from '../lib/salesPresenterReview.js';
import { resolveReferenceSalesPresenter } from './referencePresenterLock.js';
import { buildReferenceSpeechTimeline, type ReferenceStructureInput } from './referenceSpeechTimeline.js';
import { approximateSpeechLines } from '../lib/referenceApproxSpeech.js';
import { attachReviewShotMaterials, loadReferenceShotReview, reviewShotMaterialFingerprint, updateReferenceShotReview } from '../lib/referenceShotReview.js';
import { currentVerifiedSpeech, validateVerifiedSpeechLines, verifiedSpeechStatus, type VerifiedReferenceSpeech } from '../lib/verifiedReferenceSpeech.js';
import { recordVideoAdminAlert, updateVideoAdminAlertByRecordId } from '../lib/videoAdminAlerts.js';
import { requireAdminUser } from '../lib/demoAccounts.js';
import { ASSET_SESSION_COOKIE, cookieValue, signAssetUrl, tenantAssetDir, tenantAssetRelativePath } from '../lib/assetAccess.js';
import { buildDownloadedReferenceMaterial } from '../lib/downloadedReferenceMaterial.js';
import { resolvePublicVideoSource, validatePublicVideoSourceUrl, type ValidatedPublicVideoSource } from '../lib/publicVideoSourceSecurity.js';
import { fetchCloudMaterial, getCloudMaterialRecord } from '../lib/cloudMaterials.js';
import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import { currentDataAuthority, runWithDataAuthority } from '../storage/dataAuthority.js';
import { analysisTimelineQualityError, canPromoteExistingAnalysisToExact, exactVideoClassificationQualityError, exactVideoReviewReasons, hasCompletedExactVideoEvidence, isVideoLevelAnalysis, parseAnalysisTimeRange, serializeImagePostAnalysis, videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import { benchmarkAnalysisForRecord } from '../lib/benchmarkAnalysis.js';
import { productionReferenceAdmission } from '../../shared/productionReferenceAdmission.js';
import { applyOpeningHookMotionEvidence, firstSubstantiveOpeningShot, reconcileStoredOpeningHookMotionEvidence } from './hookMotionEvidence.js';
import { isDiscoveryVideoEligible } from '../../shared/contracts/discoveryVideoPolicy.js';
import { apifyCandidateWindow, cleanupFacebookTitle, dateOnly, decodeHtml, extractFacebookViews, extractFacebookWatchUrls, extractMeta, extractTitle, filterDateRangeItems, filterKeywordRelevantItems, filterRealMediaItems, hasDateRange, hasRealThumbnail, heatValue, humanSize, inferPlatformFromUrl, isGenericSocialTitle, isKeywordRelevant, isPlatformUrl, isWithinDateRange, keywordRequiredTermGroups, keywordSearchTerms, mergeExistingTags, metadataCreatorAccount, metadataTitle, metadataUploader, mimeFromPath, parseJsonRecord, safeMaterialName, safeVideoExtension, sortByHeat, tagsFromKeyword, uploadedAtFromMeta, videoDedupeKey, ytdlpDateArgs, type CrawledVideo } from './videoCrawlerNormalization.js';
export { apifyCandidateWindow, inferPlatformFromUrl } from './videoCrawlerNormalization.js';
import {
  hasDurableExactAnalysisOwner,
  isOwnerlessExactAnalysisStale,
  sourceAnalysisQueueFailurePatch,
  sourceAnalysisQueueReceiptPatch,
} from '../lib/videoAnalysisProgress.js';

export const videosRouter = Router();
videosRouter.use(requireAuth);
registerReferenceExactShotMaterializationRoutes(videosRouter, store);

const COL = 'trend_videos';
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, '../../data/media');
const ANALYSIS_DIR = path.join(__dirname, '../../data/analysis-temp');
const MATERIALS_FILE = path.join(__dirname, '../../data/materials.json');
const CRAWLER_OPS_FILE = path.join(__dirname, '../../data/crawler-ops-queue.json');
const APIFY_USAGE_FILE = path.join(__dirname, '../../data/apify-video-usage.json');
const ffmpegBin = ffmpegStatic as unknown as string | null;
const MANUAL_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const REFERENCE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;
const referenceImportRegistry = new RecordWorkRegistry();
let legacyFakePurgePromise: Promise<void> | null = null;
let activeDownloadJobs = 0;
const MAX_DOWNLOAD_JOBS = Number(process.env.VIDEO_DOWNLOAD_CONCURRENCY || 3);
const pendingVisibleBackfillJobs = new Set<string>();
const pocketBaseBackfillFailures = new Map<string, number>();
const { isMissingLocalThumbnail, cacheThumbnailLocally, storeThumbnailBuffer, persistThumbnailIfExpiring } = createVideoThumbnailPersistence({
  collection: COL, mediaDir: MEDIA_DIR, uploadObject: uploadCrawlerCosObject, dataStore: store, attachFile,
});
const { fetchImageForAnalysis, analyzeImagePostBestEffort } = createImagePostEvidenceAnalyzer({
  store, collection: COL, mediaDir: MEDIA_DIR, normalizeThumbnailUrl,
});
const { persistThumbnail: persistImagePostThumbnail, persistImages: persistImagePostImages } = createImagePostMediaPersistence({
  store, collection: COL, cacheThumbnail: cacheThumbnailLocally,
  fetchImage: fetchImageForAnalysis, uploadObject: uploadCrawlerCosObject,
});
export const imagePostAnalysisQueue = createImagePostAnalysisQueue({ store, collection: COL, analyze: analyzeImagePostBestEffort });
const queueImagePostAnalysis = imagePostAnalysisQueue.queue;

const ytDlpPythonPath = createVideoDownloaderPythonResolver();

function crawlerCosKey(record: Record<string, unknown>, role: string, extension: string): string {
  const tenantId = String(record.tenantId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const recordId = String(record.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeRole = role.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return `crawlers/tenants/${tenantId}/trend-videos/${recordId}/${safeRole}.${safeExtension}`;
}
/** Persist independently playable shot clips and exact first frames. The
 * URLs are served through tenant-checked routes below, never as public COS
 * links. A failed extraction stays explicitly unavailable in the analysis. */
async function persistExactShotEvidence(recordId: string, filePath: string, analysis: VideoAiAnalysis): Promise<VideoAiAnalysis> {
  if (!ffmpegBin || !Array.isArray(analysis.scriptDetails15s)) return analysis;
  const record = await store.getById<Record<string, unknown>>(COL, recordId);
  if (!record) return analysis;
  const details = [...analysis.scriptDetails15s];
  let openingFrameInspection: ReturnType<typeof inspectVideoOpeningFrameWithQwen> | null = null;
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index]!;
    const range = parseAnalysisTimeRange(String(detail.time || detail.timestamp || ''));
    if (!range || range.end - range.start < 0.2) continue;
    const prefix = path.join(ANALYSIS_DIR, `shot-${recordId}-${index}-${randomUUID()}`);
    const clipPath = `${prefix}.mp4`;
    const framePath = `${prefix}.jpg`;
    const firstFrameSeconds = Math.max(0, range.start + Math.min(0.04, (range.end - range.start) / 4));
    try {
      fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
      await execFileAsync(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(range.start), '-i', filePath,
        '-t', String(range.end - range.start), '-map', '0:v:0', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-c:a', 'aac', '-movflags', '+faststart', '-y', clipPath,
      ], { timeout: 90_000 });
      await execFileAsync(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error', '-ss', String(firstFrameSeconds), '-i', filePath,
        '-frames:v', '1', '-q:v', '3', '-y', framePath,
      ], { timeout: 30_000 });
      if (index === 0 && isQwenConfigured()) {
        openingFrameInspection = inspectVideoOpeningFrameWithQwen({
          base64: fs.readFileSync(framePath).toString('base64'), mimeType: 'image/jpeg',
        }).catch(error => {
          console.warn('[videos] independent opening-frame check unavailable:', error instanceof Error ? error.message : error);
          return { scene: 'unknown' as const, hasPerson: null, hasProduct: null, confidence: 0 };
        });
      }
      let clipKey = '';
      let frameKey = '';
      if (objectStorageEnabled()) {
        clipKey = await uploadCrawlerCosObject(recordId, `shot-${index + 1}-clip`, fs.readFileSync(clipPath), 'video/mp4');
        frameKey = await uploadCrawlerCosObject(recordId, `shot-${index + 1}-first-frame`, fs.readFileSync(framePath), 'image/jpeg');
      } else {
        const destination = path.join(tenantAssetDir(MEDIA_DIR, String(record.tenantId || '')), 'trend-shots', recordId);
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(clipPath, path.join(destination, `shot-${index + 1}.mp4`));
        fs.copyFileSync(framePath, path.join(destination, `shot-${index + 1}.jpg`));
      }
      details[index] = {
        ...detail,
        materialEvidence: {
          sourceVideoRef: `/api/overseas/videos/${recordId}/media`,
          clipRef: `/api/overseas/videos/${recordId}/shot/${index + 1}/clip`,
          firstFrameRef: `/api/overseas/videos/${recordId}/shot/${index + 1}/first-frame`,
          firstFrameSeconds,
          extractionStatus: 'ready',
          clipObjectKey: clipKey,
          firstFrameObjectKey: frameKey,
        },
      } as typeof detail;
    } catch (error) {
      console.warn(`[videos] shot evidence ${recordId}/${index + 1} unavailable:`, error instanceof Error ? error.message : error);
      details[index] = { ...detail, materialEvidence: {
        sourceVideoRef: `/api/overseas/videos/${recordId}/media`, clipRef: null, firstFrameRef: null,
        firstFrameSeconds, extractionStatus: 'unavailable',
      } } as typeof detail;
    } finally {
      for (const file of [clipPath, framePath]) { try { fs.unlinkSync(file); } catch { /* best effort */ } }
    }
  }
  const detectedSceneCuts = (analysis as VideoAiAnalysis & { detectedSceneCuts?: number[] }).detectedSceneCuts
    ?? await detectVideoSceneCuts(filePath);
  const openingFrameObservation = openingFrameInspection ? await openingFrameInspection : null;
  return { ...analysis, scriptDetails15s: details, detectedSceneCuts, openingFrameObservation } as VideoAiAnalysis;
}

async function uploadCrawlerCosObject(
  recordId: string,
  role: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  if (!objectStorageEnabled()) throw new Error('COS object storage is not configured for crawler media');
  const record = await store.getById<Record<string, unknown>>(COL, recordId);
  if (!record) throw new Error(`Crawler record not found before COS upload: ${recordId}`);
  const extension = contentType.includes('webp') ? 'webp'
    : contentType.includes('png') ? 'png'
      : contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg'
        : contentType.includes('mp4') ? 'mp4' : 'bin';
  const key = crawlerCosKey(record, role, extension);
  await objectStorageUpload({ key, body, contentType });
  const verified = await objectStorageHead(key);
  if (!verified || verified.size !== body.length) throw new Error(`COS crawler upload verification failed: ${key}`);
  return key;
}

async function recoverCrawlerImageObjectKey(
  record: Record<string, unknown>,
  role: string,
): Promise<string> {
  if (!objectStorageEnabled()) return '';
  for (const extension of ['jpg', 'png', 'webp']) {
    const key = crawlerCosKey(record, role, extension);
    if (await objectStorageHead(key)) return key;
  }
  return '';
}

async function streamCrawlerCosObject(res: Response, key: string, range?: string): Promise<boolean> {
  const object = await objectStorageGetObject(key, range);
  if (!object) return false;
  res.status(object.contentRange ? 206 : 200);
  res.setHeader('Content-Type', object.contentType || 'application/octet-stream');
  res.setHeader('Accept-Ranges', object.acceptRanges || 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (object.contentLength !== undefined) res.setHeader('Content-Length', object.contentLength);
  if (object.contentRange) res.setHeader('Content-Range', object.contentRange);
  for await (const chunk of object.body) res.write(chunk);
  res.end();
  return true;
}


interface Material {
  id: string;
  name: string;
  folder: string;
  type: 'video' | 'image' | 'audio';
  duration: number;
  size: string;
  file: string;
  url: string;
  poster?: string;
  objectKey?: string;
  tenantId?: string;
  scope: 'shared' | 'own';
  usage?: 'editable' | 'reference_only';
  sourceType?: string;
  sourceUrl?: string;
  rightsReviewStatus?: string;
  commercialUseApproved?: boolean;
  derivativesApproved?: boolean;
  rawLibraryUseApproved?: boolean;
  mayAnalyze?: boolean;
  mayUseInProduction?: boolean;
  pinned?: boolean;
  contentSha256?: string;
  provenance?: Record<string, unknown>;
  createdAt: string;
}

function isTestTenantRecord(tenant: Record<string, unknown> | null): boolean {
  if (isDemoMode()) return true;
  const plan = String(tenant?.subscriptionPlan || '').toLowerCase();
  const status = String(tenant?.subscriptionStatus || '').toLowerCase();
  return plan === 'trial' || plan === 'admin' || status === 'trialing';
}

async function isTestTenantId(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  if (localFallbacksEnabled() && currentDataAuthority() !== 'pocketbase' && tenantId.startsWith('local_tenant_')) return true;
  const tenant = await store.getById<Record<string, unknown>>('tenants', tenantId);
  return isTestTenantRecord(tenant);
}


const analysisQueuePositionCache = new Map<string, { expiresAt: number; positions: Map<string, number> }>();

async function tenantAnalysisQueuePositions(tenantId: string): Promise<Map<string, number>> {
  const key = `${currentDataAuthority() || 'default'}:${tenantId}`;
  const cached = analysisQueuePositionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.positions;
  const records: Record<string, unknown>[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const result = await store.list<Record<string, unknown>>(COL, { where: { tenantId }, page, perPage: 100, sort: 'updated' });
    records.push(...result.items);
    if (page >= result.totalPages || result.items.length < 100) break;
  }
  const positions = analysisQueuePositions(records);
  analysisQueuePositionCache.set(key, { expiresAt: Date.now() + 2_000, positions });
  return positions;
}

function withSignedThumbnail<T extends Record<string, unknown>>(record: T, tenantId: string): T {
  const thumbnailUrl = String(record.thumbnailUrl || '');
  if (!thumbnailUrl.startsWith('/media/')) return record;
  return { ...record, thumbnailUrl: signAssetUrl(thumbnailUrl, tenantId) } as T;
}

async function listVisibleTestTenantVideos(input: {
  tenantId: string;
  platform?: Platform;
  keyword?: string;
  limit: number;
}): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const seenSourceUrls = new Set<string>();
  let page = 1;
  let totalPages = 1;
  do {
    const result = await store.list<Record<string, unknown>>(COL, {
      where: input.platform ? { tenantId: input.tenantId, platform: input.platform } : { tenantId: input.tenantId },
      sort: '-crawledAt',
      page,
      perPage: 100,
    });
    for (const record of result.items) {
      if (!isPublicTestTenantVideo(record)) continue;
      if (input.keyword && !recordMatchesKeyword(record, input.keyword)) continue;
      const sourceUrl = String(record.sourceUrl || '').trim();
      if (sourceUrl && seenSourceUrls.has(sourceUrl)) continue;
      if (sourceUrl) seenSourceUrls.add(sourceUrl);
      out.push(publicVideoRecord(record));
      if (out.length >= input.limit) return out;
    }
    totalPages = result.totalPages || 1;
    page += 1;
  } while (page <= totalPages && page <= 50);
  return out;
}

async function existingTenantSourceUrls(tenantId: string): Promise<Set<string>> {
  const urls = new Set<string>();
  let page = 1;
  let totalPages = 1;
  do {
    const result = await store.list<Record<string, unknown>>(COL, {
      where: { tenantId },
      page,
      perPage: 100,
    });
    for (const record of result.items) {
      const sourceUrl = String(record.sourceUrl || '').trim();
      if (sourceUrl) urls.add(sourceUrl);
    }
    totalPages = result.totalPages || 1;
    page += 1;
  } while (page <= totalPages && page <= 50);
  return urls;
}

interface TestTenantVideoBackfillInput {
  tenantId: string;
  platform: Platform;
  keyword?: string;
  target: number;
  replacementForRecordId?: string;
  reason?: string;
  forceCreate?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

function scheduleTestTenantVideoBackfill(input: TestTenantVideoBackfillInput): void {
  const key = [
    input.tenantId,
    input.platform,
    input.keyword || '',
    input.dateFrom || '',
    input.dateTo || '',
    input.replacementForRecordId || '',
  ].join('|');
  if (pendingVisibleBackfillJobs.has(key)) return;

  pendingVisibleBackfillJobs.add(key);
  void ensureTestTenantVideoBackfill(input)
    .catch((e) => {
      const error = compactVideoPipelineError(e instanceof Error ? e.message : e);
      console.warn('[videos] test tenant video backfill failed:', error);
      recordVideoAdminAlert({
        recordId: input.replacementForRecordId || '',
        tenantId: input.tenantId,
        platform: input.platform,
        title: `${input.platform} ${input.keyword || ''}`.trim(),
        sourceUrl: '',
        reason: input.reason || 'fresh_video_level_backfill_failed',
        error,
      });
    })
    .finally(() => {
      pendingVisibleBackfillJobs.delete(key);
    });
}

async function ensureTestTenantVideoBackfill(input: TestTenantVideoBackfillInput): Promise<Record<string, unknown>[]> {
  if (!await isTestTenantId(input.tenantId)) return [];

  const keyword = input.keyword || '';
  const target = Math.max(1, Math.min(10, input.target));
  const existingVisible = await listVisibleTestTenantVideos({
    tenantId: input.tenantId,
    platform: input.platform,
    keyword,
    limit: target,
  });
  if (!input.forceCreate && existingVisible.length >= target) return existingVisible;

  const sourceUrls = await existingTenantSourceUrls(input.tenantId);
  const created: Record<string, unknown>[] = [];
  const needed = input.forceCreate ? target : Math.max(0, target - existingVisible.length);
  const candidates = await discoverFreshBackfillCandidates({
    platform: input.platform,
    keyword,
    limit: Math.max(needed * 40, 80),
    excludedSourceUrls: sourceUrls,
    dateFrom: input.dateFrom || '',
    dateTo: input.dateTo || '',
  });

  const maxAnalysisAttempts = Math.max(1, Math.min(10, Number(process.env.VIDEO_BACKFILL_MAX_ANALYSIS_ATTEMPTS || 3)));
  let attempted = 0;
  for (const item of candidates) {
    if (created.length >= needed) break;
    if (attempted >= maxAnalysisAttempts) break;
    attempted += 1;
    const record = await createAndAnalyzeFreshBackfillVideo({
      tenantId: input.tenantId,
      item,
      keyword,
      replacementForRecordId: input.replacementForRecordId,
      reason: input.reason || 'fresh_video_level_backfill',
      dateFrom: input.dateFrom || '',
      dateTo: input.dateTo || '',
    });
    if (!record) continue;
    sourceUrls.add(String(record.sourceUrl || ''));
    created.push(record);
  }

  return [...created, ...existingVisible].slice(0, target);
}

async function discoverFreshBackfillCandidates(input: {
  platform: Platform;
  keyword: string;
  limit: number;
  excludedSourceUrls: Set<string>;
  dateFrom: string;
  dateTo: string;
}): Promise<CrawledVideo[]> {
  const limit = Math.max(1, Math.min(120, input.limit));
  const keyword = input.keyword || DEFAULT_CRAWL_KEYWORDS;
  const candidates: CrawledVideo[] = [];

  try {
    if (input.platform === 'youtube') {
      candidates.push(...await crawlYouTubeSearch(keyword, limit, input.dateFrom, input.dateTo));
    } else if (input.platform === 'tiktok') {
      candidates.push(...await crawlTikTokWithApifyFallback(keyword, limit, input.dateFrom, input.dateTo));
    } else if (input.platform === 'instagram') {
      candidates.push(...await crawlInstagramWithApifyFallback(keyword, limit, input.dateFrom, input.dateTo));
    } else if (input.platform === 'facebook') {
      candidates.push(...await crawlSocialUrlOrFallback(input.platform, keyword, limit, input.dateFrom, input.dateTo));
    }
  } catch (e) {
    console.warn(`[videos] fresh ${input.platform} backfill search failed:`, e instanceof Error ? e.message : e);
  }

  const seen = new Set<string>();
  return sortByHeat(candidates.map(normalizeCrawledVideo))
    .filter(item => item.platform === input.platform && isPlatformUrl(item.sourceUrl, input.platform))
    .filter(item => isDiscoveryVideoEligible(item))
    .filter(item => !input.excludedSourceUrls.has(item.sourceUrl))
    .filter(item => !seen.has(item.sourceUrl) && seen.add(item.sourceUrl))
    .filter(item => isKeywordRelevant(item, keyword))
    .filter(item => item.dateEvidence === 'youtube-upload-filter' || isWithinDateRange(item.uploadedAt, input.dateFrom, input.dateTo))
    .filter(hasRealThumbnail)
    .slice(0, limit);
}

async function createAndAnalyzeFreshBackfillVideo(input: {
  tenantId: string;
  item: CrawledVideo;
  keyword: string;
  replacementForRecordId?: string;
  reason: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<Record<string, unknown> | null> {
  const existing = await store.list(COL, {
    where: { tenantId: input.tenantId, sourceUrl: input.item.sourceUrl },
    page: 1,
    perPage: 1,
  });
  if (existing.items[0]) return null;

  const record = await store.create<Record<string, unknown>>(COL, {
    tenantId: input.tenantId,
    platform: input.item.platform,
    title: input.item.title,
    thumbnailUrl: input.item.thumbnailUrl,
    videoFileId: '',
    duration: input.item.duration,
    sourceUrl: input.item.sourceUrl,
    tags: JSON.stringify(input.item.tags),
    aiAnalysis: JSON.stringify({
      source: input.item.source || `${input.item.platform}-search`,
      views: input.item.views,
      uploadedAt: input.item.uploadedAt,
      dateEvidence: input.item.dateEvidence,
      gemini: metadataFallbackAnalysis(input.item),
      analysisSource: 'metadata-fallback',
      analysisQuality: 'metadata',
      keyword: input.keyword,
      crawlRule: '关键词检索',
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      replacementForRecordId: input.replacementForRecordId,
      backfillReason: input.reason,
      importedAt: new Date().toISOString(),
      userVisible: false,
    }),
    status: 'analyzed' as VideoStatus,
    crawledAt: new Date().toISOString(),
  });
  if (!record) return null;

  try {
    await analyzeSourceVideoJob({
      record,
      sourceUrl: input.item.sourceUrl,
      title: input.item.title,
      platform: input.item.platform,
      suppressVisibleBackfill: true,
    });
  } catch {
    // The record itself is marked for admin review by the analysis path.
  }

  const recordId = String((record as Record<string, unknown>).id || '');
  if (!recordId) return null;
  const latest = await store.getById<Record<string, unknown>>(COL, recordId);
  if (!latest || !isPublicTestTenantVideo(latest)) return null;
  return publicVideoRecord(latest);
}

const DEFAULT_CRAWL_KEYWORDS = 'amazon gadgets product review';
let crawlerOpsWorkerTimer: NodeJS.Timeout | null = null;
let crawlerOpsWorkerActive = false;
let localAnalysisWorkerActive = false;
let stalledExactSweepTimer: NodeJS.Timeout | null = null;
let runtimeCrawlerProxy = '';
const analysisQueueMutations = new Set<string>();

function analysisRunsInWorkerProcess(): boolean {
  return process.env.PROCESS_ROLE_SPLIT_ENABLED === 'true' && process.env.PROCESS_ROLE === 'web';
}

export function activeAnalysisRequest(analysis: Record<string, unknown>, mode?: 'strategy' | 'exact'): boolean {
  if (!analysis.requestedAnalysisMode) return false;
  if (mode && String(analysis.requestedAnalysisMode) !== mode) return false;
  const activeStatuses = ['queued', 'waiting_for_video', 'analyzing', 'downloading', 'download_retrying', 'ops_queued', 'ops_processing'];
  return [analysis.geminiStatus, analysis.downloadStatus, analysis.videoFetchStatus]
    .some(status => activeStatuses.includes(String(status || '')))
    || ['queued', 'running'].includes(String(analysis.analysisQueueState || ''));
}

export interface CrawlVideosInput {
  tenantId: string;
  platform?: Platform;
  keyword?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  // 对标账号主页采集：mode='account' 时 accountUrl 为账号主页 URL，
  // 采集该账号最新视频而非按关键词检索。
  mode?: 'keyword' | 'account';
  accountUrl?: string;
  accountName?: string;
  cloudFallback?: boolean;
  /** One-shot diagnostics must never fan out into automatic replacement crawls. */
  disableBackfill?: boolean;
  /** Scheduled collection finishes after persistence; analysis owns its own queue. */
  deferAnalysis?: boolean;
  /** Maintenance callers may take immediate ownership of exact analysis after persistence. */
  suppressAnalysisQueue?: boolean;
  /** Approved discovery only counts newly imported videos, never a previously stored URL or platform video ID. */
  newCandidatesOnly?: boolean;
  /** Mandatory authority for scoped weekly TikTok account collection; never used by manual crawls. */
  paidPermit?: PaidApifyTikTokPermit;
  /** Trusted discovery worker only; the HTTP crawler never accepts a permit from request JSON. */
  linkedInPaidPermit?: LinkedInCompanyPaidPermit;
  /** Opaque, in-process proof issued only after the original journal and wallet agree. */
  originalDatasetReplay?: VerifiedWeeklyOriginalDatasetReplay;
  /** Trusted worker store; never accepted from an HTTP request. */
  dataStore?: DataStore;
  /** Immutable discovery provenance attached to every imported or deduplicated candidate. */
  discoveryContext?: {
    runId: string;
    scopeId: string;
    scopeVersion: number;
    mode: SocialDiscoveryMode;
    queryRef: string;
    /** A same-run five-video collection is never eligible for legacy Actor
     * sync or a second Actor download, even when an old paid permit exists. */
    weeklyOriginalAccountCollection?: {originalRunKey:string;accountUrl:string;actorInputSha256:string};
  };
}

export function isWeeklyOriginalAccountCollectionRecord(record?:Record<string,unknown>|null):boolean{
  const analysis=record?.aiAnalysis;
  let parsed:Record<string,unknown>|null=null;
  if(typeof analysis==='string'){
    try{const value:unknown=JSON.parse(analysis);parsed=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}catch{return false;}
  }else if(analysis&&typeof analysis==='object'&&!Array.isArray(analysis))parsed=analysis as Record<string,unknown>;
  return Array.isArray(parsed?.discoveryOrigins)&&parsed.discoveryOrigins.some(origin=>origin&&typeof origin==='object'&&'weeklyOriginalAccountCollection' in origin);
}

function discoveryOrigins(
  existing: unknown,
  context: CrawlVideosInput['discoveryContext'],
): Array<Record<string, unknown>> | undefined {
  if (!context) return Array.isArray(existing) ? existing as Array<Record<string, unknown>> : undefined;
  const previous = Array.isArray(existing) ? existing.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [];
  const origin = { ...context, observedAt: new Date().toISOString() };
  return [...previous.filter(item => item.runId !== context.runId || item.mode !== context.mode || item.queryRef !== context.queryRef), origin].slice(-20);
}

class NoCrawlResultsError extends Error {}

export async function acquireDiscoveryAdmissionLease(tenantId: string, dataStore:DataStore=store) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const lease = await acquireDurableOperationLease({
      dataStore, tenantId, scope: 'social-discovery-video-admission',
      subjectId: 'tenant-candidates', ownerId: randomUUID(), leaseDurationMs: 30_000,
    });
    if (lease) return lease;
    if (Date.now() >= deadline) throw Error('discovery_video_admission_busy');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export interface CrawlVideosResult {
  outcome?: 'collected' | 'no_data';
  candidateIds?: string[];
  analysisPending?: boolean;
  platform: Platform;
  keyword: string;
  imported: number;
  refreshed: number;
  skipped: number;
  skippedExisting: number;
  skippedNearDuplicate?: number;
  nearDuplicateUnchecked?: number;
  returnedExisting: number;
  requested: number;
  total: number;
  source: string;
  message: string;
  items: unknown[];
}

// ─── POST /videos/crawl ──────────────────────────────────────────────────────
// Body: { platform?: 'youtube' | 'tiktok' | 'facebook' | 'instagram', keyword?: string, limit?: number, dateFrom?: string, dateTo?: string }
videosRouter.post('/crawl', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const {
    platform = 'youtube',
    keyword = DEFAULT_CRAWL_KEYWORDS,
    limit = 5,
    dateFrom = '',
    dateTo = '',
    mode,
    accountUrl = '',
    accountName = '',
  } = req.body as {
    platform?: Platform;
    keyword?: string;
    limit?: number;
    dateFrom?: string;
    dateTo?: string;
    mode?: 'keyword' | 'account';
    accountUrl?: string;
    accountName?: string;
  };

  if (!['youtube', 'tiktok', 'facebook', 'instagram'].includes(platform)) {
    res.status(400).json({ error: 'Only youtube, tiktok, facebook and instagram are supported by this crawler task' });
    return;
  }

  try {
    const result = await crawlVideosForTenant({ tenantId, platform, keyword, limit, dateFrom, dateTo, mode, accountUrl, accountName });
    res.json(result);
  } catch (e) {
    console.error('[videos] crawl failed:', e);
    res.status(502).json({ error: e instanceof Error ? e.message : 'Crawl failed' });
  }
});

// ─── POST /videos/crawl-image-posts ──────────────────────────────────────────
// Body: { platform?: 'youtube' | 'tiktok' | 'facebook' | 'instagram', keyword?: string, limit?: number }
videosRouter.post('/crawl-image-posts', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const { platform = 'instagram', keyword = DEFAULT_CRAWL_KEYWORDS, limit = 5 } = req.body as {
    platform?: Platform;
    keyword?: string;
    limit?: number;
  };

  if (!['youtube', 'tiktok', 'facebook', 'instagram'].includes(platform)) {
    res.status(400).json({ error: 'Only youtube, tiktok, facebook and instagram are supported by this crawler task' });
    return;
  }

  try {
    const result = await crawlImagePostsForTenant({
      tenantId,
      platform,
      keyword,
      limit,
    });
    res.json(result);
  } catch (e) {
    console.error('[videos] image post crawl failed:', e);
    res.status(502).json({ error: e instanceof Error ? e.message : 'Image post crawl failed' });
  }
});

export async function crawlImagePostsForTenant(input: {
  tenantId: string;
  platform: Platform;
  keyword?: string;
  limit: number;
  mode?: 'keyword' | 'account';
  accountUrl?: string;
  accountName?: string;
  dateFrom?: string;
  dateTo?: string;
  deferImageAnalysis?: boolean;
  /** Trusted worker-issued grant. Ordinary HTTP image crawl never sets this. */
  linkedInPaidCollection?: { runId: string; permit: LinkedInCompanyPaidPermit };
}): Promise<CrawlVideosResult> {
  if (input.platform === 'linkedin' && (!input.linkedInPaidCollection || input.mode !== 'account'
    || !looksLikeAccountUrl(input.accountUrl ?? '', 'linkedin'))) {
    throw Error('linkedin_company_paid_collection_permit_required');
  }
  if (input.linkedInPaidCollection && input.platform !== 'linkedin') throw Error('linkedin_company_paid_collection_scope_mismatch');
  const target = Math.min(30, Math.max(1, Number(input.limit) || 5));
  const accountMode = input.mode === 'account' && looksLikeAccountUrl(input.accountUrl ?? '', input.platform);
  const accountUrl = accountMode ? String(input.accountUrl).trim() : '';
  const keyword = accountMode
    ? String(input.accountName || accountLabelFromUrl(accountUrl)).trim()
    : String(input.keyword || DEFAULT_CRAWL_KEYWORDS).trim();
  const dateFrom = String(input.dateFrom || '');
  const dateTo = String(input.dateTo || '');
  let items: CrawledImagePost[] = [];
  let crawlerMessage = '';
  const crawlerSource = `${input.platform}-image-${accountMode ? 'account' : 'search'}`;

  try {
    const safeLimit = Math.max(target * 4, target, 12);
    if (input.platform === 'linkedin') {
      const approved = input.linkedInPaidCollection!;
      const result = await runConfiguredLinkedInCompanyPaidCollection({ tenantId: input.tenantId,
        runId: approved.runId, companyUrl: accountUrl, limit: target, dateFrom, dateTo }, approved.permit);
      items = result.images;
    } else if (input.platform === 'instagram') {
      items = await crawlInstagramImagePostsApify(keyword, safeLimit, accountUrl);
    } else if (input.platform === 'tiktok') {
      items = await crawlTikTokImagePostsApify(keyword, safeLimit, accountUrl, dateFrom, dateTo);
    } else if (input.platform === 'facebook') {
      items = await crawlFacebookImagePostsApify(accountUrl || keyword, safeLimit);
    } else if (input.platform === 'youtube') {
      items = await crawlYouTubeCommunityPostsPublicSearch(keyword, safeLimit, accountUrl);
    }
    items = items
      .filter(item => item.platform === input.platform && isPlatformUrl(item.sourceUrl, input.platform))
      .filter(item => accountMode || imagePostRelevant(item, keyword));
    if (hasDateRange(dateFrom, dateTo)) items = items.filter(item => isWithinDateRange(item.uploadedAt, dateFrom, dateTo));
  } catch (e) {
    if (input.platform === 'linkedin') throw e;
    crawlerMessage = e instanceof Error
      ? `${input.platform} 图文采集未找到可入库内容：${e.message}`
      : `${input.platform} 图文采集未找到可入库内容`;
    console.warn(`[videos] ${input.platform} image post crawl degraded:`, e);
    items = [];
  }

  const seen = new Set<string>();
  const orderedItems = items
    .filter(item => {
      if (seen.has(item.sourceUrl)) return false;
      seen.add(item.sourceUrl);
      return true;
    })
    .slice(0, target);

  let imported = 0;
  let skipped = 0;
  let skippedExisting = 0;
  const records: unknown[] = [];
  const existingRecords: unknown[] = [];

  for (const item of orderedItems) {
    const existingByUrl = await store.list(COL, {
      where: { tenantId: input.tenantId, sourceUrl: item.sourceUrl },
      page: 1,
      perPage: 1,
    });
    const existingRecord = existingByUrl.items[0] as Record<string, unknown> | undefined;
    if (existingRecord) {
      skipped += 1;
      skippedExisting += 1;
      if (['queued', 'processing', 'unknown'].includes(String(videoAnalysisOf(existingRecord).imageAnalysisQueueState || ''))) {
        existingRecords.push(existingRecord);
        continue;
      }
      const refreshed = await refreshExistingImagePost({
        store, collection: COL, tenantId: input.tenantId, existingRecord, item, keyword,
        accountMode, accountUrl, deferImageAnalysis: Boolean(input.deferImageAnalysis),
        persistThumbnail: persistImagePostThumbnail, persistImages: persistImagePostImages,
        analyze: analyzeImagePostBestEffort, queue: queueImagePostAnalysis,
      });
      existingRecords.push(refreshed);
      continue;
    }

    const record = await importNewImagePost({
      store, collection: COL, tenantId: input.tenantId, item, keyword, crawlerSource,
      accountMode, accountUrl, deferImageAnalysis: Boolean(input.deferImageAnalysis),
      persistThumbnail: persistImagePostThumbnail, persistImages: persistImagePostImages,
      analyze: analyzeImagePostBestEffort, queue: queueImagePostAnalysis,
    });
    if (record) {
      imported += 1;
      records.push(record);
    }
    if (imported >= target) break;
  }

  const resultRecords = [...records, ...existingRecords].slice(0, target);
  return {
    platform: input.platform,
    keyword,
    imported,
    refreshed: 0,
    skipped,
    skippedExisting,
    returnedExisting: Math.max(0, resultRecords.length - records.length),
    requested: target,
    total: items.length,
    source: crawlerSource,
    message: crawlerMessage || (resultRecords.length
      ? `${accountMode ? '主页图文' : '图文'}采集完成：返回 ${resultRecords.length} 条（新增 ${imported} 条，库内已有 ${Math.max(0, resultRecords.length - records.length)} 条）`
      : `图文采集完成：未找到可入库图文，请换关键词或平台账号主页`),
    items: resultRecords.map(record => publicVideoRecord(record as Record<string, unknown>)),
  };
}

export async function crawlVideosForTenant(input: CrawlVideosInput): Promise<CrawlVideosResult> {
  const dataStore=input.dataStore??store;
  const tenantId = input.tenantId;
  const platform = input.platform ?? 'youtube';
  const accountMode = input.mode === 'account' && looksLikeAccountUrl(input.accountUrl ?? '', platform);
  const accountUrl = accountMode ? String(input.accountUrl).trim() : '';
  const accountName = accountMode ? String(input.accountName || accountLabelFromUrl(accountUrl)) : '';
  // 对标账号采集时用账号名/URL 作为关键词占位，便于溯源与去重信息展示。
  const keyword = accountMode ? (accountName || accountUrl) : (input.keyword ?? DEFAULT_CRAWL_KEYWORDS);
  const limit = input.limit ?? 5;
  const dateFrom = input.dateFrom ?? '';
  const dateTo = input.dateTo ?? '';
  const crawlRule = accountMode ? '对标账号主页' : '关键词检索';

  const originalFive=input.discoveryContext?.weeklyOriginalAccountCollection;
  const replay=input.originalDatasetReplay?readVerifiedWeeklyOriginalDatasetReplay(input.originalDatasetReplay):null;
  if(originalFive){
    const expected=originalFive.accountUrl===accountUrl&&input.mode==='account'&&platform==='tiktok'&&input.limit===5&&
      originalFive.originalRunKey.startsWith('weekly-preproduction:')&&
      createHash('sha256').update(JSON.stringify(frozenWeeklyAccountFiveVideoActorInput(originalFive.accountUrl))).digest('hex')===originalFive.actorInputSha256;
    if(!expected)throw Error('weekly_preproduction_collection_original_input_changed');
    if(!replay||replay.tenantId!==tenantId||replay.originalRunKey!==originalFive.originalRunKey||replay.accountUrl!==accountUrl||
      input.discoveryContext?.queryRef!==accountUrl||input.discoveryContext.mode!=='account'||!input.newCandidatesOnly||!input.disableBackfill||input.paidPermit)
      throw Error('weekly_preproduction_collection_original_transport_required');
  }else if(replay){
    throw Error('weekly_original_dataset_replay_scope_mismatch');
  }

  // A weekly account run must not accidentally fall through the historical
  // synchronous Actor fallback, which loses the paid run ID on interruption.
  if (input.discoveryContext && input.mode === 'account' && platform === 'tiktok' && !input.paidPermit && !replay) {
    throw Error('weekly_preproduction_collection_paid_permit_required');
  }
  if (input.paidPermit && (!input.discoveryContext || !accountMode || platform !== 'tiktok')) {
    throw Error('apify_paid_permit_scope_mismatch');
  }
  if (platform === 'linkedin' && (!input.linkedInPaidPermit || !accountMode
    || !input.discoveryContext || input.discoveryContext.mode !== 'account'
    || input.discoveryContext.queryRef !== accountUrl)) {
    throw Error('linkedin_company_paid_collection_permit_required');
  }
  if (input.linkedInPaidPermit && platform !== 'linkedin') throw Error('linkedin_company_paid_collection_scope_mismatch');
  if (platform === 'linkedin') await assertConfiguredLinkedInCompanyPaidCollection({ tenantId,
    runId: input.discoveryContext!.runId, companyUrl: accountUrl,
    limit: Math.min(30, Math.max(1, Number(limit) || 5)), dateFrom, dateTo }, input.linkedInPaidPermit);

  if(!replay && platform !== 'linkedin')await purgeLegacyFakeVideos();
  const testTenant = replay || platform === 'linkedin' ? false : await isTestTenantId(tenantId);
  const target = Math.min(30, Math.max(1, Number(limit) || 5));
  let crawlerSource = accountMode ? `${platform}-account` : `${platform}-search`;
  let crawlerMessage = '';
  let crawlerTopUpMessage = '';
  let items: CrawledVideo[];
  // 账号主页采集与直链一样跳过关键词/封面/补齐等以搜索为前提的过滤。
  const directUrlInput = accountMode || isPlatformUrl(keyword, platform);
  try {
    // Approved discovery has a separately reserved daily item budget. Do not
    // turn one reserved candidate into five provider-fetched candidates.
    const safeLimit = input.newCandidatesOnly ? target : Math.min(120, Math.max(target * 5, target));
    if (replay) {
      items=replay.rows.map(row=>apifyTikTokItemToCrawledVideo(row,keyword)).filter((item):item is CrawledVideo=>Boolean(item));
      crawlerSource='apify-tiktok-original-dataset-journal';
    } else if (input.paidPermit) {
      items = await crawlTikTokWithPaidPermit(accountUrl, target, dateFrom, dateTo, input.paidPermit);
      crawlerSource = 'apify-tiktok-account';
      if (hasDateRange(dateFrom, dateTo)) items = filterDateRangeItems(items, dateFrom, dateTo);
    } else if (platform === 'linkedin') {
      const result = await runConfiguredLinkedInCompanyPaidCollection({ tenantId,
        runId: input.discoveryContext!.runId, companyUrl: accountUrl, limit: target,
        dateFrom, dateTo }, input.linkedInPaidPermit);
      items = result.videos;
      crawlerSource = 'apify-linkedin-company-posts';
    } else if (accountMode) {
      items = await crawlAccountHomepage(platform, accountUrl, Math.max(target, Math.min(safeLimit, 30)), dateFrom, dateTo, input.cloudFallback === true, input.newCandidatesOnly === true);
      if (hasDateRange(dateFrom, dateTo)) items = filterDateRangeItems(items, dateFrom, dateTo);
      if (items.some(item => item.source === 'apify')) crawlerSource = `apify-${platform}-account`;
    } else if (platform === 'youtube') {
      items = await crawlYouTubeSearch(keyword, safeLimit, dateFrom, dateTo);
    } else if (platform === 'facebook') {
      crawlerSource = /^https?:\/\/(?:www\.|m\.|mbasic\.)?facebook\.com\//i.test(keyword.trim()) ? 'facebook-url' : 'facebook-search';
      items = await crawlFacebook(keyword, safeLimit, dateFrom, dateTo, input.newCandidatesOnly === true);
    } else if (platform === 'tiktok') {
      crawlerSource = isPlatformUrl(keyword, 'tiktok') ? 'tiktok-url' : 'tiktok-search';
      items = await crawlTikTokWithApifyFallback(keyword, safeLimit, dateFrom, dateTo, input.newCandidatesOnly === true);
      if (items.some(item => item.source === 'apify')) crawlerSource = 'apify-tiktok';
    } else if (platform === 'instagram') {
      crawlerSource = isPlatformUrl(keyword, 'instagram') ? 'instagram-url' : 'instagram-search';
      items = await crawlInstagramWithApifyFallback(keyword, safeLimit, dateFrom, dateTo);
      if (items.some(item => item.source === 'apify')) crawlerSource = 'apify-instagram';
    } else {
      throw new Error(`${platform} adapter pending`);
    }
    const beforeShortFormFilter = items.length;
    items = items.filter(item => isDiscoveryVideoEligible(item));
    if (items.length === 0 && beforeShortFormFilter > 0) {
      throw new NoCrawlResultsError(platform === 'youtube'
        ? `候选 ${beforeShortFormFilter} 条均不符合硬规则：只采集 YouTube Shorts，且时长必须在 1–60 秒`
        : `候选 ${beforeShortFormFilter} 条均不符合硬规则：视频时长必须在 1–60 秒`);
    }
    if (!directUrlInput) {
      const beforeDateFilter = items.length;
      items = filterDateRangeItems(items, dateFrom, dateTo);
      if (items.length === 0 && hasDateRange(dateFrom, dateTo)) {
        throw new NoCrawlResultsError(`没有找到发布时间在 ${dateFrom || '不限'} 至 ${dateTo || '不限'} 内的公开视频（候选 ${beforeDateFilter} 条已过滤）`);
      }
    }
    if (!directUrlInput) {
      const beforeRealMediaFilter = items.length;
      items = filterRealMediaItems(items);
      if (items.length === 0) {
        throw new NoCrawlResultsError(`没有拿到带真实封面的公开视频（候选 ${beforeRealMediaFilter} 条已过滤）`);
      }
    }
    if (!directUrlInput) {
      const beforeFilter = items.length;
      items = filterKeywordRelevantItems(items, keyword);
      if (items.length === 0) {
        throw new NoCrawlResultsError(`没有找到与关键词「${keyword}」相关的公开视频（候选 ${beforeFilter} 条已过滤）`);
      }
    }
    if (!input.disableBackfill && !directUrlInput && items.length < target) {
      const beforeTopUp = items.length;
      items = await topUpCrawledItems({ platform, keyword, target, items, dateFrom, dateTo });
      const topUpCount = Math.max(0, items.length - beforeTopUp);
      if (topUpCount > 0) {
        crawlerTopUpMessage = `；过滤后补齐 ${topUpCount} 条`;
      }
    }
  } catch (e) {
    if (!(e instanceof NoCrawlResultsError)) throw e;
    crawlerMessage = e instanceof Error
      ? `${platform} 公开采集未找到可入库的真实视频：${e.message}`
      : `${platform} 公开采集未找到可入库的真实视频`;
    console.warn(`[videos] ${platform} crawl degraded:`, e);
    items = [];
  }

  let imported = 0;
  const refreshed = 0;
  let skipped = 0;
  let skippedExisting = 0;
  const records: unknown[] = [];
  const existingRecords: unknown[] = [];
  const seenKeys = new Set<string>();
  let skippedNearDuplicate = 0;
  let nearDuplicateUnchecked = 0;
  const knownSourceIdentities = new Set<string>();
  const knownThumbnailFingerprints: Awaited<ReturnType<typeof loadKnownVideoThumbnailFingerprints>> = [];
  const orderedItems = sortByHeat(items.map(normalizeCrawledVideo))
    .filter(item => item.platform === platform && isPlatformUrl(item.sourceUrl, platform))
    .filter(item => isDiscoveryVideoEligible(item))
    .filter(item => {
    const key = videoDedupeKey(item);
    if (seenKeys.has(key)) {
      skipped += 1;
      return false;
    }
    seenKeys.add(key);
    return true;
  });
  if (platform === 'youtube' && items.length > 0 && orderedItems.length === 0) {
    console.warn('[videos] YouTube candidates rejected before import', {
      candidates: items.length,
      sampleSourceUrl: items[0]?.sourceUrl || '',
      samplePlatform: items[0]?.platform || '',
    });
  }

  for (const item of orderedItems) {
    // Re-read under the existing database-backed lease: two source queries can
    // return the same picture under different URLs after both initially see an
    // empty inventory. The stable source-ID alone cannot arbitrate that race.
    const admissionLease = input.newCandidatesOnly ? await acquireDiscoveryAdmissionLease(tenantId,dataStore) : null;
    try {
      if (admissionLease) {
        knownSourceIdentities.clear();
        for (const known of await loadKnownVideoSourceIdentities(dataStore, COL, tenantId)) knownSourceIdentities.add(known);
        knownThumbnailFingerprints.splice(0, knownThumbnailFingerprints.length, ...await loadKnownVideoThumbnailFingerprints(dataStore, tenantId));
      }
    const identity = videoSourceIdentity(item.platform, item.sourceUrl);
    const videoUrlAccount = sourceAccountFromVideoUrl(item.platform,item.sourceUrl);
    const metadataAccount = sourceAccountFromProviderMetadata(item.platform,item.sourceAccountUrl || '');
    const homepageAccount = accountMode ? sourceAccountFromProviderMetadata(item.platform,accountUrl) : null;
    const resolvedAccount = videoUrlAccount ?? metadataAccount ?? homepageAccount;
    const sourceAccountEvidence = videoUrlAccount ? 'video_url' : metadataAccount ? 'provider_metadata' : homepageAccount ? 'account_homepage' : undefined;
    if (input.newCandidatesOnly && knownSourceIdentities.has(identity) && !replay) {
      skipped += 1;
      skippedExisting += 1;
      continue;
    }
    const existingByUrl = await dataStore.list(COL, {
      where: { tenantId, sourceUrl: item.sourceUrl },
      page: 1,
      perPage: 1,
    });
    const existingRecord = existingByUrl?.items[0];
    if (existingRecord) {
      if(replay){
        const analysis=parseJsonRecord<Record<string,unknown>>(existingRecord.aiAnalysis,{});
        const origins=Array.isArray(analysis.discoveryOrigins)?analysis.discoveryOrigins:[];
        const sameRun=origins.some(origin=>origin&&typeof origin==='object'&&
          (origin as Record<string,unknown>).runId===input.discoveryContext?.runId&&
          (origin as Record<string,unknown>).scopeId===input.discoveryContext?.scopeId&&
          (origin as Record<string,unknown>).scopeVersion===input.discoveryContext?.scopeVersion&&
          (origin as Record<string,unknown>).queryRef===accountUrl&&
          JSON.stringify((origin as Record<string,unknown>).weeklyOriginalAccountCollection)===JSON.stringify(originalFive));
        if(!sameRun){skipped++;skippedExisting++;continue;}
        existingRecords.push(existingRecord);
        knownSourceIdentities.add(identity);
        continue;
      }
      skipped += 1;
      skippedExisting += 1;
      if (input.newCandidatesOnly) { knownSourceIdentities.add(identity); continue; }
      const existingAnalysis = parseJsonRecord<Record<string, unknown>>(existingRecord.aiAnalysis, {});
      const refreshedRecord = {
        ...existingRecord,
        platform: item.platform,
        title: item.title,
        thumbnailUrl: item.thumbnailUrl,
        duration: item.duration,
        sourceUrl: item.sourceUrl,
        tags: JSON.stringify(item.tags.length > 0 ? item.tags : parseJsonRecord<string[]>(existingRecord.tags, [])),
        aiAnalysis: JSON.stringify({
          ...existingAnalysis,
          views: item.views || existingAnalysis.views,
          uploadedAt: item.uploadedAt || existingAnalysis.uploadedAt,
          dateEvidence: item.dateEvidence || existingAnalysis.dateEvidence,
          author: item.author || existingAnalysis.author || (accountMode ? accountName : undefined),
          keyword,
          crawlRule,
          sourceAccount: resolvedAccount ?? existingAnalysis.sourceAccount,
          sourceAccountName: resolvedAccount ? item.author || (accountMode ? accountName : existingAnalysis.sourceAccountName) : existingAnalysis.sourceAccountName,
          sourceAccountEvidence: resolvedAccount ? sourceAccountEvidence : existingAnalysis.sourceAccountEvidence,
          dateFrom,
          dateTo,
          discoveryOrigins: discoveryOrigins(existingAnalysis.discoveryOrigins, input.discoveryContext),
        }),
      };
      // 已有本地落盘缩略图时不要用新的临时签名链接覆盖
      const keepLocalThumb = String(existingRecord.thumbnailUrl || '').startsWith('/media/') && isSignedExpiringThumbnail(item.thumbnailUrl);
      await dataStore.update(COL, String(existingRecord.id), {
        contentFormat: 'video',
        thumbnailUrl: keepLocalThumb ? String(existingRecord.thumbnailUrl) : (item.thumbnailUrl || String(existingRecord.thumbnailUrl || '')),
        sourceUrl: item.sourceUrl || String(existingRecord.sourceUrl || ''),
        aiAnalysis: refreshedRecord.aiAnalysis,
      });
      if (!keepLocalThumb) {
        void persistThumbnailIfExpiring(String(existingRecord.id), item.thumbnailUrl).catch(() => {});
      }
      existingRecords.push(refreshedRecord);
      continue;
    }

    let thumbnailFingerprint: Awaited<ReturnType<typeof fingerprintVideoThumbnail>> | null = null;
    if (input.newCandidatesOnly && !replay && canFingerprintThumbnailUrl(item.platform,item.thumbnailUrl)) {
      const image = await fetchThumbnailBuffer(item.thumbnailUrl, 5_000, true);
      if (image) {
        try { thumbnailFingerprint = await fingerprintVideoThumbnail(image.buf); } catch { /* invalid image stays unverified */ }
      }
    }
    if (input.newCandidatesOnly && !thumbnailFingerprint) nearDuplicateUnchecked += 1;
    if (thumbnailFingerprint && knownThumbnailFingerprints.some(existing => likelySameVideoThumbnail(
      {fingerprint:thumbnailFingerprint!,title:item.title,duration:item.duration},existing))) {
      skipped += 1;
      skippedNearDuplicate += 1;
      continue;
    }

    // A stable row ID makes simultaneous approved collections of the same
    // platform video elect one winner even if both read an empty inventory.
    const newCandidateId = input.newCandidatesOnly ? discoveryVideoRecordId(tenantId,item.platform,item.sourceUrl) : null;
    if (admissionLease) await assertDurableOperationLease({dataStore,lease:admissionLease});
    let record: Record<string, unknown> | null;
    try { record = await dataStore.create<Record<string, unknown>>(COL, {
      ...(newCandidateId ? {id:newCandidateId} : {}),
      tenantId,
      contentFormat: 'video',
      platform: item.platform,
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
      videoFileId: '',
      duration: item.duration,
      sourceUrl: item.sourceUrl,
      tags: JSON.stringify(item.tags),
      aiAnalysis: JSON.stringify({
        source: crawlerSource,
        views: item.views,
        uploadedAt: item.uploadedAt,
        dateEvidence: item.dateEvidence,
        author: item.author || (accountMode ? accountName : undefined),
        gemini: metadataFallbackAnalysis(item),
        analysisSource: 'metadata-fallback',
        analysisQuality: 'metadata',
        keyword,
        crawlRule,
        sourceAccount: resolvedAccount ?? undefined,
        sourceAccountName: resolvedAccount ? item.author || (accountMode ? accountName : undefined) : undefined,
        sourceAccountEvidence,
        thumbnailFingerprint: thumbnailFingerprint ?? undefined,
        dateFrom,
        dateTo,
        importedAt: new Date().toISOString(),
        userVisible: testTenant ? false : undefined,
        discoveryOrigins: discoveryOrigins(undefined, input.discoveryContext),
      }),
      status: 'analyzed' as VideoStatus,
      crawledAt: new Date().toISOString(),
    }); } catch (cause) {
      if (!newCandidateId) throw cause;
      const winner = await dataStore.getById<Record<string, unknown>>(COL, newCandidateId);
      if (!winner || videoSourceIdentity(String(winner.platform || item.platform), String(winner.sourceUrl || '')) !== identity) throw cause;
      skipped += 1; skippedExisting += 1; knownSourceIdentities.add(identity); continue;
    }
    if (!record && newCandidateId) {
      const winner = await dataStore.getById<Record<string, unknown>>(COL, newCandidateId);
      if (!winner || videoSourceIdentity(String(winner.platform || item.platform), String(winner.sourceUrl || '')) !== identity) throw Error('discovery_video_identity_conflict');
      skipped += 1; skippedExisting += 1; knownSourceIdentities.add(identity); continue;
    }
    if (record) {
      imported += 1;
      records.push(record);
      if (input.newCandidatesOnly) knownSourceIdentities.add(identity);
      if (thumbnailFingerprint) knownThumbnailFingerprints.push({fingerprint:thumbnailFingerprint,title:item.title,duration:item.duration});
      if(!replay)void persistThumbnailIfExpiring(String((record as Record<string, unknown>).id), item.thumbnailUrl).catch(() => {});
    }
    if (imported >= target) break;
    } finally {
      if (admissionLease) await releaseDurableOperationLease({dataStore,lease:admissionLease});
    }
  }

  let resultRecords = [...records, ...existingRecords].slice(0, target);
  const returnedNew = Math.min(records.length, resultRecords.length);
  let returnedExisting = Math.max(0, resultRecords.length - returnedNew);
  let visibleNewCount = 0;
  const candidateIds = resultRecords.map(record => String((record as Record<string, unknown>).id));
  if (input.suppressAnalysisQueue) {
    // Keep the durable records and candidate ids, but do not race a maintenance
    // job that will immediately run a fresh exact analysis for every candidate.
    resultRecords = [];
    returnedExisting = 0;
  } else if (testTenant && input.deferAnalysis) {
    for (const record of resultRecords) {
      await queueTestTenantVideoLevelAnalysis(record as Record<string, unknown>);
    }
    // Do not expose metadata-only records as analysis-ready results.
    resultRecords = [];
    returnedExisting = 0;
  } else if (testTenant) {
    // A repeated keyword commonly finds URLs that were inserted by an earlier
    // run but whose video-level analysis did not finish.  They are still real
    // crawl candidates and must be resumed instead of being silently skipped.
    // analyzeFreshCrawledRecordsForTestTenant only returns records that pass the
    // strict video-level evidence gate, so failed/metadata-only rows stay hidden.
    resultRecords = await analyzeFreshCrawledRecordsForTestTenant(
      [...records, ...existingRecords].slice(0, target),
      target,
    );
    visibleNewCount = resultRecords.length;
    returnedExisting = 0;
    if (visibleNewCount < target && !input.disableBackfill) {
      scheduleTestTenantVideoBackfill({
        tenantId,
        platform,
        keyword,
        target: target - visibleNewCount,
        reason: 'crawl_result_visible_backfill',
        dateFrom,
        dateTo,
        forceCreate: true,
      });
    }
  } else if (resultRecords.length > 0 && !replay) {
    await enqueueCrawledRecordsForAnalysis(resultRecords);
  }

  const message = input.deferAnalysis && candidateIds.length > 0
    ? `已采集 ${candidateIds.length} 条真实候选（新增 ${imported} 条）；视频分析在后台继续，分析通过后才可作为参考。`
    : testTenant
    ? (crawlerMessage || (resultRecords.length === 0
      ? `采集完成：本次新增 ${imported} 条候选，跳过已入库 ${skippedExisting} 条；暂无新增视频级可用结果，后台继续按同关键词补位，失败/不可分析结果已隐藏并进入人工处理。`
      : resultRecords.length < target
        ? `采集完成：本次返回 ${resultRecords.length} 条新增视频级结果（新增候选 ${imported} 条，跳过已入库 ${skippedExisting} 条），未达到用户输入数量 ${target}；后台继续按同关键词补位。`
        : `采集完成：本次返回 ${resultRecords.length} 条新增视频级结果（新增候选 ${imported} 条，跳过已入库 ${skippedExisting} 条）${crawlerTopUpMessage}`))
    : crawlerMessage
      || (resultRecords.length === 0
        ? `有效去重后没有新增视频，返回库内已有匹配 ${returnedExisting} 条；请换关键词、放宽日期范围或降低数量。`
        : resultRecords.length < target
          ? `采集完成：返回 ${resultRecords.length} 条（新增 ${imported} 条，库内已有 ${returnedExisting} 条），未达到用户输入数量 ${target}；可换关键词或放宽日期范围。`
          : `采集完成：返回 ${resultRecords.length} 条（新增 ${imported} 条，库内已有 ${returnedExisting} 条）${crawlerTopUpMessage}${visibleNewCount > 0 ? `；已返回 ${visibleNewCount} 条视频级可用结果` : ''}`);

  return {
    outcome: candidateIds.length > 0 ? 'collected' : 'no_data',
    candidateIds,
    analysisPending: candidateIds.length > 0 && (input.deferAnalysis === true || (testTenant && resultRecords.length < candidateIds.length)),
    platform,
    keyword,
    imported,
    refreshed,
    skipped,
    skippedExisting,
    skippedNearDuplicate,
    nearDuplicateUnchecked,
    returnedExisting,
    requested: target,
    total: items.length,
    source: crawlerSource,
    message,
    items: resultRecords,
  };
}

async function analyzeFreshCrawledRecordsForTestTenant(records: unknown[], target: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const seenSourceUrls = new Set<string>();
  const configuredSyncAttempts = process.env.VIDEO_CRAWL_SYNC_URL_ANALYSIS_ATTEMPTS;
  const syncYouTubeAttempts = Math.max(0, Math.min(
    10,
    configuredSyncAttempts === undefined ? Math.min(target, 3) : Number(configuredSyncAttempts),
  ));
  let attemptedYouTube = 0;

  // Publish the whole real candidate batch as "analysis queued" before doing
  // synchronous work.  Otherwise candidate 2/3 stay as metadata-only rows
  // while candidate 1 downloads, so the user sees only one result even though
  // all three were retrieved and are scheduled for automatic analysis.
  for (const raw of records.slice(0, target)) {
    const record = raw as Record<string, unknown>;
    const id = String(record.id || '');
    const sourceUrl = String(record.sourceUrl || '').trim();
    const platform = (record.platform || inferPlatformFromUrl(sourceUrl)) as Platform;
    if (!id || !isPlatformUrl(sourceUrl, platform) || !hasRealThumbnail({ thumbnailUrl: String(record.thumbnailUrl || '') } as CrawledVideo)) continue;
    const latest = await store.getById<Record<string, unknown>>(COL, id);
    if (!latest || isPublicTestTenantVideo(latest) || !shouldQueueVideoAnalysis(latest)) continue;
    const analysis = videoAnalysisOf(latest);
    await store.update(COL, id, {
      status: 'pending' as VideoStatus,
      aiAnalysis: JSON.stringify({
        ...analysis,
        userVisible: false,
        downloadStatus: 'queued',
        videoFetchStatus: 'queued',
        geminiStatus: 'waiting_for_video',
        crawlerOpsStatus: 'queued',
        analysisQueuedAt: new Date().toISOString(),
      }),
    });
  }

  for (const raw of records) {
    const record = raw as Record<string, unknown>;
    const id = String(record.id || '');
    const sourceUrl = String(record.sourceUrl || '').trim();
    if (!id || !sourceUrl) continue;

    const platform = (record.platform || inferPlatformFromUrl(sourceUrl)) as Platform;
    if (platform === 'youtube' && attemptedYouTube < syncYouTubeAttempts) {
      attemptedYouTube += 1;
      try {
        await analyzeSourceVideoJob({
          record,
          sourceUrl,
          title: String(record.title || 'youtube-video'),
          platform,
          suppressVisibleBackfill: true,
        });
      } catch (e) {
        console.warn('[videos] test tenant crawl URL analysis failed:', e instanceof Error ? e.message : e);
      }
    } else {
      await queueTestTenantVideoLevelAnalysis(record);
    }

    const latest = await store.getById<Record<string, unknown>>(COL, id);
    if (!latest || !isPublicTestTenantVideo(latest)) continue;
    const latestSourceUrl = String(latest.sourceUrl || '').trim();
    if (latestSourceUrl && seenSourceUrls.has(latestSourceUrl)) continue;
    if (latestSourceUrl) seenSourceUrls.add(latestSourceUrl);
    out.push(publicVideoRecord(latest));
    if (out.length >= target) break;
  }

  return out;
}

export function shouldCreateTestTenantAnalysisJob(analysis: Record<string, unknown>, normallyQueueable: boolean): boolean {
  return normallyQueueable || !analysis.crawlerOpsTaskId;
}

async function queueTestTenantVideoLevelAnalysis(record: Record<string, unknown>): Promise<void> {
  const id = String(record.id || '');
  if (!id) return;
  const latest = await store.getById<Record<string, unknown>>(COL, id);
  if (!latest || isPublicTestTenantVideo(latest)) return;

  const sourceUrl = String(latest.sourceUrl || '').trim();
  if (!sourceUrl) return;
  const platform = (latest.platform || inferPlatformFromUrl(sourceUrl)) as Platform;
  const analysis = parseJsonRecord<Record<string, unknown>>(latest.aiAnalysis, {});
  // The batch preflight intentionally marks every candidate as queued before
  // individual jobs are created. A queued marker without a durable ops receipt
  // must continue into queueAnalyzeSource; otherwise Facebook/Instagram rows
  // remain metadata-only forever. A receipt means the job was already accepted.
  if (!shouldCreateTestTenantAnalysisJob(analysis, shouldQueueVideoAnalysis(latest))) return;
  await store.update(COL, id, {
    status: 'pending' as VideoStatus,
    aiAnalysis: JSON.stringify({
      ...analysis,
      userVisible: false,
      downloadStatus: 'queued',
      videoFetchStatus: 'queued',
      geminiStatus: 'waiting_for_video',
      analysisQueuedAt: new Date().toISOString(),
    }),
  });

  await queueAnalyzeSource(latest, {
    record: latest,
    sourceUrl,
    title: String(latest.title || `${platform}-video`),
    platform,
  });
}

// ─── POST /videos/download-material ─────────────────────────────────────────
// Body: { id?, sourceUrl?, title?, platform?, async? } → download remote video and add it to Studio materials.
videosRouter.post('/download-material', async (req, res) => {
  const { id, sourceUrl, title, platform, async } = req.body as {
    id?: string;
    sourceUrl?: string;
    title?: string;
    platform?: Platform;
    async?: boolean;
  };
  await handleDownloadMaterial(req, res, { id, sourceUrl, title, platform, async });
});

videosRouter.post('/:id/download-material', async (req, res) => {
  const { sourceUrl, title, platform, async } = req.body as { sourceUrl?: string; title?: string; platform?: Platform; async?: boolean };
  await handleDownloadMaterial(req, res, { id: req.params.id, sourceUrl, title, platform, async });
});

// ─── POST /videos/analyze-source ─────────────────────────────────────────────
// Body: { id?, sourceUrl?, title?, platform?, async? } → fetch a temporary low-res video, analyze with Gemini, then delete it.
videosRouter.post('/analyze-source', async (req, res) => {
  const { id, sourceUrl, title, platform, async } = req.body as {
    id?: string;
    sourceUrl?: string;
    title?: string;
    platform?: Platform;
    async?: boolean;
  };
  const scoped = (res.locals as AuthLocals).starter198SocialContext;
  await handleAnalyzeSource(req, res, scoped ? { id, async } : { id, sourceUrl, title, platform, async });
});

videosRouter.post('/:id/analyze-source', async (req, res) => {
  const { sourceUrl, title, platform, async } = req.body as { sourceUrl?: string; title?: string; platform?: Platform; async?: boolean };
  await handleAnalyzeSource(req, res, { id: req.params.id, sourceUrl, title, platform, async });
});

// Adopts business context for an existing canonical analysis only. No exact
// analysis, semantic model, collection, quota or production start occurs here.
videosRouter.post('/:id/context-assessment', async(req,res)=>{
 const {tenantId,userId}=res.locals as AuthLocals;
 try{const item=await createCandidateContextAssessment(store,tenantId,userId,req.params.id,req.body as CandidateContextInput,path.resolve(__dirname,'../../data/media'));res.json({ok:true,assessment:item,providerCalled:false,exactAnalysisReused:true});}
 catch(error){const code=error instanceof Error?error.message:'candidate_context_assessment_failed';res.status(code==='candidate_context_actor_forbidden'?403:409).json({error:code});}
});
videosRouter.post('/:id/context-assessment/:assessmentId/evaluate',async(req,res)=>{
 const {tenantId,userId}=res.locals as AuthLocals;
 try{const taskId=typeof (req.body as Record<string,unknown>)?.taskId==='string'?String((req.body as Record<string,unknown>).taskId).trim():'';const contextRow=await store.getById<Record<string,unknown>>('social_candidate_context_assessments',req.params.assessmentId),context=contextRow?.payload as import('../socialDiscovery/candidateContextAssessment.js').CandidateContextAssessment|undefined;
  const result=await assessCandidateSemantics(store,tenantId,userId,req.params.id,req.params.assessmentId,taskId&&context?{paidCall:async()=>resolveCandidateSemanticPaidCall({store,tenantId,taskId,candidateId:req.params.id,context})}:{});res.status(result.state==='blocked'?409:result.state==='unknown'?202:200).json(result);}
 catch(error){const code=error instanceof Error?error.message:'candidate_semantic_failed';res.status(code==='candidate_semantic_actor_forbidden'?403:409).json({error:code});}
});

// ─── Internal crawler ops queue ──────────────────────────────────────────────
videosRouter.get('/ops/queue', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const visibleRecordIds = await crawlerOpsRecordIdsForTenant(tenantId);
  res.json({ items: filterCrawlerOpsTasksForRecordIds(loadCrawlerOpsTasks(), visibleRecordIds).filter(task => task.status === 'queued' || task.status === 'pushed' || task.status === 'processing') });
});

videosRouter.get('/ops/stats', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const visibleRecordIds = await crawlerOpsRecordIdsForTenant(tenantId);
  res.json(crawlerOpsStats(tenantId, visibleRecordIds));
});

videosRouter.post('/ops/run-once', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const result = await runCrawlerOpsWorkerOnce({ tenantId });
  res.json(result);
});

videosRouter.post('/ops/:taskId/resolve', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const { taskId } = req.params;
  const { videoBase64, mimeType = 'video/mp4', error } = req.body as {
    videoBase64?: string;
    mimeType?: string;
    error?: string;
  };
  const tasks = loadCrawlerOpsTasks();
  const task = tasks.find(item => item.id === taskId);
  if (!task) {
    res.status(404).json({ error: 'Crawler ops task not found' });
    return;
  }
  const record = await store.getById<Record<string, unknown>>(COL, task.recordId);
  if (!record || String(record.tenantId || '') !== tenantId || (task.tenantId && task.tenantId !== tenantId)) {
    // Deliberately use 404 so task IDs cannot be used to probe another tenant.
    res.status(404).json({ error: 'Crawler ops task not found' });
    return;
  }
  if (error) {
    persistCrawlerOpsTasks(tasks.map(item => item.id === taskId ? { ...item, status: 'failed', reason: error, updatedAt: new Date().toISOString() } : item));
    res.json({ ok: true, status: 'failed' });
    return;
  }
  if (!videoBase64) {
    res.status(400).json({ error: 'videoBase64 is required to resolve this task' });
    return;
  }
  try {
    await analyzeOpsVideo(task, videoBase64, mimeType);
    persistCrawlerOpsTasks(tasks.map(item => item.id === taskId ? { ...item, status: 'resolved', updatedAt: new Date().toISOString() } : item));
    res.json({ ok: true, status: 'resolved' });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : 'Crawler ops resolve failed' });
  }
});

// ─── POST /videos/ingest ──────────────────────────────────────────────────────
/** A user supplied benchmark is reference evidence only. The request body is
 * streamed MP4 bytes, avoiding the smaller JSON and legacy base64 limits. */
videosRouter.post('/import-reference-file', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  if (!/^video\/mp4(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    res.status(415).json({ error: 'Only video/mp4 is supported' }); return;
  }
  const declaredSize = Number(req.headers['content-length'] || 0);
  if (declaredSize > REFERENCE_UPLOAD_MAX_BYTES) {
    res.status(413).json({ error: 'Video exceeds 32 MiB limit' }); return;
  }
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const incomingPath = path.join(ANALYSIS_DIR, `reference-import-${randomUUID()}.mp4`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    const fd = fs.openSync(incomingPath, 'wx');
    try {
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > REFERENCE_UPLOAD_MAX_BYTES) throw new Error('reference_upload_too_large');
        hash.update(bytes);
        fs.writeSync(fd, bytes);
      }
    } finally { fs.closeSync(fd); }
    if (size < 1024) throw new Error('reference_upload_empty');
    const header = Buffer.alloc(12);
    const headerFd = fs.openSync(incomingPath, 'r');
    try { fs.readSync(headerFd, header, 0, header.length, 0); } finally { fs.closeSync(headerFd); }
    if (header.toString('ascii', 4, 8) !== 'ftyp') throw new Error('reference_upload_invalid_mp4');
    const duration = await referenceVideoDuration(incomingPath);
    const sha256 = hash.digest('hex');
    const result = await referenceImportRegistry.run(`${tenantId}:${sha256}`, async () => {
      const existing = await findTenantReferenceByHash(tenantId, sha256);
      if (existing) {
        const recovered = await recoverExistingReferenceImport({
          record: existing,
          tenantId,
          incomingPath,
          duration,
        });
        return { ...recovered, deduplicated: true };
      }
      const title = String(req.query.title || '本地参考视频').trim().slice(0, 160) || '本地参考视频';
      const platform = req.query.platform === 'instagram' || req.query.platform === 'facebook' || req.query.platform === 'youtube'
        ? req.query.platform : 'tiktok';
      const sourceUrl = String(req.query.sourceUrl || '').trim().slice(0, 1000);
      const now = new Date().toISOString();
      const initialAnalysis = {
        usage: 'reference_only', mayAnalyze: true, mayUseInProduction: false,
        contentSha256: sha256, originalBytes: size, requestedAnalysisMode: 'exact',
        analysisMode: 'exact', analysisRunId: randomUUID(), analysisRunMode: 'exact',
        analysisQueueKind: 'stored_video', analysisQueueState: 'queued',
        geminiStatus: 'queued', downloadStatus: 'uploaded', videoFetchStatus: 'manual_upload',
        analysisQuality: 'pending', userVisible: true, importedAt: now,
      };
      const record = await store.create(COL, {
        tenantId, contentFormat: 'video', platform, title, sourceUrl,
        thumbnailUrl: '', videoFileId: '', duration, views: '', tags: '[]',
        status: 'pending' as VideoStatus, crawledAt: now,
        aiAnalysis: JSON.stringify(initialAnalysis),
      });
      if (!record) throw new Error('reference_record_create_failed');
      const destination = path.join(tenantAssetDir(MEDIA_DIR, tenantId), 'reference-videos', `${record.id}.mp4`);
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(incomingPath, destination);
        const videoFileId = path.posix.join('tenants', tenantId, 'reference-videos', `${record.id}.mp4`);
        await store.update(COL, record.id, {
          videoFileId,
          thumbnailUrl: `/api/overseas/videos/${record.id}/thumbnail`,
        });
        clearTenantVisibleListCache();
        if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(record.id);
        return { id: record.id, deduplicated: false, analysisQueued: true };
      } catch (error) {
        await store.update(COL, record.id, { status: 'failed', aiAnalysis: JSON.stringify({ ...initialAnalysis, geminiStatus: 'analysis_retryable', analysisQuality: 'pending', analysisError: compactVideoPipelineError(error) }) });
        throw error;
      }
    }) as { id: string; deduplicated: boolean; analysisQueued: boolean };
    res.status(result.deduplicated ? 200 : 202).json({ ...result, status: result.analysisQueued ? 'pending' : 'existing', analysisUrl: `/api/overseas/videos/${result.id}`, sourceVideoRef: `/api/overseas/videos/${result.id}/media` });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'reference_upload_failed';
    res.status(message === 'reference_upload_too_large' ? 413
      : ['reference_upload_empty', 'reference_upload_invalid_mp4', 'reference_upload_invalid_video'].includes(message) ? 400 : 500)
      .json({ error: message });
  } finally {
    try { fs.unlinkSync(incomingPath); } catch { /* already removed */ }
  }
});

async function referenceVideoDuration(filePath: string): Promise<number> {
  if (!ffmpegBin) throw new Error('ffmpeg_unavailable');
  let output = '';
  try {
    const result = await execFileAsync(ffmpegBin, ['-hide_banner', '-i', filePath, '-frames:v', '1', '-f', 'null', '-'], { timeout: 30_000 });
    output = result.stderr;
  } catch (error) {
    output = String((error as { stderr?: string }).stderr || '');
  }
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match || !/Video:\s/.test(output)) throw new Error('reference_upload_invalid_video');
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('reference_upload_invalid_video');
  return duration;
}

async function findTenantReferenceByHash(tenantId: string, sha256: string): Promise<Record<string, unknown> | null> {
  let page = 1;
  let totalPages = 1;
  do {
    const result = await store.list<Record<string, unknown>>(COL, { where: { tenantId }, page, perPage: 200 });
    const found = result.items.find(record => {
      const analysis = videoAnalysisOf(record);
      return analysis.contentSha256 === sha256 && analysis.usage === 'reference_only' && Boolean(record.videoFileId);
    });
    if (found) return found;
    totalPages = result.totalPages;
    page += 1;
  } while (page <= totalPages);
  return null;
}

export function shouldResumeReferenceAnalysis(analysis: Record<string, unknown>, duration = 0): boolean {
  if (hasCompletedExactVideoEvidence(analysis)) {
    const gemini = analysis.gemini && typeof analysis.gemini === 'object'
      ? analysis.gemini as VideoAiAnalysis
      : parseJsonRecord<VideoAiAnalysis>(analysis.gemini, {} as VideoAiAnalysis);
    if (exactVideoClassificationQualityError(gemini)) return true;
    if (duration <= 0) return false;
    return Boolean(analysisTimelineQualityError(gemini, duration, 'exact'));
  }
  const status = String(analysis.geminiStatus || '');
  const activelyRunning = analysis.requestedAnalysisMode === 'exact'
    && ['queued', 'waiting_for_video', 'analyzing'].includes(status)
    && !analysis.analysisError;
  return !activelyRunning;
}

export function canRepairStoredExactClassification(
  record: Record<string, unknown>,
  analysis: Record<string, unknown>,
): boolean {
  const gemini = analysis.gemini && typeof analysis.gemini === 'object'
    ? analysis.gemini as VideoAiAnalysis
    : parseJsonRecord<VideoAiAnalysis>(analysis.gemini, {} as VideoAiAnalysis);
  if (!['video', 'video_review_required'].includes(String(analysis.analysisQuality || ''))
    || !canPromoteExistingAnalysisToExact(gemini, Number(record.duration || 0))) return false;
  const admission = productionReferenceAdmission(benchmarkAnalysisForRecord(record, analysis));
  return !admission.ready && admission.blockers.length > 0 && admission.blockers.every(blocker => (
    /镜头类型未确认|画面、用途或分类依据待复核/.test(blocker)
  ));
}

async function recoverExistingReferenceImport(input: {
  record: Record<string, unknown>;
  tenantId: string;
  incomingPath: string;
  duration: number;
}): Promise<{ id: string; analysisQueued: boolean }> {
  const recordId = String(input.record.id || '');
  if (!recordId) throw new Error('reference_record_invalid');
  const now = new Date().toISOString();
  const previous = videoAnalysisOf(input.record);
  const canonicalFileId = path.posix.join('tenants', input.tenantId, 'reference-videos', `${recordId}.mp4`);
  const canonicalPath = path.join(tenantAssetDir(MEDIA_DIR, input.tenantId), 'reference-videos', `${recordId}.mp4`);
  const savedPath = localReferenceVideoPath(String(input.record.videoFileId || ''), input.tenantId);
  if (!fs.existsSync(canonicalPath)) {
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.copyFileSync(savedPath && fs.existsSync(savedPath) ? savedPath : input.incomingPath, canonicalPath);
  }

  const commonAnalysis = {
    ...previous,
    usage: 'reference_only',
    mayAnalyze: true,
    mayUseInProduction: false,
    userVisible: true,
    downloadStatus: previous.downloadStatus || 'uploaded',
    videoFetchStatus: previous.videoFetchStatus || 'manual_upload',
  };
  const shouldResume = shouldResumeReferenceAnalysis(commonAnalysis, Number(input.record.duration || input.duration));
  const analysisRunId = shouldResume ? randomUUID() : String(previous.analysisRunId || randomUUID());
  const nextAnalysis = shouldResume ? {
    ...commonAnalysis,
    requestedAnalysisMode: 'exact',
    analysisMode: 'exact',
    analysisRunId,
    analysisRunMode: 'exact',
    geminiStatus: 'queued',
    downloadStatus: 'uploaded',
    videoFetchStatus: 'manual_upload',
    analysisQuality: 'pending',
    analysisError: undefined,
    downloadError: undefined,
    videoLevelFailureStatus: undefined,
    analysisRetryable: undefined,
    analysisFailureKind: undefined,
    analysisQueuedAt: now,
    reanalyzeQueuedAt: now,
    analysisQueueKind: 'stored_video',
    analysisQueueState: 'queued',
  } : commonAnalysis;
  await store.update(COL, recordId, {
    tenantId: input.tenantId,
    contentFormat: 'video',
    videoFileId: canonicalFileId,
    thumbnailUrl: `/api/overseas/videos/${recordId}/thumbnail`,
    duration: Number(input.record.duration || input.duration),
    status: shouldResume ? 'pending' as VideoStatus : input.record.status,
    aiAnalysis: JSON.stringify(nextAnalysis),
  });
  clearTenantVisibleListCache();

  if (shouldResume) {
    if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(recordId);
  }
  return { id: recordId, analysisQueued: shouldResume };
}

// ─── POST /videos/ingest ──────────────────────────────────────────────────────
// Body: { platform, title?, tags?, sourceUrl?, videoBase64?, mimeType? }
videosRouter.post('/ingest', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const { platform, title, tags, sourceUrl, videoBase64, mimeType } = req.body as {
    platform?: Platform;
    title?: string;
    tags?: string[];
    sourceUrl?: string;
    videoBase64?: string;
    mimeType?: string;
  };

  if (!platform) {
    res.status(400).json({ error: 'platform is required' });
    return;
  }

  // Create the record first; the video blob (if any) attaches to it.
  const record = await store.create(COL, {
    tenantId,
    contentFormat: 'video',
    platform: platform ?? 'tiktok',
    title: title ?? '',
    thumbnailUrl: '',
    videoFileId: '',
    duration: 0,
    sourceUrl: sourceUrl ?? '',
    tags: JSON.stringify(tags ?? []),
    aiAnalysis: JSON.stringify({}),
    status: 'pending' as VideoStatus,
    crawledAt: new Date().toISOString(),
  });

  if (!record) {
    res.status(500).json({ error: 'Failed to create video record' });
    return;
  }

  // Attach the video to the PB record's file field (PB disk storage, no S3).
  let filename = '';
  if (videoBase64) {
    const buf = Buffer.from(videoBase64.replace(/^data:[^,]+,/, ''), 'base64');
    const ext = (mimeType ?? 'video/mp4').split('/')[1] ?? 'mp4';
    const previewBuf = await compressVideoBufferForPocketBase(buf, ext);
    filename = await uploadCrawlerCosObject(record.id, 'video', previewBuf, 'video/mp4');
    if (!filename) {
      await store.update(COL, record.id, { status: 'failed' });
      res.status(500).json({ error: 'Video upload failed' });
      return;
    }
    const analysisRunId = randomUUID();
    await store.update(COL, record.id, {
      videoFileId: filename,
      aiAnalysis: JSON.stringify({
        videoStorage: 'cos', videoObjectKey: filename,
        requestedAnalysisMode: 'exact', analysisRunId, analysisRunMode: 'exact',
        analysisQueueKind: 'stored_video', analysisQueueState: 'queued',
        analysisQueuedAt: new Date().toISOString(), geminiStatus: 'queued',
      }),
    });
    if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(record.id);
  } else if (/^https?:\/\//i.test(String(sourceUrl || ''))) {
    const analysisRunId = randomUUID();
    const queuedRecord = {
      ...record,
      sourceUrl,
      aiAnalysis: JSON.stringify({ requestedAnalysisMode: 'exact', analysisRunId, analysisRunMode: 'exact' }),
    };
    await store.update(COL, record.id, { aiAnalysis: queuedRecord.aiAnalysis });
    await queueAnalyzeSource(queuedRecord);
  } else {
    await store.update(COL, record.id, { status: 'failed' as VideoStatus });
  }

  res.status(201).json({ id: record.id, status: 'pending' });
});

const videoTenantListing = createVideoTenantListing({
  store,
  collection: COL,
  isTestTenantId,
});
const { clearTenantVisibleListCache } = videoTenantListing;


registerVideoListingRoutes(videosRouter, {
  listing: videoTenantListing,
  tenantAnalysisQueuePositions,
  withSignedThumbnail,
});

videosRouter.post('/:id/reanalyze-image', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || recordContentFormat(record) !== 'image') { res.status(404).json({ error: 'Image post not found' }); return; }
  if (record.tenantId !== tenantId && !await requireAdminUser(req)) { res.status(404).json({ error: 'Image post not found' }); return; }
  if (['queued', 'processing', 'unknown'].includes(String(videoAnalysisOf(record).imageAnalysisQueueState || ''))) {
    res.status(409).json({ ok: false, error: 'image_post_queue_requires_reconciliation' });
    return;
  }
  try {
    const output = await reanalyzeStoredImagePost({
      store, collection: COL, tenantId: String(record.tenantId), record, analyze: analyzeImagePostBestEffort,
    });
    res.status(output.status === 'analyzed' ? 200 : 502).json({ ok: output.status === 'analyzed', analysis: output.analysis, error: output.error });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'image_post_analysis_unknown';
    console.error('[videos] image post reanalysis did not complete:', code);
    const publicCode = [
      'image_post_analysis_attempt_persistence_failed', 'image_post_analysis_result_persistence_failed',
      'image_post_analysis_superseded', 'image_post_analysis_source_changed',
      'image_post_record_disappeared_after_analysis',
    ].includes(code) ? code : 'image_post_analysis_unknown';
    res.status(['image_post_analysis_superseded', 'image_post_analysis_source_changed'].includes(publicCode) ? 409 : 503)
      .json({ ok: false, error: publicCode });
  }
});

// ─── GET /videos/:id ──────────────────────────────────────────────────────────

// PATCH /videos/:id - tenant-owned crawl metadata only
videosRouter.patch('/:id', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const title = String(req.body?.title ?? '').trim().slice(0, 160);
  if (!title) { res.status(400).json({ error: 'Title is required' }); return; }
  const tags = Array.isArray(req.body?.tags)
    ? req.body.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean).slice(0, 20)
    : [];
  await store.update(COL, req.params.id, {
    title,
    tags: JSON.stringify(tags.map((tag: string) => tag.slice(0, 40))),
    updatedAt: new Date().toISOString(),
  });
  const updated = await store.getById<Record<string, unknown>>(COL, req.params.id);
  res.json({ ...publicVideoRecord(updated || record), canManage: true });
});

// DELETE /videos/:id - tenant-owned crawl records only
videosRouter.delete('/:id', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  await store.delete(COL, req.params.id);
  res.json({ ok: true });
});

/** Editor review is versioned separately from model output. Editing it never
 * promotes the source video analysis or authorizes production execution. */
videosRouter.get('/:id/shot-review', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(loadReferenceShotReview(record));
});

videosRouter.put('/:id/shot-review', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const updated = updateReferenceShotReview(record, req.body || {});
    await store.update(COL, req.params.id, { referenceShotReview: JSON.stringify(updated), updatedAt: new Date().toISOString() });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid_review';
    res.status(message === 'review_version_conflict' ? 409 : 400).json({ error: message });
  }
});

/** Re-extract a reviewed physical shot from the original video. The derived
 * clip and frame are tied to source hash, analysis run, shot ID and range. */
videosRouter.post('/:id/shot-review/:shotId/materialize', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  if (!ffmpegBin) { res.status(503).json({ error: 'ffmpeg_unavailable' }); return; }
  const review = loadReferenceShotReview(record);
  const shot = review.shots.find(item => item.shotId === req.params.shotId && item.reviewStatus !== 'discarded');
  if (!shot || !/^[A-Za-z0-9_-]{1,80}$/.test(shot.shotId)) { res.status(404).json({ error: 'review_shot_not_found' }); return; }
  if (String(req.body?.expectedVersion || '') !== review.version) { res.status(409).json({ error: 'review_version_conflict' }); return; }
  const key = reviewShotMaterialFingerprint(record, shot);
  const temporary = path.join(ANALYSIS_DIR, `review-${randomUUID()}`);
  const inputPath = `${temporary}-input.mp4`;
  const clipPath = `${temporary}-clip.mp4`;
  const framePath = `${temporary}-first-frame.jpg`;
  try {
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    const local = localReferenceVideoPath(String(record.videoFileId || ''), tenantId);
    let source = local && fs.existsSync(local) ? local : '';
    if (!source) {
      const media = analysis.videoObjectKey ? await objectStorageDownload(String(analysis.videoObjectKey))
        : record.videoFileId ? await fetchFile(COL, req.params.id, String(record.videoFileId)) : null;
      if (!media || media.buf.length > 100 * 1024 * 1024) { res.status(404).json({ error: 'source_video_unavailable' }); return; }
      fs.writeFileSync(inputPath, media.buf); source = inputPath;
    }
    await execFileAsync(ffmpegBin, ['-hide_banner','-loglevel','error','-ss',String(shot.start),'-i',source,
      '-t',String(shot.end-shot.start),'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','24','-c:a','aac','-movflags','+faststart','-y',clipPath],{timeout:90_000});
    await execFileAsync(ffmpegBin, ['-hide_banner','-loglevel','error','-ss',String(shot.start+Math.min(.04,(shot.end-shot.start)/4)),'-i',source,
      '-frames:v','1','-q:v','3','-y',framePath],{timeout:30_000});
    if (objectStorageEnabled()) {
      await uploadCrawlerCosObject(req.params.id, `review-${key}-clip`, fs.readFileSync(clipPath), 'video/mp4');
      await uploadCrawlerCosObject(req.params.id, `review-${key}-first-frame`, fs.readFileSync(framePath), 'image/jpeg');
    } else {
      const dir = path.join(tenantAssetDir(MEDIA_DIR, tenantId), 'review-shots', req.params.id);
      fs.mkdirSync(dir,{recursive:true});
      fs.copyFileSync(clipPath,path.join(dir,`${key}.mp4`));
      fs.copyFileSync(framePath,path.join(dir,`${key}.jpg`));
    }
    const updated = attachReviewShotMaterials(record,shot.shotId,review.version);
    await store.update(COL,req.params.id,{referenceShotReview:JSON.stringify(updated),updatedAt:new Date().toISOString()});
    res.json(updated);
  } catch (error) {
    console.warn('[videos] review shot extraction failed:',error instanceof Error ? error.message : error);
    res.status(500).json({error:'review_shot_extraction_failed'});
  } finally {
    for (const file of [inputPath,clipPath,framePath]) try { fs.unlinkSync(file); } catch {}
  }
});

videosRouter.get('/:id/shot-review/:shotId/:kind', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  const review = loadReferenceShotReview(record);
  const shot = review.shots.find(item => item.shotId === req.params.shotId && item.reviewStatus !== 'discarded');
  const kind = req.params.kind;
  if (!shot || !['clip','first-frame'].includes(kind)) { res.status(404).json({ error: 'review_material_not_found' }); return; }
  const key = reviewShotMaterialFingerprint(record,shot);
  const expected = `/api/overseas/videos/${encodeURIComponent(req.params.id)}/shot-review/${encodeURIComponent(shot.shotId)}/${kind}?key=${key}`;
  if (req.query.key !== key || !shot.evidenceRefs.includes(expected)) { res.status(404).json({ error: 'review_material_not_found' }); return; }
  if (objectStorageEnabled()) {
    const objectKey = crawlerCosKey(record,`review-${key}-${kind}`,kind === 'clip' ? 'mp4' : 'jpg');
    if (!await streamCrawlerCosObject(res,objectKey,kind === 'clip' ? req.headers.range : undefined)) res.status(404).json({error:'review_material_not_found'});
    return;
  }
  const file = path.join(tenantAssetDir(MEDIA_DIR,tenantId),'review-shots',req.params.id,`${key}.${kind === 'clip' ? 'mp4' : 'jpg'}`);
  if (!fs.existsSync(file)) { res.status(404).json({error:'review_material_not_found'}); return; }
  res.setHeader('Cache-Control','private, max-age=3600'); res.sendFile(file);
});

/** Read-only Director -> Content review packet. A failed exact analysis remains
 * available for planning, while its productionExecutionAllowed gate stays false. */
const referenceReviewReadHandlers=createReferenceReviewReadHandlers({store,isTestTenantId,isPublicTestTenantVideo,isVisibleVideoPipelineRecord,publicVideoRecord,presenter:async tenantId=>{
 const defaults=await store.list<{payload?:{presenters?:Array<Record<string,unknown>>}}>('studio_production_defaults',{where:{tenant_id:tenantId},perPage:2});
 return defaults.totalItems===1?resolveReferenceSalesPresenter(defaults.items):null;
}});
videosRouter.get('/:id/review-handoff',referenceReviewReadHandlers.handoff);

/** Exact transcript corrections are a reviewer's assertion about the original
 * audio, version-bound to this upload. They do not change analysisQuality. */
videosRouter.get('/:id/verified-speech', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const analysisRunId = String(analysis.analysisRunId || '');
  const sourceSha256 = String(analysis.contentSha256 || '');
  const saved = currentVerifiedSpeech(parseJsonRecord(record.referenceVerifiedSpeech, null), analysisRunId, sourceSha256);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ analysisRunId, sourceSha256, duration: Number(record.duration || 0),
    status: verifiedSpeechStatus(saved),
    coverageConfirmed: saved?.coverageConfirmed || false, lines: saved?.lines || [], reviewerId: saved?.reviewerId || null,
    verifiedAt: saved?.verifiedAt || null });
});

videosRouter.put('/:id/verified-speech', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const analysisRunId = String(analysis.analysisRunId || '');
  const sourceSha256 = String(analysis.contentSha256 || '');
  if (!analysisRunId || !sourceSha256 || req.body?.analysisRunId !== analysisRunId || req.body?.sourceSha256 !== sourceSha256) {
    res.status(409).json({ error: '视频或分析版本已变化，请重新加载后校时' }); return;
  }
  let lines;
  try { lines = validateVerifiedSpeechLines(req.body?.lines, Number(record.duration || 0)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '逐句口播无效' }); return; }
  const verifiedAt = new Date().toISOString();
  const coverageConfirmed = req.body?.coverageConfirmed === true;
  const saved: VerifiedReferenceSpeech = { schemaVersion: 1, analysisRunId, sourceSha256, lines, coverageConfirmed, reviewerId: userId, verifiedAt };
  await store.update(COL, req.params.id, { referenceVerifiedSpeech: JSON.stringify(saved) });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ analysisRunId, sourceSha256, duration: Number(record.duration || 0),
    status: verifiedSpeechStatus(saved), coverageConfirmed, lines, reviewerId: userId, verifiedAt });
});

/** Poll an existing Qwen task with confirmed=false. A new paid submission
 * requires confirmed=true and still passes service feature flag and budget. */
const salesReviewRunning = new Map<string, Promise<unknown>>();
videosRouter.post('/:id/sales-presenter-review', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  const analysis = parseJsonRecord<Record<string, any>>(record.aiAnalysis, {});
  const shots = (analysis.gemini?.scriptDetails15s || analysis.scriptDetails15s) as SalesShot[];
  if (!Array.isArray(shots) || !shots.length || shots.length > 60 || !analysis.contentSha256) { res.status(422).json({ error: '销售识别需要完整原片分镜及视频指纹，最多支持60个分镜' }); return; }
  const key = createHash('sha256').update(salesReviewKey(String(analysis.contentSha256), shots)).digest('hex');
  const previous = analysis.salesPresenterReview;
  if (previous?.key === key && previous.submitted !== false) {
    if (previous.state === 'completed') { res.json({ ok: true, cached: true, ...previous, rows: previous.rows.map((row: any) => ({ ...row, sourceVisual: shots[row.index]?.visual || '' })) }); return; }
    res.status(409).json({ error: previous.error || '该销售识别请求未完成，请核对原任务，未再次提交付费识别' }); return;
  }
  try { assertSalesPresenterQwenConfigured(); } catch { res.status(503).json({ error: '销售识别服务未配置千问凭证，未提交模型请求' }); return; }
  const filename = String(record.videoFileId || '');
  const videoPath = localReferenceVideoPath(filename, tenantId);
  if (!videoPath || !fs.existsSync(videoPath) || !ffmpegBin) { res.status(422).json({ error: '原片文件不可用，未提交销售识别' }); return; }
  const lock = `${tenantId}:${record.id}:${key}`;
  let pending = salesReviewRunning.get(lock);
  if (!pending) {
    pending = durableAnalysisRecords.run(`sales:${lock}`, async () => {
      const freshRecord = await store.getById<Record<string, unknown>>(COL, req.params.id);
      const freshAnalysis = parseJsonRecord<Record<string, any>>(freshRecord?.aiAnalysis, {});
      if (freshAnalysis.salesPresenterReview?.key === key && freshAnalysis.salesPresenterReview.submitted !== false) {
        if (freshAnalysis.salesPresenterReview.state === 'completed') return freshAnalysis.salesPresenterReview;
        throw new Error('销售识别尚未确认完成，未重复提交付费请求');
      }
      fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
      const dir = fs.mkdtempSync(path.join(ANALYSIS_DIR, 'sales-review-'));
      try {
        const probedDuration = await probeDuration(videoPath!);
        const videoDuration = Math.min(probedDuration, Number(record.duration) > 0 ? Number(record.duration) : probedDuration - .5);
        if (!Number.isFinite(videoDuration) || videoDuration <= 0) throw new Error('原片时长不可读取');
        const frames = [];
        for (let index = 0; index < shots.length; index++) {
          const range = parseAnalysisTimeRange(shots[index].time);
          if (!range || range.end <= range.start || range.start >= videoDuration) throw new Error('原片分镜时间无效');
          const clipEnd = Math.min(range.end, videoDuration - .05);
          const images: string[] = [];
          for (const fraction of [.55, .85]) {
            const target = path.join(dir, `${index}-${fraction}.jpg`);
            await execFileAsync(ffmpegBin!, ['-hide_banner', '-loglevel', 'error', '-ss', String(range.start + (clipEnd-range.start)*fraction), '-i', videoPath!, '-frames:v', '1', '-vf', 'scale=384:-2', '-q:v', '5', '-y', target], { timeout: 15000 });
            images.push(fs.readFileSync(target).toString('base64'));
          }
          frames.push({ index, images, dialogue: shots[index].dialogue || '', visual: shots[index].visual || '' });
        }
        // Persist before paid submission. Unknown/failure never silently retries.
        const latest = await store.getById<Record<string, unknown>>(COL, req.params.id);
        const before = parseJsonRecord<Record<string, any>>(latest?.aiAnalysis, {});
        if (createHash('sha256').update(salesReviewKey(String(before.contentSha256), before.gemini?.scriptDetails15s || before.scriptDetails15s || [])).digest('hex') !== key) throw new Error('原片分析已变化，请重新打开草稿');
        await store.update(COL, req.params.id, { aiAnalysis: JSON.stringify({ ...before, salesPresenterReview: { key, version: SALES_REVIEW_VERSION, state: 'running', provider: 'qwen', submitted: true, startedAt: new Date().toISOString() } }) });
        const recognition = await reviewSalesPresenterFramesWithQwen({ frames });
        const rows = validateSalesReview(recognition, shots.length);
        const current = await store.getById<Record<string, unknown>>(COL, req.params.id);
        const saved = parseJsonRecord<Record<string, any>>(current?.aiAnalysis, {});
        if (saved.salesPresenterReview?.key !== key || createHash('sha256').update(salesReviewKey(String(saved.contentSha256), saved.gemini?.scriptDetails15s || saved.scriptDetails15s || [])).digest('hex') !== key) throw new Error('原片分析已变化，识别结果未覆盖新分析');
        const review = { key, version: SALES_REVIEW_VERSION, provider: recognition.provider, model: recognition.model, usage: recognition.usage, state: 'completed', rows: rows.map(row => ({ ...row, time: shots[row.index].time, sourceVisual: shots[row.index].visual || '' })), digitalHumanShotIndexes: rows.filter(row => row.observedPresenterRole === 'sales_presenter' && !row.needsReview).map(row => row.index), presenterGroups: [...new Set(rows.filter(row => row.observedPresenterRole === 'sales_presenter' && !row.needsReview).map(row => row.personContinuityId))].map(personId => ({ personId, shotIndexes: rows.filter(row => row.observedPresenterRole === 'sales_presenter' && !row.needsReview && row.personContinuityId === personId).map(row => row.index) })), frameCount: frames.length * 2, completedAt: new Date().toISOString() };
        const reviewedShots = (saved.gemini?.scriptDetails15s || saved.scriptDetails15s).map((shot: any, index: number) => ({ ...shot,
          observedPresenterRole: rows[index].observedPresenterRole, personContinuityId: rows[index].personContinuityId,
          salesPresenterConfirmed: rows[index].observedPresenterRole === 'sales_presenter' && !rows[index].needsReview,
          presenterRecognition: rows[index] }));
        await store.update(COL, req.params.id, { aiAnalysis: JSON.stringify({ ...saved, salesPresenterReview: review,
          ...(saved.gemini?.scriptDetails15s ? { gemini: { ...saved.gemini, scriptDetails15s: reviewedShots } } : { scriptDetails15s: reviewedShots }) }) });
        return review;
      } catch (error) {
        const failedRecord = await store.getById<Record<string, unknown>>(COL, req.params.id);
        const failedAnalysis = parseJsonRecord<Record<string, any>>(failedRecord?.aiAnalysis, {});
        if (failedAnalysis.salesPresenterReview?.key === key && failedAnalysis.salesPresenterReview.state === 'running') {
          await store.update(COL, req.params.id, { aiAnalysis: JSON.stringify({ ...failedAnalysis,
            salesPresenterReview: { ...failedAnalysis.salesPresenterReview, state: 'failed', failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : '销售识别失败' } }) });
        }
        throw error;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    salesReviewRunning.set(lock, pending);
    pending.finally(() => salesReviewRunning.delete(lock)).catch(() => {});
  }
  try { res.json({ ok: true, cached: false, ...(await pending as object) }); }
  catch (error) { res.status(422).json({ error: error instanceof Error ? error.message : '销售识别失败' }); }
});

/** Automatic measured speech repair uses the same ASR/mapping as new analysis.
 * It updates source evidence only; no manual confirmation/review is introduced. */
videosRouter.post('/:id/align-speech', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const recordId = String(req.params.id);
  const record = await store.getById<Record<string, unknown>>(COL, recordId);
  if (!record || String(record.tenantId || '') !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  const before = parseJsonRecord<Record<string, any>>(record.aiAnalysis, {});
  const videoPath = localReferenceVideoPath(String(record.videoFileId || ''), tenantId);
  if (!videoPath || !fs.existsSync(videoPath)) { res.status(422).json({ error: '本地原片不可用，不能建立真实词级对齐' }); return; }
  const fingerprint = (value: Record<string, any>) => createHash('sha256').update(JSON.stringify({
    contentSha256: value.contentSha256, analysisRunId: value.analysisRunId, gemini: value.gemini,
  })).digest('hex');
  try {
    const measuredHash = createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex');
    if (before.contentSha256 && before.contentSha256 !== measuredHash) {
      res.status(409).json({ error: '原片已变化，不能将新音频写入旧分镜分析' }); return;
    }
    const clock = await probeReferenceMediaClock(videoPath);
    const transcript = await prepareReferenceNarration(videoPath, clock.duration, { tenantId });
    const mapped = lockReferenceSpeechTimeline(before.gemini, transcript, { duration: clock.duration, fps: clock.fps ?? undefined });
    const latest = await store.getById<Record<string, unknown>>(COL, recordId);
    const current = parseJsonRecord<Record<string, any>>(latest?.aiAnalysis, {});
    if (!latest || String(latest.tenantId || '') !== tenantId || fingerprint(current) !== fingerprint(before)) {
      res.status(409).json({ error: '分析已变化，对齐结果未覆盖新分析' }); return;
    }
    const alignment = { version: 2, status: 'aligned', provider: 'qwen', model: transcript.model,
      taskId: transcript.taskId, sourceSha256: measuredHash, audioSha256: transcript.sourceSha256,
      wordCount: transcript.words.length, shotCount: mapped.scriptDetails15s?.length || 0,
      mappedWordCount: mapped.speechAlignmentSummary?.acceptedWordCount || 0,
      clippedShotIds: mapped.speechAlignmentSummary?.clippedShotIds || [],
      timestampResolutionMs: transcript.timestampResolutionMs, accuracyMs: transcript.accuracyMs,
      durationSeconds: clock.duration, fps: clock.fps, completedAt: new Date().toISOString() };
    if (!await store.update(COL, recordId, { duration: clock.duration,
      aiAnalysis: JSON.stringify({ ...current, gemini: mapped, speechAlignment: alignment,
        // A previous semantic classification cannot survive a changed audio clock.
        criticalShotAnalysis: undefined, referenceProductionRoutingSummary: undefined }) })) throw new Error('对齐结果保存失败');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, status: 'aligned', alignment, analysisRunId: current.analysisRunId, sourceSha256: measuredHash });
  } catch (error) { res.status(422).json({ ok: false, status: 'unavailable',
    error: error instanceof Error ? error.message : '口播对齐失败，未伪造时间戳' }); }
});

videosRouter.post('/:id/classify-critical-shots', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const id = String(req.params.id);
  const record = await store.getById<Record<string, unknown>>(COL, id);
  if (!record || record.tenantId !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  const before = parseJsonRecord<Record<string, any>>(record.aiAnalysis, {});
  const filePath = await ensureLocalReferenceVideoPath(record, tenantId);
  if (!filePath || !fs.existsSync(filePath)) { res.status(422).json({ error: '原片不可用，不能观察实际动作' }); return; }
  if (!before.gemini?.audioTranscript?.words?.length || !before.gemini?.speechAlignmentSummary?.acceptedWordCount) {
    res.status(422).json({ error: '缺少真实词级对齐，不能判定动作台词卡点' }); return;
  }
  const fingerprint = (value: Record<string, any>) => createHash('sha256')
    .update(JSON.stringify({ contentSha256: value.contentSha256, analysisRunId: value.analysisRunId, gemini: value.gemini })).digest('hex');
  try {
    const sourceSha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (before.contentSha256 && before.contentSha256 !== sourceSha256) { res.status(409).json({ error: '源视频已变化' }); return; }
    const clock = await probeReferenceMediaClock(filePath);
    const critical = await produceReferenceCriticalShots({ filePath, analysis: before.gemini,
      videoId: id, sourceSha256, duration: clock.duration, tenantId });
    const classified = before.gemini.presenterContinuitySummary
      ? await produceReferenceProductionRouting({filePath,analysis:critical,videoId:id,sourceSha256,duration:clock.duration,tenantId}) : critical;
    const latest = await store.getById<Record<string, unknown>>(COL, id);
    const current = parseJsonRecord<Record<string, any>>(latest?.aiAnalysis, {});
    if (!latest || latest.tenantId !== tenantId || fingerprint(current) !== fingerprint(before)) {
      res.status(409).json({ error: '分析已变化，卡点判定未覆盖新版本' }); return;
    }
    if (!await store.update(COL, id, { aiAnalysis: JSON.stringify({ ...current,
      gemini: classified, criticalShotAnalysis: classified.criticalShotSummary }) })) throw new Error('卡点判定保存失败');
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, status: 'classified', classification: classified.criticalShotSummary });
  } catch (error) { res.status(422).json({ ok: false, status: 'unavailable',
    error: error instanceof Error ? error.message : '卡点识别失败，未伪造判定' }); }
});

/** Automatic independent person-continuity evidence and identity-first route.
 * Existing critical labels and measured speech remain intact. */
videosRouter.post('/:id/route-production', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const id = String(req.params.id), record = await store.getById<Record<string, unknown>>(COL, id);
  if (!record || record.tenantId !== tenantId) { res.status(404).json({ error: 'Not found' }); return; }
  const before = parseJsonRecord<Record<string, any>>(record.aiAnalysis, {});
  const filePath = await ensureLocalReferenceVideoPath(record, tenantId);
  if (!filePath || !fs.existsSync(filePath)) { res.status(422).json({ error: '原片不可用，不能识别人物连续性' }); return; }
  if (!before.gemini?.scriptDetails15s?.length || !before.gemini.scriptDetails15s.every((s:any)=>s.criticalShot)) {
    res.status(422).json({ error: '缺少独立关键性证据，先完成原片分析' }); return;
  }
  const fingerprint = (value: Record<string, any>) => createHash('sha256').update(JSON.stringify({
    source:value.contentSha256,run:value.analysisRunId,gemini:value.gemini })).digest('hex');
  try {
    const sourceSha256 = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (before.contentSha256 !== sourceSha256) { res.status(409).json({ error: '原片指纹已变化' }); return; }
    const clock = await probeReferenceMediaClock(filePath);
    const routed = await produceReferenceProductionRouting({filePath,analysis:before.gemini,sourceSha256,
      videoId:id,tenantId,duration:clock.duration});
    const latest = await store.getById<Record<string,unknown>>(COL,id), current = parseJsonRecord<Record<string,any>>(latest?.aiAnalysis,{});
    if (!latest || latest.tenantId !== tenantId || fingerprint(current) !== fingerprint(before)) {
      res.status(409).json({error:'分析已变化，人物路由未覆盖新版本'});return;
    }
    if(!await store.update(COL,id,{aiAnalysis:JSON.stringify({...current,gemini:routed,
      presenterContinuitySummary:routed.presenterContinuitySummary,referenceProductionRoutingSummary:routed.referenceProductionRoutingSummary})})) throw new Error('生产路由保存失败');
    res.setHeader('Cache-Control','private, no-store');
    res.json({ok:true,status:'routed',presenterContinuitySummary:routed.presenterContinuitySummary,
      routing:routed.referenceProductionRoutingSummary});
  } catch(error) {res.status(422).json({ok:false,status:'unavailable',error:error instanceof Error?error.message:'人物识别失败，未猜测路由'});}
});

/** Compatibility response for the existing detail editor. It shares the
 * automatic reference ASR cache; no separate timestamp implementation. */
videosRouter.post('/:id/phrase-asr', createReferencePhraseAsrHandler({
  readRecord: id => store.getById(COL,id),
  localPath: localReferenceVideoPath,
  exists: fs.existsSync,
  probe: probeReferenceMediaClock,
  prepare: prepareReferenceNarration,
  readCache: readCachedReferenceNarration,
}));

/** Align observed ASR to an editor-confirmed narrative structure. This is a
 * review artifact; caller flags cannot promote an unverified source analysis. */
videosRouter.post('/:id/speech-timeline', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || String(record.tenantId || '') !== tenantId) {
    res.status(404).json({ error: 'Not found' }); return;
  }
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const shotReview = parseJsonRecord<Record<string, unknown>>(record.referenceShotReview, {});
  const currentShotReview = String(shotReview.sourceAnalysisRunId || '') === String(analysis.analysisRunId || '')
    && Boolean(shotReview.sourceAnalysisRunId);
  const rawSections = currentShotReview && Array.isArray(shotReview.sections)
    ? shotReview.sections : req.body?.sections;
  if (!Array.isArray(rawSections) || rawSections.length !== 6 || rawSections.some(item =>
    !item || typeof item.sectionId !== 'string' || typeof item.title !== 'string'
    || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start)) {
    res.status(400).json({ error: 'Six valid narrative sections are required' }); return;
  }
  const sections = rawSections as ReferenceStructureInput[];
  const gemini = analysis.gemini && typeof analysis.gemini === 'object'
    ? analysis.gemini as Record<string, unknown> : parseJsonRecord<Record<string, unknown>>(analysis.gemini, {});
  const transcript = gemini.audioTranscript && typeof gemini.audioTranscript === 'object'
    ? gemini.audioTranscript as Record<string, unknown>
    : parseJsonRecord<Record<string, unknown>>(gemini.audioTranscript, {});
  const savedSpeech = currentVerifiedSpeech(parseJsonRecord(record.referenceVerifiedSpeech, null),
    String(analysis.analysisRunId || ''), String(analysis.contentSha256 || ''));
  const speech = savedSpeech ? savedSpeech.lines.map(line => ({ ...line, timingPrecision: 'phrase' as const,
    provenance: `manual_verified:${savedSpeech.reviewerId}:${savedSpeech.verifiedAt}` }))
    : approximateSpeechLines(transcript.segments);
  const details = Array.isArray(gemini.scriptDetails15s) ? gemini.scriptDetails15s : [];
  const candidateShots = details.flatMap((raw, index) => {
    const detail = raw && typeof raw === 'object' ? raw as Record<string, unknown>
      : parseJsonRecord<Record<string, unknown>>(raw, {});
    const range = parseAnalysisTimeRange(String(detail.time || detail.timestamp || ''));
    return range ? [{ shotId: `shot-${index + 1}`, start: range.start, end: range.end,
      content: String(detail.visual || ''), purpose: String(detail.purpose || '') }] : [];
  });
  const shots = currentShotReview && Array.isArray(shotReview.shots)
    ? (shotReview.shots as Array<Record<string, unknown>>).filter(shot => shot.reviewStatus !== 'discarded').map(shot => ({
      shotId: String(shot.shotId || ''), start: Number(shot.start), end: Number(shot.end),
      content: String(shot.content || ''), purpose: String(shot.purpose || ''),
    })) : candidateShots;
  const timeline = buildReferenceSpeechTimeline({
    speech: Array.isArray(speech) ? speech as any : [], shots, sections,
    speechCoverageVerified: savedSpeech?.coverageConfirmed === true,
    shotCutsVerified: currentShotReview && shotReview.reviewComplete === true && req.body?.shotCutsVerified === true,
  });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ referenceRecordId: req.params.id, analysisRunId: analysis.analysisRunId || null, ...timeline });
});

videosRouter.get('/:id',referenceReviewReadHandlers.video);

videosRouter.get('/:id/media', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById(COL, req.params.id);
  if (!record) { res.status(404).json({ error: 'Not found' }); return; }
  if (record.tenantId !== tenantId && !await requireAdminUser(req)) { res.status(404).json({ error: 'Not found' }); return; }
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const filename = String(record.videoFileId || '');
  const localReference = localReferenceVideoPath(filename, String(record.tenantId || ''));
  // Imports are mirrored locally before object-storage upload. Prefer that durable
  // local copy so a temporary COS outage cannot break preview or stop the server.
  if (localReference && fs.existsSync(localReference)) {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('mp4').sendFile(localReference);
    return;
  }
  const cosKey = String(analysis.videoObjectKey || '');
  if (cosKey) {
    try {
      if (!await streamCrawlerCosObject(res, cosKey, req.headers.range)) res.status(404).json({ error: 'COS video not found' });
    } catch (error) {
      console.warn('[videos] object storage preview unavailable:', error instanceof Error ? error.message : error);
      if (!res.headersSent) res.status(502).json({ error: 'video_storage_temporarily_unavailable' });
      else res.end();
    }
    return;
  }
  if (!filename) { res.status(404).json({ error: 'Video not stored' }); return; }
  if (localReference) {
    if (!fs.existsSync(localReference)) { res.status(404).json({ error: 'Video not stored' }); return; }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('mp4').sendFile(localReference);
    return;
  }
  const file = await fetchFile(COL, req.params.id, filename);
  if (!file) { res.status(404).json({ error: 'PocketBase video not found' }); return; }
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', file.contentType || 'video/mp4'); res.setHeader('Cache-Control', 'private, max-age=3600');
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/); const start = Math.max(0, Number(match?.[1] || 0)); const end = Math.min(file.buf.length - 1, Number(match?.[2] || file.buf.length - 1));
    if (start > end) { res.status(416).end(); return; }
    res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${file.buf.length}`); res.setHeader('Content-Length', end - start + 1); res.end(file.buf.subarray(start, end + 1)); return;
  }
  res.setHeader('Content-Length', file.buf.length); res.end(file.buf);
});

function localReferenceVideoPath(filename: string, tenantId: string): string | null {
  const clean = filename.replace(/\\/g, '/');
  const prefix = `tenants/${tenantId}/reference-videos/`;
  if (!clean.startsWith(prefix) || !/^tenants\/[A-Za-z0-9_-]+\/reference-videos\/[A-Za-z0-9_-]+\.mp4$/.test(clean)) return null;
  const fullPath = path.resolve(MEDIA_DIR, clean);
  const tenantRoot = path.resolve(tenantAssetDir(MEDIA_DIR, tenantId));
  return fullPath.startsWith(`${tenantRoot}${path.sep}`) ? fullPath : null;
}

async function ensureLocalReferenceVideoPath(record: Record<string, unknown>, tenantId: string): Promise<string | null> {
  const existing = localReferenceVideoPath(String(record.videoFileId || ''), tenantId);
  if (existing && fs.existsSync(existing)) return existing;
  const sourceUrl = String(record.sourceUrl || '').trim();
  const platform = (record.platform || inferPlatformFromUrl(sourceUrl)) as Platform;
  if (!sourceUrl || !validatePublicVideoSourceUrl(sourceUrl, platform)) return null;
  const downloaded = await downloadVideoForAnalysis({ record, sourceUrl, title: String(record.title || `${platform}-video`), platform });
  try {
    const analysis = videoAnalysisOf(record);
    const measured = createHash('sha256').update(fs.readFileSync(downloaded.filePath)).digest('hex');
    if (analysis.contentSha256 && analysis.contentSha256 !== measured) throw new Error('reference_source_bytes_changed');
    const destination = path.join(tenantAssetDir(MEDIA_DIR, tenantId), 'reference-videos', `${String(record.id)}.mp4`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(downloaded.filePath, destination);
    const videoFileId = path.posix.join('tenants', tenantId, 'reference-videos', `${String(record.id)}.mp4`);
    await store.update(COL, String(record.id), { videoFileId });
    return destination;
  } finally {
    cleanupTempVideo(downloaded.filePath);
  }
}

videosRouter.get('/:id/shot/:number/:kind', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById(COL, req.params.id);
  if (!record || (record.tenantId !== tenantId && !await requireAdminUser(req))) {
    res.status(404).json({ error: 'Not found' }); return;
  }
  const index = Number(req.params.number) - 1;
  const kind = req.params.kind;
  if (!Number.isSafeInteger(index) || index < 0 || (kind !== 'clip' && kind !== 'first-frame')) {
    res.status(404).json({ error: 'Shot evidence not found' }); return;
  }
  const geminiValue = videoAnalysisOf(record).gemini;
  const gemini = geminiValue && typeof geminiValue === 'object' && !Array.isArray(geminiValue)
    ? geminiValue as Record<string, unknown>
    : parseJsonRecord<Record<string, unknown>>(geminiValue, {});
  const details = Array.isArray(gemini.scriptDetails15s) ? gemini.scriptDetails15s : [];
  const detailValue = details[index];
  const detail = detailValue && typeof detailValue === 'object' && !Array.isArray(detailValue)
    ? detailValue as Record<string, unknown>
    : parseJsonRecord<Record<string, unknown>>(detailValue, {});
  const evidenceValue = detail.materialEvidence;
  const evidence = evidenceValue && typeof evidenceValue === 'object' && !Array.isArray(evidenceValue)
    ? evidenceValue as Record<string, unknown>
    : parseJsonRecord<Record<string, unknown>>(evidenceValue, {});
  const key = String(kind === 'clip' ? evidence.clipObjectKey || '' : evidence.firstFrameObjectKey || '');
  if (evidence.extractionStatus !== 'ready' || !key) {
    if (evidence.extractionStatus !== 'ready' || objectStorageEnabled()) {
      res.status(404).json({ error: 'Shot evidence not found' }); return;
    }
    const file = path.join(tenantAssetDir(MEDIA_DIR, tenantId), 'trend-shots', String(record.id), `shot-${index + 1}.${kind === 'clip' ? 'mp4' : 'jpg'}`);
    if (!fs.existsSync(file)) { res.status(404).json({ error: 'Shot evidence not found' }); return; }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
    return;
  }
  if (!await streamCrawlerCosObject(res, key, kind === 'clip' ? req.headers.range : undefined)) {
    res.status(404).json({ error: 'Shot evidence not found' });
  }
});

videosRouter.get('/:id/media-url', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById(COL, req.params.id);
  if (!record) { res.status(404).json({ error: 'Not found' }); return; }
  if (record.tenantId !== tenantId && !await requireAdminUser(req)) { res.status(404).json({ error: 'Not found' }); return; }
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const filename = String(record.videoFileId || '');
  if (!filename && !analysis.videoObjectKey) { res.status(404).json({ error: 'Video not stored' }); return; }
  res.setHeader('Cache-Control', 'private, no-store');
  const normalizedLocalFile = filename.replace(/\\/g, '/').replace(/^\/+/, '');
  const recordTenantId = String(record.tenantId || '');
  const expectedPrefix = `tenants/${recordTenantId}/`;
  const tenantRoot = path.resolve(MEDIA_DIR, 'tenants', recordTenantId);
  const localPath = path.resolve(MEDIA_DIR, normalizedLocalFile);
  if (normalizedLocalFile.startsWith(expectedPrefix)
    && localPath.startsWith(`${tenantRoot}${path.sep}`)
    && fs.existsSync(localPath)
    && fs.statSync(localPath).isFile()) {
    res.json({ url: signAssetUrl(`/media/${normalizedLocalFile}`, tenantId) });
    return;
  }
  res.json({ url: signAssetUrl(`/api/overseas/videos/${encodeURIComponent(req.params.id)}/media`, tenantId) });
});

/**
 * `<img>` 发不出 Authorization 头，只能带 asset session cookie，
 * 而 requireAdminUser 只认头部。跨租户封面对管理员可见，这里补上 cookie 回落。
 */
async function isAdminForAssetRequest(req: Request): Promise<boolean> {
  if (await requireAdminUser(req)) return true;
  const cookieToken = cookieValue(req, ASSET_SESSION_COOKIE);
  if (!cookieToken) return false;
  const proxied = Object.create(req, {
    headers: { value: { ...req.headers, authorization: `Bearer ${cookieToken}` } },
  }) as Request;
  return Boolean(await requireAdminUser(proxied));
}

function isSharedInspirationThumbnailReadable(record: Record<string, unknown>): boolean {
  const sharedTenantId = String(process.env.SOCIAL_SHARED_INSPIRATION_TENANT_ID || 'demo-shared-video-pool').trim();
  const analysis = videoAnalysisOf(record);
  return Boolean(sharedTenantId)
    && String(record.tenantId || '') === sharedTenantId
    && analysis.userVisible === true
    && isPublicTestTenantVideo(record);
}

async function generateThumbnailFromStoredVideo(record: Record<string, unknown>): Promise<{ buf: Buffer; contentType: string } | null> {
  const recordId = String(record.id || '');
  if (!recordId) return null;
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const videoKey = String(analysis.videoObjectKey || '');
  const filename = String(record.videoFileId || '');
  const localReference = localReferenceVideoPath(filename, String(record.tenantId || ''));
  let video: Awaited<ReturnType<typeof objectStorageDownload>> | null = null;
  if (videoKey) {
    try {
      video = await objectStorageDownload(videoKey);
    } catch (error) {
      // A branch can carry database metadata without the corresponding local
      // object-storage blob. Continue to the record/local reference fallbacks.
      console.warn('[videos] object thumbnail source unavailable, trying local fallback:', error instanceof Error ? error.message : error);
    }
  }
  if (!video && localReference && fs.existsSync(localReference)) video = { buf: fs.readFileSync(localReference), contentType: 'video/mp4' };
  if (!video && filename) video = await fetchFile(COL, recordId, filename);
  if (!video?.buf.length) return null;

  if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const sourceName = videoKey || filename || 'video.mp4';
  const ext = path.extname(sourceName).replace(/^\./, '').toLowerCase()
    || (video.contentType.includes('webm') ? 'webm' : video.contentType.includes('quicktime') ? 'mov' : 'mp4');
  const base = `thumb-${recordId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const videoPath = path.join(ANALYSIS_DIR, `${base}.${ext}`);
  const posterPath = path.join(ANALYSIS_DIR, `${base}.jpg`);
  try {
    fs.writeFileSync(videoPath, video.buf);
    const ok = await extractPoster(videoPath, posterPath, Number(record.duration || 0) > 1 ? 1 : 0);
    if (!ok || !fs.existsSync(posterPath)) return null;
    const posterBuf = fs.readFileSync(posterPath);
    const thumbnailUrl = `/api/overseas/videos/${encodeURIComponent(recordId)}/thumbnail`;
    if (objectStorageEnabled()) {
      const thumbnailObjectKey = await uploadCrawlerCosObject(recordId, 'thumbnail', posterBuf, 'image/jpeg');
      await store.update(COL, recordId, {
        thumbnailUrl,
        aiAnalysis: JSON.stringify({
          ...analysis,
          thumbnailStorage: 'cos',
          thumbnailObjectKey,
        }),
      });
    } else {
      const thumbnailFile = await attachFile(COL, recordId, 'thumbnailFile', {
        name: `${recordId}-thumbnail.jpg`,
        buf: posterBuf,
        contentType: 'image/jpeg',
      });
      await store.update(COL, recordId, {
        thumbnailUrl,
        ...(thumbnailFile ? { thumbnailFile } : {}),
      });
    }
    return { buf: posterBuf, contentType: 'image/jpeg' };
  } catch (error) {
    console.warn('[videos] thumbnail generation failed:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    for (const filePath of [videoPath, posterPath]) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
  }
}

// 封面：直接从记录自己的 PocketBase 文件字段读。
// <img> 带不了 Authorization 头，但 requireAuth 会回落到 asset session cookie。
videosRouter.get('/:id/thumbnail', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record) {
    // Frozen weekly plans intentionally keep their source evidence after a
    // discovery record is removed. Resolve that public source instead of
    // turning every historical calendar card into a permanent broken cover.
    const sourceUrl = String(req.query.sourceUrl || '').trim().slice(0, 2_000);
    const platform = inferPlatformFromUrl(sourceUrl);
    if (!sourceUrl || !isPlatformUrl(sourceUrl, platform)) { res.status(404).end(); return; }
    const remoteUrl = await publicSourceThumbnail({ sourceUrl, platform });
    const fallback = remoteUrl ? await fetchThumbnailBuffer(remoteUrl) : null;
    if (!fallback) { res.status(404).end(); return; }
    res.setHeader('Content-Type', fallback.contentType.startsWith('image/') ? fallback.contentType : 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Content-Length', fallback.buf.length);
    res.end(fallback.buf);
    return;
  }
  const ownsRecord = String(record.tenantId || '') === tenantId;
  if (!ownsRecord && !isSharedInspirationThumbnailReadable(record) && !await isAdminForAssetRequest(req)) {
    res.status(404).end();
    return;
  }

  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  let cosKey = String(analysis.thumbnailObjectKey || '');
  if (!cosKey && analysis.contentFormat === 'image') {
    cosKey = await recoverCrawlerImageObjectKey(record, 'thumbnail');
    if (cosKey) {
      void store.update(COL, String(record.id), {
        aiAnalysis: JSON.stringify({ ...analysis, thumbnailStorage: 'cos', thumbnailObjectKey: cosKey }),
      });
    }
  }
  if (cosKey) {
    try {
      if (await streamCrawlerCosObject(res, cosKey, req.headers.range)) return;
    } catch (error) {
      console.warn('[videos] stored thumbnail unavailable, trying fallbacks:', error instanceof Error ? error.message : error);
    }
  }
  const filename = String(record.thumbnailFile || '');
  let file = filename ? await fetchFile(COL, req.params.id, filename) : null;
  if (!file) file = await generateThumbnailFromStoredVideo(record as Record<string, unknown>);
  if (!file) {
    const remoteUrl = await publicSourceThumbnail(record);
    if (remoteUrl) {
      file = await fetchThumbnailBuffer(remoteUrl);
      if (file) void storeThumbnailBuffer(String(record.id), file.buf, file.contentType);
    }
  }
  if (!file) { res.status(404).end(); return; }

  res.setHeader('Content-Type', file.contentType.startsWith('image/') ? file.contentType : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Length', file.buf.length);
  res.end(file.buf);
});

videosRouter.get('/:id/image/:index', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const record = await store.getById(COL, req.params.id);
  if (!record) { res.status(404).end(); return; }
  if (record.tenantId !== tenantId && !await isAdminForAssetRequest(req)) { res.status(404).end(); return; }
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const keys = Array.isArray(analysis.imageObjectKeys) ? analysis.imageObjectKeys.map(String) : [];
  const index = Number(req.params.index);
  let key = Number.isInteger(index) && index >= 0 ? keys[index] : '';
  if (!key && Number.isInteger(index) && index >= 0 && analysis.contentFormat === 'image') {
    key = await recoverCrawlerImageObjectKey(record as Record<string, unknown>, `image-${index + 1}`);
    if (key) {
      const repairedKeys = [...keys];
      repairedKeys[index] = key;
      void store.update(COL, String(record.id), {
        aiAnalysis: JSON.stringify({ ...analysis, imageStorage: 'cos', imageObjectKeys: repairedKeys }),
      });
    }
  }
  if (!key || !await streamCrawlerCosObject(res, key, req.headers.range)) res.status(404).end();
});

videosRouter.patch('/:id/analysis-corrections', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const record = await store.getById(COL, req.params.id);
  if (!record) { res.status(404).json({ error: 'Not found' }); return; }
  if (record.tenantId !== tenantId && !await requireAdminUser(req)) { res.status(404).json({ error: 'Not found' }); return; }
  const details = Array.isArray(req.body?.scriptDetails15s) ? req.body.scriptDetails15s.slice(0, 500) : null;
  const summary = req.body?.scriptSummary15s && typeof req.body.scriptSummary15s === 'object' ? req.body.scriptSummary15s : null;
  if (!details) { res.status(400).json({ error: 'scriptDetails15s required' }); return; }
  const previous = parseJsonRecord<Record<string, any>>(record.aiAnalysis, {});
  const gemini = previous.gemini && typeof previous.gemini === 'object' ? previous.gemini : {};
  const correctedAt = new Date().toISOString();
  const next = {
    ...previous,
    originalGemini: previous.originalGemini || gemini,
    gemini: { ...gemini, ...(summary ? { scriptSummary15s: summary } : {}), scriptDetails15s: details },
    correction: { correctedAt, correctedBy: userId, confirmed: Boolean(req.body?.confirmed), version: Number(previous.correction?.version || 0) + 1 },
  };
  await store.update(COL, req.params.id, { aiAnalysis: JSON.stringify(next) });
  res.json({ ok: true, correctedAt, version: next.correction.version, analysis: next.gemini });
});

// Record the handoff from Inspiration exact analysis into the refinement
// workflow. ScheduledPage reads this marker from the same trend_videos record,
// so the handoff is durable and tenant-scoped instead of being browser state.
videosRouter.post('/:id/refinement-sync', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || (record.tenantId !== tenantId && !await requireAdminUser(req))) {
    res.status(404).json({ error: 'Video record not found' });
    return;
  }
  const previous = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  if (previous.analysisMode !== 'exact' || previous.requestedAnalysisMode === 'exact' || previous.analysisError) {
    res.status(409).json({ error: '请先完成合格的全片精确分析，再进入精修流程' });
    return;
  }
  const syncedAt = new Date().toISOString();
  await store.update(COL, req.params.id, {
    aiAnalysis: JSON.stringify({
      ...previous,
      refinementStatus: 'ready',
      refinementQueuedAt: syncedAt,
      refinementQueuedBy: userId,
      refinementSource: String(req.body?.source || 'inspiration_analysis'),
    }),
  });
  res.json({ ok: true, id: req.params.id, status: 'ready', syncedAt });
});

videosRouter.post('/:id/analysis-pause', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || (record.tenantId !== tenantId && !await requireAdminUser(req))) {
    res.status(404).json({ error: 'Video record not found' });
    return;
  }
  const previous = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const geminiStatus = String(previous.geminiStatus || '');
  const downloadStatus = String(previous.downloadStatus || '');
  const videoFetchStatus = String(previous.videoFetchStatus || '');
  const activeStatuses = new Set([
    'queued', 'analyzing', 'waiting_for_video', 'downloading', 'download_retrying',
    'analysis_retryable', 'ops_queued', 'ops_processing',
  ]);
  const isRunning = Boolean(previous.requestedAnalysisMode)
    || activeStatuses.has(geminiStatus)
    || activeStatuses.has(downloadStatus)
    || activeStatuses.has(videoFetchStatus);
  if (!isRunning) {
    res.status(409).json({ error: '当前视频不在分析中' });
    return;
  }
  const pausedAt = new Date().toISOString();
  // Rotating the run id makes every in-flight completion stale. Expensive
  // provider calls may finish remotely, but their result can no longer
  // overwrite this durable paused state.
  await store.update(COL, req.params.id, {
    status: previous.gemini || previous.analysisQuality ? 'analyzed' as VideoStatus : 'failed' as VideoStatus,
    aiAnalysis: JSON.stringify({
      ...previous,
      analysisRunId: randomUUID(),
      requestedAnalysisMode: undefined,
      analysisQueueState: 'paused',
      analysisStage: 'paused',
      analysisStageUpdatedAt: pausedAt,
      geminiStatus: 'paused',
      downloadStatus: activeStatuses.has(downloadStatus) ? 'paused' : previous.downloadStatus,
      videoFetchStatus: activeStatuses.has(videoFetchStatus) ? 'paused' : previous.videoFetchStatus,
      analysisPausedAt: pausedAt,
      analysisPausedBy: userId,
      analysisError: undefined,
    }),
  });
  resolveCrawlerOpsTasksForRecord(req.params.id, 'paused_by_user');
  res.json({ ok: true, id: req.params.id, status: 'paused', pausedAt });
});

videosRouter.post('/:id/analysis-cancel', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || (record.tenantId !== tenantId && !await requireAdminUser(req))) {
    res.status(404).json({ error: 'Video record not found' });
    return;
  }
  const previous = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  if (!activeAnalysisRequest(previous) && !['paused', 'queued', 'running'].includes(String(previous.analysisQueueState || ''))) {
    res.status(409).json({ error: '当前视频没有可取消的分析任务' });
    return;
  }
  const cancelledAt = new Date().toISOString();
  await store.update(COL, req.params.id, {
    status: previous.gemini || previous.analysisQuality === 'video' ? 'analyzed' as VideoStatus : 'failed' as VideoStatus,
    aiAnalysis: JSON.stringify({
      ...previous,
      analysisRunId: randomUUID(),
      requestedAnalysisMode: undefined,
      analysisQueueState: 'cancelled',
      analysisStage: 'cancelled',
      analysisStageUpdatedAt: cancelledAt,
      geminiStatus: 'cancelled',
      downloadStatus: previous.downloadStatus === 'analyzed' ? 'analyzed' : 'cancelled',
      videoFetchStatus: previous.videoFetchStatus === 'fetched' ? 'fetched' : 'cancelled',
      analysisCancelledAt: cancelledAt,
      analysisCancelledBy: userId,
      analysisPausedAt: undefined,
      analysisPausedBy: undefined,
      analysisError: undefined,
    }),
  });
  resolveCrawlerOpsTasksForRecord(req.params.id, 'cancelled_by_user');
  res.json({ ok: true, id: req.params.id, status: 'cancelled', cancelledAt });
});

videosRouter.post('/:id/analysis-resume', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const record = await store.getById<Record<string, unknown>>(COL, req.params.id);
  if (!record || (record.tenantId !== tenantId && !await requireAdminUser(req))) {
    res.status(404).json({ error: 'Video record not found' });
    return;
  }
  const previous = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const mutationKey = `${String(record.tenantId || tenantId)}:record:${req.params.id}`;
  if (analysisQueueMutations.has(mutationKey) || activeAnalysisRequest(previous)) {
    res.status(202).json({ status: 'pending', analysisRunId: previous.analysisRunId, deduplicated: true });
    return;
  }
  analysisQueueMutations.add(mutationKey);
  res.once('finish', () => analysisQueueMutations.delete(mutationKey));
  const fileId = String(record.videoFileId || '');
  const sourceUrl = String(record.sourceUrl || '').trim();
  const materialId = String(previous.materialId || '').trim();
  if (!fileId && !materialId && !/^https?:\/\//i.test(sourceUrl)) {
    res.status(400).json({ error: '没有可恢复的源视频或素材' });
    return;
  }
  const analysisMode = req.body?.analysisMode === 'strategy'
    ? 'strategy'
    : String(previous.analysisRunMode || previous.analysisMode) === 'strategy' ? 'strategy' : 'exact';
  const analysisRunId = randomUUID();
  const queuedAt = new Date().toISOString();
  const missingMaterial = queuedMaterialFailureRequiresSourceFallback(previous);
  const analysisQueueKind: VideoAnalysisRetryQueueKind = fileId
    ? 'stored_video'
    : materialId && !missingMaterial ? 'material'
      : 'source_url';
  if (analysisQueueKind === 'source_url' && !/^https?:\/\//i.test(sourceUrl)) {
    res.status(409).json({ error: '原素材已不存在，请重新上传可读的原视频后再分析' });
    return;
  }
  resetCrawlerOpsTaskForExplicitRetry({
    recordId: req.params.id,
    tenantId: String(record.tenantId || tenantId),
    userId,
    usesSourceQueue: analysisQueueKind === 'source_url',
    now: queuedAt,
  });
  const nextAnalysis = {
    ...videoAnalysisRetryQueuePatch(previous, {
      analysisMode, analysisRunId, queueKind: analysisQueueKind, queuedAt, userId,
    }),
    analysisResumedAt: queuedAt,
    analysisResumedBy: userId,
  };
  const queuedRecord = { ...record, status: 'pending' as VideoStatus, aiAnalysis: JSON.stringify(nextAnalysis) };
  await store.update(COL, req.params.id, { status: 'pending' as VideoStatus, aiAnalysis: queuedRecord.aiAnalysis });
  if (analysisQueueKind === 'source_url') await queueAnalyzeSource(queuedRecord);
  else if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(req.params.id);
  res.status(202).json({ status: 'pending', analysisRunId, resumed: true });
});

// Pinned studio materials are not trend_videos records, so the regular
// /:id/reanalyze route cannot queue them. Create a tenant-scoped pipeline record
// first, then analyze the original material while exposing every state through
// the same scheduler stats used by crawled videos.
videosRouter.post('/material-exact-analysis', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const materialId = String(req.body?.materialId || '').trim();
  const rawMaterialId = materialId.replace(/^pb-/, '');
  const title = String(req.body?.title || '置顶素材').trim().slice(0, 200);
  const platform = (['tiktok', 'instagram', 'youtube', 'facebook'].includes(String(req.body?.platform))
    ? req.body.platform : 'tiktok') as Platform;
  const duration = Math.max(0, Number(req.body?.duration || 0));
  if (!materialId) { res.status(400).json({ error: 'materialId is required' }); return; }
  const mutationKey = `${tenantId}:material:${materialId}`;
  if (analysisQueueMutations.has(mutationKey)) {
    res.status(202).json({ status: 'pending', deduplicated: true });
    return;
  }
  analysisQueueMutations.add(mutationKey);
  res.once('finish', () => analysisQueueMutations.delete(mutationKey));

  let material: Material | null = null;
  let cloudRecord: Record<string, unknown> | null = null;
  if (materialId.startsWith('pb-')) {
    cloudRecord = await getCloudMaterialRecord(rawMaterialId, tenantId);
    const scope = String(cloudRecord?.scope || 'own');
    if (!cloudRecord) {
      res.status(404).json({ error: 'Material not found' });
      return;
    }
    material = {
      id: materialId,
      name: String(cloudRecord.title || cloudRecord.sourceName || title),
      folder: String(cloudRecord.folder || 'upload'),
      type: 'video',
      duration: Number(cloudRecord.duration || duration),
      size: humanSize(Number(cloudRecord.sizeBytes || 0)),
      file: String(cloudRecord.videoFile || ''),
      url: `/api/overseas/studio/materials/pb/${rawMaterialId}/media`,
      poster: `/api/overseas/studio/materials/pb/${rawMaterialId}/poster`,
      scope: scope === 'shared' ? 'shared' : 'own',
      tenantId: String(cloudRecord.tenantId || cloudRecord.tenant_id || ''),
      createdAt: String(cloudRecord.created || new Date().toISOString()),
    };
  } else {
    material = loadMaterials().find(item => item.id === materialId
      && (item.scope === 'shared' || item.tenantId === tenantId)) || null;
    if (!material) { res.status(404).json({ error: 'Material not found' }); return; }
  }
  if (material.type !== 'video') { res.status(400).json({ error: 'Only video materials can be analyzed' }); return; }

  const existingPage = await store.list<Record<string, unknown>>(COL, { where: { tenantId }, page: 1, perPage: 500 });
  const existing = existingPage.items.find(item => {
    const analysis = parseJsonRecord<Record<string, unknown>>(item.aiAnalysis, {});
    return String(analysis.materialId || '') === materialId;
  });
  const existingAnalysis = existing ? parseJsonRecord<Record<string, unknown>>(existing.aiAnalysis, {}) : {};
  if (existing && activeAnalysisRequest(existingAnalysis, 'exact')) {
    res.status(202).json({
      status: 'pending',
      id: String(existing.id),
      analysisRunId: existingAnalysis.analysisRunId,
      deduplicated: true,
    });
    return;
  }
  if (existing && productionReferenceAdmission(benchmarkAnalysisForRecord(existing, existingAnalysis)).ready) {
    res.json({
      status: 'analyzed',
      id: String(existing.id),
      analysisRunId: existingAnalysis.analysisRunId,
      reused: true,
    });
    return;
  }
  const analysisRunId = randomUUID();
  const queuedAt = new Date().toISOString();
  const queueAnalysis = {
    ...(existing ? parseJsonRecord<Record<string, unknown>>(existing.aiAnalysis, {}) : {}),
    materialId,
    materialUrl: material.url,
    materialPoster: material.poster,
    analysisSource: 'studio-material-exact',
    analysisRunId,
    analysisRunMode: 'exact',
    requestedAnalysisMode: 'exact',
    analysisMode: 'strategy',
    analysisQuality: 'segment_grounded',
    geminiStatus: 'queued',
    downloadStatus: 'analyzing',
    videoFetchStatus: 'fetched',
    analysisQueuedAt: queuedAt,
    reanalyzeQueuedAt: queuedAt,
    analysisQueueKind: 'material',
    analysisQueueState: 'queued',
    analysisStage: 'queued',
    analysisStageUpdatedAt: queuedAt,
    analysisError: undefined,
    videoLevelFailureStatus: undefined,
    userVisible: true,
  };
  let record: Record<string, unknown> | null = existing || null;
  if (existing) {
    await store.update(COL, String(existing.id), { status: 'pending' as VideoStatus, aiAnalysis: JSON.stringify(queueAnalysis) });
  } else {
    record = await store.create(COL, {
      tenantId,
      contentFormat: 'video',
      platform,
      title: title || material.name,
      thumbnailUrl: material.poster || '',
      videoFileId: '',
      duration: material.duration || duration,
      sourceUrl: '',
      tags: JSON.stringify(['置顶素材', '全片精确分析']),
      aiAnalysis: JSON.stringify(queueAnalysis),
      status: 'pending' as VideoStatus,
      crawledAt: queuedAt,
    });
  }
  const recordId = String(record?.id || existing?.id || '');
  if (!recordId) { res.status(500).json({ error: 'Failed to create analysis task' }); return; }

  if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(recordId);

  res.status(202).json({ status: 'pending', id: recordId, analysisRunId, queuedAt });
});

// ─── PATCH /videos/:id/reanalyze ─────────────────────────────────────────────
videosRouter.patch('/:id/reanalyze', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const record = await store.getById(COL, req.params.id);

  if (!record) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (record.tenantId !== tenantId && !await requireAdminUser(req)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const analysisMode = req.body?.analysisMode === 'exact' ? 'exact' : 'strategy';
  const previous = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const mutationKey = `${String(record.tenantId || tenantId)}:record:${req.params.id}`;
  if (analysisQueueMutations.has(mutationKey) || (req.body?.force !== true && activeAnalysisRequest(previous, analysisMode))) {
    res.status(202).json({
      status: 'pending',
      analysisRunId: previous.analysisRunId,
      deduplicated: true,
    });
    return;
  }
  analysisQueueMutations.add(mutationKey);
  res.once('finish', () => analysisQueueMutations.delete(mutationKey));
  const analysisRunId = randomUUID();
  const fileId = record.videoFileId as string | undefined;
  const recordTenantId = String(record.tenantId || tenantId);
  if (analysisMode === 'exact'
    && req.body?.force !== true
    && canRepairStoredExactClassification(record, previous)) {
    const queuedAt = new Date().toISOString();
    resetCrawlerOpsTaskForExplicitRetry({ recordId: req.params.id, tenantId: recordTenantId, userId, usesSourceQueue: false, now: queuedAt });
    await store.update(COL, req.params.id, {
      status: 'pending' as VideoStatus,
      aiAnalysis: JSON.stringify(videoAnalysisRetryQueuePatch(previous, {
        analysisMode, analysisRunId, queueKind: 'classification_repair', queuedAt, userId,
      })),
    });
    if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(req.params.id);
    res.status(202).json({ status: 'pending', analysisRunId, repair: 'classification_only' });
    return;
  }
  if (analysisMode === 'exact'
    && req.body?.force !== true
    && Boolean(fileId)
    && ['video', 'video_review_required'].includes(String(previous.analysisQuality || ''))
    && canPromoteExistingAnalysisToExact(previous.gemini, Number(record.duration || 0))
    && !exactVideoClassificationQualityError(previous.gemini as VideoAiAnalysis)
    && !exactVideoReviewReasons(previous.gemini as VideoAiAnalysis, Number(record.duration || 0)).length) {
    const localReference = localReferenceVideoPath(String(fileId), String(record.tenantId || tenantId));
    const sourceSha256 = localReference && fs.existsSync(localReference)
      ? createHash('sha256').update(fs.readFileSync(localReference)).digest('hex') : '';
    const promotedGemini = reconcileStoredOpeningHookMotionEvidence(previous.gemini as VideoAiAnalysis);
    resetCrawlerOpsTaskForExplicitRetry({ recordId: req.params.id, tenantId: recordTenantId, userId, usesSourceQueue: false });
    await store.update(COL, req.params.id, {
      status: 'analyzed',
      aiAnalysis: JSON.stringify({
        ...previous,
        gemini: promotedGemini,
        ...(sourceSha256 ? { contentSha256: sourceSha256 } : {}),
        durationSeconds: Number(record.duration || 0),
        ...videoSuccessVisibilityPatch(),
        analysisMode: 'exact',
        analysisQuality: 'video',
        requestedAnalysisMode: undefined,
        geminiStatus: 'analyzed',
        downloadStatus: 'analyzed',
        videoFetchStatus: 'fetched',
        videoStorage: previous.videoObjectKey ? 'cos' : (previous.videoStorage || 'pocketbase'),
        videoLevelFailureStatus: undefined,
        manualRequiredReason: undefined,
        analysisError: undefined,
        analysisQueueState: 'completed',
        analysisStage: 'completed',
        analysisReviewReasons: (Array.isArray(previous.analysisReviewReasons) ? previous.analysisReviewReasons : [])
          .filter(reason => reason !== 'opening_hook_observation_uncertainty'),
        downloadError: undefined,
        analysisPausedAt: undefined,
        analysisPausedBy: undefined,
        exactPromotedFromExisting: true,
        exactAnalyzedAt: new Date().toISOString(),
      }),
    });
    res.json({ status: 'analyzed', reused: true });
    return;
  }
  if (!fileId) {
    const sourceUrl = String(record.sourceUrl || '').trim();
    const materialUnavailable = queuedMaterialFailureRequiresSourceFallback(previous);
    if (previous.materialId && !materialUnavailable) {
      const retryResetAt = new Date().toISOString();
      await store.update(COL, req.params.id, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify(videoAnalysisRetryQueuePatch(previous, {
          analysisMode, analysisRunId, queueKind: 'material', queuedAt: retryResetAt, userId,
        })),
      });
      if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(req.params.id);
      res.status(202).json({ status: 'pending', analysisRunId });
      return;
    }
    if (!/^https?:\/\//i.test(sourceUrl)) {
      res.status(materialUnavailable ? 409 : 400).json({ error: materialUnavailable
        ? '原素材已不存在，请重新上传可读的原视频后再分析'
        : 'No video file or public sourceUrl attached to this record' });
      return;
    }
    const retryResetAt = new Date().toISOString();
    resetCrawlerOpsTaskForExplicitRetry({ recordId: req.params.id, tenantId: recordTenantId, userId, usesSourceQueue: true, now: retryResetAt });
    const queuedRecord = { ...record, status: 'pending' as VideoStatus, aiAnalysis: JSON.stringify(videoAnalysisRetryQueuePatch(previous, {
      analysisMode, analysisRunId, queueKind: 'source_url', queuedAt: retryResetAt, userId,
    })) };
    await store.update(COL, req.params.id, { aiAnalysis: queuedRecord.aiAnalysis });
    await queueAnalyzeSource(queuedRecord);
    res.json({ status: 'pending', analysisRunId });
    return;
  }

  const retryResetAt = new Date().toISOString();
  resetCrawlerOpsTaskForExplicitRetry({ recordId: req.params.id, tenantId: recordTenantId, userId, usesSourceQueue: false, now: retryResetAt });
  await store.update(COL, req.params.id, {
    status: 'pending',
    aiAnalysis: JSON.stringify(videoAnalysisRetryQueuePatch(previous, {
      analysisMode, analysisRunId, queueKind: 'stored_video', queuedAt: retryResetAt, userId,
    })),
  });
  if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(req.params.id);

  res.status(202).json({ status: 'pending', analysisRunId });
});

// ─── Internal: async AI analysis ─────────────────────────────────────────────
async function triggerVideoAnalysis(
  recordId: string,
  filename: string | undefined,
  mimeType: string | undefined,
  _userId: string,
  expectedRunId?: string,
): Promise<void> {
  if (!filename) {
    await store.update(COL, recordId, { status: 'failed' });
    return;
  }

  let tempPath = '';
  let runId = expectedRunId || '';
  try {
    const record = await store.getById<Record<string, unknown>>(COL, recordId);
    const previousRecordAnalysis = parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {});
    if (expectedRunId && String(previousRecordAnalysis.analysisRunId || '') !== expectedRunId) {
      console.warn(`[videos] stale queued analysis skipped for ${recordId}: ${expectedRunId}`);
      return;
    }
    const localReference = localReferenceVideoPath(filename, String(record?.tenantId || ''));
    let dl = localReference && fs.existsSync(localReference)
      ? { buf: fs.readFileSync(localReference), contentType: 'video/mp4' }
      : previousRecordAnalysis.videoObjectKey
      ? await objectStorageDownload(String(previousRecordAnalysis.videoObjectKey))
      : await fetchFile(COL, recordId, filename);
    // COS/S3-compatible storage can briefly return an empty/not-found response
    // while HEAD succeeds (gateway propagation or a transient upstream miss).
    // Retry the same immutable object key twice before surfacing a real failure.
    if (!dl && previousRecordAnalysis.videoObjectKey) {
      for (const delayMs of [500, 1500]) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
        dl = await objectStorageDownload(String(previousRecordAnalysis.videoObjectKey));
        if (dl) break;
      }
    }
    if (!dl) throw new Error('video file fetch failed');

    const latestBeforeStart = await store.getById<Record<string, unknown>>(COL, recordId);
    const latestBeforeStartAnalysis = parseJsonRecord<Record<string, unknown>>(latestBeforeStart?.aiAnalysis, {});
    if (expectedRunId && String(latestBeforeStartAnalysis.analysisRunId || '') !== expectedRunId) {
      console.warn(`[videos] stale fetched analysis skipped for ${recordId}: ${expectedRunId}`);
      return;
    }

    if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    tempPath = path.join(ANALYSIS_DIR, `upload-${recordId}-${Date.now()}.${mimeFromPath(filename).split('/').pop() || 'mp4'}`);
    fs.writeFileSync(tempPath, dl.buf);
    const previous = latestBeforeStartAnalysis;
    runId = runId || String(previous.analysisRunId || randomUUID());
    const modelStartedAt = new Date().toISOString();
    await store.update(COL, recordId, {
      status: 'pending' as VideoStatus,
      aiAnalysis: JSON.stringify({
        ...previous,
        manualVideoUploadStatus: 'analyzing',
        downloadStatus: 'uploaded',
        videoFetchStatus: 'manual_upload',
        geminiStatus: 'analyzing',
        analysisSource: 'gemini-upload-video',
        geminiStartedAt: modelStartedAt,
        analysisStage: 'analyzing',
        analysisStageUpdatedAt: modelStartedAt,
        analysisRunId: runId,
        analysisRunMode: previous.requestedAnalysisMode === 'strategy' ? 'strategy' : 'exact',
      }),
    });
    updateVideoAdminAlertByRecordId(recordId, {
      statusLabel: '已上传/分析中',
      manualUploadStatus: 'analyzing',
      error: '缺失视频已补充，Gemini 视频级分析处理中。',
    });
    const result = await analyzeDownloadedVideoWithFallback({
      filePath: tempPath,
      mimeType: mimeType ?? dl.contentType,
      title: String(record?.title || ''),
      platform: record?.platform as Platform | undefined,
      duration: Number(record?.duration || 0),
      tags: parseJsonRecord<string[]>(record?.tags, []),
      sourceLabel: 'gemini-upload-video',
      videoId: recordId,
      tenantId: String(record?.tenantId || ''),
      analysisMode: previous.requestedAnalysisMode === 'strategy' ? 'strategy' : 'exact',
      analysisRunId: runId,
      videoObjectKey: String(previous.videoObjectKey || record?.videoFileId || ''),
    });
    if (previous.requestedAnalysisMode !== 'strategy') {
      const evidenceStartedAt = new Date().toISOString();
      const beforeEvidence = await store.getById<Record<string, unknown>>(COL, recordId);
      const beforeEvidenceAnalysis = parseJsonRecord<Record<string, unknown>>(beforeEvidence?.aiAnalysis, {});
      await store.update(COL, recordId, {
        aiAnalysis: JSON.stringify({
          ...beforeEvidenceAnalysis,
          analysisStage: 'extracting_evidence',
          analysisStageUpdatedAt: evidenceStartedAt,
          analysisEvidenceStartedAt: evidenceStartedAt,
        }),
      });
      result.analysis = await persistExactShotEvidence(recordId, tempPath, result.analysis);
    }
    cleanupTempVideo(tempPath);
    tempPath = '';
    const latest = await store.getById<Record<string, unknown>>(COL, recordId);
    const latestAnalysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? record?.aiAnalysis, {});
    if (String(latestAnalysis.analysisRunId || '') !== runId) {
      console.warn(`[videos] stale analysis success ignored for ${recordId}: ${runId}`);
      return;
    }

    const measuredDuration = exactSourceClockDuration(result.analysis, runId);
    await store.update(COL, recordId, {
      aiAnalysis: JSON.stringify({
        ...latestAnalysis,
        ...videoLevelSuccessPatch({
          analysis: result.analysis,
          source: result.source,
          videoFetchStatus: 'manual_upload',
          extra: { manualVideoUploadStatus: 'analyzed', analysisMode: previous.requestedAnalysisMode === 'strategy' ? 'strategy' : 'exact', requestedAnalysisMode: undefined },
        }),
      }),
      status: 'analyzed',
      ...(measuredDuration ? { duration: measuredDuration } : {}),
    });
    updateVideoAdminAlertByRecordId(recordId, {
      statusLabel: '已上传/分析完成',
      manualUploadStatus: 'analyzed',
      error: '补充视频已完成 Gemini 视频级分析，已可进入灵感大屏展示。',
    });
    console.log(`[videos] analyzed ${recordId}`);
  } catch (e) {
    console.error(`[videos] analysis failed for ${recordId}:`, e);
    if (tempPath) cleanupTempVideo(tempPath);
    const record = await store.getById<Record<string, unknown>>(COL, recordId);
    const previous = parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {});
    if (runId && String(previous.analysisRunId || '') !== runId) {
      console.warn(`[videos] stale analysis failure ignored for ${recordId}: ${runId}`);
      return;
    }
    const compactError = compactVideoPipelineError(e instanceof Error ? e.message : e);
    const failedAt = new Date().toISOString();
    await store.update(COL, recordId, {
      status: 'analyzed' as VideoStatus,
      aiAnalysis: JSON.stringify(queuedVideoAnalysisFailurePatch(previous, compactError, failedAt)),
    });
    updateVideoAdminAlertByRecordId(recordId, {
      statusLabel: '上传后分析失败',
      manualUploadStatus: 'failed',
      error: compactError,
    });
  }
}

export async function attachManualVideoUploadAndQueue(input: {
  recordId: string;
  videoBase64: string;
  mimeType?: string;
  filename?: string;
  uploadedBy?: string;
}): Promise<{ recordId: string; filename: string; status: 'queued' }> {
  const record = await store.getById<Record<string, unknown>>(COL, input.recordId);
  if (!record) throw new Error('Video record not found');

  const mimeType = input.mimeType?.trim() || mimeFromPath(input.filename || 'video.mp4');
  if (!/^video\//i.test(mimeType)) throw new Error('Only video files can be uploaded');
  const raw = input.videoBase64.replace(/^data:[^,]+,/, '');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('Video file is empty');
  if (buf.length > MANUAL_UPLOAD_MAX_BYTES) throw new Error('视频压缩后仍超过 10MB，请换更短的视频或降低清晰度后再上传。');

  const ext = safeVideoExtension(input.filename, mimeType);
  const previewBuf = await compressVideoBufferForPocketBase(buf, ext);
  const storedFilename = await uploadCrawlerCosObject(input.recordId, 'video', previewBuf, 'video/mp4');
  if (!storedFilename) throw new Error('Video upload failed');

  const previous = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const analysisRunId = randomUUID();
  const queuedAt = new Date().toISOString();
  await store.update(COL, input.recordId, {
    videoFileId: storedFilename,
    status: 'pending' as VideoStatus,
    aiAnalysis: JSON.stringify({
      ...previous,
      videoStorage: 'cos',
      videoObjectKey: storedFilename,
      manualVideoUploadedAt: queuedAt,
      manualVideoUploadedBy: input.uploadedBy,
      manualVideoUploadStatus: 'queued',
      requestedAnalysisMode: 'exact',
      analysisRunId,
      analysisRunMode: 'exact',
      analysisQueueKind: 'stored_video',
      analysisQueueState: 'queued',
      analysisQueuedAt: queuedAt,
      analysisStage: 'queued',
      analysisStageUpdatedAt: queuedAt,
      downloadStatus: 'uploaded',
      videoFetchStatus: 'manual_upload',
      geminiStatus: 'queued',
      analysisSource: 'gemini-upload-video',
      userVisible: false,
      adminOnlyVideoFailure: undefined,
      videoLevelFailureStatus: undefined,
      manualRequiredReason: undefined,
      downloadError: undefined,
      analysisError: undefined,
    }),
  });

  updateVideoAdminAlertByRecordId(input.recordId, {
    statusLabel: '已上传/分析排队',
    manualUploadStatus: 'queued',
    manualUploadedAt: new Date().toISOString(),
    manualUploadRecordId: input.recordId,
    error: '缺失视频已补充，等待 Gemini 视频级分析。',
  });

  if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(input.recordId);

  return { recordId: input.recordId, filename: storedFilename, status: 'queued' };
}

async function handleAnalyzeSource(
  req: Request,
  res: Response,
  input: { id?: string; sourceUrl?: string; title?: string; platform?: Platform; async?: boolean },
): Promise<void> {
  const { tenantId } = res.locals as AuthLocals;
  try {
    let record: Record<string, unknown> | null = null;
    if (input.id) {
      record = await store.getById(COL, input.id);
      if (!record || (record.tenantId !== tenantId && !await requireAdminUser(req))) {
        res.status(404).json({ error: 'Video record not found' });
        return;
      }
    }

    const source = resolvedPublicVideoSource(record, input);
    if (!source) {
      res.status(400).json({ error: '只允许当前记录绑定的 YouTube、TikTok、Instagram 或 Facebook HTTPS 单条视频链接' });
      return;
    }
    const job = {
      record,
      sourceUrl: source.sourceUrl,
      title: String(input.title || record?.title || `${source.platform}-video`),
      platform: source.platform,
    };

    if (input.async && record?.id) {
      if (!shouldQueueVideoAnalysis(record)) {
        res.status(202).json({ ok: true, status: 'already_queued', id: record.id });
        return;
      }
      await queueAnalyzeSource(record, job);
      res.status(202).json({ ok: true, status: 'queued', id: record.id });
      return;
    }

    const analysis = await analyzeSourceVideoJob(job);
    res.status(200).json({ ok: true, analysis });
  } catch (e) {
    console.error('[videos] analyze-source failed:', e);
    res.status(502).json({ error: e instanceof Error ? e.message : 'Video analysis failed' });
  }
}

export async function queueAnalyzeSource(
  record: Record<string, unknown>,
  job?: { record: Record<string, unknown> | null; sourceUrl: string; title: string; platform: Platform },
): Promise<void> {
  const remoteUrl = String(job?.sourceUrl || record.sourceUrl || '').trim();
  const platform = (job?.platform || record.platform || inferPlatformFromUrl(remoteUrl)) as Platform;
  const analysis = parseJsonRecord(record.aiAnalysis, {});
  const queuedAt = new Date().toISOString();
  const queuedRecord = await store.update(COL, String(record.id), {
    status: 'pending' as VideoStatus,
    aiAnalysis: JSON.stringify({
      ...analysis,
      downloadStatus: 'queued',
      videoFetchStatus: 'queued',
      geminiStatus: 'waiting_for_video',
      analysisSource: 'gemini-temp-video',
      analysisError: undefined,
      downloadError: undefined,
      analysisQueueKind: 'source_url',
      analysisQueueState: 'queued',
      analysisQueuedAt: queuedAt,
      analysisStage: 'queued',
      analysisStageUpdatedAt: queuedAt,
    }),
  });
  if (!queuedRecord) throw new Error('source_analysis_queue_marker_persist_failed');
  let opsTask: CrawlerOpsTask | null = null;
  try {
    opsTask = enqueueCrawlerOpsTask({
      recordId: String(record.id),
      tenantId: String(record.tenantId || '').trim() || undefined,
      platform,
      sourceUrl: remoteUrl,
      title: String(job?.title || record.title || `${platform}-video`),
      reason: 'analysis_requested',
      forceQueue: true,
    });
    const acceptedAt = new Date().toISOString();
    const latest = await store.getById<Record<string, unknown>>(COL, String(record.id));
    const latestAnalysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis, analysis);
    const receiptRecord = await store.update(COL, String(record.id), {
      status: 'pending' as VideoStatus,
      aiAnalysis: JSON.stringify({
        ...latestAnalysis,
        ...sourceAnalysisQueueReceiptPatch(opsTask, acceptedAt),
      }),
    });
    if (!receiptRecord) throw new Error('source_analysis_queue_receipt_persist_failed');
  } catch (error) {
    const failedAt = new Date().toISOString();
    const compactError = compactVideoPipelineError(error instanceof Error ? error.message : error);
    if (opsTask?.id) {
      updateCrawlerOpsTask(opsTask.id, { status: 'failed', reason: 'analysis_queue_receipt_failed', lastError: compactError, updatedAt: failedAt });
    }
    try {
      const latest = await store.getById<Record<string, unknown>>(COL, String(record.id));
      const latestAnalysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis, analysis);
      const failureRecord = await store.update(COL, String(record.id), {
        status: latestAnalysis.gemini || latestAnalysis.analysisQuality === 'video' ? 'analyzed' as VideoStatus : 'failed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...latestAnalysis,
          ...sourceAnalysisQueueFailurePatch(compactError || 'crawler_ops_enqueue_failed', failedAt),
        }),
      });
      if (!failureRecord) throw new Error('source_analysis_queue_failure_persist_failed');
    } catch (persistError) {
      console.error('[videos] failed to persist source analysis queue failure:', persistError);
    }
    throw error;
  }
  if (analysisRunsInWorkerProcess()) return;
  void analyzeSourceVideoJob(job || {
    record,
    sourceUrl: remoteUrl,
    title: String(record.title || `${platform}-video`),
    platform,
  }).catch((e) => {
    console.warn('[videos] async analyze-source failed:', e instanceof Error ? e.message : e);
  });
}

/** Internal service entry used by task-scoped viral replication. It upgrades
 * an existing tenant-owned trend record to full-video exact analysis without
 * exposing the admin reanalyze route or trusting a caller-supplied tenant. */
export async function queueExactSourceAnalysisForTenant(input: {
  tenantId: string;
  recordId: string;
}): Promise<'already_ready' | 'queued'> {
  const record = await store.getById<Record<string, unknown>>(COL, input.recordId);
  if (!record || String(record.tenantId || '') !== input.tenantId) throw new Error('Trend video not found');
  const previous = videoAnalysisOf(record);
  const admission = hasCompletedExactVideoEvidence(previous)
    ? productionReferenceAdmission(benchmarkAnalysisForRecord(record, previous))
    : null;
  if (admission?.ready) {
    // An earlier queue attempt could mark a local:// upload as
    // waiting_for_video before failing public-URL validation. Restore the
    // completed exact evidence in place; keep its run id and source hash so
    // existing Director review and verified speech remain version-bound.
    if (String(record.sourceUrl || '').startsWith('local://')
      && (previous.requestedAnalysisMode === 'exact'
        || ['queued', 'waiting_for_video', 'analyzing'].includes(String(previous.geminiStatus || '')))) {
      await store.update(COL, input.recordId, {
        status: 'analyzed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...previous,
          requestedAnalysisMode: undefined,
          geminiStatus: previous.analysisQuality === 'video_review_required' ? 'needs_review' : 'analyzed',
          analysisError: undefined,
          downloadError: undefined,
        }),
      });
    }
    return 'already_ready';
  }
  if (String(previous.requestedAnalysisMode) === 'exact'
    && ['queued', 'waiting_for_video', 'analyzing'].includes(String(previous.geminiStatus || ''))
    && !(previous.geminiStatus === 'waiting_for_video' && previous.analysisError)) {
    return 'queued';
  }
  const analysisRunId = randomUUID();
  const nextAnalysis = {
    ...previous,
    requestedAnalysisMode: 'exact',
    analysisRunId,
    analysisRunMode: 'exact',
    geminiStatus: 'queued',
    analysisQueuedAt: new Date().toISOString(),
    analysisError: undefined,
  };
  await store.update(COL, input.recordId, {
    status: 'pending' as VideoStatus,
    aiAnalysis: JSON.stringify(nextAnalysis),
  });
  if (record.videoFileId) {
    if (!analysisRunsInWorkerProcess()) startQueuedLocalAnalysis(input.recordId);
  } else {
    await queueAnalyzeSource({ ...record, aiAnalysis: JSON.stringify(nextAnalysis) });
  }
  return 'queued';
}

async function enqueueCrawledRecordsForAnalysis(records: unknown[]): Promise<void> {
  for (const raw of records) {
    const record = raw as Record<string, unknown>;
    const id = String(record.id || '');
    if (!id) continue;
    const latest = await store.getById(COL, id);
    if (!latest || !shouldQueueVideoAnalysis(latest)) continue;
    await queueAnalyzeSource(latest);
  }
}


async function recrawlImagePostThumbnail(record: Record<string, unknown>): Promise<string> {
  const platform = String(record.platform || '') as Platform;
  const sourceUrl = String(record.sourceUrl || '').trim();
  if (!sourceUrl) return '';

  // Instagram 的公开 media 端点会重定向到当前有效的 CDN 图片，不需要登录态，
  // 可用于恢复数据库仍在但本地缓存文件已丢失的历史图文。
  if (platform === 'instagram' && /instagram\.com\/p\/[^/?#]+\/?$/i.test(sourceUrl)) {
    return `${sourceUrl.replace(/\/$/, '')}/media/?size=l`;
  }
  if (!process.env.APIFY_TOKEN?.trim()) return '';

  try {
    if (platform === 'instagram') {
      const actor = process.env.APIFY_INSTAGRAM_ACTOR?.trim() || 'apify/instagram-scraper';
      const rows = await runApifyActorDatasetItems(actor, {
        directUrls: [sourceUrl],
        resultsType: 'posts',
        resultsLimit: 1,
        addParentData: false,
      }, Number(process.env.APIFY_TIMEOUT_MS || 240_000), 'Instagram thumbnail repair');
      return firstImageUrl(rows.map(item => [item.displayUrl, item.images, item]));
    }
  } catch (error) {
    console.warn('[videos] image post thumbnail recrawl failed:', error instanceof Error ? error.message : error);
  }
  return '';
}

export async function repairMissingCrawledThumbnails(records: unknown[], limit = 5): Promise<number> {
  const normalizedRecords = records.map(raw => raw as Record<string, unknown>);
  const candidates = normalizedRecords
    .filter(record => ['youtube', 'tiktok', 'facebook', 'instagram'].includes(String(record.platform || '')))
    .filter(record => /^https?:\/\//i.test(String(record.sourceUrl || '')))
    .filter(record => {
      const thumb = normalizeThumbnailUrl(String(record.thumbnailUrl || ''));
      const stableYouTubeThumbnail = record.platform === 'youtube'
        ? youtubeThumbnailFromUrl(String(record.sourceUrl || ''))
        : '';
      return !thumb
        || isMissingLocalThumbnail(thumb)
        || isSignedExpiringThumbnail(thumb)
        || Boolean(stableYouTubeThumbnail && thumb !== stableYouTubeThumbnail)
        || canonicalSourceUrl(record.platform as Platform, String(record.sourceUrl || ''), '') !== String(record.sourceUrl || '');
    })
    .slice(0, Math.max(1, limit));

  let repaired = 0;
  for (const record of candidates) {
    try {
      const platform = record.platform as Platform;
      const existingSourceUrl = String(record.sourceUrl || '');
      const canonicalUrl = canonicalSourceUrl(platform, existingSourceUrl, '');
      const existingThumbnail = normalizeThumbnailUrl(String(record.thumbnailUrl || ''));
      const usableExistingThumbnail = isMissingLocalThumbnail(existingThumbnail) ? '' : existingThumbnail;
      // YouTube may return hq720/custom thumbnails that later become 404.
      // The standard hqdefault endpoint is stable for public videos, so always
      // canonicalize old YouTube thumbnail URLs during opportunistic repair.
      let thumbnailUrl = platform === 'youtube'
        ? youtubeThumbnailFromUrl(canonicalUrl)
        : thumbnailForPlatform(platform, canonicalUrl, usableExistingThumbnail);
      let sourceUrl = canonicalUrl;
      const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
      if (!thumbnailUrl && analysis.contentFormat === 'image') {
        const refreshedImage = await recrawlImagePostThumbnail(record);
        if (refreshedImage) {
          const local = await cacheThumbnailLocally(String(record.id), refreshedImage);
          thumbnailUrl = local || refreshedImage;
        }
      }
      if (!thumbnailUrl || isExpiredSignedThumbnail(thumbnailUrl)) {
        const meta = await crawlYtDlpMetadata(platform, sourceUrl, String(record.title || platform));
        sourceUrl = meta.sourceUrl || sourceUrl;
        thumbnailUrl = meta.thumbnailUrl || thumbnailUrl;
      }
      if (isSignedExpiringThumbnail(thumbnailUrl) && !isExpiredSignedThumbnail(thumbnailUrl)) {
        const local = await cacheThumbnailLocally(String(record.id), thumbnailUrl);
        if (local) thumbnailUrl = local;
      }
      if (thumbnailUrl && (sourceUrl !== existingSourceUrl || thumbnailUrl !== String(record.thumbnailUrl || ''))) {
        await store.update(COL, String(record.id), { sourceUrl, thumbnailUrl });
        repaired += 1;
      }
    } catch (e) {
      console.warn('[videos] thumbnail repair skipped:', e instanceof Error ? e.message : e);
    }
  }
  return repaired;
}

// 提交全片精确分析时会写入 requestedAnalysisMode，而清掉它的只有两条路径：分析成功，
// 或 persistManualVideoFailure 记录失败。两者都没走到时（服务重启、手动上传的分析没触发、
// 运维任务丢失），标记就永远留在记录上——前端「精确分析生成中…」按钮是 disabled 的，
// 用户连重试都点不了。超时后主动释放，让它退回可重试状态。
const EXACT_ANALYSIS_STALL_MS = Math.max(
  5 * 60_000,
  Number(process.env.EXACT_ANALYSIS_STALL_MS || 5 * 60_000),
);

// 卡住的记录是少数，但分布在整个库里，只扫第一页会漏。全量翻页，靠节流控制开销。
const lastStallSweepAt = new Map<string, number>();

async function releaseStalledExactAnalysis(forceInterrupted = false, tenantId?: string): Promise<number> {
  const now = Date.now();
  const sweepKey = `${currentDataAuthority() || 'default'}:${tenantId || '__global__'}`;
  const lastSweep = lastStallSweepAt.get(sweepKey) || 0;
  if (!forceInterrupted && now - lastSweep < Math.max(60_000, Math.floor(EXACT_ANALYSIS_STALL_MS / 6))) return 0;
  lastStallSweepAt.set(sweepKey, now);

  const candidates: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const result = await store.list<Record<string, unknown>>(COL, { where: tenantId ? { tenantId } : undefined, page, perPage: 500 });
    for (const record of result.items) {
      if (parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {}).requestedAnalysisMode === 'exact') {
        candidates.push(record);
      }
    }
    if (page >= result.totalPages || page >= 20) break;
    page += 1;
  }
  if (!candidates.length) return 0;

  // 运维队列里还在排队/处理中的不抢，交给 worker 继续跑完。
  const inFlight = process.env.CRAWLER_OPS_WORKER_ENABLED === '0'
    ? new Set<string>()
    : new Set(loadCrawlerOpsTasks()
      .filter(task => !tenantId || task.tenantId === tenantId || candidates.some(record => String(record.id || '') === task.recordId))
      .filter(task => ['queued', 'pushed', 'processing'].includes(task.status))
      .map(task => task.recordId));

  let released = 0;
  for (const record of candidates) {
    const recordId = String(record.id || '');
    if (!recordId || inFlight.has(recordId) || activeAnalysisRecords.has(recordId) || durableAnalysisRecords.has(recordId)) continue;
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    // Local/material jobs are recoverable by the durable analysis Worker.
    // Legacy maintenance_exact markers never entered that queue. Keeping them
    // here produced a permanent false “分析中” state after the script exited.
    if (hasDurableExactAnalysisOwner(analysis)) continue;
    // Startup bypasses only the sweep throttle. It does not make a recent
    // maintenance script stale: without a queue lease we still require an old
    // heartbeat/activity timestamp before releasing the marker.
    if (!isOwnerlessExactAnalysisStale({
      analysis,
      recordUpdatedAt: record.maintenanceHeartbeatAt || record.updated || record.updatedAt,
      nowMs: now,
      stallMs: EXACT_ANALYSIS_STALL_MS,
    })) continue;
    const failedAt = new Date().toISOString();
    await store.update(COL, recordId, {
      status: (analysis.gemini ? 'analyzed' : 'failed') as VideoStatus,
      aiAnalysis: JSON.stringify({
        ...analysis,
        requestedAnalysisMode: undefined,
        analysisQueueState: 'failed',
        analysisStage: 'failed',
        analysisStageUpdatedAt: failedAt,
        analysisFailedAt: failedAt,
        analysisRetryable: true,
        // 超时的升级不能冒充已完成的精确分析。
        analysisMode: analysis.analysisMode === 'exact' ? 'exact' : 'strategy',
        geminiStatus: 'analysis_retryable',
        videoLevelFailureStatus: analysis.videoLevelFailureStatus || '后台分析中断，可重试或恢复',
        analysisError: analysis.analysisError || 'exact_analysis_stalled',
      }),
    });
    released += 1;
    console.warn(`[videos] exact analysis ${forceInterrupted ? 'interrupted by restart' : 'stalled'}, released for retry: ${recordId}`);
  }
  return released;
}

async function releaseStalledExactAnalysisAcrossAuthorities(forceInterrupted = false): Promise<number> {
  let released = await releaseStalledExactAnalysis(forceInterrupted);
  // Local demo accounts and PocketBase accounts can coexist in development.
  // A process-level sweep has no request authority, so a healthy PocketBase
  // connection used to make local JSON records invisible to recovery and left
  // their UI permanently stuck on “分析中”. Sweep the explicitly enabled local
  // authority as a second, isolated data source.
  if (localFallbacksEnabled() && currentDataAuthority() !== 'local') {
    released += await runWithDataAuthority('local', () => releaseStalledExactAnalysis(forceInterrupted));
  }
  return released;
}

export async function backfillMissingCrawledMedia(records: unknown[]): Promise<void> {
  const normalizedRecords = records
    .map(raw => raw as Record<string, unknown>)
    .filter(record => recordContentFormat(record) === 'video');
  for (const record of normalizedRecords) {
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    if (record.videoFileId && !analysis.videoStorage) {
      await store.update(COL, String(record.id), {
        aiAnalysis: JSON.stringify({ ...analysis, videoStorage: 'pocketbase' }),
      });
      record.aiAnalysis = JSON.stringify({ ...analysis, videoStorage: 'pocketbase' });
    }
  }
  const storageCandidates = normalizedRecords.filter(record => {
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    const recordId = String(record.id || '');
    const retryAfter = pocketBaseBackfillFailures.get(recordId) || 0;
    return !record.videoFileId
      && !analysis.videoObjectKey
      && /^https?:\/\//i.test(String(record.sourceUrl || ''))
      && Date.now() >= retryAfter
      && !['downloading', 'queued', 'failed', 'download_failed', 'unavailable', 'metadata_only'].includes(String(analysis.downloadStatus || ''));
  }).slice(0, 3);
  for (const record of storageCandidates) {
    const recordId = String(record.id || '');
    void downloadMaterialJob({ record, tenantId: String(record.tenantId || ''), sourceUrl: String(record.sourceUrl), title: String(record.title || '爬取视频'), platform: record.platform as Platform, duration: Number(record.duration || 0) })
      .then(() => pocketBaseBackfillFailures.delete(recordId))
      .catch(error => {
        // Failed public downloads should not be hammered every minute. Manual retry remains available.
        pocketBaseBackfillFailures.set(recordId, Date.now() + 6 * 60 * 60 * 1000);
        console.warn('[videos] PocketBase video backfill failed:', error instanceof Error ? error.message : error);
      });
  }
  await repairMissingCrawledThumbnails(normalizedRecords, 5);
}

let pocketBaseBackfillTimer: NodeJS.Timeout | null = null;
let pocketBaseBackfillRunning = false;
export function initPocketBaseVideoBackfill(): void {
  // Backfill is an operational migration, not a normal runtime responsibility.
  // It is opt-in so local/admin/tenant dashboards cannot accidentally start a
  // full-library media conversion merely by starting the API.
  if (pocketBaseBackfillTimer || process.env.PB_VIDEO_BACKFILL_ENABLED !== 'true') return;
  const run = async () => {
    if (pocketBaseBackfillRunning) return;
    pocketBaseBackfillRunning = true;
    try {
      const first = await store.list<Record<string, unknown>>(COL, { sort: '-crawledAt', page: 1, perPage: 100 });
      const records = [...first.items];
      for (let page = 2; page <= first.totalPages; page += 1) {
        const next = await store.list<Record<string, unknown>>(COL, { sort: '-crawledAt', page, perPage: 100 });
        records.push(...next.items);
      }
      await backfillMissingCrawledMedia(records);
    } catch (error) {
      console.warn('[videos] scheduled PocketBase backfill failed:', error instanceof Error ? error.message : error);
    } finally {
      pocketBaseBackfillRunning = false;
    }
  };
  void run();
  pocketBaseBackfillTimer = setInterval(() => void run(), Math.max(30_000, Number(process.env.PB_VIDEO_BACKFILL_INTERVAL_MS || 60_000)));
  pocketBaseBackfillTimer.unref();
}

function shouldQueueVideoAnalysis(record: Record<string, unknown>): boolean {
  const sourceUrl = String(record.sourceUrl || '').trim();
  if (!/^https?:\/\//i.test(sourceUrl)) return false;
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  if (analysis.analysisPausedAt || analysis.geminiStatus === 'paused') return false;
  const status = String(analysis.downloadStatus || '');
  const videoFetchStatus = String(analysis.videoFetchStatus || '');
  const geminiStatus = String(analysis.geminiStatus || '');
  if (['metadata_only', 'analyzed'].includes(status) || ['unavailable', 'url_failed', 'ops_failed'].includes(videoFetchStatus) || geminiStatus === 'metadata_fallback') return false;
  if (['queued', 'downloading', 'analyzing'].includes(status)) return false;
  if (analysis.analysisQuality === 'video' && status === 'analyzed') return false;
  const queuedAt = Date.parse(String(analysis.analysisQueuedAt || analysis.videoAnalysisAttemptedAt || ''));
  if (Number.isFinite(queuedAt) && Date.now() - queuedAt < 5 * 60 * 1000) return false;
  return true;
}

function resolvedPublicVideoSource(
  record: Record<string, unknown> | null,
  input: { sourceUrl?: string; platform?: Platform },
): ValidatedPublicVideoSource | null {
  return resolvePublicVideoSource({
    recordSourceUrl: record?.sourceUrl,
    recordPlatform: record?.platform,
    requestedSourceUrl: input.sourceUrl,
    requestedPlatform: input.platform,
  });
}

async function handleDownloadMaterial(
  req: Request,
  res: Response,
  input: { id?: string; sourceUrl?: string; title?: string; platform?: Platform; async?: boolean },
): Promise<void> {
  const { tenantId } = res.locals as AuthLocals;
  try {
    let record: Record<string, unknown> | null = null;
    if (input.id) {
      record = await store.getById(COL, input.id);
      if (!record || (record.tenantId !== tenantId && !await requireAdminUser(req))) {
        res.status(404).json({ error: 'Video record not found' });
        return;
      }
    }

    if (record) {
      const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
      const linkedMaterialId = String(analysis.materialId || '').trim();
      const materials = loadMaterials();
      const linkedMaterial = materials.find(item => item.id === linkedMaterialId && item.tenantId === tenantId);
      if (linkedMaterial) {
        linkedMaterial.pinned = true;
        persistMaterials(materials);
        res.status(200).json({ ok: true, material: linkedMaterial });
        return;
      }

      const hasStoredVideo = Boolean(analysis.videoObjectKey || record.videoFileId);
      if (hasStoredVideo) {
        const material = await copyStoredCrawlerVideoToMaterial({
          record,
          tenantId,
          title: String(input.title || record.title || `${record.platform || 'tiktok'}-video`),
          platform: (input.platform || record.platform || 'tiktok') as Platform,
          duration: Number(record.duration || 0),
        });
        res.status(201).json({ ok: true, material });
        return;
      }
    }

    const source = resolvedPublicVideoSource(record, input);
    if (!source) {
      res.status(400).json({ error: '只允许当前记录绑定的 YouTube、TikTok、Instagram 或 Facebook HTTPS 单条视频链接' });
      return;
    }
    const job = {
      record,
      tenantId,
      sourceUrl: source.sourceUrl,
      title: String(input.title || record?.title || `${source.platform}-video`),
      platform: source.platform,
      duration: Number(record?.duration || 0),
    };

    if (input.async && record?.id) {
      const analysis = parseJsonRecord(record.aiAnalysis, {});
      await store.update(COL, String(record.id), {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({ ...analysis, downloadStatus: 'queued', downloadQueuedAt: new Date().toISOString() }),
      });
      void downloadMaterialJob(job).catch((e) => {
        console.warn('[videos] async download-material failed:', e instanceof Error ? e.message : e);
      });
      res.status(202).json({ ok: true, status: 'queued', id: record.id });
      return;
    }

    const material = await downloadMaterialJob(job);
    res.status(201).json({ ok: true, material });
  } catch (e) {
    console.error('[videos] download-material failed:', e);
    res.status(502).json({ error: e instanceof Error ? e.message : 'Video download failed' });
  }
}

async function storedCrawlerVideo(record: Record<string, unknown>): Promise<{ buf: Buffer; contentType: string } | null> {
  const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
  const objectKey = String(analysis.videoObjectKey || '').trim();
  if (objectKey) {
    try {
      const stored = await objectStorageDownload(objectKey);
      if (stored?.buf.length) return { buf: stored.buf, contentType: stored.contentType || 'video/mp4' };
    } catch (error) {
      console.warn('[videos] stored favorite COS read failed, trying local/PocketBase copy:', error instanceof Error ? error.message : error);
    }
  }

  const filename = String(record.videoFileId || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const recordTenantId = String(record.tenantId || '').trim();
  if (filename && recordTenantId) {
    const expectedPrefix = `tenants/${recordTenantId}/`;
    const tenantRoot = path.resolve(MEDIA_DIR, 'tenants', recordTenantId);
    const localPath = path.resolve(MEDIA_DIR, filename);
    if (filename.startsWith(expectedPrefix)
      && localPath.startsWith(`${tenantRoot}${path.sep}`)
      && fs.existsSync(localPath)
      && fs.statSync(localPath).isFile()) {
      return { buf: fs.readFileSync(localPath), contentType: 'video/mp4' };
    }
  }
  if (!filename) return null;
  const stored = await fetchFile(COL, String(record.id || ''), filename);
  return stored?.buf.length ? { buf: stored.buf, contentType: stored.contentType || 'video/mp4' } : null;
}

async function copyStoredCrawlerVideoToMaterial(input: {
  record: Record<string, unknown>;
  tenantId: string;
  title: string;
  platform: Platform;
  duration: number;
}): Promise<Material> {
  const stored = await storedCrawlerVideo(input.record);
  if (!stored) throw new Error('站内视频文件暂不可用，请稍后重试');

  const tenantMediaDir = tenantAssetDir(MEDIA_DIR, input.tenantId);
  fs.mkdirSync(tenantMediaDir, { recursive: true });
  const id = randomUUID();
  const videoFile = `${id}.mp4`;
  const posterFile = `${id}.poster.jpg`;
  const videoPath = path.join(tenantMediaDir, videoFile);
  const posterPath = path.join(tenantMediaDir, posterFile);
  fs.writeFileSync(videoPath, stored.buf);
  const posterOk = await extractPoster(videoPath, posterPath, input.duration > 1 ? 1 : 0);
  const createdAt = new Date().toISOString();
  const sourceUrl = String(input.record.sourceUrl || `/api/overseas/videos/${encodeURIComponent(String(input.record.id || ''))}/media`);
  const base = buildDownloadedReferenceMaterial({
    id,
    tenantId: input.tenantId,
    name: safeMaterialName(input.title, input.platform),
    platform: input.platform,
    sourceUrl,
    duration: input.duration || await probeDuration(videoPath),
    size: humanSize(stored.buf.length),
    file: tenantAssetRelativePath(input.tenantId, videoFile),
    poster: posterOk ? tenantAssetRelativePath(input.tenantId, posterFile) : undefined,
    contentSha256: createHash('sha256').update(stored.buf).digest('hex'),
    createdAt,
  });
  const material = {
    ...base,
    provenance: {
      ...base.provenance,
      sourceRecordId: String(input.record.id || ''),
      copiedFromStoredVideo: true,
    },
  } as Material;
  persistMaterials([material, ...loadMaterials().filter(item => item.id !== material.id)]);

  const analysis = parseJsonRecord<Record<string, unknown>>(input.record.aiAnalysis, {});
  await store.update(COL, String(input.record.id || ''), {
    aiAnalysis: JSON.stringify({
      ...analysis,
      materialId: material.id,
      materialUrl: material.url,
      materialPoster: material.poster,
      downloadedAt: createdAt,
      downloadStatus: 'downloaded',
    }),
  });
  return material;
}

async function downloadMaterialJob(input: {
  record: Record<string, unknown> | null;
  tenantId: string;
  sourceUrl: string;
  title: string;
  platform: Platform;
  duration: number;
}): Promise<Material> {
  const source = validatePublicVideoSourceUrl(input.sourceUrl, input.platform);
  if (!source) throw new Error('unsafe_public_video_source');
  if (!input.tenantId.trim()) throw new Error('download_material_tenant_missing');
  return withDownloadSlot(() => downloadMaterialJobInner({ ...input, ...source }));
}

async function compressPocketBasePreview(sourcePath: string): Promise<string> {
  if (!ffmpegBin) throw new Error('ffmpeg is required for PocketBase preview compression');
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const outputPath = path.join(ANALYSIS_DIR, `pb-preview-${Date.now()}-${randomUUID()}.mp4`);
  await execFileAsync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
    '-vf', "scale='if(gt(iw,ih),480,-2)':'if(gt(iw,ih),-2,480)'",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '29', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart', '-y', outputPath,
  ], { timeout: 180_000 });
  // The production PocketBase request path rejects large multipart bodies even
  // when the collection file field itself allows 100 MiB. Keep long-video
  // previews below 6 MiB so the payload remains safe after multipart overhead.
  if (fs.statSync(outputPath).size > 6 * 1024 * 1024) {
    const compactPath = path.join(ANALYSIS_DIR, `pb-preview-compact-${Date.now()}-${randomUUID()}.mp4`);
    try {
      await execFileAsync(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
        '-vf', "scale='if(gt(iw,ih),160,-2)':'if(gt(iw,ih),-2,160)'",
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '32k', '-maxrate', '48k', '-bufsize', '96k',
        '-c:a', 'aac', '-b:a', '16k', '-ac', '1', '-movflags', '+faststart', '-y', compactPath,
      ], { timeout: 240_000 });
      fs.renameSync(compactPath, outputPath);
    } finally {
      try { if (fs.existsSync(compactPath)) fs.unlinkSync(compactPath); } catch { /* best effort */ }
    }
  }
  return outputPath;
}

async function compressVideoBufferForPocketBase(buf: Buffer, extension: string): Promise<Buffer> {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const sourcePath = path.join(ANALYSIS_DIR, `pb-source-${Date.now()}-${randomUUID()}.${extension.replace(/[^a-z0-9]/gi, '') || 'mp4'}`);
  fs.writeFileSync(sourcePath, buf);
  let previewPath = '';
  try { previewPath = await compressPocketBasePreview(sourcePath); return fs.readFileSync(previewPath); }
  finally { try { fs.unlinkSync(sourcePath); } catch { /* best effort */ } try { if (previewPath) fs.unlinkSync(previewPath); } catch { /* best effort */ } }
}

async function downloadMaterialJobInner(input: {
  record: Record<string, unknown> | null;
  tenantId: string;
  sourceUrl: string;
  title: string;
  platform: Platform;
  duration: number;
}): Promise<Material> {
  const recordId = input.record?.id ? String(input.record.id) : '';
  try {
    if (recordId) {
      const analysis = parseJsonRecord(input.record?.aiAnalysis, {});
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({ ...analysis, downloadStatus: 'downloading', downloadStartedAt: new Date().toISOString() }),
      });
    }

    const material = await downloadVideoToMaterial(input);
    if (recordId) {
      const localVideoPath = path.join(MEDIA_DIR, material.file);
      if (!fs.existsSync(localVideoPath)) throw new Error('Downloaded video file missing before PocketBase upload');
      const previewPath = await compressPocketBasePreview(localVideoPath);
      const pocketBaseFilename = await uploadCrawlerCosObject(recordId, 'video', fs.readFileSync(previewPath), 'video/mp4');
      try { fs.unlinkSync(previewPath); } catch { /* best effort */ }
      if (!pocketBaseFilename) throw new Error('PocketBase video persistence failed');
      const analysis = parseJsonRecord(input.record?.aiAnalysis, {});
      await store.update(COL, recordId, {
        videoFileId: pocketBaseFilename,
        thumbnailUrl: material.poster || String(input.record?.thumbnailUrl || ''),
        aiAnalysis: JSON.stringify({
          ...analysis,
          materialId: material.id,
          materialUrl: `/api/overseas/videos/${recordId}/media`,
          videoStorage: 'cos',
          videoObjectKey: pocketBaseFilename,
          materialPoster: material.poster,
          downloadedAt: material.createdAt,
          downloadStatus: 'downloaded',
        }),
      });
      void analyzeDownloadedMaterial(recordId, path.join(MEDIA_DIR, material.file), material);
    }
    return material;
    } catch (e) {
      const soft = softDownloadFailure(input.platform, e);
      if (recordId) {
        const analysis = parseJsonRecord(input.record?.aiAnalysis, {});
        await store.update(COL, recordId, {
        status: soft ? 'pending' as VideoStatus : 'failed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...analysis,
          downloadStatus: soft ? soft.status : 'failed',
          downloadError: e instanceof Error ? e.message : 'Video download failed',
        }),
      });
    }
    throw e;
  }
}

async function withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  while (activeDownloadJobs >= MAX_DOWNLOAD_JOBS) {
    await sleep(150);
  }
  activeDownloadJobs += 1;
  try {
    return await fn();
  } finally {
    activeDownloadJobs = Math.max(0, activeDownloadJobs - 1);
  }
}

const activeAnalysisRecords = new RecordWorkRegistry();
const durableAnalysisRecords = new AnalysisLeaseRegistry(path.join(__dirname, '../../data/analysis-locks'));

export type SourceAnalysisAdapters = {
  lease?: AnalysisLeaseRegistry;
  download?: typeof downloadVideoForAnalysis;
  analyze?: typeof analyzeDownloadedVideoWithFallback;
  compressPreview?: typeof compressPocketBasePreview;
};

export async function analyzeSourceVideoJob(input: {
  record: Record<string, unknown> | null;
  sourceUrl: string;
  title: string;
  platform: Platform;
  opsTaskId?: string;
  suppressOpsRequeue?: boolean;
  skipYoutubeUrlAnalysis?: boolean;
  suppressVisibleBackfill?: boolean;
  forceManualFailure?: boolean;
}, adapters: SourceAnalysisAdapters = {}): Promise<unknown> {
  const source = validatePublicVideoSourceUrl(input.sourceUrl, input.platform);
  if (!source) throw new Error('unsafe_public_video_source');
  input = { ...input, ...source };
  const key = String(input.record?.id || '');
  const execute = () => withDownloadSlot(() => analyzeSourceVideoJobInner(input, adapters));
  return key ? activeAnalysisRecords.run(key, () => (adapters.lease || durableAnalysisRecords).run(key, execute)) : execute();
}

async function analyzeSourceVideoJobInner(input: {
  record: Record<string, unknown> | null;
  sourceUrl: string;
  title: string;
  platform: Platform;
  opsTaskId?: string;
  suppressOpsRequeue?: boolean;
  skipYoutubeUrlAnalysis?: boolean;
  suppressVisibleBackfill?: boolean;
  forceManualFailure?: boolean;
}, adapters: SourceAnalysisAdapters = {}): Promise<unknown> {
  const recordId = input.record?.id ? String(input.record.id) : '';
  const inputAnalysis = parseJsonRecord<Record<string, unknown>>(input.record?.aiAnalysis, {});
  const requestedMode = inputAnalysis.requestedAnalysisMode;
  // A crawled video is useful to the director only after full-timeline shot
  // analysis. Keep the lighter mode solely for explicitly requested strategy
  // jobs; ordinary ingestion goes straight to the detailed pipeline.
  const analysisMode = requestedMode === 'strategy' ? 'strategy' : 'exact';
  const analysisRunId = String(inputAnalysis.analysisRunId || randomUUID());
  const stillOwnsRun = async (): Promise<boolean> => {
    if (!recordId) return true;
    const latest = await store.getById(COL, recordId);
    const latestAnalysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis, {});
    return !latestAnalysis.analysisRunId || String(latestAnalysis.analysisRunId) === analysisRunId;
  };
  let tempPath = '';
  try {
    if (!await stillOwnsRun()) return null;
    if (analysisMode !== 'exact' && input.platform === 'youtube' && !input.skipYoutubeUrlAnalysis && (input.forceManualFailure || !shouldUseQwenFirst())) {
      const direct = await tryAnalyzeYouTubeUrl(input, analysisRunId);
      if (!await stillOwnsRun()) return null;
      if (direct) return direct;
      if (input.forceManualFailure) {
        return persistMetadataFallbackAnalysis(input, 'youtube_url_failed', {
          downloadStatus: 'metadata_only',
          videoFetchStatus: 'url_failed',
          geminiStatus: 'metadata_fallback',
          crawlerOpsStatus: 'skipped',
        });
      }
      if (!youtubeDownloadFallbackSyncEnabled()) {
        if (youtubeDownloadFallbackEnabled()) scheduleYouTubeDownloadFallback(input);
        return persistMetadataFallbackAnalysis(input, 'youtube_url_failed', {
          downloadStatus: youtubeDownloadFallbackEnabled() ? 'download_retrying' : 'metadata_only',
          videoFetchStatus: youtubeDownloadFallbackEnabled() ? 'download_retrying' : 'url_failed',
          geminiStatus: 'metadata_fallback',
          crawlerOpsStatus: youtubeDownloadFallbackEnabled() ? 'background_downloading' : 'skipped',
        });
      }
    }

    if (recordId) {
      const latest = await store.getById(COL, recordId);
      const analysis: Record<string, unknown> = parseJsonRecord(latest?.aiAnalysis ?? input.record?.aiAnalysis, {} as Record<string, unknown>);
      if (analysis.analysisRunId && String(analysis.analysisRunId) !== analysisRunId) {
        console.warn(`[videos] stale source analysis skipped for ${recordId}: ${analysisRunId}`);
        return analysis.gemini || null;
      }
      const downloadStartedAt = new Date().toISOString();
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...analysis,
          downloadStatus: 'downloading',
          videoFetchStatus: 'downloading',
          geminiStatus: 'waiting_for_video',
          analysisSource: 'gemini-temp-video',
          downloadStartedAt,
          analysisStage: 'downloading',
          analysisStageUpdatedAt: downloadStartedAt,
          analysisRunId,
          analysisRunMode: analysisMode,
        }),
      });
    }

    const downloaded = await (adapters.download || downloadVideoForAnalysis)(input);
    tempPath = downloaded.filePath;
    // Precise analysis previously deleted its temporary file without attaching a
    // playable copy to the record.  Persist a compact preview first so a record
    // that passes video-level analysis is also guaranteed to play in-app.
    if (recordId) {
      if (!await stillOwnsRun()) return null;
      let previewPath = '';
      try {
        const previewTranscodeStartedAt = new Date().toISOString();
        const beforePreview = await store.getById(COL, recordId);
        const beforePreviewAnalysis = parseJsonRecord<Record<string, unknown>>(beforePreview?.aiAnalysis ?? input.record?.aiAnalysis, {});
        await store.update(COL, recordId, {
          status: 'pending' as VideoStatus,
          aiAnalysis: JSON.stringify({
            ...beforePreviewAnalysis,
            analysisStage: 'transcoding',
            analysisStageUpdatedAt: previewTranscodeStartedAt,
            previewTranscodeStartedAt,
          }),
        });
        previewPath = await (adapters.compressPreview || compressPocketBasePreview)(downloaded.filePath);
        const pocketBaseFilename = await uploadCrawlerCosObject(recordId, 'video', fs.readFileSync(previewPath), 'video/mp4');
        if (!pocketBaseFilename) throw new Error('PocketBase analysis preview persistence failed');
        const latest = await store.getById(COL, recordId);
        const analysis = parseJsonRecord(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
        await store.update(COL, recordId, {
          videoFileId: pocketBaseFilename,
          aiAnalysis: JSON.stringify({
            ...analysis,
            videoStorage: 'cos',
            videoObjectKey: pocketBaseFilename,
            materialUrl: `/api/overseas/videos/${recordId}/media`,
            previewPersistedAt: new Date().toISOString(),
          }),
        });
      } catch (error) {
        // A preview is an optional playback optimization. The source permalink
        // remains playable, and the downloaded file is still valid input for
        // Gemini. Do not turn a successful crawl into a failed analysis merely
        // because ffmpeg/COS preview persistence failed.
        console.warn('[videos] analysis preview persistence skipped:', error instanceof Error ? error.message : error);
      } finally {
        if (previewPath) {
          try { fs.unlinkSync(previewPath); } catch { /* best effort */ }
        }
      }
    }
    if (recordId) {
      if (!await stillOwnsRun()) return null;
      const latest = await store.getById(COL, recordId);
      const analysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
      const downloadedAt = new Date().toISOString();
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...analysis,
          downloadStatus: 'analyzing',
          videoFetchStatus: 'fetched',
          geminiStatus: 'queued',
          analysisSource: 'gemini-temp-video',
          analysisFileSize: humanSize(downloaded.size),
          downloadedAt,
          analysisStage: 'analyzing',
          analysisStageUpdatedAt: downloadedAt,
        }),
      });
    }

    if (recordId) {
      if (!await stillOwnsRun()) return null;
      const latest = await store.getById(COL, recordId);
      const analysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
      const modelStartedAt = new Date().toISOString();
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...analysis,
          downloadStatus: 'analyzing',
          videoFetchStatus: 'fetched',
          geminiStatus: 'analyzing',
          geminiStartedAt: modelStartedAt,
          analysisStage: 'analyzing',
          analysisStageUpdatedAt: modelStartedAt,
        }),
      });
    }

    const videoAnalysis = await (adapters.analyze || analyzeDownloadedVideoWithFallback)({
      filePath: downloaded.filePath,
      mimeType: downloaded.mimeType,
      title: String(input.record?.title || input.title),
      platform: input.platform,
      duration: Number(input.record?.duration || 0),
      views: String(input.record?.views || ''),
      tags: parseJsonRecord<string[]>(input.record?.tags, []),
      sourceLabel: 'gemini-temp-video',
      videoId: recordId,
      tenantId: String(input.record?.tenantId || ''),
      analysisMode,
      analysisRunId,
      videoObjectKey: String(parseJsonRecord<Record<string, unknown>>(input.record?.aiAnalysis, {}).videoObjectKey || input.record?.videoFileId || ''),
    });

    if (recordId && analysisMode === 'exact') {
      const evidenceStartedAt = new Date().toISOString();
      const beforeEvidence = await store.getById<Record<string, unknown>>(COL, recordId);
      const beforeEvidenceAnalysis = parseJsonRecord<Record<string, unknown>>(beforeEvidence?.aiAnalysis ?? input.record?.aiAnalysis, {});
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...beforeEvidenceAnalysis,
          analysisStage: 'extracting_evidence',
          analysisStageUpdatedAt: evidenceStartedAt,
          analysisEvidenceStartedAt: evidenceStartedAt,
        }),
      });
      videoAnalysis.analysis = await persistExactShotEvidence(recordId, downloaded.filePath, videoAnalysis.analysis);
    }

    if (recordId) {
      if (!await stillOwnsRun()) {
        console.warn(`[videos] stale source analysis success ignored for ${recordId}: ${analysisRunId}`);
        return videoAnalysis.analysis;
      }
      const latest = await store.getById(COL, recordId);
      const previous = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
      const measuredDuration = exactSourceClockDuration(videoAnalysis.analysis, analysisRunId);
      const persisted = await store.update(COL, recordId, {
        status: 'analyzed' as VideoStatus,
        ...(measuredDuration ? { duration: measuredDuration } : {}),
        aiAnalysis: JSON.stringify({
          ...previous,
          ...videoLevelSuccessPatch({
            analysis: videoAnalysis.analysis,
            source: videoAnalysis.source,
            videoFetchStatus: 'fetched',
            extra: { tempVideoDeleted: true, analysisMode, requestedAnalysisMode: undefined },
          }),
        }),
      });
      if (!persisted) throw new Error('video_analysis_writeback_failed');
    }
    return videoAnalysis.analysis;
  } catch (e) {
    const soft = softDownloadFailure(input.platform, e);
    const errorMessage = e instanceof Error ? e.message : 'Video download failed';
    const nonRetryableFetch = isNonRetryableVideoFetch(input.platform, errorMessage)
      || isTikTokUnusableWithoutVideoFallback(input.platform, errorMessage, input.record);
    const forceManualFailure = input.forceManualFailure === true;
    const fallback = metadataFallbackAnalysis({
      platform: input.platform,
      title: String(input.record?.title || input.title),
      duration: Number(input.record?.duration || 0),
      views: String(parseJsonRecord<Record<string, unknown>>(input.record?.aiAnalysis, {}).views || input.platform),
      tags: parseJsonRecord<string[]>(input.record?.tags, []),
    });
    if (recordId) {
      if (!await stillOwnsRun()) {
        console.warn(`[videos] stale source analysis failure ignored for ${recordId}: ${analysisRunId}`);
        throw e;
      }
      const failureReason = soft?.status || classifyCrawlerFailure(errorMessage);
      if (nonRetryableFetch || forceManualFailure) {
        await persistManualVideoFailure(input, errorMessage, failureReason, fallback);
        return fallback;
      }
      const latest = await store.getById(COL, recordId);
      const previous = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
      const compactError = compactVideoPipelineError(errorMessage);
      const compactReason = compactVideoPipelineError(failureReason, 360);
      const opsWorkerEnabled = process.env.CRAWLER_OPS_WORKER_ENABLED !== '0';
      if (!opsWorkerEnabled && previous.requestedAnalysisMode === 'exact') {
        // Production may intentionally pause the historical crawler-ops worker.
        // In that mode a retryable exact-analysis failure must become a visible,
        // retryable failure instead of entering a queue that nobody consumes.
        const failedAt = new Date().toISOString();
        await store.update(COL, recordId, {
          status: 'analyzed' as VideoStatus,
          aiAnalysis: JSON.stringify({
            ...previous,
            requestedAnalysisMode: undefined,
            analysisQueueState: 'failed',
            analysisStage: 'failed',
            analysisStageUpdatedAt: failedAt,
            analysisFailedAt: failedAt,
            analysisMode: previous.analysisMode === 'exact' ? 'exact' : 'strategy',
            downloadStatus: previous.analysisQuality === 'video' ? 'analyzed' : 'manual_required',
            videoFetchStatus: previous.analysisQuality === 'video' ? 'fetched' : 'manual_required',
            geminiStatus: previous.analysisQuality === 'video' ? 'analyzed' : 'video_failed',
            crawlerOpsStatus: 'failed',
            crawlerOpsReason: compactReason,
            analysisError: compactError,
            analysisRetryable: classifyDiscoverySourceFailure(e) !== 'model_unavailable',
            analysisFailureKind: classifyDiscoverySourceFailure(e) === 'model_unavailable' ? 'model_configuration' : 'quality_or_timeout',
            videoLevelFailureStatus: classifyDiscoverySourceFailure(e) === 'model_unavailable' ? '分析模型不可用，等待配置修复' : '全片精确分析失败，可重试',
            downloadError: compactError,
          }),
        });
        throw e;
      }
      const opsTask = input.suppressOpsRequeue
        ? updateCrawlerOpsTask(input.opsTaskId || '', {
          status: 'failed',
          reason: compactReason,
          lastError: compactError,
          updatedAt: new Date().toISOString(),
        })
        : enqueueCrawlerOpsTask({
          recordId,
          tenantId: String(input.record?.tenantId || '').trim() || undefined,
          platform: input.platform,
          sourceUrl: input.sourceUrl,
          title: String(input.record?.title || input.title),
          reason: compactReason,
          forceQueue: true,
        });
      if (opsTask && !input.suppressOpsRequeue) {
        void pushCrawlerOpsTask(opsTask).catch((pushError) => {
          console.warn('[videos] crawler ops push failed:', pushError instanceof Error ? pushError.message : pushError);
        });
      }
      const remainsQueued = Boolean(opsTask && ['queued', 'pushed', 'processing'].includes(opsTask.status));
      const stateChangedAt = new Date().toISOString();
      await store.update(COL, recordId, {
        status: 'analyzed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...previous,
          ...(previous.gemini ? { gemini: previous.gemini } : isRetryableAnalysisFailure(e) ? { gemini: undefined } : { gemini: fallback }),
          analysisSource: previous.gemini ? previous.analysisSource || 'metadata-fallback' : isRetryableAnalysisFailure(e) ? 'analysis-pending' : 'metadata-fallback',
          analysisQuality: previous.gemini ? previous.analysisQuality || 'metadata' : isRetryableAnalysisFailure(e) ? 'pending' : 'metadata',
          videoAnalysisAttemptedAt: new Date().toISOString(),
          downloadStatus: remainsQueued ? 'ops_queued' : 'manual_required',
          videoFetchStatus: remainsQueued ? 'ops_queued' : previous.contentSha256 ? 'fetched' : 'manual_required',
          geminiStatus: remainsQueued ? 'waiting_for_video' : 'video_failed',
          crawlerOpsTaskId: opsTask?.id || input.opsTaskId || previous.crawlerOpsTaskId,
          crawlerOpsStatus: opsTask?.status || 'failed',
          crawlerOpsReason: compactReason,
          analysisError: compactError,
          analysisRetryable: isRetryableAnalysisFailure(e),
          analysisFailureKind: classifyDiscoverySourceFailure(e) === 'model_unavailable' ? 'model_configuration' : isRetryableAnalysisFailure(e) ? 'quality_or_timeout' : previous.analysisFailureKind,
          downloadError: compactError,
          requestedAnalysisMode: remainsQueued ? previous.requestedAnalysisMode : undefined,
          analysisQueueKind: remainsQueued ? 'source_url' : previous.analysisQueueKind,
          analysisQueueState: remainsQueued ? 'queued' : 'failed',
          analysisStage: remainsQueued ? 'queued' : 'failed',
          analysisStageUpdatedAt: stateChangedAt,
          ...(remainsQueued ? {} : { analysisFailedAt: stateChangedAt }),
        }),
      });
    }
    throw e;
  } finally {
    if (tempPath) cleanupTempVideo(tempPath);
  }
}

async function persistManualVideoFailure(input: {
  record: Record<string, unknown> | null;
  sourceUrl: string;
  title: string;
  platform: Platform;
  suppressVisibleBackfill?: boolean;
}, errorMessage: string, reason: string, fallback: VideoAiAnalysis): Promise<void> {
  const recordId = input.record?.id ? String(input.record.id) : '';
  if (!recordId) return;

  const latest = await store.getById(COL, recordId);
  const record = latest ?? input.record;
  const previous = parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {});
  const tenantId = String(record?.tenantId || '');
  const title = String(record?.title || input.title || `${input.platform}-video`);
  const now = new Date().toISOString();
  const hadVideoAnalysis = isVideoLevelAnalysis(previous)
    || (previous.analysisQuality === 'video' && Boolean(previous.gemini) && typeof previous.gemini === 'object');
  const requestedAnalysisMode = previous.requestedAnalysisMode === 'exact' ? 'exact' : undefined;
  const compactError = compactVideoPipelineError(errorMessage);
  const compactReason = compactVideoPipelineError(reason, 360);
  const failure = {
    statusLabel: '视频级失败/需人工处理',
    reason: compactReason,
    error: compactError,
    platform: input.platform,
    sourceUrl: input.sourceUrl,
    recordedAt: now,
  };

  await store.update(COL, recordId, {
    status: 'analyzed' as VideoStatus,
    aiAnalysis: JSON.stringify({
      ...previous,
      gemini: previous.gemini || fallback,
      analysisSource: hadVideoAnalysis ? previous.analysisSource : previous.gemini ? previous.analysisSource || 'metadata-fallback' : 'metadata-fallback',
      analysisQuality: hadVideoAnalysis ? 'video' : 'metadata',
      videoAnalysisAttemptedAt: now,
      // A failed upgrade must not be presented as a completed exact analysis.
      analysisMode: previous.analysisMode === 'exact' ? 'exact' : 'strategy',
      requestedAnalysisMode: undefined,
      analysisQueueState: 'failed',
      analysisStage: 'failed',
      analysisStageUpdatedAt: now,
      analysisFailedAt: now,
      analysisRetryable: true,
      downloadStatus: hadVideoAnalysis ? previous.downloadStatus || 'analyzed' : 'manual_required',
      videoFetchStatus: hadVideoAnalysis ? previous.videoFetchStatus || 'fetched' : 'manual_required',
      geminiStatus: hadVideoAnalysis ? previous.geminiStatus || 'analyzed' : 'video_failed',
      crawlerOpsStatus: 'needs_manual',
      crawlerOpsReason: compactReason,
      videoLevelFailureStatus: '视频级失败/需人工处理',
      manualRequiredReason: compactReason,
      userVisible: hadVideoAnalysis ? previous.userVisible : false,
      adminOnlyVideoFailure: failure,
      analysisError: compactError,
      downloadError: compactError,
    }),
  });

  recordVideoAdminAlert({
    recordId,
    tenantId,
    platform: input.platform,
    title,
    sourceUrl: input.sourceUrl,
    reason: compactReason,
    error: compactError,
  });

  if (!hadVideoAnalysis && tenantId && !input.suppressVisibleBackfill) {
    const keyword = String(previous.keyword || '');
    scheduleTestTenantVideoBackfill({
      tenantId,
      platform: input.platform,
      keyword,
      target: 1,
      replacementForRecordId: recordId,
      reason,
      forceCreate: true,
      dateFrom: String(previous.dateFrom || ''),
      dateTo: String(previous.dateTo || ''),
    });
  }
}

async function persistMetadataFallbackAnalysis(input: {
  record: Record<string, unknown> | null;
  sourceUrl: string;
  title: string;
  platform: Platform;
}, reason: string, status: {
  downloadStatus?: string;
  videoFetchStatus?: string;
  geminiStatus?: string;
  crawlerOpsStatus?: string;
} = {}): Promise<VideoAiAnalysis> {
  const fallback = metadataFallbackAnalysis({
    platform: input.platform,
    title: String(input.record?.title || input.title),
    duration: Number(input.record?.duration || 0),
    views: String(parseJsonRecord<Record<string, unknown>>(input.record?.aiAnalysis, {}).views || input.platform),
    tags: parseJsonRecord<string[]>(input.record?.tags, []),
  });
  const recordId = input.record?.id ? String(input.record.id) : '';
  const finalManualFailure = (status.downloadStatus || 'metadata_only') === 'metadata_only'
    || (status.videoFetchStatus || 'url_failed') === 'url_failed';
  if (recordId && finalManualFailure) {
    await persistManualVideoFailure(input, reason, reason, fallback);
    return fallback;
  }
  if (recordId) {
    const latest = await store.getById(COL, recordId);
    const previous = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
    await store.update(COL, recordId, {
      status: 'analyzed' as VideoStatus,
      aiAnalysis: JSON.stringify({
        ...previous,
        gemini: previous.gemini || fallback,
        analysisSource: previous.gemini ? previous.analysisSource || 'metadata-fallback' : 'metadata-fallback',
        analysisQuality: previous.gemini ? previous.analysisQuality || 'metadata' : 'metadata',
        downloadStatus: status.downloadStatus || 'metadata_only',
        videoFetchStatus: status.videoFetchStatus || 'url_failed',
        geminiStatus: status.geminiStatus || 'metadata_fallback',
        crawlerOpsStatus: status.crawlerOpsStatus || 'skipped',
        crawlerOpsReason: reason,
        videoAnalysisAttemptedAt: new Date().toISOString(),
      }),
    });
  }
  return fallback;
}

function scheduleYouTubeDownloadFallback(input: {
  record: Record<string, unknown> | null;
  sourceUrl: string;
  title: string;
  platform: Platform;
  suppressVisibleBackfill?: boolean;
  forceManualFailure?: boolean;
}): void {
  if (input.platform !== 'youtube') return;
  const recordId = input.record?.id ? String(input.record.id) : '';
  if (!recordId) return;
  void (async () => {
    const latest = await store.getById(COL, recordId);
    if (!latest) return;
    const analysis = parseJsonRecord<Record<string, unknown>>(latest.aiAnalysis, {});
    if (analysis.analysisQuality === 'video') return;
    if (['paused', 'cancelled'].includes(String(analysis.analysisQueueState || analysis.geminiStatus || ''))) return;
    await analyzeSourceVideoJob({
      record: latest,
      sourceUrl: input.sourceUrl,
      title: input.title,
      platform: input.platform,
      skipYoutubeUrlAnalysis: true,
      suppressVisibleBackfill: input.suppressVisibleBackfill,
      forceManualFailure: input.forceManualFailure,
    });
  })().catch((e) => {
    console.warn('[videos] YouTube background download fallback failed:', e instanceof Error ? e.message : e);
  });
}

function youtubeDownloadFallbackEnabled(): boolean {
  return process.env.YOUTUBE_DOWNLOAD_FALLBACK_ENABLED !== '0';
}

function youtubeDownloadFallbackSyncEnabled(): boolean {
  return process.env.YOUTUBE_DOWNLOAD_FALLBACK_MODE === 'sync';
}

async function tryAnalyzeYouTubeUrl(input: {
  record: Record<string, unknown> | null;
  sourceUrl: string;
  title: string;
  platform: Platform;
}, expectedRunId: string): Promise<unknown | null> {
  const recordId = input.record?.id ? String(input.record.id) : '';
  try {
    if (recordId) {
      const latest = await store.getById(COL, recordId);
      const analysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
      if (analysis.analysisRunId && String(analysis.analysisRunId) !== expectedRunId) return null;
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...analysis,
          downloadStatus: 'analyzing',
          videoFetchStatus: 'direct_url',
          geminiStatus: 'analyzing',
          analysisSource: 'gemini-youtube-url',
          geminiStartedAt: new Date().toISOString(),
          analysisRunId: expectedRunId,
          analysisRunMode: 'strategy',
        }),
      });
    }
    const geminiAnalysis = await analyzeYouTubeUrl({ url: input.sourceUrl });
    if (recordId) {
      const latest = await store.getById(COL, recordId);
      const previous = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
      if (String(previous.analysisRunId || '') !== expectedRunId) return null;
      await store.update(COL, recordId, {
        status: 'analyzed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...previous,
          ...videoLevelSuccessPatch({
            analysis: geminiAnalysis,
            source: 'gemini-youtube-url',
            videoFetchStatus: 'direct_url',
          }),
        }),
      });
    }
    return geminiAnalysis;
  } catch (e) {
    if (recordId) {
      const latest = await store.getById(COL, recordId);
      const previous = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? input.record?.aiAnalysis, {});
      if (String(previous.analysisRunId || '') !== expectedRunId) return null;
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...previous,
          youtubeDirectError: compactVideoPipelineError(e instanceof Error ? e.message : 'YouTube direct Gemini analysis failed'),
          downloadStatus: 'metadata_only',
          videoFetchStatus: youtubeDownloadFallbackEnabled() ? 'queued' : 'url_failed',
          geminiStatus: youtubeDownloadFallbackEnabled() ? 'waiting_for_video' : 'metadata_fallback',
        }),
      });
    }
    return null;
  }
}

async function analyzeDownloadedMaterial(recordId: string, filePath: string, material: Material, analysisMode: 'strategy' | 'exact' = 'exact', expectedRunId?: string): Promise<void> {
  try {
    if (expectedRunId) {
      const current = await store.getById<Record<string, unknown>>(COL, recordId);
      const currentAnalysis = parseJsonRecord<Record<string, unknown>>(current?.aiAnalysis, {});
      if (String(currentAnalysis.analysisRunId || '') !== expectedRunId) {
        console.warn(`[videos] stale material analysis skipped for ${recordId}: ${expectedRunId}`);
        return;
      }
    }
    const modelStartedAt = new Date().toISOString();
    const beforeModel = await store.getById<Record<string, unknown>>(COL, recordId);
    const beforeModelAnalysis = parseJsonRecord<Record<string, unknown>>(beforeModel?.aiAnalysis, {});
    await store.update(COL, recordId, {
      status: 'pending' as VideoStatus,
      aiAnalysis: JSON.stringify({
        ...beforeModelAnalysis,
        geminiStatus: 'analyzing',
        geminiStartedAt: modelStartedAt,
        analysisStage: 'analyzing',
        analysisStageUpdatedAt: modelStartedAt,
      }),
    });
    const videoAnalysis = await analyzeDownloadedVideoWithFallback({
      filePath,
      mimeType: mimeFromPath(filePath),
      title: material.name,
      duration: material.duration,
      sourceLabel: 'gemini-video',
      videoId: recordId,
      tenantId: material.tenantId,
      analysisMode,
      analysisRunId: expectedRunId,
      videoObjectKey: String(material.objectKey || ''),
    });
    if (analysisMode === 'exact') {
      const evidenceStartedAt = new Date().toISOString();
      const beforeEvidence = await store.getById<Record<string, unknown>>(COL, recordId);
      const beforeEvidenceAnalysis = parseJsonRecord<Record<string, unknown>>(beforeEvidence?.aiAnalysis, {});
      await store.update(COL, recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...beforeEvidenceAnalysis,
          analysisStage: 'extracting_evidence',
          analysisStageUpdatedAt: evidenceStartedAt,
          analysisEvidenceStartedAt: evidenceStartedAt,
        }),
      });
      videoAnalysis.analysis = await persistExactShotEvidence(recordId, filePath, videoAnalysis.analysis);
    }
    const latest = await store.getById(COL, recordId);
    const previous: Record<string, unknown> = parseJsonRecord(latest?.aiAnalysis, {} as Record<string, unknown>);
    if (expectedRunId && String(previous.analysisRunId || '') !== expectedRunId) {
      console.warn(`[videos] stale material analysis success ignored for ${recordId}: ${expectedRunId}`);
      return;
    }
    const measuredDuration = exactSourceClockDuration(videoAnalysis.analysis, expectedRunId || '');
    await store.update(COL, recordId, {
      status: 'analyzed' as VideoStatus,
      ...(measuredDuration ? { duration: measuredDuration } : {}),
      aiAnalysis: JSON.stringify({
        ...previous,
        ...videoLevelSuccessPatch({
          analysis: videoAnalysis.analysis,
          source: videoAnalysis.source,
          videoFetchStatus: 'fetched',
          extra: {
            analysisMode,
            requestedAnalysisMode: undefined,
            materialId: material.id,
            materialUrl: material.url,
            materialPoster: material.poster,
          },
        }),
      }),
    });
  } catch (e) {
    console.error(`[videos] Gemini material analysis failed for ${recordId}:`, e);
    const latest = await store.getById(COL, recordId);
    const previous = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis, {});
    if (expectedRunId && String(previous.analysisRunId || '') !== expectedRunId) {
      console.warn(`[videos] stale material analysis failure ignored for ${recordId}: ${expectedRunId}`);
      return;
    }
    const platform = (latest?.platform || inferPlatformFromUrl(String(latest?.sourceUrl || ''))) as Platform;
    if (latest && isRetryableAnalysisFailure(e)) {
      const failedAt = new Date().toISOString();
      await store.update(COL, recordId, {
        status: 'analyzed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...previous,
          requestedAnalysisMode: undefined,
          analysisQueueState: 'failed',
          analysisStage: 'failed',
          analysisStageUpdatedAt: failedAt,
          analysisFailedAt: failedAt,
          geminiStatus: 'analysis_retryable',
          analysisRetryable: true,
          analysisFailureKind: 'quality_or_timeout',
          analysisError: compactVideoPipelineError(e instanceof Error ? e.message : String(e)),
          videoLevelFailureStatus: '分析未完成，可重试',
        }),
      });
      return;
    }
    const fallback = metadataFallbackAnalysis({
      platform,
      title: String(latest?.title || material.name),
      duration: Number(latest?.duration || material.duration || 0),
      views: String(previous.views || platform),
      tags: parseJsonRecord<string[]>(latest?.tags, []),
    });
    if (latest) {
      await persistManualVideoFailure({
        record: latest,
        sourceUrl: String(latest.sourceUrl || material.url || ''),
        title: String(latest.title || material.name),
        platform,
      }, e instanceof Error ? e.message : 'Gemini analysis failed', classifyCrawlerFailure(e instanceof Error ? e.message : String(e)), fallback);
    } else {
      const failedAt = new Date().toISOString();
      await store.update(COL, recordId, {
        status: 'failed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...previous,
          analysisSource: 'gemini-video',
          requestedAnalysisMode: undefined,
          analysisQueueState: 'failed',
          analysisStage: 'failed',
          analysisStageUpdatedAt: failedAt,
          analysisFailedAt: failedAt,
          analysisRetryable: true,
          analysisError: compactVideoPipelineError(e instanceof Error ? e.message : 'Gemini analysis failed'),
        }),
      });
    }
  }
}

function startQueuedLocalAnalysis(recordId: string): void {
  void executeQueuedLocalAnalysisRecord(recordId).catch(error => {
    if (error instanceof AnalysisAlreadyRunningError) return;
    console.warn(`[videos] queued local analysis failed for ${recordId}:`, error instanceof Error ? error.message : error);
  });
}

async function materialForQueuedAnalysis(
  record: Record<string, unknown>,
  analysis: Record<string, unknown>,
): Promise<{ material: Material; filePath: string; temporary: boolean }> {
  const recordId = String(record.id || '');
  const tenantId = String(record.tenantId || '');
  const materialId = String(analysis.materialId || '');
  if (!materialId) throw new Error('queued_material_id_missing');
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const tempPath = path.join(ANALYSIS_DIR, `queued-material-${recordId}-${String(analysis.analysisRunId || randomUUID())}.mp4`);
  if (materialId.startsWith('pb-')) {
    const rawMaterialId = materialId.replace(/^pb-/, '');
    const cloudRecord = await getCloudMaterialRecord(rawMaterialId, tenantId);
    if (!cloudRecord) throw new Error('queued_cloud_material_not_found');
    const response = await fetchCloudMaterial(rawMaterialId, 'videoFile', undefined, tenantId);
    if (!response?.ok) throw new Error('queued_cloud_material_unreadable');
    fs.writeFileSync(tempPath, Buffer.from(await response.arrayBuffer()));
    return {
      material: {
        id: materialId,
        name: String(cloudRecord.title || cloudRecord.sourceName || record.title || '置顶素材'),
        folder: String(cloudRecord.folder || 'upload'),
        type: 'video',
        duration: Number(cloudRecord.duration || record.duration || 0),
        size: humanSize(Number(cloudRecord.sizeBytes || fs.statSync(tempPath).size)),
        file: String(cloudRecord.videoFile || ''),
        url: String(analysis.materialUrl || `/api/overseas/studio/materials/pb/${rawMaterialId}/media`),
        poster: String(analysis.materialPoster || record.thumbnailUrl || '') || undefined,
        scope: String(cloudRecord.scope || 'own') === 'shared' ? 'shared' : 'own',
        tenantId,
        createdAt: String(cloudRecord.created || new Date().toISOString()),
      },
      filePath: tempPath,
      temporary: true,
    };
  }
  const material = loadMaterials().find(item => item.id === materialId
    && (item.scope === 'shared' || item.tenantId === tenantId));
  if (!material) throw new Error('queued_material_not_found');
  if (material.objectKey) {
    const downloaded = await objectStorageDownload(material.objectKey);
    if (!downloaded?.buf.length) throw new Error('queued_object_material_unreadable');
    fs.writeFileSync(tempPath, downloaded.buf);
    return { material, filePath: tempPath, temporary: true };
  }
  const localPath = path.join(MEDIA_DIR, material.file);
  if (!fs.existsSync(localPath)) throw new Error('queued_local_material_missing');
  return { material, filePath: localPath, temporary: false };
}

async function executeQueuedLocalAnalysisRecord(recordId: string): Promise<boolean> {
  return await activeAnalysisRecords.run(recordId, () => durableAnalysisRecords.run(recordId, async () => {
    const record = await store.getById<Record<string, unknown>>(COL, recordId);
    if (!record) return false;
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    const queueState = String(analysis.analysisQueueState || 'queued');
    if (!analysis.requestedAnalysisMode || ['paused', 'cancelled', 'completed'].includes(queueState)) return false;
    const analysisRunId = String(analysis.analysisRunId || randomUUID());
    const analysisMode = analysis.requestedAnalysisMode === 'strategy' ? 'strategy' : 'exact';
    const queueKind = String(analysis.analysisQueueKind || '');
    const workerStartedAt = new Date().toISOString();
    await store.update(COL, recordId, {
      status: 'pending' as VideoStatus,
      aiAnalysis: JSON.stringify({
        ...analysis,
        analysisRunId,
        analysisRunMode: analysisMode,
        analysisQueueState: 'running',
        analysisWorkerStartedAt: workerStartedAt,
        analysisStage: queueKind === 'classification_repair' ? 'repairing_classification' : 'downloading',
        analysisStageUpdatedAt: workerStartedAt,
        analysisWorkerAttempt: Number(analysis.analysisWorkerAttempt || 0) + 1,
        geminiStatus: 'analyzing',
      }),
    });
    try {
      if (queueKind === 'classification_repair') {
        const gemini = analysis.gemini && typeof analysis.gemini === 'object'
          ? analysis.gemini as VideoAiAnalysis
          : parseJsonRecord<VideoAiAnalysis>(analysis.gemini, {} as VideoAiAnalysis);
        const repaired = await repairVideoShotClassificationsWithQwen(gemini);
        const latest = await store.getById<Record<string, unknown>>(COL, recordId);
        const previous = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis, {});
        if (String(previous.analysisRunId || '') !== analysisRunId) return false;
        await store.update(COL, recordId, {
          status: 'analyzed' as VideoStatus,
          aiAnalysis: JSON.stringify({
            ...previous,
            ...videoLevelSuccessPatch({
              analysis: repaired,
              source: `${String(analysis.analysisSource || 'video')}-classification-repair`,
              videoFetchStatus: String(analysis.videoFetchStatus || 'fetched'),
              extra: {
                analysisMode: 'exact',
                requestedAnalysisMode: undefined,
                classificationRepairedAt: new Date().toISOString(),
              },
            }),
          }),
        });
      } else if (queueKind === 'material' || (!record.videoFileId && analysis.materialId)) {
        const resolved = await materialForQueuedAnalysis(record, analysis);
        try {
          await analyzeDownloadedMaterial(recordId, resolved.filePath, resolved.material, analysisMode, analysisRunId);
        } finally {
          if (resolved.temporary) { try { fs.unlinkSync(resolved.filePath); } catch { /* best effort */ } }
        }
      } else {
        const filename = String(record.videoFileId || '');
        if (!filename) throw new Error('queued_video_file_missing');
        const tenantId = String(record.tenantId || '');
        const localPath = localReferenceVideoPath(filename, tenantId) || path.join(MEDIA_DIR, filename);
        if (fs.existsSync(localPath)) {
          await analyzeDownloadedMaterial(recordId, localPath, {
            id: String(analysis.materialId || path.parse(filename).name),
            name: String(record.title || filename),
            folder: 'hot',
            type: 'video',
            duration: Number(record.duration || 0),
            size: humanSize(fs.statSync(localPath).size),
            file: filename,
            url: `/api/overseas/videos/${recordId}/media`,
            poster: String(analysis.materialPoster || record.thumbnailUrl || '') || undefined,
            scope: 'own',
            tenantId,
            createdAt: new Date().toISOString(),
          }, analysisMode, analysisRunId);
        } else {
          await triggerVideoAnalysis(recordId, filename, undefined, 'analysis-worker', analysisRunId);
        }
      }
      const finished = await store.getById<Record<string, unknown>>(COL, recordId);
      const finishedAnalysis = parseJsonRecord<Record<string, unknown>>(finished?.aiAnalysis, {});
      if (String(finishedAnalysis.analysisRunId || '') === analysisRunId
        && finishedAnalysis.analysisQueueState === 'running') {
        const succeeded = !finishedAnalysis.requestedAnalysisMode
          && ['analyzed', 'needs_review'].includes(String(finishedAnalysis.geminiStatus || ''))
          && ['video', 'video_review_required'].includes(String(finishedAnalysis.analysisQuality || ''));
        const finishedAt = new Date().toISOString();
        await store.update(COL, recordId, {
          aiAnalysis: JSON.stringify({
            ...finishedAnalysis,
            analysisQueueState: succeeded ? 'completed' : 'failed',
            analysisStage: succeeded ? 'completed' : 'failed',
            analysisStageUpdatedAt: finishedAt,
            ...(succeeded
              ? { analysisCompletedAt: finishedAt }
              : { analysisFailedAt: finishedAt, analysisRetryable: true }),
          }),
        });
      }
      return true;
    } catch (error) {
      const latest = await store.getById<Record<string, unknown>>(COL, recordId);
      const latestAnalysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis, {});
      if (String(latestAnalysis.analysisRunId || '') === analysisRunId) {
        const failedAt = new Date().toISOString();
        await store.update(COL, recordId, {
          status: 'failed' as VideoStatus,
          aiAnalysis: JSON.stringify({
            ...latestAnalysis,
            requestedAnalysisMode: undefined,
            analysisQueueState: 'failed',
            analysisStage: 'failed',
            analysisStageUpdatedAt: failedAt,
            analysisFailedAt: failedAt,
            geminiStatus: 'analysis_retryable',
            analysisRetryable: true,
            analysisError: compactVideoPipelineError(error instanceof Error ? error.message : error),
            videoLevelFailureStatus: '后台分析中断，可重试或恢复',
          }),
        });
      }
      throw error;
    }
  })) as boolean;
}

async function crawlSocialUrlOrFallback(platform: Platform, keyword: string, limit: number, dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  const input = keyword.trim();
  if (isPlatformUrl(input, platform)) return [await crawlYtDlpMetadata(platform, input, keyword)];
  return crawlPublicSearch(platform, input, limit, dateFrom, dateTo);
}

async function crawlTikTokWithApifyFallback(keyword: string, limit: number, dateFrom = '', dateTo = '', strictProviderLimit = false): Promise<CrawledVideo[]> {
  const input = keyword.trim();
  if (isPlatformUrl(input, 'tiktok')) {
    try {
      return [await crawlYtDlpMetadata('tiktok', input, keyword)];
    } catch (error) {
      console.warn('[videos] TikTok direct metadata via yt-dlp failed, trying public API:', error instanceof Error ? error.message : error);
      return [await crawlTikTokPublicApi(input)];
    }
  }

  const items: CrawledVideo[] = [];
  const failures: string[] = [];
  try {
    items.push(...await crawlPublicSearch('tiktok', input, limit, dateFrom, dateTo));
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
    console.warn('[videos] TikTok local crawl failed, trying Apify:', e instanceof Error ? e.message : e);
  }

  const seen = new Set(items.map(item => item.sourceUrl));
  if (items.length < limit && canUseApifyTikTokCrawlFallback()) {
    try {
      const apifyItems = await crawlTikTokApify(input, Math.max(limit - items.length, limit), dateFrom, dateTo, strictProviderLimit);
      for (const item of apifyItems) {
        if (seen.has(item.sourceUrl)) continue;
        if (!isKeywordRelevant(item, input)) continue;
        if (!isWithinDateRange(item.uploadedAt, dateFrom, dateTo)) continue;
        if (!hasRealThumbnail(item)) continue;
        seen.add(item.sourceUrl);
        items.push(item);
        if (items.length >= limit) break;
      }
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
      console.warn('[videos] TikTok Apify fallback failed:', e instanceof Error ? e.message : e);
    }
  }

  if (items.length === 0) throw new Error(crawlFailureMessage('TikTok', failures, 'keyword search returned no usable videos'));
  return sortByHeat(items).slice(0, limit);
}

type TikTokPublicApiData = {
  id?: string; title?: string; duration?: number; cover?: string; origin_cover?: string;
  play?: string; hdplay?: string; play_count?: number; digg_count?: number;
  comment_count?: number; share_count?: number; create_time?: number;
  author?: { nickname?: string; unique_id?: string; };
};

async function readTikTokPublicApi(sourceUrl: string): Promise<TikTokPublicApiData> {
  const endpoint = String(process.env.TIKTOK_PUBLIC_DOWNLOAD_API || 'https://www.tikwm.com/api/').trim();
  const url = new URL(endpoint);
  url.searchParams.set('url', sourceUrl);
  url.searchParams.set('hd', '1');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': browserUserAgent(), Accept: 'application/json' } });
    const raw = await response.text();
    if (!response.ok) throw new Error(`TikTok public API HTTP ${response.status}`);
    const body = JSON.parse(raw) as { code?: number; msg?: string; data?: TikTokPublicApiData };
    if (body.code !== 0 || !body.data?.id) throw new Error(`TikTok public API rejected: ${String(body.msg || body.code || 'invalid_response')}`);
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

async function crawlTikTokPublicApi(sourceUrl: string): Promise<CrawledVideo> {
  const data = await readTikTokPublicApi(sourceUrl);
  const uploadedAt = Number.isFinite(Number(data.create_time)) && Number(data.create_time) > 0
    ? new Date(Number(data.create_time) * 1000).toISOString() : undefined;
  return {
    platform: 'tiktok', title: String(data.title || `TikTok ${data.id}`).trim(), sourceUrl,
    thumbnailUrl: String(data.origin_cover || data.cover || '').trim(), duration: Number(data.duration || 0),
    views: compactNumber(Number(data.play_count || 0)), tags: [...String(data.title || '').matchAll(/#([^\s#]+)/g)].map(match => match[1]!).slice(0, 20),
    uploadedAt, dateEvidence: uploadedAt ? 'provider_create_time' : undefined,
    author: String(data.author?.nickname || data.author?.unique_id || '').trim() || undefined,
    likes: compactNumber(Number(data.digg_count || 0)), comments: compactNumber(Number(data.comment_count || 0)),
    shares: compactNumber(Number(data.share_count || 0)), plays: compactNumber(Number(data.play_count || 0)), source: 'tiktok-public-api',
  };
}

async function crawlTikTokApify(keyword: string, limit: number, dateFrom = '', dateTo = '', strictProviderLimit = false): Promise<CrawledVideo[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  const actor = process.env.APIFY_TIKTOK_ACTOR?.trim() || 'clockworks/tiktok-scraper';
  // Manual collection keeps its video/slideshow oversampling. Approved weekly
  // discovery requests only its reserved item count from the paid actor.
  const input = buildApifyTikTokInput(keyword, apifyCandidateWindow(limit, 'tiktok', strictProviderLimit), dateFrom, dateTo);
  const runUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?clean=true&token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.APIFY_TIMEOUT_MS || 120_000));
  try {
    const r = await fetch(runUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Apify TikTok HTTP ${r.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text) as unknown;
    const rows = Array.isArray(data) ? data as Record<string, unknown>[] : [];
    return rows
      .map(item => apifyTikTokItemToCrawledVideo(item, keyword))
      .filter((item): item is CrawledVideo => Boolean(item))
      .slice(0, limit);
  } finally {
    clearTimeout(timer);
  }
}

async function crawlTikTokWithPaidPermit(accountUrl: string, limit: number, dateFrom: string, dateTo: string, permit: PaidApifyTikTokPermit): Promise<CrawledVideo[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw Error('apify_paid_credentials_required');
  const actor = process.env.APIFY_TIKTOK_ACTOR?.trim() || 'clockworks/tiktok-scraper';
  const rows = await runPaidApifyTikTokDataset({
    actorId: actor,
    actorInput: buildApifyTikTokInput(accountUrl, Math.max(1, limit), dateFrom, dateTo),
    permit,
    token,
    maxItems: Math.max(1, limit),
    timeoutMs: Number(process.env.APIFY_TIMEOUT_MS || 120_000),
    pollIntervalMs: Number(process.env.APIFY_POLL_INTERVAL_MS || 5_000),
  });
  return rows.map(item => apifyTikTokItemToCrawledVideo(item, accountUrl))
    .filter((item): item is CrawledVideo => Boolean(item)).slice(0, limit);
}


// ─── Instagram 采集：cookie(yt-dlp) 为主，Apify 兜底 ─────────────────────────
// 结构与 crawlTikTokWithApifyFallback 一致。IG 封了匿名访问：
//   · 直链 → 先走 yt-dlp（未登录会失败，配置了 YT_DLP_COOKIE_FILES 的 cookie 文件才通）；
//   · 关键词 → IG 无公开搜索接口，yt-dlp 走不通，直接用 Apify hashtag 搜索。
// 两种情况下 yt-dlp 拿不到时统一回落 Apify（apify/instagram-scraper）。
async function crawlInstagramWithApifyFallback(keyword: string, limit: number, dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  const input = keyword.trim();
  const directUrl = isPlatformUrl(input, 'instagram');
  const items: CrawledVideo[] = [];
  const failures: string[] = [];

  if (directUrl) {
    // 直链优先走 yt-dlp（配置了 cookie 文件即可，免 Apify 费用）；成功即返回，不再叠加 Apify。
    try {
      return [await crawlYtDlpMetadata('instagram', input, keyword)];
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
      console.warn('[videos] Instagram yt-dlp metadata failed, trying Apify:', e instanceof Error ? e.message : e);
    }
  }

  const seen = new Set(items.map(item => item.sourceUrl));
  if (items.length < limit && canUseApifyInstagramCrawlFallback()) {
    try {
      const apifyItems = await crawlInstagramApify(input, Math.max(limit - items.length, limit), dateFrom, dateTo);
      for (const item of apifyItems) {
        if (seen.has(item.sourceUrl)) continue;
        if (!directUrl && !isKeywordRelevant(item, input)) continue;
        if (!directUrl && !isWithinDateRange(item.uploadedAt, dateFrom, dateTo)) continue;
        if (!hasRealThumbnail(item)) continue;
        seen.add(item.sourceUrl);
        items.push(item);
        if (items.length >= limit) break;
      }
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
      console.warn('[videos] Instagram Apify fallback failed:', e instanceof Error ? e.message : e);
    }
  }

  if (items.length === 0) {
    throw new Error(crawlFailureMessage('Instagram', failures, '抓取无可用视频'));
  }
  return directUrl ? items.slice(0, limit) : sortByHeat(items).slice(0, limit);
}

async function crawlInstagramApify(keyword: string, limit: number, dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  const directUrl = isPlatformUrl(keyword.trim(), 'instagram');
  const actor = directUrl
    ? (process.env.APIFY_INSTAGRAM_ACTOR?.trim() || 'apify/instagram-scraper')
    : (process.env.APIFY_INSTAGRAM_SEARCH_ACTOR?.trim()
      || process.env.APIFY_INSTAGRAM_ACTOR?.trim()
      || 'apify/instagram-scraper');
  // Hashtag results mix image posts and Reels. Fetching exactly `limit` rows can
  // return only images which are correctly filtered below, leaving a false zero.
  // Oversample keyword searches, then keep the requested number of real videos.
  const fetchLimit = limit;
  const input = buildApifyInstagramInput(keyword, fetchLimit, dateFrom, dateTo);
  const rows = await runApifyActorDatasetItems(actor, input, Number(process.env.APIFY_TIMEOUT_MS || 240_000), 'Instagram crawl');
  return rows
    .map(item => apifyInstagramItemToCrawledVideo(item, keyword))
    .filter((item): item is CrawledVideo => Boolean(item))
    .slice(0, limit);
}

function buildApifyInstagramInput(keyword: string, limit: number, dateFrom = '', _dateTo = ''): Record<string, unknown> {
  const input = keyword.trim();
  const resultsLimit = Math.min(50, Math.max(1, limit));
  const base: Record<string, unknown> = {
    resultsType: 'reels',
    resultsLimit,
    addParentData: false,
  };
  if (isPlatformUrl(input, 'instagram')) {
    base.directUrls = [input];
    if (dateFrom) base.onlyPostsNewerThan = dateFrom;
  } else {
    // The actor's search mode currently redirects some English hashtags to an
    // unrelated localized tag page. Direct hashtag URLs are stable; fetch a
    // small page and apply the requested date window locally below.
    const tag = input.replace(/^#/, '').trim();
    base.directUrls = [`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`];
  }
  return base;
}


// ─── Facebook 账号主页采集：yt-dlp 为主，Apify posts actor 兜底 ───────────────
// Facebook Page 的 /videos 列表经常无法匿名枚举。Apify 返回的是帖子列表，
// 因此这里严格只收 media 中确认为 Video 的条目，避免把图片帖混入视频库。
async function crawlFacebookAccountApify(accountUrl: string, limit: number, dateFrom = '', dateTo = '', strictProviderLimit = false): Promise<CrawledVideo[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  const actor = process.env.APIFY_FACEBOOK_ACTOR?.trim() || 'apify/facebook-posts-scraper';
  const input = buildApifyFacebookAccountInput(accountUrl, limit, strictProviderLimit);
  const rows = await runApifyActorDatasetItems(actor, input, Number(process.env.APIFY_TIMEOUT_MS || 240_000), 'Facebook account crawl');
  return rows
    .map(item => apifyFacebookPostToCrawledVideo(item, accountUrl))
    .filter((item): item is CrawledVideo => Boolean(item))
    .filter(item => isWithinDateRange(item.uploadedAt, dateFrom, dateTo))
    .slice(0, limit);
}

export function buildApifyFacebookAccountInput(accountUrl: string, limit: number, strictProviderLimit = false): Record<string, unknown> {
  const resultsLimit = apifyCandidateWindow(limit, 'facebook', strictProviderLimit);
  return {
    startUrls: [{ url: accountUrl }],
    resultsLimit,
    maxPosts: resultsLimit,
  };
}


// ─── 图文/图片帖采集 ─────────────────────────────────────────────────────────
async function crawlInstagramImagePostsApify(keyword: string, limit: number, accountUrl = ''): Promise<CrawledImagePost[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  const actor = process.env.APIFY_INSTAGRAM_ACTOR?.trim() || 'apify/instagram-scraper';
  const cleanKeyword = keyword.replace(/^#/, '').trim();
  const rows = await runApifyActorDatasetItems(actor, {
    directUrls: [accountUrl || `https://www.instagram.com/explore/tags/${encodeURIComponent(cleanKeyword)}/`],
    resultsType: 'posts',
    resultsLimit: Math.min(50, Math.max(limit * 4, limit, 12)),
    addParentData: false,
  }, Number(process.env.APIFY_TIMEOUT_MS || 240_000), 'Instagram image posts');
  return rows
    .map(item => apifyInstagramItemToImagePost(item, keyword))
    .filter((item): item is CrawledImagePost => Boolean(item))
    .slice(0, limit);
}

async function crawlTikTokImagePostsApify(keyword: string, limit: number, accountUrl = '', dateFrom = '', dateTo = ''): Promise<CrawledImagePost[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  const actor = process.env.APIFY_TIKTOK_ACTOR?.trim() || 'clockworks/tiktok-scraper';
  const input = {
    ...buildApifyTikTokInput(accountUrl || keyword, limit, dateFrom, dateTo),
    shouldDownloadSlideshowImages: true,
  };
  const rows = await runApifyActorDatasetItems(actor, input, Number(process.env.APIFY_TIMEOUT_MS || 240_000), 'TikTok image posts');
  return rows
    .map(item => apifyTikTokItemToImagePost(item, keyword))
    .filter((item): item is CrawledImagePost => Boolean(item))
    .slice(0, limit);
}

async function crawlFacebookImagePostsApify(keyword: string, limit: number): Promise<CrawledImagePost[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  const actor = process.env.APIFY_FACEBOOK_ACTOR?.trim() || 'apify/facebook-posts-scraper';
  const inputUrl = isPlatformUrl(keyword, 'facebook')
    ? keyword
    : await discoverFacebookPageUrl(keyword);
  const rows = await runApifyActorDatasetItems(actor, {
    startUrls: [{ url: inputUrl }],
    resultsLimit: Math.min(50, Math.max(limit * 4, 10)),
    maxPosts: Math.min(50, Math.max(limit * 4, 10)),
  }, Number(process.env.APIFY_TIMEOUT_MS || 240_000), 'Facebook image posts');
  const mapped = rows
    .map(item => apifyFacebookPostToImagePost(item, keyword))
    .filter((item): item is CrawledImagePost => Boolean(item))
    .slice(0, limit);
  if (mapped.length > 0) return mapped;
  return crawlFacebookImagePostsPublicSearch(keyword, limit);
}

async function discoverFacebookPageUrl(keyword: string): Promise<string> {
  const actor = process.env.APIFY_FACEBOOK_SEARCH_ACTOR?.trim() || 'apify/facebook-search-scraper';
  const rows = await runApifyActorDatasetItems(actor, {
    categories: [keyword.trim()],
    resultsLimit: 1,
  }, Number(process.env.APIFY_TIMEOUT_MS || 240_000), 'Facebook page search');
  const pageUrl = String(rows[0]?.pageUrl || rows[0]?.facebookUrl || rows[0]?.url || '').trim();
  if (!isPlatformUrl(pageUrl, 'facebook')) throw new Error(`Facebook page search returned no public page for: ${keyword}`);
  return stripTrackingParams(pageUrl);
}


async function crawlFacebookImagePostsPublicSearch(keyword: string, limit: number): Promise<CrawledImagePost[]> {
  const query = `site:facebook.com "${keyword}" ("/photos/" OR "photo" OR "/posts/")`;
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const xml = await fetchText(url, 20_000);
  const items: CrawledImagePost[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] || '';
    const link = cleanSearchResultUrl(decodeHtml(block.match(/<link>([^<]+)<\/link>/i)?.[1] || '').trim());
    if (!link || !isPlatformUrl(link, 'facebook') || /\/(?:search|watch|reel|videos)\b/i.test(link) || seen.has(link)) continue;
    seen.add(link);
    const title = decodeHtml(block.match(/<title>([^<]+)<\/title>/i)?.[1] || '').trim();
    items.push({
      platform: 'facebook',
      title: cleanupAnalysisTitle(title || `Facebook image post: ${keyword}`),
      sourceUrl: link,
      thumbnailUrl: '',
      caption: title,
      imageUrls: [],
      views: 'Facebook',
      tags: tagsFromKeyword(keyword, 'facebook'),
      source: 'public-search-image',
    });
    if (items.length >= limit) break;
  }
  if (items.length === 0) throw new Error('Facebook public search did not expose image posts for this keyword');
  return items;
}

async function crawlYouTubeCommunityPostsPublicSearch(keyword: string, limit: number, accountUrl = ''): Promise<CrawledImagePost[]> {
  const account = accountUrl ? accountLabelFromUrl(accountUrl) : '';
  const query = `site:youtube.com/post "${account || keyword}"`;
  const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  const xml = await fetchText(url, 20_000);
  const items: CrawledImagePost[] = [];
  const seen = new Set<string>();
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  for (const match of itemMatches) {
    const block = match[1] || '';
    const link = cleanSearchResultUrl(decodeHtml(block.match(/<link>([^<]+)<\/link>/i)?.[1] || '').trim());
    if (!link || !isPlatformUrl(link, 'youtube') || !/\/post\//i.test(link) || seen.has(link)) continue;
    seen.add(link);
    const title = decodeHtml(block.match(/<title>([^<]+)<\/title>/i)?.[1] || '').trim();
    items.push({
      platform: 'youtube',
      title: cleanupAnalysisTitle(title || `YouTube Community post: ${keyword}`),
      sourceUrl: link,
      thumbnailUrl: '',
      caption: title,
      imageUrls: [],
      views: 'YouTube',
      tags: tagsFromKeyword(keyword, 'youtube'),
      source: 'public-search-image',
    });
    if (items.length >= limit) break;
  }
  if (items.length === 0) throw new Error('YouTube Community posts are not exposed reliably by public search');
  return items;
}

function imagePostRelevant(item: CrawledImagePost, keyword: string): boolean {
  const clean = keyword.trim().toLowerCase();
  if (!clean || /^https?:\/\//i.test(clean)) return true;
  const text = `${item.title} ${item.tags.join(' ')}`.toLowerCase();
  return clean.split(/\s+/).some(token => token.length > 1 && text.includes(token.replace(/^#/, '')));
}

// 反爬节流：同一平台的元数据请求全局排队串行，条与条之间加随机间隔，
// 避免多个入口（手动爬取/定时任务/backfill）叠加成并发快打触发风控。
const crawlPacingQueues = new Map<string, Promise<void>>();
const CRAWL_MIN_INTERVAL_MS = Number(process.env.CRAWLER_MIN_INTERVAL_MS || 3000);
const CRAWL_JITTER_MS = Number(process.env.CRAWLER_JITTER_MS || 4000);

async function withPlatformCrawlPacing<T>(platform: string, task: () => Promise<T>): Promise<T> {
  const prev = crawlPacingQueues.get(platform) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  crawlPacingQueues.set(platform, prev.then(() => gate));
  await prev;
  try {
    return await task();
  } finally {
    setTimeout(release, CRAWL_MIN_INTERVAL_MS + Math.random() * CRAWL_JITTER_MS);
  }
}

async function crawlYtDlpMetadata(platform: Platform, url: string, keyword: string): Promise<CrawledVideo> {
  return withPlatformCrawlPacing(platform, () => crawlYtDlpMetadataNow(platform, url, keyword));
}

async function crawlYtDlpMetadataNow(platform: Platform, url: string, keyword: string): Promise<CrawledVideo> {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(ytDlpPythonPath(), buildYtDlpArgs(['--dump-json', '--skip-download'], url, false), { maxBuffer: 8 * 1024 * 1024, timeout: 45_000, env: crawlerExecEnv() }));
  } catch {
    if (!usesServerCookiesForCrawl(platform)) throw new Error(`${platform} anonymous metadata crawl failed`);
    stdout = await execYtDlpWithCookieFallback(['--dump-json', '--skip-download'], url, 60_000, 8 * 1024 * 1024);
  }
  const line = stdout.split('\n').find(Boolean);
  if (!line) throw new Error(`${platform} returned empty metadata`);
  const meta = JSON.parse(line) as Record<string, unknown>;
  const webpageUrl = canonicalSourceUrl(platform, String(meta.webpage_url || meta.original_url || meta.url || url), metadataUploader(meta));
  const title = metadataTitle(platform, meta);
  const thumbnail = thumbnailForPlatform(platform, webpageUrl, firstImageUrl([meta.thumbnails, meta.thumbnail, meta]));
  const duration = Number(meta.duration || 0);
  const uploadedAt = uploadedAtFromMeta(meta);
  const views = typeof meta.view_count === 'number' ? compactNumber(meta.view_count) : platform;
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((t): t is string => typeof t === 'string').slice(0, 5)
    : [];
  return normalizeCrawledVideo({ platform, title, sourceUrl: webpageUrl, thumbnailUrl: thumbnail, duration, views, tags, uploadedAt,sourceAccountUrl:metadataCreatorAccount(platform,meta) });
}

async function downloadVideoToMaterial(input: {
  sourceUrl: string;
  title: string;
  platform: Platform;
  duration: number;
  tenantId: string;
  record?: Record<string, unknown> | null;
}): Promise<Material> {
  if(isWeeklyOriginalAccountCollectionRecord(input.record))throw Error('weekly_original_account_media_requires_same_run_kv');
  const tenantMediaDir = tenantAssetDir(MEDIA_DIR, input.tenantId);
  fs.mkdirSync(tenantMediaDir, { recursive: true });
  const id = randomUUID();
  const outTpl = path.join(tenantMediaDir, `${id}.%(ext)s`);
  const downloadArgs = [
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--max-filesize', '120m',
    '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/best[height<=720]/best',
    '-o', outTpl,
  ];
  const cleanupIncompleteDownload = () => {
    try {
      for (const filename of fs.readdirSync(tenantMediaDir)) {
        if (filename.startsWith(`${id}.`) && filename.endsWith('.part')) fs.unlinkSync(path.join(tenantMediaDir, filename));
      }
    } catch { /* best effort */ }
  };

  let ytDlpError: unknown = null;
  try {
    await execFileAsync(ytDlpPythonPath(), buildYtDlpArgs(downloadArgs, input.sourceUrl, false), { maxBuffer: 4 * 1024 * 1024, timeout: 180_000, env: crawlerExecEnv() });
  } catch (e) {
    ytDlpError = e;
    if (usesServerCookiesForCrawl(input.platform)) {
      try {
        await execYtDlpWithCookieFallback(downloadArgs, input.sourceUrl, 180_000, 4 * 1024 * 1024);
        ytDlpError = null;
      } catch (cookieError) {
        ytDlpError = cookieError;
      }
    }
  }
  if (ytDlpError && (input.platform === 'instagram' || input.platform === 'tiktok')) {
    const tenantId = apifyTenantIdFromRecord(input.record);
    if (canUseApifyVideoFallback(tenantId, input.platform)) {
      const downloaded = input.platform === 'instagram'
        ? await downloadInstagramVideoViaApify(input.sourceUrl, tenantId)
        : await downloadTikTokVideoViaApify(input.sourceUrl, tenantId);
      const materialPath = path.join(tenantMediaDir, `${id}.mp4`);
      fs.copyFileSync(downloaded.filePath, materialPath);
      cleanupTempVideo(downloaded.filePath);
      ytDlpError = null;
    }
  }
  if (ytDlpError) {
    cleanupIncompleteDownload();
    throw ytDlpError instanceof Error ? ytDlpError : new Error('yt-dlp failed for material download');
  }
  const downloaded = pickDownloadedVideoFile(id, tenantMediaDir);
  if (!downloaded) {
    cleanupIncompleteDownload();
    throw new Error('yt-dlp did not produce a video file');
  }

  const fullPath = path.join(tenantMediaDir, downloaded);
  const posterFile = `${id}.poster.jpg`;
  const posterPath = path.join(tenantMediaDir, posterFile);
  const posterOk = await extractPoster(fullPath, posterPath, input.duration > 1 ? 1 : 0);
  const createdAt = new Date().toISOString();
  const material = buildDownloadedReferenceMaterial({
    id,
    tenantId: input.tenantId,
    name: safeMaterialName(input.title, input.platform),
    platform: input.platform,
    sourceUrl: input.sourceUrl,
    duration: input.duration || await probeDuration(fullPath),
    size: humanSize(fs.statSync(fullPath).size),
    file: tenantAssetRelativePath(input.tenantId, downloaded),
    poster: posterOk ? tenantAssetRelativePath(input.tenantId, posterFile) : undefined,
    contentSha256: createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex'),
    createdAt,
  }) as Material;
  persistMaterials([material, ...loadMaterials().filter(m => m.id !== material.id)]);
  return material;
}

export async function downloadVideoForAnalysis(input: {
  sourceUrl: string;
  title: string;
  platform: Platform;
  record?: Record<string, unknown> | null;
  allowPaidFallback?: boolean;
  allowCookieFallback?: boolean;
}, executeDownload = execFileAsync, budget = new DownloadBudget(Math.max(10_000, Number(process.env.VIDEO_ANALYSIS_DOWNLOAD_TIMEOUT_MS || 150_000)))): Promise<{ filePath: string; fileName: string; mimeType: string; size: number }> {
  if(isWeeklyOriginalAccountCollectionRecord(input.record))throw Error('weekly_original_account_media_requires_same_run_kv');
  const source = validatePublicVideoSourceUrl(input.sourceUrl, input.platform);
  if (!source) throw new Error('unsafe_public_video_source');
  input = { ...input, ...source };
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const tenantId = apifyTenantIdFromRecord(input.record);
  if (input.platform === 'tiktok') {
    try {
      return await downloadTikTokViaPublicApi(input.sourceUrl, budget);
    } catch (error) {
      budget.record('TikTok public API', error);
      budget.remaining();
      console.warn('[videos] TikTok public API download failed, trying authenticated yt-dlp:', error instanceof Error ? error.message : error);
    }
  }
  // Facebook's public page frequently blocks yt-dlp or makes it retry several
  // formats before failing. The configured posts actor already exposes the
  // playable CDN URL, so use it first for an explicit analysis request.
  if (input.allowPaidFallback !== false && input.platform === 'facebook' && canUseApifyVideoFallback(tenantId, 'facebook')) {
    try {
      return await downloadFacebookVideoViaApify(input.sourceUrl, tenantId, budget);
    } catch (error) {
      budget.record('Apify', error);
      budget.remaining();
      console.warn('[videos] Facebook Apify analysis video fallback failed, trying yt-dlp:', error instanceof Error ? error.message : error);
    }
  }
  // Datacenter YouTube traffic is commonly challenged before yt-dlp can obtain
  // media bytes. A dedicated downloader actor stores one low-res MP4 in Apify
  // KVS, which we immediately copy into our own PocketBase-backed pipeline.
  if (input.allowPaidFallback !== false && input.platform === 'youtube' && canUseApifyVideoFallback(tenantId, 'youtube')) {
    try {
      return await downloadYouTubeVideoViaApify(input.sourceUrl, tenantId, budget);
    } catch (error) {
      budget.record('Apify', error);
      budget.remaining();
      console.warn('[videos] YouTube Apify analysis video fallback failed, trying yt-dlp:', error instanceof Error ? error.message : error);
    }
  }
  const id = randomUUID();
  const outTpl = path.join(ANALYSIS_DIR, `${id}.%(ext)s`);
  const clipSeconds = Math.max(30, Number(process.env.VIDEO_ANALYSIS_CLIP_SECONDS || 180));
  const baseDownloadArgs = [
    '--no-playlist',
    '--merge-output-format', 'mp4',
    '--max-filesize', process.env.VIDEO_ANALYSIS_MAX_FILESIZE || '80m',
    ...(ffmpegBin ? ['--ffmpeg-location', ffmpegBin] : []),
    '-o', outTpl,
  ];
  const formatCandidates: Array<{ format?: string; section?: boolean; label: string }> = [
    { format: 'h264_720p_1023806-1/h264_720p_1023806-0/download/best[height<=720]/best', section: false, label: 'tiktok-h264-full' },
    { format: 'bv*[height<=480]+ba/bv*[height<=480]/b[height<=480][vcodec!=none]/best[height<=480][vcodec!=none]/best[vcodec!=none]', section: false, label: '480-full' },
    { format: 'bv*+ba/bv*/b[vcodec!=none]/best[vcodec!=none]', section: false, label: 'best-full' },
    { section: false, label: 'auto-full' },
    { format: 'bv*[height<=360]+ba/bv*[height<=360]/b[height<=360][vcodec!=none]/best[height<=360][vcodec!=none]/best[vcodec!=none]', section: true, label: '360-section' },
    { format: 'bv*[height<=480]+ba/bv*[height<=480]/b[height<=480][vcodec!=none]/best[height<=480][vcodec!=none]/best[vcodec!=none]', section: true, label: '480-section' },
    { format: 'bv*+ba/bv*/b[vcodec!=none]/best[vcodec!=none]', section: true, label: 'best-section' },
  ];

  let lastError: unknown = null;
  for (const candidate of formatCandidates) {
    const downloadArgs = [
      ...baseDownloadArgs,
      ...(candidate.section && ffmpegBin ? ['--download-sections', `*0-${clipSeconds}`] : []),
      ...(candidate.format ? ['-f', candidate.format] : []),
    ];
    try {
      await executeDownload(ytDlpPythonPath(), buildYtDlpArgs(downloadArgs, input.sourceUrl, false), { maxBuffer: 4 * 1024 * 1024, timeout: budget.remaining(), env: crawlerExecEnv() });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      budget.record(candidate.label, e);
      if (terminalDownloadFailure(e)) break;
      if (input.allowCookieFallback !== false && usesServerCookiesForCrawl(input.platform) && (cookieBrowsers().length > 0 || cookieFiles().length > 0)) {
        try {
          await execYtDlpWithCookieFallback(downloadArgs, input.sourceUrl, budget.remaining(), 4 * 1024 * 1024, budget);
          lastError = null;
          break;
        } catch (cookieError) {
          lastError = cookieError;
          if (terminalDownloadFailure(cookieError)) break;
        }
      }
      try { budget.remaining(); } catch (error) { lastError = error; break; }
      console.warn(`[videos] analysis download attempt failed (${candidate.label}):`, lastError instanceof Error ? lastError.message : lastError);
    }
  }
  if (lastError) {
    cleanupDownloadedFilesById(id, ANALYSIS_DIR);
    if (input.allowPaidFallback !== false && input.platform === 'tiktok' && canUseApifyVideoFallback(tenantId, 'tiktok')) {
      try {
        console.warn('[videos] TikTok yt-dlp analysis download failed, trying Apify video fallback:', lastError instanceof Error ? lastError.message : lastError);
        return await downloadTikTokVideoViaApify(input.sourceUrl, tenantId, budget);
      } catch (apifyError) {
        budget.record('Apify', apifyError);
        console.warn('[videos] TikTok Apify analysis video fallback failed:', apifyError instanceof Error ? apifyError.message : apifyError);
      }
    }
    if (input.platform === 'tiktok') {
      try {
        return await downloadTikTokViaPublicApi(input.sourceUrl, budget);
      } catch (publicApiError) {
        budget.record('TikTok public API', publicApiError);
        console.warn('[videos] TikTok public API analysis fallback failed:', publicApiError instanceof Error ? publicApiError.message : publicApiError);
      }
    }
    if (input.allowPaidFallback !== false && input.platform === 'instagram' && canUseApifyVideoFallback(tenantId, 'instagram')) {
      try {
        console.warn('[videos] Instagram yt-dlp analysis download failed, trying Apify video fallback:', lastError instanceof Error ? lastError.message : lastError);
        return await downloadInstagramVideoViaApify(input.sourceUrl, tenantId, budget);
      } catch (apifyError) {
        budget.record('Apify', apifyError);
        console.warn('[videos] Instagram Apify analysis video fallback failed:', apifyError instanceof Error ? apifyError.message : apifyError);
      }
    }
    throw budget.error(lastError instanceof Error ? lastError.message.slice(0, 200) : 'yt-dlp failed for all analysis formats');
  }
  const downloaded = pickDownloadedVideoFile(id, ANALYSIS_DIR);
  if (!downloaded) {
    cleanupDownloadedFilesById(id, ANALYSIS_DIR);
    throw new Error('yt-dlp did not produce an analysis video file');
  }

  const filePath = path.join(ANALYSIS_DIR, downloaded);
  return {
    filePath,
    fileName: downloaded,
    mimeType: mimeFromPath(filePath),
    size: fs.statSync(filePath).size,
  };
}

async function downloadTikTokViaPublicApi(sourceUrl: string, budget: DownloadBudget): Promise<{ filePath: string; fileName: string; mimeType: string; size: number }> {
  const data = await readTikTokPublicApi(sourceUrl);
  const mediaUrl = String(data.hdplay || data.play || '').trim();
  if (!/^https:\/\//i.test(mediaUrl)) throw new Error('TikTok public API did not return HTTPS media');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget.remaining());
  const fileName = `${randomUUID()}.mp4`;
  const filePath = path.join(ANALYSIS_DIR, fileName);
  try {
    const response = await fetch(mediaUrl, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': browserUserAgent(), Referer: 'https://www.tiktok.com/' } });
    if (!response.ok) throw new Error(`TikTok media HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    const maximum = 80 * 1024 * 1024;
    if (declared > maximum) throw new Error('TikTok media exceeds analysis limit');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024 || bytes.length > maximum || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('TikTok public API returned invalid MP4');
    fs.writeFileSync(filePath, bytes, { flag: 'wx' });
    return { filePath, fileName, mimeType: 'video/mp4', size: bytes.length };
  } catch (error) {
    try { fs.unlinkSync(filePath); } catch { /* not written */ }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pickDownloadedVideoFile(id: string, dir = MEDIA_DIR): string | undefined {
  const files = fs.readdirSync(dir)
    .filter(file => file.startsWith(`${id}.`) && !file.includes('.poster.'));
  return files.find(file => /\.(mp4|webm|mov|mkv)$/i.test(file));
}

function cleanupDownloadedFilesById(id: string, dir: string): void {
  try {
    for (const file of fs.readdirSync(dir)) {
      if (file.startsWith(`${id}.`)) fs.unlinkSync(path.join(dir, file));
    }
  } catch {
    // best effort cleanup
  }
}

async function downloadTikTokVideoViaApify(sourceUrl: string, tenantId?: string, budget = new DownloadBudget(Math.max(10_000, Number(process.env.VIDEO_ANALYSIS_DOWNLOAD_TIMEOUT_MS || 150_000)))): Promise<{ filePath: string; fileName: string; mimeType: string; size: number }> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  if (!canUseApifyVideoFallback(tenantId)) throw new Error('Apify video fallback daily limit reached for this account or server');
  const actor = process.env.APIFY_TIKTOK_ACTOR?.trim() || 'clockworks/tiktok-scraper';
  const input = {
    postURLs: [sourceUrl],
    resultsPerPage: 1,
    shouldDownloadVideos: true,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    shouldDownloadMusicCovers: false,
    shouldDownloadMusic: false,
  };
  const runUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?clean=true&token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(budget.remaining(), Number(process.env.APIFY_VIDEO_TIMEOUT_MS || 180_000)));
  try {
    const r = await fetch(runUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Apify TikTok video HTTP ${r.status}: ${text.slice(0, 300)}`);
    const rows = JSON.parse(text) as unknown;
    const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
    const videoUrl = row ? findApifyVideoDownloadUrl(row) : '';
    if (!videoUrl) throw new Error('Apify did not return a downloadable video URL');
    const videoRes = await fetch(videoUrl, { signal: AbortSignal.timeout(budget.remaining()) });
    if (!videoRes.ok) throw new Error(`Apify video download HTTP ${videoRes.status}`);
    const buf = Buffer.from(await videoRes.arrayBuffer());
    if (buf.length < 1024) throw new Error('Apify returned an empty video file');
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    const fileName = `${randomUUID()}.mp4`;
    const filePath = path.join(ANALYSIS_DIR, fileName);
    fs.writeFileSync(filePath, buf);
    recordApifyVideoFallbackUse(tenantId);
    return {
      filePath,
      fileName,
      mimeType: videoRes.headers.get('content-type')?.split(';')[0] || 'video/mp4',
      size: buf.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function downloadYouTubeVideoViaApify(sourceUrl: string, tenantId?: string, budget = new DownloadBudget(Math.max(10_000, Number(process.env.VIDEO_ANALYSIS_DOWNLOAD_TIMEOUT_MS || 150_000)))): Promise<{ filePath: string; fileName: string; mimeType: string; size: number }> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  if (!canUseApifyVideoFallback(tenantId, 'youtube')) throw new Error('Apify YouTube fallback daily limit reached for this account or server');
  const actor = process.env.APIFY_YOUTUBE_VIDEO_ACTOR?.trim() || 'streamers/youtube-video-downloader';
  const rows = await runApifyActorDatasetItems(actor, {
    videos: [{ url: sourceUrl }],
    storeInKVStore: true,
    preferredQuality: '360p',
    preferredFormat: 'mp4',
    filenameTemplateParts: [],
  }, Math.min(budget.remaining(), Number(process.env.APIFY_YOUTUBE_VIDEO_TIMEOUT_MS || 300_000)), 'YouTube video');
  const videoUrl = String(rows[0]?.downloadedFileUrl || '').trim();
  if (!videoUrl) throw new Error('Apify did not return a downloaded YouTube video URL');
  const videoRes = await fetch(`${videoUrl}${videoUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(Math.min(budget.remaining(), Number(process.env.APIFY_YOUTUBE_FILE_TIMEOUT_MS || 120_000))),
  });
  if (!videoRes.ok) throw new Error(`Apify YouTube video download HTTP ${videoRes.status}`);
  const buf = Buffer.from(await videoRes.arrayBuffer());
  if (buf.length < 1024) throw new Error('Apify returned an empty YouTube video file');
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const fileName = `${randomUUID()}.mp4`;
  const filePath = path.join(ANALYSIS_DIR, fileName);
  fs.writeFileSync(filePath, buf);
  recordApifyVideoFallbackUse(tenantId);
  return {
    filePath,
    fileName,
    mimeType: videoRes.headers.get('content-type')?.split(';')[0] || 'video/mp4',
    size: buf.length,
  };
}

async function downloadInstagramVideoViaApify(sourceUrl: string, tenantId?: string, budget = new DownloadBudget(Math.max(10_000, Number(process.env.VIDEO_ANALYSIS_DOWNLOAD_TIMEOUT_MS || 150_000)))): Promise<{ filePath: string; fileName: string; mimeType: string; size: number }> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  if (!canUseApifyVideoFallback(tenantId, 'instagram')) throw new Error('Apify video fallback daily limit reached for this account or server');
  const actor = process.env.APIFY_INSTAGRAM_ACTOR?.trim() || 'apify/instagram-scraper';
  const input = {
    directUrls: [sourceUrl],
    resultsType: 'posts',
    resultsLimit: 1,
    addParentData: false,
  };
  const rows = await runApifyActorDatasetItems(actor, input, Math.min(budget.remaining(), Number(process.env.APIFY_VIDEO_TIMEOUT_MS || 240_000)), 'Instagram video');
  const row = rows[0];
  // IG 的 videoUrl 是 cdninstagram 签名直链（无扩展名），findApifyVideoDownloadUrl 的
  // 扩展名/白名单规则匹配不到，这里优先直接读 videoUrl 字段，再退回通用查找。
  const videoUrl = String(row?.videoUrl || '').trim() || (row ? findApifyVideoDownloadUrl(row) : '');
  if (!videoUrl) throw new Error('Apify did not return a downloadable video URL');
  const videoRes = await fetch(videoUrl, { signal: AbortSignal.timeout(budget.remaining()) });
  if (!videoRes.ok) throw new Error(`Apify video download HTTP ${videoRes.status}`);
  const buf = Buffer.from(await videoRes.arrayBuffer());
  if (buf.length < 1024) throw new Error('Apify returned an empty video file');
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const fileName = `${randomUUID()}.mp4`;
  const filePath = path.join(ANALYSIS_DIR, fileName);
  fs.writeFileSync(filePath, buf);
  recordApifyVideoFallbackUse(tenantId);
  return {
    filePath,
    fileName,
    mimeType: videoRes.headers.get('content-type')?.split(';')[0] || 'video/mp4',
    size: buf.length,
  };
}

function findFacebookPlayableUrl(value: unknown, depth = 0): string {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFacebookPlayableUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['browser_native_hd_url', 'playable_url_quality_hd', 'browser_native_sd_url', 'playable_url', 'videoUrl', 'downloadUrl']) {
    const found = findFacebookPlayableUrl(record[key], depth + 1);
    if (found) return found;
  }
  for (const item of Object.values(record)) {
    if (typeof item === 'object' && item) {
      const found = findFacebookPlayableUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

async function downloadFacebookVideoViaApify(sourceUrl: string, tenantId?: string, budget = new DownloadBudget(Math.max(10_000, Number(process.env.VIDEO_ANALYSIS_DOWNLOAD_TIMEOUT_MS || 150_000)))): Promise<{ filePath: string; fileName: string; mimeType: string; size: number }> {
  if (!process.env.APIFY_TOKEN?.trim()) throw new Error('APIFY_TOKEN is not configured');
  if (!canUseApifyVideoFallback(tenantId, 'facebook')) throw new Error('Apify video fallback daily limit reached for this account or server');
  const actor = process.env.APIFY_FACEBOOK_ACTOR?.trim() || 'apify/facebook-posts-scraper';
  const rows = await runApifyActorDatasetItems(actor, {
    startUrls: [{ url: sourceUrl }],
    resultsLimit: 1,
    maxPosts: 1,
  }, Math.min(budget.remaining(), Number(process.env.APIFY_VIDEO_TIMEOUT_MS || 180_000)), 'Facebook video');
  const videoUrl = rows[0] ? findFacebookPlayableUrl(rows[0]) : '';
  if (!videoUrl) throw new Error('Apify did not return a downloadable Facebook video URL');
  const videoRes = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(Math.min(90_000, budget.remaining())) });
  if (!videoRes.ok) throw new Error(`Apify Facebook video download HTTP ${videoRes.status}`);
  const buf = Buffer.from(await videoRes.arrayBuffer());
  if (buf.length < 1024) throw new Error('Apify returned an empty Facebook video file');
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const fileName = `${randomUUID()}.mp4`;
  const filePath = path.join(ANALYSIS_DIR, fileName);
  fs.writeFileSync(filePath, buf);
  recordApifyVideoFallbackUse(tenantId);
  return {
    filePath,
    fileName,
    mimeType: videoRes.headers.get('content-type')?.split(';')[0] || 'video/mp4',
    size: buf.length,
  };
}

async function runApifyActorDatasetItems(actor: string, input: Record<string, unknown>, timeoutMs: number, label: string): Promise<Record<string, unknown>[]> {
  const token = process.env.APIFY_TOKEN?.trim();
  if (!token) throw new Error('APIFY_TOKEN is not configured');
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const startUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/runs?token=${encodeURIComponent(token)}`;
  const start = await apifyJsonRequest(startUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, deadline, `${label} start`);
  const startRecord = asRecord(start);
  const run = asRecord(startRecord.data) || startRecord;
  const runId = String(run.id || '').trim();
  const datasetId = String(run.defaultDatasetId || '').trim();
  if (!runId || !datasetId) throw new Error(`Apify ${label} did not return run/dataset identifiers`);

  const pollIntervalMs = Math.max(1000, Number(process.env.APIFY_POLL_INTERVAL_MS || 5000));
  let status = String(run.status || '').toUpperCase();
  while (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
    if (Date.now() >= deadline) throw new Error(`Apify ${label} timed out while waiting for run ${runId}`);
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    const current = await apifyJsonRequest(
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`,
      { method: 'GET' },
      deadline,
      `${label} poll`,
    );
    const currentRecord = asRecord(current);
    const currentRun = asRecord(currentRecord.data) || currentRecord;
    status = String(currentRun.status || '').toUpperCase();
  }
  if (status !== 'SUCCEEDED') throw new Error(`Apify ${label} run ${runId} ended with status ${status}`);

  const items = await apifyJsonRequest(
    `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?clean=true&token=${encodeURIComponent(token)}`,
    { method: 'GET' },
    deadline,
    `${label} dataset`,
  );
  return Array.isArray(items) ? items as Record<string, unknown>[] : [];
}

async function apifyJsonRequest(url: string, init: RequestInit, deadline: number, label: string): Promise<unknown> {
  const controller = new AbortController();
  if (deadline <= Date.now()) throw new Error(`Apify ${label} 下载累计超时`);
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  try {
    const r = await fetch(url, { ...init, signal: controller.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`Apify ${label} HTTP ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) as unknown : {};
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


function findApifyVideoDownloadUrl(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^https?:\/\//i.test(text) && (/\.(mp4|mov|webm)(?:[?#]|$)/i.test(text) || /api\.apify\.com|api\.apifyusercontent\.com|storage\.googleapis\.com/i.test(text))) {
      return text;
    }
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findApifyVideoDownloadUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const priority = [
      'downloadedVideoUrl',
      'downloadUrl',
      'videoDownloadUrl',
      'videoUrl',
      'playAddr',
      'downloadAddr',
      'url',
    ];
    for (const key of priority) {
      const found = findApifyVideoDownloadUrl(record[key], depth + 1);
      if (found) return found;
    }
    for (const item of Object.values(record)) {
      const found = findApifyVideoDownloadUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

function cleanupTempVideo(filePath: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).split('.')[0];
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${base}.`)) {
      try { fs.unlinkSync(path.join(dir, file)); } catch { /* best effort */ }
    }
  }
}

function isQwenConfigured(): boolean {
  let fileKey = '';
  try { fileKey = fs.readFileSync(process.env.DASHSCOPE_API_KEY_FILE || path.join(process.env.HOME || '', '.config/lingshu/dashscope.key'), 'utf8').trim(); } catch { /* optional */ }
  const key = process.env.DASHSCOPE_API_KEY?.trim() || fileKey;
  return /^[\x21-\x7E]{20,}$/.test(key);
}

function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function shouldUseQwenFirst(): boolean {
  return (process.env.VIDEO_ANALYSIS_PROVIDER || 'qwen').trim().toLowerCase() === 'qwen';
}

function qwenFallbackTimeoutMs(): number {
  return Math.max(3000, Number(process.env.QWEN_VIDEO_FALLBACK_TIMEOUT_MS || 12000));
}

function videoAnalysisHardTimeoutMs(analysisMode: 'strategy' | 'exact' = 'strategy'): number {
  // Bound the complete frame extraction + ASR + VL request, not only the
  // individual OpenAI-compatible HTTP call.  Otherwise a record can remain in
  // `analyzing` forever when one of the preparatory stages stalls.
  const fallback = analysisMode === 'exact' ? 720_000 : 150_000;
  return Math.max(30_000, Number(process.env.VIDEO_ANALYSIS_HARD_TIMEOUT_MS || fallback));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isRetryableAnalysisFailure(error: unknown): boolean {
  if (classifyDiscoverySourceFailure(error) === 'model_unavailable') return false;
  return /analysis_quality_retryable|analysis_retryable|chunk_quality_failed|video_analysis_hard_timeout|exact_chunk_timeout/i
    .test(error instanceof Error ? error.message : String(error));
}

/** Only phrase-aligned ASR may populate a shot's dialogue. The current Qwen
 * ASR returns text without timestamps; its 30s chunk must never be copied to
 * every overlapping shot as if each shot contained the entire speech. */
type VideoAsrSegment = { words?: Array<{start: number; end: number; text: string}>; start: number; end: number; text: string; timingPrecision?: 'phrase' | 'coarse'; provenance?: string; needsReview?: boolean };

/** Qwen's inline ASR supplies text but no word clock. Preserve each sentence as
 * a reviewable interval within its actual extraction window; never invent a
 * narrower timestamp or promote it to phrase alignment. */
export function coarseAsrSentences(text: string, start: number, end: number): VideoAsrSegment[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const lines = String(text || '').trim().match(/[^。！？!?\n]+[。！？!?]?/g) || [];
  return lines.map(line => line.trim()).filter(Boolean).map(line => ({
    start, end, text: line, timingPrecision: 'coarse' as const,
    provenance: 'qwen3-asr-flash:inline_audio_window', needsReview: true,
  }));
}

export function lockAsrTimeline(analysis: VideoAiAnalysis, transcript?: ReferenceSpeechTranscript): VideoAiAnalysis {
  return lockReferenceSpeechTimeline(analysis, transcript);
}


function videoAnalysisTimelineEnd(analysis: VideoAiAnalysis): number {
  return (analysis.scriptDetails15s || []).reduce((max, detail) => {
    const range = parseAnalysisTimeRange(String(detail.time || detail.timestamp || ''));
    return Math.max(max, range?.end || 0);
  }, 0);
}

function assertFullVideoTimeline(analysis: VideoAiAnalysis, duration: number, source: string): void {
  if (!duration || duration <= 0) return;
  const analyzedUntil = videoAnalysisTimelineEnd(analysis);
  const tolerance = Math.max(1, Math.min(3, duration * 0.03));
  if (!analyzedUntil || analyzedUntil + tolerance < duration) {
    throw new Error(`${source}_incomplete_timeline_${analyzedUntil.toFixed(1)}s_of_${duration.toFixed(1)}s`);
  }
}

async function enrichExactGeminiEvidence(filePath: string, analysis: VideoAiAnalysis): Promise<VideoAiAnalysis> {
  const detectedSceneCuts = await detectVideoSceneCuts(filePath);
  let enriched = splitExactGeminiShotsAtSceneCuts(analysis, detectedSceneCuts);
  let hookReviewReasons: string[] = [];
  const hookIndex = firstSubstantiveOpeningShot(enriched);
  if (hookIndex >= 0) {
    try {
      const hookFrames = await extractOpeningHookFrames(filePath);
      const applied = applyOpeningHookMotionEvidence(enriched, await inspectOpeningHookMotionWithGemini({ frames: hookFrames }));
      enriched = applied.analysis;
      hookReviewReasons = applied.reviewReasons;
    } catch (error) {
      console.warn('[videos] opening hook motion inspection unavailable:', error instanceof Error ? error.message : error);
      hookReviewReasons = ['opening_hook_motion_inspection_failed'];
    }
  } else hookReviewReasons = ['opening_hook_no_substantive_shot'];
  return { ...enriched, detectedSceneCuts, hookReviewReasons } as VideoAiAnalysis;
}


async function analyzeExactLongVideoChunks(input: {
  frames: Array<{ base64: string; mimeType: string; timeLabel: string }>;
  title?: string;
  platform?: Platform;
  duration: number;
  views?: string;
  tags?: string[];
  transcript?: ReferenceSpeechTranscript;
  analysisMode?: 'strategy' | 'exact';
  sceneCuts?: number[];
}): Promise<VideoAiAnalysis> {
  // Keep each VL request small enough to finish reliably. Dense montage clips
  // can contain twenty or more observation boundaries in twelve seconds; that
  // response repeatedly exceeds the provider timeout even after reducing the
  // frame count. Six-second chunks bound both image input and schema output.
  const chunkSeconds = Math.max(4, Math.min(30, Number(process.env.VIDEO_EXACT_CHUNK_SECONDS || 6)));
  const inferredDuration = exactAnalysisDuration(input.duration, input.frames.map(frame => qwenFrameSeconds(frame.timeLabel)));
  const chunks = exactAnalysisChunkRanges(inferredDuration, chunkSeconds);
  const timelinePlanError = (plan: QwenTimelinePlan, duration: number): string | null => {
    const rows = plan.boundaries;
    if (!plan.theme.trim()) return 'missing_theme';
    if (!rows.length) return 'missing_boundaries';
    const ids = new Set<string>();
    let cursor = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row.id || ids.has(row.id)) return `duplicate_boundary_${index + 1}`;
      ids.add(row.id);
      if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.end <= row.start) return `invalid_boundary_${index + 1}`;
      if (Math.abs(row.start - cursor) > 0.35) return `boundary_gap_or_overlap_${index + 1}`;
      if (row.end - row.start > 5.35) return `boundary_too_long_${index + 1}`;
      cursor = row.end;
    }
    if (Math.abs(cursor - duration) > 0.5) return `boundary_tail_${cursor.toFixed(2)}_of_${duration.toFixed(2)}`;
    return null;
  };
  const analyzeChunk = async (chunk: { start: number; end: number }, frameLimit: number, signal: AbortSignal) => {
    const localDuration = chunk.end - chunk.start;
    let selected = input.frames.filter(frame => {
      const time = qwenFrameSeconds(frame.timeLabel);
      return time >= chunk.start && (time < chunk.end || chunk.end === input.duration);
    });
    if (!selected.length) {
      selected = [input.frames.reduce((nearest, frame) =>
        Math.abs(qwenFrameSeconds(frame.timeLabel) - chunk.start) < Math.abs(qwenFrameSeconds(nearest.timeLabel) - chunk.start) ? frame : nearest
      )];
    }
    selected = selectFramesForPhysicalCuts(selected, input.sceneCuts || [], chunk.start, chunk.end, frameLimit);
    const localFrames = selected.map(frame => ({ ...frame, timeLabel: `${Math.max(0, qwenFrameSeconds(frame.timeLabel) - chunk.start).toFixed(2)}s` }));
    const localSegments = (input.transcript?.segments || [])
      .filter(segment => segment.timingPrecision === 'phrase' && segment.end > chunk.start && segment.start < chunk.end)
      .map(segment => {
        const words = segment.words?.filter(word => word.end > chunk.start && word.start < chunk.end)
          .map(word => ({ ...word, start: Math.max(0, word.start - chunk.start), end: Math.min(localDuration, word.end - chunk.start) }));
        return { ...segment, ...(words?.length ? { words, text: joinReferenceWords(words) } : {}),
          start: Math.max(0, segment.start - chunk.start), end: Math.min(localDuration, segment.end - chunk.start) };
      });
    // Stage 1 is deterministic: lock continuous observation windows to the
    // real video clock. This is not a claim that every boundary is a cut; the
    // model only describes visible content inside each server-owned window.
    const observationSeconds = Math.max(2, Math.min(5, Number(process.env.VIDEO_EXACT_OBSERVATION_SECONDS || 4)));
    const cutPoints = [0, ...(input.sceneCuts || [])
      .filter(value => value > chunk.start + 0.02 && value < chunk.end - 0.02)
      .map(value => +(value - chunk.start).toFixed(2)), localDuration];
    const windows: Array<{ start: number; end: number; reason: string }> = [];
    for (let cutIndex = 0; cutIndex < cutPoints.length - 1; cutIndex += 1) {
      const start = cutPoints[cutIndex]!;
      const end = cutPoints[cutIndex + 1]!;
      const sections = Math.max(1, Math.ceil((end - start) / observationSeconds));
      for (let section = 0; section < sections; section += 1) {
        windows.push({
          start: +(start + (end - start) * section / sections).toFixed(2),
          end: +(start + (end - start) * (section + 1) / sections).toFixed(2),
          reason: section === 0 && cutIndex > 0 ? '检测到视觉切点' : '连续镜头观察段',
        });
      }
    }
    const timeline: QwenTimelinePlan = {
      theme: String(input.title || '真实视频画面分析'),
      identityEntities: [],
      hooks: [], sellingPoints: [], mood: '', structure: '', baseRequirements: '',
      firstTenSeconds: {}, coarseStructure: [], scriptSummary15s: {}, recommendedScriptType: 'storyboard',
      boundaries: windows.map((window, index) => ({
        id: `b${index + 1}`,
        start: window.start,
        end: window.end,
        reason: window.reason,
        evidence: '由真实视频时间轴及 ffmpeg 场景切点锁定，画面内容由关键帧分析填写',
      })),
    };
    const planError = timelinePlanError(timeline, localDuration);
    if (planError) throw new Error(`exact_timeline_quality_failed_${chunk.start.toFixed(0)}_${planError}`);
    console.log(`[videos] exact details ${chunk.start.toFixed(0)}-${chunk.end.toFixed(0)}s started, boundaries=${timeline.boundaries.length}`);
    const result = await analyzeVideoTimelineDetailsWithQwen({
      frames: localFrames,
      timeline,
      transcript: localSegments.length ? { text: localSegments.map(item => item.text).join(''), segments: localSegments } : undefined,
      signal,
    });
    const localQualityError = analysisTimelineQualityError(result, localDuration, input.analysisMode || 'exact');
    if (localQualityError) throw new Error(`${input.analysisMode || 'exact'}_chunk_quality_failed_${chunk.start.toFixed(0)}_${localQualityError}`);
    const details = (result.scriptDetails15s || []).map(detail => ({ ...detail,
      time: shiftedTimelineLabel(String(detail.time || detail.timestamp || ''), chunk.start, localDuration),
      beats: detail.beats?.map(beat => ({ ...beat,
        time: shiftedTimelineLabel(String(beat.time || ''), chunk.start, localDuration) })),
      tempoPhases: detail.tempoPhases?.map(phase => ({ ...phase,
        time: shiftedTimelineLabel(String(phase.time || ''), chunk.start, localDuration) })),
    }));
    return {
      ...result,
      coarseStructure: (result.coarseStructure || []).map(item => ({ ...item, time: shiftedTimelineLabel(String(item.time || ''), chunk.start, localDuration) })),
      scriptDetails15s: details,
    };
  };
  // A schema-complete director storyboard commonly needs more than one minute
  // even for a short clip. 110s remains bounded, while allowing the smaller
  // retry to finish instead of aborting a healthy generation at 60s.
  const chunkTimeoutMs = Math.max(20_000, Number(process.env.VIDEO_EXACT_CHUNK_TIMEOUT_MS || 150_000));
  const primaryFrameLimit = Math.max(8, Math.min(20, Number(process.env.VIDEO_EXACT_CHUNK_FRAME_LIMIT || 12)));
  const retryFrameLimit = Math.max(6, Math.min(primaryFrameLimit, Number(process.env.VIDEO_EXACT_RETRY_FRAME_LIMIT || 8)));
  const runWithTimeout = async (chunk: { start: number; end: number }, frameLimit: number, attempt: number) => {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutError = `exact_chunk_timeout_${chunk.start.toFixed(0)}_${chunk.end.toFixed(0)}`;
    const timeout = setTimeout(() => controller.abort(), chunkTimeoutMs);
    try {
      console.log(`[videos] exact chunk ${chunk.start.toFixed(0)}-${chunk.end.toFixed(0)}s started, frames=${frameLimit}, attempt=${attempt}`);
      const result = await analyzeChunk(chunk, frameLimit, controller.signal);
      console.log(`[videos] exact chunk ${chunk.start.toFixed(0)}-${chunk.end.toFixed(0)}s completed in ${Date.now() - startedAt}ms, frames=${frameLimit}, attempt=${attempt}`);
      return result;
    } catch (error) {
      const failure = controller.signal.aborted ? new Error(timeoutError) : error;
      console.warn(`[videos] exact chunk ${chunk.start.toFixed(0)}-${chunk.end.toFixed(0)}s failed in ${Date.now() - startedAt}ms, frames=${frameLimit}, attempt=${attempt}:`, failure instanceof Error ? failure.message : failure);
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  };
  const concurrency = Math.max(1, Math.min(3, Number(process.env.VIDEO_EXACT_CHUNK_CONCURRENCY || 2)));
  const settled = await executeExactChunks(chunks,exactQwenScope()?1:concurrency,(chunk,attempt)=>runWithTimeout(chunk,attempt===1?primaryFrameLimit:retryFrameLimit,attempt),!exactQwenScope());
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw new Error(`${classifyDiscoverySourceFailure(failure.reason) === 'model_unavailable' ? 'model_unavailable' : `${input.analysisMode || 'exact'}_analysis_retryable`}: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`);
  const results = settled.map(result => (result as PromiseFulfilledResult<VideoAiAnalysis>).value);
  const first = results[0];
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
  return {
    ...first,
    hooks: unique(results.flatMap(result => result.hooks || [])).slice(0, 6),
    sellingPoints: unique(results.flatMap(result => result.sellingPoints || [])).slice(0, 10),
    structure: unique(results.map(result => result.structure || '')).join(' → '),
    coarseStructure: results.flatMap(result => result.coarseStructure || []),
    scriptDetails15s: results.flatMap(result => result.scriptDetails15s || []),
  };
}

export function exactAnalysisChunkRanges(duration: number, chunkSeconds = 6): Array<{ start: number; end: number }> {
  const boundedDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const boundedChunkSeconds = Math.max(4, Math.min(30, Number.isFinite(chunkSeconds) ? chunkSeconds : 6));
  return Array.from({ length: Math.ceil(boundedDuration / boundedChunkSeconds) }, (_, index) => ({
    start: index * boundedChunkSeconds,
    end: Math.min(boundedDuration, (index + 1) * boundedChunkSeconds),
  }));
}

export function exactAnalysisDuration(duration: number, frameTimes: number[]): number {
  if (Number.isFinite(duration) && duration > 0) return duration;
  return Math.max(...frameTimes.filter(Number.isFinite).map(time => time + 3), 3);
}

export function exactSourceClockDuration(analysis: VideoAiAnalysis, expectedRunId: string): number | undefined {
  const clock = analysis.sourceMediaClock;
  if (!clock || !expectedRunId || clock.analysisRunId !== expectedRunId
    || !/^[a-f0-9]{64}$/i.test(clock.sourceSha256)
    || !Number.isFinite(clock.duration) || clock.duration <= 0) return undefined;
  return clock.duration;
}

export async function referenceNarrationForVideoAnalysis(
  filePath: string,
  duration: number,
  tenantId: string,
  ports: {
    readCached?: typeof readCachedReferenceNarration;
    prepare?: typeof prepareReferenceNarration;
  } = {},
) {
  const readCached = ports.readCached || readCachedReferenceNarration;
  const prepare = ports.prepare || prepareReferenceNarration;
  if (!exactQwenScope()) return prepare(filePath, duration, { tenantId });
  try {
    return readCached(filePath, tenantId) || {
      text: '', segments: [], words: [], alignmentStatus: 'unavailable',
      alignmentError: 'scoped_visual_revision_has_no_asr_authorization',
    };
  } catch {
    return { text: '', segments: [], words: [], alignmentStatus: 'unavailable',
      alignmentError: 'scoped_visual_revision_cached_asr_unavailable' };
  }
}

export const permitsCrossProviderHookMotionInspection = () => !exactQwenScope();
export function readExactQwenScopeContinuity(){const current=exactQwenScope();return current?{model:current.model,configurationHash:current.configurationHash,endpoint:current.endpoint,credentialDigest:current.credentialDigest}:null;}

export async function analyzeDownloadedVideoWithFallback(opts: {
  filePath: string;
  mimeType: string;
  title?: string;
  platform?: Platform;
  duration?: number;
  views?: string;
  tags?: string[];
  sourceLabel: string;
  videoId?: string;
  tenantId?: string;
  analysisMode?: 'strategy' | 'exact';
  analysisRunId?: string;
  videoObjectKey?: string;
}): Promise<{ analysis: VideoAiAnalysis; source: string }> {
  const sourceClock = await probeReferenceMediaClock(opts.filePath);
  opts = { ...opts, duration: sourceClock.duration };
  const sourceSha256 = createHash('sha256').update(fs.readFileSync(opts.filePath)).digest('hex');
  let speechPromise: Promise<ReferenceSpeechTranscript | undefined> | undefined;
  // A weekly candidate model revision authorizes one exact VL model/provider,
  // not an additional ASR product. Reuse already measured words when present,
  // but never turn the scoped visual retry into an unapproved paid ASR submit.
  const sourceSpeech = () => speechPromise ??= referenceNarrationForVideoAnalysis(
    opts.filePath, Number(opts.duration), opts.tenantId || 'reference_analysis')
    .catch(error => {
      console.warn('[videos] Measured source speech unavailable:', error instanceof Error ? error.message : error);
      return { text: '', segments: [], words: [], alignmentStatus: 'unavailable',
        alignmentError: error instanceof Error ? error.message : 'source_speech_unavailable' };
    });
  const finishSourceAnalysis = async (analysis: VideoAiAnalysis) => {
    const locked = lockReferenceSpeechTimeline(analysis, await sourceSpeech(),
      { duration: sourceClock.duration, fps: sourceClock.fps ?? undefined });
    const sourceBound = { ...locked, contentSha256: sourceSha256,
      durationSeconds: sourceClock.duration } as VideoAiAnalysis;
    const withClock: VideoAiAnalysis = opts.analysisMode === 'exact' && opts.analysisRunId ? {
      ...sourceBound,
      sourceMediaClock: { schemaVersion: 1, duration: sourceClock.duration, fps: sourceClock.fps,
        sourceSha256, analysisRunId: opts.analysisRunId, ...(opts.videoObjectKey ? { videoObjectKey: opts.videoObjectKey } : {}),
        measuredAt: new Date().toISOString() },
    } : sourceBound;
    if (opts.analysisMode !== 'exact' || !withClock.audioTranscript?.words?.length) return withClock;
    try {
      const sourceInput = { filePath: opts.filePath, analysis: withClock,
        videoId: opts.videoId || path.basename(opts.filePath, path.extname(opts.filePath)),
        sourceSha256,
        duration: sourceClock.duration, tenantId: opts.tenantId };
      const classified = await produceReferenceCriticalShots(sourceInput);
      try { return await produceReferenceProductionRouting({ ...sourceInput, analysis: classified }); }
      catch (error) { return { ...classified, referenceProductionRoutingError: error instanceof Error ? error.message : 'person_continuity_unavailable' }; }
    } catch (error) {
      return { ...withClock, criticalShotError: error instanceof Error ? error.message : 'critical_shot_unavailable' };
    }
  };
  const runQwen = async () => {
    // Dense opening frames + evenly distributed full-video evidence. Sixty base64
    // frames made long-video requests time out without materially improving the
    // Eighteen frames combine a dense opening with uniform and scene-change
    // evidence across the full duration, small enough for a reliable request.
    const exactFrameCount = Math.max(24, Math.min(72, Number(process.env.VIDEO_QWEN_EXACT_FRAME_COUNT || 42)));
    const strategyFrameCount = Math.max(3, Math.min(24, Number(process.env.VIDEO_QWEN_FRAME_COUNT || Math.ceil(Math.max(Number(opts.duration || 0), 10) / 5) + 1)));
    const detectedSceneCuts = opts.analysisMode === 'exact' ? await detectVideoSceneCuts(opts.filePath) : [];
    const coarseFrames = await extractQwenAnalysisFrames(
      opts.filePath,
      opts.analysisMode === 'exact' ? exactFrameCount : strategyFrameCount,
      Number(opts.duration || 0),
      opts.analysisMode === 'exact' ? 'exact' : 'strategy',
      detectedSceneCuts,
      'coarse',
    );
    const transcript = await sourceSpeech();
    let frames = coarseFrames;
    let presenterDenseSampling: { intervalSeconds: 0.5; ranges: ReferenceFrameSamplingRange[] } | null = null;
    if (opts.analysisMode === 'exact') {
      // Pass one answers only the material-type question from coarse, whole-video
      // evidence. Only a confirmed presenter shot authorizes the second,
      // temporally dense extraction used to distinguish stable/dynamic speech.
      const classificationFrames = selectFramesForPhysicalCuts(
        coarseFrames, detectedSceneCuts, 0, Number(opts.duration || 0), Math.min(12, coarseFrames.length),
      );
      const preliminary = await analyzeVideoFramesWithQwen({
        frames: classificationFrames,
        title: opts.title,
        platform: opts.platform,
        duration: opts.duration,
        views: opts.views,
        tags: opts.tags,
        transcript,
        analysisMode: 'strategy',
      });
      if (requiresPresenterDenseSampling(preliminary)) {
        const denseRanges = presenterDenseSamplingRanges(preliminary, Number(opts.duration || 0));
        presenterDenseSampling = { intervalSeconds: 0.5, ranges: denseRanges };
        frames = await extractQwenAnalysisFrames(
          opts.filePath, Math.max(exactFrameCount, Math.ceil(denseRanges.reduce((sum, range) => sum + range.endSeconds - range.startSeconds, 0) * 2)),
          Number(opts.duration || 0), 'exact', detectedSceneCuts, 'talking_head_dense', denseRanges,
        );
      }
    }
    // Exact mode always uses the chunk path, including short clips. Strategy
    // mode also chunks longer clips so each request stays bounded. Missing or
    // low-quality timelines now fail as retryable instead of being padded with
    // invented tail segments.
    const qwenAnalysis = opts.analysisMode === 'exact' || Number(opts.duration || 0) > 15
      ? await analyzeExactLongVideoChunks({ frames, title: opts.title, platform: opts.platform, duration: Number(opts.duration), views: opts.views, tags: opts.tags, transcript, analysisMode: opts.analysisMode || 'strategy', sceneCuts: detectedSceneCuts })
      : await analyzeVideoFramesWithQwen({
        frames,
        title: opts.title,
        platform: opts.platform,
        duration: opts.duration,
        views: opts.views,
        tags: opts.tags,
        transcript,
        analysisMode: opts.analysisMode || 'strategy',
      });
    const observationAnalysis = lockAsrTimeline(qwenAnalysis, transcript);
    assertFullVideoTimeline(observationAnalysis, Number(opts.duration || 0), 'qwen');
    const qualityError = analysisTimelineQualityError(observationAnalysis, Number(opts.duration || 0), opts.analysisMode || 'strategy');
    if (qualityError) throw new Error(`analysis_quality_retryable_${qualityError}`);
    let analysis = opts.analysisMode === 'exact'
      ? groupExactObservationWindows(observationAnalysis, detectedSceneCuts)
      : observationAnalysis;
    analysis = lockReferenceSpeechTimeline(analysis, transcript, { duration: Number(opts.duration), fps: sourceClock.fps ?? undefined });
    if (opts.analysisMode === 'exact' && (exactVideoClassificationQualityError(analysis)
      || (analysis.scriptDetails15s || []).some(shot => shot.needsReview === true))) {
      analysis = await repairVideoShotClassificationsWithQwen(analysis);
    }
    let hookReviewReasons: string[] = [];
    if (opts.analysisMode === 'exact') {
      const hookIndex = firstSubstantiveOpeningShot(analysis);
      if (hookIndex >= 0) {
        const hook = analysis.scriptDetails15s?.[hookIndex];
        const range = parseAnalysisTimeRange(String(hook?.time || hook?.timestamp || ''));
        if (range) {
          let motionEvidence;
          try {
            // The exact weekly revision is provider/model scoped to Qwen VL.
            // Gemini motion inspection is optional enrichment and must not
            // silently spend against a different provider authorization.
            if (!permitsCrossProviderHookMotionInspection()) throw new Error('scoped_visual_revision_skips_cross_provider_hook_motion');
            const hookFrames = await extractOpeningHookFrames(opts.filePath);
            motionEvidence = await inspectOpeningHookMotionWithGemini({ frames: hookFrames });
          } catch (error) {
            console.warn('[videos] opening hook motion inspection unavailable:', error instanceof Error ? error.message : error);
            motionEvidence = { observations: [], transitions: [], uncertainties: ['opening_hook_motion_inspection_failed'] };
          }
          const applied = applyOpeningHookMotionEvidence(analysis, motionEvidence);
          analysis = applied.analysis;
          hookReviewReasons = applied.reviewReasons;
        }
      } else {
        hookReviewReasons = ['opening_hook_no_substantive_shot'];
      }
    }
    return { analysis: await finishSourceAnalysis({ ...analysis, detectedSceneCuts, hookReviewReasons,
      ...(presenterDenseSampling ? { presenterDenseSampling } : {}) } as VideoAiAnalysis), source: 'qwen-frame-video' };
  };

  if (exactQwenScope() || shouldUseQwenFirst()) {
    if (!isQwenConfigured()) throw new Error('DASHSCOPE_API_KEY is not set');
    return withTimeout(runQwen(), videoAnalysisHardTimeoutMs(opts.analysisMode), 'video_analysis_hard_timeout');
  }

  try {
    const buf = fs.readFileSync(opts.filePath);
    const geminiPromise = analyzeVideo({
        videoBase64: buf.toString('base64'),
        mimeType: opts.mimeType,
        analysisMode: opts.analysisMode || 'strategy',
      });
    let analysis = isQwenConfigured()
      ? await withTimeout(geminiPromise, qwenFallbackTimeoutMs(), 'Gemini analysis timed out before Qwen fallback')
      : await geminiPromise;
    if (opts.analysisMode === 'exact') analysis = await enrichExactGeminiEvidence(opts.filePath, analysis);
    assertFullVideoTimeline(analysis, Number(opts.duration || 0), 'gemini');
    const qualityError = analysisTimelineQualityError(analysis, Number(opts.duration || 0), opts.analysisMode || 'strategy');
    if (qualityError) throw new Error(`analysis_quality_retryable_${qualityError}`);
    return { analysis: await finishSourceAnalysis(analysis), source: opts.sourceLabel };
  } catch (e) {
    // Promise timeouts do not prove that Gemini rejected or cancelled the
    // upstream request. Starting Qwen here could create a second paid analysis
    // while the first provider is still running. Fail closed and let the saved
    // run be reconciled instead of switching providers on an unknown outcome.
    if (/Gemini analysis timed out before Qwen fallback/i.test(e instanceof Error ? e.message : String(e))) throw e;
    if (shouldRetryGeminiWithNormalizedVideo(e)) {
      const normalizedPath = await normalizeVideoForGemini(opts.filePath);
      if (normalizedPath) {
        try {
          const buf = fs.readFileSync(normalizedPath);
          let analysis = await analyzeVideo({
            videoBase64: buf.toString('base64'),
            mimeType: 'video/mp4',
            analysisMode: opts.analysisMode || 'strategy',
          });
          if (opts.analysisMode === 'exact') analysis = await enrichExactGeminiEvidence(normalizedPath, analysis);
          assertFullVideoTimeline(analysis, Number(opts.duration || 0), 'gemini_normalized');
          const qualityError = analysisTimelineQualityError(analysis, Number(opts.duration || 0), opts.analysisMode || 'strategy');
          if (qualityError) throw new Error(`analysis_quality_retryable_${qualityError}`);
          return { analysis: await finishSourceAnalysis(analysis), source: `${opts.sourceLabel}-normalized` };
        } catch (normalizedError) {
          console.warn('[videos] Gemini normalized video analysis failed:', normalizedError instanceof Error ? normalizedError.message : normalizedError);
        } finally {
          try { fs.unlinkSync(normalizedPath); } catch { /* best effort cleanup */ }
        }
      }
    }
    if (!isQwenConfigured()) throw e;
    console.warn('[videos] Gemini video analysis failed, falling back to Qwen frames:', e instanceof Error ? e.message : e);
    return withTimeout(runQwen(), videoAnalysisHardTimeoutMs(opts.analysisMode), 'video_analysis_hard_timeout');
  }
}

function shouldRetryGeminiWithNormalizedVideo(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /0 Frames found|wrong video metadata|corrupted|INVALID_ARGUMENT/i.test(msg);
}

async function normalizeVideoForGemini(filePath: string): Promise<string> {
  if (!ffmpegBin || !fs.existsSync(filePath)) return '';
  const outPath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.gemini.mp4`);
  const ok = await runFfmpeg([
    '-i', filePath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', 'scale=trunc(min(720,iw)/2)*2:-2',
    '-r', '24',
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    '-y', outPath,
  ]);
  return ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0 ? outPath : '';
}

async function crawlYouTubeSearch(keyword: string, limit: number, dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  return crawlYouTubePublicSearch({ keyword, limit, dateFrom, dateTo, crawlFlatSearch: crawlYtDlpSearch });
}

async function crawlYtDlpSearch(platform: Platform, searchUrl: string, keyword: string, limit: number, dateFrom = '', dateTo = '', youtubeShortsSource = false): Promise<CrawledVideo[]> {
  const dateArgs = ytdlpDateArgs(dateFrom, dateTo);
  const { stdout } = await withPlatformCrawlPacing(platform, () => execFileAsync(ytDlpPythonPath(), buildYtDlpArgs(['--dump-json', '--flat-playlist', '--playlist-end', String(limit), ...dateArgs], searchUrl, false), {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 45_000,
    env: crawlerExecEnv(),
  }));
  const items = stdout.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
    .map(metaToCrawledVideo(platform, keyword, youtubeShortsSource))
    .filter((item): item is CrawledVideo => Boolean(item));
  if (items.length === 0) throw new Error(`${platform} search returned no videos`);
  return items.slice(0, limit);
}

async function crawlPublicSearch(platform: Platform, keyword: string, limit: number, dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  const candidates = await searchPublicVideoUrls(platform, keyword, Math.max(limit * 3, 12));
  const items: CrawledVideo[] = [];
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const item = await crawlYtDlpMetadata(platform, url, keyword);
      if (isKeywordRelevant(item, keyword) && isWithinDateRange(item.uploadedAt, dateFrom, dateTo) && hasRealThumbnail(item)) items.push(item);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (items.length >= limit) break;
  }
  if (items.length < limit) {
  const fallbackItems = await crawlKeywordFallbackPool(platform, keyword, limit - items.length, new Set(items.map(item => item.sourceUrl)), dateFrom, dateTo);
    items.push(...fallbackItems);
  }
  if (items.length === 0) {
    throw new Error(errors[0] || `${platform} keyword search did not expose public video URLs`);
  }
  return items.slice(0, limit);
}

async function crawlVerifiedPublicSources(platform: Platform, keyword: string, limit: number): Promise<CrawledVideo[]> {
  if (platform === 'tiktok') {
    return crawlYtDlpSearch('tiktok', pickTikTokSource(keyword), keyword, limit);
  }
  if (platform === 'facebook' || platform === 'instagram') {
    return crawlPublicSearch(platform, keyword, limit);
  }

  const seeds = verifiedSeedUrls(platform, keyword).slice(0, Math.max(1, limit));
  const items: CrawledVideo[] = [];
  const errors: string[] = [];
  for (const url of seeds) {
    try {
      items.push(await crawlYtDlpMetadata(platform, url, keyword));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (items.length >= limit) break;
  }
  if (items.length === 0) throw new Error(errors[0] || `${platform} verified public sources returned no videos`);
  return items;
}

function pickTikTokSource(keyword: string): string {
  const normalized = keyword.toLowerCase();
  if (normalized.includes('home') || normalized.includes('amazon') || normalized.includes('gadget')) {
    return 'tiktokuser:MS4wLjABAAAAr3NGz5igiD2kKCB-gnrNbB0TSfd4ScfTrgVOHqFor0lZfeVtDObaCXsugZMD5MDb';
  }
  return 'tiktokuser:MS4wLjABAAAAr3NGz5igiD2kKCB-gnrNbB0TSfd4ScfTrgVOHqFor0lZfeVtDObaCXsugZMD5MDb';
}

async function crawlKeywordFallbackPool(platform: Platform, keyword: string, limit: number, excluded = new Set<string>(), dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  if (limit <= 0) return [];
  if (platform === 'tiktok') return crawlTikTokKeywordFallback(keyword, limit, excluded, dateFrom, dateTo);
  return [];
}

async function topUpCrawledItems(input: {
  platform: Platform;
  keyword: string;
  target: number;
  items: CrawledVideo[];
  dateFrom: string;
  dateTo: string;
}): Promise<CrawledVideo[]> {
  const out = [...input.items];
  const seen = new Set(out.map(item => videoDedupeKey(item)));
  const add = (candidates: CrawledVideo[], dateEvidence: string) => {
    for (const candidate of candidates.map(normalizeCrawledVideo)) {
      if (!isDiscoveryVideoEligible(candidate)) continue;
      const key = videoDedupeKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...candidate, dateEvidence: candidate.dateEvidence || dateEvidence });
      if (out.length >= input.target) break;
    }
  };

  try {
    const strict = await crawlKeywordFallbackPool(
      input.platform,
      input.keyword,
      input.target - out.length,
      new Set(out.map(item => item.sourceUrl)),
      input.dateFrom,
      input.dateTo,
    );
    add(strict, 'fallback-strict');
  } catch (e) {
    console.warn(`[videos] ${input.platform} strict top-up failed:`, e instanceof Error ? e.message : e);
  }

  if (out.length < input.target) {
    try {
      const relaxed = await crawlKeywordFallbackPool(
        input.platform,
        input.keyword,
        input.target - out.length,
        new Set(out.map(item => item.sourceUrl)),
        '',
        '',
      );
      add(relaxed, 'fallback-relaxed');
    } catch (e) {
      console.warn(`[videos] ${input.platform} relaxed top-up failed:`, e instanceof Error ? e.message : e);
    }
  }

  return out.slice(0, Math.max(input.target, input.items.length));
}

async function crawlSeedMetadataFallback(platform: Platform, keyword: string, limit: number, excluded = new Set<string>(), dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  const seeds = verifiedKeywordSeedItems(platform, keyword)
    .filter(item => !excluded.has(item.sourceUrl))
    .filter(item => isKeywordRelevant(item, keyword))
    .filter(item => platform === 'tiktok' || isWithinDateRange(item.uploadedAt, dateFrom, dateTo));
  const out: CrawledVideo[] = [];
  for (const seed of seeds) {
    try {
      const item = await crawlYtDlpMetadata(platform, seed.sourceUrl, keyword);
      const enrichedItem = {
        ...item,
        title: item.title && !isGenericSocialTitle(item.title, platform) ? item.title : seed.title,
        tags: item.tags.length > 0 ? item.tags : seed.tags,
        uploadedAt: item.uploadedAt || seed.uploadedAt,
      };
      if (!isKeywordRelevant(enrichedItem, keyword)) continue;
      if (!isWithinDateRange(enrichedItem.uploadedAt, dateFrom, dateTo)) continue;
      if (!hasRealThumbnail(enrichedItem)) continue;
      out.push(enrichedItem);
    } catch (e) {
      console.warn(`[videos] ${platform} seed metadata failed (${seed.sourceUrl}):`, e);
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function crawlTikTokKeywordFallback(keyword: string, limit: number, excluded = new Set<string>(), dateFrom = '', dateTo = ''): Promise<CrawledVideo[]> {
  const sources = tiktokKeywordSources(keyword);
  const out: CrawledVideo[] = [];
  const seen = new Set<string>(excluded);

  for (const source of sources) {
    try {
      const sourceLimit = Math.min(36, Math.max(limit * 2, 12));
      const items = await crawlYtDlpSearch('tiktok', source, keyword, sourceLimit, dateFrom, dateTo);
      for (const item of items) {
        if (seen.has(item.sourceUrl) || !isKeywordRelevant(item, keyword) || !isWithinDateRange(item.uploadedAt, dateFrom, dateTo) || !hasRealThumbnail(item)) continue;
        seen.add(item.sourceUrl);
        out.push(item);
        if (out.length >= limit) return out;
      }
    } catch (e) {
      console.warn(`[videos] TikTok fallback source failed (${source}):`, e);
    }
  }

  return out.slice(0, limit);
}


// 采集某个对标账号主页的最新视频列表（flat-playlist 枚举，最多 limit 条）。
async function crawlAccountHomepage(platform: Platform, accountUrl: string, limit: number, dateFrom = '', dateTo = '', cloudFallback = false, strictProviderLimit = false): Promise<CrawledVideo[]> {
  if (platform === 'instagram') {
    let instagramItems: CrawledVideo[] = [];
    if (canUseApifyInstagramCrawlFallback()) {
      try {
        instagramItems = await crawlInstagramApify(accountUrl, Math.max(1, limit), dateFrom, dateTo);
      } catch (e) {
        console.warn('[videos] Instagram account Apify crawl failed:', e instanceof Error ? e.message : e);
      }
    }
    try {
      instagramItems = mergeCrawledVideos(instagramItems, await crawlYtDlpSearch(platform, normalizeAccountListUrl(platform, accountUrl), '', Math.max(1, limit), '', ''));
    } catch (e) {
      console.warn('[videos] Instagram account public crawl failed:', e instanceof Error ? e.message : e);
    }
    if (instagramItems.length === 0) throw new Error('Instagram 账号主页未抓到可用视频：请配置 APIFY_TOKEN 默认采集');
    return instagramItems.slice(0, limit);
  }
  const listUrl = normalizeAccountListUrl(platform, accountUrl);
  const safeLimit = Math.max(1, limit);
  let items: CrawledVideo[];
  if (platform === 'tiktok' && cloudFallback && canUseApifyTikTokCrawlFallback()) {
    try {
      const apifyItems = await crawlTikTokApify(accountUrl, safeLimit, dateFrom, dateTo, strictProviderLimit);
      const eligible = apifyItems.filter(item => isDiscoveryVideoEligible(item));
      if (eligible.length > 0) return eligible.slice(0, limit);
    } catch (apifyError) {
      console.warn('[videos] TikTok account cloud Apify crawl failed:', apifyError instanceof Error ? apifyError.message : apifyError);
    }
  }
  if (platform === 'facebook') {
    items = [];
    if (canUseApifyFacebookCrawlFallback()) {
      try {
        const apifyItems = await crawlFacebookAccountApify(accountUrl, safeLimit, dateFrom, dateTo, strictProviderLimit);
        items = mergeCrawledVideos(items, apifyItems);
      } catch (apifyError) {
        console.warn('[videos] Facebook account Apify crawl failed:', apifyError instanceof Error ? apifyError.message : apifyError);
      }
    }

    if (items.length < safeLimit) {
      try {
        const publicItems = await crawlFacebookAccountByPublicSearch(accountUrl, safeLimit - items.length);
        items = mergeCrawledVideos(items, publicItems);
      } catch (publicError) {
        console.warn('[videos] Facebook account public URL search failed:', publicError instanceof Error ? publicError.message : publicError);
      }
    }

    if (items.length === 0) {
      throw new Error('Facebook 账号主页未抓到可用视频：请配置 APIFY_TOKEN 默认采集');
    }
    const withinRange = hasDateRange(dateFrom, dateTo)
      ? items.filter(item => isWithinDateRange(item.uploadedAt, dateFrom, dateTo))
      : items;
    return (withinRange.length ? withinRange : items).slice(0, limit);
  }
  const candidates = accountListUrlCandidates(platform, accountUrl);
  const errors: unknown[] = [];
  for (const candidate of candidates) {
    try {
      items = await crawlYtDlpSearch(platform, candidate, '', safeLimit, '', '', platform === 'youtube');
      break;
    } catch (e) {
      errors.push(e);
      console.warn('[videos] account homepage flat enumeration failed:', e);
    }
  }
  if (!items!) {
    for (const candidate of candidates) {
      try {
        items = await enumerateAccountWithCookies(platform, candidate, safeLimit);
        break;
      } catch (cookieError) {
        errors.push(cookieError);
        console.warn('[videos] account homepage cookie enumeration failed:', cookieError);
      }
    }
  }
  if (!items!) {
    const lastError = errors[errors.length - 1];
    throw lastError instanceof Error ? lastError : new Error(`${platform} 账号主页未抓到可用视频`);
  }
  const withinRange = hasDateRange(dateFrom, dateTo)
    ? items.filter(item => isWithinDateRange(item.uploadedAt, dateFrom, dateTo))
    : items;
  return (withinRange.length ? withinRange : items)
    .map(normalizeCrawledVideo)
    .filter(item => isDiscoveryVideoEligible(item))
    .slice(0, limit);
}

async function crawlFacebookAccountByPublicSearch(accountUrl: string, limit: number): Promise<CrawledVideo[]> {
  const account = accountLabelFromUrl(accountUrl).replace(/^@/, '').trim();
  const hostPath = (() => {
    try {
      const url = new URL(accountUrl);
      return `${url.hostname.replace(/^www\./, '')}/${url.pathname.split('/').filter(Boolean)[0] || account}`;
    } catch {
      return `facebook.com/${account}`;
    }
  })();
  const query = `site:${hostPath} ("/videos/" OR "/reel/" OR "watch")`;
  const candidates = await searchPublicVideoUrlsByQuery('facebook', query, Math.max(limit * 4, 12));
  const items: CrawledVideo[] = [];
  for (const url of candidates) {
    try {
      const item = await crawlYtDlpMetadata('facebook', url, account);
      if (hasRealThumbnail(item)) items.push(item);
    } catch (e) {
      console.warn('[videos] Facebook account candidate failed:', e instanceof Error ? e.message : e);
    }
    if (items.length >= limit) break;
  }
  if (items.length === 0) throw new Error('Facebook 账号主页暂未搜索到可用公开视频');
  return items.slice(0, limit);
}

async function enumerateAccountWithCookies(platform: Platform, listUrl: string, limit: number): Promise<CrawledVideo[]> {
  const stdout = await execYtDlpWithCookieFallback(
    ['--dump-json', '--flat-playlist', '--playlist-end', String(limit)],
    listUrl,
    60_000,
    16 * 1024 * 1024,
  );
  const items = stdout.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; } })
    .filter((meta): meta is Record<string, unknown> => Boolean(meta))
    .map(metaToCrawledVideo(platform, '', platform === 'youtube' && /\/shorts(?:[/?#]|$)/i.test(listUrl)))
    .filter((item): item is CrawledVideo => Boolean(item));
  if (items.length === 0) throw new Error(`${platform} 账号主页没有枚举到可用视频`);
  return items.slice(0, limit);
}


function isTikTokUnusableWithoutVideoFallback(platform: Platform, message: string, record?: Record<string, unknown> | null): boolean {
  if (platform !== 'tiktok') return false;
  if (canUseApifyVideoFallback(apifyTenantIdFromRecord(record))) return false;
  return /0 Frames found|wrong video metadata|corrupted|INVALID_ARGUMENT|yt-dlp did not produce an analysis video file/i.test(message);
}

async function purgeLegacyFakeVideos(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' && process.env.PB_URL === undefined) return;
  if (!legacyFakePurgePromise) {
    legacyFakePurgePromise = (async () => {
      let page = 1;
      let removed = 0;
      while (page < 50) {
        const result = await store.list(COL, { page, perPage: 100 });
        for (const record of result.items) {
          const title = String(record.title || '');
          const sourceUrl = String(record.sourceUrl || '');
          if (isLegacyFakeVideo(title, sourceUrl)) {
            if (await store.delete(COL, record.id)) removed += 1;
          }
        }
        if (page >= result.totalPages || result.items.length === 0) break;
        page += 1;
      }
      if (removed > 0) console.log(`[videos] purged ${removed} legacy fake crawl records`);
    })().catch((e) => {
      legacyFakePurgePromise = null;
      console.warn('[videos] legacy fake purge failed:', e);
    });
  }
  await legacyFakePurgePromise;
}

function isLegacyFakeVideo(title: string, sourceUrl: string): boolean {
  return /auto-crawl sample/i.test(title)
    || /#auto-crawl-\d+/i.test(sourceUrl)
    || /\/search\/video\?q=.*#auto-crawl/i.test(sourceUrl)
    || /explore\/search\/keyword\/\?q=.*#auto-crawl/i.test(sourceUrl);
}

async function crawlFacebook(keyword: string, limit: number, dateFrom = '', dateTo = '', strictProviderLimit = false): Promise<CrawledVideo[]> {
  const input = keyword.trim();
  if (/^https?:\/\/(?:www\.|m\.|mbasic\.)?facebook\.com\//i.test(input)) {
    return [await crawlFacebookUrl(input, keyword)];
  }
  try {
    const publicItems = await crawlPublicSearch('facebook', input, limit, dateFrom, dateTo);
    if (publicItems.length > 0) return publicItems;
  } catch (publicError) {
    if (!canUseApifyFacebookCrawlFallback()) throw publicError;
  }
  if (!canUseApifyFacebookCrawlFallback()) throw new Error(`Facebook public search returned no videos for: ${input}`);
  const pageUrl = await discoverFacebookPageUrl(input);
  return crawlFacebookAccountApify(pageUrl, limit, dateFrom, dateTo, strictProviderLimit);
}

async function crawlFacebookUrl(url: string, keyword: string): Promise<CrawledVideo> {
  try {
    return await crawlYtDlpMetadata('facebook', url, keyword);
  } catch {
    // Fall back to lightweight OG parsing for public pages where yt-dlp cannot parse.
  }
  const html = await fetchFacebookHtml(url);
  const title = decodeHtml(extractMeta(html, 'og:title') || extractTitle(html) || 'Facebook video');
  const sourceUrl = decodeHtml(extractMeta(html, 'og:url') || url);
  const thumbnailUrl = decodeHtml(extractMeta(html, 'og:image') || '');
  const views = extractFacebookViews(title) || 'Facebook';

  return {
    platform: 'facebook',
    title: cleanupFacebookTitle(title),
    sourceUrl,
    thumbnailUrl,
    duration: 0,
    views,
    tags: tagsFromKeyword(keyword, 'facebook'),
  };
}

async function crawlFacebookSearch(keyword: string, limit: number): Promise<CrawledVideo[]> {
  const url = `https://www.facebook.com/search/videos?q=${encodeURIComponent(keyword)}`;
  const html = await fetchFacebookHtml(url);
  const candidates = extractFacebookWatchUrls(html);

  const out: CrawledVideo[] = [];
  const tags = tagsFromKeyword(keyword, 'facebook');
  for (const sourceUrl of candidates.slice(0, limit)) {
    out.push({
      platform: 'facebook',
      title: `Facebook video result for ${keyword}`,
      sourceUrl,
      thumbnailUrl: '',
      duration: 0,
      views: 'Facebook',
      tags,
    });
  }

  if (out.length === 0) throw new Error('Facebook public search did not expose parseable video results without login');
  return out;
}

async function fetchFacebookHtml(url: string): Promise<string> {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const args = [
    '-s',
    '-L',
    '--max-time',
    '20',
    '--noproxy',
    '*',
    '-A',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
  ];
  if (proxy) args.push('-x', proxy);
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 4 * 1024 * 1024, env: crawlerExecEnv() });
  if (!stdout || stdout.length < 500) throw new Error('Facebook returned an empty page');
  return stdout;
}

function proxyUrl(): string {
  return crawlerProxyUrl(runtimeCrawlerProxy);
}

function crawlerExecEnv(): NodeJS.ProcessEnv {
  return crawlerExecutionEnv(runtimeCrawlerProxy);
}

export function buildYtDlpArgs(extra: string[], url: string, withCookies: boolean): string[] {
  return buildVideoDownloaderArgs(extra, url, withCookies, {
    userAgent: browserUserAgent(), proxy: proxyUrl(), cookiesBrowser: cookiesBrowser(),
    nodeExecutable: process.execPath, youtubeEjsEnabled: process.env.YT_DLP_YOUTUBE_EJS_ENABLED !== '0',
  });
}

async function execYtDlpWithCookieFallback(extra: string[], url: string, timeout: number, maxBuffer: number, budget = new DownloadBudget(timeout)): Promise<string> {
  let lastError: unknown = null;
  for (const cookieFile of cookieFiles()) {
    try {
      const args = buildYtDlpArgs(extra, url, false);
      const proxy = proxyUrl();
      const insertAt = proxy ? args.indexOf('--proxy') : args.length - 1;
      args.splice(insertAt, 0, '--cookies', cookieFile);
      const { stdout } = await execFileAsync(ytDlpPythonPath(), args, { maxBuffer, timeout: budget.remaining(), env: crawlerExecEnv() });
      return stdout;
    } catch (e) {
      lastError = e;
      budget.record('cookie-file', e);
      if (terminalDownloadFailure(e)) throw budget.error();
    }
  }
  const browsers = cookieBrowsers();
  if (browsers.length === 0) {
    if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    throw new Error('需要平台登录态，但本机没有可读取的浏览器 cookies。请先配置 YT_DLP_COOKIE_FILES，或在 Safari/Chrome 登录对应平台并设置 YT_DLP_COOKIES_BROWSER。');
  }
  for (const browser of browsers) {
    try {
      const args = buildYtDlpArgs(extra, url, false);
      const proxy = proxyUrl();
      const insertAt = proxy ? args.indexOf('--proxy') : args.length - 1;
      args.splice(insertAt, 0, '--cookies-from-browser', browser);
      const { stdout } = await execFileAsync(ytDlpPythonPath(), args, { maxBuffer, timeout: budget.remaining(), env: crawlerExecEnv() });
      return stdout;
    } catch (e) {
      lastError = e;
      budget.record(browser, e);
      if (terminalDownloadFailure(e)) throw budget.error();
    }
  }
  throw budget.error('yt-dlp cookie fallback failed');
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

type ApifyVideoUsageDay = {
  total: number;
  tenants: Record<string, number>;
};

type ApifyVideoUsageStore = Record<string, number | ApifyVideoUsageDay>;

function loadApifyVideoUsage(): ApifyVideoUsageStore {
  try {
    return JSON.parse(fs.readFileSync(APIFY_USAGE_FILE, 'utf8')) as ApifyVideoUsageStore;
  } catch {
    return {};
  }
}

function apifyVideoDailyLimit(): number {
  return Math.max(0, Number(process.env.APIFY_TIKTOK_VIDEO_DAILY_LIMIT || 25));
}

function apifyVideoTenantDailyLimit(): number {
  return Math.max(0, Number(process.env.APIFY_TIKTOK_VIDEO_TENANT_DAILY_LIMIT || 3));
}

function normalizeApifyUsageDay(raw: number | ApifyVideoUsageDay | undefined): ApifyVideoUsageDay {
  if (typeof raw === 'number') {
    return { total: raw, tenants: {} };
  }
  if (raw && typeof raw === 'object') {
    return {
      total: Math.max(0, Number(raw.total || 0)),
      tenants: raw.tenants && typeof raw.tenants === 'object' ? raw.tenants : {},
    };
  }
  return { total: 0, tenants: {} };
}

function apifyTenantKey(tenantId?: string): string {
  return tenantId?.trim() || '__unknown__';
}

function apifyTenantIdFromRecord(record?: Record<string, unknown> | null): string | undefined {
  const tenantId = String(record?.tenantId || '').trim();
  return tenantId || undefined;
}

function apifyVideoUsageToday(tenantId?: string): { total: number; tenant: number } {
  const usage = loadApifyVideoUsage();
  const day = normalizeApifyUsageDay(usage[todayKey()]);
  return {
    total: day.total,
    tenant: day.tenants[apifyTenantKey(tenantId)] || 0,
  };
}

function canUseApifyVideoFallback(tenantId?: string, platform: Platform = 'tiktok'): boolean {
  const enableEnv = platform === 'instagram'
    ? 'APIFY_INSTAGRAM_VIDEO_FALLBACK_ENABLED'
    : platform === 'facebook'
      ? 'APIFY_FACEBOOK_VIDEO_FALLBACK_ENABLED'
      : platform === 'youtube'
        ? 'APIFY_YOUTUBE_VIDEO_FALLBACK_ENABLED'
        : 'APIFY_TIKTOK_VIDEO_FALLBACK_ENABLED';
  if (process.env[enableEnv] === '0') return false;
  if (!process.env.APIFY_TOKEN?.trim()) return false;
  // TikTok / Instagram 共用同一份 Apify 视频下载日额度（apify-video-usage.json）。
  const globalLimit = apifyVideoDailyLimit();
  const tenantLimit = apifyVideoTenantDailyLimit();
  if (globalLimit <= 0 || tenantLimit <= 0) return false;
  const usage = apifyVideoUsageToday(tenantId);
  return usage.total < globalLimit && usage.tenant < tenantLimit;
}

function canUseApifyInstagramCrawlFallback(): boolean {
  return process.env.APIFY_INSTAGRAM_CRAWL_FALLBACK_ENABLED !== '0' && Boolean(process.env.APIFY_TOKEN?.trim());
}

function canUseApifyFacebookCrawlFallback(): boolean {
  return process.env.APIFY_FACEBOOK_CRAWL_FALLBACK_ENABLED !== '0' && Boolean(process.env.APIFY_TOKEN?.trim());
}

function canUseApifyTikTokCrawlFallback(): boolean {
  return process.env.APIFY_TIKTOK_CRAWL_FALLBACK_ENABLED !== '0' && Boolean(process.env.APIFY_TOKEN?.trim());
}

function recordApifyVideoFallbackUse(tenantId?: string): void {
  const usage = loadApifyVideoUsage();
  const key = todayKey();
  const day = normalizeApifyUsageDay(usage[key]);
  const tenantKey = apifyTenantKey(tenantId);
  day.total += 1;
  day.tenants[tenantKey] = (day.tenants[tenantKey] || 0) + 1;
  usage[key] = day;
  fs.mkdirSync(path.dirname(APIFY_USAGE_FILE), { recursive: true });
  fs.writeFileSync(APIFY_USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
}

function loadCrawlerOpsTasks(): CrawlerOpsTask[] {
  try {
    return JSON.parse(fs.readFileSync(CRAWLER_OPS_FILE, 'utf8')) as CrawlerOpsTask[];
  } catch {
    return [];
  }
}

async function crawlerOpsRecordIdsForTenant(tenantId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = 1;
  for (;;) {
    const records = await store.list<Record<string, unknown>>(COL, {
      where: { tenantId },
      page,
      perPage: 500,
    });
    for (const record of records.items) {
      const id = String(record.id || '').trim();
      if (id) ids.add(id);
    }
    if (page >= records.totalPages || records.items.length < 500 || page >= 20) break;
    page += 1;
  }
  return ids;
}

function persistCrawlerOpsTasks(tasks: CrawlerOpsTask[]): void {
  fs.mkdirSync(path.dirname(CRAWLER_OPS_FILE), { recursive: true });
  fs.writeFileSync(CRAWLER_OPS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

function updateCrawlerOpsTask(taskId: string, patch: Partial<CrawlerOpsTask>): CrawlerOpsTask | null {
  if (!taskId) return null;
  const tasks = loadCrawlerOpsTasks();
  let updated: CrawlerOpsTask | null = null;
  persistCrawlerOpsTasks(tasks.map(task => {
    if (task.id !== taskId) return task;
    updated = { ...task, ...patch, updatedAt: patch.updatedAt || new Date().toISOString() };
    return updated;
  }));
  return updated;
}

function resetCrawlerOpsTaskForExplicitRetry(input: {
  recordId: string;
  tenantId: string;
  userId: string;
  usesSourceQueue: boolean;
  now?: string;
}): CrawlerOpsTask | null {
  const tasks = loadCrawlerOpsTasks();
  let updated: CrawlerOpsTask | null = null;
  persistCrawlerOpsTasks(tasks.map(task => {
    if (task.recordId !== input.recordId) return task;
    if (task.tenantId && task.tenantId !== input.tenantId) return task;
    updated = resetCrawlerOpsTaskForExplicitRetryState(task, input);
    return updated;
  }));
  return updated;
}

function resolveCrawlerOpsTasksForRecord(recordId: string, reason: string): void {
  const now = new Date().toISOString();
  const tasks = loadCrawlerOpsTasks();
  let changed = false;
  const next = tasks.map(task => {
    if (task.recordId !== recordId || task.status === 'resolved') return task;
    changed = true;
    return { ...task, status: 'resolved' as const, reason, updatedAt: now };
  });
  if (changed) persistCrawlerOpsTasks(next);
}

function enqueueCrawlerOpsTask(input: {
  recordId: string;
  tenantId?: string;
  platform: Platform;
  sourceUrl: string;
  title: string;
  reason: string;
  forceQueue?: boolean;
}): CrawlerOpsTask {
  const now = new Date().toISOString();
  const tasks = loadCrawlerOpsTasks();
  const existing = tasks.find(task =>
    task.recordId === input.recordId &&
    (!input.tenantId || !task.tenantId || task.tenantId === input.tenantId) &&
    task.sourceUrl === input.sourceUrl &&
    task.status !== 'resolved'
  );
  if (existing) {
    // A periodic recovery scan may see the same persisted record many times.
    // Merely rediscovering it is not another download attempt; attempts are
    // incremented only when the worker actually picks the task.
    const updated = {
      ...existing,
      tenantId: existing.tenantId || input.tenantId,
      ...(input.forceQueue ? { status: 'queued' as const } : {}),
      reason: input.reason,
      updatedAt: now,
    };
    persistCrawlerOpsTasks(tasks.map(task => task.id === existing.id ? updated : task));
    return updated;
  }
  const task: CrawlerOpsTask = {
    id: randomUUID(),
    recordId: input.recordId,
    tenantId: input.tenantId,
    platform: input.platform,
    sourceUrl: input.sourceUrl,
    title: input.title,
    status: 'queued',
    reason: input.reason,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  persistCrawlerOpsTasks([task, ...tasks].slice(0, 1000));
  return task;
}

export async function runQueuedLocalAnalysisWorkerOnce(options: { recoverInterrupted?: boolean; tenantId?: string } = {}): Promise<{
  picked: number;
  completed: number;
  failed: number;
  skipped: number;
}> {
  if (localAnalysisWorkerActive) return { picked: 0, completed: 0, failed: 0, skipped: 0 };
  localAnalysisWorkerActive = true;
  let picked = 0;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const records: Record<string, unknown>[] = [];
    for (let page = 1; ; page += 1) {
      const result = await store.list<Record<string, unknown>>(COL, {
        where: options.tenantId ? { tenantId: options.tenantId } : undefined,
        sort: 'updated',
        page,
        perPage: 300,
      });
      records.push(...result.items);
      if (page >= result.totalPages || !result.items.length || page >= 20) break;
    }
    const now = Date.now();
    const staleMs = Math.max(5 * 60_000, Number(process.env.LOCAL_ANALYSIS_RECOVERY_MS || 15 * 60_000));
    const candidates = records.filter(record => {
      const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
      if (!analysis.requestedAnalysisMode) return false;
      const kind = String(analysis.analysisQueueKind || '');
      if (kind === 'source_url') return false;
      if (!['material', 'stored_video', 'classification_repair'].includes(kind) && !record.videoFileId && !analysis.materialId) return false;
      const state = String(analysis.analysisQueueState || 'queued');
      if (state === 'queued') return true;
      if (state !== 'running') return false;
      if (options.recoverInterrupted) return true;
      const startedAt = Date.parse(String(analysis.analysisWorkerStartedAt || record.updated || ''));
      return Number.isFinite(startedAt) && now - startedAt >= staleMs;
    }).slice(0, Math.max(1, Number(process.env.LOCAL_ANALYSIS_WORKER_BATCH || 2)));

    for (const record of candidates) {
      const recordId = String(record.id || '');
      if (!recordId || activeAnalysisRecords.has(recordId)
        || (!options.recoverInterrupted && durableAnalysisRecords.has(recordId))) {
        skipped += 1;
        continue;
      }
      picked += 1;
      try {
        if (await executeQueuedLocalAnalysisRecord(recordId)) completed += 1;
        else skipped += 1;
      } catch (error) {
        if (error instanceof AnalysisAlreadyRunningError) skipped += 1;
        else failed += 1;
      }
    }
  } finally {
    localAnalysisWorkerActive = false;
  }
  return { picked, completed, failed, skipped };
}

export function initCrawlerOpsWorker(): void {
  const workerFlag = process.env.CRAWLER_OPS_WORKER_ENABLED;
  const intervalMs = Math.max(5_000, Number(process.env.CRAWLER_OPS_WORKER_INTERVAL_MS || 30_000));
  if (!stalledExactSweepTimer) {
    const sweep = () => void releaseStalledExactAnalysisAcrossAuthorities().catch(error => {
      console.warn('[videos] stalled exact-analysis sweep failed:', error instanceof Error ? error.message : error);
    });
    stalledExactSweepTimer = setInterval(sweep, intervalMs);
    // Every requested exact analysis belongs to the previous process at this
    // point. Clear those locks now; waiting for the age threshold creates a
    // false permanent queue after deployments or crashes.
    void releaseStalledExactAnalysisAcrossAuthorities(true).catch(error => {
      console.warn('[videos] interrupted exact-analysis recovery failed:', error instanceof Error ? error.message : error);
    });
    console.log(`[videos] stalled exact-analysis sweep enabled, interval=${intervalMs}ms`);
  }
  if (crawlerOpsWorkerTimer || workerFlag === '0') return;
  crawlerOpsWorkerTimer = setInterval(() => {
    void runCrawlerOpsWorkerOnce().then(logCrawlerOpsWorkerResult).catch((e) => {
      console.warn('[crawler-ops] worker tick failed:', e instanceof Error ? e.message : e);
    });
    void runQueuedLocalAnalysisWorkerOnce().then(result => {
      if (result.picked) console.log(`[video-analysis-worker] picked=${result.picked} completed=${result.completed} failed=${result.failed} skipped=${result.skipped}`);
    }).catch((e) => {
      console.warn('[video-analysis-worker] tick failed:', e instanceof Error ? e.message : e);
    });
  }, intervalMs);
  // No analysis job survives a process restart. Recover records persisted as
  // downloading/analyzing immediately on the first tick instead of waiting for
  // the normal active-job stall timeout.
  void runCrawlerOpsWorkerOnce({ recoverInterrupted: true }).then(logCrawlerOpsWorkerResult).catch((e) => {
    console.warn('[crawler-ops] initial tick failed:', e instanceof Error ? e.message : e);
  });
  void runQueuedLocalAnalysisWorkerOnce({ recoverInterrupted: true }).catch((e) => {
    console.warn('[video-analysis-worker] initial recovery failed:', e instanceof Error ? e.message : e);
  });
  console.log(`[crawler-ops] worker enabled, interval=${intervalMs}ms`);
}

function logCrawlerOpsWorkerResult(result: { picked: number; resolved: number; retried: number; failed: number; skipped: number }): void {
  if (result.picked === 0) return;
  console.log(`[crawler-ops] picked=${result.picked} resolved=${result.resolved} retried=${result.retried} failed=${result.failed} skipped=${result.skipped}`);
}

export async function runCrawlerOpsWorkerOnce(options: { recoverInterrupted?: boolean; tenantId?: string } = {}): Promise<{
  ok: boolean;
  picked: number;
  resolved: number;
  retried: number;
  failed: number;
  skipped: number;
}> {
  if (crawlerOpsWorkerActive) {
    return { ok: true, picked: 0, resolved: 0, retried: 0, failed: 0, skipped: 0 };
  }
  crawlerOpsWorkerActive = true;
  const previousProxy = runtimeCrawlerProxy;
  const maxBatch = Math.max(1, Number(process.env.CRAWLER_OPS_WORKER_BATCH || 2));
  const maxAttempts = Math.max(1, Number(process.env.CRAWLER_OPS_MAX_ATTEMPTS || 5));
  let picked = 0;
  let resolved = 0;
  let retried = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const tenantId = options.tenantId?.trim() || undefined;
    await enqueueOpsTasksFromRecords(options.recoverInterrupted === true, tenantId, maxAttempts);
    // 回收卡死的精确分析请求。失败不应连累队列本身，单独兜住。
    await releaseStalledExactAnalysis(false, tenantId).catch(error => {
      console.warn('[videos] stalled exact-analysis sweep failed:', error instanceof Error ? error.message : error);
      return 0;
    });
    const visibleRecordIds = tenantId ? await crawlerOpsRecordIdsForTenant(tenantId) : undefined;
    const candidates = pendingCrawlerOpsTasks(maxAttempts, visibleRecordIds).slice(0, maxBatch);
    for (const task of candidates) {
      picked += 1;
      const record = await store.getById(COL, task.recordId);
      if (!record) {
        updateCrawlerOpsTask(task.id, { status: 'failed', lastError: 'record_not_found', reason: 'record_not_found' });
        failed += 1;
        continue;
      }
      if (tenantId && String(record.tenantId || '') !== tenantId) {
        // A tenant-scoped HTTP run must never mutate a task whose backing
        // record moved or was incorrectly associated with another tenant.
        skipped += 1;
        continue;
      }
      if (activeAnalysisRecords.has(task.recordId)
        || (!options.recoverInterrupted && durableAnalysisRecords.has(task.recordId))) { skipped += 1; continue; }
      const previous = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
      if (!previous.requestedAnalysisMode && ['paused', 'cancelled'].includes(String(previous.analysisQueueState || previous.geminiStatus || ''))) {
        updateCrawlerOpsTask(task.id, { status: 'resolved', reason: String(previous.analysisQueueState || previous.geminiStatus) });
        skipped += 1;
        continue;
      }
      if (previous.analysisQuality === 'video' && previous.requestedAnalysisMode !== 'exact') {
        updateCrawlerOpsTask(task.id, { status: 'resolved', lastStrategy: 'already_video' });
        resolved += 1;
        continue;
      }

      const attemptNo = task.attempts + 1;
      runtimeCrawlerProxy = selectCrawlerProxy(attemptNo);
      const strategy = [
        runtimeCrawlerProxy ? `proxy:${redactProxy(runtimeCrawlerProxy)}` : 'proxy:direct',
        cookieFiles().length ? `cookieFiles:${cookieFiles().length}` : '',
        cookieBrowsers().length ? `browsers:${cookieBrowsers().join('|')}` : '',
      ].filter(Boolean).join(' ');
      updateCrawlerOpsTask(task.id, {
        status: 'processing',
        attempts: attemptNo,
        lastStrategy: strategy,
        updatedAt: new Date().toISOString(),
      });
      await store.update(COL, task.recordId, {
        status: 'pending' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...previous,
          downloadStatus: 'downloading',
          videoFetchStatus: 'ops_processing',
          geminiStatus: 'waiting_for_video',
          crawlerOpsTaskId: task.id,
          crawlerOpsStatus: 'processing',
          crawlerOpsStrategy: strategy,
          crawlerOpsAttempt: attemptNo,
          crawlerOpsStartedAt: new Date().toISOString(),
        }),
      });

      try {
        await analyzeSourceVideoJob({
          record,
          sourceUrl: task.sourceUrl,
          title: task.title,
          platform: task.platform,
          opsTaskId: task.id,
          suppressOpsRequeue: true,
        });
        const completed = await store.getById(COL, task.recordId);
        const evidence = parseJsonRecord<Record<string, unknown>>(completed?.aiAnalysis, {});
        if (!['video', 'video_review_required'].includes(String(evidence.analysisQuality || '')) || !evidence.gemini) {
          throw new Error(String(evidence.analysisError || evidence.downloadError || 'video_analysis_missing: metadata is not video-level analysis'));
        }
        updateCrawlerOpsTask(task.id, {
          status: 'resolved',
          lastStrategy: evidence.analysisQuality === 'video_review_required' ? `${strategy}; quality_review_required` : strategy,
          updatedAt: new Date().toISOString(),
        });
        resolved += 1;
      } catch (e) {
        if (e instanceof AnalysisAlreadyRunningError) {
          updateCrawlerOpsTask(task.id, { status: 'queued', attempts: task.attempts, lastError: 'analysis_already_running' });
          skipped += 1;
          continue;
        }
        const errorMessage = e instanceof Error ? e.message : String(e);
        const compactError = compactVideoPipelineError(errorMessage);
        const compactReason = compactVideoPipelineError(classifyCrawlerFailure(errorMessage), 360);
        // Every platform fallback already ran under downloadVideoForAnalysis's
        // single deadline and ownership lock. Do not start a second independent
        // actor/download chain here after the attempt has exhausted its budget.
        const canRetry = attemptNo < maxAttempts;
        updateCrawlerOpsTask(task.id, {
          status: canRetry ? 'queued' : 'failed',
          reason: compactReason,
          lastError: compactError,
          lastStrategy: strategy,
          updatedAt: new Date().toISOString(),
        });
        if (!canRetry) {
          const fallback = metadataFallbackAnalysis({
            platform: task.platform,
            title: task.title,
            duration: Number(record.duration || 0),
            views: String(parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {}).views || task.platform),
            tags: parseJsonRecord<string[]>(record.tags, []),
          });
          await persistManualVideoFailure({
            record,
            sourceUrl: task.sourceUrl,
            title: task.title,
            platform: task.platform,
          }, compactError, compactReason, fallback);
          failed += 1;
          continue;
        }
        const latest = await store.getById(COL, task.recordId);
        const latestAnalysis = parseJsonRecord<Record<string, unknown>>(latest?.aiAnalysis ?? record.aiAnalysis, {});
        await store.update(COL, task.recordId, {
          status: 'analyzed' as VideoStatus,
          aiAnalysis: JSON.stringify({
            ...latestAnalysis,
            downloadStatus: 'ops_queued',
            videoFetchStatus: canRetry ? 'ops_queued' : 'ops_failed',
            geminiStatus: 'waiting_for_video',
            crawlerOpsStatus: canRetry ? 'queued' : 'failed',
            crawlerOpsReason: compactReason,
            crawlerOpsLastError: compactError,
            crawlerOpsNextRetryAt: canRetry ? new Date(Date.now() + crawlerRetryDelayMs(attemptNo)).toISOString() : undefined,
          }),
        });
        retried += 1;
      }
    }
  } finally {
    runtimeCrawlerProxy = previousProxy;
    crawlerOpsWorkerActive = false;
  }
  return { ok: true, picked, resolved, retried, failed, skipped };
}

function pendingCrawlerOpsTasks(maxAttempts: number, visibleRecordIds?: Set<string>): CrawlerOpsTask[] {
  return selectPendingCrawlerOpsTasks(loadCrawlerOpsTasks(), maxAttempts, visibleRecordIds);
}

async function enqueueOpsTasksFromRecords(recoverInterrupted = false, tenantId?: string, maxAttempts = Math.max(1, Number(process.env.CRAWLER_OPS_MAX_ATTEMPTS || 5))): Promise<void> {
  const maxScan = Math.max(50, Number(process.env.CRAWLER_OPS_SCAN_LIMIT || 300));
  const records: Record<string, unknown>[] = [];
  for (let page = 1; ; page += 1) {
    const result = await store.list<Record<string, unknown>>(COL, { where: tenantId ? { tenantId } : undefined, sort: '-crawledAt', page, perPage: maxScan });
    records.push(...result.items);
    if (page >= result.totalPages || !result.items.length) break;
  }
  const now = Date.now();
  for (const record of records) {
    if (activeAnalysisRecords.has(String(record.id || ''))
      || (!recoverInterrupted && durableAnalysisRecords.has(String(record.id || '')))) continue;
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    if (analysis.analysisQuality === 'video' && analysis.requestedAnalysisMode !== 'exact') continue;
    const downloadStatus = String(analysis.downloadStatus || '');
    const videoFetchStatus = String(analysis.videoFetchStatus || '');
    const shouldEnqueue = downloadStatus === 'ops_queued' || videoFetchStatus === 'ops_queued';
    const latestProgressAt = Math.max(
      Date.parse(String(analysis.geminiStartedAt || '')) || 0,
      Date.parse(String(analysis.downloadStartedAt || '')) || 0,
      Date.parse(String(analysis.analysisQueuedAt || '')) || 0,
      Date.parse(String(record.updated || '')) || 0,
    );
    // Queued work previously lived only in process memory. After a restart it
    // could remain waiting forever. Recover never-started jobs quickly, while
    // giving active downloads/Gemini calls a generous window to finish.
    const staleQueued = downloadStatus === 'queued'
      && latestProgressAt > 0
      && now - latestProgressAt >= Math.max(60_000, Number(process.env.CRAWLER_QUEUED_RECOVERY_MS || 2 * 60_000));
    const interruptedActive = recoverInterrupted && ['downloading', 'analyzing'].includes(downloadStatus);
    const staleActive = ['downloading', 'analyzing'].includes(downloadStatus)
      && latestProgressAt > 0
      && now - latestProgressAt >= Math.max(5 * 60_000, Number(process.env.CRAWLER_ACTIVE_RECOVERY_MS || 30 * 60_000));
    if (!shouldEnqueue && !staleQueued && !staleActive && !interruptedActive) continue;
    const recordId = String(record.id || '');
    const sourceUrl = String(record.sourceUrl || '').trim();
    if (!recordId || !/^https?:\/\//i.test(sourceUrl)) continue;
    const task = enqueueCrawlerOpsTask({
      recordId,
      tenantId: String(record.tenantId || '').trim() || tenantId,
      platform: (record.platform || inferPlatformFromUrl(sourceUrl)) as Platform,
      sourceUrl,
      title: String(record.title || 'social-video'),
      reason: String(analysis.downloadError || analysis.crawlerOpsReason || (interruptedActive ? 'recovered_after_restart' : staleQueued ? 'recovered_stale_queue' : staleActive ? 'recovered_stalled_analysis' : 'ops_queued')),
    });
    const legacyRecoveredZombie = interruptedActive
      && task.status === 'queued'
      && task.reason === 'recovered_after_restart'
      && !task.recoveredAt;
    if ((interruptedActive || staleActive) && (task.status === 'processing' || legacyRecoveredZombie)) {
      const recoveredAt = new Date().toISOString();
      const recovered = recoverInterruptedCrawlerOpsTask(task, recoveredAt);
      updateCrawlerOpsTask(task.id, recovered);
      await store.update(COL, recordId, {
        status: 'analyzed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...analysis,
          downloadStatus: 'ops_queued',
          videoFetchStatus: 'ops_queued',
          geminiStatus: 'waiting_for_video',
          crawlerOpsTaskId: task.id,
          crawlerOpsStatus: 'queued',
          crawlerOpsReason: interruptedActive ? 'recovered_after_restart' : 'recovered_stalled_attempt',
          crawlerOpsAttempt: recovered.attempts,
          crawlerOpsRecoveredAt: recoveredAt,
          crawlerOpsNextRetryAt: recoveredAt,
        }),
      });
      continue;
    }
    if (task.attempts >= maxAttempts && task.status !== 'resolved') {
      const exhaustedAt = new Date().toISOString();
      const exhausted = terminalizeExhaustedCrawlerOpsTask(task, maxAttempts, exhaustedAt);
      updateCrawlerOpsTask(task.id, exhausted);
      await store.update(COL, recordId, {
        status: 'analyzed' as VideoStatus,
        aiAnalysis: JSON.stringify({
          ...analysis,
          requestedAnalysisMode: undefined,
          downloadStatus: 'manual_required',
          videoFetchStatus: 'ops_failed',
          geminiStatus: 'video_failed',
          crawlerOpsTaskId: task.id,
          crawlerOpsStatus: 'failed',
          crawlerOpsReason: 'max_attempts_exhausted',
          crawlerOpsLastError: exhausted.lastError,
          crawlerOpsNextRetryAt: undefined,
          analysisRetryable: true,
          videoLevelFailureStatus: '视频获取重试已达上限，可点击重新分析重置重试次数',
          analysisError: exhausted.lastError || 'crawler_ops_max_attempts_exhausted',
        }),
      });
    }
  }
}

function crawlerOpsStats(tenantId?: string, visibleRecordIds?: Set<string>): Record<string, unknown> {
  const tasks = filterCrawlerOpsTasksForRecordIds(loadCrawlerOpsTasks(), visibleRecordIds);
  const byStatus = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
  const byPlatform = tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.platform] = (acc[task.platform] || 0) + 1;
    return acc;
  }, {});
  const apifyUsage = apifyVideoUsageToday(tenantId);
  return {
    total: tasks.length,
    byStatus,
    byPlatform,
    workerEnabled: process.env.CRAWLER_OPS_WORKER_ENABLED !== '0',
    workerActive: crawlerOpsWorkerActive,
    maxAttempts: Math.max(1, Number(process.env.CRAWLER_OPS_MAX_ATTEMPTS || 5)),
    proxyPoolSize: crawlerProxyPool().length,
    cookieFileCount: cookieFiles().length,
    cookieBrowserCount: cookieBrowsers().length,
    apifyVideoFallback: {
      enabled: process.env.APIFY_TIKTOK_VIDEO_FALLBACK_ENABLED !== '0' || process.env.APIFY_INSTAGRAM_VIDEO_FALLBACK_ENABLED !== '0',
      tiktokEnabled: process.env.APIFY_TIKTOK_VIDEO_FALLBACK_ENABLED !== '0',
      instagramEnabled: process.env.APIFY_INSTAGRAM_VIDEO_FALLBACK_ENABLED !== '0',
      usedToday: tenantId ? apifyUsage.tenant : apifyUsage.total,
      dailyLimit: apifyVideoDailyLimit(),
      ...(tenantId ? {} : { globalUsedToday: apifyUsage.total }),
      globalDailyLimit: apifyVideoDailyLimit(),
      tenantUsedToday: apifyUsage.tenant,
      tenantDailyLimit: apifyVideoTenantDailyLimit(),
      afterAttempts: Math.max(1, Number(process.env.APIFY_TIKTOK_VIDEO_AFTER_ATTEMPTS || 2)),
    },
  };
}

export async function getVideoPipelineStats(tenantId?: string): Promise<Record<string, unknown>> {
  const records: Record<string, unknown>[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 50) {
    const result = await store.list<Record<string, unknown>>(COL, {
      where: tenantId ? { tenantId } : undefined,
      page,
      perPage: 100,
      sort: '-crawledAt',
    });
    records.push(...result.items);
    totalPages = result.items.length >= 100 ? Math.max(result.totalPages || 0, page + 1) : page;
    if (result.items.length === 0) break;
    page += 1;
  }

  const visibleRecords = tenantId && await isTestTenantId(tenantId)
    ? records.filter(record => isPublicTestTenantVideo(record) || isVisibleVideoPipelineRecord(record))
    : records;
  const analysisQueueRecords = tenantId && await isTestTenantId(tenantId)
    ? records.filter(record => {
        if (isPublicTestTenantVideo(record) || isVisibleVideoPipelineRecord(record)) return true;
        const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
        return Boolean(analysis.requestedAnalysisMode || analysis.analysisPausedAt)
          || ['queued', 'analyzing', 'paused', 'waiting_for_video'].includes(String(analysis.geminiStatus || ''));
      })
    : records;
  return projectVideoPipelineStats({
    visibleRecords,
    analysisQueueRecords,
    opsStats: crawlerOpsStats(tenantId, new Set(visibleRecords.map(record => String(record.id || '')).filter(Boolean))),
    geminiConfigured: isGeminiConfigured(),
    qwenConfigured: isQwenConfigured(),
  });
}

async function pushCrawlerOpsTask(task: CrawlerOpsTask): Promise<void> {
  const endpoint = process.env.CRAWLER_CONTROL_URL?.trim();
  if (!endpoint) return;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.CRAWLER_CONTROL_TOKEN ? { Authorization: `Bearer ${process.env.CRAWLER_CONTROL_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      ...task,
      callback: `/api/overseas/videos/ops/${task.id}/resolve`,
      requestedCapability: 'browser-like public video fetch',
    }),
  });
  if (!r.ok) throw new Error(`Crawler control HTTP ${r.status}`);
  persistCrawlerOpsTasks(loadCrawlerOpsTasks().map(item =>
    item.id === task.id ? { ...item, status: 'pushed', updatedAt: new Date().toISOString() } : item
  ));
}

async function analyzeOpsVideo(task: CrawlerOpsTask, videoBase64: string, mimeType: string): Promise<void> {
  if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  const tempExt = mimeType.includes('webm') ? 'webm' : mimeType.includes('quicktime') ? 'mov' : 'mp4';
  let tempPath = path.join(ANALYSIS_DIR, `ops-${task.id}-${Date.now()}.${tempExt}`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(videoBase64.replace(/^data:[^,]+,/, ''), 'base64'));
    const record = await store.getById(COL, task.recordId);
    const previous = parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {});
    const analysisMode = previous.requestedAnalysisMode === 'strategy' ? 'strategy' : 'exact';
    const videoAnalysis = await analyzeDownloadedVideoWithFallback({
      filePath: tempPath,
      mimeType,
      title: task.title,
      platform: task.platform,
      duration: Number(record?.duration || 0),
      sourceLabel: 'crawler-ops-video',
      videoId: task.recordId,
      tenantId: String(record?.tenantId || ''),
      analysisMode,
      analysisRunId: String(previous.analysisRunId || ''),
      videoObjectKey: String(previous.videoObjectKey || record?.videoFileId || ''),
    });
    if (analysisMode === 'exact') {
      videoAnalysis.analysis = await persistExactShotEvidence(task.recordId, tempPath, videoAnalysis.analysis);
    }
    cleanupTempVideo(tempPath);
    tempPath = '';
    const measuredDuration = exactSourceClockDuration(videoAnalysis.analysis, String(previous.analysisRunId || ''));
    await store.update(COL, task.recordId, {
      status: 'analyzed' as VideoStatus,
      ...(measuredDuration ? { duration: measuredDuration } : {}),
      aiAnalysis: JSON.stringify({
        ...previous,
        ...videoLevelSuccessPatch({
          analysis: videoAnalysis.analysis,
          source: videoAnalysis.source,
          videoFetchStatus: 'fetched',
          extra: {
            crawlerOpsTaskId: task.id,
            crawlerOpsStatus: 'resolved',
            analysisMode,
            requestedAnalysisMode: undefined,
          },
        }),
      }),
    });
  } catch (e) {
    if (tempPath) cleanupTempVideo(tempPath);
    const record = await store.getById(COL, task.recordId);
    const fallback = metadataFallbackAnalysis({
      platform: task.platform,
      title: task.title,
      duration: Number(record?.duration || 0),
      views: String(parseJsonRecord<Record<string, unknown>>(record?.aiAnalysis, {}).views || task.platform),
      tags: parseJsonRecord<string[]>(record?.tags, []),
    });
    if (record) {
      await persistManualVideoFailure({
        record,
        sourceUrl: task.sourceUrl,
        title: task.title,
        platform: task.platform,
      }, e instanceof Error ? e.message : 'Crawler ops video analysis failed', classifyCrawlerFailure(e instanceof Error ? e.message : String(e)), fallback);
    }
    throw e;
  }
}

function loadMaterials(): Material[] {
  try {
    return JSON.parse(fs.readFileSync(MATERIALS_FILE, 'utf8')) as Material[];
  } catch {
    return [];
  }
}

function persistMaterials(list: Material[]): void {
  fs.writeFileSync(MATERIALS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    if (!ffmpegBin) { resolve(false); return; }
    const p = spawn(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
  });
}

async function extractPoster(videoPath: string, outPath: string, atSec = 1): Promise<boolean> {
  const ok = await runFfmpeg(['-ss', String(atSec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', '-y', outPath]);
  return ok && fs.existsSync(outPath);
}

async function probeDuration(videoPath: string): Promise<number> {
  return new Promise(resolve => {
    if (!ffmpegBin) { resolve(0); return; }
    const p = spawn(ffmpegBin, ['-hide_banner', '-i', videoPath, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', chunk => { stderr += chunk.toString(); });
    p.on('error', () => resolve(0));
    p.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) { resolve(0); return; }
      resolve(Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])));
    });
  });
}
