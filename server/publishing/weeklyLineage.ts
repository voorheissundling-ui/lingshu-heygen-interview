import {assertPublicationAtomicStore} from './publicationAtomicStore.js';
import {assertWeeklyPublicationRecoveryDue} from '../socialPrograms/weeklyPublicationRecoverySchedule.js';
import { createHash, randomUUID } from 'node:crypto';
import {acquireDurableOperationLease,assertDurableOperationLease,releaseDurableOperationLease} from '../runtime/durableLease.js';
import type { SocialWeeklyContentPackage } from '../../shared/contracts/socialProgram.js';
import type { PublicationAssignment } from '../digitalEmployees/publishingExecution.js';
import type { PublishableProductionResult } from '../digitalEmployees/publishingExecution.js';
import { buildStarterPublicationPackage, createStarterPublicationPackage, type StarterPublicationPackage } from './starterPublicationPackage.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { platformCapabilityEvidenceIsCurrent, type PlatformCapabilityEvidence } from './platformCapabilities.js';

export type PublishingCapability = { platform: 'tiktok' | 'facebook' | 'instagram' | 'youtube' | 'linkedin'; status: 'available' | 'unavailable'; reason?: string; accountIds?: string[]; verifiedAt?: string };
export type SimulatedReceiptOutcome = 'success' | 'rejected' | 'unknown';
export type PublicationAttemptStatus = 'published' | 'failed' | 'unknown';

export interface PublicationAttempt {
  attemptId: string;
  assignmentId: string;
  status: PublicationAttemptStatus;
  platformPostId?: string;
  providerReceiptId?: string;
  failureCode?: string;
  attemptedAt: string;
}

export interface SimulatedPublicationState { attempts: Record<string, PublicationAttempt> }

export const PUBLICATION_ASSIGNMENTS = 'social_publication_assignments';
export const PUBLICATION_ATTEMPTS = 'social_publication_attempts';

export type StoredPublicationAssignmentStatus = 'package_pending' | 'package_ready' | 'revoked';
export interface StoredPublicationAssignment {
  id: string;
  tenant_id: string;
  assignment_id: string;
  package_id: string;
  operating_package_id: string;
  operating_package_version: number;
  publication_task_id: string;
  production_result_id: string;
  platform: PublicationAssignment['platform'];
  account_id: string;
  status: StoredPublicationAssignmentStatus;
  payload: PublicationAssignment;
  assignment_hash: string;
  authorization_revoked_at?: string;
  authorization_revoked_by?: string;
  created_at: string;
  updated_at: string;
}

export type DurablePublicationAttemptStatus = 'in_flight' | 'published' | 'failed' | 'unknown';
export interface DurablePublicationAttempt {
  id: string;
  tenant_id: string;
  attempt_id: string;
  assignment_id: string;
  package_id: string;
  provider: string;
  status: DurablePublicationAttemptStatus;
  provider_receipt_id?: string;
  platform_post_id?: string;
  platform_url?: string;
  failure_code?: string;
  started_at: string;
  resolved_at?: string;
  updated_at: string;
}

export interface WeeklyPublishingProviderAdapter {
  provider: string;
  platform: PublicationAssignment['platform'];
  capability: 'available' | 'unavailable';
  unavailableReason?: string;
  publish(input: {
    assignment: PublicationAssignment;
    publicationPackage: StarterPublicationPackage;
    attemptId: string;
  }): Promise<{
    status: 'published' | 'accepted' | 'rejected' | 'unknown';
    providerReceiptId?: string;
    platformPostId?: string;
    platformUrl?: string;
    failureCode?: string;
  }>;
  reconcile(input: {
    assignment: PublicationAssignment;
    publicationPackage: StarterPublicationPackage;
    attempt: DurablePublicationAttempt;
  }): Promise<{
    status: 'published' | 'failed' | 'unknown';
    providerReceiptId?: string;
    platformPostId?: string;
    platformUrl?: string;
    failureCode?: string;
  }>;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const day = (value: string) => /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] || '';

