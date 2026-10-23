import type {TikTokDirectPostOptions} from '../lib/tikTokDirectPostContract.js';
import type {SocialInstagramDeliveryPublishProof} from '../../shared/contracts/socialInstagramDelivery.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { store } from '../storage/index.js';
import type { DataStore } from '../storage/datastore.js';
import {
  acquireDurableOperationLease,
  releaseDurableOperationLease,
} from '../runtime/durableLease.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';

export type StarterPublishingPlatform = 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'linkedin';
export type PublicationPackageStatus =
  | 'awaiting_user_publish'
  | 'evidence_submitted'
  | 'published'
  | 'evidence_rejected';

export interface PublicationPackageAsset {
  kind: 'video' | 'image' | 'cover' | 'subtitle' | 'document';
  fileName: string;
  downloadUrl: string;
  contentHash: string;
}

export interface PublicationCopy {
  title: string;
  body: string;
  hashtags: string[];
  firstComment?: string;
  altText?: string;
}

export interface StarterPublicationPackage {
  schemaVersion: 1;
  packageId: string;
  tenantId: string;
  contentId: string;
  contentVersion: string;
  contentHash: string;
  platform: StarterPublishingPlatform;
  copy: PublicationCopy;
  assets: PublicationPackageAsset[];
  inquiryUrl?: string;
  tiktokPostOptions?: TikTokDirectPostOptions;
  publishingSteps: string[];
  packageHash: string;
  generatedAt: string;
  status: PublicationPackageStatus;
  workflowBinding?: StarterPublicationWorkflowBinding;
  operatingLineage?: StarterPublicationOperatingLineage;
}

export interface StarterPublicationOperatingLineage {
  instagramDelivery?:SocialInstagramDeliveryPublishProof;
  assignmentId: string;
  assignmentHash: string;
  programRef: VersionedSocialRef;
  operatingPackageRef: VersionedSocialRef;
  contentPackageRef: VersionedSocialRef;
  weeklyPublicationTaskRef: VersionedSocialRef;
  publishingWorkflowTaskRef: VersionedSocialRef;
  businessGoalRef: VersionedSocialRef | null;
  enterpriseProfileRef: VersionedSocialRef | null;
  factRefs: VersionedSocialRef[];
  productionResultRef: VersionedSocialRef;
  upstreamRefs: VersionedSocialRef[];
}

export interface StarterPublicationWorkflowBinding {
  schemaVersion: 'starter-198.publication-workflow-binding.v1';
  runId: string;
  approvalId: string;
  approvalTaskId: string;
  agentTaskId: string;
}

export interface PublicationEvidenceSubmission {
  schemaVersion: 1;
  packageId: string;
  contentHash: string;
  publicUrl?: string;
  platformPostId?: string;
  submittedAt: string;
  submittedBy: string;
  verificationStatus: 'pending';
  evidenceHash: string;
}

export interface VerifiedPublicationEvidence extends Omit<PublicationEvidenceSubmission, 'verificationStatus'> {
  verificationStatus: 'verified' | 'rejected';
  verifiedAt: string;
  verifier: 'platform_receipt' | 'assisted_session' | 'human_review';
  publiclyObservable: boolean;
  observedContentHash: string;
  verificationReceiptHash: string;
  sourceReceiptHash: string;
  verifierIdentity: string;
  rejectionReason?: string;
}

export interface StarterPublicationEvidenceSnapshot {
  package: StarterPublicationPackage;
  evidence: PublicationEvidenceSubmission | VerifiedPublicationEvidence | null;
  updatedAt: string;
}

interface StoredPublicationPackage {
  id: string;
  tenant_id: string;
  package_id: string;
  idempotency_key: string;
  content_id: string;
  content_version: string;
  content_hash: string;
  platform: StarterPublishingPlatform;
  manifest: StarterPublicationPackage | string;
  status: PublicationPackageStatus;
  evidence?: PublicationEvidenceSubmission | VerifiedPublicationEvidence | string;
  created_at: string;
  updated_at: string;
}

export class StarterPublicationPackageError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'StarterPublicationPackageError';
  }
}

