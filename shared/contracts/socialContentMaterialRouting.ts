import type { BenchmarkMaterialType } from '../benchmarkAnalysis.js';
import type { FixedYieldArchetypeId } from '../fixedYieldMaterialRegistry.js';
import type { LocalMaterialSegmentRejection } from './localMaterialSegmentProfile.js';

export type SocialProductFootageEvidenceBinding = {
  contentSha256: string;
  productId: string;
  sceneFunction: string;
  approvalId: string;
  visualFindingId: string;
};

export interface SocialProductIdentityGroup {
  productRef: string;
  referenceImageIds: string[];
  requiredVisibleElements: string[];
  forbiddenChanges: Array<'shape' | 'material' | 'color' | 'logo' | 'label_text' | 'packaging_structure'>;
}

export interface SocialProductSceneReplicationSpec {
  schemaVersion: 'social-product-scene-replication.v1';
  templateSource: 'reference_shot' | 'account_scene_template' | 'system_clean_stage';
  sceneTemplateKey: string;
  referenceShotId: string | null;
  referenceSourceId?: string | null;
  referenceStartSeconds?: number | null;
  referenceEndSeconds?: number | null;
  productIdentity: { groups: SocialProductIdentityGroup[]; identitySimilarityMinimum: number; ocrExactMatchRequired: boolean };
  sceneLock: {
    environment: string;
    background: string;
    platform: string;
    lighting: string;
    composition: string;
    productSlots: Array<{ slotId: string; productRef: string; placement: string; orientation: string; scale: number }>;
  };
  compositionSafety: {
    contentModulePolicy: 'benchmark_locked';
    reservedSafeZoneSource: 'reference_content_modules' | 'system_template';
    subjectPlacement: 'outside_content_module_safe_zone';
    visualCenterBias: 'lower_when_upper_modules';
    minimumClearanceRatio: number;
    repairOrder: ['lower_visual_center', 'rescale_subject', 'regenerate_composition', 'adjust_content_module'];
  };
  cameraLock: {
    shotSize: string;
    cameraAngle: string;
    lensFeel: string;
    startFrame: string;
    movementPath: string;
    endFrame: string;
    durationSeconds: number;
    easing: string;
  };
  tolerance: { durationSeconds: number; productPositionRatio: number; productScaleRatio: number; cameraPathDeviationRatio: number };
  validation: {
    requiredChecks: Array<'product_identity' | 'packaging_visibility' | 'subject_visibility' | 'label_ocr' | 'scene_topology' | 'product_slot_layout' | 'camera_trajectory'>;
    singleShotRetryOnFailure: true;
  };
}

export interface SocialMaterialRouting {
  schemaVersion: 'social-material-routing.v1';
  materialType: BenchmarkMaterialType;
  policy: 'local_only' | 'local_first_product_i2v' | 'authorized_presenter';
  localMatch: {
    state: 'matched' | 'missing';
    sourceRefs: string[];
    evidenceRef: string | null;
    productRef?: string | null;
    archetypeId?: FixedYieldArchetypeId;
    sourceTier?: 'product_high_fidelity_local' | 'product_packaging_first_frame_i2v' | 'product_local' | 'factory_local' | 'other_local';
    rejections?: LocalMaterialSegmentRejection[];
  };
  generation?: {
    sourceTier?: 'product_packaging_first_frame_i2v';
    method: 'reference_first_frame_product_replacement_i2v' | 'enterprise_authored_product_first_frame_i2v';
    firstFrameOrigin?: 'original_reference_pixels' | 'enterprise_authored_storyboard';
    videoProvider?: 'wan' | 'seedance';
    videoModel?: 'wan2.6-i2v-flash' | 'wan2.2-i2v-flash';
    qaModel?: 'qwen3-vl-plus';
    durationSeconds: number;
    durationOrigin?: 'default_short_shot' | 'planned_timeline' | 'explicit_frozen';
    productImageRefs: string[];
    referenceShotId: string | null;
    referenceSourceId: string | null;
  };
  productGenerationDecision?: {
    state: 'eligible' | 'selected' | 'local_only';
    importance: 'critical' | 'standard';
    reason: string;
    quoteRef?: string;
    estimatedCostCny?: number;
    budgetPlanRef?: string;
  };
}
