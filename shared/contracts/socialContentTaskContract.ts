import type { SocialMvpHandoffRead } from './socialMvpHandoff.js';
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
  SOCIAL_AGENT_WORKFLOW_STAGES,
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
  type SocialProductionApproach,
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
  type SocialAgentWorkflowStage,
  type SocialWeeklyContentPackage,
  type SocialAdHocBusinessContext,
  type SocialDirectorBriefScene,
  type SocialDirectorBrief,
  type SocialExecutionCandidate,
  type SocialContentExecutionScenePlan,
  type SocialContentExecutionPlan,
  type SocialExecutionPlanReviewReason,
  type SocialExecutionPlanSceneReview,
  type SocialExecutionPlanReview,
  type SocialProductionResult,
  type SocialReplicationEvaluationDimension,
  type SocialReplicationEvaluation,
  type SocialWorkflowResponsibilityBoundary,
  type SocialContentAgentWorkflow,
} from './socialContentWorkflow.js';
import type { ProductionReadModelV1 } from './productionReadModel.js';

export const SOCIAL_ARTIFACT_STATUSES = ['draft', 'review_required', 'approved', 'changes_requested', 'superseded'] as const;
export type SocialArtifactStatus = typeof SOCIAL_ARTIFACT_STATUSES[number];

export interface SocialWorkPackageCard {
  kind: SocialWorkPackageKind;
  packageKey: string;
  version: string;
  name: string;
  available: boolean;
  summary: string | null;
  requiredInputs: string[];
  deliverables: string[];
}

export interface SocialWorkPackageFramework {
  applicability: string[];
  requiredInputs: string[];
  workOutline: string[];
  deliverables: string[];
  userDecisions: string[];
  qualityChecks: string[];
  metricRequirements: string[];
  fallbackPolicy: string[];
}

export interface SocialWorkPackageVersionDetail extends SocialWorkPackageCard {
  summary: string | null;
  status: SocialWorkPackageStatus;
  framework: SocialWorkPackageFramework;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  recordVersion: string;
  updatedAt: string;
  builtin: boolean;
}

export interface CreateSocialWorkPackageVersionInput {
  kind: SocialWorkPackageKind;
  packageKey: string;
  version: string;
  name: string;
  summary?: string | null;
  framework?: Partial<SocialWorkPackageFramework>;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
}

export interface UpdateSocialWorkPackageVersionInput {
  expectedVersion: string;
  changes: Partial<Omit<CreateSocialWorkPackageVersionInput, 'kind' | 'packageKey' | 'version'>>;
}

export interface SocialWorkPackageSelection {
  kind: SocialWorkPackageKind;
  packageKey: string;
  version: string;
  name: string;
}

/** Use this exact already-analyzed video; cache gaps never trigger collection. */
export interface SocialReferenceReuseBinding {
  recordId: string;
  contentSha256: string;
  analysisId: string;
  analysisHash: string;
}

export interface SocialContentTaskBrief {
  title: string;
  objective: string;
  /** Stable Enterprise Center product identity. */
  productId?: string | null;
  /** Human-readable product label retained for review and legacy records. */
  productRef: string | null;
  /** Optional explicit identity selection for this task; never used as a fuzzy lookup. */
  requestedPresenterName?: string | null;
  requestedPresenterAssetId?: string | null;
  /** Explicit tenant presenter selected in the content-creation workbench. */
  presenterAssetId?: string | null;
  audience: string | null;
  markets: string[];
  languages: string[];
  platforms: string[];
  formats: string[];
  aspectRatio: string | null;
  cadence: string | null;
  requestedOutputCount: number | null;
  weeklyBudgetCny?: number | null;
  perItemBudgetCny?: number | null;
  /** Intended finished-film duration. Planning may adapt reference pacing to this bound. */
  targetDurationSeconds?: number | null;
  retryReserveCny?: number | null;
  planningMode?: 'fixed' | 'auto_adjust';
  shootingWindowMinutes?: number | null;
  specialRequirements?: string | null;
  dueAt: string | null;
  brandNotes: string | null;
  restrictions: string[];
  callToAction: string | null;
  /** Target business/account lineage for the unified social-program workflow. */
  programRef?: SocialVersionedObjectRef | null;
  targetAccountRef?: SocialVersionedObjectRef | null;
  accountPlaybookRef?: SocialAccountPlaybookRef | null;
  /** Explicit only for advanced use; historic clone tasks infer single-source. */
  referenceMode?: SocialReplicationReferenceMode;
  primaryExperimentVariable?: string | null;
  /** New two-entry workflow. Omitted on historic tasks. */
  creationMode?: SocialContentCreationMode;
  /** Customer visual readiness is informative and must never be the sole blocker. */
  assetAvailability?: SocialAssetAvailability;
  /** Defaults to one-click managed for newly created customer tasks. */
  managementMode?: SocialContentManagementMode;
  /** Always present on newly created tasks; optional for historic projections. */
  productionMode?: SocialContentProductionMode;
  /** Defaults to the zero-paid-provider customer-material edit. */
  productionApproach?: SocialProductionApproach;
  /** Explicit new-plan policy; omission preserves historical frozen routing. */
  materialRoutingPolicyVersion?: 'type-aware.v1' | 'type-aware.v2';
  referenceReuse?: SocialReferenceReuseBinding;
}

