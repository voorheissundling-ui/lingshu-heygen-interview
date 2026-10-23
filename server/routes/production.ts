import { sentenceReplicationPreview } from '../lib/sentenceReplicationPreview.js';
import { sentenceCueQualityState } from '../lib/sentenceCueQuality.js';
import { preparePhotoTalkingFirstFrames } from '../lib/photoTalkingFirstFrames.js';
import { photoTalkingBudget } from '../lib/photoTalkingBudget.js';
import { assertSeedanceCueDurations, assertSplitCueAssignments } from '../lib/sentenceCueSceneCuts.js';
import { sentenceReplicationReadiness as photoSentenceReadiness } from '../runtime/readiness.js';
import { createPresenterAssetsRouter } from './presenterAssets.js';
import { createPresenterArkEnrollmentRouter } from './presenterArkEnrollment.js';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { studioPaidBudget } from '../lib/studioPaidBudget.js';
import type { DataStore } from '../storage/datastore.js';
import type { HeyGenInput } from '../lib/heygen.js';
import { EMPTY_DEFAULTS, presenterAssetFingerprint, presenterCapabilities, presenterProductionGate, shotFingerprint, type AvatarJob, type PresenterAsset, type PresenterCapability, type ProductionDefaults, type ShotProduction } from '../../src/lib/shotProduction.js';
import { candidateToolsFor, digitalHumanPipelineFor, digitalHumanRouteSteps, planDigitalHumanShot, referenceCuesForConfirmedPresenter, referenceModelInputAuthorization, routeStepsForExecution, usesDirectReferenceVideo, type DigitalHumanExecutionRecord, type DigitalHumanPlanRecord } from '../../src/lib/digitalHumanPlan.js';
import { sentenceExecutionQuality, digitalHumanQualityState, reviewDigitalHumanQuality } from '../../src/lib/digitalHumanQuality.js';
import { digitalHumanToolCapabilities, requiredReferencePreservation, selectReferenceAdapter, verifiedSupplierCost } from '../lib/digitalHumanProviderRegistry.js';
import { normalizePresenterAccountIdentity } from '../lib/presenterAccountIdentity.js';
import { validateHeyGenPresenterRecord, validatePresenterRightsEvidence } from '../lib/presenterAssetTrust.js';
import { planPersonShotClusters } from '../../src/lib/personShotClustering.js';
import type { ExecutionStoreRecord, FirstFrameDraftJobRecord, ImportedVideoResult, PlanStoreRecord, ProductionRouterOptions, SentenceJobRecord } from './productionContracts.js';
import { createProductionRuntime, createProductionStoreRuntime } from './productionRuntime.js';
import { registerPresenterSourceRoutes } from './productionPresenterSourceRoutes.js';
import { registerProductionJobRoutes } from './productionJobRoutes.js';
import { planStudioBatchShotRoutes, uniqueAuthorizedSalesPresenter } from './studioBatchShotRoutes.js';
import { INTERNAL_BUDGET_EXEMPT_CEILING_CNY, studioAigcBatchBudgetPreview, studioAigcBudgetConfigFromEnv } from './studioAigcBatchBudget.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';
import { productionTrendReference } from '../lib/productionTrendReference.js';
import { effectiveDigitalHumanRequirements, type DigitalHumanRequirements } from '../../shared/contracts/digitalHumanRequirements.js';
import { materialIdentityEvidenceForTenant, presenterTrustReasonsForDisplay } from './productionRouteEvidence.js';
export { presenterTrustReasonsForDisplay } from './productionRouteEvidence.js';
import { compareAndSwapStudioProject } from '../lib/studioProjectRevision.js';
export { candidateOutputFromImport } from './productionRuntime.js';

