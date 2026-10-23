export type VideoAnalysisProgressStage =
  | 'metadata'
  | 'queued'
  | 'downloading'
  | 'transcoding'
  | 'analyzing'
  | 'extracting_evidence'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled';

export interface VideoAnalysisProgress {
  stage: VideoAnalysisProgressStage;
  stageLabel: string;
  percent: number | null;
  currentStep: string;
  queuePosition: number | null;
  queuedAt: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  estimatedCompletedAt: string | null;
  etaSeconds: number | null;
  retryable: boolean;
  backendAccepted: boolean;
  workerStarted: boolean;
  runId: string | null;
}

type ProgressInput = {
  analysis: Record<string, unknown>;
  recordStatus?: unknown;
  recordUpdatedAt?: unknown;
  duration?: unknown;
  queuePosition?: number | null;
  failureMessage?: unknown;
  nowMs?: number;
};

const ACTIVE_STAGES = new Set<VideoAnalysisProgressStage>([
  'queued', 'downloading', 'transcoding', 'analyzing', 'extracting_evidence',
]);

const STAGE_COPY: Record<VideoAnalysisProgressStage, { label: string; step: string }> = {
  metadata: { label: '仅有元数据', step: '尚未取得原视频，标题和标签不能代替全片精准分析。' },
  queued: { label: '等待后台工作槽', step: '任务已持久化进入分析队列，等待 Worker 接管。' },
  downloading: { label: '正在获取原视频', step: 'Worker 已开始执行，正在下载或读取完整视频文件。' },
  transcoding: { label: '正在准备分析文件', step: '正在校验并转码视频，为逐镜分析准备稳定输入。' },
  analyzing: { label: '正在逐镜分析', step: 'AI 正在读取全片画面、声音与时间线。' },
  extracting_evidence: { label: '正在生成逐镜证据', step: '分析已返回，正在保存镜头切片、首帧与质量校验结果。' },
  completed: { label: '全片精准分析已完成', step: '逐镜结果和可核验素材证据已写入记录。' },
  failed: { label: '分析未完成', step: '本次后台运行已经停止，请查看失败原因后重试。' },
  paused: { label: '分析已暂停', step: '当前结果和进度已保留，恢复后会创建新的运行版本。' },
  cancelled: { label: '分析已取消', step: '旧运行结果已失效，不会覆盖当前记录。' },
};

/** Only records consumed by the durable local analysis Worker retain ownership. */
export function hasDurableExactAnalysisOwner(analysis: Record<string, unknown>): boolean {
  return ['queued', 'running'].includes(String(analysis.analysisQueueState || ''))
    && ['material', 'stored_video'].includes(String(analysis.analysisQueueKind || ''));
}

export function sourceAnalysisQueueReceiptPatch(task: { id: string; status: string }, acceptedAt: string): Record<string, unknown> {
  if (!task.id.trim()) throw new Error('crawler_ops_task_receipt_missing');
  if (!['queued', 'pushed', 'processing'].includes(task.status)) throw new Error('crawler_ops_task_not_accepted');
  return {
    crawlerOpsTaskId: task.id,
    crawlerOpsStatus: task.status,
    analysisQueueState: 'queued',
    analysisStage: 'queued',
    analysisStageUpdatedAt: acceptedAt,
  };
}

export function sourceAnalysisQueueFailurePatch(errorMessage: string, failedAt: string): Record<string, unknown> {
  return {
    requestedAnalysisMode: undefined,
    analysisQueueState: 'failed',
    analysisStage: 'failed',
    analysisStageUpdatedAt: failedAt,
    analysisFailedAt: failedAt,
    analysisRetryable: true,
    geminiStatus: 'analysis_retryable',
    downloadStatus: 'ops_failed',
    videoFetchStatus: 'ops_failed',
    analysisError: errorMessage,
    videoLevelFailureStatus: '后台分析入队失败，可重试',
  };
}

/**
 * A legacy maintenance marker is not a queue lease. It can only be released
 * after its latest durable activity is old enough; process startup alone is
 * never evidence that a still-running maintenance script died.
 */
