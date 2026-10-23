/** Provider-neutral planning for non-presenter AIGC storyboard shots. */
export type AigcShotType = 'product_live_action' | 'factory_scene' | 'usage_scene';
export type AigcCreationMode = 'viral_replication' | 'free_creation';
export type AigcAssetRole = 'composition_reference' | 'product_identity' | 'person_identity' | 'factory_reference' | 'motion_reference';
export type AigcResolution = '480p' | '720p';

export interface AigcReferenceAsset {
  role: AigcAssetRole;
  assetId: string;
  version: string;
  /** The source image is a layout reference, never the target product identity. */
  source: 'knowledge_base' | 'enterprise_asset' | 'reference_video';
}

export interface AigcShotInput {
  shotId: string;
  type: AigcShotType;
  mode: AigcCreationMode;
  description: string;
  originalDurationSeconds?: number | null;
  priority?: number;
  selectedSource: 'intelligent_generation' | 'matched_material' | 'locked_material';
  /** Factory shots may also show a selected enterprise product. */
  requiresProductIdentity?: boolean;
  /** Only a specified enterprise person needs a bound identity asset. */
  requiresPersonIdentity?: boolean;
  assets: AigcReferenceAsset[];
  /** A confirmed upstream shot analysis is used as-is for replication. */
  observedAction?: string;
}

export interface AigcModelOffer {
  modelId: string;
  resolutions: readonly AigcResolution[];
  minDurationSeconds: number;
  maxDurationSeconds: number;
  /** Cost estimates must include the first-frame image and one video attempt. */
  firstFrameCostCny: number;
  videoCostCnyPerSecond: Record<AigcResolution, number | null>;
}

export interface AigcShotPlan {
  shotId: string;
  type: AigcShotType;
  mode: AigcCreationMode;
  status: 'preserved' | 'ready' | 'needs_input' | 'unsupported' | 'budget_excluded';
  missingAssets: AigcAssetRole[];
  targetDurationSeconds: number;
  /** The original storyboard duration remains the assembly target. */
  assemblyDurationSeconds: number;
  resolutionTier: AigcResolution | null;
  modelId: string | null;
  estimatedCostCny: number;
  maxRetries: number;
  assets: AigcReferenceAsset[];
  observedAction: string;
}

export interface AigcBatchPlan {
  shots: AigcShotPlan[];
  totalShots: number;
  requestedGeneratedShots: number;
  plannedGeneratedShots: number;
  /** Requested intelligent-generation shots divided by all storyboard shots. */
  generatedShotRatio: number;
  /** Budget-admitted intelligent-generation shots divided by all shots. */
  plannedGeneratedShotRatio: number;
  estimatedCostCny: number;
  budgetCny: number;
  budgetRemainingCny: number;
}

export interface AigcBudgetCandidate {
  shotId: string;
  targetDurationSeconds: number;
  priority?: number;
  /** An explicit per-shot choice is a constraint, not an optional upgrade. */
  requestedResolution?: AigcResolution;
  /** Long usage actions are executed as individually checked provider clips. */
  segmentDurations?: number[];
  /** Conservatively reserves optional paid pre-image observation. */
  firstFrameSurchargeCny?: number;
  /** Zero only for a server-verified existing frame; product compositing may
   * require two image calls. Omitted preserves the original one-call plan. */
  firstFrameCallCount?: number;
}