export function createProductionRouter(store: DataStore, importVideo: (url: string, duration: number, job: AvatarJob, input: HeyGenInput, tenantId: string) => Promise<string | ImportedVideoResult>, options: ProductionRouterOptions = {}) {
  const router = Router();
  const { exclusive, enabled, client, executableReferenceAdapters, referenceBudgetLimitCny, maxAttemptsPerShot, sentenceReadiness, releaseReferenceReservation, assertCandidateOutputCurrent } = createProductionRuntime(options);
  const { assertAttemptAvailable, readDefaults } = createProductionStoreRuntime(store, maxAttemptsPerShot);
  router.use('/presenters', createPresenterAssetsRouter(store, exclusive));
  router.use('/presenters', createPresenterArkEnrollmentRouter(store, exclusive));
  registerPresenterSourceRoutes(router, store, { exclusive, readDefaults }, options);
  const resolvedSentenceCues = (project: any, shotId: string, shot: ShotProduction, requirements: DigitalHumanRequirements) => {
    const slot = (Array.isArray(project.spec?.shootingSlots) ? project.spec.shootingSlots : [])
      .find((item: any) => String(item.id) === shotId);
    return referenceCuesForConfirmedPresenter(requirements, {
      shotId,
      slotId: String(slot?.slotId || shotId),
      start: Number(slot?.start),
      end: Number(slot?.end),
      duration: Number(slot?.duration),
      narration: shot.narration,
      salesPresenterConfirmed: slot?.salesPresenterConfirmed === true,
      observedPresenterRole: String(slot?.observedPresenterRole || ''),
      needsReview: slot?.needsReview === true,
      personContinuityId: String(slot?.personContinuityId || ''),
    });
  };

  const persistPlan = async (input: { tenantId: string; project: any; assemblyId: string; shotId: string; fingerprint: string; origin?: 'manual' | 'content_agent'; sourceTaskId?: string; sourceTaskVersion?: string }) => {
    const { tenantId, project, assemblyId, shotId, fingerprint } = input;
    const shot = project.spec?.shotProductions?.[`${assemblyId}:${shotId}`] as ShotProduction | undefined;
    if (!shot || shot.source !== 'avatar') throw new Error('草稿中未找到当前数字人分镜');
    if (!fingerprint || shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), shotId) !== fingerprint) throw new Error('镜头要求与已保存草稿不一致，请保存后重试');
    const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
    const presenter = defaults?.presenters.find(item => item.id === shot.presenterId && item.authorized);
    const slot = (Array.isArray(project.spec?.shootingSlots) ? project.spec.shootingSlots : []).find((item: any) => String(item.id) === shotId);
    const now = new Date().toISOString();
    const requirements = effectiveDigitalHumanRequirements(shot.digitalHuman);
    let plan = planDigitalHumanShot({ requirements, narration: shot.narration, hasAuthorizedPresenter: Boolean(presenter), talkingAvailable: enabled(), seedanceSentenceAvailable: sentenceReadiness().ready, presenterCapabilities: presenter ? presenterCapabilities(presenter) : undefined });
    let referenceEstimatedCostCny: number | null = null;
    let routeDecision: DigitalHumanPlanRecord['routeDecision'] = null;
    const modelInputAuthorization = referenceModelInputAuthorization(requirements, now);
    if (requirements && requirements.method !== 'talking' && plan.state === 'preview_only' && modelInputAuthorization) {
      const requiredPreservation = requiredReferencePreservation({ preserve: requirements.preserve, productMaterialId: shot.productMaterialId, backgroundMaterialId: shot.backgroundMaterialId });
      const selection = selectReferenceAdapter({ adapters: executableReferenceAdapters(tenantId), candidates: candidateToolsFor(requirements), method: requirements.method,
        targetDurationSeconds: Number(slot?.duration) || null,
        maxEstimatedCostCny: referenceBudgetLimitCny(tenantId),
        requiredPreservation });
      routeDecision = { targetDurationSeconds: Number(slot?.duration) || null, budgetLimitCny: referenceBudgetLimitCny(tenantId), requiredPreservation, selectedTool: selection.adapter?.id || null, evaluations: selection.evaluations };
      if (selection.adapter) {
        plan = { ...plan, state: 'ready', executable: true, reasons: [], provider: selection.adapter.id };
        referenceEstimatedCostCny = selection.estimatedCostCny;
      } else if (executableReferenceAdapters(tenantId).length) {
        plan = { ...plan, reasons: [selection.reason] };
      }
    } else if (requirements?.method === 'reenact' && usesDirectReferenceVideo(requirements) && plan.state === 'preview_only' && !modelInputAuthorization) {
      plan = { ...plan, reasons: ['当前仅做结构分析与方案预览；如需把源视频提交给生成模型，请确认模型输入授权并填写依据'] };
    } else if (requirements?.method === 'reenact' && !usesDirectReferenceVideo(requirements) && plan.state === 'preview_only') {
      plan = { ...plan, reasons: [sentenceReadiness().reason || 'Seedream + Seedance 逐句复刻运行环境预检未通过'] };
    }
    if (plan.provider === 'heygen' && plan.executable && presenter) {
      const trust = validateHeyGenPresenterRecord(presenter);
      if (!trust.ok) plan = { ...plan, state: 'needs_input', executable: false,
        reasons: [`HeyGen 人物、音色或授权预检未通过：${presenterTrustReasonsForDisplay(trust.reasons).join('、')}`] };
    }
    const shotKey = `${assemblyId}:${shotId}`;
    const rate = Number(process.env.HEYGEN_ESTIMATED_CNY_PER_SECOND);
    const presenterVersion = Math.max(1, presenter?.assetVersion || 1);
    const existing = (await store.list<PlanStoreRecord>('studio_digital_human_plans', { where: { tenant_id: tenantId, project_id: project.id, shot_key: shotKey, fingerprint }, perPage: 500 })).items
      .find(item => item.payload.presenterAssetVersion === presenterVersion);
    const inputSnapshot = {
      narration: shot.narration, language: String(project.spec?.activeVoiceLang || project.spec?.lang || ''), ratio: String(project.spec?.ratio || ''),
      targetDurationSeconds: Number.isFinite(Number(slot?.duration)) && Number(slot?.duration) > 0 ? Number(slot?.duration) : null,
      sound: shot.sound, presenterId: shot.presenterId, presenterAssetVersion: presenterVersion,
      presenterReferenceMaterialIds: [...new Set((presenter?.toolMappings?.runway?.referenceMaterialIds || presenter?.referenceMaterialIds || []).map(String).filter(Boolean))],
      voiceMapping: presenter?.voiceId && (presenter.avatarId || requirements?.presenterMode === "photo_talking") ? { avatarId: presenter.avatarId, voiceId: presenter.voiceId } : null,
      productId: shot.productId, productMaterialId: shot.productMaterialId, backgroundMaterialId: shot.backgroundMaterialId,
      requirements: requirements ? structuredClone(requirements) : null,
      ...(requirements?.method === 'replace' && requirements.reference?.derivativeAuthorized === true && requirements.reference.derivativeAuthorizationEvidence?.trim() ? {
        derivativeAuthorization: { evidence: requirements.reference.derivativeAuthorizationEvidence.trim(), confirmedAt: now },
      } : {}),
      ...(modelInputAuthorization ? { modelInputAuthorization } : {}),
    };
    const payload: DigitalHumanPlanRecord = { id: existing?.id || '', projectId: project.id, assemblyId, shotId, fingerprint,
      pipeline: digitalHumanPipelineFor(requirements),
      workflow: requirements?.workflow || 'material_processing', method: requirements?.method || 'talking', presenterId: shot.presenterId,
      presenterAssetVersion: presenterVersion, candidateTools: candidateToolsFor(requirements), inputSnapshot,
      routeSteps: digitalHumanRouteSteps(requirements?.method || 'talking', plan.provider, plan.executable, plan.state),
      routeDecision,
      estimatedCostCny: plan.provider === 'heygen' && rate > 0 ? Number((Math.max(1,
        Number.isFinite(Number(slot?.duration)) && Number(slot?.duration) > 0 ? Number(slot.duration) : shot.narration.length / 4) * rate).toFixed(2)) : referenceEstimatedCostCny,
      ...plan, origin: input.origin || existing?.payload.origin || 'manual',
      ...((input.sourceTaskId || existing?.payload.sourceTaskId) ? { sourceTaskId: input.sourceTaskId || existing?.payload.sourceTaskId } : {}),
      ...((input.sourceTaskVersion || existing?.payload.sourceTaskVersion) ? { sourceTaskVersion: input.sourceTaskVersion || existing?.payload.sourceTaskVersion } : {}),
      createdAt: existing?.payload.createdAt || now, updatedAt: now };
    if (existing) {
      if (!await store.update('studio_digital_human_plans', existing.id, { payload })) throw new Error('制作方案来源版本更新失败');
      return { ...payload, id: existing.id };
    }
    const saved = await store.create<PlanStoreRecord>('studio_digital_human_plans', { tenant_id: tenantId, project_id: project.id, shot_key: shotKey, fingerprint, payload });
    if (!saved) throw new Error('制作方案保存失败');
    return { ...payload, id: saved.id };
  };
  router.get('/capabilities', (_req, res) => {
    const rate = Number(process.env.HEYGEN_ESTIMATED_CNY_PER_SECOND);
    const budget = studioPaidBudget.status('heygen', undefined, res.locals.tenantId);
    const tenantId = String(res.locals.tenantId || '');
    res.json({ configured: enabled() && budget.allowed, reason: !enabled() ? '管理员须配置 HEYGEN_API_KEY 并明确启用 HEYGEN_GENERATION_ENABLED；当前不会发起付费生成' : budget.reason, costPerSecond: rate > 0 ? rate : null, budget, referenceBudgetLimitCny: referenceBudgetLimitCny(tenantId), maxAttemptsPerShot: maxAttemptsPerShot(),
      tools: digitalHumanToolCapabilities({ talkingEnabled: enabled() && budget.allowed, talkingCostReconciliation: Boolean(options.reconcileHeyGenCost), adapters: executableReferenceAdapters(tenantId), unavailableReasons: options.toolUnavailableReasons }) });
  });
  router.get('/defaults', async (_req, res) => {
    try { res.json({ ...EMPTY_DEFAULTS, ...((await readDefaults(res.locals.tenantId))?.payload || {}) }); }
    catch { res.status(503).json({ error: '企业出镜设置读取失败' }); }
  });
  router.get('/plans', async (req, res) => {
    try {
      const projectId = String(req.query.projectId || '');
      const result = await store.list<PlanStoreRecord>('studio_digital_human_plans', { where: { tenant_id: res.locals.tenantId, project_id: projectId }, perPage: 500 });
      res.json(result.items.filter(item => item.tenant_id === res.locals.tenantId).map(item => ({ ...item.payload, id: item.id })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } catch { res.status(503).json({ error: '数字人分镜制作方案读取失败' }); }
  });
  router.get('/batch-shot-routes', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const projectId = String(req.query.projectId || '');
      const project = await store.getById<any>('studio_projects', projectId);
      if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
      const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
      const configuredPresenters = (defaults?.presenters ?? []).filter(item => item.authorized && item.id);
      const presenterTrust = new Map(configuredPresenters.map(item => [item.id, validateHeyGenPresenterRecord(item)]));
      const authorizedPresenters = configuredPresenters.filter(item => presenterTrust.get(item.id)?.ok);
      const salesPresenter = uniqueAuthorizedSalesPresenter(authorizedPresenters);
      const presenterGate = presenterProductionGate(defaults);
      if (!presenterGate.ready) throw new Error(presenterGate.message);
      const materialIdentityEvidence = await materialIdentityEvidenceForTenant(tenantId);
      const routes = planStudioBatchShotRoutes(project.spec ?? {}, {
        talkingExecutorReady: enabled() && studioPaidBudget.status('heygen', undefined, tenantId).allowed,
        actionExecutorReady: executableReferenceAdapters(tenantId).length > 0,
        authorizedPresenterIds: authorizedPresenters.map(item => item.id),
        configuredPresenterIds: configuredPresenters.map(item => item.id),
        presenterPreflightIssues: Object.fromEntries([...presenterTrust].map(([id, result]) => [id, result.ok ? [] : presenterTrustReasonsForDisplay(result.reasons)])),
        presenterNamesById: Object.fromEntries(configuredPresenters.map(item => [item.id, item.name])),
        presenterNativeOrientationsById: Object.fromEntries(configuredPresenters.map(item => [item.id, item.nativeOrientation || 'unknown'])),
        defaultSalesPresenterId: salesPresenter?.id ?? null,
        materialIdentityEvidence,
      });
      const aigcBudgetPreview = studioAigcBatchBudgetPreview(routes, {
        ...studioAigcBudgetConfigFromEnv(),
        ...(isInternalBudgetExemptTenant(tenantId) ? { batchBudgetCny: INTERNAL_BUDGET_EXEMPT_CEILING_CNY } : {}),
        creationMode: String(project.spec?.mode || ''),
        slots: Array.isArray(project.spec?.shootingSlots) ? project.spec.shootingSlots : [],
        requestedResolutions: Object.fromEntries(Object.entries(project.spec?.storyboardSourcePlans || {}).map(([id, value]) => {
          const plan = value as { videoResolution?: string; videoResolutionPinned?: boolean };
          return [id, plan?.videoResolutionPinned && (plan.videoResolution === '480p' || plan.videoResolution === '720p')
            ? plan.videoResolution : undefined];
        })),
      });
      res.json({ projectId, planningOnly: true, routes, aigcBudgetPreview, counts: {
        matched: routes.filter(item => item.status === 'matched').length,
        needsPlan: routes.filter(item => item.status === 'needs_plan').length,
        aigcFirstFrame: routes.filter(item => item.route === 'aigc_first_frame').length,
        needsMaterial: routes.filter(item => item.status === 'needs_material').length,
        blocked: routes.filter(item => item.status === 'blocked').length,
      } });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '批量分镜路线检查失败' }); }
  });
  router.get('/executions', async (req, res) => {
    try {
      const result = await store.list<ExecutionStoreRecord>('studio_digital_human_executions', { where: { tenant_id: res.locals.tenantId, project_id: String(req.query.projectId || '') }, perPage: 500 });
      res.json(result.items.filter(item => item.tenant_id === res.locals.tenantId).map(item => ({ ...item.payload, id: item.id })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } catch { res.status(503).json({ error: '数字人执行记录读取失败' }); }
  });
  router.post('/executions/:id/cost', async (req, res) => {
    try {
      const record = await store.getById<ExecutionStoreRecord>('studio_digital_human_executions', req.params.id);
      if (!record || record.tenant_id !== res.locals.tenantId) throw new Error('数字人执行记录不存在');
      const amount = Number(req.body?.actualCostCny); const sourceRef = String(req.body?.sourceRef || '').trim();
      if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000 || !sourceRef || sourceRef.length > 300) throw new Error('实际费用或账单依据无效');
      const payload: DigitalHumanExecutionRecord = { ...record.payload, id: record.id, actualCostCny: Number(amount.toFixed(4)), costStatus: 'reconciled', costSourceRef: sourceRef, updatedAt: new Date().toISOString() };
      if (!await store.update('studio_digital_human_executions', record.id, { payload })) throw new Error('实际费用保存失败');
      res.json(payload);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '实际费用保存失败' }); }
  });
  router.post('/executions/:id/reconcile-cost', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const payload = await exclusive(`cost-reconcile:${tenantId}:${req.params.id}`, async () => {
        const record = await store.getById<ExecutionStoreRecord>('studio_digital_human_executions', req.params.id);
        if (!record || record.tenant_id !== tenantId) throw new Error('数字人执行记录不存在');
        if (record.payload.costStatus === 'reconciled') return { ...record.payload, id: record.id };
        if (record.payload.state !== 'completed' || !record.payload.externalTaskId) throw new Error('供应商任务尚未完成，不能核对最终账单');
        const adapter = (options.adapters || []).find(item => item.id === record.payload.tool);
        const lookup = record.payload.tool === 'heygen'
          ? options.reconcileHeyGenCost
          : adapter?.cost ? (externalTaskId: string) => adapter.cost!(externalTaskId) : undefined;
        if (!lookup) throw new Error('当前供应商未提供可核验的账单查询能力');
        const evidence = verifiedSupplierCost(await lookup(record.payload.externalTaskId));
        if (!evidence) throw new Error('供应商账单尚未生成，请稍后核对原任务；不会使用预计费用替代');
        const next: DigitalHumanExecutionRecord = { ...record.payload, id: record.id, ...evidence, costStatus: 'reconciled', updatedAt: new Date().toISOString() };
        if (!await store.update('studio_digital_human_executions', record.id, { payload: next })) throw new Error('供应商账单对账结果保存失败');
        return next;
      });
      res.json(payload);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '供应商账单对账失败' }); }
  });
  router.post('/executions/:id/quality', async (req, res) => {
    try {
      const record = await store.getById<ExecutionStoreRecord>('studio_digital_human_executions', req.params.id);
      if (!record || record.tenant_id !== res.locals.tenantId) throw new Error('数字人执行记录不存在');
      if (record.payload.adoption) throw new Error('候选已填入分镜；如需更换，请先创建新的候选或装配版本，不能改写已采用版本的验收结论');
      if (record.payload.quality.state === 'failed' || record.payload.quality.reviewedAt) throw new Error('当前候选的人工验收已经结束；不通过后请按修改意见生成新候选，不能改写原结论');
      if (record.payload.quality.checks.find(check => check.key === 'media_import')?.status !== 'passed') throw new Error('媒体尚未通过入库检查，不能完成人工验收');
      await assertCandidateOutputCurrent(record, res.locals.tenantId as string);
      const raw = req.body?.decisions;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('请提交人工验收结果');
      const pendingManual = record.payload.quality.checks.filter(check => check.mode === 'manual' && check.status === 'pending');
      const allowed = new Set(pendingManual.map(check => check.key));
      const decisions: Record<string, { passed: boolean; evidence: string }> = {};
      for (const [key, value] of Object.entries(raw as Record<string, any>)) {
        if (!allowed.has(key) || typeof value?.passed !== 'boolean' || !String(value?.evidence || '').trim()) throw new Error('人工验收项目或依据无效');
        decisions[key] = { passed: value.passed, evidence: String(value.evidence).trim().slice(0, 500) };
      }
      if (!pendingManual.length || pendingManual.some(check => !decisions[check.key]) || Object.keys(decisions).length !== pendingManual.length) {
        throw new Error('请一次提交当前候选全部待人工验收项目的明确结论');
      }
      const reviewNote = String(req.body?.reviewNote || '').trim().slice(0, 1000);
      if (Object.values(decisions).some(decision => !decision.passed) && !reviewNote) throw new Error('质检不通过时请填写具体修改意见');
      const quality = reviewDigitalHumanQuality(record.payload.quality, decisions, new Date().toISOString(), reviewNote);
      const payload = { ...record.payload, id: record.id, quality,
        routeSteps: record.payload.routeSteps ? routeStepsForExecution(record.payload.routeSteps, record.payload.state, quality, Boolean(record.payload.adoption)) : undefined,
        updatedAt: new Date().toISOString() };
      if (!await store.update('studio_digital_human_executions', record.id, { payload })) throw new Error('人工验收结果保存失败');
      res.json(payload);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '人工验收结果保存失败' }); }
  });
  router.post('/plans', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const b = req.body || {};
      const project = await store.getById<any>('studio_projects', String(b.projectId || ''));
      if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
      res.json(await persistPlan({ tenantId, project, assemblyId: String(b.assemblyId || ''), shotId: String(b.shotId || ''), fingerprint: String(b.fingerprint || '') }));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '数字人分镜制作方案保存失败' }); }
  });

  router.post('/sentence-first-frames', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string; const b = req.body || {};
      const project = await store.getById<any>('studio_projects', String(b.projectId || ''));
      if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
      const shot = project.spec?.shotProductions?.[`${b.assemblyId}:${b.shotId}`] as ShotProduction | undefined;
      if (!shot) throw new Error('草稿中未找到当前分镜，请重新打开分镜');
      const requirements = effectiveDigitalHumanRequirements(shot?.digitalHuman);
      if (!requirements || requirements.workflow !== 'viral_replication' || requirements.method !== 'reenact'
        || usesDirectReferenceVideo(requirements)) throw new Error('当前分镜不是逐句首帧重建路线');
      if (shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), String(b.shotId || '')) !== String(b.fingerprint || '')) throw new Error('数字人参数与已保存草稿不一致，请保存后重试');
      const materialId = String(requirements.reference?.materialId || '');
      const cues = resolvedSentenceCues(project, String(b.shotId || ''), shot, requirements);
      if (!cues.length) throw new Error('请先完成爆款参考视频逐句分析');
      const sourceMaterial = materialId ? undefined : await productionTrendReference({ store, tenantId, projectSpec: project.spec,
        shotReference: requirements.reference || {} });
      const resolvedMaterialId = materialId || sourceMaterial!.id;
      const clusterPlan = planPersonShotClusters(cues, Math.max(1, Number(process.env.DIGITAL_HUMAN_MAX_FIRST_FRAMES_PER_VIDEO) || 3));
      if (clusterPlan.state !== 'ready') throw new Error(clusterPlan.blockers.join('；'));
      if (!options.prepareSentenceFirstFrames) throw new Error('逐句首帧提取服务尚未配置');
      const autoSplitPhysicalCuts = project.spec?.automation?.managedBy === 'digital_employee'
        && project.spec?.creationPath === 'viral_replication';
      res.json({ cues: await options.prepareSentenceFirstFrames({ tenantId, referenceMaterialId: resolvedMaterialId, cues, sourceMaterial, autoSplitPhysicalCuts }), clusterPlan });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '逐句首帧提取失败' }); }
  });

  router.post('/photo-talking-first-frames', async (req,res) => {
    try { const tenantId=res.locals.tenantId as string; const b=req.body||{}; if(b.confirmed!==true) throw new Error('请确认目标首帧生成及供应商计费');
      const maxCostCny=Number(b.maxCostCny); if(!Number.isFinite(maxCostCny)||maxCostCny<=0) throw new Error('请填写本次照片口播费用上限');
      const project=await store.getById<any>('studio_projects',String(b.projectId||'')); if(!project||project.tenant_id!==tenantId||project.status!=='draft') throw new Error('创作草稿不存在');
      const shot=project.spec?.shotProductions?.[`${b.assemblyId}:${b.shotId}`] as ShotProduction|undefined;
      if(!shot) throw new Error('草稿中未找到当前分镜，请重新打开分镜');
      const requirements=effectiveDigitalHumanRequirements(shot?.digitalHuman);
      if(!requirements || requirements.workflow!=='viral_replication' || requirements.method!=='reenact' || usesDirectReferenceVideo(requirements)) throw new Error('当前分镜不是逐句首帧重建路线');
      if(shotFingerprint(shot,String(project.spec?.shotProductionContext||''),String(b.shotId))!==b.fingerprint) throw new Error('请先保存当前人物配置');
      const sourceAuthorization=requirements.reference;
      if(sourceAuthorization?.modelInputAuthorized!==true||!String(sourceAuthorization.modelInputAuthorizationEvidence||'').trim()) throw new Error('请先确认原片首帧可作为方舟构图参考，并填写授权依据；未调用供应商');
      const defaults=(await readDefaults(tenantId))?.payload as ProductionDefaults|undefined; const presenter=defaults?.presenters.find(item=>item.id===shot.presenterId&&item.authorized); if(!presenter) throw new Error('请选择企业人物照片');
      const cues=resolvedSentenceCues(project,String(b.shotId||''),shot,requirements);assertSplitCueAssignments(cues);const clusters=planPersonShotClusters(cues,Math.max(1,Number(process.env.DIGITAL_HUMAN_MAX_FIRST_FRAMES_PER_VIDEO)||3));if(clusters.state!=='ready')throw new Error(clusters.blockers.join('；'));
      const quote=requirements.presenterMode === 'photo_talking'
        ? photoTalkingBudget({tenantId,cues,frameCount:clusters.clusters.length,fixedHeygenReserveCny:Number(process.env.STUDIO_HEYGEN_RESERVE_CNY)})
        : {totalCny:clusters.clusters.length * Number(process.env.SEEDREAM_FIRST_FRAME_ESTIMATED_CNY || 0.22)};
      if(quote.totalCny>maxCostCny)throw new Error(`首帧与口播合计预估费用 ¥${quote.totalCny.toFixed(2)} 超过本次上限 ¥${maxCostCny.toFixed(2)}，未调用供应商`);
      const result=await exclusive(`photo-first-frames:${tenantId}:${b.projectId}`,()=>(options.preparePhotoTalkingFirstFrames || preparePhotoTalkingFirstFrames)({tenantId,projectId:project.id,assemblyId:String(b.assemblyId),presenter,cues,certifyForSeedance:requirements.presenterMode!=='photo_talking',requirements}));res.json(result);
    } catch(error) {res.status(400).json({error:error instanceof Error?error.message:'目标首帧生成失败'});}
  });
  router.post('/sentence-first-frame-drafts',async(req,res)=>{
    try {
      const tenantId = res.locals.tenantId as string;
      const b = req.body || {};
      const requestId = String(b.requestId || '');
      if (b.confirmed !== true || !/^[A-Za-z0-9_:.-]{1,150}$/.test(requestId)) throw new Error('请确认千问首帧草稿生成及计费，并提供有效请求标识');
      const result = await exclusive(`qwen-first-frame-draft:${tenantId}:${requestId}`, async () => {
        const prior = (await store.list<FirstFrameDraftJobRecord>('studio_first_frame_draft_jobs', { where: { tenant_id: tenantId, request_id: requestId }, perPage: 1 })).items[0];
        if (prior) {
          if (prior.payload.state === 'completed' && prior.payload.result) return prior.payload.result;
          throw new Error(prior.payload.state === 'failed'
            ? `该千问草稿请求已失败并留档：${prior.payload.error || '原因未知'}；修正后请使用新请求标识`
            : '该千问草稿请求状态未确认，请核对原任务，勿重复提交计费');
        }
        const project = await store.getById<any>('studio_projects', String(b.projectId || ''));
        if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
        const assemblyId = String(b.assemblyId || '');
        const shotId = String(b.shotId || '');
        const fingerprint = String(b.fingerprint || '');
        const shot = project.spec?.shotProductions?.[`${assemblyId}:${shotId}`] as ShotProduction | undefined;
        if (!shot) throw new Error('草稿中未找到当前分镜，请重新打开分镜');
        const requirements = effectiveDigitalHumanRequirements(shot?.digitalHuman);
        if (!requirements || requirements.workflow !== 'viral_replication' || requirements.method !== 'reenact' || usesDirectReferenceVideo(requirements)) throw new Error('当前分镜不是逐句首帧重建路线');
        if (shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), shotId) !== fingerprint) throw new Error('数字人参数与已保存草稿不一致，请保存后重试');
        const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
        const presenter = defaults?.presenters.find(item => item.id === shot.presenterId && item.authorized);
        if (!presenter) throw new Error('请选择已授权企业人物');
        const cues = resolvedSentenceCues(project, shotId, shot, requirements);
        assertSplitCueAssignments(cues);
        if (requirements.presenterMode !== 'photo_talking') assertSeedanceCueDurations(cues);
        if (!cues.length || cues.some(cue => cue.personShot !== false && !cue.sourceFirstFrame?.materialId)) throw new Error('请先完成全部人物镜头的逐句源首帧提取');
        if (!options.generateSentenceFirstFrameDrafts) throw new Error('千问首帧草稿服务尚未配置');
        const now = new Date().toISOString();
        const created = await store.create<FirstFrameDraftJobRecord>('studio_first_frame_draft_jobs', { tenant_id: tenantId, project_id: project.id, request_id: requestId,
          payload: { state: 'running', fingerprint, assemblyId, shotId, createdAt: now, updatedAt: now } });
        if (!created) throw new Error('千问首帧草稿作业留档失败，未发起计费');
        try {
          const generated = await options.generateSentenceFirstFrameDrafts({ tenantId, projectId: project.id, assemblyId, presenter, cues });
          await store.update('studio_first_frame_draft_jobs', created.id, { payload: { ...created.payload, state: 'completed', result: generated, updatedAt: new Date().toISOString() } });
          return generated;
        } catch (error) {
          await store.update('studio_first_frame_draft_jobs', created.id, { payload: { ...created.payload, state: 'failed', error: error instanceof Error ? error.message : '生成失败', updatedAt: new Date().toISOString() } });
          throw error;
        }
      });
      res.json(result);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '千问首帧草稿生成失败' }); }
  });

  router.post('/sentence-replication-preview', async (req,res) => {
    try {
      const tenantId=res.locals.tenantId as string; const b=req.body||{};
      const project=await store.getById<any>('studio_projects',String(b.projectId||''));
      if(!project || project.tenant_id!==tenantId) throw new Error('创作草稿不存在');
      const shot=b.shot as ShotProduction;
      if(!shot?.digitalHuman || !Array.isArray(shot.digitalHuman.reference?.cues)) throw new Error('请先配置逐镜制作方案');
      const presenter=((await readDefaults(tenantId))?.payload as ProductionDefaults|undefined)?.presenters.find(item=>item.id===shot.presenterId && item.authorized);
      if(!presenter) throw new Error('请选择已授权企业人物');
      const jobs=(await store.list<SentenceJobRecord>('studio_sentence_replication_jobs',{where:{tenant_id:tenantId,project_id:project.id},perPage:500})).items;
      const previous=jobs.filter(item=>item.tenant_id===tenantId && item.project_id===project.id && item.payload.assemblyId===b.assemblyId && item.payload.shotId===b.shotId && item.payload.state==='completed' && item.payload.result).map(item=>item.payload.result!);
      const preview=sentenceReplicationPreview(shot,presenter,String(b.language||project.spec?.activeVoiceLang||project.spec?.lang||''),previous,process.env,tenantId);
      res.json({impacts:preview.impacts,estimatedCostCny:preview.estimatedCostCny,estimateError:preview.estimateError});
    } catch(error) {res.status(400).json({error:error instanceof Error?error.message:'修改影响与费用读取失败'});}
  });

  router.get('/sentence-replication-readiness', (_req, res) => {
    // Safe to return to the UI: this reports variable names only, never values.
    res.json(sentenceReadiness());
  });

  router.get('/sentence-replication-jobs/:id', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const record = await store.getById<SentenceJobRecord>('studio_sentence_replication_jobs', req.params.id);
      if (!record || record.tenant_id !== tenantId) throw new Error('逐句生产作业不存在');
      if (record.payload.state !== 'completed' || !record.payload.result) throw new Error(`逐句生产作业尚未完成：${record.payload.state}`);
      res.json({ ...record.payload.result, sentenceJobId: record.id });
    } catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : '逐句生产作业读取失败' }); }
  });

  router.get('/sentence-replication-jobs/:id/status', async (req, res) => {
    try {
      const record = await store.getById<SentenceJobRecord>('studio_sentence_replication_jobs', req.params.id);
      if (!record || record.tenant_id !== res.locals.tenantId) throw new Error('逐句生产作业不存在');
      res.json({ id: record.id, state: record.payload.state, providerTasks: record.payload.providerTasks || {}, error: record.payload.error || '', updatedAt: record.payload.updatedAt });
    } catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : '逐句生产状态读取失败' }); }
  });
  router.get('/sentence-replication-requests/:requestId/status', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const record = (await store.list<SentenceJobRecord>('studio_sentence_replication_jobs', { where: { tenant_id: tenantId, request_id: req.params.requestId }, perPage: 1 })).items[0];
      if (!record) throw new Error('逐句生产请求不存在');
      res.json({ id: record.id, state: record.payload.state, providerTasks: record.payload.providerTasks || {}, error: record.payload.error || '', updatedAt: record.payload.updatedAt });
    } catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : '逐句生产状态读取失败' }); }
  });
  router.get('/sentence-replication-pending', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string; const projectId = String(req.query.projectId || '');
      const project = await store.getById<any>('studio_projects', projectId);
      if (!project || project.tenant_id !== tenantId) throw new Error('创作草稿不存在');
      const jobs = (await store.list<SentenceJobRecord>('studio_sentence_replication_jobs', { where: { tenant_id: tenantId, project_id: projectId }, perPage: 500 })).items;
      const matches = jobs.filter(item => item.payload.assemblyId === req.query.assemblyId && item.payload.shotId === req.query.shotId && item.payload.fingerprint === req.query.fingerprint && item.payload.state === 'uncertain' && Object.keys(item.payload.providerTasks || {}).length);
      matches.sort((a, b) => b.payload.updatedAt.localeCompare(a.payload.updatedAt));
      const record = matches[0]; res.json(record ? { id: record.id, state: record.payload.state, providerTasks: record.payload.providerTasks, error: record.payload.error, updatedAt: record.payload.updatedAt } : null);
    } catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : '待核实逐句任务读取失败' }); }
  });

  async function submitSentenceReplication(tenantId: string, b: { projectId: string; assemblyId: string; shotId: string; fingerprint: string; requestId: string; maxCostCny?: number }, resumeJobId?: string, reprocessJobId?: string) {
    return await exclusive(`sentence-replication:${tenantId}:${b.requestId}`, async () => {
        const requestId = String(b.requestId);
        const existing = (await store.list<SentenceJobRecord>('studio_sentence_replication_jobs', { where: { tenant_id: tenantId, request_id: requestId }, perPage: 1 })).items[0];
        if (resumeJobId && (!existing || existing.id !== resumeJobId || existing.payload.state !== 'uncertain')) throw new Error('原作业不在可恢复状态，请核对状态');
        if (existing && !resumeJobId) {
          if (existing.payload.state === 'completed' && existing.payload.result) return existing.payload.result;
          throw new Error(existing.payload.state === 'failed'
            ? `该请求已失败并已留档：${existing.payload.error || '原因未知'}。修正输入后请发起新请求，勿复用请求标识`
            : '该请求已有生成记录，状态未确认；请核对原任务，勿重复提交计费');
        }
        const project = await store.getById<any>('studio_projects', String(b.projectId || ''));
        if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
        const shot = project.spec?.shotProductions?.[`${b.assemblyId}:${b.shotId}`] as ShotProduction | undefined;
        if (!shot) throw new Error('草稿中未找到当前分镜，请重新打开分镜');
        const requirements = effectiveDigitalHumanRequirements(shot?.digitalHuman);
        if (!requirements || requirements.workflow !== 'viral_replication' || requirements.method !== 'reenact' || usesDirectReferenceVideo(requirements)) throw new Error('当前分镜不是逐句首帧重建路线');
        const fingerprint = String(b.fingerprint || '');
        if (shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), String(b.shotId || '')) !== fingerprint) throw new Error('数字人参数与已保存草稿不一致，请保存后重试');
        if (!resumeJobId) {
          const priorJobs = (await store.list<SentenceJobRecord>('studio_sentence_replication_jobs', { where: { tenant_id: tenantId, project_id: project.id }, perPage: 500 })).items;
          if (priorJobs.some(item => item.payload.assemblyId === b.assemblyId && item.payload.shotId === b.shotId && item.payload.fingerprint === fingerprint && ['running','uncertain'].includes(item.payload.state))) throw new Error('当前分镜已有未核实的逐句任务，请查询并恢复原任务，勿重新提交计费');
        }
        const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
        const presenter = defaults?.presenters.find(item => item.id === shot.presenterId && item.authorized);
        if (!presenter) throw new Error('请选择已授权企业人物');
        if (requirements.presenterMode !== 'photo_talking' && requirements.preferredProvider && !['auto', 'sd'].includes(requirements.preferredProvider)) throw new Error('逐句首帧视频路线当前使用 Seedance；所选模型需走对应执行接口，不能自动替换模型');
        const cues = resolvedSentenceCues(project, String(b.shotId || ''), shot, requirements);
        assertSplitCueAssignments(cues);
        const reprocessRecord = reprocessJobId ? await store.getById<SentenceJobRecord>('studio_sentence_replication_jobs', reprocessJobId) : null;
        if (reprocessJobId && (!reprocessRecord || reprocessRecord.tenant_id !== tenantId || reprocessRecord.project_id !== project.id || !['completed','failed'].includes(reprocessRecord.payload.state) || reprocessRecord.payload.assemblyId !== b.assemblyId || reprocessRecord.payload.shotId !== b.shotId || reprocessRecord.payload.fingerprint !== fingerprint || cues.some(cue => cue.personShot !== false && !reprocessRecord.payload.providerTasks?.[cue.id]))) throw new Error('原逐句作业不完整或与当前分镜不一致，不能恢复供应商结果');
        if (requirements.presenterMode !== 'photo_talking') assertSeedanceCueDurations(cues);
        if (resumeJobId && cues.some(cue => cue.personShot !== false && !existing?.payload.providerTasks?.[cue.id])) throw new Error('原作业缺少完整供应商任务 ID，需人工核对，不能重新提交计费');
        if (!cues.length) throw new Error('缺少逐镜口播时间轴');
        const clusterPlan = planPersonShotClusters(cues, Math.max(1, Number(process.env.DIGITAL_HUMAN_MAX_FIRST_FRAMES_PER_VIDEO) || 3));
        if (clusterPlan.state !== 'ready') throw new Error(clusterPlan.blockers.join('；'));
        if (!clusterPlan.personCueIds.length) throw new Error('当前视频没有人物镜头，不应调用人物首帧或数字人口播生成；请按普通素材混剪路线制作');
        if (!options.runSentenceReplication) throw new Error('逐句目标人物首帧与视频编排器尚未配置');
        const readiness = requirements.presenterMode === 'photo_talking' ? photoSentenceReadiness(process.env, 'heygen') : sentenceReadiness();
        if (!readiness.ready) throw new Error(readiness.reason);
        if (requirements.presenterMode === 'photo_talking' && (!Number.isFinite(Number(b.maxCostCny)) || Number(b.maxCostCny) <= 0)) throw new Error('请填写本次照片口播费用上限');
        const sourceMaterial = requirements.reference?.materialId ? undefined : await productionTrendReference({ store, tenantId, projectSpec: project.spec, shotReference: requirements.reference || {} });
        const savedPlan = await persistPlan({ tenantId, project, assemblyId: String(b.assemblyId), shotId: String(b.shotId), fingerprint });
        const now = new Date().toISOString();
        const record = existing || await store.create<SentenceJobRecord>('studio_sentence_replication_jobs', { tenant_id: tenantId, project_id: project.id, request_id: requestId,
          payload: { state: 'running', fingerprint, assemblyId: String(b.assemblyId), shotId: String(b.shotId), ...(reprocessRecord?.payload.providerTasks ? {providerTasks:reprocessRecord.payload.providerTasks} : {}), createdAt: now, updatedAt: now } });
        if (!record) throw new Error('逐句生成请求记录保存失败，尚未调用供应商');
        if (resumeJobId) { record.payload = { ...record.payload, state: 'running', error: '', updatedAt: now }; if (!await store.update('studio_sentence_replication_jobs', record.id, { payload: record.payload })) throw new Error('原作业恢复状态保存失败'); }
        try {
          const priorResults = (await store.list<SentenceJobRecord>('studio_sentence_replication_jobs', {where:{tenant_id:tenantId,project_id:project.id},perPage:500})).items
            .filter(item=>item.tenant_id===tenantId && item.project_id===project.id && item.payload.assemblyId===b.assemblyId && item.payload.shotId===b.shotId && item.payload.state==='completed' && item.payload.result).map(item=>item.payload.result!);
          const reuse = sentenceReplicationPreview(shot,presenter,String(project.spec?.activeVoiceLang||project.spec?.lang||''),priorResults,process.env,tenantId);
          const generated = await options.runSentenceReplication({ tenantId, projectId: project.id, assemblyId: String(b.assemblyId), shotId: String(b.shotId), fingerprint, shot, presenter, cues, requestId, maxCostCny: b.maxCostCny, targetLanguage: String(project.spec?.activeVoiceLang || project.spec?.lang || ''), sourceMaterial, reuseCueMaterialIds:reuse.reuseCueMaterialIds,reuseCueQuality:reuse.reuseCueQuality, existingProviderTasks: resumeJobId || reprocessJobId ? record.payload.providerTasks : undefined,
            onProviderTaskSubmitted: async (cueId,taskId)=>{ const providerTasks={...(record.payload.providerTasks||{}),[cueId]:taskId}; record.payload={...record.payload,providerTasks,updatedAt:new Date().toISOString()}; if(!await store.update('studio_sentence_replication_jobs',record.id,{payload:record.payload})) throw new Error('供应商已受理任务但任务 ID 持久化失败；请核对原任务，勿重复提交'); } });
          if (!generated.candidateOutput) throw new Error('逐句拼接候选缺少可复核的对象版本与内容哈希');
          const quality = sentenceExecutionQuality(generated.cueQuality, generated.materialId);
          const execution: DigitalHumanExecutionRecord = { id: '', planId: savedPlan.id, jobId: record.id, projectId: project.id, assemblyId: String(b.assemblyId), shotId: String(b.shotId), fingerprint,
            tool: requirements.presenterMode === 'photo_talking' ? 'heygen' : 'runway_seedance', provider: requirements.presenterMode === 'photo_talking' ? 'sentence_first_frame_heygen' : 'sentence_first_frame_pipeline', model: requirements.presenterMode === 'photo_talking' ? 'heygen-v3-photo' : process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast-260128', presenterAssetVersion: presenter.assetVersion || 1,
            submissionOutcome: 'created', candidateOutput: generated.candidateOutput, routeSteps: routeStepsForExecution(savedPlan.routeSteps || [], 'completed', quality), state: 'completed',
            externalTaskId: generated.providerTaskIds?.join(',') || null, materialId: generated.materialId, estimatedCostCny: null, actualCostCny: null, costStatus: 'awaiting_invoice', costSourceRef: null,
            error: '', quality, createdAt: now, updatedAt: new Date().toISOString() };
          const executionRecord = await store.create<ExecutionStoreRecord>('studio_digital_human_executions', { tenant_id: tenantId, project_id: project.id, job_id: record.id, plan_id: savedPlan.id, request_id: requestId, payload: execution });
          if (!executionRecord) throw new Error('逐句生成已完成但验收记录保存失败；请核对素材库，勿重复提交');
          const completed = { ...generated, executionId: executionRecord.id, sentenceJobId: record.id };
          const payload: SentenceJobRecord['payload'] = { ...record.payload, state: 'completed', result: completed, updatedAt: new Date().toISOString() };
          if (!await store.update('studio_sentence_replication_jobs', record.id, { payload })) throw new Error('逐句生成已完成但结果记录保存失败；请核对素材库，勿重复提交');
          return completed;
        } catch (error) {
          const message = error instanceof Error ? error.message : '逐句生成失败';
          const hasSubmittedTask = Object.keys(record.payload.providerTasks || {}).length > 0;
          const uncertain = !/任务明确失败/.test(message) && (hasSubmittedTask || /未知|超时|核对原任务|已完成但/.test(message));
          await store.update('studio_sentence_replication_jobs', record.id, { payload: { ...record.payload, state: uncertain ? 'uncertain' : 'failed', error: message, updatedAt: new Date().toISOString() } });
          throw error;
        }
      });
  }
  router.post('/sentence-replication-jobs', async (req, res) => {
    try {
      const b = req.body || {};
      if (b.confirmed !== true || !/^[A-Za-z0-9_:.-]{1,150}$/.test(String(b.requestId || ''))) throw new Error('请确认逐句视频生成及供应商计费，并提供有效请求标识');
      res.json(await submitSentenceReplication(res.locals.tenantId as string, b));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '逐句爆款复刻失败' }); }
  });
  router.post('/sentence-replication-jobs/:id/resume', async (req, res) => {
    try {
      if (req.body?.confirmed !== true) throw new Error('请确认查询原 HeyGen 任务并继续本地验收');
      const record = await store.getById<SentenceJobRecord>('studio_sentence_replication_jobs', req.params.id);
      if (!record || record.tenant_id !== res.locals.tenantId) throw new Error('逐句生产作业不存在');
      res.json(await submitSentenceReplication(record.tenant_id, { projectId: record.project_id, assemblyId: record.payload.assemblyId, shotId: record.payload.shotId, fingerprint: record.payload.fingerprint, requestId: record.request_id, maxCostCny: Number(req.body?.maxCostCny) }, record.id));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '逐句生产原任务恢复失败' }); }
  });
  router.post('/sentence-replication-jobs/:id/reprocess', async (req, res) => {
    try {
      const record = await store.getById<SentenceJobRecord>('studio_sentence_replication_jobs', req.params.id);
      if (!record || record.tenant_id !== res.locals.tenantId) throw new Error('原 HeyGen 作业不存在');
      res.json(await submitSentenceReplication(record.tenant_id, {projectId:record.project_id,assemblyId:record.payload.assemblyId,shotId:record.payload.shotId,fingerprint:record.payload.fingerprint,requestId:randomUUID(),maxCostCny:Number(req.body?.maxCostCny)},undefined,record.id));
    } catch (error) { res.status(400).json({error:error instanceof Error?error.message:'原 HeyGen 素材重整失败'}); }
  });
  router.post('/sentence-replication-jobs/:id/cue-quality', async (req,res)=>{
    try { const tenantId=res.locals.tenantId as string; const record=await store.getById<SentenceJobRecord>('studio_sentence_replication_jobs',req.params.id);
      if(!record || record.tenant_id!==tenantId || record.payload.state!=='completed' || !record.payload.result?.cueQuality) throw new Error('逐镜质检记录不存在或生产尚未完成');
      const submitted=req.body?.decisions && typeof req.body.decisions==='object'?req.body.decisions as Record<string,Record<string,{passed?:unknown;evidence?:unknown}>>:{};
      const allowed=new Set(['identity','motion','product_brand_text','background','audio_sync','reuse_risk']);
      const cueQuality=record.payload.result.cueQuality.map(cue=>{ const decisions=submitted[cue.cueId]||{}; const checks=cue.checks.map(check=>{ if(check.status!=='pending'||!allowed.has(check.key)||!decisions[check.key]) return check; const decision=decisions[check.key]!; const evidence=String(decision.evidence||'').trim(); if(typeof decision.passed!=='boolean'||!evidence) throw new Error(`镜头 ${cue.cueId} 的 ${check.key} 缺少明确结论或证据`); return {...check,status:decision.passed?'passed' as const:'failed' as const,evidence}; }); const state=sentenceCueQualityState(checks); return {...cue,checks,state}; });
      const failedCueIds=cueQuality.filter(cue=>cue.state==='failed').map(cue=>cue.cueId); const result={...record.payload.result,cueQuality,failedCueIds}; const payload={...record.payload,result,updatedAt:new Date().toISOString()}; if(!await store.update('studio_sentence_replication_jobs',record.id,{payload})) throw new Error('逐镜质检结果保存失败');
      if(result.executionId){ const execution=await store.getById<ExecutionStoreRecord>('studio_digital_human_executions',result.executionId); if(execution && execution.tenant_id===tenantId){const quality=sentenceExecutionQuality(cueQuality,result.materialId); if(!await store.update('studio_digital_human_executions',execution.id,{payload:{...execution.payload,quality,routeSteps:routeStepsForExecution(execution.payload.routeSteps||[],'completed',quality),updatedAt:new Date().toISOString()}}))throw new Error('逐镜质检已保存但执行质量同步失败，请刷新原任务');}} res.json(result);
    } catch(error){res.status(400).json({error:error instanceof Error?error.message:'逐镜质检保存失败'});}
  });
  router.post('/sentence-replication-jobs/:id/retry-failed',async(req,res)=>{
    let retryRecord:SentenceJobRecord|undefined;
    try { const tenantId=res.locals.tenantId as string; const requestId=String(req.body?.requestId||''); if(req.body?.confirmed!==true||!/^[A-Za-z0-9_:.-]{1,150}$/.test(requestId)) throw new Error('请确认局部返工计费，并提供新的有效请求标识');
      const result=await exclusive(`sentence-repair:${tenantId}:${requestId}`,async()=>{ const previous=await store.getById<SentenceJobRecord>('studio_sentence_replication_jobs',req.params.id); if(!previous||previous.tenant_id!==tenantId||previous.payload.state!=='completed'||!previous.payload.result) throw new Error('原逐句作业不存在或尚未完成');
        const existing=(await store.list<SentenceJobRecord>('studio_sentence_replication_jobs',{where:{tenant_id:tenantId,request_id:requestId},perPage:1})).items[0]; if(existing){if(existing.payload.state==='completed'&&existing.payload.result)return existing.payload.result;throw new Error('该返工请求已存在且状态未确认，请核对原任务，勿重复提交计费');}
        const failed=new Set(previous.payload.result.failedCueIds||[]); if(!failed.size) throw new Error('原作业没有已确认的失败镜头，无需发起局部返工');
        const project=await store.getById<any>('studio_projects',previous.project_id); if(!project||project.tenant_id!==tenantId||project.status!=='draft') throw new Error('创作草稿不存在或不可编辑');
        const {assemblyId,shotId,fingerprint}=previous.payload; const shot=project.spec?.shotProductions?.[`${assemblyId}:${shotId}`] as ShotProduction|undefined; if(!shot||shotFingerprint(shot,String(project.spec?.shotProductionContext||''),shotId)!==fingerprint) throw new Error('分镜要求已经变化，请保存为新的完整生产请求');
        const defaults=(await readDefaults(tenantId))?.payload as ProductionDefaults|undefined; const presenter=defaults?.presenters.find(item=>item.id===shot.presenterId&&item.authorized); if(!presenter)throw new Error('原人物资产已不可用'); const requirements=effectiveDigitalHumanRequirements(shot.digitalHuman);if(!requirements||requirements.method!=='reenact'||requirements.workflow!=='viral_replication')throw new Error('当前分镜已不再使用逐句首帧重建路线');const cues=resolvedSentenceCues(project,shotId,shot,requirements);
        const priorCues=new Map(previous.payload.result.cues.map(cue=>[cue.id,cue])); const reuseCueMaterialIds:Record<string,string>={}; for(const cue of cues)if(!failed.has(cue.id)){const materialId=String(priorCues.get(cue.id)?.generatedClip?.materialId||'');if(!materialId)throw new Error(`已通过镜头 ${cue.id} 缺少可复用素材`);reuseCueMaterialIds[cue.id]=materialId;}
        const reuseCueQuality=(previous.payload.result.cueQuality||[]).filter(item=>!failed.has(item.cueId)&&item.state==='accepted'); if(Object.keys(reuseCueMaterialIds).length!==reuseCueQuality.length)throw new Error('已通过镜头缺少完整质量验收证据，不能在局部返工中直接复用');
        const now=new Date().toISOString(); const createdRetry=await store.create<SentenceJobRecord>('studio_sentence_replication_jobs',{tenant_id:tenantId,project_id:project.id,request_id:requestId,payload:{state:'running',fingerprint,assemblyId,shotId,createdAt:now,updatedAt:now}}); if(!createdRetry)throw new Error('局部返工作业保存失败，尚未调用供应商'); retryRecord=createdRetry;
        try { const generated=await options.runSentenceReplication!({tenantId,projectId:project.id,assemblyId,shotId,fingerprint,shot,presenter,cues,requestId,reuseCueMaterialIds,reuseCueQuality,onProviderTaskSubmitted:async(cueId,taskId)=>{const providerTasks={...(retryRecord!.payload.providerTasks||{}),[cueId]:taskId};retryRecord!.payload={...retryRecord!.payload,providerTasks,updatedAt:new Date().toISOString()};if(!await store.update('studio_sentence_replication_jobs',retryRecord!.id,{payload:retryRecord!.payload}))throw new Error('Seedance 已受理返工任务但任务 ID 持久化失败；请核对原任务，勿重复提交');}});
          if(!generated.candidateOutput)throw new Error('局部返工拼接结果缺少可复核对象证据'); const savedPlan=await persistPlan({tenantId,project,assemblyId,shotId,fingerprint}); const quality=sentenceExecutionQuality(generated.cueQuality, generated.materialId); const execution:DigitalHumanExecutionRecord={id:'',planId:savedPlan.id,jobId:retryRecord.id,projectId:project.id,assemblyId,shotId,fingerprint,tool:shot.digitalHuman?.presenterMode==='photo_talking'?'heygen':'runway_seedance',provider:shot.digitalHuman?.presenterMode==='photo_talking'?'sentence_first_frame_heygen_repair':'sentence_first_frame_repair',model:shot.digitalHuman?.presenterMode==='photo_talking'?'heygen-v3-photo':process.env.SEEDANCE_MODEL||'doubao-seedance-2-0-fast-260128',presenterAssetVersion:presenter.assetVersion||1,submissionOutcome:'created',candidateOutput:generated.candidateOutput,routeSteps:routeStepsForExecution(savedPlan.routeSteps||[],'completed',quality),state:'completed',externalTaskId:generated.providerTaskIds?.join(',')||null,materialId:generated.materialId,estimatedCostCny:null,actualCostCny:null,costStatus:'awaiting_invoice',costSourceRef:null,error:'',quality,createdAt:now,updatedAt:new Date().toISOString()}; const executionRecord=await store.create<ExecutionStoreRecord>('studio_digital_human_executions',{tenant_id:tenantId,project_id:project.id,job_id:retryRecord.id,plan_id:savedPlan.id,request_id:requestId,payload:execution});if(!executionRecord)throw new Error('局部返工已完成但执行记录保存失败；请核对素材库，勿重复提交'); const completed={...generated,executionId:executionRecord.id,sentenceJobId:retryRecord.id}; const payload={...retryRecord.payload,state:'completed' as const,result:completed,updatedAt:new Date().toISOString()};if(!await store.update('studio_sentence_replication_jobs',retryRecord.id,{payload}))throw new Error('局部返工已完成但结果记录保存失败；请核对素材库，勿重复提交');return completed;
        }catch(error){const message=error instanceof Error?error.message:'局部返工失败';const uncertain=/未知|超时|核对原任务|已完成但|已受理/.test(message);await store.update('studio_sentence_replication_jobs',retryRecord.id,{payload:{...retryRecord.payload,state:uncertain?'uncertain':'failed',error:message,updatedAt:new Date().toISOString()}});throw error;}
      });res.json(result);
    }catch(error){res.status(400).json({error:error instanceof Error?error.message:'逐镜局部返工失败'});}
  });
  router.post('/executions/:id/adopt', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const payload = await exclusive(`adopt:${tenantId}:${req.params.id}`, async () => {
        const record = await store.getById<ExecutionStoreRecord>('studio_digital_human_executions', req.params.id);
        if (!record || record.tenant_id !== tenantId) throw new Error('数字人执行记录不存在');
        const candidateId = String(req.body?.candidateId || ''); const materialId = String(req.body?.materialId || '');
        if (!candidateId || !materialId) throw new Error('候选或素材标识无效');
        if (digitalHumanQualityState(record.payload.quality.checks) !== 'accepted' || record.payload.state !== 'completed' || record.payload.materialId !== materialId) throw new Error('候选尚未完成生成或存在质量失败，不能填入分镜');
        record.payload.quality = { ...record.payload.quality, state: digitalHumanQualityState(record.payload.quality.checks) };
        await assertCandidateOutputCurrent(record, tenantId);
        if (record.payload.adoption) {
          if (record.payload.adoption.candidateId !== candidateId || record.payload.adoption.materialId !== materialId) throw new Error('该执行结果已填入其他候选，不能静默改写装配记录');
          return { ...record.payload, id: record.id };
        }
        const project = await store.getById<any>('studio_projects', record.project_id);
        if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
        const shotKey = `${record.payload.assemblyId}:${record.payload.shotId}`;
        const shot = project.spec?.shotProductions?.[shotKey] as ShotProduction | undefined;
        if (!shot || shot.locked || shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), record.payload.shotId) !== record.payload.fingerprint) throw new Error('当前分镜要求已变化或已锁定，不能采用旧候选');
        const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
        const currentPresenter = defaults?.presenters.find(item => item.id === shot.presenterId && item.authorized);
        if (!currentPresenter || Math.max(1, currentPresenter.assetVersion || 1) !== record.payload.presenterAssetVersion) throw new Error('人物或音色资产版本已变化，请重新生成并验收当前分镜');
        if (record.payload.tool === 'heygen') {
          const trust = validateHeyGenPresenterRecord(currentPresenter);
          if (!trust.ok) throw new Error(`人物或声音授权已失效，不能采用候选：${presenterTrustReasonsForDisplay(trust.reasons).join('、')}`);
        }
        const candidate = shot.candidates.find(item => item.id === candidateId && item.materialId === materialId && item.fingerprint === record.payload.fingerprint
          && (item.jobId === record.id || item.jobId === record.payload.jobId));
        if (!candidate) throw new Error('当前草稿中未找到与本次执行匹配的候选');
        const slot = (Array.isArray(project.spec?.shootingSlots) ? project.spec.shootingSlots : []).find((item: any) => String(item.id) === record.payload.shotId);
        if (!slot?.slotId) throw new Error('当前分镜缺少装配时间轴绑定');
        const adoptedAt = new Date().toISOString(); const assemblyVersion = randomUUID();
        const nextSpec = structuredClone(project.spec || {});
        nextSpec.shotProductions = { ...(nextSpec.shotProductions || {}), [shotKey]: { ...shot, adoptedId: candidateId } };
        nextSpec.storyboardAssignments = { ...(nextSpec.storyboardAssignments || {}), [slot.slotId]: materialId };
        const adoption = { candidateId, materialId, assemblyVersion, adoptedAt, planId: record.payload.planId, fingerprint: record.payload.fingerprint,
          presenterAssetVersion: record.payload.presenterAssetVersion, ...(record.payload.quality.reviewedAt ? { qualityReviewedAt: record.payload.quality.reviewedAt } : {}),
          ...(record.payload.candidateOutput ? { ...(record.payload.candidateOutput.objectKey ? { candidateObjectKey: record.payload.candidateOutput.objectKey } : {}),
            ...(record.payload.candidateOutput.localFile ? { candidateLocalFile: record.payload.candidateOutput.localFile } : {}),
            candidateContentSha256: record.payload.candidateOutput.contentSha256,
            ...(record.payload.candidateOutput.objectEtag ? { candidateObjectEtag: record.payload.candidateOutput.objectEtag } : {}) } : {}) };
        nextSpec.digitalHumanAssemblyAdoptions = { ...(nextSpec.digitalHumanAssemblyAdoptions || {}), [shotKey]: { executionId: record.id, ...adoption } };
        const savedProject = await compareAndSwapStudioProject(store, project, { spec: nextSpec });
        if (!savedProject.ok) throw new Error('候选验收期间草稿已更新，未覆盖最新内容；请刷新后重新确认');
        const next: DigitalHumanExecutionRecord = { ...record.payload, id: record.id, adoption,
          routeSteps: record.payload.routeSteps ? routeStepsForExecution(record.payload.routeSteps, record.payload.state, record.payload.quality, true) : undefined,
          updatedAt: adoptedAt };
        if (!await store.update('studio_digital_human_executions', record.id, { payload: next })) throw new Error('候选已写入草稿，但执行装配记录保存失败；请刷新原任务修复，勿重新生成');
        return next;
      });
      res.json(payload);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '候选填入分镜失败' }); }
  });
  router.post('/plans/sync-agent', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const project = await store.getById<any>('studio_projects', String(req.body?.projectId || ''));
      if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
      const sourcePlans = Array.isArray(project.spec?.socialDigitalHumanPlans) ? project.spec.socialDigitalHumanPlans : [];
      const slots = Array.isArray(project.spec?.shootingSlots) ? project.spec.shootingSlots : [];
      const assemblyId = String(project.spec?.activeAssemblyId || '');
      const records: DigitalHumanPlanRecord[] = [];
      for (const [index, source] of sourcePlans.entries()) {
        const slot = slots.find((item: any) => item.slotId === source.shotId) || slots[Number.isInteger(source.shotIndex) ? source.shotIndex : index];
        if (!slot?.id) continue;
        const shot = project.spec?.shotProductions?.[`${assemblyId}:${slot.id}`] as ShotProduction | undefined;
        if (!shot || shot.source !== 'avatar') continue;
        records.push(await persistPlan({ tenantId, project, assemblyId, shotId: String(slot.id), fingerprint: shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), String(slot.id)),
          origin: 'content_agent', sourceTaskId: String(source.sourceTaskId || ''), sourceTaskVersion: String(source.sourceTaskVersion || '') }));
      }
      res.json(records);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Content Agent 分镜方案同步失败' }); }
  });
  router.post('/defaults', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const b = req.body as ProductionDefaults;
      const invalidPresenter = (item: PresenterAsset) => {
        const referenceMaterialIds = Array.isArray(item?.referenceMaterialIds) ? item.referenceMaterialIds.filter(Boolean) : [];
        const hasHeyGenPair = Boolean((item?.avatarId && item?.voiceId)
          || (item?.toolMappings?.heygen?.avatarId && item?.toolMappings?.heygen?.voiceId));
        const safeLocalProfile = item?.authorized === false
          && !item.avatarId && !item.voiceId && !item.toolMappings?.heygen?.avatarId && !item.toolMappings?.heygen?.voiceId
          && referenceMaterialIds.length >= 2 && item.arkCertification?.status === 'profile_incomplete';
        return !item || !item.id || !item.name
          || (item.authorized !== true && !safeLocalProfile)
          || (item.authorized === true && !hasHeyGenPair && referenceMaterialIds.length === 0);
      };
      if (!b || !['auto', 'avatar', 'real', 'none'].includes(b.preference) || !Array.isArray(b.presenters) || b.presenters.length > 50 || b.presenters.some(invalidPresenter)
        || new Set(b.presenters.map(item => item.id)).size !== b.presenters.length || (b.defaultPresenterId && !b.presenters.some(item => item.id === b.defaultPresenterId))) {
        res.status(400).json({ error: '请完整填写人物资料；未完成平台授权的人物只能保存为本地待认证资料' }); return;
      }
      if (options.validatePresenterMaterials) {
        const presenterMaterialIds = b.presenters.flatMap(item => [item.referenceMaterialIds,
          item.toolMappings?.seedance?.referenceMaterialIds, item.toolMappings?.sd?.referenceMaterialIds,
          item.toolMappings?.runway?.referenceMaterialIds].flatMap(ids => Array.isArray(ids) ? ids : []));
        try { await options.validatePresenterMaterials(tenantId, presenterMaterialIds); }
        catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '人物参考资产校验失败' }); return; }
      }
      const payload = await exclusive(`defaults:${tenantId}`, async () => {
        const existing = await readDefaults(tenantId); const previous = (existing?.payload as ProductionDefaults | undefined)?.presenters || [];
        const presenterRoutes = (Array.isArray(b.presenterRoutes) ? b.presenterRoutes : []).map(route => ({
          channel: String(route.channel), presenterId: String(route.presenterId || ''), voiceId: String(route.voiceId || ''), layout: String(route.layout || 'full'),
        }));
        if (presenterRoutes.length > 6 || presenterRoutes.some(route => !['default','tiktok','youtube','facebook','instagram','live'].includes(route.channel)
          || !['full','split','pip'].includes(route.layout) || (route.presenterId && !b.presenters.some(item => item.id === route.presenterId)))) throw new Error('渠道出镜策略包含无效人物或布局');
        const next: ProductionDefaults = { preference: b.preference, defaultPresenterId: String(b.defaultPresenterId || ''),
          defaultSound: ['voiceover', 'source', 'silent'].includes(b.defaultSound) ? b.defaultSound : 'voiceover',
          defaultLayout: ['full', 'split', 'pip'].includes(b.defaultLayout) ? b.defaultLayout : 'full', presenterRoutes: presenterRoutes as ProductionDefaults['presenterRoutes'], presenters: b.presenters.map(item => {
        const referenceMaterialIds = Array.isArray(item.referenceMaterialIds) ? [...new Set(item.referenceMaterialIds.map(id => String(id).trim()).filter(Boolean))].slice(0, 30) : [];
        const avatarId = String(item.toolMappings?.heygen?.avatarId || item.avatarId).slice(0, 200);
        const voiceId = String(item.toolMappings?.heygen?.voiceId || item.voiceId).slice(0, 200);
        const capabilities: PresenterCapability[] = [...(avatarId && voiceId ? ['talking' as const] : []), ...(referenceMaterialIds.length && voiceId && !avatarId ? ['talking' as const] : []), ...(referenceMaterialIds.length ? ['reference_image' as const, 'reference_video' as const, 'person_replacement' as const] : [])];
        const accountIdentity = normalizePresenterAccountIdentity(item);
        const certification = item.arkCertification && typeof item.arkCertification === 'object' ? item.arkCertification : undefined;
        const assetUri = String(certification?.assetUri || '').trim(); const assetStatus = String(certification?.status || 'ark_pending');
        if (assetUri && !/^asset:\/\/asset-[a-z0-9-]+$/i.test(assetUri)) throw new Error('方舟 Asset ID 格式无效');
        const priorPresenter = previous.find(value => value.id === String(item.id));
        let declaration = item.authorizationConfirmation?.subjectAdultConfirmed === true
          ? { ...(priorPresenter?.authorizationConfirmation || {}),
              id: priorPresenter?.authorizationConfirmation?.id || randomUUID(),
              recordedAt: Number.isFinite(Date.parse(String(priorPresenter?.authorizationConfirmation?.recordedAt || '')))
                ? priorPresenter!.authorizationConfirmation!.recordedAt : new Date().toISOString(),
              version: priorPresenter?.authorizationConfirmation?.version || 'presenter-upload-authorization-v1',
              subjectAdultConfirmed: true,
              ...(item.authorizationConfirmation.arkProcessingAuthorized === true ? { arkProcessingAuthorized: true } : {}),
              ...(item.authorizationConfirmation.heygenProcessingAuthorized === true ? { heygenProcessingAuthorized: true } : {}) } : undefined;
        // Rights references are server-owned. Client-supplied references are not
        // accepted as proof; an explicit declaration may renew invalid legacy
        // evidence with a fresh, auditable server-issued envelope.
        let rightsEvidence = priorPresenter?.rightsEvidence ? structuredClone(priorPresenter.rightsEvidence) : undefined;
        const grantDeclaredRights = (provider: 'heygen' | 'volcengine_ark', uses: Array<'digital_presenter' | 'voice_synthesis' | 'person_replacement'>, renewForNewScope: boolean) => {
          if (!declaration) return rightsEvidence;
          const candidate = { ...(rightsEvidence || {}), subjectAdultConfirmed: true,
            permittedProviders: [...new Set([...(rightsEvidence?.permittedProviders || []), provider])],
            permittedUses: [...new Set([...(rightsEvidence?.permittedUses || []), ...uses])],
          } as NonNullable<PresenterAsset['rightsEvidence']>;
          const checked = validatePresenterRightsEvidence(candidate, { provider, uses });
          // Extending a declaration to another processing provider is a new
          // authorization event. A valid envelope for an older scope must not
          // be silently reused as evidence for the newly declared provider.
          if (checked.ok && !renewForNewScope) return checked.evidence;
          declaration = { ...declaration, id: randomUUID(), recordedAt: new Date().toISOString(),
            version: 'presenter-upload-authorization-v2', subjectAdultConfirmed: true };
          const providerScopes = [...(rightsEvidence?.providerScopes || []).filter(scope => scope.provider !== provider), { provider, uses }];
          return {
            authorizationRef: `document://presenter-declarations/${declaration.id}`,
            consentRef: `consent://presenter-declarations/${declaration.id}`,
            grantedAt: declaration.recordedAt!,
            subjectAdultConfirmed: true,
            permittedProviders: [...new Set([...(rightsEvidence?.permittedProviders || []), provider])],
            permittedUses: [...new Set([...(rightsEvidence?.permittedUses || []), ...uses])],
            providerScopes,
          } satisfies NonNullable<PresenterAsset['rightsEvidence']>;
        };
        if (declaration?.arkProcessingAuthorized) rightsEvidence = grantDeclaredRights('volcengine_ark', ['digital_presenter', 'person_replacement'],
          priorPresenter?.authorizationConfirmation?.arkProcessingAuthorized !== true
            || !validatePresenterRightsEvidence(priorPresenter?.rightsEvidence, { provider: 'volcengine_ark', uses: ['digital_presenter', 'person_replacement'] }).ok);
        if (declaration?.heygenProcessingAuthorized) rightsEvidence = grantDeclaredRights('heygen', ['digital_presenter', 'voice_synthesis'],
          priorPresenter?.authorizationConfirmation?.heygenProcessingAuthorized !== true
            || !validatePresenterRightsEvidence(priorPresenter?.rightsEvidence, { provider: 'heygen', uses: ['digital_presenter', 'voice_synthesis'] }).ok);
        if (assetStatus === 'active' && (!assetUri || certification?.assetType !== 'image' || !referenceMaterialIds.includes(String(certification?.materialId || '')) || !rightsEvidence?.authorizationRef || !rightsEvidence?.consentRef || rightsEvidence?.subjectAdultConfirmed !== true)) {
          throw new Error('方舟图片资产标记为 Active 前，必须绑定人物图片并补齐主体授权、同意凭证和成年人确认');
        }
        if (assetStatus === 'active' && certification?.verificationSource === 'manual_console') {
          const confirmation = certification.manualConfirmation;
          const previousCertification = priorPresenter?.arkCertification;
          const unchangedLegacyConfirmation = previousCertification?.status === 'active' && previousCertification.verificationSource === 'manual_console'
            && previousCertification.assetUri === assetUri && previousCertification.materialId === certification.materialId
            && !previousCertification.manualConfirmation;
          if (!unchangedLegacyConfirmation && (confirmation?.imageTypeConfirmed !== true || confirmation?.activeConfirmed !== true
            || confirmation?.samePersonConfirmed !== true || !Number.isFinite(Date.parse(String(confirmation?.confirmedAt || ''))))) {
            throw new Error('请确认方舟素材是图片、状态为 Active，且与当前授权人物为同一人');
          }
        }
        if (assetStatus === 'active' && !['ark_api', 'manual_console'].includes(String(certification?.verificationSource || ''))) {
          throw new Error('方舟 Active 状态必须来自只读接口或控制台人工核验');
        }
        const normalized: PresenterAsset = { id: String(item.id).slice(0, 100), name: String(item.name).slice(0, 100), avatarId, voiceId,
          ...(item.voiceAuthorization?.voiceId === voiceId && Number.isFinite(Date.parse(String(item.voiceAuthorization.recordedAt || ''))) ? { voiceAuthorization: { voiceId, recordedAt: item.voiceAuthorization.recordedAt, source: 'user_confirmation' as const, ...(typeof item.voiceAuthorization.authorizationRef === 'string' ? { authorizationRef: item.voiceAuthorization.authorizationRef } : {}) } } : {}),
          authorized: item.authorized === true, supportsAlpha: item.supportsAlpha === true,
          nativeOrientation: ['portrait', 'landscape', 'square'].includes(item.nativeOrientation || '') ? item.nativeOrientation : 'unknown',
          assetVersion: 1, capabilities, referenceMaterialIds,
          ...accountIdentity,
          ...(declaration ? { authorizationConfirmation: declaration } : {}),
          ...(rightsEvidence ? { rightsEvidence: structuredClone(rightsEvidence) } : {}),
          ...(certification ? { arkCertification: { projectName: String(certification.projectName || 'default').slice(0, 100), groupId: String(certification.groupId || '').slice(0, 200), assetUri,
            assetType: certification.assetType === 'image' || certification.assetType === 'video' ? certification.assetType : '',
            status: ['profile_incomplete','authorization_pending','ark_pending','processing','active','failed','disabled'].includes(assetStatus) ? assetStatus as NonNullable<PresenterAsset['arkCertification']>['status'] : 'ark_pending',
            materialId: String(certification.materialId || '').slice(0, 200), syncedAt: certification.syncedAt ? String(certification.syncedAt) : undefined,
            failureReason: certification.failureReason ? String(certification.failureReason).slice(0, 500) : undefined,
            verificationSource: certification.verificationSource === 'ark_api' || certification.verificationSource === 'manual_console' ? certification.verificationSource : undefined,
            ...(certification.manualConfirmation ? { manualConfirmation: {
              imageTypeConfirmed: certification.manualConfirmation.imageTypeConfirmed === true,
              activeConfirmed: certification.manualConfirmation.activeConfirmed === true,
              samePersonConfirmed: certification.manualConfirmation.samePersonConfirmed === true,
              confirmedAt: String(certification.manualConfirmation.confirmedAt || ''),
            } } : {}) } } : {}),
          toolMappings: { ...(voiceId ? { heygen: { avatarId, voiceId } } : {}),
            ...(referenceMaterialIds.length ? { runway: { referenceMaterialIds }, sd: { referenceMaterialIds }, seedance: { referenceMaterialIds } } : {}) },
        };
        const old = previous.find(value => value.id === normalized.id);
        normalized.assetVersion = old ? Math.max(1, old.assetVersion || 1) + (presenterAssetFingerprint(old) === presenterAssetFingerprint(normalized) ? 0 : 1) : 1;
        return normalized;
      }) };
        const saved = existing ? await store.update('studio_production_defaults', existing.id, { payload: next }) : await store.create('studio_production_defaults', { tenant_id: tenantId, payload: next });
        if (!saved) throw new Error('storage');
        if (options.bindArkAsset) for (const presenter of next.presenters) if (presenter.arkCertification?.materialId) await options.bindArkAsset({ tenantId, presenterId: presenter.id, certification: presenter.arkCertification });
        return next;
      });
      res.json(payload);
    } catch (error) { const message = error instanceof Error ? error.message : '企业出镜设置保存失败'; res.status(message === 'storage' ? 503 : 400).json({ error: message === 'storage' ? '企业出镜设置保存失败' : message }); }
  });
  router.post('/presenters/ark-status', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string; const assetUri = String(req.body?.assetUri || '').trim();
      const match = /^asset:\/\/(asset-[a-z0-9-]+)$/i.exec(assetUri); if (!match) throw new Error('请输入有效的方舟 asset:// 图片资产 ID');
      if (!options.verifyArkAsset) { res.status(409).json({ error: '当前套餐未配置 Assets API 只读查询；请在方舟控制台确认状态为 Active 后选择“控制台人工确认”' }); return; }
      const groupId = String(req.body?.groupId || '').trim();
      if (!/^group-[a-z0-9-]+$/i.test(groupId)) throw new Error('请先关联有效的方舟人物资产组');
      const result = await options.verifyArkAsset({ tenantId, projectName: String(req.body?.projectName || 'default').trim() || 'default', groupId, assetId: match[1] });
      res.json({ ...result, assetUri, syncedAt: new Date().toISOString(), verificationSource: 'ark_api' });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '方舟资产状态查询失败' }); }
  });
  registerProductionJobRoutes(router, store, importVideo, { exclusive, enabled, client, executableReferenceAdapters, referenceBudgetLimitCny, releaseReferenceReservation, assertAttemptAvailable, readDefaults, persistPlan, submitSentenceReplication }, options);
  return router;
}
