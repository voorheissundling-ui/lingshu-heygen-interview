import { collectProductionAssets, exactAnalysis } from './contentProductionAssets.js';
export { collectProductionAssets, resolveEnterpriseAssetLocation } from './contentProductionAssets.js';
import { frozenOrderProductItems, immutableContentOrderBlockers, productFacts, referenceStructure, resolveFrozenOrderProduct, selectedProductItems } from './contentProductionFacts.js';
export { immutableContentOrderBlockers, legacyManagedPaidSubmissionBlocker, productFacts, resolveFrozenOrderProduct, selectExplicitFocusProducts } from './contentProductionFacts.js';
import { routeTitle } from './contentProductionScripts.js';
export { deterministicClosedWorldStoryboard, generateDirectorScriptContracts, generateScript, isLlmUnavailableError } from './contentProductionScripts.js';
import { automatedContentQualityNeedsRevalidation, buildRouteSourcePlans, contentProjectRetryable, evidenceAssetSnapshot, projectAutomation, repairFrozenOrderProductBinding, stagePatch, updateProject } from './contentProductionProjectState.js';
export { assetRenderUrl, automatedContentQualityNeedsRevalidation, buildRouteSourcePlans, contentProjectBlockIsSemanticallyUnchanged, contentProjectRetryable, repairFrozenOrderProductBinding, resumeContentProjectForTaskControl } from './contentProductionProjectState.js';
import { advanceOneProject } from './contentProductionExecution.js';
export { advanceOneProject } from './contentProductionExecution.js';
import { MANAGED_REPLICATION_BRIDGE_VERSION } from './replicationContentProduction.js';
import { presenterApprovalForProject, presenterApprovalResumesQuality } from './presenterApprovalRecovery.js';
import { normalizeVideoPlan, usesDigitalPresenter } from '../../shared/contracts/videoCreationPlan.js';
import { readTenantEnterpriseProfile, type EnterpriseProfile } from '../routes/enterprise.js';
import { store } from '../storage/index.js';
import type { DigitalEmployeeConfig, WeeklyGoalInput } from './domain.js';
import { contentProjectLineageFields } from './contentProjectLineage.js';
import { notifyStarterReviewableContentProjects } from '../starter198/contentArtifactWakeup.js';
import { CONTENT_SCRIPT_QUALITY_RULE_VERSION } from './contentQualityContract.js'; export { CONTENT_SCRIPT_QUALITY_RULE_VERSION } from './contentQualityContract.js';
import {legacyIncrementalCostBlocker,LEGACY_INCREMENTAL_COST_BLOCKER,readLegacyManualCompletion} from './legacyIncrementalCostGuard.js';export { containsInternalContentMarker, paginateAlignedCues, subtitleCuesAreSafe } from '../lib/subtitleCues.js';
export { bindVoiceCuesToScenes, freezeStoryboardNarration, languageSceneAlignmentIssues, productionTiming, proportionalCues, splitSubtitleUnits, storyboardVoiceLanguageMatches, storyboardVoiceLines, translateStoryboardFromMaster } from './contentProductionNarrationTiming.js';
import type { AssetCandidate, ContentProductionAdvanceResult, ContentProductionOrderInput, ContentProductionRoute, ContentRouteEvidence, RouteSourcePlan, StoredRecord } from './contentProductionContracts.js';
export type { AssetCandidate, ContentProductionAdvanceResult, ContentProductionOrderInput, ContentProductionRoute, ContentRouteEvidence, ContentRoutePlan, RouteSourcePlan, SceneSourcePlanItem } from './contentProductionContracts.js';
import { CONTENT_PRODUCTION_SCHEMA_VERSION, allocateBalancedContentRoutes, assetEligible, contentProductionKnowledgeGaps, enabledRoutes, expandContentOrdersByLanguage, json, platformCreativeBrief, requiredContentRoutes, selectContentProjectsForTick, stableHash, text } from './contentProductionPlanning.js';
export {
  CONTENT_PRODUCTION_SCHEMA_VERSION, CONTENT_PRODUCTION_MAX_CONCURRENCY,
  MAX_FROZEN_DIRECTOR_SCRIPT_LENGTH, expandContentOrdersByLanguage,
  refreshExpandedContentOrderContract, frozenDirectorScriptForProduction,
  productIdentity, assetAuthorization, sceneIntent, sceneHasVisualEvidence,
  matchSceneSources, resolvePresentationMaterials, platformCreativeBrief,
  contentFingerprint, detectContentDuplication, selectContentProjectsForTick,
  enabledRoutes, requiredContentRoutes, contentProductionKnowledgeGaps,
  allocateBalancedContentRoutes,
} from './contentProductionPlanning.js';
function requestedDraftCount(config: DigitalEmployeeConfig, goal: WeeklyGoalInput): number {
  const cadence = config.socialCadence.match(/(?:每周生成|每周发布|每周)\s*(\d{1,2})\s*条/);
  const count = cadence ? Number(cadence[1]) : Math.max(1, goal.target - goal.baseline);
  return Math.max(1, Math.min(12, count || 5));
}


