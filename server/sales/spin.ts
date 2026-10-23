import { canonicalReply, recentSellerTexts, type TimelineLike } from '../lib/nonRepeatingReply.js';
import { hasLargeQuantity } from '../lib/dealSize.js';
import type { BantAssessment, QualificationTurn } from './qualification.js';

export type SpinStage = 'situation' | 'problem' | 'implication' | 'need_payoff';
export type DealSizeHint = 'small' | 'large' | 'unknown';

export interface SpinState {
  stage: SpinStage;
  turnIndex: number;
  implicationUsed: boolean;
  dealSizeHint: DealSizeHint;
  updatedAt: string;
}

export interface SpinGuidance {
  stage: SpinStage;
  statement: string;
  question: string;
  rationale: string;
  updatedAt: string;
}

const PROBLEM_SIGNAL_PATTERN = /\b(?:current supplier|slow delivery|late delivery|quality issue|inconsistent quality|moq (?:is |too )?high|too expensive|hard to reach|no certificate|stock.?out|returns?|complaints?|compliance|fake certificate|trust issue)\b|现有供应商|交货慢|质量不稳|起订量太高|联系不上|没有认证|缺货|退货|客诉|合规|假证|信任问题/i;

function normalizedLanguage(value: unknown): 'zh' | 'es' | 'ar' | 'en' {
  const language = String(value || '').toLowerCase();
  if (/中文|chinese|zh/.test(language)) return 'zh';
  if (/西语|spanish|español|\bes\b/.test(language)) return 'es';
  if (/阿语|arabic|العربية|\bar\b/.test(language)) return 'ar';
  return 'en';
}

function hasProblemSignal(turns: QualificationTurn[]): boolean {
  return turns.some(turn => turn.role === 'buyer' && PROBLEM_SIGNAL_PATTERN.test(String(turn.text || '')));
}

function resolveDealSizeHint(previous: DealSizeHint | undefined, turns: QualificationTurn[], bant: BantAssessment): DealSizeHint {
  // 单调升级：一旦判定为大单，不因某一轮信号缺失而降级。
  if (previous === 'large') return 'large';
  const buyerText = turns.filter(turn => turn.role === 'buyer').map(turn => String(turn.text || '')).join(' ');
  if (hasLargeQuantity(buyerText) || bant.rawTotal >= 60) return 'large';
  if (bant.completeness > 0 || buyerText.trim()) return previous === 'unknown' || !previous ? 'small' : previous;
  return previous ?? 'unknown';
}

export function advanceSpinStage(input: {
  previous?: SpinState;
  turns: QualificationTurn[];
  bant: BantAssessment;
  isNewBuyerTurn: boolean;
}): SpinState {
  const previous = input.previous;
  const turnIndex = (previous?.turnIndex ?? 0) + (input.isNewBuyerTurn ? 1 : 0);
  const dealSizeHint = resolveDealSizeHint(previous?.dealSizeHint, input.turns, input.bant);
  const implicationUsed = previous?.implicationUsed ?? false;

  let stage: SpinStage = previous?.stage ?? 'situation';
  if (!previous) {
    stage = turnIndex >= 3 ? 'problem' : 'situation';
  } else if (input.isNewBuyerTurn) {
    if (stage === 'situation' && turnIndex >= 3) {
      stage = 'problem';
    } else if (stage === 'problem' && dealSizeHint === 'large' && !implicationUsed && hasProblemSignal(input.turns)) {
      stage = 'implication';
    } else if (stage === 'implication') {
      // 放大影响最多用一次，用完立即进入收口阶段，不连续追问。
      stage = 'need_payoff';
    }
    // 小单在 problem 阶段封顶，不强制推进到 implication/need_payoff。
  }

  return {
    stage,
    turnIndex,
    implicationUsed: implicationUsed || stage === 'need_payoff' && previous?.stage === 'implication',
    dealSizeHint,
    updatedAt: new Date().toISOString(),
  };
}

interface StagePhrasing {
  statementBank: Record<'zh' | 'es' | 'ar' | 'en', string[]>;
  questionBank: Record<'zh' | 'es' | 'ar' | 'en', string[]>;
  rationale: string;
}

