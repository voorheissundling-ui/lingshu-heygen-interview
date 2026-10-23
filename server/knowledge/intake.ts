import { callLLM } from '../agents/llm.js';
import type { BizRules, EnterpriseProfile, FaqItem } from '../routes/enterprise.js';

export interface KnowledgeConversationMessage {
  actor: 'buyer' | 'seller';
  body: string;
  timestamp: number;
}

export interface KnowledgeConversationSample {
  customerId: string;
  messages: KnowledgeConversationMessage[];
}

export interface KnowledgeIntakePreview {
  source: 'history' | 'products';
  historyMessageCount: number;
  conversationCount: number;
  companyIntro: string;
  bizRules: Partial<BizRules>;
  faqs: Array<Omit<FaqItem, 'id'>>;
  evidence: string[];
  missing: string[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stripFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const cleaned = stripFence(raw);
  try { return JSON.parse(cleaned) as Record<string, unknown>; } catch { /* inspect embedded JSON */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { return {}; }
}

function normalizeQuoteMode(value: unknown): BizRules['quoteMode'] | undefined {
  return value === 'range' || value === 'human_only' ? 'human_only' : undefined;
}

function normalizeBargainPolicy(value: unknown): BizRules['bargainPolicy'] | undefined {
  return value === 'no' || value === 'limited' || value === 'open' ? value : undefined;
}

function normalizePreview(
  raw: Record<string, unknown>,
  source: KnowledgeIntakePreview['source'],
  stats: { historyMessageCount: number; conversationCount: number },
): KnowledgeIntakePreview {
  const rawRules = raw.bizRules && typeof raw.bizRules === 'object' ? raw.bizRules as Record<string, unknown> : {};
  const rawFaqs = Array.isArray(raw.faqs) ? raw.faqs : [];
  const faqs = rawFaqs.map(item => {
    const faq = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      question: text(faq.question || faq.q),
      answer: text(faq.answer || faq.a),
      approvedForAuto: false,
      source: source === 'history' ? 'learned' as const : 'manual' as const,
    };
  }).filter(item => item.question && item.answer).slice(0, 12);

  const bizRules: Partial<BizRules> = {
    quoteMode: normalizeQuoteMode(rawRules.quoteMode),
    priceRange: text(rawRules.priceRange),
    bargainPolicy: normalizeBargainPolicy(rawRules.bargainPolicy),
    bargainFloor: text(rawRules.bargainFloor),
    moq: text(rawRules.moq),
    samplePolicy: text(rawRules.samplePolicy),
    paymentTerms: text(rawRules.paymentTerms),
    leadTime: text(rawRules.leadTime),
  };
  Object.keys(bizRules).forEach(key => {
    if (bizRules[key as keyof BizRules] === undefined || bizRules[key as keyof BizRules] === '') {
      delete bizRules[key as keyof BizRules];
    }
  });

  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map(text).filter(Boolean).slice(0, 8) : [];
  const missing = Array.isArray(raw.missing) ? raw.missing.map(text).filter(Boolean).slice(0, 8) : [];
  return {
    source,
    ...stats,
    companyIntro: text(raw.companyIntro),
    bizRules,
    faqs,
    evidence,
    missing,
  };
}

function productSummary(profile: EnterpriseProfile): string {
  const items = (profile.products.items ?? []).slice(0, 20).map(item => ({
    sku: item.sku || '',
    name: item.name,
    category: item.category || '',
    price: item.priceRange || item.retailPrice || item.tagPrice || '',
    moq: item.moq || '',
    highlights: item.highlights || '',
    certifications: item.certifications || '',
  }));
  return JSON.stringify({
    company: profile.company,
    productOverview: {
      categories: profile.products.categories,
      certifications: profile.products.certifications,
      highlights: profile.products.highlights,
    },
    products: items,
  });
}

function conversationText(samples: KnowledgeConversationSample[]): string {
  const blocks: string[] = [];
  let usedCharacters = 0;
  const maxCharacters = 80_000;
  for (const [index, sample] of samples.entries()) {
    const block = [
      `会话 ${index + 1}:`,
      ...sample.messages.map(message => `${message.actor === 'buyer' ? '买家' : '商家'}: ${message.body}`),
    ].join('\n');
    if (usedCharacters + block.length > maxCharacters) break;
    blocks.push(block);
    usedCharacters += block.length;
  }
  return blocks.join('\n\n');
}

function fallbackFromProducts(profile: EnterpriseProfile): KnowledgeIntakePreview {
  const productNames = (profile.products.items ?? []).map(item => item.name).filter(Boolean).slice(0, 4);
  const category = profile.products.categories || profile.company.industry || '';
  const highlights = profile.products.highlights || (profile.products.items ?? []).map(item => item.highlights).filter(Boolean).slice(0, 3).join('；');
  const hasBusinessMaterial = Boolean(category || highlights || productNames.length);
  const companyIntro = hasBusinessMaterial ? [
    profile.company.name,
    category ? `专注于${category}` : '',
    highlights,
    profile.company.mainMarkets ? `主要服务${profile.company.mainMarkets}市场` : '',
  ].filter(Boolean).join('，') : '';
  const faqs: KnowledgeIntakePreview['faqs'] = [];
  if (productNames.length) {
    faqs.push({ question: '你们主要有哪些产品？', answer: `我们目前主推${productNames.join('、')}。可以告诉我你关注的款式和预计采购量，我为你进一步确认。`, approvedForAuto: false, source: 'manual' });
  }
  if (profile.products.certifications) {
    faqs.push({ question: '产品有哪些认证？', answer: `目前已录入的认证包括：${profile.products.certifications}。具体款式的认证范围请以对应产品资料为准。`, approvedForAuto: false, source: 'manual' });
  }
  return {
    source: 'products',
    historyMessageCount: 0,
    conversationCount: 0,
    companyIntro,
    bizRules: {
      quoteMode: 'human_only',
      moq: profile.products.moq || undefined,
      priceRange: profile.products.priceRange || undefined,
    },
    faqs,
    evidence: productNames.length ? [`根据已录入的 ${productNames.length} 个主推产品生成初稿`] : [],
    missing: ['样品政策', '付款方式', '交期口径'].filter(item => {
      if (item === '样品政策') return !profile.bizRules?.samplePolicy;
      if (item === '付款方式') return !profile.bizRules?.paymentTerms;
      return !profile.bizRules?.leadTime;
    }),
  };
}

export async function extractKnowledgeFromHistory(
  profile: EnterpriseProfile,
  samples: KnowledgeConversationSample[],
): Promise<KnowledgeIntakePreview> {
  const historyMessageCount = samples.reduce((sum, sample) => sum + sample.messages.length, 0);
  if (!historyMessageCount) return draftKnowledgeFromProducts(profile);

  const prompt = [
    '你在帮助中国外贸商家把过去的真实客户聊天整理成企业知识库。',
    '只输出合法 JSON，不要 markdown。所有文字使用简体中文。',
    '必须遵守：',
    '1. 只提取聊天里反复出现或表达明确的信息；价格、MOQ、交期、付款比例、折扣底线不得猜测。',
    '2. 不确定的字段留空，并把字段名写入 missing。',
    '3. FAQ 要把买家真实常问问题整理成中文 Q/A；答案必须忠于商家过去的实际口径。',
    '4. FAQ 默认都不能自动发送，approvedForAuto 固定 false。',
    '5. companyIntro 只写 60-140 字，可直接给海外买家或用于 AI 回复。',
    '6. evidence 写 2-6 条中文依据说明，不含客户姓名、电话、地址。',
    '7. quoteMode 固定为 human_only。AI 只能识别询价并整理条件，不能直接报价，也不能生成“稍后报价”占位消息。',
    '输出结构：',
    '{"companyIntro":"","bizRules":{"quoteMode":"human_only","priceRange":"","bargainPolicy":"no|limited|open","bargainFloor":"","moq":"","samplePolicy":"","paymentTerms":"","leadTime":""},"faqs":[{"question":"","answer":"","approvedForAuto":false}],"evidence":[],"missing":[]}',
    '已录入的企业/产品资料（用于核对，不能覆盖聊天事实）：',
    productSummary(profile),
    '过去六个月的脱敏会话：',
    conversationText(samples),
  ].join('\n');

  try {
    const raw = await callLLM(prompt, {
      backend: 'qwen',
      model: process.env.KNOWLEDGE_INTAKE_MODEL || process.env.KNOWLEDGE_QUERY_MODEL || 'qwen-plus',
    });
    const normalized = normalizePreview(parseJsonObject(raw), 'history', { historyMessageCount, conversationCount: samples.length });
    if (normalized.companyIntro || normalized.faqs.length || Object.keys(normalized.bizRules).length) return normalized;
  } catch (error) {
    console.warn('[knowledge-intake] history extraction failed:', error instanceof Error ? error.message : error);
  }

  const fallback = fallbackFromProducts(profile);
  return {
    ...fallback,
    historyMessageCount,
    conversationCount: samples.length,
    evidence: ['历史聊天已读取，但 AI 整理暂时不可用；先根据产品生成了可编辑初稿'],
  };
}

export async function draftKnowledgeFromProducts(profile: EnterpriseProfile): Promise<KnowledgeIntakePreview> {
  const fallback = fallbackFromProducts(profile);
  if (!(profile.products.items ?? []).length && !profile.products.categories && !profile.company.industry) return fallback;
  const prompt = [
    '你在帮助中国外贸商家根据已录入的真实产品资料起草企业知识库。',
    '只输出合法 JSON，不要 markdown，所有文字使用简体中文。',
    '不得编造价格、MOQ、库存、认证、交期、付款方式或公司规模；资料中没有就留空并放入 missing。',
    'companyIntro 写 60-140 字。FAQ 写 5-8 条最容易确认的初稿，答案中不确定的信息用“请告诉我采购数量，我们为你确认”收口。',
    'FAQ 的 approvedForAuto 固定 false。',
    '输出结构：',
    '{"companyIntro":"","bizRules":{"quoteMode":"human_only","priceRange":"","bargainPolicy":"no|limited|open","bargainFloor":"","moq":"","samplePolicy":"","paymentTerms":"","leadTime":""},"faqs":[{"question":"","answer":"","approvedForAuto":false}],"evidence":[],"missing":[]}',
    '企业与产品资料：',
    productSummary(profile),
  ].join('\n');
  try {
    const raw = await callLLM(prompt, {
      backend: 'qwen',
      model: process.env.KNOWLEDGE_INTAKE_MODEL || process.env.KNOWLEDGE_QUERY_MODEL || 'qwen-plus',
    });
    const normalized = normalizePreview(parseJsonObject(raw), 'products', { historyMessageCount: 0, conversationCount: 0 });
    if (normalized.companyIntro || normalized.faqs.length || Object.keys(normalized.bizRules).length) return normalized;
  } catch (error) {
    console.warn('[knowledge-intake] product draft failed:', error instanceof Error ? error.message : error);
  }
  return fallback;
}
