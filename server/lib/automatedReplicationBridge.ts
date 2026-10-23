import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import type { Router } from 'express';
import type { DataStore } from '../storage/datastore.js';
import { readLocalMaterials, type MaterialRecord } from './materialLibrary.js';
import { readTenantMaterialBytes } from './sentenceReplicationProduction.js';
import { shotFingerprint } from '../../src/lib/shotProduction.js';
import { digitalHumanQualityState } from '../../src/lib/digitalHumanQuality.js';
import { isTenantPrivateObjectKey } from '../storage/materialAssets.js';
import { tenantAssetDir } from './assetAccess.js';
import { matchReplicationMaterial } from './replicationMaterialMatching.js';
import { referenceCues } from '../../src/lib/digitalHumanPlan.js';
import { assertReferencePresenterComposition, type ReferencePresenterComposition } from '../digitalEmployees/referencePresenterComposite.js';
import { automaticManagedFallbackFrameAdmission, automaticManagedFallbackVideoAdmission } from './storyboardAigcQuality.js';
import { createControlledProductImageAnimation, type ControlledProductImageAnimationInput,
  type ControlledProductImageAnimationResult } from './controlledProductImageAnimation.js';
import { compareAndSwapStudioProject } from './studioProjectRevision.js';

export interface AutomatedReplicationShot {
  shotId: string; slotId: string; kind: 'person' | 'nonperson' | 'blocked'; start: number; end: number;
  required?: boolean; productionState?: 'ready' | 'blocked'; blockerCode?: string; blocker?: string;
  fingerprintContext?: string;
  referenceShotId?: string; referenceFirstFrameUrl?: string; referenceComposition?: ReferencePresenterComposition;
  firstFrameRequest?: Record<string, unknown>;
}
export interface ReplicationRouteReply { status: number; body: any }
export type ReplicationRouteCall = (surface: 'production' | 'studio', method: 'get' | 'post', route: string, body?: Record<string, unknown>) => Promise<ReplicationRouteReply>;
export interface AutomatedReplicationDependencies { call: ReplicationRouteCall; materials?: () => MaterialRecord[] | Promise<MaterialRecord[]>; validateVideo?: (material: MaterialRecord, tenantId: string) => Promise<string | void>; validateAdoption?: (spec: Record<string, any>, materials: MaterialRecord[]) => Promise<string[]>; createControlledProductAnimation?: (input: ControlledProductImageAnimationInput) => Promise<ControlledProductImageAnimationResult> }
export interface AutomatedReplicationResult { state: 'pending' | 'blocked' | 'ready'; changed: boolean; blocker?: string; blockerCode?: string; shotId?: string; materialIds?: string[] }

/** Invoke a native business handler inside the already authenticated worker scope.
 * This is deliberately not an HTTP client or a token/authentication bypass: the
 * tenant comes from the trusted job, and every handler still validates ownership.
 */
export async function invokeReplicationRoute(router: Router, tenantId: string, method: 'get' | 'post', route: string, body: Record<string, unknown> = {}): Promise<ReplicationRouteReply> {
  if (!tenantId) throw new Error('逐镜任务缺少已认证企业');
  for (const layer of (router as any).stack || []) {
    const registered = layer.route;
    if (!registered?.methods?.[method] || typeof registered.path !== 'string') continue;
    const names: string[] = [];
    const expression = registered.path.split('/').map((part: string) => part.startsWith(':') ? (names.push(part.slice(1)), '([^/]+)') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
    const match = route.match(new RegExp(`^${expression}$`));
    if (!match) continue;
    let status = 200; let response: any; let ended = false;
    const req = { body, params: Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)])), query: {}, method: method.toUpperCase(), path: route, headers: {}, get: () => undefined };
    const res: any = { locals: { tenantId, userId: 'digital_employee_worker' }, status(code: number) { status = code; return res; }, json(value: any) { response = value; ended = true; return res; }, send(value: any) { response = value; ended = true; return res; } };
    for (const handler of registered.stack) { await handler.handle(req, res, (error?: Error) => { if (error) throw error; }); if (ended) break; }
    if (!ended) throw new Error(`原生逐镜接口未返回结果：${route}`);
    return { status, body: response };
  }
  throw new Error(`逐镜生产接口不存在：${method} ${route}`);
}

