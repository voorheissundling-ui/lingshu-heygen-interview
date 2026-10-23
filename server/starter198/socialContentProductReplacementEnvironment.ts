import {executeWanImageVideo,type WanImageVideoCheckpoint} from '../lib/wanImageVideo.js';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {store} from '../storage/index.js';
import {objectStorageDownload} from '../storage/objectStorage.js';
import {readMaterialLibrary} from '../lib/materialLibrary.js';
import {prepareTrustedStoryboardSeedream} from '../lib/storyboardSeedreamPreparation.js';
import {firstFrameInputFingerprint, type FirstFrameReference} from '../lib/firstFrameGenerator.js';
import {generateSeedanceConceptVideo} from '../lib/generativeVideoGateway.js';
import {withPaidOperationLock} from '../lib/paidOperationLock.js';
import {MvpBudgetAdmission, type MvpBudgetRecord} from '../lib/mvpBudgetAdmission.js';
import {isInternalBudgetExemptTenant} from '../lib/tenantBudgetExemption.js';
import {readProductRecoveryFunding} from './socialContentProductRecoveryFunding.js';
import {SocialContentTaskBudget} from '../lib/socialContentTaskBudget.js';
import {runVisualFfmpeg} from '../lib/renderVisualQuality.js';
import {inspectStoryboardAigcFramesWithQwen} from '../agents/qwen.js';
import {applyStoryboardReplicationAutomation, buildStoryboardQaReport, inspectStoryboardTechnicalFrames} from '../lib/storyboardAigcQuality.js';
import {createStarter198Repository} from './repository.js';
import {findSocialContentFile, readSocialContentFile, MAX_SOCIAL_CONTENT_FILE_BYTES, type SocialContentBackendFilePort} from './socialContentFiles.js';
import {socialRequestHash} from './socialContentValidation.js';
import {bindProductPaidStage, hasProductPaidStage, productPaidReservedCostCny, type ProductPaidContext, type ProductPaidStage} from './socialContentProductPaidContext.js';
import type {ProductReplacementPorts} from './socialContentProductReplacementExecution.js';
import type {ProductSceneExecutionPorts} from './socialContentProductSceneAdapter.js';
import type {SocialAssetSupplyPlan} from '../../shared/contracts/socialContentWorkflow.js';

type Input = Parameters<ProductSceneExecutionPorts['execute']>[0];
type Row = Record<string, any>;
const json = (x: unknown): any => typeof x === 'string' ? JSON.parse(x) : x;
const sha = (x: Buffer | string) => createHash('sha256').update(x).digest('hex');
const compactProviderReceipt = (provider: string, fingerprint: string) => `${provider}:${fingerprint}`;
export function productReplacementExceedsInternalBudget(tenantId: string, amountCny: number, maximumCostCny: number) {
  return !isInternalBudgetExemptTenant(tenantId) && amountCny > maximumCostCny;
}
export function adaptSingletonProductFirstFrameQuality(quality: any, spec: Input['spec']) {
  const report = quality?.firstFrameQuality;
  if (quality?.firstFrameQualityState !== 'evaluated' || spec.productIdentity.groups.length !== 1 || !report?.checks) return quality;
  const checks = report.checks as Record<string, any>;
  if (checks.product_identity?.verdict !== 'pass' || checks.visual_integrity?.verdict !== 'pass'
    || checks.start_state?.verdict !== 'pass') return quality;
  const observations = Object.values(checks).filter((item: any) => item?.key !== 'contact').map((item: any) => item?.key === 'layout'
    ? {...item,verdict:'pass',action:'retry_video',note:'企业库仅有一个 SKU；已按单品展示功能验收，禁止复制产品伪装参考套组。'} : item);
  const adapted = applyStoryboardReplicationAutomation(buildStoryboardQaReport({phase:'first_frame',sceneType:'product',hasProduct:true,
    hasNamedPerson:false,hasEnvironmentReference:false,hasContact:false,hasAction:true,observations,evidenceFrameLabels:report.evidenceFrameLabels,
    checkedAt:report.checkedAt}));
  return {...quality,firstFrameQuality:adapted,canProceedToVideo:adapted.passed};
}
export function executableMaterialRouting(value: unknown): unknown {
  const routing = structuredClone((value && typeof value === 'object' ? value : {}) as Row);
  // durationOrigin records which planner supplied the already-frozen duration.
  // It does not alter provider inputs; projections rebuilt from the same task
  // may legitimately label that provenance differently.
  if (routing.generation && typeof routing.generation === 'object') delete routing.generation.durationOrigin;
  return routing;
}
export function productReferenceBound(
  references: Input['referenceImages'], id: string, contentHash: string | undefined,
): boolean {
  // Budget preflight deliberately has no render-workspace assets. It derives
  // the bound from canonical same-tenant library bytes below. Runtime calls do
  // carry references and must match the exact canonical hash.
  return references.length === 0 || references.some(reference => (
    reference.assetId === id && reference.contentHash === contentHash
  ));
}
/** Exact inputs for server quotes; provider duration, not trimmed duration, is billed. */
export function productReplacementOperationFingerprint(kind: string, value: unknown) {
  return sha(JSON.stringify({schema: 'product-replacement-operation.v1', kind, value}));
}
export interface ProductReplacementEnvironmentContext {
  dataStore?: Pick<typeof store, 'getById' | 'list'>;
  materials?: typeof readMaterialLibrary;
  download?: typeof objectStorageDownload;
  paidContext?: ProductPaidContext;
  /** Internal transport/configuration injection for offline contract tests. */
  wanTransport?: typeof fetch;
  wanCredentials?:()=>{apiKey:string;baseUrl:string;credentialSha256:string};
  budgetRoot?: string;
  /** Private server evidence cache; never a worker render workspace. */
  durableRoot?: string;
  backendFilePort?: SocialContentBackendFilePort;
  readRegisteredFile?: (input: {tenantId: string; fileId: string; expectedSha256: string}) => Promise<Buffer>;
  /** Trusted server callback, never populated from an HTTP body. */
  assertCurrent?: () => Promise<void>;
  prepareFrame?: typeof prepareTrustedStoryboardSeedream;
  generateVideo?: typeof generateSeedanceConceptVideo;
  inspectVisual?: typeof inspectStoryboardAigcFramesWithQwen;
  /** The read-only plan admitted by this production run. Product shots are
   * generated from this plan, while replication_script remains the director
   * script and is not a persisted copy of the derived supply plan. */
  frozenSupplyPlan?: SocialAssetSupplyPlan;
  /** Identity sealed in the executor checkpoint when the run starts. Task
   * status/version may advance afterwards without changing this authority. */
  frozenSupplyPlanBinding?: {planVersion:string;planHash:string};
}

