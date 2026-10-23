import {
  normalizeMaterialAssetV2,
  type MaterialAssetV2Metadata,
  type MaterialAssetRoleV2,
  type MaterialContentRoleV2,
} from './contracts/materialAssetV2.js';
import type { MaterialCapabilityManifest } from './contracts/materialCapabilityManifest.js';

export const IMAGE_DELIVERABLES = [
  'product_hero',
  'social_poster',
  'carousel_cover',
  'scenario_visual',
  'product_infographic',
] as const;
export type ImageDeliverable = typeof IMAGE_DELIVERABLES[number];

export const IMAGE_PRODUCTION_STRATEGIES = [
  'reuse_existing',
  'compose_assets',
  'reference_generate',
  'generate_supporting',
] as const;
export type ImageProductionStrategy = typeof IMAGE_PRODUCTION_STRATEGIES[number];

export const IMAGE_DELIVERABLE_LABELS: Record<ImageDeliverable, string> = {
  product_hero: '产品主视觉',
  social_poster: '社媒海报',
  carousel_cover: '轮播首图',
  scenario_visual: '产品场景图',
  product_infographic: '产品信息图',
};

export const MATERIAL_ASSET_ROLE_LABELS: Record<MaterialAssetRoleV2, string> = {
  exact_product: '精准产品素材',
  generic_scene_plate: '通用场景底图',
  fact_evidence: '事实证明素材',
  person_authorization: '人物授权素材',
  digital_human_input: '数字人输入',
  reusable_template: '可复用模板',
  supporting: '辅助素材',
};

export const MATERIAL_CONTENT_ROLE_LABELS: Record<MaterialContentRoleV2, string> = {
  product_front: '产品正面',
  product_side: '产品侧面',
  product_back: '产品背面',
  product_detail: '产品细节',
  transparent_cutout: '透明底产品图',
  label_artwork: '标签稿',
  packaging_dieline: '包装刀版',
  scene_plate: '场景底图',
  fact_evidence: '证书/报告',
  person_authorization: '人物授权',
  digital_human_portrait: '数字人肖像',
  digital_human_voice: '数字人声音',
  other: '其他内容',
};

export type MaterialDirectorInput = {
  type: string;
  name?: string;
  folder?: string;
  tags?: string;
  productId?: string;
  productName?: string;
  /** Generated derivatives may be product-related, but they are never the
   * source-of-truth pixels for exact product identity. */
  identityAuthority?: 'source' | 'derived';
  enterpriseCommon?: boolean;
  visualObservations?: string[];
  sourceRevision?: string;
};

const includesAny = (value: string, patterns: RegExp[]) => patterns.some(pattern => pattern.test(value));

function directorSceneType(text: string): string | null {
  if (/factory|production line|workshop|工厂|车间|产线|灌装|质检/i.test(text)) return 'factory';
  if (/warehouse|仓库|仓储|货架/i.test(text)) return 'warehouse';
  if (/exhibition|expo|trade show|booth|展会|展台/i.test(text)) return 'exhibition';
  if (/office|meeting|办公|会议/i.test(text)) return 'office';
  if (/laboratory|\blab\b|实验室|研发室/i.test(text)) return 'laboratory';
  if (/bathroom|bedroom|kitchen|home|居家|浴室|卧室|厨房/i.test(text)) return 'lifestyle';
  if (/outdoor|street|nature|户外|街道|自然/i.test(text)) return 'outdoor';
  return null;
}

/**
 * Convert Director visual observations into the canonical material contract.
 * Product binding is the only path to exact-product identity; visual similarity
 * alone never upgrades a public/reference image into an enterprise product.
 */
