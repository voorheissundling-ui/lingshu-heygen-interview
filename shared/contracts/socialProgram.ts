import type {ContentTemplateStructureConstraint} from '../socialContentTemplateStructure.js';
export type SocialProgramRoute = 'cold_start' | 'account_repair';

export type SocialProgramStage =
  | 'needs_route'
  | 'needs_foundation'
  | 'needs_account_import'
  | 'diagnosing'
  | 'needs_benchmarks'
  | 'needs_acquisition_route'
  | 'needs_account_playbook'
  | 'needs_month_plan'
  | 'ready_for_week'
  | 'executing'
  | 'reviewing';

export type SocialPlatform = 'tiktok' | 'instagram' | 'youtube' | 'facebook' | 'linkedin' | 'douyin' | 'xiaohongshu' | 'other';

export interface VersionedSocialRef {
  type: string;
  id: string;
  version: number;
}

export interface SocialProgramReadiness {
  foundationConfirmed: boolean;
  accountImportConfirmed: boolean;
  diagnosisComplete: boolean;
  benchmarkRoundComplete: boolean;
  conversionRouteConfirmed: boolean;
  accountPlaybooksConfirmed: boolean;
  monthlyPlanActive: boolean;
  weeklyPlanActive: boolean;
  productionInProgress: boolean;
  reviewDue: boolean;
}

