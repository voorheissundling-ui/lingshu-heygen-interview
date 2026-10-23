import type { PresenterShotMeasurements } from '../../shared/contracts/presenterStackPolicy.js';

type ExtractedShotEvidence = {
  sourceVideoRef: string | null;
  clipRef: string | null;
  firstFrameRef: string | null;
  firstFrameSeconds: number;
  extractionStatus: 'ready' | 'unavailable';
};

/**
 * Build the measurement record from server-extracted media evidence only.
 * A model's prose, ASR, and its self-reported confidence cannot establish
 * visible lip movement, body displacement, or camera displacement. Those
 * fields stay unknown until a measured track is available.
 */
export function presenterShotMeasurements(input: {
  shotId: string;
  startSeconds: number;
  endSeconds: number;
  materialEvidence?: ExtractedShotEvidence;
}): PresenterShotMeasurements {
  const durationSeconds = +(input.endSeconds - input.startSeconds).toFixed(2);
  const extracted = input.materialEvidence;
  const frameVerified = extracted?.extractionStatus === 'ready'
    && Boolean(extracted.firstFrameRef && extracted.clipRef && extracted.sourceVideoRef)
    && Number.isFinite(extracted.firstFrameSeconds)
    && extracted.firstFrameSeconds >= input.startSeconds
    && extracted.firstFrameSeconds < input.endSeconds;
  const sourceFirstFrameRef = frameVerified ? extracted.firstFrameRef : null;
  return {
    shotId: input.shotId,
    durationSeconds,
    sourceFirstFrameRef,
    enterprisePresenterAssetRef: null,
    visibleSpeechSeconds: null,
    lipSyncRequired: null,
    specificGestureCount: null,
    bodyCenterTravelFrameWidth: null,
    cameraTravelFrameDiagonal: null,
    compositionLockRequired: null,
    physicalProductContact: null,
    decisionConfidence: 0,
    evidence: sourceFirstFrameRef ? [{
      startSeconds: 0,
      endSeconds: Math.min(durationSeconds, 0.1),
      frameRef: sourceFirstFrameRef,
      observation: '服务器从该分镜时间区间抽取原视频首帧；仅证明参考画面存在，不证明口型、手势或位移',
      fieldName: 'sourceFirstFrameRef',
      sourceKind: 'server_extracted_frame',
    }] : [],
  };
}
