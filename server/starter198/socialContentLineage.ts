import type {
  SocialDirectorBrief,
  SocialInspirationHandoff,
  SocialProductionResult,
} from '../../shared/contracts/socialContentWorkflow.js';
import type { VersionedSocialRef } from '../../shared/contracts/socialProgram.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { socialJson, socialObject, socialRequestHash, socialText } from './socialContentValidation.js';

export type SocialProductionReturnReason = 'asset_missing' | 'continuity' | 'dialogue' | 'goal_degraded' | 'production_failed' | 'partial_rework';

export interface SocialContentAuthorityLineage {
  schemaVersion: 'social-content-authority-lineage.v1';
  lineageId: string;
  version: string;
  programRef: VersionedSocialRef;
  packageRef: VersionedSocialRef;
  weeklyTaskRef: VersionedSocialRef;
  publicationTaskRef: VersionedSocialRef;
  businessGoalRef: VersionedSocialRef;
  enterpriseProfileRef: VersionedSocialRef;
  enterpriseFactRefs: VersionedSocialRef[];
  referenceSelectionRef: VersionedSocialRef;
  candidateEvidenceRefs: VersionedSocialRef[];
  inspirationHandoffRefs: VersionedSocialRef[];
  directorBriefRef: VersionedSocialRef;
  productionResultRef: VersionedSocialRef | null;
  upstreamFingerprint: string;
  invalidation: {
    status: 'valid' | 'partially_invalid' | 'invalid';
    affectedObjects: Array<'handoff' | 'director_brief' | 'weekly_task'>;
    affectedSceneIds: string[];
    reasons: string[];
  };
  createdAt: string;
  recordHash: string;
}

export interface SocialContentReturnQueueItem {
  queueItemId: string;
  lineageId: string;
  lineageVersion: string;
  weeklyTaskRef: VersionedSocialRef;
  returnToTaskRef: VersionedSocialRef;
  productionResultRef: VersionedSocialRef | null;
  sceneId: string | null;
  affectedSceneIds: string[];
  failureScope: 'full_task' | 'scene';
  reason: SocialProductionReturnReason;
  destination: 'reshoot_queue' | 'weekly_task';
  action: 'supply_asset' | 'repair_continuity' | 'rewrite_dialogue' | 'replan_goal' | 'retry_production' | 'retry_scenes';
  status: 'pending';
  createdAt: string;
}

function ref(type: string, id: string, version: string | number): VersionedSocialRef {
  return { type, id, version: Number(version) };
}

function hashPayload<T extends { recordHash: string }>(value: T): string {
  const { recordHash: _recordHash, ...payload } = value;
  return socialRequestHash(payload);
}

function assertLineage(value: SocialContentAuthorityLineage): void {
  if (value.schemaVersion !== 'social-content-authority-lineage.v1' || hashPayload(value) !== value.recordHash) {
    throw new Error('social_content_lineage_integrity_violation');
  }
}

export function buildSocialContentAuthorityLineage(input: {
  version: string;
  programRef: VersionedSocialRef;
  packageRef: VersionedSocialRef;
  weeklyTaskRef: VersionedSocialRef;
  publicationTaskRef: VersionedSocialRef;
  businessGoalRef: VersionedSocialRef;
  enterpriseProfileRef: VersionedSocialRef;
  enterpriseFactRefs: VersionedSocialRef[];
  referenceSelectionRef: VersionedSocialRef;
  candidateEvidenceRefs: VersionedSocialRef[];
  inspirationHandoffs: SocialInspirationHandoff[];
  directorBrief: SocialDirectorBrief;
  productionResult?: SocialProductionResult | null;
  now?: Date;
}): SocialContentAuthorityLineage {
  if (input.productionResult && (!Number.isSafeInteger(Number(input.productionResult.version)) || Number(input.productionResult.version) < 1)) {
    throw new Error('social_content_production_version_invalid');
  }
  const upstream = {
    programRef: input.programRef, packageRef: input.packageRef, weeklyTaskRef: input.weeklyTaskRef,
    publicationTaskRef: input.publicationTaskRef, businessGoalRef: input.businessGoalRef,
    enterpriseProfileRef: input.enterpriseProfileRef, enterpriseFactRefs: input.enterpriseFactRefs,
    referenceSelectionRef: input.referenceSelectionRef, candidateEvidenceRefs: input.candidateEvidenceRefs,
  };
  const lineageId = `content_lineage_${socialRequestHash({ program: input.programRef.id, task: input.weeklyTaskRef.id, publication: input.publicationTaskRef.id }).slice(0, 20)}`;
  const value: SocialContentAuthorityLineage = {
    schemaVersion: 'social-content-authority-lineage.v1', lineageId, version: input.version,
    ...structuredClone(upstream),
    inspirationHandoffRefs: input.inspirationHandoffs.map(item => ref('inspiration_handoff', item.handoffId ?? item.inspirationId, item.version ?? item.analysisVersion)),
    directorBriefRef: ref('director_brief', input.directorBrief.directorBriefId, input.directorBrief.version),
    productionResultRef: input.productionResult
      ? ref('production_result', input.productionResult.productionResultId, input.productionResult.version) : null,
    upstreamFingerprint: socialRequestHash(upstream),
    invalidation: { status: 'valid', affectedObjects: [], affectedSceneIds: [], reasons: [] },
    createdAt: (input.now ?? new Date()).toISOString(), recordHash: '',
  };
  value.recordHash = hashPayload(value);
  return value;
}

