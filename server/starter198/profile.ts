import {
  STARTER_198_CAPABILITIES,
  STARTER_198_PROFILE,
  STARTER_198_PROFILE_VERSION,
  type Starter198Capability,
  type Starter198CapabilityManifest,
  type Starter198OrgRole,
  type Starter198ResourceLimits,
} from '../../shared/contracts/starter198.js';

export interface Starter198Entitlement {
  capability: Starter198Capability;
  enabled: boolean;
  expiresAt?: string;
}

export interface Starter198AccessSnapshot {
  recordId: string;
  tenantId: string;
  productProfile: typeof STARTER_198_PROFILE;
  profileVersion: typeof STARTER_198_PROFILE_VERSION;
  entitlementSnapshotId: string;
  entitlements: Starter198Entitlement[];
  resourceLimits: Starter198ResourceLimits;
  status: 'active';
  cycleStartedAt: string;
  cycleEndsAt: string;
  updatedAt: string;
}

const PROFILE_CAPABILITIES = new Set<Starter198Capability>([
  'workspace.read',
  'production_site.read',
  'orchestrator.command.submit',
  'orchestrator.decision.resolve',
  'workflow.standard.run',
  'workflow.run.pause',
  'workflow.run.resume',
  'workflow.run.cancel',
  'publishing.package.generate',
  'publishing.evidence.submit',
  'quotation.calculate',
]);

const CYCLE_INDEPENDENT_READ_CAPABILITIES = new Set<Starter198Capability>([
  'workspace.read',
  'production_site.read',
]);

const LIMIT_KEYS = [
  'workspaceCount',
  'brandCount',
  'memberCount',
  'agentTeamCount',
  'productCount',
  'marketCount',
  'buyerPersonaCount',
  'languageCount',
  'primaryPlatformCount',
  'concurrentRunCount',
  'contentArtifactCountPerCycle',
  'contentRevisionCountPerCycle',
  'publicationPackageCountPerContent',
  'assistedSessionCount',
  'inquiryAiCountPerCycle',
  'quoteDraftCountPerCycle',
  'highCostVideoCount',
  'budgetCnyPerCycle',
] as const satisfies ReadonlyArray<Exclude<keyof Starter198ResourceLimits, 'agentBudgetCny'>>;

const CAPABILITY_LIMIT: Partial<Record<Starter198Capability, keyof Starter198ResourceLimits>> = {
  'workflow.standard.run': 'concurrentRunCount',
  'publishing.package.generate': 'publicationPackageCountPerContent',
  'quotation.calculate': 'quoteDraftCountPerCycle',
};

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; }
  catch { return undefined; }
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseResourceLimits(value: unknown): Starter198ResourceLimits | null {
  const source = object(json(value));
  if (!source) return null;
  const agentBudget = object(source.agentBudgetCny);
  if (!agentBudget || !LIMIT_KEYS.every(key => finiteNonNegative(source[key]))) return null;
  if (!['orchestrator', 'content', 'traffic', 'sales'].every(role => finiteNonNegative(agentBudget[role]))) return null;
  const limits = {
    ...Object.fromEntries(LIMIT_KEYS.map(key => [key, Number(source[key])])),
    agentBudgetCny: {
      orchestrator: Number(agentBudget.orchestrator),
      content: Number(agentBudget.content),
      traffic: Number(agentBudget.traffic),
      sales: Number(agentBudget.sales),
    },
  } as Starter198ResourceLimits;
  const allocated = Object.values(limits.agentBudgetCny).reduce((sum, amount) => sum + amount, 0);
  return allocated <= limits.budgetCnyPerCycle ? limits : null;
}

function parseEntitlements(value: unknown): Starter198Entitlement[] | null {
  const source = json(value);
  if (!Array.isArray(source)) return null;
  const result: Starter198Entitlement[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const record = object(item);
    const capability = nonEmpty(record?.capability) as Starter198Capability;
    const enabled = record?.enabled;
    const expiresAt = nonEmpty(record?.expiresAt);
    if (!STARTER_198_CAPABILITIES.includes(capability) || typeof enabled !== 'boolean' || seen.has(capability)) return null;
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) return null;
    seen.add(capability);
    result.push({ capability, enabled, ...(expiresAt ? { expiresAt } : {}) });
  }
  return result;
}

