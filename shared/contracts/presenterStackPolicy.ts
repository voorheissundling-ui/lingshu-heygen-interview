/** Measured evidence for one reference shot. Null means not measured. */
export interface PresenterShotMeasurements {
  shotId: string;
  durationSeconds: number;
  sourceFirstFrameRef: string | null;
  enterprisePresenterAssetRef: string | null;
  visibleSpeechSeconds: number | null;
  lipSyncRequired: boolean | null;
  specificGestureCount: number | null;
  bodyCenterTravelFrameWidth: number | null;
  cameraTravelFrameDiagonal: number | null;
  compositionLockRequired: boolean | null;
  physicalProductContact: boolean | null;
  /** Minimum confidence of the fields that determine this route, in [0,1]. */
  decisionConfidence: number;
  /** Time-coded source observations, not model-written justifications. */
  evidence: Array<{ startSeconds: number; endSeconds: number; frameRef: string; observation: string; fieldName?: keyof PresenterShotMeasurements; sourceKind?: 'server_extracted_frame' | 'deterministic_cv' | 'verified_asr' | 'human_review' }>;
}

export type PresenterStackRoute = 'heygen_talking' | 'seedance_first_frame' | 'split_motion_and_speech' | 'no_presenter_stack' | 'needs_evidence' | 'blocked';

export interface PresenterStackDecision {
  policyVersion: '1';
  route: PresenterStackRoute;
  executable: boolean;
  reasonCodes: string[];
  measurements: PresenterShotMeasurements;
}
