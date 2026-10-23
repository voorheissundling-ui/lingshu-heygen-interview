export type StudioScriptQualityStatus = 'passed' | 'warning' | 'needs_material' | 'rejected';

export type StudioScriptMaterialInfo = {
  name?: string;
  targetStart?: number;
  targetEnd?: number;
  observations?: string[];
};

export type MaterialCoverage = {
  selectedMaterials: number;
  storyboardScenes: number;
  boundScenes: number;
  pendingScenes: number;
  coverageRatio: number;
};

export type StudioScriptQualityV2Result = {
  script: string;
  qualityStatus: StudioScriptQualityStatus;
  hardIssues: string[];
  warnings: string[];
  materialCoverage: MaterialCoverage;
};

const PRODUCT_FACT_CLAIM_GROUPS: string[][] = [
  ['治具校准', 'fixture calibration'],
  ['良率', 'yield rate', 'defect rate'],
  ['无补焊', '无飞线', 'rework-free'],
  ['高纯度', '高纯', '纯度', 'high purity', 'purity'],
  ['符合美国市场基础合规要求', '符合美国市场合规要求', '美国市场合规', 'us market compliance', 'us compliant'],
  ['合规要求', '合规标准', '基础合规', 'regulatory requirements', 'compliance requirements'],
  ['通过认证', '获得认证', '认证齐全', 'certified'],
];

const MATERIAL_VISUAL_FACT_GROUPS: string[][] = [
  ['展会', '展馆', '展台', '观众', 'imtex', 'exhibition', 'trade show'],
  ['展板', '标识', 'logo', 'brand mark'],
  ['屏幕', '界面', '检测结果', '识别结果', 'dashboard', 'interface', 'inspection result'],
  ['正在运行', '实时运行', '运转中', 'running live', 'in operation'],
  ['划伤', '字符识别', 'scratch detection', 'ocr'],
  ...PRODUCT_FACT_CLAIM_GROUPS,
];

// These details can only be asserted when the selected footage/image itself
// proves them. A product MOQ or contact email in structured enterprise data
// does not prove that the text, QR code or VI is visible in the asset.
const STRICT_MATERIAL_VISUAL_FACT_GROUPS: string[][] = [
  ['二维码', 'qr code'],
  ['邮箱', '电子邮件', 'email address', 'e-mail address'],
  ['for sensitive skin'],
  ['标签已有', '标签印有', '标签显示', '标签上有', '标签文字', '标签字样', '瓶身印有', '包装印有', 'label reads', 'printed on label'],
  ['品牌vi', 'vi标识', 'vi 标识', 'vi字样', 'vi 字样', 'visual identity'],
];

const BUSINESS_ROLE_TERMS = [
  'factory automation manager', 'automation manager', 'automation lead',
  'engineering manager', 'plant manager', 'factory manager', 'project buyer',
  'equipment manager', 'production manager', 'process manager', 'process engineer',
  'quality manager', 'qa manager', 'procurement manager', 'procurement', 'buyer',
  'sourcing manager', 'supply chain manager', 'system integrator',
  'brand founder', 'brand owner', 'product manager', 'channel buyer',
  'importer', 'distributor',
];

function normalized(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/[\s,，、/]+/g, ' ');
}

export function normalizeNumericEvidenceText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00A0\t\f\v ]+/g, ' ')
    .trim();
}

const NUMERIC_FACT_PATTERN = /(\d+(?:\.\d+)?)\s*(瓶|bottles?|ml|毫升|kg|千克|公斤|g|克|斤|cm|厘米|mm|毫米|天|day|days|秒|seconds?|secs?|s\b|帧|frames?|fps|%|percent|个|pcs?|pieces?|件|箱|cartons?|boxes?|元|美元|usd|rmb|cny)/gi;

