import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { callLLM } from '../agents/llm.js';
import { enterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';
import { DEFAULT_BIZ_RULES, normalizeProfile, text } from './enterpriseProfileStore.js';
import type { EnterpriseProfile, FaqItem } from './enterpriseProfileContracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type KnowledgeSectionKey = 'products' | 'materials' | 'bizRules' | 'faq' | 'market' | 'company';

export interface KnowledgeCompletion {
  completed: number;
  total: 6;
  profileCompleteness: {
    percentage: number;
    completed: number;
    total: 4;
    checks: Record<'productImage' | 'price' | 'certificate' | 'market', boolean>;
  };
  todos: Array<{
    id: string;
    kind: 'product_image' | 'price' | 'certificate' | 'market';
    label: string;
    description: string;
    view: 'products' | 'company';
    anchor: string;
    productId?: string;
    productIndex?: number;
  }>;
  sections: Record<KnowledgeSectionKey, { completed: boolean; label: string }>;
  notificationsReady: boolean;
  capabilities: {
    productGrounding: { unlocked: boolean; label: string; reason: string };
    quoteDraft: { unlocked: boolean; label: string; reason: string };
    autoReply: { unlocked: boolean; label: string; reason: string };
    importantAlerts: { unlocked: boolean; label: string; reason: string };
  };
}

function assetCounts(profile: EnterpriseProfile) {
  const items = profile.products.items ?? [];
  return items.reduce((acc, item) => {
    acc.images += (item.images?.length ?? 0) + (item.imageUrl ? 1 : 0);
    acc.videos += item.videos?.length ?? 0;
    acc.documents += item.documents?.length ?? 0;
    return acc;
  }, { images: 0, videos: 0, documents: 0 });
}

function hasTestedNotificationTarget(profile: EnterpriseProfile): boolean {
  return Boolean((profile.notifications?.receivers ?? []).length >= 1 && profile.notifications?.lastTestAt);
}

export function knowledgeCompletion(profile: EnterpriseProfile): KnowledgeCompletion {
  const normalized = normalizeProfile(profile);
  const productItems = normalized.products.items ?? [];
  const counts = assetCounts(normalized);
  const totalAssets = counts.images + counts.videos + counts.documents;
  const hasProductVideo = (normalized.products.items ?? []).some(item => (item.videos?.length ?? 0) >= 1);
  const sections: KnowledgeCompletion['sections'] = {
    products: { label: '产品资料', completed: (normalized.products.items ?? []).length >= 1 },
    materials: { label: '素材库', completed: hasProductVideo || totalAssets >= 5 },
    bizRules: {
      label: '报价与业务规则',
      completed: Boolean(normalized.bizRules?.quoteMode && normalized.bizRules.samplePolicy && normalized.bizRules.paymentTerms),
    },
    faq: { label: '常见问答', completed: (normalized.faq ?? []).length >= 5 },
    market: {
      label: '目标市场与语言',
      completed: Boolean(text(normalized.company.mainMarkets) && text(normalized.company.primaryLanguages)),
    },
    company: { label: '公司介绍', completed: text(normalized.company.description).length >= 50 },
  };
  const productImageReady = productItems.length > 0 && productItems.every(item => Boolean(
    text(item.imageUrl) || (item.images?.length ?? 0) > 0,
  ));
  const priceReady = Boolean(text(normalized.products.priceRange) || text(normalized.bizRules?.priceRange))
    || (productItems.length > 0 && productItems.every(item => Boolean(text(item.priceRange) || text(item.retailPrice) || text(item.tagPrice))));
  const certificateReady = Boolean(text(normalized.products.certifications))
    || (productItems.length > 0 && productItems.every(item => Boolean(
      text(item.certifications) || (item.certificateImages?.length ?? 0) > 0 || (item.documents?.length ?? 0) > 0,
    )));
  const marketReady = Boolean(text(normalized.company.mainMarkets) && text(normalized.company.primaryLanguages));
  const checks = { productImage: productImageReady, price: priceReady, certificate: certificateReady, market: marketReady };
  const incompleteImage = productItems.findIndex(item => !(text(item.imageUrl) || (item.images?.length ?? 0) > 0));
  const incompletePrice = productItems.findIndex(item => !(text(item.priceRange) || text(item.retailPrice) || text(item.tagPrice)));
  const incompleteCertificate = productItems.findIndex(item => !(text(item.certifications) || (item.certificateImages?.length ?? 0) > 0 || (item.documents?.length ?? 0) > 0));
  const todos: KnowledgeCompletion['todos'] = [];
  if (!productImageReady) todos.push({
    id: `product-image-${Math.max(0, incompleteImage)}`, kind: 'product_image', label: '补产品图',
    description: productItems[incompleteImage]?.name ? `${productItems[incompleteImage]!.name} 缺少可用于内容与投放的产品图` : '先添加产品并上传一张产品图',
    view: 'products', anchor: 'product-image',
    ...(incompleteImage >= 0 ? { productId: enterpriseProductIdentity(productItems[incompleteImage]!, incompleteImage), productIndex: incompleteImage } : {}),
  });
  if (!priceReady) todos.push({
    id: `price-${Math.max(0, incompletePrice)}`, kind: 'price', label: '补价格',
    description: productItems[incompletePrice]?.name ? `${productItems[incompletePrice]!.name} 缺少参考价格` : '补充产品或内部参考价格',
    view: 'products', anchor: 'product-price', ...(incompletePrice >= 0 ? { productId: enterpriseProductIdentity(productItems[incompletePrice]!, incompletePrice), productIndex: incompletePrice } : {}),
  });
  if (!certificateReady) todos.push({
    id: `certificate-${Math.max(0, incompleteCertificate)}`, kind: 'certificate', label: '补证书',
    description: productItems[incompleteCertificate]?.name ? `${productItems[incompleteCertificate]!.name} 缺少认证或资质凭证` : '补充认证名称或上传资质凭证',
    view: 'products', anchor: 'product-certificate', ...(incompleteCertificate >= 0 ? { productId: enterpriseProductIdentity(productItems[incompleteCertificate]!, incompleteCertificate), productIndex: incompleteCertificate } : {}),
  });
  if (!marketReady) todos.push({
    id: 'market', kind: 'market', label: '补市场信息', description: '补充目标市场和主要沟通语言',
    view: 'company', anchor: 'enterprise-language-settings',
  });
  const completedChecks = Object.values(checks).filter(Boolean).length;
  return {
    completed: Object.values(sections).filter(section => section.completed).length,
    total: 6,
    profileCompleteness: { percentage: completedChecks * 25, completed: completedChecks, total: 4, checks },
    todos,
    sections,
    notificationsReady: hasTestedNotificationTarget(normalized),
    capabilities: {
      productGrounding: {
        unlocked: sections.products.completed,
        label: '看懂产品',
        reason: sections.products.completed ? 'AI 回复会引用已录入的真实产品' : '先录入 1 个主推产品',
      },
      quoteDraft: {
        unlocked: sections.products.completed && sections.bizRules.completed,
        label: '识别询价并转人工',
        reason: sections.bizRules.completed ? 'AI 会整理询价条件并提醒销售接手' : '再确认样品、付款和交期口径',
      },
      autoReply: {
        unlocked: (normalized.faq ?? []).filter(item => item.approvedForAuto && item.question && item.answer).length >= 5,
        label: '自动回答常见问题',
        reason: (normalized.faq ?? []).filter(item => item.approvedForAuto && item.question && item.answer).length >= 5
          ? '已审批的标准问答可在安全范围内自动发送'
          : '审批 5 条常见问答后解锁',
      },
      importantAlerts: {
        unlocked: hasTestedNotificationTarget(normalized),
        label: '及时提醒重要询盘',
        reason: hasTestedNotificationTarget(normalized) ? '重要询盘会通知指定负责人' : '设置并测试 1 位通知接收人',
      },
    },
  };
}

export function bizRulesReady(profile: EnterpriseProfile): boolean {
  return knowledgeCompletion(profile).sections.bizRules.completed;
}

export function shouldSuppressPrice(profile: EnterpriseProfile): boolean {
  return true;
}

export function autoFaqReady(profile: EnterpriseProfile): boolean {
  return (normalizeProfile(profile).faq ?? []).filter(item => item.approvedForAuto && item.question && item.answer).length >= 5;
}

export function findApprovedFaqAnswer(profile: EnterpriseProfile, message: string): FaqItem | null {
  const normalizedMessage = text(message).toLowerCase();
  if (!normalizedMessage) return null;
  const candidates = (normalizeProfile(profile).faq ?? []).filter(item => item.approvedForAuto && item.question && item.answer);
  return candidates.find(item => normalizedMessage.includes(item.question.toLowerCase()) || item.question.toLowerCase().includes(normalizedMessage)) ?? null;
}

export function buildBizRulesInstruction(profile: EnterpriseProfile): string {
  const normalized = normalizeProfile(profile);
  const rules = normalized.bizRules ?? DEFAULT_BIZ_RULES;
  const lines = [
    'Enterprise business rules:',
    `Quote mode: ${rules.quoteMode || 'not_configured'}`,
    rules.priceRange ? `Internal price reference only; never send it to the buyer: ${rules.priceRange}` : '',
    'Hard rule: never send prices, currency amounts, unit prices, discounts, or quotation promises. Mark price requests as waiting_for_human_quote and hand them to a human seller.',
    rules.moq ? `MOQ guidance: ${rules.moq}` : '',
    rules.samplePolicy ? `Sample policy: ${rules.samplePolicy}` : '',
    rules.paymentTerms ? `Payment terms: ${rules.paymentTerms}` : '',
    rules.leadTime ? `Lead time: ${rules.leadTime}` : '',
    rules.bargainPolicy ? `Bargaining policy: ${rules.bargainPolicy}${rules.bargainFloor ? `; floor note: ${rules.bargainFloor}` : ''}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

export function notificationTargetReady(profile: EnterpriseProfile): boolean {
  return hasTestedNotificationTarget(normalizeProfile(profile));
}

export function buildEnterpriseContext(profile: EnterpriseProfile): string {
  if (profile.dataGovernance?.aiAccessEnabled === false) return '';
  const parts: string[] = [];
  if (profile.factVersion) parts.push(`企业事实版本：${profile.factVersion.id}`);
  if (profile.company.name) parts.push(`公司名称：${profile.company.name}`);
  if (profile.company.industry) parts.push(`行业类目：${profile.company.industry}`);
  if (profile.company.companyType) parts.push(`企业类型：${profile.company.companyType}`);
  if (profile.socialStrategy?.enabledRoutes?.length) parts.push(`社媒合作路线：${profile.socialStrategy.enabledRoutes.join('/')}`);
  if (profile.company.mainMarkets) parts.push(`主攻市场：${profile.company.mainMarkets}`);
  if (profile.company.primaryLanguages) parts.push(`主要业务语言：${profile.company.primaryLanguages}`);
  if (profile.company.socialPlatformExperience) parts.push(`海外平台经验：${profile.company.socialPlatformExperience}`);
  if (profile.company.description) parts.push(`公司简介：${profile.company.description}`);
  if (profile.products.categories) parts.push(`主营产品：${profile.products.categories}`);
  if (profile.products.priceRange) parts.push(`价格区间：${profile.products.priceRange}`);
  if (profile.products.moq) parts.push(`起订量：${profile.products.moq}`);
  if (profile.products.certifications) parts.push(`认证资质：${profile.products.certifications}`);
  if (profile.products.highlights) parts.push(`产品优势：${profile.products.highlights}`);
  if (Array.isArray(profile.products.items) && profile.products.items.length) {
    profile.products.items.forEach((item, index) => {
      const details = [
        item.name || `产品${index + 1}`,
        item.category ? `类目：${item.category}` : '',
        item.priceRange ? `价格：${item.priceRange}` : '',
        item.moq ? `起订量：${item.moq}` : '',
        item.certifications ? `资质：${item.certifications}` : '',
        item.highlights ? `卖点：${item.highlights}` : '',
        item.images?.length ? `图片附件：${item.images.map(a => a.name).join('、')}` : '',
        item.videos?.length ? `视频附件：${item.videos.map(a => a.name).join('、')}` : '',
        item.documents?.length ? `资质文书附件：${item.documents.map(a => a.name).join('、')}` : '',
        item.factoryImages?.length ? `工厂实拍素材：${item.factoryImages.map(a => a.name).join('、')}` : '',
        item.packagingImages?.length ? `包装定制素材：${item.packagingImages.map(a => a.name).join('、')}` : '',
        item.certificateImages?.length ? `证书资质素材：${item.certificateImages.map(a => a.name).join('、')}` : '',
        item.sceneImages?.length ? `使用场景素材：${item.sceneImages.map(a => a.name).join('、')}` : '',
        item.brandAssets?.length ? `品牌视觉素材：${item.brandAssets.map(a => a.name).join('、')}` : '',
      ].filter(Boolean);
      if (details.length) parts.push(`产品${index + 1}：${details.join('；')}`);
    });
  }
  if (profile.bizRules) {
    parts.push(`Business rules: quoteMode=${profile.bizRules.quoteMode || 'not_configured'}; priceRange=${profile.bizRules.priceRange || ''}; moq=${profile.bizRules.moq || ''}; samplePolicy=${profile.bizRules.samplePolicy || ''}; paymentTerms=${profile.bizRules.paymentTerms || ''}; leadTime=${profile.bizRules.leadTime || ''}; bargainPolicy=${profile.bizRules.bargainPolicy || ''}; bargainFloor=${profile.bizRules.bargainFloor || ''}`);
  }
  const approvedFaq = (profile.faq ?? []).filter(item => item.approvedForAuto && item.question && item.answer);
  if (approvedFaq.length) {
    parts.push(`Approved FAQ for auto reply:\n${approvedFaq.map(item => `Q: ${item.question}\nA: ${item.answer}`).join('\n')}`);
  }
  if (profile.notifications?.receivers?.length) {
    parts.push(`Notification receivers: ${profile.notifications.receivers.map(item => `${item.name}/${item.channel}`).join('; ')}; workHours=${profile.notifications.workHours.start}-${profile.notifications.workHours.end}; quietOutsideHours=${profile.notifications.quietOutsideHours}; nightMode=${profile.notifications.nightMode.enabled ? 'enabled' : 'disabled'}`);
  }
  if (profile.handoffRules) {
    parts.push(`Handoff rules: keywords=${profile.handoffRules.keywords.join('/')}; missStreakToDraft=${profile.handoffRules.missStreakToDraft}; negativeSentiment=${profile.handoffRules.negativeSentiment}`);
  }
  if (profile.brand?.name) parts.push(`品牌名称：${profile.brand.name}`);
  if (profile.brand?.usp) parts.push(`核心卖点：${profile.brand.usp}`);
  if (profile.brand?.tone) parts.push(`品牌调性：${profile.brand.tone}`);
  if (profile.brand?.preferredLanguages) parts.push(`首选输出语言：${profile.brand.preferredLanguages}`);
  if (profile.brand?.taboos) parts.push(`禁忌话题：${profile.brand.taboos}`);
  if (profile.strategy?.currentGoal) parts.push(`当前经营目标：${profile.strategy.currentGoal}`);
  if (profile.strategy?.focusProducts) parts.push(`重点产品：${profile.strategy.focusProducts}`);
  if (profile.strategy?.focusMarkets) parts.push(`重点市场：${profile.strategy.focusMarkets}`);
  if (profile.strategy?.excludedMarkets) parts.push(`暂不经营市场：${profile.strategy.excludedMarkets}`);
  if (profile.strategy?.pricingStrategy) parts.push(`价格策略：${profile.strategy.pricingStrategy}`);
  if (profile.strategy?.minMargin) parts.push(`最低利润要求：${profile.strategy.minMargin}`);
  if (profile.strategy?.agentAutonomy) parts.push(`Agent 执行权限：${profile.strategy.agentAutonomy}`);
  if (profile.strategy?.aiAutonomy) parts.push(`AI 参与程度：${profile.strategy.aiAutonomy}`);
  if (profile.customers?.targetProfiles) parts.push(`目标客户画像：${profile.customers.targetProfiles}`);
  if (profile.customers?.highValueSignals) parts.push(`高价值客户信号：${profile.customers.highValueSignals}`);
  if (profile.customers?.lowQualitySignals) parts.push(`低质量询盘特征：${profile.customers.lowQualitySignals}`);
  if (profile.customers?.commonQuestions) parts.push(`客户常问问题：${profile.customers.commonQuestions}`);
  if (profile.customers?.followupStyle) parts.push(`跟进偏好：${profile.customers.followupStyle}`);
  if (profile.operations?.leadTime) parts.push(`交期能力：${profile.operations.leadTime}`);
  if (profile.operations?.customization) parts.push(`定制能力：${profile.operations.customization}`);
  if (profile.operations?.logistics) parts.push(`物流履约：${profile.operations.logistics}`);
  if (profile.operations?.paymentTerms) parts.push(`付款条款：${profile.operations.paymentTerms}`);
  if (profile.operations?.riskNotes) parts.push(`履约风险提示：${profile.operations.riskNotes}`);
  if (profile.agentLearning?.provenAngles) parts.push(`已验证有效角度：${profile.agentLearning.provenAngles}`);
  if (profile.agentLearning?.weakAngles) parts.push(`低效角度/需降权：${profile.agentLearning.weakAngles}`);
  if (profile.agentLearning?.pendingAssumptions) parts.push(`待用户确认推断：${profile.agentLearning.pendingAssumptions}`);
  if (profile.agentLearning?.userCorrections) parts.push(`用户纠正偏好：${profile.agentLearning.userCorrections}`);
  if (profile.knowledge) parts.push(`补充知识：${profile.knowledge}`);
  return parts.join('\n');
}

function fallbackFaqStructure(raw: string): FaqItem[] {
  const lines = raw.split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
  const items: FaqItem[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const [questionPart, ...answerParts] = line.split(/[：:]/);
    const looksLikeQuestion = /[?？]|^(q|问|问题)/i.test(line);
    if (answerParts.length || looksLikeQuestion) {
      const question = answerParts.length ? questionPart.replace(/^(q|问|问题)\s*/i, '').trim() : line;
      const answer = answerParts.join(':').replace(/^(a|答|答案)\s*/i, '').trim() || lines[index + 1] || '';
      items.push({ id: randomUUID(), question, answer, approvedForAuto: false });
      if (!answerParts.length && lines[index + 1]) index += 1;
    }
  }
  if (!items.length && raw.trim()) {
    items.push({ id: randomUUID(), question: '常见问题', answer: raw.trim(), approvedForAuto: false });
  }
  return items.slice(0, 20);
}

function parseFaqItemsFromLLM(raw: string): FaqItem[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(item => ({
      id: randomUUID(),
      question: text(item?.question),
      answer: text(item?.answer),
      approvedForAuto: false,
    })).filter(item => item.question && item.answer).slice(0, 30);
  } catch {
    return [];
  }
}

export async function structureFaqText(raw: string): Promise<FaqItem[]> {
  const source = raw.trim();
  if (!source) return [];
  try {
    const prompt = [
      '把下面旧版常见问答文本整理成 JSON 数组。',
      '只返回 JSON，不要解释。数组元素格式：{"question":"客户可能这样问","answer":"标准回答"}。',
      '合并重复问题，保留卖家原意，不要编造价格、交期或政策。',
      '',
      source,
    ].join('\n');
    const result = parseFaqItemsFromLLM(await callLLM(prompt));
    if (result.length) return result;
  } catch {
    // Fall through to deterministic parsing.
  }
  return fallbackFaqStructure(source);
}

export type PackIndustry = 'apparel' | 'home' | 'general';
export type PackScenario = 'presales' | 'shipping' | 'aftersales' | 'credentials';
interface PackEntry { q: string; a: string; vars?: string[] }

const PACK_ROOT = path.join(__dirname, '../knowledge/packs');
export const INDUSTRY_LABELS: Record<PackIndustry, string> = { apparel: '服装', home: '家居', general: '通用' };
export const SCENARIO_LABELS: Record<PackScenario, string> = { presales: '售前', shipping: '物流与运费', aftersales: '售后', credentials: '公司资质' };

function packVars(profile: EnterpriseProfile): Record<string, string> {
  const rules = profile.bizRules ?? DEFAULT_BIZ_RULES;
  return {
    moq: text(rules.moq),
    samplePolicy: text(rules.samplePolicy),
    paymentTerms: text(rules.paymentTerms),
    leadTime: text(rules.leadTime),
    priceRange: text(rules.priceRange),
    bargainFloor: text(rules.bargainFloor),
  };
}

function readPack(industry: PackIndustry, scenario: PackScenario): PackEntry[] {
  const file = path.join(PACK_ROOT, industry, `${scenario}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as PackEntry[];
  return Array.isArray(raw) ? raw : [];
}

export function fillPackEntry(entry: PackEntry, vars: Record<string, string>) {
  const required = Array.isArray(entry.vars) ? entry.vars : [];
  const missingVars = required.filter(key => !text(vars[key]));
  const answer = required.reduce((next, key) => next.replaceAll(`{${key}}`, vars[key] || `{${key}}`), entry.a);
  return {
    q: text(entry.q),
    a: answer,
    vars: required,
    missingVars,
    ready: missingVars.length === 0,
  };
}

export function inferIndustry(profile: EnterpriseProfile): PackIndustry {
  const raw = `${profile.company?.industry || ''} ${profile.products?.categories || ''}`.toLowerCase();
  if (/服装|服饰|衣|裤|裙|鞋|帽|apparel|fashion|garment|clothing|textile/.test(raw)) return 'apparel';
  if (/家居|家具|家纺|收纳|厨房|home|house|furniture|decor|kitchen/.test(raw)) return 'home';
  return 'general';
}

export function buildPackPreview(profile: EnterpriseProfile, industry: PackIndustry, scenario: PackScenario) {
  const vars = packVars(profile);
  const items = readPack(industry, scenario).map(entry => fillPackEntry(entry, vars));
  const existing = new Set((profile.faq ?? []).map(item => text(item.question).toLowerCase()).filter(Boolean));
  return {
    id: `${industry}/${scenario}`,
    industry,
    industryLabel: INDUSTRY_LABELS[industry],
    scenario,
    scenarioLabel: SCENARIO_LABELS[scenario],
    count: items.length,
    preview: items.slice(0, 3),
    items: items.map(item => ({ ...item, exists: existing.has(item.q.toLowerCase()) })),
  };
}

export function allPackPreviews(profile: EnterpriseProfile) {
  const industries = Object.keys(INDUSTRY_LABELS) as PackIndustry[];
  const scenarios = Object.keys(SCENARIO_LABELS) as PackScenario[];
  return industries.flatMap(industry => scenarios.map(scenario => buildPackPreview(profile, industry, scenario)));
}

