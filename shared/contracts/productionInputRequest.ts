/**
 * Durable input gaps for the whole production system.
 *
 * A request describes missing source truth or reusable source material. It is
 * deliberately separate from a shooting task: the resolver may satisfy it
 * from an existing material, an uploaded document, structured data or an
 * authorization record without asking the customer to shoot anything.
 */

export const PRODUCTION_INPUT_CATEGORIES = [
  'product_asset',
  'fact_evidence',
  'person_authorization',
  'scene_plate',
  'digital_human_input',
  'account_authorization',
  'production_choice',
  'other',
] as const;
export type ProductionInputCategory = typeof PRODUCTION_INPUT_CATEGORIES[number];

// Budget approval is deliberately absent: it authorizes an already calculated
// quote/upper bound and remains in ProductionCostQuote + the read-model
// `budget_confirmation` state instead of creating a second mutable truth here.

export const PRODUCTION_INPUT_KINDS = [
  'product_front_image',
  'product_side_image',
  'product_back_image',
  'product_detail_image',
  'product_transparent_png',
  'product_label_artwork',
  'product_packaging_dieline_pdf',
  'product_dimensions',
  'fact_evidence',
  'person_authorization',
  'scene_plate',
  'digital_human_portrait',
  'digital_human_voice_sample',
  'account_authorization',
  'production_choice',
  'content_clarification',
  'other',
] as const;
export type ProductionInputKind = typeof PRODUCTION_INPUT_KINDS[number];

export const PRODUCT_ASSET_REQUEST_KINDS = [
  'product_front_image',
  'product_side_image',
  'product_back_image',
  'product_detail_image',
  'product_transparent_png',
  'product_label_artwork',
  'product_packaging_dieline_pdf',
  'product_dimensions',
] as const satisfies readonly ProductionInputKind[];
export type ProductAssetRequestKind = typeof PRODUCT_ASSET_REQUEST_KINDS[number];

export type ProductionInputRequestStatus = 'open' | 'partial' | 'fulfilled' | 'waived';
export type ProductionInputFulfillmentType = 'material' | 'document' | 'structured_data' | 'authorization';

export interface ProductionInputBinding {
  taskId: string;
  shotId?: string | null;
}

export interface ProductDimensions {
  width: number;
  height: number;
  depth?: number | null;
  unit: 'mm' | 'cm' | 'in';
}

export interface ProductionInputFulfillment {
  fulfillmentKey: string;
  type: ProductionInputFulfillmentType;
  sourceId: string;
  materialId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  data?: Record<string, unknown> | null;
  suppliedBy: 'user' | 'material_library' | 'system';
  suppliedAt: string;
}

export interface ProductionInputRequest {
  id: string;
  schemaVersion: 'production-input-request.v1';
  category: ProductionInputCategory;
  kind: ProductionInputKind;
  status: ProductionInputRequestStatus;
  title: string;
  instructions: string;
  required: boolean;
  blocking: boolean;
  /** Stable subject for non-product requests, e.g. presenter:alice or claim:iso9001. */
  subjectRef: string | null;
  productId: string | null;
  productName: string | null;
  bindings: ProductionInputBinding[];
  acceptedMimeTypes: string[];
  specification: Record<string, unknown>;
  fulfillments: ProductionInputFulfillment[];
  minimumItems: number;
  createdAt: string;
  updatedAt: string;
  fulfilledAt: string | null;
  waivedAt: string | null;
  waiverReason: string | null;
}

export interface CreateProductionInputRequestInput {
  category?: ProductionInputCategory;
  kind: ProductionInputKind;
  title: string;
  instructions?: string;
  required?: boolean;
  blocking?: boolean;
  subjectRef?: string | null;
  productId?: string | null;
  productName?: string | null;
  bindings?: ProductionInputBinding[];
  acceptedMimeTypes?: string[];
  specification?: Record<string, unknown>;
  minimumItems?: number;
}

/** Compatibility name for product-specific consumers. */
export type ProductAssetRequest = ProductionInputRequest & {
  category: 'product_asset';
  kind: ProductAssetRequestKind;
  productId: string;
};

export function productionInputCategoryForKind(kind: ProductionInputKind): ProductionInputCategory {
  if ((PRODUCT_ASSET_REQUEST_KINDS as readonly string[]).includes(kind)) return 'product_asset';
  if (kind === 'fact_evidence') return 'fact_evidence';
  if (kind === 'person_authorization') return 'person_authorization';
  if (kind === 'scene_plate') return 'scene_plate';
  if (kind === 'digital_human_portrait' || kind === 'digital_human_voice_sample') return 'digital_human_input';
  if (kind === 'account_authorization') return 'account_authorization';
  if (kind === 'production_choice' || kind === 'content_clarification') return 'production_choice';
  return 'other';
}
