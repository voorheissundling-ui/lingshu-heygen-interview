import type { DataStore } from '../storage/datastore.js';
import type {
  ProductionAllowedCommand,
  ProductionBlocker,
  ProductionCostSummaryV1,
  ProductionIdentityGuarantee,
  ProductionIdentityLevel,
  ProductionInputRequirement,
  ProductionInputSummary,
  ProductionPipelinePhase,
  ProductionPipelinePhaseStatus,
  ProductionReadModelV1,
  ProductionReadStatus,
  ProductionRouteKind,
  ProductionRouteRef,
  ProductionShotReadModelV1,
  SocialAssetSupplyPlan,
  SocialContentAgentWorkflow,
  SocialContentTaskStatus,
} from '../../shared/contracts/socialContentWorkflow.js';
import { PRODUCTION_READ_MODEL_SCHEMA } from '../../shared/contracts/productionReadModel.js';
import type { ProductionCostQuote } from '../../shared/contracts/productionCostQuote.js';
import type { ProductionInputRequest } from '../../shared/contracts/productionInputRequest.js';
import { buildSceneCapabilitySignature } from '../../shared/sceneVisualContract.js';
import type { SocialProductionReceipt } from './socialContentProductionHandoff.js';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

function text(value: unknown, maximum = 500): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maximum) : '';
}

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? +parsed.toFixed(4) : null;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueBlockers(values: ProductionBlocker[]): ProductionBlocker[] {
  return [...new Map(values.map(item => [`${item.code}\u0000${item.inputId ?? ''}\u0000${item.message}`, item])).values()];
}

export interface CanonicalSocialStudioProject {
  id: string;
  version: string;
  status: string;
  title: string;
  slotIds: string[];
  sourceTaskVersions: string[];
}

export interface CanonicalSocialStudioProjectSelection {
  available: boolean;
  project: CanonicalSocialStudioProject | null;
  duplicateCount: number;
}

type StoredStudioProject = {
  id: string;
  tenant_id?: string;
  title?: unknown;
  status?: unknown;
  spec?: unknown;
  updated_at?: unknown;
  updated?: unknown;
  created_at?: unknown;
};

function studioProjectView(row: StoredStudioProject): CanonicalSocialStudioProject {
  const spec = record(row.spec);
  const slots = Array.isArray(spec.shootingSlots) ? spec.shootingSlots.map(record) : [];
  const digitalPlans = Array.isArray(spec.socialDigitalHumanPlans) ? spec.socialDigitalHumanPlans.map(record) : [];
  return {
    id: text(row.id, 200),
    version: text(row.updated_at ?? row.updated ?? row.created_at, 80),
    status: text(row.status, 80) || 'draft',
    title: text(row.title, 240) || '未命名制作项目',
    slotIds: unique(slots.map(item => text(item.slotId ?? item.id, 200))),
    sourceTaskVersions: unique(digitalPlans.map(item => text(item.sourceTaskVersion, 120))),
  };
}

function hasEstablishedStoryboard(row: StoredStudioProject): boolean {
  const spec = record(row.spec);
  return Object.keys(record(spec.storyboardAssignments)).length > 0;
}

/**
 * Resolve the server-persisted Studio project linked to a canonical social
 * task. Browser storage is never consulted. Multiple projects remain visible
 * as a conflict instead of silently becoming competing facts.
 */
export async function readCanonicalSocialStudioProject(input: {
  dataStore?: DataStore;
  tenantId: string;
  taskId: string;
}): Promise<CanonicalSocialStudioProjectSelection> {
  if (!input.dataStore) return { available: false, project: null, duplicateCount: 0 };
  try {
    const first = await input.dataStore.list<StoredStudioProject>('studio_projects', {
      where: { tenant_id: input.tenantId }, sort: '-updated_at', page: 1, perPage: 500,
    });
    if (!Array.isArray(first.items) || !Number.isFinite(first.totalItems) || first.totalItems > 10_000) {
      return { available: false, project: null, duplicateCount: 0 };
    }
    const rows = [...first.items];
    for (let page = 2; page <= first.totalPages; page += 1) {
      const next = await input.dataStore.list<StoredStudioProject>('studio_projects', {
        where: { tenant_id: input.tenantId }, sort: '-updated_at', page, perPage: 500,
      });
      rows.push(...next.items);
    }
    if (rows.some(item => text(item.tenant_id, 200) !== input.tenantId) || rows.length !== first.totalItems) {
      return { available: false, project: null, duplicateCount: 0 };
    }
    const candidates = rows.filter(item => {
      const spec = record(item.spec);
      return text(spec.socialContentTaskId, 200) === input.taskId && text(item.status, 80) !== 'template';
    }).sort((left, right) => Number(hasEstablishedStoryboard(right)) - Number(hasEstablishedStoryboard(left))
      || text(right.updated_at ?? right.updated).localeCompare(text(left.updated_at ?? left.updated))
      || text(left.id).localeCompare(text(right.id)));
    return {
      available: true,
      project: candidates[0] ? studioProjectView(candidates[0]) : null,
      duplicateCount: Math.max(0, candidates.length - 1),
    };
  } catch {
    return { available: false, project: null, duplicateCount: 0 };
  }
}

