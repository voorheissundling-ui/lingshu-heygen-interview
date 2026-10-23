import type { SocialProductFootageEvidenceBinding } from './socialContentReplication.js';
import {
  SOCIAL_CONTENT_TASK_STATUSES,
  SOCIAL_WORK_PACKAGE_KINDS,
  SOCIAL_WORK_PACKAGE_STATUSES,
  SOCIAL_SOURCE_KINDS,
  SOCIAL_CONTENT_TASK_MODES,
  SOCIAL_CONTENT_CREATION_MODES,
  SOCIAL_REPLICATION_REFERENCE_MODES,
  SOCIAL_ASSET_AVAILABILITIES,
  SOCIAL_CONTENT_MANAGEMENT_MODES,
  SOCIAL_CONTENT_PRODUCTION_MODES,
  SOCIAL_CONTENT_THEME_IDS,
  SOCIAL_MATERIAL_REQUIREMENT_STATUSES,
  SOCIAL_ASSET_SUPPLY_ROUTES,
  SOCIAL_SHOT_FUNCTIONS,
  SOCIAL_TRUTH_SENSITIVE_SUBJECTS,
  SOCIAL_SHOT_SOURCE_STRATEGIES,
  SOCIAL_TRUTH_PROHIBITIONS,
  SOCIAL_PRODUCTION_FEASIBILITIES,
  SOCIAL_REPLICATION_FACTOR_CATEGORIES,
  SOCIAL_REPLICATION_FACTOR_POLICIES,
  type SocialContentTaskStatus,
  type SocialWorkPackageKind,
  type SocialWorkPackageStatus,
  type SocialSourceKind,
  type SocialContentTaskMode,
  type SocialContentCreationMode,
  type SocialReplicationReferenceMode,
  type ReferenceMode,
  type SocialAssetAvailability,
  type SocialContentManagementMode,
  type SocialContentProductionMode,
  type SocialContentThemeId,
  type SocialThemeClassificationStatus,
  type SocialContentThemeCard,
  type SocialContentThemeSelection,
  type SocialMaterialRequirementStatus,
  type SocialMaterialRequirement,
  type SocialMaterialReadiness,
  type SocialAssetSupplyRoute,
  type SocialShotFunction,
  type SocialTruthSensitiveSubject,
  type SocialShotSourceStrategy,
  type SocialTruthProhibition,
  type SocialProductionFeasibility,
  type SocialShotTruthBoundary,
  type SocialFunctionalEquivalentReplacement,
  type SocialAccountPresenterLock,
  type SocialProductSceneReplicationSpec,
  type SocialAssetSupplyShotPlan,
  type SocialAssetSupplyPlan,
  type SocialReferenceShotTags,
  type SocialReferenceShotAnalysis,
  type SocialTimelineSubjectKind,
  type SocialTimelineBeat,
  type SocialThreeSecondHook,
  type SocialReferenceVideoAnalysis,
  type SocialVersionedObjectRef,
  type SocialBenchmarkAccountSnapshot,
  type SocialReferenceContentAnalysis,
  type SocialAccountPlaybookRef,
  type SocialReplicationReferenceChain,
  type SocialReplicationFactorCategory,
  type SocialReplicationFactorPolicy,
  type SocialReplicationFactorImportance,
  type SocialReplicationCausalRole,
  type SocialReplicationCausalStatus,
  type SocialReplicationFactorEvidence,
  type SocialReplicationFactorTarget,
  type SocialReplicationFactorTolerance,
  type SocialReplicationFactorValidator,
  type SocialReplicationFactorSpec,
  type ReplicationFactorSpec,
  type SocialReplicationReferenceAssignment,
  type SocialReplicationJobContext,
  type SocialReplicationJob,
  type ReplicationJob,
  type SocialCreativePatternMemory,
  type SocialCompanyRole,
  type SocialAudienceRole,
  type SocialSearchIntent,
  type SocialKeywordEvidenceSource,
  type SocialDiscoveryMode,
  type SocialDiscoveryPath,
  type SocialInspirationReadiness,
  type SocialAccountTrackingStatus,
  type SocialCrawlKeywordCategory,
  type SocialBenchmarkAccountType,
  type SocialKeywordScope,
  type SocialDiscoverySeed,
  type SocialSceneCluster,
  type SocialContentSearchUnit,
  type SocialKeywordRelation,
  type SocialKeywordGraph,
  type SocialMarketKeywordSet,
  type SocialDiscoveryBrief,
  type SocialDiscoveryModePolicy,
  type SocialCollectionRunStatus,
  type SocialCollectionStopReason,
  type SocialDiscoveryModeRunStats,
  type SocialInspirationCollectionRun,
  type SocialProductionGapRequirement,
  type SocialProductionGapBudget,
  type SocialProductionGapTask,
  type SocialDiscoverySummary,
  type SocialCandidateEvidence,
  type SocialInspirationHandoff,
  type SocialAccountTrackingDecision,
  type SocialCrawlStrategy,
  type SocialInspirationScores,
  type SocialReplicationScriptShot,
  type SocialReplicationScriptVersion,
  type SocialShotMaterialMapEntry,
} from './socialContentWorkflow.js';
import type {
  SocialMaterialRole,
  SocialProductPolicy,
  SocialProductPolicySource,
  SocialSceneVisualContract,
} from '../sceneVisualContract.js';

