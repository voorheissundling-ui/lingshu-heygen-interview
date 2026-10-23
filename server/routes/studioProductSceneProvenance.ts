import {
  PRODUCT_SCENE_KINDS,
  PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION,
  stableProductScenePreparationSlotId,
  type ProductSceneKind,
} from '../../shared/contracts/productScenePreparation.js';

const PRODUCT_SCENE_PROVENANCE_KEY = 'productScenePreparation';

export interface ProductSceneMaterialProvenance {
  schemaVersion: typeof PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION;
  slotId: string;
  productId: string;
  kind: ProductSceneKind;
  verifiedDurationSeconds: number;
  verifiedWidth: number;
  verifiedHeight: number;
  decodedFrameCount: number;
  verificationMethod: 'ffmpeg_full_decode';
  contentSha256: string;
  boundAt?: string;
}

export function recordObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

export function productSceneMaterialProvenanceOf(material: Record<string, unknown>): ProductSceneMaterialProvenance | undefined {
  const provenance = recordObject(material.provenance);
  const binding = recordObject(provenance[PRODUCT_SCENE_PROVENANCE_KEY]);
  const kind = String(binding.kind || '') as ProductSceneKind;
  const productId = String(binding.productId || '').trim();
  const verifiedDurationSeconds = Number(binding.verifiedDurationSeconds);
  const verifiedWidth = Number(binding.verifiedWidth);
  const verifiedHeight = Number(binding.verifiedHeight);
  const decodedFrameCount = Number(binding.decodedFrameCount);
  const verificationMethod = String(binding.verificationMethod || '');
  const contentSha256 = String(binding.contentSha256 || '').trim().toLowerCase();
  if (binding.schemaVersion !== PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION
    || !PRODUCT_SCENE_KINDS.includes(kind)
    || !productId
    || verificationMethod !== 'ffmpeg_full_decode'
    || !Number.isFinite(verifiedDurationSeconds)
    || verifiedDurationSeconds <= 0
    || !Number.isSafeInteger(decodedFrameCount)
    || decodedFrameCount < 1
    || !/^[a-f0-9]{64}$/.test(contentSha256)) return undefined;
  let expectedSlotId = '';
  try { expectedSlotId = stableProductScenePreparationSlotId(productId, kind); }
  catch { return undefined; }
  if (String(binding.slotId || '') !== expectedSlotId) return undefined;
  return {
    schemaVersion: PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION,
    slotId: expectedSlotId,
    productId,
    kind,
    verifiedDurationSeconds,
    verifiedWidth: Number.isFinite(verifiedWidth) && verifiedWidth > 0 ? Math.round(verifiedWidth) : 0,
    verifiedHeight: Number.isFinite(verifiedHeight) && verifiedHeight > 0 ? Math.round(verifiedHeight) : 0,
    decodedFrameCount,
    verificationMethod: 'ffmpeg_full_decode',
    contentSha256,
    ...(String(binding.boundAt || '').trim() ? { boundAt: String(binding.boundAt) } : {}),
  };
}

function mergedSearchLabels(...values: unknown[]): string {
  const labels = values.flatMap(value => String(value || '')
    .split(/[,，、;；|\n]+/)
    .map(item => item.trim())
    .filter(Boolean));
  return Array.from(new Set(labels)).join(',').slice(0, 500);
}

export function productSceneMaterialBindingChanges(input: {
  material: Record<string, unknown>;
  productId: string;
  productName: string;
  kind: ProductSceneKind;
  verification: {
    durationSeconds: number;
    width: number;
    height: number;
    decodedFrameCount: number;
    verificationMethod: 'ffmpeg_full_decode';
    contentSha256: string;
  };
  boundAt?: string;
}): Record<string, unknown> {
  if (!PRODUCT_SCENE_KINDS.includes(input.kind)) throw new Error('product_scene_preparation_kind_invalid');
  const productId = String(input.productId || '').trim();
  if (!productId) throw new Error('product_scene_preparation_product_id_required');
  const durationSeconds = Number(input.verification.durationSeconds);
  const decodedFrameCount = Number(input.verification.decodedFrameCount);
  const contentSha256 = String(input.verification.contentSha256 || '').trim().toLowerCase();
  if (input.verification.verificationMethod !== 'ffmpeg_full_decode'
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || !Number.isSafeInteger(decodedFrameCount)
    || decodedFrameCount < 1
    || !/^[a-f0-9]{64}$/.test(contentSha256)) throw new Error('product_scene_preparation_verification_invalid');
  const provenance = recordObject(input.material.provenance);
  const productScenePreparation: ProductSceneMaterialProvenance = {
    schemaVersion: PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION,
    slotId: stableProductScenePreparationSlotId(productId, input.kind),
    productId,
    kind: input.kind,
    verifiedDurationSeconds: durationSeconds,
    verifiedWidth: Math.max(0, Math.round(Number(input.verification.width) || 0)),
    verifiedHeight: Math.max(0, Math.round(Number(input.verification.height) || 0)),
    decodedFrameCount,
    verificationMethod: 'ffmpeg_full_decode',
    contentSha256,
    boundAt: input.boundAt || new Date().toISOString(),
  };
  return {
    productId,
    productName: String(input.productName || '').trim(),
    provenance: { ...provenance, [PRODUCT_SCENE_PROVENANCE_KEY]: productScenePreparation },
    tags: mergedSearchLabels('产品预制素材', input.material.tags),
    shotFunction: mergedSearchLabels('产品展示', input.material.shotFunction),
  };
}

export function productSceneMaterialProductAssociationChanges(input: {
  material: Record<string, unknown>;
  productId: string;
  productName: string;
}): Record<string, unknown> {
  const productId = String(input.productId || '').trim();
  const productName = String(input.productName || '').trim();
  const provenance = recordObject(input.material.provenance);
  const existingBinding = productSceneMaterialProvenanceOf(input.material);
  if (!existingBinding || !productId) {
    const nextProvenance = { ...provenance };
    delete nextProvenance[PRODUCT_SCENE_PROVENANCE_KEY];
    return { productId, productName, provenance: nextProvenance };
  }
  return productSceneMaterialBindingChanges({
    material: input.material,
    productId,
    productName,
    kind: existingBinding.kind,
    verification: {
      durationSeconds: existingBinding.verifiedDurationSeconds,
      width: existingBinding.verifiedWidth,
      height: existingBinding.verifiedHeight,
      decodedFrameCount: existingBinding.decodedFrameCount,
      verificationMethod: existingBinding.verificationMethod,
      contentSha256: existingBinding.contentSha256,
    },
  });
}
