import {parseSocialReferenceReuse} from './socialContentValidation.js';
import { parseSocialReplicationContext } from './socialContentValidation.js';
import {
  SOCIAL_ARTIFACT_STATUSES,
  SOCIAL_CONTENT_TASK_STATUSES,
  SOCIAL_SOURCE_KINDS,
  SOCIAL_CONTENT_TASK_MODES,
  SOCIAL_CONTENT_PRODUCTION_MODES,
  SOCIAL_PRODUCTION_APPROACHES,
  SOCIAL_ASSET_AVAILABILITIES,
  SOCIAL_CONTENT_CREATION_MODES,
  SOCIAL_CONTENT_MANAGEMENT_MODES,
  SOCIAL_REPLICATION_REFERENCE_MODES,
  SOCIAL_CONTENT_THEME_IDS,
  SOCIAL_WORK_PACKAGE_KINDS,
  type SocialArtifactStatus,
  type SocialAccountPlaybookRef,
  type SocialAccountPresenterLock,
  type SocialContentArtifact,
  type SocialContentTaskBrief,
  type SocialContentTaskStatus,
  type SocialContentTaskSummary,
  type SocialContentThemeSelection,
  type SocialMaterialReadiness,
  type SocialDeliveryPackage,
  type SocialMetricSubmission,
  type SocialPublicationRecord,
  type SocialTaskSource,
  type SocialWorkPackageSelection,
  type SocialVersionedObjectRef,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialText,
} from './socialContentValidation.js';
import {
  materialReadiness,
  parseStoredMaterialRequirements,
  publicMaterialRequirements,
} from './socialContentThemes.js';
import {
  parseStoredSocialScriptBaseline,
  publicSocialScriptBaselineSummary,
} from './socialContentScriptBaseline.js';
import {
  parseStoredSocialDirectorPlan,
  publicSocialDirectorPlanSummary,
} from './socialContentDirectorPlan.js';
import { validateHeyGenPresenterRecord } from '../lib/presenterAssetTrust.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import {
  automaticMaterialScore,
  automaticSocialMaterialEligible,
  materialTenantId,
} from './socialContentProductionMaterials.js';
import { visualEvidenceScore } from '../digitalEmployees/sceneEvidence.js';
import {
  inferMaterialRoles,
  normalizeSceneVisualContract,
  resolveProductCompatibility,
  type SocialMaterialRole,
  type SocialProductPolicy,
} from '../../shared/sceneVisualContract.js';
import { materialAssetV2FromRecord } from '../../shared/contracts/materialAssetV2.js';
import { buildMaterialCapabilityManifest } from '../../shared/contracts/materialCapabilityManifest.js';
import { analyzedMaterialShots, buildMaterialSegmentProfile, materialIsEnterpriseCommon, materialProductIdentity, sameProduct,
  type SocialWorkflowMaterialCandidateSet } from './socialContentMaterialCandidateSupport.js';
export type { SocialWorkflowMaterialCandidateSet, SocialWorkflowMaterialClipCandidate } from './socialContentMaterialCandidateSupport.js';

export type StoredPresenter = Record<string, unknown> & {
  id?: string; authorized?: boolean; avatarId?: string; voiceId?: string;
  socialAccountId?: string; presenterProfileId?: string; presenterProfileVersion?: string;
  presenterProfileStatus?: string; commercialRightsStatus?: string; consistencyKey?: string;
  rightsEvidence?: { authorizationRef?: string; consentRef?: string; expiresAt?: string; revokedAt?: string;
    subjectAdultConfirmed?: boolean; permittedUses?: string[] };
  toolMappings?: { heygen?: { avatarId?: string; voiceId?: string }; runway?: { referenceMaterialIds?: unknown[] } };
  referenceMaterialIds?: unknown[];
};

