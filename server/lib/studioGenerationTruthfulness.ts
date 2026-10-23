import {
  numericClaimIsProductionParameter,
  normalizeNumericEvidenceText,
  productInfoSupportsNumericClaim,
} from './studioScriptQualityV2.js';

type CommercialClaimAudit = { issues: string[]; fieldsToConfirm: string[] };

const COMMERCIAL_CLAIM_RULES: Array<{
  field: string;
  claim: RegExp;
  evidence: RegExp;
}> = [
  {
    field: 'MOQ / 起订量',
    claim: /\bMOQ\b|\blow\s*moq\b|起订量|最低订购|低起订|小批量(?:起订|订单)|(?:low|small|flexible)\s+(?:minimum order|MOQ)/i,
    evidence: /起订量[：:]\s*[^；;\s]|\bMOQ\b\s*[：:=]\s*[^；;\s]|minimum order\s*[：:=]\s*[^；;\s]/i,
  },
  {
    field: '认证资质',
    claim: /\b(?:GMP|ISO(?:[\s-]?\d{3,5})?|FDA(?:-ready|\s+(?:approved|registered|compliant))?|CE|RoHS|UKCA|ETL|BSCI|REACH)\b|认证(?:通过|齐全|支持)|资质(?:齐全|认证)|certif(?:ied|ication)/i,
    evidence: /认证资质[：:]\s*[^；;\s]|资质[：:]\s*[^；;\s]|certif(?:ied|ication)\s*[：:=]\s*[^；;\s]/i,
  },
  {
    field: '交期 / 周转时间',
    claim: /交期|快速交付|极速交付|快速打样|(?:fast|quick|rapid)\s+(?:turnaround|delivery|sampling)|lead\s*time/i,
    evidence: /leadTime=\s*[^；;\s]|交期(?:能力)?[：:]\s*[^；;\s]|周转时间[：:]\s*[^；;\s]/i,
  },
  {
    field: '价格',
    claim: /价格(?:低|优势|从|仅|区间)|最低价|出厂价|批发价|price\s+(?:from|range)|factory\s+price|wholesale\s+price/i,
    evidence: /价格区间[：:]\s*[^；;\s]|价格[：:]\s*[^；;\s]|priceRange=\s*[^；;\s]|定价策略[：:]\s*[^；;\s]/i,
  },
  {
    field: '出口能力 / 国家',
    claim: /全球出口|出口(?:就绪|能力|支持|到)|销往全球|覆盖\S*(?:国家|市场)|(?:global|worldwide)\s+(?:export|shipping|supply)|international\s+shipping|ships?\s+(?:worldwide|globally|internationally|to)|serv(?:e|ing)\s+\d+\s+(?:countries|markets)|export[- ]ready|export\s+(?:support|capability|to)/i,
    evidence: /(?:出口|外贸|export)[^：:=\n]*[：:=]\s*[^；;\s]|(?:出口企业|外贸企业|exporter)/i,
  },
  {
    field: '工厂资质 / 产能',
    claim: /源头工厂|自有工厂|厂家直供|工厂(?:直供|支持|车间|产线|实拍|场景|展示)?|生产能力|日产|月产|年产|批量(?:供货|生产)|量产能力|大货[^\n，。;]{0,10}(?:能接|承接|供应)|\bfactory\b|\bmanufactur(?:er|ing)\b|production\s+(?:line|capacity)|mass\s+production/i,
    evidence: /企业类型[：:]\s*[^\n]*(?:工厂|制造)|工厂实拍素材[：:]\s*[^；;\s]|源头工厂|自有工厂|厂家直供|(?:factory|manufactur)[^：:=\n]*[：:=]\s*[^；;\s]/i,
  },
  {
    field: 'OEM / ODM / 私标 / 定制能力',
    claim: /\bOEM\b|\bODM\b|私标|贴牌|(?:可|支持|提供|能够|可以)[^\n，。;]{0,12}定制|定制(?:能力|方案|配方|包装|产品|服务|[。.!！,，;；\s]|$)|private\s+label|custom(?:izable|ization|\s+formula|\s+packaging)/i,
    evidence: /社媒合作路线[：:]\s*[^\n]*oem_odm|定制能力[：:]\s*[^；;\s]|(?:\bOEM\b|\bODM\b|私标|贴牌|定制|custom)[^：:=\n]*[：:=]\s*[^；;\s]/i,
  },
  {
    field: '样品 / 寄样政策',
    claim: /免费样品|免费寄样|可寄样|可以寄样|提供样品|样品可用|sample(?:s)?\s+(?:available|provided)|free\s+samples?/i,
    evidence: /samplePolicy=\s*[^；;\s]|样品政策[：:]\s*[^；;\s]|寄样[：:]\s*[^；;\s]/i,
  },
  {
    field: '库存 / 现货能力',
    claim: /现货供应|大量现货|库存充足|立即发货|ready\s+stock|in\s+stock|ships?\s+immediately/i,
    evidence: /(?:库存|现货)[^：:=\n]*[：:=]\s*[^；;\s]|ready\s+stock|in\s+stock/i,
  },
  {
    field: '质量或履约承诺',
    claim: /品质保证|质量保证|严格质检|优质品质|高端品质|准时交付|全程支持|quality\s+(?:guarantee|assurance|control)|premium\s+quality|on[- ]time\s+delivery|dedicated\s+support/i,
    evidence: /品质保证|质量保证|质检|质量控制|准时交付|全程支持|quality\s+(?:guarantee|assurance|control)|on[- ]time\s+delivery|dedicated\s+support/i,
  },
];