export function invalidateSocialContentLineage(input: {
  lineage: SocialContentAuthorityLineage;
  directorBrief: SocialDirectorBrief;
  next: Pick<SocialContentAuthorityLineage, 'packageRef' | 'weeklyTaskRef' | 'businessGoalRef' | 'enterpriseProfileRef' | 'enterpriseFactRefs' | 'referenceSelectionRef' | 'candidateEvidenceRefs'>;
}): SocialContentAuthorityLineage {
  assertLineage(input.lineage);
  const changed = (left: unknown, right: unknown) => socialRequestHash(left) !== socialRequestHash(right);
  const reasons: string[] = [];
  const affectedObjects = new Set<'handoff' | 'director_brief' | 'weekly_task'>();
  const affectedScenes = new Set<string>();
  if (changed(input.lineage.referenceSelectionRef, input.next.referenceSelectionRef)
    || changed(input.lineage.candidateEvidenceRefs, input.next.candidateEvidenceRefs)) {
    reasons.push('reference_evidence_changed'); affectedObjects.add('handoff'); affectedObjects.add('director_brief');
    input.directorBrief.scenes.filter(scene => scene.referenceShotId).forEach(scene => affectedScenes.add(scene.sceneId));
  }
  if (changed(input.lineage.enterpriseFactRefs, input.next.enterpriseFactRefs)
    || changed(input.lineage.enterpriseProfileRef, input.next.enterpriseProfileRef)) {
    reasons.push('enterprise_facts_changed'); affectedObjects.add('director_brief');
    const previous = new Set(input.lineage.enterpriseFactRefs.map(item => `${item.type}:${item.id}@${item.version}`));
    const next = new Set(input.next.enterpriseFactRefs.map(item => `${item.type}:${item.id}@${item.version}`));
    input.directorBrief.scenes.filter(scene => scene.truthBoundary.confirmedFactRefs.some(item => previous.has(item) || next.has(item)))
      .forEach(scene => affectedScenes.add(scene.sceneId));
  }
  if (changed(input.lineage.businessGoalRef, input.next.businessGoalRef)
    || changed(input.lineage.packageRef, input.next.packageRef)
    || changed(input.lineage.weeklyTaskRef, input.next.weeklyTaskRef)) {
    reasons.push('weekly_authority_changed'); affectedObjects.add('weekly_task'); affectedObjects.add('director_brief');
  }
  const invalidation = {
    status: affectedObjects.has('weekly_task') || affectedObjects.has('handoff') ? 'invalid' as const
      : affectedObjects.size ? 'partially_invalid' as const : 'valid' as const,
    affectedObjects: [...affectedObjects], affectedSceneIds: [...affectedScenes], reasons,
  };
  const value = { ...input.lineage, invalidation, recordHash: '' };
  value.recordHash = hashPayload(value);
  return value;
}

async function appendVersion(repository: Starter198Repository, tenantId: string, collection: typeof STARTER_COLLECTIONS.socialInspirationHandoffVersions | typeof STARTER_COLLECTIONS.socialDirectorBriefVersions, identity: Record<string, string>, payload: unknown): Promise<StarterRecord> {
  const recordHash = socialRequestHash(payload);
  const existing = await repository.list(collection, tenantId, { where: identity, perPage: 2 });
  if (existing.totalItems > 1) throw new Error('social_content_authority_storage_integrity_violation');
  if (existing.items[0]) {
    if (socialText(existing.items[0].record_hash) !== recordHash) throw new Error('social_content_authority_version_conflict');
    return existing.items[0];
  }
  return repository.create(collection, tenantId, { ...identity, payload, record_hash: recordHash, created_at: new Date().toISOString() });
}