/**
 * Read all tenant projects so older pages cannot hide current-run orders.
 */
export async function listTenantContentProjects(tenantId: string): Promise<StoredRecord[]> {
  const records: StoredRecord[] = [];
  for (let page = 1; ; page += 1) {
    const result = await store.list<StoredRecord>('studio_projects', { where: { tenant_id: tenantId }, sort: 'created_at,id', perPage: 500, page });
    records.push(...result.items);
    if (page >= result.totalPages || result.items.length === 0) return records;
  }
}

export function contentOrderCoverage(projects: StoredRecord[], orderIds: string[]) {
  const ids = projects.map(project => text(json<Record<string, unknown>>(project.spec, {}).contentOrderId));
  const missing = orderIds.filter(id => !ids.includes(id));
  const duplicate = orderIds.filter(id => ids.filter(value => value === id).length > 1);
  const unexpected = ids.filter(id => !orderIds.includes(id));
  return { missing, duplicate, unexpected, complete: orderIds.length > 0 && missing.length === 0 && duplicate.length === 0 && unexpected.length === 0 };
}

/** One bounded tick; repair partial queue creation before advancing projects. */
export async function advanceAutomatedContentProduction(input: {
  tenantId: string;
  runId: string;
  taskId: string;
  config: DigitalEmployeeConfig;
  goal: WeeklyGoalInput;
  enterpriseProfile?: EnterpriseProfile;
  batchPlanId?: string;
  contentOrders?: ContentProductionOrderInput[];
  /** Internal admission-only tick: persist missing real projects but never
   * advance any project into scripts, voice, images or provider rendering. */
  materializeOnly?:boolean;
}): Promise<ContentProductionAdvanceResult> {
  const [profile, analysesResult, existingProjects] = await Promise.all([
    input.enterpriseProfile ? Promise.resolve(structuredClone(input.enterpriseProfile)) : readTenantEnterpriseProfile(input.tenantId),
    store.list<StoredRecord>('trend_videos', { where: { tenantId: input.tenantId }, sort: '-updatedAt', perPage: 500 }),
    listTenantContentProjects(input.tenantId),
  ]);
  const analyses = analysesResult.items.filter(record => exactAnalysis(record) && Boolean(referenceStructure(record)));
  const assets = await collectProductionAssets(input.tenantId, profile);
  let projects = existingProjects.filter(record => {
    const spec = json<Record<string, unknown>>(record.spec, {});
    return spec.workflowRunId === input.runId && spec.workflowTaskId === input.taskId && projectAutomation(record).managedBy === 'digital_employee' && projectAutomation(record).stage !== 'superseded';
  });
  const requestedOrders = input.contentOrders?.filter(order => ['clone', 'product', 'material'].includes(order.route)) || [];
  if (input.contentOrders && (!requestedOrders.length || requestedOrders.length !== input.contentOrders.length
    || requestedOrders.some(order => !text(order.id)) || new Set(requestedOrders.map(order => order.id)).size !== requestedOrders.length)) {
    return { changed: false, ready: false, projectRefs: [], knowledgeGaps: [], blocker: '内容批次订单为空、重复或包含无效路径', summary: '内容生产未启动' };
  }
  const frozenOrders = expandContentOrdersByLanguage(requestedOrders, input.config);
  // A frozen order may intentionally target any product from the frozen
  // enterprise snapshot. focusProducts is only the default for an unfrozen,
  // automatically allocated batch.
  const selectedProducts = frozenOrders.length
    ? frozenOrderProductItems(profile, frozenOrders)
    : selectedProductItems(profile, input.config);
  const productNames = selectedProducts.map(({ item }) => text(item.name, 160)).filter(Boolean);
  const evidence: ContentRouteEvidence = { exactAnalysisIds: analyses.map(item => item.id), productNames, assetIds: assets.map(item => item.id) };
  const missingOrders = contentOrderCoverage(projects, frozenOrders.map(order => order.id)).missing;
  const requiredRoutes = requiredContentRoutes({ frozenOrders, videoPlans: input.goal.videoPlans,
    projectRoutes: projects.map(project => text(projectAutomation(project).route) as ContentProductionRoute).filter(route => ['clone', 'product', 'material'].includes(route)),
    enabled: enabledRoutes(input.config) });

  let changed = false;
  if (!projects.length || missingOrders.length > 0) {
    const priorCounts: Partial<Record<ContentProductionRoute, number>> = {};
    for (const record of existingProjects.filter(item => !projects.some(project => project.id === item.id))) {
      const route = text(projectAutomation(record).route) as ContentProductionRoute;
      if (['clone', 'product', 'material'].includes(route)) priorCounts[route] = Number(priorCounts[route] || 0) + 1;
    }
    const plan = allocateBalancedContentRoutes({ count: requestedDraftCount(input.config, input.goal), enabled: requiredRoutes, evidence, priorCounts });
    if (!frozenOrders.length && !plan.allocations.length) {
      const gaps = contentProductionKnowledgeGaps({ enabled: requiredRoutes, evidence });
      return { changed: false, ready: false, projectRefs: [], knowledgeGaps: gaps, blocker: plan.blockers.join('；') || gaps.map(item => item.label).join('；') || '未启用内容生产路径', summary: '内容生产未启动' };
    }
    const now = new Date().toISOString();
    const created: StoredRecord[] = [];
    const sourcePlans = frozenOrders.length ? frozenOrders.map(order => {
      const product = resolveFrozenOrderProduct(profile.products.items || [], order);
      const productId = product?.productId || '';
      const productName = text(product?.item.name || order.productName, 160);
      const owned = assets.filter(asset => assetEligible(asset) && (order.route === 'material' ? !asset.productId || asset.productId === productId : asset.productId === productId));
      const referenceId = order.evidenceRefs.find(ref => ref.type === 'exact_analysis')?.id || '';
      const materialId = order.evidenceRefs.find(ref => ref.type === 'enterprise_material')?.id || '';
      const material = materialId ? (
        assets.find(asset => asset.id === materialId && assetEligible(asset) && (!productId || !asset.productId || asset.productId === productId))
        || (/^product-\d+-/.test(materialId) ? owned[0] : undefined)
      ) : undefined;
      // A frozen content order owns the exact enterprise material selected by
      // the batch planner. Pulling every asset for the same product into every
      // order made otherwise distinct product/material routes converge on the
      // same evidence set and correctly trip the cross-route duplication gate.
      // Additional material may still be chosen by a future batch plan, but it
      // must be explicit evidence rather than an implicit same-product sweep.
      const assetIds = order.evidenceRefs.filter(ref => ref.type === 'enterprise_material').map(ref => ref.id).filter(id => owned.some(asset => asset.id === id));
      // Re-evaluate mutable product/reference/material readiness from the
      // current frozen evidence on every retry. Only immutable route/platform
      // scope errors remain hard-frozen on the order.
      const orderGap = immutableContentOrderBlockers(order).join('；');
      const gap = orderGap || (!productId ? '批次订单引用的产品不在当前冻结产品资料中'
        : order.route === 'clone' && !analyses.some(record => record.id === referenceId) ? '批次订单引用的精确参考结构不存在或不可解析'
          : order.route === 'material' && !material ? '批次订单引用的锁定素材不存在、未授权或不属于当前产品'
            : !assetIds.length && (!order.videoPlan || !usesDigitalPresenter(order.videoPlan)) && order.route !== 'product' ? '批次订单没有属于当前产品的已授权视觉素材' : '');
      return {
        route: order.route, productId, productName, assetIds, ...(order.route === 'material' && material ? { seedAssetId: material.id } : {}),
        ...(referenceId ? { referenceAnalysisId: referenceId } : {}),
        platform: order.platform, platformBrief: platformCreativeBrief(order.platform), ...(gap ? { gap } : {}),
      } satisfies RouteSourcePlan;
    }) : buildRouteSourcePlans({
      allocations: plan.allocations,
      products: selectedProducts.map(({ item, productId }) => ({ productId, productName: text(item.name, 160) })),
      assets,
      referenceAnalysisIds: analyses.map(item => item.id),
      platforms: input.goal.contentPlatforms,
    });
    for (let slot = 0; slot < sourcePlans.length; slot += 1) {
      const routePlan = sourcePlans[slot]!;
      const frozenOrder = frozenOrders[slot];
      if (frozenOrder && !missingOrders.includes(frozenOrder.id)) continue;
      const route = routePlan.route;
      const referenceId = routePlan.referenceAnalysisId || '';
      const routeAssets = routePlan.assetIds.map(id => assets.find(asset => asset.id === id)).filter((asset): asset is AssetCandidate => Boolean(asset));
      const reference = referenceId ? analyses.find(item => item.id === referenceId) : undefined;
      const referenceEvidence = referenceStructure(reference);
      const snapshot = {
        schemaVersion: CONTENT_PRODUCTION_SCHEMA_VERSION,
        capturedAt: now,
        product: routePlan.productId ? { id: routePlan.productId, name: routePlan.productName || '', facts: productFacts(profile, input.config, routePlan.productId) } : null,
        assets: routeAssets.map(evidenceAssetSnapshot),
        reference: referenceEvidence,
        hash: stableHash({ productId: routePlan.productId || '', assets: routeAssets.map(evidenceAssetSnapshot), reference: referenceEvidence }),
      };
      const normalizedPlan = normalizeVideoPlan(frozenOrder?.videoPlan || input.config.videoDefaults || {});
      const publication = normalizedPlan.publication;
      const spec = {
        mode: route, contentMode: 'video', platform: routePlan.platform, platformBrief: routePlan.platformBrief, ratio: '9:16', exportSpec: { ratio: '9:16', resolution: '1080p', fps: 30 }, duration: normalizeVideoPlan(frozenOrder?.videoPlan || input.config.videoDefaults || {}).duration, lang: normalizeVideoPlan(frozenOrder?.videoPlan || input.config.videoDefaults || {}).language,
        workflowRunId: input.runId, workflowTaskId: input.taskId, workflowTaskKey: 'content_production', productInfo: productFacts(profile, input.config, routePlan.productId),
        productionContractVersion: frozenOrder?.productionContractVersion || (frozenOrder?.fixedYieldTimeline ? 'fixed-yield.v2-preflight' : 'legacy.v1'),
        fixedYieldExecutionState: frozenOrder?.fixedYieldTimeline ? 'preflight_only_legacy_stage_runner' : 'not_applicable',
        ...(frozenOrder?.fixedYieldTimeline ? { fixedYieldTimeline: frozenOrder.fixedYieldTimeline } : {}),
        ...(input.batchPlanId ? { batchPlanId: input.batchPlanId } : {}), ...(frozenOrder?.id ? { contentOrderId: frozenOrder.id, contentOrder: frozenOrder } : {}),
        presenterMode: Boolean(frozenOrder?.videoPlan && usesDigitalPresenter(frozenOrder.videoPlan)) ? 'digital' : 'real',
        audience: input.config.customerProfile, selectedMaterialIds: [], script: '', subtitlesOn: true,
        caption: publication?.caption || '', hashtags: publication?.tags || [], publicationTitle: publication?.title || '',
        evidenceSnapshot: snapshot,
        automation: {
          schemaVersion: CONTENT_PRODUCTION_SCHEMA_VERSION, managedBy: 'digital_employee', route, slot: slot + 1,
          productionGraphId: `digital-employee:${input.runId}:${input.taskId}:${slot + 1}`,
          stage: 'script', status: routePlan.gap ? 'blocked' : 'queued', referenceAnalysisId: referenceId,
          evidence, evidenceSnapshotHash: snapshot.hash, routePlan,
          ...(routePlan.gap ? { blocker: routePlan.gap, resumeStage: 'script', retryAfter: new Date(Date.now() + 15 * 60_000).toISOString() } : {}),
          routeWarnings: plan.blockers, createdAt: now, updatedAt: now,
        },
      };
      const record = await store.create<StoredRecord>('studio_projects', {
        tenant_id: input.tenantId,
        title: publication?.title || `${routeTitle(route)} · ${input.goal.title} · ${normalizedPlan.language.toUpperCase()} · ${slot + 1}`,
        status: 'draft',
        spec,
        ...contentProjectLineageFields({ tenantId: input.tenantId, spec }),
        thumb_seed: '', created_at: now, updated_at: now,
      });
      if (!record) throw new Error('studio_project_storage_unavailable');
      created.push(record);
    }
    projects = [...projects, ...created];
    changed = created.length > 0;
  }

  if(input.materializeOnly)return {changed,ready:false,projectRefs:projects.map(project=>({type:'studio_project' as const,id:project.id,route:text(projectAutomation(project).route) as ContentProductionRoute,status:String(project.status||'draft'),stage:text(projectAutomation(project).stage)||'script'})),knowledgeGaps:[],blocker:LEGACY_INCREMENTAL_COST_BLOCKER,summary:'已登记真实内容制作项目，等待在生产工作台核对费用后继续。'};

  // Manual workbench completion is a separate real authority. Recover its
  // current signed quality + persisted render-job + actual bytes, without
  // sending this cost-blocked order back through paid automatic stages.
  projects=await Promise.all(projects.map(async project=>{
    const spec=json<Record<string,unknown>>(project.spec,{});
    if(!legacyIncrementalCostBlocker(json(spec.contentOrder,{})))return project;
    const proof=await readLegacyManualCompletion(store,input.tenantId,project),automation=projectAutomation(project);
    if(proof){const existing=json<Record<string,unknown>>(automation.manualStudioCompletion,{});if(automation.stage==='completed'&&existing.sha256===proof.sha256&&existing.inputFingerprint===proof.inputFingerprint)return project;
      await updateProject(project,{...spec,renderOutputPath:proof.outputPath,automation:{...automation,stage:'completed',status:'ready_for_approval',blocker:'',renderOutputPath:proof.outputPath,manualStudioCompletion:proof,quality:{passed:true,source:'verified_manual_studio',ruleVersion:'studio-project-quality-v1',qualityRecordId:proof.qualityRecordId},completedAt:proof.verifiedAt}},'ready_for_approval');changed=true;return (await store.getById<StoredRecord>('studio_projects',project.id))!;
    }
    if(automation.manualStudioCompletion&&automation.stage==='completed'){await updateProject(project,{...spec,automation:{...automation,stage:'blocked',status:'blocked',blocker:LEGACY_INCREMENTAL_COST_BLOCKER,quality:{...json<Record<string,unknown>>(automation.quality,{}),passed:false}}});changed=true;return (await store.getById<StoredRecord>('studio_projects',project.id))!;}
    return project;
  }));

  // Repair the historical focus-product binding bug for every project in the
  // scoped run/task before allocating scarce production slots. The repair is
  // metadata-only: it neither generates media nor clears a genuine blocker.
  // Without this pass, each repaired script project consumed an entire tick
  // before the next sibling could even have its frozen product restored.
  const bindingRepairs = await Promise.all(projects.map(async project => {
    if (text(projectAutomation(project).stage) === 'completed') return null;
    const repaired = repairFrozenOrderProductBinding({
      spec: json<Record<string, unknown>>(project.spec, {}),
      profile,
      config: input.config,
      assets,
    });
    if (!repaired) return null;
    await updateProject(project, repaired);
    return await store.getById<StoredRecord>('studio_projects', project.id)
      || { ...project, spec: repaired, status: 'draft' };
  }));
  const repairedById = new Map(bindingRepairs.filter((project): project is StoredRecord => Boolean(project)).map(project => [project.id, project]));
  if (repairedById.size) {
    projects = projects.map(project => repairedById.get(project.id) || project);
    changed = true;
  }

  // A historical `passed` result is not proof under newer fact/visual rules.
  // Re-open one stale project per tick so it is re-matched, re-voiced and
  // re-rendered before it can count as completed again.
  const staleCompleted = projects.find(project => automatedContentQualityNeedsRevalidation(projectAutomation(project))&&!legacyIncrementalCostBlocker(json<Record<string,unknown>>(json<Record<string,unknown>>(project.spec,{}).contentOrder,{})));
  if (staleCompleted) {
    const staleSpec = json<Record<string, unknown>>(staleCompleted.spec, {});
    const staleAutomation = projectAutomation(staleCompleted);
    const revalidationSpec = {
      ...staleSpec,
      automation: stagePatch(staleAutomation, 'material_match', {
        status: 'queued', blocker: '',
        previousQuality: staleAutomation.quality,
        quality: undefined,
        qualityRevalidationReason: `脚本与视觉规则升级至 v${CONTENT_SCRIPT_QUALITY_RULE_VERSION}`,
      }),
    };
    await updateProject(staleCompleted, revalidationSpec, 'draft');
    const refreshed = await store.getById<StoredRecord>('studio_projects', staleCompleted.id);
    projects = projects.map(project => project.id === staleCompleted.id ? (refreshed || { ...project, status: 'draft', spec: revalidationSpec }) : project);
    changed = true;
  }
  const pending = selectContentProjectsForTick(projects.map(project => ({
    project, stage: text(projectAutomation(project).stage),
    retryable: contentProjectRetryable(projectAutomation(project))
      || (projectAutomation(project).route === 'clone' && projectAutomation(project).replicationBridgeVersion !== MANAGED_REPLICATION_BRIDGE_VERSION)
      || presenterApprovalResumesQuality(projectAutomation(project),
      presenterApprovalForProject(input.tenantId, project.id, json<Record<string, unknown>>(project.spec, {}), projectAutomation(project))),
  }))).map(item => item.project);
  const advancedResults = await Promise.all(pending.map(project => advanceOneProject({
    tenantId: input.tenantId, record: project, config: input.config, goal: input.goal, profile, assets, analyses, allProjects: projects,
  })));
  changed ||= advancedResults.some(result => result.changed);
  const blocker = advancedResults.map(result => result.blocker).find(Boolean) || '';
  const refreshedProjects = await Promise.all(pending.map(project => store.getById<StoredRecord>('studio_projects', project.id)));
  for (const refreshed of refreshedProjects) {
    if (refreshed) projects = projects.map(item => item.id === refreshed.id ? refreshed : item);
  }
  await notifyStarterReviewableContentProjects({ dataStore: store, tenantId: input.tenantId, projects });
  const projectRefs = projects.map(project => {
    const automation = projectAutomation(project);
    return {
      type: 'studio_project' as const,
      id: project.id,
      route: text(automation.route) as ContentProductionRoute,
      language: text(json<Record<string, unknown>>(project.spec, {}).lang, 20),
      status: String(project.status || 'draft'),
      stage: text(automation.stage) || 'script',
      ...(text(automation.renderOutputPath) ? { outputPath: text(automation.renderOutputPath, 2_000) } : {}),
    };
  });
  const coverage = frozenOrders.length ? contentOrderCoverage(projects, frozenOrders.map(order => order.id)) : null;
  const ready = (!coverage || coverage.complete) && projectRefs.length > 0 && projectRefs.every(ref => ref.status === 'ready_for_approval' && ref.stage === 'completed');
  const coverageBlocker = coverage && !coverage.complete ? `内容订单覆盖不完整：缺失 ${coverage.missing.length}，重复 ${coverage.duplicate.length}，非当前订单 ${coverage.unexpected.length}` : '';
  const blocked = projects.map(project => text(projectAutomation(project).blocker)).filter(Boolean);
  return {
    changed,
    ready,
    projectRefs,
    knowledgeGaps: contentProductionKnowledgeGaps({ enabled: requiredRoutes, evidence }),
    blocker: coverageBlocker || blocker || blocked[0] || (ready ? '' : '内容 Agent 正在后台推进素材、配音、渲染与质检'),
    summary: ready ? `已完成 ${projectRefs.length} 个可审批成片` : `内容生产进度 ${projectRefs.filter(ref => ref.stage === 'completed').length}/${projectRefs.length}`,
  };
}
