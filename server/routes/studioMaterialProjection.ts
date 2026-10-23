import path from 'node:path';
import { signAssetUrl, signPathAssetUrl, sharedAssetRelativePath, tenantAssetRelativePath } from '../lib/assetAccess.js';
import { productIdentity } from '../digitalEmployees/contentProduction.js';
import { enterpriseAssetStableId } from '../digitalEmployees/contentBatchPlan.js';
import { productSceneMaterialProvenanceOf } from './studioProductSceneProvenance.js';
import { materialAssetV2FromRecord, type MaterialAssetV2Metadata } from '../../shared/contracts/materialAssetV2.js';
import { buildMaterialCapabilityManifest, type MaterialCapabilityManifest } from '../../shared/contracts/materialCapabilityManifest.js';
import { buildMaterialScriptAnalysis, type MaterialScriptAnalysis } from '../../shared/materialScriptAnalysis.js';
import type { AvatarMediaCheck } from '../lib/avatarMediaCheck.js';
import type { MaterialUsage } from '../lib/materialPolicy.js';
import type { MaterialSegment } from './studioMaterialAnalysisSegments.js';
import type { MaterialUsageSummary } from '../../shared/contracts/materialUsageTracking.js';
import type { ProductSceneKind } from '../../shared/contracts/productScenePreparation.js';
import type { SubCue } from './studioRenderManifestProjection.js';
import type { EnterpriseProfile } from './enterpriseProfileContracts.js';

export interface Material {
  avatarMediaCheck?: AvatarMediaCheck;
  transcript?: string;
  transcriptCues?: SubCue[];
  id: string;
  name: string;
  folder: string;
  type: 'video' | 'image' | 'audio';
  duration: number; // 秒，图片为 0
  width?: number;
  height?: number;
  aspectRatio?: number;
  size: string;
  file: string;     // PB 文件名；历史记录可能仍是 data/media 相对路径
  url: string;      // 受保护的 PB 播放路由；历史记录可能仍是 /media/<file>
  poster?: string;  // 封面用的帧画面：视频抽首帧，图片即自身
  objectKey?: string;
  posterObjectKey?: string;
  scope: 'shared' | 'own'; // shared=公共库（运营预置），own=用户自己上传
  tenantId?: string;
  usage?: MaterialUsage;   // 兼容旧数据；进入素材库后统一按 editable 使用
  sourceType?: string;
  sourceName?: string;
  sourceProvider?: string;
  contentSha256?: string;
  sourceCreator?: string;
  sourceUrl?: string;
  licenseEvidence?: string;
  rightsStatus?: string;
  rightsEvidenceRef?: string;
  licenseName?: string;
  licenseUrl?: string;
  attributionText?: string;
  licenseEvidenceCapturedAt?: string;
  licenseEvidenceTextSha256?: string;
  importBatchId?: string;
  manifestSha256?: string;
  importedAt?: string;
  commercialUseApproved?: boolean;
  derivativesApproved?: boolean;
  rawLibraryUseApproved?: boolean;
  provenance?: Record<string, unknown>;
  materialV2?: MaterialAssetV2Metadata | null;
  capabilityManifest?: MaterialCapabilityManifest;
  enterpriseCommon?: boolean;
  pinned?: boolean;
  industry?: string;
  shotFunction?: string;
  applicability?: string;
  tags?: string;
  productId?: string;
  productName?: string;
  productSceneType?: ProductSceneKind;
  segmentAnalysisStatus?: 'pending' | 'analyzing' | 'completed' | 'failed';
  segmentAnalysisError?: string;
  segments?: MaterialSegment[];
  scriptAnalysis?: MaterialScriptAnalysis;
  analysisSourceRevision?: string;
  sourceRevision?: string;
  createdAt: string;
  libraryRemovedAt?: string;
  usageSummary?: MaterialUsageSummary;
}

