/** Shared editorial guidance; facts, timing and output schemas remain owned by each caller. */
export const SCRIPT_CREATIVE_QUALITY_RULES = `面对一个具体买家，以熟悉产品的讲解者视角，把一个小问题讲清楚。
先写连贯口播，再按镜头分段；句子长短自然变化，后一句承接前一句，保留必要的解释与转折。
开头给观看理由，中间用具体细节兑现，产品自然进入讨论；让观众带走一个有用的判断。
解释写买家可以怎样考虑或追问，不从功能名推导产品效果。只围绕一个细节展开，宁可把它说明白，也不罗列卖点。
按内容目标收尾，不把每段写成广告口号。不刻意添加语气词，不虚构亲身经历、客户故事或产品效果。
直接按目标语言的口语习惯创作；事实与适用条件保持准确。`;

export function scriptEndingRules(goal: 'reach' | 'leads', cta: string): string {
  const purpose = goal === 'reach'
    ? '内容目标：观看与互动。先兑现开头，让观众带走一个具体看法，不强塞销售邀请。'
    : '内容目标：获取询盘。讲清需求与产品能力的关系，行动邀请自然承接正文。';
  if (cta.trim()) return `${purpose}用户指定行动：${cta.trim()}；保留行动意图，用目标语言自然表达，不必逐字照读或独占一镜。`;
  return goal === 'reach'
    ? `${purpose}以有用的结论收束，或自然引出讨论；不要默认添加私信、报价或购买邀请。`
    : `${purpose}结尾邀请私信了解产品，明确可以聊正文中的什么问题，不新增寄样、报价或服务承诺。`;
}

/** Approximate writing range, not measured TTS duration or per-sentence limits. */
export function scriptNarrationBudget(duration: number, language: string): string {
  const seconds = Math.max(10, Number(duration) || 20);
  return language === 'zh'
    ? `中文全稿控制在${Math.round(seconds * 3.2)}—${Math.round(seconds * 3.6)}字内，含产品名和收尾；超过时少讲内容，保留解释与承接。此范围用于预估语速，不代表已测量音频时长。`
    : `全稿按${seconds}秒自然语速创作。英文可先按约${Math.round(seconds * 1.9)}—${Math.round(seconds * 2.2)}词估算；其他语言按实际说话节奏安排。不要先写中文再逐字翻译，也不限制每句话的长度。`;
}

/** New prose plans and legacy lines are both accepted; metadata never becomes narration. */
export function scriptNarrationFromPlan(raw: string): string {
  try {
    const plan = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    if (typeof plan.narration === 'string' && plan.narration.trim()) return plan.narration.trim();
    if (Array.isArray(plan.lines) && plan.lines.length && plan.lines.every((line: unknown) => typeof line === 'string' && line.trim())) return plan.lines.join(' ');
  } catch { /* malformed generation is reported by the caller */ }
  return '';
}

/** Select a source clause, not a model paraphrase; keep modifiers outside the quote. */
export function scriptSelectedFactPhrase(raw: string, product: string): string {
  try {
    const plan = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    const normalize = (value: string) => value.replace(/\s/g, '');
    for (const quote of Array.isArray(plan.factBasis) ? plan.factBasis : []) {
      if (typeof quote !== 'string' || !quote.trim()) continue;
      const source = product.split(/\r?\n/).find(line => normalize(line).includes(normalize(quote)));
      if (!source) continue;
      const value = source.replace(/^(?:产品名称|产品卖点|核心优势|已核实事实|产品规格|规格参数)[：:]\s*/, '');
      // Conditions can apply across clauses; in that case retain the complete source value.
      if (/需|仅限|仅当|条件|前提|如果|若|unless|only if|provided|subject to|requires?|when/i.test(value)) return value;
      return value.split(/[；;]/).find(part => normalize(part).includes(normalize(quote)))?.trim() || value;
    }
  } catch { /* caller reports an invalid plan */ }
  return '';
}

/** Preserve fact ownership when a request contains several product records. */
export function scriptSelectedFactProductName(raw: string, product: string): string {
  try {
    const plan = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    const quote = typeof plan.factBasis?.[0] === 'string' ? plan.factBasis[0].replace(/\s/g, '') : '';
    if (!quote) return '';
    let owner = '';
    for (const line of product.split(/\r?\n/)) {
      const name = line.match(/^产品名称[：:]\s*(.+)/);
      if (name) owner = name[1].trim();
      if (line.replace(/\s/g, '').includes(quote)) return owner;
    }
  } catch { /* caller validates the plan */ }
  return '';
}

