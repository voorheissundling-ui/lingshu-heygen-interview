import type { DataStore } from '../storage/datastore.js';
import type { MaterialRecord } from './materialLibrary.js';

/** Bridge an owned, retained reference video into the sentence-frame extractor.
 * The preview URL is only a display hint; it never authorizes file access. */
export async function productionTrendReference(input: {
  store: DataStore;
  tenantId: string;
  projectSpec: Record<string, any>;
  shotReference: { videoUrl?: string };
}): Promise<MaterialRecord> {
  const kickoff = input.projectSpec.videoKickoff?.video;
  const recordId = String(kickoff?.referenceRecordId || '');
  if (!/^trend_videos_[a-zA-Z0-9_-]{8,100}$/.test(recordId)) throw new Error('当前分镜缺少已入库的爆款参考视频');
  const expectedUrl = `/api/overseas/videos/${recordId}/media-url`;
  if (String(input.shotReference.videoUrl || '') !== expectedUrl
    || String(kickoff?.videoUrl || '') !== expectedUrl) throw new Error('当前分镜参考视频与项目原片不一致');
  const record = await input.store.getById<Record<string, unknown>>('trend_videos', recordId);
  if (!record || record.tenantId !== input.tenantId || record.contentFormat !== 'video') throw new Error('爆款参考视频不存在或不属于当前企业');
  let analysis: Record<string, unknown> = {};
  try { analysis = typeof record.aiAnalysis === 'string' ? JSON.parse(record.aiAnalysis) : (record.aiAnalysis || {}) as Record<string, unknown>; }
  catch { throw new Error('爆款参考视频版本信息无效'); }
  const contentSha256 = String(analysis.contentSha256 || '');
  if (analysis.usage !== 'reference_only' && analysis.mayAnalyze !== true) throw new Error('爆款参考视频没有分析用途授权');
  if (!/^[a-f0-9]{64}$/i.test(contentSha256)) throw new Error('爆款参考视频缺少可核验内容版本');
  const file = String(record.videoFileId || '').replace(/\\/g, '/');
  const expectedFile = `tenants/${input.tenantId}/reference-videos/${recordId}.mp4`;
  const objectKey = String(analysis.videoObjectKey || '');
  const safeObject = objectKey.startsWith(`tenants/${input.tenantId}/`) && !objectKey.split('/').includes('..');
  if (file !== expectedFile && !safeObject) throw new Error('爆款参考视频没有可核验的企业存储对象');
  return { id: recordId, type: 'video', scope: 'own', tenantId: input.tenantId,
    ...(file === expectedFile ? { file } : {}), ...(safeObject ? { objectKey } : {}),
    contentSha256, verifyContentSha256: true, sourceType: 'trend-reference' };
}
