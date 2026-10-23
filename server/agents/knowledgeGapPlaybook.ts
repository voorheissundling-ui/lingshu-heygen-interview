import { chooseNonRepeatedIndex, type TimelineLike } from '../lib/nonRepeatingReply.js';

export type KnowledgeGapScenario =
  | 'after_sale_complaint'
  | 'call_request'
  | 'delivery_commitment'
  | 'product_discovery'
  | 'product_availability'
  | 'quality_or_certification'
  | 'competitor_comparison'
  | 'customization_or_packaging'
  | 'urgent_next_step'
  | 'order_or_logistics'
  | 'price_or_quote'
  | 'high_value_or_peer'
  | 'general_unknown';

export interface KnowledgeGapPlan {
  scenario: KnowledgeGapScenario;
  draft: string;
  draftZh: string;
  handoffRequired: true;
  safeToSendBeforeHandoff: true;
  handlingReason: string;
  variantCount: number;
  followUpMinutes: number;
  followUpDueAt: string;
  replyConfidence: {
    level: 'bridge_only';
    score: number;
    reason: string;
  };
}

type SupportedLanguage = 'english' | 'spanish' | 'arabic';
type ReplyPair = { draft: string; draftZh: string };

export function groundedProductNames(contextNames: string[], selectedProduct: unknown): string[] {
  const names = [...contextNames, String(selectedProduct || '')]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return Array.from(new Map(names.map(name => [name.toLocaleLowerCase(), name])).values()).slice(0, 5);
}

function naturalList(values: string[], conjunction: string): string {
  if (values.length <= 1) return values[0] || '';
  if (values.length === 2) return `${values[0]} ${conjunction} ${values[1]}`;
  return `${values.slice(0, -1).join(', ')} ${conjunction} ${values.at(-1)}`;
}

export function groundedProductDiscoveryReply(
  buyerLanguageNames: string[],
  language: unknown,
  chineseNames = buyerLanguageNames,
): ReplyPair {
  const shown = buyerLanguageNames.map(value => String(value || '').trim()).filter(Boolean).slice(0, 3);
  const shownZh = chineseNames.map(value => String(value || '').trim()).filter(Boolean).slice(0, 3);
  const languageKey = normalizeLanguage(language);
  const buyerList = naturalList(shown, languageKey === 'english' ? 'and' : languageKey === 'spanish' ? 'y' : 'و');
  const chineseList = naturalList(shownZh, '和');
  const hasMore = buyerLanguageNames.filter(value => String(value || '').trim()).length > shown.length;
  const hasMoreZh = chineseNames.filter(value => String(value || '').trim()).length > shownZh.length;
  if (languageKey === 'spanish') return {
    draft: `Trabajamos principalmente con ${buyerList}${hasMore ? ' y algunos productos más' : ''}. ¿Buscas algo de este tipo o necesitas otro producto?`,
    draftZh: `我们主要做${chineseList}${hasMoreZh ? '等产品' : ''}。您找的是这类，还是其他产品？`,
  };
  if (languageKey === 'arabic') return {
    draft: `نعمل بشكل أساسي مع ${buyerList}${hasMore ? ' ومنتجات أخرى' : ''}. هل تبحث عن شيء من هذا النوع أم عن منتج آخر؟`,
    draftZh: `我们主要做${chineseList}${hasMoreZh ? '等产品' : ''}。您找的是这类，还是其他产品？`,
  };
  return {
    draft: `We mainly carry ${buyerList}${hasMore ? ' and a few more products' : ''}. Is that what you're looking for, or do you need something else?`,
    draftZh: `我们主要做${chineseList}${hasMoreZh ? '等产品' : ''}。您找的是这类，还是其他产品？`,
  };
}

const LARGE_ORDER_PATTERN = /\b(\d[\d,]*(?:\.\d+)?)\s*(?:pcs?|pieces?|units?|sets?|bottles?|boxes?|cartons?)\b/gi;
const PEER_PATTERN = /\b(?:we are (?:also )?(?:a )?(?:supplier|factory|manufacturer|trading company)|i am (?:also )?(?:a )?(?:supplier|manufacturer|trader)|our factory|resell to other suppliers)\b|我们也是供应商|我们是工厂|我们也是厂家|同行/i;

