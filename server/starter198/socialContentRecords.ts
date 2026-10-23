import {applySocialContentRevisionSupply} from './socialContentRevisionProjection.js';
import {readHandoffProductFootageRevisionSupply} from './socialContentProductFootageRevisionProjection.js';
import {auditWeeklyMaterialInventory} from './weeklyMaterialInventory.js';
import {readWeeklyStageObservation} from './socialWeeklyStageObservation.js';
import {readWeeklyReplicationContext} from './weeklyReplicationContext.js';
import type { SocialContentTaskDetail, SocialProductionResult, SocialReplicationEvaluation } from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialRequestHash,
  socialObject,
  socialText,
} from './socialContentValidation.js';
import {
  materialReadiness,
  parseStoredMaterialRequirements,
  publicMaterialRequirements,
} from './socialContentThemes.js';
import { parseStoredSocialScriptBaseline } from './socialContentScriptBaseline.js';
import { createSocialAssetSupplyPlan } from '../../shared/socialContentAssetSupply.js';
import { materialRoutingRequests } from './socialContentMaterialRoutingRequests.js';
import { matchesRequestedMaterialProduct, projectWeeklyReviewedMaterialRouting, uniqueMaterialAssetIds } from './weeklyReviewedMaterialRoutingProjection.js';
import { ownedProductReferenceImageIds } from './socialContentProductReferenceInventory.js';
import {
  parseStoredSocialReferenceVideoAnalysis,
  parseStoredSocialReplicationScript,
  parseStoredSocialShotMaterialMap,
} from './socialContentScriptSources.js';
import { buildSocialAgentWorkflow } from './socialContentAgentWorkflow.js';
import { buildSocialReferenceReviewHandoff } from './socialReferenceReviewHandoff.js';
import {
  buildSocialContentProductionReadModel,
  projectProductionInputRequests,
  readCanonicalSocialStudioProject,
  selectProductionCostQuoteForRun,
} from './socialContentProductionReadModel.js';
import { readSocialProductionState } from './socialContentProductionHandoff.js';
import { listProductionInputRequests } from '../production/productionInputRequests.js';
import { listProductionCostQuotes } from '../production/productionCostQuotes.js';
import { readMaterialLibrary, type MaterialRecord } from '../lib/materialLibrary.js';
import {
  AUTO_TASK_KEY,
  decodeMaterialRef,
  materialTenantId,
} from './socialContentProductionMaterials.js';
import type { EnterpriseProfile } from '../lib/socialContentLegacyPorts.js';
import {
  projectShotMaterialRequirements,
  resolveSocialEnterpriseProductBinding,
} from './socialContentTaskEvidenceProjection.js';
export type { SocialWorkflowMaterialCandidateSet, SocialWorkflowMaterialClipCandidate } from './socialContentMaterialCandidateSupport.js';
import { assetSupplyShotFunction, type SocialWorkflowMaterialClipCandidate } from './socialContentMaterialCandidateSupport.js';
import {
  readAuthorizedPresenterInventory, socialTaskSummary, socialTaskSource, socialArtifact,
  socialDeliveryPackage, socialPublication, socialMetricSubmission, socialTaskRecord,
  taskRows, buildSocialWorkflowMaterialCandidates,
} from './socialContentRecordProjection.js';
export { readAuthorizedPresenterInventory, readAuthorizedPresenterAssetIds, parseSocialTaskBrief, parsePackageSelection, socialTaskReadiness, parseSocialTaskThemeSelection, socialTaskSummary, socialTaskSource, socialArtifact, socialDeliveryPackage, socialPublication, socialMetricSubmission, socialTaskRecord, buildSocialWorkflowMaterialCandidates } from './socialContentRecordProjection.js';
export type { SocialSourceCoverage } from './socialContentRecordProjection.js';

