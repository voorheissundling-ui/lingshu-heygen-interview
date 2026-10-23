import {
  SOCIAL_WORK_PACKAGE_KINDS,
  SOCIAL_WORK_PACKAGE_STATUSES,
  type CreateSocialWorkPackageVersionInput,
  type SocialWorkPackageCard,
  type SocialWorkPackageFramework,
  type SocialWorkPackageKind,
  type SocialWorkPackageStatus,
  type SocialWorkPackageVersionDetail,
  type UpdateSocialWorkPackageVersionInput,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import {
  SocialContentWorkflowError,
  requireSocialId,
  socialJson,
  socialObject,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';

export const SOCIAL_PACKAGE_CATALOG_TENANT = 'starter198-social-package-catalog';
export const SOCIAL_PACKAGE_FRAMEWORK_VERSION = 'framework-v1';
export const MAX_SOCIAL_WORK_PACKAGE_VERSIONS = 300;

const EMPTY_FRAMEWORK: SocialWorkPackageFramework = {
  applicability: [],
  requiredInputs: [],
  workOutline: [],
  deliverables: [],
  userDecisions: [],
  qualityChecks: [],
  metricRequirements: [],
  fallbackPolicy: [],
};

const PACKAGE_NAMES: Record<SocialWorkPackageKind, string> = {
  industry_launch: '行业起航包',
  content_rocket: '内容火箭包',
  task_express: '任务飞车包',
};

export const BUILTIN_SOCIAL_WORK_PACKAGES: SocialWorkPackageVersionDetail[] = SOCIAL_WORK_PACKAGE_KINDS.map(kind => ({
  kind,
  packageKey: kind,
  version: SOCIAL_PACKAGE_FRAMEWORK_VERSION,
  name: PACKAGE_NAMES[kind],
  summary: null,
  status: 'active',
  available: true,
  framework: structuredClone(EMPTY_FRAMEWORK),
  requiredInputs: [],
  deliverables: [],
  effectiveFrom: null,
  effectiveUntil: null,
  recordVersion: 'builtin',
  updatedAt: '2026-09-14T00:00:00.000Z',
  builtin: true,
}));

function stringList(value: unknown): string[] {
  const parsed = socialJson(value);
  if (!Array.isArray(parsed)) throw new SocialContentWorkflowError('social_package_record_invalid', 503);
  const items = parsed.map(socialText);
  if (items.some(item => !item)) throw new SocialContentWorkflowError('social_package_record_invalid', 503);
  return items;
}

function framework(value: unknown): SocialWorkPackageFramework {
  const parsed = socialObject(socialJson(value));
  if (!parsed) throw new SocialContentWorkflowError('social_package_record_invalid', 503);
  return {
    applicability: stringList(parsed.applicability),
    requiredInputs: stringList(parsed.requiredInputs),
    workOutline: stringList(parsed.workOutline),
    deliverables: stringList(parsed.deliverables),
    userDecisions: stringList(parsed.userDecisions),
    qualityChecks: stringList(parsed.qualityChecks),
    metricRequirements: stringList(parsed.metricRequirements),
    fallbackPolicy: stringList(parsed.fallbackPolicy),
  };
}

function nullableTime(value: unknown): string | null {
  const parsed = socialText(value);
  return parsed && Number.isFinite(Date.parse(parsed)) ? new Date(parsed).toISOString() : null;
}

function packageDetail(record: StarterRecord): SocialWorkPackageVersionDetail {
  const kind = socialText(record.package_kind) as SocialWorkPackageKind;
  const status = socialText(record.status) as SocialWorkPackageStatus;
  const recordVersion = socialText(record.record_version);
  const packageKey = socialText(record.package_key);
  const version = socialText(record.package_version);
  const name = socialText(record.name);
  const updatedAt = socialText(record.updated_at);
  if (!SOCIAL_WORK_PACKAGE_KINDS.includes(kind) || !SOCIAL_WORK_PACKAGE_STATUSES.includes(status)
    || !packageKey || !version || !name || !recordVersion || !updatedAt) {
    throw new SocialContentWorkflowError('social_package_record_invalid', 503);
  }
  const parsedFramework = framework(record.framework);
  return {
    kind,
    packageKey,
    version,
    name,
    summary: socialText(record.summary) || null,
    status,
    available: status === 'active',
    framework: parsedFramework,
    requiredInputs: parsedFramework.requiredInputs,
    deliverables: parsedFramework.deliverables,
    effectiveFrom: nullableTime(record.effective_from),
    effectiveUntil: nullableTime(record.effective_until),
    recordVersion,
    updatedAt,
    builtin: false,
  };
}

function activeNow(item: SocialWorkPackageVersionDetail, now: Date): boolean {
  const current = now.getTime();
  return item.status === 'active'
    && (!item.effectiveFrom || Date.parse(item.effectiveFrom) <= current)
    && (!item.effectiveUntil || current < Date.parse(item.effectiveUntil));
}

export async function listSocialWorkPackageDetails(input: {
  repository: Starter198Repository;
  now?: Date;
}): Promise<SocialWorkPackageVersionDetail[]> {
  const result = await input.repository.list(
    STARTER_COLLECTIONS.socialWorkPackageVersions,
    SOCIAL_PACKAGE_CATALOG_TENANT,
    { sort: '-created_at', perPage: MAX_SOCIAL_WORK_PACKAGE_VERSIONS + 1 },
  );
  if (result.totalItems > MAX_SOCIAL_WORK_PACKAGE_VERSIONS || result.items.length !== result.totalItems) {
    throw new SocialContentWorkflowError('social_package_catalog_limit_exceeded', 503);
  }
  const stored = result.items.map(packageDetail);
  const storedIdentities = new Set(stored.map(item => `${item.packageKey}:${item.version}`));
  return [
    ...stored,
    ...BUILTIN_SOCIAL_WORK_PACKAGES.filter(item => !storedIdentities.has(`${item.packageKey}:${item.version}`)),
  ];
}

export async function listActiveSocialWorkPackageCards(input: {
  repository: Starter198Repository;
  now?: Date;
}): Promise<SocialWorkPackageCard[]> {
  const now = input.now ?? new Date();
  const details = await listSocialWorkPackageDetails(input);
  const cards: SocialWorkPackageCard[] = [];
  for (const kind of SOCIAL_WORK_PACKAGE_KINDS) {
    const storedActive = details.filter(item => !item.builtin && item.kind === kind && activeNow(item, now));
    if (storedActive.length > 1) throw new SocialContentWorkflowError('social_package_active_integrity_violation', 503);
    const selected = storedActive[0] ?? details.find(item => item.builtin && item.kind === kind && activeNow(item, now));
    if (!selected) continue;
    cards.push({
      kind: selected.kind,
      packageKey: selected.packageKey,
      version: selected.version,
      name: selected.name,
      available: true,
      summary: selected.summary,
      requiredInputs: selected.requiredInputs,
      deliverables: selected.deliverables,
    });
  }
  return cards;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(record).some(key => !allowed.has(key))) {
    throw new SocialContentWorkflowError('social_package_input_invalid', 400);
  }
}

function required(value: unknown, code: string, max: number): string {
  const parsed = socialText(value);
  if (!parsed || parsed.length > max) throw new SocialContentWorkflowError(code, 400);
  return parsed;
}

function optional(value: unknown, code: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return required(value, code, max);
}

function list(value: unknown, code: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new SocialContentWorkflowError(code, 400);
  const parsed = value.map(item => required(item, code, 500));
  return [...new Set(parsed)];
}

function parseFramework(value: unknown): SocialWorkPackageFramework {
  if (value === undefined) return structuredClone(EMPTY_FRAMEWORK);
  const source = socialObject(value);
  if (!source) throw new SocialContentWorkflowError('social_package_framework_invalid', 400);
  exactKeys(source, Object.keys(EMPTY_FRAMEWORK));
  return {
    applicability: list(source.applicability, 'social_package_framework_invalid'),
    requiredInputs: list(source.requiredInputs, 'social_package_framework_invalid'),
    workOutline: list(source.workOutline, 'social_package_framework_invalid'),
    deliverables: list(source.deliverables, 'social_package_framework_invalid'),
    userDecisions: list(source.userDecisions, 'social_package_framework_invalid'),
    qualityChecks: list(source.qualityChecks, 'social_package_framework_invalid'),
    metricRequirements: list(source.metricRequirements, 'social_package_framework_invalid'),
    fallbackPolicy: list(source.fallbackPolicy, 'social_package_framework_invalid'),
  };
}

function parseFrameworkPatch(value: unknown): Partial<SocialWorkPackageFramework> {
  const source = socialObject(value);
  if (!source) throw new SocialContentWorkflowError('social_package_framework_invalid', 400);
  exactKeys(source, Object.keys(EMPTY_FRAMEWORK));
  return Object.fromEntries(Object.keys(source).map(key => [
    key,
    list(source[key], 'social_package_framework_invalid'),
  ])) as Partial<SocialWorkPackageFramework>;
}

function time(value: unknown, code: string): string | null {
  const parsed = optional(value, code, 80);
  if (!parsed) return null;
  if (!Number.isFinite(Date.parse(parsed))) throw new SocialContentWorkflowError(code, 400);
  return new Date(parsed).toISOString();
}

export function parseCreateWorkPackage(value: unknown): CreateSocialWorkPackageVersionInput {
  const source = socialObject(value);
  if (!source) throw new SocialContentWorkflowError('social_package_input_invalid', 400);
  exactKeys(source, ['kind', 'packageKey', 'version', 'name', 'summary', 'framework', 'effectiveFrom', 'effectiveUntil']);
  const kind = socialText(source.kind) as SocialWorkPackageKind;
  if (!SOCIAL_WORK_PACKAGE_KINDS.includes(kind)) throw new SocialContentWorkflowError('social_package_kind_invalid', 400);
  const effectiveFrom = time(source.effectiveFrom, 'social_package_effective_time_invalid');
  const effectiveUntil = time(source.effectiveUntil, 'social_package_effective_time_invalid');
  if (effectiveFrom && effectiveUntil && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
    throw new SocialContentWorkflowError('social_package_effective_range_invalid', 400);
  }
  return {
    kind,
    packageKey: requireSocialId(source.packageKey, 'social_package_key_invalid'),
    version: requireSocialId(source.version, 'social_package_version_invalid'),
    name: required(source.name, 'social_package_name_invalid', 120),
    summary: optional(source.summary, 'social_package_summary_invalid', 500),
    framework: parseFramework(source.framework),
    effectiveFrom,
    effectiveUntil,
  };
}

export function parseUpdateWorkPackage(value: unknown): UpdateSocialWorkPackageVersionInput {
  const source = socialObject(value);
  if (!source) throw new SocialContentWorkflowError('social_package_update_invalid', 400);
  exactKeys(source, ['expectedVersion', 'changes']);
  const changes = socialObject(source.changes);
  if (!changes || !Object.keys(changes).length) throw new SocialContentWorkflowError('social_package_changes_required', 400);
  exactKeys(changes, ['name', 'summary', 'framework', 'effectiveFrom', 'effectiveUntil']);
  const parsed: UpdateSocialWorkPackageVersionInput['changes'] = {};
  if ('name' in changes) parsed.name = required(changes.name, 'social_package_name_invalid', 120);
  if ('summary' in changes) parsed.summary = optional(changes.summary, 'social_package_summary_invalid', 500);
  if ('framework' in changes) parsed.framework = parseFrameworkPatch(changes.framework);
  if ('effectiveFrom' in changes) parsed.effectiveFrom = time(changes.effectiveFrom, 'social_package_effective_time_invalid');
  if ('effectiveUntil' in changes) parsed.effectiveUntil = time(changes.effectiveUntil, 'social_package_effective_time_invalid');
  return {
    expectedVersion: required(source.expectedVersion, 'social_package_record_version_required', 80),
    changes: parsed,
  };
}

async function storedPackage(input: {
  repository: Starter198Repository;
  packageKey: string;
  version: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(
    STARTER_COLLECTIONS.socialWorkPackageVersions,
    SOCIAL_PACKAGE_CATALOG_TENANT,
    { where: { package_key: input.packageKey, package_version: input.version }, perPage: 2 },
  );
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_package_record_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

function isBuiltinIdentity(packageKey: string, version: string): boolean {
  return SOCIAL_WORK_PACKAGE_KINDS.includes(packageKey as SocialWorkPackageKind)
    && version === SOCIAL_PACKAGE_FRAMEWORK_VERSION;
}

async function replayStoredPackage(input: {
  repository: Starter198Repository;
  packageKey: string;
  version: string;
}): Promise<{ workPackage: SocialWorkPackageVersionDetail }> {
  const record = await storedPackage(input);
  if (!record) throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
  return { workPackage: packageDetail(record) };
}

export async function createSocialWorkPackageVersion(input: {
  repository: Starter198Repository;
  userId: string;
  idempotencyKey: string;
  value: CreateSocialWorkPackageVersionInput;
  now?: Date;
}): Promise<SocialWorkPackageVersionDetail> {
  if (input.value.packageKey === input.value.kind && input.value.version === SOCIAL_PACKAGE_FRAMEWORK_VERSION) {
    throw new SocialContentWorkflowError('social_package_builtin_read_only', 409);
  }
  const requestHash = socialRequestHash(input.value);
  const targetId = 'package-catalog';
  const mutation = await executeSocialContentMutation<{ workPackage: SocialWorkPackageVersionDetail }>({
    repository: input.repository,
    tenantId: SOCIAL_PACKAGE_CATALOG_TENANT,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    operation: 'create_work_package_version',
    targetId,
    now: input.now,
    replay: async () => replayStoredPackage({
      repository: input.repository,
      packageKey: input.value.packageKey,
      version: input.value.version,
    }),
    action: async operationId => {
      const existing = await storedPackage({ repository: input.repository, packageKey: input.value.packageKey, version: input.value.version });
      if (existing) {
        if (socialText(existing.last_operation_id) === operationId) return { workPackage: packageDetail(existing) };
        throw new SocialContentWorkflowError('social_package_version_exists', 409);
      }
      const catalog = await input.repository.list(
        STARTER_COLLECTIONS.socialWorkPackageVersions,
        SOCIAL_PACKAGE_CATALOG_TENANT,
        { perPage: 1 },
      );
      if (catalog.totalItems >= MAX_SOCIAL_WORK_PACKAGE_VERSIONS) {
        throw new SocialContentWorkflowError('social_package_catalog_limit_reached', 409);
      }
      const timestamp = (input.now ?? new Date()).toISOString();
      const created = await input.repository.create(STARTER_COLLECTIONS.socialWorkPackageVersions, SOCIAL_PACKAGE_CATALOG_TENANT, {
        package_kind: input.value.kind,
        package_key: input.value.packageKey,
        package_version: input.value.version,
        name: input.value.name,
        summary: input.value.summary ?? '',
        framework: { ...EMPTY_FRAMEWORK, ...input.value.framework },
        status: 'draft',
        effective_from: input.value.effectiveFrom ?? '',
        effective_until: input.value.effectiveUntil ?? '',
        record_version: '1',
        last_operation_id: operationId,
        created_by: input.userId,
        updated_by: input.userId,
        created_at: timestamp,
        updated_at: timestamp,
      });
      return { workPackage: packageDetail(created) };
    },
  });
  return mutation.value.workPackage;
}

export async function updateSocialWorkPackageVersion(input: {
  repository: Starter198Repository;
  userId: string;
  idempotencyKey: string;
  packageKey: string;
  version: string;
  value: UpdateSocialWorkPackageVersionInput;
  now?: Date;
}): Promise<SocialWorkPackageVersionDetail> {
  if (isBuiltinIdentity(input.packageKey, input.version)) {
    throw new SocialContentWorkflowError('social_package_builtin_read_only', 409);
  }
  const initialRecord = await storedPackage(input);
  if (!initialRecord) throw new SocialContentWorkflowError('social_package_version_not_found', 404);
  const initialPackage = packageDetail(initialRecord);
  const mutation = await executeSocialContentMutation<{ workPackage: SocialWorkPackageVersionDetail }>({
    repository: input.repository,
    tenantId: SOCIAL_PACKAGE_CATALOG_TENANT,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash(input.value),
    operation: 'update_work_package_version',
    targetId: `package-kind:${initialPackage.kind}`,
    now: input.now,
    replay: async () => replayStoredPackage(input),
    action: async operationId => {
      const record = await storedPackage(input);
      if (!record) throw new SocialContentWorkflowError('social_package_version_not_found', 404);
      if (socialText(record.last_operation_id) === operationId) return { workPackage: packageDetail(record) };
      if (socialText(record.record_version) !== input.value.expectedVersion) {
        throw new SocialContentWorkflowError('social_package_version_conflict', 409);
      }
      if (!['draft', 'internal_trial'].includes(socialText(record.status))) {
        throw new SocialContentWorkflowError('social_package_active_version_immutable', 409);
      }
      const nextVersion = String(Number(record.record_version) + 1);
      const current = packageDetail(record);
      const effectiveFrom = input.value.changes.effectiveFrom === undefined ? current.effectiveFrom : input.value.changes.effectiveFrom;
      const effectiveUntil = input.value.changes.effectiveUntil === undefined ? current.effectiveUntil : input.value.changes.effectiveUntil;
      if (effectiveFrom && effectiveUntil && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
        throw new SocialContentWorkflowError('social_package_effective_range_invalid', 400);
      }
      await input.repository.update(STARTER_COLLECTIONS.socialWorkPackageVersions, SOCIAL_PACKAGE_CATALOG_TENANT, record.id, {
        name: input.value.changes.name ?? current.name,
        summary: input.value.changes.summary === undefined ? current.summary ?? '' : input.value.changes.summary ?? '',
        framework: input.value.changes.framework ? { ...current.framework, ...input.value.changes.framework } : current.framework,
        effective_from: effectiveFrom ?? '',
        effective_until: effectiveUntil ?? '',
        record_version: nextVersion,
        last_operation_id: operationId,
        updated_by: input.userId,
        updated_at: (input.now ?? new Date()).toISOString(),
      });
      return { workPackage: packageDetail((await storedPackage(input))!) };
    },
  });
  return mutation.value.workPackage;
}

const PACKAGE_STATUS_TRANSITIONS: Record<SocialWorkPackageStatus, readonly SocialWorkPackageStatus[]> = {
  draft: ['internal_trial', 'retired'],
  internal_trial: ['draft', 'active', 'retired'],
  active: ['retired'],
  retired: [],
};

export async function changeSocialWorkPackageStatus(input: {
  repository: Starter198Repository;
  userId: string;
  idempotencyKey: string;
  packageKey: string;
  version: string;
  expectedVersion: string;
  status: SocialWorkPackageStatus;
  now?: Date;
}): Promise<SocialWorkPackageVersionDetail> {
  if (!SOCIAL_WORK_PACKAGE_STATUSES.includes(input.status)) {
    throw new SocialContentWorkflowError('social_package_status_invalid', 400);
  }
  if (isBuiltinIdentity(input.packageKey, input.version)) {
    throw new SocialContentWorkflowError('social_package_builtin_read_only', 409);
  }
  const initialRecord = await storedPackage(input);
  if (!initialRecord) throw new SocialContentWorkflowError('social_package_version_not_found', 404);
  const initialPackage = packageDetail(initialRecord);
  const mutation = await executeSocialContentMutation<{ workPackage: SocialWorkPackageVersionDetail }>({
    repository: input.repository,
    tenantId: SOCIAL_PACKAGE_CATALOG_TENANT,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash({ expectedVersion: input.expectedVersion, status: input.status }),
    operation: 'change_work_package_status',
    targetId: `package-kind:${initialPackage.kind}`,
    now: input.now,
    replay: async () => replayStoredPackage(input),
    action: async operationId => {
      const record = await storedPackage(input);
      if (!record) throw new SocialContentWorkflowError('social_package_version_not_found', 404);
      if (socialText(record.last_operation_id) === operationId) return { workPackage: packageDetail(record) };
      const current = packageDetail(record);
      if (current.recordVersion !== input.expectedVersion) {
        throw new SocialContentWorkflowError('social_package_version_conflict', 409);
      }
      if (!PACKAGE_STATUS_TRANSITIONS[current.status].includes(input.status)) {
        throw new SocialContentWorkflowError('social_package_status_transition_invalid', 409);
      }
      if (input.status === 'active') {
        if (!current.summary || !current.framework.requiredInputs.length || !current.framework.deliverables.length) {
          throw new SocialContentWorkflowError('social_package_activation_incomplete', 409);
        }
        const details = await listSocialWorkPackageDetails({ repository: input.repository, now: input.now });
        if (details.some(item => !item.builtin && item.kind === current.kind && item.status === 'active'
          && (item.packageKey !== current.packageKey || item.version !== current.version))) {
          throw new SocialContentWorkflowError('social_package_active_version_exists', 409);
        }
      }
      await input.repository.update(STARTER_COLLECTIONS.socialWorkPackageVersions, SOCIAL_PACKAGE_CATALOG_TENANT, record.id, {
        status: input.status,
        record_version: String(Number(current.recordVersion) + 1),
        last_operation_id: operationId,
        updated_by: input.userId,
        updated_at: (input.now ?? new Date()).toISOString(),
      });
      return { workPackage: packageDetail((await storedPackage(input))!) };
    },
  });
  return mutation.value.workPackage;
}

export async function resolveSelectedPackages(input: {
  repository: Starter198Repository;
  selections: Array<{ kind: SocialWorkPackageKind; packageKey: string; version: string }>;
  now?: Date;
}) {
  const details = await listSocialWorkPackageDetails(input);
  const now = input.now ?? new Date();
  return input.selections.map(selection => {
    const selected = details.find(item => item.kind === selection.kind
      && item.packageKey === selection.packageKey && item.version === selection.version);
    if (!selected || !activeNow(selected, now)) {
      throw new SocialContentWorkflowError('social_package_selection_unavailable', 409);
    }
    return { kind: selected.kind, packageKey: selected.packageKey, version: selected.version, name: selected.name };
  });
}