export interface AigcBudgetAllocation {
  shotId: string;
  status: 'ready' | 'unsupported' | 'budget_excluded';
  targetDurationSeconds: number;
  resolutionTier: AigcResolution | null;
  modelId: string | null;
  estimatedCostCny: number;
  segmentDurations: number[];
  estimatedVideoCostCny: number;
  estimatedFirstFrameCostCny: number;
  estimatedGeometryObservationCostCny: number;
  firstFrameCallCount: number;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const roleOrder: AigcAssetRole[] = ['product_identity', 'composition_reference', 'factory_reference', 'person_identity', 'motion_reference'];

/** Allocate the cheapest supported offer per shot, then upgrade the most
 * important shots. Duration is never silently shortened to fit a model. */
export function allocateAigcBudget(input: {
  candidates: AigcBudgetCandidate[];
  offers: AigcModelOffer[];
  budgetCny: number;
  maxRetries: number;
  preferredResolution?: AigcResolution;
}): AigcBudgetAllocation[] {
  if (!nonnegative(input.budgetCny) || !Number.isInteger(input.maxRetries) || input.maxRetries < 0) throw new Error('invalid_aigc_budget');
  const ranked = input.candidates.map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => (b.candidate.priority ?? 0) - (a.candidate.priority ?? 0) || a.index - b.index);
  const result: AigcBudgetAllocation[] = input.candidates.map(candidate => ({
    shotId: candidate.shotId, status: 'budget_excluded', targetDurationSeconds: Math.max(4, Math.ceil(candidate.targetDurationSeconds)),
    resolutionTier: null, modelId: null, estimatedCostCny: 0, estimatedVideoCostCny: 0,
    estimatedFirstFrameCostCny: 0, estimatedGeometryObservationCostCny: 0,
    firstFrameCallCount: candidate.firstFrameCallCount ?? 1,
    segmentDurations: candidate.segmentDurations?.length ? [...candidate.segmentDurations] : [Math.max(4, Math.ceil(candidate.targetDurationSeconds))],
  }));
  const choices = (candidate: AigcBudgetCandidate, resolution: AigcResolution) => input.offers.flatMap(offer => {
    const durations = candidate.segmentDurations?.length ? candidate.segmentDurations : [Math.max(4, Math.ceil(candidate.targetDurationSeconds))];
    const duration = durations.reduce((sum, item) => sum + item, 0);
    const rate = offer.videoCostCnyPerSecond[resolution];
    const frameCalls = candidate.firstFrameCallCount ?? 1;
    if (!Number.isFinite(duration) || duration > 300 || !offer.resolutions.includes(resolution)
      || durations.some(segment => !Number.isInteger(segment) || segment < offer.minDurationSeconds || segment > offer.maxDurationSeconds)
      || rate === null || !nonnegative(rate) || !nonnegative(offer.firstFrameCostCny)
      || !nonnegative(candidate.firstFrameSurchargeCny ?? 0)
      || !Number.isInteger(frameCalls) || frameCalls < 0 || frameCalls > 2) return [];
    const surcharge = roundMoney(candidate.firstFrameSurchargeCny ?? 0);
    const imageCost = roundMoney(offer.firstFrameCostCny * frameCalls + surcharge);
    const videoCost = roundMoney(rate * duration);
    return [{ modelId: offer.modelId, resolution, cost: roundMoney((imageCost + videoCost) * (input.maxRetries + 1)), imageCost, videoCost, surcharge }];
  }).sort((a, b) => a.cost - b.cost || a.modelId.localeCompare(b.modelId));
  let remaining = input.budgetCny;
  for (const { candidate, index } of ranked) {
    const available = (candidate.requestedResolution
      ? choices(candidate, candidate.requestedResolution)
      : [...choices(candidate, '480p'), ...choices(candidate, '720p')])
      .sort((a, b) => a.cost - b.cost || a.modelId.localeCompare(b.modelId));
    if (!available.length) { result[index].status = 'unsupported'; continue; }
    const selected = available.find(choice => choice.cost <= remaining + 0.000001);
    if (!selected) continue;
    Object.assign(result[index], { status: 'ready', resolutionTier: selected.resolution, modelId: selected.modelId,
      estimatedCostCny: selected.cost, estimatedVideoCostCny: selected.videoCost,
      estimatedFirstFrameCostCny: selected.imageCost, estimatedGeometryObservationCostCny: selected.surcharge });
    remaining = roundMoney(remaining - selected.cost);
  }
  if (input.preferredResolution !== '480p') {
    for (const { candidate, index } of ranked) {
      const current = result[index];
      if (current.status !== 'ready' || current.resolutionTier === '720p' || candidate.requestedResolution) continue;
      const high = choices(candidate, '720p').find(choice => choice.cost - current.estimatedCostCny <= remaining + 0.000001);
      if (!high) break;
      remaining = roundMoney(remaining - (high.cost - current.estimatedCostCny));
      Object.assign(current, { resolutionTier: '720p', modelId: high.modelId,
        estimatedCostCny: high.cost, estimatedVideoCostCny: high.videoCost,
        estimatedFirstFrameCostCny: high.imageCost, estimatedGeometryObservationCostCny: high.surcharge });
    }
  }
  return result;
}