const SCENARIO_PATTERNS: Array<{ scenario: KnowledgeGapScenario; pattern: RegExp }> = [
  {
    scenario: 'after_sale_complaint',
    pattern: /\b(?:complaint|refund|return|damaged|broken|defective|wrong item|not as described|unacceptable|very disappointed|compensation)\b|投诉|退款|退货|破损|损坏|瑕疵|发错|货不对板|无法接受|很失望|赔偿/i,
  },
  {
    scenario: 'call_request',
    pattern: /\b(?:call me|phone call|video call|can we (?:talk|call)|speak (?:by phone|on a call|to (?:a )?manager)|whatsapp call|zoom|google meet)\b|给我打电话|打个电话|视频通话|语音通话|开会聊|电话聊|找经理聊/i,
  },
  {
    scenario: 'competitor_comparison',
    pattern: /\b(?:another supplier|other supplier|competitor|offered|why should i choose|compare (?:you|your)|better than)\b|其他供应商|另一家|竞争对手|为什么选你|对比你们/i,
  },
  {
    scenario: 'delivery_commitment',
    pattern: /\b(?:(?:can you|will you|do you) guarantee.{0,24}(?:delivery|arrival|shipping|date|days?)|guaranteed? (?:delivery|arrival|shipping)|must arrive|arrive by|deliver by|ship in \d+ days?|within \d+ days?)\b|保证.*(?:到货|交付|发货)|必须.*(?:到货|交付)|\d+天内.*(?:到货|交付|发货)/i,
  },
  {
    scenario: 'quality_or_certification',
    pattern: /\b(?:quality|reliable|certificate|certification|gmp|iso|coa|lab report|test report|inspection|compliance|fake cert|standard)\b|质量|可靠|证书|认证|检测报告|验货|合规|假证/i,
  },
  {
    scenario: 'product_discovery',
    pattern: /\b(?:what (?:products? )?do you have|what do you sell|show me what you have|show me your products?|what can you offer|product range|send (?:me )?(?:your )?catalog(?:ue)?)\b|(?:¿?\s*qué productos (?:tienen|venden|ofrecen)|¿?\s*qué (?:tienen|venden|ofrecen)|qué productos hay|muéstrame (?:sus|tus) productos|envíame (?:su|tu) catálogo|catálogo de productos)|(?:ما (?:هي )?المنتجات (?:المتوفرة )?(?:لديكم|عندكم)|ما المنتجات التي لديكم|ماذا تبيعون|ما الذي تبيعونه|أرسل(?:وا)? (?:لي )?الكتالوج|اعرض(?:وا)? (?:لي )?منتجاتكم)|你们有什么|你卖什么|有什么产品|看看产品|发.{0,6}目录/iu,
  },
  {
    scenario: 'product_availability',
    pattern: /\b(?:do you have|have you got|available|in stock|what colo(?:u)?rs|which colo(?:u)?rs|what sizes|which sizes|size\s+[a-z0-9-]+|black|white|navy|beige|red|blue|green)\b|有货吗|现货|有哪些颜色|什么颜色|有哪些尺码|什么尺码|黑色|白色|藏青|米色/i,
  },
  {
    scenario: 'order_or_logistics',
    pattern: /\b(?:tracking|where is my order|order status|has it shipped|invoice|payment status|in transit|dispatch)\b|物流|运单|订单状态|发货了吗|发票|付款状态/i,
  },
  {
    scenario: 'price_or_quote',
    pattern: /\b(?:price|quote|quotation|discount|payment terms?|deposit|lead time|delivery time|unit cost|how much|moq|minimum order(?: quantity)?)\b|报价|价格|单价|多少钱|折扣|付款条款|定金|交期|起订量|最小起订量/i,
  },
  {
    scenario: 'urgent_next_step',
    pattern: /\b(?:today|end of day|right now|immediately|urgent|move this forward|what exactly do you need|no back and forth|how (?:fast|soon))\b|今天|马上|尽快|加急|怎么推进|不要来回沟通/i,
  },
  {
    scenario: 'customization_or_packaging',
    pattern: /\b(?:private[ -]?label|customi[sz]e|custom packaging|our logo|my logo|bilingual|arabic packaging|label design|packaging style|oem|odm)\b|贴牌|定制|包装|双语|阿拉伯语|徽标|商标|代工/i,
  },
];

function hasLargeOrderSignal(message: string): boolean {
  for (const match of message.matchAll(LARGE_ORDER_PATTERN)) {
    const quantity = Number(String(match[1]).replace(/,/g, ''));
    if (Number.isFinite(quantity) && quantity >= 1000) return true;
  }
  return false;
}

export function classifyKnowledgeGapScenario(message: string): KnowledgeGapScenario {
  const value = String(message || '').trim();
  for (const item of SCENARIO_PATTERNS.slice(0, 6)) {
    if (item.pattern.test(value)) return item.scenario;
  }
  if (PEER_PATTERN.test(value) || hasLargeOrderSignal(value)) return 'high_value_or_peer';
  for (const item of SCENARIO_PATTERNS.slice(6)) {
    if (item.pattern.test(value)) return item.scenario;
  }
  return 'general_unknown';
}

