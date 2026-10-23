import { createHash } from 'node:crypto';
import { store } from '../storage/index.js';
import { evaluateSocialCandidateEvidence, scoreSocialDiscoveryCandidate } from '../../shared/socialInspirationStrategy.js';
import type { SocialAudienceRole, SocialCandidateEvidence, SocialDiscoveryPath, SocialProductionGapTask } from '../../shared/contracts/socialContentWorkflow.js';
import { assessAccountRelativeMomentum, buildCandidateG1, type CandidateG1, type PerformanceSnapshot, type VersionedCandidateEvidence } from './qualityOrchestration.js';

export const CANDIDATE_EVIDENCE_COLLECTION = 'social_candidate_evidence';
export const DISCOVERY_GAP_TASK_COLLECTION = 'social_discovery_gap_tasks';
export const REFERENCE_SELECTION_COLLECTION = 'social_reference_selections';

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface CandidateEvidenceInput {
  tenantId: string;
  candidateId: string;
  discoveryPath: SocialDiscoveryPath[];
  sceneIds?: string[];
  taskRelevance?: number;
  currentPerformance?: number | null;
  accountPlatformBaseline?: number | null;
  performanceSnapshots?: PerformanceSnapshot[];
  transferability?: number;
  mechanisms?: string[];
  limitations?: string[];
  evidenceRefs?: string[];
  novelty?: number | null;
  platform?: string;
  keywordTier?: 'broad' | 'medium' | 'evidence' | 'account' | 'unknown';
  audienceRole?: SocialAudienceRole;
  sourceText?: string;
  g1: Parameters<typeof buildCandidateG1>[0];
  now?: Date;
}

/** Append-only evidence writer. Identical inputs are idempotent; changed inputs create a new version. */
export async function persistCandidateEvidence(input: CandidateEvidenceInput): Promise<VersionedCandidateEvidence> {
  const immutableInput = { ...input, now: undefined };
  const inputFingerprint = fingerprint(immutableInput);
  const existing = await store.list<VersionedCandidateEvidence & { id: string; tenant_id: string }>(CANDIDATE_EVIDENCE_COLLECTION, {
    where: { tenant_id: input.tenantId, candidateId: input.candidateId }, sort: '-version', page: 1, perPage: 1,
  });
  const latest = existing.items[0];
  if (latest?.inputFingerprint === inputFingerprint) return latest;
  const momentum = assessAccountRelativeMomentum({
    currentPerformance: input.currentPerformance,
    accountPlatformBaseline: input.accountPlatformBaseline,
    snapshots: input.performanceSnapshots,
  });
  const base = evaluateSocialCandidateEvidence({
    inspirationId: input.candidateId,
    discoveryPath: input.discoveryPath,
    sceneIds: input.sceneIds,
    taskRelevance: input.taskRelevance,
    currentPerformance: input.currentPerformance,
    accountPlatformBaseline: input.accountPlatformBaseline,
    hasTimeSeries: momentum.consecutiveSnapshotGrowth === true,
    transferability: input.transferability,
    mechanisms: input.mechanisms,
    limitations: input.limitations,
    evidenceRefs: input.evidenceRefs,
    novelty: input.novelty,
  });
  const scoredEvidence = { ...base, momentum: { ...base.momentum, level: momentum.level, reasons: momentum.reasons } };
  const { businessModel, ...qualityScore } = scoreSocialDiscoveryCandidate({
    evidence: scoredEvidence,
    platform: input.platform,
    keywordTier: input.keywordTier,
    audienceRole: input.audienceRole,
    sourceText: input.sourceText,
    hasSource: Boolean(input.g1.sourceUrl && input.g1.sourceUrl !== 'unknown'),
    now: input.now,
  });
  const evidence: SocialCandidateEvidence = {
    ...scoredEvidence,
    qualityScore,
    classification: {
      businessModel,
      platform: input.platform || 'unknown',
      keywordTier: input.keywordTier ?? 'unknown',
    },
  };
  const g1 = buildCandidateG1(input.g1);
  const version = (latest?.version ?? 0) + 1;
  const createdAt = (input.now ?? new Date()).toISOString();
  const value: VersionedCandidateEvidence = {
    evidenceId: `candidate_evidence_${fingerprint({ tenantId: input.tenantId, candidateId: input.candidateId, version, inputFingerprint }).slice(0, 20)}`,
    version,
    tenantId: input.tenantId,
    candidateId: input.candidateId,
    inputFingerprint,
    evidence,
    g1,
    completeness: g1.missingFields.length === 0 ? 'complete' : g1.missingFields.length < 6 ? 'partial' : 'unknown',
    createdAt,
    supersedesEvidenceId: latest?.evidenceId ?? null,
  };
  const saved = await store.create(CANDIDATE_EVIDENCE_COLLECTION, { ...value, tenant_id: input.tenantId });
  if (!saved) throw new Error('candidate_evidence_storage_unavailable');
  return value;
}