/** Public metadata only. Formula identifiers and internal prompt templates stay server-side. */
export interface SocialScriptBaselineSummary {
  version: string;
  source: 'reference_analysis' | 'asset_supply_plan' | 'inspiration_script' | 'knowledge_fallback' | 'system_theme_baseline' | 'formula';
  sceneCount: number;
  language: 'zh' | 'en';
  lockedAt: string;
  /** Public lineage only; internal formula/script identifiers remain private. */
  matchConfidence?: number;
  groundingVersion?: string;
  /** Active task reference source; absent for system recommendations and historic records. */
  referenceSourceId?: string | null;
  /** Customer-visible reference video identity used for authenticated previews. */
  referenceVideoId?: string | null;
}

/**
 * Customer-safe projection of the versioned Director Agent handoff. Formula
 * identifiers, internal templates and material scoring evidence remain on the
 * server; the user can still understand exactly what the director prepared for
 * the Content Agent.
 */
export interface SocialDirectorPlanSummary {
  version: string;
  status: 'ready' | 'blocked';
  scriptSource: 'reference_analysis' | 'asset_supply_plan' | 'inspiration_script' | 'knowledge_fallback' | 'system_theme_baseline' | 'formula';
  baselineVersion: string;
  sceneCount: number;
  language: 'zh' | 'en';
  createdAt: string;
  /** @deprecated Kept only while historic formula-backed plans remain readable. */
  formulaConfigured: boolean;
  qualityPassed: boolean;
  reshootSuggestionCount: number;
  scriptSummary: string;
  voiceoverSummary: string;
  subtitleSummary: string;
  shotRhythmSummary: string;
  /** Active task reference source; null for a clearly-labelled system recommendation. */
  referenceSourceId?: string | null;
}

export interface SocialContentTaskSummary {
  taskId: string;
  /** Read-only server binding. Historic tasks have no implicit new allowance. */
  contentOrder?: {schemaVersion:'social-content-order.v1';contentId:string;budgetTaskId:string;
    entry:'weekly_package'|'workspace'|'assistant';programId:string|null;originWeek:string|null};
  brief: SocialContentTaskBrief;
  status: SocialContentTaskStatus;
  version: string;
  packageSelection: SocialWorkPackageSelection[];
  readiness: {
    complete: boolean;
    /** Only conditions that genuinely prevent any safe production. */
    missing: string[];
    /** Optional inputs that improve personalization but never block production. */
    personalizationGaps?: string[];
  };
  runId: string | null;
  sourceCount: number;
  knowledgeSourceCount: number;
  materialSourceCount: number;
  artifactCount: number;
  approvedArtifactCount: number;
  deliveryPackageCount: number;
  publicationCount: number;
  metricSubmissionCount: number;
  createdAt: string;
  updatedAt: string;
  /** Present for theme-driven tasks; omitted only for records created before this workflow. */
  mode?: SocialContentTaskMode;
  weeklyPlanId?: string | null;
  theme?: SocialContentThemeSelection | null;
  materialReadiness?: SocialMaterialReadiness;
  assetSupplyPlan?: SocialAssetSupplyPlan;
  scriptBaseline?: SocialScriptBaselineSummary;
  /** Present after the Director Agent has handed a locked plan to Content Agent. */
  directorPlan?: SocialDirectorPlanSummary;
}

export interface SocialTaskSource {
  sourceId: string;
  taskId: string;
  kind: SocialSourceKind;
  sourceRef: string;
  sourceVersion: string | null;
  label: string;
  purpose: string | null;
  status: 'active' | 'replaced' | 'removed';
  createdAt: string;
}

export interface SocialContentFile {
  fileId: string;
  taskId: string;
  usage: 'source' | 'metric_evidence' | 'artifact_media';
  fileRef: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  /** Authenticated application-backend URL; never an application-server path. */
  downloadUrl?: string;
}

export interface SocialContentSourceOption {
  optionId: string;
  kind: 'knowledge' | 'material';
  sourceRef: string;
  sourceVersion: string;
  label: string;
  type: string;
  thumbnailHref: string | null;
}