const CERTIFICATION_TOKEN_RE = /\b(?:GMP|ISO(?:[\s-]?\d{3,5})?|FDA(?:-ready|\s+(?:approved|registered|compliant))?|CE|RoHS|UKCA|ETL|BSCI|REACH)\b/gi;
const ABSOLUTE_COMMERCIAL_PROMISE_RE = /保证|绝对|永久|永不|零风险|100%|最快|最低价|全网第一|guaranteed|always|never|zero[- ]risk|best\s+price/i;
const QUALIFIED_AS_PENDING_RE = /待确认|需确认|尚未确认|未核实|请提供|请填写|询问|是否|\?|？|to confirm|needs? confirmation|unverified|not verified|please (?:provide|confirm)|may i know|what is/i;

function normalizedEvidence(value: string): string {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\u00a0_-]+/g, '');
}

export function normalizedFactValue(value: string): string {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, '');
}

export function hasConfirmedEnterpriseFacts(value: string): boolean {
  const text = String(value || '');
  if (/^(?:公司名称|行业类目|企业类型|主营产品|产品优势|产品\d+|核心卖点|重点产品|认证资质|起订量|价格区间|定制能力|交期能力|物流履约)[：:]\s*\S+/m.test(text)) return true;
  if (/^Approved FAQ for auto reply:\s*\S+/m.test(text)) return true;
  return /\b(?:priceRange|moq|samplePolicy|paymentTerms|leadTime|bargainPolicy|bargainFloor)=\s*(?!not_configured\b)[^；;\s]+/i.test(text);
}

const PRODUCT_CONTEXT_FIELD_RE = /^(?:选定产品\s*\d*|产品名称|主推品|所属类目|产品类目|产品卖点|核心优势|已核实事实|价格区间|起订量|认证资质|产品主图素材|工厂实拍素材|包装定制素材|证书资质素材|使用场景素材|品牌视觉素材)$/;

/**
 * Keep company-wide facts plus only the selected product records. This avoids
 * accidentally borrowing a certification, MOQ or selling point from another
 * product in the same tenant profile.
 */
export function confirmedEnterpriseContextForProduct(productInfo: unknown, confirmedEnterpriseContext: string): string {
  const raw = String(productInfo || '');
  const selectedNames = Array.from(raw.matchAll(/^产品名称[：:]\s*(.+)$/gm))
    .map(match => match[1]!.trim())
    .filter(Boolean);
  if (!selectedNames.length) return String(confirmedEnterpriseContext || '');
  const selectedKeys = selectedNames.map(normalizedFactValue).filter(Boolean);
  const lines = String(confirmedEnterpriseContext || '').split('\n');
  const globalLines = lines.filter(line => !/^产品\d+[：:]/.test(line.trim()));
  const selectedProductLines = lines.filter(line => {
    const name = line.trim().match(/^产品\d+[：:]\s*([^；;\n]+)/)?.[1] || '';
    const key = normalizedFactValue(name);
    return key.length > 0 && selectedKeys.some(selected => key === selected);
  });
  return [...globalLines, ...selectedProductLines].join('\n');
}