export function parseStarter198AccessRecord(
  value: Record<string, unknown>,
  expectedTenantId: string,
): Starter198AccessSnapshot | null {
  const resourceLimits = parseResourceLimits(value.resource_limits);
  const entitlements = parseEntitlements(value.feature_entitlements);
  const recordId = nonEmpty(value.id);
  const tenantId = nonEmpty(value.tenant_id);
  const profileVersion = nonEmpty(value.profile_version);
  const productProfile = nonEmpty(value.product_profile);
  const entitlementSnapshotId = nonEmpty(value.entitlement_snapshot_id);
  const status = nonEmpty(value.status);
  const cycleStartedAt = nonEmpty(value.cycle_started_at);
  const cycleEndsAt = nonEmpty(value.cycle_ends_at);
  const updatedAt = nonEmpty(value.updated_at);
  const cycleStartMs = Date.parse(cycleStartedAt);
  const cycleEndMs = Date.parse(cycleEndsAt);
  if (!recordId || tenantId !== expectedTenantId || productProfile !== STARTER_198_PROFILE
    || profileVersion !== STARTER_198_PROFILE_VERSION || !entitlementSnapshotId
    || status !== 'active' || !updatedAt || !resourceLimits || !entitlements
    || !Number.isFinite(cycleStartMs) || !Number.isFinite(cycleEndMs) || cycleEndMs <= cycleStartMs) return null;
  return {
    recordId,
    tenantId,
    productProfile: STARTER_198_PROFILE,
    profileVersion: STARTER_198_PROFILE_VERSION,
    entitlementSnapshotId,
    entitlements,
    resourceLimits,
    status: 'active',
    cycleStartedAt,
    cycleEndsAt,
    updatedAt,
  };
}

function limitAvailable(capability: Starter198Capability, limits: Starter198ResourceLimits): boolean {
  const key = CAPABILITY_LIMIT[capability];
  return key ? Number(limits[key]) > 0 : true;
}

export function buildStarter198CapabilityManifest(
  access: Starter198AccessSnapshot,
  now = new Date(),
): Starter198CapabilityManifest {
  const entitlements = new Map(access.entitlements.map(item => [item.capability, item]));
  const accessCycleOpen = starter198AccessCycleOpen(access, now);
  const capabilities = Object.fromEntries(STARTER_198_CAPABILITIES.map(capability => {
    if (!PROFILE_CAPABILITIES.has(capability)) return [capability, { allowed: false, reason: 'profile_denied' as const }];
    if (!accessCycleOpen && !CYCLE_INDEPENDENT_READ_CAPABILITIES.has(capability)) {
      return [capability, { allowed: false, reason: 'entitlement_expired' as const }];
    }
    const entitlement = entitlements.get(capability);
    if (!entitlement) return [capability, { allowed: false, reason: 'entitlement_missing' as const }];
    if (!entitlement.enabled) return [capability, { allowed: false, reason: 'entitlement_disabled' as const }];
    if (entitlement.expiresAt && Date.parse(entitlement.expiresAt) <= now.getTime()) {
      return [capability, { allowed: false, reason: 'entitlement_expired' as const }];
    }
    if (!limitAvailable(capability, access.resourceLimits)) {
      return [capability, { allowed: false, reason: 'resource_limit_unavailable' as const }];
    }
    return [capability, { allowed: true, reason: 'allowed' as const }];
  })) as Starter198CapabilityManifest['capabilities'];
  return {
    schemaVersion: 'starter-198.capabilities.v1',
    productProfile: STARTER_198_PROFILE,
    profileVersion: STARTER_198_PROFILE_VERSION,
    entitlementSnapshotId: access.entitlementSnapshotId,
    generatedAt: now.toISOString(),
    capabilities,
    resourceLimits: access.resourceLimits,
  };
}

export function starter198AccessCycleOpen(
  access: Pick<Starter198AccessSnapshot, 'cycleStartedAt' | 'cycleEndsAt'>,
  now = new Date(),
): boolean {
  const startsAt = Date.parse(access.cycleStartedAt);
  const endsAt = Date.parse(access.cycleEndsAt);
  const current = now.getTime();
  return Number.isFinite(startsAt) && Number.isFinite(endsAt)
    && Number.isFinite(current) && startsAt <= current && current < endsAt;
}

export function starter198CapabilityAllowed(
  manifest: Starter198CapabilityManifest,
  capability: Starter198Capability,
): boolean {
  return manifest.capabilities[capability]?.allowed === true;
}

export function starter198OrgRole(value: unknown): Starter198OrgRole | null {
  if (value === 'super_admin' || value === 'owner') return 'owner';
  if (value === 'admin') return 'admin';
  if (value === 'social_operator' || value === 'operator') return 'operator';
  if (value === 'customer_service') return 'customer_service';
  return null;
}