function routeKind(strategy: string | null, approach?: string | null): ProductionRouteKind {
  if (approach === 'shooting_plan') return 'user_capture';
  if (strategy === 'customer_real_asset' || strategy === 'licensed_stock_asset') return 'material_edit';
  if (strategy === 'authorized_digital_presenter') return 'digital_human';
  if (strategy === 'motion_graphics' || strategy === 'verified_fact_card') return 'motion_graphics';
  if (strategy === 'non_evidentiary_ai_visual') return 'aigc_visual';
  if (strategy === 'customer_product_image_animation') return 'product_composite';
  if (strategy === 'aigc_product_scene_replication') return 'product_scene';
  return 'unknown';
}

const ROUTE_LABELS: Record<ProductionRouteKind, string> = {
  material_edit: '素材剪辑',
  digital_human: '数字人口播',
  motion_graphics: '动态图文',
  aigc_visual: 'AIGC 补镜',
  product_composite: '真实产品合成',
  product_scene: '产品场景生成',
  user_capture: '用户实拍/输入',
  unknown: '待确定路线',
};

function routeRef(strategy: string | null, executable: boolean, reason: string | null, approach?: string | null): ProductionRouteRef {
  const kind = routeKind(strategy, approach);
  return { kind, sourceStrategy: strategy, label: ROUTE_LABELS[kind], executable, reason };
}

function inputSummary(items: ProductionInputRequirement[]): ProductionInputSummary {
  const deduped = [...new Map(items.map(item => [item.id, item])).values()];
  return {
    required: deduped.filter(item => item.required).map(item => item.id),
    missing: deduped.filter(item => item.required && ['missing', 'pending_confirmation'].includes(item.status)).map(item => item.id),
    items: deduped,
  };
}

function inputItem(input: Omit<ProductionInputRequirement, 'source'> & { source?: ProductionInputRequirement['source'] }): ProductionInputRequirement {
  return { ...input, source: input.source ?? 'execution_plan' };
}

function blockerForInput(item: ProductionInputRequirement): ProductionBlocker | null {
  if (!item.required || !['missing', 'pending_confirmation'].includes(item.status)) return null;
  return {
    code: `input_${item.kind}_${item.status}`,
    message: item.reason || `${item.label}尚未完成`,
    recoverable: true,
    inputId: item.id,
  };
}

function selectedCandidate(scene: SocialContentAgentWorkflow['executionPlan']['scenes'][number]) {
  const candidateIds = new Set(scene.recommendedCandidateIds);
  return scene.candidates.find(candidate => candidateIds.has(candidate.candidateId)) ?? null;
}

function productReferenceReady(scene: SocialContentAgentWorkflow['executionPlan']['scenes'][number]): boolean {
  return Boolean(scene.productSceneReplication?.productIdentity.groups.some(group => group.referenceImageIds.length > 0));
}

function identityLevelRank(value: ProductionIdentityLevel): number {
  return ({
    not_required: 0,
    exact_source: 1,
    locked_reference: 2,
    qa_gated: 3,
    generic_only: 4,
    unverified: 5,
  } satisfies Record<ProductionIdentityLevel, number>)[value];
}

function aggregateIdentity(rows: ProductionIdentityGuarantee[]): ProductionIdentityGuarantee {
  const levels = rows.flatMap(row => [row.product, row.presenter]).filter(level => level !== 'not_required');
  const overall = levels.sort((left, right) => identityLevelRank(right) - identityLevelRank(left))[0] ?? 'not_required';
  const worst = (key: 'product' | 'presenter') => rows.map(row => row[key])
    .sort((left, right) => identityLevelRank(right) - identityLevelRank(left))[0] ?? 'not_required';
  return {
    overall,
    product: worst('product'),
    presenter: worst('presenter'),
    requiresQa: rows.some(row => row.requiresQa),
    basis: unique(rows.flatMap(row => row.basis)),
  };
}