export function buildAssignedPublicationPackage(input: {
  assignment: PublicationAssignment;
  productionResult: PublishableProductionResult;
  now?: Date;
}): StarterPublicationPackage {
  if (input.assignment.lineage.productionResultRef.id !== input.productionResult.productionResultId) throw new Error('assignment_production_result_mismatch');
  const manifest = buildStarterPublicationPackage({
    tenantId: input.assignment.tenantId,
    // Starter packages enforce one immutable package per content id. Scope the
    // id to the weekly item so one accepted result can feed several accounts
    // without colliding; the original result id remains in operatingLineage.
    contentId: `${input.productionResult.contentId}:${input.assignment.publicationTaskId}`,
    contentVersion: input.productionResult.contentVersion,
    contentHash: input.productionResult.contentHash,
    platform: input.assignment.platform,
    copy: { title: input.productionResult.title, body: input.productionResult.body, hashtags: input.productionResult.hashtags ?? [] },
    assets: input.productionResult.assets,
    operatingLineage: { assignmentId: input.assignment.assignmentId, assignmentHash: input.assignment.assignmentHash, ...input.assignment.lineage },
    idempotencyKey: input.assignment.packageIdempotencyKey,
    now: input.now,
  });
  if (manifest.packageId !== input.assignment.packageId) throw new Error('assignment_package_identity_mismatch');
  return manifest;
}

export async function createAssignedPublicationPackage(input: {
  assignment: PublicationAssignment;
  productionResult: PublishableProductionResult;
  now?: Date;
}, dataStore: DataStore = store): Promise<{ package: StarterPublicationPackage; created: boolean }> {
  const manifest = buildAssignedPublicationPackage(input);
  return createStarterPublicationPackage({
    tenantId: manifest.tenantId, contentId: manifest.contentId, contentVersion: manifest.contentVersion,
    contentHash: manifest.contentHash, platform: manifest.platform, copy: manifest.copy, assets: manifest.assets,
    operatingLineage: manifest.operatingLineage, idempotencyKey: input.assignment.packageIdempotencyKey,
    now: input.now,
  }, dataStore);
}

export async function persistPublicationAssignment(
  assignment: PublicationAssignment,
  dataStore: DataStore = store,
): Promise<{ item: StoredPublicationAssignment; created: boolean }> {
  const found = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, {
    where: { tenant_id: assignment.tenantId, assignment_id: assignment.assignmentId }, page: 1, perPage: 2,
  });
  if (found.totalItems > 1 || found.items.length > 1) throw new Error('publication_assignment_integrity_violation');
  if (found.items[0]) {
    if (found.items[0].assignment_hash !== assignment.assignmentHash) throw new Error('publication_assignment_identity_conflict');
    return { item: found.items[0], created: false };
  }
  const now = new Date().toISOString();
  const created = await dataStore.create<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, {
    tenant_id: assignment.tenantId, assignment_id: assignment.assignmentId, package_id: assignment.packageId,
    operating_package_id: assignment.lineage.operatingPackageRef.id,
    operating_package_version: assignment.lineage.operatingPackageRef.version,
    publication_task_id: assignment.publicationTaskId,
    production_result_id: assignment.lineage.productionResultRef.id,
    platform: assignment.platform, account_id: assignment.accountId, status: 'package_pending',
    payload: assignment, assignment_hash: assignment.assignmentHash, created_at: now, updated_at: now,
  });
  if (created) return { item: created, created: true };
  const raced = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, {
    where: { tenant_id: assignment.tenantId, assignment_id: assignment.assignmentId }, page: 1, perPage: 2,
  });
  if (raced.items[0]?.assignment_hash === assignment.assignmentHash) return { item: raced.items[0], created: false };
  throw new Error('publication_assignment_storage_unavailable');
}

export async function markPublicationAssignmentPackageReady(
  tenantId: string,
  assignmentId: string,
  dataStore: DataStore = store,
): Promise<void> {
  const result = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, {
    where: { tenant_id: tenantId, assignment_id: assignmentId }, page: 1, perPage: 2,
  });
  if (result.totalItems !== 1 || !result.items[0]) throw new Error('publication_assignment_not_found');
  if (result.items[0].status === 'revoked') return;
  if (!await dataStore.update(PUBLICATION_ASSIGNMENTS, result.items[0].id, { status: 'package_ready', updated_at: new Date().toISOString() })) {
    throw new Error('publication_assignment_storage_unavailable');
  }
}