export const SOCIAL_AGENT_WORKFLOW_STAGES = [
  'planned',
  'reference_ready',
  'factor_ready',
  'director_ready',
  'execution_planning',
  'director_review',
  'producing',
  'technical_review',
  'media_evaluation',
  'creative_review',
  'asset_review',
  'ready_to_publish',
  'needs_facts',
  'needs_rights',
  'needs_budget',
  'goal_degraded',
  'failed_recoverable',
] as const;
export type SocialAgentWorkflowStage = typeof SOCIAL_AGENT_WORKFLOW_STAGES[number];

export interface SocialWeeklyContentPackage {
  packageId: string;
  version: string;
  businessGoal: string;
  productFocus: string | null;
  audience: string | null;
  markets: string[];
  languages: string[];
  originalContentCount: number;
  adaptationVersionCount: number;
  publicationTaskCount: number;
  platforms: string[];
  publicationMatrix: Array<{
    platform: string;
    accountRef: string | null;
    accountPositioning: string | null;
    publishWindow: string | null;
  }>;
  weeklyBudgetCny: number | null;
  perItemBudgetCny: number | null;
  dueAt: string | null;
  availableAssetRefs: string[];
  customerCanShoot: boolean;
  availableCapabilities: SocialShotSourceStrategy[];
  priorities: Array<'must_do' | 'can_delay' | 'experiment'>;
  successCriteria: string[];
  metricTargets: string[];
  createdBy: 'business_agent';
}

export interface SocialAdHocBusinessContext {
  contextId: string;
  version: string;
  objective: string;
  productRef: string | null;
  audience: string | null;
  platforms: string[];
  markets: string[];
  languages: string[];
  budgetCny: number | null;
  dueAt: string | null;
  factSourceRefs: string[];
  createdBy: 'business_agent';
}