const run = promisify(execFile);
export async function validateReplicationVideo(material: MaterialRecord, tenantId: string): Promise<string> {
  if (material.scope !== 'own' || String(material.tenantId || material.tenant_id || '') !== tenantId || material.type !== 'video'
    || /reference|tiktok|benchmark/i.test(String(material.sourceType || ''))) throw new Error('逐镜采用只允许本企业可编辑真实视频，禁止原片与目录图片');
  if (material.objectKey && !isTenantPrivateObjectKey(String(material.objectKey), tenantId)) throw new Error('逐镜视频对象存储路径不属于当前企业');
  if (material.file) {
    const root = tenantAssetDir(path.resolve('data/media'), tenantId);
    const file = path.resolve('data/media', String(material.file));
    if (fs.existsSync(file) ? (!fs.existsSync(root) || !fs.realpathSync(file).startsWith(`${fs.realpathSync(root)}${path.sep}`)) : !material.objectKey) throw new Error('逐镜视频本地路径不属于当前企业');
  }
  const loaded = await readTenantMaterialBytes(material, tenantId);
  if (material.contentSha256 && createHash('sha256').update(loaded.bytes).digest('hex') !== material.contentSha256) throw new Error('逐镜视频内容哈希已变化');
  const contentSha256 = createHash('sha256').update(loaded.bytes).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replication-bridge-'));
  try {
    const file = path.join(dir, 'candidate.mp4'); fs.writeFileSync(file, loaded.bytes, { mode: 0o600 });
    if (!ffmpeg) throw new Error('逐镜视频解码工具不可用');
    const decoded = await run(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', file, '-map', '0:v:0', '-an', '-f', 'null', '-'], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    if (!/Video:/.test(decoded.stderr) || !/Duration:/.test(decoded.stderr)) throw new Error('逐镜候选不是可完整解码的视频');
    return contentSha256;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const productionRouters = new WeakMap<DataStore, Router>();
async function defaultDependencies(input: { tenantId: string; store: DataStore }): Promise<AutomatedReplicationDependencies> {
  let production = productionRouters.get(input.store);
  if (!production) { const module = await import('./studioAvatarProduction.js'); production = module.createStudioAvatarProductionRouter(input.store); productionRouters.set(input.store, production); }
  const { studioRouter } = await import('../routes/studio.js');
  const { readMaterialLibrary } = await import('./materialLibrary.js');
  return { materials: async () => (await readMaterialLibrary(input.tenantId, { dataStore: input.store })).items,
    createControlledProductAnimation: createControlledProductImageAnimation,
    call: (surface, method, route, body) => invokeReplicationRoute(surface === 'production' ? production! : studioRouter, input.tenantId, method, route, body) };
}
const locks = new Set<string>();
// These native responses are explicit pre-admission rejections. Other errors
// may follow a paid submission: preserve that request and stop this tick.
const unpaidRejections = new Set([
  'STORYBOARD_BUDGET_PLAN_UNAVAILABLE', 'STORYBOARD_BUDGET_PLAN_CHANGED',
  'STORYBOARD_PROJECT_BUDGET_EXCEEDED', 'seedance_monthly_budget_exceeded',
  'USAGE_ACTION_STATES_REQUIRED', 'USAGE_ACTION_PLAN_NOT_READY',
  'ACTION_SEGMENT_PLAN_NOT_READY', 'STORYBOARD_PROJECT_INPUT_CHANGED',
  'STORYBOARD_IMAGE_PROVIDER_UNAVAILABLE', 'FIRST_FRAME_NOT_CONFIRMED',
]);
function nativeFailure(reply: ReplicationRouteReply, fallback: string) {
  return Object.assign(new Error(reply.body?.error || fallback), { code: String(reply.body?.code || '') });
}
/** Advance exactly one supplier-producing step per tick. Native ledgers own paid
 * idempotency; progress is saved before submission so uncertain work is never
 * silently submitted again following a process restart. */
export async function advanceAutomatedReplication(input: { tenantId: string; projectId: string; maxCostCny?: number; store: DataStore }, suppliedDeps?: AutomatedReplicationDependencies): Promise<AutomatedReplicationResult> {
  const key = `${input.tenantId}:${input.projectId}`;
  if (locks.has(key)) return { state: 'pending', changed: false };
  locks.add(key);
  try {
    const deps = suppliedDeps || await defaultDependencies(input);
    const project = await input.store.getById<any>('studio_projects', input.projectId);
    if (!project || project.tenant_id !== input.tenantId || project.status !== 'draft') return { state: 'blocked', changed: false, blocker: '当前企业逐镜草稿不存在或不可编辑' };
    const spec = project.spec || {}; const shots = spec.automatedReplicationShots as AutomatedReplicationShot[];
    if (!Array.isArray(shots) || !shots.length) return { state: 'blocked', changed: false, blocker: '缺少精确逐镜生产计划' };
    const assemblyId = String(spec.activeAssemblyId || '');
    const progress = { ...(spec.automatedReplicationProgress || {}) };
    const save = async (shotId: string, value: Record<string, unknown>, patch: Record<string, any> = {}) => {
      const latest = await input.store.getById<any>('studio_projects', project.id);
      if (!latest || latest.tenant_id !== input.tenantId || latest.status !== 'draft') throw new Error('逐镜草稿状态已变化');
      Object.assign(progress, latest.spec?.automatedReplicationProgress || {});
      progress[shotId] = { ...progress[shotId], blocker: '', blockerCode: '', ...value, updatedAt: new Date().toISOString() };
      const saved = await compareAndSwapStudioProject(input.store, latest, {
        spec: { ...latest.spec, ...patch, automatedReplicationProgress: progress },
      });
      if (!saved.ok) throw new Error('逐镜草稿已并发更新，未覆盖最新内容；请刷新后重试');
    };
    const materialFor = async (id: string) => (await (deps.materials || readLocalMaterials)()).find(item => item.id === id && String(item.tenantId || item.tenant_id || '') === input.tenantId);
    const validate = deps.validateVideo || validateReplicationVideo;
    const readyIds: string[] = [];
    const blockedShots: AutomatedReplicationShot[] = [];
    let changed = false;
    for (const entry of shots) {
      if (entry.kind === 'blocked' || entry.productionState === 'blocked') {
        blockedShots.push(entry);
        continue;
      }
      let mayHaveSubmitted = false;
      const call: ReplicationRouteCall = async (surface, method, route, body) => {
        const paid = method === 'post' && route !== '/sentence-first-frames' && !route.endsWith('/adopt');
        if (paid) mayHaveSubmitted = true;
        const reply = await deps.call(surface, method, route, body);
        if (paid && surface === 'studio' && reply.status >= 400 && unpaidRejections.has(String(reply.body?.code || ''))
          && !reply.body?.providerTaskId) mayHaveSubmitted = false;
        return reply;
      };
      try {
      const shotKey = `${assemblyId}:${entry.shotId}`; const shot = spec.shotProductions?.[shotKey];
      if (!shot || shot.locked) throw new Error('逐镜参数缺失或被锁定');
      const fingerprint = shotFingerprint(shot, String(entry.fingerprintContext || spec.shotProductionContext || ''), entry.shotId);
      const state = progress[entry.shotId] || {};
      if (state.fingerprint && state.fingerprint !== fingerprint) throw new Error('逐镜输入已变化，原付费作业需核对后更新生产计划');
      const assigned = String(spec.storyboardAssignments?.[entry.slotId] || '');
      if (assigned) {
        const material = await materialFor(assigned); if (!material) throw new Error('装配视频不存在或不属于当前企业'); const currentHash = await validate(material, input.tenantId);
        if (state.videoContentSha256 && currentHash !== state.videoContentSha256) throw new Error('逐镜视频在质检或采用后已被替换');
        if (material.provenance?.storyboardAigc === true) {
          const issues = deps.validateAdoption ? await deps.validateAdoption(spec, await (deps.materials || readLocalMaterials)())
            : await (await import('../routes/studio.js')).automationStoryboardAssignmentIssues(input.tenantId, project.id, spec);
          if (issues.length) throw new Error(issues.join('；'));
        }
        if (entry.kind === 'nonperson' && !shot.candidates?.some((candidate: any) => candidate.id === shot.adoptedId && candidate.materialId === assigned && candidate.fingerprint === fingerprint)) {
          const candidateId = `matched:${createHash('sha256').update(`${key}:${entry.shotId}:${assigned}:${fingerprint}`).digest('hex').slice(0,24)}`;
          await save(entry.shotId, { fingerprint, adopted: true, materialId: assigned, source: 'matched_enterprise_video', ...(currentHash ? { videoContentSha256: currentHash } : {}) }, { shotProductions: { ...spec.shotProductions, [shotKey]: { ...shot, adoptedId: candidateId, candidates: [...(shot.candidates || []), { id: candidateId, materialId: assigned, fingerprint, source: 'material', createdAt: new Date().toISOString() }] } } });
          return { state: 'pending', changed: true, shotId: entry.shotId };
        }
        if (state.blocker || state.blockerCode) { await save(entry.shotId, {}); changed = true; }
        readyIds.push(assigned); continue;
      }
      // A supplier request is tied to both the editable shot and the immutable
      // generation recipe.  Product-image pipeline upgrades must be able to
      // create a new request without perturbing other already-adopted shots.
      const generationRevision = String(entry.firstFrameRequest?.generationRevision || 'v1');
      const requestId = `bridge:${createHash('sha256').update(`${key}:${assemblyId}:${entry.shotId}:${fingerprint}:${generationRevision}`).digest('hex').slice(0,40)}`;
      const b = { projectId: project.id, assemblyId, shotId: entry.shotId, fingerprint, requestId, confirmed: true, maxCostCny: input.maxCostCny };
      if (entry.kind === 'person') {
        assertReferencePresenterComposition(entry.referenceComposition);
        if (entry.referenceShotId !== entry.referenceComposition.referenceShotId
          || entry.referenceFirstFrameUrl !== entry.referenceComposition.referenceFirstFrameUrl) {
          throw new Error('真人口播对标分镜绑定不一致');
        }
        const personCues = referenceCues(shot.digitalHuman).filter(cue => cue.personShot !== false);
        if (!personCues.length || personCues.some(cue => cue.referenceShotId !== entry.referenceShotId
          || cue.referenceFirstFrameUrl !== entry.referenceFirstFrameUrl
          || cue.composition?.referenceShotId !== entry.referenceShotId)) {
          throw new Error('真人口播逐句计划未绑定当前对标分镜首帧');
        }
        if (!referenceCues(shot.digitalHuman).every(cue => cue.personShot === false || cue.sourceFirstFrame?.materialId)) {
          const reply = await call('production', 'post', '/sentence-first-frames', b); if (reply.status >= 400 || !reply.body?.cues) throw nativeFailure(reply, '人物源首帧提取失败');
          const nextShot = { ...shot, digitalHuman: { ...shot.digitalHuman, reference: { ...shot.digitalHuman.reference, cues: reply.body.cues } } };
          await save(entry.shotId, {}, { shotProductions: { ...spec.shotProductions, [shotKey]: nextShot } });
          return { state: 'pending', changed: true, shotId: entry.shotId };
        }
        if (state.submitted && !state.result) {
          const reply = await call('production', 'get', `/sentence-replication-requests/${requestId}/status`);
          const job = reply.body;
          if (job?.state === 'completed' && job.id) {
            const completed = await call('production', 'get', `/sentence-replication-jobs/${job.id}`);
            if (completed.body?.executionId) { await save(entry.shotId, { result: completed.body }); return { state: 'pending', changed: true }; }
          }
          if (reply.status === 404) {
            // No native record means the process stopped before supplier admission.
            const submitted = await call('production', 'post', '/sentence-replication-jobs', b);
            if (submitted.status < 400 && submitted.body?.executionId) { await save(entry.shotId, { result: submitted.body }); return { state: 'pending', changed: true }; }
            throw nativeFailure(submitted, '人物原生作业未完成');
          }
          if (job?.state === 'uncertain' && job.id && referenceCues(shot.digitalHuman).filter(cue => cue.personShot !== false).every(cue => job.providerTasks?.[cue.id])) {
            const resumed = await call('production', 'post', `/sentence-replication-jobs/${job.id}/resume`, { confirmed: true, maxCostCny: input.maxCostCny });
            if (resumed.status < 400 && resumed.body?.executionId) { await save(entry.shotId, { result: resumed.body }); return { state: 'pending', changed: true }; }
            throw nativeFailure(resumed, '原供应商任务尚未恢复完成');
          }
          throw new Error(job?.error || '已提交人物作业等待核对，保留原请求且不重复付费');
        }
        if (!state.result) {
          await save(entry.shotId, { fingerprint, submitted: true, requestId });
          const reply = await call('production', 'post', '/sentence-replication-jobs', b);
          if (reply.status >= 400 || !reply.body?.executionId) throw nativeFailure(reply, '人物逐镜生成未完成');
          await save(entry.shotId, { result: reply.body }); return { state: 'pending', changed: true, shotId: entry.shotId };
        }
        const result = state.result;
        const executions = await input.store.getById<any>('studio_digital_human_executions', result.executionId);
        if (!executions || executions.tenant_id !== input.tenantId || digitalHumanQualityState(executions.payload.quality.checks) !== 'accepted') throw new Error('人物候选存在质量失败或媒体尚未完成');
        const candidateId = `${requestId}:candidate`; const nextShot = { ...shot, candidates: [...(shot.candidates || []).filter((item: any) => item.id !== candidateId), { id: candidateId, materialId: result.materialId, fingerprint, source: 'avatar', jobId: result.executionId, createdAt: new Date().toISOString() }] };
        await save(entry.shotId, {}, { shotProductions: { ...spec.shotProductions, [shotKey]: nextShot } });
        const reply = await call('production', 'post', `/executions/${result.executionId}/adopt`, { candidateId, materialId: result.materialId });
        if (reply.status >= 400) throw new Error(reply.body?.error || '人物候选自动采用失败');
        await save(entry.shotId, { adopted: true, materialId: result.materialId }); return { state: 'pending', changed: true, shotId: entry.shotId };
      }
      if (!state.firstFrameMaterialId && !state.matchingChecked) {
        const match = matchReplicationMaterial({ tenantId: input.tenantId,
          shotDescription: String(entry.firstFrameRequest?.shotDescription || ''), duration: entry.end - entry.start,
          materials: await (deps.materials || readLocalMaterials)(),
          requiredProductId: entry.firstFrameRequest?.sceneType === 'product' ? String((entry.firstFrameRequest.productIds as string[] | undefined)?.[0] || shot.productId || '') || undefined : undefined });
        if (match) {
          const material = await materialFor(match.materialId); if (!material) throw new Error('匹配视频已不属于当前企业');
          const matchedHash = await validate(material, input.tenantId);
          if (match.contentSha256 && matchedHash !== match.contentSha256) throw new Error('匹配视频内容版本与证据不一致');
          const candidateId = `${requestId}:matched`;
          await save(entry.shotId, { fingerprint, matchingChecked: true, matching: match, ...(matchedHash ? { videoContentSha256: matchedHash } : {}), trimStart: match.trimStart, trimEnd: match.trimEnd, adopted: true, materialId: match.materialId }, {
            storyboardAssignments: { ...spec.storyboardAssignments, [entry.slotId]: match.materialId },
            clipEdits: { ...spec.clipEdits, [entry.slotId]: { ...spec.clipEdits?.[entry.slotId], trimStart: match.trimStart, trimEnd: match.trimEnd } },
            shotProductions: { ...spec.shotProductions, [shotKey]: { ...shot, adoptedId: candidateId, candidates: [...(shot.candidates || []), { id: candidateId, materialId: match.materialId, fingerprint, source: 'material', createdAt: new Date().toISOString() }] } },
          });
          return { state: 'pending', changed: true, shotId: entry.shotId };
        }
      }
      if (!state.firstFrameMaterialId) {
        if (!entry.firstFrameRequest) throw new Error('非人物镜头缺少参考首帧和产品生成参数');
        const reply = await call('studio', 'post', '/storyboard-first-frame', { ...entry.firstFrameRequest, projectId: project.id, shotId: entry.slotId, requestId, maxCostCny: input.maxCostCny });
        if (reply.status >= 400 || !reply.body?.ok || !reply.body?.material?.id) throw nativeFailure(reply, '非人物首帧生成未完成');
        await save(entry.shotId, { fingerprint, firstFrameMaterialId: reply.body.material.id, firstFrameFingerprint: reply.body.fingerprint }); return { state: 'pending', changed: true, shotId: entry.shotId };
      }
      if (!state.videoMaterialId) {
        const firstFrame = await materialFor(String(state.firstFrameMaterialId));
        const qualityState = firstFrame?.provenance?.firstFrameQualityState;
        if (qualityState && qualityState !== 'evaluated') {
          const reply = await call('studio', 'post', `/storyboard-first-frame/${encodeURIComponent(String(state.firstFrameMaterialId))}/recheck-quality`, {
            fingerprint: state.firstFrameFingerprint,
            shotId: entry.slotId,
          });
          // A completed recheck may legitimately return a hard QA rejection.
          // That result is persisted on the retained material and must flow
          // through the protected, budgeted regeneration branch on the next
          // tick. Treating the 422 as a transport failure blocked the whole
          // project before its approved retry allowance could be consumed.
          const completedQualityRejection = reply.body?.code === 'FIRST_FRAME_QA_FAILED';
          if ((reply.status >= 400 || !reply.body?.ok) && !completedQualityRejection) {
            throw nativeFailure(reply, '首帧质检未完成，已保留原图并等待自动复检；不会重新生成图片');
          }
          await save(entry.shotId, { firstFrameQaRecheckedAt: new Date().toISOString() });
          return { state: 'pending', changed: true, shotId: entry.shotId };
        }
        const firstFrameQuality = firstFrame?.provenance?.firstFrameQuality as { passed?: unknown; reasonCodes?: unknown } | undefined;
        const currentSourcePlan = spec.storyboardSourcePlans?.[entry.slotId] as Record<string, any> | undefined;
        const managedFallbackAccepted = automaticManagedFallbackFrameAdmission(firstFrame?.provenance, currentSourcePlan);
        if (firstFrameQuality && firstFrameQuality.passed !== true && !managedFallbackAccepted) {
          const reasonCodes = Array.isArray(firstFrameQuality.reasonCodes) ? firstFrameQuality.reasonCodes.map(String) : [];
          const reasons = reasonCodes.join('、');
          const operatingContext = spec.contentOrder?.operatingContext || {};
          const maxRetries = Math.max(0, Math.min(20, Number(operatingContext.maxAigcRetries || 0)));
          const productIds = Array.isArray(entry.firstFrameRequest?.productIds)
            ? entry.firstFrameRequest.productIds.map(String).filter(Boolean) : [];
          const shotSpec = firstFrame?.provenance?.shotSpec;
          const projectShotFingerprint = String(firstFrame?.provenance?.projectShotFingerprint || '');
          const createControlledFallback = async () => {
            const controlledEligible = currentSourcePlan?.fallbackMode === 'enterprise_product_display'
              && currentSourcePlan?.mode === 'ai'
              && entry.firstFrameRequest?.fallbackMode === 'enterprise_product_display'
              && entry.firstFrameRequest?.mode === 'free_creation'
              && entry.firstFrameRequest?.sceneType === 'product'
              && productIds.length === 1
              && shotSpec?.mode === 'free_creation' && shotSpec?.scene === 'product'
              && !shotSpec.constraints?.some((value: string) => ['person_identity', 'physical_contact', 'factory_space', 'action_completion'].includes(value))
              && !shotSpec.action?.beats?.length
              && projectShotFingerprint;
            if (!controlledEligible) return false;
            const inventory = await (deps.materials || readLocalMaterials)();
            const source = inventory.find(item => item.type === 'image' && item.scope === 'own'
              && String(item.tenantId || item.tenant_id || '') === input.tenantId
              && item.sourceType === 'enterprise_product_table' && item.commercialUseApproved === true
              && item.rightsStatus === 'authorized' && String(item.productId || '') === productIds[0]);
            const createControlled = deps.createControlledProductAnimation || (suppliedDeps ? undefined : createControlledProductImageAnimation);
            if (!source || !createControlled) return false;
            const controlled = await createControlled({ tenantId: input.tenantId, projectId: project.id,
              shotId: entry.slotId, requestId: `${requestId}:controlled-product-animation`,
              projectShotFingerprint, durationSeconds: Math.max(4, Math.min(15, Math.ceil(entry.end - entry.start))),
              productImage: source, shotSpec });
            await save(entry.shotId, {
              firstFrameMaterialId: controlled.frame.id,
              firstFrameFingerprint: controlled.frame.provenance?.fingerprint,
              firstFrameQaRecheckedAt: new Date().toISOString(),
              videoMaterialId: controlled.video.id,
              controlledProductFallback: true,
            });
            return true;
          };
          // A current, authorized product image is stronger identity evidence
          // than another generative guess. For static managed product-display
          // shots, switch immediately after an identity failure and preserve
          // retry budget for failures that generation can actually repair.
          if (reasonCodes.includes('PRODUCT_IDENTITY_FAILED') && await createControlledFallback())
            return { state: 'pending', changed: true, shotId: entry.shotId };
          // Protected plans freeze a project-wide maximum before production.
          // If the ordinary retry changes the failure class, one directed
          // prompt-repair revision may use otherwise-unused headroom inside
          // that same approved ceiling. The project ledger remains the final
          // cost gate, so this can never raise the user's approved budget.
          const directedRepairAllowance = operatingContext.productionBudgetMode === 'protected'
            && Boolean(operatingContext.budgetApprovedAt) && maxRetries > 0 ? 1 : 0;
          const retryCount = Math.max(0, Number(state.firstFrameRetryCount || 0));
          if (retryCount < maxRetries + directedRepairAllowance) {
            const nextRetryCount = retryCount + 1;
            const firstFrameHistory = [...(Array.isArray(state.firstFrameHistory) ? state.firstFrameHistory : []), {
              materialId: state.firstFrameMaterialId,
              fingerprint: state.firstFrameFingerprint,
              reasonCodes: Array.isArray(firstFrameQuality.reasonCodes) ? firstFrameQuality.reasonCodes.map(String) : [],
              rejectedAt: new Date().toISOString(),
            }];
            const qualityRepairReasonCodes = [...new Set(firstFrameHistory.flatMap(item => Array.isArray(item.reasonCodes)
              ? item.reasonCodes.map(String) : []))];
            const nextShots = shots.map(item => item.shotId !== entry.shotId ? item : ({
              ...item,
              firstFrameRequest: { ...item.firstFrameRequest,
                generationRevision: nextRetryCount > maxRetries ? `quality-directed-repair-${nextRetryCount}` : `quality-retry-${nextRetryCount}`,
                qualityRepairReasonCodes },
            }));
            await save(entry.shotId, {
              firstFrameMaterialId: '', firstFrameFingerprint: '', firstFrameQaRecheckedAt: '',
              firstFrameRetryCount: nextRetryCount, firstFrameHistory,
            }, { automatedReplicationShots: nextShots });
            return { state: 'pending', changed: true, shotId: entry.shotId };
          }
          if (await createControlledFallback()) return { state: 'pending', changed: true, shotId: entry.shotId };
          throw Object.assign(new Error(`非人物首帧未通过产品与画面质检${reasons ? `：${reasons}` : ''}；未提交视频生成`), { code: 'FIRST_FRAME_QA_FAILED' });
        }
        const videoRequestId = state.videoGenerationRevision ? `${requestId}:video:${state.videoGenerationRevision}` : `${requestId}:video`;
        const reply = await call('studio', 'post', '/seedance-video', { ...entry.firstFrameRequest, script: entry.firstFrameRequest?.shotDescription || shot.narration, firstFrameMaterialId: state.firstFrameMaterialId, firstFrameFingerprint: state.firstFrameFingerprint, shotId: entry.slotId, requestId: videoRequestId, duration: Math.max(4, Math.min(15, Math.ceil(entry.end - entry.start))), resolution: '480p', ratio: spec.ratio || '9:16', language: spec.activeVoiceLang || spec.lang || 'en', generationContext: { projectId: project.id }, maxCostCny: input.maxCostCny });
        if (reply.status === 202 && reply.body?.code === 'STORYBOARD_VIDEO_IN_PROGRESS') {
          if (reply.body.providerTaskId && reply.body.providerAcceptedAt) {
            await save(entry.shotId, { providerTaskId: reply.body.providerTaskId,
              providerAcceptedAt: reply.body.providerAcceptedAt, providerModel: reply.body.providerModel });
          }
          return { state: 'pending', changed: Boolean(reply.body.providerTaskId), shotId: entry.shotId };
        }
        if (reply.status >= 400 && reply.body?.code === 'STORYBOARD_VIDEO_PROVIDER_FAILED') {
          const maxRetries = Math.max(0, Math.min(20, Number(spec.contentOrder?.operatingContext?.maxAigcRetries || 0)));
          const retryCount = Math.max(0, Number(state.videoRetryCount || 0));
          if (retryCount < maxRetries) {
            const nextRetryCount = retryCount + 1;
            const videoHistory = [...(Array.isArray(state.videoHistory) ? state.videoHistory : []), {
              materialId: state.videoMaterialId || '', providerTaskId: reply.body?.providerTaskId || state.providerTaskId || '',
              providerStatus: reply.body?.providerStatus || '', failureCode: 'STORYBOARD_VIDEO_PROVIDER_FAILED',
              rejectedAt: new Date().toISOString(),
            }];
            await save(entry.shotId, {
              videoMaterialId: '', qualityChecked: false,
              providerTaskId: '', providerAcceptedAt: '', providerModel: '',
              videoRetryCount: nextRetryCount, videoGenerationRevision: `provider-retry-${nextRetryCount}`, videoHistory,
            });
            return { state: 'pending', changed: true, shotId: entry.shotId };
          }
        }
        if (reply.status >= 400 || !reply.body?.ok || !reply.body?.material?.id) throw nativeFailure(reply, '非人物镜头生成未完成，原生预算账本保留原作业');
        await save(entry.shotId, { videoMaterialId: reply.body.material.id }); return { state: 'pending', changed: true, shotId: entry.shotId };
      }
      if (!state.qualityChecked) {
        const qualityMaterial = await materialFor(state.videoMaterialId); if (!qualityMaterial) throw new Error('待质检视频不存在');
        const qualityInputHash = await validate(qualityMaterial, input.tenantId);
        const currentSourcePlan = spec.storyboardSourcePlans?.[entry.slotId] as Record<string, any> | undefined;
        if (automaticManagedFallbackVideoAdmission(qualityMaterial.provenance, currentSourcePlan)) {
          await save(entry.shotId, { qualityChecked: true, ...(qualityInputHash ? { videoContentSha256: qualityInputHash } : {}) });
          return { state: 'pending', changed: true, shotId: entry.shotId };
        }
        const reply = await call('studio', 'post', '/storyboard-quality-check', { materialId: state.videoMaterialId, storyboard: entry.firstFrameRequest?.shotDescription || '' });
        if (reply.status >= 400) throw nativeFailure(reply, '视频质检服务未完成，已保留原视频');
        const managedFallbackVideoAccepted = automaticManagedFallbackVideoAdmission({
          ...qualityMaterial.provenance,
          storyboardQualityReport: reply.body?.quality,
        }, currentSourcePlan);
        if (!reply.body?.quality?.passed && !managedFallbackVideoAccepted) {
          const maxRetries = Math.max(0, Math.min(20, Number(spec.contentOrder?.operatingContext?.maxAigcRetries || 0)));
          const retryCount = Math.max(0, Number(state.videoRetryCount || 0));
          if (retryCount < maxRetries) {
            const nextRetryCount = retryCount + 1;
            const videoHistory = [...(Array.isArray(state.videoHistory) ? state.videoHistory : []), {
              materialId: state.videoMaterialId,
              quality: reply.body?.quality || null,
              providerTaskId: state.providerTaskId || '',
              rejectedAt: new Date().toISOString(),
            }];
            await save(entry.shotId, {
              videoMaterialId: '', qualityChecked: false,
              providerTaskId: '', providerAcceptedAt: '', providerModel: '',
              videoRetryCount: nextRetryCount, videoGenerationRevision: `quality-retry-${nextRetryCount}`, videoHistory,
            });
            return { state: 'pending', changed: true, shotId: entry.shotId };
          }
          throw Object.assign(new Error(reply.body?.error || '非人物视频质量检查未通过'), { code: 'STORYBOARD_VIDEO_QA_FAILED' });
        }
        const checkedMaterial = await materialFor(state.videoMaterialId); if (!checkedMaterial) throw new Error('质检视频不存在');
        const checkedHash = await validate(checkedMaterial, input.tenantId);
        if (qualityInputHash && checkedHash !== qualityInputHash) throw new Error('非人物视频在质检过程中已被替换');
        await save(entry.shotId, { qualityChecked: true, ...(checkedHash ? { videoContentSha256: checkedHash } : {}) }); return { state: 'pending', changed: true, shotId: entry.shotId };
      }
      const material = await materialFor(state.videoMaterialId); if (!material) throw new Error('非人物候选视频不可读取'); const adoptedHash = await validate(material, input.tenantId);
      if (state.videoContentSha256 && adoptedHash !== state.videoContentSha256) throw new Error('非人物视频在质检后已被替换');
      const candidateSpec = { ...spec, storyboardAssignments: { ...spec.storyboardAssignments, [entry.slotId]: material.id } };
      const adoptionIssues = deps.validateAdoption
        ? await deps.validateAdoption(candidateSpec, await (deps.materials || readLocalMaterials)())
        : await (await import('../routes/studio.js')).automationStoryboardAssignmentIssues(input.tenantId, project.id, candidateSpec);
      if (adoptionIssues.length) throw new Error(adoptionIssues.join('；'));
      const candidateId = `${requestId}:candidate`;
      const nextShot = { ...shot, adoptedId: candidateId, candidates: [...(shot.candidates || []).filter((candidate: any) => candidate.id !== candidateId), { id: candidateId, materialId: material.id, fingerprint, source: 'ai', createdAt: new Date().toISOString() }] };
      await save(entry.shotId, { adopted: true, materialId: material.id }, { storyboardAssignments: { ...spec.storyboardAssignments, [entry.slotId]: material.id }, shotProductions: { ...spec.shotProductions, [shotKey]: nextShot } });
      return { state: 'pending', changed: true, shotId: entry.shotId };
      } catch (error) {
        const blocker = error instanceof Error ? error.message : '逐镜执行失败';
        const blockerCode = String((error as { code?: unknown })?.code || 'shot_execution_blocked');
        await save(entry.shotId, { blocker, blockerCode });
        changed = true;
        blockedShots.push({ ...entry, blocker, blockerCode });
        if (mayHaveSubmitted) return { state: 'blocked', changed, blocker, blockerCode, shotId: entry.shotId, materialIds: readyIds };
      }
    }
    if (blockedShots.length) return { state: 'blocked', changed,
      blocker: blockedShots.map(entry => entry.blocker || `${entry.shotId} 缺少可执行镜头证据`).join('；'),
      blockerCode: blockedShots[0]!.blockerCode, shotId: blockedShots[0]!.shotId, materialIds: readyIds };
    return { state: 'ready', changed: false, materialIds: readyIds };
  } catch (error) { return { state: 'blocked', changed: false, blocker: error instanceof Error ? error.message : '逐镜执行失败' }; }
  finally { locks.delete(key); }
}