export async function revokePublicationAssignments(input: {
  tenantId: string;
  operatingPackageId: string;
  operatingPackageVersion?: number;
  revokedBy: string;
  revokedAt?: string;
  dataStore?: DataStore;
}): Promise<number> {
  const dataStore = input.dataStore ?? store;
  const result = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, {
    where: {
      tenant_id: input.tenantId, operating_package_id: input.operatingPackageId,
      ...(input.operatingPackageVersion ? { operating_package_version: input.operatingPackageVersion } : {}),
    }, page: 1, perPage: 500,
  });
  if (result.totalItems > result.items.length) throw new Error('publication_assignment_scan_truncated');
  const revokedAt = input.revokedAt ?? new Date().toISOString();
  let changed = 0;
  for (const item of result.items) {
    if (item.status === 'revoked') continue;
    const attempts = await dataStore.list<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, {
      where: { tenant_id: input.tenantId, assignment_id: item.assignment_id }, page: 1, perPage: 100,
    });
    // A call already made to a provider remains recoverable. Revocation stops
    // new effects but never erases or rewrites an ambiguous/real receipt.
    const hasProviderEffect = attempts.items.some(attempt => ['in_flight', 'unknown', 'published'].includes(attempt.status));
    if (!await dataStore.update(PUBLICATION_ASSIGNMENTS, item.id, {
      status: 'revoked', authorization_revoked_at: revokedAt, authorization_revoked_by: input.revokedBy,
      updated_at: revokedAt, ...(hasProviderEffect ? { receipt_recovery_required: true } : {}),
    })) throw new Error('publication_assignment_storage_unavailable');
    changed += 1;
  }
  return changed;
}

async function assignmentAttempt(
  tenantId: string,
  assignmentId: string,
  dataStore: DataStore,
): Promise<DurablePublicationAttempt | null> {
  const result = await dataStore.list<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, {
    where: { tenant_id: tenantId, assignment_id: assignmentId }, sort: '-started_at', page: 1, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) throw new Error('publication_attempt_integrity_violation');
  return result.items[0] ?? null;
}

function attemptId(assignment: PublicationAssignment): string {
  return `pat_${digest(`${assignment.tenantId}:${assignment.assignmentId}`).slice(0, 24)}`;
}

function normalizedAttemptResult(
  result: Awaited<ReturnType<WeeklyPublishingProviderAdapter['publish']>>,
): Pick<DurablePublicationAttempt, 'status' | 'provider_receipt_id' | 'platform_post_id' | 'platform_url' | 'failure_code'> {
  const providerReceipt = String(result.providerReceiptId || '').trim();
  const platformPost = String(result.platformPostId || '').trim();
  if (result.status === 'published' && providerReceipt && platformPost) {
    return { status: 'published', provider_receipt_id: providerReceipt, platform_post_id: platformPost, ...(result.platformUrl ? { platform_url: result.platformUrl } : {}) };
  }
  if (result.status === 'rejected') return { status: 'failed', failure_code: result.failureCode || 'provider_rejected' };
  return { status: 'unknown', ...(providerReceipt ? { provider_receipt_id: providerReceipt } : {}), failure_code: result.failureCode || (result.status === 'accepted' ? 'provider_accepted_pending_receipt' : 'provider_outcome_unknown') };
}

