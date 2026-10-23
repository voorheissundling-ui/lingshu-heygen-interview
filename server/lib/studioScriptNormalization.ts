export function compactProductLabel(productInfo: string): string {
  const names = Array.from(String(productInfo || '').matchAll(/产品名称[：:]\s*([^\n]+)/g))
    .map(match => String(match[1] || '').trim())
    .filter(name => name && !/^(this product|主推产品|企业产品组合)$/i.test(name));
  if (names.length) return names.join(' + ').slice(0, 120);
  const match = String(productInfo || '').match(/(?:主推品|产品类目|所属类目|Product|product)\s*[：:]\s*([^\n]+)/i);
  const fallback = String(match?.[1] || String(productInfo || '').split('\n')[0] || '').trim();
  return fallback && !/^(this product|主推产品|企业产品组合)$/i.test(fallback) ? fallback.slice(0, 80) : '选定产品';
}

export function stripScriptAnalysisSummary(text: string): string {
  const value = String(text || '').trim();
  const forbiddenBlockRe = /^\s*(?:【?\s*)?(?:基础要求|分析摘要|竞品识别|产品替换|参考爆款|成片目标|指定画风|核心情绪|参考品牌|口播语言|爆点拆解|产品承接|Purpose|Creative style|Core emotion|Product replacement|Voiceover language|Goal|Storyboard)(?:\s*】)?\s*[：:].*$/i;
  const firstTimestamp = value.search(/(?:^|\n)\s*(?:\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\]|Scene\s+\d+\s*\()/i);
  if (firstTimestamp > 0) {
    const head = value.slice(0, firstTimestamp);
    if (/基础要求|分析摘要|竞品识别|产品替换|参考爆款|成片目标|指定画风|核心情绪|对标视频|参考品牌|口播语言/.test(head)) {
      return value.slice(firstTimestamp).trim();
    }
  }
  return value.split(/\n+/).filter(line => !forbiddenBlockRe.test(line)).join('\n').trim();
}

export function normalizeScriptTimestamps(value: string): string {
  const clean = (raw: string) => {
    const number = Number(raw);
    return Number.isFinite(number) ? number.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') : raw;
  };
  return String(value || '').replace(
    /\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\]/gi,
    (_match, start, end) => `[${clean(start)}-${clean(end)}s]`,
  );
}

export function enforceProductNameInScript(script: string, productInfo: string): string {
  const productName = compactProductLabel(productInfo).trim();
  if (!productName || /^(this product|主推产品|企业产品组合)$/i.test(productName)) return script;
  return String(script || '')
    .replace(/「企业产品组合」|“企业产品组合”|企业产品组合/g, `「${productName}」`)
    .replace(/「主推产品」|“主推产品”|主推产品/g, `「${productName}」`)
    .replace(/\bthis product\b/gi, productName);
}

export function ensureSelectedProductNamesInScript(script: string, productInfo: string): string {
  const names = selectedProductNames(productInfo);
  let next = String(script || '');
  for (const name of names) {
    if (!name || normalizeProductIdentity(next).includes(normalizeProductIdentity(name))) continue;
    const blocks = next.split(/(?=^\[[^\]\r\n]+\][ \t]*$)/m);
    const index = blocks.findIndex(block => /^\[[^\]]+\]/.test(block) && /^画面[：:]/m.test(block)
      && !/^画面[：:]\s*数字人[：:]/m.test(block));
    if (index < 0) continue;
    blocks[index] = blocks[index]!.replace(/^(画面[：:]\s*)([^\n]*)/m, (_line, prefix, visual) => `${prefix}${visual ? `${visual}；` : ''}展示 ${name}`);
    next = blocks.join('');
  }
  return next;
}

export function selectedProductNames(productInfo: string): string[] {
  return Array.from(String(productInfo || '').matchAll(/产品名称[：:]\s*([^\n]+)/g))
    .map(match => String(match[1] || '').trim()).filter(Boolean);
}

export function productFactCandidates(productInfo: string): string[] {
  const factLines = String(productInfo || '').split('\n').flatMap(line => {
    const match = line.match(/^(?:产品卖点|核心优势|已核实事实|产品规格|规格参数)[：:]\s*(.+)$/i);
    return match?.[1] ? match[1].split(/[；;。]\s*/) : [];
  });
  return Array.from(new Set(factLines.map(item => item.trim()).filter(Boolean)));
}

