import type { EnterpriseProfile } from '../routes/enterprise.js';
import type { DigitalEmployeeConfig } from './domain.js';
import type { ContentProductionOrderInput, ContentProductionRoute, StoredRecord } from './contentProductionContracts.js';
import { enterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';
import { buildBenchmarkAnalysis, MATERIAL_TYPE_LABELS, SHOT_ROLE_LABELS } from '../../shared/benchmarkAnalysis.js';
import { deriveNarrationStyleProfile, type NarrationStyleProfile } from './narrationStyle.js';
import { LEGACY_INCREMENTAL_COST_BLOCKER } from './legacyIncrementalCostGuard.js';
import { json, productIdentity, stableHash, text } from './contentProductionPlanning.js';

export function selectExplicitFocusProducts<T extends { name: string; sku?: string }>(products: T[], focusProducts: string): T[] {
  const focus = focusProducts.split(/[,，、;；\n]/).map(item => item.trim()).filter(Boolean);
  if (!focus.length) return [];
  return products.filter(item => focus.some(name => name === item.name || name === item.sku));
}

export function selectedProductItems(profile: EnterpriseProfile, config: DigitalEmployeeConfig) {
  const selected = selectExplicitFocusProducts(profile.products.items || [], config.focusProducts);
  return (profile.products.items || []).map((item, index) => ({ item, productId: productIdentity(item, index) }))
    .filter(({ item }) => selected.includes(item));
}

/**
 * Resolve a frozen order against the complete frozen catalog. An explicit
 * product id is authoritative and never falls back to a same-named product;
 * name/SKU matching exists only for legacy orders that predate stable ids.
 */
export function resolveFrozenOrderProduct<T extends { id?: unknown; productId?: unknown; sku?: unknown; name?: unknown }>(
  products: T[],
  order: { productId?: unknown; productName?: unknown },
): { item: T; productId: string } | undefined {
  const catalog = products.map((item, index) => ({ item, productId: enterpriseProductIdentity(item, index) }));
  const explicitId = text(order.productId, 200);
  if (explicitId) return catalog.find(candidate => candidate.productId === explicitId);
  const legacyName = text(order.productName, 200);
  if (!legacyName) return undefined;
  const matches = catalog.filter(({ item }) => text(item.name, 200) === legacyName || text(item.sku, 160) === legacyName);
  return matches.length === 1 ? matches[0] : undefined;
}

export function frozenOrderProductItems(profile: EnterpriseProfile, orders: ContentProductionOrderInput[]) {
  const catalog = profile.products.items || [];
  const resolved = orders.map(order => resolveFrozenOrderProduct(catalog, order)).filter((item): item is NonNullable<typeof item> => Boolean(item));
  return [...new Map(resolved.map(item => [item.productId, item])).values()];
}

/** Product, reference and material availability can change after a worker or
 * user supplies the missing evidence. Only immutable route/platform scope is
 * allowed to survive as a frozen runtime blocker. */
export function immutableContentOrderBlockers(order: Pick<ContentProductionOrderInput, 'readinessBlockers'>): string[] {
  return (order.readinessBlockers || []).filter(reason =>
    reason===LEGACY_INCREMENTAL_COST_BLOCKER||/指定内容路径未在 Agent 配置中开启|制作平台不在本周目标范围中|固定路径编译失败|制作前编导交接待复核/.test(reason));
}

/**
 * Product/material were historical whole-video routes. In the fixed-yield
 * design they are shot-level local material classes inside a reference clone,
 * not independent routes that may open a fresh TTS/HeyGen charge. Existing
 * projects may still finish from already-created provider artifacts, but a
 * worker must never create new paid work without the frozen per-operation
 * budget authority used by the clone executor.
 */
export function legacyManagedPaidSubmissionBlocker(input: {
  route: ContentProductionRoute;
  productionContractVersion?: unknown;
  voiceoverUrl?: unknown;
  stage?: unknown;
  heygenJobId?: unknown;
}): string {
  if (input.route === 'clone') return '';
  if (String(input.productionContractVersion || 'legacy.v1') !== 'legacy.v1') return '';
  const stage = String(input.stage || 'script');
  const hasVoiceArtifact = Boolean(String(input.voiceoverUrl || '').trim());
  if (!hasVoiceArtifact && ['script', 'material_match', 'voice_subtitles'].includes(stage)) {
    return '该旧版独立产品/素材路线不能新建付费配音；请重新生成固定参考视频计划，产品与工厂镜头将按时间线匹配企业本地素材';
  }
  if (stage === 'heygen' && !String(input.heygenJobId || '').trim()) {
    return '该旧版路线没有冻结的数字人供应商任务，不能新建付费提交；请重新生成固定参考视频计划';
  }
  return '';
}

function confirmedProductSpecification(value: unknown): string {
  if (typeof value !== 'string') return '';
  const specification = value.trim();
  return /^(?:无|暂无|未知|待补充|待确认|未(?:确认|提供|填写|标注)|(?:附件|资料|原文|标签)(?:中)?未(?:提供|标注)|unknown|n\/?a|none|not specified|[-—–]+)$/i.test(specification)
    ? '' : specification;
}

export function productFacts(profile: EnterpriseProfile, config: DigitalEmployeeConfig, productId?: string): string {
  // An explicit weekly-plan binding may select any confirmed catalog product.
  // The focus list is a default, and can contain names from an older catalog.
  const items = productId
    ? (profile.products.items || []).filter((item, index) => productIdentity(item, index) === productId)
    : selectedProductItems(profile, config).map(item => item.item);
  return items.map(item => [
    `产品：${item.name}`, item.sku ? `SKU：${item.sku}` : '', item.category ? `类别：${item.category}` : '',
    confirmedProductSpecification(item.size) ? `规格：${confirmedProductSpecification(item.size)}` : '',
    confirmedProductSpecification(item.attributes?.['净含量']) ? `净含量：${confirmedProductSpecification(item.attributes?.['净含量'])}` : '',
    item.material ? `材质：${item.material}` : '', item.priceRange ? `价格范围：${item.priceRange}` : '',
    item.moq ? `MOQ：${item.moq}` : '', item.certifications ? `认证：${item.certifications}` : '', item.highlights ? `特点：${item.highlights}` : '',
  ].filter(Boolean).join('；')).join('\n').slice(0, 8_000);
}

export function referenceStructure(record?: StoredRecord): { id: string; structure: unknown; observedFacts: string[]; narrationStyle: NarrationStyleProfile | null; hash: string } | null {
  if (!record) return null;
  const analysis = json<Record<string, unknown>>(record.aiAnalysis, {});
  const gemini = json<Record<string, unknown>>(analysis.gemini, {});
  const shots = Array.isArray(gemini.scriptDetails15s) ? gemini.scriptDetails15s : Array.isArray(gemini.shots) ? gemini.shots : [];
  const normalized = buildBenchmarkAnalysis({
    analysis,
    videoId: record.id,
    duration: Number(record.duration || 0),
    evidenceRevision: text(record.updatedAt || record.updated_at || analysis.analysisRunId || `analysis:${record.id}`, 160),
  });
  const structure = normalized.structure.map((step, index) => ({
    index,
    materialType: step.materialType,
    materialLabel: MATERIAL_TYPE_LABELS[step.materialType],
    narrativeRole: step.narrativeRole,
    narrativeRoleLabel: SHOT_ROLE_LABELS[step.narrativeRole],
    shots: step.shotIds.map(id => normalized.shots.find(shot => shot.shotId === id)).filter(Boolean),
  }));
  const observedFacts = shots.flatMap(shot => {
    const row = json<Record<string, unknown>>(shot, {});
    return Array.isArray(row.observedFacts) ? row.observedFacts.map(item => text(item, 200)).filter(Boolean) : [];
  });
  if (!structure.length) return null;
  const narrationStyle = deriveNarrationStyleProfile(shots.map(shot => json<Record<string, unknown>>(shot, {})));
  return { id: record.id, structure, observedFacts, narrationStyle, hash: stableHash({ structure, narrationStyle }) };
}
