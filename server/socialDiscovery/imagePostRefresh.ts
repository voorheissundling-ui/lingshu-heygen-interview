import type { DataStore } from '../storage/datastore.js';
import type { VideoAiAnalysis, VideoStatus } from '../types/index.js';
import { serializeImagePostAnalysis, videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import type { ImagePostEvidenceAnalysis } from '../agents/qwenContracts.js';
import type { CrawledImagePost } from './imagePostEvidenceAnalysis.js';

type EvidenceResult = {
  status: 'analyzed' | 'failed';
  analysis?: ImagePostEvidenceAnalysis;
  error?: string;
  provider?: 'qwen' | 'gemini';
};

/** Refresh source evidence before re-running the existing visual analyzer. */
export async function refreshExistingImagePost(input: {
  store: DataStore;
  collection: string;
  tenantId: string;
  existingRecord: Record<string, unknown>;
  item: CrawledImagePost;
  keyword: string;
  accountMode: boolean;
  accountUrl: string;
  deferImageAnalysis: boolean;
  persistThumbnail(recordId: string, url: string): Promise<string>;
  persistImages(recordId: string, urls: string[]): Promise<string[]>;
  analyze(item: CrawledImagePost, keyword: string, fallback?: VideoAiAnalysis): Promise<EvidenceResult>;
  queue(recordId: string, item: CrawledImagePost, keyword: string): Promise<void>;
}): Promise<Record<string, unknown>> {
  const { existingRecord, item } = input;
  if (existingRecord.tenantId !== input.tenantId) throw Error('image_post_tenant_mismatch');
  const existingAnalysis = videoAnalysisOf(existingRecord);
  if (['queued', 'processing', 'unknown'].includes(String(existingAnalysis.imageAnalysisQueueState || ''))) {
    throw Error('image_post_queue_requires_reconciliation');
  }
  const previouslyAnalyzed = (existingAnalysis.imageEvidence as { status?: string } | undefined)?.status === 'analyzed';
  const recordId = String(existingRecord.id);
  const remoteThumbnail = item.thumbnailUrl || String(existingRecord.thumbnailUrl || '');
  const thumbnailUrl = await input.persistThumbnail(recordId, remoteThumbnail);
  const storedImageUrls = await input.persistImages(recordId, item.imageUrls?.length ? item.imageUrls : [remoteThumbnail]);
  const storedRecord = await input.store.getById<Record<string, unknown>>(input.collection, recordId);
  if (!storedRecord || storedRecord.tenantId !== input.tenantId) throw Error('image_post_record_disappeared_before_analysis');
  const storedAnalysis = videoAnalysisOf(storedRecord);
  const stagedAnalysis = serializeImagePostAnalysis({
    ...existingAnalysis,
    imageStorage: storedAnalysis.imageStorage,
    imageObjectKeys: storedAnalysis.imageObjectKeys,
    thumbnailStorage: storedAnalysis.thumbnailStorage,
    thumbnailObjectKey: storedAnalysis.thumbnailObjectKey,
    contentFormat: 'image',
    caption: item.caption || existingAnalysis.caption || item.title,
    imageUrls: storedImageUrls.length ? storedImageUrls : (item.imageUrls?.length ? item.imageUrls : existingAnalysis.imageUrls),
    imageCount: storedImageUrls.length || item.imageUrls?.length || existingAnalysis.imageCount || 1,
    views: item.views || existingAnalysis.views,
    publicMetrics: {
      likes: item.likes, comments: item.comments, shares: item.shares, plays: item.plays,
      followers: item.followers, observedAt: new Date().toISOString(),
    },
    author: item.author || existingAnalysis.author,
    publicAdSignals: { isAd: item.isAd, isPaidPartnership: item.isPaidPartnership },
    uploadedAt: item.uploadedAt || existingAnalysis.uploadedAt,
    keyword: input.keyword,
    crawlRule: input.accountMode ? '对标账号主页' : '图文检索',
    sourceAccountUrl: input.accountUrl || existingAnalysis.sourceAccountUrl,
    imageAnalysisStatus: 'pending',
    importedAt: existingAnalysis.importedAt || new Date().toISOString(),
  });
  if (!await input.store.update(input.collection, recordId, {
    contentFormat: 'image', thumbnailUrl, status: 'pending' as VideoStatus, aiAnalysis: stagedAnalysis,
  })) throw Error('image_post_source_persistence_failed');
  if (input.deferImageAnalysis && !previouslyAnalyzed) {
    await input.queue(recordId, item, input.keyword);
    return { ...existingRecord, thumbnailUrl };
  }
  const output = await input.analyze(item, input.keyword, existingAnalysis.gemini as VideoAiAnalysis | undefined);
  const latest = await input.store.getById<Record<string, unknown>>(input.collection, recordId);
  if (!latest || latest.tenantId !== input.tenantId) throw Error('image_post_record_disappeared_after_analysis');
  const currentAnalysis = videoAnalysisOf(latest);
  const finalAnalysis = serializeImagePostAnalysis({
    ...currentAnalysis,
    imageEvidence: output.analysis || existingAnalysis.imageEvidence,
    imageAnalysisStatus: output.status === 'analyzed' ? 'analyzed' : (existingAnalysis.imageAnalysisStatus || 'failed'),
    imageAnalysisError: output.status === 'analyzed' ? undefined : output.error,
    analysisSource: output.status === 'analyzed' ? `${output.provider || 'qwen'}-image-evidence-v2` : (existingAnalysis.analysisSource || 'image-metadata'),
    analysisQuality: output.status === 'analyzed' ? 'image' : (existingAnalysis.analysisQuality || 'metadata'),
  });
  if (!await input.store.update(input.collection, recordId, {
    aiAnalysis: finalAnalysis, status: (output.status === 'analyzed' ? 'analyzed' : 'failed') as VideoStatus,
  })) throw Error('image_post_analysis_persistence_failed');
  return { ...existingRecord, thumbnailUrl };
}
