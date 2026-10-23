import { benchmarkAnalysisForRecord } from '../lib/benchmarkAnalysis.js';
import { productionReferenceAdmission } from '../../shared/productionReferenceAdmission.js';
import { describeVideoAnalysisRecovery, publicVideoPipelineError } from './videoAnalysisRecovery.js';
import { parseJsonRecord } from './videoCrawlerNormalization.js';

/** Pure projection of already tenant-scoped records and operational facts. */
export function projectVideoPipelineStats(input: {
  visibleRecords: Record<string, unknown>[];
  analysisQueueRecords: Record<string, unknown>[];
  opsStats: Record<string, unknown>;
  geminiConfigured: boolean;
  qwenConfigured: boolean;
  nowMs?: number;
}): Record<string, unknown> {
  const visibleRecords = input.visibleRecords;
  const analysisQueueRecords = input.analysisQueueRecords;
  const now = input.nowMs ?? Date.now();
  const today = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const byPlatform = visibleRecords.reduce<Record<string, number>>((acc, record) => {
    const platform = String(record.platform || 'unknown');
    acc[platform] = (acc[platform] || 0) + 1;
    return acc;
  }, {});
  const statusCounts = visibleRecords.reduce<Record<string, number>>((acc, record) => {
    const status = String(record.status || 'unknown');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const downloadStatus = visibleRecords.reduce<Record<string, number>>((acc, record) => {
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    const status = String(analysis.downloadStatus || analysis.videoFetchStatus || 'none');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const geminiStatus = visibleRecords.reduce<Record<string, number>>((acc, record) => {
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    const status = String(analysis.geminiStatus || analysis.analysisQuality || 'none');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const fetchQueueCount = visibleRecords.filter(record => {
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    const status = String(analysis.downloadStatus || analysis.videoFetchStatus || '');
    return ['queued', 'downloading', 'download_retrying', 'ops_queued', 'ops_processing'].includes(status);
  }).length;
  const recentRecords = visibleRecords.filter(record => {
    const crawledAt = Date.parse(String(record.crawledAt || ''));
    return Number.isFinite(crawledAt) && now - crawledAt <= 24 * 60 * 60 * 1000;
  });
  const refinementItems = visibleRecords
    .map(record => {
      const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
      const syncedAt = String(analysis.refinementQueuedAt || '');
      if (!syncedAt) return null;
      return {
        id: String(record.id || ''),
        title: String(record.title || '未命名视频'),
        platform: String(record.platform || 'unknown'),
        thumbnailUrl: String(record.thumbnailUrl || ''),
        duration: Number(record.duration || 0),
        status: String(analysis.refinementStatus || 'ready'),
        analysisMode: String(analysis.analysisMode || ''),
        analysisQuality: String(analysis.analysisQuality || ''),
        syncedAt,
        analyzedAt: String(analysis.exactAnalyzedAt || analysis.analyzedAt || ''),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => Date.parse(b.syncedAt) - Date.parse(a.syncedAt))
    .slice(0, 50);
  const analysisItems = analysisQueueRecords.slice(0, 100).map(record => {
    const analysis = parseJsonRecord<Record<string, unknown>>(record.aiAnalysis, {});
    const gemini = String(analysis.geminiStatus || '');
    const fetchStatus = String(analysis.downloadStatus || analysis.videoFetchStatus || '');
    const queueState = String(analysis.analysisQueueState || '');
    const paused = Boolean(analysis.analysisPausedAt) || gemini === 'paused';
    const cancelled = Boolean(analysis.analysisCancelledAt) || gemini === 'cancelled' || analysis.analysisQueueState === 'cancelled';
    const failed = String(record.status || '') === 'failed'
      || Boolean(analysis.analysisError || analysis.videoLevelFailureStatus)
      || ['video_failed', 'analysis_retryable', 'ops_failed', 'url_failed', 'unavailable'].includes(gemini)
      || ['ops_failed', 'url_failed', 'unavailable'].includes(fetchStatus);
    const analyzing = !['failed', 'cancelled', 'paused', 'completed'].includes(queueState) && (Boolean(analysis.requestedAnalysisMode)
      || ['queued', 'analyzing', 'waiting_for_video', 'downloading', 'download_retrying'].includes(gemini)
      || ['queued', 'downloading', 'download_retrying', 'ops_queued', 'ops_processing'].includes(fetchStatus));
    const requestedMode = String(analysis.requestedAnalysisMode || analysis.analysisMode || 'strategy');
    const admission = requestedMode === 'exact' && !cancelled && !paused && !analyzing && !failed
      ? productionReferenceAdmission(benchmarkAnalysisForRecord(record, analysis))
      : null;
    const itemStatus = cancelled ? 'cancelled' : paused ? 'paused' : analyzing ? 'analyzing' : failed ? 'failed'
      : requestedMode !== 'exact' ? 'strategy' : admission && !admission.ready ? 'review' : 'analyzed';
    const recovery = describeVideoAnalysisRecovery(analysis, String(record.status || ''));
    return {
      id: String(record.id || ''),
      title: String(record.title || '未命名视频'),
      platform: String(record.platform || 'unknown'),
      thumbnailUrl: `/api/overseas/videos/${String(record.id || '')}/thumbnail`,
      duration: Number(record.duration || 0),
      status: itemStatus,
      analysisMode: requestedMode,
      productionReady: admission?.ready,
      productionBlockers: admission?.blockers.slice(0, 3) || [],
      updatedAt: String(record.updated || record.crawledAt || ''),
      error: failed ? publicVideoPipelineError(analysis.analysisError || analysis.videoLevelFailureStatus) : '',
      statusReason: cancelled ? '任务已取消，旧运行结果不会再写回。'
        : paused ? '任务已暂停，当前结果和进度已保留。'
          : recovery.reason,
      recoveryAction: cancelled ? '点击“恢复”会创建新的运行版本并从持久队列继续。'
        : paused ? '点击“恢复”继续，或点击“取消”终止本次任务。'
          : recovery.recoveryAction,
      failureCode: recovery.code,
      provider: recovery.provider,
      visibility: recovery.hidden ? 'hidden' : 'visible',
    };
  });

  return {
    updatedAt: new Date(now).toISOString(),
    crawl: {
      total: visibleRecords.length,
      today: visibleRecords.filter(record => {
        const crawledAt = Date.parse(String(record.crawledAt || ''));
        return Number.isFinite(crawledAt) && new Date(crawledAt + 8 * 60 * 60 * 1000).toISOString().startsWith(today);
      }).length,
      last24h: recentRecords.length,
      byPlatform,
      latestAt: String(visibleRecords[0]?.crawledAt || ''),
      statusCounts,
    },
    fetchQueue: {
      queued: fetchQueueCount,
      byStatus: downloadStatus,
      ops: input.opsStats,
    },
    analysisQueue: {
      queued: analysisItems.filter(item => item.status === 'analyzing').length,
      byStatus: analysisItems.reduce<Record<string, number>>((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {}),
      pendingRecords: analysisItems.filter(item => item.status === 'analyzing' || item.status === 'paused' || item.status === 'review').length,
      analyzedRecords: analysisItems.filter(item => item.status === 'analyzed').length,
      strategyRecords: analysisItems.filter(item => item.status === 'strategy').length,
      failedRecords: analysisItems.filter(item => item.status === 'failed').length,
      hiddenRecords: analysisItems.filter(item => item.visibility === 'hidden').length,
      providerStatus: {
        gemini: {
          configured: input.geminiConfigured,
          reason: input.geminiConfigured ? '' : 'Gemini 未配置，不会启动 Gemini 视频分析。',
          recoveryAction: input.geminiConfigured ? '' : '请管理员配置 GEMINI_API_KEY，或确认已切换到 Qwen。',
        },
        qwen: {
          configured: input.qwenConfigured,
          reason: input.qwenConfigured ? '' : 'Qwen 未配置，Gemini 失败时无法使用 Qwen 兜底。',
          recoveryAction: input.qwenConfigured ? '' : '请管理员配置 DASHSCOPE_API_KEY。',
        },
      },
      items: analysisItems,
      refinementItems,
    },
  };
}
