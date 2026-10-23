import type {
  CreateSocialArtifactInput,
  CreateSocialDeliveryPackageInput,
  DecideSocialArtifactBatchInput,
  DecideSocialArtifactInput,
  RegisterSocialPublicationInput,
  SocialContentArtifact,
  SocialContentTaskDetail,
  SocialDeliveryPackage,
  SocialMetricSubmission,
  SocialPublicationRecord,
  SubmitSocialMetricsInput,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import {
  findSocialRecord,
  readSocialTaskDetail,
  requireSocialTask,
  socialArtifact,
  socialDeliveryPackage,
  socialMetricSubmission,
  socialPublication,
  socialTaskReadiness,
  socialTaskSummary,
} from './socialContentRecords.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialPublicId,
  socialRequestHash,
  socialText,
} from './socialContentValidation.js';
import { requireOwnedSocialFileRef, type SocialContentBackendFilePort } from './socialContentFiles.js';
import { assertSocialTaskChildCapacity } from './socialContentLimits.js';
import { store } from '../storage/index.js';
import { verifiedStudioGenerationFromSpec } from '../lib/studioGenerationVerification.js';
import {
  readSocialContentSourceCoverage,
  reconcileSocialContentTask,
} from './socialContentProjection.js';
import {
  parseSocialDeliveryManifest,
  type SocialDeliveryManifest,
} from './socialDeliveryArchive.js';
import { resolveSelectedPackages } from './socialWorkPackages.js';
import {
  resolveSocialArtifactMedia,
  socialArtifactMediaDescriptor,
  socialArtifactMediaFamily,
} from './socialArtifactMedia.js';
import type { SocialContentAccessResolver } from './socialContentAccess.js';
import type { Starter198OrchestratorQueuePort } from './runtimePorts.js';
import { startSocialContentTask } from './socialContentTasks.js';
import { materialDecisionFeedback } from '../videoProduction/materialQualityLearning.js';
import { socialManagedArtifactReview } from './socialContentManagedReview.js';
import { assertSocialContentReleaseQuality } from './socialContentReleaseQuality.js';

import {
  MAX_SOCIAL_DELIVERY_MANIFEST_BYTES,
  OUTPUT_EDITABLE_STATES,
  assertStudioSocialArtifactGeneration,
  assertTaskVersion,
  byOperation,
  nextVersion,
  scheduleSocialArtifactRevision,
} from './socialContentOutputSupport.js';