function normalizeLanguage(value: unknown): SupportedLanguage {
  const language = String(value || '').toLowerCase();
  if (language.includes('arabic') || language.includes('阿语') || language.includes('العربية')) return 'arabic';
  if (language.includes('spanish') || language.includes('西语') || language.includes('español')) return 'spanish';
  return 'english';
}

const HANDLING_REASON: Record<KnowledgeGapScenario, string> = {
  after_sale_complaint: '客户正在投诉或要求退款，需要负责人立即接管并核对订单证据',
  call_request: '客户希望电话或视频沟通，需要人工确认可用时间并接管',
  delivery_commitment: '客户要求保证交付时间，需要人工核实生产与物流后确认',
  product_discovery: '客户正在了解可选产品，需要结合已录入的产品资料推荐；资料不足时先了解采购方向',
  product_availability: '客户正在确认颜色、尺码或库存，需要核对当前产品资料与实时可用状态',
  quality_or_certification: '客户在确认质量或资质真实性，需要人工核验真实文件',
  competitor_comparison: '客户正在比较供应商条件，需要销售确认同口径方案',
  customization_or_packaging: '客户提出定制或包装需求，需要确认真实可执行范围',
  urgent_next_step: '客户希望快速推进，需要负责人确认下一步与时间',
  order_or_logistics: '客户在查询订单、物流或付款状态，需要人工核对真实记录',
  price_or_quote: '客户正在询价或确认交易条件，需要销售人工报价',
  high_value_or_peer: '疑似大单或同行客户，需要销售负责人判断并接管',
  general_unknown: '客户问题超出企业知识库，需要先澄清关键点，重复出现时转人工确认',
};

