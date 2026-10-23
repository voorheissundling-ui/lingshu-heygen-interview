export interface OutboundGuardContext {
  tenantId?: string;
  customerId?: string;
  action?: string;
  classifyIntent?: (text: string) => Promise<{ contains_l4: boolean; category?: string }>;
}

export interface OutboundGuardResult {
  allowed: boolean;
  matchedRule?: string;
}

const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'price_or_amount', pattern: /(?:[$¥€]\s*\d+|\b(?:usd|rmb|eur|cny)\s*\d+|\d+(?:\.\d+)?\s*(?:usd|rmb|eur|cny|dollars?|yuan|元|块|美金))/i },
  { name: 'discount', pattern: /\b(?:discount|off|rebate|coupon|special price|better price|give u|give you)\b|(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*percent)\s*(?:off|discount)?|优惠|折扣|让利|降价|便宜/i },
  { name: 'delivery_promise', pattern: /(?:\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:days?|weeks?)\b.{0,32}\b(?:deliver|delivery|ship|shipping|arrive|lead time|guarantee|guaranteed)\b|\b(?:deliver|delivery|ship|shipping|arrive|lead time|guarantee|guaranteed)\b.{0,32}\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:days?|weeks?)\b|交期|发货|到货|几天内|周内|天内)/i },
  { name: 'payment_terms', pattern: /\b(?:payment|deposit|balance|t\/t|tt|l\/c|lc|wire transfer|western union|paypal)\b|付款|定金|预付|尾款|账期|信用证|电汇/i },
  { name: 'compensation', pattern: /\b(?:compensation|compensate|refund|replace for free|free replacement)\b|赔偿|补偿|退款|免费补发/i },
];

const INTENT_RULES: Array<{ category: string; pattern: RegExp }> = [
  { category: '价格承诺', pattern: /(?:unit price|per pc|per piece|quote|quotation|报价|单价|总价|价格)/i },
  { category: '合同条款', pattern: /(?:contract|agreement|exclusive|liability|合同|协议|独家|责任)/i },
  { category: '付款条款', pattern: /(?:net\s*\d+|payment after|pay after|付款后|货到付款|账期)/i },
  { category: '交期承诺', pattern: /(?:guarantee.{0,20}(?:ship|deliver|arrive)|保证.{0,12}(?:发货|到货|交付))/i },
];

export function guardOutboundSync(text: string): OutboundGuardResult {
  const body = text.trim();
  if (!body) return { allowed: true };
  const matched = RULES.find(rule => rule.pattern.test(body));
  return matched ? { allowed: false, matchedRule: matched.name } : { allowed: true };
}

async function classifyByHeuristic(text: string): Promise<{ contains_l4: boolean; category?: string }> {
  const matched = INTENT_RULES.find(rule => rule.pattern.test(text));
  return matched ? { contains_l4: true, category: matched.category } : { contains_l4: false };
}

export async function guardOutbound(text: string, context: OutboundGuardContext = {}): Promise<OutboundGuardResult> {
  const sync = guardOutboundSync(text);
  if (!sync.allowed) return sync;

  const classified = context.classifyIntent
    ? await context.classifyIntent(text)
    : await classifyByHeuristic(text);

  if (classified.contains_l4) {
    return { allowed: false, matchedRule: classified.category || 'l4_intent' };
  }
  return { allowed: true };
}
