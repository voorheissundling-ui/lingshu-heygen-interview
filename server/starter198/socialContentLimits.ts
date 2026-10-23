import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  SocialContentAccessError,
  socialContentAccessResolver,
  type SocialContentAccessResolver,
} from './socialContentAccess.js';
import { SocialContentWorkflowError } from './socialContentValidation.js';

export const SOCIAL_CONTENT_HARD_LIMITS = {
  tasksPerTenant: 200,
  sourcesPerTask: 100,
  filesPerTask: 50,
  fileBytesPerTask: 512 * 1024 * 1024,
  artifactsPerTask: 100,
  deliveryPackagesPerTask: 40,
  publicationsPerTask: 100,
  metricSubmissionsPerTask: 500,
  metricSubmissionsPerPublication: 50,
} as const;

async function count(input: {
  repository: Starter198Repository;
  tenantId: string;
  collection: Parameters<Starter198Repository['list']>[0];
  where?: Record<string, string | number | boolean>;
}): Promise<number> {
  const result = await input.repository.list(input.collection, input.tenantId, {
    ...(input.where ? { where: input.where } : {}),
    page: 1,
    perPage: 1,
  });
  if (!Number.isSafeInteger(result.totalItems) || result.totalItems < 0) {
    throw new SocialContentWorkflowError('social_content_resource_integrity_violation', 503);
  }
  return result.totalItems;
}

export async function assertSocialTaskCapacity(input: {
  repository: Starter198Repository;
  tenantId: string;
}): Promise<void> {
  if (await count({ ...input, collection: STARTER_COLLECTIONS.socialContentTasks })
    >= SOCIAL_CONTENT_HARD_LIMITS.tasksPerTenant) {
    throw new SocialContentWorkflowError('social_content_task_limit_reached', 409);
  }
}

export async function assertSocialTaskChildCapacity(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  kind: 'source' | 'artifact' | 'delivery_package' | 'publication' | 'metric_submission';
  publicationId?: string;
  accessResolver?: SocialContentAccessResolver;
  now?: Date;
}): Promise<void> {
  const limits = SOCIAL_CONTENT_HARD_LIMITS;
  const configured = {
    source: { collection: STARTER_COLLECTIONS.socialTaskSources, maximum: limits.sourcesPerTask },
    artifact: { collection: STARTER_COLLECTIONS.socialContentArtifacts, maximum: limits.artifactsPerTask },
    delivery_package: { collection: STARTER_COLLECTIONS.socialDeliveryPackages, maximum: limits.deliveryPackagesPerTask },
    publication: { collection: STARTER_COLLECTIONS.socialPublications, maximum: limits.publicationsPerTask },
    metric_submission: { collection: STARTER_COLLECTIONS.socialMetricSubmissions, maximum: limits.metricSubmissionsPerTask },
  } as const;
  const target = configured[input.kind];
  let maximum: number = target.maximum;
  if (input.kind === 'artifact' || input.kind === 'delivery_package') {
    let resolved;
    try {
      resolved = await (input.accessResolver ?? socialContentAccessResolver).resolve({
        repository: input.repository,
        tenantId: input.tenantId,
        requiredCapabilities: ['orchestrator.command.submit'],
        now: input.now,
      });
    } catch (error) {
      if (error instanceof SocialContentAccessError) {
        throw new SocialContentWorkflowError(error.code, error.status);
      }
      throw error;
    }
    // Non-starter subscriptions intentionally receive only the conservative
    // workflow hard limits. Starter tenants retain their plan-specific caps.
    if (resolved.kind === 'starter_198') {
      const planMaximum = input.kind === 'artifact'
        ? resolved.access.resourceLimits.contentArtifactCountPerCycle
        : resolved.access.resourceLimits.publicationPackageCountPerContent;
      maximum = Math.min(maximum, Math.max(1, Math.floor(planMaximum)));
    }
  }
  if (await count({ ...input, collection: target.collection, where: { task_id: input.taskId } }) >= maximum) {
    throw new SocialContentWorkflowError(`social_content_${input.kind}_limit_reached`, 409);
  }
  if (input.kind === 'metric_submission' && input.publicationId
    && await count({
      ...input,
      collection: STARTER_COLLECTIONS.socialMetricSubmissions,
      where: { publication_id: input.publicationId },
    }) >= limits.metricSubmissionsPerPublication) {
    throw new SocialContentWorkflowError('social_content_publication_metric_limit_reached', 409);
  }
}

export async function socialTaskFileCapacity(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
}): Promise<{ count: number; bytes: number; remainingBytes: number }> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentFiles, input.tenantId, {
    where: { task_id: input.taskId },
    page: 1,
    perPage: SOCIAL_CONTENT_HARD_LIMITS.filesPerTask,
  });
  if (result.totalItems >= SOCIAL_CONTENT_HARD_LIMITS.filesPerTask || result.items.length !== result.totalItems) {
    throw new SocialContentWorkflowError(
      result.totalItems >= SOCIAL_CONTENT_HARD_LIMITS.filesPerTask
        ? 'social_content_file_limit_reached'
        : 'social_content_file_resource_integrity_violation',
      result.totalItems >= SOCIAL_CONTENT_HARD_LIMITS.filesPerTask ? 409 : 503,
    );
  }
  const bytes = result.items.reduce((sum, record: StarterRecord) => {
    const size = Number(record.byte_size);
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new SocialContentWorkflowError('social_content_file_resource_integrity_violation', 503);
    }
    return sum + size;
  }, 0);
  if (!Number.isSafeInteger(bytes) || bytes > SOCIAL_CONTENT_HARD_LIMITS.fileBytesPerTask) {
    throw new SocialContentWorkflowError('social_content_file_resource_integrity_violation', 503);
  }
  return {
    count: result.totalItems,
    bytes,
    remainingBytes: SOCIAL_CONTENT_HARD_LIMITS.fileBytesPerTask - bytes,
  };
}