export function inferMaterialAssetV2(input: MaterialDirectorInput): MaterialAssetV2Metadata {
  const text = [input.name, input.folder, input.tags, ...(input.visualObservations || [])]
    .filter(Boolean).join(' ').toLowerCase();
  const productId = String(input.productId || '').trim();
  const hasProduct = Boolean(productId);
  const hasExactProductIdentity = hasProduct && input.identityAuthority !== 'derived';
  const sceneType = directorSceneType(text);
  const isEvidence = includesAny(text, [
    /certificate|certification|test report|inspection report|coa\b|msds\b/,
    /证书|认证|检测报告|检验报告|资质|专利/,
  ]);
  const isAuthorization = includesAny(text, [/authorization|consent|release form/, /授权书|肖像授权|同意书/]);
  const isTemplate = includesAny(text, [/template|layout|brand guide|模板|版式|品牌规范/]);
  const isTransparent = includesAny(text, [/transparent|cutout|isolated on (?:a )?white|透明底|抠图|白底/]);
  const isDieline = includesAny(text, [/dieline|die line|刀版|展开图/]);
  const isLabel = includesAny(text, [/label artwork|label design|标签稿|标签设计/]);

  let contentRole: MaterialContentRoleV2 = 'other';
  if (isAuthorization) contentRole = 'person_authorization';
  else if (isEvidence) contentRole = 'fact_evidence';
  else if (isDieline) contentRole = 'packaging_dieline';
  else if (isLabel) contentRole = 'label_artwork';
  else if (isTransparent) contentRole = 'transparent_cutout';
  else if (/back view|rear view|产品背面|背标|背面/.test(text)) contentRole = 'product_back';
  else if (/side view|profile view|产品侧面|侧面/.test(text)) contentRole = 'product_side';
  else if (/detail|macro|close[ -]?up|texture|细节|特写|质地/.test(text)) contentRole = 'product_detail';
  else if (hasProduct && !sceneType) contentRole = 'product_front';
  else if (sceneType) contentRole = 'scene_plate';

  let assetRole: MaterialAssetRoleV2 = 'supporting';
  if (isAuthorization) assetRole = 'person_authorization';
  else if (isEvidence) assetRole = 'fact_evidence';
  else if (isTemplate) assetRole = 'reusable_template';
  else if (hasExactProductIdentity) assetRole = 'exact_product';
  else if (sceneType && !hasProduct) assetRole = 'generic_scene_plate';

  const productIdentityLevel = assetRole === 'exact_product' ? 'exact' : hasProduct ? 'category' : 'none';
  const hasPerson = /person|people|hand|face|model|presenter|人物|人像|手部|模特|口播/.test(text);
  const cleanPlate = input.type === 'image'
    ? !hasPerson && !/crowd|busy|遮挡|人群/.test(text)
    : null;
  const labelReadability = contentRole === 'label_artwork' || contentRole === 'packaging_dieline'
    ? 'high'
    : contentRole === 'product_front' || contentRole === 'transparent_cutout'
      ? 'medium'
      : /label|logo|文字清晰|标签|包装文字/.test(text) ? 'medium' : 'none';
  const occlusion = /heavily occluded|严重遮挡/.test(text) ? 'high'
    : /partially occluded|部分遮挡|遮挡/.test(text) ? 'medium'
      : cleanPlate === true ? 'none' : null;
  const personProductContact = !hasPerson ? 'none'
    : /holding|held|手持|拿着/.test(text) ? 'held'
      : /using|apply|使用|涂抹/.test(text) ? 'used' : 'incidental';
  const templateEligible = assetRole === 'reusable_template'
    || (assetRole === 'generic_scene_plate' && cleanPlate === true);
  const reuseScore = Math.min(0.95, Math.max(0.2,
    0.35
    + (input.type === 'image' ? 0.1 : 0)
    + (assetRole === 'exact_product' ? 0.2 : 0)
    + (assetRole === 'generic_scene_plate' ? 0.15 : 0)
    + (cleanPlate === true ? 0.1 : 0)
    + (labelReadability === 'high' ? 0.1 : labelReadability === 'medium' ? 0.05 : 0),
  ));

  return normalizeMaterialAssetV2({
    assetRole,
    contentRole,
    productIdentityLevel,
    enterpriseCommon: !hasProduct && (input.enterpriseCommon === true || assetRole === 'generic_scene_plate'),
    subjectRefs: [
      ...(productId ? [`product:${productId}`] : []),
      ...(sceneType ? [`scene:${sceneType}`] : []),
    ],
    sceneType,
    personProductContact,
    occlusion,
    cleanPlate,
    cameraMotion: input.type === 'image' ? 'still' : null,
    labelReadability,
    templateEligible,
    reuseScore,
    segmentCandidates: [],
  });
}