function shotIdentity(input: {
  scene: SocialContentAgentWorkflow['executionPlan']['scenes'][number];
  directorScene: SocialContentAgentWorkflow['directorBrief']['scenes'][number] | undefined;
  selectedStrategy: string;
  workflow: SocialContentAgentWorkflow;
}): ProductionIdentityGuarantee {
  const capability = input.directorScene?.visualContract
    ? buildSceneCapabilitySignature(input.directorScene.visualContract) : null;
  const productRequired = Boolean(input.scene.productSceneReplication
    || ['customer_product_image_animation', 'aigc_product_scene_replication'].includes(input.selectedStrategy)
    || input.directorScene?.visualTopic?.kind === 'product_introduction'
    || capability?.requiresProductIdentity);
  const presenterRequired = Boolean(input.directorScene?.productionRouting?.presenterIdentityReplacementRequired
    || input.selectedStrategy === 'authorized_digital_presenter');
  let product: ProductionIdentityLevel = productRequired ? 'unverified' : 'not_required';
  let presenter: ProductionIdentityLevel = presenterRequired ? 'unverified' : 'not_required';
  const basis: string[] = [];
  const candidate = selectedCandidate(input.scene);
  if (input.selectedStrategy === 'customer_product_image_animation' && productRequired) {
    product = candidate?.sourceRef ? 'exact_source' : 'unverified';
    basis.push(candidate?.sourceRef ? '采用企业真实产品图片合成' : '尚未绑定真实产品图片');
  } else if (input.selectedStrategy === 'aigc_product_scene_replication' && productRequired) {
    product = productReferenceReady(input.scene) ? 'qa_gated' : 'unverified';
    basis.push(productReferenceReady(input.scene) ? '产品参考已锁定，生成后仍需身份与 OCR 质检' : '缺少产品身份参考图');
  } else if (input.selectedStrategy === 'customer_real_asset' && productRequired) {
    const requestedId = text(input.workflow.directorBrief.contentRequirements?.product.productId);
    const requestedRef = text(input.workflow.directorBrief.contentRequirements?.product.productRef).normalize('NFKC').toLocaleLowerCase();
    const candidateRef = text(candidate?.productRef).normalize('NFKC').toLocaleLowerCase();
    product = candidate && ((requestedId && candidate.productId === requestedId) || (requestedRef && candidateRef === requestedRef))
      ? 'exact_source' : 'unverified';
    basis.push(product === 'exact_source' ? '采用与任务产品匹配的真实素材' : '真实素材尚未证明与锁定产品一致');
  } else if (input.selectedStrategy === 'licensed_stock_asset' && productRequired) {
    product = 'generic_only';
    basis.push('公共素材只承担通用场景，不保证产品身份');
  } else if (input.selectedStrategy === 'non_evidentiary_ai_visual' && productRequired) {
    product = 'generic_only';
    basis.push('通用 AIGC 只承担非证据画面');
  } else if (['motion_graphics', 'verified_fact_card'].includes(input.selectedStrategy) && productRequired) {
    product = 'not_required';
    basis.push('功能替代不展示需要核验的产品实物身份');
  }
  if (input.selectedStrategy === 'authorized_digital_presenter' && presenterRequired) {
    presenter = input.workflow.executionPlan.accountPresenterLock ? 'locked_reference' : 'unverified';
    basis.push(presenter === 'locked_reference' ? '账号已发布数字人身份版本已锁定' : '尚未锁定账号数字人身份版本');
  } else if (presenterRequired && input.selectedStrategy === 'customer_real_asset') {
    presenter = 'exact_source';
    basis.push('采用已授权真实人物素材');
  }
  const levels = [product, presenter].filter(level => level !== 'not_required');
  const overall = levels.sort((left, right) => identityLevelRank(right) - identityLevelRank(left))[0] ?? 'not_required';
  return { overall, product, presenter, requiresQa: ['qa_gated', 'locked_reference'].includes(overall), basis: unique(basis) };
}

function shotInputs(input: {
  scene: SocialContentAgentWorkflow['executionPlan']['scenes'][number];
  directorScene: SocialContentAgentWorkflow['directorBrief']['scenes'][number] | undefined;
  supplyShot: SocialAssetSupplyPlan['shots'][number] | undefined;
  workflow: SocialContentAgentWorkflow;
  approach: string | null;
  external: ProductionInputRequirement[];
}): ProductionInputSummary {
  const items: ProductionInputRequirement[] = [...input.external];
  const candidate = selectedCandidate(input.scene);
  if (input.approach === 'shooting_plan') {
    const shootingMediaProvided = input.external.some(item => item.kind === 'shooting_media' && item.status === 'provided');
    items.push(inputItem({ id: `${input.scene.sceneId}:shooting_media`, kind: 'shooting_media', label: '按清单提供实拍镜头',
      required: true, status: shootingMediaProvided ? 'provided' : 'missing',
      reason: shootingMediaProvided ? null : '当前路线输出代拍清单，成片制作需回传对应镜头素材', source: 'canonical_task' }));
  } else if (['customer_real_asset', 'licensed_stock_asset'].includes(input.scene.selectedSourceStrategy)) {
    items.push(inputItem({ id: `${input.scene.sceneId}:material`, kind: 'material', label: '可用素材片段', required: true,
      status: candidate?.sourceRef || input.supplyShot?.sourceRefs.length ? 'provided' : 'missing',
      reason: candidate?.sourceRef || input.supplyShot?.sourceRefs.length ? null : '当前镜头没有已绑定且可执行的素材片段' }));
  }
  if (['customer_product_image_animation', 'aigc_product_scene_replication'].includes(input.scene.selectedSourceStrategy)) {
    const ready = input.scene.selectedSourceStrategy === 'aigc_product_scene_replication'
      ? productReferenceReady(input.scene)
      : Boolean(candidate?.sourceRef || input.supplyShot?.sourceRefs.length);
    items.push(inputItem({ id: `${input.scene.sceneId}:product_asset`, kind: 'product_asset', label: '真实产品参考图', required: true,
      status: ready ? 'provided' : 'missing', reason: ready ? null : '缺少可锁定真实产品身份的参考图' }));
  }
  if (input.scene.selectedSourceStrategy === 'authorized_digital_presenter') {
    const ready = Boolean(input.workflow.executionPlan.accountPresenterLock
      || input.supplyShot?.digitalHumanPlan?.presenterAssetIds.length);
    items.push(inputItem({ id: `${input.scene.sceneId}:presenter_asset`, kind: 'presenter_asset', label: '账号数字人身份', required: true,
      status: ready ? 'provided' : 'missing', reason: ready ? null : '缺少已授权且已发布的账号数字人身份版本' }));
  }
  const review = input.workflow.executionPlanReview.sceneResults.find(item => item.sceneId === input.scene.sceneId);
  if (review?.reasonCodes.includes('budget_exceeded')) {
    items.push(inputItem({ id: `${input.scene.sceneId}:budget`, kind: 'budget_confirmation', label: '预算确认', required: true,
      status: 'pending_confirmation', reason: review.requiredRevision.join('；') || '预计费用超过当前单条预算' }));
  }
  if (input.workflow.executionPlanReview.reasonCodes.includes('facts_missing')) {
    items.push(inputItem({ id: `${input.scene.sceneId}:facts`, kind: 'fact_confirmation', label: '事实确认', required: true,
      status: 'pending_confirmation', reason: '当前内容存在尚未确认的企业或产品事实' }));
  }
  if (input.workflow.executionPlanReview.reasonCodes.includes('rights_missing')) {
    items.push(inputItem({ id: `${input.scene.sceneId}:rights`, kind: 'rights_confirmation', label: '授权确认', required: true,
      status: 'pending_confirmation', reason: '当前镜头需要补充可核验的使用授权' }));
  }
  if (input.directorScene?.referenceMaterial
    && input.directorScene.referenceMaterial.extractionStatus !== 'ready'
    && input.directorScene.referenceMaterial.isPrimaryHook) {
    items.push(inputItem({ id: `${input.scene.sceneId}:reference_media`, kind: 'reference_media', label: '参考镜头证据', required: true,
      status: 'missing', reason: '关键参考镜头尚未完成首帧或片段提取' }));
  }
  return inputSummary(items);
}

