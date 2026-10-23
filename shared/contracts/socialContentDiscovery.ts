import {
  type SocialBenchmarkAccountType,
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
} from './socialContentWorkflow.js';

export type SocialCompanyRole = 'factory' | 'brand' | 'importer' | 'distributor' | 'retailer';
export type SocialAudienceRole = 'brand_buyer' | 'importer' | 'distributor' | 'retailer' | 'consumer';
export type SocialSearchIntent = 'learn' | 'compare' | 'buy' | 'use';
export type SocialKeywordEvidenceSource = 'product' | 'website' | 'inquiry' | 'competitor' | 'user' | 'content' | 'comment';
export type SocialDiscoveryMode = 'momentum' | 'account' | 'innovation';
export type SocialDiscoveryPath = 'keyword' | 'account' | 'relation' | 'performance' | 'innovation';
export type SocialInspirationReadiness = 'discovery_reference' | 'strategy_reference' | 'production_reference';
export type SocialAccountTrackingStatus = 'candidate' | 'trial' | 'tracked' | 'watching' | 'stopped';
export type SocialCrawlKeywordCategory = 'discovery_seed' | 'scene_cluster' | 'evidence_query' | 'competitor_account' | 'task_override';
export type SocialCollectionScopeMode = 'industry_matrix' | 'market_focus';
export type SocialBusinessModel = 'b2b' | 'd2c' | 'mixed' | 'unknown';
export type SocialDiscoveryScoreDecision = 'accepted' | 'review' | 'rejected';

export interface SocialDiscoveryCandidateScore {
  ruleVersion: 'discovery-score-v1';
  overall: number;
  dimensions: {
    relevance: number;
    transferability: number;
    momentum: number;
    evidence: number;
    platformPriority: number;
    businessModelFit: number;
  };
  decision: SocialDiscoveryScoreDecision;
  reasons: string[];
  blockers: string[];
  scoredAt: string;
}

export interface SocialKeywordScope {
  productRef: string;
  market: string;
  language: string;
  companyRole: SocialCompanyRole;
  audienceRole: SocialAudienceRole;
  verifiedCompetitors: Array<{ type: 'brand' | 'domain' | 'account'; value: string }>;
}

export interface SocialDiscoverySeed {
  seedId: string;
  label: string;
  queryVariants: string[];
  evidence: SocialKeywordEvidenceSource[];
  enabled: boolean;
}

export interface SocialSceneCluster {
  sceneId: string;
  label: string;
  productTask: string;
  demandDimension: 'audience' | 'scene' | 'problem' | 'desired_result' | 'decision_concern' | 'mechanism' | 'proof';
  queryVariants: string[];
  evidence: SocialKeywordEvidenceSource[];
  status: 'suggested' | 'approved' | 'rejected' | 'watching';
}

export interface SocialContentSearchUnit {
  unitId: string;
  groupLabel: string;
  productEntity: string;
  buyerQuestion: string;
  observableEvidence: string;
  contentPattern?: 'test' | 'process' | 'comparison' | 'tutorial' | 'case' | 'demo';
  intent: SocialSearchIntent;
  queryVariants: string[];
  evidence: SocialKeywordEvidenceSource[];
  status: 'suggested' | 'approved' | 'rejected';
}

export interface SocialKeywordRelation {
  relationId: string;
  fromId: string;
  toId: string;
  evidenceRefs: string[];
  occurrenceCount: number;
  confidence: number;
}

export interface SocialKeywordGraph {
  discoverySeeds: SocialDiscoverySeed[];
  sceneClusters: SocialSceneCluster[];
  evidenceQueries: SocialContentSearchUnit[];
  edges: SocialKeywordRelation[];
}

export interface SocialMarketKeywordSet {
  keywordSetId: string;
  version: number;
  name: string;
  scope: SocialKeywordScope;
  graph: SocialKeywordGraph;
  status: 'draft' | 'active' | 'retired';
  createdBy: 'director_agent' | 'user';
  createdAt: string;
}

export interface SocialDiscoveryBrief {
  discoveryBriefId: string;
  keywordSetId: string;
  keywordSetVersion: number;
  productRef: string;
  market: string;
  audience: string;
  discoverySeedIds: string[];
  trackedSceneIds: string[];
  competitorAccounts: string[];
  discoveryModes: SocialDiscoveryMode[];
  platforms: string[];
  lookbackDays: number;
  resultLimit: number;
  budgetLimitCny: number | null;
  productionGap: string | null;
  createdBy: 'director_agent' | 'user';
  /** Per-channel execution policy. No product ratio is implied when omitted. */
  modePolicies?: Partial<Record<SocialDiscoveryMode, SocialDiscoveryModePolicy>>;
  /** Explicit, approved weekly source revision; ordinary account minimum remains one. */
  weeklyAccountCollectionTarget?: { accountUrl: string; targetCount: number };
}