export function unconfirmedEnterpriseProductFields(productInfo: unknown, confirmedEnterpriseContext: string): string[] {
  const raw = String(productInfo || '').trim();
  if (!raw) return [];
  const evidenceKey = normalizedFactValue(confirmedEnterpriseContextForProduct(raw, confirmedEnterpriseContext));
  const fields: string[] = [];
  let inspected = 0;
  for (const line of raw.split(/\n+/)) {
    const match = line.trim().match(/^([^：:]+)[：:]\s*(.+)$/);
    if (!match) continue;
    const label = match[1]!.trim();
    const value = match[2]!.trim();
    if (!PRODUCT_CONTEXT_FIELD_RE.test(label) || !value) continue;
    inspected += 1;
    const values = /^选定产品/.test(label)
      ? value.split(/\s*\+\s*|[、，,]/).filter(Boolean)
      : [value];
    if (values.some(item => {
      const key = normalizedFactValue(item);
      return key.length >= 2 && !evidenceKey.includes(key);
    })) fields.push(label || '产品资料');
  }
  if (!inspected) {
    const key = normalizedFactValue(raw);
    if (key.length >= 2 && !evidenceKey.includes(key)) fields.push('产品资料');
  }
  return Array.from(new Set(fields));
}

function regexMatchContexts(text: string, pattern: RegExp): string[] {
  const flags = Array.from(new Set(`${pattern.flags.replace(/g/g, '')}g`.split(''))).join('');
  const matcher = new RegExp(pattern.source, flags);
  return Array.from(text.matchAll(matcher)).map(match => {
    const start = Math.max(0, text.lastIndexOf('\n', match.index ?? 0) + 1);
    const nextBreak = text.indexOf('\n', (match.index ?? 0) + match[0].length);
    return text.slice(start, nextBreak < 0 ? text.length : nextBreak).trim();
  });
}

/**
 * Closed-world gate for commercial copy. The model may rewrite prose, but it
 * cannot create a sensitive business capability that is absent from the
 * authenticated tenant's enterprise profile.
 */
export function auditCommercialClaims(candidate: unknown, confirmedEnterpriseContext: string): CommercialClaimAudit {
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate ?? '');
  const evidence = String(confirmedEnterpriseContext || '');
  const issues: string[] = [];
  const fieldsToConfirm = new Set<string>();
  if (!text.trim()) return { issues, fieldsToConfirm: [] };

  const absoluteContexts = regexMatchContexts(text, ABSOLUTE_COMMERCIAL_PROMISE_RE);
  if (absoluteContexts.some(context => !QUALIFIED_AS_PENDING_RE.test(context))) {
    issues.push('输出包含绝对化或不可核实的商业承诺');
    fieldsToConfirm.add('绝对化商业承诺');
  }

  for (const rule of COMMERCIAL_CLAIM_RULES) {
    const contexts = regexMatchContexts(text, rule.claim);
    if (!contexts.length) continue;
    const unqualifiedContexts = contexts.filter(context => !QUALIFIED_AS_PENDING_RE.test(context));
    if (!unqualifiedContexts.length) {
      fieldsToConfirm.add(rule.field);
      continue;
    }
    if (!rule.evidence.test(evidence)) {
      issues.push(`企业中心未确认“${rule.field}”，但生成内容包含相关承诺`);
      fieldsToConfirm.add(rule.field);
    }
  }

  const evidenceKey = normalizedEvidence(evidence);
  const certificationMatches = Array.from(text.matchAll(CERTIFICATION_TOKEN_RE));
  for (const match of certificationMatches) {
    const token = match[0];
    const start = Math.max(0, text.lastIndexOf('\n', match.index ?? 0) + 1);
    const nextBreak = text.indexOf('\n', (match.index ?? 0) + token.length);
    const context = text.slice(start, nextBreak < 0 ? text.length : nextBreak);
    if (QUALIFIED_AS_PENDING_RE.test(context)) {
      fieldsToConfirm.add('认证资质');
      continue;
    }
    if (!evidenceKey.includes(normalizedEvidence(token))) {
      issues.push(`企业中心未确认认证“${token}”`);
      fieldsToConfirm.add('认证资质');
    }
  }

  const assertedText = text.split('\n').filter(line => !QUALIFIED_AS_PENDING_RE.test(line)).join('\n');
  const unsupportedNumbers = unsupportedNumericClaims(assertedText, evidence);
  if (unsupportedNumbers.length) {
    issues.push(`企业中心未确认商业数字：${unsupportedNumbers.join('、')}`);
    fieldsToConfirm.add('数字、价格、MOQ 或交期');
  }

  return {
    issues: Array.from(new Set(issues)),
    fieldsToConfirm: Array.from(fieldsToConfirm),
  };
}

