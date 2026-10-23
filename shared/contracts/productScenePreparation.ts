export const PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION = 'product-scene-preparation.v1' as const;

export const PRODUCT_SCENE_KINDS = [
  'shelf_display',
  'conveyor_release',
  'floor_stack',
] as const;

export type ProductSceneKind = typeof PRODUCT_SCENE_KINDS[number];

export interface ProductSceneDefinition {
  kind: ProductSceneKind;
  label: string;
  description: string;
  targetDurationSeconds: {
    min: 2;
    max: 3;
  };
}

/**
 * Canonical product-scene brief. These are preparation targets rather than
 * claims that a provider job or finished video already exists.
 */
export const PRODUCT_SCENE_DEFINITIONS: readonly ProductSceneDefinition[] = [
  {
    kind: 'shelf_display',
    label: '预制场景 1',
    description: '',
    targetDurationSeconds: { min: 2, max: 3 },
  },
  {
    kind: 'conveyor_release',
    label: '预制场景 2',
    description: '',
    targetDurationSeconds: { min: 2, max: 3 },
  },
  {
    kind: 'floor_stack',
    label: '预制场景 3',
    description: '',
    targetDurationSeconds: { min: 2, max: 3 },
  },
] as const;

export interface ProductScenePreparationSlotPlan {
  slotId: string;
  kind: ProductSceneKind;
  targetDurationSeconds: {
    min: 2;
    max: 3;
  };
}

export interface ProductScenePreparationPlan {
  schemaVersion: typeof PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION;
  slots: ProductScenePreparationSlotPlan[];
}

export const PRODUCT_SCENE_PREPARATION_STATUSES = [
  'waiting_source',
  'queued',
  'preparing',
  'ready',
  'needs_replacement',
] as const;

export type ProductScenePreparationStatus = typeof PRODUCT_SCENE_PREPARATION_STATUSES[number];

/**
 * A deliberately narrow projection of a server-verified material. Callers
 * must derive this from the authoritative material store, never from a
 * browser-supplied readiness flag.
 */
export interface ProductScenePreparationMaterialBinding {
  slotId: string;
  productId: string;
  kind: ProductSceneKind;
  materialId: string;
  materialUrl: string;
  posterUrl?: string;
  materialName?: string;
  mediaType: 'video';
  actualDurationSeconds: number;
  productionEligible: boolean;
  synthetic: boolean;
}

export interface ProductScenePreparationReadModel {
  slotId: string;
  productId: string;
  kind: ProductSceneKind;
  label: string;
  description: string;
  targetDurationSeconds: {
    min: 2;
    max: 3;
  };
  status: ProductScenePreparationStatus;
  sourceImageAvailable: boolean;
  sourceImageUrl?: string;
  materialId?: string;
  materialUrl?: string;
  posterUrl?: string;
  materialName?: string;
  actualDurationSeconds?: number;
}

function cleanText(value: unknown, maximum = 500): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, maximum) : '';
}

function normalizedProductId(productId: unknown): string {
  const value = cleanText(productId, 200);
  if (!value) throw new Error('product_scene_preparation_product_id_required');
  return value;
}

function sceneDefinition(kind: ProductSceneKind): ProductSceneDefinition {
  return PRODUCT_SCENE_DEFINITIONS.find(item => item.kind === kind)!;
}

/** Stable across product-table reordering, profile saves and process restarts. */
export function stableProductScenePreparationSlotId(productId: string, kind: ProductSceneKind): string {
  const canonicalProductId = normalizedProductId(productId);
  if (!PRODUCT_SCENE_KINDS.includes(kind)) throw new Error('product_scene_preparation_kind_invalid');
  return `${PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION}:${encodeURIComponent(canonicalProductId)}:${kind}`;
}

/**
 * Rebuilds the v1 plan from its immutable product identity. Unknown, partial,
 * duplicate or stale persisted slots cannot remove a required target or
 * manufacture completion metadata.
 */
