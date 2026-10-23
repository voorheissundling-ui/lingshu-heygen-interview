import { createHash, randomUUID } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import type { VideoStatus } from '../types/index.js';
import type { ImagePostEvidenceAnalysis } from '../agents/qwenContracts.js';
import { serializeImagePostAnalysis, videoAnalysisOf } from '../lib/videoAnalysisCodec.js';
import type { CrawledImagePost } from './imagePostEvidenceAnalysis.js';

type EvidenceResult = {
  status: 'analyzed' | 'failed';
  analysis?: ImagePostEvidenceAnalysis;
  error?: string;
  provider?: 'qwen' | 'gemini';
};

function tagsOf(value: unknown): string[] {
  try {
    const tags = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch { return []; }
}

export function imagePostSourceHash(record: Record<string, unknown>): string {
  const analysis = videoAnalysisOf(record);
  return createHash('sha256').update(JSON.stringify({
    tenantId: record.tenantId, id: record.id, sourceUrl: record.sourceUrl,
    thumbnailUrl: record.thumbnailUrl, caption: analysis.caption,
    imageUrls: analysis.imageUrls, imageObjectKeys: analysis.imageObjectKeys,
  })).digest('hex');
}

/** A visible attempt marker is durable before calling the existing analyzer. */
export async function reanalyzeStoredImagePost(input: {
  store: DataStore;
  collection: string;
  tenantId: string;
  record: Record<string, unknown>;
  analyze(item: CrawledImagePost, keyword: string): Promise<EvidenceResult>;
}): Promise<EvidenceResult> {
  const { record } = input;
  const recordId = String(record.id || '');
  if (!recordId || record.tenantId !== input.tenantId) throw Error('image_post_tenant_mismatch');
  const current = videoAnalysisOf(record);
  if (current.contentFormat !== 'image' && record.contentFormat !== 'image') throw Error('image_post_format_mismatch');
  if (['queued', 'processing', 'unknown'].includes(String(current.imageAnalysisQueueState || ''))) {
    throw Error('image_post_queue_requires_reconciliation');
  }
  const initialSourceHash = imagePostSourceHash(record);
  const item: CrawledImagePost = {
    platform: String(record.platform || 'instagram') as CrawledImagePost['platform'],
    title: String(record.title || ''), sourceUrl: String(record.sourceUrl || ''),
    thumbnailUrl: String(record.thumbnailUrl || ''),
    caption: String(current.caption || record.title || ''),
    imageUrls: Array.isArray(current.imageUrls) ? current.imageUrls.map(String) : [String(record.thumbnailUrl || '')],
    views: String(current.views || ''), tags: tagsOf(record.tags),
    uploadedAt: String(current.uploadedAt || ''), author: String(current.author || ''),
  };
  const attemptId = randomUUID();
  if (!await input.store.update(input.collection, recordId, {
    status: 'pending' as VideoStatus,
    aiAnalysis: serializeImagePostAnalysis({ ...current,
      imageAnalysisStatus: 'pending', imageAnalysisAttemptId: attemptId,
      imageAnalysisStartedAt: new Date().toISOString(), imageAnalysisError: undefined,
    }),
  })) throw Error('image_post_analysis_attempt_persistence_failed');
  const output = await input.analyze(item, String(current.keyword || ''));
  const latest = await input.store.getById<Record<string, unknown>>(input.collection, recordId);
  if (!latest || latest.tenantId !== input.tenantId) throw Error('image_post_record_disappeared_after_analysis');
  const latestAnalysis = videoAnalysisOf(latest);
  if (latestAnalysis.imageAnalysisAttemptId !== attemptId) throw Error('image_post_analysis_superseded');
  if (imagePostSourceHash(latest) !== initialSourceHash) throw Error('image_post_analysis_source_changed');
  const finalAnalysis = serializeImagePostAnalysis({ ...latestAnalysis,
    imageEvidence: output.analysis || latestAnalysis.imageEvidence,
    imageAnalysisStatus: output.status,
    imageAnalysisError: output.error,
    analysisSource: output.status === 'analyzed' ? `${output.provider || 'qwen'}-image-evidence-v2` : 'image-metadata',
    analysisQuality: output.status === 'analyzed' ? 'image' : 'metadata',
    analyzedAt: new Date().toISOString(),
  });
  if (!await input.store.update(input.collection, recordId, {
    aiAnalysis: finalAnalysis, status: output.status as VideoStatus,
  })) throw Error('image_post_analysis_result_persistence_failed');
  return output;
}