function canonicalFrozenProductShot(input: Input, task: Row, context: ProductReplacementEnvironmentContext) {
  if (!context.frozenSupplyPlan) {
    const script = task && json(task.replication_script);
    return script?.shots?.find((shot: Row) => shot.shotId === input.shotId)?.materialPlan;
  }
  const plan = context.frozenSupplyPlan;
  const binding=context.frozenSupplyPlanBinding;
  if(!binding||!/^[a-f0-9]{64}$/.test(binding.planHash))throw Error('product_replacement_current_frozen_plan_binding_missing');
  if(String(plan.planVersion)!==binding.planVersion||socialRequestHash(plan)!==binding.planHash)throw Error('product_replacement_current_frozen_plan_changed');
  const ids = plan.shots.map(shot => shot.shotId);
  if (new Set(ids).size !== ids.length) throw Error('product_replacement_current_frozen_plan_ambiguous');
  const matches = plan.shots.filter(shot => shot.shotId === input.shotId);
  if (matches.length !== 1) return null;
  return matches[0]!;
}

export function diagnoseFrozenProductShot(input: Pick<Input,'tenantId'|'shotId'|'materialRouting'|'spec'>, task: Row, shot: any) {
  if (!task) return 'task_missing';
  if (task.tenant_id !== input.tenantId) return 'tenant_changed';
  if (!task.run_id) return 'run_missing';
  if (!shot) return 'shot_not_in_frozen_plan';
  if (!shot.materialRouting) return 'frozen_material_routing_missing';
  if (!input.materialRouting) return 'execution_material_routing_missing';
  if (!shot.productSceneReplication) return 'frozen_product_spec_missing';
  if (!input.spec) return 'execution_product_spec_missing';
  if (socialRequestHash(executableMaterialRouting(shot.materialRouting)) !== socialRequestHash(executableMaterialRouting(input.materialRouting))) return 'material_routing_changed';
  if (socialRequestHash(shot.productSceneReplication) !== socialRequestHash(input.spec)) return 'product_spec_changed';
  return null;
}

/** Default readers use canonical task, immutable handoffs, registered KB bytes and
 * provisioned budget pools. Missing rights/quotes are gaps, never implicit grants. */
