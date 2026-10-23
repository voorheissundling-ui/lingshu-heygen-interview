import type { ActionRisk } from '../autonomy/actionRules.js';

export interface SalesAction {
  id: string;
  scenario: string;
  signals: string[];
  bantImpact: string[];
  goal: string;
  actions: string[];
  talk: string[][];
  risk: ActionRisk;
  escalate?: string;
}

export interface SalesActionMatchInput {
  message: string;
  firstTurn?: boolean;
  stage?: string;
  knowledgeMiss?: boolean;
  productAvailable?: boolean;
  redFlagCount?: number;
  fallbackCount?: number;
  sentiment?: string;
}

function action(
  id: string,
  scenario: string,
  signals: string[],
  goal: string,
  actions: string[],
  talk: string[] | string[][],
  risk: ActionRisk,
  escalate = '',
  bantImpact: string[] = [],
): SalesAction {
  const variants = Array.isArray(talk[0]) ? talk as string[][] : [talk as string[]];
  return { id, scenario, signals, bantImpact, goal, actions, talk: variants, risk, escalate };
}

// 与《灵小枢销售体系》逐项对应。talk 的每个内层数组是一组可分条发送的短消息。
export const SALES_ACTION_LIBRARY: readonly SalesAction[] = [
  action('A01', '首次接触·纯问候', ['hi', 'hello', 'salam', '你好'], '拿到品类或市场', ['热情简短回应', '只问一个开放问题', '不介绍公司、不推产品'], ['Hi! 😊', 'What are you looking for?'], 'L3'),
  action('A02', '首次接触·带明确需求', ['首条明确产品', '首条明确数量'], '确认规格和市场', ['先确认收到需求', '只问一个关键细节'], ['Got it 👍', 'Which market are you selling to?'], 'L3', '数量超阈值时转人工', ['N +15', 'B 视数量']),
  action('A03', '泛泛索要目录/价格表', ['send catalog', 'price list', '目录', '价格表'], '把泛问变成具体需求', ['不给完整价格表', '先给分类', '只问需要哪一类'], ['We have skincare, masks, sunscreen and body care.', "Which category do you need? I'll send the right one 🙂"], 'L2', '3轮仍拒绝说明需求时只给公开资料', ['N +3', '坚持拒答触发红旗']),
  action('A04', '客户自我介绍生意', ['our shop', 'our company', 'we distribute', '我们公司', '我们店'], '建立关系并顺势探需求', ['先回应客户的生意', '再问一个S类问题'], ['Sounds like a solid business 👍', 'Which line sells best for you now?'], 'L3', '', ['A +16', '真实性 +0.1']),

  action('B01', '询问具体产品', ['sku', 'model', 'that product', '具体产品', '货号', '型号'], '确认规格并引出数量', ['只用知识库中的准确信息', '不主动报价', '只问数量'], ['Yes, I know the one you mean.', 'How many are you thinking?'], 'L3'),
  action('B02', '询问不存在的产品', ['产品库无货', 'not in product library'], '如实转到有货品类', ['明确说没有', '给知识库中真实存在的替代方向', '绝不编造有货'], ["We don't carry those, sorry 🙏", 'Want to see the closest options we do have?'], 'L2'),
  action('B03', '询问产品成分/参数/功效', ['ingredients', 'how it works', 'benefit', '成分', '参数', '功效'], '给事实且不做医疗宣称', ['只说知识库成分与规格', '不做疗效承诺'], ['I can share the confirmed ingredients and specs.', 'Which detail do you need?'], 'L4', '要求医疗或药效背书时立即转人工'),
  action('B04', '要求发图片/视频/资料', ['send photos', 'send video', 'send catalog', '发图片', '发视频', '发资料'], '满足资料需求并顺势推进', ['发送已审批资料', '附一个推进问题'], ['Sending the available files now 📦', 'Tell me which one you like.'], 'L3'),

  action('C01', '直接问价', ['how much', 'price', '多少钱', '价格'], '先拿数量再谈价', ['AI不报批发价', '说明价格随数量变化', '只问数量'], ['Price depends on quantity 🙂', "How many do you need? I'll get sales to quote it."], 'L4', '客户给出数量并要报价时转人工'),
  action('C02', '客户说太贵', ['too expensive', 'high price', '太贵', '价格高'], '不立即让价，转到价值和数量', ['先认可感受', '不擅自降价', '只问比较口径'], ['I hear you 🙂', 'Are you comparing the same quality and package?'], 'L4', '要求具体折扣数字时转人工'),
  action('C03', '客户用同行低价压价', ['another supplier', 'competitor price', '另一家报价', '同行低价'], '不贬低同行，引出隐性成本', ['先认可', '让客户核对报价包含项', '不承诺对比让价'], ["That's a good price 👍", 'Does it include the documents and packaging you need?'], 'L4', '需要对比让价时转人工'),
  action('C04', '临下单索要折扣', ['discount before order', 'best discount', '下单前折扣', '再便宜点'], '守住价格并把成交机会交给人工', ['不擅自给折扣', '标记高意向'], ['Let me see what I can do for this order.'], 'L4', '立即转人工'),
  action('C05', '要求完整报价单或PI', ['send quotation', 'proforma invoice', 'send pi', '正式报价单', '形式发票'], '收齐开单信息并交人工', ['收集品类、数量、规格和收货国', '不由AI生成正式报价'], ['Sure 👍', 'Send me the items and quantities so I can get the quote prepared.'], 'L4', '必转人工', ['T +16', 'A +10']),

  action('D01', '质疑品质或第一次从中国进货', ['how do i know quality', 'first time buying from china', '质量可靠吗', '第一次从中国采购'], '用可验证凭据降低风险感', ['只引用知识库真实凭据', '可以提出样品验证', '知识库没有的认证不提'], ['Totally fair question 🙂', 'Want to verify it with a sample first?'], 'L2', '要求认证原件或编号核验时转人工'),
  action('D02', '索要知识库未覆盖的认证文件', ['gmp', 'iso', 'coa', 'lab report', '认证文件', '检测报告'], '不撒谎且不丢客户', ['不承诺拥有文件', '说明需要核验', '记录知识库缺口'], ['Let me confirm exactly which documents are available.', 'I’m passing this to the team to verify.'], 'L4', '必转人工并标记知识库补充'),
  action('D03', '怀疑证书造假', ['fake certificate', 'fake document', '假证', '证书造假'], '共情并交人工核验', ['不辩解', '不承诺真伪', '让负责人提供可核验资料'], ['You’re right to be careful.', 'Let me match the document to this product before I confirm anything.'], 'L4', '必转人工'),
  action('D04', '询问工厂或公司实力', ['factory or trading', 'how big is your company', '工厂还是贸易', '公司实力'], '按知识库如实回答并判断是否同行', ['只给知识库和公开信息', '多条红旗时限制信息深度'], ['I can share the verified company information.', 'What part matters most for your check?'], 'L2', '追问工厂地址或产线细节时红旗+1并转人工'),

  action('E01', '索要样品', ['sample', '样品'], '促成样品单', ['只给知识库中的样品政策', '问想测试哪一款'], ['Samples are available when the policy allows 👍', 'Which one do you want to try?'], 'L3', '要求免费样品或免运费时转人工', ['N +10', 'T +10']),
  action('E02', '要求免费样品', ['free sample', 'you pay shipping', '免费样品', '免运费'], '不硬拒也不擅自答应', ['说明需要人工确认', '不承诺免费或免运费'], ['Let me check the sample terms for this order 🙂'], 'L4', '转人工'),
  action('E03', '样品寄出后无反馈', ['sample delivered', 'sample follow-up', '样品寄出未回复'], '轻量唤醒并拿到反馈', ['确认是否收到', '只问一个反馈问题'], ['Hi! Did the samples arrive ok? 📦', 'Any feedback from your side?'], 'L2'),

  action('F01', '询问物流方式或时效', ['shipping', 'how long', 'delivery', '物流方式', '多久到'], '提供真实范围但不承诺日期', ['只说知识库中的常规方式', '具体交期交人工确认'], ['Exact timing depends on the order.', 'Which country and quantity should we check?'], 'L4', '要求确定到货日时转人工'),
  action('F02', '询问运费', ['shipping cost', 'freight', '运费'], '收集计算运费所需信息', ['不估算运费', '收集城市、数量和重量'], ['Freight depends on quantity and address.', 'Send me your city and quantity so I can get it checked 👍'], 'L4', '转人工计算'),
  action('F03', '询问清关税费或进口手续', ['customs', 'duty', 'import', '清关', '税费', '进口手续'], '说明资料边界，不做法律税务承诺', ['只说知识库可提供的单据', '明确当地税费由当地规则决定'], ['Duties depend on your local rules 🙂', 'Which country are you importing into?'], 'L4', '要求包税或包清关时转人工'),

  action('G01', '询问付款方式', ['payment', 'how to pay', 't/t', '付款方式'], '提供已确认的常规条款', ['仅引用知识库付款条款', '不议价、不修改条款'], ['I can share the approved payment terms.', 'Which method do you normally use?'], 'L4', '议付款比例、账期或信用证时转人工'),
  action('G02', '要求账期或先货后款', ['credit terms', 'pay after receive', '30 days credit', '账期', '先货后款'], '不答应，交人工评估', ['绝不擅自同意', '保持礼貌承接'], ['Let me check what payment terms work for this order.'], 'L4', '必转人工；大单同时异常宽松要求时触发红旗'),

  action('H01', '要求定制、私标或OEM', ['private label', 'oem', 'our logo', 'custom packaging', '贴牌', '定制包装'], '识别高意向并收集需求', ['积极承接', '一次只问定制内容、数量、市场或时间中的一个', '不承诺可行性、价格和周期'], ['Got it — you need private label 👍', 'What do you want on the packaging?'], 'L4', '立即转人工', ['N +18', 'A +10']),
  action('H02', '要求独家代理', ['exclusive', 'sole distributor', '独家代理', '总代'], '收集市场覆盖并交负责人', ['只表达兴趣', '不做独家承诺'], ["That's interesting 🙂", 'Tell me about your market coverage.'], 'L4', '立即转人工并即时通知'),

  action('I01', '客户表达购买意向', ['i want to order', "let's proceed", 'ready to order', '我要下单', '继续下单'], '锁定细节并交人工开单', ['确认品项、数量和收货信息', '不由AI开单'], ['Great! 🎉', 'Send me the items, quantities and delivery country, and I’ll take it from there.'], 'L4', '转人工', ['T +20']),
  action('I02', '客户犹豫不决', ['let me think', "i'll consider", '考虑一下', '再想想'], '降低决策门槛且不施压', ['给样品或小单选项', '给客户留出口'], ['Sure, take your time 🙂', 'A small trial may be easier if you want.'], 'L2'),
  action('I03', '客户要求简化流程', ["don't want a long process", 'keep it simple', '流程太长', '简单一点'], '只给一个明确动作', ['回复不能用列表', '只说下一步的一件事'], ["Got it — let's keep it simple 👍", 'Just send the quantity.'], 'L2'),
  action('I04', '客户要求总结已确认内容', ['summarize', 'confirm what we discussed', '总结一下', '确认聊过的内容'], '准确复述已确认内容', ['只从timeline提取', '分条短消息', '不遗漏、不添加'], ['Sure 👍', 'I’ll recap only what we confirmed.', 'Anything to add?'], 'L2'),

  action('J01', '报价后已读不回', ['quoted silence', '报价后未回复'], '带价值重新触达', ['提供真实的新信息', '不空催'], ['Quick update — there may be something useful for your order 📦', 'Still interested?'], 'L2'),
  action('J02', '长期沉默30或60天', ['silent30', 'silent60'], '低频个性化唤醒', ['结合历史采购', '超24小时窗口使用模板', '30天不超过2次'], ["Hi, it's been a while 🙂", 'Want to see options related to your last order?'], 'L2'),
  action('J03', '客户说以后再联系', ['maybe later', 'next season', '以后联系', '下个季节'], '接受并约定下次联系节点', ['写入跟进任务', '不施压'], ['No problem 👍', 'Should I check back before your season starts?'], 'L1'),

  action('K01', '老客户回来', ['stage won', 'repeat customer', '老客户回来'], '体现记忆并顺势推进', ['引用历史采购', '不重新自我介绍'], ['Welcome back! 🎉', 'Same item as last time, or something new?'], 'L2'),
  action('K02', '客户反馈销售情况好', ['sold well', 'customers like it', '卖得很好', '客户喜欢'], '趁热推进复购或扩品', ['先祝贺', '只问一个关联品问题'], ["That's great to hear! 🙌", 'Want to add a related item this time?'], 'L2'),
  action('K03', '售后问题或质量投诉', ['damaged', 'wrong item', 'complaint', 'refund', '破损', '发错', '投诉', '退款'], '共情、收集证据并立即交人工', ['不认责、不承诺赔偿', '只收集订单号和照片'], ["I'm sorry to hear that 😔", 'Can you send the order number and photos?'], 'L4', '立即human_needed并即时通知'),

  action('L01', '客户要求通话或视频', ['call', 'voice', 'video call', 'speak to manager', '通话', '视频聊'], '停止自动回复并约时间', ['挂起自动回复', '只问方便时间', '创建通话任务'], ['Of course! 📞', 'What time works for you?'], 'L4', '立即转人工、创建通话任务并即时通知', ['真实性 +0.1']),
  action('L02', '疑似同行套价', ['two red flags', '疑似套价'], '礼貌但限制信息深度', ['只给公开信息', '不报价、不发详细规格、不透露客户信息'], ['We cover the public product categories 🙂', 'For pricing I need your quantity and market.'], 'L2', '标记提醒负责人，不主动断联'),
  action('L03', '疑似诈骗', ['unusual large order', 'ship first', 'identity conflict', '异常大单', '先发货', '身份矛盾'], '停止推进并交人工判断', ['不承诺任何条款', '礼貌转交负责人'], ['I need to verify a few details before we go further.'], 'L4', '转人工并标记信息待核实'),
  action('L04', '情绪激动或辱骂', ['angry', 'swearing', '辱骂', '情绪激动'], '一句共情后立即转人工', ['不辩解', '不连续追问'], ["I'm sorry this got frustrating.", 'Give me a moment and I’ll look into it.'], 'L4', '立即human_needed'),
  action('L05', '知识库完全未覆盖', ['knowledgeMiss', 'unknown question'], '不编造且不丢客户', ['先问一个贴合当前问题的具体问题', '人工接管只在系统内部发生', '不得向客户解释队列、团队或转交流程'], [
    ['Which part do you want to pin down first?'],
    ['Can you tell me a little more about what you need?'],
    ['What exactly do you need this to do?'],
  ], 'L2', '同会话兜底达到2次时强制转人工'),
];

