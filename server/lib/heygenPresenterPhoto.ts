import fs from 'node:fs';
import path from 'node:path';
import type { PresenterAsset } from '../../src/lib/shotProduction.js';
import { readLocalMaterials } from './materialLibrary.js';
import { objectStorageDownload } from '../storage/objectStorage.js';
import { validatePresenterRightsEvidence } from './presenterAssetTrust.js';

export async function resolveHeyGenPresenterPhoto(tenantId: string, presenter: PresenterAsset) {
  const rights = validatePresenterRightsEvidence(presenter.rightsEvidence, { provider: 'heygen', uses: ['digital_presenter', 'voice_synthesis'] });
  if (!rights.ok) throw new Error(`照片口播授权未完成：${rights.reasons.join('、')}`);
  const ids = presenter.referenceMaterialIds || [];
  const material = readLocalMaterials().find(item => ids.includes(String(item.id)) && item.type === 'image' && item.scope === 'own' && String(item.tenantId || item.tenant_id || '') === tenantId);
  if (!material) throw new Error('未找到本企业已绑定的人物照片');
  if (material.objectKey) { const object = await objectStorageDownload(String(material.objectKey)); if (object?.buf.length) return { bytes: object.buf, mimeType: object.contentType }; }
  const root = path.resolve(process.cwd(), 'data/media');
  const file = path.resolve(root, String(material.file || ''));
  if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file)) throw new Error('人物照片文件不可读取');
  return { bytes: fs.readFileSync(file), mimeType: /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg' };
}