export async function createEnvironmentProductReplacementPorts(input: Input, context: ProductReplacementEnvironmentContext = {}): Promise<ProductReplacementPorts> {
  const db = context.dataStore || store;
  const taskRows = await db.list<Row>('starter_social_content_tasks', {where: {tenant_id: input.tenantId, task_id: input.taskId}, perPage: 2});
  const tasks = taskRows.items.filter(row => row.tenant_id === input.tenantId && row.task_id === input.taskId);
  if (tasks.length !== 1 || taskRows.totalItems > taskRows.items.length) throw Error('product_replacement_canonical_task_missing_or_ambiguous');
  const task = tasks[0]!;
  const shot = canonicalFrozenProductShot(input, task, context);
  const frozenShotDiagnostic = diagnoseFrozenProductShot(input, task, shot);
  if (frozenShotDiagnostic) throw Error(`product_replacement_current_frozen_shot_missing:${frozenShotDiagnostic}:${input.shotId}`);
  const brief = json(task.brief);
  const productId = brief?.productId;
  const accountId = brief?.targetAccountRef?.id ?? null;
  if (typeof productId !== 'string' || !productId) throw Error('product_replacement_canonical_product_identity_missing');
  const frozenProductRefs: string[] = shot.productSceneReplication.productIdentity.groups.map((group: {productRef:string}) => group.productRef.replace(/^product:/, ''));
  if (!frozenProductRefs.length || frozenProductRefs.some((ref: string) => ref !== productId)) throw Error('product_replacement_canonical_product_identity_changed');
  const productAuthorities = new Map<string, {hash:string; recordHash:string}>();
  let usageAuthority: {id: string; hash: string} | null = null;
  const taskIdentity = socialRequestHash({run: task.run_id, script: task.replication_script, brief: task.brief});
  const assertCurrent = async () => {
    await context.assertCurrent?.();
    const live = await db.getById<Row>('starter_social_content_tasks', task.id);
    if (!live || live.tenant_id !== input.tenantId || socialRequestHash({run: live.run_id, script: live.replication_script, brief: live.brief}) !== taskIdentity) throw Error('product_replacement_task_changed');
    if (productAuthorities.size) {
      const library=await (context.materials || readMaterialLibrary)(input.tenantId);
      for (const [id, authority] of productAuthorities) {
        const record=library.items.find(r=>r.id===id);
        if (!record || socialRequestHash(record)!==authority.recordHash || (record.tenantId || record.tenant_id)!==input.tenantId
          || sha(await readBytes(record))!==authority.hash) throw Error('product_KB_original_authority_changed');
      }
    }
    if (usageAuthority) {
      const row = await db.getById<Row>('starter_social_inspiration_handoff_versions', usageAuthority.id);
      const h = row && json(row.payload);
      if (!row || row.tenant_id !== input.tenantId || row.record_hash !== usageAuthority.hash || socialRequestHash(h) !== usageAuthority.hash
        || h.rights?.mayUseOriginalMedia !== true || h.rights?.mayAdapt !== true) throw Error('product_reference_pixels_usage_changed');
    }
  };
  const budgetRoot = context.budgetRoot || path.resolve(process.env.MVP_BUDGET_POOL_DIR || 'data/mvp-budget-pools');
  const repository = createStarter198Repository(db as typeof store);
  const admission = new MvpBudgetAdmission(budgetRoot);
  const durableDirectory = path.join(context.durableRoot || path.resolve('data/social-product-replacement-executions'),
    sha(input.tenantId), sha(input.taskId), sha(String(task.run_id)), sha(input.shotId), sha(input.idempotencyKey));
  const paid = (stage: ProductPaidStage, attempt = 0) => context.paidContext ? bindProductPaidStage(context.paidContext, input.shotId, stage, attempt) : null;
  const paidRequestFile = (stage: ProductPaidStage, attempt = 0) => path.join(durableDirectory,'paid-requests',sha(paid(stage,attempt)!.intent.operationId)+'.json');
  const beforePaidSubmit = async (stage: ProductPaidStage, body: Record<string,unknown>, attempt = 0) => {
    await assertCurrent();
    const bound=paid(stage,attempt)!;
    const claim=await bound.beforeSubmit(body);
    const file=paidRequestFile(stage,attempt);
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    fs.writeFileSync(file,JSON.stringify({...claim,inputContractHash:bound.intent.inputContractHash,state:'unknown'}),{mode:0o600});
  };
  const stageFor = (operation: string): ProductPaidStage => operation === 'first-frame' ? 'first_frame' : operation === 'first-frame-qa' ? 'first_frame_qa' : operation === 'video-qa' ? 'video_qa' : 'video';
  const paidAmount = (stage: ProductPaidStage, attempt = 0) => {const bound = paid(stage,attempt)!; const amount = context.paidContext!.readReservedCny(bound.intent.operationId); if (!Number.isFinite(amount) || amount < 0) throw Error('product_paid_reservation_missing'); return amount;};
  const quote = (fingerprint: string, provider: string, model: string) => {
    const candidates: Array<{record: MvpBudgetRecord; scope: MvpBudgetRecord['authorizations'][number]; amount: number}> = [];
    for (const name of fs.existsSync(budgetRoot) ? fs.readdirSync(budgetRoot).filter(n => /^[a-f0-9]{64}\.json$/.test(n)) : []) {
      const record = JSON.parse(fs.readFileSync(path.join(budgetRoot, name), 'utf8')) as MvpBudgetRecord;
      if (record.tenantId !== input.tenantId || record.taskId !== input.taskId) continue;
      const q = record.pricing?.operationQuotes?.[fingerprint];
      if (!q || q.provider !== provider || q.model !== model || !Number.isFinite(q.upperBoundCny) || q.upperBoundCny < 0) continue;
      for (const scope of record.authorizations || []) if (scope.version === Number(task.version) && scope.runId === task.run_id && scope.provider === provider && scope.model === model && scope.shotIds.includes(input.shotId)
        && scope.accountId === (accountId) && scope.productId === productId) candidates.push({record, scope, amount: q.upperBoundCny});
    }
    if (candidates.length !== 1) throw Error('product_replacement_exact_server_budget_quote_missing_or_ambiguous');
    return candidates[0]!;
  };
  const taskBudgetScope = {tenantId: input.tenantId, taskId: input.taskId, runId: String(task.run_id), planHash: taskIdentity};
  const taskBudget = new SocialContentTaskBudget(path.join(path.dirname(budgetRoot), 'social-content-task-budget'), {
    assertCurrent: async () => assertCurrent(),
    authorization: async () => {
      const limit = Number(brief.perItemBudgetCny);
      if (!Number.isFinite(limit) || limit <= 0) throw Error('product_whole_film_budget_missing');
      return {maximumCny: Math.min(brief.materialRoutingPolicyVersion === 'type-aware.v2' ? 15 : 10, limit), authorizationRef: 'canonical-task-budget:' + taskIdentity};
    },
    quote: async (_scope, op) => {
      const q = quote(op.fingerprint, op.provider, op.model);
      return {upperBoundCny: q.amount, quoteRef: q.record.pricing.evidenceRef + ':' + op.fingerprint, validUntil: q.record.pricing.validUntil};
    },
    verifyRejection: async () => false, // Unknown/failed generation does not refund this chain's upper bound.
  });
  const reserve = async (fingerprint: string, provider: string, model: string, operation: string, attempt = 0) => {
    await assertCurrent();
    if (context.paidContext) return paidAmount(stageFor(operation),attempt);
    const q = quote(fingerprint, provider, model);
    if (productReplacementExceedsInternalBudget(input.tenantId, q.amount, input.maximumCostCny)) throw Error('product_replacement_quote_exceeds_shot_budget');
    // Refuse to create a fresh whole-film ledger over unreconciled historical spending.
    if (!taskBudget.status(taskBudgetScope)) {
      for (const name of fs.existsSync(budgetRoot) ? fs.readdirSync(budgetRoot).filter(n => /^[a-f0-9]{64}\.json$/.test(n)) : []) {
        const existing = JSON.parse(fs.readFileSync(path.join(budgetRoot, name), 'utf8')) as MvpBudgetRecord;
        if (existing.tenantId === input.tenantId && existing.taskId === input.taskId && Object.keys(existing.entries || {}).length)
          throw Error('product_whole_film_historical_budget_reconciliation_required');
      }
    }
    await taskBudget.reserveBatch(taskBudgetScope, [{operationId: `product-replacement:${sha(input.idempotencyKey + ':' + operation)}`,
      fingerprint, provider, model, accountRef: accountId || 'unbound', stage: operation, shotId: input.shotId}]);
    await admission.reserve({scope: q.scope, tenantId: input.tenantId, taskId: input.taskId, version: Number(task.version), runId: task.run_id,
      session: q.scope.session, accountId: accountId, productId: productId, action: 'generate_media', provider, model, shotId: input.shotId,
      estimatedCostCny: q.amount, operationId: `product-replacement:${sha(input.idempotencyKey + ':' + operation)}`, fingerprint});
    return q.amount;
  };
  const originalBinding = (fingerprint: string, provider: string, model: string, operation?: string, attempt = 0) => {
    if (context.paidContext) {const bound=paid(stageFor(operation || (provider === 'seedream' ? 'first-frame' : provider === 'seedance' ? 'video' : 'video-qa')),attempt)!; return {paidOperationId:bound.intent.operationId, inputContractHash:bound.intent.inputContractHash};}
    const q = quote(fingerprint, provider, model);
    return {poolId: q.record.id, authorizationRef: q.scope.authorizationRef, scopeHash: sha(JSON.stringify(q.scope))};
  };
  const recoveryAmount = async (fingerprint: string, provider: string, model: string, operation: string, binding?: any, attempt = 0) => {
    if (context.paidContext && binding?.paidOperationId) {
      const bound=paid(stageFor(operation),attempt)!;
      if (binding?.paidOperationId !== bound.intent.operationId || binding.inputContractHash !== bound.intent.inputContractHash) throw Error('product_paid_original_funding_changed');
      const file=paidRequestFile(stageFor(operation),attempt);
      const claim=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
      if(!claim || claim.operationId!==bound.intent.operationId || claim.inputContractHash!==bound.intent.inputContractHash || !/^[a-f0-9]{64}$/.test(claim.requestSha256)) throw Error('product_paid_original_request_evidence_missing');
      await context.paidContext.assertRecovery(bound.intent.operationId);
      return paidAmount(stageFor(operation),attempt);
    }
    return readProductRecoveryFunding({budgetRoot, tenantId: input.tenantId, taskId: input.taskId, runId: String(task.run_id), shotId: input.shotId, productId, accountId, provider, model, fingerprint,
      binding, operationId: `product-replacement:${sha(input.idempotencyKey + ':' + operation)}`, wholeFilmEntries: taskBudget.status(taskBudgetScope)?.entries || []});
  };
  const readBytes = async (record: Row): Promise<Buffer> => {
    // Only canonical registered object keys; arbitrary caller URLs/paths are not read.
    const key = String(record.objectKey || record.videoFileId || '').trim();
    const expected = String(record.contentSha256 || record.contentHash || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw Error('product_replacement_registered_bytes_missing');
    let bytes: Buffer | undefined;
    if (key) {
      const mediaRoot = path.resolve(process.env.SOCIAL_CONTENT_MEDIA_ROOT || 'data/media');
      const localCandidate = record.videoFileId ? path.resolve(mediaRoot, key) : null;
      if (localCandidate && fs.existsSync(localCandidate)
        && fs.realpathSync(localCandidate).startsWith(fs.realpathSync(mediaRoot) + path.sep)) bytes = fs.readFileSync(localCandidate);
      else bytes = (await (context.download || objectStorageDownload)(key))?.buf;
    }
    else if (typeof record.url === 'string' && /^\/api\/overseas\/starter-198\/social-content\/files\/[A-Za-z0-9_-]{1,180}$/.test(record.url)) {
      const fileId = record.url.slice(record.url.lastIndexOf('/') + 1);
      if (context.readRegisteredFile) bytes = await context.readRegisteredFile({tenantId: input.tenantId, fileId, expectedSha256: expected});
      else {
        const registered = await findSocialContentFile({repository, tenantId: input.tenantId, fileId});
        if (!registered || registered.tenant_id !== input.tenantId || registered.content_sha256 !== expected
          || registered.usage !== 'source' || !String(registered.mime_type).startsWith('image/')) throw Error('product_replacement_registered_task_file_invalid');
        const result = await readSocialContentFile({repository, tenantId: input.tenantId, fileId, backendFilePort: context.backendFilePort});
        if (result.view.sha256 !== expected || result.view.size > MAX_SOCIAL_CONTENT_FILE_BYTES) throw Error('product_replacement_registered_task_file_invalid');
        if (result.backend) bytes = result.backend.buf;
        else if (result.localPath) bytes = fs.readFileSync(result.localPath);
        else if (result.object) {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of result.object.body) {size += chunk.length; if (size > result.view.size) throw Error('product_replacement_registered_task_file_size_changed'); chunks.push(Buffer.from(chunk));}
          bytes = Buffer.concat(chunks);
        }
        if (bytes?.length !== result.view.size) throw Error('product_replacement_registered_task_file_size_changed');
      }
    } else {
      // Enterprise product projection and execution must resolve the same media
      // authority. Preview workers keep canonical bytes outside the checkout;
      // resolving /media URLs against process.cwd() can select a stale namesake.
      const mediaRoot = path.resolve(process.env.SOCIAL_CONTENT_MEDIA_ROOT || 'data/media');
      const candidate = record.localPath || (typeof record.url === 'string' && record.url.startsWith('/media/')
        ? path.join(mediaRoot, decodeURIComponent(record.url.slice('/media/'.length))) : null);
      if (typeof candidate === 'string' && fs.existsSync(candidate)) {
        const actual = fs.realpathSync(candidate);
        if (actual.startsWith(fs.realpathSync(mediaRoot) + path.sep)) bytes = fs.readFileSync(actual);
      }
    }
    if (!bytes?.length || sha(bytes) !== expected) throw Error('product_replacement_registered_bytes_changed');
    return bytes;
  };
  const imageReference = (bytes: Buffer, role: FirstFrameReference['role']): FirstFrameReference => ({bytes, role, sha256: sha(bytes), mimeType: bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png'});
  let firstFrameEstimate = 0;
  const frameModel = process.env.SEEDREAM_IMAGE_MODEL || 'doubao-seedream-5-0-pro-260628';
  const videoModel = process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast-260128';
  const qaModel = input.materialRouting?.generation?.qaModel || process.env.QWEN_VL_MODEL || 'qwen3-vl-plus';
  return {
    evidenceDirectory: durableDirectory,
    canUseVideoAttempt: attempt => !context.paidContext || (hasProductPaidStage(context.paidContext, input.shotId, 'video', attempt)
      && hasProductPaidStage(context.paidContext, input.shotId, 'video_qa', attempt)),
    estimatedCostCny: () => context.paidContext ? productPaidReservedCostCny(context.paidContext, input.shotId) : +(taskBudget.status(taskBudgetScope)?.entries.filter(e => e.shotId === input.shotId && e.status !== 'rejected').reduce((total, e) => total + e.reservedMicros, 0) || 0) / 1e6,
    assertCurrent,
    composition: async () => {
      if (input.materialRouting?.generation?.method === 'enterprise_authored_product_first_frame_i2v') throw Error('authored_frame_must_not_read_reference_pixels');
      await assertCurrent();
      const sourceId = input.materialRouting!.generation!.referenceSourceId!.replace(/^system-reference:/, '');
      const source = await db.getById<Row>('trend_videos', sourceId);
      if (!source || (source.tenantId || source.tenant_id) !== input.tenantId) throw Error('product_reference_same_tenant_source_missing');
      const sourceUrl = source.sourceUrl || source.videoUrl || source.url;
      if (typeof sourceUrl !== 'string' || !sourceUrl) throw Error('product_reference_canonical_source_url_missing');
      const rows = await db.list<Row>('starter_social_inspiration_handoff_versions', {where: {tenant_id: input.tenantId}, perPage: 500});
      if (rows.totalItems > rows.items.length) throw Error('product_reference_usage_lookup_incomplete');
      const matches = rows.items.filter(r => {
        const h = json(r.payload);
        return r.tenant_id === input.tenantId && h?.source?.sourceUrl === sourceUrl && h.taskContext?.taskId === input.taskId
          && h.rights?.mayUseOriginalMedia === true && h.rights?.mayAdapt === true && socialRequestHash(h) === r.record_hash;
      });
      if (!matches.length) throw Error('product_reference_pixels_usage_missing_or_ambiguous');
      const semanticHashes = new Set(matches.map(row => {
        const payload = structuredClone(json(row.payload));
        if (payload?.rights) delete payload.rights.confirmedAt;
        return socialRequestHash(payload);
      }));
      if (semanticHashes.size !== 1) throw Error('product_reference_pixels_usage_missing_or_ambiguous');
      // Concurrent persistence of the same explicit user grant can create
      // timestamp-only duplicates. They carry identical authority; select the
      // newest immutable record deterministically while conflicting grants
      // remain fail-closed above.
      matches.sort((left, right) => String(right.created_at || right.created || '').localeCompare(String(left.created_at || left.created || '')) || String(right.id).localeCompare(String(left.id)));
      usageAuthority = {id: matches[0]!.id, hash: matches[0]!.record_hash};
      const bytes = await readBytes(source);
      fs.mkdirSync(input.outputDirectory, {recursive: true, mode: 0o700});
      const sourceFile = path.join(input.outputDirectory, `source-${sha(bytes)}.mp4`);
      const image = path.join(input.outputDirectory, `composition-${sha(bytes)}-${input.shotId}.png`);
      fs.writeFileSync(sourceFile, bytes, {mode: 0o600});
      const extracted = await runVisualFfmpeg(['-ss', String(input.spec.referenceStartSeconds || 0), '-i', sourceFile, '-frames:v', '1', '-y', image], false, {timeoutMs: 120000});
      if (!extracted.ok || !fs.existsSync(image)) throw Error('product_reference_actual_frame_extraction_failed');
      return {reference: imageReference(fs.readFileSync(image), 'source_composition'), usageEvidenceRef: `${usageAuthority.id}:${usageAuthority.hash}`};
    },
    products: async () => {
      await assertCurrent();
      const library = await (context.materials || readMaterialLibrary)(input.tenantId);
      const refs = input.materialRouting!.generation!.productImageRefs;
      if (refs.length < 1 || refs.length > 2) throw Error('product_replacement_bounded_QA_product_reference_count_unsupported');
      return Promise.all(refs.map(async id => {
        const record = library.items.find(r => {
          const groups = input.spec.productIdentity.groups.filter(g => g.referenceImageIds.includes(id));
          const refs = [r.productRef, ...(Array.isArray(r.productRefs) ? r.productRefs : [])].filter(v => typeof v === 'string');
          const associationMatches = r.productId ? r.productId === productId : groups.length > 0 && groups.some(g => refs.includes(g.productRef));
          return r.id === id && (r.tenantId || r.tenant_id) === input.tenantId && r.type === 'image' && r.scope !== 'shared' && groups.length > 0 && associationMatches;
        });
        if (!record || !productReferenceBound(input.referenceImages, id, record.contentSha256 || record.contentHash)) throw Error('product_KB_same_tenant_packaging_missing');
        const bytes=await readBytes(record);
        productAuthorities.set(id,{hash:sha(bytes),recordHash:socialRequestHash(record)});
        return imageReference(bytes, 'product_identity');
      }));
    },
    firstFrame: async request => {
      await assertCurrent();
      const fingerprint = firstFrameInputFingerprint(request, 'seedream', frameModel);
      const root = path.join(durableDirectory, 'first-frame-receipts');
      const receipt = path.join(root, `${fingerprint}.json`);
      const prior = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : null;
      if (prior && (prior.fingerprint !== fingerprint || !['generated', 'evaluated'].includes(prior.state))) throw Error('seedream_unknown_requires_original_receipt_reconciliation');
      const fundingFile = `${receipt}.funding.json`;
      const funding = fs.existsSync(fundingFile) ? JSON.parse(fs.readFileSync(fundingFile, 'utf8')) : undefined;
      const amount = prior ? await recoveryAmount(fingerprint, 'seedream', frameModel, 'first-frame', funding) : context.paidContext ? paidAmount('first_frame') : quote(fingerprint, 'seedream', frameModel).amount;
      if (!prior && !context.prepareFrame && !(process.env.SEEDREAM_API_KEY || process.env.SEEDANCE_API_KEY)) throw Error('product_replacement_seedream_not_configured');
      firstFrameEstimate = amount;
      if (prior?.state === 'evaluated') {
        const image = path.join(root, `${fingerprint}.png`);
        if (prior.model !== frameModel || prior.qaModel !== qaModel || !prior.providerRequestId || prior.tenantId !== request.tenantId
          || prior.projectId !== request.videoId || prior.shotId !== request.compositionId || !fs.existsSync(image)) throw Error('product_first_frame_original_scope_changed');
        const qaFundingFile = `${receipt}.qa-funding.json`;
        const qaFunding = fs.existsSync(qaFundingFile) ? JSON.parse(fs.readFileSync(qaFundingFile, 'utf8')) : undefined;
        await recoveryAmount(productReplacementOperationFingerprint('first-frame-qa', {fingerprint, qaModel}), 'qwen', qaModel, 'first-frame-qa', qaFunding);
        if (context.paidContext) await paid('first_frame_qa')!.completed(compactProviderReceipt('qwen', productReplacementOperationFingerprint('first-frame-qa', {fingerprint, qaModel})));
        const adaptedQuality=prior.quality?adaptSingletonProductFirstFrameQuality(prior.quality,input.spec):null;
        const adaptationReceipt=path.join(root,`${fingerprint}.singleton-adaptation.json`);
        if(adaptedQuality&&adaptedQuality!==prior.quality)fs.writeFileSync(adaptationReceipt,JSON.stringify({sourceReportId:prior.quality?.firstFrameQuality?.reportId,quality:adaptedQuality,policy:'single_enterprise_sku_functional_equivalent_v1'}),{mode:0o600});
        const bytes = fs.readFileSync(image);
        if (sha(bytes) !== prior.outputSha256) throw Error('seedream_original_bytes_changed');
        return {bytes, providerRequestId: prior.providerRequestId, model: prior.model, estimatedCostCny: amount, canProceedToVideo: adaptedQuality?.canProceedToVideo === true||prior.canProceedToVideo === true, evidenceRefs: [receipt,...(fs.existsSync(adaptationReceipt)?[adaptationReceipt]:[])]};
      }
      const result = await (context.prepareFrame || prepareTrustedStoryboardSeedream)({request, model: frameModel, estimatedCostCny: amount, root, productInfo: JSON.stringify(input.spec.productIdentity), execute: true, qaModel, beforeFrameSubmit: paid('first_frame') ? async body => {await beforePaidSubmit('first_frame',body);} : undefined, beforeQaSubmit: paid('first_frame_qa') ? async body => {await beforePaidSubmit('first_frame_qa',body);} : undefined}, {
        assertCurrent, reserve: async fp => {
          await reserve(fp, 'seedream', frameModel, 'first-frame');
          fs.mkdirSync(root, {recursive: true, mode: 0o700});
          fs.writeFileSync(fundingFile, JSON.stringify(originalBinding(fp, 'seedream', frameModel)), {mode: 0o600});
        },
        reserveQa: async fp => {
          const qaFingerprint = productReplacementOperationFingerprint('first-frame-qa', {fingerprint: fp, qaModel});
          await reserve(qaFingerprint, 'qwen', qaModel, 'first-frame-qa');
          fs.mkdirSync(root, {recursive: true, mode: 0o700});
          fs.writeFileSync(`${receipt}.qa-funding.json`, JSON.stringify(originalBinding(qaFingerprint, 'qwen', qaModel, 'first-frame-qa')), {mode: 0o600});
        },
      });
      if (context.paidContext && !('dryRun' in result)) {if (!prior || funding?.paidOperationId) await paid('first_frame')!.completed(`seedream:${result.providerRequestId}:${fingerprint}`); await paid('first_frame_qa')!.completed(compactProviderReceipt('qwen',productReplacementOperationFingerprint('first-frame-qa', {fingerprint, qaModel})));}
      if ('dryRun' in result) throw Error('product_first_frame_unexpected_dryrun');
      if (result.qaModel !== qaModel) throw Error('product_first_frame_QA_model_binding_changed');
      // Apply the same server-side single-SKU/static-first-frame policy on the
      // initial evaluation and on recovery. A first run must not pause merely
      // because a still image cannot prove a later contact action.
      const adaptedQuality=adaptSingletonProductFirstFrameQuality(result.quality,input.spec);
      const adaptationReceipt=path.join(root,`${fingerprint}.singleton-adaptation.json`);
      if(adaptedQuality!==result.quality)fs.writeFileSync(adaptationReceipt,JSON.stringify({sourceReportId:result.quality?.firstFrameQuality?.reportId,quality:adaptedQuality,policy:'single_enterprise_sku_functional_equivalent_v1'}),{mode:0o600});
      return {bytes: fs.readFileSync(result.filePath), providerRequestId: result.providerRequestId, model: result.model, estimatedCostCny: amount,
        canProceedToVideo: adaptedQuality?.canProceedToVideo === true||result.canProceedToVideo, evidenceRefs: [path.join(durableDirectory, 'first-frame-receipts', `${fingerprint}.json`),...(fs.existsSync(adaptationReceipt)?[adaptationReceipt]:[])]};
    },
    video: async request => {
      await assertCurrent();
      const videoPaid = paid('video', request.attempt ?? 0);
      if(input.materialRouting?.generation?.videoProvider==='wan'){
       if(!context.paidContext)throw Error('wan_whole_film_budget_context_missing');const bound=videoPaid!;
       const model=input.materialRouting.generation.videoModel;if(!model||bound.intent.provider!=='wan'||bound.intent.model!==model)throw Error('wan_frozen_provider_changed');
       const checkpointPath=path.join(durableDirectory,'wan',sha(request.requestId)+'.json'),media=checkpointPath+'.mp4';
       return withPaidOperationLock(path.join(durableDirectory,'.wan-locks'),sha(request.requestId),async()=>{
        const cp=()=>fs.existsSync(checkpointPath)?JSON.parse(fs.readFileSync(checkpointPath,'utf8')) as WanImageVideoCheckpoint:null;
        if(cp()?.status==='completed'&&fs.existsSync(media)){await context.paidContext!.assertRecovery(bound.intent.operationId);const bytes=fs.readFileSync(media);if(sha(bytes)!==cp()!.mediaSha256)throw Error('wan_completed_media_changed');await bound.completed('wan:'+cp()!.providerTaskId+':'+cp()!.mediaSha256);return {bytes,providerTaskId:cp()!.providerTaskId!,model,estimatedCostCny:paidAmount('video',request.attempt??0)};}
        const run=()=>executeWanImageVideo({model,firstFrame:request.firstFrame,mimeType:request.firstFrame[0]===0xff&&request.firstFrame[1]===0xd8?'image/jpeg':'image/png',prompt:request.prompt,durationSeconds:request.providerDurationSeconds,firstFrameSha256:sha(request.firstFrame),inputContractHash:bound.intent.inputContractHash},{transport:context.wanTransport,credentials:context.wanCredentials,assertCurrent,readCheckpoint:async()=>cp(),writeCheckpoint:async value=>{fs.mkdirSync(path.dirname(checkpointPath),{recursive:true,mode:0o700});const temp=checkpointPath+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,checkpointPath);},beforeSubmit:async body=>{await beforePaidSubmit('video',body,request.attempt??0);},assertRecovery:async()=>{await context.paidContext!.assertRecovery(bound.intent.operationId);}});
        let result=await run();const deadline=Date.now()+900000;while(result.status==='pending'&&Date.now()<deadline){await assertCurrent();await new Promise(resolve=>setTimeout(resolve,5000));result=await run();}
        if(result.status==='pending')throw Error('waiting_external:wan:'+result.providerTaskId);
        fs.writeFileSync(media,result.bytes,{mode:0o600});await bound.completed('wan:'+result.providerTaskId+':'+result.mediaSha256);return {bytes:result.bytes,providerTaskId:result.providerTaskId,model,estimatedCostCny:paidAmount('video',request.attempt??0)};
       });
      }

      const fingerprint = productReplacementOperationFingerprint('video', {...request, firstFrame: sha(request.firstFrame), checkpointPath: undefined, model: videoModel});
      return withPaidOperationLock(path.join(durableDirectory, '.video-locks'), fingerprint, async () => {
      const checkpointPath = path.join(durableDirectory, 'video', `${fingerprint}.json`);
      const attempt = `${checkpointPath}.attempt.json`, media = `${checkpointPath}.completed.mp4`;
      const prior = fs.existsSync(attempt) ? JSON.parse(fs.readFileSync(attempt, 'utf8')) : null;
      if (prior && prior.fingerprint !== fingerprint) throw Error('product_video_attempt_changed');
      if (prior?.state === 'completed') {
        const originalAmount = await recoveryAmount(fingerprint, 'seedance', videoModel, request.requestId, prior.funding);
        if (prior.model !== videoModel || prior.provider !== 'seedance' || prior.requestId !== request.requestId || !prior.providerTaskId || prior.estimatedCostCny !== originalAmount) throw Error('product_video_original_scope_changed');
        const bytes = fs.readFileSync(media);
        if (sha(bytes) !== prior.sha256) throw Error('product_video_completed_bytes_changed');
        if (fs.existsSync(checkpointPath) && JSON.parse(fs.readFileSync(checkpointPath, 'utf8')).taskId !== prior.providerTaskId) throw Error('product_video_original_task_changed');
        return {bytes, providerTaskId: prior.providerTaskId, model: videoModel, estimatedCostCny: prior.estimatedCostCny};
      }
      if (prior) {
        if (prior.model !== videoModel || prior.provider !== 'seedance' || prior.requestId !== request.requestId || prior.firstFrameSha256 !== sha(request.firstFrame)) throw Error('product_video_original_scope_changed');
        const checkpoint = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) : null;
        if (!checkpoint?.taskId || !checkpoint.reservationId || !Number.isFinite(checkpoint.reservedCny)) throw Error('product_video_submission_unknown_requires_original_receipt');
        if (prior.providerTaskId && prior.providerTaskId !== checkpoint.taskId) throw Error('product_video_original_task_changed');
        if (prior.providerKeySha256 !== sha(process.env.SEEDANCE_API_KEY || '')) throw Error('product_video_provider_account_changed');
      } else if (fs.existsSync(checkpointPath)) throw Error('product_video_checkpoint_without_attempt_identity');
      if (!prior) {
        const q = context.paidContext ? {amount:paidAmount('video',request.attempt??0)} : quote(fingerprint, 'seedance', videoModel);
        if (productReplacementExceedsInternalBudget(input.tenantId, q.amount + firstFrameEstimate, input.maximumCostCny)) throw Error('product_replacement_total_quote_exceeds_shot_budget');
        if (process.env.SEEDANCE_VIDEO_ENABLED !== 'true') throw Error('seedance_not_enabled');
      }
      if (!context.generateVideo && !process.env.SEEDANCE_API_KEY) throw Error('product_replacement_seedance_not_configured');
      const amount = prior ? await recoveryAmount(fingerprint, 'seedance', videoModel, request.requestId, prior.funding,request.attempt??0) : await reserve(fingerprint, 'seedance', videoModel, request.requestId,request.attempt??0);
      await assertCurrent();
      fs.mkdirSync(path.dirname(attempt), {recursive: true, mode: 0o700});
      if (prior && !prior.funding) throw Error('product_video_original_funding_binding_missing');
      const binding = {funding: prior ? prior.funding : originalBinding(fingerprint, 'seedance', videoModel,'video',request.attempt??0), fingerprint, provider: 'seedance', model: videoModel, requestId: request.requestId, firstFrameSha256: sha(request.firstFrame), providerKeySha256: sha(process.env.SEEDANCE_API_KEY || ''), estimatedCostCny: amount};
      fs.writeFileSync(attempt, JSON.stringify({...prior, ...binding, state: 'prepared'}), {mode: 0o600});
      let result;
      try { result = await (context.generateVideo || generateSeedanceConceptVideo)({tenantId: input.tenantId, apiKey: process.env.SEEDANCE_API_KEY || '', model: videoModel,
        prompt: request.prompt, durationSeconds: request.providerDurationSeconds, ratio: '9:16', resolution: '720p', idempotencyKey: request.requestId,
        beforeSubmit: videoPaid ? async body => {await beforePaidSubmit('video',body,request.attempt??0);} : undefined, timeoutMs: 900000, checkpointPath, firstFrameDataUrl: `data:image/png;base64,${request.firstFrame.toString('base64')}`}); } catch (error) {
        if (fs.existsSync(checkpointPath)) {
          const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
          if (checkpoint.taskId) fs.writeFileSync(attempt, JSON.stringify({...binding, state: 'accepted', providerTaskId: checkpoint.taskId}), {mode: 0o600});
        }
        throw error;
      }
      if(context.paidContext && (!prior || prior.funding?.paidOperationId)) await videoPaid!.completed(`seedance:${result.providerTaskId}:${sha(result.bytes)}`);
      fs.writeFileSync(media, result.bytes, {mode: 0o600});
      fs.writeFileSync(attempt, JSON.stringify({...binding, state: 'completed', providerTaskId: result.providerTaskId, sha256: sha(result.bytes), estimatedCostCny: amount}), {mode: 0o600});
      return {...result, estimatedCostCny: amount};
      });
    },
    quality: async request => {
      const qualityPaid = paid('video_qa', request.attempt ?? 0);
      const mediaSha256 = sha(fs.readFileSync(request.filePath));
      const fingerprint = productReplacementOperationFingerprint('video-qa', {mediaSha256, qaModel, directorScene: request.directorScene, products: request.productReferences.map(r => r.sha256)});
      const receipt = path.join(durableDirectory, 'video-qa', `${fingerprint}.json`);
      fs.mkdirSync(path.dirname(receipt), {recursive: true, mode: 0o700});
      if (fs.existsSync(receipt)) { const prior = JSON.parse(fs.readFileSync(receipt, 'utf8')); if (prior.fingerprint !== fingerprint || prior.mediaSha256 !== mediaSha256 || prior.model !== qaModel || !prior.quality) throw Error('product_video_qa_unknown'); await recoveryAmount(fingerprint, 'qwen', qaModel, 'video-qa', prior.funding,request.attempt??0); if(context.paidContext)await qualityPaid!.completed(compactProviderReceipt('qwen',fingerprint));return prior.quality; }
      await reserve(fingerprint, 'qwen', qaModel, 'video-qa', request.attempt ?? 0);
      const funding = originalBinding(fingerprint, 'qwen', qaModel, 'video-qa', request.attempt ?? 0);
      const frames: Array<{bytes: Buffer; timeLabel: string}> = [];
      const sampleTimes = request.productReferences.length === 1 ? [0.1, request.durationSeconds / 2, request.durationSeconds - 0.1] : [0.1, request.durationSeconds - 0.1];
      for (const [index, second] of sampleTimes.entries()) {
        const image = `${request.filePath}.${index}.png`;
        const extraction = await runVisualFfmpeg(['-ss', String(second), '-i', request.filePath, '-frames:v', '1', '-y', image], false, {timeoutMs: 120000});
        if (!extraction.ok) throw Error('product_video_qa_frame_extraction_failed');
        frames.push({bytes: fs.readFileSync(image), timeLabel: `actual-video-${index}`});
      }
      await assertCurrent();
      fs.writeFileSync(receipt, JSON.stringify({funding, fingerprint, state: 'prepared', model: qaModel, mediaSha256}), {mode: 0o600});
      const visual = await (context.inspectVisual || inspectStoryboardAigcFramesWithQwen)({model: qaModel, boundedPaidQa: true, paidSubmission: qualityPaid ? async body => {await beforePaidSubmit('video_qa',body,request.attempt??0);} : undefined, phase: 'video', sceneType: 'product',
        frames: frames.map(f => ({base64: f.bytes.toString('base64'), mimeType: 'image/png', timeLabel: f.timeLabel})),
        productReferences: request.productReferences.map((p, i) => ({base64: p.bytes.toString('base64'), mimeType: p.mimeType, timeLabel: `KB-package-${i}`})),
        environmentReferences: [{base64: request.firstFrame.toString('base64'), mimeType: 'image/png', timeLabel: 'approved-first-frame'}],
        storyboard: request.directorScene, productInfo: JSON.stringify(input.spec.productIdentity), onReceipt: raw => fs.writeFileSync(`${receipt}.provider.json`, JSON.stringify(raw), {mode: 0o600})});
      if (context.paidContext) await qualityPaid!.completed(compactProviderReceipt('qwen',fingerprint));
      const technical = await inspectStoryboardTechnicalFrames('video', frames);
      const report = applyStoryboardReplicationAutomation(buildStoryboardQaReport({phase: 'video', sceneType: 'product', hasProduct: true, hasNamedPerson: false,
        hasEnvironmentReference: true, hasContact: true, hasAction: true, observations: [...technical, ...visual], evidenceFrameLabels: frames.map(f => f.timeLabel)}));
      const pass = report.automatedPassed ? 1 : 0;
      const packagingVisibilityPassed = report.checks.packaging_visibility?.verdict === 'pass';
      const subjectVisibilityPassed = report.checks.subject_visibility?.verdict === 'pass';
      const quality = {productIdentitySimilarity: Object.fromEntries(input.spec.productIdentity.groups.map(g => [g.productRef, pass])), packagingVisibilityPassed, subjectVisibilityPassed, labelOcrExactMatch: pass === 1,
        sceneTopologyScore: pass, productSlotLayoutScore: pass, cameraTrajectoryScore: pass, evidenceRefs: [receipt, `${receipt}.provider.json`]};
      fs.writeFileSync(receipt, JSON.stringify({funding, fingerprint, state: 'completed', model: qaModel, mediaSha256, report, quality, humanApproved: false}), {mode: 0o600});
      return quality;
    },
  };
}

