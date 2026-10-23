import crypto from 'node:crypto';
import { allocateEvidenceClips } from './sceneEvidence.js';
import { normalizeVideoPlan, presentationScenes, type VideoCreationPlan } from '../../shared/contracts/videoCreationPlan.js';
import { VIDEO_LANGUAGES, normalizeVideoLanguage } from '../../shared/contracts/videoLanguages.js';
import type { NarrationVisibleEvidence } from './narration.js';
import type { EnterpriseProfile } from '../routes/enterprise.js';
import { enterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';
import type { DigitalEmployeeConfig } from './domain.js';
import type {
  AssetCandidate, ContentProductionAdvanceResult, ContentProductionOrderInput,
  ContentProductionRoute, ContentRouteEvidence, ContentRoutePlan, RouteSourcePlan,
  SceneSourcePlanItem,
} from './contentProductionContracts.js';

export const CONTENT_PRODUCTION_SCHEMA_VERSION = 4;
export const CONTENT_PRODUCTION_MAX_CONCURRENCY = 2;

export function expandContentOrdersByLanguage(
  orders: ContentProductionOrderInput[],
  config: DigitalEmployeeConfig,
): ContentProductionOrderInput[] {
  const fallback = normalizeVideoLanguage(config.videoDefaults?.language || 'en');
  return orders.flatMap(order => {
    const configured = (order.languages?.length ? order.languages : [order.videoPlan?.language || fallback])
      .map(normalizeVideoLanguage)
      .filter((code, index, values) => code in VIDEO_LANGUAGES && values.indexOf(code) === index)
      .slice(0, 5);
    const languages = configured.length ? configured : [fallback in VIDEO_LANGUAGES ? fallback : 'en'];
    const masterLanguage = languages[0]!;
    const masterContentOrderId = `${order.id}::${masterLanguage}`;
    return languages.map(language => ({
      ...order,
      id: `${order.id}::${language}`,
      sourceContentOrderId: order.id,
      masterContentOrderId,
      masterLanguage,
      videoPlan: normalizeVideoPlan({ ...(order.videoPlan || config.videoDefaults || {}), language }),
    }));
  });
}

/** Refresh a language-expanded project order from its repaired base contract.
 * The project identity/lineage must remain stable so retries update the same
 * work item instead of creating a duplicate render. */
export function refreshExpandedContentOrderContract<T extends ContentProductionOrderInput>(
  expanded: T,
  repairedBase: ContentProductionOrderInput,
  language: string,
): T {
  const targetLanguage = normalizeVideoLanguage(language || expanded.videoPlan?.language || repairedBase.videoPlan?.language || 'en');
  return {
    ...expanded,
    ...repairedBase,
    id: expanded.id,
    sourceContentOrderId: expanded.sourceContentOrderId || repairedBase.id,
    masterContentOrderId: expanded.masterContentOrderId,
    masterLanguage: expanded.masterLanguage,
    videoPlan: normalizeVideoPlan({ ...(repairedBase.videoPlan || expanded.videoPlan || {}), language: targetLanguage }),
  } as T;
}

export const text = (value: unknown, max = 1_000): string => String(value ?? '').trim().slice(0, max);
export const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value && typeof value === 'object' ? value as T : fallback;
};

export const stableHash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const MAX_FROZEN_DIRECTOR_SCRIPT_LENGTH = 30_000;

export function frozenDirectorScriptForProduction(
  spec: Record<string, unknown>,
  language: string,
): { script: string; blocker: string; source: 'frozen_contract' | 'legacy_project' } {
  const contract = json<ContentProductionOrderInput | undefined>(spec.contentOrder, undefined);
  if (contract?.contractVersion !== 1) {
    const script = typeof spec.script === 'string' ? spec.script.trim() : '';
    return {
      script: script.length <= MAX_FROZEN_DIRECTOR_SCRIPT_LENGTH ? script : '',
      blocker: !script
        ? '当前内容缺少已确认脚本，未调用制作供应商'
        : script.length > MAX_FROZEN_DIRECTOR_SCRIPT_LENGTH
          ? `当前内容脚本超过 ${MAX_FROZEN_DIRECTOR_SCRIPT_LENGTH} 字符支持上限，未调用制作供应商`
          : '',
      source: 'legacy_project',
    };
  }
  const frozen = contract.scripts?.[language];
  const frozenBody = typeof frozen?.body === 'string' ? frozen.body : '';
  const oversized = frozenBody.length > MAX_FROZEN_DIRECTOR_SCRIPT_LENGTH;
  const valid = frozen?.status === 'confirmed'
    && frozen.generatedBy === 'director_agent'
    && Boolean(frozenBody.trim())
    && !oversized
    && frozen.hash === stableHash(frozen.body);
  return valid
    ? { script: frozenBody, blocker: '', source: 'frozen_contract' }
    : { script: '', blocker: oversized
      ? `内容订单的编导已确认脚本超过 ${MAX_FROZEN_DIRECTOR_SCRIPT_LENGTH} 字符支持上限，未调用制作供应商`
      : '内容订单缺少编导已确认脚本版本，未调用制作供应商', source: 'frozen_contract' };
}