export async function readAuthorizedPresenterInventory(repository: Starter198Repository, tenantId: string, socialAccountId?: string | null, requestedPresenterAssetId?: string | null): Promise<{
  assetIds: string[];
  accountPresenterLock: SocialAccountPresenterLock | null;
  selectedPresenterEvidence: { assetId: string; assetVersion: string; rightsVerified: true; rightsEvidenceRef: string } | null;
}> {
  if (!repository.dataStore) return { assetIds: [], accountPresenterLock: null, selectedPresenterEvidence: null };
  try {
    const defaults = await repository.dataStore.list<{ tenant_id: string; payload?: { presenters?: StoredPresenter[] } }>('studio_production_defaults', { where: { tenant_id: tenantId }, perPage: 2 });
    if (defaults.totalItems > 1 || defaults.items.length > 1) throw new Error('duplicate_defaults');
    const usable = (defaults.items[0]?.payload?.presenters || []).filter(item => {
      const mappings = item.toolMappings && typeof item.toolMappings === 'object' ? item.toolMappings as Record<string, any> : {};
      return item.authorized === true && String(item.id || '').trim() && (Boolean(String(item.avatarId || '').trim() && String(item.voiceId || '').trim())
        || (Array.isArray(item.referenceMaterialIds) && item.referenceMaterialIds.some(Boolean))
        || Boolean(String(mappings.heygen?.avatarId || '').trim() && String(mappings.heygen?.voiceId || '').trim())
        || (Array.isArray(mappings.runway?.referenceMaterialIds) && mappings.runway.referenceMaterialIds.some(Boolean)));
    });
    const requested = String(requestedPresenterAssetId || '').trim();
    const selected = requested ? usable.filter(item => String(item.id) === requested) : usable;
    const validatedSelected = selected.length === 1 ? validateHeyGenPresenterRecord(selected[0]!) : null;
    const selectedPresenterEvidence = validatedSelected?.ok ? {
      assetId: validatedSelected.presenterAssetId,
      assetVersion: String(validatedSelected.assetVersion),
      rightsVerified: true as const,
      rightsEvidenceRef: validatedSelected.rights.authorizationRef,
    } : null;
    if (!socialAccountId) return { assetIds: selected.map(item => String(item.id)), accountPresenterLock: null, selectedPresenterEvidence };
    const profiles = selected.flatMap(item => {
      const avatarId = String(item.toolMappings?.heygen?.avatarId || item.avatarId || '').trim();
      const voiceProfileId = String(item.toolMappings?.heygen?.voiceId || item.voiceId || '').trim();
      const presenterProfileId = String(item.presenterProfileId || '').trim();
      const presenterProfileVersion = String(item.presenterProfileVersion || '').trim();
      const expectedKey = `${socialAccountId}:${presenterProfileId}:${presenterProfileVersion}`;
      const authorizationRef = String(item.rightsEvidence?.authorizationRef || '').trim();
      const consentRef = String(item.rightsEvidence?.consentRef || '').trim();
      const expiresAt = item.rightsEvidence?.expiresAt ? Date.parse(item.rightsEvidence.expiresAt) : null;
      const rightsReady = Boolean(authorizationRef && consentRef && !item.rightsEvidence?.revokedAt
        && item.rightsEvidence?.subjectAdultConfirmed === true
        && item.rightsEvidence?.permittedUses?.includes('digital_presenter')
        && (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > Date.now())));
      return item.socialAccountId === socialAccountId && item.presenterProfileStatus === 'published'
        && item.commercialRightsStatus === 'cleared' && rightsReady
        && presenterProfileId && presenterProfileVersion && avatarId && voiceProfileId
        && item.consistencyKey === expectedKey
        ? [{ socialAccountId, presenterProfileId, presenterProfileVersion, presenterAssetId: String(item.id),
          avatarId, voiceProfileId, consentRef, commercialRightsStatus: 'cleared' as const,
          status: 'published' as const, consistencyKey: expectedKey }]
        : [];
    });
    if (profiles.length > 1) throw new Error('duplicate_published_account_presenter');
    return { assetIds: profiles.map(item => item.presenterAssetId), accountPresenterLock: profiles[0] ?? null, selectedPresenterEvidence };
  } catch {
    throw new SocialContentWorkflowError('social_content_presenter_assets_unavailable', 503);
  }
}

export async function readAuthorizedPresenterAssetIds(repository: Starter198Repository, tenantId: string): Promise<string[]> {
  return (await readAuthorizedPresenterInventory(repository, tenantId)).assetIds;
}

export const storedCount = (value: unknown): number => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) {
    throw new SocialContentWorkflowError('social_content_task_counter_invalid', 503);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SocialContentWorkflowError('social_content_task_counter_invalid', 503);
  }
  return parsed;
};

export function nullable(value: unknown): string | null {
  return socialText(value) || null;
}

export function versionedObjectRef(value: unknown, expectedObjectType?: string): SocialVersionedObjectRef | null {
  if (value === null || value === undefined || value === '') return null;
  const row = socialObject(value);
  const objectType = socialText(row?.objectType);
  const id = socialText(row?.id);
  const version = socialText(row?.version);
  if (!row || !objectType || !id || !version || (expectedObjectType && objectType !== expectedObjectType)) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  return { objectType, id, version };
}

export function accountPlaybookRef(value: unknown): SocialAccountPlaybookRef | null {
  const base = versionedObjectRef(value, 'account_playbook');
  if (!base) return null;
  const accountRef = socialText(socialObject(value)?.accountRef);
  if (!accountRef) throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  return { ...base, objectType: 'account_playbook', accountRef };
}