const MATCHERS: Record<string, (input: SalesActionMatchInput) => boolean> = {
  A01: input => Boolean(input.firstTurn) && /^(?:hi|hello|hey|salam|你好|您好)[!！,.，。\s😊🙂👋]*$/i.test(input.message),
  A02: input => Boolean(input.firstTurn) && /\b(?:need|looking for|interested in|want)\b|需要|寻找|想要/i.test(input.message) && /\b(?:pcs?|pieces?|units?|serums?|masks?|sunscreens?|products?)\b|件|个|精华|面膜|防晒|产品/i.test(input.message),
  A03: input => /\b(?:send|need|want).{0,24}(?:catalog|catalogue|price list)\b|\bfull price list\b|发.{0,8}(?:目录|价格表)|完整价格表/i.test(input.message),
  A04: input => /\b(?:we are|our (?:shop|company|business|store)|i own|i run|we distribute)\b|我们(?:是|公司|店)|我经营|我们经销/i.test(input.message),
  B01: input => /\b(?:sku|model|that (?:one|product)|collagen serum|face mask|sunscreen)\b|货号|型号|那款|胶原精华|面膜|防晒/i.test(input.message),
  B02: input => input.productAvailable === false && /\b(?:do you have|have you got|carry|stock).{0,28}(?:product|item|serum|mask|cream|oil|accessor)|有没有|有.{0,12}(?:产品|款|精华|面膜|霜|油|配件)/i.test(input.message),
  B03: input => /\b(?:ingredients?|formula|specs?|how (?:does|it) work|benefits?|medical|cure|treat)\b|成分|配方|参数|功效|治疗|疗效/i.test(input.message),
  B04: input => /\b(?:send|show).{0,12}(?:photos?|pictures?|videos?|files?|catalog)\b|发.{0,8}(?:图片|照片|视频|资料|目录)/i.test(input.message),
  C01: input => /\b(?:how much|what(?:'s| is) (?:the )?price|price (?:for|of))\b|^\s*price\s*[?？]?\s*$|多少钱|什么价格|怎么卖/i.test(input.message),
  C02: input => /\b(?:too expensive|price is (?:too )?high|price(?:s)? (?:are|seem) (?:too )?high|so expensive)\b|太贵|价格太高/i.test(input.message),
  C03: input => /\b(?:another|other) supplier.{0,30}(?:offer|price|quote)|competitor.{0,20}(?:price|quote)|别家.{0,20}(?:报价|价格)|同行.{0,12}(?:低价|报价)/i.test(input.message),
  C04: input => /\b(?:ready to order|place the order|deal).{0,30}(?:discount|lower|better price)|下单.{0,18}(?:折扣|便宜|优惠)|成交前.{0,12}(?:折扣|优惠)/i.test(input.message),
  C05: input => /\b(?:send|prepare|need).{0,12}(?:quotation|proforma invoice|pi)\b|正式报价单|形式发票|开PI/i.test(input.message),
  D01: input => /\b(?:how (?:do|can) i know.{0,12}quality|quality reliable|first time buying from china)\b|怎么保证质量|质量可靠吗|第一次从中国采购/i.test(input.message),
  D02: input => Boolean(input.knowledgeMiss) && /\b(?:gmp|iso|coa|lab report|test report|certificate)\b|认证|证书|检测报告/i.test(input.message),
  D03: input => /\b(?:fake certificate|fake document|forged certificate|supplier sent fake)\b|假证|证书造假|伪造证书/i.test(input.message),
  D04: input => /\b(?:factory or trading|are you (?:a )?factory|company size|how big)\b|工厂还是贸易|是不是工厂|公司多大|公司实力/i.test(input.message),
  E01: input => /\b(?:sample|trial sample)\b|样品|试样/i.test(input.message) && !MATCHERS.E02(input),
  E02: input => /\b(?:free sample|sample for free|you pay shipping|free shipping)\b|免费样品|样品免费|免运费/i.test(input.message),
  E03: input => /\b(?:sample (?:was |has been )?(?:arrived|delivered)|sample follow.?up)\b|样品已寄|样品签收/i.test(input.message),
  F01: input => /\b(?:shipping method|how long|delivery time|transit time|when.*arrive)\b|物流方式|多久到|运输时效|交期/i.test(input.message),
  F02: input => /\b(?:shipping cost|freight|delivery cost)\b|运费|物流费用/i.test(input.message),
  F03: input => /\b(?:customs|duty|duties|import procedure|tax)\b|清关|关税|税费|进口手续|包税/i.test(input.message),
  G01: input => /\b(?:payment method|how (?:can|do) (?:i|we) pay|t\/t|letter of credit)\b|付款方式|怎么付款|电汇|信用证/i.test(input.message),
  G02: input => /\b(?:credit terms?|pay after.{0,12}(?:receive|delivery)|net ?30|ship first)\b|账期|先货后款|货到付款|先发货/i.test(input.message),
  H01: input => /\b(?:private[- ]label|oem|odm|our logo|custom packaging|custom label)\b|私标|贴牌|代工|我们的logo|定制包装/i.test(input.message),
  H02: input => /\b(?:exclusive|sole distributor|exclusive agent)\b|独家代理|独家经销|总代/i.test(input.message),
  I01: input => /\b(?:i want to order|let'?s proceed|ready to order|place the order)\b|我要下单|开始下单|继续推进/i.test(input.message),
  I02: input => /\b(?:let me think|i(?:'ll| will) consider|need to think)\b|考虑一下|再想想|犹豫/i.test(input.message),
  I03: input => /\b(?:don'?t want (?:a )?long process|keep it simple|too much back and forth)\b|流程太长|简单一点|不要来回沟通/i.test(input.message),
  I04: input => /\b(?:summari[sz]e|recap|confirm what we discussed)\b|总结一下|复述一下|确认聊过的内容/i.test(input.message),
  J01: input => input.stage === 'quoted' && /\b(?:follow.?up|checking in)\b|报价后未回复/i.test(input.message),
  J02: input => input.stage === 'silent30' || input.stage === 'silent60',
  J03: input => /\b(?:maybe later|next season|contact you later|not now)\b|以后联系|下个季节|以后再说/i.test(input.message),
  K01: input => input.stage === 'won',
  K02: input => /\b(?:sold well|selling well|customers? (?:like|love) it)\b|卖得很好|客户很喜欢|销售不错/i.test(input.message),
  K03: input => /\b(?:damaged|wrong item|complaint|refund|defect|bad quality)\b|破损|发错|投诉|退款|质量问题/i.test(input.message),
  L01: input => /\b(?:call me|can we (?:call|talk)|video call|voice call|speak to (?:a )?manager)\b|打电话|通话|视频聊|找经理/i.test(input.message),
  L02: input => (input.redFlagCount ?? 0) >= 2,
  L03: input => /\b(?:ship first|pay after delivery|overpay|refund the difference)\b|先发货|货到付款|多付.{0,8}退回/i.test(input.message) || (input.redFlagCount ?? 0) >= 3,
  L04: input => input.sentiment === 'negative' || /\b(?:fuck|shit|idiot|stupid|angry|furious)\b|滚|骗子|垃圾|混蛋|愤怒/i.test(input.message),
  L05: input => Boolean(input.knowledgeMiss),
};

export function matchesSalesAction(id: string, input: SalesActionMatchInput): boolean {
  return MATCHERS[id]?.({ ...input, message: String(input.message || '') }) ?? false;
}

export function matchSalesActions(input: SalesActionMatchInput): SalesAction[] {
  const matches = SALES_ACTION_LIBRARY.filter(item => matchesSalesAction(item.id, input));
  return matches.sort((left, right) => {
    const risk = { L4: 4, L3: 3, L2: 2, L1: 1 };
    return risk[right.risk] - risk[left.risk] || left.id.localeCompare(right.id);
  });
}

export function salesActionById(id: string): SalesAction | undefined {
  return SALES_ACTION_LIBRARY.find(item => item.id === id);
}

const ALWAYS_ESCALATE = new Set(['C04', 'C05', 'D02', 'D03', 'E02', 'F02', 'G02', 'H01', 'H02', 'I01', 'K03', 'L01', 'L03', 'L04']);

export function shouldEscalateSalesAction(item: SalesAction, message: string): boolean {
  const value = String(message || '');
  if (ALWAYS_ESCALATE.has(item.id)) return true;
  if (item.id === 'B03') return /\b(?:medical|clinical|cures?|treats?|heals?|drug effect|guarantee results?)\b|医疗|临床|治愈|治疗|药效|保证效果/i.test(value);
  if (item.id === 'C01') return ANY_QUANTITY_FOR_ESCALATION.test(value);
  if (item.id === 'C02') return /\b(?:discount|reduce|lower).{0,12}(?:\d+\s*%|to\s*[$€£¥]?\d)|便宜.{0,8}\d|折扣.{0,8}\d/i.test(value);
  if (item.id === 'C03') return /\b(?:match|beat|lower than).{0,20}(?:price|quote)|按.{0,8}(?:同行|对方).{0,8}(?:价格|报价)|比.{0,8}(?:同行|对方).{0,8}低/i.test(value);
  if (item.id === 'F01') return /\b(?:guarantee|confirm|exact).{0,18}(?:arrival|delivery|date)|确定到货日|保证.{0,8}(?:到货|交期)/i.test(value);
  if (item.id === 'F03') return /\b(?:include|cover|handle).{0,12}(?:duty|customs|tax)|包税|包清关/i.test(value);
  if (item.id === 'G01') return /\b(?:change|reduce|negotiate).{0,12}(?:deposit|payment)|letter of credit|credit terms|修改.{0,8}(?:定金|付款)|调整.{0,8}(?:比例|条款)|信用证|账期/i.test(value);
  return false;
}

const ANY_QUANTITY_FOR_ESCALATION = /\b\d[\d,]*\s*(?:pcs?|pieces?|units?|sets?|cartons?|containers?|bottles?|boxes?)\b|\d+\s*(?:件|个|套|箱|瓶|盒|柜)/i;

export const L4_SALES_ACTION_IDS = SALES_ACTION_LIBRARY.filter(item => item.risk === 'L4').map(item => item.id);
