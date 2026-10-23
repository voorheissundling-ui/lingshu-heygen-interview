import { materialRoleFromFolder } from '../lib/studioMaterialPresentation.js';
import { productFactCandidates, selectedProductNames } from '../lib/studioScriptNormalization.js';
import { isBusinessRoleEntity, productInfoSupportsNumericClaim } from '../lib/studioScriptQualityV2.js';
import type { ContentTheme, CooperationRoute } from '../strategy/scriptBrief.js';
import {
  ctaSemanticallySatisfied,
  dedupeStoryboardFieldLines,
  fitSpeechToShot,
  fitStoryboardSpeech,
  normalizeStoryboardFieldLines,
  safeStoryboardCta,
  shortStoryboardCta,
  storyboardSpeechIssues,
} from './studioStoryboardSpeechRules.js';

type LockedStoryboardScene = { environment: string; shot: string; camera: string; composition: string; purpose: string; visual: string; music: string };
export function isPackagingOnlyProductInfo(productInfo: string): boolean {
  const text = String(productInfo || '').toLowerCase();
  const hasPackagingIdentity = /滴管瓶|泵霜瓶|真空泵(?:霜)?瓶|包装(?:展示|容器)?|瓶器|空瓶|包材|容器|dropper bottle|airless (?:pump )?jar|empty (?:bottle|jar)|packaging|container/.test(text);
  const hasFinishedBeautyProduct = /膏体|质地|配方|精华液本体|面霜本体|润唇膏|上唇|涂抹|试涂|formula|texture|lip balm|apply to (?:skin|lips)/.test(text);
  return hasPackagingIdentity && !hasFinishedBeautyProduct;
}

export function isBeautyProductInfo(productInfo: string): boolean {
  return /美妆|护肤|彩妆|口红|唇膏|润唇|精华|面霜|乳液|面膜|洁面|防晒|粉底|睫毛|眼影|beauty|cosmetic|skincare|lip(?:stick| balm)|serum|face cream|lotion|mascara|foundation/i
    .test(String(productInfo || ''));
}

export function productVoicePlanSupportsTheme(lines: string[], theme: ContentTheme): boolean {
  const opening = String(lines[0] || '');
  const patterns: Record<ContentTheme, RegExp> = {
    buyer_pain: /担心|难|问题|选择|判断|拖慢|concern|risk|problem|choice|decision|slowing/i,
    product_proof: /目录|实物|细节|核实|验证|确认|catalog|physical|detail|verify|check|confirm|proof/i,
    use_case: /场景|陈列|使用|适用|适合|适配|scene|display|use|fit|suit/i,
    supplier_capability: /供应|交付|质检|生产|执行|supply|delivery|quality|production|execution/i,
    customization: /定制|标签|外盒|包装触点|custom|label|carton|packaging touchpoint/i,
    comparison: /比较|对比|两种|怎么选|compare|comparison|two .*options|choose between/i,
    customer_case: /案例|客户|合作过程|case|customer|collaboration process/i,
    trend: /趋势|信号|来源|trend|signal|sourced/i,
    talking_head: /我|回答|讲解|let me|answer|explain/i,
  };
  return patterns[theme].test(opening);
}

export function openingMatchesCooperationRoute(opening: string, route: CooperationRoute): boolean {
  const patterns: Record<CooperationRoute, RegExp> = {
    oem_odm: /品牌方|品牌创始人|产品经理|采购|\bbrand(?:s)?\b|brand founder|product manager|procurement|sourcing manager/i,
    wholesale_distribution: /进口商|经销商|渠道采购|importer|distributor|channel buyer/i,
    consumer_retail: /你|消费者|用户|customer|consumer/i,
  };
  return patterns[route].test(opening);
}