export async function createSocialContentArtifact(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  idempotencyKey: string;
  value: CreateSocialArtifactInput;
  trustedAgentOrigin?: boolean;
  /** Server-selected execution policy; never accepted from an HTTP payload. */
  requireHumanReview?: boolean;
  accessResolver?: SocialContentAccessResolver;
  backendFilePort?: SocialContentBackendFilePort;
  now?: Date;
}): Promise<{ artifact: SocialContentArtifact; task: SocialContentTaskDetail }> {
  await assertStudioSocialArtifactGeneration(input.tenantId, input.value.kind, input.value.content);
  if (input.value.origin === 'agent' && !input.trustedAgentOrigin) {
    throw new SocialContentWorkflowError('social_artifact_agent_origin_forbidden', 403);
  }
  const mutation = await executeSocialContentMutation<{ artifact: SocialContentArtifact; task: SocialContentTaskDetail }>({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash(input.requireHumanReview
      ? { value: input.value, requireHumanReview: true } : input.value),
    operation: 'create_social_content_artifact',
    targetId: input.taskId,
    now: input.now,
    replay: async operationId => {
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialContentArtifacts, operationId });
      if (!existing) throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
      return { artifact: socialArtifact(existing), task: (await readSocialTaskDetail(input))! };
    },
    action: async operationId => {
      const task = await requireSocialTask(input);
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialContentArtifacts, operationId });
      if (existing) {
        await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
        return { artifact: socialArtifact(existing), task: (await readSocialTaskDetail(input))! };
      }
      const taskStatus = socialText(task.status);
      if (taskStatus === 'plan_review') {
        if (input.value.origin !== 'manual') {
          throw new SocialContentWorkflowError('social_content_artifact_not_allowed', 409);
        }
        const summary = socialTaskSummary(task);
        const readiness = socialTaskReadiness(
          summary.brief,
          await readSocialContentSourceCoverage(input),
          summary.theme ? {
            theme: summary.theme,
            materialReadiness: summary.materialReadiness ?? {
              complete: true,
              requiredCount: 0,
              satisfiedRequiredCount: 0,
              blockingRequirementIds: [],
            },
          } : undefined,
        );
        if (!readiness.complete) {
          throw new SocialContentWorkflowError('social_content_task_inputs_incomplete', 409);
        }
        await resolveSelectedPackages({
          repository: input.repository,
          selections: summary.packageSelection,
          now: input.now,
        });
      } else if (!OUTPUT_EDITABLE_STATES.has(taskStatus)) {
        throw new SocialContentWorkflowError('social_content_artifact_not_allowed', 409);
      }
      await assertSocialTaskChildCapacity({ ...input, kind: 'artifact' });
      const media = await resolveSocialArtifactMedia(input);
      let parent: StarterRecord | null = null;
      if (input.value.parentArtifactId) {
        parent = await findSocialRecord({
          ...input,
          collection: STARTER_COLLECTIONS.socialContentArtifacts,
          where: { artifact_id: input.value.parentArtifactId, task_id: input.taskId },
          notFoundCode: 'social_artifact_parent_not_found',
        });
      }
      const timestamp = (input.now ?? new Date()).toISOString();
      const artifactId = socialPublicId('socialart');
      const automaticReview = input.requireHumanReview
        ? { approved: false, reason: 'human_review_required' }
        : socialManagedArtifactReview({
        tenantId: input.tenantId,
        brief: socialTaskSummary(task).brief,
        trustedAgentOrigin: input.trustedAgentOrigin,
        origin: input.value.origin,
        kind: input.value.kind,
        resourceRef: media?.file.fileRef ?? input.value.resourceRef,
        content: input.value.content,
      });
      const content = {
        ...(input.value.content ?? {}),
        ...(automaticReview.approved ? { review: {
          state: 'automatically_approved', automatedChecksPassed: true,
          reviewedBy: 'director_agent', ruleVersion: 'social-managed-review.v1',
          reason: automaticReview.reason,
        } } : {}),
        ...(media ? { media: socialArtifactMediaDescriptor(artifactId, media.file) } : {}),
      };
      const created = await input.repository.create(STARTER_COLLECTIONS.socialContentArtifacts, input.tenantId, {
        artifact_id: artifactId,
        task_id: input.taskId,
        artifact_kind: input.value.kind,
        platform: input.value.platform ?? '',
        language: input.value.language ?? '',
        version: '1',
        status: automaticReview.approved ? 'approved' : 'review_required',
        origin: input.value.origin,
        resource_ref: media?.file.fileRef ?? input.value.resourceRef ?? '',
        content,
        content_hash: socialRequestHash({ resourceRef: media?.file.fileRef ?? input.value.resourceRef, content }),
        parent_artifact_id: input.value.parentArtifactId ?? '',
        decision_note: automaticReview.approved ? automaticReview.reason : '',
        created_operation_id: operationId,
        last_operation_id: operationId,
        created_by: input.userId,
        updated_by: input.userId,
        created_at: timestamp,
        updated_at: timestamp,
      });
      if (parent && socialText(parent.status) !== 'superseded') {
        await input.repository.update(STARTER_COLLECTIONS.socialContentArtifacts, input.tenantId, parent.id, {
          status: 'superseded',
          updated_by: input.userId,
          updated_at: timestamp,
        });
      }
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
      return { artifact: socialArtifact(created), task: (await readSocialTaskDetail(input))! };
    },
  });
  return mutation.value;
}