const ENGLISH: Record<KnowledgeGapScenario, ReplyPair[]> = {
  after_sale_complaint: [
    { draft: "I'm sorry this happened. Send me the order number and a couple of clear photos, and I'll look into it straight away.", draftZh: '很抱歉出了这个问题。把订单号和两张清楚的照片发给我，我马上核查。' },
    { draft: "I can see why you're upset. Send me the order number and photos of the problem, and I'll take it from there.", draftZh: '我明白您为什么生气。把订单号和问题照片发给我，后面我来跟进。' },
    { draft: "That's not how this should have arrived. Send me the order number and clear photos so I can look into it right away.", draftZh: '货物不该是这样到手的。把订单号和清楚的照片发给我，我马上核查。' },
  ],
  call_request: [
    { draft: "Sure, let's talk. What time works for you today?", draftZh: '可以，我们电话聊。您今天什么时间方便？' },
    { draft: 'Yes, a call is easier. What time works for you?', draftZh: '可以，电话聊更方便。您什么时间合适？' },
    { draft: 'No problem. Tell me your time zone and a good time to call.', draftZh: '没问题。请告诉我您的时区和方便通话的时间。' },
  ],
  delivery_commitment: [
    { draft: 'Let me confirm the production and shipping time before I give you a date.', draftZh: '我先核对生产和运输时间，再给您确认日期。' },
    { draft: 'That date matters. Let me check the actual timing and come back to you here.', draftZh: '这个日期很重要。我先核对实际时间，确认后就在这里回复您。' },
    { draft: 'Let me check whether that date works for this order first.', draftZh: '我先核对一下这笔订单能不能按这个日期交付。' },
  ],
  product_discovery: [
    { draft: "What kind of product are you looking for? Send me a photo or the product name and I'll show you the closest options.", draftZh: '您想找哪类产品？发一张图片或产品名称给我，我按这个方向给您找合适的。' },
    { draft: "What are you buying for—your shop, online sales, or a specific order? That'll help me show you the right products.", draftZh: '您是给门店、线上销售，还是某个具体订单找产品？我好按用途给您推荐。' },
    { draft: 'Tell me what you are looking for and roughly how many you need, and I can narrow it down for you.', draftZh: '告诉我您想找什么、大概需要多少，我就能帮您把范围缩小。' },
  ],
  product_availability: [
    { draft: "Which item do you mean? Send me the photo or product name and I'll check the available options.", draftZh: '您指的是哪一款？把图片或产品名称发给我，我帮您看现有哪些选项。' },
    { draft: "Send me the product photo or name and I'll check what's available.", draftZh: '把产品图片或名称发给我，我帮您看现有选项。' },
    { draft: 'Got it. Let me check the current options for this one.', draftZh: '明白，我查一下这款现在有哪些选项。' },
  ],
  quality_or_certification: [
    { draft: "You're right to check. Let me match the certificate to this product before I confirm anything.", draftZh: '您要核实是对的。我先确认这份证书和产品是否对应，再给您答复。' },
    { draft: "Fair question. Let's check the actual document and certificate number for this product.", draftZh: '这个问题很合理。我们直接核对这款产品对应的文件和证书编号。' },
    { draft: "I get why you're careful. Let me verify the actual document before I answer.", draftZh: '我明白您为什么谨慎。我先核实真实文件，再回复您。' },
  ],
  competitor_comparison: [
    { draft: "That's worth comparing. Let's check what's actually included, not only the headline number.", draftZh: '这个报价值得比较。我们先看清实际包含哪些内容，不只看表面的数字。' },
    { draft: "300 pcs and 10 days sounds attractive. Let's check whether the packaging, documents and delivery terms are really the same.", draftZh: '300 件和 10 天确实有吸引力。我们先确认包装、文件和交付条件是不是完全相同。' },
    { draft: 'It looks good on the surface. Let me compare the full scope so you can see the real difference.', draftZh: '表面看确实不错。我把完整条件对一下，您就能看清真正的差别。' },
  ],
  customization_or_packaging: [
    { draft: "Got it—your label, with both languages on the pack. Send me the logo or a pack you like and I'll check it 👍", draftZh: '明白，要用您的品牌，包装上放两种语言。把 Logo 或喜欢的包装参考发来，我帮您看。' },
    { draft: "I see the look you're after. Drop the logo and a packaging reference here and I'll take it from there 👍", draftZh: '我明白您想要的效果。把 Logo 和包装参考发在这里，后面我来跟进。' },
    { draft: "Private label, got it. Send the logo or a pack you like and I'll check what works 👍", draftZh: '明白，您要做贴牌。把 Logo 或喜欢的包装参考发来，我帮您确认怎么做合适。' },
  ],
  urgent_next_step: [
    { draft: "Got it—you want this simple. I've kept everything you already sent, so just add anything that's still missing and I'll sort out the next step.", draftZh: '明白，您想简单推进。我已经记下您发过的信息，只需补充还缺的内容，下一步我来处理。' },
    { draft: "Let's keep it simple. I have what you've already shared; just add any missing deadline or packaging reference.", draftZh: '我们简单推进。我已经记下您说过的信息，只需补充还没提到的截止时间或包装参考。' },
    { draft: "Got it. I have the details above, so you won't need to repeat anything.", draftZh: '明白，上面的信息我都记下了，您不用再重复。' },
  ],
  order_or_logistics: [
    { draft: "Send me the order number and I'll check what's happening.", draftZh: '把订单号发给我，我查一下现在是什么情况。' },
    { draft: "Let me check the order itself. What's the order number?", draftZh: '我直接核对订单。订单号是多少？' },
    { draft: "Drop the order number here and I'll look into it.", draftZh: '把订单号发在这里，我来核查。' },
  ],
  price_or_quote: [
    { draft: "Let me work out the exact quote from the details you've sent. If any spec or packaging detail is still missing, add it here.", draftZh: '我按您发来的信息核算准确报价。如果还有没提到的规格或包装细节，请在这里补充。' },
    { draft: "Got it. I have the details above—let me work out the quote for this order.", draftZh: '明白，上面的信息我已经记下。我来核算这笔订单的报价。' },
    { draft: 'Let me check the proper quote. You only need to add anything that is still missing.', draftZh: '我来核算正式报价。您只需要补充还没提到的内容。' },
  ],
  high_value_or_peer: [
    { draft: "That's a serious volume. Let me go through the details you've sent and work out the next step.", draftZh: '这个数量需要认真跟进。我先把您发来的信息过一遍，再确认下一步。' },
    { draft: 'Got it—this needs a proper commercial review. I have the details above and will take it from here.', draftZh: '明白，这需要认真做商务评估。上面的信息我已经记下，后面我来跟进。' },
    { draft: "This is worth handling properly. I've kept your full brief, so you won't need to repeat it.", draftZh: '这条需求值得认真处理。您的要求我都记下了，不用再重复。' },
  ],
  general_unknown: [
    { draft: 'Which part do you want to pin down first?', draftZh: '您想先确认哪一部分？' },
    { draft: "Got it—that's clear now. Let me check it properly before I answer.", draftZh: '明白，这次说清楚了。我先认真核实再回复您。' },
    { draft: "I have the detail now. I'll verify it and come back with a proper answer.", draftZh: '具体要求我记下了。我核实清楚后给您准确答复。' },
  ],
};

