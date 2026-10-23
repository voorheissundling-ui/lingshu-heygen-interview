import { randomUUID } from 'node:crypto';
import type { Record_ } from '../storage/datastore.js';
import type { Starter198Repository } from './repository.js';
import { organizationRoleOrNull } from '../lib/organizationRole.js';
import { acquireDurableOperationLease, assertDurableOperationLease, releaseDurableOperationLease } from '../runtime/durableLease.js';
import { socialContentAccessResolver } from './socialContentAccess.js';
import { assertOrchestratorAdmissionQuota } from './quota.js';
import { socialJson, socialObject, socialRequestHash } from './socialContentValidation.js';
import { createSocialSceneReworkIntent } from './socialContentSceneRework.js';
import { createSocialSceneReworkService } from './socialContentSceneReworkService.js';
import { createSocialSceneReworkCostPolicyService, type SceneReworkCostScope } from './socialContentSceneReworkCostPolicy.js';

const fail = (code: string): never => { throw new Error(code); };
export interface SceneReworkAdmissionSelection {
  repository: Starter198Repository; tenantId: string; actorUserId: string; taskId: string;
  sourceRunId: string; parentArtifactId: string; affectedSceneIds: string[];
  expectedCacheHash?: string; env?: NodeJS.ProcessEnv;
}
export interface SceneReworkAdmissionPreview {
  type: 'scene_rework_admission_preview'; version: 1; tenantId: string; taskId: string;
  sourceRunId: string; parentArtifactId: string; affectedSceneIds: string[]; operationId: string;
  executionRunId: string; cacheHash: string; planHash: string; localOnly: boolean;
  quote: Awaited<ReturnType<ReturnType<typeof createSocialSceneReworkCostPolicyService>['readPrepared']>>['quote'];
  gaps: string[]; previewHash: string;
}

async function prepare(input: SceneReworkAdmissionSelection) {
  const store = input.repository.dataStore;
  if (!store) fail('scene_rework_persistent_store_required');
  const dataStore = store!;
  for (const value of [input.tenantId, input.actorUserId, input.taskId, input.sourceRunId, input.parentArtifactId]) {
    if (!/^[a-zA-Z0-9._:@-]{1,200}$/.test(value)) fail('scene_rework_identity_invalid');
  }
  const user = await dataStore.getById<Record_>('users', input.actorUserId);
  const role = organizationRoleOrNull(user?.role);
  if (!user || user.tenantId !== input.tenantId || !role || role === 'customer_service'
    || user.disabled === true || user.active === false || ['disabled', 'suspended'].includes(String(user.status))) {
    fail('scene_rework_actor_forbidden');
  }
  const access = await socialContentAccessResolver.resolve({ repository: input.repository, tenantId: input.tenantId,
    requiredCapabilities: ['workflow.standard.run'], requireOpenCycle: true });
  if (access.kind !== 'starter_198') fail('scene_rework_resource_limits_unavailable');
  const resourceLimits = access.kind === 'starter_198' ? access.access.resourceLimits
    : fail('scene_rework_resource_limits_unavailable');
  const service = createSocialSceneReworkService(input.repository);
  const sourceScope = { tenantId: input.tenantId, taskId: input.taskId, runId: input.sourceRunId,
    parentArtifactId: input.parentArtifactId };
  const context = await service.readCache(sourceScope);
  if (input.expectedCacheHash !== undefined && input.expectedCacheHash !== context.cache.recordHash) {
    fail('scene_rework_cache_version_conflict');
  }
  const source = await dataStore.getById<Record_>('workflow_runs', input.sourceRunId);
  if (!source || source.tenant_id !== input.tenantId
    || !['succeeded', 'completed', 'failed'].includes(String(source.status))) fail('scene_rework_source_run_not_terminal');
  const operationIntent = createSocialSceneReworkIntent(context.cache, input.actorUserId,
    input.affectedSceneIds, 'pending-admission');
  if (context.cache.scenes.some(scene => !operationIntent.affectedSceneIds.includes(scene.sceneId)
    && scene.status !== 'passed')) fail('scene_rework_unselected_review_required');
  const executionRunId = socialRequestHash({ type: 'social_scene_rework_run', tenantId: input.tenantId,
    sourceRunId: input.sourceRunId, operationId: operationIntent.operationId }).slice(0, 15);
  const intent = createSocialSceneReworkIntent(context.cache, input.actorUserId,
    input.affectedSceneIds, executionRunId);
  const costScope: SceneReworkCostScope = { tenantId: input.tenantId, taskId: input.taskId,
    runId: executionRunId, operationId: intent.operationId, actorUserId: input.actorUserId };
  const evidence = await createSocialSceneReworkCostPolicyService(input.repository, input.env)
    .readPrepared(costScope, { ...context, intent });
  const previewBody = { type: 'scene_rework_admission_preview' as const, version: 1 as const,
    tenantId: input.tenantId, taskId: input.taskId, sourceRunId: input.sourceRunId,
    parentArtifactId: input.parentArtifactId, affectedSceneIds: [...intent.affectedSceneIds],
    operationId: intent.operationId, executionRunId, cacheHash: intent.cacheHash, planHash: intent.planHash,
    localOnly: evidence.localOnly, quote: evidence.quote, gaps: [...evidence.gaps] };
  const preview: SceneReworkAdmissionPreview = { ...previewBody, previewHash: socialRequestHash(previewBody) };
  return { store: dataStore, service, source: source!, context, intent, costScope, resourceLimits, preview };
}