export function materialDirectorSummary(metadata: MaterialAssetV2Metadata, productName = '') {
  const role = MATERIAL_ASSET_ROLE_LABELS[metadata.assetRole];
  const content = MATERIAL_CONTENT_ROLE_LABELS[metadata.contentRole];
  const identity = metadata.productIdentityLevel === 'exact'
    ? `只用于“${productName || '已绑定产品'}”的精准还原`
    : metadata.productIdentityLevel === 'category'
      ? '可用于品类说明，不可冒充精准产品外观'
      : '不承担产品身份，只用于场景、结构或辅助表达';
  const usableFor = metadata.assetRole === 'exact_product'
    ? ['产品主视觉', '产品目录', '卖点说明', '场景合成']
    : metadata.assetRole === 'generic_scene_plate'
      ? ['背景场景', '氛围合成', '版式衬底']
      : metadata.assetRole === 'fact_evidence'
        ? ['资质证明区', '能力背书区']
        : metadata.assetRole === 'reusable_template'
          ? ['版式参考', '品牌结构复用']
          : ['辅助画面'];
  const cautions = [identity];
  if (metadata.labelReadability === 'low' || metadata.labelReadability === 'none') cautions.push('不要依赖原图中的小字直接发布');
  return { summary: `${role} · ${content}`, usableFor, cautions };
}

export type ImageReferenceCandidate = {
  id: string;
  type: string;
  folder?: string;
  productId?: string;
  usage?: 'editable' | 'reference_only';
  segmentAnalysisStatus?: string;
  materialV2?: MaterialAssetV2Metadata | null;
  capabilityManifest?: MaterialCapabilityManifest | null;
};

export type ImageReferencePlan = {
  selectedIds: string[];
  exactProductIds: string[];
  styleReferenceIds: string[];
  reasons: Record<string, string>;
  blockers: string[];
};

function imageReferenceScore(candidate: ImageReferenceCandidate, targetProductIds: Set<string>): number {
  const metadata = candidate.materialV2;
  let score = 0;
  if (candidate.type === 'image') score += 30;
  if (candidate.segmentAnalysisStatus === 'completed') score += 12;
  if (candidate.capabilityManifest?.status === 'ready') score += 18;
  if (candidate.capabilityManifest?.capabilities.includes('image_generation_reference')) score += 35;
  if (metadata) {
    score += metadata.reuseScore * 20;
    if (metadata.assetRole === 'exact_product') score += 80;
    if (metadata.contentRole === 'product_front') score += 45;
    if (metadata.contentRole === 'transparent_cutout') score += 40;
    if (metadata.contentRole === 'product_detail') score += 25;
    if (metadata.contentRole === 'fact_evidence') score += 18;
    if (metadata.contentRole === 'scene_plate') score += 14;
    if (metadata.labelReadability === 'high') score += 12;
    if (metadata.labelReadability === 'medium') score += 6;
  } else {
    if (candidate.folder === 'product') score += 35;
    if (candidate.folder === 'packaging') score += 20;
    if (candidate.folder === 'certificate') score += 16;
    if (candidate.folder === 'scene' || candidate.folder === 'factory') score += 12;
  }
  if (candidate.productId && targetProductIds.has(candidate.productId)) score += 45;
  return score;
}