export interface SocialDirectorBriefScene {
  sceneId: string;
  order: number;
  referenceShotId: string | null;
  /** Visual subject is decided before choosing an existing asset or a generation stack. */
  visualTopic?: {
    kind: 'factory_footage' | 'competitor_comparison' | 'product_introduction' | 'presenter_talking' | 'other';
    subject: string;
    intent: string;
    personRole?: 'visible_speech' | 'expressive_action' | 'background' | 'none';
  };
  /** Exact analyzed segment and first-frame evidence for the Content Agent. */
  referenceMaterial?: {
    semanticLabel: { content: string; intent: string } | null;
    sourceVideoRef: string | null;
    clipRef: string | null;
    firstFrameRef: string | null;
    firstFrameSeconds: number | null;
    extractionStatus: 'ready' | 'unavailable';
    isPrimaryHook: boolean;
    hookDetail: import('./socialContentReplication.js').SocialThreeSecondHook['detailedAnalysis'] | null;
  };
  /** Provider-neutral requirements; the Content Agent selects a capable stack. */
  productionRouting?: {
    presenterVisible: boolean;
    presenterIdentityReplacementRequired: boolean;
    enterprisePresenterAssetRef: string | null;
    needsPreciseLipSync: boolean;
    needsExpressiveAction: boolean;
    needsCameraOrCompositionReconstruction: boolean;
    decisionReason: string[];
  };
  /** Independent source-person routing; never substitutes for capability measurements. */
  referenceProductionRouting?: import('../referenceShotProductionRouting.js').ReferenceShotProductionRouting;
  purpose: SocialShotFunction;
  targetVisual: string;
  /** Shared Director-to-Content visual contract. Optional on historic briefs. */
  visualContract?: SocialSceneVisualContract;
  requiredEvidence: string[];
  action: { startState: string; path: string; endState: string };
  shotLanguage: { shotSize: string; cameraAngle: string; movement: string; composition: string };
  spaceAndContinuity: string[];
  audioLayers: {
    voiceover: string | null;
    dialogue: string | null;
    captionIntent: string | null;
    ambient: string | null;
    music: string | null;
    soundEffects: string | null;
  };
  /** Every source sentence visually intersecting this scene. Narration is
   * emitted once, by its owner shot, even when video cuts during the line. */
  voiceoverLines?: Array<{
    lineId: string;
    text: string;
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    narrationOwnerShotId: string;
    visualShotIds: string[];
    isNarrationOwner: boolean;
  }>;
  /** The Content Agent must retrieve material against this exact spoken line.
   * Subject/action tags are secondary filters, never the primary query. */
  voiceoverAlignment?: {
    cueId: string;
    text: string;
    startSeconds: number;
    endSeconds: number;
    matchMode: 'verbatim_semantic';
    secondaryVisualTags: string[];
  };
  duration: { startSeconds: number; endSeconds: number; targetSeconds: number };
  truthBoundary: SocialShotTruthBoundary;
  allowedVariation: string[];
  acceptanceCriteria: string[];
  /** Frozen scene/camera language for product-reference-driven generation. */
  productSceneReplication?: SocialProductSceneReplicationSpec;
  /**
   * Machine-verifiable subset of the frozen factor spec. Optional only for
   * historic DirectorBrief records created before ReplicationJob v1.
   */
  replicationFactors?: Array<{
    factorId: string;
    factorSpecVersion: string;
    category: SocialReplicationFactorCategory;
    policy: SocialReplicationFactorPolicy;
    importance: SocialReplicationFactorImportance;
    target: SocialReplicationFactorTarget;
    tolerance: SocialReplicationFactorTolerance;
    validator: SocialReplicationFactorValidator;
    /** Records whether the source factor still applies literally after an
     * authored semantic rewrite, without losing its stable source identity. */
    semanticAdaptation?: {
      status: 'applicable' | 'functionally_replaced';
      sourceFactorId: string;
      targetFunction: SocialShotFunction;
      replacementReason: string | null;
    };
  }>;
  /** @deprecated Human-readable compatibility projection. */
  fidelityPoints: string[];
  /** @deprecated Human-readable compatibility projection. */
  mustDifferPoints: string[];
}

/** Director-owned expression contract. It deliberately contains no asset, clip, model or provider choice. */
export interface SocialDirectorBrief {
  directorBriefId: string;
  version: string;
  status: 'ready' | 'blocked';
  source: { weeklyPackageId: string | null; adHocBusinessContextId: string | null };
  /** Present for viral replication; optional only on historic records. */
  replicationJobRef?: { replicationJobId: string; version: string; factorSpecVersion: string } | null;
  referenceMode?: SocialReplicationReferenceMode | null;
  accountPlaybookRef?: SocialAccountPlaybookRef | null;
  /** Same published presenter identity must be reused by every presenter scene. */
  accountPresenterLock?: SocialAccountPresenterLock | null;
  referenceAnalysis: {
    analysisId: string;
    version: string;
    fullDurationSeconds: number | null;
    precisionIntervals: Array<{ startSeconds: number; endSeconds: number; level: 'L1' | 'L2' | 'L3' | 'L4' }>;
    gaps: Array<{ startSeconds: number; endSeconds: number; reason: string }>;
    overallConfidence: number | null;
  } | null;
  inspirationHandoffIds?: string[];
  topic: string;
  audience: string | null;
  platforms: string[];
  accountRefs: string[];
  creativeIntent: string;
  narrativeStructure: string[];
  rhythm: string;
  primaryHookId: string | null;
  coreSellingPoints: string[];
  callToAction: string | null;
  totalDurationSeconds: number;
  aspectRatio: string | null;
  languages: string[];
  brandRequirements: string[];
  factSourceRefs: string[];
  /** Director-owned automatic labels; users review the result instead of
   * manually deciding whether a product or enterprise facts are needed. */
  contentRequirements?: {
    product: {
      required: boolean;
      /** Stable Enterprise Center identity; absent on historic briefs. */
      productId?: string | null;
      productRef: string | null;
      /** Missing only on historic Director briefs. */
      policy?: SocialProductPolicy;
      /** Distinguishes an explicit customer lock from automatic selection. */
      source?: SocialProductPolicySource;
      confidence: number;
      reason: string;
    };
    enterpriseFacts: {
      required: boolean;
      factSourceRefs: string[];
      reason: string;
    };
    primaryMaterialKinds: Array<'product' | 'factory' | 'person' | 'scenario' | 'detail' | 'general'>;
  };
  rightsConstraints: string[];
  referenceEvidence: Array<{
    analysisId: string;
    referenceShotId: string | null;
    transferable: string[];
    mustReplace: string[];
  }>;
  budgetCny: number | null;
  dueAt: string | null;
  scenes: SocialDirectorBriefScene[];
  createdBy: 'director_agent';
}