const PHRASING: Record<SpinStage, StagePhrasing> = {
  situation: {
    rationale: '了解现状：品类、市场、现有采购方式，为 BANT 的 B/N 打基础。',
    statementBank: {
      en: ['Glad to help with that.', 'Happy to look into this for you.'],
      zh: ['很高兴能帮到您。', '我来帮您看看合适的方案。'],
      es: ['Con gusto te ayudo con eso.', 'Encantado de revisar esto contigo.'],
      ar: ['يسعدني مساعدتك في ذلك.', 'يسرني النظر في هذا من أجلك.'],
    },
    questionBank: {
      en: ['Which market are you selling in?', 'Are you importing this already, or is it a new line for you?', 'Do you sell retail, or supply to other shops?'],
      zh: ['您这批货主要卖到哪个市场？', '这个品类您之前有在采购吗，还是第一次尝试？', '您是零售为主，还是也供货给其他店铺？'],
      es: ['¿En qué mercado vendes?', '¿Ya importas esto o es nueva para ti?', '¿Vendes al detalle o también abasteces a otras tiendas?'],
      ar: ['في أي سوق تبيع؟', 'هل تستورد هذا حالياً أم هو جديد بالنسبة لك؟', 'هل تبيع بالتجزئة أم تورّد لمتاجر أخرى؟'],
    },
  },
  problem: {
    rationale: '挖掘痛点：现有供应商的问题、质量、交期或起订量，不急着推销自己的优势。',
    statementBank: {
      en: ["That's useful context, thanks.", 'Good to know, that helps me understand your setup.'],
      zh: ['了解，这个背景很有用。', '明白了，这样我更清楚您的情况。'],
      es: ['Eso ayuda, gracias.', 'Bueno saberlo, así entiendo mejor tu situación.'],
      ar: ['هذا مفيد، شكراً لك.', 'جيد أن أعرف ذلك، يساعدني على فهم وضعك.'],
    },
    questionBank: {
      en: ['Any issue with your current supplier — quality, delivery, or MOQ?', 'Is lead time ever a headache for you?', "Do your buyers ever ask for certificates you can't get?"],
      zh: ['现在的供应商有没有让您头疼的地方，比如质量、交期或起订量？', '交期紧张的时候会影响您的生意吗？', '您的客户有没有要求过您暂时拿不到的认证？'],
      es: ['¿Algún problema con tu proveedor actual — calidad, entrega o MOQ?', '¿El plazo de entrega a veces te complica?', '¿Tus clientes piden certificados que no puedes conseguir?'],
      ar: ['هل هناك مشكلة مع موردك الحالي — الجودة أو التسليم أو الحد الأدنى للطلب؟', 'هل مدة التسليم تسبب لك إزعاجاً أحياناً؟', 'هل يطلب عملاؤك شهادات لا تستطيع الحصول عليها؟'],
    },
  },
  implication: {
    rationale: '放大影响：只在大单/高价值客户身上用一次，让客户意识到问题的代价。',
    statementBank: {
      en: ['That sounds like it really adds up.', 'I can see how that would be frustrating.'],
      zh: ['这个影响听起来确实不小。', '这种情况确实挺让人头疼的。'],
      es: ['Eso suena como que realmente afecta.', 'Entiendo que eso sea frustrante.'],
      ar: ['يبدو أن هذا يؤثر فعلاً.', 'أتفهم أن هذا أمر محبط.'],
    },
    questionBank: {
      en: ['Does that delay end up costing you sales in season?', 'So that ties up cash on stock that just sits?', 'Does that stop you from selling to bigger buyers?'],
      zh: ['这种延误会不会让您在旺季损失订单？', '这样是不是会占用资金压在库存上？', '这会不会让您没办法拿下更大的客户？'],
      es: ['¿Ese retraso te hace perder ventas en temporada alta?', '¿Eso inmoviliza capital en inventario parado?', '¿Eso te impide venderle a compradores más grandes?'],
      ar: ['هل يكلفك هذا التأخير مبيعات في الموسم؟', 'هل هذا يجمد رأس المال في مخزون راكد؟', 'هل هذا يمنعك من البيع لمشترين أكبر؟'],
    },
  },
  need_payoff: {
    rationale: '收口：让客户自己说出价值，然后立即给出具体下一步。',
    statementBank: {
      en: ["Here's a concrete way we could help.", "Let's see if this changes things for you."],
      zh: ['我们这边有个具体能帮上忙的方式。', '看看这样是否能解决您的问题。'],
      es: ['Aquí hay una forma concreta de ayudar.', 'Veamos si esto cambia las cosas para ti.'],
      ar: ['إليك طريقة عملية يمكننا المساعدة بها.', 'لنرَ إن كان هذا يغيّر الأمور بالنسبة لك.'],
    },
    questionBank: {
      en: ['If the timing can be confirmed, would that solve the main issue?', 'If we find a lower-risk first step, would you want to try it?', 'Want me to check the exact next step?'],
      zh: ['如果交付时间能确认下来，是不是就解决了主要问题？', '如果先从风险更低的一步开始，您愿意试试吗？', '需要我帮您核实准确的下一步吗？'],
      es: ['Si podemos confirmar el plazo, ¿resolvería el problema principal?', 'Si encontramos un primer paso con menos riesgo, ¿lo probarías?', '¿Quieres que confirme el siguiente paso exacto?'],
      ar: ['إذا تأكد موعد التسليم، هل سيحل ذلك المشكلة الأساسية؟', 'إذا وجدنا خطوة أولى أقل مخاطرة، هل ترغب في تجربتها؟', 'هل تريد أن أتحقق من الخطوة التالية بدقة؟'],
    },
  },
};

// SPIN statement/question are sent together as one WhatsApp message, so a previously-used
// fragment can appear anywhere inside a recent combined message, not only as its prefix.
// This needs substring containment rather than the stricter prefix matching that
// `chooseNonRepeatedIndex` uses for whole-message bridging replies.
function chooseUnusedFragmentIndex(options: string[], timeline: TimelineLike[]): number {
  const recent = recentSellerTexts(timeline);
  const index = options.findIndex(option => {
    const candidate = canonicalReply(option);
    return !recent.some(previous => previous.includes(candidate));
  });
  return index >= 0 ? index : options.length - 1;
}

export function selectSpinGuidance(state: SpinState, language: unknown, timeline: TimelineLike[] = []): SpinGuidance {
  const lang = normalizedLanguage(language);
  const phrasing = PHRASING[state.stage];
  const statementIndex = chooseUnusedFragmentIndex(phrasing.statementBank[lang], timeline);
  const questionIndex = chooseUnusedFragmentIndex(phrasing.questionBank[lang], timeline);
  return {
    stage: state.stage,
    statement: phrasing.statementBank[lang][statementIndex] ?? phrasing.statementBank[lang][0],
    question: phrasing.questionBank[lang][questionIndex] ?? phrasing.questionBank[lang][0],
    rationale: phrasing.rationale,
    updatedAt: new Date().toISOString(),
  };
}