export async function decideSocialContentArtifact(input: {
  repository: Starter198Repository;
  orchestratorQueue?: Starter198OrchestratorQueuePort;
  tenantId: string;
  userId: string;
  taskId: string;
  artifactId: string;
  idempotencyKey: string;
  value: DecideSocialArtifactInput;
  weeklyRevisionBridge?: {
    handles(input:{tenantId:string;taskId:string;artifactId:string}):Promise<boolean>;
    persist(input:{tenantId:string;actorUserId:string;taskId:string;artifactId:string;operationId:string;operationRequestHash:string;note:string}):Promise<unknown>;
  };
  now?: Date;
}): Promise<{ artifact: SocialContentArtifact; task: SocialContentTaskDetail }> {
  const weeklyRevisionHandled=input.value.decision==='changes_requested'&&!!input.weeklyRevisionBridge&&await input.weeklyRevisionBridge.handles({tenantId:input.tenantId,taskId:input.taskId,artifactId:input.artifactId});
  const operationRequestHash=socialRequestHash(weeklyRevisionHandled?{artifactId:input.artifactId,value:input.value}:input.value);
  const mutation = await executeSocialContentMutation<{ artifact: SocialContentArtifact; task: SocialContentTaskDetail }>({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: operationRequestHash,
    operation: 'decide_social_content_artifact',
    targetId: input.taskId,
    now: input.now,
    replay: async operationId => {
      const artifact = await findSocialRecord({
        ...input,
        collection: STARTER_COLLECTIONS.socialContentArtifacts,
        where: { artifact_id: input.artifactId, task_id: input.taskId },
        notFoundCode: 'social_artifact_not_found',
      });
      if (input.value.decision === 'approved') {
        await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
      } else if(weeklyRevisionHandled){
        await input.weeklyRevisionBridge!.persist({tenantId:input.tenantId,actorUserId:input.userId,taskId:input.taskId,artifactId:input.artifactId,operationId,operationRequestHash,note:input.value.note??''});
      }
      return { artifact: socialArtifact(artifact), task: (await readSocialTaskDetail(input))! };
    },
    action: async operationId => {
      const task = await requireSocialTask(input);
      const artifact = await findSocialRecord({
        ...input,
        collection: STARTER_COLLECTIONS.socialContentArtifacts,
        where: { artifact_id: input.artifactId, task_id: input.taskId },
        notFoundCode: 'social_artifact_not_found',
      });
      if (socialText(artifact.last_operation_id) === operationId) {
        if (input.value.decision === 'changes_requested') {
          if(weeklyRevisionHandled){
            await input.weeklyRevisionBridge!.persist({tenantId:input.tenantId,actorUserId:input.userId,taskId:input.taskId,artifactId:input.artifactId,operationId,operationRequestHash,note:input.value.note??''});
            return {artifact:socialArtifact(artifact),task:(await readSocialTaskDetail(input))!};
          }
          const taskDetail = await scheduleSocialArtifactRevision({
            ...input, operationId, artifactIds: [input.artifactId],
          });
          return { artifact: socialArtifact(artifact), task: taskDetail };
        }
        await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
        return { artifact: socialArtifact(artifact), task: (await readSocialTaskDetail(input))! };
      }
      if (socialText(artifact.version) !== input.value.expectedVersion) {
        throw new SocialContentWorkflowError('social_artifact_version_conflict', 409);
      }
      if (socialText(artifact.status) !== 'review_required') {
        throw new SocialContentWorkflowError('social_artifact_not_decidable', 409);
      }
      if (input.value.decision === 'changes_requested' && !weeklyRevisionHandled && !input.orchestratorQueue) {
        throw new SocialContentWorkflowError('social_content_orchestrator_not_configured', 503);
      }
      if (input.value.decision === 'changes_requested' && !weeklyRevisionHandled
        && !['asset_review', 'attention', 'paused'].includes(socialText(task.status))) {
        throw new SocialContentWorkflowError('social_content_revision_not_startable', 409);
      }
      if (input.value.decision === 'approved') {
        await assertStudioSocialArtifactGeneration(input.tenantId, socialText(artifact.artifact_kind), artifact.content);
        assertSocialContentReleaseQuality({ tenantId: input.tenantId, brief: socialTaskSummary(task).brief, content: socialJson(artifact.content), mode: 'human' });
      }
      const timestamp = (input.now ?? new Date()).toISOString();
      const qualityFeedback = materialDecisionFeedback({
        artifactContent: socialJson(artifact.content), decision: input.value.decision,
        note: input.value.note, decidedAt: timestamp,
      });
      await input.repository.update(STARTER_COLLECTIONS.socialContentArtifacts, input.tenantId, artifact.id, {
        status: input.value.decision,
        version: nextVersion(artifact.version, 'social_artifact_record_invalid'),
        decision_note: input.value.note ?? '',
        ...(qualityFeedback ? { quality_feedback: qualityFeedback } : {}),
        last_operation_id: operationId,
        updated_by: input.userId,
        updated_at: timestamp,
      });
      const updated = await findSocialRecord({
        ...input,
        collection: STARTER_COLLECTIONS.socialContentArtifacts,
        where: { artifact_id: input.artifactId, task_id: input.taskId },
        notFoundCode: 'social_artifact_not_found',
      });
      if (input.value.decision === 'changes_requested') {
        if(weeklyRevisionHandled){
          await input.weeklyRevisionBridge!.persist({tenantId:input.tenantId,actorUserId:input.userId,taskId:input.taskId,artifactId:input.artifactId,operationId,operationRequestHash,note:input.value.note??''});
          return {artifact:socialArtifact(updated),task:(await readSocialTaskDetail(input))!};
        }
        const taskDetail = await scheduleSocialArtifactRevision({
          ...input, operationId, artifactIds: [input.artifactId],
        });
        return { artifact: socialArtifact(updated), task: taskDetail };
      }
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
      return { artifact: socialArtifact(updated), task: (await readSocialTaskDetail(input))! };
    },
  });
  return mutation.value;
}