function localizedPairs(language: SupportedLanguage, scenario: KnowledgeGapScenario): ReplyPair[] {
  if (language === 'english') return ENGLISH[scenario];
  if (language === 'spanish') {
    const spanish: Partial<Record<KnowledgeGapScenario, ReplyPair[]>> = {
      after_sale_complaint: [
        { draft: 'Siento que haya pasado esto. Envíame el número de pedido y un par de fotos claras; voy a llamar al responsable ahora.', draftZh: '很抱歉出了这个问题。请发来订单号和两张清楚的照片，我现在请负责人处理。' },
        { draft: 'Entiendo tu enfado. Pásame el número de pedido y fotos del problema; voy a pedir al responsable que lo revise ahora.', draftZh: '我理解您为什么生气。请发来订单号和问题照片，我现在请负责人核查。' },
      ],
      call_request: [
        { draft: 'Claro, hablemos. ¿A qué hora te viene bien hoy?', draftZh: '可以，我们电话聊。您今天什么时间方便？' },
        { draft: 'Sí, una llamada será más fácil. Dime tu zona horaria y una hora que te venga bien.', draftZh: '可以，电话沟通更方便。请告诉我您的时区和合适时间。' },
      ],
      delivery_commitment: [
        { draft: 'No quiero prometer una fecha sin comprobar producción y envío reales. Voy a pedir a ventas que confirme el plazo para este pedido.', draftZh: '我不想在核实真实生产和运输时间前承诺日期。我会请销售确认这笔订单的时间。' },
        { draft: 'Esa fecha importa, así que no voy a adivinar. Ventas revisará el plazo real y lo confirmará aquí.', draftZh: '这个日期很重要，所以我不会靠猜。销售会核对真实时间并在这里确认。' },
      ],
      product_discovery: [
        { draft: '¿Qué tipo de producto buscas? Envíame una foto o el nombre y te enseño las opciones más cercanas.', draftZh: '您想找哪类产品？发一张图片或产品名称给我，我按这个方向给您找合适的。' },
        { draft: 'Cuéntame qué buscas y para qué mercado; así puedo enseñarte productos más adecuados.', draftZh: '告诉我您在找什么、面向哪个市场，我好给您推荐更合适的产品。' },
      ],
      quality_or_certification: [
        { draft: 'Tienes razón en comprobarlo. No diré que un certificado es válido hasta verificar que corresponde a este producto. Voy a llamar al responsable ahora.', draftZh: '您要核实是对的。在确认与产品一致前，我不会说证书有效。我现在请负责人处理。' },
        { draft: 'Es una duda justa. Vamos a verificar el documento y el número de certificado reales para este producto.', draftZh: '这个问题很合理。我们会核验这个产品对应的真实文件和证书编号。' },
      ],
      general_unknown: [
        { draft: 'Todavía no tengo una respuesta fiable. ¿Qué punto exacto quieres que compruebe?', draftZh: '这件事我现在还没有可靠答案。您具体想确认哪一点？' },
        { draft: 'Entendido, ahora está claro. Déjame comprobarlo bien antes de responder.', draftZh: '明白，这次说清楚了。我先认真核实再回复您。' },
      ],
    };
    const fallback: Record<KnowledgeGapScenario, ReplyPair> = {
      after_sale_complaint: spanish.after_sale_complaint![0],
      call_request: spanish.call_request![0],
      delivery_commitment: spanish.delivery_commitment![0],
      product_discovery: spanish.product_discovery![0],
      product_availability: { draft: 'Envíame una foto o el nombre del producto y reviso las opciones disponibles.', draftZh: '把产品图片或名称发给我，我帮您看现有选项。' },
      quality_or_certification: spanish.quality_or_certification![0],
      competitor_comparison: { draft: 'Vale la pena compararlo bien. Voy a pedir a ventas que revise el mismo alcance contigo, no solo el número principal.', draftZh: '这个报价值得认真比较。我会请销售按同一范围与您比较，而不只看表面的数字。' },
      customization_or_packaging: { draft: 'Entendido: marca privada y empaque bilingüe. Envíame el logo o una referencia y pediré que confirmen lo que realmente podemos hacer 👍', draftZh: '明白，您要贴牌和双语包装。请发来 Logo 或参考，我会请人确认真实可执行范围。' },
      urgent_next_step: { draft: 'Entendido, quieres avanzar sin tantas vueltas. Ya tengo lo que compartiste; añade solo lo que falte y pediré que confirmen el siguiente paso.', draftZh: '明白，您想直接推进。我已经记下您说过的信息，只需补充缺少的内容，我会请人确认下一步。' },
      order_or_logistics: { draft: 'Necesito revisar el registro real. Envíame el número de pedido y pediré que comprueben el estado.', draftZh: '这需要核对真实记录。请发来订单号，我会请人核查状态。' },
      price_or_quote: { draft: 'No voy a inventar el precio. Voy a pasar a ventas los datos que ya compartiste para que confirme la cotización real.', draftZh: '我不会随口猜价格。我会把您已经说过的信息交给销售，请他们确认真实报价。' },
      high_value_or_peer: { draft: 'Es un volumen importante. Voy a llamar al responsable de ventas y le pasaré los datos que ya compartiste.', draftZh: '这个数量需要认真跟进。我会请销售负责人接手，并把您已经提供的信息一起交给他。' },
      general_unknown: spanish.general_unknown![0],
    };
    return spanish[scenario] ?? [fallback[scenario]];
  }
  const arabic: Partial<Record<KnowledgeGapScenario, ReplyPair[]>> = {
    after_sale_complaint: [
      { draft: 'آسف لما حدث. أرسل رقم الطلب وصورتين واضحتين، وسأطلب من المسؤول متابعة الموضوع الآن.', draftZh: '很抱歉出了这个问题。请发来订单号和两张清楚的照片，我现在请负责人处理。' },
      { draft: 'أتفهم انزعاجك. أرسل رقم الطلب وصور المشكلة هنا، وسأُدخل المسؤول في المحادثة الآن.', draftZh: '我理解您为什么生气。请发来订单号和问题照片，我现在请负责人加入处理。' },
    ],
    call_request: [
      { draft: 'بالتأكيد، لنتحدث. ما الوقت المناسب لك اليوم؟', draftZh: '可以，我们电话聊。您今天什么时间方便？' },
      { draft: 'نعم، المكالمة أسهل. أرسل منطقتك الزمنية والوقت المناسب لك.', draftZh: '可以，电话沟通更方便。请告诉我您的时区和合适时间。' },
    ],
    delivery_commitment: [
      { draft: 'لا أريد أن أعد بموعد قبل التحقق من وقت الإنتاج والشحن الفعلي. سأطلب من المبيعات تأكيد المدة لهذا الطلب.', draftZh: '我不想在核实真实生产和运输时间前承诺日期。我会请销售确认这笔订单的时间。' },
      { draft: 'هذا الموعد مهم، لذلك لن أخمّن. ستراجع المبيعات المدة الفعلية وتؤكدها هنا.', draftZh: '这个日期很重要，所以我不会靠猜。销售会核对真实时间并在这里确认。' },
    ],
    product_discovery: [
      { draft: 'ما نوع المنتج الذي تبحث عنه؟ أرسل صورة أو اسم المنتج وسأعرض لك أقرب الخيارات.', draftZh: '您想找哪类产品？发一张图片或产品名称给我，我按这个方向给您找合适的。' },
      { draft: 'أخبرني بما تبحث عنه ولأي سوق، وسأساعدك في تضييق الخيارات.', draftZh: '告诉我您想找什么、面向哪个市场，我帮您缩小选择范围。' },
    ],
    quality_or_certification: [
      { draft: 'من حقك أن تتحقق. لن أقول إن الشهادة صحيحة قبل مطابقتها مع هذا المنتج. سأطلب من المسؤول التحقق منها الآن.', draftZh: '您要核实是对的。在确认与产品一致前，我不会说证书有效。我现在请负责人核验。' },
      { draft: 'سؤال منطقي. لنتحقق من المستند الحقيقي ورقم الشهادة لهذا المنتج.', draftZh: '这个问题很合理。我们会核验这个产品对应的真实文件和证书编号。' },
    ],
    general_unknown: [
      { draft: 'ليس لدي جواب موثوق بعد. ما النقطة التي تريد مني التحقق منها بالضبط؟', draftZh: '这件事我现在还没有可靠答案。您具体想确认哪一点？' },
      { draft: 'واضح الآن. دعني أتحقق منه جيدًا قبل أن أجيبك.', draftZh: '明白，这次说清楚了。我先认真核实再回复您。' },
    ],
  };
  const fallback: Record<KnowledgeGapScenario, ReplyPair> = {
    after_sale_complaint: arabic.after_sale_complaint![0],
    call_request: arabic.call_request![0],
    delivery_commitment: arabic.delivery_commitment![0],
    product_discovery: arabic.product_discovery![0],
    product_availability: { draft: 'أرسل صورة المنتج أو اسمه وسأراجع الخيارات المتاحة.', draftZh: '把产品图片或名称发给我，我帮您看现有选项。' },
    quality_or_certification: arabic.quality_or_certification![0],
    competitor_comparison: { draft: 'هذا العرض يستحق مقارنة دقيقة. سأطلب من المبيعات مقارنة نفس النطاق معك، وليس الرقم الظاهر فقط.', draftZh: '这个报价值得认真比较。我会请销售按同一范围与您比较，而不只看表面的数字。' },
    customization_or_packaging: { draft: 'واضح: علامة خاصة وتغليف بلغتين. أرسل الشعار أو مرجعًا للتغليف وسأطلب تأكيد ما يمكن تنفيذه فعليًا 👍', draftZh: '明白，您要贴牌和双语包装。请发来 Logo 或包装参考，我会请人确认真实可执行范围。' },
    urgent_next_step: { draft: 'واضح أنك تريد التقدم بدون نقاش طويل. لدي ما أرسلته، فأضف فقط أي تفصيل ناقص وسأطلب تأكيد الخطوة التالية.', draftZh: '明白，您想直接推进。我已经记下您说过的信息，只需补充缺少的内容，我会请人确认下一步。' },
    order_or_logistics: { draft: 'أحتاج إلى مراجعة سجل الطلب الحقيقي. أرسل رقم الطلب وسأطلب التحقق من الحالة.', draftZh: '这需要核对真实订单记录。请发来订单号，我会请人核查状态。' },
    price_or_quote: { draft: 'لن أخمّن السعر. سأرسل للمبيعات التفاصيل التي شاركتها بالفعل لتأكيد العرض الحقيقي.', draftZh: '我不会随口猜价格。我会把您已经说过的信息交给销售，请他们确认真实报价。' },
    high_value_or_peer: { draft: 'هذه كمية مهمة. سأطلب من مسؤول المبيعات الانضمام وسأرسل له التفاصيل التي شاركتها بالفعل.', draftZh: '这个数量需要认真跟进。我会请销售负责人接手，并把您已经提供的信息一起交给他。' },
    general_unknown: arabic.general_unknown![0],
  };
  return arabic[scenario] ?? [fallback[scenario]];
}

