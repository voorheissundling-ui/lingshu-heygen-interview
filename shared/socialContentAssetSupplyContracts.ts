import type { BenchmarkMaterialType } from './benchmarkAnalysis';
import type {
  SocialAssetAvailability,
  SocialAssetSupplyShotPlan,
  SocialAccountPresenterLock,
  SocialContentCreationMode,
  SocialContentManagementMode,
  SocialProductionApproach,
  SocialProductSceneReplicationSpec,
  SocialReferenceShotAnalysis,
  SocialShotFunction,
  SocialTruthSensitiveSubject,
} from './contracts/socialContentWorkflow';
import type { LocalMaterialSegmentRejection } from './contracts/localMaterialSegmentProfile';
import type { SocialMaterialRouting } from './contracts/socialContentReplication';
import type { FixedYieldArchetypeId } from './fixedYieldMaterialRegistry';
import type { SocialSceneVisualContract } from './sceneVisualContract';

export interface SocialAssetInventory {
  customerVideoIds?: string[];
  productImageIds?: string[];
  productIdentityGroups?: Array<{ productRef: string; imageIds: string[] }>;
  presenterAssetIds?: string[];
  referenceVideoIds?: string[];
  factoryEvidenceAssetIds?: string[];
  customerCaseEvidenceAssetIds?: string[];
  productEffectEvidenceAssetIds?: string[];
  licensedStockAssetIds?: string[];
}

export interface SocialAssetSupplyShotRequest {
  materialType?: BenchmarkMaterialType;
  fixedYieldArchetypeId?: FixedYieldArchetypeId;
  localVideoMatch?: {
    sourceRefs: string[];
    semanticMatch: 'verified';
    evidenceRef: string;
    productRef?: string | null;
    archetypeId?: FixedYieldArchetypeId;
    sourceTier?: 'product_high_fidelity_local' | 'product_packaging_first_frame_i2v' | 'product_local' | 'factory_local' | 'other_local';
  };
  localMaterialRejections?: LocalMaterialSegmentRejection[];
  selectedMaterialSegment?: SocialAssetSupplyShotPlan['selectedMaterialSegment'];
  plannedDurationSeconds?: number;
  materialRouting?: SocialMaterialRouting;
  shotId: string;
  function: SocialShotFunction;
  requestedDescription?: string | null;
  truthSensitiveSubject?: SocialTruthSensitiveSubject;
  referenceShotId?: string | null;
  productSceneReplication?: SocialProductSceneReplicationSpec;
  subjects?: string[];
  interaction?: string | null;
  environment?: string | null;
  productUsage?: string | null;
  productPolicy?: 'locked' | 'preferred' | 'open';
  productRef?: string | null;
  visualContract?: SocialSceneVisualContract;
}

export interface CreateSocialAssetSupplyPlanInput {
  materialRoutingPolicyVersion?: 'type-aware.v1' | 'type-aware.v2';
  creationMode: SocialContentCreationMode;
  assetAvailability?: SocialAssetAvailability;
  managementMode?: SocialContentManagementMode;
  productionApproach?: SocialProductionApproach;
  planVersion?: string;
  inventory?: SocialAssetInventory;
  accountPresenterLock?: SocialAccountPresenterLock | null;
  presenterSelectionConfirmed?: boolean;
  referenceShots?: SocialReferenceShotAnalysis[];
  confirmedFactRefs?: string[];
  rightsConfirmationRequired?: boolean;
  shots?: SocialAssetSupplyShotRequest[];
}