export function isOwnerlessExactAnalysisStale(input: {
  analysis: Record<string, unknown>;
  recordUpdatedAt?: unknown;
  nowMs?: number;
  stallMs: number;
}): boolean {
  const nowMs = input.nowMs ?? Date.now();
  const maintenanceMinimumMs = 30 * 60_000;
  const thresholdMs = String(input.analysis.analysisQueueKind || '') === 'maintenance_exact'
    ? Math.max(input.stallMs, maintenanceMinimumMs)
    : input.stallMs;
  const activityMs = [
    input.analysis.analysisHeartbeatAt,
    input.analysis.analysisStageUpdatedAt,
    input.analysis.analysisWorkerStartedAt,
    input.analysis.downloadStartedAt,
    input.analysis.geminiStartedAt,
    input.analysis.analysisStartedAt,
    input.analysis.reanalyzeQueuedAt,
    input.recordUpdatedAt,
  ].map(value => iso(value)).filter((value): value is string => Boolean(value)).map(value => Date.parse(value));
  if (!activityMs.length) return false;
  return nowMs - Math.max(...activityMs) >= thresholdMs;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function iso(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText || !Number.isFinite(Date.parse(valueText))) return null;
  return new Date(Date.parse(valueText)).toISOString();
}

function firstIso(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = iso(value);
    if (parsed) return parsed;
  }
  return null;
}

function explicitActiveStage(value: unknown): VideoAnalysisProgressStage | null {
  const stage = text(value) as VideoAnalysisProgressStage;
  return ACTIVE_STAGES.has(stage) ? stage : null;
}

function stageFor(input: ProgressInput): VideoAnalysisProgressStage {
  const analysis = input.analysis;
  const queueState = text(analysis.analysisQueueState);
  const geminiStatus = text(analysis.geminiStatus);
  const downloadStatus = text(analysis.downloadStatus);
  const videoFetchStatus = text(analysis.videoFetchStatus);
  const requested = text(analysis.requestedAnalysisMode);
  const explicit = explicitActiveStage(analysis.analysisStage);
  const workerEvidence = firstIso(
    analysis.analysisWorkerStartedAt,
    analysis.downloadStartedAt,
    analysis.crawlerOpsStartedAt,
    analysis.geminiStartedAt,
  );

  if (queueState === 'cancelled' || geminiStatus === 'cancelled' || analysis.analysisCancelledAt) return 'cancelled';
  if (queueState === 'paused' || geminiStatus === 'paused' || analysis.analysisPausedAt) return 'paused';

  const terminalFailure = queueState === 'failed'
    || text(input.recordStatus) === 'failed'
    || ['video_failed', 'analysis_retryable', 'failed', 'ops_failed', 'url_failed', 'unavailable'].includes(geminiStatus)
    || (!requested && Boolean(analysis.analysisError || analysis.videoLevelFailureStatus));
  if (terminalFailure) return 'failed';

  const completed = queueState === 'completed'
    || (!requested
      && ['analyzed', 'needs_review'].includes(geminiStatus)
      && ['video', 'video_review_required'].includes(text(analysis.analysisQuality)));
  if (completed) return 'completed';

  if (requested || ['queued', 'running'].includes(queueState)) {
    if (explicit && (explicit === 'queued' || workerEvidence)) return explicit;
    if (workerEvidence && analysis.analysisEvidenceStartedAt) return 'extracting_evidence';
    if (workerEvidence && geminiStatus === 'analyzing') return 'analyzing';
    if (workerEvidence && analysis.previewTranscodeStartedAt && !analysis.previewPersistedAt) return 'transcoding';
    if (workerEvidence && (downloadStatus === 'downloading' || ['downloading', 'ops_processing'].includes(videoFetchStatus))) return 'downloading';
    return 'queued';
  }

  if (text(analysis.analysisSource) === 'metadata-fallback'
    || text(analysis.analysisQuality) === 'metadata'
    || geminiStatus === 'metadata_fallback'
    || downloadStatus === 'metadata_only') return 'metadata';

  return text(input.recordStatus) === 'analyzed' ? 'completed' : 'metadata';
}

function retryableFailure(analysis: Record<string, unknown>, stage: VideoAnalysisProgressStage): boolean {
  if (stage !== 'failed') return false;
  if (analysis.analysisRetryable === true) return true;
  if (analysis.analysisRetryable === false) return false;
  const evidence = [analysis.analysisError, analysis.videoLevelFailureStatus, analysis.geminiStatus]
    .map(value => text(value)).join(' ');
  return /retry|可重试|stalled|timeout|超时|中断|video_failed|analysis_retryable/i.test(evidence);
}