export function openingMatchesTargetBuyer(opening: string, audience: string): boolean {
  if (!String(audience || '').trim()) return true;
  const roleGroups = [
    ['工厂厂长', '厂长', 'factory manager', 'plant manager'],
    ['自动化负责人', '自动化', 'automation manager', 'automation lead'],
    ['设备负责人', '设备经理', 'equipment manager'],
    ['生产经理', 'production manager'], ['工艺经理', 'process manager', 'process engineer'],
    ['质量经理', 'quality manager', 'qa manager'],
    ['采购', '采购经理', 'procurement', 'buyer', 'sourcing manager'],
    ['供应链负责人', '供应链经理', 'supply chain manager'],
    ['系统集成商', 'system integrator'],
    ['品牌创始人', 'brand founder'], ['产品经理', 'product manager'],
    ['进口商', 'importer'], ['经销商', 'distributor'],
  ];
  const expected = roleGroups.filter(group => group.some(term => audience.toLowerCase().includes(term.toLowerCase())));
  return expected.length === 0 || expected.some(group => group.some(term => opening.toLowerCase().includes(term.toLowerCase())));
}

function targetBuyerVoiceLabel(audience: string, language: string): string {
  const text = String(audience || '').toLowerCase();
  if (language === 'zh') {
    if (/自动化|automation/.test(text)) return '自动化经理';
    if (/工程|engineering|engineer/.test(text)) return '工程经理';
    if (/质量|quality|\bqa\b/.test(text)) return '质量经理';
    if (/工厂|厂长|plant|factory/.test(text)) return '工厂经理';
    if (/采购|procurement|buyer|sourcing/.test(text)) return '采购经理';
    if (/经销|distributor/.test(text)) return '经销商';
    if (/进口|importer/.test(text)) return '进口商';
    return '采购';
  }
  if (/自动化|automation/.test(text)) return 'Automation managers';
  if (/工程|engineering|engineer/.test(text)) return 'Engineering managers';
  if (/质量|quality|\bqa\b/.test(text)) return 'Quality managers';
  if (/工厂|厂长|plant|factory/.test(text)) return 'Plant managers';
  if (/经销|distributor/.test(text)) return 'Distributors';
  if (/进口|importer/.test(text)) return 'Importers';
  return 'Buyers';
}

export function safeProductVoicePlan(theme: ContentTheme, productInfo: string, cta: string, language: string, audience = ''): string[] {
  const names = selectedProductNames(productInfo);
  const first = names[0] || 'the selected product';
  const facts = productFactCandidates(productInfo);
  const buyer = targetBuyerVoiceLabel(audience, language);
  if (language === 'zh') {
    const hooks: Record<ContentTheme, string> = {
      buyer_pain: `${buyer}，这个风险怎么判断？`, product_proof: `${buyer}，如何核实产品实证？`, use_case: `${buyer}，现场是否适用？`,
      supplier_capability: `${buyer}，交付能力怎么核实？`, customization: `${buyer}，哪些项目能定制？`, comparison: `${buyer}，两种方案怎么选？`,
      customer_case: `${buyer}，这个案例可靠吗？`, trend: `${buyer}，这个趋势有依据吗？`, talking_head: `${buyer}，我来讲解判断重点。`,
    };
    return [
      hooks[theme],
      facts[0] ? `${facts[0]}。` : `核对${first}的真实细节。`,
      facts[1] ? `${facts[1]}。` : '确认资料支持的第二项证据。',
      safeStoryboardCta(cta, language),
    ];
  }
  const hooks: Record<ContentTheme, string> = {
    buyer_pain: `${buyer}, how do you judge this risk?`, product_proof: `${buyer}, how do you verify the proof?`, use_case: `${buyer}, does this fit your site?`,
    supplier_capability: `${buyer}, how do you verify delivery?`, customization: `${buyer}, which items can be customized?`, comparison: `${buyer}, how do these options compare?`,
    customer_case: `${buyer}, is this case verifiable?`, trend: `${buyer}, is this trend sourced?`, talking_head: `${buyer}, let me explain the key checks.`,
  };
  return [
    hooks[theme],
    facts[0] || `Review the verified details of ${first}.`,
    facts[1] || 'Confirm the second supported product fact.',
    safeStoryboardCta(cta, language),
  ];
}