export function jsonRecord(value: unknown, code: string): Record<string, unknown> {
  const parsed = socialObject(socialJson(value));
  if (!parsed) throw new SocialContentWorkflowError(code, 503);
  return parsed;
}

export function strings(value: unknown, code: string): string[] {
  const parsed = socialJson(value);
  if (!Array.isArray(parsed) || parsed.some(item => !socialText(item))) {
    throw new SocialContentWorkflowError(code, 503);
  }
  return parsed.map(socialText);
}

export function parseSocialTaskBrief(value: unknown): SocialContentTaskBrief {
  const record = jsonRecord(value, 'social_content_task_record_invalid');
  const title = socialText(record.title);
  const objective = socialText(record.objective);
  if (!title || !objective) throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  const requested = record.requestedOutputCount;
  const optionalStoredNumber = (field: string, maximum: number, integer = false): number | null => {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > maximum || (integer && !Number.isSafeInteger(raw))) {
      throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
    }
    return raw;
  };
  const planningMode = socialText(record.planningMode) || 'auto_adjust';
  if (!['fixed', 'auto_adjust'].includes(planningMode)) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  // Records written before the publish-quality mode existed keep their
  // historic preview behavior. Every newly created customer task explicitly
  // stores `social_ready` through defaultBrief().
  const productionMode = socialText(record.productionMode) || 'concept_preview';
  if (!SOCIAL_CONTENT_PRODUCTION_MODES.includes(productionMode as NonNullable<SocialContentTaskBrief['productionMode']>)) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  const productionApproach = socialText(record.productionApproach);
  if (productionApproach && !SOCIAL_PRODUCTION_APPROACHES.includes(productionApproach as NonNullable<SocialContentTaskBrief['productionApproach']>)) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  const creationMode = socialText(record.creationMode);
  const assetAvailability = socialText(record.assetAvailability);
  const managementMode = socialText(record.managementMode);
  const referenceMode = socialText(record.referenceMode);
  if ((creationMode && !SOCIAL_CONTENT_CREATION_MODES.includes(creationMode as typeof SOCIAL_CONTENT_CREATION_MODES[number]))
    || (assetAvailability && !SOCIAL_ASSET_AVAILABILITIES.includes(assetAvailability as typeof SOCIAL_ASSET_AVAILABILITIES[number]))
    || (managementMode && !SOCIAL_CONTENT_MANAGEMENT_MODES.includes(managementMode as typeof SOCIAL_CONTENT_MANAGEMENT_MODES[number]))
    || (referenceMode && !SOCIAL_REPLICATION_REFERENCE_MODES.includes(referenceMode as typeof SOCIAL_REPLICATION_REFERENCE_MODES[number]))) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  if (record.materialRoutingPolicyVersion != null && record.materialRoutingPolicyVersion !== 'type-aware.v1' && record.materialRoutingPolicyVersion !== 'type-aware.v2') {
    throw new SocialContentWorkflowError('social_material_routing_policy_invalid', 503);
  }
  return {
    title,
    objective,
    ...(record.referenceReuse != null ? {referenceReuse: parseSocialReferenceReuse(record.referenceReuse)} : {}),
    ...(record.materialRoutingPolicyVersion === 'type-aware.v1' || record.materialRoutingPolicyVersion === 'type-aware.v2' ? { materialRoutingPolicyVersion: record.materialRoutingPolicyVersion } : {}),
    productId: nullable(record.productId),
    productRef: nullable(record.productRef),
    requestedPresenterName: nullable(record.requestedPresenterName),
    requestedPresenterAssetId: nullable(record.requestedPresenterAssetId),
    presenterAssetId: nullable(record.presenterAssetId),
    audience: nullable(record.audience),
    markets: strings(record.markets, 'social_content_task_record_invalid'),
    languages: strings(record.languages, 'social_content_task_record_invalid'),
    platforms: strings(record.platforms, 'social_content_task_record_invalid'),
    formats: strings(record.formats, 'social_content_task_record_invalid'),
    aspectRatio: nullable(record.aspectRatio),
    cadence: nullable(record.cadence),
    requestedOutputCount: typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0 ? requested : null,
    weeklyBudgetCny: optionalStoredNumber('weeklyBudgetCny', 10_000_000),
    perItemBudgetCny: optionalStoredNumber('perItemBudgetCny', 1_000_000),
    targetDurationSeconds: optionalStoredNumber('targetDurationSeconds', 60),
    retryReserveCny: optionalStoredNumber('retryReserveCny', 10_000_000),
    planningMode: planningMode as SocialContentTaskBrief['planningMode'],
    shootingWindowMinutes: optionalStoredNumber('shootingWindowMinutes', 10_080, true),
    specialRequirements: nullable(record.specialRequirements),
    dueAt: nullable(record.dueAt),
    brandNotes: nullable(record.brandNotes),
    restrictions: strings(record.restrictions, 'social_content_task_record_invalid'),
    callToAction: nullable(record.callToAction),
    ...parseSocialReplicationContext(record),
    programRef: versionedObjectRef(record.programRef),
    targetAccountRef: versionedObjectRef(record.targetAccountRef, 'social_owned_account'),
    accountPlaybookRef: accountPlaybookRef(record.accountPlaybookRef),
    ...(referenceMode ? { referenceMode: referenceMode as NonNullable<SocialContentTaskBrief['referenceMode']> } : {}),
    primaryExperimentVariable: nullable(record.primaryExperimentVariable),
    ...(creationMode ? { creationMode: creationMode as NonNullable<SocialContentTaskBrief['creationMode']> } : {}),
    ...(assetAvailability ? { assetAvailability: assetAvailability as NonNullable<SocialContentTaskBrief['assetAvailability']> } : {}),
    ...(managementMode ? { managementMode: managementMode as NonNullable<SocialContentTaskBrief['managementMode']> } : {}),
    productionMode: productionMode as SocialContentTaskBrief['productionMode'],
    ...(productionApproach ? { productionApproach: productionApproach as NonNullable<SocialContentTaskBrief['productionApproach']> } : {}),
  };
}

