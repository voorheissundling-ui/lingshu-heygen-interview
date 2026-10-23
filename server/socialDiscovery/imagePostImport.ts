import type { DataStore } from '../storage/datastore.js';
import type { VideoStatus } from '../types/index.js';
import { serializeImagePostAnalysis, videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import type { ImagePostEvidenceAnalysis } from '../agents/qwenContracts.js';
import type { CrawledImagePost } from './imagePostEvidenceAnalysis.js';

type ImageAnalysisResult = {
  status: 'analyzed' | 'failed';
  analysis?: ImagePostEvidenceAnalysis;
  error?: string;
  provider?: 'qwen' | 'gemini';
};

/** Persist the source identity before any analysis that may later be paid. */
export async function importNewImagePost(input: {
  store: DataStore;
  collection: string;
  tenantId: string;
  item: CrawledImagePost;
  keyword: string;
  crawlerSource: string;
  accountMode: boolean;
  accountUrl: string;
  deferImageAnalysis: boolean;
  persistThumbnail(recordId: string, url: string): Promise<string>;
  persistImages(recordId: string, urls: string[]): Promise<string[]>;
  analyze(item: CrawledImagePost, keyword: string): Promise<ImageAnalysisResult>;
  queue(recordId: string, item: CrawledImagePost, keyword: string): Promise<void>;
}): Promise<Record<string, unknown> | null> {
  const { item } = input;
  const initialAnalysis = serializeImagePostAnalysis({
    contentFormat: 'image', source: item.source || input.crawlerSource,
    caption: item.caption || item.title,
    imageUrls: item.imageUrls?.length ? item.imageUrls : [item.thumbnailUrl].filter(Boolean),
    imageCount: item.imageUrls?.length || 1,
    views: item.views,
    publicMetrics: {
      likes: item.likes, comments: item.comments, shares: item.shares, plays: item.plays,
      followers: item.followers, observedAt: new Date().toISOString(),
    },
    publicAdSignals: { isAd: item.isAd, isPaidPartnership: item.isPaidPartnership },
    uploadedAt: item.uploadedAt, author: item.author, likes: item.likes, comments: item.comments,
    imageAnalysisStatus: 'pending', analysisSource: 'image-metadata', analysisQuality: 'metadata',
    keyword: input.keyword, crawlRule: input.accountMode ? '对标账号主页' : '图文检索',
    sourceAccountUrl: input.accountUrl || undefined, importedAt: new Date().toISOString(),
  });
  const record = await input.store.create<Record<string, unknown>>(input.collection, {
    tenantId: input.tenantId, contentFormat: 'image', platform: item.platform,
    title: item.title, thumbnailUrl: item.thumbnailUrl, videoFileId: '', duration: 0,
    sourceUrl: item.sourceUrl, tags: JSON.stringify(item.tags), aiAnalysis: initialAnalysis,
    status: 'pending' as VideoStatus, crawledAt: new Date().toISOString(),
  });
  if (!record) return null;
  const recordId = String(record.id);
  const thumbnailUrl = await input.persistThumbnail(recordId, item.thumbnailUrl);
  const storedImageUrls = await input.persistImages(recordId, item.imageUrls?.length ? item.imageUrls : [item.thumbnailUrl]);
  const storedRecord = await input.store.getById<Record<string, unknown>>(input.collection, recordId);
  if (!storedRecord || storedRecord.tenantId !== input.tenantId) throw Error('image_post_record_disappeared_before_analysis');
  const storedAnalysis = videoAnalysisOf(storedRecord);
  const stagedAnalysis = serializeImagePostAnalysis({ ...storedAnalysis,
    imageUrls: storedImageUrls.length ? storedImageUrls : storedAnalysis.imageUrls,
    imageCount: storedImageUrls.length || storedAnalysis.imageCount || 1,
  });
  if (!await input.store.update(input.collection, recordId, { thumbnailUrl, aiAnalysis: stagedAnalysis })) {
    throw Error('image_post_source_persistence_failed');
  }
  if (input.deferImageAnalysis) {
    await input.queue(recordId, item, input.keyword);
    return await input.store.getById<Record<string, unknown>>(input.collection, recordId)
      || { ...record, thumbnailUrl, aiAnalysis: stagedAnalysis };
  }
  const output = await input.analyze(item, input.keyword);
  const latest = await input.store.getById<Record<string, unknown>>(input.collection, recordId);
  if (!latest || latest.tenantId !== input.tenantId) throw Error('image_post_record_disappeared_after_analysis');
  const analysis = videoAnalysisOf(latest);
  const status = (output.status === 'analyzed' ? 'analyzed' : 'failed') as VideoStatus;
  const finalAnalysis = serializeImagePostAnalysis({ ...analysis,
    imageEvidence: output.analysis,
    imageAnalysisStatus: output.status,
    imageAnalysisError: output.error,
    analysisSource: output.status === 'analyzed' ? `${output.provider || 'qwen'}-image-evidence-v2` : 'image-metadata',
    analysisQuality: output.status === 'analyzed' ? 'image' : 'metadata',
  });
  if (!await input.store.update(input.collection, recordId, { aiAnalysis: finalAnalysis, status })) {
    throw Error('image_post_analysis_persistence_failed');
  }
  return await input.store.getById<Record<string, unknown>>(input.collection, recordId)
    || { ...record, thumbnailUrl, aiAnalysis: finalAnalysis, status };
}