const mutationQueues = new Map<string, Promise<void>>();
const text = (value: unknown): string => String(value ?? '').trim();

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function packageBusinessSubject(input: Pick<
  StarterPublicationPackage,
  'tenantId' | 'contentId' | 'contentVersion' | 'contentHash' | 'platform' | 'copy' | 'assets' | 'inquiryUrl' | 'workflowBinding' | 'operatingLineage' | 'tiktokPostOptions'
>): Record<string, unknown> {
  return {
    tenantId: input.tenantId,
    contentId: input.contentId,
    contentVersion: input.contentVersion,
    contentHash: input.contentHash,
    platform: input.platform,
    copy: input.copy,
    assets: input.assets,
    ...(input.inquiryUrl ? { inquiryUrl: input.inquiryUrl } : {}),
    ...(input.tiktokPostOptions ? { tiktokPostOptions: input.tiktokPostOptions } : {}),
    ...(input.workflowBinding ? { workflowBinding: input.workflowBinding } : {}),
    ...(input.operatingLineage ? { operatingLineage: input.operatingLineage } : {}),
  };
}

function parseObject<T>(value: unknown): T | null {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function hasExactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join('\u0000') === [...keys].sort().join('\u0000');
}

function safeDownloadUrl(value: string): boolean {
  if (value.startsWith('/api/overseas/')) return true;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

function normalizeHashtags(values: string[]): string[] {
  return [...new Set(values.map(value => text(value).replace(/^#+/, '')).filter(Boolean))].slice(0, 30);
}

function platformSteps(platform: StarterPublishingPlatform): string[] {
  const upload = platform === 'youtube' ? '在 YouTube Studio 上传主文件' : `在 ${platform} 创建新帖子并上传主文件`;
  return [
    upload,
    '复制标题、正文、标签、替代文本和首评，不要改动已审批的商业事实',
    '核对封面、目标账号、可见范围和询盘链接',
    '在平台完成发布后，回到灵小枢发布卡提交公开 URL 或平台帖子 ID',
  ];
}

function assertBuildInput(input: BuildStarterPublicationPackageInput): void {
  if (!text(input.tenantId) || !text(input.contentId) || !text(input.contentVersion)) {
    throw new StarterPublicationPackageError('publication_package_identity_required');
  }
  if (!/^[a-f0-9]{32,128}$/i.test(text(input.contentHash))) {
    throw new StarterPublicationPackageError('publication_content_hash_invalid');
  }
  if (!['facebook', 'instagram', 'tiktok', 'youtube', 'linkedin'].includes(input.platform)) {
    throw new StarterPublicationPackageError('publication_platform_invalid');
  }
  if (!/^[a-z0-9:_-]{8,200}$/i.test(text(input.idempotencyKey))) {
    throw new StarterPublicationPackageError('publication_idempotency_key_invalid');
  }
  if (!input.assets.length || input.assets.some(asset => (
    !text(asset.fileName)
    || !/^[a-f0-9]{32,128}$/i.test(text(asset.contentHash))
    || !safeDownloadUrl(text(asset.downloadUrl))
  ))) throw new StarterPublicationPackageError('publication_assets_invalid');
  if (text(input.inquiryUrl) && !safeDownloadUrl(text(input.inquiryUrl))) {
    throw new StarterPublicationPackageError('publication_inquiry_url_invalid');
  }
  if (!text(input.copy.body) && !text(input.copy.title)) {
    throw new StarterPublicationPackageError('publication_copy_required');
  }
  const workflow = input.workflowBinding;
  if (workflow && (workflow.schemaVersion !== 'starter-198.publication-workflow-binding.v1'
    || ![workflow.runId, workflow.approvalId, workflow.approvalTaskId, workflow.agentTaskId]
      .every(value => /^[a-z0-9:_-]{1,200}$/i.test(text(value))))) {
    throw new StarterPublicationPackageError('publication_workflow_binding_invalid');
  }
}

export interface BuildStarterPublicationPackageInput {
  tenantId: string;
  contentId: string;
  contentVersion: string;
  contentHash: string;
  platform: StarterPublishingPlatform;
  copy: PublicationCopy;
  assets: PublicationPackageAsset[];
  inquiryUrl?: string;
  tiktokPostOptions?: TikTokDirectPostOptions;
  workflowBinding?: StarterPublicationWorkflowBinding;
  operatingLineage?: StarterPublicationOperatingLineage;
  idempotencyKey: string;
  now?: Date;
}

export function buildStarterPublicationPackage(input: BuildStarterPublicationPackageInput): StarterPublicationPackage {
  assertBuildInput(input);
  const normalized = {
    tenantId: text(input.tenantId),
    contentId: text(input.contentId),
    contentVersion: text(input.contentVersion),
    contentHash: text(input.contentHash).toLowerCase(),
    platform: input.platform,
    copy: {
      title: text(input.copy.title).slice(0, 300),
      body: text(input.copy.body).slice(0, 10_000),
      hashtags: normalizeHashtags(input.copy.hashtags),
      ...(text(input.copy.firstComment) ? { firstComment: text(input.copy.firstComment).slice(0, 2_000) } : {}),
      ...(text(input.copy.altText) ? { altText: text(input.copy.altText).slice(0, 2_000) } : {}),
    },
    assets: input.assets.map(asset => ({
      kind: asset.kind,
      fileName: text(asset.fileName).slice(0, 240),
      downloadUrl: text(asset.downloadUrl),
      contentHash: text(asset.contentHash).toLowerCase(),
    })),
    ...(input.operatingLineage ? { operatingLineage: input.operatingLineage } : {}),
    ...(input.tiktokPostOptions ? { tiktokPostOptions: structuredClone(input.tiktokPostOptions) } : {}),
    ...(text(input.inquiryUrl) ? { inquiryUrl: text(input.inquiryUrl) } : {}),
    ...(input.workflowBinding ? { workflowBinding: {
      schemaVersion: input.workflowBinding.schemaVersion,
      runId: text(input.workflowBinding.runId),
      approvalId: text(input.workflowBinding.approvalId),
      approvalTaskId: text(input.workflowBinding.approvalTaskId),
      agentTaskId: text(input.workflowBinding.agentTaskId),
    } } : {}),
  };
  const packageHash = sha256(packageBusinessSubject(normalized));
  const packageId = `pubpkg_${sha256({ tenantId: normalized.tenantId, idempotencyKey: text(input.idempotencyKey) }).slice(0, 24)}`;
  return {
    schemaVersion: 1,
    packageId,
    ...normalized,
    publishingSteps: platformSteps(input.platform),
    packageHash,
    generatedAt: (input.now ?? new Date()).toISOString(),
    status: 'awaiting_user_publish',
  };
}

function allowedEvidenceHost(platform: StarterPublishingPlatform, hostname: string): boolean {
  const domains: Record<StarterPublishingPlatform, string[]> = {
    facebook: ['facebook.com', 'fb.watch'],
    instagram: ['instagram.com'],
    tiktok: ['tiktok.com'],
    youtube: ['youtube.com', 'youtu.be'],
    linkedin: ['linkedin.com'],
  };
  return domains[platform].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}

function normalizedEvidenceUrl(platform: StarterPublishingPlatform, value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !allowedEvidenceHost(platform, url.hostname.toLowerCase())) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function evidenceSubject(input: Pick<
  PublicationEvidenceSubmission,
  'packageId' | 'contentHash' | 'publicUrl' | 'platformPostId' | 'submittedAt' | 'submittedBy'
>): Record<string, unknown> {
  return {
    packageId: input.packageId,
    contentHash: input.contentHash,
    ...(text(input.publicUrl) ? { publicUrl: text(input.publicUrl) } : {}),
    ...(text(input.platformPostId) ? { platformPostId: text(input.platformPostId) } : {}),
    submittedAt: input.submittedAt,
    submittedBy: input.submittedBy,
  };
}

function verificationReceiptSubject(input: {
  package: StarterPublicationPackage;
  evidence: Pick<PublicationEvidenceSubmission, 'evidenceHash'>;
  verifier: VerifiedPublicationEvidence['verifier'];
  publiclyObservable: boolean;
  observedContentHash: string;
  verificationStatus: VerifiedPublicationEvidence['verificationStatus'];
  verifiedAt: string;
  rejectionReason?: string;
  sourceReceiptHash: string;
  verifierIdentity: string;
}): Record<string, unknown> {
  return {
    tenantId: input.package.tenantId,
    packageId: input.package.packageId,
    packageHash: input.package.packageHash,
    contentId: input.package.contentId,
    contentVersion: input.package.contentVersion,
    contentHash: input.package.contentHash,
    platform: input.package.platform,
    evidenceHash: input.evidence.evidenceHash,
    verifier: input.verifier,
    publiclyObservable: input.publiclyObservable,
    observedContentHash: input.observedContentHash,
    verificationStatus: input.verificationStatus,
    verifiedAt: input.verifiedAt,
    rejectionReason: text(input.rejectionReason),
    sourceReceiptHash: input.sourceReceiptHash,
    verifierIdentity: input.verifierIdentity,
  };
}

export function buildPublicationEvidenceSubmission(input: {
  package: StarterPublicationPackage;
  contentHash: string;
  publicUrl?: string;
  platformPostId?: string;
  submittedBy: string;
  now?: Date;
}): PublicationEvidenceSubmission {
  if (!/^[a-z0-9:_@.-]{1,160}$/i.test(text(input.submittedBy))) {
    throw new StarterPublicationPackageError('publication_evidence_actor_required');
  }
  if (text(input.contentHash).toLowerCase() !== input.package.contentHash) {
    throw new StarterPublicationPackageError('publication_evidence_content_changed');
  }
  const publicUrl = normalizedEvidenceUrl(input.package.platform, input.publicUrl);
  const platformPostId = text(input.platformPostId);
  if ((input.publicUrl && !publicUrl) || (platformPostId && !/^[a-z0-9_.:-]{3,180}$/i.test(platformPostId))) {
    throw new StarterPublicationPackageError('publication_evidence_invalid');
  }
  if (!publicUrl && !platformPostId) throw new StarterPublicationPackageError('publication_evidence_required');
  const submittedAt = (input.now ?? new Date()).toISOString();
  const subject = {
    packageId: input.package.packageId,
    contentHash: input.package.contentHash,
    ...(publicUrl ? { publicUrl } : {}),
    ...(platformPostId ? { platformPostId } : {}),
    submittedAt,
    submittedBy: text(input.submittedBy),
  };
  return {
    schemaVersion: 1,
    ...subject,
    verificationStatus: 'pending',
    evidenceHash: sha256(subject),
  };
}

export function resolvePublicationEvidence(input: {
  package: StarterPublicationPackage;
  evidence: PublicationEvidenceSubmission;
  verifier: VerifiedPublicationEvidence['verifier'];
  publiclyObservable: boolean;
  observedContentHash?: string;
  rejectionReason?: string;
  sourceReceiptHash: string;
  verifierIdentity: string;
  now?: Date;
}): { status: 'published' | 'evidence_rejected'; evidence: VerifiedPublicationEvidence } {
  if (input.evidence.verificationStatus !== 'pending'
    || input.evidence.packageId !== input.package.packageId
    || input.evidence.contentHash !== input.package.contentHash
    || !/^[a-z0-9:_@.-]{1,160}$/i.test(text(input.evidence.submittedBy))
    || !Number.isFinite(Date.parse(text(input.evidence.submittedAt)))
    || normalizedEvidenceUrl(input.package.platform, input.evidence.publicUrl) !== text(input.evidence.publicUrl)
    || (text(input.evidence.platformPostId)
      && !/^[a-z0-9_.:-]{3,180}$/i.test(text(input.evidence.platformPostId)))
    || (!text(input.evidence.publicUrl) && !text(input.evidence.platformPostId))
    || input.evidence.evidenceHash !== sha256(evidenceSubject(input.evidence))
    || !['platform_receipt', 'assisted_session', 'human_review'].includes(input.verifier)
    || typeof input.publiclyObservable !== 'boolean') {
    throw new StarterPublicationPackageError('publication_evidence_integrity_violation');
  }
  const contentMatches = text(input.observedContentHash).toLowerCase() === input.package.contentHash;
  const verified = input.publiclyObservable && contentMatches;
  const verificationNow = input.now ?? new Date();
  if (!Number.isFinite(verificationNow.getTime())) {
    throw new StarterPublicationPackageError('publication_verifier_time_invalid');
  }
  const verifiedAt = verificationNow.toISOString();
  if (Date.parse(verifiedAt) < Date.parse(input.evidence.submittedAt)) {
    throw new StarterPublicationPackageError('publication_verifier_time_invalid');
  }
  const observedContentHash = text(input.observedContentHash).toLowerCase();
  const sourceReceiptHash = text(input.sourceReceiptHash).toLowerCase();
  const verifierIdentity = text(input.verifierIdentity);
  if ((observedContentHash && !/^[a-f0-9]{32,128}$/.test(observedContentHash))
    || !/^[a-f0-9]{64}$/.test(sourceReceiptHash)
    || !/^[a-z0-9._:@-]{3,160}$/i.test(verifierIdentity)) {
    throw new StarterPublicationPackageError('publication_verifier_receipt_invalid');
  }
  const verificationStatus = verified ? 'verified' : 'rejected';
  const suppliedReason = text(input.rejectionReason);
  const rejectionReason = !verified
    ? (/^[a-z0-9_.:-]{1,120}$/i.test(suppliedReason)
      ? suppliedReason
      : (contentMatches ? 'publication_not_observable' : 'publication_content_mismatch'))
    : '';
  const receipt = verificationReceiptSubject({
    package: input.package,
    evidence: input.evidence,
    verifier: input.verifier,
    publiclyObservable: input.publiclyObservable,
    observedContentHash,
    verificationStatus,
    verifiedAt,
    sourceReceiptHash,
    verifierIdentity,
    ...(rejectionReason ? { rejectionReason } : {}),
  });
  const evidence: VerifiedPublicationEvidence = {
    ...input.evidence,
    verificationStatus,
    verifiedAt,
    verifier: input.verifier,
    publiclyObservable: input.publiclyObservable,
    observedContentHash,
    verificationReceiptHash: sha256(receipt),
    sourceReceiptHash,
    verifierIdentity,
    ...(rejectionReason ? { rejectionReason } : {}),
  };
  return { status: verified ? 'published' : 'evidence_rejected', evidence };
}

async function serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  mutationQueues.set(key, queued);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (mutationQueues.get(key) === queued) mutationQueues.delete(key);
  }
}

async function findStoredPackage(
  tenantId: string,
  where: Record<string, string | number | boolean>,
  dataStore: DataStore = store,
): Promise<StoredPublicationPackage | null> {
  const result = await dataStore.list<StoredPublicationPackage>('starter_publication_packages', {
    where: { tenant_id: tenantId, ...where }, perPage: 2,
  });
  if (!Array.isArray(result.items) || !Number.isFinite(result.totalItems)
    || result.totalItems > result.items.length || result.items.length > 1) {
    throw new StarterPublicationPackageError('publication_package_integrity_violation');
  }
  const stored = result.items[0] ?? null;
  if (stored && (stored.tenant_id !== tenantId || Object.entries(where)
    .some(([key, value]) => String((stored as unknown as Record<string, unknown>)[key] ?? '') !== String(value)))) {
    throw new StarterPublicationPackageError('publication_package_integrity_violation');
  }
  return stored;
}

function packageFromRecord(record: StoredPublicationPackage): StarterPublicationPackage {
  const manifest = parseObject<StarterPublicationPackage>(record.manifest);
  const expectedPackageId = `pubpkg_${sha256({ tenantId: record.tenant_id, idempotencyKey: record.idempotency_key }).slice(0, 24)}`;
  const validStatus = ['awaiting_user_publish', 'evidence_submitted', 'published', 'evidence_rejected'].includes(record.status);
  let rebuilt: StarterPublicationPackage | null = null;
  try {
    if (manifest && Number.isFinite(Date.parse(text(manifest.generatedAt)))) {
      rebuilt = buildStarterPublicationPackage({
        tenantId: manifest.tenantId,
        contentId: manifest.contentId,
        contentVersion: manifest.contentVersion,
        contentHash: manifest.contentHash,
        platform: manifest.platform,
        copy: manifest.copy,
        assets: manifest.assets,
        ...(manifest.inquiryUrl ? { inquiryUrl: manifest.inquiryUrl } : {}),
        ...(manifest.tiktokPostOptions ? { tiktokPostOptions: manifest.tiktokPostOptions } : {}),
        ...(manifest.workflowBinding ? { workflowBinding: manifest.workflowBinding } : {}),
        ...(manifest.operatingLineage ? { operatingLineage: manifest.operatingLineage } : {}),
        idempotencyKey: record.idempotency_key,
        now: new Date(manifest.generatedAt),
      });
    }
  } catch {
    rebuilt = null;
  }
  if (
    !manifest
    || !rebuilt
    || !isDeepStrictEqual(manifest, rebuilt)
    || manifest.status !== 'awaiting_user_publish'
    || manifest.packageId !== record.package_id
    || manifest.packageId !== expectedPackageId
    || manifest.tenantId !== record.tenant_id
    || manifest.contentId !== record.content_id
    || manifest.contentVersion !== record.content_version
    || manifest.contentHash !== record.content_hash
    || manifest.platform !== record.platform
    || manifest.packageHash !== sha256(packageBusinessSubject(manifest))
    || record.created_at !== manifest.generatedAt
    || !validStatus
  ) {
    throw new StarterPublicationPackageError('publication_package_integrity_violation');
  }
  const current = { ...manifest, status: record.status };
  evidenceFromRecord(record, current);
  return current;
}

function evidenceFromRecord(
  record: StoredPublicationPackage,
  packageManifest: StarterPublicationPackage,
): PublicationEvidenceSubmission | VerifiedPublicationEvidence | null {
  const parsed = parseObject<PublicationEvidenceSubmission | VerifiedPublicationEvidence>(record.evidence);
  if (record.status === 'awaiting_user_publish') {
    if (parsed && Object.keys(parsed).length) throw new StarterPublicationPackageError('publication_evidence_integrity_violation');
    return null;
  }
  if (!parsed
    || parsed.schemaVersion !== 1
    || parsed.packageId !== packageManifest.packageId
    || parsed.contentHash !== packageManifest.contentHash
    || !text(parsed.submittedBy)
    || !Number.isFinite(Date.parse(text(parsed.submittedAt)))
    || normalizedEvidenceUrl(packageManifest.platform, parsed.publicUrl) !== text(parsed.publicUrl)
    || (text(parsed.platformPostId) && !/^[a-z0-9_.:-]{3,180}$/i.test(text(parsed.platformPostId)))
    || (!text(parsed.publicUrl) && !text(parsed.platformPostId))
    || parsed.evidenceHash !== sha256(evidenceSubject(parsed))) {
    throw new StarterPublicationPackageError('publication_evidence_integrity_violation');
  }
  const submissionKeys = [
    'schemaVersion', 'packageId', 'contentHash',
    ...(text(parsed.publicUrl) ? ['publicUrl'] : []),
    ...(text(parsed.platformPostId) ? ['platformPostId'] : []),
    'submittedAt', 'submittedBy', 'verificationStatus', 'evidenceHash',
  ];
  if (record.status === 'evidence_submitted') {
    if (parsed.verificationStatus !== 'pending' || record.updated_at !== parsed.submittedAt
      || !hasExactKeys(parsed, submissionKeys)) {
      throw new StarterPublicationPackageError('publication_evidence_integrity_violation');
    }
    return parsed as PublicationEvidenceSubmission;
  }
  const verified = parsed as VerifiedPublicationEvidence;
  const expectedVerification = record.status === 'published' ? 'verified' : 'rejected';
  const verifiedAt = Date.parse(text(verified.verifiedAt));
  const submittedAt = Date.parse(text(verified.submittedAt));
  if (verified.verificationStatus !== expectedVerification
    || !hasExactKeys(verified, [
      ...submissionKeys,
      'verifiedAt', 'verifier', 'publiclyObservable', 'observedContentHash',
      'verificationReceiptHash', 'sourceReceiptHash', 'verifierIdentity',
      ...(text(verified.rejectionReason) ? ['rejectionReason'] : []),
    ])
    || !['platform_receipt', 'assisted_session', 'human_review'].includes(text(verified.verifier))
    || typeof verified.publiclyObservable !== 'boolean'
    || !/^[a-f0-9]{0,128}$/i.test(text(verified.observedContentHash))
    || !Number.isFinite(verifiedAt) || verifiedAt < submittedAt
    || record.updated_at !== verified.verifiedAt
    || !/^[a-f0-9]{64}$/.test(text(verified.sourceReceiptHash))
    || !/^[a-z0-9._:@-]{3,160}$/i.test(text(verified.verifierIdentity))
    || (expectedVerification === 'verified'
      && (!verified.publiclyObservable || verified.observedContentHash !== packageManifest.contentHash
        || text(verified.rejectionReason)))
    || (expectedVerification === 'rejected' && !text(verified.rejectionReason))) {
    throw new StarterPublicationPackageError('publication_evidence_integrity_violation');
  }
  const receipt = verificationReceiptSubject({
    package: packageManifest,
    evidence: verified,
    verifier: verified.verifier,
    publiclyObservable: verified.publiclyObservable,
    observedContentHash: verified.observedContentHash,
    verificationStatus: verified.verificationStatus,
    verifiedAt: verified.verifiedAt,
    sourceReceiptHash: verified.sourceReceiptHash,
    verifierIdentity: verified.verifierIdentity,
    ...(verified.rejectionReason ? { rejectionReason: verified.rejectionReason } : {}),
  });
  if (verified.verificationReceiptHash !== sha256(receipt)) {
    throw new StarterPublicationPackageError('publication_evidence_integrity_violation');
  }
  return verified;
}

/** Tenant-scoped, integrity-checked read used by the starter workspace only. */
export async function readStarterPublicationPackage(
  tenantId: string,
  packageId: string,
  dataStore: DataStore = store,
): Promise<StarterPublicationPackage | null> {
  const stored = await findStoredPackage(text(tenantId), { package_id: text(packageId) }, dataStore);
  return stored ? packageFromRecord(stored) : null;
}

/** Internal verifier/projection read; it never performs platform verification. */
export async function readStarterPublicationEvidenceSnapshot(
  tenantId: string,
  packageId: string,
  dataStore: DataStore = store,
): Promise<StarterPublicationEvidenceSnapshot | null> {
  const stored = await findStoredPackage(text(tenantId), { package_id: text(packageId) }, dataStore);
  if (!stored) return null;
  const packageManifest = packageFromRecord(stored);
  return {
    package: packageManifest,
    evidence: evidenceFromRecord(stored, packageManifest),
    updatedAt: stored.updated_at,
  };
}

export async function createStarterPublicationPackage(
  input: BuildStarterPublicationPackageInput,
  dataStore: DataStore = store,
): Promise<{
  package: StarterPublicationPackage;
  created: boolean;
}> {
  const packageManifest = buildStarterPublicationPackage(input);
  const mutationKey = `${packageManifest.tenantId}:${text(input.idempotencyKey)}`;
  return serializeMutation(mutationKey, async () => {
    const existing = await findStoredPackage(packageManifest.tenantId, { idempotency_key: text(input.idempotencyKey) }, dataStore);
    if (existing) {
      const previous = packageFromRecord(existing);
      if (previous.packageHash !== packageManifest.packageHash) throw new StarterPublicationPackageError('publication_idempotency_conflict');
      return { package: previous, created: false };
    }
    const now = packageManifest.generatedAt;
    const created = await dataStore.create<StoredPublicationPackage>('starter_publication_packages', {
      tenant_id: packageManifest.tenantId,
      package_id: packageManifest.packageId,
      idempotency_key: text(input.idempotencyKey),
      content_id: packageManifest.contentId,
      content_version: packageManifest.contentVersion,
      content_hash: packageManifest.contentHash,
      platform: packageManifest.platform,
      manifest: packageManifest,
      status: packageManifest.status,
      evidence: {},
      created_at: now,
      updated_at: now,
    });
    if (created) return { package: packageManifest, created: true };
    const raced = await findStoredPackage(packageManifest.tenantId, { idempotency_key: text(input.idempotencyKey) }, dataStore);
    if (!raced) {
      const contentPackage = await findStoredPackage(packageManifest.tenantId, { content_id: packageManifest.contentId }, dataStore);
      if (contentPackage) throw new StarterPublicationPackageError('publication_package_quota_exceeded');
      throw new StarterPublicationPackageError('publication_package_storage_unavailable');
    }
    const previous = packageFromRecord(raced);
    if (previous.packageHash !== packageManifest.packageHash) throw new StarterPublicationPackageError('publication_idempotency_conflict');
    return { package: previous, created: false };
  });
}

async function withEvidenceMutationLease<T>(input: {
  dataStore: DataStore;
  tenantId: string;
  packageId: string;
  action: () => Promise<T>;
}): Promise<T> {
  let lease;
  try {
    lease = await acquireDurableOperationLease({
      dataStore: input.dataStore, tenantId: input.tenantId,
      scope: 'starter-publication-evidence', subjectId: input.packageId,
      ownerId: `publication-evidence:${process.pid}:${randomUUID()}`, leaseDurationMs: 60_000,
    });
  } catch {
    throw new StarterPublicationPackageError('publication_evidence_storage_unavailable');
  }
  if (!lease) throw new StarterPublicationPackageError('publication_evidence_mutation_conflict');
  try { return await input.action(); }
  finally { await releaseDurableOperationLease({ dataStore: input.dataStore, lease }).catch(() => undefined); }
}

export async function submitStarterPublicationEvidence(input: {
  tenantId: string;
  packageId: string;
  contentHash: string;
  publicUrl?: string;
  platformPostId?: string;
  submittedBy: string;
  now?: Date;
}, dataStore: DataStore = store): Promise<{ package: StarterPublicationPackage; evidence: PublicationEvidenceSubmission; repeated: boolean }> {
  return serializeMutation(`${input.tenantId}:${input.packageId}`, () => withEvidenceMutationLease({
    dataStore, tenantId: input.tenantId, packageId: input.packageId, action: async () => {
    const stored = await findStoredPackage(input.tenantId, { package_id: text(input.packageId) }, dataStore);
    if (!stored) throw new StarterPublicationPackageError('publication_package_not_found');
    if (stored.status === 'published') throw new StarterPublicationPackageError('publication_already_verified');
    const packageManifest = packageFromRecord(stored);
    const evidence = buildPublicationEvidenceSubmission({ ...input, package: packageManifest });
    const previous = parseObject<PublicationEvidenceSubmission>(stored.evidence);
    const samePendingSubmission = previous?.verificationStatus === 'pending'
      && previous.packageId === evidence.packageId
      && previous.contentHash === evidence.contentHash
      && text(previous.publicUrl) === text(evidence.publicUrl)
      && text(previous.platformPostId) === text(evidence.platformPostId)
      && text(previous.submittedBy) === text(evidence.submittedBy);
    if (samePendingSubmission && stored.status === 'evidence_submitted') {
      return { package: packageManifest, evidence: previous, repeated: true };
    }
    if (previous && !samePendingSubmission && stored.status === 'evidence_submitted') {
      throw new StarterPublicationPackageError('publication_evidence_conflict');
    }
    const updated = await dataStore.update('starter_publication_packages', stored.id, {
      evidence,
      status: 'evidence_submitted',
      updated_at: evidence.submittedAt,
    });
    if (!updated) throw new StarterPublicationPackageError('publication_package_storage_unavailable');
    return { package: { ...packageManifest, status: 'evidence_submitted' }, evidence, repeated: false };
    },
  }));
}

export async function verifyStarterPublicationEvidence(input: {
  tenantId: string;
  packageId: string;
  verifier: VerifiedPublicationEvidence['verifier'];
  publiclyObservable: boolean;
  observedContentHash?: string;
  rejectionReason?: string;
  sourceReceiptHash: string;
  verifierIdentity: string;
  now?: Date;
}, dataStore: DataStore = store): Promise<{ package: StarterPublicationPackage; evidence: VerifiedPublicationEvidence }> {
  return serializeMutation(`${input.tenantId}:${input.packageId}`, () => withEvidenceMutationLease({
    dataStore, tenantId: input.tenantId, packageId: input.packageId, action: async () => {
    const stored = await findStoredPackage(input.tenantId, { package_id: text(input.packageId) }, dataStore);
    if (!stored) throw new StarterPublicationPackageError('publication_package_not_found');
    const packageManifest = packageFromRecord(stored);
    const pending = parseObject<PublicationEvidenceSubmission>(stored.evidence);
    if (!pending || pending.verificationStatus !== 'pending') throw new StarterPublicationPackageError('publication_evidence_not_pending');
    const resolved = resolvePublicationEvidence({ ...input, package: packageManifest, evidence: pending });
    const updated = await dataStore.update('starter_publication_packages', stored.id, {
      evidence: resolved.evidence,
      status: resolved.status,
      updated_at: resolved.evidence.verifiedAt,
    });
    if (!updated) throw new StarterPublicationPackageError('publication_package_storage_unavailable');
    return { package: { ...packageManifest, status: resolved.status }, evidence: resolved.evidence };
    },
  }));
}