function followUpMinutes(): number {
  const configured = Number(process.env.CUSTOMER_SERVICE_FOLLOW_UP_MINUTES ?? 240);
  return Number.isFinite(configured) ? Math.min(24 * 60, Math.max(15, Math.round(configured))) : 240;
}

function firstBuyerQuantity(message: string): string {
  return String(message || '').match(/\b\d[\d,]*(?:\.\d+)?\s*(?:pcs?|pieces?|units?|sets?|bottles?|boxes?|cartons?)\b/i)?.[0] || '';
}

function firstBuyerDeliveryWindow(message: string): string {
  return String(message || '').match(/\b(?:within|in)\s+\d+\s+days?\b/i)?.[0] || '';
}

function quantityInChinese(value: string): string {
  return value
    .replace(/\bpcs?\b|\bpieces?\b|\bunits?\b/i, '件')
    .replace(/\bsets?\b/i, '套')
    .replace(/\bbottles?\b/i, '瓶')
    .replace(/\bboxes?\b|\bcartons?\b/i, '箱');
}

function deliveryWindowInChinese(value: string): string {
  const days = value.match(/\d+/)?.[0];
  return days ? `${days} 天内` : value;
}

function personalizeEnglishBridge(scenario: KnowledgeGapScenario, message: string, fallback: ReplyPair): ReplyPair {
  const quantity = firstBuyerQuantity(message);
  const deliveryWindow = firstBuyerDeliveryWindow(message);
  if (scenario === 'product_availability') {
    const size = String(message || '').match(/\bsize\s+([a-z0-9-]+)\b/i)?.[1];
    const color = String(message || '').match(/\b(black|white|navy|beige|red|blue|green)\b/i)?.[1];
    if (size || color) {
      const colorZh: Record<string, string> = { black: '黑色', white: '白色', navy: '藏青色', beige: '米色', red: '红色', blue: '蓝色', green: '绿色' };
      const details = [
        color ? `${color[0].toUpperCase()}${color.slice(1).toLowerCase()}` : '',
        size ? `size ${size.toUpperCase()}` : '',
        quantity,
      ].filter(Boolean);
      const detailsZh = [
        color ? colorZh[color.toLowerCase()] || color : '',
        size ? `${size.toUpperCase()} 码` : '',
        quantity ? quantityInChinese(quantity) : '',
      ].filter(Boolean);
      return {
        draft: `${details.join(', ')}—got it. Let me double-check that combination for you.`,
        draftZh: `${detailsZh.join('、')}，明白。我帮您确认一下这个组合。`,
      };
    }
    if (/colo(?:u)?rs?/i.test(message)) return {
      draft: 'Let me check the available colors for this one.',
      draftZh: '我帮您查一下这款现有哪些颜色。',
    };
  }
  if (scenario === 'high_value_or_peer' && quantity) {
    return {
      draft: `${quantity}—got it. Let me go through the details you've sent and work out the next step.`,
      draftZh: `${quantityInChinese(quantity)}，明白。我先把您发来的信息过一遍，再确认下一步。`,
    };
  }
  if (scenario === 'competitor_comparison' && (quantity || deliveryWindow)) {
    const offer = quantity && deliveryWindow
      ? `${quantity} with delivery ${deliveryWindow}`
      : quantity || `delivery ${deliveryWindow}`;
    const offerZh = quantity && deliveryWindow
      ? `${quantityInChinese(quantity)}、交付时间 ${deliveryWindowInChinese(deliveryWindow)}`
      : quantityInChinese(quantity) || `交付时间 ${deliveryWindowInChinese(deliveryWindow)}`;
    return {
      draft: `${offer} does sound attractive. Before you decide, let's check whether the packaging, documents and delivery terms are really the same.`,
      draftZh: `${offerZh}确实有吸引力。决定前，我们先确认包装、文件和交付条件是否真的相同。`,
    };
  }
  if (scenario === 'delivery_commitment' && deliveryWindow) {
    const days = deliveryWindow.match(/\d+/)?.[0] || '';
    return {
      draft: `A ${days}-day delivery window is tight. Let me check production and shipping before I say yes.`,
      draftZh: `${days} 天的交付时间比较紧。我先核实生产和运输，再给您明确答复。`,
    };
  }
  if (scenario === 'price_or_quote' && /\b(?:moq|minimum order(?: quantity)?)\b/i.test(message)) {
    return {
      draft: 'Which product do you need the MOQ for?',
      draftZh: '您想确认哪款产品的起订量？',
    };
  }
  return fallback;
}

