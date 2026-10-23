import { hasCompletedExactVideoEvidence, isVideoLevelAnalysis } from '../lib/videoAnalysisCodec.js';

/** A failed exact reanalysis must not erase the last completed video evidence. */
export function queuedVideoAnalysisFailurePatch(
  previous: Record<string, unknown>,
  compactError: string,
  failedAt: string,
): Record<string, unknown> {
  const retainedEvidence = hasCompletedExactVideoEvidence(previous) || isVideoLevelAnalysis(previous);
  return {
    ...previous,
    manualVideoUploadStatus: 'failed',
    downloadStatus: retainedEvidence ? previous.downloadStatus || 'analyzed' : 'manual_upload_analyze_failed',
    videoFetchStatus: retainedEvidence ? previous.videoFetchStatus || 'fetched' : 'manual_upload',
    geminiStatus: retainedEvidence
      ? previous.analysisQuality === 'video_review_required' ? 'needs_review' : 'analyzed'
      : 'video_failed',
    requestedAnalysisMode: undefined,
    analysisQueueState: 'failed',
    analysisStage: 'failed',
    analysisStageUpdatedAt: failedAt,
    analysisFailedAt: failedAt,
    analysisRetryable: true,
    analysisError: compactError,
    videoLevelFailureStatus: '视频级失败/需人工处理',
    manualRequiredReason: 'manual_upload_analysis_failed',
    userVisible: retainedEvidence ? previous.userVisible : false,
  };
}

export type VideoAnalysisRetryQueueKind = 'material' | 'stored_video' | 'source_url' | 'classification_repair';

/** A retry is a new durable run. Stale terminal fields cannot label it failed. */
export function videoAnalysisRetryQueuePatch(
  previous: Record<string, unknown>,
  input: {
    analysisMode: 'exact' | 'strategy';
    analysisRunId: string;
    queueKind: VideoAnalysisRetryQueueKind;
    queuedAt: string;
    userId: string;
  },
): Record<string, unknown> {
  const sourceQueue = input.queueKind === 'source_url';
  return {
    ...previous,
    requestedAnalysisMode: input.analysisMode,
    analysisRunId: input.analysisRunId,
    analysisRunMode: input.analysisMode,
    analysisQueueKind: input.queueKind,
    analysisQueueState: 'queued',
    analysisQueuedAt: input.queuedAt,
    analysisStage: 'queued',
    analysisStageUpdatedAt: input.queuedAt,
    reanalyzeQueuedAt: input.queuedAt,
    geminiStatus: sourceQueue ? 'waiting_for_video' : 'queued',
    downloadStatus: sourceQueue ? 'ops_queued' : input.queueKind === 'material' ? 'analyzing' : 'uploaded',
    videoFetchStatus: sourceQueue ? 'ops_queued' : 'fetched',
    analysisPausedAt: undefined,
    analysisPausedBy: undefined,
    analysisCancelledAt: undefined,
    analysisCancelledBy: undefined,
    analysisCompletedAt: undefined,
    analysisFailedAt: undefined,
    analysisRetryable: undefined,
    analysisError: undefined,
    downloadError: undefined,
    videoLevelFailureStatus: undefined,
    manualRequiredReason: undefined,
    adminOnlyVideoFailure: undefined,
    crawlerOpsLastError: undefined,
    crawlerOpsReason: sourceQueue ? 'explicit_reanalyze_started' : 'explicit_reanalyze_uses_local_file',
    crawlerOpsStatus: sourceQueue ? 'queued' : 'resolved',
    crawlerOpsAttempt: 0,
    crawlerOpsRetryResetAt: input.queuedAt,
    crawlerOpsRetryResetBy: input.userId,
  };
}

export function queuedMaterialFailureRequiresSourceFallback(analysis: Record<string, unknown>): boolean {
  const evidence = [analysis.analysisError, analysis.videoLevelFailureStatus, analysis.manualRequiredReason]
    .map(value => String(value || ''))
    .join(' ');
  return /queued_(?:cloud_)?material_(?:not_found|unreadable)|queued_local_material_missing/i.test(evidence);
}