function privateStudioAssetUrl(namespace: string, tenantId: string, file: string): string {
  return signAssetUrl(`/api/overseas/studio/private-assets/${namespace}/${path.basename(file)}`, tenantId);
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function materialResponse(material: Material, tenantId: string): Promise<Material & { canManage: boolean }> {
  // Some deterministic local renderers persist a tenant-scoped `file` before
  // object-storage mirroring is available.  The record is still a valid media
  // asset; expose its protected local route instead of returning an empty URL
  // that leaves the shared media frame in a permanent error state.
  const storedFileUrl = material.file
    ? `/media/${material.scope === 'shared'
      ? sharedAssetRelativePath(material.file)
      : tenantAssetRelativePath(tenantId, material.file)}`
    : '';
  const sourceUrl = material.url || storedFileUrl;
  const url = material.objectKey
    ? privateStudioAssetUrl('materials', tenantId, path.basename(material.objectKey))
    : /^\/(?:cloud-files|studio-media)\//.test(sourceUrl)
      // Studio workflows often span script, material, music and render steps.
      // Keep the protected playback URL valid for the whole editing session.
      ? signPathAssetUrl(sourceUrl, tenantId, 24 * 60 * 60 * 1000)
      : /^\/(?:media|api\/overseas\/studio\/materials\/pb)\//.test(sourceUrl) ? signAssetUrl(sourceUrl, tenantId) : sourceUrl;
  const poster = material.posterObjectKey
    ? privateStudioAssetUrl('materials', tenantId, path.basename(material.posterObjectKey))
    : material.poster && /^\/(?:cloud-files|studio-media)\//.test(material.poster)
      ? signPathAssetUrl(material.poster, tenantId, 24 * 60 * 60 * 1000)
      : material.poster && /^\/(?:media|api\/overseas\/studio\/materials\/pb)\//.test(material.poster)
        ? signAssetUrl(material.poster, tenantId, 24 * 60 * 60 * 1000)
        : material.poster;
  const segments = await Promise.all((material.segments || []).map(async segment => ({
    ...segment,
    poster: segment.posterObjectKey ? privateStudioAssetUrl('materials', tenantId, path.basename(segment.posterObjectKey)) : segment.poster,
    posterObjectKey: undefined,
  })));
  const scriptAnalysis = material.scriptAnalysis || (material.segmentAnalysisStatus === 'completed' && material.analysisSourceRevision
    ? buildMaterialScriptAnalysis({
      materialId: material.id,
      name: material.name,
      sourceRevision: material.analysisSourceRevision,
      duration: material.duration,
      segments: material.segments as unknown as Array<Record<string, unknown>>,
      analyzedAt: material.createdAt,
    })
    : undefined);
  const materialV2 = materialAssetV2FromRecord(material as unknown as Record<string, unknown>);
  const capabilityManifest = buildMaterialCapabilityManifest({
    ...material, scriptAnalysis, materialV2,
  } as unknown as Record<string, unknown>);
  const productSceneType = productSceneMaterialProvenanceOf(material as unknown as Record<string, unknown>)?.kind;
  return { ...material, url: url || material.url, poster, segments, scriptAnalysis, materialV2, capabilityManifest, enterpriseCommon: materialV2?.enterpriseCommon ?? material.enterpriseCommon ?? false, ...(productSceneType ? { productSceneType } : {}), canManage: material.sourceType !== 'enterprise_product_table' && material.scope !== 'shared' && material.tenantId === tenantId, objectKey: undefined, posterObjectKey: undefined };
}

export function enterpriseProductMaterials(tenantId: string, profile: EnterpriseProfile): Material[] {
  return (profile.products.items || []).flatMap((product, productIndex) => {
    const productId = productIdentity(product, productIndex);
    const productName = String(product.name || product.sku || `产品 ${productIndex + 1}`).trim();
    const groups = ['images', 'videos', 'factoryImages', 'packagingImages', 'sceneImages', 'brandAssets']
      .map(group => Array.isArray((product as Record<string, unknown>)[group]) ? (product as Record<string, unknown>)[group] as Array<Record<string, unknown>> : [])
      .filter(group => group.length);
    if (String(product.imageUrl || '').trim()) groups.unshift([{ type: 'image', url: product.imageUrl, name: '产品主图' }]);
    return groups.flat().flatMap((asset, assetIndex) => {
      const url = String(asset.url || '').trim();
      if (!url) return [];
      const type = String(asset.type || '').startsWith('video') ? 'video' as const : 'image' as const;
      return [{
        id: enterpriseAssetStableId(productIndex, assetIndex, url),
        tenantId,
        name: String(asset.name || `${productName}${type === 'video' ? '视频' : '图片'} ${assetIndex + 1}`).trim(),
        folder: 'product',
        type,
        duration: 0,
        size: Number(asset.size || 0) > 0 ? humanSize(Number(asset.size)) : '企业产品表',
        file: '',
        url,
        poster: type === 'image' ? url : undefined,
        scope: 'own' as const,
        usage: 'editable' as const,
        sourceType: 'enterprise_product_table',
        sourceName: '企业中心产品表',
        rightsStatus: 'authorized',
        rightsEvidenceRef: `enterprise_profile:product:${productId}`,
        licenseEvidence: `enterprise_profile:product:${productId}`,
        commercialUseApproved: true,
        derivativesApproved: true,
        rawLibraryUseApproved: true,
        productId,
        productName,
        tags: `产品素材,${productName}`,
        createdAt: String(asset.updatedAt || new Date(0).toISOString()),
      } satisfies Material];
    });
  });
}
