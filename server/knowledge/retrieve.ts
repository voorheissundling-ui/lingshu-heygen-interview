import { callLLM } from '../agents/llm.js';
import { readTenantEnterpriseProfile, type BizRules, type EnterpriseProfile, type FaqItem } from '../routes/enterprise.js';

export interface CustomerLite {
  id?: string;
  name?: string;
  language?: string;
  stage?: string;
  product?: string;
  internalProduct?: string;
}

export interface ProductLite {
  sku?: string;
  name: string;
  category?: string;
  priceRange?: string;
  moq?: string;
  tagPrice?: string;
  retailPrice?: string;
  brand?: string;
  material?: string;
  color?: string;
  size?: string;
  highlights?: string;
  attributes?: Record<string, unknown>;
}

export interface ConversationTurn {
  role: 'buyer' | 'seller';
  text: string;
}

export interface RetrievedFaq {
  q: string;
  a: string;
  approvedForAuto: boolean;
  source: 'manual' | 'pack' | 'learned';
}

export interface FaqMatch {
  faq: RetrievedFaq;
  confidence: number;
  ambiguous: boolean;
  autoSafe: boolean;
  reason: string;
  method: 'exact' | 'semantic' | 'heuristic';
}

export interface RetrieveContextOptions {
  conversation?: ConversationTurn[];
  /** Reuse the request-scoped confirmed snapshot so a single reply cannot mix saves. */
  enterpriseProfile?: EnterpriseProfile;
}

export interface RetrievedContext {
  enterpriseFactVersion?: string;
  companyIntro: string;
  bizRules: BizRules;
  faqs: RetrievedFaq[];
  matchedFaqs: RetrievedFaq[];
  faqMatch: FaqMatch | null;
  products: Array<ProductLite>;
  evidence: string[];
  knowledgeReady: boolean;
  knowledgeMiss: boolean;
  missReason?: string;
  sentiment?: 'negative' | 'neutral' | 'positive';
}

export interface ProductQuery {
  sku?: string;
  keywords?: string[];
  category?: string;
  sentiment?: 'negative' | 'neutral' | 'positive';
}

const EMPTY_BIZ_RULES: BizRules = {
  quoteMode: '',
  priceRange: '',
  bargainPolicy: 'no',
  bargainFloor: '',
  moq: '',
  samplePolicy: '',
  paymentTerms: '',
  leadTime: '',
};

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function normalize(value: unknown): string {
  return text(value).normalize('NFKC').toLowerCase();
}

function heuristicSentiment(message: string): 'negative' | 'neutral' {
  const raw = normalize(message);
  return /\b(angry|terrible|awful|bad service|waste(d)? my time|complaint|refund|unacceptable|disappointed|ridiculous|worst)\b|太糟糕|浪费.*时间|投诉|退款|生气|差评|无法接受|很差|太差/.test(raw)
    ? 'negative'
    : 'neutral';
}

function tokenize(value: string): string[] {
  return Array.from(new Set(
    normalize(value)
      .split(/[^a-z0-9\u4e00-\u9fff]+/i)
      .map(item => item.trim())
      .filter(item => item.length >= 2),
  ));
}

function companyIntro(profile: EnterpriseProfile): string {
  return [
    profile.company?.name ? `公司名称：${profile.company.name}` : '',
    profile.company?.industry ? `行业类目：${profile.company.industry}` : '',
    profile.company?.companyType ? `企业类型：${profile.company.companyType}` : '',
    profile.socialStrategy?.enabledRoutes?.length ? `社媒合作路线：${profile.socialStrategy.enabledRoutes.join('/')}` : '',
    profile.company?.mainMarkets ? `主攻市场：${profile.company.mainMarkets}` : '',
    profile.company?.primaryLanguages ? `主要业务语言：${profile.company.primaryLanguages}` : '',
    profile.company?.description ? `公司简介：${profile.company.description}` : '',
    profile.products?.categories ? `主营产品：${profile.products.categories}` : '',
    profile.brand?.usp ? `核心卖点：${profile.brand.usp}` : '',
  ].filter(Boolean).join('\n');
}

