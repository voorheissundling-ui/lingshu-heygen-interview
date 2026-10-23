import type { StoredSocialDirectorPlan } from './socialContentDirectorPlan.js';
import { parseStoredSocialDirectorPlan } from './socialContentDirectorPlan.js';
import type {
  SocialEnterpriseFactVersion,
  StoredSocialScriptBaseline,
  VerifiedSocialScriptContext,
} from './socialContentScriptBaseline.js';
import {
  STARTER_COLLECTIONS,
  type Starter198Repository,
  type StarterRecord,
} from './repository.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';

export const SOCIAL_DIRECTOR_PLAN_VERSION_SCHEMA = 'social-content-director-plan-version.v1';
export const SOCIAL_DIRECTOR_FACT_SNAPSHOT_SCHEMA = 'social-content-director-fact-snapshot.v1';
export const SOCIAL_DIRECTOR_ARTIFACT_REFERENCE_SCHEMA = 'social-content-director-plan-reference.v1';

type SocialDirectorFactSource = VerifiedSocialScriptContext['source'] | 'user_product_association';

export interface SocialDirectorFactSnapshot {
  schemaVersion: typeof SOCIAL_DIRECTOR_FACT_SNAPSHOT_SCHEMA;
  captureMode: 'verified_context' | 'legacy_plan_only';
  baselineVersion: string;
  baselineHash: string | null;
  groundingVersion: string | null;
  enterpriseFactVersion?: SocialEnterpriseFactVersion | null;
  source: SocialDirectorFactSource;
  productName: string | null;
  confidence: number;
  verifiedFactKeys: string[];
  facts: Array<{ key: string; label: string; value: string }>;
  capturedAt: string;
  snapshotHash: string;
}

export interface StoredSocialDirectorPlanVersion {
  schemaVersion: typeof SOCIAL_DIRECTOR_PLAN_VERSION_SCHEMA;
  taskId: string;
  directorPlanId: string;
  version: string;
  previousVersion: string | null;
  lineageHash: string;
  status: StoredSocialDirectorPlan['status'];
  lockStatus: StoredSocialDirectorPlan['lockStatus'];
  plan: StoredSocialDirectorPlan;
  factSnapshot: SocialDirectorFactSnapshot;
  factSnapshotHash: string;
  materialSnapshot: StoredSocialDirectorPlan['materialSnapshot'];
  materialSnapshotHash: string;
  recordHash: string;
  createdAt: string;
  createdBy: 'director_agent';
}

export interface SocialDirectorArtifactReference {
  schemaVersion: typeof SOCIAL_DIRECTOR_ARTIFACT_REFERENCE_SCHEMA;
  directorPlanId: string;
  version: string;
  lineageHash: string;
  factSnapshotHash: string;
  materialSnapshotHash: string;
  recordHash: string;
}

function storageIntegrityError(): SocialContentWorkflowError {
  return new SocialContentWorkflowError('social_content_director_plan_version_invalid', 503);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function storageText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return socialText(value);
}

function safeIdentity(value: unknown): string {
  const parsed = socialText(value);
  if (!parsed || parsed.length > 200 || /[\u0000-\u001f]/.test(parsed)) throw storageIntegrityError();
  return parsed;
}

function normalizedConfidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw storageIntegrityError();
  return Number(parsed.toFixed(4));
}

function snapshotPayload(snapshot: Omit<SocialDirectorFactSnapshot, 'snapshotHash'>): Omit<SocialDirectorFactSnapshot, 'snapshotHash'> {
  return snapshot;
}