/** Persist-before-effect publication. An unknown result is never resubmitted. */
export async function executeWeeklyPublication(input: {
  assignment: PublicationAssignment;
  publicationPackage: StarterPublicationPackage;
  contentPackage: SocialWeeklyContentPackage;
  adapter: WeeklyPublishingProviderAdapter;
  existingPublishedCount: number;
  now?: Date;
  dataStore?: DataStore;
}): Promise<DurablePublicationAttempt> {
  const dataStore = input.dataStore ?? store;
  await assertPublicationAtomicStore(dataStore);
  const existing = await assignmentAttempt(input.assignment.tenantId, input.assignment.assignmentId, dataStore);
  if (existing) return existing;
  const lease=await acquireDurableOperationLease({dataStore,tenantId:input.assignment.tenantId,scope:'weekly_publication_quota',subjectId:digest(`${input.assignment.lineage.operatingPackageRef.id}:${input.assignment.lineage.operatingPackageRef.version}`),ownerId:randomUUID(),leaseDurationMs:30000});
  if(!lease)throw Error('publication_quota_busy');
  let sourceLease: Awaited<ReturnType<typeof acquireDurableOperationLease>> = null;
  let created:DurablePublicationAttempt|null=null;
  try{
    sourceLease=await acquireDurableOperationLease({dataStore,tenantId:input.assignment.tenantId,scope:'weekly_publication_source_account',subjectId:digest(`${input.assignment.lineage.productionResultRef.id}:${input.assignment.lineage.productionResultRef.version}:${input.assignment.accountId}`),ownerId:randomUUID(),leaseDurationMs:30000});
    if(!sourceLease)throw Error('inventory_publication_busy');
    const raced=await assignmentAttempt(input.assignment.tenantId,input.assignment.assignmentId,dataStore);
    if(raced)return raced;
    const recoverySchedule=await assertWeeklyPublicationRecoveryDue(dataStore,input.assignment,input.now??new Date());
    const assignments = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, {
      where: { tenant_id: input.assignment.tenantId, assignment_id: input.assignment.assignmentId }, page: 1, perPage: 2,
    });
    if (assignments.totalItems !== 1 || !assignments.items[0]) throw new Error('publication_assignment_not_found');
    if (assignments.items[0].assignment_hash !== input.assignment.assignmentHash) throw new Error('publication_assignment_identity_conflict');
    if (assignments.items[0].status === 'revoked') throw new Error('authorization_revoked');
    if (assignments.items[0].status !== 'package_ready') throw new Error('publication_package_not_ready');
    const siblings=await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS,{where:{tenant_id:input.assignment.tenantId,operating_package_id:input.assignment.lineage.operatingPackageRef.id,operating_package_version:input.assignment.lineage.operatingPackageRef.version},page:1,perPage:1000});
    if(siblings.totalItems!==siblings.items.length)throw Error('publication_assignment_scan_truncated');
    let reservedCount=0;
    for(const sibling of siblings.items){
      const prior=await assignmentAttempt(input.assignment.tenantId,sibling.assignment_id,dataStore);
      // A request with an uncertain outcome may already be live on the platform.
      // Its authorization slot remains reserved until explicit rejection.
      if(prior&&['published','unknown','in_flight'].includes(prior.status))reservedCount++;
    }
    const issue = validateWeeklyAssignmentBoundary({ assignment: input.assignment, contentPackage: input.contentPackage, existingPublishedCount: Math.max(input.existingPublishedCount,reservedCount), now: (input.now ?? new Date()).toISOString() });
    if (issue) throw new Error(issue);
    if (input.adapter.platform !== input.assignment.platform || input.adapter.capability !== 'available') {
      throw new Error(input.adapter.unavailableReason || 'publishing_provider_unavailable');
    }
    if (input.publicationPackage.packageId !== input.assignment.packageId
      || input.publicationPackage.operatingLineage?.assignmentHash !== input.assignment.assignmentHash) {
      throw new Error('publication_package_assignment_mismatch');
    }
    const publication = input.contentPackage.publicationTasks.find(task => task.publicationTaskId === input.assignment.publicationTaskId);
    if (publication?.inventoryReuseRef) {
      const candidates = await dataStore.list<StoredPublicationAssignment>(PUBLICATION_ASSIGNMENTS, {where:{tenant_id:input.assignment.tenantId,production_result_id:input.assignment.lineage.productionResultRef.id},page:1,perPage:1000});
      if(candidates.totalItems!==candidates.items.length)throw Error('publication_assignment_scan_truncated');
      for(const candidate of candidates.items){
        if(candidate.assignment_id===input.assignment.assignmentId||candidate.account_id!==input.assignment.accountId)continue;
        const version=candidate.payload?.lineage?.productionResultRef?.version;
        if(Number.isSafeInteger(version)&&version!==input.assignment.lineage.productionResultRef.version)continue;
        const prior=await assignmentAttempt(input.assignment.tenantId,candidate.assignment_id,dataStore);
        if(prior&&['published','unknown','in_flight'].includes(prior.status))throw Error('inventory_same_account_publication_exists');
      }
      // Canonical receipts can predate the assignment ledger. Preserve that gate.
      const packages=await dataStore.list<{manifest?:StarterPublicationPackage|string;status?:string;content_version?:string}>('starter_publication_packages',{where:{tenant_id:input.assignment.tenantId,account_id:input.assignment.accountId},page:1,perPage:1000});
      if(packages.totalItems!==packages.items.length)throw Error('publication_package_scan_truncated');
      for(const candidate of packages.items){
        let manifest:StarterPublicationPackage|undefined;
        if(typeof candidate.manifest==='string'){try{manifest=JSON.parse(candidate.manifest) as StarterPublicationPackage;}catch{throw Error('inventory_publication_manifest_invalid');}}else manifest=candidate.manifest;
        const lineage=manifest?.operatingLineage;
        if(lineage?.assignmentId===input.assignment.assignmentId)continue;
        if(manifest?.contentVersion!==undefined&&candidate.content_version!==undefined&&manifest.contentVersion!==candidate.content_version)throw Error('inventory_publication_version_changed');
        const version=Number(String(manifest?.contentVersion??candidate.content_version??'').replace(/^v/,''));
        if(lineage?.productionResultRef.id===input.assignment.lineage.productionResultRef.id&&(!Number.isSafeInteger(version)||version<1||version===input.assignment.lineage.productionResultRef.version)&&['published','unknown','in_flight','publishing'].includes(String(candidate.status)))throw Error('inventory_same_account_publication_exists');
      }
    }
    const startedAt = (input.now ?? new Date()).toISOString();
    await assertDurableOperationLease({dataStore,lease});
    await assertDurableOperationLease({dataStore,lease:sourceLease});
    created = await dataStore.create<DurablePublicationAttempt>(PUBLICATION_ATTEMPTS, {
      tenant_id: input.assignment.tenantId, attempt_id: attemptId(input.assignment),
      assignment_id: input.assignment.assignmentId, package_id: input.assignment.packageId,
      provider: input.adapter.provider, status: 'in_flight', started_at: startedAt, updated_at: startedAt,
      ...(recoverySchedule?{publication_recovery_schedule_ref:recoverySchedule.recoveryRef,planned_send_at:recoverySchedule.plannedSendAt}:{}),
    });
    if (!created) {
      const raced = await assignmentAttempt(input.assignment.tenantId, input.assignment.assignmentId, dataStore);
      if (raced) return raced;
      throw new Error('publication_attempt_storage_unavailable');
    }
  }finally{if(sourceLease)await releaseDurableOperationLease({dataStore,lease:sourceLease});await releaseDurableOperationLease({dataStore,lease});}
  if(!created)throw Error('publication_attempt_storage_unavailable');
  let normalized: ReturnType<typeof normalizedAttemptResult>;
  try {
    normalized = normalizedAttemptResult(await input.adapter.publish({ assignment: input.assignment, publicationPackage: input.publicationPackage, attemptId: created.attempt_id }));
  } catch {
    normalized = { status: 'unknown', failure_code: 'provider_outcome_unknown' };
  }
  const resolvedAt = new Date().toISOString();
  return settlePublicationAttempt({dataStore,original:created,observation:normalized,resolvedAt});
}