export async function decideSocialContentArtifactBatch(input: {
  repository: Starter198Repository;
  orchestratorQueue?: Starter198OrchestratorQueuePort;
  tenantId: string;
  userId: string;
  taskId: string;
  idempotencyKey: string;
  value: DecideSocialArtifactBatchInput;
  now?: Date;
}): Promise<SocialContentTaskDetail> {
  const mutation = await executeSocialContentMutation<{ task: SocialContentTaskDetail }>({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash(input.value),
    operation: 'decide_social_content_artifact_batch',
    targetId: input.taskId,
    now: input.now,
    replay: async operationId => {
      if (input.value.decision === 'approved') {
        await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
      }
      return { task: (await readSocialTaskDetail(input))! };
    },
    action: async operationId => {
      const task = await requireSocialTask(input);
      const records = await Promise.all(input.value.artifacts.map(item => findSocialRecord({
        ...input,
        collection: STARTER_COLLECTIONS.socialContentArtifacts,
        where: { artifact_id: item.artifactId, task_id: input.taskId },
        notFoundCode: 'social_artifact_not_found',
      })));

      if (input.value.decision === 'approved') {
        for (const record of records) assertSocialContentReleaseQuality({
          tenantId: input.tenantId, brief: socialTaskSummary(task).brief, content: socialJson(record.content), mode: 'human',
        });
        await Promise.all(records.map(record => assertStudioSocialArtifactGeneration(
          input.tenantId,
          socialText(record.artifact_kind),
          record.content,
        )));
      }
      if (input.value.decision === 'changes_requested' && !input.orchestratorQueue) {
        throw new SocialContentWorkflowError('social_content_orchestrator_not_configured', 503);
      }
      if (input.value.decision === 'changes_requested'
        && !['asset_review', 'attention', 'paused'].includes(socialText(task.status))) {
        throw new SocialContentWorkflowError('social_content_revision_not_startable', 409);
      }

      records.forEach((record, index) => {
        if (socialText(record.last_operation_id) === operationId) return;
        if (socialText(record.version) !== input.value.artifacts[index].expectedVersion) {
          throw new SocialContentWorkflowError('social_artifact_version_conflict', 409);
        }
        if (socialText(record.status) !== 'review_required') {
          throw new SocialContentWorkflowError('social_artifact_not_decidable', 409);
        }
      });

      const timestamp = (input.now ?? new Date()).toISOString();
      for (const record of records) {
        if (socialText(record.last_operation_id) === operationId) continue;
        const qualityFeedback = materialDecisionFeedback({
          artifactContent: socialJson(record.content), decision: input.value.decision,
          note: input.value.note, decidedAt: timestamp,
        });
        await input.repository.update(STARTER_COLLECTIONS.socialContentArtifacts, input.tenantId, record.id, {
          status: input.value.decision,
          version: nextVersion(record.version, 'social_artifact_record_invalid'),
          decision_note: input.value.note ?? '',
          ...(qualityFeedback ? { quality_feedback: qualityFeedback } : {}),
          last_operation_id: operationId,
          updated_by: input.userId,
          updated_at: timestamp,
        });
      }
      if (input.value.decision === 'changes_requested') {
        return { task: await scheduleSocialArtifactRevision({
          ...input,
          operationId,
          artifactIds: input.value.artifacts.map(item => item.artifactId),
        }) };
      }
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'asset_review' });
      return { task: (await readSocialTaskDetail(input))! };
    },
  });
  return mutation.value.task;
}