export function applySafeStoryboardSpeechFallback(
  script: string,
  productInfo: string,
  theme: ContentTheme,
  primaryCta: string,
  language: string,
): string {
  const blocks = String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m);
  const sceneIndexes = blocks.map((block, index) => /^\s*\[\s*\d/.test(block) ? index : -1).filter(index => index >= 0);
  if (!sceneIndexes.length) return script;
  const safePlan = safeProductVoicePlan(theme, productInfo, primaryCta, language);
  const cta = safeStoryboardCta(primaryCta, language);
  const middleCount = Math.max(0, sceneIndexes.length - 2);
  const middleLines = Array.from({ length: middleCount }, (_, index) => {
    if (index % 2 === 0) return language === 'zh' ? '查看产品现场。' : 'Review the visible product.';
    return language === 'zh' ? '核对可见证据。' : 'Check the visible evidence.';
  });
  const lines = [safePlan[0]!, ...middleLines, cta];
  for (let position = 0; position < sceneIndexes.length; position += 1) {
    const index = sceneIndexes[position]!;
    const range = blocks[index]!.match(/^\s*\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—]\s*(\d+(?:\.\d+)?)/);
    const duration = range ? Math.max(0.5, Number(range[2]) - Number(range[1])) : 4;
    const plannedVoice = lines[position] || cta;
    let voice = fitSpeechToShot(plannedVoice, duration);
    let block = blocks[index]!;
    if (/^台词[：:]/m.test(block)) block = block.replace(/^台词[：:].*$/m, `台词：${voice}`);
    else block = `${block.replace(/\s+$/, '')}\n台词：${voice}\n`;
    if (/^字幕[：:]/m.test(block)) block = block.replace(/^字幕[：:].*$/m, `字幕：${voice}`);
    else block = block.replace(/^(台词[：:].*)$/m, `$1\n字幕：${voice}`);
    if (storyboardSpeechIssues(block).length > 0) {
      voice = position === 0
        ? (language === 'zh' ? '采购，怎么判断？' : 'Buyers, how do you judge it?')
        : position === sceneIndexes.length - 1
          ? shortStoryboardCta(primaryCta, language)
          : (language === 'zh' ? (position % 2 ? '查看产品现场。' : '核对可见证据。') : 'Review visible evidence.');
      block = block.replace(/^台词[：:].*$/m, `台词：${voice}`).replace(/^字幕[：:].*$/m, `字幕：${voice}`);
    }
    blocks[index] = block;
  }
  return blocks.join('');
}

export function ensureStoryboardPrimaryCta(
  script: string,
  primaryCta: string,
  language: string,
  includeVoice = true,
): string {
  if (!primaryCta || ctaSemanticallySatisfied(script, primaryCta)) return script;
  const blocks = String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m);
  const lastSceneIndex = blocks.map((block, index) => /^\s*\[\s*\d/.test(block) ? index : -1).filter(index => index >= 0).pop();
  if (lastSceneIndex == null) return script;
  const range = blocks[lastSceneIndex]!.match(/^\s*\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—]\s*(\d+(?:\.\d+)?)/);
  const duration = range ? Math.max(0.5, Number(range[2]) - Number(range[1])) : 3;
  let voice = fitSpeechToShot(safeStoryboardCta(primaryCta, language), duration);
  if (!includeVoice) voice = safeStoryboardCta(primaryCta, language);
  const voiceFits = (candidate: string) => storyboardSpeechIssues(`[0-${duration}s]\n台词：${candidate}`).length === 0;
  if (!ctaSemanticallySatisfied(voice, primaryCta) || (includeVoice && !voiceFits(voice))) voice = shortStoryboardCta(primaryCta, language);
  if ((!ctaSemanticallySatisfied(voice, primaryCta) || (includeVoice && !voiceFits(voice))) && language === 'zh' && /预约/.test(primaryCta)) voice = '预约诊断。';
  let block = blocks[lastSceneIndex]!;
  const spokenLine = includeVoice ? voice : '无';
  if (/^[ \t]*台词[：:]/m.test(block)) block = block.replace(/^[ \t]*台词[：:].*$/m, `台词：${spokenLine}`);
  else block = `${block.replace(/\s+$/, '')}\n台词：${spokenLine}\n`;
  if (/^[ \t]*字幕[：:]/m.test(block)) block = block.replace(/^[ \t]*字幕[：:].*$/m, `字幕：${voice}`);
  else block = block.replace(/^(台词[：:].*)$/m, `$1\n字幕：${voice}`);
  blocks[lastSceneIndex] = block;
  return blocks.join('');
}