export async function readSocialTaskDetail(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  /** Server-only authority readers. An unverified marker is never projected. */
  preparedProductAssetRevisionReaders?: {
    readBudgetLedgerRef: () => Promise<string>;
    readReplacementMaterial: (assetId: string, tenantId: string) => Promise<MaterialRecord | null>;
    readReplacementBytes: (assetId: string, tenantId: string) => Promise<Buffer>;
  };
  ledgerRoot?: string;
}): Promise<SocialContentTaskDetail | null> {
  const task = await socialTaskRecord(input);
  if (!task) return null;
  const [sources, artifacts, packages, publications, metrics] = await Promise.all([
    taskRows(input.repository, STARTER_COLLECTIONS.socialTaskSources, input.tenantId, input.taskId),
    taskRows(input.repository, STARTER_COLLECTIONS.socialContentArtifacts, input.tenantId, input.taskId),
    taskRows(input.repository, STARTER_COLLECTIONS.socialDeliveryPackages, input.tenantId, input.taskId),
    taskRows(input.repository, STARTER_COLLECTIONS.socialPublications, input.tenantId, input.taskId),
    taskRows(input.repository, STARTER_COLLECTIONS.socialMetricSubmissions, input.tenantId, input.taskId),
  ]);
  const summary = socialTaskSummary(task);
  const storedScriptBaseline = parseStoredSocialScriptBaseline(task.script_baseline);
  const executionTaskRows = summary.runId
    ? await input.repository.list(STARTER_COLLECTIONS.tasks, input.tenantId, {
      where: { run_id: summary.runId, task_key: AUTO_TASK_KEY }, perPage: 2,
    }).catch(() => ({ items: [] as StarterRecord[], totalItems: 0, page: 1, perPage: 2, totalPages: 0 }))
    : null;
  if (executionTaskRows && (executionTaskRows.totalItems > 1 || executionTaskRows.items.length > 1)) {
    throw new SocialContentWorkflowError('social_content_execution_integrity_violation', 503);
  }
  const sourceViews = sources.map(socialTaskSource);
  const artifactViews = artifacts.map(socialArtifact);
  const activeSources = sourceViews.filter(source => source.status === 'active');
  const actual = {
    sourceCount: activeSources.length,
    knowledgeSourceCount: activeSources.filter(source => source.kind === 'knowledge').length,
    materialSourceCount: activeSources.filter(source => source.kind === 'material').length,
    artifactCount: artifacts.length,
    approvedArtifactCount: artifactViews.filter(artifact => artifact.status === 'approved').length,
    deliveryPackageCount: packages.length,
    publicationCount: publications.length,
    metricSubmissionCount: metrics.length,
  };
  if (Object.entries(actual).some(([key, value]) => summary[key as keyof typeof actual] !== value)) {
    throw new SocialContentWorkflowError('social_content_task_projection_out_of_sync', 503);
  }
  const activeMaterials = activeSources.filter(source => source.kind === 'material');
  const materialInventory = await (input.repository.materialLibrary ?? readMaterialLibrary)(input.tenantId, {dataStore: input.repository.dataStore}).catch(() => {throw new SocialContentWorkflowError('social_content_material_inventory_unavailable',503);});
  const enterpriseProfile = await (async (): Promise<EnterpriseProfile | null> => {
    if (!input.repository.dataStore) return null;
    const profiles = await input.repository.dataStore.list<Record<string, unknown>>('tenant_profiles', {
      where: { tenant_id: input.tenantId }, page: 1, perPage: 2,
    });
    if (profiles.totalItems > 1 || profiles.items.some(row => row.tenant_id !== input.tenantId)) {
      throw new SocialContentWorkflowError('enterprise_product_inventory_scope_invalid', 503);
    }
    return socialObject(socialJson(profiles.items[0]?.profile)) as unknown as EnterpriseProfile | null;
  })();
  const materialById = new Map(materialInventory.items.map(item => [socialText(item.id), item]));
  const linkedMaterialRows = activeMaterials.flatMap(source => {
    const record = materialById.get(decodeMaterialRef(source.sourceRef));
    return record ? [{ source, record }] : [];
  });
  const presenterInventory = await readAuthorizedPresenterInventory(
    input.repository,
    input.tenantId,
    summary.brief.targetAccountRef?.id,
    summary.brief.presenterAssetId,
  );
  const weeklyAuthority = socialObject(socialJson(task.brief))?._weeklyAuthority as Parameters<typeof buildSocialAgentWorkflow>[0]['authoritativeContext'];
  const enterpriseProductBinding = resolveSocialEnterpriseProductBinding(enterpriseProfile, summary.brief.productId);
  const confirmedFactRefs = [
    ...(weeklyAuthority?.publicationTask.factRefs.map(ref => `${ref.type}:${ref.id}@${ref.version}`) ?? []),
    ...(enterpriseProductBinding ? [enterpriseProductBinding.enterpriseFactRef] : []),
    ...activeSources.filter(source => source.kind === 'knowledge').map(source => source.sourceId),
    ...(summary.brief.brandNotes ? ['brief:confirmed-facts'] : []),
  ];
  const referenceVideoAnalysis = parseStoredSocialReferenceVideoAnalysis(task.reference_video_analysis);
  const replicationScript = parseStoredSocialReplicationScript(task.replication_script);
  const shotMaterialMap = parseStoredSocialShotMaterialMap(task.shot_material_map);
  const voiceoverRows = (replicationScript ? replicationScript.shots.map(shot => ({
    cueId: `${shot.shotId}:voiceover`,
    text: socialText(shot.spokenText || shot.captionText || shot.visualInstruction),
  })) : (storedScriptBaseline?.scenes ?? []).map(scene => ({
    cueId: `${scene.sceneId}:voiceover`,
    text: socialText(scene.voiceover || scene.narration || scene.caption)
      || [scene.subject, scene.action].map(socialText).filter(Boolean).join(' · '),
  }))).filter(item => item.text);
  const safeMaterialPreview = (record: MaterialRecord): string | null => {
    const values = socialText(record.type) === 'video'
      ? [record.poster, record.url]
      : [record.url, record.poster];
    return values.map(socialText).find(value => /^\/(?:media|studio-media|api\/overseas\/(?:studio\/materials\/pb|videos)\/)/.test(value)) ?? null;
  };
  const linkedRecordIds = new Set(linkedMaterialRows.map(item => socialText(item.record.id)));
  const frozenRaw=socialObject(socialJson(task.brief))?._weeklyOwnedProductIdentityDemand,frozen=socialObject(socialJson(frozenRaw));
  if(frozen){const {resolveWeeklyCreativeRepairAuthority}=await import('../runtime/weeklyCreativeRepairAuthority.js'),creative=input.repository.dataStore?await resolveWeeklyCreativeRepairAuthority({store:input.repository.dataStore,tenantId:input.tenantId,task}):null;if(creative){const {recordHash,...body}=frozen;if(frozen.schemaVersion!=='weekly-owned-product-identity.v1'||recordHash!==socialRequestHash(body)||frozen.tenantId!==input.tenantId||frozen.contentTaskId!==summary.taskId||frozen.packageId!==creative.repairCase.packageId||frozen.packageVersion!==creative.repairCase.packageVersion||frozen.publicationTaskId!==creative.repairCase.publicationTaskId||!Array.isArray(frozen.requirements)||!Array.isArray(frozen.verifiedMaterials))throw new SocialContentWorkflowError('weekly_owned_product_identity_binding_changed',409);for(const value of frozen.verifiedMaterials){const material=socialObject(value);if(!material||typeof material.sha256!=='string'||!activeMaterials.some(source=>source.sourceRef===material.sourceRef&&source.sourceVersion===material.sourceVersion&&material.sourceVersion===material.sha256))throw new SocialContentWorkflowError('weekly_owned_product_identity_material_changed',409);const matches=materialInventory.items.filter(item=>String(item.tenantId||item.tenant_id)===input.tenantId&&item.type==='image'&&item.contentSha256===material.sha256&&(frozen.requirements as unknown[]).some((value:unknown)=>{const requirement=socialObject(value);return Array.isArray(requirement?.imageIds)&&requirement.imageIds.includes(item.id)&&Array.isArray(requirement.imageHashes)&&requirement.imageHashes.includes(material.sha256)&&String(item.productRef||item.productName)===requirement.productRef;}));if(matches.length!==1)throw new SocialContentWorkflowError('weekly_owned_product_identity_material_changed',409);linkedRecordIds.add(matches[0]!.id);}}}
  const selectedTaskProductId = socialText(summary.brief.productId) || null;
  const selectedTaskProductRef = socialText(summary.brief.productRef) || null;
  let enterpriseProductImageUrls: string[] = [];
  if (selectedTaskProductId && enterpriseProfile) {
    const items = (enterpriseProfile.products.items ?? []).map(item => socialObject(item)).filter(Boolean);
    const selected = items.find(product => {
      const persisted = [product?.id, product?.productId, product?.sku].map(socialText).find(Boolean);
      return persisted === selectedTaskProductId;
    });
    if (selected) {
      enterpriseProductImageUrls = [...new Set([
        socialText(selected.imageUrl),
        ...(Array.isArray(selected.images) ? selected.images.map(image => socialText(socialObject(image)?.url)) : []),
        ...(Array.isArray(selected.packagingImages) ? selected.packagingImages.map(image => socialText(socialObject(image)?.url)) : []),
      ].filter(Boolean))];
    }
  }
  const reviewedFootageOverlays: MaterialRecord[] = [];
  if (selectedTaskProductId && input.repository.dataStore) {
    const { configuredFootageVisualAuthorities, readApprovedProductFootageVisualOverlay } =
      await import('../routes/enterpriseProductFootageVisualReview.js');
    if (configuredFootageVisualAuthorities().length) {
      for (const record of materialInventory.items) {
        if (record.type !== 'video' || !record.provenance?.footageCandidate
          || materialTenantId(record) !== input.tenantId || socialText(record.productId) !== selectedTaskProductId) continue;
        const overlay = await readApprovedProductFootageVisualOverlay({
          store: input.repository.dataStore, material: record, tenantId: input.tenantId,
          productId: selectedTaskProductId,
        }).catch(() => null);
        if (overlay) reviewedFootageOverlays.push(overlay);
      }
    }
  }
  const candidateSet = buildSocialWorkflowMaterialCandidates({
    records: materialInventory.items,
    reviewedFootageOverlays,
    tenantId: input.tenantId,
    voiceoverRows,
    selectedProductRef: selectedTaskProductRef,
    selectedProductId: selectedTaskProductId,
    themeId: summary.theme?.themeId ?? null,
    linkedRecordIds,
  });
  const materialCandidates: SocialWorkflowMaterialClipCandidate[] = candidateSet.candidates.map(candidate => ({
    ...candidate,
    ...((summary.brief.materialRoutingPolicyVersion === 'type-aware.v1' || summary.brief.materialRoutingPolicyVersion === 'type-aware.v2') ? {
      synthetic: /ai.generated|seedream|seedance|synthetic|generated/i.test(String(materialById.get(candidate.assetId)?.sourceType || ''))
        || materialById.get(candidate.assetId)?.synthetic === true,
    } : {}),
    previewUrl: safeMaterialPreview(materialById.get(candidate.assetId) ?? { id: candidate.assetId }),
  }));
  const reviewedMaterialBindings=projectWeeklyReviewedMaterialRouting({tenantId:input.tenantId,requestIds:weeklyAuthority?.publicationTask.materialRequirement?.requestIds??[],shotMaterialMap,candidates:materialCandidates,activeMaterials});
  const uniqueAssetIds=uniqueMaterialAssetIds;
  const sameRequestedProduct=(candidate:SocialWorkflowMaterialClipCandidate)=>matchesRequestedMaterialProduct(candidate,candidateSet);
  const productRows = materialCandidates.filter(candidate => candidate.mediaType === 'image'
    && candidate.materialRoles.includes('product'));
  const productFamilyRows = candidateSet.productPolicy === 'open'
    ? productRows.filter(candidate => candidate.assetId === productRows[0]?.assetId
      || Boolean(candidate.productRef && candidate.productRef === productRows[0]?.productRef))
    : productRows.filter(sameRequestedProduct);
  const productImageIds = [...new Set([...uniqueAssetIds(productFamilyRows),
    ...((summary.brief.materialRoutingPolicyVersion === 'type-aware.v1' || summary.brief.materialRoutingPolicyVersion === 'type-aware.v2') ? ownedProductReferenceImageIds({
      records: materialInventory.items, tenantId: input.tenantId,
      productId: selectedTaskProductId, productRef: selectedTaskProductRef,
      enterpriseProductImageUrls,
    }) : []),
  ])].slice(0, 4);
  const primaryProductRef = candidateSet.requestedProductRef
    || productFamilyRows[0]?.productRef
    || productImageIds[0]
    || 'task-product';
  // Inventory routes are projected from analyzed clip roles. An unanalyzed
  // full video never becomes a generic candidate merely because it is owned.
  const ownedRenderableRows = materialCandidates.filter(candidate => candidate.origin === 'my_materials');
  const factoryEvidenceAssetIds = uniqueAssetIds(ownedRenderableRows.filter(candidate => candidate.materialRoles.includes('factory')));
  const customerCaseEvidenceAssetIds = uniqueAssetIds(ownedRenderableRows.filter(candidate => candidate.materialRoles.includes('customer_case')));
  const productEffectEvidenceAssetIds = uniqueAssetIds(ownedRenderableRows.filter(candidate => candidate.materialRoles.includes('person_usage')));
  const customerVideoIds = uniqueAssetIds(ownedRenderableRows.filter(candidate => (
    candidate.mediaType === 'video'
    && !candidate.materialRoles.includes('factory')
    && !candidate.materialRoles.includes('customer_case')
  )));
  const licensedStockAssetIds = uniqueAssetIds(materialCandidates.filter(candidate => candidate.origin === 'shared_library'));
  let referenceRecord: MaterialRecord | undefined = referenceVideoAnalysis?.referenceRecordId
    ? materialById.get(referenceVideoAnalysis.referenceRecordId)
    : undefined;
  // URL references are canonical catalog records, not uploaded library media.
  // Resolve only this tenant's exact analyzed record and attached source identity.
  if (!referenceRecord && referenceVideoAnalysis?.referenceRecordId && input.repository.dataStore) {
    const catalog = await input.repository.dataStore.list<Record<string, unknown>>('trend_videos', {
      where: { tenantId: input.tenantId, id: referenceVideoAnalysis.referenceRecordId }, perPage: 2,
    });
    const candidate = catalog.items[0];
    if (catalog.totalItems === 1 && catalog.items.length === 1 && candidate?.tenantId === input.tenantId
      && candidate.id === referenceVideoAnalysis.referenceRecordId
      && activeSources.some(source => source.kind === 'reference_link' && source.sourceRef === candidate.sourceUrl)) {
      if (weeklyAuthority) {
        const plan = weeklyAuthority.weeklyPackage.agentPlanning;
        const dispatched = plan?.dispatch?.scheduleItems.find(item => item.publicationTaskId === weeklyAuthority.publicationTask.publicationTaskId);
        const analysis = plan?.directorAnalyses.find(item => item.analysisId === dispatched?.directorAnalysisRef?.id);
        if (!analysis) throw new SocialContentWorkflowError('weekly_reference_source_missing', 409);
        const {readWeeklyReferenceSources} = await import('../runtime/socialWeeklyReferenceSource.js');
        const references = await readWeeklyReferenceSources(input.repository.dataStore, input.tenantId, weeklyAuthority, analysis);
        if (!references.some(reference => reference.record.id === candidate.id && activeSources.some(source => source.kind === 'reference_link'
          && source.sourceRef === reference.sourceRef && source.sourceVersion === reference.sourceVersion))) {
          throw new SocialContentWorkflowError('weekly_reference_version_changed', 409);
        }
      }
      referenceRecord = { ...candidate, id: referenceVideoAnalysis.referenceRecordId };
      const originalAnalysis = socialObject(socialJson(candidate.aiAnalysis));
      if (originalAnalysis && typeof originalAnalysis.analysisRunId === 'string' && typeof originalAnalysis.contentSha256 === 'string') {
        const analysisHash = socialRequestHash(originalAnalysis);
        const evidence = await input.repository.dataStore.list<Record<string, unknown>>('reference_exact_shot_evidence', {
          where: { tenant_id: input.tenantId, record_id: String(candidate.id), source_sha256: originalAnalysis.contentSha256,
            analysis_run_id: originalAnalysis.analysisRunId, analysis_hash: analysisHash }, perPage: 2,
        });
        if (evidence.totalItems > 0) {
          const {createExactShotMaterializationService} = await import('../lib/referenceExactShotMaterialization.js');
          const merged = await createExactShotMaterializationService(input.repository.dataStore).readVerifiedAnalysis({
            tenantId: input.tenantId, recordId: String(candidate.id), expectedSourceSha256: originalAnalysis.contentSha256,
            expectedAnalysisRunId: originalAnalysis.analysisRunId, expectedAnalysisHash: analysisHash,
          });
          if (merged) referenceRecord = {...candidate, id: referenceVideoAnalysis.referenceRecordId, aiAnalysis: JSON.stringify(merged)};
        }
      }
    }
  }
  let assetSupplyPlan = applySocialContentRevisionSupply({ tenantId: input.tenantId, taskId: summary.taskId, brief: task.brief, script: replicationScript, plan: createSocialAssetSupplyPlan({
    materialRoutingPolicyVersion: summary.brief.materialRoutingPolicyVersion,
    creationMode: summary.brief.creationMode ?? 'material_processing',
    assetAvailability: summary.brief.assetAvailability,
    managementMode: summary.brief.managementMode,
    productionApproach: summary.brief.productionApproach ?? 'ai_enhanced',
    planVersion: summary.version,
    inventory: { customerVideoIds, productImageIds,
      productIdentityGroups: productImageIds.length ? [{
        productRef: primaryProductRef, imageIds: productImageIds,
      }] : [],
      presenterAssetIds: presenterInventory.assetIds,
      referenceVideoIds: (summary.brief.creationMode ?? 'material_processing') === 'viral_replication'
        && referenceVideoAnalysis ? [referenceVideoAnalysis.referenceRecordId
          ? `system-reference:${referenceVideoAnalysis.referenceRecordId}`
          : referenceVideoAnalysis.referenceSourceId] : [],
      factoryEvidenceAssetIds,
      customerCaseEvidenceAssetIds,
      productEffectEvidenceAssetIds,
      licensedStockAssetIds },
    confirmedFactRefs,
    accountPresenterLock: presenterInventory.accountPresenterLock,
    presenterSelectionConfirmed: Boolean(summary.brief.presenterAssetId && presenterInventory.assetIds.length === 1),
    referenceShots: referenceVideoAnalysis?.shots,
    shots: materialRoutingRequests({ policyVersion: summary.brief.materialRoutingPolicyVersion,
      tenantId: input.tenantId, candidates: materialCandidates, rejectedSegments: candidateSet.rejectedSegments,
      reviewedMaterialBindings,
      referenceShots: referenceVideoAnalysis?.shots,
      productRef: primaryProductRef, shots: replicationScript?.shots.map(shot => ({
      shotId: shot.shotId,
      function: shot.purpose,
      requestedDescription: shot.visualInstruction,
      truthSensitiveSubject: shot.materialPlan.truthBoundary.subject,
      referenceShotId: shot.referenceShotId,
      ...((summary.brief.materialRoutingPolicyVersion === 'type-aware.v1' || summary.brief.materialRoutingPolicyVersion === 'type-aware.v2') && shot.materialPlan.materialRouting ? {
        plannedDurationSeconds: shot.endSeconds - shot.startSeconds,
        ...(shot.materialPlan.visualContract ? { visualContract: structuredClone(shot.materialPlan.visualContract) } : {}),
        ...(shot.materialPlan.productSceneReplication ? { productSceneReplication: shot.materialPlan.productSceneReplication } : {}),
        ...(shot.materialPlan.materialRouting ? { materialRouting: structuredClone(shot.materialPlan.materialRouting) } : {}),
      } : {}),
    })) ?? storedScriptBaseline?.scenes.map((scene, index, scenes) => ({
      shotId: scene.sceneId,
      function: assetSupplyShotFunction(scene.shotFunction, index, scenes.length),
      requestedDescription: [scene.shotFunction, scene.subject, scene.action].map(socialText).filter(Boolean).join(' · '),
    })) ?? [] }),
    rightsConfirmationRequired: false,
  }) });
  const footageRevision = await readHandoffProductFootageRevisionSupply({ repository: input.repository,
    tenantId: input.tenantId, taskId: summary.taskId, task, ledgerRoot: input.ledgerRoot });
  if (footageRevision) assetSupplyPlan = footageRevision.plan;
  if (!footageRevision) assetSupplyPlan.inventoryAudit=auditWeeklyMaterialInventory(input.tenantId,materialInventory.items);
  const presenterLock = presenterInventory.accountPresenterLock;
  const referenceReviewHandoff = summary.brief.creationMode === 'viral_replication'
    ? referenceRecord ? buildSocialReferenceReviewHandoff({
      record: referenceRecord as unknown as Record<string, unknown>,
      presenter: presenterLock ? {
        assetId: presenterLock.presenterAssetId,
        assetVersion: presenterLock.presenterProfileVersion,
        rightsVerified: presenterLock.commercialRightsStatus === 'cleared' && presenterLock.status === 'published',
        rightsEvidenceRef: presenterLock.consentRef,
      } : presenterInventory.selectedPresenterEvidence,
      verifiedEnterpriseFactRefs: confirmedFactRefs,
    }) : { productionExecutionAllowed: false as const, versionHash: 'reference-record-unavailable' }
    : null;
  const agentWorkflow = buildSocialAgentWorkflow({
    tenantId: input.tenantId,
    taskId: summary.taskId,
    taskVersion: summary.version,
    taskStatus: summary.status,
    mode: summary.mode ?? 'weekly',
    weeklyPlanId: summary.weeklyPlanId ?? null,
    brief: summary.brief,
    authoritativeContext: weeklyAuthority,
    replicationContext: input.repository.dataStore && weeklyAuthority?.weeklyPackage.agentPlanning?.dispatch ? await readWeeklyReplicationContext({store:input.repository.dataStore,tenantId:input.tenantId,task,sources:activeSources}) : undefined,
    sources: activeSources,
    factSourceRefs: confirmedFactRefs,
    assetSupplyPlan,
    ...(footageRevision ? { footageRevisionPlanHash: footageRevision.planHash } : {}),
    referenceAnalysis: referenceVideoAnalysis,
    referenceReviewHandoff,
    replicationScript,
    materialCandidates,
    inferredProductRef: candidateSet.productPolicy === 'preferred' ? primaryProductRef : null,
    enterprisePresenterAssetRef: presenterInventory.selectedPresenterEvidence?.assetId ?? null,
    referencePreviewUrl: referenceVideoAnalysis?.referenceRecordId
      ? `/api/overseas/videos/${encodeURIComponent(referenceVideoAnalysis.referenceRecordId)}/thumbnail`
      : referenceRecord ? safeMaterialPreview(referenceRecord) : null,
  });
  const executionOutput = socialObject(socialJson(executionTaskRows?.items[0]?.output));
  const storedProduction = socialObject(socialJson(executionOutput?.production));
  const productionStage = socialText(storedProduction?.stage);
  const productionMessage = socialText(storedProduction?.message);
  const productionUpdatedAt = socialText(storedProduction?.updatedAt);
  const remainingRatioByStage: Record<string, number> = {
    execution_plan_approved: 0.92,
    director_planning: 0.8,
    asset_supply_completed: 0.65,
    content_production: 0.52,
    director_revision_required: 0.48,
    rendering: 0.3,
    quality_check: 0.18,
    media_evaluation: 0.12,
    creative_review: 0.06,
    review_ready: 0,
  };
  const productionStepByStage: Record<string, string> = {
    execution_plan_approved: '准备执行',
    director_planning: '编导方案',
    asset_supply_completed: '素材匹配',
    content_production: '内容制作',
    director_revision_required: '口播校准',
    rendering: '剪辑合成',
    quality_check: '成片质检',
    media_evaluation: '复刻评估',
    creative_review: '编导复核',
    review_ready: '等待审核',
    waiting_for_user_input: '等待确认',
    automatic_recovery_exhausted: '等待重试',
  };
  const stageObservation=input.repository.dataStore&&summary.runId?await readWeeklyStageObservation(input.repository.dataStore,{tenantId:input.tenantId,taskId:input.taskId,runId:summary.runId}):null;
  const productionProgress = stageObservation ? {step:'等待素材与资产排期',activity:'原运行已保存分镜意图，等待素材二次核验及资产任务领取；对应任务到期后继续原作业，不重新启动。',estimatedRemainingSeconds:null,waitingForScheduledAssets:true,updatedAt:stageObservation.updatedAt||summary.updatedAt} : productionStage && productionMessage
    ? {
      step: productionStepByStage[productionStage] ?? '自动制作',
      activity: productionMessage,
      estimatedRemainingSeconds: remainingRatioByStage[productionStage]===undefined?null:Math.max(0, Math.round(
        agentWorkflow.executionPlan.estimatedTotalSeconds
          * (remainingRatioByStage[productionStage] ?? 0.75),
      )),
      updatedAt: productionUpdatedAt || summary.updatedAt,
    }
    : null;
  const productionResult = [...artifactViews].reverse().flatMap(artifact => {
    const row = socialObject(artifact.content?.productionResult);
    return row && socialText(row.productionResultId) && socialText(row.executionPlanId)
      ? [{
        ...(structuredClone(row) as unknown as SocialProductionResult),
        artifactId: artifact.artifactId,
        publishAssignmentId: publications.map(socialPublication).reverse()[0]?.publicationId ?? null,
      }]
      : [];
  })[0] ?? null;
  const replicationEvaluation = [...artifactViews].reverse().flatMap(artifact => {
    const row = socialObject(artifact.content?.replicationEvaluation);
    return row && socialText(row.evaluationId) && socialText(row.replicationJobId)
      ? [structuredClone(row) as unknown as SocialReplicationEvaluation]
      : [];
  })[0] ?? null;
  agentWorkflow.productionResult = productionResult;
  agentWorkflow.replicationEvaluation = replicationEvaluation;
  const projectionStore = input.repository.dataStore;
  const [studioProject, productionState, durableInputRequests, costQuotes] = await Promise.all([
    readCanonicalSocialStudioProject({
      dataStore: projectionStore,
      tenantId: input.tenantId,
      taskId: input.taskId,
    }),
    readSocialProductionState({
      repository: input.repository,
      tenantId: input.tenantId,
      taskId: input.taskId,
      version: summary.version,
    }),
    projectionStore
      ? listProductionInputRequests({
        store: projectionStore,
        tenantId: input.tenantId,
        taskId: input.taskId,
        includeResolved: true,
      })
      : Promise.resolve([]),
    projectionStore && summary.runId
      ? listProductionCostQuotes({
        store: projectionStore,
        tenantId: input.tenantId,
        taskId: input.taskId,
      })
      : Promise.resolve([]),
  ]);
  const artifactCost = [...artifactViews].reverse().flatMap(artifact => {
    const value = socialObject(artifact.content?.costSummary);
    return value ? [value] : [];
  })[0] ?? null;
  const production = buildSocialContentProductionReadModel({
    task: {
      taskId: summary.taskId,
      version: summary.version,
      status: summary.status,
      runId: summary.runId,
      updatedAt: summary.updatedAt,
      title: summary.brief.title,
      readinessMissing: summary.readiness.missing,
      productionApproach: summary.brief.productionApproach,
    },
    workflow: agentWorkflow,
    assetSupplyPlan,
    studio: studioProject,
    productionStage: productionStage ? {
      stage: productionStage,
      message: productionMessage || null,
      updatedAt: productionUpdatedAt || null,
    } : null,
    receipts: productionState?.receipts ?? [],
    artifactCost,
    costQuote: selectProductionCostQuoteForRun({
      quotes: costQuotes,
      taskId: summary.taskId,
      runId: summary.runId,
    }),
    inputRequests: projectProductionInputRequests(durableInputRequests, summary.taskId),
  });
  const privateBrief = socialObject(socialJson(task.brief));
  const preparedMarker = socialObject(privateBrief?._productAssetFallback);
  const preparedReaders = input.preparedProductAssetRevisionReaders;
  const preparedProductAssetRevisionCandidate = preparedMarker && preparedReaders
    ? await (async () => {
      const { readPreparedSocialProductAssetFallback } = await import('./socialContentProductAssetRevisionPrepare.js');
      const result = await readPreparedSocialProductAssetFallback({
        repository: input.repository, tenantId: input.tenantId, taskId: input.taskId,
        expectedPreparedVersion: summary.version,
        sourceRunId: socialText(preparedMarker.sourceRunId),
        budgetLedgerRef: socialText(preparedMarker.budgetLedgerRef),
        ...preparedReaders,
      });
      return { plan: result.plan, preparedVersion: result.preparedVersion,
        revisedPlanHash: result.revisedPlanHash, budgetLedgerRef: result.budgetLedgerRef,
        authorizesStart: false as const };
    })()
    : undefined;
  const referenceRecovery = socialObject(privateBrief?._managedStart);
  const publishingRecovery = socialObject(privateBrief?._managedPublishing);
  const recoveryView = (value: Record<string, unknown>) => ({
    status: socialText(value.status), attempts: Number(value.attempts) || 0,
    nextAttemptAt: socialText(value.nextAttemptAt) || null, reason: socialText(value.reason) || null,
  });
  const socialMvpHandoff = await (async () => {
    const missing = {package:null,clips:[],estimatedCosts:{A:null,B:null,total:null},gaps:['mvp_authoritative_scope_missing']};
    const scope = socialObject(socialJson(task.mvp_scope));
    if (!input.repository.dataStore || !scope) return missing;
    const {SOCIAL_MVP_SCOPE_KEYS} = await import('../../shared/contracts/socialMvpHandoff.js');
    if (!SOCIAL_MVP_SCOPE_KEYS.every(key => typeof scope[key] === 'string' && String(scope[key]).trim())
      || scope.tenantId !== input.tenantId || scope.taskId !== input.taskId || scope.runId !== summary.runId
      || scope.version !== summary.version || scope.accountId !== summary.brief.targetAccountRef?.id
      || scope.productId !== summary.brief.productId || scope.projectId !== task.project_id) return missing;
    try {
      const {readSocialMvpHandoff} = await import('./socialMvpHandoffEvidence.js');
      return await readSocialMvpHandoff(input.repository.dataStore, scope as unknown as import('../../shared/contracts/socialMvpHandoff.js').SocialMvpScope);
    } catch { return {...missing,gaps:['mvp_authoritative_storage_unavailable']}; }
  })();
  const storedRequirements = summary.theme
    ? publicMaterialRequirements(parseStoredMaterialRequirements(task.material_requirements)) : [];
  // V2 discovers material gaps during review; its provisional baseline is not a user-confirmed request.
  const shotRequirements = summary.brief.materialRoutingPolicyVersion === 'type-aware.v2' ? [] : projectShotMaterialRequirements({
    plan: assetSupplyPlan,
    shotMaterialMap,
    themeId: summary.theme?.themeId,
    aspectRatio: summary.brief.aspectRatio,
    recalculatedAt: summary.updatedAt,
  });
  // A concrete shot plan is authoritative; the old theme/formula column is only for tasks without shots.
  const effectiveMaterialRequirements = shotRequirements.length ? shotRequirements : storedRequirements;
  return {
    ...summary,
    ...(enterpriseProductBinding ? { enterpriseProductBinding } : {}),
    ...((summary.theme || shotRequirements.length) ? { materialReadiness: materialReadiness(effectiveMaterialRequirements) } : {}),
    socialMvpHandoff,
    ...(referenceRecovery || publishingRecovery ? { managedExecution: {
      ...(referenceRecovery ? { reference: { ...recoveryView(referenceRecovery),
        ...(['producing', 'asset_review', 'packaging', 'delivered', 'awaiting_publish', 'awaiting_metrics', 'reviewed'].includes(summary.status)
          ? { status: 'completed', nextAttemptAt: null, reason: null } : {}),
      } } : {}),
      ...(publishingRecovery ? { publishing: { ...recoveryView(publishingRecovery), retryExhausted: publishingRecovery.retryExhausted === true } } : {}),
    } } : {}),
    assetSupplyPlan,
    ...(preparedProductAssetRevisionCandidate ? { preparedProductAssetRevisionCandidate } : {}),
    sources: sourceViews,
    artifacts: artifactViews,
    deliveryPackages: packages.map(socialDeliveryPackage),
    publications: publications.map(socialPublication),
    metricSubmissions: metrics.map(socialMetricSubmission),
    agentWorkflow,
    productionProgress,
    production,
    ...(referenceVideoAnalysis ? { referenceVideoAnalysis } : {}),
    ...(replicationScript ? { replicationScript } : {}),
    ...(shotMaterialMap.length ? { shotMaterialMap } : {}),
    ...((summary.theme || shotRequirements.length) ? { materialRequirements: effectiveMaterialRequirements } : {}),
  };
}

export async function requireSocialTask(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
}): Promise<StarterRecord> {
  const record = await socialTaskRecord(input);
  if (!record) throw new SocialContentWorkflowError('social_content_task_not_found', 404);
  return record;
}

export async function findSocialRecord(input: {
  repository: Starter198Repository;
  collection: Parameters<Starter198Repository['list']>[0];
  tenantId: string;
  where: Record<string, string | number | boolean>;
  notFoundCode: string;
}): Promise<StarterRecord> {
  const result = await input.repository.list(input.collection, input.tenantId, { where: input.where, perPage: 2 });
  if (result.totalItems > 1 || result.items.length > 1) {
    throw new SocialContentWorkflowError(`${input.notFoundCode}_integrity`, 503);
  }
  const record = result.items[0];
  if (!record) throw new SocialContentWorkflowError(input.notFoundCode, 404);
  return record;
}
