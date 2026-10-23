import { compactProductLabel } from './studioScriptNormalization.js';

function productField(productInfo: string, label: string): string {
  const match = String(productInfo || '').match(new RegExp(`${label}[：:]\\s*([^\\n]+)`));
  return match?.[1]?.trim() || '';
}

function firstProductField(productInfo: string, labels: string[]): string {
  for (const label of labels) {
    const value = productField(productInfo, label);
    if (value) return value;
  }
  return '';
}

export function productBrief(productInfo: string) {
  const name = compactProductLabel(productInfo);
  const category = firstProductField(productInfo, ['所属类目', '产品类目']) || '目标采购场景';
  const highlights = conservativeClaim(firstProductField(productInfo, ['产品卖点', '核心优势']));
  const moq = firstProductField(productInfo, ['起订量', 'MOQ']);
  const cert = firstProductField(productInfo, ['认证资质', '认证']);
  const price = firstProductField(productInfo, ['价格区间', '价格']);
  const detailPoints = [
    ['容量', firstProductField(productInfo, ['容量'])],
    ['杯体材质', firstProductField(productInfo, ['杯体材质'])],
    ['刀片材质', firstProductField(productInfo, ['刀片材质'])],
    ['材质', firstProductField(productInfo, ['材质', '产品材质'])],
    ['充电方式', firstProductField(productInfo, ['充电方式'])],
    ['尺寸', firstProductField(productInfo, ['尺寸', '产品尺寸'])],
    ['规格', firstProductField(productInfo, ['规格'])],
  ].filter((item): item is string[] => Boolean(item[1])).map(([label, value]) => `${label} ${value}`);
  const highlightPoints = highlights.split(/[、,，;；\n]/).map(item => item.trim()).filter(Boolean);
  const pointList = [
    ...detailPoints,
    ...highlightPoints,
    cert && cert !== '可按需求确认' ? `认证 ${cert}` : '',
    moq && moq !== '可按需求确认' ? `起订量 ${moq}` : '',
    price ? `报价 ${price}` : '',
  ].filter(Boolean);
  return {
    name,
    category,
    highlights,
    moq,
    cert,
    price,
    firstPoint: pointList[0] || highlights || name,
    secondPoint: pointList[1] || pointList[0] || name,
    thirdPoint: pointList[2] || pointList[1] || pointList[0] || name,
    detailPoints,
    highlightPoints,
    naturalTrustPoint: cert && cert !== '可按需求确认' ? '认证和检测资料能不能一次给齐' : '样品和资料能不能按需求确认',
  };
}

export function compactBriefCategory(p: ReturnType<typeof productBrief>): string {
  const items = String(p.category || '').split(/[、,，/]/).map(item => item.trim()).filter(Boolean);
  if (p.name && items.some(item => p.name.includes(item) || item.includes(p.name))) return p.name;
  return items[0] || p.name || '产品';
}

function conservativeClaim(value: string): string {
  return String(value || '')
    .replace(/大风吹不烂/g, '不易撕裂，抗拉表现可打样测试')
    .replace(/吹不烂|不破|不裂|纹丝不动/g, '不易撕裂')
    .replace(/最耐用|最便宜|全网|保证/g, '可按需求确认')
    .trim();
}

