import { buildSocialCrawlStrategy } from '../../shared/socialInspirationStrategy.js';
import type { SocialCrawlStrategy } from '../../shared/contracts/socialContentWorkflow.js';
import { normalizeModePolicies } from '../socialDiscovery/domain.js';
import { discoveryPerspective, generateProductKeywords } from '../lib/productDiscovery.js';
import type { ProductKeywordRecommendation } from '../../shared/productDiscovery.js';

export const WEEKLY_DISCOVERY_PRODUCT_BINDING_VERSION = 'selected-products.v1';

export interface ConfirmedWeeklyDiscoveryBoundary {
  businessGoal: string;
  products: string[];
  market: string;
  language: string;
  audience: string;
  platforms: string[];
  lookbackDays: number;
  resultLimit: number;
  approvedBy: string;
  workflowRunId: string;
  workflowTaskId: string;
}

export interface WeeklyDiscoveryEnterpriseFacts {
  companyType?: string;
  enabledRoutes?: string[];
  products: Array<{
    name: string;
    category?: string;
    highlights?: string;
    material?: string;
  }>;
}

function compactProductIdentity(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Bind every selected weekly-plan product to exactly one enterprise product.
 * A selection may include the product name plus a SKU/barcode, so containment
 * is allowed only when it resolves uniquely. Never broaden back to all facts:
 * that would let an unrelated SKU influence the approved discovery scope.
 */
export function selectWeeklyDiscoveryProductFacts(
  selectedProducts: string[],
  facts: WeeklyDiscoveryEnterpriseFacts['products'],
): WeeklyDiscoveryEnterpriseFacts['products'] {
  const selected = [...new Set(selectedProducts.map(value => value.trim()).filter(Boolean))];
  const available = facts
    .map(item => ({ item, identity: compactProductIdentity(item.name) }))
    .filter(row => row.identity.length > 0);
  const bound = new Set<WeeklyDiscoveryEnterpriseFacts['products'][number]>();
  for (const product of selected) {
    const identity = compactProductIdentity(product);
    const exact = available.filter(row => row.identity === identity);
    const candidates = exact.length ? exact : available.filter(row =>
      identity.includes(row.identity) || row.identity.includes(identity),
    );
    if (candidates.length !== 1) {
      const reason = candidates.length === 0 ? '未找到' : '匹配到多个';
      throw new Error(`编导关键词生成受阻：选中产品“${product}”在企业知识库中${reason}产品事实。`);
    }
    bound.add(candidates[0]!.item);
  }
  if (!bound.size) throw new Error('编导关键词生成受阻：周计划没有可绑定的选中产品。');
  return [...bound];
}

export function buildConfirmedWeeklyDiscoveryScope(
  input: ConfirmedWeeklyDiscoveryBoundary,
  version: number,
  now = new Date(),
): SocialCrawlStrategy | null {
  const products = [...new Set(input.products.map(value => value.trim()).filter(Boolean))];
  const platforms = [...new Set(input.platforms.map(value => value.trim().toLowerCase()).filter(Boolean))];
  const market = input.market.trim();
  const language = input.language.trim();
  const approvedBy = input.approvedBy.trim();
  if (!products.length || !platforms.length || !market || !language || !approvedBy || version < 1) return null;

  const strategy = buildSocialCrawlStrategy({
    businessGoal: input.businessGoal.trim() || '为已确认周计划采集可复刻的爆款内容证据',
    productTerms: products,
    platforms,
    market,
    language,
    audienceRole: /采购|经销|进口|buyer|distributor|importer/i.test(input.audience) ? 'brand_buyer' : 'consumer',
    lookbackDays: input.lookbackDays,
    resultLimit: input.resultLimit,
    scopeMode: 'market_focus',
    industryFocus: products[0],
    marketFocus: market,
    now,
  });
  strategy.keywordSet.version = version;
  strategy.keywordSet.createdBy = 'director_agent';
  strategy.discoveryBrief.keywordSetVersion = version;
  strategy.discoveryBrief.createdBy = 'director_agent';
  strategy.discoveryBrief.modePolicies = normalizeModePolicies(
    undefined,
    strategy.discoveryBrief.discoveryModes,
    strategy.discoveryBrief.resultLimit,
    strategy.discoveryBrief.platforms,
  );
  strategy.createdBy = 'director_agent';
  strategy.approval = {
    status: 'approved',
    approvedBy: 'user',
    approvedAt: now.toISOString(),
    scopeVersion: version,
  };
  (strategy as SocialCrawlStrategy & { authorizationSource?: Record<string, string> }).authorizationSource = {
    type: 'confirmed_weekly_plan',
    workflowRunId: input.workflowRunId,
    workflowTaskId: input.workflowTaskId,
    approvedBy,
  };
  return strategy;
}

/**
 * A confirmed weekly plan authorizes discovery, but it does not authorize SKU
 * titles as search terms. The Director must derive the five generic category
 * terms from the frozen enterprise facts before an approved scope can exist.
 */
export async function buildConfirmedWeeklyDiscoveryScopeWithKeywords(
  input: ConfirmedWeeklyDiscoveryBoundary,
  version: number,
  facts: WeeklyDiscoveryEnterpriseFacts,
  now = new Date(),
  generate: typeof generateProductKeywords = generateProductKeywords,
): Promise<SocialCrawlStrategy> {
  const strategy = buildConfirmedWeeklyDiscoveryScope(input, version, now);
  if (!strategy) throw new Error('编导关键词生成受阻：周计划缺少产品、平台、市场或语言配置。');
  const selectedProductFacts = selectWeeklyDiscoveryProductFacts(input.products, facts.products);
  const source = selectedProductFacts
    .map(item => [item.name, item.category, item.highlights, item.material].map(value => String(value || '').trim()).filter(Boolean).join(' · '))
    .filter(Boolean)
    .join('\n');
  if (source.length < 10) throw new Error('编导关键词生成受阻：企业知识库缺少可用产品事实，请先完善产品配置。');
  let recommendation: ProductKeywordRecommendation;
  try {
    recommendation = await generate({
      source,
      sourceName: '企业知识库产品资料',
      perspective: discoveryPerspective(facts.companyType || '', facts.enabledRoutes || []),
      market: input.market,
      language: input.language,
      focus: input.products.join('、'),
      allowSupplyChainQueries: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误';
    throw new Error(`编导关键词生成受阻：${detail}`);
  }
  strategy.keywordRecommendation = recommendation;
  (strategy as SocialCrawlStrategy & { productFactBinding?: Record<string, unknown> }).productFactBinding = {
    version: WEEKLY_DISCOVERY_PRODUCT_BINDING_VERSION,
    selectedProducts: [...new Set(input.products.map(value => value.trim()).filter(Boolean))],
    enterpriseProductNames: selectedProductFacts.map(item => item.name),
  };
  const broadTerms = recommendation.broadTerms.map(item => item.term);
  strategy.keywordSet.graph.discoverySeeds = strategy.keywordSet.graph.discoverySeeds.slice(0, 1);
  strategy.keywordSet.graph.discoverySeeds[0].queryVariants = broadTerms;
  const discoveryKeywords = strategy.keywords.find(item => item.category === 'discovery_seed');
  if (discoveryKeywords) discoveryKeywords.values = broadTerms;
  strategy.keywordSet.graph.sceneClusters = recommendation.mediumTerms.map((item, index) => ({
    sceneId: `weekly_keyword_scene_${index + 1}`,
    label: item.term,
    productTask: input.products[0],
    demandDimension: index % 2 === 0 ? 'problem' : 'decision_concern',
    queryVariants: [item.term],
    evidence: ['product'],
    status: 'approved',
  }));
  const sceneKeywords = strategy.keywords.find(item => item.category === 'scene_cluster');
  if (sceneKeywords) sceneKeywords.values = recommendation.mediumTerms.map(item => item.term);
  strategy.discoveryBrief.trackedSceneIds = strategy.keywordSet.graph.sceneClusters.map(item => item.sceneId);
  return strategy;
}
