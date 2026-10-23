import {publicationProductionDeadline} from '../socialPrograms/publicationDeadlines.js';
import { planNewSocialMaterialRoutes } from './socialContentMaterialRoutePlanning.js';
import type {
  AddSocialTaskSourceInput,
  CreateSocialContentTaskInput,
  CreateSocialWeeklyPlanInput,
  SelectSocialWorkPackagesInput,
  SocialContentTaskDetail,
  SocialContentTaskPage,
  SocialContentTaskSummary,
  SocialContentWorkspace,
  SocialWeeklyPlan,
  SocialContentAgentWorkflow,
  SocialTaskSource,
  UpdateSocialContentTaskInput,
} from '../../shared/contracts/socialContentWorkflow.js';
import type { BusinessContentGoal } from '../../shared/contracts/socialOperatingDecision.js';
import type { SocialWeeklyPublicationTask, VersionedSocialRef, WeeklyOperatingPackage, WeeklyWorkflowTask } from '../../shared/contracts/socialProgram.js';
import type { VersionedReferenceSelection } from '../socialDiscovery/orchestration.js';
import { buildSocialAgentWorkflow, type BuildSocialAgentWorkflowInput } from './socialContentAgentWorkflow.js';
import type { Starter198OrchestratorQueuePort } from './runtimePorts.js';
import { Starter198RuntimePortError } from './runtimePorts.js';
import { readTenantEnterpriseProfile } from '../lib/socialContentLegacyPorts.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { executeSocialContentMutation } from './socialContentMutation.js';
import {
  readSocialTaskDetail,
  findSocialRecord,
  requireSocialTask,
  socialTaskReadiness,
  socialTaskSource,
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
import {
  listActiveSocialWorkPackageCards,
  resolveSelectedPackages,
} from './socialWorkPackages.js';
import { requireOwnedSocialFileRef } from './socialContentFiles.js';
import { assertSocialTaskCapacity, assertSocialTaskChildCapacity } from './socialContentLimits.js';
import {
  socialContentSourceOptions,
  type SocialContentSourceOptionsPort,
} from './socialContentSourceOptions.js';
import {
  readSocialContentSourceCoverage,
  reconcileSocialContentTask,
} from './socialContentProjection.js';
import {
  SOCIAL_THEME_CATALOG,
  advisoryMaterialRequirements,
  materialReadiness,
  parseStoredMaterialRequirements,
  resolveSocialThemeSelection,
} from './socialContentThemes.js';
import {
  freezeSocialScriptBaseline,
  parseStoredSocialScriptBaseline,
  verifiedSocialScriptContext,
  type StoredSocialScriptBaseline,
} from './socialContentScriptBaseline.js';
import {
  pendingSocialTaskReferenceAnalysis,
  parseStoredSocialShotMaterialMap,
  resolveSocialInspirationScript,
  resolveSocialRecommendedReferenceScript,
  resolveSocialTaskReferenceScript,
  type ResolvedSocialTaskReference,
} from './socialContentScriptSources.js';

export const TASK_EDITABLE_STATES = new Set(['draft', 'needs_input', 'plan_review', 'paused', 'attention']);
export const SOURCE_EDITABLE_STATES = new Set(['draft', 'needs_input', 'plan_review', 'paused', 'attention']);

/**
 * T3/T4 adapter used by weekly orchestration. It intentionally requires the
 * frozen package item and selection instead of accepting a loose weekly-plan
 * id, so Starter198 cannot silently rebuild business authority from task UI.
 */
export function buildAuthoritativeSocialContentWorkflow(input: Omit<BuildSocialAgentWorkflowInput, 'mode' | 'weeklyPlanId' | 'authoritativeContext'> & {
  programRef: VersionedSocialRef;
  enterpriseProfileRef: VersionedSocialRef;
  weeklyPackage: WeeklyOperatingPackage;
  weeklyWorkflowTask: WeeklyWorkflowTask;
  publicationTask: SocialWeeklyPublicationTask;
  businessGoal: BusinessContentGoal;
  referenceSelection: VersionedReferenceSelection;
  selectedHandoffs: BuildSocialAgentWorkflowInput['inspirationHandoffs'];
}): SocialContentAgentWorkflow {
  return buildSocialAgentWorkflow({
    ...input,
    mode: 'weekly',
    weeklyPlanId: input.weeklyPackage.packageId,
    brief: {
      ...input.brief,
      objective: input.businessGoal.objective,
      audience: input.businessGoal.audiences[0] ?? input.brief.audience,
      markets: [...input.businessGoal.markets],
      languages: [...input.businessGoal.languages],
      platforms: [input.publicationTask.platform],
      callToAction: input.publicationTask.cta,
      dueAt: publicationProductionDeadline(input.publicationTask.publishWindow),
      weeklyBudgetCny: input.weeklyPackage.socialContentPackage.weeklyBudgetCny,
      perItemBudgetCny: Math.min(input.brief.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10,
        input.brief.perItemBudgetCny ?? (input.brief.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10),
        input.weeklyPackage.socialContentPackage.perItemBudgetCny ?? (input.brief.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10)),
    },
    factSourceRefs: input.publicationTask.factRefs.map(ref => `${ref.type}:${ref.id}@${ref.version}`),
    authoritativeContext: {
      programRef: input.programRef,
      enterpriseProfileRef: input.enterpriseProfileRef,
      weeklyPackage: input.weeklyPackage,
      weeklyWorkflowTask: input.weeklyWorkflowTask,
      publicationTask: input.publicationTask,
      businessGoal: input.businessGoal,
      referenceSelection: input.referenceSelection,
      selectedHandoffs: input.selectedHandoffs ?? [],
    },
  });
}

export function nextVersion(record: StarterRecord): string {
  const current = Number(record.version);
  if (!Number.isSafeInteger(current) || current < 1) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  return String(current + 1);
}

export function assertVersion(record: StarterRecord, expectedVersion: string): void {
  if (socialText(record.version) !== expectedVersion) {
    throw new SocialContentWorkflowError('social_content_task_version_conflict', 409);
  }
}

export async function taskCreatedByOperation(input: {
  repository: Starter198Repository;
  tenantId: string;
  idempotencyKey: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, {
    where: { create_idempotency_key: input.idempotencyKey }, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_task_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

export function socialWeeklyPlan(record: StarterRecord): SocialWeeklyPlan | null {
  const value = socialObject(socialJson(record.plan));
  if (!value || socialText(value.schemaVersion) !== 'social-content-weekly-plan.v1') return null;
  const taskIds = socialJson(value.taskIds);
  const status = socialText(record.status) as SocialWeeklyPlan['status'];
  const weeklyPlanId = socialText(value.weeklyPlanId) || socialText(record.id);
  if (!weeklyPlanId || !['draft', 'active', 'completed'].includes(status)
    || !Array.isArray(taskIds) || taskIds.some(item => !socialText(item))) {
    throw new SocialContentWorkflowError('social_weekly_plan_record_invalid', 503);
  }
  return {
    weeklyPlanId,
    title: socialText(value.title),
    objective: socialText(value.objective),
    productId: socialText(value.productId) || null,
    productRef: socialText(value.productRef) || null,
    audience: socialText(value.audience) || null,
    taskIds: taskIds.map(socialText),
    status,
    version: socialText(value.version) || '1',
    createdAt: socialText(record.created_at),
    updatedAt: socialText(record.updated_at) || socialText(record.created_at),
  };
}

export async function listSocialWeeklyPlans(input: {
  repository: Starter198Repository;
  tenantId: string;
}): Promise<SocialWeeklyPlan[]> {
  const first = await input.repository.list(STARTER_COLLECTIONS.plans, input.tenantId, {
    sort: '-created_at', page: 1, perPage: 500,
  });
  if (first.totalItems > 10_000) throw new SocialContentWorkflowError('social_weekly_plan_scan_limit_exceeded', 503);
  const rows = [...first.items];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await input.repository.list(STARTER_COLLECTIONS.plans, input.tenantId, {
      sort: '-created_at', page, perPage: 500,
    });
    rows.push(...next.items);
  }
  if (rows.length !== first.totalItems) throw new SocialContentWorkflowError('social_weekly_plan_integrity_violation', 503);
  return rows.map(socialWeeklyPlan).filter((item): item is SocialWeeklyPlan => Boolean(item));
}

export async function sourceCreatedByOperation(input: {
  repository: Starter198Repository;
  tenantId: string;
  operationId: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialTaskSources, input.tenantId, {
    where: { created_operation_id: input.operationId }, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_source_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

export function defaultBrief(value: CreateSocialContentTaskInput) {
  const themeDriven = Boolean(value.mode || value.themeId || value.customTopic || value.topic || value.weeklyPlanId);
  return {
    ...(value.materialRoutingPolicyVersion ? { materialRoutingPolicyVersion: value.materialRoutingPolicyVersion } : {}),
    ...(value.referenceReuse ? {referenceReuse: value.referenceReuse} : {}),
    title: value.title,
    objective: value.objective,
    productId: value.productId ?? null,
    productRef: value.productRef ?? null,
    requestedPresenterName: value.requestedPresenterName ?? null,
    requestedPresenterAssetId: value.requestedPresenterAssetId ?? null,
    presenterAssetId: value.presenterAssetId ?? null,
    audience: value.audience ?? null,
    markets: value.markets ?? (themeDriven ? ['全球'] : []),
    languages: value.languages ?? (themeDriven ? ['中文'] : []),
    platforms: value.platforms ?? (themeDriven ? ['抖音'] : []),
    formats: value.formats ?? (themeDriven ? ['短视频'] : []),
    aspectRatio: value.aspectRatio ?? null,
    cadence: value.cadence ?? null,
    requestedOutputCount: value.mode === 'instant' ? 1 : value.requestedOutputCount ?? null,
    weeklyBudgetCny: value.weeklyBudgetCny ?? null,
    perItemBudgetCny: Math.min(value.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10,
      value.perItemBudgetCny ?? (value.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10)),
    targetDurationSeconds: value.targetDurationSeconds ?? null,
    retryReserveCny: value.retryReserveCny ?? null,
    planningMode: value.planningMode ?? 'auto_adjust',
    shootingWindowMinutes: value.shootingWindowMinutes ?? null,
    specialRequirements: value.specialRequirements ?? null,
    dueAt: value.dueAt ?? null,
    brandNotes: value.brandNotes ?? null,
    restrictions: value.restrictions ?? [],
    callToAction: value.callToAction ?? null,
    programRef: value.programRef ?? null,
    targetAccountRef: value.targetAccountRef ?? null,
    accountPlaybookRef: value.accountPlaybookRef ?? null,
    referenceMode: value.referenceMode,
    primaryExperimentVariable: value.primaryExperimentVariable ?? null,
    creationMode: value.creationMode
      ?? (value.legacyCreationRoute === 'clone' ? 'viral_replication' : 'material_processing'),
    assetAvailability: value.assetAvailability ?? 'none',
    managementMode: value.managementMode ?? 'one_click_managed',
    productionMode: value.productionMode ?? 'social_ready',
    productionApproach: value.productionApproach ?? 'ai_enhanced',
  };
}

export async function groundedScriptBaseline(input: {
  tenantId: string;
  brief: SocialContentTaskDetail['brief'];
  theme: NonNullable<SocialContentTaskDetail['theme']>;
  lockedAt: string;
  previous?: StoredSocialScriptBaseline | null;
}): Promise<StoredSocialScriptBaseline> {
  const profile = await readTenantEnterpriseProfile(input.tenantId).catch(() => null);
  const verifiedContext = verifiedSocialScriptContext(profile, input.brief.productId || input.brief.productRef);
  const inspiration = input.theme.themeId
    ? await resolveSocialInspirationScript({ tenantId: input.tenantId, themeId: input.theme.themeId, verifiedContext })
    : null;
  return freezeSocialScriptBaseline({
    brief: input.brief,
    theme: input.theme,
    inspiration,
    verifiedContext,
    lockedAt: input.lockedAt,
    previous: input.previous,
  });
}

export type SocialTaskReferenceResolver = typeof resolveSocialTaskReferenceScript;

export async function refreshSocialTaskReferenceOutputs(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  operationId: string;
  now?: Date;
  referenceResolver?: SocialTaskReferenceResolver;
}): Promise<StarterRecord> {
  const task = await requireSocialTask(input);
  if (socialText(task.last_operation_id) === `${input.operationId}:reference-analysis`) return task;
  const summary = socialTaskSummary(task);
  if (summary.brief.creationMode !== 'viral_replication' || !summary.theme?.themeId
    || summary.theme.classificationStatus !== 'confirmed') return task;
  const detail = await readSocialTaskDetail(input);
  if (!detail) throw new SocialContentWorkflowError('social_content_task_not_found', 404);
  const references = detail.sources.filter(source => source.status === 'active' && source.kind === 'reference_link');
  const profile = await readTenantEnterpriseProfile(input.tenantId).catch(() => null);
  const verifiedContext = verifiedSocialScriptContext(profile, summary.brief.productId || summary.brief.productRef);
  const planning = {
    targetDurationSeconds: summary.brief.targetDurationSeconds ?? null,
    budgetCny: Math.min(summary.brief.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10,
      summary.brief.perItemBudgetCny ?? (summary.brief.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10)),
    language: summary.brief.languages.some(language => /^en(?:glish)?$/i.test(language)) ? 'en' as const : 'zh' as const,
    callToAction: summary.brief.callToAction ?? null,
  };
  let resolved: ResolvedSocialTaskReference | null = null;
  if (references.length) {
    resolved = await (input.referenceResolver ?? resolveSocialTaskReferenceScript)({
      tenantId: input.tenantId,
      themeId: summary.theme.themeId,
      verifiedContext,
      referenceSources: references,
      referenceReuse: summary.brief.referenceReuse,
      referenceStore: input.repository.dataStore,
      planning,
    });
  } else {
    if (summary.brief.referenceReuse) throw new SocialContentWorkflowError('social_reference_reuse_source_missing', 409);
    resolved = await resolveSocialRecommendedReferenceScript({
      tenantId: input.tenantId,
      themeId: summary.theme.themeId,
      verifiedContext,
      createdAt: (input.now ?? new Date()).toISOString(),
      planning,
    });
  }
  const storedReplication = socialObject(socialJson(task.replication_script));
  if (resolved
    && socialText(storedReplication?.referenceAnalysisId) === resolved.referenceVideoAnalysis.analysisId
    && socialText(storedReplication?.status) === 'confirmed') {
    resolved = {
      ...resolved,
      replicationScript: { ...resolved.replicationScript, status: 'confirmed' },
    };
  }
  if (resolved) resolved = await planNewSocialMaterialRoutes({ repository: input.repository,
    tenantId: input.tenantId, task, resolved });
  const previous = parseStoredSocialScriptBaseline(task.script_baseline);
  const baseline = resolved
    ? freezeSocialScriptBaseline({
        brief: summary.brief,
        theme: summary.theme,
        inspiration: resolved.match,
        replicationScript: resolved.replicationScript,
        verifiedContext,
        lockedAt: (input.now ?? new Date()).toISOString(),
        previous,
      })
    : previous;
  const newestReference = [...references].sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || right.sourceId.localeCompare(left.sourceId)
  ))[0] ?? null;
  const timestamp = (input.now ?? new Date()).toISOString();
  const existingShotMap = new Map(parseStoredSocialShotMaterialMap(task.shot_material_map).map(item => [item.shotId, item]));
  const resolvedShotMap = (resolved?.shotMaterialMap ?? []).map(item => {
    const existing = existingShotMap.get(item.shotId);
    if (!existing) return item;
    const customerAssetIds = [...new Set([...existing.customerAssetIds, ...item.customerAssetIds])].sort();
    return { ...item, customerAssetIds,
      generatedAssetIds: [...new Set([...existing.generatedAssetIds, ...item.generatedAssetIds])].sort(),
      licensedAssetIds: [...new Set([...existing.licensedAssetIds, ...item.licensedAssetIds])].sort(),
      sourceStrategy: customerAssetIds.length ? 'customer_real_asset' as const : item.sourceStrategy,
      truthBoundary: structuredClone(existing.truthBoundary),
      functionalEquivalentReplacement: structuredClone(existing.functionalEquivalentReplacement) };
  });
  await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, task.id, {
    ...(baseline ? { script_baseline: baseline } : {}),
    formula_reference: '',
    director_plan: '',
    reference_video_analysis: resolved?.referenceVideoAnalysis
      ?? pendingSocialTaskReferenceAnalysis(newestReference ?? {
        sourceId: 'system-reference:pending',
        sourceRef: 'system-recommendation-pending',
        createdAt: timestamp,
      }),
    replication_script: resolved?.replicationScript ?? '',
    shot_material_map: resolved ? resolvedShotMap : [...existingShotMap.values()],
    version: nextVersion(task),
    last_operation_id: `${input.operationId}:reference-analysis`,
    updated_by: input.userId,
    updated_at: timestamp,
  });
  return requireSocialTask(input);
}