function parseFactSnapshot(value: unknown): SocialDirectorFactSnapshot {
  const row = socialObject(socialJson(value));
  const factsValue = socialJson(row?.facts);
  const keysValue = socialJson(row?.verifiedFactKeys);
  const captureMode = socialText(row?.captureMode) as SocialDirectorFactSnapshot['captureMode'];
  const source = socialText(row?.source) as SocialDirectorFactSource;
  const hasEnterpriseFactVersion = Object.prototype.hasOwnProperty.call(row ?? {}, 'enterpriseFactVersion');
  const factVersionRow = socialObject(row?.enterpriseFactVersion);
  if (!row
    || socialText(row.schemaVersion) !== SOCIAL_DIRECTOR_FACT_SNAPSHOT_SCHEMA
    || !['verified_context', 'legacy_plan_only'].includes(captureMode)
    || !/^\d+$/.test(socialText(row.baselineVersion))
    || !['enterprise_product', 'enterprise_profile', 'user_product_association', 'none'].includes(source)
    || !Array.isArray(keysValue)
    || !Array.isArray(factsValue)
    || !socialText(row.capturedAt)
    || !/^[a-f0-9]{64}$/i.test(socialText(row.snapshotHash))) {
    throw storageIntegrityError();
  }
  const baselineHash = row.baselineHash === null || row.baselineHash === undefined || row.baselineHash === ''
    ? null : socialText(row.baselineHash).toLocaleLowerCase();
  const groundingVersion = row.groundingVersion === null || row.groundingVersion === undefined || row.groundingVersion === ''
    ? null : socialText(row.groundingVersion);
  const productName = row.productName === null || row.productName === undefined || row.productName === ''
    ? null : socialText(row.productName);
  const enterpriseFactVersion = factVersionRow ? {
    id: socialText(factVersionRow.id),
    revision: Number(factVersionRow.revision),
    contentHash: socialText(factVersionRow.contentHash),
  } : null;
  if ((baselineHash && !/^[a-f0-9]{64}$/.test(baselineHash))
    || (captureMode === 'verified_context' && !baselineHash)
    || (captureMode === 'legacy_plan_only' && (baselineHash || factsValue.length || keysValue.length))
    || (hasEnterpriseFactVersion && row.enterpriseFactVersion !== null
      && (!enterpriseFactVersion
        || !enterpriseFactVersion.id
        || !Number.isSafeInteger(enterpriseFactVersion.revision)
        || enterpriseFactVersion.revision < 1
        || !enterpriseFactVersion.contentHash))) {
    throw storageIntegrityError();
  }
  const verifiedFactKeys = keysValue.map(socialText).filter(Boolean);
  if (verifiedFactKeys.length !== keysValue.length || new Set(verifiedFactKeys).size !== verifiedFactKeys.length) {
    throw storageIntegrityError();
  }
  const facts = factsValue.map(value => {
    const fact = socialObject(value);
    const key = socialText(fact?.key);
    const label = socialText(fact?.label);
    const factValue = socialText(fact?.value);
    if (!fact || !key || !label || !factValue || !verifiedFactKeys.includes(key)) throw storageIntegrityError();
    return { key, label, value: factValue };
  });
  if (new Set(facts.map(fact => fact.key)).size !== facts.length) throw storageIntegrityError();
  const payload: Omit<SocialDirectorFactSnapshot, 'snapshotHash'> = {
    schemaVersion: SOCIAL_DIRECTOR_FACT_SNAPSHOT_SCHEMA,
    captureMode,
    baselineVersion: socialText(row.baselineVersion),
    baselineHash,
    groundingVersion,
    ...(hasEnterpriseFactVersion ? { enterpriseFactVersion } : {}),
    source,
    productName,
    confidence: normalizedConfidence(row.confidence),
    verifiedFactKeys,
    facts,
    capturedAt: socialText(row.capturedAt),
  };
  const snapshotHash = socialText(row.snapshotHash).toLocaleLowerCase();
  if (socialRequestHash(snapshotPayload(payload)) !== snapshotHash) throw storageIntegrityError();
  return { ...payload, snapshotHash };
}

/**
 * Capture only facts that the frozen baseline explicitly says it used. The
 * task title/objective and visual-analysis prose are intentionally absent.
 */
