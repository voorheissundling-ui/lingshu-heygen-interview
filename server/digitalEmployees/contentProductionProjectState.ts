import fs from 'node:fs';
import { fetchCloudMaterial } from '../lib/cloudMaterials.js';
import { store } from '../storage/index.js';
import { objectStorageEnabled, objectStorageSignedGetUrl } from '../storage/objectStorage.js';
import { digitalEmployeeProductionGraph } from '../videoProduction/runtimeGraph.js';
import { contentProjectLineageFields } from './contentProjectLineage.js';
import { CONTENT_SCRIPT_QUALITY_RULE_VERSION } from './contentQualityContract.js';
import { mimeFromFile } from './contentProductionAssets.js';
import { productFacts, resolveFrozenOrderProduct } from './contentProductionFacts.js';
import { routeTitle } from './contentProductionScripts.js';
import { assetEligible, json, platformCreativeBrief, stableHash, text } from './contentProductionPlanning.js';
import type { DigitalEmployeeConfig } from './domain.js';
import type { EnterpriseProfile } from '../routes/enterprise.js';
import type { AssetCandidate, ContentProductionOrderInput, ContentProductionRoute, ProductionStage, RouteSourcePlan, StoredRecord } from './contentProductionContracts.js';

export function evidenceAssetSnapshot(asset: AssetCandidate) {
  return {
    id: asset.id, name: asset.name, type: asset.type, source: asset.source,
    productId: asset.productId || '', productName: asset.productName || '',
    visualObservations: asset.visualObservations, authorization: asset.authorization,
    synthetic: asset.synthetic, aspectRatio: asset.aspectRatio || '', width: asset.width || 0, height: asset.height || 0,
    ...(typeof asset.focusX === 'number' ? { focusX: asset.focusX } : {}), ...(typeof asset.focusY === 'number' ? { focusY: asset.focusY } : {}),
    tags: asset.tags,
  };
}

export function buildRouteSourcePlans(input: {
  allocations: ContentProductionRoute[];
  products: Array<{ productId: string; productName: string }>;
  assets: AssetCandidate[];
  referenceAnalysisIds: string[];
  platforms: string[];
  existingFingerprints?: string[];
}): RouteSourcePlan[] {
  const productCursor = new Map<string, number>();
  const usedAcrossRoutes = new Set<string>();
  const usedReferences = new Set<string>();
  return input.allocations.map((route, slot) => {
    const platform = input.platforms[slot % Math.max(1, input.platforms.length)] || '';
    const base = { route, platform, platformBrief: platformCreativeBrief(platform) };
    if (route === 'material') {
      const material = input.assets
        .filter(asset => assetEligible(asset) && !usedAcrossRoutes.has(asset.id))
        .sort((a, b) => Number(Boolean(b.visualObservations.length)) - Number(Boolean(a.visualObservations.length)) || a.id.localeCompare(b.id))[0];
      if (!material) return { ...base, assetIds: [], gap: '素材生成缺少尚未使用的已授权真实素材；不会复用其他路径素材冒充新内容' };
      const companions = material.productId ? input.assets.filter(asset => assetEligible(asset) && asset.id !== material.id && asset.productId === material.productId && !usedAcrossRoutes.has(asset.id)).slice(0, 2) : [];
      const assetIds = [material.id, ...companions.map(asset => asset.id)];
      assetIds.forEach(id => usedAcrossRoutes.add(id));
      return { ...base, ...(material.productId ? { productId: material.productId, productName: material.productName } : {}), seedAssetId: material.id, assetIds };
    }
    const candidates = input.products.filter(product => input.assets.some(asset => assetEligible(asset) && asset.productId === product.productId && !usedAcrossRoutes.has(asset.id)));
    if (!candidates.length) return { ...base, assetIds: [], gap: `${routeTitle(route)}缺少“重点产品 + 归属于该产品的已授权素材”` };
    const selected = candidates.slice().sort((left, right) => (productCursor.get(left.productId) || 0) - (productCursor.get(right.productId) || 0) || left.productId.localeCompare(right.productId))[0]!;
    productCursor.set(selected.productId, (productCursor.get(selected.productId) || 0) + 1);
    const ownedAssets = input.assets.filter(asset => assetEligible(asset) && asset.productId === selected.productId && !usedAcrossRoutes.has(asset.id));
    ownedAssets.forEach(asset => usedAcrossRoutes.add(asset.id));
    if (route === 'product') return { ...base, productId: selected.productId, productName: selected.productName, assetIds: ownedAssets.map(asset => asset.id) };
    const referenceAnalysisId = input.referenceAnalysisIds.find(id => !usedReferences.has(id));
    if (!referenceAnalysisId) return { ...base, productId: selected.productId, productName: selected.productName, assetIds: ownedAssets.map(asset => asset.id), gap: '爆款裂变缺少尚未用于本批次的精确参考结构' };
    usedReferences.add(referenceAnalysisId);
    return { ...base, productId: selected.productId, productName: selected.productName, assetIds: ownedAssets.map(asset => asset.id), referenceAnalysisId };
  });
}