export async function createSocialDeliveryPackage(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  idempotencyKey: string;
  value: CreateSocialDeliveryPackageInput;
  accessResolver?: SocialContentAccessResolver;
  backendFilePort?: SocialContentBackendFilePort;
  now?: Date;
}): Promise<{ deliveryPackage: SocialDeliveryPackage; task: SocialContentTaskDetail }> {
  const mutation = await executeSocialContentMutation<{ deliveryPackage: SocialDeliveryPackage; task: SocialContentTaskDetail }>({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash(input.value),
    operation: 'create_social_delivery_package',
    targetId: input.taskId,
    now: input.now,
    replay: async operationId => {
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialDeliveryPackages, operationId });
      if (!existing) throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'delivered' });
      return { deliveryPackage: socialDeliveryPackage(existing), task: (await readSocialTaskDetail(input))! };
    },
    action: async operationId => {
      const task = await requireSocialTask(input);
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialDeliveryPackages, operationId });
      if (existing) {
        await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'delivered' });
        return { deliveryPackage: socialDeliveryPackage(existing), task: (await readSocialTaskDetail(input))! };
      }
      assertTaskVersion(task, input.value.expectedTaskVersion);
      if (!['asset_review', 'packaging'].includes(socialText(task.status))) {
        throw new SocialContentWorkflowError('social_delivery_package_not_allowed', 409);
      }
      await assertSocialTaskChildCapacity({ ...input, kind: 'delivery_package' });
      const artifacts: SocialContentArtifact[] = [];
      const media: SocialDeliveryManifest['media'] = [];
      for (const artifactId of input.value.artifactIds) {
        const record = await findSocialRecord({
          ...input,
          collection: STARTER_COLLECTIONS.socialContentArtifacts,
          where: { artifact_id: artifactId, task_id: input.taskId },
          notFoundCode: 'social_delivery_artifact_not_found',
        });
        const artifact = socialArtifact(record);
        if (artifact.status !== 'approved') throw new SocialContentWorkflowError('social_delivery_artifact_not_approved', 409);
        await assertStudioSocialArtifactGeneration(input.tenantId, artifact.kind, artifact.content);
        assertSocialContentReleaseQuality({ tenantId: input.tenantId, brief: socialTaskSummary(task).brief, content: artifact.content, mode: 'human' });
        const resolvedMedia = await resolveSocialArtifactMedia({
          repository: input.repository,
          tenantId: input.tenantId,
          taskId: input.taskId,
          backendFilePort: input.backendFilePort,
          value: {
            kind: artifact.kind,
            platform: artifact.platform,
            language: artifact.language,
            origin: artifact.origin,
            resourceRef: artifact.resourceRef,
            content: artifact.content,
            parentArtifactId: artifact.parentArtifactId,
          },
        });
        if (socialArtifactMediaFamily(artifact.kind, artifact.content) && !resolvedMedia) {
          throw new SocialContentWorkflowError('social_delivery_media_required', 409);
        }
        if (resolvedMedia) media.push(socialArtifactMediaDescriptor(artifact.artifactId, resolvedMedia.file));
        artifacts.push(artifact);
      }
      const timestamp = (input.now ?? new Date()).toISOString();
      const packageId = socialPublicId('socialpkg');
      const manifest: SocialDeliveryManifest = {
        schemaVersion: 'social-content.delivery.v1', taskId: input.taskId, packageId, artifacts, media,
      };
      if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_SOCIAL_DELIVERY_MANIFEST_BYTES) {
        throw new SocialContentWorkflowError('social_delivery_package_too_large', 413);
      }
      const packageHash = socialRequestHash(manifest);
      const taskDetail = await readSocialTaskDetail(input);
      if (!taskDetail) throw new SocialContentWorkflowError('social_content_task_not_found', 404);
      const created = await input.repository.create(STARTER_COLLECTIONS.socialDeliveryPackages, input.tenantId, {
        package_id: packageId,
        task_id: input.taskId,
        version: String(taskDetail.deliveryPackages.length + 1),
        status: 'ready',
        artifact_ids: artifacts.map(item => item.artifactId),
        manifest,
        package_hash: packageHash,
        created_operation_id: operationId,
        last_operation_id: operationId,
        created_by: input.userId,
        created_at: timestamp,
        updated_at: timestamp,
      });
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'delivered' });
      return { deliveryPackage: socialDeliveryPackage(created), task: (await readSocialTaskDetail(input))! };
    },
  });
  const {reconcileSocialContentOrderProjection}=await import('./socialContentOrderProjection.js');
  await reconcileSocialContentOrderProjection(input);
  return mutation.value;
}

