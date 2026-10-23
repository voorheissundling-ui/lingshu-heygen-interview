import { createHash } from 'node:crypto';
import {
  STARTER_198_PROFILE,
  STARTER_198_PROFILE_VERSION,
  type Starter198Capability,
  type Starter198ResourceLimits,
} from '../../shared/contracts/starter198.js';
import {
  STARTER_COLLECTIONS,
  Starter198RepositoryError,
  starter198Repository,
  type Starter198Repository,
} from './repository.js';
import type { Starter198AccessSnapshot } from './profile.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { withStarter198TenantTransitionLock } from './legacyEffectGuard.js';
import {
  assertStarter198ProvisioningCompatible,
  Starter198ProvisioningCompatibilityError,
  type Starter198ProvisioningBlocker,
} from './provisioningCompatibility.js';

export interface Starter198ProvisioningActor {
  userId: string;
  role: 'internal_admin';
}

export class Starter198ProvisioningError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly blockers: Array<{ kind: Starter198ProvisioningBlocker; count: number }> = [],
  ) {
    super(code);
    this.name = 'Starter198ProvisioningError';
  }
}

export const STARTER_198_DEFAULT_LIMITS: Starter198ResourceLimits = Object.freeze({
  workspaceCount: 1,
  brandCount: 1,
  memberCount: 2,
  agentTeamCount: 1,
  productCount: 1,
  marketCount: 1,
  buyerPersonaCount: 1,
  languageCount: 1,
  primaryPlatformCount: 1,
  concurrentRunCount: 1,
  contentArtifactCountPerCycle: 2,
  contentRevisionCountPerCycle: 1,
  publicationPackageCountPerContent: 1,
  assistedSessionCount: 0,
  inquiryAiCountPerCycle: 10,
  quoteDraftCountPerCycle: 10,
  highCostVideoCount: 0,
  budgetCnyPerCycle: 100,
  agentBudgetCny: Object.freeze({ orchestrator: 25, content: 25, traffic: 25, sales: 25 }),
});

const DEFAULT_CAPABILITIES: readonly Starter198Capability[] = Object.freeze([
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
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function provisionStarter198(input: {
  tenantId: string;
  actor: Starter198ProvisioningActor;
  idempotencyKey: string;
  repository?: Starter198Repository;
  compatibilityStore?: DataStore;
  now?: Date;
}): Promise<{ access: Starter198AccessSnapshot; created: boolean }> {
  const tenantId = text(input.tenantId);
  const actorId = text(input.actor?.userId);
  const idempotencyKey = text(input.idempotencyKey);
  if (input.actor?.role !== 'internal_admin' || !actorId) {
    throw new Starter198ProvisioningError('starter_198_internal_admin_required', 403);
  }
  if (!/^[a-z0-9:_-]{1,200}$/i.test(tenantId) || !/^[a-z0-9:_.-]{8,128}$/i.test(idempotencyKey)) {
    throw new Starter198ProvisioningError('starter_198_provisioning_input_invalid', 400);
  }
  const repository = input.repository ?? starter198Repository;
  const transitionStore = input.compatibilityStore ?? repository.dataStore ?? store;
  const entitlements = DEFAULT_CAPABILITIES.map(capability => ({ capability, enabled: true }));
  const subject = {
    tenantId,
    productProfile: STARTER_198_PROFILE,
    profileVersion: STARTER_198_PROFILE_VERSION,
    entitlements,
    resourceLimits: STARTER_198_DEFAULT_LIMITS,
  };
  const requestHash = hash(subject);
  return withStarter198TenantTransitionLock(tenantId, async transitionGuard => {
    const existing = await repository.list(STARTER_COLLECTIONS.access, tenantId, { perPage: 2 });
    if (existing.totalItems > 1 || existing.items.length > 1) {
      throw new Starter198ProvisioningError('starter_198_access_integrity_violation', 503);
    }
    if (existing.items[0]) {
      if (text(existing.items[0].provisioning_idempotency_key) !== idempotencyKey
        || text(existing.items[0].provisioning_request_hash) !== requestHash) {
        throw new Starter198ProvisioningError('starter_198_already_provisioned', 409);
      }
      return { access: await repository.access(tenantId), created: false };
    }
    try {
      await assertStarter198ProvisioningCompatible(tenantId, transitionStore);
    } catch (error) {
      if (error instanceof Starter198ProvisioningCompatibilityError) {
        throw new Starter198ProvisioningError(error.code, error.status, error.blockers);
      }
      throw error;
    }
    const cycleStartedAt = input.now ?? new Date();
    const timestamp = cycleStartedAt.toISOString();
    const cycleEndsAt = new Date(cycleStartedAt.getTime() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    try {
      await transitionGuard.beforeEffect();
      await repository.create(STARTER_COLLECTIONS.access, tenantId, {
        product_profile: STARTER_198_PROFILE,
        profile_version: STARTER_198_PROFILE_VERSION,
        entitlement_snapshot_id: `starter_ent_${hash(subject).slice(0, 24)}`,
        feature_entitlements: entitlements,
        resource_limits: STARTER_198_DEFAULT_LIMITS,
        status: 'active',
        provisioning_idempotency_key: idempotencyKey,
        provisioning_request_hash: requestHash,
        created_by: actorId,
        updated_by: actorId,
        cycle_started_at: timestamp,
        cycle_ends_at: cycleEndsAt,
        created_at: timestamp,
        updated_at: timestamp,
      });
    } catch (error) {
      if (!(error instanceof Starter198RepositoryError)) throw error;
      const raced = await repository.list(STARTER_COLLECTIONS.access, tenantId, { perPage: 2 });
      const row = raced.items.length === 1 ? raced.items[0] : null;
      if (!row || text(row.provisioning_idempotency_key) !== idempotencyKey
        || text(row.provisioning_request_hash) !== requestHash) {
        throw new Starter198ProvisioningError('starter_198_provisioning_storage_unavailable', 503);
      }
      return { access: await repository.access(tenantId), created: false };
    }
    return { access: await repository.access(tenantId), created: true };
  }, transitionStore);
}