export function userFacingPosterText(value: any): string {
  const poster = value?.poster || value || {};
  return [
    poster.headline,
    poster.subheadline,
    poster.originBadge,
    ...(Array.isArray(poster.trustBadges) ? poster.trustBadges : []),
    ...(Array.isArray(poster.sellingPoints) ? poster.sellingPoints : []),
    ...(Array.isArray(poster.process) ? poster.process : []),
    ...(Array.isArray(poster.categories) ? poster.categories.flatMap((item: any) => [item?.name, item?.description]) : []),
    ...(Array.isArray(poster.bottomBar) ? poster.bottomBar : []),
    poster.cta,
    value?.caption,
    ...(Array.isArray(value?.hashtags) ? value.hashtags : []),
    value?.commentCta,
    value?.dmOpening,
    value?.imagePrompt,
  ].filter(Boolean).map(String).join('\n');
}

function safeCommercialText(value: unknown, evidence: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const parts = text.split(/(?<=[。！？.!?])\s+|\n+/).map(item => item.trim()).filter(Boolean);
  const safe = parts.filter(item => auditCommercialClaims(item, evidence).issues.length === 0);
  return safe.join(parts.length > 1 ? '\n' : ' ').trim();
}

/**
 * Keep a useful, conservative poster draft when the model adds an unsupported
 * commercial promise. Unsafe sentences/items are removed and surfaced as
 * confirmation fields; they never remain hidden in the image prompt.
 */
export function sanitizePosterCommercialClaims(value: any, evidence: string) {
  const poster = value?.poster || {};
  const safeArray = (items: unknown) => Array.isArray(items)
    ? items.map(item => safeCommercialText(item, evidence)).filter(Boolean)
    : [];
  const categories = Array.isArray(poster.categories) ? poster.categories.map((item: any) => ({
    name: safeCommercialText(item?.name || item, evidence),
    description: safeCommercialText(item?.description, evidence),
  })).filter((item: { name: string }) => item.name) : [];
  const sanitized = {
    ...value,
    poster: {
      ...poster,
      headline: safeCommercialText(poster.headline, evidence),
      subheadline: safeCommercialText(poster.subheadline, evidence),
      originBadge: safeCommercialText(poster.originBadge, evidence),
      trustBadges: safeArray(poster.trustBadges),
      sellingPoints: safeArray(poster.sellingPoints),
      process: safeArray(poster.process),
      categories,
      bottomBar: safeArray(poster.bottomBar),
      cta: safeCommercialText(poster.cta, evidence),
    },
    caption: safeCommercialText(value?.caption, evidence),
    hashtags: safeArray(value?.hashtags),
    commentCta: safeCommercialText(value?.commentCta, evidence),
    dmOpening: safeCommercialText(value?.dmOpening, evidence),
    imagePrompt: safeCommercialText(value?.imagePrompt, evidence),
  };
  return sanitized;
}

export function userFacingLeadPackageText(value: any): string {
  return [
    value?.strategySummary,
    ...(Array.isArray(value?.items) ? value.items.flatMap((item: any) => [
      item?.title,
      item?.objective,
      ...(Array.isArray(item?.slides) ? item.slides.flatMap((slide: any) => [slide?.headline, slide?.body]) : []),
      item?.caption,
      ...(Array.isArray(item?.hashtags) ? item.hashtags : []),
      item?.cta,
      item?.dmOpening,
      item?.imagePrompt,
    ]) : []),
  ].filter(Boolean).map(String).join('\n');
}

export function confirmationFields(value: unknown): string[] {
  return Array.from(new Set((Array.isArray(value) ? value : []).map(String).map(item => item.trim()).filter(Boolean))).slice(0, 20);
}

