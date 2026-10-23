import { productIdentity } from '../digitalEmployees/contentProduction.js';
import { ProductSceneUploadProbeError, probeProductSceneUploadVideo } from '../lib/productSceneUploadProbe.js';
import { readTenantEnterpriseProfile } from './enterprise.js';
import { PRODUCT_SCENE_KINDS, type ProductSceneKind } from '../../shared/contracts/productScenePreparation.js';

export const PRODUCT_SCENE_UPLOAD_SOURCE = 'product-scene-preparation';

export interface ProductSceneUploadIntent {
  productId: string;
  productName: string;
  kind: ProductSceneKind;
}

export interface MaterialUploadProductBinding {
  productId: string;
  productName: string;
}

class ProductSceneUploadContextError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProductSceneUploadContextError';
    this.status = status;
  }
}

export async function resolveProductSceneUploadIntent(input: {
  tenantId: string;
  type: string;
  sourceType: string;
  productId: unknown;
  productSceneType: unknown;
}): Promise<ProductSceneUploadIntent | undefined> {
  const productId = String(input.productId || '').trim();
  const rawKind = String(input.productSceneType || '').trim();
  const requested = input.sourceType === PRODUCT_SCENE_UPLOAD_SOURCE || Boolean(rawKind);
  if (!requested) return undefined;
  if (input.type !== 'video') throw new ProductSceneUploadContextError(400, '预制素材仅支持视频文件');
  if (!productId || !rawKind) throw new ProductSceneUploadContextError(400, '请从产品详情中选择预制素材位后上传');
  const kind = rawKind as ProductSceneKind;
  if (!PRODUCT_SCENE_KINDS.includes(kind)) throw new ProductSceneUploadContextError(400, '预制素材位无效');
  const profile = await readTenantEnterpriseProfile(input.tenantId);
  const product = (profile.products.items || []).find((item, index) => productIdentity(item, index) === productId);
  if (!product) throw new ProductSceneUploadContextError(400, '关联产品不在当前企业资料中');
  return { productId, productName: String(product.name || product.sku || '').trim(), kind };
}

export async function resolveMaterialUploadProductBinding(
  tenantId: string,
  productIdValue: unknown,
): Promise<MaterialUploadProductBinding | undefined> {
  const productId = String(productIdValue || '').trim();
  if (!productId) return undefined;
  const profile = await readTenantEnterpriseProfile(tenantId);
  const product = (profile.products.items || []).find((item, index) => productIdentity(item, index) === productId);
  if (!product) throw new ProductSceneUploadContextError(400, '关联产品不在当前企业资料中');
  return { productId, productName: String(product.name || product.sku || productId).trim() };
}

export async function verifyProductSceneUpload(
  intent: ProductSceneUploadIntent | undefined,
  mediaPath: string,
  contentSha256: string,
): Promise<VerifiedProductSceneUpload | undefined> {
  if (!intent) return undefined;
  const verified = await probeProductSceneUploadVideo(mediaPath);
  return { ...intent, ...verified, contentSha256: contentSha256.toLowerCase() };
}

export function productSceneUploadErrorResponse(error: unknown): { status: number; message: string } | undefined {
  if (error instanceof ProductSceneUploadContextError) return { status: error.status, message: error.message };
  if (error instanceof ProductSceneUploadProbeError) return {
    status: error.code === 'product_scene_media_probe_unavailable' ? 503 : 422,
    message: error.message,
  };
  return undefined;
}

export interface VerifiedProductSceneUpload {
  productId: string;
  productName: string;
  kind: ProductSceneKind;
  durationSeconds: number;
  width: number;
  height: number;
  decodedFrameCount: number;
  verificationMethod: 'ffmpeg_full_decode';
  contentSha256: string;
}

export function productSceneUploadReuseMetadata(context?: VerifiedProductSceneUpload): {
  licenseEvidence?: string;
  commercialUseApproved?: boolean;
  derivativesApproved?: boolean;
  rawLibraryUseApproved?: boolean;
  authorizationScopes?: string[];
} {
  if (!context
    || !String(context.productId || '').trim()
    || !PRODUCT_SCENE_KINDS.includes(context.kind)
    || context.verificationMethod !== 'ffmpeg_full_decode'
    || !Number.isFinite(context.durationSeconds)
    || context.durationSeconds <= 0
    || !Number.isSafeInteger(context.decodedFrameCount)
    || context.decodedFrameCount < 1
    || !/^[a-f0-9]{64}$/i.test(context.contentSha256)) return {};
  return {
    licenseEvidence: 'tenant_product_scene_upload',
    commercialUseApproved: true,
    derivativesApproved: true,
    rawLibraryUseApproved: true,
    authorizationScopes: ['content_reuse', 'model_input', 'enterprise-video'],
  };
}
