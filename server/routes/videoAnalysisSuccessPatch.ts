import type { VideoAiAnalysis } from '../types/index.js';
import { exactVideoReviewReasons, hasCompleteVideoGeminiAnalysis } from '../lib/videoAnalysisCodec.js';

export function videoSuccessVisibilityPatch(): Record<string, unknown> {
  return {
    userVisible: true,
    adminOnlyVideoFailure: undefined,
    videoLevelFailureStatus: undefined,
    manualRequiredReason: undefined,
  };
}

function assertCompleteVideoGeminiAnalysis(gemini: VideoAiAnalysis, sourceLabel: string): void {
  if (hasCompleteVideoGeminiAnalysis(gemini)) return;
  throw new Error(`${sourceLabel}_incomplete_gemini_video_analysis`);
}

/** One terminal success patch, preserving exact-analysis review requirements. */
export function videoLevelSuccessPatch(input: {
  analysis: VideoAiAnalysis;
  source: string;
  videoFetchStatus: string;
  extra?: Record<string, unknown>;
  now?: () => Date;
}): Record<string, unknown> {
  assertCompleteVideoGeminiAnalysis(input.analysis, input.source);
  const exact = input.extra?.analysisMode === 'exact';
  const sceneCuts = (input.analysis as VideoAiAnalysis & { detectedSceneCuts?: number[] }).detectedSceneCuts || [];
  const openingFrame = (input.analysis as VideoAiAnalysis & { openingFrameObservation?: { scene: string; confidence: number } | null }).openingFrameObservation;
  const hookReviewReasons = (input.analysis as VideoAiAnalysis & { hookReviewReasons?: string[] }).hookReviewReasons || [];
  const reviewReasons = exact ? [...exactVideoReviewReasons(input.analysis, 0, sceneCuts, openingFrame), ...hookReviewReasons] : [];
  const completedAt = (input.now?.() ?? new Date()).toISOString();
  return {
    gemini: input.analysis,
    analysisSource: input.source,
    analysisQuality: reviewReasons.length ? 'video_review_required' : 'video',
    analysisReviewReasons: reviewReasons,
    analysisMode: 'strategy',
    downloadStatus: 'analyzed',
    videoFetchStatus: input.videoFetchStatus,
    geminiStatus: reviewReasons.length ? 'needs_review' : 'analyzed',
    analysisError: undefined,
    downloadError: undefined,
    analysisQueueState: 'completed',
    analysisStage: 'completed',
    analysisStageUpdatedAt: completedAt,
    analysisCompletedAt: completedAt,
    ...videoSuccessVisibilityPatch(),
    analyzedAt: completedAt,
    ...(input.extra ?? {}),
  };
}