export function parsePackageSelection(value: unknown): SocialWorkPackageSelection[] {
  const parsed = socialJson(value);
  if (!Array.isArray(parsed) || parsed.length !== SOCIAL_WORK_PACKAGE_KINDS.length) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  const selection = parsed.map(item => {
    const record = socialObject(item);
    const kind = socialText(record?.kind) as SocialWorkPackageSelection['kind'];
    const packageKey = socialText(record?.packageKey);
    const version = socialText(record?.version);
    const name = socialText(record?.name);
    if (!SOCIAL_WORK_PACKAGE_KINDS.includes(kind) || !packageKey || !version || !name) {
      throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
    }
    return { kind, packageKey, version, name };
  });
  if (new Set(selection.map(item => item.kind)).size !== SOCIAL_WORK_PACKAGE_KINDS.length) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  return selection;
}

export interface SocialSourceCoverage {
  total: number;
  knowledge: number;
  material: number;
}

export function socialTaskReadiness(
  brief: SocialContentTaskBrief,
  coverage: SocialSourceCoverage,
  themeWorkflow?: { theme: SocialContentThemeSelection | null; materialReadiness: SocialMaterialReadiness },
): { complete: boolean; missing: string[]; personalizationGaps: string[] } {
  const missing: string[] = [];
  const personalizationGaps: string[] = [];
  if (!brief.productRef) personalizationGaps.push('product');
  if (!brief.audience) personalizationGaps.push('audience');
  if (!brief.markets.length) personalizationGaps.push('market');
  if (!brief.languages.length) personalizationGaps.push('language');
  if (!brief.platforms.length) personalizationGaps.push('platform');
  if (!brief.formats.length) personalizationGaps.push('content_format');
  if (coverage.knowledge < 1) personalizationGaps.push('enterprise_knowledge');
  if (coverage.material < 1) personalizationGaps.push('source_material');
  if (themeWorkflow) {
    if (!themeWorkflow.theme || themeWorkflow.theme.classificationStatus !== 'confirmed' || !themeWorkflow.theme.themeId) {
      missing.push('theme_confirmation');
    }
    // Missing customer material is a production-routing decision, not an
    // admission blocker. The content workflow may use licensed/system assets,
    // generated visuals, a digital presenter, or a non-claiming graphic
    // substitute. Verified proof shots must be rewritten rather than invented.
  } else {
    // Preserve the stricter contract for historic non-theme workflows. The
    // fast-start fallback applies only to the new theme-driven workflow.
    missing.push(...personalizationGaps);
  }
  // Local walkthroughs must be able to reach every production node without
  // fabricating setup data. Production remains fail-closed; the local switch
  // intentionally opens every workflow-admission gate for node-by-node checks.
  // Theme confirmation affects the final script and must not be skipped by the
  // local budget-only walkthrough allowance.
  const blockingMissing = missing;
  return { complete: blockingMissing.length === 0, missing: blockingMissing, personalizationGaps };
}