export function compactVideoPipelineError(message: unknown, max = 900): string {
  return String(message || '')
    .replace(/(token=)[^&\s]+/gi, '$1***')
    .replace(/(api[_-]?key=)[^&\s]+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, 'Bearer ***')
    .replace(/\/\/([^:\s/@]+):([^@\s]+)@/g, '//***:***@')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function publicVideoPipelineError(message: unknown): string {
  const text = compactVideoPipelineError(message, 500);
  if (!text) return '视频分析失败，请稍后重试。';
  if (/video_downloader_not_installed|No module named yt_dlp/i.test(text)) return '视频读取组件未安装，请管理员补齐 yt-dlp 后重新分析。';
  if (/GEMINI_API_KEY\s+is\s+not\s+set|gemini[^\n]*(?:not configured|missing api)/i.test(text)) return 'Gemini 未配置，请联系管理员配置后重新分析，或切换到已配置的 Qwen。';
  if (/video_analysis_hard_timeout|exact_chunk_timeout|qwen[^\n]*(?:timeout|timed out|超时)/i.test(text)) return 'Qwen 分析超时，可点击重新分析；连续超时时请改用策略分析或缩短视频。';
  if (/404|not found|unable to download|download webpage|unsupported url/i.test(text)) return '源视频暂时无法获取，请确认链接有效后重新分析。';
  if (/429|quota|resource_exhausted|额度|余额/i.test(text)) return 'AI 分析额度暂时不足，请稍后重试或联系管理员。';
  if (/timeout|timed out|超时/i.test(text)) return '视频分析超时，请稍后重新分析。';
  if (/gemini|model|api/i.test(text)) return 'AI 分析服务暂时不可用，请稍后重试。';
  return '视频分析失败，请稍后重试。';
}

export type VideoAnalysisRecovery = {
  code: 'downloader_missing' | 'gemini_missing' | 'qwen_timeout' | 'candidate_hidden' | 'source_unavailable' | 'analysis_failed' | 'none';
  reason: string;
  recoveryAction: string;
  provider: 'Gemini' | 'Qwen' | 'AI';
  hidden: boolean;
};

/** Keeps operational failures actionable without returning provider secrets. */
export function describeVideoAnalysisRecovery(
  analysis: Record<string, unknown>,
  recordStatus = '',
): VideoAnalysisRecovery {
  const source = String(analysis.analysisSource || '').toLowerCase();
  const rawError = compactVideoPipelineError([
    analysis.analysisError,
    analysis.videoLevelFailureStatus,
    analysis.manualRequiredReason,
    analysis.downloadError,
    analysis.youtubeDirectError,
  ].filter(Boolean).join(' '), 900);
  const hidden = analysis.userVisible === false;
  const provider: VideoAnalysisRecovery['provider'] = /qwen|dashscope/.test(`${source} ${rawError}`)
    ? 'Qwen'
    : /gemini/.test(`${source} ${rawError}`) ? 'Gemini' : 'AI';

  if (/video_downloader_not_installed|No module named yt_dlp/i.test(rawError)) {
    return {
      code: 'downloader_missing', provider, hidden,
      reason: '视频读取组件未安装，重复点击不会完成分析。',
      recoveryAction: '请管理员安装 yt-dlp；组件就绪后再点击“重新分析”。',
    };
  }

  if (/GEMINI_API_KEY\s+is\s+not\s+set|gemini[^\n]*(?:not configured|missing api)/i.test(rawError)) {
    return {
      code: 'gemini_missing', provider: 'Gemini', hidden,
      reason: 'Gemini 未配置，当前候选无法完成视频级分析。',
      recoveryAction: '请管理员配置 GEMINI_API_KEY，或切换到已配置的 Qwen 后点击“重新分析”。',
    };
  }
  if (/video_analysis_hard_timeout|exact_chunk_timeout|qwen[^\n]*(?:timeout|timed out|超时)/i.test(rawError)) {
    return {
      code: 'qwen_timeout', provider: 'Qwen', hidden,
      reason: 'Qwen 视频分析超时，本次没有生成可用的全片结果。',
      recoveryAction: '可点击“重新分析”；连续超时时改用策略分析、缩短视频，或交给人工补充源文件。',
    };
  }
  if (/404|not found|unable to download|download webpage|unsupported url|manual_required|url_failed/i.test(rawError)) {
    return {
      code: 'source_unavailable', provider, hidden,
      reason: '源视频暂时无法获取，候选不会被当作已分析结果展示。',
      recoveryAction: '请确认公开链接或人工上传原视频，然后点击“重新分析”。',
    };
  }
  if (hidden) {
    return {
      code: 'candidate_hidden', provider, hidden: true,
      reason: '候选暂未展示：只有完成真实视频级分析后才会进入灵感大屏。',
      recoveryAction: rawError
        ? '查看失败原因后点击“重新分析”，或人工补充可读的原视频。'
        : '等待当前分析完成；长时间无进展时可暂停后重新分析。',
    };
  }
  if (rawError || recordStatus === 'failed') {
    return {
      code: 'analysis_failed', provider, hidden,
      reason: publicVideoPipelineError(rawError),
      recoveryAction: '点击“重新分析”；如果仍失败，请人工检查源视频和模型配置。',
    };
  }
  return { code: 'none', provider, hidden, reason: '', recoveryAction: '', };
}