export async function readSocialDeliveryPackage(input: {
  repository: Starter198Repository;
  tenantId: string;
  packageId: string;
}): Promise<{ view: SocialDeliveryPackage; manifest: SocialDeliveryManifest }> {
  const record = await findSocialRecord({
    ...input,
    collection: STARTER_COLLECTIONS.socialDeliveryPackages,
    where: { package_id: input.packageId },
    notFoundCode: 'social_delivery_package_not_found',
  });
  const view = socialDeliveryPackage(record);
  if (!['ready', 'confirmed'].includes(view.status)) {
    throw new SocialContentWorkflowError('social_delivery_package_not_ready', 409);
  }
  const rawManifest = socialJson(record.manifest);
  const manifestRecord = socialObject(rawManifest);
  if (!manifestRecord || socialRequestHash(manifestRecord) !== socialText(record.package_hash)) {
    throw new SocialContentWorkflowError('social_delivery_package_integrity_violation', 503);
  }
  const manifest = parseSocialDeliveryManifest(manifestRecord, {
    taskId: view.taskId,
    packageId: view.packageId,
    artifactIds: view.artifactIds,
  });
  return { view, manifest };
}

export async function registerSocialPublication(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  idempotencyKey: string;
  value: RegisterSocialPublicationInput;
  now?: Date;
}): Promise<{ publication: SocialPublicationRecord; task: SocialContentTaskDetail }> {
  const mutation = await executeSocialContentMutation<{ publication: SocialPublicationRecord; task: SocialContentTaskDetail }>({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash(input.value),
    operation: 'register_social_publication',
    targetId: input.taskId,
    now: input.now,
    replay: async operationId => {
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialPublications, operationId });
      if (!existing) throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'awaiting_metrics' });
      return { publication: socialPublication(existing), task: (await readSocialTaskDetail(input))! };
    },
    action: async operationId => {
      const task = await requireSocialTask(input);
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialPublications, operationId });
      if (existing) {
        await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'awaiting_metrics' });
        return { publication: socialPublication(existing), task: (await readSocialTaskDetail(input))! };
      }
      assertTaskVersion(task, input.value.expectedTaskVersion);
      if (!['delivered', 'awaiting_publish', 'awaiting_metrics'].includes(socialText(task.status))) {
        throw new SocialContentWorkflowError('social_publication_not_allowed', 409);
      }
      await assertSocialTaskChildCapacity({ ...input, kind: 'publication' });
      const delivery = await findSocialRecord({
        ...input,
        collection: STARTER_COLLECTIONS.socialDeliveryPackages,
        where: { package_id: input.value.packageId, task_id: input.taskId },
        notFoundCode: 'social_delivery_package_not_found',
      });
      if (!['ready', 'confirmed'].includes(socialText(delivery.status))) {
        throw new SocialContentWorkflowError('social_delivery_package_not_ready', 409);
      }
      const timestamp = (input.now ?? new Date()).toISOString();
      const created = await input.repository.create(STARTER_COLLECTIONS.socialPublications, input.tenantId, {
        publication_id: socialPublicId('socialpub'),
        task_id: input.taskId,
        package_id: input.value.packageId,
        platform: input.value.platform,
        account_label: input.value.accountLabel ?? '',
        public_url: input.value.publicUrl ?? '',
        platform_post_id: input.value.platformPostId ?? '',
        published_at: input.value.publishedAt,
        notes: input.value.notes ?? '',
        status: 'registered',
        created_operation_id: operationId,
        last_operation_id: operationId,
        created_by: input.userId,
        created_at: timestamp,
        updated_at: timestamp,
      });
      await reconcileSocialContentTask({ ...input, operationId, preferredStatus: 'awaiting_metrics' });
      return { publication: socialPublication(created), task: (await readSocialTaskDetail(input))! };
    },
  });
  return mutation.value;
}