export function canonicalMaterialPrimaryCta(primaryCta: string, language: string): string {
  const cta = String(primaryCta || '').replace(/\s+/g, ' ').trim();
  if (!cta) return '';
  if (/messenger/i.test(cta)) return language === 'zh' ? '通过 Messenger 联系我们。' : 'Message us on Messenger.';
  if (/whatsapp|\bwa\b/i.test(cta)) return language === 'zh' ? '通过 WhatsApp 联系我们。' : 'Message us on WhatsApp.';
  // Enterprise settings sometimes store workflow language rather than public
  // copy. Normalize those cases, while preserving an already publishable CTA
  // verbatim so every configured action, qualifier and duration remains visible.
  if (/引导跳转|以触达|触达客户/.test(cta)) {
    if (/目录|资料/.test(cta)) return language === 'zh' ? '联系我们获取已核实的产品资料。' : 'Message us for verified product details.';
    return language === 'zh' ? '联系我们了解已核实的产品信息。' : 'Message us for verified product details.';
  }
  return cta;
}

function compactMaterialCtaVoice(primaryCta: string, language: string): string {
  const cta = canonicalMaterialPrimaryCta(primaryCta, language);
  if (!cta) return '无';
  if (language === 'zh') {
    if (/发送|提交|发来|分享/.test(cta) && /预约/.test(cta) && /30\s*分钟/.test(cta) && /英文/.test(cta) && /诊断|评估|方案|咨询/.test(cta)) {
      const item = /工件/.test(cta) ? '工件' : /节拍/.test(cta) ? '节拍' : /缺陷/.test(cta) ? '缺陷样本' : /布局/.test(cta) ? '现场布局' : '关键资料';
      return `发${item}，预约30分钟英文方案诊断。`;
    }
    return safeStoryboardCta(cta, language);
  }
  if (/send|share|submit/i.test(cta) && /book|schedule|预约/i.test(cta) && /30\s*(?:minutes?|mins?)/i.test(cta)) {
    return 'Share one key input and book a 30-minute solution review.';
  }
  return safeStoryboardCta(cta, language);
}

/**
 * Material scripts must carry the complete enterprise CTA deterministically.
 * A short spoken CTA may differ from the full on-screen CTA; the final caption
 * remains the canonical source of truth and is exempt from voice/caption parity.
 */
export function ensureMaterialCanonicalCta(
  script: string,
  primaryCta: string,
  language: string,
  includeVoice = true,
): string {
  const canonical = canonicalMaterialPrimaryCta(primaryCta, language);
  if (!canonical) return script;
  const blocks = String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m);
  const lastSceneIndex = blocks.map((block, index) => /^\s*\[\s*\d/.test(block) ? index : -1).filter(index => index >= 0).pop();
  if (lastSceneIndex == null) return script;
  let block = blocks[lastSceneIndex]!;
  const voice = includeVoice ? compactMaterialCtaVoice(primaryCta, language) : '无';
  const setField = (field: string, value: string) => {
    const pattern = new RegExp(`^[ \\t]*${field}[：:].*$`, 'm');
    if (pattern.test(block)) block = block.replace(pattern, `${field}：${value}`);
    else block = `${block.replace(/\s+$/, '')}\n${field}：${value}\n`;
  };
  setField('镜头功能', 'CTA');
  setField('台词', voice);
  setField('字幕', canonical);
  blocks[lastSceneIndex] = block;
  return blocks.join('');
}