export function upstreamGenerationFailure(error: unknown, label: string) {
  const raw = String(error instanceof Error ? error.message : error || 'unknown upstream error');
  const outcomeUnknown = /provider_submission_unknown|outcome_uncertain|requires_manual_reconciliation/i.test(raw);
  const quota = /429|RESOURCE_EXHAUSTED|prepayment credits|quota|billing|额度|余额/i.test(raw);
  const authFailure = /401|403|api.?key|unauthorized|permission|鉴权|权限/i.test(raw);
  const retryable = !quota && !authFailure && /timeout|timed out|超时|503|502|504|UNAVAILABLE|fetch|network/i.test(raw);
  return {
    ok: false,
    source: 'ai_failed' as const,
    provenance: 'ai_failed' as const,
    publishable: false,
    qualityStatus: 'failed' as const,
    code: outcomeUnknown ? 'UPSTREAM_SUBMISSION_OUTCOME_UNKNOWN' : quota ? 'UPSTREAM_QUOTA_EXHAUSTED' : authFailure ? 'UPSTREAM_AUTH_UNAVAILABLE' : 'UPSTREAM_GENERATION_FAILED',
    retryable: outcomeUnknown ? false : retryable,
    error: outcomeUnknown
      ? `${label}请求已提交，但供应商未在时限内返回结果。为避免重复计费，系统已停止自动重试。`
      : quota
      ? `上游模型额度不足，未生成${label}。`
      : authFailure
        ? `上游模型授权不可用，未生成${label}。`
        : `上游模型调用失败，未生成${label}。请稍后重试。`,
  };
}