export interface SocialContentSourceOptionPage {
  items: SocialContentSourceOption[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  status: 'ready' | 'partial' | 'unavailable';
}

export interface SocialContentArtifact {
  artifactId: string;
  taskId: string;
  kind: string;
  platform: string | null;
  language: string | null;
  version: string;
  status: SocialArtifactStatus;
  origin: 'agent' | 'manual';
  resourceRef: string | null;
  content: Record<string, unknown> | null;
  parentArtifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialDeliveryPackage {
  packageId: string;
  taskId: string;
  version: string;
  status: 'preparing' | 'ready' | 'confirmed' | 'superseded';
  artifactIds: string[];
  packageHash: string;
  downloadHref: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialPublicationRecord {
  publicationId: string;
  taskId: string;
  packageId: string;
  platform: string;
  accountLabel: string | null;
  publicUrl: string | null;
  platformPostId: string | null;
  publishedAt: string;
  notes: string | null;
  status: 'registered';
  createdAt: string;
  updatedAt: string;
}

export interface SocialMetricSubmission {
  submissionId: string;
  taskId: string;
  publicationId: string;
  method: 'link' | 'platform_id' | 'table' | 'screenshot' | 'manual' | 'connected_account';
  capturedAt: string;
  metrics: Record<string, number | null>;
  evidenceRefs: string[];
  notes: string | null;
  status: 'received' | 'needs_confirmation' | 'confirmed';
  version: string;
  createdAt: string;
}

export interface SocialContentTaskDetail extends SocialContentTaskSummary {
  /** Read-only exact-window revision identity; does not admit a worker. */
  footageRevisionPlanHash?: string;
  /** Read-only prepared fallback candidate. Never an execution authorization. */
  preparedProductAssetRevisionCandidate?: {
    plan: SocialAssetSupplyPlan;
    preparedVersion: string;
    revisedPlanHash: string;
    budgetLedgerRef: string;
    authorizesStart: false;
  };
  /** Exact product row bound to a verified Enterprise Center fact revision. */
  enterpriseProductBinding?: {
    productId: string;
    productName: string;
    productSku: string | null;
    enterpriseFactRef: string;
    enterpriseFactId: string;
    enterpriseFactRevision: number;
    enterpriseFactContentHash: string;
    confirmedAt: string;
  };
  /** Server-owned read projection; absent or missing evidence stays unverified. */
  socialMvpHandoff?: SocialMvpHandoffRead;
  referencePreparation?: { status: 'pending' | 'review_required' | 'blocked'; reason: string | null };
  /** Read-only recovery checkpoints; no grant secrets or private binding data. */
  managedExecution?: {
    reference?: { status: string; attempts: number; nextAttemptAt: string | null; reason: string | null };
    publishing?: { status: string; attempts: number; nextAttemptAt: string | null; reason: string | null; retryExhausted: boolean };
  };
  sources: SocialTaskSource[];
  artifacts: SocialContentArtifact[];
  deliveryPackages: SocialDeliveryPackage[];
  publications: SocialPublicationRecord[];
  metricSubmissions: SocialMetricSubmission[];
  materialRequirements?: SocialMaterialRequirement[];
  referenceVideoAnalysis?: SocialReferenceVideoAnalysis | null;
  replicationScript?: SocialReplicationScriptVersion | null;
  /** Unified viral-replication truth; absent on material-processing/historic tasks. */
  replicationJob?: SocialReplicationJob | null;
  shotMaterialMap?: SocialShotMaterialMapEntry[];
  /** Unified Business → Director → Content Agent projection. */
  agentWorkflow?: SocialContentAgentWorkflow;
  /** Customer-facing live production projection. Internal task keys and graph data stay server-side. */
  productionProgress?: {
    step: string;
    activity: string;
    estimatedRemainingSeconds: number | null;
    waitingForScheduledAssets?: boolean;
    updatedAt: string;
  } | null;
  /**
   * Canonical, provider-neutral production projection. Optional only for
   * historic servers during rolling upgrades; clients must not reconstruct it
   * from localStorage or provider-specific payloads.
   */
  production?: ProductionReadModelV1;
}

export interface SocialWeeklyPlanItemInput {
  title: string;
  objective: string;
  themeId?: SocialContentThemeId | null;
  customTopic?: string | null;
  topic?: string | null;
}

export interface CreateSocialWeeklyPlanInput {
  title: string;
  objective: string;
  productId?: string | null;
  productRef?: string | null;
  audience?: string | null;
  items: SocialWeeklyPlanItemInput[];
}

export interface SocialWeeklyPlan {
  weeklyPlanId: string;
  title: string;
  objective: string;
  productId?: string | null;
  productRef: string | null;
  audience: string | null;
  taskIds: string[];
  status: 'draft' | 'active' | 'completed';
  version: string;
  createdAt: string;
  updatedAt: string;
}

export interface SocialContentTaskPage {
  items: SocialContentTaskSummary[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export type SocialContentTaskListMeta = Omit<SocialContentTaskPage, 'items'>;

export interface SocialContentWorkspace {
  catalog: SocialWorkPackageCard[];
  tasks: SocialContentTaskSummary[];
  taskList: SocialContentTaskListMeta;
  currentTask: SocialContentTaskDetail | null;
  weeklyPlans?: SocialWeeklyPlan[];
  themes?: SocialContentThemeCard[];
}

export interface CreateSocialContentTaskInput {
  title: string;
  objective: string;
  productId?: string | null;
  productRef?: string | null;
  requestedPresenterName?: string | null;
  requestedPresenterAssetId?: string | null;
  presenterAssetId?: string | null;
  audience?: string | null;
  markets?: string[];
  languages?: string[];
  platforms?: string[];
  formats?: string[];
  aspectRatio?: string | null;
  cadence?: string | null;
  requestedOutputCount?: number | null;
  weeklyBudgetCny?: number | null;
  perItemBudgetCny?: number | null;
  /** Intended finished-film duration, independent of the reference video's runtime. */
  targetDurationSeconds?: number | null;
  retryReserveCny?: number | null;
  planningMode?: 'fixed' | 'auto_adjust';
  shootingWindowMinutes?: number | null;
  specialRequirements?: string | null;
  dueAt?: string | null;
  brandNotes?: string | null;
  restrictions?: string[];
  callToAction?: string | null;
  programRef?: SocialVersionedObjectRef | null;
  targetAccountRef?: SocialVersionedObjectRef | null;
  accountPlaybookRef?: SocialAccountPlaybookRef | null;
  referenceMode?: SocialReplicationReferenceMode;
  primaryExperimentVariable?: string | null;
  creationMode?: SocialContentCreationMode;
  assetAvailability?: SocialAssetAvailability;
  managementMode?: SocialContentManagementMode;
  productionMode?: SocialContentProductionMode;
  productionApproach?: SocialProductionApproach;
  mode?: SocialContentTaskMode;
  materialRoutingPolicyVersion?: 'type-aware.v1' | 'type-aware.v2';
  referenceReuse?: SocialReferenceReuseBinding;
  weeklyPlanId?: string | null;
  themeId?: SocialContentThemeId | null;
  customTopic?: string | null;
  topic?: string | null;
  /** Compatibility marker for historic material/clone/product entry routes. */
  legacyCreationRoute?: 'material' | 'clone' | 'product' | null;
}

export interface UpdateSocialContentTaskInput {
  expectedVersion: string;
  changes: Partial<CreateSocialContentTaskInput>;
}

export interface AddSocialTaskSourceInput {
  kind: SocialSourceKind;
  sourceRef: string;
  /** Select an existing tenant-owned analysis; hashes are derived by the server. */
  cachedReferenceRecordId?: string;
  sourceVersion?: string | null;
  label: string;
  purpose?: string | null;
}

export interface SelectSocialWorkPackagesInput {
  expectedVersion: string;
  selections: Array<Pick<SocialWorkPackageSelection, 'kind' | 'packageKey' | 'version'>>;
}

export interface CreateSocialArtifactInput {
  kind: string;
  platform?: string | null;
  language?: string | null;
  origin: 'agent' | 'manual';
  resourceRef?: string | null;
  content?: Record<string, unknown> | null;
  parentArtifactId?: string | null;
}

export interface DecideSocialArtifactInput {
  expectedVersion: string;
  decision: 'approved' | 'changes_requested';
  note?: string | null;
}

export interface DecideSocialArtifactBatchInput {
  artifacts: Array<{ artifactId: string; expectedVersion: string }>;
  decision: 'approved' | 'changes_requested';
  note?: string | null;
}

export interface CreateSocialDeliveryPackageInput {
  expectedTaskVersion: string;
  artifactIds: string[];
}

export interface RegisterSocialPublicationInput {
  expectedTaskVersion: string;
  packageId: string;
  platform: string;
  accountLabel?: string | null;
  publicUrl?: string | null;
  platformPostId?: string | null;
  publishedAt: string;
  notes?: string | null;
}

export interface SubmitSocialMetricsInput {
  method: SocialMetricSubmission['method'];
  capturedAt: string;
  metrics: Record<string, number | null>;
  evidenceRefs?: string[];
  notes?: string | null;
}
