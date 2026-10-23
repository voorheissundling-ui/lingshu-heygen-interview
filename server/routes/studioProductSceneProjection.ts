import { productIdentity } from '../digitalEmployees/contentProduction.js';
import { isReferenceOnlyMaterial, isWorkflowInternalMaterial } from '../lib/materialPolicy.js';
import { isSyntheticMaterial } from '../lib/materialTruthfulness.js';
import { productSceneMaterialProvenanceOf } from './studioProductSceneProvenance.js';
import {
  buildProductScenePreparationReadModels,
  ensureProductScenePreparationPlan,
  type ProductScenePreparationMaterialBinding,
  type ProductScenePreparationReadModel,
  type ProductScenePreparationStatus,
} from '../../shared/contracts/productScenePreparation.js';

export function productSceneSourceImageUrl(product: Record<string, unknown>): string {
  const direct = String(product.imageUrl || '').trim();
  if (direct) return direct;
  for (const key of ['images', 'packagingImages', 'sceneImages', 'brandAssets']) {
    const rows = Array.isArray(product[key]) ? product[key] as Array<Record<string, unknown>> : [];
    const url = rows.map(row => String(row?.url || '').trim()).find(Boolean);
    if (url) return url;
  }
  return '';
}

export function productSceneMaterialProductionEligible(
  material: Record<string, unknown>,
  binding = productSceneMaterialProvenanceOf(material),
): boolean {
  const duration = Number(material.duration);
  const contentSha256 = String(material.sha256 || material.contentSha256 || '').trim().toLowerCase();
  return material.type === 'video'
    && Boolean(binding)
    && Boolean(String(material.id || '').trim())
    && Boolean(String(material.url || '').trim())
    && String(material.scope || 'own') !== 'shared'
    && Number.isFinite(duration)
    && duration > 0
    && Math.abs(duration - Number(binding?.verifiedDurationSeconds)) <= 0.05
    && contentSha256 === binding?.contentSha256
    && !String(material.libraryRemovedAt || '').trim()
    && !isSyntheticMaterial(material)
    && !isReferenceOnlyMaterial(material)
    && !isWorkflowInternalMaterial(material);
}

/**
 * Read-only join used by the materials envelope. Empty preparation slots are
 * projections of the product plan and are never persisted as material rows.
 */
export function buildStudioProductScenePreparationSlots(input: {
  products: readonly Record<string, unknown>[];
  materials: readonly Record<string, unknown>[];
  resolveSourceImageUrl?: (product: Record<string, unknown>, index: number) => string;
}): ProductScenePreparationReadModel[] {
  const orderedMaterials = [...input.materials].sort((left, right) => (
    (Date.parse(String(right.updatedAt || right.createdAt || '')) || 0)
    - (Date.parse(String(left.updatedAt || left.createdAt || '')) || 0)
  ));
  return input.products.flatMap((product, productIndex) => {
    const productId = productIdentity(product as Parameters<typeof productIdentity>[0], productIndex);
    const plan = ensureProductScenePreparationPlan(productId, product.productScenePreparation);
    const associatedImage = orderedMaterials.find(material => material.type === 'image'
      && String(material.productId || '').trim() === productId
      && String(material.scope || 'own') !== 'shared'
      && !String(material.libraryRemovedAt || '').trim()
      && !isSyntheticMaterial(material)
      && !isReferenceOnlyMaterial(material)
      && !isWorkflowInternalMaterial(material)
      && Boolean(String(material.url || material.poster || '').trim()));
    const sourceImageUrl = String(input.resolveSourceImageUrl?.(product, productIndex)
      || productSceneSourceImageUrl(product)
      || associatedImage?.url
      || associatedImage?.poster
      || '').trim();
    const candidates = orderedMaterials
      .map(material => ({ material, binding: productSceneMaterialProvenanceOf(material) }))
      .filter(candidate => candidate.binding?.productId === productId);
    const statusBySlotId: Record<string, ProductScenePreparationStatus | undefined> = {};
    const materialBindings: ProductScenePreparationMaterialBinding[] = [];
    for (const slot of plan.slots) {
      const claimed = candidates.filter(candidate => candidate.binding?.slotId === slot.slotId);
      const usable = claimed.find(candidate => (
        String(candidate.material.productId || '').trim() === productId
        && productSceneMaterialProductionEligible(candidate.material, candidate.binding)
      ));
      if (usable?.binding) {
        materialBindings.push({
          slotId: slot.slotId,
          productId,
          kind: slot.kind,
          materialId: String(usable.material.id),
          materialUrl: String(usable.material.url),
          ...(String(usable.material.poster || '').trim() ? { posterUrl: String(usable.material.poster) } : {}),
          ...(String(usable.material.name || '').trim() ? { materialName: String(usable.material.name) } : {}),
          mediaType: 'video',
          actualDurationSeconds: usable.binding.verifiedDurationSeconds,
          productionEligible: true,
          synthetic: false,
        });
      } else if (claimed.length) {
        statusBySlotId[slot.slotId] = 'needs_replacement';
      }
    }
    return buildProductScenePreparationReadModels({
      productId,
      plan,
      sourceImageUrl,
      statusBySlotId,
      materialBindings,
    });
  });
}

export function filterMaterialsByProductAssociation<T extends object>(
  materials: readonly T[],
  input: { productId?: unknown; excludeProductAssociated?: boolean },
): T[] {
  const productId = String(input.productId || '').trim();
  if (productId && input.excludeProductAssociated) throw new Error('material_product_filter_conflict');
  const associatedProductId = (material: T) => String((material as { productId?: unknown }).productId || '').trim();
  if (productId) return materials.filter(material => associatedProductId(material) === productId);
  if (input.excludeProductAssociated) return materials.filter(material => !associatedProductId(material));
  return [...materials];
}

export function scopeProductSceneProjection<
  TProduct extends Record<string, unknown>,
  TMaterial extends object,
>(input: {
  products: readonly TProduct[];
  materials: readonly TMaterial[];
  productId?: unknown;
}): { products: TProduct[]; materials: TMaterial[] } {
  const productId = String(input.productId || '').trim();
  if (!productId) return { products: [...input.products], materials: [...input.materials] };
  const products = input.products.flatMap((product, index) => {
    const canonicalId = productIdentity(product as unknown as Parameters<typeof productIdentity>[0], index);
    return canonicalId === productId ? [{ ...product, id: canonicalId } as TProduct] : [];
  });
  if (!products.length) return { products: [], materials: [] };
  return {
    products,
    materials: input.materials.filter(material => (
      String((material as { productId?: unknown }).productId || '').trim() === productId
    )),
  };
}
