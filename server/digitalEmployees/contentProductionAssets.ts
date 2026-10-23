import fs from 'node:fs';
import path from 'node:path';
import { readMaterialLibrary } from '../lib/materialLibrary.js';
import { isSyntheticMaterial, syntheticMaterialMarker } from '../lib/materialTruthfulness.js';
import { enterpriseAssetObjectKey, enterpriseAssetTenantKey } from '../storage/enterpriseAssets.js';
import { objectStorageEnabled } from '../storage/objectStorage.js';
import { resolveMaterialProductAssociation, type ProductMaterialReference } from './materialProductionReadiness.js';
import type { EnterpriseProfile } from '../routes/enterprise.js';
import type { MaterialScriptAnalysis } from '../../shared/materialScriptAnalysis.js';
import type { AssetCandidate, StoredRecord } from './contentProductionContracts.js';
import { assetAuthorization, assetEligible, authoritativeMaterialRights, dimensions, json, productIdentity, stringList, text } from './contentProductionPlanning.js';

export function exactAnalysis(record: StoredRecord): boolean {
  const analysis = json<Record<string, unknown>>(record.aiAnalysis, {});
  return analysis.analysisMode === 'exact' && ['video', 'video_review_required'].includes(String(analysis.analysisQuality)) && Boolean(analysis.gemini);
}

function realMaterial(record: Record<string, unknown>, tenantId: string): boolean {
  if (isSyntheticMaterial(record)) return false;
  const scope = String(record.scope || 'own');
  return scope === 'shared' || String(record.tenantId || record.tenant_id || '') === tenantId;
}

function observationsForMaterial(record: Record<string, unknown>): string[] {
  const segments = Array.isArray(record.segments) ? record.segments as Array<Record<string, unknown>> : [];
  const fromSegments = segments.flatMap(segment => [
    text(segment.action, 180),
    text(segment.environment, 180),
    ...(Array.isArray(segment.subject) ? segment.subject.map(item => text(item, 100)) : []),
  ]).filter(Boolean);
  const confirmed = Array.isArray(record.visualObservations) ? record.visualObservations.filter((value): value is string => typeof value === 'string') : [];
  return [...new Set(fromSegments.length ? fromSegments : confirmed)].slice(0, 32);
}

export function mimeFromFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mov') return 'video/quicktime';
  return 'video/mp4';
}

function productMaterialReferences(profile: EnterpriseProfile): ProductMaterialReference[] {
  return (profile.products.items || []).map((product, index) => ({
    id: productIdentity(product, index),
    name: text(product.name, 200),
    sku: text(product.sku, 120),
  })).filter(product => product.name);
}

function localMaterials(tenantId: string, records: Array<Record<string, unknown>>, products: ProductMaterialReference[]): AssetCandidate[] {
  return records.filter(record => realMaterial(record, tenantId) && ['video', 'image'].includes(String(record.type || ''))).flatMap(record => {
    const relative = text(record.file, 500);
    const localPath = relative ? path.resolve(process.cwd(), 'data', 'media', relative) : '';
    const objectKey = text(record.objectKey, 1_000);
    if ((!localPath || !fs.existsSync(localPath) || fs.statSync(localPath).size <= 0) && !objectKey) return [];
    const source = String(record.scope || 'own') === 'shared' ? 'licensed_shared_material' as const : 'tenant_material' as const;
    const visualObservations = observationsForMaterial(record);
    const association = resolveMaterialProductAssociation(record, products);
    return [{
      id: text(record.id, 160), name: text(record.name, 200) || '企业素材', type: String(record.type) as 'video' | 'image',
      ...(localPath && fs.existsSync(localPath) ? { localPath } : {}), ...(objectKey ? { objectKey } : {}), duration: Math.max(0, Number(record.duration || 0)),
      observations: visualObservations, visualObservations, segments: Array.isArray(record.segments) ? record.segments as Array<Record<string, unknown>> : [],
      ...(record.scriptAnalysis ? { scriptAnalysis: record.scriptAnalysis as MaterialScriptAnalysis } : {}),
      ...authoritativeMaterialRights(record),
      ...(association ? { productId: association.productId, productName: association.productName } : {}),
      authorization: assetAuthorization(record, source), synthetic: isSyntheticMaterial(record), ...dimensions(record),
      tags: stringList(record.tags), source,
    }];
  });
}

