export type BantKey = 'budget' | 'authority' | 'need' | 'timing';
export type BantStatus = 'unknown' | 'partial' | 'confirmed';
export type AuthenticityBand = 'verified' | 'reduced' | 'suspected_scraping';
export type QualificationBand = 'white' | 'blue' | 'yellow' | 'red' | 'black';

export interface BantDimension {
  score: number;
  status: BantStatus;
  evidence: string[];
  signalPoints?: Record<string, number>;
}

export interface AuthenticityAssessment {
  score: number;
  band: AuthenticityBand;
  redFlags: string[];
  greenFlags: string[];
}

export interface BantAssessment {
  budget: BantDimension;
  authority: BantDimension;
  need: BantDimension;
  timing: BantDimension;
  rawTotal: number;
  authenticity: AuthenticityAssessment;
  total: number;
  band: QualificationBand;
  completeness: number;
  level: 'early' | 'qualified' | 'hot';
  evidence: string[];
  updatedAt: string;
}

export interface ProgressionGoal {
  dimension: BantKey;
  label: string;
  reason: string;
  question: string;
  questionStyle: 'spin_indirect';
  updatedAt: string;
}

export interface QualificationTurn {
  role: 'buyer' | 'seller';
  text: string;
}

interface ScoreSignal {
  key: string;
  points: number;
  evidence: string;
  matched: boolean;
}

const QUANTITY_MODIFIER = '(?:(?:private[- ]label|custom(?:ized)?|printed|branded)\\s+)?';
const LARGE_QUANTITY_PATTERN = new RegExp(`\\b(?:[5-9]\\d{2}|[1-9]\\d{3,}|\\d{1,3}(?:,\\d{3})+)\\s*${QUANTITY_MODIFIER}(?:pcs?|pieces?|units?|sets?|cartons?|bottles?|boxes?)\\b|(?:500|[6-9]\\d{2}|\\d{4,})\\s*(?:件|个|套|箱|瓶|盒)|\\b(?:one|a|1)\\s+(?:full\\s+)?container\\b|(?:一|1)\\s*(?:个)?整柜`, 'i');
const SMALL_MEDIUM_QUANTITY_PATTERN = new RegExp(`\\b(?:5\\d|[6-9]\\d|[1-4]\\d{2})\\s*${QUANTITY_MODIFIER}(?:pcs?|pieces?|units?|sets?|cartons?|bottles?|boxes?)\\b|(?:5\\d|[6-9]\\d|[1-4]\\d{2})\\s*(?:件|个|套|箱|瓶|盒)`, 'i');
const ANY_QUANTITY_PATTERN = new RegExp(`\\b\\d[\\d,]*\\s*${QUANTITY_MODIFIER}(?:pcs?|pieces?|units?|sets?|cartons?|containers?|bottles?|boxes?)\\b|\\d+\\s*(?:件|个|套|箱|瓶|盒|柜)`, 'i');
const TIER_PRICE_PATTERN = /\b(?:tier(?:ed)? price|price tiers?|quantity break|volume price|wholesale price|dealer price|distributor price)\b|阶梯价|批发价|经销价|代理价|量大价|数量价格/i;
const CURRENT_SUPPLIER_PATTERN = /\b(?:current|existing|present|regular) supplier\b|\bsource(?:d|ing)? from\b|\bwe (?:usually|currently) buy\b|现有供应商|现在的供应商|一直从.{0,18}(?:采购|拿货)|目前从.{0,18}(?:采购|拿货)/i;
const TARGET_PRICE_PATTERN = /\b(?:target price|target cost|budget is|budget of|need it (?:at|under|below)|price target)\b.{0,20}(?:[$€£¥]|usd|eur|gbp|rmb|cny|\d)|(?:目标价|预算|希望价格|控制在).{0,18}\d/i;
const PRICE_PROBE_PATTERN = /\b(?:how much|best price|lowest price|cheapest|price)\b|多少钱|最低价|价格/i;
const FULL_PRICE_LIST_PATTERN = /\bfull price list\b|\ball (?:your )?products?.{0,10}price\b|complete price list|price list for everything|全部产品.{0,6}价格|完整价格表|所有产品报价/i;