export function normalizeProductScenePreparationPlan(
  productId: string,
  _value?: unknown,
): ProductScenePreparationPlan {
  const canonicalProductId = normalizedProductId(productId);
  return {
    schemaVersion: PRODUCT_SCENE_PREPARATION_SCHEMA_VERSION,
    slots: PRODUCT_SCENE_DEFINITIONS.map(definition => ({
      slotId: stableProductScenePreparationSlotId(canonicalProductId, definition.kind),
      kind: definition.kind,
      targetDurationSeconds: { ...definition.targetDurationSeconds },
    })),
  };
}

export function ensureProductScenePreparationPlan(
  productId: string,
  value?: unknown,
): ProductScenePreparationPlan {
  return normalizeProductScenePreparationPlan(productId, value);
}

function isVerifiedMaterialBinding(
  binding: ProductScenePreparationMaterialBinding,
  productId: string,
  slot: ProductScenePreparationSlotPlan,
): boolean {
  const materialId = cleanText(binding.materialId, 300);
  const materialUrl = cleanText(binding.materialUrl, 2_000);
  const duration = Number(binding.actualDurationSeconds);
  return binding.slotId === slot.slotId
    && cleanText(binding.productId, 200) === productId
    && binding.kind === slot.kind
    && binding.mediaType === 'video'
    && materialId.length > 0
    && materialUrl.length > 0
    && binding.productionEligible === true
    && binding.synthetic === false
    && Number.isFinite(duration)
    && duration > 0;
}

/**
 * Joins a deterministic plan with authoritative material bindings. A slot is
 * never reported as ready solely because persisted UI state says so: it must
 * have a real, production-eligible, positive-duration video binding. The
 * target duration remains generation guidance and never rejects an upload.
 */
export function buildProductScenePreparationReadModels(input: {
  productId: string;
  plan?: unknown;
  sourceImageUrl?: unknown;
  statusBySlotId?: Readonly<Record<string, ProductScenePreparationStatus | undefined>>;
  materialBindings?: readonly ProductScenePreparationMaterialBinding[];
}): ProductScenePreparationReadModel[] {
  const productId = normalizedProductId(input.productId);
  const plan = normalizeProductScenePreparationPlan(productId, input.plan);
  const sourceImageUrl = cleanText(input.sourceImageUrl, 2_000);
  const sourceImageAvailable = sourceImageUrl.length > 0;
  const bindings = input.materialBindings ?? [];

  return plan.slots.map(slot => {
    const definition = sceneDefinition(slot.kind);
    const binding = bindings.find(candidate => isVerifiedMaterialBinding(candidate, productId, slot));
    const requestedStatus = input.statusBySlotId?.[slot.slotId];
    const status: ProductScenePreparationStatus = binding
      ? 'ready'
      : !sourceImageAvailable
        ? 'waiting_source'
        : requestedStatus === 'needs_replacement'
        ? 'needs_replacement'
        : requestedStatus === 'waiting_source' || requestedStatus === 'queued' || requestedStatus === 'preparing'
            ? requestedStatus
            : 'queued';

    return {
      slotId: slot.slotId,
      productId,
      kind: slot.kind,
      label: definition.label,
      description: definition.description,
      targetDurationSeconds: { ...slot.targetDurationSeconds },
      status,
      sourceImageAvailable,
      ...(sourceImageUrl ? { sourceImageUrl } : {}),
      ...(binding && status === 'ready' ? {
        materialId: cleanText(binding.materialId, 300),
        materialUrl: cleanText(binding.materialUrl, 2_000),
        ...(cleanText(binding.posterUrl, 2_000) ? { posterUrl: cleanText(binding.posterUrl, 2_000) } : {}),
        ...(cleanText(binding.materialName, 300) ? { materialName: cleanText(binding.materialName, 300) } : {}),
        actualDurationSeconds: Number(binding.actualDurationSeconds),
      } : {}),
    };
  });
}