export function resolveEnterpriseAssetLocation(
  assetUrl: string,
  tenantId: string,
  options: { assetsDir?: string; mediaDir?: string; objectStorage?: boolean } = {},
): Pick<AssetCandidate, 'url' | 'localPath' | 'objectKey'> {
  const url = text(assetUrl, 2_000);
  if (!url || syntheticMaterialMarker(url)) return {};
  if (/^(?:https?:|data:)/i.test(url)) return { url };
  // Imported product catalog images also live in the tenant media tree.
  if (url.startsWith('/media/tenants/')) {
    let relative: string;
    try { relative = decodeURIComponent(url.slice('/media/tenants/'.length).split(/[?#]/)[0]!); } catch { return {}; }
    const parts = relative.split('/');
    if (parts[0] !== tenantId || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || /\0/.test(part))) return {};
    const mediaDir = path.resolve(options.mediaDir || path.resolve(process.cwd(), 'data', 'media'));
    const tenantRoot = path.join(mediaDir, 'tenants', tenantId);
    const candidate = path.resolve(mediaDir, 'tenants', relative);
    try {
      const realRoot = fs.realpathSync(tenantRoot);
      const realFile = fs.realpathSync(candidate);
      if (!realFile.startsWith(realRoot + path.sep) || fs.statSync(realFile).size <= 0) return {};
      return { localPath: realFile };
    } catch { return {}; }
  }

  const match = url.match(/^\/api\/overseas\/enterprise\/assets\/([^/?#]+)(?:[?#].*)?$/i);
  if (!match) return {};
  let filename = '';
  try { filename = path.basename(decodeURIComponent(match[1]!)); } catch { return {}; }
  if (!filename || syntheticMaterialMarker(filename)) return {};
  const assetsDir = options.assetsDir || path.resolve(process.cwd(), 'data', 'enterprise-assets');
  const localPath = path.join(assetsDir, enterpriseAssetTenantKey(tenantId), filename);
  try {
    if (fs.statSync(localPath).size > 0) return { localPath };
  } catch { /* the tenant asset may live only in object storage */ }
  const useObjectStorage = options.objectStorage ?? objectStorageEnabled();
  return useObjectStorage ? { objectKey: enterpriseAssetObjectKey(tenantId, filename) } : {};
}

function enterpriseAssets(profile: EnterpriseProfile, tenantId: string): AssetCandidate[] {
  return (profile.products.items || []).flatMap((product, productIndex) => {
    const groups = [product.images, product.videos, product.factoryImages, product.packagingImages, product.sceneImages, product.brandAssets].filter(Array.isArray) as Array<Array<{ name: string; type: string; url?: string }>>;
    if (product.imageUrl) groups.unshift([{ name: `${product.name || '产品'}主图`, type: 'image', url: product.imageUrl }]);
    return groups.flat().flatMap((asset, assetIndex) => {
      const url = text(asset.url, 2_000);
      // A legitimate file may be named "product-demo.mp4". Only explicit
      // synthetic provenance markers are rejected; display words are not data lineage.
      const location = resolveEnterpriseAssetLocation(url, tenantId);
      if (!location.url && !location.localPath && !location.objectKey) return [];
      const type = /video/i.test(asset.type || '') || /\.(mp4|mov|webm)(?:\?|$)/i.test(url) ? 'video' as const : 'image' as const;
      const productId = productIdentity(product, productIndex);
      const visualObservations = [`企业知识库产品“${product.name || '未命名产品'}”的已上传${type === 'video' ? '视频' : '图片'}`];
      return [{
        id: `enterprise-product-${productIndex}-${assetIndex}-${Buffer.from(url).toString('base64url').slice(0, 12)}`,
        name: text(asset.name, 200) || `${product.name || '产品'}素材`, type, ...location, duration: 0,
        productId, productName: text(product.name, 200), observations: visualObservations, visualObservations, segments: [],
        authorization: assetAuthorization(asset as unknown as Record<string, unknown>, 'enterprise_product'), synthetic: false, ...dimensions(asset as unknown as Record<string, unknown>),
        tags: [text(product.category, 120), text(product.sku, 120), text(asset.name, 120)].filter(Boolean), source: 'enterprise_product' as const,
      }];
    });
  });
}

export async function collectProductionAssets(tenantId: string, profile: EnterpriseProfile): Promise<AssetCandidate[]> {
  const inventory = await readMaterialLibrary(tenantId);
  if (inventory.status === 'unavailable') throw Error('素材库暂时无法读取，请重试或联系管理员');
  const products = productMaterialReferences(profile);
  const cloud = inventory.items.filter(item => item.id.startsWith('pb-'));
  const cloudAssets = cloud.filter(record => realMaterial(record, tenantId) && ['video', 'image'].includes(String(record.type || ''))).map(record => {
    const association = resolveMaterialProductAssociation(record, products);
    return {
      id: text(record.id, 160), name: text(record.name, 200) || '云端素材', type: String(record.type) as 'video' | 'image',
      url: text(record.url, 2_000), cloudRecordId: text(record.id).replace(/^pb-/, ''), duration: Math.max(0, Number(record.duration || 0)),
      observations: observationsForMaterial(record), visualObservations: observationsForMaterial(record), segments: Array.isArray(record.segments) ? record.segments as Array<Record<string, unknown>> : [],
      ...(record.scriptAnalysis ? { scriptAnalysis: record.scriptAnalysis as MaterialScriptAnalysis } : {}),
      ...authoritativeMaterialRights(record),
      ...(association ? { productId: association.productId, productName: association.productName } : {}),
      authorization: assetAuthorization(record, String(record.scope || 'own') === 'shared' ? 'licensed_shared_material' : 'tenant_material'),
      synthetic: isSyntheticMaterial(record), ...dimensions(record), tags: stringList(record.tags),
      source: String(record.scope || 'own') === 'shared' ? 'licensed_shared_material' as const : 'tenant_material' as const,
    };
  });
  const byId = new Map([...localMaterials(tenantId, inventory.items.filter(item => !item.id.startsWith('pb-')), products), ...cloudAssets, ...enterpriseAssets(profile, tenantId)].map(asset => [asset.id, asset]));
  return [...byId.values()].filter(assetEligible);
}

