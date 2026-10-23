export const SOCIAL_CHANNEL_IDS = [
  'douyin_cn',
  'tiktok_global',
  'instagram',
  'facebook',
  'youtube',
  'linkedin',
] as const;

export type SocialChannelId = (typeof SOCIAL_CHANNEL_IDS)[number];
export type LegacySocialChannelId = SocialChannelId | 'tiktok';

/**
 * `tiktok` is the only legacy alias. Domestic Douyin is deliberately never
 * inferred from a TikTok identifier, credential, endpoint or receipt.
 */
export function normalizeSocialChannelId(value: unknown): SocialChannelId | null {
  const candidate = String(value ?? '').trim().toLowerCase();
  if (candidate === 'tiktok') return 'tiktok_global';
  return (SOCIAL_CHANNEL_IDS as readonly string[]).includes(candidate)
    ? candidate as SocialChannelId
    : null;
}

export const SOCIAL_CHANNEL_CAPABILITIES = [
  'publication_package',
  'assisted_browser_publish',
  'official_publish',
  'content_list',
  'content_metrics',
  'account_metrics',
  'webhook_or_status_poll',
] as const;

export type SocialChannelCapability = (typeof SOCIAL_CHANNEL_CAPABILITIES)[number];
export type CapabilityAvailability = 'available' | 'unavailable' | 'unconfigured';

export interface ChannelCapabilityDecision {
  capability: SocialChannelCapability;
  availability: CapabilityAvailability;
  source: 'built_in' | 'official_api' | 'assisted_browser' | 'public_page';
  reasonCode?: string;
  requirements?: string[];
  verifiedAt?: string;
}

export interface ChannelCapabilityMatrix {
  schemaVersion: 'social-channel-capabilities.v1';
  channelId: SocialChannelId;
  evaluatedAt: string;
  decisions: Record<SocialChannelCapability, ChannelCapabilityDecision>;
}

export type DouyinApplicationType = 'web' | 'mobile' | 'mini_program' | 'unknown';
export type DouyinTokenType = 'user_access_token' | 'client_token' | 'none';
export type DouyinAccountQualification = 'eligible' | 'ineligible' | 'unknown';

export interface DouyinCapabilityContext {
  applicationType: DouyinApplicationType;
  approvedScopes: string[];
  tokenType: DouyinTokenType;
  tokenHealth: 'valid' | 'expired' | 'missing' | 'unknown';
  accountQualification: DouyinAccountQualification;
  applicationReview: 'approved' | 'pending' | 'rejected' | 'unknown';
  realAccountE2E: 'passed' | 'failed' | 'not_run';
  webhookConfigured: boolean;
}

export type PublicationPackageStatus =
  | 'ready'
  | 'awaiting_publish_confirmation'
  | 'evidence_submitted'
  | 'published_verified'
  | 'reconciliation_required'
  | 'failed'
  | 'expired'
  | 'superseded';

export interface PublicationAsset {
  kind: 'video' | 'image' | 'cover' | 'subtitle' | 'document';
  fileName: string;
  downloadUrl: string;
  contentHash: string;
  mediaType?: string;
  byteSize?: number;
}

export interface PublicationCopy {
  title: string;
  body: string;
  hashtags: string[];
  cta?: string;
  firstComment?: string;
  altText?: string;
}

export interface PublicationSpecificationCheck {
  code: string;
  status: 'passed' | 'warning' | 'failed' | 'not_checked';
  message: string;
}

export interface PublicationPackage {
  schemaVersion: 'publication-package.v1';
  packageId: string;
  tenantId: string;
  contentId: string;
  contentVersion: string;
  contentHash: string;
  channelId: SocialChannelId;
  targetAccountId?: string;
  copy: PublicationCopy;
  assets: PublicationAsset[];
  specificationChecks: PublicationSpecificationCheck[];
  sourceTracking?: Record<string, string>;
  publishingInstructions: string[];
  packageHash: string;
  generatedAt: string;
  status: PublicationPackageStatus;
}

export type PublicationMethod = 'manual_package' | 'assisted_browser' | 'official_api';

export interface PublicationEvidenceSubmission {
  schemaVersion: 'publication-evidence.v1';
  evidenceId: string;
  packageId: string;
  channelId: SocialChannelId;
  method: PublicationMethod;
  contentHash: string;
  packageHash: string;
  externalContentId?: string;
  publicUrl?: string;
  providerReceiptHash?: string;
  submittedBy: string;
  submittedAt: string;
  verificationStatus: 'pending';
  evidenceHash: string;
}

