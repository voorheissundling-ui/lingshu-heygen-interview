import { VIDEO_LANGUAGES, narrationLength, narrationRate } from '../../shared/contracts/videoLanguages.js';
import { callVideoModel } from './videoModel.js';
import { spokenLanguageMatches } from '../../shared/contracts/videoCreationPlan.js';

export function narrationUnits(text: string, language: string): number {
  return narrationLength(text, language);
}
export function parseNarration(raw: string, language: string, duration: number): string[] {
  const payload = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  const lines = Array.isArray(payload.lines) ? payload.lines.filter((line: unknown) => typeof line === 'string' && line.trim()).map((line: string) => line.trim()) : [];
  const spoken = lines.join(' ');
  if (lines.length < 3 || lines.length > 8 || !spokenLanguageMatches(spoken, language)) throw Error(`口播需为 ${language}，并包含 3–8 句，实际 ${lines.length} 句`);
  const units = narrationUnits(spoken, language), rate = narrationRate(language);
  if (units > duration * rate * 1.35 || units < duration * rate * 0.5) throw Error(`口播长度 ${units}，目标时长 ${duration} 秒允许 ${Math.ceil(duration * rate * 0.5)}–${Math.floor(duration * rate * 1.35)} 字词`);
  const naturalness = narrationNaturalnessIssues(lines);
  if (naturalness.length) throw Error(naturalness.join('；'));
  return lines;
}