export interface SocialDiscoveryModePolicy {
  enabled: boolean;
  sourceRefs: string[];
  platforms: string[];
  resultLimit: number;
  refreshIntervalMinutes: number;
  budgetLimitCny: number | null;
}

export type SocialCollectionRunStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'stopped';
export type SocialCollectionStopReason = 'completed' | 'duplicate_limit' | 'no_valid_results' | 'budget_limited' | 'source_failed' | 'daily_collection_limit_reached' | 'manual';

export interface SocialDiscoveryModeRunStats {
  requested: number;
  fetched: number;
  deduplicated: number;
  /** Optional cost-funnel details; old run snapshots remain readable. */
  exactDuplicates?: number;
  nearDuplicates?: number;
  nearDuplicateUnchecked?: number;
  analyzed?: number;
  accepted: number;
  momentumCandidates: number;
  failed: number;
  costCny: number | null;
  effectiveRate: number | null;
}

export interface SocialInspirationCollectionRun {
  runId: string;
  planId: string;
  keywordSetId: string;
  keywordSetVersion: number;
  discoveryScopeId: string;
  discoveryScopeVersion: number;
  status: SocialCollectionRunStatus;
  triggerType: 'scheduled' | 'manual' | 'production_gap';
  scopeSnapshot: SocialDiscoveryBrief;
  modeStats: Partial<Record<SocialDiscoveryMode, SocialDiscoveryModeRunStats>>;
  platformStats?: Record<string, SocialDiscoveryModeRunStats>;
  keywordTierStats?: Partial<Record<'broad' | 'medium' | 'evidence' | 'account' | 'unknown', SocialDiscoveryModeRunStats>>;
  /** Qualified worker outcomes. Imported crawler rows are never authority. */
  evidenceOutcomes?: Partial<Record<SocialDiscoveryMode, {
    acceptedCandidateIds: string[];
    acceptedEvidenceRefs: string[];
    suggestionCandidateIds: string[];
    failedCandidateIds: string[];
  }>>;
  sourceRunRefs: string[];
  failureDetails?: Array<{ mode: SocialDiscoveryMode; platform: string; queryRef: string; error: string; errorCode?: 'model_unavailable' | 'provider_budget_exhausted' | 'provider_authorization_required' | 'downloader_missing' | 'source_media_unavailable' | 'source_rate_limited' | 'source_failed' }>;
  queryBasis: Partial<Record<SocialDiscoveryMode, string[]>>;
  market: string;
  language: string;
  stopReason: SocialCollectionStopReason | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface SocialProductionGapRequirement {
  description: string;
  requiredSceneIds: string[];
  minimumReferences: number;
  requiredReadiness: SocialInspirationReadiness;
  requestedModes: SocialDiscoveryMode[];
}

export interface SocialProductionGapBudget {
  currency: 'CNY';
  limitCny: number;
  spentCny: number;
}

/** Durable T4 request. The originating weekly task remains the return address. */
export interface SocialProductionGapTask {
  gapTaskId: string;
  tenantId: string;
  upstreamTaskRef: string;
  taskGap: SocialProductionGapRequirement;
  budget: SocialProductionGapBudget;
  status: 'collecting' | 'ready_to_resume' | 'resumed' | 'blocked';
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  runRefs: string[];
  selectedEvidenceRefs: string[];
  referenceSelectionRef: { selectionId: string; version: number } | null;
  stopReason: 'inventory_covered' | 'evidence_satisfied' | 'budget_exhausted' | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialDiscoverySummary {
  keywordSetId: string;
  keywordSetVersion: number;
  runCount: number;
  latestRunAt: string | null;
  nextRunAt: string | null;
  totals: SocialDiscoveryModeRunStats;
  byMode: Partial<Record<SocialDiscoveryMode, SocialDiscoveryModeRunStats>>;
  coverageGaps: SocialDiscoveryMode[];
  totalKnownCostCny: number;
  costComplete: boolean;
  accountDecisionsPendingBusinessConfirmation: number;
}

export interface SocialCandidateEvidence {
  inspirationId: string;
  discoveryPath: SocialDiscoveryPath[];
  sceneIds: string[];
  relevance: { level: 'high' | 'medium' | 'low'; reasons: string[] };
  momentum: { level: 'rising' | 'high_performance' | 'unknown'; reasons: string[]; confidence: number };
  novelty?: { level: 'high' | 'medium' | 'low'; reasons: string[]; confidence: number };
  transferability: { level: 'high' | 'medium' | 'low'; mechanisms: string[]; limitations: string[] };
  evidenceRefs: string[];
  /** Server-owned, versioned decision. UI filters must use this value instead of recomputing a score. */
  qualityScore?: SocialDiscoveryCandidateScore;
  classification?: {
    businessModel: SocialBusinessModel;
    platform: string;
    keywordTier: 'broad' | 'medium' | 'evidence' | 'account' | 'unknown';
  };
}

export interface SocialDiscoveryReadiness {
  readyForOutline: boolean;
  readyForDetailedPlan: boolean;
  thresholds: { acceptedVideos: number; benchmarkAccounts: number; sceneClusters: number };
  actual: { acceptedVideos: number; benchmarkAccounts: number; sceneClusters: number };
  gaps: Array<{ code: 'videos' | 'accounts' | 'scenes' | 'scope'; label: string; missing: number }>;
  evaluatedAt: string;
}

export interface SocialDiscoverySupplyItem {
  candidateId: string;
  candidateType: 'video' | 'account';
  platform: string;
  title: string;
  author: string;
  sourceUrl: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  sceneIds: string[];
  businessModel: SocialBusinessModel;
  score: SocialDiscoveryCandidateScore;
  evidenceRef: string;
  evidenceVersion: number;
  raw?: Record<string, unknown>;
}

export interface SocialInspirationHandoff {
  /** Stable independent aggregate id; absent only on records written before Gap-V1 T5. */
  handoffId?: string;
  /** Independent immutable version; absent only on historic embedded records. */
  version?: string;
  inspirationId: string;
  analysisId: string;
  analysisVersion: string;
  readiness: SocialInspirationReadiness;
  source: { platform: string; sourceUrl: string; author?: string; publishedAt?: string };
  taskContext: { taskId?: string; productRef?: string; market?: string; audience?: string; userNote?: string };
  whySelected: string[];
  referenceRole: 'primary_structure' | 'proof_reference' | 'visual_rhythm' | 'cta_reference';
  reusableLogic: { hookTypes: string[]; revealOrder: string[]; proofPlacement: string[]; pacing: string; emotionalProgression: string; ctaPosition: string };
  adaptationBoundary: { reusable: string[]; mustReplace: string[]; prohibited: string[] };
  productionImplications: { requiredEvidence: string[]; likelyAssetNeeds: string[]; difficulty?: 'low' | 'medium' | 'high'; risks: string[] };
  evidenceRefs: Array<{ startTime?: number; endTime?: number; description: string; confidence: number; needsReview: boolean }>;
  rights: { mayAnalyze: boolean; mayUseOriginalMedia: boolean; mayAdapt: boolean; note?: string };
}

export interface SocialAccountTrackingDecision {
  accountId: string;
  decision: 'trial' | 'track' | 'watch' | 'stop';
  status: SocialAccountTrackingStatus;
  accountRole: SocialBenchmarkAccountType;
  reasons: string[];
  evidenceVideoIds: string[];
  relatedSceneIds: string[];
  missingEvidence: string[];
  nextReviewAt?: string;
  recommendedCadence?: string;
  confidence: number;
  recommendedBy?: 'director_agent' | 'user';
  businessConfirmation?: {
    status: 'pending' | 'confirmed' | 'rejected';
    confirmedBy: 'business_agent' | null;
    decisionRef: string | null;
    reason: string | null;
    confirmedAt: string | null;
  };
}

export interface SocialCrawlStrategy {
  keywordRecommendation?: import('../productDiscovery').ProductKeywordRecommendation;
  crawlStrategyId: string;
  version: string;
  businessGoal: string;
  keywordSet: SocialMarketKeywordSet;
  discoveryBrief: SocialDiscoveryBrief;
  /** Compiled execution view kept for existing scheduler consumers. */
  keywords: Array<{ category: SocialCrawlKeywordCategory; values: string[] }>;
  benchmarkAccounts: Array<{ accountRef: string; type: SocialBenchmarkAccountType; weight: number }>;
  platformQuotas: Array<{ platform: string; limit: number; weight: number }>;
  collectionPolicy?: {
    scopeMode: SocialCollectionScopeMode;
    industryFocus: string | null;
    marketFocus: string | null;
    keywordTierWeights: { broad: number; medium: number; evidence: number };
    platformWeights: Record<string, number>;
    primaryPlatform: 'tiktok';
    youtubePolicy: 'targeted_only';
  };
  refreshIntervalMinutes: number;
  stopConditions: string[];
  market: string | null;
  language: string | null;
  cultureTags: string[];
  seasonTags: string[];
  regionalPlatformWeights: Record<string, number>;
  createdBy: 'director_agent' | 'user';
  approval?: {
    status: 'approved' | 'pending' | 'rejected';
    approvedBy: 'business_agent' | 'user' | null;
    /** Authenticated actor identity, separate from the business-role enum. */
    approvedByUserId?: string;
    approvedAt: string | null;
    scopeVersion: number;
  };
}

export interface SocialInspirationScores {
  sourcePriority: number;
  contentOpportunityScore: number;
  relativePerformance: number | null;
  reasons: string[];
}

export interface SocialReplicationScriptShot {
  /** Authored copy/timing; not recovered reference ASR or a review decision. */
  scriptOrigin?: 'independent_revision' | 'budget_semantic_revision';
  shotId: string;
  referenceShotId: string | null;
  /** All reference factors retained by a consolidated authored scene. */
  referenceShotIds?: string[];
  startSeconds: number;
  endSeconds: number;
  purpose: SocialShotFunction;
  visualInstruction: string;
  /** Verbatim line recovered from the reference video before tenant identity substitution. */
  referenceSpokenText?: string | null;
  spokenText: string | null;
  /** Source speech cues remain approximate until synthesized narration returns
   * precise alignment. Keep both original and identity-substituted wording. */
  speechLines?: Array<{
    /** Stable identity across visual cuts. One spoken sentence can reference several shots. */
    lineId?: string;
    referenceText: string;
    draftText: string;
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    sourcePrecision: 'phrase' | 'coarse';
    sourceWords?: Array<{start: number; end: number; text: string}>;
    sourceProvenance: string;
    replacedEntityTypes: Array<'company' | 'brand' | 'product'>;
    /** Exactly one shot owns narration; every intersecting visual shot is listed. */
    narrationOwnerShotId?: string;
    visualShotIds?: string[];
  }>;
  /** New replication tasks only replace identity tokens; all other wording and timing stay frozen. */
  voiceoverReplacement?: {
    mode: 'identity_only';
    replacedEntityTypes: Array<'company' | 'brand' | 'product'>;
  };
  captionText: string | null;
  audioAndTransition: string | null;
  fidelityPoints: string[];
  mustDifferPoints: string[];
  materialPlan: SocialAssetSupplyShotPlan;
  lockedRegions: string[];
  risks: string[];
}

export interface SocialReplicationScriptVersion {
  version: string;
  referenceAnalysisId: string;
  status: 'draft' | 'review_required' | 'confirmed' | 'superseded';
  primaryHookId: string;
  hookOptions: SocialThreeSecondHook[];
  shots: SocialReplicationScriptShot[];
  /** Canonical ordered narration, deduplicated across physical visual cuts. */
  narrationLines?: NonNullable<SocialReplicationScriptShot['speechLines']>;
  /** A legacy model dialogue guess must never be mistaken for source ASR. */
  narrationSourceStatus?: 'asr_aligned' | 'missing_source_asr';
  structureFidelitySummary: string;
  originalityDifferenceSummary: string;
  createdAt: string;
  /** Present only after an authenticated advanced-workflow review command has
   * approved every shot against the exact analysis and script hashes. */
  review?: {
    schemaVersion: 'social-replication-script-review.v1';
    analysisId: string;
    analysisHash: string;
    scriptHash: string;
    sceneDecisions: Array<{shotId: string; conclusion: 'approved'; evidence: string[]}>;
    evidence: string[];
    reviewedBy: string;
    reviewedAt: string;
  };
}

export interface SocialShotMaterialMapEntry {
  shotId: string;
  customerAssetIds: string[];
  generatedAssetIds: string[];
  licensedAssetIds: string[];
  sourceStrategy: SocialShotSourceStrategy;
  truthBoundary: SocialShotTruthBoundary;
  functionalEquivalentReplacement: SocialFunctionalEquivalentReplacement;
}