export function buildSocialDirectorFactSnapshot(input: {
  plan: StoredSocialDirectorPlan;
  baseline?: StoredSocialScriptBaseline | null;
  verifiedContext?: VerifiedSocialScriptContext | null;
}): SocialDirectorFactSnapshot {
  const parsedPlan = parseStoredSocialDirectorPlan(input.plan);
  if (!parsedPlan) throw storageIntegrityError();
  const baseline = input.baseline;
  const baselineMatches = Boolean(baseline && baseline.version === parsedPlan.scriptSource.baselineVersion);
  if (!baselineMatches) {
    const payload: Omit<SocialDirectorFactSnapshot, 'snapshotHash'> = {
      schemaVersion: SOCIAL_DIRECTOR_FACT_SNAPSHOT_SCHEMA,
      captureMode: 'legacy_plan_only',
      baselineVersion: parsedPlan.scriptSource.baselineVersion,
      baselineHash: null,
      groundingVersion: null,
      enterpriseFactVersion: null,
      source: parsedPlan.scriptSource.verifiedKnowledgeSource,
      productName: null,
      confidence: Number(Math.max(0, Math.min(1, parsedPlan.scriptSource.matchConfidence)).toFixed(4)),
      verifiedFactKeys: [],
      facts: [],
      capturedAt: parsedPlan.createdAt,
    };
    return { ...payload, snapshotHash: socialRequestHash(snapshotPayload(payload)) };
  }

  const exactBaseline = baseline!;
  const enterpriseFactVersion = exactBaseline.enterpriseFactVersion ?? null;
  const association = exactBaseline.match?.userProductAssociation;
  const knowledgeSource = exactBaseline.match?.verifiedKnowledgeSource ?? 'none';
  const source: SocialDirectorFactSource = knowledgeSource === 'none' && association
    ? 'user_product_association'
    : knowledgeSource;
  const verifiedFactKeys = [...new Set(exactBaseline.match?.verifiedFactKeys ?? [])].filter(Boolean);
  const context = input.verifiedContext ?? null;
  if (enterpriseFactVersion) {
    const contextVersion = context?.factVersion;
    if (!contextVersion
      || contextVersion.id !== enterpriseFactVersion.id
      || contextVersion.revision !== enterpriseFactVersion.revision
      || contextVersion.contentHash !== enterpriseFactVersion.contentHash) {
      throw new SocialContentWorkflowError('social_content_director_fact_snapshot_version_mismatch', 409);
    }
  }
  if (!['none', 'user_product_association'].includes(source) && (!context || context.source !== source)) {
    throw new SocialContentWorkflowError('social_content_director_fact_snapshot_unavailable', 503);
  }
  const facts = ['none', 'user_product_association'].includes(source) ? [] : (context?.facts ?? [])
    .filter(fact => verifiedFactKeys.includes(socialText(fact.key)))
    .map(fact => ({ key: socialText(fact.key), label: socialText(fact.label), value: socialText(fact.value) }))
    .filter(fact => fact.key && fact.label && fact.value);
  if (['none', 'user_product_association'].includes(source) && verifiedFactKeys.length
    || (!['none', 'user_product_association'].includes(source)
      && facts.length !== verifiedFactKeys.length)) {
    throw new SocialContentWorkflowError('social_content_director_fact_snapshot_unavailable', 503);
  }
  const payload: Omit<SocialDirectorFactSnapshot, 'snapshotHash'> = {
    schemaVersion: SOCIAL_DIRECTOR_FACT_SNAPSHOT_SCHEMA,
    captureMode: 'verified_context',
    baselineVersion: exactBaseline.version,
    baselineHash: socialRequestHash(exactBaseline),
    groundingVersion: socialText(exactBaseline.groundingVersion) || null,
    enterpriseFactVersion: enterpriseFactVersion ? { ...enterpriseFactVersion } : null,
    source,
    productName: source === 'enterprise_product' ? context?.productName ?? null : null,
    confidence: Number(Math.max(0, Math.min(1,
      ['none', 'user_product_association'].includes(source)
        ? association?.confidence ?? exactBaseline.match?.confidence ?? 0
        : context?.confidence ?? exactBaseline.match?.confidence ?? 0)).toFixed(4)),
    verifiedFactKeys,
    facts,
    capturedAt: parsedPlan.createdAt,
  };
  return { ...payload, snapshotHash: socialRequestHash(snapshotPayload(payload)) };
}

function versionRecordPayload(
  record: Omit<StoredSocialDirectorPlanVersion, 'recordHash'>,
): Omit<StoredSocialDirectorPlanVersion, 'recordHash'> {
  return record;
}

function buildVersionRecord(input: {
  taskId: string;
  plan: StoredSocialDirectorPlan;
  factSnapshot: SocialDirectorFactSnapshot;
}): StoredSocialDirectorPlanVersion {
  const plan = parseStoredSocialDirectorPlan(input.plan);
  if (!plan) throw storageIntegrityError();
  const taskId = safeIdentity(input.taskId);
  const factSnapshot = parseFactSnapshot(input.factSnapshot);
  if (factSnapshot.baselineVersion !== plan.scriptSource.baselineVersion
    || (factSnapshot.source === 'user_product_association'
      ? socialText(plan.scriptSource.verifiedKnowledgeSource) !== 'user_product_association'
      : factSnapshot.source !== plan.scriptSource.verifiedKnowledgeSource)) throw storageIntegrityError();
  const materialSnapshot = cloneJson(plan.materialSnapshot);
  const materialSnapshotHash = socialRequestHash(materialSnapshot);
  const payload: Omit<StoredSocialDirectorPlanVersion, 'recordHash'> = {
    schemaVersion: SOCIAL_DIRECTOR_PLAN_VERSION_SCHEMA,
    taskId,
    directorPlanId: plan.directorPlanId,
    version: plan.version,
    previousVersion: plan.revision.previousVersion,
    lineageHash: plan.lineageHash,
    status: plan.status,
    lockStatus: plan.lockStatus,
    plan: cloneJson(plan),
    factSnapshot: cloneJson(factSnapshot),
    factSnapshotHash: factSnapshot.snapshotHash,
    materialSnapshot,
    materialSnapshotHash,
    createdAt: plan.createdAt,
    createdBy: 'director_agent',
  };
  return { ...payload, recordHash: socialRequestHash(versionRecordPayload(payload)) };
}