export interface SocialExecutionCandidate {
  candidateId: string;
  kind: 'asset' | 'capability';
  label: string;
  sourceRef: string | null;
  sourceStrategy: SocialShotSourceStrategy;
  evidenceStrength: 'strong' | 'supporting' | 'non_evidentiary';
  rightsStatus: 'confirmed' | 'restricted' | 'requires_confirmation';
  enterpriseOwnershipScore: number;
  semanticScore: number;
  evidenceScore: number;
  actionAndShotScore: number;
  qualityScore: number;
  durationFitScore: number;
  repetitionPenalty: number;
  estimatedCostCny: number;
  estimatedSeconds: number;
  estimatedSuccessRate: number;
  dataTransfer: 'local_only' | 'external_processor';
  providerId: string | null;
  modelId: string | null;
  clipId: string | null;
  timeRange: { startSeconds: number; endSeconds: number } | null;
  promptRef: string | null;
  previewUrl?: string | null;
  mediaType?: 'video' | 'image' | null;
  matchedVoiceoverCueIds?: string[];
  /** Stable product identity is retained separately from its display label. */
  productId?: string | null;
  productRef?: string | null;
  enterpriseCommon?: boolean;
  materialRoles?: SocialMaterialRole[];
  /** Segment-level candidates let Content Agent trim one asset by exact cue. */
  materialSegments?: Array<{
    /** First-class, revision-bound identity for caching and deterministic reuse. */
    candidateId?: string;
    segmentId: string;
    footageEvidence?: SocialProductFootageEvidenceBinding;
    sourceRevision?: string;    startSeconds: number;
    endSeconds: number;
    assetRole?: import('./materialAssetV2.js').MaterialAssetRoleV2;
    contentRole?: import('./materialAssetV2.js').MaterialContentRoleV2;
    productIdentityLevel?: import('./materialAssetV2.js').MaterialProductIdentityLevelV2;
    templateEligible?: boolean;
    reuseScore?: number;
    visualContract: SocialSceneVisualContract;
    materialRoles: SocialMaterialRole[];
    matchedVoiceoverCueIds: string[];
    voiceoverScore: number;
    visualCompatibilityScore: number;
  }>;
  retryPolicy: { maxAttempts: number; fallbackStrategies: SocialShotSourceStrategy[] };
  provenance: {
    origin: 'customer' | 'licensed_library' | 'system_capability';
    inputVersion: string;
    authorizationRef: string | null;
    executionRecordId: string | null;
  };
}

export interface SocialProductionOption {
  approach: import('./socialContentReplication.js').SocialProductionApproach;
  label: string;
  description: string;
  qualityTier: 'standard' | 'enhanced' | 'premium';
  available: boolean;
  unavailableReason: string | null;
  usesPaidProviders: boolean;
  estimatedCostCny: number;
  includedOperations: string[];
  selectedMaterialIds: string[];
  firstFramePreview: {
    assetId: string;
    label: string;
    mediaType: 'video' | 'image';
    url: string | null;
    sourceTimestampSeconds: 0;
  } | null;
}

