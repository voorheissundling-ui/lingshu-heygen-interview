import { randomUUID } from 'node:crypto';
import type { Router } from 'express';
import { studioPaidBudget } from '../lib/studioPaidBudget.js';
import { resolveHeyGenPresenterPhoto } from '../lib/heygenPresenterPhoto.js';
import { validateHeyGenPresenterRecord } from '../lib/presenterAssetTrust.js';
import { digitalHumanRouteSteps, planDigitalHumanShot, routeStepsForExecution, usesDirectReferenceVideo, candidateToolsFor, type DigitalHumanExecutionRecord, type DigitalHumanPlanRecord, type SentenceReplicationResult } from '../../src/lib/digitalHumanPlan.js';
import { initialDigitalHumanQuality, recordDigitalHumanMediaCheck, recordModelQualityChecks, recordReferenceTechnicalChecks, recordReferenceVisualChecks, deferUnavailableVisualChecksToManual } from '../../src/lib/digitalHumanQuality.js';
import { presenterCapabilities, presenterProductionGate, shotFingerprint, type AvatarJob, type ProductionDefaults, type ShotProduction } from '../../src/lib/shotProduction.js';
import { mapNarrationCues, narrationFromDetail } from '../../src/lib/narrationAlignment.js';
import { isDefinitiveSupplierSubmissionError, requiredReferencePreservation, selectReferenceAdapter, verifiedSupplierCost, type DigitalHumanExecutionAdapter } from '../lib/digitalHumanProviderRegistry.js';
import { batchShotRequestId, planStudioBatchShotRoutes, uniqueAuthorizedSalesPresenter } from './studioBatchShotRoutes.js';
import { effectiveDigitalHumanRequirements } from '../../shared/contracts/digitalHumanRequirements.js';
import { materialIdentityEvidenceForTenant, presenterTrustReasonsForDisplay } from './productionRouteEvidence.js';
import { candidateOutputFromImport } from './productionRuntime.js';
import type { createProductionRuntime, createProductionStoreRuntime } from './productionRuntime.js';
import type { DataStore } from '../storage/datastore.js';
import type { HeyGenInput } from '../lib/heygen.js';
import type { ExecutionStoreRecord, ImportedVideoResult, JobRecord, PlanStoreRecord, ProductionRouterOptions } from './productionContracts.js';

type ProductionJobRuntime = Pick<ReturnType<typeof createProductionRuntime>,
  'exclusive' | 'enabled' | 'client' | 'executableReferenceAdapters' | 'referenceBudgetLimitCny' | 'releaseReferenceReservation'>
  & Pick<ReturnType<typeof createProductionStoreRuntime>, 'assertAttemptAvailable' | 'readDefaults'>
  & { persistPlan: (input: { tenantId: string; project: any; assemblyId: string; shotId: string; fingerprint: string;
      origin?: 'manual' | 'content_agent'; sourceTaskId?: string; sourceTaskVersion?: string }) => Promise<DigitalHumanPlanRecord>;
    submitSentenceReplication: (tenantId: string, input: { projectId: string; assemblyId: string; shotId: string; fingerprint: string; requestId: string; maxCostCny?: number },
      resumeJobId?: string, reprocessJobId?: string) => Promise<SentenceReplicationResult> };