export function productIdentity(product: NonNullable<EnterpriseProfile['products']['items']>[number], index: number): string {
  return enterpriseProductIdentity(product, index);
}

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => text(item, 160)).filter(Boolean);
  return text(value, 1_000).split(/[,，、;；|\n]+/).map(item => item.trim()).filter(Boolean);
}

export function dimensions(record: Record<string, unknown>): { width?: number; height?: number; aspectRatio?: string; focusX?: number; focusY?: number } {
  const width = Number(record.width || json<Record<string, unknown>>(record.metadata, {}).width || 0);
  const height = Number(record.height || json<Record<string, unknown>>(record.metadata, {}).height || 0);
  const explicit = text(record.aspectRatio || record.ratio || json<Record<string, unknown>>(record.metadata, {}).aspectRatio, 40);
  const focusX = Number(record.focusX ?? json<Record<string, unknown>>(record.metadata, {}).focusX);
  const focusY = Number(record.focusY ?? json<Record<string, unknown>>(record.metadata, {}).focusY);
  return {
    ...(width > 0 ? { width } : {}),
    ...(height > 0 ? { height } : {}),
    ...(explicit ? { aspectRatio: explicit } : width > 0 && height > 0 ? { aspectRatio: `${width}:${height}` } : {}),
    ...(Number.isFinite(focusX) && focusX >= 0 && focusX <= 1 ? { focusX } : {}),
    ...(Number.isFinite(focusY) && focusY >= 0 && focusY <= 1 ? { focusY } : {}),
  };
}