export interface SocialContentExecutionScenePlan {
  sceneId: string;
  /** Content Agent's own decision, derived from the Director's goals and available resources. */
  routeDecision?: {
    visualTopic: SocialDirectorBriefScene['visualTopic'];
    policy: 'hook_fidelity' | 'visible_speech' | 'expressive_action' | 'reuse_material' | 'product_scene' | 'needs_capability';
    reason: string;
    source: 'content_agent';
  };
  /** Frozen Director-owned requirements this scene must realize. */
  replicationFactorIds?: string[];
  factorFeasibility?: Array<{
    factorId: string;
    /** False means the source factor is retained for lineage but was honestly
     * replaced by the scene's target function and is not an output validator. */
    required?: boolean;
    feasible: boolean;
    reason: string;
    plannedValidatorId: string;
    /** Output domain consumed by the independent post-render detector. This
     * keeps detector planning separate from production-candidate selection. */
    validationScope?: 'scene_frames' | 'timeline_segment' | 'audio_track' | 'caption_track' | 'whole_output';
    /** Concrete evidence that must be emitted before this frozen factor can
     * pass. The detector remains planned while those render artifacts are pending. */
    requiredEvidence?: Array<'reference_frame' | 'output_frame' | 'timeline_measurement' | 'audio_segment' | 'caption_text' | 'fingerprint_measurement'>;
    detectorIndependence?: 'independent_post_render';
    plannedCandidateId?: string | null;
    semanticAdaptation?: {
      status: 'applicable' | 'functionally_replaced';
      sourceFactorId: string;
      targetFunction: SocialShotFunction;
      replacementReason: string | null;
    };
  }>;
  feasibility: SocialProductionFeasibility;
  feasibilityReason: string;
  candidates: SocialExecutionCandidate[];
  recommendedCandidateIds: string[];
  alternativeCandidateGroups: string[][];
  selectedSourceStrategy: SocialShotSourceStrategy;
  fallbackSourceStrategy: SocialShotSourceStrategy | null;
  estimatedCostCny: number;
  estimatedSeconds: number;
  estimatedSuccessRate: number;
  rightsRisks: string[];
  dataTransferRisks: string[];
  idempotencyKey: string;
  productSceneReplication?: SocialProductSceneReplicationSpec;
}

/** Content-Agent-owned implementation plan. */
export interface SocialContentExecutionPlan {
  executionPlanId: string;
  version: string;
  directorBriefId: string;
  directorBriefVersion: string;
  status: 'planning' | 'review_required' | 'approved' | 'blocked';
  reviewRound: number;
  maxReviewRounds: number;
  budgetLimitCny: number | null;
  deadlineAt: string | null;
  accountPresenterLock?: SocialAccountPresenterLock | null;
  estimatedTotalCostCny: number;
  estimatedTotalSeconds: number;
  selectedApproach?: import('./socialContentReplication.js').SocialProductionApproach;
  productionOptions?: SocialProductionOption[];
  referenceFirstFramePreview?: {
    label: string;
    mediaType: 'video' | 'image';
    url: string | null;
    sourceTimestampSeconds: 0;
  } | null;
  scenes: SocialContentExecutionScenePlan[];
  createdBy: 'content_agent';
}

export type SocialExecutionPlanReviewReason =
  | 'material_insufficient'
  | 'facts_missing'
  | 'rights_missing'
  | 'budget_exceeded'
  | 'capability_mismatch'
  | 'duration_mismatch'
  | 'generation_failed'
  | 'expression_failed';

export interface SocialExecutionPlanSceneReview {
  sceneId: string;
  approved: boolean;
  feasibility: SocialProductionFeasibility;
  failedCriteria: string[];
  requiredRevision: string[];
  goalImpact: 'none' | 'video' | 'weekly_plan';
  reasonCodes: SocialExecutionPlanReviewReason[];
}

export interface SocialExecutionPlanReview {
  /** V2 candidate review is not paid authorization; real provider quotes,
   * prior spend and every required stage remain a separate hard preflight. */
  budgetPreflight?: {state:'required'; advisoryEstimatedCostCny:number; maximumCny:number|null; advisoryExceeded:boolean};
  reviewId: string;
  version: string;
  executionPlanId: string;
  executionPlanVersion: string;
  directorBriefId: string;
  directorBriefVersion: string;
  approved: boolean;
  sceneResults: SocialExecutionPlanSceneReview[];
  failedCriteria: string[];
  requiredRevision: string[];
  goalImpact: 'none' | 'video' | 'weekly_plan';
  reasonCodes: SocialExecutionPlanReviewReason[];
  createdBy: 'director_agent';
}

