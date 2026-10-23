export interface DigitalHumanReferenceCue {
  id: string;
  start: number;
  end: number;
  /** Supplier request duration when the reference beat is shorter than the provider minimum. */
  generationDurationSeconds?: number;
  /** Duration retained on the editing timeline after the supplier result is returned. */
  outputDurationSeconds?: number;
  originalText: string;
  targetText: string;
  shotIds: string[];
  /** Manual physical-shot split: both source wording and person speech must be reassigned. */
  splitFromCueId?: string;
  /** Only person shots enter the paid first-frame replacement chain. */
  personShot?: boolean;
  classificationSource?: 'analysis' | 'manual';
  /** Immutable matched reference shot. Presenter frames may not use a generic scene fallback. */
  referenceShotId?: string;
  referenceFirstFrameUrl?: string;
  composition?: { presenterKey: string; shotSize: string; cameraAngle: string; background: string; actionIntent: string; referenceShotId?: string; sourceComposition?: string };
  compositionClusterId?: string;
  /** Tenant-owned replacement footage for product/factory/B-roll cues. */
  nonPersonMaterialId?: string;
  /** The source frame is extracted locally for structure/composition analysis. */
  sourceFirstFrame?: { time: number; materialId?: string; imageUrl?: string };
  /** The rebuilt frame contains the selected enterprise presenter and becomes video input. */
  targetFirstFrame?: { materialId?: string; imageUrl?: string; state: 'pending' | 'ready' | 'failed' };
  /** Optional paid Qwen composition draft. It is never used as Seedance input without a separate final-frame step. */
  draftFirstFrame?: { provider: 'qwen'; materialId: string; imageUrl?: string; state: 'ready'; estimatedCostCny: number };
  generatedClip?: { materialId?: string; videoUrl?: string; state: 'pending' | 'ready' | 'failed'; duration?: number; inputFingerprint?: string };
}

/** Provider-independent requirements shared by the editor and server admission checks. */
export interface DigitalHumanRequirements {
  targetFramesConfirmed?: boolean;
  presenterMode?: 'video_twin' | 'photo_talking';
  workflow: 'material_processing' | 'viral_replication';
  method: 'talking' | 'replace' | 'reenact';
  preferredProvider?: 'auto' | 'kling' | 'sd' | 'runway' | 'self_hosted';
  /** Viral reenactment defaults to local sentence/frame decomposition; direct reference is opt-in. */
  replicationMode?: 'sentence_first_frame' | 'direct_reference';
  presenterSelected?: boolean;
  replacementScope?: 'face_only' | 'person_keep_scene' | 'person_and_scene';
  targetEffect?: 'natural_talking' | 'reference_motion' | 'flexible_scene';
  contentConfirmed: boolean;
  action: string;
  scene: string;
  preserve: string;
  reference?: {
    materialId?: string;
    videoUrl: string;
    start: number;
    end: number;
    originalText: string;
    derivativeAuthorized: boolean;
    derivativeAuthorizationEvidence?: string;
    modelInputAuthorized?: boolean;
    modelInputAuthorizationEvidence?: string;
    cues?: DigitalHumanReferenceCue[];
  };
}

/**
 * `presenterMode` is an explicit user choice and therefore outranks legacy
 * analysis fields left on older drafts. In particular, switching an old viral
 * reenactment shot to an existing HeyGen video twin must not keep routing it
 * through sentence-first-frame analysis.
 */
export function effectiveDigitalHumanRequirements(
  requirements?: DigitalHumanRequirements,
): DigitalHumanRequirements | undefined {
  if (!requirements?.presenterMode) return requirements;
  const photoReplication = requirements.presenterMode === 'photo_talking'
    && requirements.workflow === 'viral_replication';
  if (photoReplication) return {
    ...requirements,
    method: 'reenact',
    preferredProvider: 'sd',
    replicationMode: 'sentence_first_frame',
  };
  return {
    ...requirements,
    workflow: 'material_processing',
    method: 'talking',
    preferredProvider: 'auto',
    replicationMode: 'sentence_first_frame',
    replacementScope: undefined,
    targetEffect: 'natural_talking',
    action: '',
    scene: '',
    preserve: '',
    reference: undefined,
    targetFramesConfirmed: undefined,
  };
}