export function buildSafeCloneStoryboard(
  script: string,
  productInfo: string,
  primaryCta: string,
  language: string,
  voiceoverMode: string,
  targetAudience = '',
): string {
  const ranges = Array.from(String(script || '').matchAll(/\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\]/g))
    .map(match => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter((range, index, all) => range.end > range.start && all.findIndex(item => item.start === range.start && item.end === range.end) === index);
  if (!ranges.length) return script;
  const names = selectedProductNames(productInfo);
  const productName = names[0] || (language === 'zh' ? '已选产品' : 'the selected product');
  const audienceHook = /automation/i.test(targetAudience)
    ? '采购，自动化风险怎么判断？'
    : /engineering|engineer/i.test(targetAudience)
      ? '采购，工程风险怎么判断？'
      : /plant/i.test(targetAudience)
        ? '采购，工厂风险怎么判断？'
        : '采购，这个风险怎么判断？';
  const silent = voiceoverMode === 'none';
  return ranges.map((range, index) => {
    const last = index === ranges.length - 1;
    const duration = Math.max(0.5, range.end - range.start);
    let caption = last
      ? safeStoryboardCta(primaryCta, language)
      : index === 0
        ? (language === 'zh' ? audienceHook : 'Buyers, how do you judge this risk?')
        : (language === 'zh' ? `核对${productName}可见细节。` : `Check the visible details of ${productName}.`);
    if (!silent) {
      caption = fitSpeechToShot(caption, duration);
      if (storyboardSpeechIssues(`[0-${duration}s]\n台词：${caption}`).length > 0) {
        caption = last
          ? shortStoryboardCta(primaryCta, language)
          : index === 0
            ? (language === 'zh' ? '采购，怎么判断？' : 'Buyers, how do you judge it?')
            : (language === 'zh' ? '核对可见细节。' : 'Check visible details.');
      }
    }
    const purpose = index === 0 ? '主题钩子' : last ? 'CTA' : '产品证据';
    const visual = index === 0
      ? `展示${productName}实际可见的现场状态`
      : last
        ? `展示${productName}并叠加唯一行动提示`
        : `展示${productName}实际可见细节`;
    return `[${range.start}-${range.end}s]\n环境：企业产品现场\n景别：${index === 0 ? '中景' : '特写'}\n运镜：${index % 2 ? '固定镜头' : '缓慢推进'}\n构图：产品主体居中\n镜头功能：${purpose}\n画面：${visual}\n配乐：轻量中性节奏\n台词：${silent ? '无' : caption}\n字幕：${caption}`;
  }).join('\n\n');
}

export function clearStoryboardSpeech(script: string): string {
  const blocks = String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m);
  return blocks.map(block => {
    if (!/^\s*\[\s*\d/.test(block)) return block;
    let next = block;
    if (/^[ \t]*台词[：:]/m.test(next)) next = next.replace(/^[ \t]*台词[：:].*$/m, '台词：无');
    else next = `${next.replace(/\s+$/, '')}\n台词：无\n`;
    if (/^[ \t]*字幕[：:]/m.test(next)) next = next.replace(/^[ \t]*字幕[：:].*$/m, '字幕：无');
    else next = next.replace(/^(台词[：:]无)$/m, '$1\n字幕：无');
    return next;
  }).join('');
}