export function parseStoredSocialDirectorPlanVersion(value: unknown): StoredSocialDirectorPlanVersion {
  const row = socialObject(socialJson(value));
  const plan = parseStoredSocialDirectorPlan(socialJson(row?.plan));
  const factSnapshot = parseFactSnapshot(socialJson(row?.fact_snapshot ?? row?.factSnapshot));
  const materialValue = socialJson(row?.material_snapshot ?? row?.materialSnapshot);
  const materialSnapshot = Array.isArray(materialValue)
    ? materialValue as StoredSocialDirectorPlan['materialSnapshot'] : null;
  const version = storageText(row?.plan_version ?? row?.version);
  const previousVersionValue = row?.previous_version ?? row?.previousVersion;
  const previousVersion = previousVersionValue === null || previousVersionValue === undefined || previousVersionValue === ''
    ? null : storageText(previousVersionValue);
  if (!row || socialText(row.schema_version ?? row.schemaVersion) !== SOCIAL_DIRECTOR_PLAN_VERSION_SCHEMA
    || !plan || !materialSnapshot
    || !/^\d+$/.test(version)
    || (previousVersion !== null && !/^\d+$/.test(previousVersion))
    || !/^[a-f0-9]{64}$/i.test(socialText(row.lineage_hash ?? row.lineageHash))
    || !/^[a-f0-9]{64}$/i.test(socialText(row.fact_snapshot_hash ?? row.factSnapshotHash))
    || !/^[a-f0-9]{64}$/i.test(socialText(row.material_snapshot_hash ?? row.materialSnapshotHash))
    || !/^[a-f0-9]{64}$/i.test(socialText(row.record_hash ?? row.recordHash))) {
    throw storageIntegrityError();
  }
  const record: Omit<StoredSocialDirectorPlanVersion, 'recordHash'> = {
    schemaVersion: SOCIAL_DIRECTOR_PLAN_VERSION_SCHEMA,
    taskId: safeIdentity(row.task_id ?? row.taskId),
    directorPlanId: socialText(row.director_plan_id ?? row.directorPlanId),
    version,
    previousVersion,
    lineageHash: socialText(row.lineage_hash ?? row.lineageHash).toLocaleLowerCase(),
    status: socialText(row.status) as StoredSocialDirectorPlan['status'],
    lockStatus: socialText(row.lock_status ?? row.lockStatus) as StoredSocialDirectorPlan['lockStatus'],
    plan,
    factSnapshot,
    factSnapshotHash: socialText(row.fact_snapshot_hash ?? row.factSnapshotHash).toLocaleLowerCase(),
    materialSnapshot,
    materialSnapshotHash: socialText(row.material_snapshot_hash ?? row.materialSnapshotHash).toLocaleLowerCase(),
    createdAt: socialText(row.created_at ?? row.createdAt),
    createdBy: socialText(row.created_by ?? row.createdBy) as 'director_agent',
  };
  const recordHash = socialText(row.record_hash ?? row.recordHash).toLocaleLowerCase();
  if (record.directorPlanId !== plan.directorPlanId
    || record.version !== plan.version
    || record.previousVersion !== plan.revision.previousVersion
    || (record.previousVersion === null
      ? record.version !== '1'
      : Number(record.version) !== Number(record.previousVersion) + 1)
    || record.lineageHash !== plan.lineageHash
    || record.status !== plan.status
    || record.lockStatus !== plan.lockStatus
    || record.createdAt !== plan.createdAt
    || record.createdBy !== 'director_agent'
    || factSnapshot.baselineVersion !== plan.scriptSource.baselineVersion
    || record.factSnapshotHash !== factSnapshot.snapshotHash
    || socialRequestHash(materialSnapshot) !== record.materialSnapshotHash
    || socialRequestHash(plan.materialSnapshot) !== record.materialSnapshotHash
    || socialRequestHash(versionRecordPayload(record)) !== recordHash) {
    throw storageIntegrityError();
  }
  return { ...record, recordHash };
}