export function projectAutomation(record: StoredRecord): Record<string, unknown> {
  return json<Record<string, unknown>>(json<Record<string, unknown>>(record.spec, {}).automation, {});
}

export function automatedContentQualityNeedsRevalidation(automation: Record<string, unknown>): boolean {
  if (automation.managedBy !== 'digital_employee' || text(automation.stage) !== 'completed') return false;
  const quality = json<Record<string, unknown>>(automation.quality, {});
  return Number(quality.ruleVersion || 0) !== CONTENT_SCRIPT_QUALITY_RULE_VERSION;
}

export function stagePatch(automation: Record<string, unknown>, stage: ProductionStage, extra: Record<string, unknown> = {}) {
  const updatedAt = new Date().toISOString();
  return { ...automation, stage, updatedAt, ...digitalEmployeeProductionGraph({ automation, stage, extra, now: updatedAt }), ...extra };
}

export function selectedAssets(spec: Record<string, unknown>, all: AssetCandidate[]): AssetCandidate[] {
  const ids = Array.isArray(spec.selectedMaterialIds) ? spec.selectedMaterialIds.map(String) : [];
  return ids.map(id => all.find(asset => asset.id === id)).filter((asset): asset is AssetCandidate => Boolean(asset));
}

export async function assetRenderUrl(asset: AssetCandidate, tenantId: string): Promise<string> {
  if (asset.localPath && fs.existsSync(asset.localPath)) {
    return `data:${mimeFromFile(asset.localPath)};base64,${fs.readFileSync(asset.localPath).toString('base64')}`;
  }
  if (asset.objectKey && objectStorageEnabled()) return objectStorageSignedGetUrl(asset.objectKey, 15 * 60);
  if (asset.cloudRecordId) {
    const response = await fetchCloudMaterial(asset.cloudRecordId, asset.type === 'video' ? 'videoFile' : 'posterFile', undefined, tenantId);
    if (response?.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length) return `data:${response.headers.get('content-type') || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg')};base64,${bytes.toString('base64')}`;
    }
  }
  const url = text(asset.url, 4_000);
  return /^(?:https?:|data:)/i.test(url) ? url : '';
}

export async function updateProject(record: StoredRecord, spec: Record<string, unknown>, status = 'draft') {
  const lineage = contentProjectLineageFields({ tenantId: record.tenant_id, spec, current: record });
  const ok = await store.update('studio_projects', record.id, { spec, status, ...lineage, updated_at: new Date().toISOString() });
  if (!ok) throw new Error('studio_project_update_failed');
}

export function contentProjectRetryable(stage: Record<string, unknown>): boolean {
  if (stage.retryPolicy === 'input_required') {
    // Balance/credential blockers still need a human account change, but once
    // that change is made the worker must discover it automatically. Older
    // persisted blockers predate autoRecheckExternal, so recognize their exact
    // provider wording and give them one migration retry as well.
    const recoverableExternalAccount = stage.autoRecheckExternal === true
      || /账户欠费|充值|鉴权失败|API Key|account is not in good standing|overdue[ -]?payment|arrearage|invalid api key|unauthori[sz]ed|forbidden/i.test(text(stage.blocker, 2_000));
    if (!recoverableExternalAccount) return false;
  }
  const next = Date.parse(text(stage.retryAfter, 80));
  return !Number.isFinite(next) || next <= Date.now();
}

export function contentProjectBlockIsSemanticallyUnchanged(input: {
  automation: Record<string, unknown>;
  resumeStage: ProductionStage;
  reason: string;
}): boolean {
  return text(input.automation.stage) === 'blocked'
    && text(input.automation.status) === 'blocked'
    && text(input.automation.resumeStage) === input.resumeStage
    && text(input.automation.blocker, 2_000) === text(input.reason, 2_000);
}

/**
 * Clears a content project's internal backoff after an explicit task retry or
 * replan. The project payload, selected real materials and render receipts are
 * preserved; only the retry-control fields for the exact run/task lineage are
 * changed.
 */