export async function submitSocialMetrics(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  publicationId: string;
  idempotencyKey: string;
  value: SubmitSocialMetricsInput;
  now?: Date;
}): Promise<{ metricSubmission: SocialMetricSubmission; task: SocialContentTaskDetail }> {
  const publication = await findSocialRecord({
    ...input,
    collection: STARTER_COLLECTIONS.socialPublications,
    where: { publication_id: input.publicationId },
    notFoundCode: 'social_publication_not_found',
  });
  const taskId = socialText(publication.task_id);
  if (['table', 'screenshot'].includes(input.value.method) && !input.value.evidenceRefs?.length) {
    throw new SocialContentWorkflowError('social_metrics_evidence_required', 400);
  }
  for (const fileRef of input.value.evidenceRefs ?? []) {
    await requireOwnedSocialFileRef({
      repository: input.repository,
      tenantId: input.tenantId,
      taskId,
      fileRef,
      usage: 'metric_evidence',
    });
  }
  const mutation = await executeSocialContentMutation<{ metricSubmission: SocialMetricSubmission; task: SocialContentTaskDetail }>({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    requestHash: socialRequestHash(input.value),
    operation: 'submit_social_metrics',
    targetId: taskId,
    now: input.now,
    replay: async operationId => {
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialMetricSubmissions, operationId });
      if (!existing) throw new SocialContentWorkflowError('social_content_operation_integrity_violation', 503);
      await reconcileSocialContentTask({ ...input, taskId, operationId, preferredStatus: 'awaiting_metrics' });
      return { metricSubmission: socialMetricSubmission(existing), task: (await readSocialTaskDetail({ ...input, taskId }))! };
    },
    action: async operationId => {
      await requireSocialTask({ ...input, taskId });
      const existing = await byOperation({ ...input, collection: STARTER_COLLECTIONS.socialMetricSubmissions, operationId });
      if (existing) {
        await reconcileSocialContentTask({ ...input, taskId, operationId, preferredStatus: 'awaiting_metrics' });
        return { metricSubmission: socialMetricSubmission(existing), task: (await readSocialTaskDetail({ ...input, taskId }))! };
      }
      await assertSocialTaskChildCapacity({
        ...input,
        taskId,
        kind: 'metric_submission',
        publicationId: input.publicationId,
      });
      const previous = await input.repository.list(STARTER_COLLECTIONS.socialMetricSubmissions, input.tenantId, {
        where: { publication_id: input.publicationId }, perPage: 500,
      });
      const timestamp = (input.now ?? new Date()).toISOString();
      const created = await input.repository.create(STARTER_COLLECTIONS.socialMetricSubmissions, input.tenantId, {
        submission_id: socialPublicId('socialmetric'),
        task_id: taskId,
        publication_id: input.publicationId,
        method: input.value.method,
        captured_at: input.value.capturedAt,
        metrics: input.value.metrics,
        evidence_refs: input.value.evidenceRefs ?? [],
        notes: input.value.notes ?? '',
        status: 'received',
        version: String(previous.totalItems + 1),
        created_operation_id: operationId,
        last_operation_id: operationId,
        created_by: input.userId,
        created_at: timestamp,
      });
      await reconcileSocialContentTask({ ...input, taskId, operationId, preferredStatus: 'awaiting_metrics' });
      return { metricSubmission: socialMetricSubmission(created), task: (await readSocialTaskDetail({ ...input, taskId }))! };
    },
  });
  return mutation.value;
}
