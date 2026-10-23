import { allocateAigcBudget, type AigcModelOffer, type AigcResolution } from '../../shared/aigcShotPlanning.js';
import { estimateSeedanceCostCny } from '../lib/seedanceBudget.js';
import { storyboardProjectShotInput } from '../lib/storyboardProjectShotInput.js';
import { automaticManagedFallbackFrameAdmission } from '../lib/storyboardAigcQuality.js';
import { planStudioBatchShotRoutes, type StudioBatchShotRoute, type StudioVerifiedAdoptionContext } from './studioBatchShotRoutes.js';
import { isInternalBudgetExemptTenant } from '../lib/tenantBudgetExemption.js';

export const INTERNAL_BUDGET_EXEMPT_CEILING_CNY = 1_000_000_000;

export interface StudioAigcBudgetContext extends StudioVerifiedAdoptionContext {
  /** Sum of ALL native allocations, including completed/uncertain/reserved.
   * This is an admission estimate, not a settled supplier invoice. */
  usedCny: number;
}

export interface StudioAigcBudgetSlot {
  id?: string;
  slotId?: string;
  duration?: number;
  priority?: number;
  importance?: number;
}

interface StoryboardBudgetActionPlan {
  sceneType?: string;
  actionStartState?: string;
  actionBeats?: string;
  actionKeyStates?: string;
  actionEndState?: string;
}

const actionParts = (value: string | undefined) => String(value || '').split(/[；;\n]+/).map(item => item.trim()).filter(Boolean);

/** Match the integer-duration video tasks created for each confirmed action beat. */
export function storyboardBudgetConfirmedStageDurations(duration: number, plan: StoryboardBudgetActionPlan | undefined): number[] | null {
  if (!Number.isFinite(duration) || duration <= 0 || !plan?.actionStartState?.trim() || !plan.actionEndState?.trim()) return null;
  const beats = actionParts(plan.actionBeats);
  const states = actionParts(plan.actionKeyStates);
  if (beats.length < 2 || states.length !== beats.length - 1 || duration < beats.length * 4) return null;
  if (Number.isInteger(duration)) {
    const base = Math.floor(duration / beats.length);
    return beats.map((_, index) => base + (index < duration % beats.length ? 1 : 0));
  }
  return beats.map(() => Math.ceil(duration / beats.length - 1e-9));
}

/** Cost envelope for a sequential action. The final segment is at least four
 * seconds, so a total such as 16s is planned as 12s + 4s. */
export function storyboardBudgetSegmentDurations(targetSeconds: number): number[] {
  const total = Math.ceil(targetSeconds);
  if (!Number.isFinite(total) || total <= 15) return [Math.max(4, total || 4)];
  if (total > 300) return [];
  const count = Math.ceil(total / 15);
  const durations: number[] = [];
  let remaining = total;
  for (let index = 0; index < count; index++) {
    const remainingSegments = count - index - 1;
    const current = Math.min(15, remaining - remainingSegments * 4);
    durations.push(current);
    remaining -= current;
  }
  return durations;
}