export function numericClaimIsProductionParameter(claim: string, line: string): boolean {
  const normalizedClaim = normalizeNumericEvidenceText(claim).toLowerCase();
  if (!/(?:秒|seconds?|secs?|s|帧|frames?|fps)$/.test(normalizedClaim)) return false;
  const normalizedLine = String(line || '').trim();
  if (/^\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\]$/i.test(normalizedLine)) return true;
  const field = normalizedLine.match(/^([^:：]{1,12})[:：]/)?.[1] || '';
  if (!/^(?:时间轴|时长|剪辑|转场|配乐|音效|镜头功能|运镜|构图|环境|景别|画面|素材)$/i.test(field)) return false;
  if (/^(?:配乐|音效)$/.test(field) && /(?:音效|提示音|余韵|铺底|脉冲|音乐|静音)/.test(normalizedLine)) return true;
  if (/(?:帧|frames?|fps)$/.test(normalizedClaim) && /^(?:时间轴|时长|剪辑|转场|运镜|镜头功能)$/i.test(field)) return true;
  if (/(?:第\s*)?\d+(?:\.\d+)?\s*(?:秒|seconds?|secs?|s\b)/i.test(normalizedLine) && /第\s*\d/i.test(normalizedLine)) return true;
  return /(?:持续|停留|留|淡入|淡出|转场|剪辑|节奏|静音|定格|推进|拉远|平移|镜头|画面|片头|片尾|起止|时长|帧率|fps)/i.test(normalizedLine);
}

function numericUnitGroup(unit: string): string {
  const value = unit.toLowerCase();
  if (['瓶', 'bottle', 'bottles'].includes(value)) return 'bottle';
  if (['ml', '毫升'].includes(value)) return 'ml';
  if (['kg', '千克', '公斤'].includes(value)) return 'kg';
  if (['g', '克'].includes(value)) return 'g';
  if (['cm', '厘米'].includes(value)) return 'cm';
  if (['mm', '毫米'].includes(value)) return 'mm';
  if (['天', 'day', 'days'].includes(value)) return 'day';
  if (['秒', 's', 'second', 'seconds', 'sec', 'secs'].includes(value)) return 'second';
  if (['帧', 'frame', 'frames'].includes(value)) return 'frame';
  if (['%', 'percent'].includes(value)) return 'percent';
  if (['个', '件', 'pc', 'pcs', 'piece', 'pieces'].includes(value)) return 'piece';
  if (['箱', 'carton', 'cartons', 'box', 'boxes'].includes(value)) return 'carton';
  if (['美元', 'usd'].includes(value)) return 'usd';
  if (['元', 'rmb', 'cny'].includes(value)) return 'cny';
  return value;
}

export function productInfoSupportsNumericClaim(claim: string, productInfo: string): boolean {
  const normalizedClaim = normalizeNumericEvidenceText(claim);
  const source = normalizeNumericEvidenceText(productInfo);
  const parsed = Array.from(normalizedClaim.matchAll(NUMERIC_FACT_PATTERN))[0];
  if (!parsed) return false;
  const claimValue = Number(parsed[1]);
  const claimUnit = numericUnitGroup(parsed[2]!);
  if (!Number.isFinite(claimValue)) return false;
  for (const match of source.matchAll(NUMERIC_FACT_PATTERN)) {
    if (Number(match[1]) === claimValue && numericUnitGroup(match[2]!) === claimUnit) return true;
  }
  // Structured records sometimes keep the unit in the field semantics rather
  // than the value, for example `MOQ: 100`. This is valid only for count units.
  if (['bottle', 'piece', 'carton'].includes(claimUnit)) {
    const escaped = String(claimValue).replace('.', '\\.');
    return new RegExp(`(?:起订量|MOQ)[^\\n]{0,30}(?:^|\\D)${escaped}(?:\\D|$)`, 'i').test(source);
  }
  return false;
}

function evidenceSupportsTerm(evidence: string, term: string): boolean {
  const source = evidence.toLowerCase();
  const needle = term.toLowerCase();
  let cursor = source.indexOf(needle);
  while (cursor >= 0) {
    const prefix = source.slice(Math.max(0, cursor - 24), cursor);
    if (!/(?:未(?:观察到|发现|显示|出现)|没有|不存在|不含|无|not\s+(?:observed|visible|shown|present)|without|no)\s*[^，。;；\n]{0,36}$/i.test(prefix)) return true;
    cursor = source.indexOf(needle, cursor + needle.length);
  }
  return false;
}