export interface InventoryCandidate {
  candidateId: string;
  evidenceId: string;
  evidenceVersion: number;
  readiness: 'discovery_reference' | 'strategy_reference' | 'production_reference';
  taskRelevance: number;
  transferability: number;
  rightsClear: boolean;
  sceneIds: string[];
  sourceRef?: string | 'unknown';
}

export interface ReferenceSelection {
  status: 'selected' | 'needs_collection' | 'blocked';
  selected: InventoryCandidate[];
  reason: string;
  evidenceVersionRefs: string[];
}

export interface VersionedReferenceSelection extends ReferenceSelection {
  selectionId: string;
  version: number;
  tenantId: string;
  upstreamTaskRef: string;
  createdAt: string;
  supersedesSelectionId: string | null;
}

export class ReferenceSelector {
  select(input: { candidates: InventoryCandidate[]; requiredSceneIds?: string[]; minimumReferences?: number; requireProductionReady?: boolean }): ReferenceSelection {
    const required = new Set(input.requiredSceneIds ?? []);
    const minimum = Math.max(1, Math.floor(input.minimumReferences ?? 1));
    const eligible = input.candidates
      .filter(item => item.rightsClear)
      .filter(item => Boolean(item.sourceRef && item.sourceRef !== 'unknown'))
      .filter(item => !input.requireProductionReady || item.readiness === 'production_reference')
      .filter(item => required.size === 0 || item.sceneIds.some(sceneId => required.has(sceneId)))
      .filter(item => item.taskRelevance >= 0.7 && item.transferability >= 0.6)
      .sort((a, b) => b.taskRelevance + b.transferability - a.taskRelevance - a.transferability || a.candidateId.localeCompare(b.candidateId));
    if (eligible.length < minimum) return { status: 'needs_collection', selected: [], reason: 'inventory_evidence_insufficient', evidenceVersionRefs: [] };
    const selected = eligible.slice(0, minimum);
    return { status: 'selected', selected, reason: 'inventory_covered', evidenceVersionRefs: selected.map(item => `${item.evidenceId}@${item.evidenceVersion}`) };
  }
}

export async function persistReferenceSelection(input: {
  tenantId: string;
  upstreamTaskRef: string;
  selection: ReferenceSelection;
  now?: Date;
}): Promise<VersionedReferenceSelection> {
  const existing = await store.list<VersionedReferenceSelection & { id: string; tenant_id: string }>(REFERENCE_SELECTION_COLLECTION, {
    where: { tenant_id: input.tenantId, upstreamTaskRef: input.upstreamTaskRef }, sort: '-version', page: 1, perPage: 1,
  });
  const latest = existing.items[0];
  if (latest && fingerprint({
    status: latest.status, selected: latest.selected, reason: latest.reason, evidenceVersionRefs: latest.evidenceVersionRefs,
  }) === fingerprint(input.selection)) return latest;
  const version = (latest?.version ?? 0) + 1;
  const value: VersionedReferenceSelection = {
    ...input.selection,
    selectionId: `reference_selection_${fingerprint({ tenantId: input.tenantId, upstreamTaskRef: input.upstreamTaskRef, version, selection: input.selection }).slice(0, 20)}`,
    version,
    tenantId: input.tenantId,
    upstreamTaskRef: input.upstreamTaskRef,
    createdAt: (input.now ?? new Date()).toISOString(),
    supersedesSelectionId: latest?.selectionId ?? null,
  };
  const saved = await store.create(REFERENCE_SELECTION_COLLECTION, { ...value, tenant_id: input.tenantId });
  if (!saved) throw new Error('reference_selection_storage_unavailable');
  return value;
}

export type ProductionGapTask = SocialProductionGapTask;