/** Read-only trusted proposal. It never creates a run, intent, queue job or supplier request. */
export async function previewSocialSceneReworkAdmission(input: SceneReworkAdmissionSelection) {
  return (await prepare(input)).preview;
}

/** Persist an immutable paid-route confirmation before execution admission. */
export async function confirmSocialSceneReworkAdmissionCost(input: SceneReworkAdmissionSelection & {
  expectedPreviewHash: string; expectedQuoteHash: string; authorizedMaximumCostCny: number;
}) {
  const actual = await prepare(input);
  if (actual.preview.previewHash !== input.expectedPreviewHash || actual.preview.localOnly
    || actual.preview.gaps.length || actual.preview.quote?.recordHash !== input.expectedQuoteHash) {
    fail('scene_rework_admission_preview_conflict');
  }
  return createSocialSceneReworkCostPolicyService(input.repository, input.env).confirmPrepared(
    actual.costScope, { ...actual.context, intent: actual.intent }, {
      expectedQuoteHash: input.expectedQuoteHash, authorizedMaximumCostCny: input.authorizedMaximumCostCny,
    });
}

/** Creates the independent run and queue job only after a fresh preview and paid-policy check. */
export async function admitSocialSceneRework(input: SceneReworkAdmissionSelection & {
  expectedPreviewHash: string; expectedPolicyHash?: string;
}) {
  const store = input.repository.dataStore;
  if (!store) fail('scene_rework_persistent_store_required');
  const dataStore = store!;
  const lease = await acquireDurableOperationLease({ dataStore, tenantId: input.tenantId,
    scope: 'social_scene_rework_admission', subjectId: input.tenantId, ownerId: randomUUID() });
  if (!lease) fail('scene_rework_admission_busy');
  try {
    const actual = await prepare(input);
    if (actual.preview.previewHash !== input.expectedPreviewHash) fail('scene_rework_admission_preview_conflict');
    if (actual.preview.gaps.length) fail(actual.preview.gaps[0]!);
    if (actual.preview.localOnly) {
      if (input.expectedPolicyHash !== undefined) fail('scene_rework_cost_policy_not_required');
    } else {
      const policy = await createSocialSceneReworkCostPolicyService(input.repository, input.env)
        .requirePreparedConfirmed(actual.costScope, { ...actual.context, intent: actual.intent });
      if (!policy || !input.expectedPolicyHash || input.expectedPolicyHash !== policy.recordHash) {
        fail('scene_rework_cost_policy_confirmation_required');
      }
    }
    let run = await dataStore.getById<Record_>('workflow_runs', actual.preview.executionRunId);
    if (!run) {
      await assertOrchestratorAdmissionQuota({ repository: input.repository, tenantId: input.tenantId,
        limits: actual.resourceLimits });
      const payload = { type: 'social_scene_rework_authorization', version: 1, tenantId: input.tenantId,
        taskId: input.taskId, sourceRunId: input.sourceRunId, executionRunId: actual.preview.executionRunId,
        parentArtifactId: input.parentArtifactId, parentArtifactHash: actual.intent.parentArtifactHash,
        actorUserId: input.actorUserId, operationId: actual.intent.operationId, cacheHash: actual.intent.cacheHash,
        planHash: actual.intent.planHash, changeKind: 'visual_asset', authorizedAt: new Date().toISOString() };
      await assertDurableOperationLease({ dataStore, lease: lease! });
      run = await dataStore.create<Record_>('workflow_runs', { id: actual.preview.executionRunId,
        tenant_id: input.tenantId, goal_id: actual.source!.goal_id, plan_id: actual.source!.plan_id,
        status: 'running', current_controller: 'agent', product_profile: actual.source!.product_profile,
        starter_context: { sceneReworkAuthorization: { ...payload, recordHash: socialRequestHash(payload) } },
        started_at: payload.authorizedAt, completed_at: '' });
      if (!run) fail('scene_rework_run_save_failed');
    }
    const savedRun = run!;
    const authorization = socialObject(socialObject(socialJson(savedRun.starter_context))?.sceneReworkAuthorization);
    if (!authorization || savedRun.tenant_id !== input.tenantId || authorization.sourceRunId !== input.sourceRunId
      || authorization.operationId !== actual.intent.operationId) fail('scene_rework_run_conflict');
    await assertDurableOperationLease({ dataStore, lease: lease! });
    return actual.service.createIntent({ tenantId: input.tenantId, taskId: input.taskId,
      runId: input.sourceRunId, parentArtifactId: input.parentArtifactId,
      executionRunId: actual.preview.executionRunId, actorUserId: input.actorUserId,
      affectedSceneIds: input.affectedSceneIds, changeKind: 'visual_asset' });
  } finally { await releaseDurableOperationLease({ dataStore, lease: lease! }); }
}
