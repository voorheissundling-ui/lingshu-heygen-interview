/** Metric payload accepted by the review contract. Kept in shared so clients do
 * not acquire a dependency on the server-side aggregation implementation. */
export type ReviewMetricKey =
  | 'views' | 'reach' | 'likes' | 'comments' | 'shares' | 'saves'
  | 'watchTimeMinutes' | 'averageViewDurationSeconds' | 'averageViewPercentage'
  | 'followers' | 'subscribers' | 'profileViews' | 'postsPublished';
export type MetricValues = Partial<Record<ReviewMetricKey, number>>;

export type ReviewAvailability = 'available' | 'unknown' | 'unavailable';
export type ReviewEvidenceKind = 'external_reference' | 'owned_content_result';
export type PromotionAction = 'observe' | 'retest' | 'scale';

export interface ReviewWindow { startsAt: string; endsAt: string; frozenAt: string }
export interface ReviewMetric {
  value: number | null;
  availability: ReviewAvailability;
  reason?: 'not_returned' | 'source_unavailable' | 'baseline_missing';
}
export interface ReviewContentInput {
  businessDirection: string;
  platform: string;
  accountId: string;
  contentId: string;
  evidenceKind: ReviewEvidenceKind;
  publicationReceiptRefs?: string[];
  attributionStatus?: 'attributed' | 'unknown' | 'unavailable';
  confounders?: string[];
  baseline?: MetricValues;
  /** Durable weekly-plan item that asked for this publication. */
  publicationTaskId?: string;
  interactionRefs?: string[];
  salesQualificationRefs?: string[];
  salesQualifiedCount?: number;
}
export interface ReviewContentAggregate extends ReviewContentInput {
  metrics: Partial<Record<keyof MetricValues, ReviewMetric>>;
  metricSnapshotRefs: string[];
}
export interface ReviewAggregate {
  key: string;
  evidenceKinds: ReviewEvidenceKind[];
  contentCount: number;
  metrics: Partial<Record<keyof MetricValues, ReviewMetric>>;
}
export interface SampleSufficiency {
  status: 'sufficient' | 'insufficient' | 'unavailable';
  ownedContentCount: number;
  attributableContentCount: number;
  minimumOwnedContent: number;
  reasons: string[];
}
export interface MaintenanceEffort {
  minutes: number | null;
  availability: ReviewAvailability;
  entryRefs: string[];
}
export interface FrozenWeeklyReview {
  snapshotId: string;
  version: 1;
  tenantId: string;
  programId?: string;
  weekRef: string;
  operatingPackageRef?: { type: 'weekly_operating_package'; id: string; version: number };
  window: ReviewWindow;
  contents: ReviewContentAggregate[];
  byBusinessDirection: ReviewAggregate[];
  byAccount: ReviewAggregate[];
  maintenanceEffort: MaintenanceEffort;
  sampleSufficiency: SampleSufficiency;
  evidenceBoundary: { externalReferenceContentIds: string[]; ownedContentIds: string[] };
  sourceEvidence?: {
    workflowEventRefs: string[];
    publicationReceiptRefs: string[];
    interactionRefs: string[];
    salesQualificationRefs: string[];
    publishingAvailability: ReviewAvailability;
    engagementAvailability: ReviewAvailability;
    salesConfirmationAvailability: ReviewAvailability;
  };
  sourceDigest: string;
}

export interface PerformanceEvaluation {
  contentId: string;
  action: PromotionAction;
  score: number | null;
  attributable: boolean;
  sufficient: boolean;
  evidenceRefs: string[];
  boundaries: string[];
  reasons: string[];
}
export interface WeeklyPromotionDecision {
  decisionId: string;
  snapshotId: string;
  contentId: string;
  publicationTaskId?: string;
  action: PromotionAction;
  evidenceRefs: string[];
  reasons: string[];
  boundaries: string[];
}
export interface VersionedQuotaReference {
  quotaId: string;
  version: number;
  sourceSnapshotId: string;
  programId?: string;
  previousQuotaRef?: string;
  /** Observe decisions stay in the decision ledger and are never planning quota. */
  allocations: Array<{ businessDirection: string; accountId: string; action: Exclude<PromotionAction, 'observe'>; contentCount: number; sourceDecisionIds: string[] }>;
  stopConditions: string[];
}