export function requiredAigcAssetRoles(shot: AigcShotInput): AigcAssetRole[] {
  const roles: AigcAssetRole[] = [];
  if (shot.type !== 'factory_scene' || shot.requiresProductIdentity) roles.push('product_identity');
  if (shot.mode === 'viral_replication') roles.push('composition_reference');
  if (shot.requiresPersonIdentity) roles.push('person_identity');
  return roleOrder.filter(role => roles.includes(role));
}

/**
 * Plan locally before any supplier submission. The caller supplies real model
 * prices and supported durations; unsupported combinations are never invented.
 */
export function planAigcShotBatch(input: {
  shots: AigcShotInput[];
  offers: AigcModelOffer[];
  budgetCny: number;
  maxRetries?: number;
  preferredResolution?: AigcResolution;
}): AigcBatchPlan {
  if (!nonnegative(input.budgetCny)) throw new Error('invalid_aigc_budget');
  const maxRetries = input.maxRetries ?? 0;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('invalid_aigc_retry_limit');
  const ids = new Set<string>();
  for (const shot of input.shots) {
    if (!shot.shotId.trim() || ids.has(shot.shotId)) throw new Error('invalid_or_duplicate_aigc_shot_id');
    ids.add(shot.shotId);
  }
  const requestedGeneratedShots = input.shots.filter(shot => shot.selectedSource === 'intelligent_generation').length;
  const plans = input.shots.map((shot): AigcShotPlan => {
    const missingAssets = requiredAigcAssetRoles(shot).filter(role => !shot.assets.some(asset => asset.role === role
      && asset.assetId.trim() && asset.version.trim()
      && (role !== 'product_identity' || asset.source === 'knowledge_base')
      && (role !== 'person_identity' || asset.source === 'enterprise_asset')
      && (role !== 'composition_reference' || asset.source === 'reference_video')));
    const original = shot.originalDurationSeconds;
    const assemblyDurationSeconds = typeof original === 'number' && Number.isFinite(original) && original > 0 ? original : 4;
    return {
      shotId: shot.shotId, type: shot.type, mode: shot.mode,
      status: shot.selectedSource === 'intelligent_generation' ? (missingAssets.length ? 'needs_input' : 'budget_excluded') : 'preserved',
      missingAssets, targetDurationSeconds: Math.max(4, Math.ceil(assemblyDurationSeconds)), assemblyDurationSeconds,
      resolutionTier: null, modelId: null, estimatedCostCny: 0, maxRetries,
      assets: shot.assets.map(asset => ({ ...asset })), observedAction: shot.observedAction || '',
    };
  });
  const candidates = input.shots.filter((_, index) => plans[index].status === 'budget_excluded')
    .map(shot => ({ shotId: shot.shotId, targetDurationSeconds: plans.find(plan => plan.shotId === shot.shotId)!.targetDurationSeconds, priority: shot.priority }));
  const allocation = allocateAigcBudget({ candidates, offers: input.offers, budgetCny: input.budgetCny,
    maxRetries, preferredResolution: input.preferredResolution });
  for (const assigned of allocation) {
    const plan = plans.find(item => item.shotId === assigned.shotId)!;
    plan.status = assigned.status;
    plan.resolutionTier = assigned.resolutionTier;
    plan.modelId = assigned.modelId;
    plan.estimatedCostCny = assigned.estimatedCostCny;
  }
  const remaining = roundMoney(input.budgetCny - plans.reduce((sum, plan) => sum + plan.estimatedCostCny, 0));
  return {
    shots: plans, totalShots: plans.length, requestedGeneratedShots,
    plannedGeneratedShots: plans.filter(plan => plan.status === 'ready').length,
    generatedShotRatio: plans.length ? roundMoney(requestedGeneratedShots / plans.length) : 0,
    plannedGeneratedShotRatio: plans.length ? roundMoney(plans.filter(plan => plan.status === 'ready').length / plans.length) : 0,
    estimatedCostCny: roundMoney(input.budgetCny - remaining),
    budgetCny: input.budgetCny, budgetRemainingCny: remaining,
  };
}