/** No supplier call or budget mutation. Uses the same canonical KB byte reader
 * as execution, including tenant, SKU, registered file and SHA verification. */
export async function readProductReplacementRequestBounds(input: Input, context: ProductReplacementEnvironmentContext = {}) {
  const ports = await createEnvironmentProductReplacementPorts(input, context);
  const products = await ports.products(input);
  const authored = input.materialRouting?.generation?.method === 'enterprise_authored_product_first_frame_i2v';
  const composition = authored ? null : await ports.composition(input);
  const compositionSha256 = composition?.reference.sha256 ?? null;
  await ports.assertCurrent();
  const firstFrameMaximumFrames = 1 + products.length + (authored ? 0 : 1);
  const videoCandidateFrames = products.length === 1 ? 3 : 2;
  return {firstFrameMaximumFrames, videoMaximumFrames: products.length + videoCandidateFrames + 1,
    compositionSha256, productSha256s: products.map(p => p.sha256), qaModel:input.materialRouting?.generation?.qaModel,videoProvider:input.materialRouting?.generation?.videoProvider,videoModel:input.materialRouting?.generation?.videoModel,providerDurationSeconds:input.materialRouting?.generation?.videoProvider==='wan'?(input.materialRouting.generation.videoModel==='wan2.2-i2v-flash'?5:Math.max(2,Math.ceil(input.spec.cameraLock.durationSeconds))):Math.max(4, Math.ceil(input.spec.cameraLock.durationSeconds)),
    evidenceRef: 'canonical-product-request-bounds:' + socialRequestHash({tenantId:input.tenantId,taskId:input.taskId,shotId:input.shotId,
      materialRouting:input.materialRouting,spec:input.spec,products:products.map(p=>p.sha256),compositionSha256,firstFrameMaximumFrames,videoCandidateFrames})};
}
