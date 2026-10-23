import { readMaterialLibrary } from './materialLibrary.js';
import { hasSeedanceTrustedAssetMetadata, seedanceTrustedAssetForMaterial } from './seedanceTrustedAsset.js';

/** Validates that presenter references are visible to this tenant and are real image/video assets. */
export async function validatePresenterReferenceMaterials(tenantId: string, ids: string[], load: typeof readMaterialLibrary = readMaterialLibrary) {
  const unique = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))];
  if (!unique.length) return;
  const library = await load(tenantId);
  if (library.status === 'unavailable') throw new Error('人物素材库当前不可用，未保存企业人物');
  const byId = new Map(library.items.map(item => [String(item.id), item]));
  for (const id of unique) {
    const material = byId.get(id);
    if (!material) throw new Error(`人物参考资产 ${id} 不存在、未授权或不属于当前企业`);
    if (!['image', 'video'].includes(String(material.type))) throw new Error(`人物参考资产 ${id} 必须是图片或视频`);
    if (!String(material.objectKey || '')) throw new Error(`人物参考资产 ${id} 尚未持久化到对象存储`);
    if (hasSeedanceTrustedAssetMetadata(material) && !seedanceTrustedAssetForMaterial(material)) throw new Error(`人物参考资产 ${id} 的 Seedance 可信资产配置无效：须为同类型、状态为 Active 的方舟 asset:// 素材`);
  }
}