export function narrationNaturalnessIssues(lines: string[]): string[] {
  const spoken = lines.join(' ');
  const issues: string[] = [];
  const auditPhrases = spoken.match(/已确认资料(?:显示|表明)|已确认产品资料|本段仅|内容仅使用|以正式资料为准|according to (?:the )?(?:confirmed|provided) (?:data|information)|this segment only/gi) || [];
  if (auditPhrases.length >= 2) issues.push('口播审稿腔过重，应把事实自然说给观众听，不要反复朗读证据状态');
  const openings = lines.map(line => line.replace(/^[\s“”"'‘’]+/, '').slice(0, /[\u3400-\u9fff]/.test(line) ? 3 : 12).toLowerCase()).filter(Boolean);
  if (new Set(openings).size <= Math.max(1, Math.floor(lines.length / 2))) issues.push('多句使用相同开头，人物语气机械重复');
  if (lines.some(line => /^(?:首先|其次|最后)[，,]?/.test(line)) && lines.length <= 4) issues.push('短视频口播不应套用报告式“首先、其次、最后”结构');
  return issues;
}

/**
 * Narrow proof that a visual can support conservative, directly observable
 * narration when the product table contains only an identity. Callers must
 * report authorization and product ownership explicitly; a non-empty asset
 * label or upload receipt is not visual evidence.
 */
export interface NarrationVisibleEvidence {
  authorization: 'owned' | 'licensed' | 'unknown';
  productMatched: boolean;
  synthetic?: boolean;
  observations: readonly string[];
}

export function narrationVisibleObservations(evidence: readonly NarrationVisibleEvidence[] = []): string[] {
  return [...new Set(evidence.flatMap(item => {
    if (item.authorization === 'unknown' || !item.productMatched || item.synthetic === true) return [];
    return item.observations.map(value => String(value || '').trim()).filter(value => value
      && !/^(?:无|暂无|未知|待补充|待确认|未分析|未识别|unknown|n\/?a|none)$/i.test(value)
      && !/^企业知识库产品.+的已上传(?:视频|图片)$/.test(value)
      && !/^(?:已上传|uploaded)(?:素材|material|image|video)?$/i.test(value));
  }))];
}

/** Require substantive product evidence before spending on narration or approving legacy output. */
export function narrationEvidenceIssues(
  facts: string,
  spoken = '',
  visibleEvidence: readonly NarrationVisibleEvidence[] = [],
): string[] {
  const substantive = facts.split(/[；;\n]/).map(value => value.trim()).filter(value => value && !/^(?:产品|product|SKU|型号)\s*[:：]/i.test(value));
  const hasSubstantiveProductFacts = substantive.length > 0
    && !substantive.every(value => /[:：]\s*(?:无|暂无|未知|待补充|unknown|n\/a)?$/i.test(value));
  const visibleObservations = narrationVisibleObservations(visibleEvidence);
  if (!hasSubstantiveProductFacts && !visibleObservations.length) return ['产品资料缺少已确认的类别、材质、特点或规格，且没有已授权并归属当前产品的可见素材观察，无法核验口播；请补充企业知识库产品事实或真实素材分析'];
  // Visible observations only satisfy the minimum entry gate. They never
  // prove performance, specifications or certification; deterministic rules
  // below and the final narration review continue to check those claims
  // against `facts`, not against visual observations.
  const unsupported = [
    { claim: /voltage|电压/i, evidence: /voltage|电压/i, name: '电压' },
    { claim: /temperature|温度/i, evidence: /temperature|温度/i, name: '温度' },
    { claim: /response time|响应时间/i, evidence: /response time|响应时间/i, name: '响应时间' },
    { claim: /derat(?:e|ing)|降额/i, evidence: /derat(?:e|ing)|降额/i, name: '降额性能' },
  ].filter(rule => rule.claim.test(spoken) && !rule.evidence.test(facts));
  return unsupported.map(rule => `口播涉及未提供依据的${rule.name}，需补充对应事实或移除该内容`);
}

export async function generateNarration(input: { facts: string; theme: string; audience: string; language: string; duration: number; cta: string; constraints: string[]; reference?: string; styleProfile?: string; visibleEvidence?: readonly NarrationVisibleEvidence[] }): Promise<string[]> {
  const visibleObservations = narrationVisibleObservations(input.visibleEvidence);
  const evidenceIssues = narrationEvidenceIssues(input.facts, '', input.visibleEvidence);
  if (evidenceIssues.length) throw new Error(evidenceIssues.join('；'));
  const units = Math.floor(input.duration * (narrationRate(input.language) * 0.87));
  const languageName = VIDEO_LANGUAGES[input.language as keyof typeof VIDEO_LANGUAGES] || input.language;
  const unitLabel = ['zh', 'ja'].includes(input.language) ? '字' : '词';
  const hardMaximum = Math.floor(input.duration * narrationRate(input.language) * 1.2);
  const prompt = `写一段纯${languageName}（${input.language}） 社媒口播，目标 ${input.duration} 秒、约 ${units} ${unitLabel}，总长度不得超过 ${hardMaximum} ${unitLabel}；长度是硬性验收条件。先完整想清表达，再按自然语意分成3–8句。
对谁说：${input.audience}。具体主题：${input.theme}。收尾目的：${input.cta}。
${input.duration <= 15 ? '短于或等于15秒时，只保留三个必要信息：一个有画面依据的开场观察、一个不同的可见细节、一个受事实边界限制的收尾；不要加入背景解释、选型建议或额外铺垫。' : '先提出具体场景中的问题，解释为什么值得关注，给一个可执行的判断方法，再自然收尾。'}保留句子之间的承接；像真实从业者对镜头说话，不加假经历、硬塞口头禅或审稿腔。事实要自然嵌入口语，禁止连续使用“已确认资料显示”“本段仅”“内容仅使用”等系统说明。不假定买家已经遇到故障或缺少能力。
仅允许陈述下列已确认事实，所有数字和条件需有原文依据。行业猜测改成买家要核实的问题；不承诺资料外的效果或服务。收尾仅邀请讨论需求，不承诺提供未经确认存在的清单、指南、方案或测试服务。提到几个问题，就必须完整给出对应数量的问题。
不要朗读内部素材编号、资料标题或测试标签。没有画面分析时，不断言视频里有/没有某技术内容，只讲买家应该向供应商核实什么，不扩展主题外的系统和型号。
事实：${input.facts}
已授权且归属当前产品的可见素材观察（只允许描述画面，不证明功效、规格或认证）：${visibleObservations.join('；') || '（无）'}
约束：${input.constraints.join('；')}
${input.reference ? '参考只迁移表达顺序，不复制事实：' + input.reference : ''}
${input.styleProfile ? '历史优质口播只提供抽象风格指纹，绝不复用原句：' + input.styleProfile : ''}
只输出 JSON：{"lines":["完整口播第一句","衔接句","收尾"]}。`;
  let correction = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const { text: raw } = await callVideoModel(prompt + correction, { timeoutMs: 90000, systemPrompt: `所有口播必须使用${languageName}（${input.language}），不要翻译成其他语言。JSON键名固定为lines。严格控制总长度和句数。` });
    try { return parseNarration(raw, input.language, input.duration); } catch (error) {
      if (attempt === 3) throw error;
      if (attempt >= 1) {
        const { text: compressed } = await callVideoModel(`压缩以下${languageName}短视频口播。只允许删除信息和缩短措辞，不得添加事实、数字、承诺或新CTA。保留原顺序，输出恰好3句，总长度不得超过 ${hardMaximum} ${unitLabel}，目标约 ${units} ${unitLabel}。只输出JSON：{"lines":["第一句","第二句","第三句"]}。\n原稿：${raw.slice(0, 6000)}`, { timeoutMs: 60_000, systemPrompt: `这是严格的长度压缩任务。输出必须是${languageName}，恰好3句且不超过${hardMaximum}${unitLabel}。` });
        try { return parseNarration(compressed, input.language, input.duration); } catch { /* continue with a fresh full draft */ }
      }
      correction = `\n上一版未通过：${error instanceof Error ? error.message : 'JSON无效'}。必须严格缩短到约 ${units} ${unitLabel}，绝不能超过 ${hardMaximum} ${unitLabel}；仍保留至少3句，每句只表达一个信息。直接删除解释和修饰语，在原事实边界内重写完整版本，不增加信息。上一版：${raw.slice(0, 6000)}`;
    }
  }
  throw Error('口播生成失败');
}
export async function reviewFinalNarration(input: { spoken: string; facts: string; visualFacts?: string[]; visibleEvidence?: readonly NarrationVisibleEvidence[]; sceneEvidence?: Array<{ spoken: string; asset: string; observations: string[] }>; language: string; constraints: string[] }): Promise<string[]> {
  const visibleObservations = narrationVisibleObservations(input.visibleEvidence);
  const evidenceIssues = narrationEvidenceIssues(input.facts, input.spoken, input.visibleEvidence);
  if (evidenceIssues.length) return evidenceIssues;
  if (!spokenLanguageMatches(input.spoken, input.language)) return ['最终口播语言与制作计划不符'];
  const naturalnessIssues = narrationNaturalnessIssues(input.spoken.match(/[^。！？!?]+[。！？!?]?/g)?.map(line => line.trim()).filter(Boolean) || [input.spoken]);
  if (naturalnessIssues.length) return naturalnessIssues;
  const { text: raw } = await callVideoModel(`审核最终口播，首先检查正文是否为目标语言 ${input.language}（品牌、型号可保留原文），包括区分英语、西语、法语等拉丁字母语言。再检查会改变事实或理解的问题：未提供依据的数字/效果/承诺，条件或否定丢失，要求“这几个问题”却未列出，制作审稿腔。不要按个人文风改写。私信领取清单/指南/方案等也属于服务承诺，事实中未明确提供则指出。只检查口播，不检查画面标识是否出现或出现位置；画面标识由渲染单独验证。
已确认事实：${input.facts}
已核验素材观察（只能证明画面，不能证明功效或合规）：${[...(input.visualFacts || []), ...visibleObservations].join('；')}
逐镜口播与实际素材对应（判断指代时以本镜为准，其他镜头不表示同一商品）：${JSON.stringify(input.sceneEvidence || [])}
约束：${input.constraints.join('；')}
最终口播：${input.spoken}
不把待确认的中性提问当成事实断言。“视频不能证明某功能”不等于“设备没有某功能”，前者是证据边界，不应误报为否定功能。不要因未展开全部技术条件而拒绝简短科普。只返回已确认的事实错误，策略建议放advisories。严格输出JSON：{"issues":[{"kind":"unsupported_claim|contradiction|missing_condition|language|service_promise|missing_enumeration|audit_tone","quote":"逐字引用最终口播中的原句","reason":"具体违反的事实及证据"}],"advisories":[]}。没有事实错误issues必须为空，不得在issues中写“此项无误/尚可接受/不计入”。`, { timeoutMs: 60000, systemPrompt: '你只做事实与语言审核，不做营销策略评分。只报告口播中实际出现的具体错误，并逐字引用原句。产品名本身不是功效承诺；不声称包装能证明性能，不等于否认产品性能。请阅读成分/说明、比较资料、评论提问、联系讨论需求，都不是企业承诺提供服务。只有明确承诺赠送、发送、提供未确认资料或服务才报告服务承诺。普通开放提问不需要枚举问题，只有明确说“这几个/这些/三项问题”等固定问题集合而未列出才报告数量丢失。不得从消费品类别推断只能面向C端，B2B受众与市场定位由用户目标决定。约束中的平台节奏、CTA偏好、画面要求和营销风格应交给策略审核，不得当作语言错误或虚构事实。不得因口播未复述全部卖点而拒绝。缺少免责声明不是事实错误，除非原句实际作出了需附条件的功效或认证断言。普通建议阅读标签不暗示该标签具有认证或功效证明。逐镜已对应的包装展示无需口播重复商品名，其他镜头已注明其他目录商品时不得推断它们都是本商品。' });
  return parseFinalNarrationReview(raw, input.spoken);
}

export function parseFinalNarrationReview(raw: string, spoken: string): string[] {
  const payload = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  if (!Array.isArray(payload.issues)) throw Error('最终口播审核未返回有效结论');
  const kinds = new Set(['unsupported_claim', 'contradiction', 'missing_condition', 'language', 'service_promise', 'missing_enumeration', 'audit_tone']);
  return payload.issues.map((issue: any) => {
    if (!issue || !kinds.has(issue.kind) || typeof issue.quote !== 'string' || !issue.quote.trim() || !spoken.includes(issue.quote) || typeof issue.reason !== 'string' || !issue.reason.trim()) throw Error('口播审核错误缺少可核验原句或有效事实类别');
    return `${issue.reason}；原句：${issue.quote}`;
  });
}