export function parseSocialTaskThemeSelection(value: unknown): SocialContentThemeSelection | null {
  const parsed = socialJson(value);
  if (parsed === undefined || parsed === null || parsed === '') return null;
  const record = socialObject(parsed);
  const rawThemeId = socialText(record?.themeId);
  const themeId = rawThemeId || null;
  const inputKind = socialText(record?.inputKind);
  const classificationStatus = socialText(record?.classificationStatus);
  if (!record || (themeId && !SOCIAL_CONTENT_THEME_IDS.includes(themeId as typeof SOCIAL_CONTENT_THEME_IDS[number]))
    || !['preset', 'custom'].includes(inputKind)
    || !['confirmed', 'pending_confirmation'].includes(classificationStatus)) {
    throw new SocialContentWorkflowError('social_content_theme_record_invalid', 503);
  }
  return {
    themeId: themeId as SocialContentThemeSelection['themeId'],
    inputKind: inputKind as SocialContentThemeSelection['inputKind'],
    topic: socialText(record.topic),
    classificationStatus: classificationStatus as SocialContentThemeSelection['classificationStatus'],
  };
}

export function socialTaskSummary(record: StarterRecord): SocialContentTaskSummary {
  const taskId = socialText(record.task_id);
  const status = socialText(record.status) as SocialContentTaskStatus;
  const version = socialText(record.version);
  const createdAt = socialText(record.created_at);
  const updatedAt = socialText(record.updated_at);
  if (!taskId || !SOCIAL_CONTENT_TASK_STATUSES.includes(status) || !version || !createdAt || !updatedAt) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  const brief = parseSocialTaskBrief(record.brief);
  const modeValue = socialText(record.task_mode) || 'weekly';
  if (!SOCIAL_CONTENT_TASK_MODES.includes(modeValue as typeof SOCIAL_CONTENT_TASK_MODES[number])) {
    throw new SocialContentWorkflowError('social_content_task_record_invalid', 503);
  }
  const theme = parseSocialTaskThemeSelection(record.theme_selection);
  const scriptBaseline = publicSocialScriptBaselineSummary(parseStoredSocialScriptBaseline(record.script_baseline));
  const directorPlan = publicSocialDirectorPlanSummary(parseStoredSocialDirectorPlan(record.director_plan));
  const requirements = publicMaterialRequirements(parseStoredMaterialRequirements(record.material_requirements));
  const requirementReadiness = materialReadiness(requirements);
  const sourceCount = storedCount(record.source_count);
  const knowledgeSourceCount = storedCount(record.knowledge_source_count);
  const materialSourceCount = storedCount(record.material_source_count);
  const artifactCount = storedCount(record.artifact_count);
  const approvedArtifactCount = storedCount(record.approved_artifact_count);
  // Supplemental text notes count toward lineage but are deliberately excluded
  // from both confirmed-knowledge and source-material readiness counters.
  if (knowledgeSourceCount + materialSourceCount > sourceCount || approvedArtifactCount > artifactCount) {
    throw new SocialContentWorkflowError('social_content_task_counter_invalid', 503);
  }
  return {
    taskId,
    ...(socialObject(socialJson(record.content_order))?.schemaVersion==='social-content-order.v1'
      ?{contentOrder:structuredClone(socialJson(record.content_order)) as SocialContentTaskSummary['contentOrder']}:{}),
    brief,
    status,
    version,
    packageSelection: parsePackageSelection(record.package_selection),
    readiness: socialTaskReadiness(brief, {
      total: sourceCount,
      knowledge: knowledgeSourceCount,
      material: materialSourceCount,
    }, theme ? { theme, materialReadiness: requirementReadiness } : undefined),
    runId: nullable(record.run_id),
    sourceCount,
    knowledgeSourceCount,
    materialSourceCount,
    artifactCount,
    approvedArtifactCount,
    deliveryPackageCount: storedCount(record.delivery_package_count),
    publicationCount: storedCount(record.publication_count),
    metricSubmissionCount: storedCount(record.metric_submission_count),
    createdAt,
    updatedAt,
    mode: modeValue as typeof SOCIAL_CONTENT_TASK_MODES[number],
    weeklyPlanId: nullable(record.weekly_plan_id),
    theme,
    ...(theme ? { materialReadiness: requirementReadiness } : {}),
    ...(scriptBaseline ? { scriptBaseline } : {}),
    ...(directorPlan ? { directorPlan } : {}),
  };
}

export function socialTaskSource(record: StarterRecord): SocialTaskSource {
  const kind = socialText(record.source_kind) as SocialTaskSource['kind'];
  const status = socialText(record.status) as SocialTaskSource['status'];
  if (!SOCIAL_SOURCE_KINDS.includes(kind) || !['active', 'replaced', 'removed'].includes(status)) {
    throw new SocialContentWorkflowError('social_content_source_record_invalid', 503);
  }
  return {
    sourceId: socialText(record.source_id),
    taskId: socialText(record.task_id),
    kind,
    sourceRef: socialText(record.source_ref),
    sourceVersion: nullable(record.source_version),
    label: socialText(record.label),
    purpose: nullable(record.purpose),
    status,
    createdAt: socialText(record.created_at),
  };
}