export function resolveKnowledgeGapPlan(input: {
  message: string;
  language: unknown;
  timeline?: TimelineLike[];
}): KnowledgeGapPlan {
  const scenario = classifyKnowledgeGapScenario(input.message);
  const language = normalizeLanguage(input.language);
  const options = localizedPairs(language, scenario);
  const replyIndex = chooseNonRepeatedIndex(options.map(option => option.draft), input.timeline ?? []);
  const baseSelection = options[replyIndex] ?? options[0];
  const selected = language === 'english' && replyIndex === 0
    ? personalizeEnglishBridge(scenario, input.message, baseSelection)
    : baseSelection;
  const minutes = followUpMinutes();
  return {
    scenario,
    draft: selected.draft,
    draftZh: selected.draftZh,
    handoffRequired: true,
    safeToSendBeforeHandoff: true,
    handlingReason: HANDLING_REASON[scenario],
    variantCount: options.length,
    followUpMinutes: minutes,
    followUpDueAt: new Date(Date.now() + minutes * 60_000).toISOString(),
    replyConfidence: {
      level: 'bridge_only',
      score: scenario === 'general_unknown' ? 0.35 : 0.55,
      reason: '这是一条不承诺业务事实的安全承接话术；真实答案等待人工确认',
    },
  };
}