export function resumeContentProjectForTaskControl(input: {
  project: Record<string, unknown>;
  runId: string;
  affectedTaskIds: Set<string>;
  now: string;
}): Record<string, unknown> | null {
  const spec = json<Record<string, unknown>>(input.project.spec, {});
  const automation = json<Record<string, unknown>>(spec.automation, {});
  if (automation.managedBy !== 'digital_employee') return null;
  if (text(spec.workflowRunId) !== input.runId || !input.affectedTaskIds.has(text(spec.workflowTaskId))) return null;
  const resumableStages: ProductionStage[] = ['script', 'material_match', 'voice_subtitles', 'heygen', 'render', 'quality'];
  const currentStage = text(automation.stage) as ProductionStage;
  // Historical projects stored the active production node in `stage` and the
  // blocked state separately in `status`. Treat both encodings as retryable,
  // while never reopening completed or superseded work.
  const legacyBlocked = text(automation.status) === 'blocked' && resumableStages.includes(currentStage);
  if (currentStage !== 'blocked' && !legacyBlocked) return null;
  const requestedStage = text(automation.resumeStage) as ProductionStage;
  const resumeStage: ProductionStage = resumableStages.includes(requestedStage)
    ? requestedStage
    : legacyBlocked ? currentStage : 'script';
  const { retryPolicy: _retryPolicy, retryAfter: _retryAfter, resumeStage: _resumeStage, blocker: _blocker, ...preserved } = automation;
  return {
    ...spec,
    materialAnalysisAttempts: {},
    automation: {
      ...preserved,
      stage: resumeStage,
      status: 'queued',
      retryRequestedAt: input.now,
      updatedAt: input.now,
      autoNarrationRepairAttempts: 0,
      autoNarrationReviewAttempts: 0,
      autoTimingRematchAttempts: 0,
      autoTranslationRepairAttempts: 0,
    },
  };
}
/** Repair legacy projects created while frozen orders were incorrectly
 * resolved only inside focusProducts. This updates evidence binding only; it
 * never clears the blocker or retries production without an explicit task
 * recovery action. */
export function repairFrozenOrderProductBinding(input: {
  spec: Record<string, unknown>;
  profile: EnterpriseProfile;
  config: DigitalEmployeeConfig;
  assets: AssetCandidate[];
}): Record<string, unknown> | null {
  const contentOrder = json<ContentProductionOrderInput | undefined>(input.spec.contentOrder, undefined);
  if (!contentOrder) return null;
  const product = resolveFrozenOrderProduct(input.profile.products.items || [], contentOrder);
  if (!product) return null;
  const automation = json<Record<string, unknown>>(input.spec.automation, {});
  const routePlan = json<RouteSourcePlan>(automation.routePlan, {
    route: contentOrder.route, assetIds: [], platform: contentOrder.platform, platformBrief: platformCreativeBrief(contentOrder.platform),
  });
  if (text(routePlan.productId, 200) === product.productId) return null;
  // Never replace a different explicit catalog binding. The compatibility
  // repair is only for the historical empty binding produced by the focus bug.
  if (text(routePlan.productId, 200)) return null;
  const assetIds = contentOrder.evidenceRefs
    .filter(ref => ref.type === 'enterprise_material')
    .map(ref => ref.id)
    .filter(id => input.assets.some(asset => asset.id === id && assetEligible(asset) && (!asset.productId || asset.productId === product.productId)));
  const boundAssets = assetIds.map(id => input.assets.find(asset => asset.id === id)).filter((asset): asset is AssetCandidate => Boolean(asset));
  const previousSnapshot = json<Record<string, unknown>>(input.spec.evidenceSnapshot, {});
  const preservedRoutePlan = { ...routePlan };
  delete preservedRoutePlan.gap;
  const nextRoutePlan: RouteSourcePlan = {
    ...preservedRoutePlan,
    productId: product.productId,
    productName: text(product.item.name, 160) || contentOrder.productName,
    assetIds,
  };
  const productSnapshot = { id: product.productId, name: nextRoutePlan.productName || '', facts: productFacts(input.profile, input.config, product.productId) };
  const assetSnapshots = boundAssets.map(evidenceAssetSnapshot);
  const reference = previousSnapshot.reference ?? null;
  return {
    ...input.spec,
    productInfo: productSnapshot.facts,
    evidenceSnapshot: {
      ...previousSnapshot,
      product: productSnapshot,
      assets: assetSnapshots,
      hash: stableHash({ productId: product.productId, assets: assetSnapshots, reference }),
    },
    automation: { ...automation, routePlan: nextRoutePlan },
  };
}