/** Reconciliation is status-only. It cannot call publish again. */
export async function reconcileWeeklyPublication(input: {
  assignment: PublicationAssignment;
  publicationPackage: StarterPublicationPackage;
  adapter: WeeklyPublishingProviderAdapter;
  now?: Date;
  dataStore?: DataStore;
}): Promise<DurablePublicationAttempt> {
  const dataStore = input.dataStore ?? store;
  const current = await assignmentAttempt(input.assignment.tenantId, input.assignment.assignmentId, dataStore);
  if (!current) throw new Error('publication_attempt_not_found');
  if (current.status !== 'unknown' && current.status !== 'in_flight') return current;
  if (current.tenant_id !== input.assignment.tenantId || current.assignment_id !== input.assignment.assignmentId || current.package_id !== input.assignment.packageId) throw new Error('publication_attempt_scope_mismatch');
  if (current.provider !== input.adapter.provider) throw new Error('publication_receipt_provider_mismatch');
  if (input.publicationPackage.tenantId !== input.assignment.tenantId || input.publicationPackage.packageId !== input.assignment.packageId || input.publicationPackage.platform !== input.assignment.platform || input.publicationPackage.operatingLineage?.assignmentId !== input.assignment.assignmentId || input.publicationPackage.operatingLineage.assignmentHash !== input.assignment.assignmentHash) throw new Error('publication_package_assignment_mismatch');
  if (input.adapter.platform !== input.assignment.platform || input.adapter.capability !== 'available') throw new Error('publishing_receipt_lookup_unavailable');
  const result = await input.adapter.reconcile({ assignment: input.assignment, publicationPackage: input.publicationPackage, attempt: current });
  const normalized = result.status === 'published'
    ? normalizedAttemptResult({ ...result, status: 'published' })
    : result.status === 'failed'
      ? { status: 'failed' as const, failure_code: result.failureCode || 'provider_rejected' }
      : { status: 'unknown' as const, ...(result.providerReceiptId ? { provider_receipt_id: result.providerReceiptId } : {}), failure_code: result.failureCode || 'provider_outcome_unknown' };
  const resolvedAt = (input.now ?? new Date()).toISOString();
  return settlePublicationAttempt({dataStore,original:current,observation:normalized,resolvedAt});
}