function storageFields(record: StoredSocialDirectorPlanVersion): Record<string, unknown> {
  return {
    schema_version: record.schemaVersion,
    task_id: record.taskId,
    director_plan_id: record.directorPlanId,
    plan_version: record.version,
    previous_version: record.previousVersion ?? '',
    lineage_hash: record.lineageHash,
    status: record.status,
    lock_status: record.lockStatus,
    plan: cloneJson(record.plan),
    fact_snapshot: cloneJson(record.factSnapshot),
    fact_snapshot_hash: record.factSnapshotHash,
    material_snapshot: cloneJson(record.materialSnapshot),
    material_snapshot_hash: record.materialSnapshotHash,
    record_hash: record.recordHash,
    created_by: record.createdBy,
    created_at: record.createdAt,
  };
}

async function existingVersion(input: {
  repository: Starter198Repository;
  tenantId: string;
  directorPlanId: string;
  version: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialDirectorPlanVersions, input.tenantId, {
    where: { director_plan_id: input.directorPlanId, plan_version: input.version },
    perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) throw storageIntegrityError();
  return result.items[0] ?? null;
}

/**
 * Recover the latest immutable Director Plan when a retry refreshed the task's
 * derived reference outputs and therefore cleared its compatibility pointer.
 * The version ledger remains authoritative and tenant/task scoped.
 */
export async function latestSocialDirectorPlanVersion(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
}): Promise<StoredSocialDirectorPlanVersion | null> {
  const result = await input.repository.list(
    STARTER_COLLECTIONS.socialDirectorPlanVersions,
    input.tenantId,
    { where: { task_id: input.taskId }, sort: '-created_at', perPage: 500 },
  );
  const versions = result.items.map(parseStoredSocialDirectorPlanVersion)
    .filter(record => record.taskId === input.taskId)
    .sort((left, right) => Number(right.version) - Number(left.version));
  return versions[0] ?? null;
}

function assertSameImmutableVersion(
  stored: StoredSocialDirectorPlanVersion,
  expected: StoredSocialDirectorPlanVersion,
): void {
  // A compatibility backfill carries no historic fact context. If the exact
  // plan already has a richer verified snapshot, retain and reuse that record
  // instead of trying to replace it with the legacy placeholder.
  if (expected.factSnapshot.captureMode === 'legacy_plan_only'
    && stored.taskId === expected.taskId
    && stored.directorPlanId === expected.directorPlanId
    && stored.version === expected.version
    && stored.lineageHash === expected.lineageHash) return;
  if (stored.recordHash !== expected.recordHash) {
    throw new SocialContentWorkflowError('social_content_director_plan_version_immutable_conflict', 409);
  }
}

/**
 * Append one immutable Director Plan version. Repeating the exact write is
 * idempotent; attempting to replace the same identity/version is rejected.
 */
export async function persistSocialDirectorPlanVersion(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  plan: StoredSocialDirectorPlan;
  baseline?: StoredSocialScriptBaseline | null;
  verifiedContext?: VerifiedSocialScriptContext | null;
}): Promise<{ versionRecord: StoredSocialDirectorPlanVersion; reference: SocialDirectorArtifactReference; created: boolean }> {
  const factSnapshot = buildSocialDirectorFactSnapshot({
    plan: input.plan,
    baseline: input.baseline,
    verifiedContext: input.verifiedContext,
  });
  const expected = buildVersionRecord({ taskId: input.taskId, plan: input.plan, factSnapshot });
  const current = await existingVersion({
    repository: input.repository,
    tenantId: input.tenantId,
    directorPlanId: expected.directorPlanId,
    version: expected.version,
  });
  if (current) {
    const stored = parseStoredSocialDirectorPlanVersion(current);
    assertSameImmutableVersion(stored, expected);
    return { versionRecord: stored, reference: socialDirectorArtifactReference(stored), created: false };
  }
  if (expected.previousVersion && expected.factSnapshot.captureMode === 'verified_context') {
    const predecessor = await existingVersion({
      repository: input.repository,
      tenantId: input.tenantId,
      directorPlanId: expected.directorPlanId,
      version: expected.previousVersion,
    });
    if (!predecessor || parseStoredSocialDirectorPlanVersion(predecessor).taskId !== expected.taskId) {
      throw new SocialContentWorkflowError('social_content_director_plan_predecessor_missing', 503);
    }
  }
  try {
    const created = await input.repository.create(
      STARTER_COLLECTIONS.socialDirectorPlanVersions,
      input.tenantId,
      storageFields(expected),
    );
    const stored = parseStoredSocialDirectorPlanVersion(created);
    assertSameImmutableVersion(stored, expected);
    return { versionRecord: stored, reference: socialDirectorArtifactReference(stored), created: true };
  } catch (error) {
    const raced = await existingVersion({
      repository: input.repository,
      tenantId: input.tenantId,
      directorPlanId: expected.directorPlanId,
      version: expected.version,
    }).catch(() => null);
    if (!raced) throw error;
    const stored = parseStoredSocialDirectorPlanVersion(raced);
    assertSameImmutableVersion(stored, expected);
    return { versionRecord: stored, reference: socialDirectorArtifactReference(stored), created: false };
  }
}