/** Select at most three references because the current image provider accepts three. */
export function planImageReferences(
  candidates: ImageReferenceCandidate[],
  options: { productIds?: string[]; includeStyleReference?: boolean; limit?: number } = {},
): ImageReferencePlan {
  const limit = Math.max(1, Math.min(3, options.limit || 3));
  const targetProductIds = new Set((options.productIds || []).filter(Boolean));
  const images = candidates.filter(item => item.type === 'image');
  const style = images.filter(item => (item.folder === 'hot' || item.usage === 'reference_only')
    && (!item.capabilityManifest || item.capabilityManifest.capabilities.includes('image_generation_reference')));
  const production = images.filter(item => {
    if (style.includes(item)) return false;
    if (item.capabilityManifest && !item.capabilityManifest.capabilities.includes('image_generation_reference')) return false;
    if (!targetProductIds.size || !item.productId) return true;
    return targetProductIds.has(item.productId);
  }).sort((a, b) => imageReferenceScore(b, targetProductIds) - imageReferenceScore(a, targetProductIds));
  const selected: ImageReferenceCandidate[] = [];
  const usedContentRoles = new Set<string>();
  const productionLimit = options.includeStyleReference && style[0] ? Math.max(0, limit - 1) : limit;
  for (const item of production) {
    if (selected.length >= productionLimit) break;
    const role = item.materialV2?.contentRole || item.folder || 'other';
    if (usedContentRoles.has(role) && production.some(other => !selected.includes(other) && !usedContentRoles.has(other.materialV2?.contentRole || other.folder || 'other'))) continue;
    selected.push(item);
    usedContentRoles.add(role);
  }
  if (options.includeStyleReference && selected.length < limit && style[0]) selected.push(style[0]);
  const exactProductIds = selected.filter(item => item.materialV2?.assetRole === 'exact_product'
    || item.capabilityManifest?.capabilities.includes('exact_product_reference')).map(item => item.id);
  const styleReferenceIds = selected.filter(item => style.includes(item)).map(item => item.id);
  const reasons = Object.fromEntries(selected.map(item => {
    const metadata = item.materialV2;
    const reason = style.includes(item)
      ? '只参考版式和视觉节奏，不复制其中的产品、品牌或文字'
      : metadata
        ? `${MATERIAL_ASSET_ROLE_LABELS[metadata.assetRole]} · ${MATERIAL_CONTENT_ROLE_LABELS[metadata.contentRole]}`
        : `按历史文件夹“${item.folder || '未分类'}”临时匹配，建议完成编导分析`;
    return [item.id, reason];
  }));
  const blockers: string[] = [];
  if (targetProductIds.size && !exactProductIds.length) blockers.push('缺少与当前产品绑定的精准产品图，不能保证包装、标签和外观一致');
  if (!selected.length) blockers.push('没有可用于图片生成的图片素材');
  return { selectedIds: selected.map(item => item.id), exactProductIds, styleReferenceIds, reasons, blockers };
}

export type ImageProductionPlan = ImageReferencePlan & {
  deliverable: ImageDeliverable;
  strategy: ImageProductionStrategy;
  strategyReason: string;
  inputRoles: Array<{ materialId: string; role: 'exact_product' | 'style' | 'supporting' }>;
};

/** Users choose the finished image; the Agent chooses the safest production method. */
export function planImageProduction(
  candidates: ImageReferenceCandidate[],
  options: { deliverable: ImageDeliverable; productIds?: string[]; includeStyleReference?: boolean; limit?: number },
): ImageProductionPlan {
  const referencePlan = planImageReferences(candidates, options);
  const selected = referencePlan.selectedIds
    .map(id => candidates.find(candidate => candidate.id === id))
    .filter((item): item is ImageReferenceCandidate => Boolean(item));
  const supporting = selected.filter(item => !referencePlan.exactProductIds.includes(item.id)
    && !referencePlan.styleReferenceIds.includes(item.id));
  let strategy: ImageProductionStrategy = 'generate_supporting';
  let strategyReason = '没有可直接复用的完整成图，生成不承担产品身份的辅助画面';
  if (referencePlan.exactProductIds.length && referencePlan.styleReferenceIds.length) {
    strategy = 'reference_generate';
    strategyReason = '锁定企业产品外观，只借鉴参考图的构图和节奏重新生成';
  } else if (referencePlan.exactProductIds.length && supporting.length) {
    strategy = 'compose_assets';
    strategyReason = '以精准产品图为身份锚点，与已授权场景或证明素材合成';
  } else if (referencePlan.exactProductIds.length) {
    strategy = 'reference_generate';
    strategyReason = '以精准产品图为身份锚点，自动补齐中性背景和版式';
  } else if (selected.some(item => item.capabilityManifest?.capabilities.includes('template_reuse'))) {
    strategy = 'reuse_existing';
    strategyReason = '现有模板已通过复用准入，只替换已核实内容';
  }
  const blockers = [...referencePlan.blockers];
  if ((options.productIds || []).length && !referencePlan.exactProductIds.length
    && !blockers.some(message => message.includes('精准产品图'))) {
    blockers.push('缺少与当前产品绑定的精准产品图，不能保证包装、标签和外观一致');
  }
  return {
    ...referencePlan,
    blockers,
    deliverable: options.deliverable,
    strategy,
    strategyReason,
    inputRoles: selected.map(item => ({
      materialId: item.id,
      role: referencePlan.exactProductIds.includes(item.id) ? 'exact_product'
        : referencePlan.styleReferenceIds.includes(item.id) ? 'style' : 'supporting',
    })),
  };
}