export async function persistAuthoritativeContentBundle(input: {
  repository: Starter198Repository; tenantId: string; lineage: SocialContentAuthorityLineage;
  handoffs: SocialInspirationHandoff[]; directorBrief: SocialDirectorBrief;
}): Promise<void> {
  assertLineage(input.lineage);
  for (const handoff of input.handoffs) await appendVersion(input.repository, input.tenantId, STARTER_COLLECTIONS.socialInspirationHandoffVersions, {
    handoff_id: handoff.handoffId ?? handoff.inspirationId, handoff_version: handoff.version ?? handoff.analysisVersion,
  }, handoff);
  await appendVersion(input.repository, input.tenantId, STARTER_COLLECTIONS.socialDirectorBriefVersions, {
    director_brief_id: input.directorBrief.directorBriefId, director_brief_version: input.directorBrief.version,
  }, input.directorBrief);
  const existing = await input.repository.list(STARTER_COLLECTIONS.socialContentLineage, input.tenantId, {
    where: { lineage_id: input.lineage.lineageId, lineage_version: input.lineage.version }, perPage: 2,
  });
  if (existing.totalItems > 1) throw new Error('social_content_lineage_integrity_violation');
  if (existing.items[0]) {
    if (socialText(existing.items[0].record_hash) !== input.lineage.recordHash) throw new Error('social_content_lineage_version_conflict');
    return;
  }
  await input.repository.create(STARTER_COLLECTIONS.socialContentLineage, input.tenantId, {
    lineage_id: input.lineage.lineageId, lineage_version: input.lineage.version,
    weekly_task_id: input.lineage.weeklyTaskRef.id, production_result_id: input.lineage.productionResultRef?.id ?? '',
    payload: input.lineage, record_hash: input.lineage.recordHash, created_at: input.lineage.createdAt,
  });
}

export function routeProductionReturn(input: {
  lineage: SocialContentAuthorityLineage; reason: SocialProductionReturnReason; sceneId?: string | null;
  affectedSceneIds?: string[]; productionResultRef?: VersionedSocialRef | null; now?: Date;
}): SocialContentReturnQueueItem {
  assertLineage(input.lineage);
  const route = {
    asset_missing: ['reshoot_queue', 'supply_asset'], continuity: ['reshoot_queue', 'repair_continuity'],
    dialogue: ['weekly_task', 'rewrite_dialogue'], goal_degraded: ['weekly_task', 'replan_goal'],
    production_failed: ['weekly_task', 'retry_production'], partial_rework: ['reshoot_queue', 'retry_scenes'],
  }[input.reason] as [SocialContentReturnQueueItem['destination'], SocialContentReturnQueueItem['action']];
  const sceneId = input.sceneId ?? null;
  const affectedSceneIds = [...new Set([...(input.affectedSceneIds ?? []), ...(sceneId ? [sceneId] : [])])];
  const failureScope = input.reason === 'production_failed' || !affectedSceneIds.length ? 'full_task' as const : 'scene' as const;
  if (input.reason === 'partial_rework' && !affectedSceneIds.length) throw new Error('social_content_partial_rework_scene_required');
  const productionResultRef = input.productionResultRef ?? input.lineage.productionResultRef;
  return {
    queueItemId: `content_return_${socialRequestHash({ lineageId: input.lineage.lineageId, version: input.lineage.version, reason: input.reason, affectedSceneIds, productionResultRef }).slice(0, 20)}`,
    lineageId: input.lineage.lineageId, lineageVersion: input.lineage.version,
    weeklyTaskRef: input.lineage.weeklyTaskRef, returnToTaskRef: input.lineage.weeklyTaskRef,
    productionResultRef: productionResultRef ?? null, sceneId, affectedSceneIds, failureScope, reason: input.reason,
    destination: route[0], action: route[1], status: 'pending', createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export async function persistProductionReturn(repository: Starter198Repository, tenantId: string, item: SocialContentReturnQueueItem): Promise<StarterRecord> {
  const existing = await repository.list(STARTER_COLLECTIONS.socialContentReworkQueue, tenantId, { where: { queue_item_id: item.queueItemId }, perPage: 2 });
  if (existing.totalItems > 1) throw new Error('social_content_return_queue_integrity_violation');
  if (existing.items[0]) return existing.items[0];
  return repository.create(STARTER_COLLECTIONS.socialContentReworkQueue, tenantId, {
    queue_item_id: item.queueItemId, weekly_task_id: item.weeklyTaskRef.id, destination: item.destination,
    weekly_task_version: item.weeklyTaskRef.version, lineage_id: item.lineageId, lineage_version: item.lineageVersion,
    production_result_id: item.productionResultRef?.id ?? '', scene_id: item.sceneId ?? '', action: item.action,
    failure_scope: item.failureScope, reason: item.reason, status: item.status, payload: item, created_at: item.createdAt,
  });
}

export function parseSocialContentAuthorityLineage(record: StarterRecord): SocialContentAuthorityLineage {
  const value = socialObject(socialJson(record.payload)) as unknown as SocialContentAuthorityLineage | null;
  if (!value) throw new Error('social_content_lineage_integrity_violation');
  assertLineage(value); return value;
}