export function socialDirectorArtifactReference(
  record: StoredSocialDirectorPlanVersion,
): SocialDirectorArtifactReference {
  const parsed = parseStoredSocialDirectorPlanVersion(record);
  return {
    schemaVersion: SOCIAL_DIRECTOR_ARTIFACT_REFERENCE_SCHEMA,
    directorPlanId: parsed.directorPlanId,
    version: parsed.version,
    lineageHash: parsed.lineageHash,
    factSnapshotHash: parsed.factSnapshotHash,
    materialSnapshotHash: parsed.materialSnapshotHash,
    recordHash: parsed.recordHash,
  };
}

export function parseSocialDirectorArtifactReference(value: unknown): SocialDirectorArtifactReference {
  const row = socialObject(socialJson(value));
  if (!row
    || socialText(row.schemaVersion) !== SOCIAL_DIRECTOR_ARTIFACT_REFERENCE_SCHEMA
    || !/^director_plan_[a-f0-9]{24}$/.test(socialText(row.directorPlanId))
    || !/^\d+$/.test(storageText(row.version))
    || [row.lineageHash, row.factSnapshotHash, row.materialSnapshotHash, row.recordHash]
      .some(hash => !/^[a-f0-9]{64}$/i.test(socialText(hash)))) {
    throw storageIntegrityError();
  }
  return {
    schemaVersion: SOCIAL_DIRECTOR_ARTIFACT_REFERENCE_SCHEMA,
    directorPlanId: socialText(row.directorPlanId),
    version: storageText(row.version),
    lineageHash: socialText(row.lineageHash).toLocaleLowerCase(),
    factSnapshotHash: socialText(row.factSnapshotHash).toLocaleLowerCase(),
    materialSnapshotHash: socialText(row.materialSnapshotHash).toLocaleLowerCase(),
    recordHash: socialText(row.recordHash).toLocaleLowerCase(),
  };
}

export async function readSocialDirectorPlanVersion(input: {
  repository: Starter198Repository;
  tenantId: string;
  directorPlanId: string;
  version: string;
}): Promise<StoredSocialDirectorPlanVersion | null> {
  const row = await existingVersion(input);
  return row ? parseStoredSocialDirectorPlanVersion(row) : null;
}

/** Resolve an artifact reference back to the exact plan and both input
 * snapshots. Every hash is checked, so a mutable task projection cannot stand
 * in for the referenced immutable version. */
export async function resolveSocialDirectorArtifactLineage(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  reference: SocialDirectorArtifactReference | unknown;
}): Promise<StoredSocialDirectorPlanVersion> {
  const reference = parseSocialDirectorArtifactReference(input.reference);
  const version = await readSocialDirectorPlanVersion({
    repository: input.repository,
    tenantId: input.tenantId,
    directorPlanId: reference.directorPlanId,
    version: reference.version,
  });
  if (!version || version.taskId !== input.taskId
    || version.lineageHash !== reference.lineageHash
    || version.factSnapshotHash !== reference.factSnapshotHash
    || version.materialSnapshotHash !== reference.materialSnapshotHash
    || version.recordHash !== reference.recordHash) {
    throw new SocialContentWorkflowError('social_content_director_plan_lineage_not_found', 503);
  }
  return version;
}