export function socialArtifact(record: StarterRecord): SocialContentArtifact {
  const status = socialText(record.status) as SocialArtifactStatus;
  const origin = socialText(record.origin) as SocialContentArtifact['origin'];
  if (!SOCIAL_ARTIFACT_STATUSES.includes(status) || !['agent', 'manual'].includes(origin)) {
    throw new SocialContentWorkflowError('social_artifact_record_invalid', 503);
  }
  const contentValue = socialJson(record.content);
  const content = contentValue === null || contentValue === undefined || contentValue === ''
    ? null : socialObject(contentValue);
  if (contentValue && !content) throw new SocialContentWorkflowError('social_artifact_record_invalid', 503);
  return {
    artifactId: socialText(record.artifact_id),
    taskId: socialText(record.task_id),
    kind: socialText(record.artifact_kind),
    platform: nullable(record.platform),
    language: nullable(record.language),
    version: socialText(record.version),
    status,
    origin,
    resourceRef: nullable(record.resource_ref),
    content,
    parentArtifactId: nullable(record.parent_artifact_id),
    createdAt: socialText(record.created_at),
    updatedAt: socialText(record.updated_at),
  };
}

export function socialDeliveryPackage(record: StarterRecord): SocialDeliveryPackage {
  const status = socialText(record.status) as SocialDeliveryPackage['status'];
  const packageId = socialText(record.package_id);
  if (!['preparing', 'ready', 'confirmed', 'superseded'].includes(status) || !packageId) {
    throw new SocialContentWorkflowError('social_delivery_package_record_invalid', 503);
  }
  return {
    packageId,
    taskId: socialText(record.task_id),
    version: socialText(record.version),
    status,
    artifactIds: strings(record.artifact_ids, 'social_delivery_package_record_invalid'),
    packageHash: socialText(record.package_hash),
    downloadHref: status === 'ready' || status === 'confirmed'
      ? `/api/overseas/starter-198/social-content/delivery-packages/${encodeURIComponent(packageId)}/download`
      : null,
    createdAt: socialText(record.created_at),
    updatedAt: socialText(record.updated_at),
  };
}

export function socialPublication(record: StarterRecord): SocialPublicationRecord {
  if (socialText(record.status) !== 'registered') {
    throw new SocialContentWorkflowError('social_publication_record_invalid', 503);
  }
  return {
    publicationId: socialText(record.publication_id),
    taskId: socialText(record.task_id),
    packageId: socialText(record.package_id),
    platform: socialText(record.platform),
    accountLabel: nullable(record.account_label),
    publicUrl: nullable(record.public_url),
    platformPostId: nullable(record.platform_post_id),
    publishedAt: socialText(record.published_at),
    notes: nullable(record.notes),
    status: 'registered',
    createdAt: socialText(record.created_at),
    updatedAt: socialText(record.updated_at),
  };
}

export function socialMetricSubmission(record: StarterRecord): SocialMetricSubmission {
  const method = socialText(record.method) as SocialMetricSubmission['method'];
  const status = socialText(record.status) as SocialMetricSubmission['status'];
  const parsedMetrics = jsonRecord(record.metrics, 'social_metrics_record_invalid');
  if (!['link', 'platform_id', 'table', 'screenshot', 'manual', 'connected_account'].includes(method)
    || !['received', 'needs_confirmation', 'confirmed'].includes(status)
    || Object.values(parsedMetrics).some(value => value !== null && typeof value !== 'number')) {
    throw new SocialContentWorkflowError('social_metrics_record_invalid', 503);
  }
  return {
    submissionId: socialText(record.submission_id),
    taskId: socialText(record.task_id),
    publicationId: socialText(record.publication_id),
    method,
    capturedAt: socialText(record.captured_at),
    metrics: parsedMetrics as Record<string, number | null>,
    evidenceRefs: strings(record.evidence_refs, 'social_metrics_record_invalid'),
    notes: nullable(record.notes),
    status,
    version: socialText(record.version),
    createdAt: socialText(record.created_at),
  };
}

export async function socialTaskRecord(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
}): Promise<StarterRecord | null> {
  const result = await input.repository.list(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, {
    where: { task_id: input.taskId }, perPage: 2,
  });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError('social_content_task_integrity_violation', 503);
  }
  return result.items[0] ?? null;
}