export function ambiguousFaqClarification(language: unknown): { draft: string; draftZh: string } {
  const normalized = normalizeLanguage(language);
  const draft = normalized === 'arabic'
    ? 'أي منتج أو موديل تقصد تحديدًا، وما النقطة التي تريد تأكيدها؟'
    : normalized === 'spanish'
    ? '¿Qué producto o modelo exacto quieres confirmar y qué dato necesitas?'
    : 'Which exact product or model do you mean, and what detail should I confirm?';
  return { draft, draftZh: '请问您具体指哪个产品或型号，想确认哪一项信息？' };
}

export function scenarioHasGroundedEvidence(scenario: KnowledgeGapScenario, evidenceSource: string): boolean {
  const source = String(evidenceSource || '').toLowerCase();
  if (scenario === 'customization_or_packaging') {
    return /\b(?:private[ -]?label|oem|odm|custom packaging|bilingual|arabic packaging)\b|贴牌|代工|定制包装|双语包装|阿拉伯语包装/.test(source);
  }
  if (scenario === 'product_availability') {
    return /"(?:color|size|material)"\s*:\s*"(?!\s*")[^"]+"/i.test(source);
  }
  if (scenario === 'product_discovery') {
    return /"name"\s*:\s*"(?!\s*")[^"]+"/i.test(source);
  }
  return false;
}