/** Segment finished speech without asking a model to rewrite it as scene-sized slogans. */
export function scriptNarrationLinesFromPlan(raw: string, maxScenes: number): string[] {
  const narration = scriptNarrationFromPlan(raw);
  if (!narration) return [];
  // Retain the old provider contract when it already contains valid voice chunks.
  try {
    const plan = JSON.parse(raw.replace(/```json|```/gi, '').trim());
    if (!plan.narration && Array.isArray(plan.lines) && plan.lines.length <= maxScenes) return plan.lines.map((line: string) => line.trim());
  } catch { return []; }
  const boundaries = new Map<number, number>();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  for (const segment of segmenter.segment(narration)) boundaries.set(segment.index + segment.segment.length, 0);
  // Commas are optional cut points; sentence endings are preferable. Never cut a word,
  // decimal number or a punctuation-free sentence just to reach a scene count.
  for (const match of narration.matchAll(/[，；]|[,;](?=\s)/g)) {
    const end = match.index! + match[0].length;
    if (!boundaries.has(end)) boundaries.set(end, 80);
  }
  boundaries.set(narration.length, 0);
  const ends = [0, ...[...boundaries.keys()].sort((a, b) => a - b)];
  const count = Math.min(Math.max(1, Math.trunc(maxScenes) || 1), ends.length - 1);
  const target = narration.length / count;
  const cost = Array.from({ length: count + 1 }, () => Array(ends.length).fill(Infinity));
  const previous = Array.from({ length: count + 1 }, () => Array(ends.length).fill(-1));
  cost[0][0] = 0;
  for (let group = 1; group <= count; group++) {
    for (let end = group; end < ends.length; end++) {
      for (let start = group - 1; start < end; start++) {
        if (!narration.slice(ends[start], ends[end]).trim()) continue;
        const candidate = cost[group - 1][start] + (ends[end] - ends[start] - target) ** 2 + (boundaries.get(ends[end]) || 0);
        if (candidate < cost[group][end]) { cost[group][end] = candidate; previous[group][end] = start; }
      }
    }
  }
  const lines: string[] = [];
  let end = ends.length - 1;
  for (let group = count; group > 0; group--) {
    const start = previous[group][end];
    if (start < 0) return [narration];
    lines.unshift(narration.slice(ends[start], ends[end]).trim());
    end = start;
  }
  return lines;
}

export function scriptCreativeModeRule(mode: string): string {
  if (mode === 'clone') return '对标模式：沿用原片的停留机制、揭示顺序、切点和音画位置；创作要求只用于已有内容位，不新增原片没有的口播、字幕或 CTA，不套采购问答结构。';
  if (mode === 'material') return '素材模式：从已观察到的动作或细节组织内容，画面证明判断；保留素材绑定和可用时间，无法承载的信息省略或标为待补素材。';
  return '产品模式：围绕一个产品价值组织内容；缺少已有画面时可建议补拍，但不把建议当作已发生的结果。';
}

/** A lightweight direction, not another model call or a fixed scene template. */
export function scriptVariantDirection(mode: string, seed: unknown): string {
  if (mode === 'clone') return '差异方向：保留参考片的钩子机制和镜头功能，只在允许替换的产品表达中变化，不能为排重添加新剧情。';
  const directions = [
    '给出一个与产品有关的实用判断：用具体细节解释怎样选择，避免泛泛的采购风险。',
    '从一个容易忽略的产品细节或动作切入：先吸引注意，再揭示它对选择的意义。',
    '从一个资料支持的使用或采购场景切入：沿着场景中的一个具体决定展开。',
  ];
  const value = Number(seed);
  const index = Number.isFinite(value) ? Math.abs(Math.trunc(value)) % directions.length : 0;
  return `本版优先切口：${directions[index]}证据不支持时改用另一个有依据的切口，不编造问题或结果。`;
}

/** Prefer facts not already named in prior narration; retain all original qualifiers. */
export function scriptUnusedFacts(facts: string[], priorNarration: string): string[] {
  const normalize = (value: string) => value.replace(/\s/g, '').toLowerCase();
  const prior = normalize(priorNarration);
  return facts.filter(fact => {
    const phrases = fact.replace(/^(?:支持|可配置|可选|具备|supports?\s+)/i, '')
      .split(/[、，,；;与和及]|\band\b/i).map(normalize).filter(value => value.length >= 4);
    return !phrases.some(phrase => prior.includes(phrase));
  });
}

/** Short examples teach the feature -> buying consideration transformation, not a fixed script. */
export const SCRIPT_FACT_TO_VALUE_EXAMPLES = `写法示例（只学承接方式，不借用事实或固定句式）：
资料“A设备，双工位可选” → “你在看双工位设备？先想想，这两个工位分别要做什么。拿A设备来说，双工位可以选配。跟供应商聊时，就把自己的工序带进去问：工件怎么安排，人在哪一步操作？这些聊清楚，再看这个配置合不合适。”
用事实承接一个真实的选择，把未知实施细节留作买家问题；不替设备回答，更不推导产能或省人成果。询盘稿在讨论后自然邀请交流，观看稿可以在结论处结束。`;

/** Keep only source-backed selections; retain the source line to preserve conditions. */
export function scriptSelectedFactContext(rawPlan: string, product: string, limit = 2): string {
  try {
    const plan = JSON.parse(rawPlan.replace(/```json|```/gi, '').trim());
    const normalize = (text: string) => text.replace(/\s+/g, '');
    const sourceLines = product.split(/\r?\n/).filter(Boolean);
    const selected = [...new Set<string>(Array.isArray(plan.factBasis)
      ? plan.factBasis.filter((fact: unknown): fact is string => typeof fact === 'string' && Boolean(fact.trim())) : [])]
      .map(quote => ({ quote, source: sourceLines.find(line => normalize(line).includes(normalize(quote))) }))
      .filter((item): item is { quote: string; source: string } => Boolean(item.source)).slice(0, limit);
    return selected.length
      ? selected.map(item => `本条选中事实：${item.quote}\n原始上下文（仅用于保留条件，不扩展其他卖点）：${item.source}`).join('\n')
      : product;
  } catch { return product; }
}