export function safeProductScenes(productInfo: string, count: number): LockedStoryboardScene[] {
  const names = selectedProductNames(productInfo);
  const facts = productFactCandidates(productInfo);
  return Array.from({ length: count }, (_, index) => {
    const nameIndex = index <= 1 ? 0 : Math.min(1, Math.max(0, names.length - 1));
    const productName = names[nameIndex] || '已选产品';
    const last = index === count - 1;
    const fact = facts[Math.max(0, index - 1)] || '';
    return ({
    environment: '待匹配真实产品或现场素材', shot: index === 0 ? '中近景' : index === count - 1 ? '全景' : '特写',
    camera: index % 2 ? '固定镜头' : '缓慢推进', composition: '产品主体与资料可验证的细节清晰可见',
    purpose: index === 0 ? '主题钩子' : last ? 'CTA' : '产品证据',
    visual: index === 0
      ? `待匹配${productName}的真实整机或现场全貌；外观、颜色与环境完全以素材为准`
      : last
        ? `待匹配${productName}的真实产品画面并叠加唯一行动提示`
        : fact
          ? `待匹配能够证明“${fact}”的真实操作、结构或数据界面；素材无法证明时标记待补`
          : `待匹配${productName}的真实产品细节；仅展示资料与素材共同支持的内容`,
    music: last ? '轻提示音' : '轻量中性节奏',
    });
  });
}
export function parseLockedStoryboardScenes(raw: string, expectedCount: number): LockedStoryboardScene[] {
  try {
    const parsed = JSON.parse(String(raw).replace(/```json|```/gi, '').trim()) as { scenes?: unknown };
    if (!Array.isArray(parsed.scenes) || parsed.scenes.length !== expectedCount) return [];
    return parsed.scenes.map(item => {
      const scene = item as Record<string, unknown>;
      return {
        environment: String(scene.environment || '').trim(), shot: String(scene.shot || '').trim(), camera: String(scene.camera || '').trim(),
        composition: String(scene.composition || '').trim(), purpose: String(scene.purpose || '').trim(), visual: String(scene.visual || '').trim(), music: String(scene.music || '无').trim() || '无',
      };
    }).filter(scene => Object.values(scene).every(Boolean));
  } catch { return []; }
}
export function lockedVoiceDurations(lines: string[]): number[] {
  return lines.map(voice => {
    const chars = Array.from(voice.replace(/[\s，。！？、；：,.!?;:“”"'（）()]/g, '')).length;
    const words = voice.split(/\s+/).filter(Boolean).length;
    const spoken = /[\u3400-\u9fff]/.test(voice) ? chars / 4.5 : words / 2.5;
    return Math.max(2.4, +(spoken + 0.95).toFixed(1));
  });
}
export function serializeLockedStoryboard(scenes: LockedStoryboardScene[], lines: string[], targetDuration = 0): string {
  const naturalDurations = lockedVoiceDurations(lines);
  const naturalTotal = naturalDurations.reduce((sum, duration) => sum + duration, 0);
  const requestedTotal = Number(targetDuration) || 0;
  const scaleToRequestedTotal = requestedTotal >= scenes.length * 2.4 && requestedTotal >= naturalTotal;
  const durations = scaleToRequestedTotal
    ? naturalDurations.map(duration => duration * requestedTotal / naturalTotal)
    : naturalDurations;
  let cursor = 0;
  return scenes.map((scene, index) => {
    const voice = lines[index] || '';
    const duration = durations[index] || 2.4;
    const end = scaleToRequestedTotal && index === scenes.length - 1
      ? requestedTotal
      : +(cursor + duration).toFixed(1);
    const block = `[${cursor}-${end}s]\n环境：${scene.environment}\n景别：${scene.shot}\n运镜：${scene.camera}\n构图：${scene.composition}\n镜头功能：${scene.purpose}\n画面：${scene.visual}\n配乐：${scene.music}\n台词：${voice}\n字幕：${voice}`;
    cursor = end;
    return block;
  }).join('\n\n');
}

export function repairMaterialScript(script: string, productInfo: string, materialsText: string): string {
  let repaired = dedupeStoryboardFieldLines(normalizeStoryboardFieldLines(script));
  const unsupportedNumbers = Array.from(repaired.matchAll(/\d+(?:\.\d+)?\s*(?:瓶|ml|ML|毫升|kg|KG|g|克|斤|cm|厘米|mm|毫米|天|day|days|Days|秒|%|个|pcs|件|箱|元|美元)/g))
    .map(match => match[0])
    .filter(claim => !productInfoSupportsNumericClaim(claim, productInfo));
  for (const claim of unsupportedNumbers) repaired = repaired.replaceAll(claim, '');
  const evidence = `${productInfo}\n${materialsText}`.toLowerCase();
  const unsupportedEffects: Array<[RegExp, string[], string]> = [
    [/迅速吸收|快速吸收|瞬时渗透|即时渗透|一触即融|吸收|渗透/g, ['迅速吸收', '快速吸收', '瞬时渗透', '即时渗透', '一触即融', '吸收', '渗透'], '质地细节'],
    [/淡纹|去皱|紧致|抗衰|抗老/g, ['淡纹', '去皱', '紧致', '抗衰', '抗老'], '产品细节'],
    [/美白|提亮|祛斑/g, ['美白', '提亮', '祛斑'], '外观表现'],
    [/祛痘|抗炎|修复屏障|无刺激|敏感肌可用/g, ['祛痘', '抗炎', '修复屏障', '无刺激', '敏感肌可用'], '使用展示'],
  ];
  for (const [pattern, terms, neutral] of unsupportedEffects) {
    if (!terms.some(term => evidence.includes(term.toLowerCase()))) repaired = repaired.replace(pattern, neutral);
  }
  repaired = repaired.replace(/[：:]\s*([，。；,.!?！？])+/g, '：无').replace(/[ ]{2,}/g, ' ').trim();
  return fitStoryboardSpeech(repaired);
}

export function materialGroundingIssues(script: string, productInfo: string, materialsText: string, targetBuyerText = ''): string[] {
  const evidence = `${productInfo}\n${materialsText}`.toLowerCase();
  const claimGroups = [
    ['迅速吸收', '快速吸收', '瞬时渗透', '即时渗透', '一触即融', '吸收', '渗透'],
    ['淡纹', '去皱', '紧致', '抗衰', '抗老'],
    ['美白', '提亮', '祛斑'],
    ['祛痘', '抗炎', '修复屏障', '无刺激', '敏感肌可用'],
    ['防水', '耐摔', '不易破损', '承重'],
  ];
  const issues: string[] = [];
  for (const group of claimGroups) {
    const used = group.filter(term => script.toLowerCase().includes(term.toLowerCase()));
    if (used.length && !group.some(term => evidence.includes(term.toLowerCase()))) {
      issues.push(`素材/产品资料未支持的效果描述：${used.join('、')}`);
    }
  }
  // Closed-world visual facts: these nouns/states are commonly hallucinated
  // from an unrelated recommended benchmark. They are allowed only when the
  // selected material observations or approved product facts mention them.
  const visualFactGroups = [
    ['展会', '展馆', '展台', '观众', 'imtex', 'exhibition', 'trade show'],
    ['展板', '标识', 'logo', 'brand mark'],
    ['屏幕', '界面', '检测结果', '识别结果', 'dashboard', 'interface', 'inspection result'],
    ['正在运行', '实时运行', '运转中', 'running live', 'in operation'],
    ['划伤', '字符识别', 'scratch detection', 'ocr'],
  ];
  for (const group of visualFactGroups) {
    const used = group.filter(term => script.toLowerCase().includes(term));
    if (used.length && !group.some(term => evidence.includes(term))) {
      issues.push(`已选素材观察未支持的画面事实：${used.join('、')}`);
    }
  }
  const outputEntities = Array.from(script.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z][A-Za-z0-9]*)+\b/g))
    .map(match => match[0]!.trim())
    .filter(term => !/^(CTA|AI|OEM|ODM|B2B|VO)$/i.test(term))
    .filter(term => !isBusinessRoleEntity(term, targetBuyerText));
  for (const entity of outputEntities) {
    if (!evidence.includes(entity.toLowerCase())) issues.push(`已选素材/产品资料未支持的品牌或设备名：${entity}`);
  }
  return Array.from(new Set(issues));
}