export interface SocialProductionResult {
  productionResultId: string;
  version: string;
  executionPlanId: string;
  executionPlanVersion: string;
  executionPlanReviewId: string;
  artifactId: string | null;
  creativeReviewId: string;
  publishAssignmentId: string | null;
  status: 'technical_review_passed' | 'creative_review_passed' | 'asset_review';
  sceneResults: Array<{
    sceneId: string;
    idempotencyKey: string;
    sourceStrategy: SocialShotSourceStrategy;
    feasibility: SocialProductionFeasibility;
    provenanceCandidateIds: string[];
    /** Exact media selected by the existing supply execution for this scene.
     * This is the render input for the shot, not a synthetic preview and not
     * the final whole-film artifact. Historic results may omit it. */
    mediaArtifact?: {
      assetId: string;
      mediaType: 'video' | 'image';
      resourceRef: string;
      contentHash: string;
      durationSeconds: number;
      providerId: string;
      supplyPlanVersion: string;
      role: 'scene_render_input';
    };
  }>;
  technicalReview: { approved: boolean; checkedScenes: number; failures: string[] };
  creativeReview: { approved: boolean; failedCriteria: string[]; reviewedBy: 'director_agent' };
  artifactResourceRef: string;
  createdAt: string;
}

export interface SocialReplicationEvaluationDimension {
  status: 'passed' | 'failed' | 'review_required' | 'not_applicable';
  score: number | null;
  blockingFactorIds: string[];
  evidenceRefs: string[];
  summary: string;
}

/** Independent evidence report. It may not change factor weights or tolerances. */
export interface SocialReplicationEvaluation {
  evaluationId: string;
  version: string;
  replicationJobId: string;
  replicationJobVersion: string;
  factorSpecVersion: string;
  productionResultId: string;
  attemptId: string;
  status: 'running' | 'passed' | 'failed' | 'review_required';
  referenceTimelineAudit?: {
    referenceShotCount: number;
    referenceDurationSeconds: number;
    outputShotCount: number;
    fullCoverageValidated: boolean;
  };
  viralFactorFidelity: SocialReplicationEvaluationDimension;
  identityReplacement: SocialReplicationEvaluationDimension;
  originalityDifference: SocialReplicationEvaluationDimension;
  unauthorizedReuseRisk: SocialReplicationEvaluationDimension;
  accountAndFactFit: SocialReplicationEvaluationDimension;
  sceneResults: Array<{
    sceneId: string;
    factorResults: Array<{
      factorId: string;
      status: 'passed' | 'failed' | 'review_required';
      measuredValue: string | number | boolean | string[] | null;
      evidenceRefs: string[];
      repairAction: string | null;
    }>;
  }>;
  generatedBy: 'media_evaluation_worker';
  generatedAt: string;
  directorDecision: {
    status: 'pending' | 'approved' | 'changes_required';
    reviewedBy: 'director_agent';
    failedCriteria: string[];
    reviewedAt: string | null;
  };
}

export interface SocialWorkflowResponsibilityBoundary {
  businessGoalOwner: 'business_agent';
  factorDecisionOwner: 'director_agent';
  executionOwner: 'content_agent';
  metricEvidenceProvider: 'metrics_worker';
  mediaEvidenceProvider: 'media_evaluation_worker';
  finalGateOrder: ['content_agent', 'media_evaluation_worker', 'director_agent', 'business_agent', 'rules_engine'];
  selfApprovalForbidden: true;
}

export interface SocialContentAgentWorkflow {
  schemaVersion: 'social-content-agent-workflow.v1' | 'social-content-agent-workflow.v2';
  stage: SocialAgentWorkflowStage;
  contentPlanId: string;
  videoTaskId: string;
  weeklyPackage: SocialWeeklyContentPackage | null;
  adHocBusinessContext: SocialAdHocBusinessContext | null;
  discoveryBrief: SocialDiscoveryBrief | null;
  inspirationHandoffs: SocialInspirationHandoff[];
  /** Unified job is absent only for material-processing or historic records. */
  replicationJob?: SocialReplicationJob | null;
  responsibilityBoundary?: SocialWorkflowResponsibilityBoundary;
  directorBrief: SocialDirectorBrief;
  executionPlan: SocialContentExecutionPlan;
  executionPlanReview: SocialExecutionPlanReview;
  productionResult: SocialProductionResult | null;
  replicationEvaluation?: SocialReplicationEvaluation | null;
}