export function storyboardSceneRanges(script: string): Array<{ start: number; end: number }> {
  return Array.from(String(script || '').matchAll(/^\s*\[\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\]/gm))
    .map(match => ({ start: Number(match[1]), end: Number(match[2]) }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
}

export function materialCoverageForScript(
  script: string,
  materialInfos: StudioScriptMaterialInfo[],
): MaterialCoverage {
  const storyboardScenes = storyboardSceneRanges(script).length;
  const selectedMaterials = new Set(materialInfos.map((info,index)=>info.name || `unnamed-${index}`)).size;
  const availableSceneSlots = materialInfos.reduce((total, info) => (
    total + Math.max(1, info.observations?.filter(Boolean).length || 0)
  ), 0);
  const explicitlyPending = (String(script || '').match(/^\s*素材[：:]\s*待匹配素材\s*$/gm) || []).length;
  const pendingScenes = Math.min(storyboardScenes, Math.max(
    explicitlyPending,
    Math.max(0, storyboardScenes - availableSceneSlots),
  ));
  const boundScenes = Math.max(0, storyboardScenes - pendingScenes);
  return {
    selectedMaterials,
    storyboardScenes,
    boundScenes,
    pendingScenes,
    coverageRatio: storyboardScenes > 0 ? Number((boundScenes / storyboardScenes).toFixed(2)) : 0,
  };
}

export function markUncoveredMaterialScenes(script: string, materialInfos: StudioScriptMaterialInfo[]): string {
  const availableSceneSlots = materialInfos.reduce((total, info) => (
    total + Math.max(1, info.observations?.filter(Boolean).length || 0)
  ), 0);
  let sceneIndex = 0;
  return String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m).map(block => {
    if (!/^\s*\[\s*\d/.test(block)) return block;
    const covered = sceneIndex < availableSceneSlots;
    sceneIndex += 1;
    if (covered) return block;
    let next = block;
    const replaceField = (field: string, value: string) => {
      const pattern = new RegExp(`^[ \\t]*${field}[：:].*$`, 'm');
      if (pattern.test(next)) next = next.replace(pattern, `${field}：${value}`);
      else next = `${next.replace(/\s+$/, '')}\n${field}：${value}\n`;
    };
    replaceField('素材', '待匹配素材');
    replaceField('环境', '按后续补充素材的实际环境');
    replaceField('构图', '仅使用后续补充素材中的实际可见内容');
    replaceField('镜头功能', '待补素材');
    replaceField('画面', '待匹配素材；需补充能够证明本段信息的实际画面');
    return next;
  }).join('');
}

export function isBusinessRoleEntity(entity: string, targetBuyerText = ''): boolean {
  const value = normalized(entity);
  if (!value) return false;
  if (BUSINESS_ROLE_TERMS.some(role => value === role || value.includes(role))) return true;
  const audience = normalized(targetBuyerText);
  if (audience && (audience.includes(value) || value.split(' ').every(part => audience.includes(part)))) return true;
  // Capitalized job titles are people/segments, not product identities. Keep
  // the suffix list intentionally narrow so a product such as "Vision System"
  // still needs evidence.
  return /\b(?:manager|buyer|engineer|director|officer|lead|owner|founder|procurement|purchaser|importer|distributor)s?$/.test(value);
}

export function unsupportedMaterialVisualTerms(
  script: string,
  productInfo: string,
  materialsText: string,
): string[] {
  const evidence = `${productInfo}\n${materialsText}`.toLowerCase();
  const used = MATERIAL_VISUAL_FACT_GROUPS.flatMap(group => {
    if (group.some(term => evidenceSupportsTerm(evidence, term))) return [];
    return group.filter(term => script.toLowerCase().includes(term.toLowerCase()));
  });
  used.push(...STRICT_MATERIAL_VISUAL_FACT_GROUPS.flatMap(group => {
    if (group.some(term => evidenceSupportsTerm(materialsText.toLowerCase(), term))) return [];
    return group.filter(term => script.toLowerCase().includes(term.toLowerCase()));
  }));
  return Array.from(new Set(used));
}

export function neutralizeUnsupportedMaterialVisuals(
  script: string,
  productInfo: string,
  materialsText: string,
  materialInfos: StudioScriptMaterialInfo[] = [],
): { script: string; warnings: string[]; neutralizedTerms: string[]; repairedTrustedScenes: number; pendingScenes: number } {
  const evidence = `${productInfo}\n${materialsText}`.toLowerCase();
  const unsupportedGroups = [
    ...MATERIAL_VISUAL_FACT_GROUPS.filter(group => !group.some(term => evidenceSupportsTerm(evidence, term))),
    ...STRICT_MATERIAL_VISUAL_FACT_GROUPS.filter(group => !group.some(term => evidenceSupportsTerm(materialsText.toLowerCase(), term))),
  ];
  const unsupportedTerms = unsupportedGroups.flat();
  const materialSlots = materialInfos.flatMap(info => {
    const observations = info.observations?.filter(Boolean) || [];
    return (observations.length ? observations : ['']).map(observation => ({
      name: String(info.name || '已选素材').trim() || '已选素材',
      observation: String(observation || '').trim(),
    }));
  });
  const safeObservation = (observation: string): string => {
    const positiveClauses = String(observation || '')
      .split(/[；;。\n]+/)
      .map(clause => clause.trim().replace(/^素材[：:]\s*/, ''))
      .filter(Boolean)
      .filter(clause => !/(?:未(?:观察到|发现|显示|出现)|没有|不存在|不含|无|not\s+(?:observed|visible|shown|present)|without|no\b)/i.test(clause))
      .filter(clause => !unsupportedTerms.some(term => clause.toLowerCase().includes(term.toLowerCase())));
    return positiveClauses.join('；') || '已选素材中的实际可见画面';
  };
  const safeShot = (value: string): string => (
    value.match(/中近景|特写|近景|中景|全景|远景/)?.[0] || '中景'
  );
  const safeCamera = (value: string): string => (
    value.match(/俯拍固定|固定微推进|缓慢推进|缓慢拉远|平移|跟拍|固定/)?.[0] || '固定'
  );
  const readField = (block: string, field: string): string => {
    const match = block.match(new RegExp(`^[ \\t]*${field}[：:]\\s*(.*)$`, 'm'));
    return String(match?.[1] || '').trim();
  };
  const containsUnsupportedTerm = (value: string): boolean => unsupportedTerms.some(term => (
    value.toLowerCase().includes(term.toLowerCase())
  ));
  const genericObservation = (value: string): boolean => {
    const observation = String(value || '').trim();
    if (!observation) return true;
    return /^(?:企业知识库产品[“"][^”"]+[”"]的)?已上传(?:图片|视频|素材)$/i.test(observation)
      || /^(?:uploaded|provided)\s+(?:image|video|asset)$/i.test(observation);
  };
  const neutralizedTerms = new Set<string>();
  let sceneIndex = 0;
  let repairedTrustedScenes = 0;
  let pendingScenes = 0;
  const blocks = String(script || '').split(/(?=^[ \t]*\[\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*[-–—]\s*\d+(?:\.\d+)?\s*(?:s|秒)?\s*\][ \t]*$)/m);
  const repaired = blocks.map(block => {
    if (!/^\s*\[\s*\d/.test(block)) return block;
    const slot = materialSlots[sceneIndex];
    sceneIndex += 1;
    const terms = unsupportedGroups.flatMap(group => group.filter(term => block.toLowerCase().includes(term.toLowerCase())));
    const observationOnlyConfirmsUpload = Boolean(slot && genericObservation(slot.observation));
    if (!terms.length && !observationOnlyConfirmsUpload) return block;
    terms.forEach(term => neutralizedTerms.add(term));
    if (observationOnlyConfirmsUpload) neutralizedTerms.add('素材观察仅确认文件已上传');
    let next = block;
    const replaceField = (field: string, value: string) => {
      const pattern = new RegExp(`^[ \\t]*${field}[：:].*$`, 'm');
      if (pattern.test(next)) next = next.replace(pattern, `${field}：${value}`);
      else next = `${next.replace(/\s+$/, '')}\n${field}：${value}\n`;
    };
    const alreadyPending = /^\s*素材[：:]\s*待匹配素材\s*$/m.test(block);
    if (!slot || alreadyPending) {
      pendingScenes += 1;
      replaceField('素材', '待匹配素材');
      replaceField('环境', '按后续补充素材的实际环境');
      replaceField('景别', '中景');
      replaceField('运镜', '固定');
      replaceField('构图', '仅使用后续补充素材中的实际可见内容');
      replaceField('镜头功能', '待补素材');
      replaceField('画面', '待匹配素材；需补充能够证明本段信息的实际画面');
      replaceField('配乐', '轻节奏铺底');
      // Unsupported visual facts must not survive in spoken or on-screen copy.
      // The CTA is deterministically restored after this pass by the caller.
      replaceField('台词', '无');
      replaceField('字幕', '无');
      return next;
    }

    repairedTrustedScenes += 1;
    const originalDialogue = readField(block, '台词');
    const originalSubtitle = readField(block, '字幕');
    const originalMusic = readField(block, '配乐');
    replaceField('素材', slot.name);
    if (observationOnlyConfirmsUpload) {
      replaceField('环境', '以已选素材原始画面为准');
      replaceField('景别', '保持原素材景别');
      replaceField('运镜', '不添加未确认运镜');
      replaceField('构图', '保持原素材构图');
      replaceField('镜头功能', '原素材展示');
      replaceField('画面', '原样展示已选素材；不补充未确认的物体、文字或动作');
    } else {
      replaceField('环境', '以已选素材实际环境为准');
      replaceField('景别', safeShot(readField(block, '景别')));
      replaceField('运镜', safeCamera(readField(block, '运镜')));
      replaceField('构图', '仅呈现已选素材中实际可见的主体');
      replaceField('镜头功能', '素材事实展示');
      replaceField('画面', `按已选素材观察呈现：${safeObservation(slot.observation)}`);
    }
    if (containsUnsupportedTerm(originalMusic)) replaceField('配乐', '轻节奏铺底');
    if (containsUnsupportedTerm(originalDialogue)) {
      replaceField('台词', '先看画面中的实际证据，再判断是否值得进一步沟通。');
    }
    if (containsUnsupportedTerm(originalSubtitle)) {
      replaceField('字幕', '先看画面中的实际证据，再判断是否值得进一步沟通。');
    }
    return next;
  }).join('');
  const terms = Array.from(neutralizedTerms);
  const warnings: string[] = [];
  if (repairedTrustedScenes > 0) {
    warnings.push(`已按已选素材的真实可见内容修复${repairedTrustedScenes}个分镜：${terms.join('、')}`);
  }
  if (pendingScenes > 0) {
    warnings.push(`素材未支持的画面已标记为待匹配素材：${terms.join('、')}`);
  }
  if (terms.length && !warnings.length) {
    warnings.push(`已将素材未支持的画面替换为待匹配素材：${terms.join('、')}`);
  }
  return {
    script: repaired,
    neutralizedTerms: terms,
    warnings,
    repairedTrustedScenes,
    pendingScenes,
  };
}

export function materialTimelineWarningsV2(
  script: string,
  infos: StudioScriptMaterialInfo[],
): string[] {
  const ranges = storyboardSceneRanges(script);
  const warnings: string[] = [];
  const availableSceneSlots = infos.reduce((total, info) => (
    total + Math.max(1, info.observations?.filter(Boolean).length || 0)
  ), 0);
  if (ranges.length > availableSceneSlots) {
    warnings.push(`素材覆盖不足：${ranges.length}个分镜仅有${availableSceneSlots}个可信素材片段，缺口分镜已标记为待匹配`);
  }
  ranges.slice(0, infos.length).forEach((range, index) => {
    const info = infos[index];
    if ((info?.observations?.filter(Boolean).length || 0) > 1) return;
    if (!info || info.targetStart == null || info.targetEnd == null) return;
    const expectedStart = Number(info.targetStart);
    const expectedEnd = Number(info.targetEnd);
    if (!Number.isFinite(expectedStart) || !Number.isFinite(expectedEnd)) return;
    if (Math.abs(range.start - expectedStart) > 0.05 || Math.abs(range.end - expectedEnd) > 0.05) {
      warnings.push(`第${index + 1}段需在成片前重新匹配素材可用区间（建议 ${expectedStart}-${expectedEnd}s）`);
    }
  });
  return warnings;
}

export function hardScriptSafetyIssues(script: string, productInfo: string): string[] {
  const issues: string[] = [];
  const absoluteClaims = Array.from(String(script || '').matchAll(/不破|不裂|纹丝不动|吹不烂|保证|最快|最低价|全网|零缺陷|绝不漏|永不漏|no tear|won'?t tear|never breaks?|unbreakable/gi))
    .map(match => match[0]);
  if (absoluteClaims.length) issues.push(`脚本包含绝对化或不可验证承诺：${Array.from(new Set(absoluteClaims)).join('、')}`);
  const unsupportedProductClaims = PRODUCT_FACT_CLAIM_GROUPS.flatMap(group => {
    if (group.some(term => evidenceSupportsTerm(productInfo.toLowerCase(), term))) return [];
    return group.filter(term => script.toLowerCase().includes(term.toLowerCase()));
  });
  if (unsupportedProductClaims.length) issues.push(`脚本包含产品资料未提供的声明：${Array.from(new Set(unsupportedProductClaims)).join('、')}`);
  // Visual evidence of equipment is not a test report for compatibility.
  // Require the complete assertion, including the compatible target, in the
  // product facts; an unrelated verified product must not license the claim.
  const unsupportedCompatibility = Array.from(script.matchAll(/(?:已验证兼容|兼容性已验证|verified compatible with|compatibility verified for)[^。！？.!?;\n；]*/gi))
    .map(match => match[0].trim())
    .filter(claim => !evidenceSupportsTerm(productInfo.toLowerCase(), claim.toLowerCase()));
  if (unsupportedCompatibility.length) issues.push(`脚本包含产品资料未验证的兼容性声明：${[...new Set(unsupportedCompatibility)].join('；')}`);
  const normalizedScript = normalizeNumericEvidenceText(script);
  const numericClaims = Array.from(normalizedScript.matchAll(NUMERIC_FACT_PATTERN))
    .filter(match => {
      const claim = match[0];
      if (productInfoSupportsNumericClaim(claim, productInfo)) return false;
      const start = normalizedScript.lastIndexOf('\n', match.index ?? 0) + 1;
      const end = normalizedScript.indexOf('\n', match.index ?? 0);
      const line = normalizedScript.slice(start, end < 0 ? normalizedScript.length : end).trim();
      if (numericClaimIsProductionParameter(claim, line)) return false;
      if (/%$/.test(claim) && /^(?:运镜|构图|环境|景别)[：:]/.test(line)) return false;
      if (/(?:个|件|瓶)$/.test(claim) && /^(?:运镜|构图|环境|景别|画面)[：:]/.test(line)) return false;
      if (/(?:cm|厘米|mm|毫米)$/i.test(claim) && /^(?:运镜|画面|构图|环境|景别)[：:]/.test(line)) return false;
      return true;
    })
    .map(match => match[0]);
  if (numericClaims.length) issues.push(`出现产品资料未提供的数字：${Array.from(new Set(numericClaims)).join('、')}`);
  return issues;
}

export function assessScriptQualityV2(input: {
  script: string;
  productInfo: string;
  materialsText: string;
  materialInfos: StudioScriptMaterialInfo[];
  primaryCta?: string;
  targetBuyerText?: string;
  hardIssues?: string[];
  warnings?: string[];
}): StudioScriptQualityV2Result {
  const coverageMarkedScript = markUncoveredMaterialScenes(input.script, input.materialInfos);
  const neutralized = neutralizeUnsupportedMaterialVisuals(
    coverageMarkedScript,
    input.productInfo,
    input.materialsText,
    input.materialInfos,
  );
  const materialCoverage = materialCoverageForScript(neutralized.script, input.materialInfos);
  const warnings = Array.from(new Set([
    ...neutralized.warnings,
    ...materialTimelineWarningsV2(neutralized.script, input.materialInfos),
    ...(input.warnings || []),
  ].filter(Boolean)));
  const hardIssues = Array.from(new Set([
    ...hardScriptSafetyIssues(neutralized.script, input.productInfo),
    ...(input.hardIssues || []),
  ].filter(Boolean)));
  const needsMaterial = materialCoverage.pendingScenes > 0 || neutralized.pendingScenes > 0;
  return {
    script: neutralized.script,
    qualityStatus: hardIssues.length ? 'rejected' : needsMaterial ? 'needs_material' : warnings.length ? 'warning' : 'passed',
    hardIssues,
    warnings,
    materialCoverage,
  };
}