export interface ResolvedPublicationEvidence
  extends Omit<PublicationEvidenceSubmission, 'verificationStatus'> {
  verificationStatus: 'verified' | 'reconciliation_required' | 'rejected';
  verifiedAt: string;
  verifier: 'official_api' | 'public_page' | 'assisted_session' | 'human_review';
  verifierIdentity: string;
  verificationRequestId?: string;
  observedContentHash?: string;
  sourceReceiptHash: string;
  reviewNote?: string;
  rejectionReason?: string;
}

export interface PublicationEvidenceEvent {
  schemaVersion: 'publication-evidence-event.v1';
  eventId: string;
  packageId: string;
  evidenceId: string;
  evidenceHash: string;
  eventType: 'submitted' | 'corrected' | 'verified' | 'rejected' | 'reconciliation_required';
  actorKind: 'tenant_submitter' | 'internal_verifier';
  actorId: string;
  recordedAt: string;
  supersedesEvidenceId?: string;
  evidence: PublicationEvidenceSubmission | ResolvedPublicationEvidence;
}

export interface PublicationPackageSnapshot {
  publicationPackage: PublicationPackage;
  currentEvidence: PublicationEvidenceSubmission | ResolvedPublicationEvidence | null;
  evidenceHistory: PublicationEvidenceEvent[];
}

export type AssistedBrowserSessionStatus =
  | 'waiting_for_local_helper'
  | 'in_progress'
  | 'paused_for_user'
  | 'awaiting_final_confirmation'
  | 'confirmation_received'
  | 'evidence_pending'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export interface AssistedBrowserTaskRecord {
  schemaVersion: 'assisted-browser-task.v1';
  sessionId: string;
  tenantId: string;
  packageId: string;
  packageHash: string;
  contentHash: string;
  channelId: SocialChannelId;
  targetAccountId: string;
  requestedBy: string;
  callbackOrigin: string;
  tokenDigest: string;
  tokenConsumedAt?: string;
  expiresAt: string;
  status: AssistedBrowserSessionStatus;
  createdAt: string;
  finalConfirmation?: {
    confirmedBy: string;
    confirmedAt: string;
    packageHash: string;
    contentHash: string;
  };
}

export interface AssistedBrowserTaskGrant {
  session: Omit<AssistedBrowserTaskRecord, 'tokenDigest'>;
  /** Returned exactly once and never persisted or logged by the server. */
  oneTimeToken: string;
}

export type SocialDataSource =
  | 'official_api'
  | 'assisted_browser'
  | 'public_page'
  | 'manual_import';

export type SocialMetricValue = number | null;

export interface SocialMetricSnapshot {
  schemaVersion: 'social-metric-snapshot.v1';
  snapshotId: string;
  tenantId: string;
  channelId: SocialChannelId;
  accountId: string;
  externalContentId?: string;
  source: SocialDataSource;
  capturedAt: string;
  providerObservedAt?: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  freshnessReason?: string;
  metrics: {
    views: SocialMetricValue;
    likes: SocialMetricValue;
    comments: SocialMetricValue;
    shares: SocialMetricValue;
    favorites: SocialMetricValue;
    completionRate: SocialMetricValue;
    followerDelta: SocialMetricValue;
    attributedInquiries: SocialMetricValue;
  };
  unavailableMetrics: string[];
  rawFieldDigest?: string;
}

export interface ExternalSocialContent {
  schemaVersion: 'external-social-content.v1';
  tenantId: string;
  channelId: SocialChannelId;
  accountId: string;
  externalContentId: string;
  publicUrl?: string;
  title?: string;
  publishedAt?: string;
  status: 'published' | 'private' | 'deleted' | 'processing' | 'unknown';
  linkedPackageId?: string;
  source: SocialDataSource;
  observedAt: string;
}

export interface SocialSyncCursor {
  schemaVersion: 'social-sync-cursor.v1';
  tenantId: string;
  channelId: SocialChannelId;
  accountId: string;
  source: SocialDataSource;
  /** Provider cursor is opaque; callers must not parse or merge it. */
  opaqueCursor?: string;
  lastSuccessfulSyncAt?: string;
  nextRetryAt?: string;
  capturedAt: string;
  cursorDigest: string;
}

export interface AccountContentSyncPage {
  items: ExternalSocialContent[];
  metricSnapshots: SocialMetricSnapshot[];
  cursor: SocialSyncCursor;
  source: SocialDataSource;
  coverage: 'account' | 'registered_content_only';
}