export function materialTimelineIssues(script: string, infos: ScriptMaterialInfo[]): string[] {
  const ranges = Array.from(String(script).matchAll(/^\s*\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\]/gm))
    .map(match => ({ start: Number(match[1]), end: Number(match[2]) }));
  const issues: string[] = [];
  if (ranges.length !== infos.length) issues.push(`分镜数量与已选素材不一致（${ranges.length}/${infos.length}）`);
  ranges.forEach((range, index) => {
    const info = infos[index];
    if (!info) return;
    const expectedStart = Number(info.targetStart || 0);
    const expectedEnd = Number(info.targetEnd || expectedStart);
    if (Math.abs(range.start - expectedStart) > 0.05 || Math.abs(range.end - expectedEnd) > 0.05) {
      issues.push(`第${index + 1}段时间线超出已选素材可用区间（应为 ${expectedStart}-${expectedEnd}s）`);
    }
  });
  return issues;
}

type ScriptMaterialInfo = {
  name?: string;
  type?: string;
  folder?: string;
  duration?: number;
  effectiveDuration?: number;
  role?: string;
  targetStart?: number;
  targetEnd?: number;
  industry?: string;
  shotFunction?: string;
  tags?: string;
  observations?: string[];
};

export function requiresMinimumVoiceoverLines(voiceoverMode: unknown, generationMode: unknown): boolean {
  return voiceoverMode === 'ai' && generationMode !== 'clone';
}

export const MAX_INTERACTIVE_SCRIPT_REPAIR_ATTEMPTS = 1;