export interface SocialProgram {
  programId: string;
  brandName: string;
  businessLine: string | null;
  market: string;
  targetAudience: string;
  candidatePlatforms: SocialPlatform[];
  route: SocialProgramRoute | null;
  stage: SocialProgramStage;
  readiness: SocialProgramReadiness;
  enterpriseProfileRef: VersionedSocialRef | null;
  productMarketingProfileRefs: VersionedSocialRef[];
  activeMonthlyPlanRef: VersionedSocialRef | null;
  activeWeeklyPlanRef: VersionedSocialRef | null;
  activeWeeklyOperatingPackageRef: VersionedSocialRef | null;
  activeBusinessContentGoalRef?: VersionedSocialRef | null;
  version: number;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export const WEEKLY_OPERATING_WORKFLOW_KINDS = [
  'readiness',
  'discovery',
  'directing',
  'content',
  'publishing',
  'engagement',
  'review',
] as const;
export type WeeklyOperatingWorkflowKind = typeof WEEKLY_OPERATING_WORKFLOW_KINDS[number];

export const WEEKLY_OPERATING_PACKAGE_STATUSES = ['draft', 'active', 'superseded', 'retired'] as const;
export type WeeklyOperatingPackageStatus = typeof WEEKLY_OPERATING_PACKAGE_STATUSES[number];
export type WeeklyOperatingWorkflowStatus = 'planned' | 'blocked' | 'in_progress' | 'completed' | 'cancelled';

export type WeeklyWorkflowTaskStatus = WeeklyOperatingWorkflowStatus;

export const WEEKLY_EXECUTION_TASK_STATUSES = [
  'pending_activation',
  'queued',
  'leased',
  'blocked',
  'succeeded',
  'cancelled',
  'dead_letter',
] as const;
export type WeeklyExecutionTaskStatus = typeof WEEKLY_EXECUTION_TASK_STATUSES[number];
export type WeeklyExecutionTaskScope = 'package' | 'content' | 'adaptation' | 'account' | 'publication';

/** Business identity of the two B2B operating chains. Legacy persisted tasks may omit it. */
export type WeeklyAgentChainProfile = 'b2b_cold_start' | 'b2b_established';
export type WeeklyAgentChainTaskCode = `${'Z' | 'H'}-${`M${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}` | `S${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`}`;

export interface WeeklyAgentChainContract {
  /** Frozen business inputs required by this profile-specific task, in addition to inputSnapshot. */
  requiredInputKinds: string[];
  /** Auditable business outputs expected from the existing step executor. */
  deliverableKinds: string[];
}

export type WeeklyResponsibleActor =
  | 'business_agent'
  | 'director_agent'
  | 'content_agent'
  | 'quality_agent'
  | 'publishing_agent'
  | 'customer_agent'
  | 'user';

export type WeeklyProductionStepKind =
  | 'business_outline'
  | 'benchmark_collection'
  | 'benchmark_scoring'
  | 'director_analysis'
  | 'business_schedule'
  | 'material_preparation'
  | 'material_readiness'
  | 'script'
  | 'storyboard'
  | 'asset_generation'
  | 'video_generation'
  | 'quality_check'
  | 'rework'
  | 'user_approval'
  | 'publishing'
  | 'customer_channel_readiness'
  | 'customer_inquiry_handoff'
  | 'performance_monitoring'
  | 'weekly_review'
  | 'template_extraction'
  | 'template_performance_validation';

export interface WeeklyExecutionTaskSchedule {
  stepKind: WeeklyProductionStepKind;
  responsibleActor: WeeklyResponsibleActor;
  estimatedDurationMinutes: number;
  estimatedStartAt: string;
  estimatedFinishAt: string;
  latestStartAt?: string | null;
  latestFinishAt?: string | null;
  planningRisks?: string[];
  actualStartedAt: string | null;
  actualFinishedAt: string | null;
}

export interface WeeklyExecutionTaskLease {
  leaseId: string;
  token: string;
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface WeeklyExecutionTaskBudget {
  category: 'none' | 'discovery' | 'production';
  limitCny: number | null;
}

/**
 * Durable unit consumed by a worker. The snapshots and versioned references
 * deliberately make the task self-contained: a worker must never silently
 * read a newer package, policy or planning decision while executing it.
 */
export interface WeeklyExecutionTask {
  inventoryUserApproval?: {actorUserId:string;confirmedAt:string;bindingRef:VersionedSocialRef;bindingHash:string;sourceHash:string;artifactRef:VersionedSocialRef};
  taskId: string;
  tenantId: string;
  programId: string;
  packageId: string;
  packageVersion: number;
  workflowKind: WeeklyOperatingWorkflowKind;
  scope: WeeklyExecutionTaskScope;
  subjectId: string;
  accountId: string | null;
  publicationTaskId: string | null;
  /** Profile-specific business identity; stepKind remains the stable executor protocol. */
  chainProfile?: WeeklyAgentChainProfile;
  chainTaskCode?: WeeklyAgentChainTaskCode;
  /** Conditional side-chain identities this durable task owns if their trigger is observed. */
  chainSupportTaskCodes?: WeeklyAgentChainTaskCode[];
  chainContract?: WeeklyAgentChainContract;
  dependsOnTaskIds: string[];
  upstreamVersionRefs: VersionedSocialRef[];
  inputSnapshot: Record<string, unknown>;
  idempotencyKey: string;
  budget: WeeklyExecutionTaskBudget;
  schedule: WeeklyExecutionTaskSchedule;
  status: WeeklyExecutionTaskStatus;
  ownBlockingReasons: string[];
  inheritedBlockingTaskIds: string[];
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lease: WeeklyExecutionTaskLease | null;
  resultRefs: VersionedSocialRef[];
  lastError: { code: string; message: string; retryable: boolean; occurredAt: string } | null;
  /** Explicit original-request quality recovery receipts; never stage completion. */
  qualityRecoveries?: import('./weeklyContentQualityRecovery.js').WeeklyContentQualityRecoveryReceipt[];
  /** Observed upstream activity, independent from verified step completion. */
  productionProgress?: { contentTaskId: string; runId: string | null; step: string; activity: string; updatedAt: string } | null;
  /** Read-only API projection after verifying the original task's continuation receipt. */
  continuationObservation?: { status: 'ready' | 'pending' | 'blocked'; sourceVersion?: number; sourceTaskId?: string; contentTaskId?: string; sourceActualFinishedAt?: string | null; sourceLatestFinishAt?: string | null; code?: string };
  /** Stored deadline evaluation reference; never completion or authorization. */
  deadlineRecovery?: { assessmentId: string; assessedAt: string; status: 'evaluated' | 'blocked'; blockingReasons: string[]; affectedPublicationIds: string[] };
  recoveredFromDeadLetterAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyOperatingScheduleSlot {
  referenceSource?: 'owned' | 'external';
  slotId: string;
  motherContentId: string;
  publicationTaskIds: string[];
  accountIds: string[];
  platforms: SocialWeeklyPublicationTask['platform'][];
  plannedPublishWindows: string[];
  objective: string;
  quantity: number;
}

export interface WeeklyOperatingScheduleSkeleton {
  skeletonId: string;
  packageId: string;
  packageVersion: number;
  generatedBy: 'business_agent';
  tokenCost: 0;
  slots: WeeklyOperatingScheduleSlot[];
  createdAt: string;
}

export interface WeeklyMaterialEvidenceConfiguration {
  schemaVersion: 'weekly-material-evidence-configuration.v1';
  configurationId: string; version: number;
  tenantId: string; programId: string;
  scope: { packageId: string; packageVersion: number; slotId: string };
  handoffRef: { inspirationId: string; version: string; recordHash: string };
  decisions: Array<{ requirementId: string; classification: 'human_irreplaceable'; reason: string; shotUsage: string }>;
  configuredBy: string; configuredAt: string; recordHash: string;
}

export interface WeeklyMaterialEvidenceRequirements {
  schemaVersion: 'weekly-material-evidence.v1';
  configurationRef?: { id: string; version: number; recordHash: string };
  scope: { packageId: string; packageVersion: number; slotId: string };
  handoffRef: { inspirationId: string; version: string; recordHash: string } | null;
  source: { requiredEvidence: string[]; likelyAssetNeeds: string[]; adaptationBoundary: { reusable: string[]; mustReplace: string[]; prohibited: string[] } } | null;
  items: Array<{ requirementId: string; sourceField: 'requiredEvidence' | 'likelyAssetNeeds' | 'missing_handoff'; sourceIndex: number; description: string; classification: 'human_irreplaceable' | 'generatable_non_evidentiary' | 'unknown'; reason: string }>;
  recordHash: string;
}

/** Actual account and immutable playbook versions explicitly frozen during planning. */
export interface WeeklyTargetAccountPlaybook {
  accountId: string;
  accountRef: VersionedSocialRef;
  playbookRef: VersionedSocialRef;
  playbookHash: string;
}

export interface WeeklyDirectorPlanningAnalysis {
  targetAccountPlaybooks?: WeeklyTargetAccountPlaybook[];
  contentTemplateEvidence?: Array<{publicationTaskId:string;bindingRef:VersionedSocialRef;structure:ContentTemplateStructureConstraint}>;
  customerFeedbackTopicRefs?: VersionedSocialRef[];
  customerFeedbackTopicEvidence?: Array<{ publicationTaskId: string; confirmationRef: VersionedSocialRef; candidateRef: { id: string; version: number; recordHash: string }; question: string; topicAngle: string }>;
  ownedReferenceDiagnosis?: {
    policy: WeeklyReferenceSourcePolicy;
    performanceStatus: 'complete' | 'partial' | 'unavailable';
    observedMetrics: { views: number | null; likes: number | null; shares: number | null; comments: number | null };
    performanceSnapshot: { ref: VersionedSocialRef; capturedAt: string; source: string } | null;
    missingMetrics: Array<'views' | 'likes' | 'shares' | 'comments'>;
    interactionRate: number | null;
    acquisitionConclusion: 'not_measured';
    toneStatus: 'verified' | 'pending';
    tone: { hookTypes: string[]; revealOrder: string[]; proofPlacement: string[]; pacing: string; emotionalProgression: string; ctaPosition: string } | null;
    handoffRef: { inspirationId: string; version: string; recordHash: string } | null;
    checkedAt: string;
    evidenceHash: string;
  };
  frozenHandoffRefs?: Array<{ inspirationId: string; version: string; recordHash: string }>;
  historicalPerformance?: {
    snapshotRef: VersionedSocialRef;
    capturedAt: string;
    source: string;
    metrics: { views: number | null; likes: number | null; shares: number | null; comments: number | null };
  } | null;
  analysisId: string;
  slotId: string;
  packageId: string;
  packageVersion: number;
  analyzedBy: 'director_agent';
  benchmarkAccountRefs: VersionedSocialRef[];
  benchmarkVideoRefs: VersionedSocialRef[];
  benchmarkEvidenceRefs: string[];
  contentDirection: string;
  styleRules: string[];
  updateRhythm: string;
  materialRequirements: string[];
  materialEvidenceRequirements?: WeeklyMaterialEvidenceRequirements;
  estimatedProductionMinutes: number;
  createdAt: string;
}

export interface WeeklyDetailedContentScheduleItem {
  targetAccountPlaybook?: WeeklyTargetAccountPlaybook;
  contentTemplateStructure?: ContentTemplateStructureConstraint;
  scheduleItemId: string;
  slotId: string;
  publicationTaskId: string;
  accountId: string;
  platform: SocialWeeklyPublicationTask['platform'];
  topic: string;
  directorAnalysisRef: VersionedSocialRef;
  benchmarkAccountRefs: VersionedSocialRef[];
  benchmarkVideoRefs: VersionedSocialRef[];
  materialRequirements: string[];
  materialEvidenceRequirements?: WeeklyMaterialEvidenceRequirements;
  materialPlan: {
    canStartWithExistingAssets: boolean;
    fallback: 'premium_aigc';
    optionalShootTaskIds: string[];
    note: string;
  };
  publishWindow: string;
  qualityTier: 'premium';
  estimatedProductionMinutes: number;
}

export interface WeeklyPlanningCoverage {
  selectedSlotIds: string[];
  pendingSlotIds: string[];
  referenceSourcePolicy: WeeklyReferenceSourcePolicy | null;
}

export interface WeeklyBusinessContentDispatch {
  coverage?: WeeklyPlanningCoverage;
  dispatchId: string;
  packageId: string;
  packageVersion: number;
  issuedBy: 'business_agent';
  assignedTo: 'content_agent';
  detailedScheduleRef: VersionedSocialRef;
  scheduleItemIds: string[];
  scheduleItems: WeeklyDetailedContentScheduleItem[];
  issuedAt: string;
}

/** Both identities are required for planning mutations; neither version substitutes for the other. */
export interface WeeklyAgentPlanningMutation {
  expectedPackageVersion: number;
  expectedPlanningVersion: number;
  selectedSlotIds?: string[];
}

export interface WeeklyAgentPlanningState {
  /** A user-selected reference, frozen only after current-run admission and exact media/handoff verification. */
  pinnedReference?: {
    schema: 'weekly-pinned-reference.v1';
    slotId: string;
    candidateId: string;
    evidenceVersion: number;
    accountCandidateId: string;
    accountEvidenceVersion: number;
    accountSourceUrl: string;
    mediaSha256: string;
    handoffRecordHash: string;
    sourceUrl: string;
    selectedBy: string;
    selectedAt: string;
    discoveryAuthority: { rootJobId: string; currentJobId: string; runId: string };
    recordHash: string;
  };
  automaticTemplateAdoption?: {source:'automatic_template';templateVersion:'weekly-automation.v3';adoptedAt:string;actorUserId:string;userApproval:null;selectedSlotIds:string[];analysisEvidenceHash:string;detailedScheduleHash:string;recordHash:string;authorizesPublishing:false;authorizesContentAcceptance:false;authorizesCustomerMessages:false};
  referenceSourcePolicy?: WeeklyReferenceSourcePolicy | null;
  planningId: string;
  version: number;
  programId: string;
  packageId: string;
  packageVersion: number;
  status: 'outline_ready' | 'director_analyzing' | 'awaiting_confirmation' | 'confirmed' | 'dispatched';
  skeleton: WeeklyOperatingScheduleSkeleton;
  directorAnalyses: WeeklyDirectorPlanningAnalysis[];
  directorGaps?: Array<{ slotId: string; referenceSource: 'owned' | 'external' | 'unknown'; code: string; message: string; observedAt: string }>;
  detailedSchedule: { ref: VersionedSocialRef; mergedBy: 'business_agent'; items: WeeklyDetailedContentScheduleItem[]; createdAt: string; coverage?: WeeklyPlanningCoverage } | null;
  userConfirmation: { confirmedBy: string; confirmedAt: string; selectedSlotIds?: string[] } | null;
  dispatch: WeeklyBusinessContentDispatch | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyExecutionStatusSummary {
  total: number;
  byStatus: Record<WeeklyExecutionTaskStatus, number>;
  byWorkflow: Record<WeeklyOperatingWorkflowKind, WeeklyOperatingWorkflowStatus>;
  refreshedAt: string;
}

export interface WeeklyWorkflowTask {
  taskId: string;
  kind: WeeklyOperatingWorkflowKind;
  taskRef: VersionedSocialRef;
  dependsOnTaskIds: string[];
  subjectRefs: VersionedSocialRef[];
  status: WeeklyWorkflowTaskStatus;
  ownBlockingReasons: string[];
  inheritedBlockingTaskIds: string[];
  carriedFromTaskId: string | null;
}

export interface WeeklyWorkflowEvent {
  eventId: string;
  taskId: string;
  type: 'start' | 'complete' | 'block' | 'unblock' | 'cancel';
  reason?: string | null;
  occurredAt: string;
}

export interface WeeklyTaskVersionMapping {
  previousTaskId: string;
  nextTaskId: string | null;
  handling: 'carried' | 'replaced' | 'cancelled';
}

export interface WeeklyOperatingWorkflow {
  kind: WeeklyOperatingWorkflowKind;
  status: WeeklyOperatingWorkflowStatus;
  taskRefs: VersionedSocialRef[];
  blockingReasons: string[];
}

export interface SocialWeeklyPublicationTask {
  publicationTaskId: string;
  motherContentId: string;
  adaptationOfPublicationTaskId: string | null;
  platform: Extract<SocialPlatform, 'tiktok' | 'facebook' | 'instagram' | 'youtube' | 'linkedin'>;
  accountId: string;
  accountPositioning: string | null;
  businessProposition: string | null;
  cta: string | null;
  /** Explicit frozen reception contract; historical packages may lack this field. */
  receptionRequirement?: { required: true; bindingId: string | null };
  /** Required human inputs are frozen by request identity and reverified at production admission. */
  customerFeedbackTopicRef?: VersionedSocialRef;
  /** Explicit confirmed structure binding for this exact immutable publication version. */
  contentTemplateBindingRef?: VersionedSocialRef;
  inventoryReuseRef?: VersionedSocialRef;
  materialRequirement?: { required: true; requestIds: string[]; bindings?: Array<{ requirementId: string; requestId: string }> };
  factRefs: VersionedSocialRef[];
  metricTargets: string[];
  publishWindow: string | null;
  status: 'planned' | 'blocked' | 'ready' | 'published' | 'cancelled';
}

export interface SocialWeeklyContentPackage {
  /** New immutable packages share original production; legacy packages retain per-publication runs. */
  productionIdentityVersion?: 'shared-original.v1';
  contentPackageId: string;
  operatingPackageId: string;
  version: number;
  status: WeeklyOperatingPackageStatus;
  originalContentTarget: number;
  adaptationVersionTarget: number;
  publicationTaskTarget: number;
  publicationTasks: SocialWeeklyPublicationTask[];
  weeklyBudgetCny: number | null;
  perItemBudgetCny: number | null;
  capacityNotes: string[];
  authorization: {
    mode: 'each' | 'bounded';
    accountIds: string[];
    maxPublishItems: number;
    weekStart: string;
    weekEnd: string;
    allowRealPublishing: boolean;
    authorizedBy: string | null;
    authorizedAt: string | null;
    revokedBy: string | null;
    revokedAt: string | null;
  };
}

export interface WeeklyReferenceSourcePolicy {
  profile: 'b2b_cold_start' | 'b2b_established';
  ownedPercent: number;
  externalPercent: number;
  allocationUnit: 'mother_content';
}

export interface WeeklyOperatingPackage {
  /** Missing means the immutable legacy graph; new drafts explicitly use v2. */
  executionGraphVersion?: 2 | 3;
  /** Server-written evidence of an explicitly confirmed upgrade consumed by a new week. */
  profileUpgradeConsumption?: {
    schemaVersion:'weekly-profile-upgrade-consumption.v1';
    upgradeId:string;sourcePackageId:string;sourcePackageVersion:number;
    confirmationHash:string;evidenceHash:string;confirmedBy:string;confirmedAt:string;
    creationRequestId:string;creationInputHash:string;createdBy:string;createdAt:string;
    targetPackageId:string;targetPackageVersion:1;targetWeekStart:string;timeZone:string;
    publicationTaskIds:string[];publicationInputHash:string;targetInputHash:string;recordHash:string;
  };
  referenceSourcePolicy?: WeeklyReferenceSourcePolicy | null;
  packageId: string;
  programId: string;
  version: number;
  status: WeeklyOperatingPackageStatus;
  weekStart: string;
  weekEnd: string;
  objective: string;
  enterpriseProfileRef: VersionedSocialRef | null;
  businessContentGoalRef?: VersionedSocialRef | null;
  monthlyPlanRef: VersionedSocialRef | null;
  workflows: WeeklyOperatingWorkflow[];
  workflowTasks: WeeklyWorkflowTask[];
  /** Present on R3-aware reads; optional while older R1 consumers migrate. */
  executionTaskRefs?: VersionedSocialRef[];
  executionSummary?: WeeklyExecutionStatusSummary;
  /** Read projection from the independent append-only Agent planning stream. */
  agentPlanning?: WeeklyAgentPlanningState;
  appliedWorkflowEvents: WeeklyWorkflowEvent[];
  /** Independent append-only workflow stream version; absent only on legacy rows. */
  workflowStateVersion?: number;
  taskVersionMappings: WeeklyTaskVersionMapping[];
  planningBlockers: string[];
  capacityPlanRef: VersionedSocialRef | null;
  automationPolicyRef: VersionedSocialRef | null;
  operatingDecisionSnapshotRef?: VersionedSocialRef | null;
  referenceModeRef?: VersionedSocialRef | null;
  /** R6 output consumed as an explicit, versioned input to this plan. */
  promotionQuotaRef?: VersionedSocialRef | null;
  discoveryBudgetCny: number | null;
  socialContentPackage: SocialWeeklyContentPackage;
  successCriteria: string[];
  changeReason: string | null;
  previousVersion: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversionRoute {
  routeId: string;
  entryType: 'profile_link' | 'comment' | 'direct_message' | 'store' | 'form' | 'whatsapp' | 'other';
  entryRef: string | null;
  callToAction: string;
  qualificationFields: string[];
  handoffTarget: string | null;
  verifiedAt: string | null;
}

export interface OwnedSocialAccount {
  accountId: string;
  programId: string;
  platform: SocialPlatform;
  displayName: string;
  handle: string | null;
  businessRole: string;
  audiencePromise: string;
  contentPromise: string;
  status: 'planned' | 'active' | 'paused' | 'retired';
  connectionId: string | null;
  connectionCapabilities: string[];
  playbookRef: VersionedSocialRef | null;
  conversionRoute: ConversionRoute | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AccountPlaybook {
  playbookId: string;
  programId: string;
  accountId: string;
  version: number;
  audience: string[];
  pillars: string[];
  recurringFormats: string[];
  presenterRules: string[];
  visualRules: string[];
  evidenceRules: string[];
  languageRules: string[];
  fixedFactors: string[];
  experimentFactors: string[];
  conversionRoute: ConversionRoute;
  sourceRefs: VersionedSocialRef[];
  status: 'draft' | 'active' | 'retired';
  createdAt: string;
}

export interface SocialMonthlyPlan {
  planId: string;
  programId: string;
  version: number;
  month: string;
  objective: string;
  accountIds: string[];
  priorityProductRefs: VersionedSocialRef[];
  audiencePriorities: string[];
  contentMix: Array<{ format: string; count: number }>;
  experimentVariables: string[];
  budgetLimitCny: number | null;
  successCriteria: string[];
  sourceRefs: VersionedSocialRef[];
  status: 'draft' | 'active' | 'retired';
  createdAt: string;
}

export interface WeeklyContentItem {
  itemId: string;
  accountId: string;
  title: string;
  contentTask: string;
  cta: string;
  productMarketingProfileRef: VersionedSocialRef;
  referenceRefs: VersionedSocialRef[];
  factRefs: VersionedSocialRef[];
  dueAt: string | null;
  approvalPolicy: 'user_confirm' | 'owner_approve';
}

export interface SocialWeeklyPlan {
  planId: string;
  programId: string;
  monthlyPlanRef: VersionedSocialRef;
  version: number;
  weekStart: string;
  items: WeeklyContentItem[];
  budgetLimitCny: number | null;
  status: 'draft' | 'active' | 'retired';
  createdAt: string;
}

export interface SocialProgramActivationIssue {
  code: string;
  message: string;
}

export const EMPTY_SOCIAL_PROGRAM_READINESS: SocialProgramReadiness = {
  foundationConfirmed: false,
  accountImportConfirmed: false,
  diagnosisComplete: false,
  benchmarkRoundComplete: false,
  conversionRouteConfirmed: false,
  accountPlaybooksConfirmed: false,
  monthlyPlanActive: false,
  weeklyPlanActive: false,
  productionInProgress: false,
  reviewDue: false,
};

export function deriveSocialProgramStage(
  route: SocialProgramRoute | null,
  readiness: SocialProgramReadiness,
): SocialProgramStage {
  if (!route) return 'needs_route';
  if (route === 'cold_start' && !readiness.foundationConfirmed) return 'needs_foundation';
  if (route === 'account_repair' && !readiness.accountImportConfirmed) return 'needs_account_import';
  if (route === 'account_repair' && !readiness.diagnosisComplete) return 'diagnosing';
  if (!readiness.benchmarkRoundComplete) return 'needs_benchmarks';
  if (!readiness.conversionRouteConfirmed) return 'needs_acquisition_route';
  if (!readiness.accountPlaybooksConfirmed) return 'needs_account_playbook';
  if (!readiness.monthlyPlanActive) return 'needs_month_plan';
  if (!readiness.weeklyPlanActive) return 'ready_for_week';
  if (readiness.reviewDue) return 'reviewing';
  return 'executing';
}

export function monthlyPlanActivationIssues(program: SocialProgram): SocialProgramActivationIssue[] {
  const issues: SocialProgramActivationIssue[] = [];
  if (!program.readiness.foundationConfirmed) issues.push({ code: 'foundation_missing', message: '企业、市场、目标受众和产品营销档案尚未确认。' });
  if (program.route === 'account_repair' && !program.readiness.diagnosisComplete) issues.push({ code: 'diagnosis_missing', message: '已有账号诊断尚未完成。' });
  if (!program.readiness.benchmarkRoundComplete) issues.push({ code: 'benchmark_missing', message: '至少需要完成一轮对标账号试采。' });
  if (!program.readiness.conversionRouteConfirmed) issues.push({ code: 'conversion_route_missing', message: '获客路径尚未确认。' });
  if (!program.readiness.accountPlaybooksConfirmed) issues.push({ code: 'account_playbook_missing', message: '自有账号矩阵和账号规则尚未确认。' });
  return issues;
}

export function weeklyPlanActivationIssues(program: SocialProgram, plan: SocialWeeklyPlan): SocialProgramActivationIssue[] {
  const issues: SocialProgramActivationIssue[] = [];
  if (!program.readiness.monthlyPlanActive || program.activeMonthlyPlanRef?.id !== plan.monthlyPlanRef.id) {
    issues.push({ code: 'monthly_plan_missing', message: '周计划必须绑定当前活动月计划。' });
  }
  for (const item of plan.items) {
    if (!item.accountId) issues.push({ code: `item_account_missing:${item.itemId}`, message: `内容 ${item.title || item.itemId} 未绑定账号。` });
    if (!item.cta) issues.push({ code: `item_cta_missing:${item.itemId}`, message: `内容 ${item.title || item.itemId} 未绑定 CTA。` });
    if (!item.factRefs.length) issues.push({ code: `item_fact_missing:${item.itemId}`, message: `内容 ${item.title || item.itemId} 没有事实来源。` });
  }
  return issues;
}

/** Cancellation reports preserved external effects rather than claiming rollback. */
export interface WeeklyCancellationSummary {
  currentSettlements?: import('./weeklyCancellationSettlement.js').WeeklyCancellationSettlement[];
  status: string;
  boundary: string;
  effects: Array<{ resourceType: string; resourceId: string; outcome: 'irreversible' | 'unknown_requires_reconciliation'; receiptCount: number }>;
  lastError: string | null;
  updatedAt: string;
}