const OWNER_PATTERN = /\b(?:owner|founder|co-founder|ceo|president)\b|老板|店主|创始人|法人|总经理/i;
const SELF_OWNER_PATTERN = /\bi\s+(?:am|['’]m)\s+(?:(?:the|a|an)\s+)?(?:owner|founder|co-founder|ceo|president)\b|我是(?:老板|店主|创始人|法人|总经理)/i;
const DIRECT_DECIDER_PATTERN = /\b(?:i decide|i approve|i handle purchasing|i am (?:the )?(?:buyer|purchasing manager|procurement manager|director)|we (?:will|can|are ready to) (?:place|make|confirm) (?:the |an )?order)\b|我决定|我拍板|我负责采购|我是采购|我们会下单|可以下单|准备下单/i;
const AUTHORITY_DENIAL_PATTERN = /\b(?:i\s+(?:cannot|can't|can not|do not|don't)\s+(?:approve\s+(?:purchases?|orders?)|make\s+(?:the\s+)?purchas(?:e|ing)\s+decisions?)|i\s+am\s+not\s+(?:the\s+)?(?:purchasing\s+)?decision\s*maker)\b|(?:我|本人)(?:没有|无|不能|无法|不具备).{0,8}(?:采购决策权|采购审批权|批准采购|批准订单)/i;
const NEEDS_APPROVAL_PATTERN = /\b(?:need to (?:ask|check with|confirm with)|my (?:partner|boss|manager) (?:will|needs to)|team approval|management approval)\b|要问.{0,6}(?:合伙人|老板|经理)|需要.{0,6}(?:合伙人|老板|领导|团队).{0,6}(?:确认|审批)/i;
const FOR_CLIENT_PATTERN = /\b(?:for my client|for a client|my customer asked|helping (?:a|my) client)\b|替客户问|帮客户问|给我的客户|客户让我问/i;
const COMPANY_INFO_PATTERN = /\b(?:my|our) (?:company|business|shop|store|clinic|salon|brand)\b|\b(?:company name|business email|corporate email)\b|我们公司|我司|我们店|公司名称|企业邮箱/i;
const BUSINESS_OPERATOR_PATTERN = /\b(?:we are|i am).{0,24}(?:distributor|wholesaler|retailer|importer|retail chain|store|shop|clinic|salon)|\bi (?:run|own) (?:a |the )?(?:shop|store|business|clinic|salon)|我们是.{0,12}(?:经销商|批发商|零售商|进口商|连锁|门店|诊所|沙龙)|我经营|我有.{0,8}(?:店|公司)/i;
const IDENTITY_REFUSAL_PATTERN = /\b(?:won't|will not|don't want to) (?:share|say|tell).{0,20}(?:company|business|identity|use|market)\b|拒绝.{0,8}(?:身份|用途|公司)|不说.{0,8}(?:身份|用途|公司)|不方便.{0,8}(?:身份|用途|公司)/i;

const EXACT_PRODUCT_PATTERN = /\b(?:sku\s*[-:#]?\s*[a-z0-9-]+|model\s*[-:#]?\s*[a-z0-9-]+|collagen serum|face serum|facial mask|sheet mask|sunscreen|hair accessory|lip gloss|body lotion|the product in (?:your|that) video|that one)\b|货号|型号|胶原精华|面部精华|面膜|防晒|身体乳|视频里那款|这款产品/i;
const SPEC_PATTERN = /\b(?:specification|ingredients?|formula|material|size|capacity|volume|weight|color|packaging|pack size|\d+\s*(?:ml|g|kg|oz))\b|规格|成分|配方|材质|尺寸|容量|克重|颜色|包装|毫升/i;
const TARGET_MARKET_PATTERN = /\b(?:target market|selling (?:in|to)|distribute (?:in|to)|for the .{0,20} market|market is)\b|目标市场|销往|销售到|在.{0,10}(?:销售|经销)|市场是/i;
const USE_SCENARIO_PATTERN = /\b(?:for (?:our|my) (?:shop|store|clinic|salon|pharmacy|brand|chain|distributors?)|resell|retail|wholesale|distribution|e-commerce|online store)\b|用于.{0,10}(?:门店|诊所|沙龙|药房|品牌|经销|电商)|转售|零售|批发/i;
const CUSTOMIZATION_PATTERN = /\b(?:private[- ]label|oem|odm|our logo|custom(?:ize|ized)? (?:logo|label|packaging|formula|design)|bilingual packaging)\b|私标|贴牌|代工|定制.{0,8}(?:标|包装|配方|设计)|印我们的logo|双语包装/i;
const GENERIC_CATALOG_PATTERN = /\b(?:catalog|catalogue|brochure|product list)\b|目录|产品册|产品清单/i;
const SAMPLE_REQUEST_PATTERN = /\b(?:sample|trial sample)\b|样品|试样/i;
const FORMAL_QUOTE_PATTERN = /\b(?:quotation|formal quote|proforma invoice|send (?:the )?pi|prepare (?:the )?pi)\b|正式报价单|形式发票|开PI/i;
const PURCHASE_INTENT_PATTERN = /\b(?:i want to order|let'?s proceed|ready to order|place (?:the |an )?order)\b|我要下单|开始下单|继续推进|准备下单/i;

const DEADLINE_PATTERN = /\b(?:deadline|launch date|need (?:it|them) by|must arrive by|before (?:next\s+)?(?:week|month|quarter|\w+ \d{1,2})|within \d+ (?:days?|weeks?))\b|截止日期|上市日期|必须.{0,8}(?:前|之前)(?:到货|交付)|\d+\s*(?:天|周)内/i;
const URGENT_PATTERN = /\b(?:urgent|asap|right away|immediately|as soon as possible)\b|紧急|急单|尽快|马上要/i;
const SEASON_PATTERN = /\b(?:christmas|ramadan|eid|black friday|valentine|festival|holiday season|peak season|busy season|summer season)\b|圣诞|斋月|开斋节|黑五|情人节|节日|节庆|旺季|销售季/i;
const RESTOCK_PATTERN = /\b(?:reorder|repeat order|restock|replenish|top up stock|sold out)\b|复购|返单|补货|再下一单|卖完了/i;
const RESEARCH_PATTERN = /\b(?:comparing|compare suppliers?|researching|checking options|looking around|getting quotes)\b|正在比较|对比供应商|调研中|看看选择|多问几家/i;
const NEXT_YEAR_PATTERN = /\b(?:maybe|perhaps|possibly) next year\b|也许明年|可能明年|明年再说/i;

const MARKET_MENTION_PATTERN = /\b(?:market|country|region)\b|selling (?:in|to)|for\s+(?:our|the)\s+\w+\s+market|市场|国家|地区/i;
const REFUSAL_TO_DISCLOSE_PATTERN = /\bwhy (?:do you need|does it matter|ask)\b|just (?:send|give|tell) me (?:the )?price|no need to (?:know|tell)|不需要告诉你|不方便说|直接说价格|别问那么多/i;
const FACTORY_PROBE_PATTERN = /\bfactory address\b|\bproduction line\b|\bwhich factory\b|\bwho (?:is your|manufactures)\b|工厂地址|生产线|哪个工厂|谁生产/i;
const OTHER_CUSTOMERS_PATTERN = /\bwho else (?:do you supply|are your customers)\b|other (?:customers|clients|buyers)\b.{0,20}(?:you supply|you have)|还给谁供货|其他客户是谁|你的客户有哪些/i;
const UNUSUAL_PAYMENT_PATTERN = /\bno deposit\b|\bzero deposit\b|\bpay after (?:delivery|receipt)\b|\bship first\b|\boverpay\b|refund the difference|western union|money order|cashier'?s check|无需定金|先发货后付款|货到付款|多付.{0,6}退还|银行本票|电汇差额/i;
const DESCRIBES_BUSINESS_PATTERN = /\bwe are\b|\bour (?:shop|store|company|business|clinic|chain|brand|salon|pharmacy)\b|\bi run\b|\bi own\b|我们是|我们店|我司|我们公司/i;
const SHARES_COMPANY_INFO_PATTERN = /\bwebsite\b|\binstagram\b|\bfacebook\b|www\.|\.com\b|官网|社媒|https?:\/\//i;
const EXECUTABLE_LOGISTICS_PATTERN = /\b(?:shipping|customs|duty|payment terms|deposit|T\/T|L\/C|incoterm|FOB|CIF)\b|物流|清关|关税|付款方式|定金/i;
const AFTERSALES_PATTERN = /\b(?:after.?sales|return policy|returns?|warranty|replacement|defect handling)\b|售后|退换|退货|保修|质保|瑕疵处理/i;
const CONTENT_SOURCE_PATTERN = /\bsaw your (?:video|post|ad)\b|\byour (?:tiktok|instagram|youtube)\b|看到你.{0,6}(?:视频|广告)|从.{0,10}(?:短视频|广告).{0,6}看到/i;
const CALL_WILLING_PATTERN = /\b(?:can we|let'?s|want to) (?:call|video call|speak)\b|方便通话|视频聊|打个电话/i;

const RED_FLAG_LABELS: Record<string, string> = {
  price_only_no_quantity: '信息待核实：只反复问价，未说明采购数量',
  full_price_list: '信息待核实：索要全部产品完整价格表',
  refuses_market: '信息待核实：回避说明目标市场或用途',
  factory_probe: '信息待核实：过早追问工厂地址或产线细节',
  other_customers: '信息待核实：询问其他客户或供货对象信息',
  unusual_large_order: '信息待核实：异常大单同时提出异常宽松付款条件',
  identity_conflict: '信息待核实：自述身份或所在地前后矛盾',
};

const GREEN_FLAG_LABELS: Record<string, string> = {
  describes_business: '已主动介绍自身业务',
  shares_company_info: '已提供公司、官网或社媒信息',
  executable_logistics: '已讨论物流、清关或付款等执行问题',
  aftersales_interest: '已询问售后、退换或质保安排',
  content_source: '看过视频或内容后发起咨询',
  willing_to_call: '愿意通话进一步确认需求',
};

function unique(values: string[], limit = 12): string[] {
  return [...new Set(values.filter(Boolean))].slice(-limit);
}

function statusForScore(score: number): BantStatus {
  if (score >= 15) return 'confirmed';
  if (score !== 0) return 'partial';
  return 'unknown';
}

function dimension(signals: ScoreSignal[]): BantDimension {
  const hits = signals.filter(signal => signal.matched);
  const score = Math.min(25, hits.reduce((sum, signal) => sum + signal.points, 0));
  return {
    score,
    status: statusForScore(score),
    evidence: unique(hits.map(signal => signal.evidence)),
    signalPoints: Object.fromEntries(hits.map(signal => [signal.key, signal.points])),
  };
}

function mergeDimension(current: BantDimension, previous: BantDimension | undefined, allowDecrease: boolean): BantDimension {
  if (!previous) return current;
  const evidence = unique([...previous.evidence, ...current.evidence]);
  if (previous.signalPoints && Object.keys(previous.signalPoints).length) {
    const signalPoints = { ...previous.signalPoints, ...current.signalPoints };
    const score = Math.min(25, Object.values(signalPoints).reduce((sum, points) => sum + points, 0));
    return { score, status: statusForScore(score), evidence, signalPoints };
  }
  if (allowDecrease) {
    const deductions = Object.values(current.signalPoints ?? {}).filter(points => points < 0).reduce((sum, points) => sum + points, 0);
    if (deductions < 0) {
      const score = Math.min(25, previous.score + deductions);
      return { score, status: statusForScore(score), evidence, signalPoints: current.signalPoints };
    }
  }
  if (allowDecrease || current.score >= previous.score) return { ...current, evidence };
  return { ...previous, evidence };
}

// Explicit buyer corrections veto individual historical signals without creating
// positive evidence. A zero-point marker carries that veto across incremental runs.
function correctRevokedSignals(current: BantDimension, previous: BantDimension | undefined, messages: string[], rules: { key: string; positive: RegExp; negative: RegExp; evidence: RegExp }[]): BantDimension {
  let result = current;
  for (const rule of rules) {
    let denial = -1;
    let confirmation = -1;
    messages.forEach((message, index) => {
      if (rule.negative.test(message)) denial = index;
      else if (rule.positive.test(message)) confirmation = index;
    });
    const marker = `${rule.key}_revoked`;
    const previouslyRevoked = previous?.signalPoints?.[marker] === 0;
    if (denial < 0 && !previouslyRevoked) continue;
    const revoked = denial >= confirmation && denial >= 0 || previouslyRevoked && confirmation < 0;
    const signalPoints = { ...result.signalPoints };
    delete signalPoints[marker];
    if (revoked) {
      delete signalPoints[rule.key];
      signalPoints[marker] = 0;
    }
    const evidence = revoked ? result.evidence.filter(item => !rule.evidence.test(item)) : result.evidence;
    const score = Math.min(25, Object.values(signalPoints).reduce((sum, points) => sum + points, 0));
    result = { score, status: statusForScore(score), signalPoints, evidence };
  }
  return result;
}

const CUSTOMIZATION_REVOCATION = /\b(?:no\s+(?:customi[sz]ation|customi[sz]ed\s+(?:products?|items?)|OEM|ODM|private[- ]label)|(?:do\s+not|don't|no\s+longer)\s+(?:need|want|require)\s+(?:customi[sz]ation|OEM|ODM|private[- ]label|customi[sz]ed\s+(?:products?|items?)))\b|(?:不需要|不要|无需|取消)(?:任何)?(?:定制|OEM|ODM|私标|贴牌)/i;
const SAMPLE_REVOCATION = /\b(?:no\s+samples?|(?:do\s+not|don't|no\s+longer)\s+(?:need|want|require)\s+(?:any\s+)?samples?)\b|(?:不需要|不要|无需|取消)(?:任何)?(?:样品|试样|打样)/i;
const DEADLINE_REVOCATION = /\b(?:no\s+(?:fixed\s+)?(?:delivery\s+)?deadline|(?:cancel|withdraw)(?:led)?\s+(?:the\s+)?(?:deadline|delivery deadline)|(?:deadline|delivery deadline)\s+(?:is\s+)?(?:cancelled|canceled|withdrawn)|no\s+longer\s+(?:have|need)\s+(?:a\s+)?deadline)\b|(?:取消|撤销)(?:之前的|原来(?:的)?)?(?:交期|截止日期|到货期限)|(?:没有|无需|不再有)(?:明确|固定)?(?:交期|截止日期|到货期限)/i;

function explicitLocationClaims(messages: string[]): string[] {
  return unique(messages.flatMap(message => {
    const matches = message.matchAll(/\b(?:i am|i'm|we are|our company is) (?:based |located )?in ([a-z][a-z .'-]{2,24}?)(?=[,.!?]|$|\s+(?:and|but)\s+)/gi);
    return [...matches].map(match => {
      const location = String(match[1]).trim().toLowerCase();
      if (/dubai|abu dhabi|uae|united arab emirates/.test(location)) return 'united arab emirates';
      if (/usa|u\.s\.|united states|america/.test(location)) return 'united states';
      if (/uk|u\.k\.|united kingdom|england/.test(location)) return 'united kingdom';
      return location;
    });
  }));
}

function assessAuthenticity(buyerMessages: string[], previous?: AuthenticityAssessment): AuthenticityAssessment {
  const text = buyerMessages.join(' ');
  const redKeys: string[] = [];
  const repeatedPriceOnly = buyerMessages.filter(message => PRICE_PROBE_PATTERN.test(message)).length >= 2 && !ANY_QUANTITY_PATTERN.test(text);
  if (repeatedPriceOnly) redKeys.push('price_only_no_quantity');
  if (FULL_PRICE_LIST_PATTERN.test(text)) redKeys.push('full_price_list');
  if (REFUSAL_TO_DISCLOSE_PATTERN.test(text) && !MARKET_MENTION_PATTERN.test(text)) redKeys.push('refuses_market');
  if (buyerMessages.slice(0, 3).some(message => FACTORY_PROBE_PATTERN.test(message))) redKeys.push('factory_probe');
  if (OTHER_CUSTOMERS_PATTERN.test(text)) redKeys.push('other_customers');
  if (LARGE_QUANTITY_PATTERN.test(text) && UNUSUAL_PAYMENT_PATTERN.test(text)) redKeys.push('unusual_large_order');
  if (explicitLocationClaims(buyerMessages).length >= 2 || /\b(?:actually|sorry),? (?:i am|we are) not\b|其实我不是|前面身份是假的/i.test(text)) redKeys.push('identity_conflict');

  const greenKeys: string[] = [];
  if (DESCRIBES_BUSINESS_PATTERN.test(text)) greenKeys.push('describes_business');
  if (SHARES_COMPANY_INFO_PATTERN.test(text)) greenKeys.push('shares_company_info');
  if (EXECUTABLE_LOGISTICS_PATTERN.test(text)) greenKeys.push('executable_logistics');
  if (AFTERSALES_PATTERN.test(text)) greenKeys.push('aftersales_interest');
  if (CONTENT_SOURCE_PATTERN.test(text)) greenKeys.push('content_source');
  if (CALL_WILLING_PATTERN.test(text)) greenKeys.push('willing_to_call');

  const redFlags = unique([...(previous?.redFlags ?? []), ...redKeys.map(key => RED_FLAG_LABELS[key])]);
  const greenFlags = unique([...(previous?.greenFlags ?? []), ...greenKeys.map(key => GREEN_FLAG_LABELS[key])]);
  const baseline = redFlags.length >= 3 ? 0.2 : redFlags.length >= 2 ? 0.5 : 1;
  const score = Number(Math.min(1, baseline + greenFlags.length * 0.1).toFixed(1));
  const band: AuthenticityBand = score <= 0.3 ? 'suspected_scraping' : score >= 1 ? 'verified' : 'reduced';
  return { score, band, redFlags, greenFlags };
}

export function assessBant(input: { turns: QualificationTurn[]; previous?: BantAssessment }): BantAssessment {
  const buyerMessages = input.turns.filter(turn => turn.role === 'buyer').map(turn => String(turn.text || '').trim()).filter(Boolean);
  const text = buyerMessages.join(' ');
  const priceOnly = buyerMessages.filter(message => PRICE_PROBE_PATTERN.test(message)).length >= 2 && !ANY_QUANTITY_PATTERN.test(text);
  const fullPriceList = FULL_PRICE_LIST_PATTERN.test(text);
  const identityRefusal = IDENTITY_REFUSAL_PATTERN.test(text);

  const budget = mergeDimension(dimension([
    { key: 'large_quantity', points: 20, evidence: '明确大批量采购（500 件以上或整柜）+20', matched: LARGE_QUANTITY_PATTERN.test(text) },
    { key: 'small_quantity', points: 12, evidence: '明确中小批量采购（50–499 件）+12', matched: !LARGE_QUANTITY_PATTERN.test(text) && SMALL_MEDIUM_QUANTITY_PATTERN.test(text) },
    { key: 'tier_price', points: 8, evidence: '询问阶梯价、批发价或经销价 +8', matched: TIER_PRICE_PATTERN.test(text) },
    { key: 'current_supplier', points: 10, evidence: '提到现有供应商或既有采购渠道 +10', matched: CURRENT_SUPPLIER_PATTERN.test(text) },
    { key: 'target_price', points: 12, evidence: '给出目标价或预算范围 +12', matched: TARGET_PRICE_PATTERN.test(text) },
    { key: 'price_only', points: -8, evidence: '只反复问最低价且不说数量 -8', matched: priceOnly },
    { key: 'full_price_list', points: -5, evidence: '索要全部产品完整价格表 -5', matched: fullPriceList },
  ]), input.previous?.budget, priceOnly || fullPriceList);

  let lastAuthorityDenial = -1;
  let lastAuthorityConfirmation = -1;
  buyerMessages.forEach((message, index) => {
    if (AUTHORITY_DENIAL_PATTERN.test(message)) lastAuthorityDenial = index;
    else if (SELF_OWNER_PATTERN.test(message) || DIRECT_DECIDER_PATTERN.test(message)) lastAuthorityConfirmation = index;
  });
  const previousDenied = input.previous?.authority.signalPoints?.authority_denied === 0;
  const authorityDenied = lastAuthorityDenial >= 0 && lastAuthorityDenial >= lastAuthorityConfirmation
    || previousDenied && lastAuthorityConfirmation < 0;
  // Explicit corrections supersede both historical turns and accumulated
  // scores. Later unrelated messages cannot restore revoked decision rights.
  const authorityText = lastAuthorityDenial >= 0 ? buyerMessages.slice(lastAuthorityDenial + 1).join(' ') : text;
  const authorityPrevious = lastAuthorityDenial >= 0 || previousDenied ? undefined : input.previous?.authority;
  let authority: BantDimension = authorityDenied ? {
    score: 0, status: 'unknown' as const,
    evidence: ['客户明确无采购决策权，需重新确认决策链 +0'],
    signalPoints: { authority_denied: 0 },
  } : mergeDimension(dimension([
    { key: 'owner', points: 22, evidence: '明确是老板、店主或创始人 +22', matched: OWNER_PATTERN.test(authorityText) },
    { key: 'direct_decider', points: 16, evidence: '明确负责采购或可直接决定下单 +16', matched: DIRECT_DECIDER_PATTERN.test(authorityText) },
    { key: 'business_operator', points: 16, evidence: '主动说明自己经营、经销或进口业务 +16', matched: BUSINESS_OPERATOR_PATTERN.test(authorityText) },
    { key: 'needs_approval', points: 9, evidence: '需要与合伙人、老板或团队确认 +9', matched: NEEDS_APPROVAL_PATTERN.test(authorityText) },
    { key: 'for_client', points: 5, evidence: '表示在替自己的客户询问 +5', matched: FOR_CLIENT_PATTERN.test(authorityText) },
    { key: 'company_info', points: 6, evidence: '提供公司、业务或企业邮箱信息 +6', matched: COMPANY_INFO_PATTERN.test(authorityText) },
    { key: 'formal_quote_authority', points: 10, evidence: '要求正式报价单或形式发票 +10', matched: FORMAL_QUOTE_PATTERN.test(authorityText) },
    { key: 'customization_authority', points: 10, evidence: '提出私标或 OEM，体现采购决策参与度 +10', matched: CUSTOMIZATION_PATTERN.test(authorityText) },
    { key: 'identity_refusal', points: -5, evidence: '拒绝说明身份或采购用途 -5', matched: identityRefusal },
  ]), authorityPrevious, identityRefusal);

  let need = mergeDimension(dimension([
    { key: 'exact_product', points: 15, evidence: '指明具体产品、货号或视频中的款式 +15', matched: EXACT_PRODUCT_PATTERN.test(text) },
    { key: 'specification', points: 20, evidence: '给出成分、容量、材质或包装等规格 +20', matched: SPEC_PATTERN.test(text) },
    { key: 'target_market', points: 10, evidence: '说明目标市场或销售国家 +10', matched: TARGET_MARKET_PATTERN.test(text) },
    { key: 'use_scenario', points: 10, evidence: '说明门店、诊所、经销或电商等销售场景 +10', matched: USE_SCENARIO_PATTERN.test(text) },
    { key: 'customization', points: 18, evidence: '提出私标、OEM、Logo 或包装定制 +18', matched: CUSTOMIZATION_PATTERN.test(text) },
    { key: 'generic_catalog', points: 3, evidence: '仅泛泛索要目录或产品清单 +3', matched: GENERIC_CATALOG_PATTERN.test(text) },
    { key: 'sample', points: 10, evidence: '主动索要样品或试样 +10', matched: SAMPLE_REQUEST_PATTERN.test(text) },
  ]), input.previous?.need, false);

  let timing = mergeDimension(dimension([
    { key: 'deadline', points: 22, evidence: '给出到货、上市或项目截止时间 +22', matched: DEADLINE_PATTERN.test(text) },
    { key: 'urgent', points: 16, evidence: '明确表示紧急或需要尽快处理 +16', matched: URGENT_PATTERN.test(text) },
    { key: 'season', points: 12, evidence: '采购与节庆、旺季或销售季相关 +12', matched: SEASON_PATTERN.test(text) },
    { key: 'restock', points: 15, evidence: '表示补货、返单或复购 +15', matched: RESTOCK_PATTERN.test(text) },
    { key: 'research', points: 6, evidence: '仍在比较供应商或调研阶段 +6', matched: RESEARCH_PATTERN.test(text) },
    { key: 'next_year', points: 3, evidence: '只表示可能明年再采购 +3', matched: NEXT_YEAR_PATTERN.test(text) },
    { key: 'formal_quote', points: 16, evidence: '要求正式报价单或形式发票 +16', matched: FORMAL_QUOTE_PATTERN.test(text) },
    { key: 'sample', points: 10, evidence: '推进到索要样品或试样 +10', matched: SAMPLE_REQUEST_PATTERN.test(text) },
    { key: 'purchase_intent', points: 20, evidence: '明确表达购买或继续下单意向 +20', matched: PURCHASE_INTENT_PATTERN.test(text) },
  ]), input.previous?.timing, false);

  authority = correctRevokedSignals(authority, input.previous?.authority, buyerMessages, [
    { key: 'customization_authority', positive: CUSTOMIZATION_PATTERN, negative: CUSTOMIZATION_REVOCATION, evidence: /提出私标或 OEM/ },
  ]);
  need = correctRevokedSignals(need, input.previous?.need, buyerMessages, [
    { key: 'customization', positive: CUSTOMIZATION_PATTERN, negative: CUSTOMIZATION_REVOCATION, evidence: /提出私标、OEM/ },
    { key: 'sample', positive: SAMPLE_REQUEST_PATTERN, negative: SAMPLE_REVOCATION, evidence: /主动索要样品/ },
  ]);
  timing = correctRevokedSignals(timing, input.previous?.timing, buyerMessages, [
    { key: 'sample', positive: SAMPLE_REQUEST_PATTERN, negative: SAMPLE_REVOCATION, evidence: /推进到索要样品/ },
    { key: 'deadline', positive: DEADLINE_PATTERN, negative: DEADLINE_REVOCATION, evidence: /给出到货、上市或项目截止时间/ },
  ]);

  const rawTotal = Math.max(0, budget.score + authority.score + need.score + timing.score);
  const authenticity = assessAuthenticity(buyerMessages, input.previous?.authenticity);
  const total = Math.max(0, Math.round(rawTotal * authenticity.score));
  const completeness = [budget, authority, need, timing].filter(item => item.status !== 'unknown').length;
  const band: QualificationBand = authenticity.band === 'suspected_scraping'
    ? 'black'
    : total >= 75 ? 'red' : total >= 50 ? 'yellow' : total >= 25 ? 'blue' : 'white';
  return {
    budget,
    authority,
    need,
    timing,
    rawTotal,
    authenticity,
    total,
    band,
    completeness,
    level: total >= 75 ? 'hot' : total >= 50 ? 'qualified' : 'early',
    evidence: unique([
      ...budget.evidence.map(item => `B：${item}`),
      ...authority.evidence.map(item => `A：${item}`),
      ...need.evidence.map(item => `N：${item}`),
      ...timing.evidence.map(item => `T：${item}`),
      ...authenticity.redFlags,
      ...authenticity.greenFlags,
    ], 32),
    updatedAt: new Date().toISOString(),
  };
}

function normalizedLanguage(value: unknown): 'zh' | 'es' | 'ar' | 'en' {
  const language = String(value || '').toLowerCase();
  if (/中文|chinese|zh/.test(language)) return 'zh';
  if (/西语|spanish|español|\bes\b/.test(language)) return 'es';
  if (/阿语|arabic|العربية|\bar\b/.test(language)) return 'ar';
  return 'en';
}

const GOALS: Record<BantKey, { label: string; reason: string; questions: Record<'zh' | 'es' | 'ar' | 'en', string> }> = {
  need: {
    label: '明确真实需求',
    reason: '先确认使用场景和优先需求，避免过早报价。',
    questions: {
      zh: '您现在最想解决的是选品、包装，还是交付时间？',
      en: 'What matters most right now: product fit, packaging, or timing?',
      es: '¿Qué importa más ahora: el producto, el empaque o el plazo?',
      ar: 'ما الأهم الآن: المنتج أم التغليف أم الوقت؟',
    },
  },
  timing: {
    label: '确认采购时间',
    reason: '用业务节点判断紧迫度，不直接逼问下单日期。',
    questions: {
      zh: '这批货是配合旺季、补货，还是新项目上线？',
      en: 'Is this for seasonal demand, restocking, or a new launch?',
      es: '¿Es para temporada alta, reposición o un nuevo lanzamiento?',
      ar: 'هل هذه الكمية للموسم أم لإعادة التخزين أم لإطلاق جديد؟',
    },
  },
  authority: {
    label: '识别决策链',
    reason: '了解谁参与确认，便于准备合适的决策资料。',
    questions: {
      zh: '除了您之外，还有谁会一起确认产品和采购条件？',
      en: 'Who else will review the product and purchase terms with you?',
      es: '¿Quién más revisará contigo el producto y las condiciones de compra?',
      ar: 'من سيشاركك مراجعة المنتج وشروط الشراء؟',
    },
  },
  budget: {
    label: '判断预算适配',
    reason: '从既有采购习惯判断预算，不生硬追问数字。',
    questions: {
      zh: '您之前采购类似产品时，更看重单价还是整体到岸成本？',
      en: 'For similar orders, do you focus more on unit price or landed cost?',
      es: 'En pedidos similares, ¿priorizas el precio unitario o el costo puesto en destino?',
      ar: 'في الطلبات المشابهة، هل تركز أكثر على سعر الوحدة أم التكلفة بعد الوصول؟',
    },
  },
};

export function selectProgressionGoal(bant: BantAssessment, language: unknown): ProgressionGoal {
  const order: BantKey[] = ['need', 'timing', 'authority', 'budget'];
  const dimension = order
    .map(key => ({ key, score: bant[key].score }))
    .sort((left, right) => left.score - right.score || order.indexOf(left.key) - order.indexOf(right.key))[0].key;
  const goal = GOALS[dimension];
  return {
    dimension,
    label: goal.label,
    reason: goal.reason,
    question: goal.questions[normalizedLanguage(language)],
    questionStyle: 'spin_indirect',
    updatedAt: new Date().toISOString(),
  };
}