export function dedupeStoryboardProductNameSubtitles(script: string, productInfo: string): string {
  const names = selectedProductNames(productInfo);
  if (!names.length) return script;
  const seen = new Set<string>();
  return String(script || '').split('\n').map(line => {
    if (!/^字幕[：:]/.test(line)) return line;
    let next = line;
    for (const name of names) {
      if (!next.includes(name)) continue;
      if (seen.has(name)) next = next.replace(name, '产品');
      else seen.add(name);
    }
    return next;
  }).join('\n');
}

export function normalizeProductIdentity(value: string): string {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s\u00a0「」“”"'（）()【】\[\]·•・,，。；;：:!！?？/_-]+/g, '');
}

function normalizeScriptPart(value: string): string {
  return String(value || '').replace(/\d+(?:\.\d+)?\s*(?:s|秒|天|day|days|%|个|pcs|件|箱|元|美元)?/gi, '#')
    .replace(/[「」"“”'（）()【】\[\],，。；;：:\s/]+/g, '').replace(/企业产品组合|主推产品|thisproduct/gi, '产品').toLowerCase();
}

function extractField(block: string, labels: string[]): string {
  for (const label of labels) {
    const match = block.match(new RegExp(`${label}\\s*[：:]\\s*([^\\n]+)`, 'i'));
    if (match?.[1]) return match[1].trim();
  }
  return block.trim();
}

export function jaccardSimilarity(a: string, b: string): number {
  const grams = (text: string) => {
    const normalized = normalizeScriptPart(text);
    const out = new Set<string>();
    for (let i = 0; i < Math.max(1, normalized.length - 1); i += 1) out.add(normalized.slice(i, i + 2));
    return out;
  };
  const left = grams(a), right = grams(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  left.forEach(item => { if (right.has(item)) overlap += 1; });
  return overlap / Math.max(left.size, right.size);
}

export function hasRepetitiveStoryboard(script: string): boolean {
  const blocks = String(script || '').split(/(?=\n?\s*(?:\[\s*\d+(?:\.\d+)?\s*[-–]\s*\d+(?:\.\d+)?\s*s?\s*\]|Scene\s+\d+\s*\())/i)
    .map(item => item.trim()).filter(item => item.length > 20);
  if (blocks.length < 3) return false;
  const visualKeys = blocks.map(block => normalizeScriptPart(extractField(block, ['画面', 'Visual'])));
  const voiceKeys = blocks.map(block => normalizeScriptPart(extractField(block, ['人物说', '台词', 'Voiceover'])));
  const repeatedVisuals = visualKeys.filter((key, index) => key && visualKeys.indexOf(key) !== index).length;
  const repeatedVoices = voiceKeys.filter((key, index) => key && voiceKeys.indexOf(key) !== index).length;
  if (repeatedVisuals >= 2 || repeatedVoices >= 2) return true;
  let similarPairs = 0;
  for (let i = 1; i < blocks.length; i += 1) if (jaccardSimilarity(blocks[i - 1]!, blocks[i]!) > 0.72) similarPairs += 1;
  return similarPairs >= Math.max(2, Math.floor(blocks.length / 2));
}

const TECH_TERM_RE = /\b(?:CE|RoHS|UKCA|ETL|IES\/?LDT|LDT|IP\d{2,}|BSCI|REACH|ISO\d*|MOQ|OEM|ODM|SKU)\b|认证资质|认证|型号|光学文件|检测报告|参数|色温|显指|防护等级/gi;

export function hasUnnaturalVoiceover(script: string): boolean {
  return String(script || '').split(/\n+/).some(line => {
    const match = line.match(/(?:台词|人物说|Voiceover|VO|口播)\s*[：:]\s*(.+)$/i);
    if (!match?.[1]) return false;
    const text = match[1].replace(/\s+/g, ' ').trim();
    const tooLong = /[\u3400-\u9fff]/.test(text) ? Array.from(text.replace(/\s/g, '')).length > 72 : text.split(/\s+/).filter(Boolean).length > 20;
    return Array.from(text.matchAll(TECH_TERM_RE)).length >= 3 || tooLong || /CE[、,，\s]+RoHS[、,，\s]+UKCA/i.test(text);
  });
}