function shotCost(scene: SocialContentAgentWorkflow['executionPlan']['scenes'][number], kind: ProductionRouteKind): ProductionCostSummaryV1 {
  const expected = money(scene.estimatedCostCny);
  const candidate = selectedCandidate(scene);
  const attempts = Math.max(1, Math.min(5, Number(candidate?.retryPolicy.maxAttempts) || 1));
  const upperBound = expected === null ? null : +(expected * attempts).toFixed(4);
  return {
    currency: 'CNY',
    expectedCny: expected,
    upperBoundCny: upperBound,
    actualCny: null,
    unsettledCny: null,
    status: expected === null ? 'unknown' : expected === 0 ? 'free' : 'estimated',
    reusable: ['material_edit', 'motion_graphics', 'product_composite'].includes(kind),
    basis: expected === null ? 'unavailable' : 'execution_plan',
  };
}

function latestReceipt(receipts: SocialProductionReceipt[], sceneId: string): SocialProductionReceipt | null {
  return receipts.filter(item => item.gate === 'G4' && item.sceneId === sceneId)
    .sort((left, right) => right.attempt - left.attempt || right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function stageStatus(stage: string, taskStatus: SocialContentTaskStatus): ProductionReadStatus | null {
  if (stage === 'rendering') return 'rendering';
  if (['quality_check', 'media_evaluation', 'creative_review'].includes(stage)) return 'quality_review';
  if (stage === 'review_ready') return 'review_ready';
  if (stage === 'waiting_for_user_input') return 'needs_input';
  if (stage === 'automatic_recovery_exhausted') return 'failed';
  if (['asset_supply_completed', 'content_production', 'director_planning', 'execution_plan_approved', 'presenter_stack_selection'].includes(stage)) return 'running';
  if (taskStatus === 'paused') return 'paused';
  if (taskStatus === 'attention') return 'failed';
  if (taskStatus === 'asset_review') return 'review_ready';
  if (taskStatus === 'packaging') return 'rendering';
  if (['delivered', 'awaiting_publish', 'awaiting_metrics', 'reviewed'].includes(taskStatus)) return 'completed';
  if (taskStatus === 'producing') return 'running';
  if (taskStatus === 'needs_input') return 'needs_input';
  return null;
}

function shotStatus(input: {
  taskStatus: SocialContentTaskStatus;
  stage: string;
  inputs: ProductionInputSummary;
  blockers: ProductionBlocker[];
  reviewApproved: boolean;
  resultPresent: boolean;
  receipt: SocialProductionReceipt | null;
}): ProductionReadStatus {
  if (input.receipt?.status === 'failed') return 'failed';
  if (input.receipt?.status === 'review_required') return 'quality_review';
  if (input.receipt?.status === 'passed' && ['delivered', 'awaiting_publish', 'awaiting_metrics', 'reviewed'].includes(input.taskStatus)) return 'completed';
  if (input.resultPresent) return 'review_ready';
  const active = stageStatus(input.stage, input.taskStatus);
  // Required canonical inputs are execution gates. A stale task/stage value
  // must not make a shot look active after a new blocking request is opened.
  // Terminal failure/completion still wins because it describes an already
  // recorded outcome rather than an in-flight attempt.
  if (input.inputs.missing.length && !['completed', 'failed'].includes(active ?? '')) return 'needs_input';
  if (active && ['running', 'rendering', 'quality_review', 'review_ready', 'completed', 'paused', 'failed'].includes(active)) return active;
  if (input.blockers.length || !input.reviewApproved) return 'blocked';
  return input.reviewApproved ? 'ready' : 'planning';
}

function commandsForShot(input: {
  shot: Omit<ProductionShotReadModelV1, 'allowedCommands'>;
  taskStatus: SocialContentTaskStatus;
}): ProductionAllowedCommand[] {
  const commands: ProductionAllowedCommand[] = [];
  if (input.shot.slotId) commands.push('open_shot');
  if (!['running', 'rendering', 'quality_review', 'completed'].includes(input.shot.status)) {
    if (input.shot.route.recommended.kind === 'material_edit') commands.push('select_material');
    if (input.shot.inputs.items.some(item => item.kind === 'product_asset' && item.status !== 'provided')) commands.push('upload_product_asset');
    if (input.shot.inputs.items.some(item => item.kind === 'presenter_asset' && item.status !== 'provided')) commands.push('select_presenter');
    if (input.shot.inputs.items.some(item => item.kind === 'fact_confirmation' && item.status !== 'provided')) commands.push('confirm_facts');
    if (input.shot.inputs.items.some(item => item.kind === 'rights_confirmation' && item.status !== 'provided')) commands.push('confirm_rights');
    if (input.shot.inputs.items.some(item => item.kind === 'budget_confirmation' && item.status !== 'provided')) commands.push('confirm_budget');
    if (input.shot.inputs.items.some(item => item.kind === 'account_authorization'
      && item.status !== 'provided' && item.status !== 'not_applicable')) commands.push('connect_account');
    if (input.shot.inputs.items.some(item => item.kind === 'production_choice'
      && item.status !== 'provided' && item.status !== 'not_applicable')) commands.push('confirm_production_choice');
    if (input.shot.route.fallbacks.length) commands.push('use_fallback');
    const hasExecutableSystemRoute = (input.shot.route.recommended.kind !== 'user_capture'
      && input.shot.route.recommended.executable)
      || input.shot.route.fallbacks.some(route => route.kind !== 'user_capture' && route.executable);
    // A missing product/fact/rights input is not evidence that the system
    // production route is unavailable. Ask for that minimum input first and
    // expose shooting only after the route truly has no executable system
    // candidate (or the canonical plan explicitly selected user capture).
    if (input.shot.route.recommended.kind === 'user_capture'
      || (!hasExecutableSystemRoute && input.shot.inputs.missing.length === 0)) {
      commands.push('request_shoot');
    }
  }
  if (input.shot.executable && input.shot.status === 'ready' && ['draft', 'needs_input', 'plan_review', 'paused', 'attention'].includes(input.taskStatus)) commands.push('generate');
  if (['failed', 'paused'].includes(input.shot.status)) commands.push('retry');
  if (['quality_review', 'review_ready'].includes(input.shot.status)) commands.push('review_output');
  if (input.shot.status === 'review_ready' && input.shot.blockers.length === 0) commands.push('approve_output');
  return unique(commands);
}

function aggregateCost(
  shots: ProductionShotReadModelV1[],
  artifactCost: unknown,
  costQuote?: ProductionCostQuote | null,
): ProductionCostSummaryV1 {
  const row = record(artifactCost);
  const expectedFromReceipt = money(row.estimatedBeforeGenerationCny);
  const expectedFromQuote = money(costQuote?.expectedCostCny);
  const expected = expectedFromQuote ?? expectedFromReceipt ?? (shots.length > 0
    && shots.every(shot => shot.cost.expectedCny !== null)
    ? +shots.reduce((sum, shot) => sum + (shot.cost.expectedCny ?? 0), 0).toFixed(4) : null);
  const upperBoundFromQuote = money(costQuote?.upperBoundCostCny);
  const upperBound = upperBoundFromQuote ?? (shots.length > 0
    && shots.every(shot => shot.cost.upperBoundCny !== null)
    ? +shots.reduce((sum, shot) => sum + (shot.cost.upperBoundCny ?? 0), 0).toFixed(4) : null);
  const settlement = text(row.settlementStatus, 80);
  const quoteActual = money(costQuote?.actualCostCny);
  const actual = quoteActual ?? (settlement ? money(row.actualProviderCostCny) : null);
  const unsettled = settlement ? money(row.estimatedUnsettledProviderCostCny) : null;
  const quoteStatus = text(costQuote?.status, 80);
  const status: ProductionCostSummaryV1['status'] = quoteStatus === 'settled' ? 'settled'
    : quoteStatus === 'reserved' || quoteStatus === 'quoted' ? 'estimated'
      : quoteStatus === 'overrun' ? 'partially_settled'
        : quoteStatus === 'failed' ? 'unknown'
          : settlement === 'settled' ? 'settled'
            : settlement === 'partially_settled' ? 'partially_settled'
              : settlement === 'estimated' ? 'estimated'
                : settlement === 'unknown' ? 'unknown'
                  : expected === null ? 'unknown' : expected === 0 ? 'free' : 'estimated';
  const hasRecordedCost = Boolean(settlement) || quoteActual !== null;
  return {
    currency: 'CNY', expectedCny: expected, upperBoundCny: upperBound,
    actualCny: actual, unsettledCny: unsettled, status,
    reusable: costQuote?.lines.length
      ? costQuote.lines.every(line => line.reused)
      : shots.length > 0 && shots.every(shot => shot.cost.reusable),
    basis: hasRecordedCost
      ? (expected !== null ? 'mixed' : 'provider_receipt')
      : expected !== null ? 'execution_plan' : 'unavailable',
  };
}

function aggregateStatus(input: {
  taskStatus: SocialContentTaskStatus;
  stage: string;
  shots: ProductionShotReadModelV1[];
}): ProductionReadStatus {
  const active = stageStatus(input.stage, input.taskStatus);
  if (active && ['completed', 'failed'].includes(active)) return active;
  if (input.shots.some(shot => shot.status === 'needs_input')) return 'needs_input';
  if (active) return active;
  if (!input.shots.length) return 'planning';
  if (input.shots.some(shot => shot.status === 'failed')) return 'failed';
  if (input.shots.some(shot => shot.status === 'blocked')) return 'blocked';
  if (input.shots.some(shot => shot.status === 'quality_review')) return 'quality_review';
  if (input.shots.some(shot => shot.status === 'review_ready')) return 'review_ready';
  if (input.shots.every(shot => shot.status === 'completed')) return 'completed';
  if (input.shots.every(shot => shot.status === 'ready')) return 'ready';
  return 'planning';
}

function currentPhase(status: ProductionReadStatus): ProductionPipelinePhase {
  if (status === 'needs_input') return 'input';
  if (['running', 'paused', 'failed'].includes(status)) return 'production';
  if (status === 'rendering') return 'render';
  if (status === 'quality_review') return 'qa';
  if (['review_ready', 'completed'].includes(status)) return 'review';
  return 'planning';
}

function phases(status: ProductionReadStatus, shots: ProductionShotReadModelV1[]): Array<{ phase: ProductionPipelinePhase; status: ProductionPipelinePhaseStatus }> {
  const order: ProductionPipelinePhase[] = ['planning', 'input', 'production', 'render', 'qa', 'review'];
  const active = currentPhase(status);
  const activeIndex = order.indexOf(active);
  const blocked = ['needs_input', 'blocked', 'failed', 'paused'].includes(status);
  return order.map((phase, index) => ({
    phase,
    status: status === 'completed' ? 'completed'
      : index < activeIndex ? 'completed'
        : index > activeIndex ? 'pending'
          : blocked ? 'blocked'
            : status === 'planning' && !shots.length ? 'active'
              : 'active',
  }));
}

function statusCounts(shots: ProductionShotReadModelV1[]) {
  return {
    total: shots.length,
    ready: shots.filter(shot => shot.status === 'ready').length,
    running: shots.filter(shot => ['running', 'rendering'].includes(shot.status)).length,
    needsInput: shots.filter(shot => shot.status === 'needs_input').length,
    blocked: shots.filter(shot => ['blocked', 'failed', 'paused'].includes(shot.status)).length,
    review: shots.filter(shot => ['quality_review', 'review_ready'].includes(shot.status)).length,
    completed: shots.filter(shot => shot.status === 'completed').length,
  };
}

export interface ProductionReadInputRequest extends ProductionInputRequirement {
  shotId?: string | null;
}

/**
 * Cost is scoped to an execution run, not merely to a long-lived task. Quote
 * lists are newest-first, so the first exact task/run match is authoritative.
 */
export function selectProductionCostQuoteForRun(input: {
  quotes: ProductionCostQuote[];
  taskId: string;
  runId: string | null;
}): ProductionCostQuote | null {
  if (!input.runId) return null;
  return input.quotes.find(quote => quote.taskId === input.taskId && quote.runId === input.runId) ?? null;
}

function projectedInputKind(request: ProductionInputRequest): ProductionInputRequirement['kind'] {
  if (request.category === 'product_asset') return 'product_asset';
  if (request.category === 'fact_evidence') return 'fact_confirmation';
  if (request.category === 'person_authorization') return 'rights_confirmation';
  if (request.category === 'account_authorization') return 'account_authorization';
  if (request.category === 'production_choice' || request.kind === 'content_clarification') {
    return 'production_choice';
  }
  if (request.category === 'scene_plate') return 'reference_media';
  if (request.category === 'digital_human_input') return 'presenter_asset';
  return 'other';
}

/** Convert durable system-wide input requests into shot/task read-model rows. */
export function projectProductionInputRequests(
  requests: ProductionInputRequest[],
  taskId?: string,
): ProductionReadInputRequest[] {
  return requests.flatMap(request => {
    const status: ProductionInputRequirement['status'] = request.status === 'fulfilled'
      ? 'provided'
      : request.status === 'waived' ? 'not_applicable' : 'missing';
    const matchingBindings = taskId
      ? request.bindings.filter(binding => binding.taskId === taskId)
      : request.bindings;
    if (taskId && request.bindings.length && !matchingBindings.length) return [];
    const bindings = matchingBindings.length ? matchingBindings : [{ taskId: taskId ?? '', shotId: null }];
    return bindings.map((binding, index) => ({
      id: bindings.length === 1 ? request.id : `${request.id}:${binding.shotId ?? index}`,
      kind: projectedInputKind(request),
      label: request.title,
      required: request.required && request.status !== 'waived',
      status,
      reason: status === 'provided' || status === 'not_applicable'
        ? null : request.instructions || '生产所需输入尚未满足',
      source: 'canonical_task' as const,
      shotId: binding.shotId ?? null,
    }));
  });
}

export function buildSocialContentProductionReadModel(input: {
  task: {
    taskId: string;
    version: string;
    status: SocialContentTaskStatus;
    runId: string | null;
    updatedAt: string;
    title: string;
    readinessMissing?: string[];
    productionApproach?: string | null;
  };
  workflow: SocialContentAgentWorkflow | null;
  assetSupplyPlan?: SocialAssetSupplyPlan | null;
  studio: CanonicalSocialStudioProjectSelection;
  productionStage?: { stage: string; message?: string | null; updatedAt?: string | null } | null;
  receipts?: SocialProductionReceipt[];
  artifactCost?: unknown;
  costQuote?: ProductionCostQuote | null;
  inputRequests?: ProductionReadInputRequest[];
}): ProductionReadModelV1 {
  const workflow = input.workflow;
  const costQuote = selectProductionCostQuoteForRun({
    quotes: input.costQuote ? [input.costQuote] : [],
    taskId: input.task.taskId,
    runId: input.task.runId,
  });
  const stage = text(input.productionStage?.stage, 120);
  const approach = text(input.task.productionApproach, 80) || workflow?.executionPlan.selectedApproach || null;
  const directorById = new Map(workflow?.directorBrief.scenes.map(scene => [scene.sceneId, scene]) ?? []);
  const supplyById = new Map(input.assetSupplyPlan?.shots.map(shot => [shot.shotId, shot]) ?? []);
  const resultById = new Map(workflow?.productionResult?.sceneResults.map(scene => [scene.sceneId, scene]) ?? []);
  const reviewById = new Map(workflow?.executionPlanReview.sceneResults.map(scene => [scene.sceneId, scene]) ?? []);
  const slotIds = input.studio.project?.slotIds ?? [];
  const receipts = input.receipts ?? [];
  const external = input.inputRequests ?? [];
  const shots = (workflow?.executionPlan.scenes ?? []).map((scene, index): ProductionShotReadModelV1 => {
    const result = resultById.get(scene.sceneId);
    const selectedStrategy = result?.sourceStrategy ?? scene.selectedSourceStrategy;
    const review = reviewById.get(scene.sceneId);
    const directorScene = directorById.get(scene.sceneId);
    const supplyShot = supplyById.get(scene.sceneId) ?? input.assetSupplyPlan?.shots[index];
    const shotInput = shotInputs({ scene, directorScene, supplyShot, workflow: workflow!, approach,
      external: external.filter(item => !item.shotId || item.shotId === scene.sceneId) });
    const blockers = uniqueBlockers([
      ...shotInput.items.map(blockerForInput).filter((item): item is ProductionBlocker => Boolean(item)),
      ...(review?.approved === false ? review.failedCriteria.map((message, blockerIndex) => ({
        code: `execution_review_${review.reasonCodes[blockerIndex] ?? blockerIndex + 1}`,
        message, recoverable: true, inputId: null,
      })) : []),
      ...(scene.feasibility === 'blocked_for_facts_or_rights' && !review?.failedCriteria.length ? [{
        code: 'route_not_executable', message: scene.feasibilityReason, recoverable: true, inputId: null,
      }] : []),
    ]);
    const candidate = selectedCandidate(scene);
    const routeGateOpen = approach !== 'shooting_plan'
      && scene.feasibility !== 'blocked_for_facts_or_rights'
      && shotInput.missing.length === 0
      && review?.approved !== false;
    const routeExecutable = Boolean(candidate) && routeGateOpen;
    const recommended = routeRef(scene.selectedSourceStrategy, routeExecutable, scene.feasibilityReason, approach);
    const selected = result ? routeRef(selectedStrategy, true, '已由生产结果确认采用', approach) : null;
    const fallbackStrategies = unique([
      ...(scene.fallbackSourceStrategy ? [scene.fallbackSourceStrategy] : []),
      ...(candidate?.retryPolicy.fallbackStrategies ?? []),
    ]);
    const fallbackRoutes = fallbackStrategies.map(strategy => {
      const fallbackCandidate = scene.candidates.find(item => item.sourceStrategy === strategy);
      const executable = Boolean(fallbackCandidate) && routeGateOpen;
      return routeRef(strategy, executable, executable
        ? '已有当前栈候选；切换后仍需重新通过输入、预算与运行时门禁'
        : '当前执行计划没有可执行候选；需重新规划后才能切换');
    });
    const receipt = latestReceipt(receipts, scene.sceneId);
    const status = shotStatus({ taskStatus: input.task.status, stage, inputs: shotInput, blockers,
      reviewApproved: review?.approved === true, resultPresent: Boolean(result), receipt });
    const base: Omit<ProductionShotReadModelV1, 'allowedCommands'> = {
      shotId: scene.sceneId,
      slotId: slotIds.includes(scene.sceneId) ? scene.sceneId : slotIds[index] ?? null,
      order: directorScene?.order ?? index + 1,
      title: text(directorScene?.targetVisual, 240) || text(scene.routeDecision?.visualTopic?.subject, 240) || `镜头 ${index + 1}`,
      route: { selected, recommended, fallbacks: fallbackRoutes },
      status,
      executable: routeExecutable,
      identityGuarantee: shotIdentity({ scene, directorScene, selectedStrategy, workflow: workflow! }),
      inputs: shotInput,
      cost: shotCost(scene, recommended.kind),
      blockers,
    };
    return { ...base, allowedCommands: commandsForShot({ shot: base, taskStatus: input.task.status }) };
  });
  const projectBlockers: ProductionBlocker[] = [
    ...(input.studio.duplicateCount > 0 ? [{ code: 'studio_project_conflict',
      message: `同一任务存在 ${input.studio.duplicateCount + 1} 个制作项目，请先确认唯一项目`, recoverable: true, inputId: null }] : []),
    ...(input.studio.project?.sourceTaskVersions.length
      && !input.studio.project.sourceTaskVersions.includes(input.task.version) ? [{ code: 'studio_project_stale',
        message: 'Studio 制作项目仍引用旧任务版本，请从当前任务刷新后再执行', recoverable: true, inputId: null }] : []),
    ...(!input.studio.available ? [{ code: 'studio_projection_unavailable',
      message: '暂时无法读取 Studio 项目关联；任务事实仍以服务端 canonical task 为准', recoverable: true, inputId: null }] : []),
  ];
  const readinessInputs = (input.task.readinessMissing ?? []).map(item => inputItem({
    id: `task:${item}`, kind: 'other', label: item, required: true, status: 'missing',
    reason: `任务仍缺少必要输入：${item}`, source: 'canonical_task',
  }));
  const aggregateInputs = inputSummary([
    ...shots.flatMap(shot => shot.inputs.items),
    ...external.filter(item => !item.shotId),
    ...readinessInputs,
  ]);
  const aggregateBlockers = [
    ...projectBlockers,
    ...readinessInputs.map(blockerForInput).filter((item): item is ProductionBlocker => Boolean(item)),
    ...shots.flatMap(shot => shot.blockers.map(blocker => ({
      ...blocker, code: `${shot.shotId}:${blocker.code}`, message: `镜头 ${shot.order}：${blocker.message}`,
    }))),
  ];
  const shotDerivedStatus = aggregateStatus({ taskStatus: input.task.status, stage, shots });
  const status = aggregateInputs.missing.length > 0
    && !['completed', 'failed'].includes(shotDerivedStatus)
    ? 'needs_input' : shotDerivedStatus;
  const executable = shots.length > 0 && shots.every(shot => shot.executable)
    && aggregateInputs.missing.length === 0 && !projectBlockers.some(item => item.code !== 'studio_projection_unavailable');
  const allowedCommands = unique([
    ...(input.studio.project ? ['open_project' as const] : []),
    ...shots.flatMap(shot => shot.allowedCommands),
    ...(aggregateInputs.items.some(item => item.kind === 'account_authorization'
      && item.status !== 'provided' && item.status !== 'not_applicable') ? ['connect_account' as const] : []),
    ...(aggregateInputs.items.some(item => item.kind === 'production_choice'
      && item.status !== 'provided' && item.status !== 'not_applicable') ? ['confirm_production_choice' as const] : []),
  ]);
  const aggregateStatusValue = projectBlockers.some(item => item.code === 'studio_project_conflict' || item.code === 'studio_project_stale')
    && !['running', 'rendering', 'quality_review', 'review_ready', 'completed'].includes(status) ? 'blocked' : status;
  return {
    schemaVersion: PRODUCTION_READ_MODEL_SCHEMA,
    authority: 'canonical_task',
    project: {
      kind: 'social_content', id: input.task.taskId, version: input.task.version, title: input.task.title,
      taskStatus: input.task.status, runId: input.task.runId,
      studioProjectId: input.studio.project?.id ?? null,
      studioProjectVersion: input.studio.project?.version || null,
      studioProjectStatus: input.studio.project?.status || null,
      studioProjectConflict: input.studio.duplicateCount > 0,
    },
    aggregate: {
      stage: currentPhase(aggregateStatusValue), status: aggregateStatusValue, executable,
      identityGuarantee: aggregateIdentity(shots.map(shot => shot.identityGuarantee)),
      inputs: aggregateInputs,
      cost: aggregateCost(shots, input.artifactCost, costQuote),
      blockers: aggregateBlockers,
      counts: statusCounts(shots),
      phases: phases(aggregateStatusValue, shots),
      allowedCommands,
    },
    shots,
    updatedAt: text(input.productionStage?.updatedAt, 80) || input.task.updatedAt,
  };
}