export function studioAigcBudgetConfigFromEnv() {
  const geometryEnabled = process.env.STORYBOARD_CLONE_GEOMETRY_QWEN_ENABLED === 'true';
  const geometryCost = Number(process.env.STORYBOARD_AIGC_CLONE_GEOMETRY_ESTIMATED_CNY || 0.1);
  if (geometryEnabled && (!Number.isFinite(geometryCost) || geometryCost <= 0))
    throw new Error('爆款首帧几何观察费用配置无效，未提交供应商');
  return {
    firstFrameCostCny: Number(process.env.STORYBOARD_AIGC_FIRST_FRAME_ESTIMATED_CNY || 0.3),
    cloneGeometryObservationCostCny: geometryEnabled ? geometryCost : 0,
    maxRetries: Number(process.env.STORYBOARD_AIGC_MAX_RETRIES || 1),
    batchBudgetCny: Number(process.env.STORYBOARD_AIGC_BATCH_BUDGET_CNY || 30),
    modelId: String(process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast-260128'),
  };
}

/** Managed weekly production must use the cost already frozen on its content
 * order. A request may lower that ceiling, but cannot raise either the frozen
 * order limit or the installation-wide storyboard limit. */
export function studioAigcBudgetConfigForSpec(spec: Record<string, any>, requestedMaxCostCny?: unknown, tenantId?: string) {
  const config = studioAigcBudgetConfigFromEnv();
  const internalBudgetExempt = isInternalBudgetExemptTenant(tenantId);
  const managed = spec?.automation?.managedBy === 'digital_employee';
  const context = spec?.contentOrder?.operatingContext || {};
  const frozen = Number(context.estimatedContentCostMax ?? context.estimatedContentCost);
  const managedRetries = Number(context.maxAigcRetries);
  const requested = requestedMaxCostCny === undefined ? null : Number(requestedMaxCostCny);
  if (requested !== null && (!Number.isFinite(requested) || requested <= 0)) {
    return { ...config, batchBudgetCny: 0 };
  }
  if (managed && (!Number.isFinite(frozen) || frozen <= 0)) {
    return { ...config, batchBudgetCny: 0 };
  }
  const installationCeiling = internalBudgetExempt ? INTERNAL_BUDGET_EXEMPT_CEILING_CNY
    : process.env.STORYBOARD_AIGC_BATCH_BUDGET_CNY === undefined
    ? Number.POSITIVE_INFINITY : config.batchBudgetCny;
  return { ...config,
    ...(managed && Number.isInteger(managedRetries) && managedRetries >= 0 && managedRetries <= 1 ? { maxRetries: managedRetries } : {}),
    batchBudgetCny: Math.min(
    installationCeiling,
    ...(managed ? [frozen] : []),
    ...(requested !== null ? [requested] : []),
  ) };
}

/** Cost-only plan for the existing one-click storyboard flow. Product/first
 * frame readiness remains a separate per-shot gate. No supplier is submitted
 * by this function. */
export function studioAigcBatchBudgetPreview(routes: StudioBatchShotRoute[], input: {
  firstFrameCostCny: number;
  cloneGeometryObservationCostCny?: number;
  creationMode?: string;
  maxRetries: number;
  batchBudgetCny: number;
  modelId: string;
  slots?: StudioAigcBudgetSlot[];
  actionPlans?: Record<string, StoryboardBudgetActionPlan | undefined>;
  requestedResolutions?: Record<string, AigcResolution | undefined>;
  offers?: AigcModelOffer[];
  preferredResolution?: AigcResolution;
  usedCostCny?: number;
  firstFrameCallCounts?: Record<string, number>;
}) {
  const active = routes.filter(route => route.route === 'aigc_first_frame');
  const byId = new Map((input.slots || []).flatMap(slot => [slot.id, slot.slotId].filter(Boolean).map(id => [id!, slot] as const)));
  const maxRetries = Number.isInteger(input.maxRetries) ? Math.max(0, input.maxRetries) : 0;
  const firstFrameCost = Number.isFinite(input.firstFrameCostCny) ? Math.max(0, input.firstFrameCostCny) : 0;
  const cloneGeometryCost = input.creationMode === 'clone' && Number.isFinite(input.cloneGeometryObservationCostCny)
    ? Math.max(0, Number(input.cloneGeometryObservationCostCny)) : 0;
  const budgetCny = Number.isFinite(input.batchBudgetCny) ? Math.max(0, input.batchBudgetCny) : 0;
  const usedCostCny = input.usedCostCny ?? 0;
  const budgetEvidenceValid = Number.isFinite(usedCostCny) && usedCostCny >= 0
    && Number.isSafeInteger(Math.round(usedCostCny * 1e6));
  const availableBudgetCny = budgetEvidenceValid ? Math.max(0, Math.round((budgetCny - usedCostCny) * 1e6) / 1e6) : 0;
  const offers: AigcModelOffer[] = input.offers || [{
    modelId: input.modelId, resolutions: ['480p', '720p'], minDurationSeconds: 4, maxDurationSeconds: 15,
    firstFrameCostCny: firstFrameCost,
    videoCostCnyPerSecond: { '480p': estimateSeedanceCostCny(1, '480p'), '720p': estimateSeedanceCostCny(1, '720p') },
  }];
  const candidates = active.map(route => {
    const slot = byId.get(route.slotId) || byId.get(route.shotId);
    const raw = Number(slot?.duration);
    const requested = input.requestedResolutions?.[route.slotId] || input.requestedResolutions?.[route.shotId];
    const actionPlan = input.actionPlans?.[route.slotId] || input.actionPlans?.[route.shotId];
    const usageScene = route.visualTopic === 'usage_scene' || actionPlan?.sceneType === 'usage';
    const confirmedStages = usageScene ? storyboardBudgetConfirmedStageDurations(raw, actionPlan) : null;
    const firstFrameCallCount = input.firstFrameCallCounts?.[route.slotId] ?? input.firstFrameCallCounts?.[route.shotId] ?? 1;
    return { shotId: route.shotId, targetDurationSeconds: Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : 4,
      priority: Number(slot?.priority ?? slot?.importance ?? 0) || 0,
      requestedResolution: requested === '480p' || requested === '720p' ? requested : undefined,
      firstFrameSurchargeCny: firstFrameCallCount === 0 ? 0 : cloneGeometryCost, firstFrameCallCount,
      segmentDurations: confirmedStages || (usageScene && Number.isFinite(raw) && raw > 15
        ? storyboardBudgetSegmentDurations(raw) : undefined) };
  });
  const shotPlans = allocateAigcBudget({ candidates, offers, budgetCny: availableBudgetCny, maxRetries, preferredResolution: input.preferredResolution })
    .map(plan => ({ ...plan, firstFrameOverheadCny: Math.round(Math.max(0, plan.firstFrameCallCount - 1)
      * Number(offers.find(offer => offer.modelId === plan.modelId)?.firstFrameCostCny || 0) * 100) / 100 }));
  const total = routes.length;
  const costAt = (tier: AigcResolution) => Math.round(candidates.reduce((sum, candidate) => {
    const segments = candidate.segmentDurations?.length ? candidate.segmentDurations : [Math.max(4, candidate.targetDurationSeconds)];
    const duration = segments.reduce((total, segment) => total + segment, 0);
    const compatible = offers.filter(offer => offer.resolutions.includes(tier)
      && segments.every(segment => offer.minDurationSeconds <= segment && offer.maxDurationSeconds >= segment)
      && offer.videoCostCnyPerSecond[tier] !== null);
    if (!compatible.length) return sum;
    if (!Number.isInteger(candidate.firstFrameCallCount) || candidate.firstFrameCallCount < 0 || candidate.firstFrameCallCount > 2) return sum;
    return sum + Math.min(...compatible.map(offer => (offer.firstFrameCostCny * candidate.firstFrameCallCount + (candidate.firstFrameSurchargeCny || 0)
      + duration * (offer.videoCostCnyPerSecond[tier] || 0)) * (maxRetries + 1)));
  }, 0) * 100) / 100;
  const estimate480pCny = costAt('480p');
  const estimate720pCny = costAt('720p');
  const estimatedCostCny = Math.round(shotPlans.reduce((sum, plan) => sum + plan.estimatedCostCny, 0) * 100) / 100;
  const readyShots = shotPlans.filter(plan => plan.status === 'ready').length;
  return {
    planningOnly: true as const, modelId: input.modelId, totalShots: total, aigcShots: active.length,
    aigcShotRatio: total ? Math.round(active.length / total * 100) / 100 : 0,
    candidateDurationSeconds: 4 as const, maxRetries, estimate480pCny, estimate720pCny,
    batchBudgetCny: budgetCny, budgetUsedCny: budgetEvidenceValid ? usedCostCny : null,
    availableBudgetCny, budgetEvidenceValid,
    recommendedResolution: (estimate720pCny <= availableBudgetCny ? '720p' : '480p') as AigcResolution,
    budgetEnoughFor480p: budgetEvidenceValid && !shotPlans.some(plan => plan.status === 'unsupported') && estimate480pCny <= availableBudgetCny,
    shotPlans, readyShots, excludedShots: active.length - readyShots, estimatedCostCny,
    budgetRemainingCny: Math.round((availableBudgetCny - estimatedCostCny) * 100) / 100,
  };
}

/** Shared source of truth for preview and the supplier-submission gate. Digital
 * human readiness does not affect selection of non-presenter AIGC routes. */
export function studioAigcBudgetPreviewForSpec(
  spec: Parameters<typeof planStudioBatchShotRoutes>[0],
  input: Omit<Parameters<typeof studioAigcBatchBudgetPreview>[1], 'slots' | 'requestedResolutions' | 'actionPlans'>,
  context?: StudioAigcBudgetContext,
) {
  const routes = planStudioBatchShotRoutes(spec, {
    talkingExecutorReady: false, actionExecutorReady: false, authorizedPresenterIds: [], verifiedAdoptionContext: context,
  });
  const firstFrameCallCounts = Object.fromEntries(routes.map(route => {
    const entry = spec.automatedReplicationShots?.find(item => item.shotId === route.shotId && item.slotId === route.slotId);
    const state = spec.automatedReplicationProgress?.[route.shotId];
    const plan = spec.storyboardSourcePlans?.[route.slotId] || spec.storyboardSourcePlans?.[route.shotId];
    const frameId = state?.firstFrameMaterialId || plan?.firstFrameMaterialId;
    const frame = context?.materials.find(item => item.id === frameId);
    const actualHash = frameId ? context?.verifiedFirstFrameContentSha256ByMaterialId?.[frameId] : undefined;
    const provenance = frame?.provenance;
    const currentShot = storyboardProjectShotInput(spec, route.slotId);
    const qa = provenance?.firstFrameQuality;
    const managedFallbackAccepted = automaticManagedFallbackFrameAdmission(provenance, plan);
    const reusable = !!context?.tenantId && !!context.projectId && frame?.scope === 'own' && frame.type === 'image'
      && frame.sourceType === 'ai-storyboard-first-frame' && String(frame.tenantId || frame.tenant_id || '') === context.tenantId
      && provenance?.projectId === context.projectId && provenance.shotId === route.slotId
      && !!currentShot && provenance.projectShotFingerprint === currentShot.fingerprint
      && !!actualHash && /^[a-f0-9]{64}$/.test(actualHash) && actualHash === provenance.firstFrameQualityInput?.sourceSha256
      && (provenance.confirmed === true || managedFallbackAccepted)
      && qa?.phase === 'first_frame' && (qa.status === 'passed' && qa.passed === true || managedFallbackAccepted)
      && qa.requiresHumanReview !== true && (!state?.firstFrameFingerprint || state.firstFrameFingerprint === provenance.fingerprint);
    // Only the native product-remake path has two paid image calls: clearing
    // the reference product, then compositing the enterprise product into it.
    const request = entry?.firstFrameRequest;
    const products = [request?.productIds, currentShot?.input.source.productIds, spec.selectedProductIds]
      .find(value => Array.isArray(value) && value.length > 0) || [];
    const productComposite = spec.mode === 'clone' && (request?.sceneType || plan?.sceneType || route.visualTopic) === 'product'
      && !!(request?.sourceFirstFrameUrl || currentShot?.input.reference?.firstFrameRef)
      && Array.isArray(products) && products.length > 0;
    return [route.slotId, reusable ? 0 : productComposite ? 2 : 1];
  }));
  return studioAigcBatchBudgetPreview(routes, { ...input, slots: Array.isArray(spec.shootingSlots) ? spec.shootingSlots : [],
    firstFrameCallCounts,
    usedCostCny: context?.usedCny ?? (spec.automation?.managedBy === 'digital_employee' ? Number.NaN : input.usedCostCny),
    creationMode: spec.mode,
    actionPlans: spec.storyboardSourcePlans || {},
    requestedResolutions: Object.fromEntries(Object.entries(spec.storyboardSourcePlans || {}).map(([id, plan]) => [id,
      plan.videoResolutionPinned && (plan.videoResolution === '480p' || plan.videoResolution === '720p') ? plan.videoResolution : undefined])),
  });
}
