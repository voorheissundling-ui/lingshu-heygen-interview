export const MATERIAL_SOURCE_CATEGORIES = ['local_upload', 'official_import', 'user_generated'] as const;
export type MaterialSourceCategory = typeof MATERIAL_SOURCE_CATEGORIES[number];

export const MATERIAL_THEMES = ['talking_head', 'factory', 'product', 'consumer_demo'] as const;
export type MaterialTheme = typeof MATERIAL_THEMES[number];
export type MaterialClassificationStatus = 'pending' | 'analyzing' | 'completed' | 'review_required' | 'failed';

export const MATERIAL_SOURCE_LABELS: Record<MaterialSourceCategory, string> = {
  local_upload: '本地上传', official_import: '官方导入', user_generated: '用户生成',
};
export const MATERIAL_THEME_LABELS: Record<MaterialTheme, string> = {
  talking_head: '人物口播', factory: '工厂实况', product: '产品实拍', consumer_demo: 'DtoC',
};

type SourceLike = { sourceCategory?: unknown; sourceType?: unknown; sourceProvider?: unknown; folder?: unknown; scope?: unknown; provenance?: unknown };
const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Compatibility boundary for legacy sourceType values. Model/provider names remain provenance, never user-facing categories. */
export function materialSourceCategoryOf(material: SourceLike): MaterialSourceCategory {
  const explicit = String(material.sourceCategory || '').trim();
  if (MATERIAL_SOURCE_CATEGORIES.includes(explicit as MaterialSourceCategory)) return explicit as MaterialSourceCategory;
  const provenance = objectOf(material.provenance);
  const source = [material.sourceType, material.sourceProvider, provenance.sourceChannel, provenance.sourceEntry].join(' ').toLowerCase();
  if (/seedance|seedream|gemini|qwen|aigc|ai[-_ ]?generated|generation/.test(source)) return 'user_generated';
  if (material.scope === 'shared' || material.folder === 'hot' || /official|viral|licensed[-_ ]?stock|platform_operations/.test(source)) return 'official_import';
  return 'local_upload';
}

type ThemeLike = { primaryTheme?: unknown; themeTags?: unknown; segments?: unknown; scriptAnalysis?: unknown; visualObservations?: unknown; tags?: unknown; shotFunction?: unknown; name?: unknown };
export function materialThemeTagsOf(material: ThemeLike): MaterialTheme[] {
  const values: unknown[] = [material.primaryTheme, ...(Array.isArray(material.themeTags) ? material.themeTags : [])];
  if (Array.isArray(material.segments)) for (const segment of material.segments) values.push(objectOf(segment).materialType);
  const analysis = objectOf(material.scriptAnalysis);
  const details = Array.isArray(analysis.scriptDetails15s) ? analysis.scriptDetails15s : [];
  for (const detail of details) values.push(objectOf(detail).materialType);
  const explicit = [...new Set(values.filter(value => MATERIAL_THEMES.includes(value as MaterialTheme)) as MaterialTheme[])];
  if (explicit.length) return explicit;
  const text = [material.name, material.tags, material.shotFunction, analysis.searchableText,
    ...(Array.isArray(material.visualObservations) ? material.visualObservations : []),
    ...(Array.isArray(material.segments) ? material.segments.map(item => Object.values(objectOf(item)).flat().join(' ')) : []),
  ].join(' ').toLowerCase();
  const inferred: MaterialTheme[] = [];
  if (/口播|面对镜头|讲解|主播|主持人|sales presenter|talking head|speaking to camera/.test(text)) inferred.push('talking_head');
  if (/工厂|车间|产线|生产线|灌装|包装工序|仓储|质检|设备操作|factory|assembly line|production line/.test(text)) inferred.push('factory');
  if (/产品|瓶身|包装盒|商品|产品展示|产品特写|product|packshot|showroom/.test(text)) inferred.push('product');
  if (/消费者|顾客|用户.{0,12}(使用|试用)|涂抹|上脸|效果对比|before.?after|consumer demo|customer use/.test(text)) inferred.push('consumer_demo');
  return [...new Set(inferred)];
}

export function materialPrimaryThemeOf(material: ThemeLike): MaterialTheme | null {
  const explicit = material.primaryTheme;
  if (MATERIAL_THEMES.includes(explicit as MaterialTheme)) return explicit as MaterialTheme;
  return materialThemeTagsOf(material)[0] || null;
}