/** Keep editorial preferences visible without discarding a safe storyboard. */
export function isNonBlockingScriptQualityIssue(issue: string): boolean {
  return /^(?:未使用本条唯一主 CTA|已选择 AI 口播，但有效台词不足两段|首段没有|分镜功能重复|美妆产品本体镜头不足|本次脚本与上一版本过于相似|爆款分镜包含不可执行的泛化镜头描述)/.test(String(issue || '').trim());
}

export function normalizeMaterialInfos(value: unknown, fallbackNames: unknown, totalDuration: number): ScriptMaterialInfo[] {
  const raw = Array.isArray(value) ? value : [];
  const selectedNames = new Set(Array.isArray(fallbackNames) ? fallbackNames.map(item => String(item).trim()).filter(Boolean) : []);
  const selectedRaw = selectedNames.size
    ? raw.filter(item => selectedNames.has(String(item && typeof item === 'object' ? (item as Record<string, unknown>).name || '' : '').trim()))
    : raw;
  let cursor = 0;
  const fromInfos = selectedRaw.reduce<ScriptMaterialInfo[]>((acc, item) => {
    const obj = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const name = String(obj.name || '').trim();
    if (!name) return acc;
    const slot = Math.max(0.5, totalDuration / Math.max(1, selectedRaw.length || 1));
    const sourceDuration = Math.max(0.1, Number(obj.duration) || slot);
    const usableDuration = Math.min(sourceDuration, Math.max(0.1, Number(obj.effectiveDuration) || sourceDuration));
    const requestedLength = Math.max(0.1, Number(obj.targetEnd) - Number(obj.targetStart));
    const clipLength = Math.min(usableDuration, Number.isFinite(requestedLength) ? requestedLength : usableDuration);
    const start = +cursor.toFixed(1);
    const end = +(cursor + clipLength).toFixed(1);
    cursor = end;
    acc.push({
      name,
      type: String(obj.type || 'video'),
      folder: String(obj.folder || 'upload'),
      duration: sourceDuration,
      effectiveDuration: usableDuration,
      role: String(obj.role || ''),
      targetStart: start,
      targetEnd: end,
      industry: String(obj.industry || ''),
      shotFunction: String(obj.shotFunction || ''),
      tags: String(obj.tags || ''),
      observations: Array.isArray(obj.observations) ? obj.observations.map(String).filter(Boolean).slice(0, 6) : [],
    });
    return acc;
  }, []);
  if (fromInfos.length) return fromInfos.slice(0, 8);

  const names = Array.isArray(fallbackNames) ? fallbackNames.map(String).filter(Boolean) : [];
  const slot = Math.max(2, totalDuration / Math.max(1, names.length || 1));
  return names.slice(0, 8).map((name, index) => ({
    name,
    type: 'video',
    folder: 'upload',
    duration: slot,
    effectiveDuration: slot,
    role: '素材片段',
    targetStart: +(index * slot).toFixed(1),
    targetEnd: +(index === names.length - 1 ? totalDuration : (index + 1) * slot).toFixed(1),
  }));
}

export function materialInfoLines(infos: ScriptMaterialInfo[]): string {
  return infos.map((info, index) => [
    `${index + 1}. 素材名：${info.name}`,
    `类型：${info.type || 'video'}`,
    `角色：${materialRoleFromFolder(info)}`,
    `原始时长：${Number(info.duration || 0).toFixed(1)}s`,
    `建议有效时长：${Number(info.effectiveDuration || Math.max(0, Number(info.targetEnd || 0) - Number(info.targetStart || 0))).toFixed(1)}s`,
    `建议时间段：${Number(info.targetStart || 0).toFixed(1)}-${Number(info.targetEnd || 0).toFixed(1)}s`,
    info.industry ? `行业：${info.industry}` : '',
    info.shotFunction ? `镜头功能标签：${info.shotFunction}` : '',
    info.tags ? `人工/运营标签：${info.tags}` : '',
    info.observations?.length ? `已确认或待复核的分段观察：${info.observations.join(' | ')}` : '没有视频级分段观察，只能依据素材名和标签做保守剪辑',
  ].filter(Boolean).join('；')).join('\n');
}
