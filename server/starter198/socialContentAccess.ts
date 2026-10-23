import type { Starter198Capability } from '../../shared/contracts/starter198.js';
import {
  getTenantSubscription,
  isEntitled,
  type Subscription,
} from '../middleware/subscription.js';
import {
  buildStarter198CapabilityManifest,
  starter198CapabilityAllowed,
  type Starter198AccessSnapshot,
} from './profile.js';
import { assertStarter198AccessCycleOpen } from './quota.js';
import {
  Starter198RepositoryError,
  type Starter198Repository,
} from './repository.js';

export type SocialContentResolvedAccess =
  | {
    kind: 'starter_198';
    access: Starter198AccessSnapshot;
  }
  | {
    kind: 'subscription';
    subscription: Subscription;
  };

export class SocialContentAccessError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = 'SocialContentAccessError';
  }
}

export interface SocialContentAccessResolver {
  resolve(input: {
    repository: Starter198Repository;
    tenantId: string;
    requiredCapabilities: readonly Starter198Capability[];
    now?: Date;
    requireOpenCycle?: boolean;
  }): Promise<SocialContentResolvedAccess>;
}

export interface SocialContentAccessResolverDependencies {
  loadSubscription?: (tenantId: string) => Promise<Subscription>;
  subscriptionEntitled?: (subscription: Subscription) => boolean;
}

/**
 * Resolves the authority for the shared social-content workflow.
 *
 * A provisioned starter_198 tenant is always governed by its starter manifest;
 * a disabled capability or a malformed/unavailable access record never falls
 * through to the broader subscription. Only the explicit not-provisioned case
 * may use the normal tenant subscription authority.
 */
export function createSocialContentAccessResolver(
  dependencies: SocialContentAccessResolverDependencies = {},
): SocialContentAccessResolver {
  const loadSubscription = dependencies.loadSubscription ?? getTenantSubscription;
  const subscriptionEntitled = dependencies.subscriptionEntitled ?? isEntitled;

  return {
    async resolve(input): Promise<SocialContentResolvedAccess> {
      let access: Starter198AccessSnapshot;
      try {
        access = await input.repository.access(input.tenantId);
      } catch (error) {
        if (!(error instanceof Starter198RepositoryError)
          || error.code !== 'starter_198_not_provisioned') {
          throw error;
        }
        const subscription = await loadSubscription(input.tenantId);
        if (!subscriptionEntitled(subscription)) {
          throw new SocialContentAccessError('social_content_not_entitled', 403);
        }
        return { kind: 'subscription', subscription };
      }

      if (input.requireOpenCycle) {
        assertStarter198AccessCycleOpen({ access, now: input.now });
      }
      const manifest = buildStarter198CapabilityManifest(access, input.now);
      if (input.requiredCapabilities.some(capability => !starter198CapabilityAllowed(manifest, capability))) {
        throw new SocialContentAccessError('social_content_not_entitled', 403);
      }
      return { kind: 'starter_198', access };
    },
  };
}

export const socialContentAccessResolver = createSocialContentAccessResolver();