export function referenceForbiddenTerms(input: {
  referenceTitle?: unknown;
  materials?: unknown;
  referenceHighlights?: unknown;
  referenceAnalysis?: unknown;
}): string[] {
  const raw = [
    input.referenceTitle,
    ...(Array.isArray(input.materials) ? input.materials : []),
    ...(Array.isArray(input.referenceHighlights) ? input.referenceHighlights : []),
    input.referenceAnalysis,
  ].map(String).join('\n');
  const terms = new Set<string>();
  for (const match of raw.matchAll(/#([A-Za-z][A-Za-z0-9_-]{2,})/g)) terms.add(match[1]!);
  for (const match of raw.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g)) terms.add(match[0]!);
  for (const match of raw.matchAll(/\b[A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+\b/g)) terms.add(match[0]!);
  // Competitor names often use a single leading capital (for example
  // "Sinotruk"). Capture title-like Latin tokens too; common platform words
  // are removed below so they cannot leak through a local fallback.
  for (const match of raw.matchAll(/\b[A-Z][a-z][A-Za-z0-9-]{3,}\b/g)) terms.add(match[0]!);
  for (const term of ['CeraVe', 'TikTok', 'Instagram', 'Facebook', 'YouTube']) {
    if (raw.toLowerCase().includes(term.toLowerCase())) terms.add(term);
  }
  return Array.from(terms)
    .map(term => term.replace(/^#/, '').trim())
    .filter(term => term.length >= 3 && !/^(TikTok|Instagram|Facebook|YouTube|Video|Official|Factory|Product|Free|Mini|This|Summer|Brighter|Skin|Days)$/i.test(term))
    .slice(0, 24);
}

export function referenceIndustryLeakTerms(referenceText: string, productInfo: string): string[] {
  const reference = String(referenceText || '').toLowerCase();
  const product = String(productInfo || '').toLowerCase();
  const groups = [
    ['护肤', '美妆', '面霜', '眼霜', '防晒', '精华', '皮肤', 'skincare', 'cosmetic', 'cream', 'serum', 'sunscreen'],
    ['包装', '纸袋', '纸盒', '礼盒', '印刷', 'paper bag', 'paper box', 'package', 'packaging'],
    ['灯具', '照明', '轨道灯', '筒灯', '吸顶灯', '色温', '亮度', 'lighting', 'light fixture', 'track light'],
    ['电视', '电视机', '显示器', '屏幕', '4k', '8k', 'uhd', 'hdr', 'smart tv', 'television', 'screen'],
    ['服装', '面料', '连衣裙', 't恤', 'apparel', 'fabric', 'garment'],
    ['家具', '沙发', '椅子', '桌子', 'furniture', 'sofa', 'chair'],
  ];
  const leaked = new Set<string>();
  for (const group of groups) {
    const referenceHasGroup = group.some(term => reference.includes(term.toLowerCase()));
    const productHasGroup = group.some(term => product.includes(term.toLowerCase()));
    if (referenceHasGroup && !productHasGroup) {
      group.forEach(term => leaked.add(term));
    }
  }
  return Array.from(leaked);
}

export function storyboardReferenceLeakIssues(
  candidate: string,
  forbiddenTerms: string[],
  forbiddenIndustryTerms: string[],
): string[] {
  const text = String(candidate || '');
  const leakedTerms = forbiddenTerms.filter(term => new RegExp(
    `(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`,
    'i',
  ).test(text));
  const leakedIndustry = forbiddenIndustryTerms.filter(term => text.toLowerCase().includes(term.toLowerCase()));
  const hashtags = [...new Set(Array.from(text.matchAll(/#[A-Za-z][A-Za-z0-9_-]{2,}/g)).map(match => match[0]))];
  return [
    leakedTerms.length ? `仍含对标来源词：${leakedTerms.join('、')}` : '',
    leakedIndustry.length ? `仍含对标行业词：${leakedIndustry.join('、')}` : '',
    hashtags.length ? `分镜不应包含 Hashtag：${hashtags.join('、')}` : '',
  ].filter(Boolean);
}

export function stripStoryboardHashtags(script: string): string {
  return String(script || '')
    .replace(/#[A-Za-z][A-Za-z0-9_-]{2,}/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function stripStoryboardReferenceLeaks(
  script: string,
  forbiddenTerms: string[],
  forbiddenIndustryTerms: string[],
): string {
  let sanitized = String(script || '');
  for (const term of forbiddenTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sanitized = sanitized.replace(new RegExp(escaped, 'gi'), '');
  }
  for (const term of forbiddenIndustryTerms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replacement = /[A-Za-z]/.test(term) ? 'equipment' : /\d/.test(term) ? '' : '设备';
    if (/^[A-Za-z0-9][A-Za-z0-9\s-]*$/.test(term)) {
      sanitized = sanitized.replace(
        new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, 'gi'),
        (_match, prefix: string) => `${prefix}${replacement}`,
      );
    } else {
      sanitized = sanitized.replace(new RegExp(escaped, 'gi'), replacement);
    }
  }
  return stripStoryboardHashtags(sanitized)
    .replace(/设备(?:\s*设备)+/g, '设备')
    .replace(/equipment(?:\s+equipment)+/gi, 'equipment')
    .replace(/[ \t]+([，。！？、；：,.!?;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function unsupportedNumericClaims(candidate: string, productInfo: string): string[] {
  const normalizedCandidate = normalizeNumericEvidenceText(candidate);
  const pattern = /\d+(?:\.\d+)?\s*(?:瓶|bottles?|ml|毫升|kg|千克|公斤|g|克|斤|cm|厘米|mm|毫米|天|day|days|秒|seconds?|secs?|%|percent|个|pcs?|pieces?|件|箱|cartons?|boxes?|元|美元|usd|rmb|cny)/gi;
  return [...new Set(Array.from(normalizedCandidate.matchAll(pattern))
    .filter(match => {
      const claim = match[0];
      if (productInfoSupportsNumericClaim(claim, productInfo)) return false;
      const start = normalizedCandidate.lastIndexOf('\n', match.index ?? 0) + 1;
      const end = normalizedCandidate.indexOf('\n', match.index ?? 0);
      const line = normalizedCandidate.slice(start, end < 0 ? normalizedCandidate.length : end).trim();
      if (numericClaimIsProductionParameter(claim, line)) return false;
      if (/%$/.test(claim)) {
        return !/^(?:运镜|构图|环境|景别)[：:]/.test(line);
      }
      if (/(?:个|件|瓶)$/.test(claim) && /^(?:运镜|构图|环境|景别|画面)[：:]/.test(line)) return false;
      if (!/(?:cm|厘米|mm|毫米)$/i.test(claim)) return true;
      // Distances used to stage a shot are production directions, not product
      // specifications. Keep numeric claims in speech/captions and explicit
      // size/dimension statements subject to the closed-world fact gate.
      return /^(?:台词|字幕)[：:]/.test(line)
        || /(?:尺寸|规格|直径|高度|宽度|长度|厚度|容量)[^\n]*\d/i.test(line)
        || !/^(?:运镜|画面|构图|环境|景别)[：:]/.test(line);
    })
    .map(match => match[0]))];
}