/** Build a conservative server-authored snapshot. Milestones never animate. */
export function buildVideoAnalysisProgress(input: ProgressInput): VideoAnalysisProgress {
  const { analysis } = input;
  const nowMs = input.nowMs ?? Date.now();
  const stage = stageFor(input);
  const queuePosition = Number.isInteger(input.queuePosition) && Number(input.queuePosition) > 0
    ? Number(input.queuePosition) : null;
  const runId = text(analysis.analysisRunId) || null;
  const queuedAt = firstIso(analysis.analysisQueuedAt, analysis.reanalyzeQueuedAt);
  // analysisStartedAt is intentionally excluded: legacy maintenance scripts
  // wrote it before a Worker or lock existed, which caused false running state.
  const startedAt = firstIso(
    analysis.analysisWorkerStartedAt,
    analysis.downloadStartedAt,
    analysis.crawlerOpsStartedAt,
    analysis.geminiStartedAt,
  );
  const updatedAt = firstIso(
    analysis.analysisStageUpdatedAt,
    analysis.analysisCompletedAt,
    analysis.analysisFailedAt,
    analysis.geminiStartedAt,
    analysis.downloadedAt,
    analysis.downloadStartedAt,
    analysis.analysisWorkerStartedAt,
    input.recordUpdatedAt,
    queuedAt,
  );
  const workerStarted = Boolean(startedAt);
  const queueKind = text(analysis.analysisQueueKind);
  const queueState = text(analysis.analysisQueueState);
  const durableQueueReceipt = ['material', 'stored_video'].includes(queueKind)
    && ['queued', 'running', 'completed', 'failed', 'paused', 'cancelled'].includes(queueState);
  const crawlerReceipt = Boolean(text(analysis.crawlerOpsTaskId))
    && ['queued', 'pushed', 'processing', 'resolved', 'failed'].includes(text(analysis.crawlerOpsStatus));
  const terminalReceipt = Boolean(firstIso(analysis.analysisCompletedAt)) && queueState === 'completed';
  const backendAccepted = Boolean(runId && (durableQueueReceipt || crawlerReceipt || workerStarted || terminalReceipt));
  // A stage transition is not a measured percentage. Active runs therefore
  // expose no percentage unless a future Worker records a genuine measured
  // value under analysisMeasuredPercent. Completion is the only intrinsically
  // measurable terminal milestone.
  const measuredPercent = analysis.analysisMeasuredPercent;
  const hasMeasuredPercent = typeof measuredPercent === 'number'
    && Number.isFinite(measuredPercent)
    && measuredPercent >= 0
    && measuredPercent < 100;
  const percent = stage === 'completed' && Boolean(firstIso(analysis.analysisCompletedAt))
    ? 100
    : ACTIVE_STAGES.has(stage)
      && hasMeasuredPercent
      ? Math.round(measuredPercent)
      : null;
  let etaSeconds: number | null = null;
  let estimatedCompletedAt: string | null = null;
  if (ACTIVE_STAGES.has(stage)) {
    const explicitCompletedAt = iso(analysis.analysisEstimatedCompletedAt);
    const explicitEtaSeconds = Number(analysis.analysisEtaSeconds);
    if (explicitCompletedAt) {
      estimatedCompletedAt = explicitCompletedAt;
      etaSeconds = Math.max(0, Math.round((Date.parse(explicitCompletedAt) - nowMs) / 1000));
    } else if (Number.isFinite(explicitEtaSeconds) && explicitEtaSeconds >= 0) {
      etaSeconds = Math.round(explicitEtaSeconds);
      estimatedCompletedAt = new Date(nowMs + etaSeconds * 1000).toISOString();
    }
  }
  const copy = STAGE_COPY[stage];
  const currentStep = stage === 'failed' && text(input.failureMessage)
    ? text(input.failureMessage)
    : stage === 'queued' && !backendAccepted
      ? '已记录分析请求，但尚未取得持久队列或 Worker 受理凭证。'
      : copy.step;

  return {
    stage,
    stageLabel: copy.label,
    percent,
    currentStep,
    queuePosition,
    queuedAt,
    startedAt,
    updatedAt,
    estimatedCompletedAt,
    etaSeconds,
    retryable: retryableFailure(analysis, stage),
    backendAccepted,
    workerStarted,
    runId,
  };
}
