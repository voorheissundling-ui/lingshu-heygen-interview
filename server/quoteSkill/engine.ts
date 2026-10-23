import type { BuildQuoteDraftInput, QuoteCatalogProduct, QuoteFieldEvidence, QuoteSkillDraft } from './types.js';

const MONEY_PATTERN = /(?:¥|rmb|cny|usd|us\$|\$)\s*([0-9]+(?:\.[0-9]+)?)/i;
const QUOTE_INTENT_PATTERN = /\b(quote|quotation|price|pricing|cost|best price|unit price|rfq|offer)\b|报价|价格|多少钱|单价|询价|成本/i;
const MATERIALS = ['6061-T6', '6061', '7075', 'SUS304', '304不锈钢', '45号钢', 'Q235', 'ABS', 'POM', 'PP', 'PC', 'stainless steel', 'aluminum', 'aluminium', 'carbon steel'];

function clean(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const match = clean(value).replaceAll(',', '').match(/[0-9]+(?:\.[0-9]+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function exactMoneyFrom(value: unknown): number | null {
  if (typeof value === 'number') return numberFrom(value);
  const source = clean(value).replaceAll(',', '');
  if (!source) return null;
  const matches = source.match(/[0-9]+(?:\.[0-9]+)?/g) || [];
  if (matches.length !== 1 || /(?:\d)\s*(?:-|–|—|~|to|至|到)\s*(?:[A-Z$¥￥]*\s*)?\d/i.test(source)) return null;
  return numberFrom(matches[0]);
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function tokens(value: string): string[] {
  return Array.from(new Set(normalized(value).split(/[^a-z0-9\u4e00-\u9fff]+/).filter(token => token.length >= 2)));
}

function evidence(field: QuoteFieldEvidence['field'], value: string | number, source: QuoteFieldEvidence['source'], excerpt: string): QuoteFieldEvidence {
  return { field, value, source, excerpt: excerpt.slice(0, 180) };
}

function requiredQuoteFields(draft: Pick<QuoteSkillDraft, 'productName' | 'quantity' | 'material' | 'destination' | 'incoterm' | 'leadTime' | 'deliveryDate' | 'paymentTerms'>): string[] {
  return [
    !draft.productName ? '具体产品或 SKU' : '',
    draft.quantity == null ? '采购数量' : '',
    !draft.material ? '材料/规格' : '',
    !draft.destination ? '交货地点或港口' : '',
    !draft.incoterm ? '贸易术语' : '',
    !draft.leadTime && !draft.deliveryDate ? '交期' : '',
    !draft.paymentTerms ? '付款条款' : '',
  ].filter(Boolean);
}

export function quoteQuestions(draft: Pick<QuoteSkillDraft, 'customerLanguage' | 'productName' | 'quantity' | 'material' | 'destination' | 'incoterm' | 'leadTime' | 'deliveryDate' | 'paymentTerms'> & { blockers?: string[] }): string[] {
  const chinese = /^(?:zh|中文|chinese)/i.test(draft.customerLanguage || '');
  const questions = chinese ? [
    !draft.productName ? '请确认具体产品名称或 SKU。' : '',
    draft.quantity == null ? '请问本次需要报价的数量是多少？' : '',
    !draft.material ? '请确认所需材料和关键规格。' : '',
    !draft.destination ? '请确认本次报价的交货地点或港口。' : '',
    !draft.incoterm ? '请确认本次报价使用的贸易术语，例如 EXW、FOB 或 DDP。' : '',
    draft.blockers?.includes('FOB 指定装运港尚未确认') ? '请确认 FOB 指定装运港。' : '',
    !draft.leadTime && !draft.deliveryDate ? '请确认目标交期。' : '',
    !draft.paymentTerms ? '请确认期望的付款条款。' : '',
  ] : [
    !draft.productName ? 'Could you confirm the exact product name or SKU?' : '',
    draft.quantity == null ? 'What quantity would you like us to quote?' : '',
    !draft.material ? 'Could you confirm the required material and key specifications?' : '',
    !draft.destination ? 'What named delivery place or port should we use for this quotation?' : '',
    !draft.incoterm ? 'Which Incoterm should we use for this quotation (for example, EXW, FOB or DDP)?' : '',
    draft.blockers?.includes('FOB 指定装运港尚未确认') ? 'Which named port of shipment should we use for FOB?' : '',
    !draft.leadTime && !draft.deliveryDate ? 'What is your target lead time or delivery date?' : '',
    !draft.paymentTerms ? 'What payment terms should we use for this quotation?' : '',
  ];
  return questions.filter(Boolean);
}

export function quoteIntentScore(text: string): number {
  const source = clean(text);
  if (!source) return 0;
  let score = QUOTE_INTENT_PATTERN.test(source) ? 55 : 0;
  if (/\d[\d,]*\s*(?:pcs?|pieces?|units?|件|套|个|箱)/i.test(source)) score += 18;
  if (MATERIALS.some(item => normalized(source).includes(normalized(item)))) score += 12;
  if (/delivery|lead time|交期|发货|within\s+\d+\s*(?:days?|weeks?)/i.test(source)) score += 10;
  if (/moq|sample|drawing|cad|specification|图纸|规格|样品/i.test(source)) score += 5;
  return Math.min(100, score);
}

function extractQuantity(text: string): number | null {
  const match = [...text.matchAll(/(\d[\d,]*)\s*(?:pcs?|pieces?|units?|sets?|件|套|个|箱)/gi)].at(-1);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

function extractMaterial(text: string): string {
  const matches = MATERIALS.flatMap(material => {
    const escaped = material.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...text.matchAll(new RegExp(`${/^[A-Za-z0-9]/.test(material) ? '\\b' : ''}${escaped}${/[A-Za-z0-9]$/.test(material) ? '\\b' : ''}`, 'gi'))]
      .map(match => ({ material, index: match.index }));
  });
  matches.sort((left, right) => right.index - left.index || right.material.length - left.material.length);
  return matches[0]?.material || '';
}

function extractDelivery(text: string): string {
  // Resolve corrections in dialogue order. A withdrawn customer deadline does
  // not change the independent lead time supplied by the enterprise catalog.
  const events: Array<{ index: number; value: string }> = [];
  for (const iso of text.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/g)) {
    events.push({ index: iso.index, value: `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}` });
  }
  for (const relative of text.matchAll(/(?:within|in|交期|需要)\s*(\d+)\s*(days?|weeks?|天|周)/gi)) {
    events.push({ index: relative.index, value: `${relative[1]} ${/week|周/i.test(relative[2]) ? 'weeks' : 'days'}` });
  }
  const withdrawal = /\b(?:no\s+(?:longer\s+)?(?:any\s+)?(?:delivery\s+(?:deadline|date|requirement|target)|delivery\s+deadline\s+requirement|lead\s+time\s+requirement)|(?:withdraw|cancel|remove)\s+(?:the\s+|my\s+|our\s+)?(?:delivery\s+(?:deadline|date|requirement|target)))\b|(?:取消|撤销|不再要求|不再需要)(?:之前的|原先的|原定的)?(?:交期|交货日期|交付日期|交付期限)|(?:没有|无需|不需要)(?:交期|交货日期|交付日期|交付期限)(?:要求)?/gi;
  for (const match of text.matchAll(withdrawal)) events.push({ index: match.index, value: '' });
  return events.sort((left, right) => left.index - right.index).at(-1)?.value || '';
}

function extractDestination(text: string): string {
  const match = [...text.matchAll(/(?:ship(?:ping)?\s+to|deliver(?:y)?\s+to|destination(?:\s+(?:is|remains))?|发往|发到|目的地|目的港)\s*[:：]?\s*([A-Za-z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff .-]{1,40})/gi)].at(-1);
  return match?.[1]?.split(/[;,。\n]|\.(?:\s|$)/)[0]?.trim() || '';
}

function extractCustomerBudget(text: string): { amount: number; currency: string } | undefined {
  const events: Array<{ index: number; value: { amount: number; currency: string } | undefined }> = [];
  for (const match of text.matchAll(/(?:\bbudget\s*(?:is|of|:)?|预算\s*[:：]?)\s*(USD|CNY|RMB|EUR|GBP|US\$|\$|¥|￥)\s*([\d,]+(?:\.\d+)?)/gi)) {
    const amount = numberFrom(match[2]);
    if (amount) events.push({ index: match.index, value: { amount, currency: match[1].toUpperCase().replace(/^(?:US\$|\$)$/, 'USD').replace(/^(?:RMB|¥|￥)$/, 'CNY') } });
  }
  // A refusal to increase a budget is not a withdrawal of the existing amount.
  const withdrawal = /\b(?:no\s+(?:longer\s+)?(?:any\s+)?budget(?=\s*(?:anymore\b|[.;,\n]|$))|(?:withdraw|cancel|remove)\s+(?:the\s+|my\s+|our\s+)?budget\b|budget\s+(?:is\s+)?(?:withdrawn|cancelled|canceled|no\s+longer\s+(?:available|confirmed)))|(?:取消|撤销|不再提供)(?:之前的|原先的|原定的)?预算|(?:预算)(?:已取消|已撤销|不再有效)/gi;
  for (const match of text.matchAll(withdrawal)) events.push({ index: match.index, value: undefined });
  return events.sort((left, right) => left.index - right.index).at(-1)?.value;
}

function extractIncoterm(text: string): string {
  return [...text.matchAll(/\b(EXW|FCA|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/gi)].at(-1)?.[1]?.toUpperCase() || '';
}

function extractPackaging(text: string): string {
  return text.match(/\b(export cartons?|wooden (?:cases?|crates?)|pallets?|vacuum pack(?:aging)?)\b/i)?.[1]?.trim() || '';
}

function extractDrawingVersion(text: string): string {
  return text.match(/(?:drawing|图纸)\s*(?:revision|rev(?:ision)?|版本)?\s*[:：#-]?\s*([A-Za-z0-9._-]{1,30})/i)?.[1]?.trim() || '';
}

function extractProductName(text: string): string {
  const english = text.match(/\d[\d,]*\s*(?:pcs?|pieces?|units?|sets?)\s+(?:of\s+)?(.+?)(?=\s+(?:in|made\s+of)\s+(?:6061|7075|sus304|stainless|alumin|carbon\s+steel)|[,.;]|\s+(?:with\s+delivery|delivery|lead\s+time)|$)/i);
  if (english?.[1]) return english[1].trim().replace(/^(?:the|our)\s+/i, '').slice(0, 120);
  const chinese = text.match(/\d[\d,]*\s*(?:件|套|个|箱)\s*([^，。；,;]{2,40}?)(?=\s*(?:材料|材质|规格|交期|发货|，|。|；|,|;|$))/);
  return chinese?.[1]?.trim() || '';
}

function productScore(query: string, product: QuoteCatalogProduct): number {
  const haystack = normalized(`${product.sku} ${product.name} ${product.material}`);
  const queryNormalized = normalized(query);
  let score = product.sku && queryNormalized.includes(normalized(product.sku)) ? 100 : 0;
  if (product.name && (queryNormalized.includes(normalized(product.name)) || normalized(product.name).includes(queryNormalized))) score += 70;
  score += tokens(query).reduce((sum, token) => sum + (haystack.includes(token) ? 10 : 0), 0);
  return score;
}

function bestProduct(query: string, products: QuoteCatalogProduct[]): QuoteCatalogProduct | null {
  const ranked = products.map(product => ({ product, score: productScore(query, product) })).sort((a, b) => b.score - a.score);
  return (ranked[0]?.score || 0) >= 20 ? ranked[0].product : null;
}

export function catalogProductsFromEnterprise(items: Array<Record<string, unknown>> = []): QuoteCatalogProduct[] {
  return items.map(item => {
    const attributes = item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)
      ? item.attributes as Record<string, unknown>
      : {};
    const candidates: Array<[unknown, string]> = [
      [attributes.unitPrice, '企业产品目录 unitPrice'],
      [attributes.referencePrice, '企业产品目录 referencePrice'],
      [item.retailPrice, '企业产品目录 retailPrice'],
      [item.tagPrice, '企业产品目录 tagPrice'],
      [item.priceRange, '企业产品目录 priceRange'],
    ];
    const priced = candidates.map(([value, source]) => ({ value, source, amount: exactMoneyFrom(value) })).find(candidate => candidate.amount != null);
    const explicitPrice = priced?.amount ?? null;
    const priceText = clean(priced?.value ?? candidates.map(([value]) => clean(value)).find(Boolean));
    const currency = /\$|usd/i.test(priceText) ? 'USD' : clean(attributes.currency) || 'CNY';
    return {
      sku: clean(item.sku),
      name: clean(item.name),
      material: clean(item.material || attributes.material),
      unit: clean(attributes.unit) || '件',
      unitPrice: explicitPrice,
      currency,
      moq: numberFrom(item.moq ?? attributes.moq),
      leadTime: attributes.leadTimeDays && !attributes.leadTime ? `${clean(attributes.leadTimeDays)} days` : clean(attributes.leadTime),
      priceSource: explicitPrice == null ? '' : priced!.source,
      attributes,
    };
  }).filter(product => product.name || product.sku);
}

export function buildQuoteDraft(input: BuildQuoteDraftInput): QuoteSkillDraft {
  const message = input.messages.map(clean).filter(Boolean).slice(-12).join('\n');
  const intentScore = quoteIntentScore(message);
  const quantity = extractQuantity(message);
  const material = extractMaterial(message);
  const deliveryDate = extractDelivery(message);
  const destination = extractDestination(message);
  const incoterm = extractIncoterm(message);
  const packaging = extractPackaging(message);
  const drawingVersion = extractDrawingVersion(message);
  const extractedProduct = extractProductName(message);
  // A later explicit SKU takes precedence over a generic profile hint or an
  // earlier request. Keep unknown SKUs unmatched rather than reusing an old price.
  const explicitSku = [...message.matchAll(/\bSKU\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_-]*)/gi)].at(-1)?.[1];
  const productHint = /^(?:待确认|待补充|未知|unknown|tbd)$/i.test(clean(input.productHint)) ? '' : clean(input.productHint);
  const productQuery = explicitSku || productHint || extractedProduct || message;
  const matchedProduct = explicitSku
    ? input.products.find(product => normalized(product.sku) === normalized(explicitSku)) || null
    : bestProduct(productQuery, input.products);
  const productName = matchedProduct?.name || clean(input.productHint) || extractedProduct;
  const resolvedMaterial = material || matchedProduct?.material || '';
  const materialMismatch = Boolean(material && matchedProduct?.material && normalized(material) !== normalized(matchedProduct.material));
  const unitPrice = materialMismatch ? null : matchedProduct?.unitPrice ?? null;
  const currency = matchedProduct?.currency || (/\busd\b|\$/i.test(message) ? 'USD' : 'CNY');
  const unit = matchedProduct?.unit || '件';
  const subtotal = quantity != null && unitPrice != null ? Number((quantity * unitPrice).toFixed(2)) : null;
  const customerBudget = extractCustomerBudget(message);
  const leadTime = matchedProduct?.leadTime || clean(input.rules.leadTime);
  const fieldEvidence: QuoteFieldEvidence[] = [];
  if (productName) fieldEvidence.push(evidence('productName', productName, matchedProduct ? 'product_catalog' : 'customer_profile', matchedProduct ? `${matchedProduct.sku} ${matchedProduct.name}` : productName));
  if (quantity != null) fieldEvidence.push(evidence('quantity', quantity, 'buyer_message', [...message.matchAll(/\d[\d,]*\s*(?:pcs?|pieces?|units?|sets?|件|套|个|箱)/gi)].at(-1)?.[0] || String(quantity)));
  if (resolvedMaterial) fieldEvidence.push(evidence('material', resolvedMaterial, material ? 'buyer_message' : 'product_catalog', resolvedMaterial));
  if (deliveryDate) fieldEvidence.push(evidence('deliveryDate', deliveryDate, 'buyer_message', deliveryDate));
  if (destination) fieldEvidence.push(evidence('destination', destination, 'buyer_message', destination));
  if (incoterm) fieldEvidence.push(evidence('incoterm', incoterm, 'buyer_message', incoterm));
  if (packaging) fieldEvidence.push(evidence('packaging', packaging, 'buyer_message', packaging));
  if (drawingVersion) fieldEvidence.push(evidence('drawingVersion', drawingVersion, 'buyer_message', drawingVersion));

  const requiredFields = { productName, quantity, material: resolvedMaterial, destination, incoterm, leadTime, deliveryDate, paymentTerms: clean(input.rules.paymentTerms) };
  const missingFields = requiredQuoteFields(requiredFields);
  const blockers: string[] = [];
  if (input.rules.quoteMode === 'human_only' && unitPrice == null) blockers.push('企业设置为仅人工报价，需人工填写单价');
  if (!matchedProduct) blockers.push('未匹配到企业产品目录');
  if (unitPrice == null) blockers.push('产品目录没有可核验单价');
  if (materialMismatch) blockers.push('客户材料与目录规格不一致，需确认对应价格');
  if (!leadTime && deliveryDate) blockers.push('客户目标交期尚未获得企业履约信息确认');
  const latestFobContext = input.messages.filter(value => /\bFOB\b/i.test(value)).at(-1) || '';
  const unresolvedFobPort = incoterm === 'FOB' && /(?:named\s+)?FOB\s+port\s+(?:still\s+)?(?:needs?\s+confirmation|(?:is|remains?)\s+(?:unknown|unconfirmed|not\s+confirmed|pending\s+confirmation))|FOB.{0,8}(?:港口待确认|港口未确认)/i.test(latestFobContext);
  if (unresolvedFobPort) blockers.push('FOB 指定装运港尚未确认');
  if (matchedProduct?.moq != null && quantity != null && quantity < matchedProduct.moq) blockers.push(`数量低于 MOQ ${matchedProduct.moq}`);

  const pricingExplanation = [
    matchedProduct ? `匹配产品：${matchedProduct.sku ? `${matchedProduct.sku} · ` : ''}${matchedProduct.name}` : '没有可靠的目录产品匹配',
    unitPrice != null ? `价格来源：${matchedProduct?.priceSource || '企业配置'} ${currency} ${unitPrice}/${unit}` : '价格待人工填写，Agent 不猜测单价',
    leadTime ? `参考交期：${leadTime}` : '交期待人工确认',
  ];
  const clarificationQuestions = quoteQuestions({ ...requiredFields, blockers, customerLanguage: clean(input.customerLanguage) || 'English' });
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    revision: 1,
    version: 1,
    customerId: clean(input.customerId),
    customerName: clean(input.customerName),
    customerNameSource: input.customerNameSource === 'whatsapp_profile' ? 'whatsapp_profile' : 'safe_fallback',
    customerLanguage: clean(input.customerLanguage) || 'English',
    sellerName: clean(input.sellerName),
    status: missingFields.length || blockers.length ? 'needs_clarification' : 'ready_for_review',
    intentScore,
    productName,
    sku: matchedProduct?.sku || '',
    quantity,
    unit,
    material: resolvedMaterial,
    deliveryDate,
    destination,
    incoterm,
    packaging,
    drawingVersion,
    unitPrice,
    ...(unitPrice != null ? { unitPriceSource: 'product_catalog' as const } : {}),
    currency,
    subtotal,
    ...(customerBudget ? { customerBudget } : {}),
    leadTime,
    paymentTerms: clean(input.rules.paymentTerms),
    validityDays: 15,
    missingFields,
    blockers,
    evidence: fieldEvidence,
    matchedProduct,
    pricingExplanation,
    clarificationQuestions,
    humanConfirmationRequired: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function applyQuoteDraftPatch(draft: QuoteSkillDraft, patch: Record<string, unknown>, source: QuoteFieldEvidence['source'] = 'human'): QuoteSkillDraft {
  const next = { ...draft };
  const catalogMatch = patch.matchedProduct && typeof patch.matchedProduct === 'object'
    ? patch.matchedProduct as QuoteCatalogProduct
    : null;
  const productIdentityChanged = ('productName' in patch && clean(patch.productName) !== draft.productName)
    || ('sku' in patch && clean(patch.sku) !== draft.sku);
  if ('productName' in patch) next.productName = clean(patch.productName);
  if ('sku' in patch) next.sku = clean(patch.sku);
  if ('material' in patch) next.material = clean(patch.material);
  if ('deliveryDate' in patch) next.deliveryDate = clean(patch.deliveryDate);
  if ('destination' in patch) next.destination = clean(patch.destination);
  if ('incoterm' in patch) next.incoterm = clean(patch.incoterm).toUpperCase();
  if ('packaging' in patch) next.packaging = clean(patch.packaging);
  if ('drawingVersion' in patch) next.drawingVersion = clean(patch.drawingVersion);
  if ('unit' in patch) next.unit = clean(patch.unit) || next.unit;
  if ('currency' in patch) next.currency = clean(patch.currency).toUpperCase().slice(0, 6) || next.currency;
  if ('leadTime' in patch) next.leadTime = clean(patch.leadTime);
  if ('paymentTerms' in patch) next.paymentTerms = clean(patch.paymentTerms);
  if ('quantity' in patch) next.quantity = numberFrom(patch.quantity);
  if ('unitPrice' in patch) {
    next.unitPrice = numberFrom(patch.unitPrice);
    next.unitPriceSource = next.unitPrice == null
      ? undefined
      : patch.unitPriceSource === 'product_catalog' || patch.unitPriceSource === 'human'
        ? patch.unitPriceSource
        : source === 'product_catalog' ? 'product_catalog' : 'human';
  } else if (productIdentityChanged || ('material' in patch && clean(patch.material) !== draft.material)) {
    next.unitPrice = null;
    next.unitPriceSource = undefined;
  }
  if (catalogMatch) next.matchedProduct = catalogMatch;
  else if (productIdentityChanged) next.matchedProduct = null;
  if (next.unitPrice != null && (patch.unitPriceSource === 'product_catalog' || patch.unitPriceSource === 'human')) {
    next.unitPriceSource = patch.unitPriceSource;
  } else if (next.unitPrice != null && source === 'human' && ('currency' in patch || 'unit' in patch)) {
    next.unitPriceSource = 'human';
  }
  if ('validityDays' in patch) next.validityDays = Math.max(1, Math.min(365, Math.round(numberFrom(patch.validityDays) || 15)));
  next.subtotal = next.quantity != null && next.unitPrice != null ? Number((next.quantity * next.unitPrice).toFixed(2)) : null;
  next.missingFields = requiredQuoteFields(next);
  next.blockers = draft.blockers.filter(item => !/没有可核验单价|未匹配到企业产品目录|仅人工报价|数量低于 MOQ|客户材料与目录规格不一致|客户目标交期尚未获得企业履约信息确认/.test(item));
  const explicitlyNamedPort = /\bport\b|港/i.test(next.destination)
    && !/unknown|unconfirmed|pending|not\s+confirmed|\bTBD\b|待确认|未确认|未知/i.test(next.destination)
    && Boolean(next.destination.replace(/\b(?:port|of|FOB)\b|港口|港/gi, '').trim());
  if (source === 'human' && 'destination' in patch && explicitlyNamedPort && next.destination !== draft.destination) next.blockers = next.blockers.filter(item => item !== 'FOB 指定装运港尚未确认');
  if (next.unitPrice == null) next.blockers.push('产品目录没有可核验单价');
  if (!next.leadTime && next.deliveryDate && !(source === 'human' && 'deliveryDate' in patch)) next.blockers.push('客户目标交期尚未获得企业履约信息确认');
  if (next.matchedProduct?.moq != null && next.quantity != null && next.quantity < next.matchedProduct.moq) next.blockers.push(`数量低于 MOQ ${next.matchedProduct.moq}`);
  next.pricingExplanation = [
    next.matchedProduct
      ? `匹配产品：${next.matchedProduct.sku ? `${next.matchedProduct.sku} · ` : ''}${next.matchedProduct.name}`
      : `产品由人工确认：${next.productName || '待确认'}`,
    next.unitPrice != null
      ? `价格来源：${next.unitPriceSource === 'product_catalog' ? next.matchedProduct?.priceSource || '企业配置' : '人工填写'} ${next.currency} ${next.unitPrice}/${next.unit}`
      : '价格待人工填写，Agent 不猜测单价',
    next.leadTime ? `参考交期：${next.leadTime}` : next.deliveryDate ? `目标交期：${next.deliveryDate}（需确认履约）` : '交期待人工确认',
  ];
  next.clarificationQuestions = quoteQuestions(next);
  next.status = next.missingFields.length || next.blockers.length ? 'needs_clarification' : 'ready_for_review';
  next.updatedAt = new Date().toISOString();
  next.evidence = [...draft.evidence, ...(['productName', 'quantity', 'material', 'deliveryDate', 'destination', 'incoterm', 'packaging', 'drawingVersion'] as const)
    .filter(field => field in patch && clean(patch[field]))
    .map(field => evidence(field, field === 'quantity' ? Number(patch[field]) : clean(patch[field]), source, `人工填写：${clean(patch[field])}`))];
  return next;
}

export function composeQuoteReply(draft: QuoteSkillDraft): string {
  if (draft.status !== 'confirmed') throw new Error('quote_not_confirmed');
  const amount = draft.subtotal == null ? '' : `${draft.currency} ${draft.subtotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const chinese = /^(?:zh|中文|chinese)/i.test(draft.customerLanguage || '');
  const customerName = draft.customerNameSource === 'whatsapp_profile' ? clean(draft.customerName) : '';
  if (chinese) {
    return [
      `${customerName ? `${customerName}，您好：` : '您好：'}`,
      `感谢您的询价。${draft.productName}${draft.material ? `（${draft.material}）` : ''}的报价为 ${draft.currency} ${draft.unitPrice}/${draft.unit}，数量 ${draft.quantity} ${draft.unit}。`,
      amount ? `产品小计：${amount}。` : '',
      draft.leadTime ? `参考交期：${draft.leadTime}。` : '',
      draft.deliveryDate ? `客户目标交期：${draft.deliveryDate}，最终履约时间待确认。` : '',
      draft.paymentTerms ? `付款条款：${draft.paymentTerms}。` : '',
      draft.incoterm ? `贸易术语：${draft.incoterm}${draft.destination ? `，指定地点/港口 ${draft.destination}` : ''}。` : '',
      draft.drawingVersion ? `图纸版本：${draft.drawingVersion}。` : '',
      draft.packaging ? `包装要求：${draft.packaging}。` : '',
      `本报价有效期为 ${draft.validityDays} 天。运费、税费和最终交付承诺将在确认目的地及订单明细后确定。`,
      '如需正式报价单，请告诉我。',
    ].filter(Boolean).join('\n\n');
  }
  const englishUnit = ({ 件: 'pcs', 个: 'units', 套: 'sets', 箱: 'cartons' } as Record<string, string>)[draft.unit] || draft.unit;
  return [
    `Hi ${customerName || 'there'},`,
    `Thank you for your inquiry. We can offer ${draft.quantity} ${englishUnit} of ${draft.productName}${draft.material ? ` in ${draft.material}` : ''} at ${draft.currency} ${draft.unitPrice} per ${englishUnit === 'pcs' ? 'piece' : englishUnit.replace(/s$/, '')}.`,
    amount ? `The product subtotal is ${amount}.` : '',
    draft.leadTime ? `Reference lead time: ${draft.leadTime}.` : '',
    draft.deliveryDate ? `Requested delivery: ${draft.deliveryDate}; final fulfillment timing is subject to confirmation.` : '',
    draft.paymentTerms ? `Payment terms: ${draft.paymentTerms}.` : '',
    draft.incoterm ? `Incoterm: ${draft.incoterm}${draft.destination ? `, named place/port ${draft.destination}` : ''}.` : '',
    draft.drawingVersion ? `Drawing revision: ${draft.drawingVersion}.` : '',
    draft.packaging ? `Packaging: ${draft.packaging}.` : '',
    `This quotation is valid for ${draft.validityDays} days. Shipping, tax and final delivery commitment will be confirmed against the destination and order details.`,
    'Please let me know if you would like us to prepare the formal quotation document.',
  ].filter(Boolean).join('\n\n');
}

export function parseManualPrice(text: string): { unitPrice: number | null; currency: string } {
  const match = clean(text).match(MONEY_PATTERN);
  return { unitPrice: match ? Number(match[1]) : null, currency: /usd|us\$|\$/i.test(text) ? 'USD' : 'CNY' };
}