export function createProductionGapTask(input: {
  tenantId: string;
  upstreamTaskRef: string;
  description: string;
  requiredSceneIds?: string[];
  minimumReferences?: number;
  requiredReadiness?: ProductionGapTask['taskGap']['requiredReadiness'];
  requestedModes?: ProductionGapTask['taskGap']['requestedModes'];
  budgetLimitCny: number;
  now?: Date;
}): ProductionGapTask {
  const createdAt = (input.now ?? new Date()).toISOString();
  const requestedModes: ProductionGapTask['taskGap']['requestedModes'] = input.requestedModes?.length
    ? [...new Set(input.requestedModes)]
    : ['momentum', 'account', 'innovation'];
  const taskGap = {
    description: input.description.trim(),
    requiredSceneIds: [...new Set(input.requiredSceneIds?.filter(Boolean) ?? [])],
    minimumReferences: Math.max(1, Math.floor(input.minimumReferences ?? 1)),
    requiredReadiness: input.requiredReadiness ?? 'production_reference' as const,
    requestedModes,
  };
  if (!taskGap.description) throw new Error('production_gap_description_required');
  const limitCny = Math.max(0, Number(input.budgetLimitCny) || 0);
  return {
    gapTaskId: `discovery_gap_${fingerprint({ tenantId: input.tenantId, upstreamTaskRef: input.upstreamTaskRef, taskGap, limitCny }).slice(0, 20)}`,
    tenantId: input.tenantId,
    upstreamTaskRef: input.upstreamTaskRef,
    taskGap,
    budget: { currency: 'CNY', limitCny, spentCny: 0 },
    status: 'collecting', attemptCount: 0, lastError: null, lastAttemptAt: null,
    runRefs: [], selectedEvidenceRefs: [], referenceSelectionRef: null, stopReason: null,
    createdAt, updatedAt: createdAt,
  };
}

export function advanceProductionGapTask(input: {
  task: ProductionGapTask;
  selection: ReferenceSelection;
  addedCostCny?: number | null;
  runRef?: string;
  referenceSelectionRef?: ProductionGapTask['referenceSelectionRef'];
  selectionSource?: 'inventory' | 'collection';
  now?: Date;
}): ProductionGapTask {
  if (input.task.status !== 'collecting') return input.task;
  const spentCny = Math.min(input.task.budget.limitCny, input.task.budget.spentCny + Math.max(0, input.addedCostCny ?? 0));
  const runRefs = input.runRef ? [...new Set([...input.task.runRefs, input.runRef])] : input.task.runRefs;
  const updatedAt = (input.now ?? new Date()).toISOString();
  if (input.selection.status === 'selected') return {
    ...input.task, budget: { ...input.task.budget, spentCny }, runRefs, status: 'ready_to_resume',
    stopReason: input.selectionSource === 'collection' || input.runRef ? 'evidence_satisfied' : 'inventory_covered',
    selectedEvidenceRefs: input.selection.evidenceVersionRefs,
    referenceSelectionRef: input.referenceSelectionRef ?? input.task.referenceSelectionRef,
    lastError: null, updatedAt,
  };
  if (spentCny >= input.task.budget.limitCny) return {
    ...input.task, budget: { ...input.task.budget, spentCny }, runRefs, status: 'blocked', stopReason: 'budget_exhausted', updatedAt,
  };
  return { ...input.task, budget: { ...input.task.budget, spentCny }, runRefs, updatedAt };
}

export function recordProductionGapAttempt(task: ProductionGapTask, error: unknown, now = new Date()): ProductionGapTask {
  return {
    ...task,
    attemptCount: task.attemptCount + 1,
    lastAttemptAt: now.toISOString(),
    lastError: error instanceof Error ? error.message : String(error || 'production_gap_attempt_failed'),
    updatedAt: now.toISOString(),
  };
}

export function completeProductionGapResume(task: ProductionGapTask, now = new Date()): ProductionGapTask {
  if (task.status !== 'ready_to_resume') return task;
  return { ...task, status: 'resumed', lastError: null, updatedAt: now.toISOString() };
}

export async function saveProductionGapTask(task: ProductionGapTask): Promise<void> {
  const existing = await store.list<{ id: string }>(DISCOVERY_GAP_TASK_COLLECTION, { where: { tenant_id: task.tenantId, gapTaskId: task.gapTaskId }, page: 1, perPage: 1 });
  const {tenantId,...persistedTask}=task;
  const payload = {
    ...persistedTask,
    // PocketBase normalizes optional text nulls to an empty string. Persist
    // that canonical form so the strict read-after-write verification does
    // not report a successful update as unavailable.
    stopReason: task.stopReason ?? '',
    lastError: task.lastError ?? '',
    lastAttemptAt: task.lastAttemptAt ?? '',
    // Compatibility projections for rows created before the authoritative gap contract.
    productionGap: task.taskGap.description,
    budgetLimitCny: task.budget.limitCny,
    spentCny: task.budget.spentCny,
    tenant_id: task.tenantId,
  };
  const saved = existing.items[0] ? await store.update(DISCOVERY_GAP_TASK_COLLECTION, existing.items[0].id, payload) : await store.create(DISCOVERY_GAP_TASK_COLLECTION, payload);
  if (!saved) throw new Error('production_gap_task_storage_unavailable');
}