export async function taskRows(
  repository: Starter198Repository,
  collection: Parameters<Starter198Repository['list']>[0],
  tenantId: string,
  taskId: string,
): Promise<StarterRecord[]> {
  const result = await repository.list(collection, tenantId, {
    where: { task_id: taskId }, sort: 'created_at', perPage: 500,
  });
  if (result.totalItems !== result.items.length) {
    throw new SocialContentWorkflowError('social_content_task_children_truncated', 503);
  }
  return result.items;
}

export function buildSocialWorkflowMaterialCandidates(input: {
  records: MaterialRecord[];
  /** Only overlays returned by the independent signed byte/visual reader. */
  reviewedFootageOverlays?: MaterialRecord[];
  tenantId: string;
  voiceoverRows: Array<{ cueId: string; text: string }>;
  selectedProductRef?: string | null;
  selectedProductId?: string | null;
  themeId?: (typeof SOCIAL_CONTENT_THEME_IDS)[number] | null;
  linkedRecordIds?: Set<string>;
}): SocialWorkflowMaterialCandidateSet {
  const linkedRecordIds = input.linkedRecordIds ?? new Set<string>();
  const trustedOverlays = input.reviewedFootageOverlays ?? [];
  const raw = [...input.records.filter(record => automaticSocialMaterialEligible(record, input.tenantId)), ...trustedOverlays]
    .flatMap(record => {
      const assetId = socialText(record.id);
      const mediaType = socialText(record.type) as 'video' | 'image';
      if (!assetId || !['video', 'image'].includes(mediaType)) return [];
      const identity = materialProductIdentity(record, input.selectedProductRef);
      const enterpriseCommon = materialIsEnterpriseCommon(record);
      const materialV2 = materialAssetV2FromRecord(record);
      const capabilityManifest = buildMaterialCapabilityManifest(record);
      const sourceRevision = socialText(record.analysisSourceRevision || record.sourceRevision
        || socialObject(record.scriptAnalysis)?.sourceRevision || record.updatedAt)
        || `material:${assetId}`;
      return analyzedMaterialShots(record).flatMap(shot => {
        const shotIdentity = {
          productId: identity.productId || socialText(shot.visualContract.productUsage.productId) || null,
          productRef: identity.productRef || socialText(shot.visualContract.productUsage.productRef) || null,
        };
        const startSeconds = Number(shot.startSeconds);
        const endSeconds = Number(shot.endSeconds);
        const observed = [
          ...shot.observedEvidence,
          ...shot.matchTags,
          ...shot.editorial.subjects,
          ...shot.editorial.actions,
          ...shot.editorial.environments,
          shot.visualContract.interaction.description,
          shot.visualContract.productUsage.description,
        ].map(socialText).filter(Boolean);
        const cueScores = input.voiceoverRows.map(cue => ({ cueId: cue.cueId, score: visualEvidenceScore(cue.text, observed) }));
        const materialRoles = [...new Set([
          ...shot.materialRoles,
          ...inferMaterialRoles(shot.visualContract),
          ...(Array.isArray(record.materialRoles) ? record.materialRoles.map(socialText) : []),
        ].filter(role => ['factory', 'customer_case', 'product', 'person_usage', 'presenter', 'environment', 'general'].includes(role)))] as SocialMaterialRole[];
        const profileAssessment = buildMaterialSegmentProfile({ record, shot, tenantId: input.tenantId, assetId,
          mediaType, materialRoles, identity: shotIdentity });
        return [{
          record,
          shot,
          assetId,
          mediaType,
          identity: shotIdentity,
          enterpriseCommon,
          materialRoles,
          segmentProfile: profileAssessment.profile,
          segmentProfileRejectionReasons: profileAssessment.rejectionReasons,
          materialV2,
          sourceRevision,          cueScores,
          baseScore: Math.max(0, ...cueScores.map(item => item.score)) * 100
            + automaticMaterialScore({
              record,
              tenantId: input.tenantId,
              productRef: input.selectedProductRef ?? null,
              themeId: input.themeId ?? null,
              linked: linkedRecordIds.has(assetId),
            })
            + Math.round(shot.confidence * 20),
        }];
      });
    });

  const selectedProductRef = socialText(input.selectedProductRef) || null;
  const explicitProductId = socialText(input.selectedProductId) || null;
  const hasExplicitProduct = Boolean(selectedProductRef || explicitProductId);
  const selectedProductId = explicitProductId
    || (selectedProductRef
      ? raw.find(item => sameProduct(item.identity, { productId: null, productRef: selectedProductRef }))?.identity.productId
      : null) || null;
  const inferred = hasExplicitProduct ? null : raw
    .filter(item => item.mediaType === 'image' && item.materialRoles.includes('product')
      && (item.identity.productId || item.identity.productRef))
    .sort((left, right) => right.baseScore - left.baseScore || left.assetId.localeCompare(right.assetId))[0] ?? null;
  const requestedProductId = selectedProductId || inferred?.identity.productId || null;
  const requestedProductRef = selectedProductRef
    || (explicitProductId ? raw.find(item => item.identity.productId === explicitProductId)?.identity.productRef : null)
    || inferred?.identity.productRef || null;
  const productPolicy: SocialProductPolicy = hasExplicitProduct ? 'locked' : inferred ? 'preferred' : 'open';
  const requested = { productId: requestedProductId, productRef: requestedProductRef };
  const rejectedSegments = raw.flatMap(item => item.mediaType === 'video' && !item.segmentProfile?.productionEligible
    ? [{ assetId: item.assetId, segmentId: item.shot.segmentId,
      sourceRevision: item.segmentProfile?.sourceRevision ?? null,
      reasons: item.segmentProfileRejectionReasons }]
    : []);
  const candidates = raw.flatMap(item => {
    // Images remain available to historic product-identity flows. Fixed-yield
    // local video routes only receive segments whose version, rights and edit
    // boundaries passed the server-owned profile gate.
    if (item.mediaType === 'video' && !item.segmentProfile?.productionEligible) return [];
    const productCompatibility = resolveProductCompatibility({
      policy: productPolicy,
      requestedProductId,
      requestedProductRef,
      candidateProductId: item.identity.productId,
      candidateProductRef: item.identity.productRef,
      candidateMaterialRoles: item.materialRoles,
      enterpriseCommon: item.enterpriseCommon,
    });
    const evidenceRole = item.materialRoles.includes('factory') || item.materialRoles.includes('customer_case');
    if (!productCompatibility.compatible && !evidenceRole) return [];
    const trim = item.shot.editorial.trim;
    const useSafeTrim = trim.boundaryConfidence >= 0.6 && trim.cleanEntry && trim.cleanExit
      && trim.preferredEndSeconds > trim.preferredStartSeconds;
    const timeRange = item.mediaType === 'video' ? {
      startSeconds: Number((useSafeTrim ? trim.preferredStartSeconds : item.shot.startSeconds).toFixed(2)),
      endSeconds: Number((useSafeTrim ? trim.preferredEndSeconds : item.shot.endSeconds).toFixed(2)),
    } : null;
    const visualContract = normalizeSceneVisualContract({
      ...item.shot.visualContract,
      product: {
        policy: productPolicy,
        requestedProductId,
        requestedProductRef,
        source: productPolicy === 'locked' ? 'user_explicit'
          : productPolicy === 'preferred' ? 'agent_inferred' : 'inventory_open',
      },
      evidence: {
        ...item.shot.visualContract.evidence,
        sourceRange: timeRange,
      },
    });
    const matchScore = item.baseScore
      + Math.round(productCompatibility.score * 180)
      + (item.enterpriseCommon ? 35 : 0)
      + (evidenceRole ? 45 : 0);
    return [{
      assetId: item.assetId,
      sourceRef: item.assetId,
      segmentId: item.shot.segmentId,
      ...(item.record.provenance?.footageCandidate && item.shot.footageEvidence
        ? { footageEvidence: structuredClone(item.shot.footageEvidence) } : {}),
      label: `${socialText(item.record.name || item.record.title) || '未命名素材'} · ${item.shot.segmentId}`,
      mediaType: item.mediaType,
      previewUrl: null,
      origin: materialTenantId(item.record) === input.tenantId ? 'my_materials' as const : 'shared_library' as const,
      matchedVoiceoverCueIds: item.cueScores.filter(score => score.score > 0).map(score => score.cueId),
      matchScore,
      productId: item.identity.productId,
      productRef: item.identity.productRef,
      enterpriseCommon: item.enterpriseCommon,
      productPolicy,
      materialRoles: item.materialRoles,
      visualContract,
      timeRange,
      segmentProfile: item.segmentProfile,
      segmentProfileRejectionReasons: item.segmentProfileRejectionReasons,
      segmentCandidateId: `${item.assetId}:${item.sourceRevision}:${item.shot.segmentId}`,
      sourceRevision: item.sourceRevision,
      materialV2: item.materialV2,    }];
  }).sort((left, right) => right.matchScore - left.matchScore
    || left.assetId.localeCompare(right.assetId)
    || left.segmentId.localeCompare(right.segmentId));
  return { candidates, rejectedSegments, productPolicy, requestedProductId, requestedProductRef };
}
