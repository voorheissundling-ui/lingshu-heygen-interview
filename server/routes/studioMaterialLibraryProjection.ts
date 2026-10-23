import { resolveMaterialProductAssociation, type ProductMaterialReference } from '../digitalEmployees/materialProductionReadiness.js';
import { materialVisibleForPurpose, type MaterialRecord } from '../lib/materialLibrary.js';
import { canAppearInSharedLibrary, isReferenceOnlyMaterial, isWorkflowInternalMaterial } from '../lib/materialPolicy.js';
import { filterMyGeneratedMaterials, projectGeneratedMaterial } from '../../src/lib/generatedMaterial.js';
import { ASSET_GENERATION_KINDS, type AssetGenerationKind, type GeneratedAssetQuality } from '../../shared/contracts/generatedMaterial.js';
import { MATERIAL_SOURCE_CATEGORIES, MATERIAL_THEMES, materialSourceCategoryOf, materialThemeTagsOf, type MaterialSourceCategory, type MaterialTheme } from '../../shared/materialTaxonomy.js';
import { filterMaterialsByProductAssociation } from './studioProductSceneProjection.js';

export interface StudioMaterialProjectionItem {
  id: string;
  name: string;
  createdAt: string;
  scope?: string;
  productId?: string;
  productName?: string;
  tags?: string;
  industry?: string;
  shotFunction?: string;
}

export interface StudioMaterialLibraryProjection<T> {
  sceneMaterials: T[];
  filteredMaterials: T[];
  pageItems: T[];
  total: number;
  page: number;
  pageSize: number;
  facets: { sources: Record<string, number>; themes: Record<string, number> };
  productIdFilter: string;
  error?: '产品筛选条件冲突' | '生成素材类型无效' | '生成素材质量状态无效';
}

/** Deterministic list projection; the route still owns tenant reads, media signing and usage evidence. */
export function projectStudioMaterialLibrary<T extends StudioMaterialProjectionItem>(input: {
  enterpriseMaterials: T[];
  inventoryMaterials: T[];
  productReferences: ProductMaterialReference[];
  tenantId: string;
  query: Record<string, unknown>;
}): StudioMaterialLibraryProjection<T> {
  const q = input.query;
  const productIdFilter = String(q.productId || '').trim();
  const excludeProductAssociated = q.excludeProductAssociated === '1';
  const assetGenerationKind = String(q.assetGenerationKind || '');
  const qualityState = String(q.qualityState || '');
  const error = productIdFilter && excludeProductAssociated ? '产品筛选条件冲突'
    : assetGenerationKind && !ASSET_GENERATION_KINDS.includes(assetGenerationKind as AssetGenerationKind) ? '生成素材类型无效'
    : qualityState && !['accepted', 'repair_required', 'failed'].includes(qualityState) ? '生成素材质量状态无效'
    : undefined;
  const sceneMaterials = [...new Map([...input.enterpriseMaterials, ...input.inventoryMaterials]
    .map(material => [material.id, material])).values()]
    .map(material => {
      const association = resolveMaterialProductAssociation(material as unknown as Record<string, unknown>, input.productReferences);
      return association ? { ...material, productId: association.productId, productName: association.productName } : material;
    }) as T[];
  if (error) return { sceneMaterials, filteredMaterials: [], pageItems: [], total: 0, page: 1, pageSize: 1, facets: { sources: {}, themes: {} }, productIdFilter, error };

  let list = filterMaterialsByProductAssociation(sceneMaterials, { productId: productIdFilter, excludeProductAssociated });
  const scope = String(q.scope || '');
  const purpose = String(q.purpose || 'library');
  if (scope === 'shared') list = list.filter(canAppearInSharedLibrary);
  else if (scope === 'own') list = list.filter(material => (material.scope ?? 'own') === 'own');
  list = list.filter(material => materialVisibleForPurpose(material as MaterialRecord, purpose));
  if (purpose === 'reference') list = list.filter(material => isReferenceOnlyMaterial(material) && !isWorkflowInternalMaterial(material));
  else if (purpose !== 'all') list = list.filter(material => !isReferenceOnlyMaterial(material) && !isWorkflowInternalMaterial(material));

  const origin = String(q.origin || '');
  if (origin === 'generated' || assetGenerationKind || qualityState || q.reusableOnly === '1') {
    list = filterMyGeneratedMaterials(list, {
      tenantId: input.tenantId,
      ...(assetGenerationKind ? { assetGenerationKind: assetGenerationKind as AssetGenerationKind } : {}),
      ...(qualityState ? { qualityState: qualityState as GeneratedAssetQuality['state'] } : {}),
      reusableOnly: q.reusableOnly === '1',
    }) as T[];
  } else if (origin === 'uploaded') {
    list = list.filter(material => !projectGeneratedMaterial(material));
  }
  const facets = {
    sources: Object.fromEntries(MATERIAL_SOURCE_CATEGORIES.map(value => [value, list.filter(material => materialSourceCategoryOf(material) === value).length])),
    themes: Object.fromEntries(MATERIAL_THEMES.map(value => [value, list.filter(material => materialThemeTagsOf(material).includes(value)).length])),
  };
  const sourceCategory = String(q.sourceCategory || '');
  const theme = String(q.theme || '');
  const query = String(q.query || '').trim().toLowerCase();
  if (MATERIAL_SOURCE_CATEGORIES.includes(sourceCategory as MaterialSourceCategory)) list = list.filter(material => materialSourceCategoryOf(material) === sourceCategory);
  if (MATERIAL_THEMES.includes(theme as MaterialTheme)) list = list.filter(material => materialThemeTagsOf(material).includes(theme as MaterialTheme));
  if (query) list = list.filter(material => [material.name, material.productName, material.tags, material.industry, material.shotFunction].some(value => String(value || '').toLowerCase().includes(query)));
  const total = list.length;
  const paginated = q.page !== undefined || q.pageSize !== undefined;
  const pageSize = paginated ? Math.min(100, Math.max(1, Number(q.pageSize || 60))) : Math.max(1, total);
  const page = Math.max(1, Number(q.page || 1));
  const ordered = list.sort((a, b) => (Date.parse(String(b.createdAt || '')) || 0) - (Date.parse(String(a.createdAt || '')) || 0));
  const pageItems = paginated ? ordered.slice((page - 1) * pageSize, page * pageSize) : ordered;
  return { sceneMaterials, filteredMaterials: list, pageItems, total, page, pageSize, facets, productIdFilter };
}