export function registerProductionJobRoutes(
  router: Router,
  store: DataStore,
  importVideo: (url: string, duration: number, job: AvatarJob, input: HeyGenInput, tenantId: string) => Promise<string | ImportedVideoResult>,
  { exclusive, enabled, client, executableReferenceAdapters, referenceBudgetLimitCny, releaseReferenceReservation,
    assertAttemptAvailable, readDefaults, persistPlan, submitSentenceReplication }: ProductionJobRuntime,
  options: ProductionRouterOptions,
): void {
  router.get('/jobs', async (req, res) => {
    try {
      const result = await store.list<JobRecord>('studio_avatar_jobs', { where: { tenant_id: res.locals.tenantId, project_id: String(req.query.projectId || '') }, perPage: 500 });
      res.json(result.items.filter(item => item.tenant_id === res.locals.tenantId).map(item => ({ ...item.payload, id: item.id })));
    } catch { res.status(503).json({ error: '镜头任务读取失败' }); }
  });
  const update = async (record: JobRecord, patch: Partial<AvatarJob>): Promise<AvatarJob> => {
    const payload = { ...record.payload, id: record.id, ...patch, updatedAt: new Date().toISOString() };
    if (!await store.update('studio_avatar_jobs', record.id, { payload })) throw new Error('镜头任务状态保存失败，请刷新原任务；不要重复提交');
    record.payload = payload; return payload;
  };
  const readExecution = async (jobId: string) => (await store.list<ExecutionStoreRecord>('studio_digital_human_executions', { where: { job_id: jobId }, perPage: 1 })).items[0];
  const updateExecution = async (jobId: string, patch: Partial<DigitalHumanExecutionRecord>) => {
    const record = await readExecution(jobId);
    if (!record) throw new Error('数字人执行记录缺失，请勿重复提交');
    let payload = { ...record.payload, id: record.id, ...patch, updatedAt: new Date().toISOString() };
    if (payload.routeSteps) payload = { ...payload, routeSteps: routeStepsForExecution(payload.routeSteps, payload.state, payload.quality, Boolean(payload.adoption)) };
    if (!await store.update('studio_digital_human_executions', record.id, { payload })) throw new Error('数字人执行状态保存失败，请刷新原任务；不要重复提交');
    return payload;
  };
  const latestRevisionFeedback = async (tenantId: string, projectId: string, assemblyId: string, shotId: string, fingerprint: string, presenterAssetVersion: number) => {
    const result = await store.list<ExecutionStoreRecord>('studio_digital_human_executions', { where: { tenant_id: tenantId, project_id: projectId }, perPage: 500 });
    return result.items.filter(item => item.payload.assemblyId === assemblyId && item.payload.shotId === shotId && item.payload.fingerprint === fingerprint
      && item.payload.presenterAssetVersion === presenterAssetVersion && item.payload.quality.state === 'failed' && item.payload.quality.reviewNote)
      .sort((a, b) => b.payload.updatedAt.localeCompare(a.payload.updatedAt))[0]?.payload.quality.reviewNote || null;
  };
  const submitRemote = async (record: JobRecord) => {
    try {
      if (record.input.audioRef && !record.input.audioAssetId) {
        if (!options.prepareAudio) throw new Error('统一旁白分段服务不可用');
        const prepared = await options.prepareAudio(record.input.audioRef, record.tenant_id);
        const audio = prepared instanceof Uint8Array ? prepared : prepared.bytes;
        const audioAssetId = await client().uploadAudio(audio, `${record.request_id}:audio`);
        const input = { ...record.input, audioAssetId, voiceId: '', script: '' };
        if (!await store.update('studio_avatar_jobs', record.id, { input })) throw new Error('音频资产绑定保存失败');
        record.input = input;
        if (!(prepared instanceof Uint8Array)) {
          const execution = await readExecution(record.id);
          if (!execution) throw new Error('数字人执行记录缺失，请勿重复提交');
          await updateExecution(record.id, { inputSnapshot: execution.payload.inputSnapshot ? { ...execution.payload.inputSnapshot, audioSegment: {
            segmentId: prepared.segmentId, checksumSha256: prepared.checksumSha256, start: prepared.start, duration: prepared.duration,
          } } : execution.payload.inputSnapshot });
        }
      }
      const remoteId = await client().create(record.input, record.request_id);
      const job = await update(record, { remoteId, status: 'pending', error: '' });
      await updateExecution(record.id, { externalTaskId: remoteId, submissionOutcome: 'created', state: 'pending', error: '' });
      return job;
    } catch (error) {
      const message = error instanceof Error ? error.message : '供应商提交结果待核实';
      const job = await update(record, { status: 'uncertain', error: message });
      await updateExecution(record.id, { state: 'uncertain', error: message });
      return job;
    }
  };
  const submitTalkingJob = async (tenantId: string, b: any): Promise<AvatarJob> => {
    return exclusive(`submit:${tenantId}`, async () => {
        const existing = (await store.list<JobRecord>('studio_avatar_jobs', { where: { tenant_id: tenantId, request_id: `${tenantId}:${b.requestId}` }, perPage: 1 })).items[0];
        if (existing) return { ...existing.payload, id: existing.id };
        const project = await store.getById<any>('studio_projects', String(b.projectId || ''));
        if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
        const pendingJobs = await store.list<JobRecord>('studio_avatar_jobs', { where: { tenant_id: tenantId, project_id: project.id }, perPage: 500 });
        if (pendingJobs.items.some(item => item.payload.assemblyId === b.assemblyId && item.payload.shotId === b.shotId && item.payload.fingerprint === b.fingerprint && ['submitting', 'pending', 'uncertain'].includes(item.payload.status))) throw new Error('该镜头已有未结束任务，请刷新原任务，不重复提交');
        const shot = project.spec?.shotProductions?.[`${b.assemblyId}:${b.shotId}`] as ShotProduction | undefined;
        const context = project.spec?.shotProductionContext;
        if (!shot) throw new Error('草稿中未找到当前镜头，请重新打开分镜');
        if (shot.source !== 'avatar') throw new Error('当前镜头尚未保存为数字人来源');
        if (shot.locked) throw new Error('当前镜头已锁定，请先解锁');
        if (shotFingerprint(shot, String(context || ''), String(b.shotId || '')) !== b.fingerprint) throw new Error('数字人参数与已保存草稿不一致，请保存后重试');
        const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
        const presenter = defaults?.presenters.find(item => item.id === shot.presenterId && item.authorized);
        if (!presenter) throw new Error('请先保存已授权的人物与声音资产');
        const presenterTrust = validateHeyGenPresenterRecord(presenter);
        if (!presenterTrust.ok) throw new Error(`HeyGen 人物、音色或授权预检未通过：${presenterTrustReasonsForDisplay(presenterTrust.reasons).join('、')}`);
        const requirements = effectiveDigitalHumanRequirements(shot.digitalHuman);
        const plan = planDigitalHumanShot({ requirements, narration: shot.narration, hasAuthorizedPresenter: Boolean(presenter), talkingAvailable: enabled(), presenterCapabilities: presenter ? presenterCapabilities(presenter) : undefined });
        if (!plan.executable) throw new Error(plan.reasons.join('；'));
        if (shot.layout === 'pip' && !shot.transparent) throw new Error('数字人画中画需要去背景的透明人物层；请先核验透明支持，或改用全屏普通混剪');
        if (requirements?.presenterMode !== 'photo_talking' && b.ratio === '9:16' && !shot.transparent && presenter.nativeOrientation !== 'portrait') throw new Error('竖屏生成前须在人物资产中核验原生竖屏画幅；横屏或未知人物可能产生大面积留白，已阻止付费提交');
        if (shot.transparent && !presenter.supportsAlpha) throw new Error('该人物未确认支持透明视频，不能生成独立背景人物层');
        if (shot.backgroundMaterialId && shot.backgroundMode === 'baked') throw new Error('首版只支持独立背景合成，请改用透明人物层；不将新背景参数静默忽略');
        if (!shot.narration.trim() || shot.narration.length > 5000 || !['9:16', '16:9', '1:1'].includes(b.ratio) || b.ratio !== project.spec.ratio) throw new Error('台词或画幅无效，请先保存当前草稿');
        const now = new Date().toISOString();
        const input: HeyGenInput = { avatarId: presenter.avatarId, voiceId: presenter.voiceId, script: shot.narration, ratio: b.ratio, transparent: shot.transparent, title: `灵枢镜头 ${b.shotId}` };
        if (requirements?.presenterMode === 'photo_talking') {
          const photo = await resolveHeyGenPresenterPhoto(tenantId, presenter);
          input.imageAssetId = await client().uploadImage(photo.bytes, photo.mimeType, `${tenantId}:${b.requestId}:photo`);
          input.avatarId = '';
        }
        if (shot.sound === 'voiceover') {
          const language = project.spec.activeVoiceLang || project.spec.lang;
          const audio = project.spec.voiceoverAudios?.[language];
          const audioUrl = project.spec.voiceoverMode === 'ai' ? audio?.url : project.spec.voiceoverUrl;
          if (!audioUrl) throw new Error('请先生成或上传并确认统一旁白，再用其驱动数字人');
          const slots = project.spec.shootingSlots || []; const slotIndex = slots.findIndex((item: any) => item.id === b.shotId);
          if (slotIndex < 0) throw new Error('未找到镜头音频区间');
          const ranges = mapNarrationCues(slots.map((item: any) => project.spec.shotProductions?.[`${b.assemblyId}:${item.id}`]?.narration ?? narrationFromDetail(item.detail)),
            project.spec.alignedCuesByLang?.[language] || audio?.cues || [],
            project.spec.voiceoverMode === 'ai' ? audio?.duration : project.spec.voiceoverDur, audio?.alignmentSource);
          const range = ranges[slotIndex];
          if (!range) throw new Error('该镜头没有已对齐的口播，不提交数字人生成');
          if (range.end - range.start > slots[slotIndex].duration + 0.01) throw new Error('台词超过镜头时长，请先延长镜头');
          input.audioRef = { url: audioUrl, start: range.start, duration: range.end - range.start };
        }
        const payload: AvatarJob = { id: '', projectId: project.id, shotId: String(b.shotId), assemblyId: String(b.assemblyId), fingerprint: b.fingerprint, status: 'submitting', createdAt: now, updatedAt: now };
        const savedPlan = (await store.list<PlanStoreRecord>('studio_digital_human_plans', { where: { tenant_id: tenantId, project_id: project.id, shot_key: `${b.assemblyId}:${b.shotId}`, fingerprint: b.fingerprint }, perPage: 500 })).items
          .find(item => item.payload.presenterAssetVersion === Math.max(1, presenter.assetVersion || 1));
        if (!savedPlan || !savedPlan.payload.executable || savedPlan.payload.provider !== 'heygen') throw new Error('请先保存当前分镜的可执行制作方案');
        await assertAttemptAvailable({ tenantId, projectId: project.id, assemblyId: String(b.assemblyId), shotId: String(b.shotId), fingerprint: b.fingerprint,
          presenterAssetVersion: savedPlan.payload.presenterAssetVersion });
        await (options.reserve || (id => studioPaidBudget.reserve('heygen', id, undefined, tenantId)))(`${tenantId}:${b.requestId}`);
        const record = await store.create<JobRecord>('studio_avatar_jobs', { tenant_id: tenantId, project_id: project.id, request_id: `${tenantId}:${b.requestId}`, payload, input });
        if (!record) throw new Error('任务存储不可用，未发起付费生成');
        const quality = initialDigitalHumanQuality(requirements, now);
        const execution: DigitalHumanExecutionRecord = { id: '', planId: savedPlan.id, jobId: record.id, projectId: project.id,
          assemblyId: String(b.assemblyId), shotId: String(b.shotId), fingerprint: b.fingerprint, tool: 'heygen', provider: 'heygen', model: null,
          presenterAssetVersion: savedPlan.payload.presenterAssetVersion, submissionOutcome: 'unknown', inputSnapshot: savedPlan.payload.inputSnapshot ? { ...savedPlan.payload.inputSnapshot,
            revisionFeedback: await latestRevisionFeedback(tenantId, project.id, String(b.assemblyId), String(b.shotId), b.fingerprint, savedPlan.payload.presenterAssetVersion) } : undefined,
          state: 'submitting', externalTaskId: null, materialId: null,
          estimatedCostCny: savedPlan.payload.estimatedCostCny, actualCostCny: null, costStatus: 'estimated', costSourceRef: null, error: '',
          quality, routeSteps: routeStepsForExecution(savedPlan.payload.routeSteps || digitalHumanRouteSteps('talking', 'heygen', true), 'submitting', quality), createdAt: now, updatedAt: now };
        const executionRecord = await store.create<ExecutionStoreRecord>('studio_digital_human_executions', { tenant_id: tenantId, project_id: project.id, job_id: record.id, plan_id: savedPlan.id, payload: execution });
        if (!executionRecord) {
          await store.delete('studio_avatar_jobs', record.id).catch(() => false);
          throw new Error('执行记录存储不可用，未发起付费生成');
        }
        return submitRemote(record);
      });
  };
  router.post('/jobs', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const b = req.body || {};
      if (!enabled()) { res.status(503).json({ error: '数字人服务尚未配置或启用' }); return; }
      if (b.confirmed !== true || !/^[A-Za-z0-9_:.-]{1,150}$/.test(String(b.requestId || ''))) { res.status(400).json({ error: '请确认本镜头生成及供应商计费，并提供有效请求标识' }); return; }
      const job = await submitTalkingJob(tenantId, b);
      res.json(job);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '生成提交失败' }); }
  });
  router.post('/batch-shot-jobs', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const projectId = String(req.body?.projectId || '');
      const batchId = String(req.body?.batchId || '');
      if (req.body?.confirmed !== true || !/^[A-Za-z0-9_:.-]{1,100}$/.test(batchId))
        throw new Error('请确认批量生成及供应商计费，并提供稳定批次标识');
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
      let routes = planStudioBatchShotRoutes(project.spec ?? {}, {
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
      if (req.body.slotIds !== undefined) {
        if (!Array.isArray(req.body.slotIds) || !req.body.slotIds.length || req.body.slotIds.length > 100 || req.body.slotIds.some((id: unknown) => typeof id !== 'string')) throw new Error('请选择有效的分镜');
        const selected = new Set<string>(req.body.slotIds);
        if ([...selected].some(id => !routes.some(route => route.slotId === id))) throw new Error('所选分镜不属于当前草稿');
        routes = routes.filter(route => selected.has(route.slotId));
      }
      if (!routes.length || routes.length > 100) throw new Error('批量分镜数量必须为 1–100');
      const assemblyId = String(project.spec?.activeAssemblyId || '');
      const identities = new Map<string, string>();
      for (const slot of project.spec?.shootingSlots || []) {
        const sourcePerson = String(slot.personContinuityId || '').trim();
        if (!sourcePerson) continue;
        const route = routes.find(item => item.shotId === slot.id);
        if (!route || route.route === 'local_material') continue;
        const target = project.spec?.shotProductions?.[`${assemblyId}:${slot.id}`]?.presenterId;
        if (!target) continue;
        if (identities.has(sourcePerson) && identities.get(sourcePerson) !== target) throw new Error(`同一原片人物 ${sourcePerson} 选择了不同企业数字人，请在工作面板统一人物后再批量制作`);
        identities.set(sourcePerson, target);
      }
      const results: Array<{ shotId: string; slotId: string; state: 'submitted' | 'matched' | 'needs_material' | 'blocked'; jobId: string | null; reason: string }> = [];
      for (const route of routes) {
        if (route.route === 'local_material') {
          results.push({ shotId: route.shotId, slotId: route.slotId,
            state: route.status === 'matched' ? 'matched' : 'needs_material', jobId: null, reason: route.reason });
          continue;
        }
        if (route.route === 'aigc_first_frame') {
          results.push({ shotId: route.shotId, slotId: route.slotId,
            state: 'blocked', jobId: null, reason: route.reason });
          continue;
        }
        const configuredShot = project.spec?.shotProductions?.[`${assemblyId}:${route.shotId}`] as ShotProduction | undefined;
        const configuredRequirements = effectiveDigitalHumanRequirements(configuredShot?.digitalHuman);
        if (configuredRequirements?.method === 'reenact' && route.visualTopic === 'presenter') {
          try {
            if (!configuredShot) throw new Error('草稿中未找到当前分镜，请重新打开分镜');
            if (configuredShot.locked) throw new Error('镜头已锁定，请先解锁');
            const fingerprint = shotFingerprint(configuredShot, String(project.spec?.shotProductionContext || ''), route.shotId);
            const requestId = batchShotRequestId({ projectId, batchId, assemblyId, shotId: route.shotId, fingerprint });
            const generated = await submitSentenceReplication(tenantId, { projectId, assemblyId, shotId: route.shotId, fingerprint, requestId });
            results.push({ shotId: route.shotId, slotId: route.slotId, state: 'submitted', jobId: generated.sentenceJobId || null, reason: '场景重建候选已生成，等待逐镜验收' });
          } catch (error) {
            results.push({ shotId: route.shotId, slotId: route.slotId, state: 'blocked', jobId: null, reason: error instanceof Error ? error.message : '场景重建失败' });
          }
          continue;
        }
        if (route.route !== 'digital_human' || route.status === 'blocked') {
          results.push({ shotId: route.shotId, slotId: route.slotId, state: 'blocked', jobId: null, reason: route.reason });
          continue;
        }
        let shot = project.spec?.shotProductions?.[`${assemblyId}:${route.shotId}`] as ShotProduction | undefined;
        if (!shot || shot.locked) {
          results.push({ shotId: route.shotId, slotId: route.slotId, state: 'blocked', jobId: null,
            reason: '人物口播镜头不存在或已锁定，未提交供应商' });
          continue;
        }
        if (!shot.presenterId) {
          results.push({ shotId: route.shotId, slotId: route.slotId, state: 'blocked', jobId: null,
            reason: '企业出镜设置中没有唯一且已授权的“销售”人物资产' });
          continue;
        }
        const fingerprint = shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), route.shotId);
        try {
          const plan = await persistPlan({ tenantId, project, assemblyId, shotId: route.shotId, fingerprint });
          if (!plan.executable || plan.provider !== 'heygen') throw new Error(plan.reasons.join('；') || '数字人口播执行器尚未就绪');
          // The single-shot submitter owns reservation, persisted execution,
          // supplier idempotency, and uncertain-outcome handling. Batch mode
          // only supplies a stable per-shot request ID; it never skips checks.
          const requestId = batchShotRequestId({ projectId, batchId, assemblyId, shotId: route.shotId, fingerprint });
          const job = await submitTalkingJob(tenantId, { projectId, assemblyId, shotId: route.shotId,
            fingerprint, ratio: project.spec?.ratio, requestId });
          results.push({ shotId: route.shotId, slotId: route.slotId, state: 'submitted', jobId: job.id,
            reason: job.status === 'uncertain' ? '供应商提交结果待核实；请刷新原任务，勿重复提交' : `供应商任务状态：${job.status}` });
        } catch (error) {
          results.push({ shotId: route.shotId, slotId: route.slotId, state: 'blocked', jobId: null,
            reason: error instanceof Error ? error.message : '本镜提交失败' });
        }
      }
      res.json({ projectId, batchId, results, counts: {
        submitted: results.filter(item => item.state === 'submitted').length,
        matched: results.filter(item => item.state === 'matched').length,
        needsMaterial: results.filter(item => item.state === 'needs_material').length,
        blocked: results.filter(item => item.state === 'blocked').length,
      } });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '批量分镜生成失败' }); }
  });
  router.post('/jobs/:id/refresh', async (req, res) => {
    try {
      const job = await exclusive(`job:${req.params.id}`, async () => {
        const record = await store.getById<JobRecord>('studio_avatar_jobs', req.params.id);
        if (!record || record.tenant_id !== res.locals.tenantId) throw new Error('镜头任务不存在');
        if (record.payload.status === 'completed' || record.payload.status === 'failed') return { ...record.payload, id: record.id };
        if (!record.payload.remoteId) {
          throw new Error('提交结果未知：刷新不会再次付费生成。请管理员核对供应商任务和账单；不要创建新请求重试');
        }
        const remote = await client().status(record.payload.remoteId);
        if (remote.status === 'completed') {
          try {
            const imported = await importVideo(remote.url!, remote.duration!, { ...record.payload, id: record.id }, record.input, record.tenant_id);
            const materialId = typeof imported === 'string' ? imported : imported.materialId;
            const candidateOutput = typeof imported === 'string' ? undefined : candidateOutputFromImport(imported);
            if (!candidateOutput) throw new Error('新候选缺少可复核的存储引用、内容 SHA-256 或对象版本，不能进入人工验收');
            const job = await update(record, { status: 'completed', materialId, error: '' });
            const execution = await readExecution(record.id);
            if (!execution) throw new Error('数字人执行记录缺失，请勿重复提交');
            await updateExecution(record.id, { state: 'completed', materialId, ...(candidateOutput ? { candidateOutput } : {}), costStatus: 'awaiting_invoice', error: '',
              quality: recordDigitalHumanMediaCheck(execution.payload.quality, { passed: true, evidence: `material:${materialId}` }) });
            return job;
          } catch (error) {
            const message = `供应商已生成，但下载或技术检查未通过：${error instanceof Error ? error.message : '导入失败'}。刷新仅复查原任务，不重新生成。`;
            const job = await update(record, { status: 'pending', error: message });
            const execution = await readExecution(record.id);
            if (!execution) throw new Error('数字人执行记录缺失，请勿重复提交');
            await updateExecution(record.id, { state: 'pending', error: message,
              quality: recordDigitalHumanMediaCheck(execution.payload.quality, { passed: false, evidence: message }) });
            return job;
          }
        }
        const job = await update(record, { status: remote.status, error: remote.error || '' });
        await updateExecution(record.id, { state: remote.status, error: remote.error || '' });
        return job;
      });
      res.json(job);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '镜头状态刷新失败' }); }
  });

  router.post('/reference-jobs', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string; const b = req.body || {};
      if (b.confirmed !== true || !/^[A-Za-z0-9_:.-]{1,150}$/.test(String(b.requestId || ''))) throw new Error('请确认本镜头生成及供应商计费，并提供有效请求标识');
      const execution = await exclusive(`reference-submit:${tenantId}`, async () => {
        const requestId = `${tenantId}:${b.requestId}`;
        const existing = (await store.list<ExecutionStoreRecord>('studio_digital_human_executions', { where: { tenant_id: tenantId, request_id: requestId }, perPage: 1 })).items[0];
        if (existing) return { ...existing.payload, id: existing.id };
        const project = await store.getById<any>('studio_projects', String(b.projectId || ''));
        if (!project || project.tenant_id !== tenantId || project.status !== 'draft') throw new Error('创作草稿不存在或不可编辑');
        const shot = project.spec?.shotProductions?.[`${b.assemblyId}:${b.shotId}`] as ShotProduction | undefined;
        if (!shot || shot.source !== 'avatar' || shot.locked) throw new Error('当前数字人分镜不存在或已锁定');
        if (shotFingerprint(shot, String(project.spec?.shotProductionContext || ''), String(b.shotId || '')) !== b.fingerprint) throw new Error('数字人参数与已保存草稿不一致，请保存后重试');
        const requirements = effectiveDigitalHumanRequirements(shot.digitalHuman);
        if (!requirements || requirements.method === 'talking') throw new Error('人物口播请使用口播生成任务');
        const defaults = (await readDefaults(tenantId))?.payload as ProductionDefaults | undefined;
        const presenter = defaults?.presenters.find(item => item.id === shot.presenterId && item.authorized);
        if (!presenter || !presenterCapabilities(presenter).some(value => ['reference_image', 'reference_video', 'person_replacement'].includes(value))) throw new Error('请先保存已授权的人物参考资产');
        const savedPlan = (await store.list<PlanStoreRecord>('studio_digital_human_plans', { where: { tenant_id: tenantId, project_id: project.id, shot_key: `${b.assemblyId}:${b.shotId}`, fingerprint: b.fingerprint }, perPage: 500 })).items
          .find(item => item.payload.presenterAssetVersion === Math.max(1, presenter.assetVersion || 1));
        if (!savedPlan?.payload.executable || !savedPlan.payload.provider || savedPlan.payload.provider === 'heygen') throw new Error('请先保存当前分镜的可执行参考人物制作方案');
        if (requirements.method === 'replace' && (!savedPlan.payload.inputSnapshot?.derivativeAuthorization?.evidence || !savedPlan.payload.inputSnapshot.derivativeAuthorization.confirmedAt)) {
          throw new Error('当前人物替换方案缺少服务端固化的源视频派生授权依据，请重新确认并保存方案');
        }
        if (usesDirectReferenceVideo(requirements) && (!savedPlan.payload.inputSnapshot?.modelInputAuthorization?.evidence || !savedPlan.payload.inputSnapshot.modelInputAuthorization.confirmedAt)) {
          throw new Error('当前参考人物方案缺少服务端固化的源视频模型输入授权依据，不能提交给生成供应商');
        }
        if (!usesDirectReferenceVideo(requirements)) throw new Error('逐句首帧重建必须由分句编排器执行，不能把整段爆款原片提交给参考视频适配器');
        const existingExecutions = await store.list<ExecutionStoreRecord>('studio_digital_human_executions', { where: { tenant_id: tenantId, project_id: project.id }, perPage: 500 });
        if (existingExecutions.items.some(item => item.payload.assemblyId === String(b.assemblyId) && item.payload.shotId === String(b.shotId)
          && item.payload.fingerprint === b.fingerprint && item.payload.presenterAssetVersion === savedPlan.payload.presenterAssetVersion
          && ['submitting', 'pending', 'uncertain'].includes(item.payload.state))) {
          throw new Error('该镜头已有未结束的参考人物任务，请刷新或取消原任务，不重复提交');
        }
        await assertAttemptAvailable({ tenantId, projectId: project.id, assemblyId: String(b.assemblyId), shotId: String(b.shotId), fingerprint: b.fingerprint,
          presenterAssetVersion: savedPlan.payload.presenterAssetVersion });
        const slot = (Array.isArray(project.spec?.shootingSlots) ? project.spec.shootingSlots : []).find((item: any) => String(item.id) === String(b.shotId));
        const selection = selectReferenceAdapter({ adapters: executableReferenceAdapters(tenantId), candidates: candidateToolsFor(requirements), method: requirements.method,
          targetDurationSeconds: Number(slot?.duration) || null,
          maxEstimatedCostCny: referenceBudgetLimitCny(tenantId),
          requiredPreservation: requiredReferencePreservation({ preserve: requirements.preserve, productMaterialId: shot.productMaterialId, backgroundMaterialId: shot.backgroundMaterialId }) });
        const adapter = selection.adapter;
        if (!adapter || adapter.id !== savedPlan.payload.provider) throw new Error(selection.reason || '制作方案对应的参考人物执行适配器当前不可用或能力已变化，请重新保存方案');
        const resolvedInputs = await options.resolveReferenceInputs!({ shot, presenter, tenantId });
        const ratio = ({ '9:16': '720:1280', '16:9': '1280:720', '1:1': '960:960' } as const)[String(project.spec?.ratio || '') as '9:16' | '16:9' | '1:1'];
        if (!ratio) throw new Error('当前画幅不受参考人物适配器支持');
        await options.reserveReference!(adapter.id, requestId, selection.estimatedCostCny, tenantId);
        const now = new Date().toISOString(); const jobId = `reference:${randomUUID()}`;
        const revisionFeedback = await latestRevisionFeedback(tenantId, project.id, String(b.assemblyId), String(b.shotId), b.fingerprint, savedPlan.payload.presenterAssetVersion);
        const quality = initialDigitalHumanQuality(requirements, now);
        const payload: DigitalHumanExecutionRecord = { id: '', planId: savedPlan.id, jobId, projectId: project.id,
          assemblyId: String(b.assemblyId), shotId: String(b.shotId), fingerprint: b.fingerprint, tool: adapter.id, provider: adapter.id, model: null,
          presenterAssetVersion: savedPlan.payload.presenterAssetVersion, submissionOutcome: 'unknown', inputSnapshot: savedPlan.payload.inputSnapshot ? { ...savedPlan.payload.inputSnapshot, revisionFeedback,
            ...(resolvedInputs.characterMaterialId && resolvedInputs.characterObjectKey ? { presenterInput: {
              materialId: resolvedInputs.characterMaterialId, objectKey: resolvedInputs.characterObjectKey, type: resolvedInputs.characterType, objectEtag: resolvedInputs.characterObjectEtag,
            } } : {}),
            ...(resolvedInputs.referenceClipKey && resolvedInputs.referenceMaterialId && resolvedInputs.referenceStart != null && resolvedInputs.referenceDuration != null ? { referenceInput: {
              materialId: resolvedInputs.referenceMaterialId, clipObjectKey: resolvedInputs.referenceClipKey, start: resolvedInputs.referenceStart, duration: resolvedInputs.referenceDuration,
              sourceObjectEtag: resolvedInputs.referenceSourceObjectEtag, clipObjectEtag: resolvedInputs.referenceClipObjectEtag,
            } } : {}) } : undefined,
          state: 'submitting', externalTaskId: null, materialId: null,
          estimatedCostCny: savedPlan.payload.estimatedCostCny, actualCostCny: null, costStatus: 'estimated', costSourceRef: null, error: '',
          quality, routeSteps: routeStepsForExecution(savedPlan.payload.routeSteps || digitalHumanRouteSteps(requirements.method, adapter.id, true), 'submitting', quality), createdAt: now, updatedAt: now };
        let record: ExecutionStoreRecord | null;
        try {
          record = await store.create<ExecutionStoreRecord>('studio_digital_human_executions', { tenant_id: tenantId, project_id: project.id, job_id: jobId, plan_id: savedPlan.id, request_id: requestId, payload });
          if (!record) throw new Error('执行记录存储不可用，未发起供应商生成');
        } catch (error) {
          const releaseError = await releaseReferenceReservation(adapter.id, requestId, tenantId);
          const message = error instanceof Error ? error.message : '执行记录存储不可用，未发起供应商生成';
          throw new Error(releaseError ? `${message}；${releaseError}` : message);
        }
        try {
          const submitted = await adapter.submit({ projectId: project.id, assemblyId: b.assemblyId, shotId: b.shotId, shot, presenter, revisionFeedback, ...resolvedInputs,
          ratio, targetDurationSeconds: Number(slot?.duration) || null, bodyControl: true, expressionIntensity: 3 }, requestId);
          const next = { ...payload, id: record.id, externalTaskId: submitted.externalTaskId, submissionOutcome: 'created' as const, state: 'pending' as const,
            routeSteps: payload.routeSteps ? routeStepsForExecution(payload.routeSteps, 'pending', payload.quality) : undefined, updatedAt: new Date().toISOString() };
          if (!await store.update('studio_digital_human_executions', record.id, { payload: next })) throw new Error('供应商任务已提交但状态保存失败，请核对原任务');
          return next;
        } catch (error) {
          const definitive = isDefinitiveSupplierSubmissionError(error);
          const releaseError = definitive ? await releaseReferenceReservation(adapter.id, requestId, tenantId) : '';
          const state = definitive ? 'failed' as const : 'uncertain' as const;
          const baseError = error instanceof Error ? error.message : '供应商提交结果待核实';
          const next = { ...payload, id: record.id, state, submissionOutcome: definitive ? 'rejected' as const : 'unknown' as const, error: releaseError ? `${baseError}；${releaseError}` : baseError,
            routeSteps: payload.routeSteps ? routeStepsForExecution(payload.routeSteps, state, payload.quality) : undefined, updatedAt: new Date().toISOString() };
          if (!await store.update('studio_digital_human_executions', record.id, { payload: next })) throw new Error('供应商提交结果无法写入执行记录，请核对原任务与预算账本');
          return next;
        }
      });
      res.json(execution);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '参考人物生成提交失败' }); }
  });

  router.post('/reference-jobs/:id/refresh', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const result = await exclusive(`reference-refresh:${req.params.id}`, async () => {
        const record = await store.getById<ExecutionStoreRecord>('studio_digital_human_executions', req.params.id);
        if (!record || record.tenant_id !== tenantId || record.payload.tool === 'heygen') throw new Error('参考人物执行记录不存在');
        if (['completed', 'failed'].includes(record.payload.state)) return { ...record.payload, id: record.id };
        if (!record.payload.externalTaskId) throw new Error('提交结果未知：刷新不会再次生成，请核对供应商任务和账单');
        const adapter = (options.adapters || []).find(item => item.id === record.payload.tool);
        if (!adapter) throw new Error('原执行适配器当前不可用，不能查询任务状态');
        let remote: Awaited<ReturnType<DigitalHumanExecutionAdapter['status']>>;
        try {
          remote = await adapter.status(record.payload.externalTaskId);
        } catch (error) {
          const message = `供应商状态查询失败：${error instanceof Error ? error.message : '未知错误'}。可稍后重查原任务，系统不会重新提交生成。`;
          const payload = { ...record.payload, id: record.id, error: message, updatedAt: new Date().toISOString() };
          if (!await store.update('studio_digital_human_executions', record.id, { payload })) throw new Error('供应商状态查询失败且执行记录更新失败');
          throw new Error(message);
        }
        let payload: DigitalHumanExecutionRecord = { ...record.payload, id: record.id, state: remote.state, error: remote.error || '', updatedAt: new Date().toISOString() };
        const supplierCost = verifiedSupplierCost(remote);
        if (supplierCost) payload = { ...payload, ...supplierCost, costStatus: 'reconciled' };
        if (remote.state === 'completed') {
          if ((!remote.outputUrl || !options.importReferenceVideo) && (!remote.outputObjectKey || !options.importReferenceObject)) throw new Error('供应商已完成，但参考视频导入服务不可用');
          try {
            const snapshot = payload.inputSnapshot;
            const requiresVersionCheck = Boolean(snapshot?.presenterInput?.objectEtag || snapshot?.referenceInput?.clipObjectEtag);
            if (requiresVersionCheck && (!snapshot || !options.verifyReferenceInputs || !await options.verifyReferenceInputs(snapshot, tenantId))) {
              throw new Error('当次人物或精确参考片段对象版本已变化，不能使用当前对象完成历史任务质检');
            }
            const imported = remote.outputObjectKey
              ? await options.importReferenceObject!(remote.outputObjectKey, payload, tenantId)
              : await options.importReferenceVideo!(remote.outputUrl!, payload, tenantId);
            let quality = recordDigitalHumanMediaCheck(payload.quality, { passed: true, evidence: `material:${imported.materialId}` });
            if (imported.technicalMetrics) quality = recordReferenceTechnicalChecks(quality, imported.technicalMetrics);
            if (imported.visualMetrics) quality = recordReferenceVisualChecks(quality, imported.visualMetrics);
            else quality = deferUnavailableVisualChecksToManual(quality);
            if (options.inspectReferenceQuality) {
              const referenceInput = payload.inputSnapshot?.referenceInput;
              const presenterInput = payload.inputSnapshot?.presenterInput;
              if (!referenceInput?.clipObjectKey || !referenceInput.materialId) throw new Error('模型质检缺少精确原片证据');
              if (!presenterInput?.materialId || !presenterInput.objectKey) throw new Error('身份质检缺少本次实际采用的企业人物资产证据');
              quality = recordModelQualityChecks(quality, await options.inspectReferenceQuality({
                referenceClipObjectKey: referenceInput.clipObjectKey,
                referenceMaterialId: referenceInput.materialId,
                presenterReferenceMaterialIds: [presenterInput.materialId],
                candidateMaterialId: imported.materialId,
                candidateVideoUrl: remote.outputUrl || '',
                execution: payload,
                tenantId,
              }));
            }
            const candidateOutput = candidateOutputFromImport(imported);
            if (!candidateOutput) throw new Error('新候选缺少可复核的存储引用、内容 SHA-256 或对象版本，不能进入人工验收');
            payload = { ...payload, materialId: imported.materialId, ...(candidateOutput ? { candidateOutput } : {}), costStatus: payload.costStatus === 'reconciled' ? 'reconciled' : 'awaiting_invoice', quality };
          } catch (error) {
            const message = `供应商已生成，但下载或技术检查未通过：${error instanceof Error ? error.message : '导入失败'}。刷新仅复查原任务，不重新生成。`;
            payload = { ...payload, state: 'pending', error: message, quality: recordDigitalHumanMediaCheck(payload.quality, { passed: false, evidence: message }) };
          }
        }
        if (payload.routeSteps) payload = { ...payload, routeSteps: routeStepsForExecution(payload.routeSteps, payload.state, payload.quality) };
        if (!await store.update('studio_digital_human_executions', record.id, { payload })) throw new Error('参考人物执行状态保存失败');
        return payload;
      });
      res.json(result);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '参考人物任务刷新失败' }); }
  });
  router.post('/reference-jobs/:id/cancel', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const payload = await exclusive(`reference-cancel:${req.params.id}`, async () => {
        const record = await store.getById<ExecutionStoreRecord>('studio_digital_human_executions', req.params.id);
        if (!record || record.tenant_id !== tenantId || record.payload.tool === 'heygen') throw new Error('参考人物执行记录不存在');
        if (record.payload.state === 'cancelled') return { ...record.payload, id: record.id };
        if (!['submitting', 'pending'].includes(record.payload.state) || !record.payload.externalTaskId) throw new Error('当前任务不能取消；提交结果未知或任务已结束时请核对供应商状态');
        const adapter = (options.adapters || []).find(item => item.id === record.payload.tool);
        if (!adapter?.cancel) throw new Error('当前执行工具未提供可核验的取消能力，不能只在本地标记取消');
        const cancelled = await adapter.cancel(record.payload.externalTaskId);
        if (!cancelled.cancelled) throw new Error(cancelled.reason || '供应商未确认取消，任务状态保持不变');
        const next: DigitalHumanExecutionRecord = { ...record.payload, id: record.id, state: 'cancelled', error: cancelled.reason || '',
          routeSteps: record.payload.routeSteps ? routeStepsForExecution(record.payload.routeSteps, 'cancelled', record.payload.quality) : undefined, updatedAt: new Date().toISOString() };
        if (!await store.update('studio_digital_human_executions', record.id, { payload: next })) throw new Error('取消结果保存失败，请核对供应商原任务');
        return next;
      });
      res.json(payload);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '参考人物任务取消失败' }); }
  });
}