export function validateWeeklyAssignmentBoundary(input: {
  assignment: PublicationAssignment;
  contentPackage: SocialWeeklyContentPackage;
  existingPublishedCount: number;
  now: string;
}): string | null {
  const { assignment, contentPackage: pack } = input;
  const authorization = pack.authorization;
  if (!pack.publicationTasks.some(task => task.publicationTaskId === assignment.publicationTaskId
    && task.accountId === assignment.accountId && task.platform === assignment.platform)) return 'assignment_outside_package';
  if (!authorization.allowRealPublishing) return authorization.revokedAt ? 'authorization_revoked' : 'authorization_unavailable';
  if (!authorization.accountIds.includes(assignment.accountId)) return 'assignment_account_outside_package';
  if (authorization.maxPublishItems < 1 || input.existingPublishedCount >= authorization.maxPublishItems) return 'authorization_limit_exceeded';
  const currentDay = day(input.now);
  if (!currentDay || currentDay < authorization.weekStart || currentDay > authorization.weekEnd) return 'authorization_expired';
  return null;
}

/**
 * Deterministic fake provider used for recovery tests. Unknown means that the
 * call may have reached the provider and is never retried until reconciled.
 */
export function simulatePublicationAttempt(input: {
  assignment: PublicationAssignment;
  contentPackage: SocialWeeklyContentPackage;
  outcome: SimulatedReceiptOutcome;
  state: SimulatedPublicationState;
  existingPublishedCount: number;
  now: string;
}): PublicationAttempt {
  const attemptId = `pat_${digest(input.assignment.assignmentId).slice(0, 24)}`;
  const previous = input.state.attempts[attemptId];
  if (previous) return previous;
  const boundaryIssue = validateWeeklyAssignmentBoundary(input);
  if (boundaryIssue) {
    return input.state.attempts[attemptId] = { attemptId, assignmentId: input.assignment.assignmentId, status: 'failed', failureCode: boundaryIssue, attemptedAt: input.now };
  }
  if (input.outcome === 'unknown') {
    return input.state.attempts[attemptId] = { attemptId, assignmentId: input.assignment.assignmentId, status: 'unknown', attemptedAt: input.now };
  }
  if (input.outcome === 'rejected') {
    return input.state.attempts[attemptId] = { attemptId, assignmentId: input.assignment.assignmentId, status: 'failed', failureCode: 'provider_rejected', attemptedAt: input.now };
  }
  return input.state.attempts[attemptId] = {
    attemptId, assignmentId: input.assignment.assignmentId, status: 'published',
    platformPostId: `sim_${digest(`${attemptId}:post`).slice(0, 18)}`,
    providerReceiptId: `simr_${digest(`${attemptId}:receipt`).slice(0, 18)}`, attemptedAt: input.now,
  };
}

export function reconcileSimulatedAttempt(input: { state: SimulatedPublicationState; attemptId: string; platformPostId?: string; providerReceiptId?: string; now: string }): PublicationAttempt {
  const previous = input.state.attempts[input.attemptId];
  if (!previous) throw new Error('publication_attempt_not_found');
  if (previous.status !== 'unknown') return previous;
  if (!input.platformPostId || !input.providerReceiptId) return previous;
  const recovered = { ...previous, status: 'published' as const, platformPostId: input.platformPostId, providerReceiptId: input.providerReceiptId, attemptedAt: input.now };
  input.state.attempts[input.attemptId] = recovered;
  return recovered;
}

export function aggregatePublicationAttempts(attempts: PublicationAttempt[]): 'published' | 'partial' | 'failed' | 'unknown' {
  if (attempts.some(item => item.status === 'unknown')) return 'unknown';
  const successes = attempts.filter(item => item.status === 'published' && item.platformPostId && item.providerReceiptId).length;
  if (successes === attempts.length && attempts.length) return 'published';
  if (successes) return 'partial';
  return 'failed';
}

export function realPublishingCapabilities(evidence: PlatformCapabilityEvidence[] = [], now = new Date()): PublishingCapability[] {
  const platforms: PublishingCapability['platform'][] = ['youtube', 'facebook', 'instagram', 'tiktok', 'linkedin'];
  return platforms.map(platform => {
    const verified = evidence.filter(item => item.platform === platform && item.capability === 'publishing.official'
      && platformCapabilityEvidenceIsCurrent(item, now));
    return verified.length
      ? { platform, status: 'available', reason: 'provider_capability_verified', accountIds: [...new Set(verified.map(item => item.account_id))], verifiedAt: verified.map(item => item.verified_at).sort().at(-1) }
      : { platform, status: 'unavailable', reason: 'provider_publish_permission_not_verified' };
  });
}
import {settlePublicationAttempt} from './publicationAttemptSettlement.js';