export function authoritativeMaterialRights(record: Record<string, unknown>): Partial<Pick<AssetCandidate,
  'rightsEvidenceRefs' | 'commercialUseApproved' | 'commercialUseApprovalEvidenceRefs'
  | 'modelInputAllowed' | 'derivativeUseAllowed' | 'sourceRevision' | 'currentSourceRevision' | 'segmentProfiles'>> {
  const provenance = record.provenance && typeof record.provenance === 'object' && !Array.isArray(record.provenance)
    ? record.provenance as Record<string, unknown> : {};
  const rightsEvidenceRefs = [...new Set([
    record.rightsEvidenceRef,
    record.licenseEvidence,
    record.consentRef,
    ...(Array.isArray(record.rightsEvidenceRefs) ? record.rightsEvidenceRefs : []),
    provenance.rightsEvidenceRef,
    provenance.authorizationRef,
  ].map(value => text(value, 500)).filter(value => value && !/(?:unverified|unknown|missing|pending|待确认|未确认)/i.test(value)))];
  const commercialUseApprovalEvidenceRefs = [...new Set([
    ...(Array.isArray(record.commercialUseApprovalEvidenceRefs) ? record.commercialUseApprovalEvidenceRefs : []),
    record.commercialUseApprovalEvidenceRef,
    provenance.commercialUseApprovalEvidenceRef,
  ].map(value => text(value, 500)).filter(value => value && !/(?:unverified|unknown|missing|pending|待确认|未确认)/i.test(value)))];
  const sourceRevision = text(record.analysisSourceRevision || record.sourceRevision, 500);
  const currentSourceRevision = text(record.sourceRevision || record.contentSha256 || record.sha256 || record.analysisSourceRevision, 500);
  return {
    ...(rightsEvidenceRefs.length ? { rightsEvidenceRefs } : {}),
    ...(typeof record.commercialUseApproved === 'boolean'
      ? { commercialUseApproved: record.commercialUseApproved }
      : {}),
    // A rights receipt may double as the commercial-use approval receipt only
    // when the source row explicitly records commercial approval.
    ...(record.commercialUseApproved === true ? {
      commercialUseApprovalEvidenceRefs: commercialUseApprovalEvidenceRefs.length
        ? commercialUseApprovalEvidenceRefs : rightsEvidenceRefs,
    } : {}),
    ...(typeof record.modelInputAllowed === 'boolean' ? { modelInputAllowed: record.modelInputAllowed } : {}),
    ...(typeof record.derivativeUseAllowed === 'boolean'
      ? { derivativeUseAllowed: record.derivativeUseAllowed }
      : typeof record.derivativesApproved === 'boolean'
        ? { derivativeUseAllowed: record.derivativesApproved }
        : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(currentSourceRevision ? { currentSourceRevision } : {}),
    ...(Array.isArray(record.segmentProfiles) ? { segmentProfiles: record.segmentProfiles } : {}),
  };
}

export function assetAuthorization(record: Record<string, unknown>, source: AssetCandidate['source']): AssetCandidate['authorization'] {
  const license = text(record.licenseEvidence || record.license, 500);
  if (license) return { status: 'licensed', scope: source === 'licensed_shared_material' ? 'shared' : 'tenant', evidence: license };
  if (source === 'enterprise_product') return { status: 'owned', scope: 'tenant', evidence: '企业知识库当前租户上传' };
  if (source === 'licensed_shared_material') {
    const evidence = text(record.license || record.licenseEvidence || record.authorization || (/licensed/i.test(text(record.sourceType)) ? record.sourceType : ''), 500);
    return { status: evidence ? 'licensed' : 'unknown', scope: 'shared', evidence };
  }
  return { status: 'owned', scope: 'tenant', evidence: text(record.authorization || record.provenance, 500) || '当前租户素材记录' };
}

export function assetEligible(asset: AssetCandidate): boolean {
  return !asset.synthetic && asset.authorization.status !== 'unknown';
}

export function narrationEvidenceForProduct(assets: AssetCandidate[], productId?: string): NarrationVisibleEvidence[] {
  const expectedProductId = text(productId, 200);
  return assets.map(asset => ({
    authorization: asset.authorization.status,
    productMatched: Boolean(expectedProductId && asset.productId === expectedProductId),
    synthetic: asset.synthetic,
    observations: asset.visualObservations,
  }));
}

function normalizedTokens(value: string): string[] {
  const latin = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  const chinese = value.match(/[\u3400-\u9fff]{2,6}/g) || [];
  return [...new Set([...latin, ...chinese])].slice(0, 80);
}

export function sceneIntent(script: string, start: number, end: number): string {
  const markers = [...script.matchAll(/^\[\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*s\s*\]\s*$/gim)];
  const markerIndex = markers.findIndex(match => Math.abs(Number(match[1]) - start) < 0.001 && Math.abs(Number(match[2]) - end) < 0.001);
  if (markerIndex < 0) return '';
  const from = markers[markerIndex]!.index!;
  const next = markers[markerIndex + 1]?.index;
  const block = script.slice(from, next);
  return block.split('\n').filter(line => /^(?:环境|镜头功能|画面)[：:]/.test(line.trim())).join('；').slice(0, 1_000);
}

export function sceneHasVisualEvidence(intent: string, asset: AssetCandidate): boolean {
  const observations = asset.visualObservations.filter(value => !/^企业知识库产品.+的已上传(?:视频|图片)$/.test(value));
  if (!observations.length) return false;
  const ignore = new Set([...normalizedTokens(asset.productName || ''), 'product', 'scene', 'the', 'and', 'with', 'show', '画面', '展示', '镜头', '环境', '产品']);
  const observed = observations.join(' ').toLowerCase();
  const chinese = [...intent.matchAll(/[\u3400-\u9fff]{2,}/g)].flatMap(match => Array.from({ length: match[0].length - 1 }, (_, index) => match[0].slice(index, index + 2)));
  const tokens = [...normalizedTokens(intent), ...chinese].filter(token => !ignore.has(token));
  return tokens.some(token => observed.includes(token.toLowerCase()));
}

/**
 * Selects only semantically related assets. Product routes have a hard product
 * ownership boundary; a high keyword score can never cross that boundary.
 */
export function matchSceneSources(input: {
  script: string;
  scenes: Array<{ start: number; end: number }>;
  assets: AssetCandidate[];
  route: ContentProductionRoute;
  productId?: string;
  lockedAssetIds?: string[];
}): { plan: SceneSourcePlanItem[]; gaps: string[] } {
  const locked = new Set(input.lockedAssetIds || []);
  const candidates = input.assets.filter(asset => {
    if (!assetEligible(asset)) return false;
    if (input.route === 'material') return locked.size > 0 && locked.has(asset.id);
    return Boolean(input.productId && asset.productId === input.productId);
  });
  if (!candidates.length) return { plan: [], gaps: [input.route === 'material' ? '已锁定素材不可用或缺少授权' : '缺少属于本产品的已授权视觉素材'] };
  const used = new Map<string, number>();
  const gaps: string[] = [];
  const plan = input.scenes.flatMap((scene, sceneIndex) => {
    const intent = sceneIntent(input.script, scene.start, scene.end);
    const tokens = normalizedTokens(intent);
    const ranked = candidates.filter(asset => sceneHasVisualEvidence(intent, asset)).map(asset => {
      const haystack = [asset.name, asset.productName, ...asset.visualObservations, ...asset.tags, asset.scriptAnalysis?.searchableText].filter(Boolean).join(' ').toLowerCase();
      const hits = tokens.filter(token => haystack.includes(token.toLowerCase()));
      const ownership = input.productId && asset.productId === input.productId ? 60 : input.route === 'material' ? 40 : 0;
      const observation = asset.visualObservations.length ? 20 : 0;
      const useCount = used.get(asset.id) || 0;
      const reusePenalty = useCount > 0 && used.size < candidates.length ? 100 : useCount * 12;
      return { asset, score: ownership + observation + hits.length * 5 - reusePenalty, hits, reusePenalty };
    }).sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
    const best = ranked[0];
    if (!best) {
      gaps.push(`第 ${sceneIndex + 1} 镜头缺少支持该画面描述的视觉观察，需补充相关真实素材`);
      return [];
    }
    used.set(best.asset.id, (used.get(best.asset.id) || 0) + 1);
    return [{
      sceneIndex, start: scene.start, end: scene.end, intent, assetId: best.asset.id,
      ...(best.asset.productId ? { productId: best.asset.productId } : {}), score: best.score,
      reasons: [
        input.route === 'material' ? '使用脚本生成前锁定的素材' : `素材归属产品 ${best.asset.productName || best.asset.productId}`,
        best.hits.length ? `语义命中：${best.hits.slice(0, 5).join('、')}` : '无关键词命中，按产品归属与已确认视觉观察安全降级',
        best.reusePenalty ? `重复使用扣分 ${best.reusePenalty}` : '优先未使用素材',
      ],
    }];
  });
  return { plan, gaps };
}

export function resolvePresentationMaterials(brief: VideoCreationPlan, script: string, scenes: Array<{start: number; end: number}>, assets: AssetCandidate[], route: ContentProductionRoute, routePlan: Pick<RouteSourcePlan, 'productId' | 'assetIds'>, options: {
  durations?: number[]; overrides?: Array<{ trimStart?: number }>; excluded?: Parameters<typeof allocateEvidenceClips>[0]['excluded'];
} = {}): { plan: SceneSourcePlanItem[]; gaps: string[] } {
  let choices;
  try { choices = presentationScenes(brief, scenes.length); } catch (error) { return { plan: [], gaps: [(error as Error).message] }; }
  const candidates = assets.filter(asset => assetEligible(asset) && (route === 'material'
    ? routePlan.assetIds.includes(asset.id) : Boolean(routePlan.productId && asset.productId === routePlan.productId)));
  const result = allocateEvidenceClips({ assets: candidates, excluded: options.excluded,
    scenes: choices.flatMap((choice, sceneIndex) => choice.source === 'avatar' ? [] : [{
      sceneIndex, intent: sceneIntent(script, scenes[sceneIndex].start, scenes[sceneIndex].end),
      duration: options.durations?.[sceneIndex] ?? scenes[sceneIndex].end - scenes[sceneIndex].start,
      materialId: choice.materialId || undefined, trimStart: options.overrides?.[sceneIndex]?.trimStart,
    }]),
  });
  return { gaps: result.gaps, plan: result.plan.map(clip => ({
    sceneIndex: clip.sceneIndex, ...scenes[clip.sceneIndex], intent: sceneIntent(script, scenes[clip.sceneIndex].start, scenes[clip.sceneIndex].end),
    assetId: clip.assetId, productId: candidates.find(asset => asset.id === clip.assetId)?.productId,
    sourceStart: clip.start, sourceEnd: Number.isFinite(clip.end) ? clip.end : undefined,
    evidenceSegmentId: clip.segmentId, observations: clip.observations, score: clip.score,
    reasons: [`已确认片段 ${clip.segmentId}`, `视觉依据：${clip.observations.join('；')}`],
  })) };
}

export function platformCreativeBrief(platform: string): string {
  const key = platform.toLowerCase();
  if (key.includes('linkedin')) return 'LinkedIn：专业决策者语气，先给业务问题与可信证据，弱化娱乐化表达，CTA 指向商务沟通。';
  if (key.includes('youtube')) return 'YouTube：标题与开场承诺一致，信息结构完整，镜头留出字幕安全区，CTA 指向进一步了解。';
  if (key.includes('instagram')) return 'Instagram：视觉优先、首屏识别产品，短句字幕，突出可保存或可分享的信息点。';
  if (key.includes('facebook')) return 'Facebook：上下文清晰、适合静音浏览，强调场景价值与可信说明。';
  if (key.includes('tiktok')) return 'TikTok：前 2 秒明确钩子，快节奏但不牺牲产品真实性，单一低门槛 CTA。';
  return `${platform || '已确认平台'}：保持平台安全区、可读字幕与单一 CTA；不跨平台复用同一标题、开场和节奏。`;
}

export function contentFingerprint(input: { route: ContentProductionRoute; productId?: string; referenceAnalysisId?: string; assetIds: string[]; script?: string }): string {
  return stableHash({ route: input.route, productId: input.productId || '', referenceAnalysisId: input.referenceAnalysisId || '', assetIds: [...input.assetIds].sort(), script: text(input.script, 30_000) });
}

export function detectContentDuplication(input: {
  candidate: { route: ContentProductionRoute; productId?: string; referenceAnalysisId?: string; assetIds: string[]; script?: string; explicitMaterials?: boolean };
  existing: Array<{ fingerprint?: string; route?: ContentProductionRoute; assetIds?: string[]; script?: string }>;
}): { duplicate: boolean; pathDifference: boolean; reason: string } {
  const fingerprint = contentFingerprint(input.candidate);
  if (input.existing.some(item => item.fingerprint === fingerprint)) return { duplicate: true, pathDifference: false, reason: '内容证据、路径与脚本完全重复' };
  const candidateAssets = new Set(input.candidate.assetIds);
  const collision = input.existing.find(item => item.route !== input.candidate.route && (item.assetIds || []).length > 0 && (item.assetIds || []).every(id => candidateAssets.has(id)));
  const normalizedScript = text(input.candidate.script, 30_000).replace(/\s+/g, '');
  const sameScript = input.existing.some(item => item.route !== input.candidate.route && normalizedScript && text(item.script, 30_000).replace(/\s+/g, '') === normalizedScript);
  if ((collision && !input.candidate.explicitMaterials) || sameScript) return { duplicate: false, pathDifference: false, reason: sameScript ? '不同路径生成了相同脚本' : '不同路径完全复用了同一素材集合' };
  return { duplicate: false, pathDifference: true, reason: '' };
}

export function selectContentProjectsForTick<T extends { stage: string; retryable: boolean }>(projects: T[], limit = CONTENT_PRODUCTION_MAX_CONCURRENCY): T[] {
  const selected: T[] = [];
  let scriptSlotUsed = false;
  for (const project of projects) {
    if (project.stage === 'completed' || (project.stage === 'blocked' && !project.retryable)) continue;
    // Script uniqueness is checked against persisted siblings. Keep that stage
    // serialized while allowing render/voice/quality work to proceed in parallel.
    const effectiveStage = project.stage === 'blocked' ? 'script' : project.stage;
    if (effectiveStage === 'script' && scriptSlotUsed) continue;
    selected.push(project);
    if (effectiveStage === 'script') scriptSlotUsed = true;
    if (selected.length >= Math.max(1, limit)) break;
  }
  return selected;
}

export function enabledRoutes(config: Pick<DigitalEmployeeConfig, 'enabledWorkflows'>): ContentProductionRoute[] {
  // Explicit content preparation remains independent of publishing accounts.
  const enabled = new Set(config.enabledWorkflows);
  return [
    ...(enabled.has('viral_clone') ? ['clone' as const] : []),
    ...(enabled.has('product_content') ? ['product' as const] : []),
    ...(enabled.has('material_content') ? ['material' as const] : []),
  ];
}

/** Configuration enables capabilities; only this batch's selected routes require evidence. */
export function requiredContentRoutes(input: {
  frozenOrders?: Array<{ route: ContentProductionRoute }>;
  videoPlans?: Array<{ route: ContentProductionRoute }>;
  projectRoutes?: ContentProductionRoute[];
  enabled: ContentProductionRoute[];
}): ContentProductionRoute[] {
  const selected = input.frozenOrders?.length ? input.frozenOrders.map(order => order.route)
    : input.videoPlans?.length ? input.videoPlans.map(plan => plan.route)
      : input.projectRoutes?.length ? input.projectRoutes : input.enabled;
  return [...new Set(selected)];
}

export function contentProductionKnowledgeGaps(input: { enabled: ContentProductionRoute[]; evidence: ContentRouteEvidence }) {
  const gaps: ContentProductionAdvanceResult['knowledgeGaps'] = [];
  if (!input.enabled.length) gaps.push({ type: 'knowledge_gap', key: 'content_route', label: '未启用内容生产路径', destination: 'digitalEmployees', purpose: '在 Agent 边界中启用爆款裂变、产品生成或素材生成' });
  if (input.enabled.includes('clone') && !input.evidence.exactAnalysisIds.length) gaps.push({ type: 'knowledge_gap', key: 'exact_analysis', label: '缺少爆款全片精确分析', destination: 'socialInspiration', purpose: '给爆款裂变提供可验证的节奏和分镜依据' });
  if ((input.enabled.includes('clone') || input.enabled.includes('product')) && !input.evidence.productNames.length) gaps.push({ type: 'knowledge_gap', key: 'product', label: '缺少重点产品', destination: 'enterprise', purpose: '为脚本和画面提供可追溯产品事实' });
  if (input.enabled.length && !input.evidence.assetIds.length) gaps.push({ type: 'knowledge_gap', key: 'material', label: '缺少可用企业/授权素材', destination: 'smartAssets', purpose: '为分镜、配音字幕和真实成片渲染提供画面' });
  return gaps;
}

/** Pure allocator: always picks the currently least-used eligible route. */
export function allocateBalancedContentRoutes(input: {
  count: number;
  enabled: ContentProductionRoute[];
  evidence: ContentRouteEvidence;
  priorCounts?: Partial<Record<ContentProductionRoute, number>>;
}): ContentRoutePlan {
  const blockers: string[] = [];
  const eligibleRoutes = input.enabled.filter(route => {
    if (route === 'clone') {
      const ok = input.evidence.exactAnalysisIds.length > 0 && input.evidence.productNames.length > 0 && input.evidence.assetIds.length > 0;
      if (!ok) blockers.push('爆款裂变需要“全片精确分析 + 重点产品 + 可用自有/授权素材”');
      return ok;
    }
    if (route === 'product') {
      const ok = input.evidence.productNames.length > 0 && input.evidence.assetIds.length > 0;
      if (!ok) blockers.push('产品生成需要“重点产品资料 + 至少 1 个可用产品图片/视频”');
      return ok;
    }
    const ok = input.evidence.assetIds.length > 0;
    if (!ok) blockers.push('素材生成需要企业素材库中至少 1 个可编辑的真实图片/视频');
    return ok;
  });
  const counts: Record<ContentProductionRoute, number> = {
    clone: Number(input.priorCounts?.clone || 0),
    product: Number(input.priorCounts?.product || 0),
    material: Number(input.priorCounts?.material || 0),
  };
  const order: ContentProductionRoute[] = ['clone', 'product', 'material'];
  const allocations: ContentProductionRoute[] = [];
  for (let index = 0; index < Math.max(0, Math.min(12, Math.floor(input.count))); index += 1) {
    const route = eligibleRoutes
      .slice()
      .sort((left, right) => counts[left] - counts[right] || order.indexOf(left) - order.indexOf(right))[0];
    if (!route) break;
    allocations.push(route);
    counts[route] += 1;
  }
  return { allocations, eligibleRoutes, blockers: [...new Set(blockers)], evidence: input.evidence };
}