export function enterpriseKnowledgeReady(profile: EnterpriseProfile): boolean {
  const hasCompanyGrounding = Boolean(text(profile.company?.description) || text(profile.company?.industry) || text(profile.company?.mainMarkets));
  const hasProductGrounding = (profile.products?.items ?? []).some(item => Boolean(text(item.name) || text(item.sku)));
  const hasApprovedFaq = (profile.faq ?? []).some(item => item.approvedForAuto && text(item.question) && text(item.answer));
  const rules = profile.bizRules;
  const hasBusinessRuleGrounding = Boolean(
    text(rules?.moq)
    || text(rules?.samplePolicy)
    || text(rules?.paymentTerms)
    || text(rules?.leadTime),
  );
  return hasCompanyGrounding || hasProductGrounding || hasApprovedFaq || hasBusinessRuleGrounding;
}

function faqSource(item: FaqItem): 'manual'|'pack'|'learned' {
  const raw = text((item as any).source);
  return raw === 'pack' || raw === 'learned' ? raw : 'manual';
}

function retrieveFaqs(profile: EnterpriseProfile, message: string, evidence: string[]): RetrievedContext['faqs'] {
  const all = (profile.faq ?? [])
    .filter(item => item.question || item.answer)
    .map(item => ({
      q: item.question,
      a: item.answer,
      approvedForAuto: item.approvedForAuto,
      source: faqSource(item),
    }));
  if (all.length <= 50) {
    if (all.length) evidence.push(`FAQ 总数 ${all.length} 条，已全量返回`);
    return all;
  }
  const tokens = tokenize(message);
  const scored = all
    .map(item => {
      const question = normalize(item.q);
      const score = tokens.reduce((sum, token) => sum + (question.includes(token) ? 1 : 0), 0);
      return { item, score };
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(row => row.item);
  evidence.push(`FAQ 超过 50 条，关键词粗筛命中 ${scored.length} 条`);
  return scored;
}

function matchedFaqs(faqs: RetrievedContext['faqs'], message: string): RetrievedContext['faqs'] {
  const tokens = tokenize(message);
  const normalizedMessage = normalize(message);
  if (!normalizedMessage) return [];
  return faqs
    .map(item => {
      const q = normalize(item.q);
      const score = tokens.reduce((sum, token) => sum + (q.includes(token) ? 1 : 0), 0)
        + (normalizedMessage.includes(q) || q.includes(normalizedMessage) ? 3 : 0);
      return { item, score };
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(row => row.item);
}

function recentConversation(options: RetrieveContextOptions, latestMessage: string): ConversationTurn[] {
  const turns = (options.conversation ?? [])
    .filter(turn => turn && (turn.role === 'buyer' || turn.role === 'seller') && text(turn.text))
    .slice(-8)
    .map(turn => ({ role: turn.role, text: text(turn.text).slice(0, 1000) }));
  const last = turns.at(-1);
  if (!last || last.role !== 'buyer' || normalize(last.text) !== normalize(latestMessage)) {
    turns.push({ role: 'buyer', text: text(latestMessage).slice(0, 1000) });
  }
  return turns;
}

function faqCandidates(faqs: RetrievedFaq[], contextText: string): RetrievedFaq[] {
  const lexical = matchedFaqs(faqs, contextText);
  const ordered = [...lexical, ...faqs.filter(item => item.approvedForAuto), ...faqs];
  const seen = new Set<string>();
  return ordered.filter(item => {
    const key = `${normalize(item.q)}\u0000${normalize(item.a)}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function parseFaqMatch(raw: string): { faqIndex: number | null; confidence: number; ambiguous: boolean; reason: string } | null {
  const match = raw.replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const faqIndex = parsed.faqIndex === null ? null : Number(parsed.faqIndex);
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    return {
      faqIndex: Number.isInteger(faqIndex) ? faqIndex : null,
      confidence,
      ambiguous: parsed.ambiguous !== false,
      reason: text(parsed.reason).slice(0, 240),
    };
  } catch {
    return null;
  }
}

export function isContextDependentFaqQuestion(value: string): boolean {
  const raw = normalize(value);
  if (!raw) return true;
  return /^(how much|price|what about (it|this|that)|is (it|this|that) available|can you do (it|this|that)|why|when|where|which one)[?？!.。！]*$/i.test(raw)
    || /^(多少钱|什么价格|这个呢|那个呢|可以吗|有吗|为什么|什么时候|在哪里|哪个)[?？!.。！]*$/.test(raw)
    || /\b(it|this|that|these|those|same one)\b/i.test(raw)
    || /(这个|那个|这些|那些|同款|上面那个)/.test(raw);
}

async function resolveFaqMatch(
  faqs: RetrievedFaq[],
  latestMessage: string,
  conversation: ConversationTurn[],
  evidence: string[],
): Promise<FaqMatch | null> {
  if (!faqs.length || !text(latestMessage)) return null;
  const exact = faqs.find(item => normalize(item.q) === normalize(latestMessage));
  if (exact && !isContextDependentFaqQuestion(exact.q)) {
    evidence.push(`FAQ 精确命中：${exact.q}`);
    return {
      faq: exact,
      confidence: 1,
      ambiguous: false,
      autoSafe: exact.approvedForAuto,
      reason: '买家当前问题与标准问题完全一致',
      method: 'exact',
    };
  }

  const contextText = conversation.map(turn => `${turn.role}: ${turn.text}`).join('\n');
  const candidates = faqCandidates(faqs, contextText || latestMessage);
  if (!candidates.length) return null;
  const prompt = [
    'Judge whether the latest buyer message has exactly the same business intent as one FAQ question.',
    'Use the recent conversation to resolve pronouns, follow-up questions, product references, and negation.',
    'Choose null when the message is ambiguous, asks multiple questions, changes the subject, needs missing order/product facts, or only shares a keyword with an FAQ.',
    'A related topic is not enough. The approved answer must be directly correct for this exact context without adding assumptions.',
    'Return strict JSON only: {"faqIndex": number|null, "confidence": number, "ambiguous": boolean, "reason": string}.',
    'faqIndex is zero-based. Use confidence >= 0.90 only when it is safe to send the FAQ answer verbatim.',
    '',
    'Recent conversation:',
    contextText || `buyer: ${latestMessage}`,
    '',
    'FAQ candidates:',
    candidates.map((item, index) => `[${index}] Q: ${item.q}\nA: ${item.a}`).join('\n\n'),
  ].join('\n');
  try {
    const raw = await callLLM(prompt, { backend: 'qwen', model: process.env.KNOWLEDGE_QUERY_MODEL || 'qwen-plus' });
    const judged = parseFaqMatch(raw);
    if (judged?.faqIndex != null && judged.faqIndex >= 0 && judged.faqIndex < candidates.length) {
      const faq = candidates[judged.faqIndex];
      const autoSafe = faq.approvedForAuto && judged.confidence >= 0.9 && !judged.ambiguous;
      evidence.push(`FAQ 语境判定：${faq.q}，置信度 ${judged.confidence.toFixed(2)}${autoSafe ? '，可使用已审批原文' : '，仅供草稿参考'}`);
      return {
        faq,
        confidence: judged.confidence,
        ambiguous: judged.ambiguous,
        autoSafe,
        reason: judged.reason || '语义匹配',
        method: 'semantic',
      };
    }
    evidence.push('FAQ 语境判定未找到可直接回答的标准问题');
    return null;
  } catch (error) {
    const heuristic = matchedFaqs(candidates, latestMessage)[0];
    if (!heuristic) {
      evidence.push(`FAQ 语境判定不可用，规则兜底也未命中：${error instanceof Error ? error.message : 'unknown_error'}`);
      return null;
    }
    evidence.push(`FAQ 语境判定不可用，关键词命中仅供草稿参考：${heuristic.q}`);
    return {
      faq: heuristic,
      confidence: 0.6,
      ambiguous: true,
      autoSafe: false,
      reason: '仅关键词规则命中，不能确认当前语境完全一致',
      method: 'heuristic',
    };
  }
}

function productIntentLikely(message: string): boolean {
  const raw = text(message);
  if (!raw) return false;
  if (/^(hi|hello|hey|hola|buenas|thanks|thank you|ok|okay|are you there|est[aá]n ah[ií]|在吗|你好|您好)[\s?？!.！。]*$/i.test(raw)) return false;
  return /(?:[A-Z]{1,6}[-_]\d{2,}|[A-Z0-9]{2,}[-_][A-Z0-9-]{2,})/.test(raw)
    || /\b(price|how much|quote|quotation|sku|model|item|product|catalog|moq|sample|fabric|material|size|color|pcs|pieces)\b/i.test(raw)
    || /价格|报价|多少钱|货号|款号|产品|目录|起订|样品|面料|材质|颜色|尺码/.test(raw);
}

export function isProductDiscoveryIntent(message: string): boolean {
  const raw = text(message);
  return /\b(?:what (?:products? )?do you have|what do you sell|show me what you have|show me your products?|what can you offer|product range|send (?:me )?(?:your )?catalog(?:ue)?)\b|你们有什么|你卖什么|有什么产品|看看产品|发.{0,6}目录/i.test(raw);
}

function refersToCurrentProduct(message: string): boolean {
  const raw = normalize(message);
  if (!raw) return false;
  return /\b(?:it|this|that|these|those|same one|the item|the product|size|color|colour|material|fabric|sample|moq)\b/i.test(raw)
    || /(?:这个|那个|这款|那款|同款|它|尺码|颜色|材质|面料|样品|起订)/.test(raw);
}

export function seedCurrentProductQuery(
  query: ProductQuery | null,
  customer: CustomerLite,
  latestMessage: string,
  conversation: ConversationTurn[],
  evidence: string[],
): ProductQuery | null {
  const internalProduct = text(customer.internalProduct);
  if (!internalProduct) return query;

  const latest = normalize(latestMessage);
  const publicProduct = normalize(customer.product);
  const internalNormalized = normalize(internalProduct);
  const priorConversation = conversation.slice(0, -1).slice(-6).map(turn => normalize(turn.text)).join(' ');
  const explicitCurrentProduct = Boolean(
    (publicProduct && latest.includes(publicProduct))
    || latest.includes(internalNormalized),
  );
  const referencedCurrentProduct = refersToCurrentProduct(latestMessage) && Boolean(
    publicProduct
    || priorConversation.includes(internalNormalized),
  );
  if (!explicitCurrentProduct && !referencedCurrentProduct) return query;

  const keywords = Array.from(new Set([
    ...(query?.keywords ?? []),
    internalProduct,
    ...tokenize(internalProduct),
  ].map(text).filter(Boolean))).slice(0, 10);
  evidence.push(`根据当前会话产品映射补充内部检索词：${internalProduct}`);
  return { ...(query ?? {}), keywords, sentiment: query?.sentiment ?? heuristicSentiment(latestMessage) };
}

export function isGreetingOrProcessIntent(message: string): boolean {
  const raw = text(message);
  if (!raw) return true;
  return /^(hi|hello|hey|hola|buenas|thanks|thank you|ok|okay|are you there|est[aá]n ah[ií]|在吗|你好|您好)[\s?？!.！。]*$/i.test(raw)
    || /\b(catalog|catalogue|brochure|tracking|track|shipped|shipping status|invoice|pi)\b/i.test(raw)
    || /目录|产品册|物流|运单|发货|发票|形式发票/.test(raw);
}

export function isSafeWithoutEnterpriseKnowledge(message: string): boolean {
  const raw = text(message);
  if (!raw) return true;
  return /^(hi|hello|hey|hola|buenas|thanks|thank you|ok|okay|are you there|est[aá]n ah[ií]|在吗|你好|您好)[\s?？!.！。]*$/i.test(raw);
}

function toProductLite(item: NonNullable<EnterpriseProfile['products']['items']>[number]): ProductLite {
  return {
    sku: text(item.sku),
    name: text(item.name || item.sku),
    category: text(item.category),
    priceRange: text(item.priceRange || item.retailPrice || item.tagPrice),
    moq: text(item.moq),
    tagPrice: text(item.tagPrice),
    retailPrice: text(item.retailPrice),
    brand: text(item.brand),
    material: text(item.material),
    color: text(item.color),
    size: text(item.size),
    highlights: text(item.highlights),
    attributes: item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes) ? item.attributes : {},
  };
}

function parseJsonObject(raw: string): ProductQuery | null {
  const trimmed = raw.replace(/```json|```/gi, '').trim();
  const match = trimmed.match(/\{[\s\S]*}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as ProductQuery;
    const sku = text(parsed.sku);
    const category = text(parsed.category);
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.map(item => text(item)).filter(Boolean).slice(0, 8)
      : [];
    const sentiment = parsed.sentiment === 'negative' || parsed.sentiment === 'positive' ? parsed.sentiment : 'neutral';
    if (!sku && !category && keywords.length === 0) return { sentiment };
    return { sku, category, keywords, sentiment };
  } catch {
    return null;
  }
}

function heuristicProductQuery(message: string): ProductQuery | null {
  const sku = text(message.match(/\b[A-Z0-9]{2,}(?:[-_][A-Z0-9]{2,})+\b/i)?.[0]).toUpperCase();
  const keywords = tokenize(message)
    .filter(token => !/^(price|quote|quotation|how|much|sku|model|item|product|moq|pcs|pieces|hello|hola)$/i.test(token))
    .slice(0, 6);
  if (!sku && keywords.length === 0) return null;
  return { sku, keywords };
}

async function parseProductQuery(message: string, evidence: string[]): Promise<ProductQuery | null> {
  if (!productIntentLikely(message)) {
    evidence.push('买家消息为寒暄或未涉及具体产品，跳过产品查询解析');
    return { sentiment: heuristicSentiment(message) };
  }
  const prompt = [
    'Parse the buyer message into product search conditions and sentiment.',
    'Return strict JSON only: {"sku": string, "keywords": string[], "category": string, "sentiment":"negative|neutral|positive"} or null.',
    'Only return conditions when the message refers to a concrete product, SKU, category, material, size, color, MOQ, price, or catalog need.',
    'For greetings or availability checks, return {"keywords":[],"sentiment":"neutral"}.',
    'Use sentiment="negative" when the buyer is angry, complaining, asking for a refund because of dissatisfaction, or says the seller wasted their time.',
    `Buyer message: ${message}`,
  ].join('\n');
  try {
    const raw = await callLLM(prompt, { backend: 'qwen', model: process.env.KNOWLEDGE_QUERY_MODEL || 'qwen-plus' });
    const parsed = raw.trim() === 'null' ? null : parseJsonObject(raw);
    if (parsed) {
      evidence.push('产品查询条件由 LLM 解析');
      return parsed;
    }
  } catch (error) {
    evidence.push(`产品查询 LLM 解析失败，已使用规则兜底：${error instanceof Error ? error.message : 'unknown_error'}`);
  }
  const fallback = heuristicProductQuery(message);
  if (fallback) fallback.sentiment = heuristicSentiment(message);
  if (fallback) evidence.push('产品查询条件由规则兜底解析');
  return fallback ?? { sentiment: heuristicSentiment(message) };
}

function productHaystack(product: ProductLite): string {
  return normalize([
    product.sku,
    product.name,
    product.category,
    product.material,
    product.color,
    product.size,
    product.highlights,
    product.priceRange,
    product.moq,
    JSON.stringify(product.attributes ?? {}),
  ].filter(Boolean).join(' '));
}

function retrieveProducts(profile: EnterpriseProfile, query: ProductQuery | null, evidence: string[], includeCatalog = false): ProductLite[] {
  if (!query) return [];
  const all = (profile.products.items ?? []).map(toProductLite).filter(item => item.name || item.sku);
  if (!all.length) {
    evidence.push('产品表为空，未命中产品');
    return [];
  }
  if (includeCatalog) {
    evidence.push(`客户正在浏览产品，返回已录入产品 ${Math.min(5, all.length)} 条`);
    return all.slice(0, 5);
  }
  const sku = normalize(query.sku);
  if (sku) {
    const exact = all.filter(item => normalize(item.sku) === sku);
    if (exact.length) {
      evidence.push(`命中货号 ${query.sku}`);
      return exact.slice(0, 5);
    }
  }
  const keywords = (query.keywords ?? []).map(normalize).filter(Boolean);
  const category = normalize(query.category);
  const scored = all
    .map(product => {
      const haystack = productHaystack(product);
      const categoryMatched = category && normalize(product.category).includes(category);
      const keywordScore = keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0);
      const nameScore = keywords.reduce((sum, keyword) => sum + (normalize(product.name).includes(keyword) ? 2 : 0), 0);
      return { product, score: keywordScore + nameScore + (categoryMatched ? 2 : 0) };
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(row => row.product);
  if (scored.length) {
    evidence.push(`产品关键词命中 ${scored.length} 条：${scored.map(item => item.sku || item.name).join('、')}`);
  } else {
    evidence.push('产品结构化检索未命中');
  }
  return scored;
}

export async function retrieveContext(
  tenantId: string,
  customer: CustomerLite,
  message: string,
  options: RetrieveContextOptions = {},
): Promise<RetrievedContext> {
  const profile = options.enterpriseProfile || await readTenantEnterpriseProfile(tenantId);
  const evidence: string[] = [];
  if (profile.factVersion?.id) evidence.push(`企业事实版本：${profile.factVersion.id}`);
  if (tenantId) evidence.push(`租户 ${tenantId} 使用企业知识库`);
  if (customer?.id || customer?.name) evidence.push(`客户上下文：${customer.name || customer.id}`);
  const conversation = recentConversation(options, message);
  const conversationQuery = conversation.map(turn => turn.text).join(' ');
  const parsedQuery = await parseProductQuery(message, evidence);
  const query = seedCurrentProductQuery(parsedQuery, customer, message, conversation, evidence);
  const products = retrieveProducts(profile, query, evidence, isProductDiscoveryIntent(message));
  const faqs = retrieveFaqs(profile, conversationQuery || message, evidence);
  const faqMatch = await resolveFaqMatch(faqs, message, conversation, evidence);
  const lexicalMatches = matchedFaqs(faqs, conversationQuery || message);
  const faqMatches = faqMatch
    ? [faqMatch.faq, ...lexicalMatches.filter(item => item.q !== faqMatch.faq.q)].slice(0, 5)
    : lexicalMatches;
  const faqCovered = Boolean(faqMatch && !faqMatch.ambiguous && faqMatch.confidence >= 0.75);
  const knowledgeReady = enterpriseKnowledgeReady(profile);
  const knowledgeMiss = !faqCovered && products.length === 0 && !isSafeWithoutEnterpriseKnowledge(message);
  if (!knowledgeReady) evidence.push('企业知识尚未配置：AI 只能承接需求、追问必要信息或转人工，不能回答企业与产品事实');
  if (knowledgeMiss) evidence.push('知识库未覆盖：FAQ 与产品均无有效命中，且不是寒暄/流程类意图');
  return {
    enterpriseFactVersion: profile.factVersion?.id,
    companyIntro: companyIntro(profile),
    bizRules: profile.bizRules ?? EMPTY_BIZ_RULES,
    faqs,
    matchedFaqs: faqMatches,
    faqMatch,
    products,
    evidence,
    knowledgeReady,
    knowledgeMiss,
    missReason: knowledgeMiss ? '客户在问知识库没有的问题' : '',
    sentiment: query?.sentiment ?? heuristicSentiment(message),
  };
}
