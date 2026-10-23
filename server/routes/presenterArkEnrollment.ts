import { Router, raw } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import convertHeic from 'heic-convert';
import type { DataStore } from '../storage/datastore.js';
import { readLocalMaterials, saveLocalMaterials, updateLocalMaterial } from '../lib/materialLibrary.js';
import { isTenantPrivateObjectKey, materialAssetObjectKey } from '../storage/materialAssets.js';
import { objectStorageHead, objectStorageSignedGetUrl, objectStorageSupplierDeliveryReady, objectStorageUpload } from '../storage/objectStorage.js';
import { VolcengineArkAssets } from '../lib/volcengineArkAssets.js';
import type { PresenterAsset, ProductionDefaults } from '../../src/lib/shotProduction.js';

type Row = { id: string; tenant_id: string; kind: string; request_id: string; payload: Enrollment };
type Enrollment = { presenterId: string; photoMaterialId: string; videoMaterialId: string; photoObjectEtag: string; videoObjectEtag: string; projectName: string; groupId: string; assetId: string; bytedToken: string; verificationUrl: string; state: 'needs_verification' | 'processing' | 'ready' | 'failed' | 'uncertain'; error: string; createdAt: string; updatedAt: string };
type Exclusive = <T>(key: string, operation: () => Promise<T>) => Promise<T>;
const collection = 'studio_presenter_assets';
const publicState = (row: Row) => ({ id: row.id, presenterId: row.payload.presenterId, state: row.payload.state,
  verificationUrl: row.payload.state === 'needs_verification' ? row.payload.verificationUrl : '', error: row.payload.error,
  assetUri: row.payload.state === 'ready' ? `asset://${row.payload.assetId}` : '', updatedAt: row.payload.updatedAt });

export function createPresenterArkEnrollmentRouter(store: DataStore, exclusive: Exclusive, dependencies: {
  ark?: VolcengineArkAssets; signedUrl?: typeof objectStorageSignedGetUrl; supplierReady?: () => boolean;
} = {}) {
  const router = Router(); const ark = dependencies.ark || new VolcengineArkAssets();
  const signedUrl = dependencies.signedUrl || objectStorageSignedGetUrl;
  const supplierReady = dependencies.supplierReady || objectStorageSupplierDeliveryReady;
  const defaultsFor = async (tenantId: string) => (await store.list<{ id: string; tenant_id: string; payload: ProductionDefaults }>('studio_production_defaults', { where: { tenant_id: tenantId }, perPage: 1 })).items[0];
  const own = async (id: string, tenantId: string) => {
    const row = await store.getById<Row>(collection, id);
    if (!row || row.tenant_id !== tenantId || row.kind !== 'ark_enrollment') throw new Error('当前企业的人物认证任务不存在');
    return row;
  };
  const save = async (row: Row, patch: Partial<Enrollment>) => {
    const payload = { ...row.payload, ...patch, updatedAt: new Date().toISOString() };
    if (!await store.update(collection, row.id, { payload })) throw new Error('方舟认证状态保存失败，请核对原任务');
    row.payload = payload; return row;
  };
  router.get('/ark-enrollments/capabilities', (_req, res) => {
    const missing = [
      !ark.configured() && { code: 'provider_credentials', label: '方舟真人资产服务尚未配置' },
      !supplierReady() && { code: 'public_asset_delivery', label: '照片存储尚不能通过公网 HTTPS 交付方舟' },
      !/^https:\/\/[^/]+/.test(String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_APP_URL || ''))
        && { code: 'verification_return_url', label: '本人验证回跳地址尚未配置' },
    ].filter((item): item is { code: 'provider_credentials' | 'public_asset_delivery' | 'verification_return_url'; label: string } => Boolean(item));
    res.json({ ready: missing.length === 0, missing: missing.map(item => item.code), reason: missing.map(item => item.label).join('；') });
  });
  router.post('/ark-enrollments/materials', raw({ type: 'application/octet-stream', limit: '100mb' }), async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const type = String(req.query.type || ''), mime = String(req.query.mime || '').toLowerCase().split(';')[0].trim();
      const source = req.body as Buffer;
      if (!Buffer.isBuffer(source) || !source.length || source.length > 100 * 1024 * 1024 || !['image', 'video'].includes(type)) throw new Error('人物文件无效或超过 100 MB');
      let bytes: Buffer, contentType: string, extension: string;
      if (type === 'image') {
        if (!['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/octet-stream'].includes(mime)) throw new Error('请上传 JPG、PNG 或 HEIC 照片');
        const metadata = await sharp(source).metadata();
        if (!['jpeg', 'png', 'heif'].includes(metadata.format || '') || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000) throw new Error('照片格式或尺寸不受支持');
        bytes = metadata.format === 'heif'
          ? Buffer.from(await convertHeic({ buffer: source, format: 'JPEG', quality: 0.92 }))
          : await sharp(source).rotate().jpeg({ quality: 92 }).toBuffer();
        contentType = 'image/jpeg'; extension = 'jpg';
      } else {
        const mp4 = ['video/mp4', 'video/quicktime'].includes(mime) && source.toString('ascii', 4, 8) === 'ftyp';
        // MediaRecorder implementations may retain a codecs parameter in the
        // MIME and browser-generated WebM should be recognized by its EBML
        // signature. The bytes are authoritative; the query MIME is only a
        // delivery hint.
        const webm = source.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        if (!mp4 && !webm) throw new Error('请上传 MP4、MOV 或 WebM 视频');
        bytes = source; contentType = mime; extension = webm ? 'webm' : mime === 'video/quicktime' ? 'mov' : 'mp4';
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      const id = `presenter-ark-${type}-${createHash('sha256').update(`${tenantId}:${digest}`).digest('hex').slice(0, 24)}`;
      const result = await exclusive('presenter-ark-material-library', async () => {
        const existing = readLocalMaterials().find(item => item.id === id && item.tenantId === tenantId);
        if (existing) return { id, type, name: existing.name };
        const key = materialAssetObjectKey(tenantId, `${id}.${extension}`);
        await objectStorageUpload({ key, body: bytes, contentType });
        const head = await objectStorageHead(key); if (!head?.etag) throw new Error('人物文件入库后缺少对象版本');
        const material = { id, name: type === 'image' ? '企业人物正面照片' : '企业人物本人视频', folder: 'presenter', type, scope: 'own', tenantId,
          objectKey: key, objectEtag: head.etag, contentSha256: digest, file: '', url: '', size: `${Math.ceil(bytes.length / 1024)} KB`, duration: 0,
          sourceType: 'presenter-ark-enrollment', createdAt: new Date().toISOString() };
        saveLocalMaterials([...readLocalMaterials(), material]);
        return { id, type, name: material.name };
      });
      res.status(201).json(result);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '人物文件上传失败' }); }
  });
  router.get('/ark-enrollments', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string; const presenterId = String(req.query.presenterId || '');
      if (!presenterId) throw new Error('请选择企业人物');
      const rows = await store.list<Row>(collection, { where: { tenant_id: tenantId, kind: 'ark_enrollment' }, perPage: 100 });
      res.json(rows.items.filter(row => row.tenant_id === tenantId && row.payload.presenterId === presenterId).sort((a, b) => b.payload.createdAt.localeCompare(a.payload.createdAt)).map(publicState));
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '人物认证任务读取失败' }); }
  });
  router.post('/ark-enrollments', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const requestId = String(req.body?.requestId || ''), presenterId = String(req.body?.presenterId || '');
      const photoMaterialId = String(req.body?.photoMaterialId || ''), videoMaterialId = String(req.body?.videoMaterialId || '');
      if (!/^[A-Za-z0-9_:.-]{1,150}$/.test(requestId) || !presenterId || !photoMaterialId || !videoMaterialId) throw new Error('人物认证请求缺少人物、视频或照片');
      if (req.body?.subjectAdultConfirmed !== true || req.body?.arkProcessingAuthorized !== true) throw new Error('请由成年出镜本人确认方舟真人认证与照片处理授权');
      const result = await exclusive(`ark-enroll:${tenantId}:${requestId}`, async () => {
        const prior = (await store.list<Row>(collection, { where: { tenant_id: tenantId, kind: 'ark_enrollment', request_id: requestId }, perPage: 1 })).items[0];
        if (prior) {
          if (prior.payload.presenterId !== presenterId || prior.payload.photoMaterialId !== photoMaterialId || prior.payload.videoMaterialId !== videoMaterialId) throw new Error('请求标识已用于另一组人物资料');
          return publicState(prior);
        }
        if (!ark.configured()) throw new Error('方舟真人资产服务尚未配置');
        if (!supplierReady()) throw new Error('人物照片存储尚不能通过公网 HTTPS 交付方舟');
        const defaults = await defaultsFor(tenantId);
        const presenter = defaults?.payload.presenters.find(item => item.id === presenterId && item.authorized);
        if (!defaults || !presenter) throw new Error('请选择已保存且授权的企业人物');
        if (!presenter.referenceMaterialIds?.includes(photoMaterialId) || !presenter.referenceMaterialIds?.includes(videoMaterialId)) throw new Error('视频和照片必须属于当前人物');
        const materials = readLocalMaterials(); const objectVersions: Record<string, string> = {};
        for (const [id, type] of [[photoMaterialId, 'image'], [videoMaterialId, 'video']]) {
          const material = materials.find(item => item.id === id && item.tenantId === tenantId && item.scope === 'own' && item.type === type);
          if (!material || !isTenantPrivateObjectKey(String(material.objectKey || ''), tenantId)) throw new Error(`当前人物${type === 'image' ? '照片' : '视频'}未安全入库`);
          const head = await objectStorageHead(material.objectKey);
          if (!head?.etag || material.objectEtag && material.objectEtag !== head.etag) throw new Error(`当前人物${type === 'image' ? '照片' : '视频'}对象版本已变化，请重新上传`);
          objectVersions[type] = head.etag;
        }
        const projectName = presenter.arkCertification?.projectName || process.env.VOLCENGINE_ARK_PROJECT_NAME || 'default';
        const groupId = presenter.arkCertification?.groupId || '';
        const now = new Date().toISOString();
        const base = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
        if (!groupId && !/^https:\/\/[^/]+/.test(base)) throw new Error('真人认证回跳地址未配置为公网 HTTPS');
        const returnUrl = groupId ? null : new URL(base);
        returnUrl?.searchParams.set('page', 'enterprise');
        returnUrl?.searchParams.set('arkVerification', 'complete');
        returnUrl?.searchParams.set('arkPresenterId', presenterId);
        const session = groupId ? null : await ark.createValidationSession(projectName, returnUrl!.toString());
        const payload: Enrollment = { presenterId, photoMaterialId, videoMaterialId, photoObjectEtag: objectVersions.image, videoObjectEtag: objectVersions.video, projectName, groupId, assetId: '', bytedToken: session?.BytedToken || '',
          verificationUrl: session?.H5Link || '', state: groupId ? 'processing' : 'needs_verification', error: '', createdAt: now, updatedAt: now };
        const row = await store.create<Row>(collection, { tenant_id: tenantId, kind: 'ark_enrollment', request_id: requestId, payload });
        if (!row) throw new Error('方舟认证任务留档失败，请勿重复开始认证');
        const declaration = { ...(presenter.authorizationConfirmation || { id: randomUUID(), recordedAt: now, version: 'presenter-upload-authorization-v1' }), subjectAdultConfirmed: true, arkProcessingAuthorized: true };
        const rights = { ...(presenter.rightsEvidence || {}), authorizationRef: presenter.rightsEvidence?.authorizationRef || `document://presenter-declarations/${declaration.id}`,
          consentRef: presenter.rightsEvidence?.consentRef || `consent://presenter-declarations/${declaration.id}`, grantedAt: presenter.rightsEvidence?.grantedAt || now,
          subjectAdultConfirmed: true, permittedProviders: [...new Set([...(presenter.rightsEvidence?.permittedProviders || []), 'volcengine_ark' as const])],
          permittedUses: [...new Set([...(presenter.rightsEvidence?.permittedUses || []), 'digital_presenter' as const, 'person_replacement' as const])] };
        const updated: PresenterAsset = { ...presenter, authorizationConfirmation: declaration, rightsEvidence: rights,
          arkCertification: { projectName, groupId, assetUri: '', assetType: 'image', status: groupId ? 'processing' : 'authorization_pending', materialId: photoMaterialId } };
        const authorizationSaved = await exclusive(`defaults:${tenantId}`, async () => {
          const latest = await defaultsFor(tenantId);
          if (!latest?.payload.presenters.some(item => item.id === presenterId && item.referenceMaterialIds?.includes(photoMaterialId) && item.referenceMaterialIds?.includes(videoMaterialId))) return false;
          return store.update('studio_production_defaults', latest.id, { payload: { ...latest.payload,
            presenters: latest.payload.presenters.map(item => item.id === presenterId ? { ...item, authorizationConfirmation: declaration, rightsEvidence: rights,
              arkCertification: updated.arkCertification, assetVersion: Math.max(1, item.assetVersion || 1) + 1 } : item) } });
        });
        if (!authorizationSaved) { await save(row, { state: 'failed', error: '人物资料已变化，授权记录未保存；请重新开始认证' }); throw new Error('人物授权记录保存失败，请核对原认证任务'); }
        return publicState(row);
      });
      res.json(result);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '方舟认证启动失败' }); }
  });
  router.post('/ark-enrollments/:id/refresh', async (req, res) => {
    try {
      const tenantId = res.locals.tenantId as string;
      const result = await exclusive(`ark-enroll-refresh:${tenantId}:${req.params.id}`, async () => {
        const row = await own(String(req.params.id), tenantId); const p = row.payload;
        if (p.state === 'ready' || p.state === 'failed') return publicState(row);
        if (p.state === 'uncertain') {
          if (!p.groupId) return publicState(row);
          const recovered = await ark.findImageByName(p.projectName, p.groupId, `lingshu-${row.id}`);
          if (!recovered) return publicState(row);
          await save(row, { assetId: recovered.Id, state: 'processing' });
        }
        let groupId = p.groupId;
        if (!groupId) {
          if (Date.now() - Date.parse(p.createdAt) > 29 * 60_000) return publicState(await save(row, { state: 'failed', error: '本人验证链接已过期，请重新开始认证' }));
          try { groupId = (await ark.validationResult(p.projectName, p.bytedToken)).GroupId || ''; }
          catch { return publicState(row); }
          if (!/^group-[a-z0-9-]+$/i.test(groupId)) return publicState(row);
          await save(row, { groupId, state: 'processing', verificationUrl: '' });
        }
        if (!row.payload.assetId) {
          const material = readLocalMaterials().find(item => item.id === p.photoMaterialId && item.tenantId === tenantId && item.type === 'image');
          if (!material || !isTenantPrivateObjectKey(String(material.objectKey || ''), tenantId) || (await objectStorageHead(material.objectKey))?.etag !== p.photoObjectEtag) throw new Error('原人物照片版本已变化，请重新上传');
          // CreateAsset is async. An ambiguous network outcome must never trigger another paid upload.
          await save(row, { state: 'uncertain' });
          const assetId = await ark.createImage(p.projectName, groupId, await signedUrl(material.objectKey, 3600), `lingshu-${row.id}`);
          await save(row, { assetId, state: 'processing' });
        }
        const asset = await ark.getAsset(p.projectName, row.payload.assetId);
        if (asset.Id !== row.payload.assetId || asset.GroupId !== groupId || asset.AssetType !== 'Image') throw new Error('方舟图片资产与当前认证人物不一致');
        if (asset.Status === 'Failed') return publicState(await save(row, { state: 'failed', error: asset.Error?.Message || '图片未通过方舟审核' }));
        if (asset.Status !== 'Active') return publicState(row);
        const defaults = await defaultsFor(tenantId); const presenter = defaults?.payload.presenters.find(item => item.id === p.presenterId);
        if (!defaults || !presenter || !presenter.referenceMaterialIds?.includes(p.photoMaterialId)) throw new Error('人物资料已变更，不能绑定旧认证结果');
        const certification: NonNullable<PresenterAsset['arkCertification']> = { projectName: p.projectName, groupId, assetUri: `asset://${asset.Id}`, assetType: 'image', status: 'active', materialId: p.photoMaterialId, syncedAt: new Date().toISOString(), verificationSource: 'ark_api' };
        const original = readLocalMaterials().find(item => item.id === p.photoMaterialId && item.tenantId === tenantId);
        if (!original || !isTenantPrivateObjectKey(String(original.objectKey || ''), tenantId) || (await objectStorageHead(original.objectKey))?.etag !== p.photoObjectEtag) throw new Error('方舟认证通过，但原人物照片版本已变化；请联系支持核对原任务');
        const bindingSaved = await exclusive(`defaults:${tenantId}`, async () => {
          const latest = await defaultsFor(tenantId);
          if (!latest?.payload.presenters.some(item => item.id === p.presenterId && item.referenceMaterialIds?.includes(p.photoMaterialId))) return false;
          return store.update('studio_production_defaults', latest.id, { payload: { ...latest.payload,
            presenters: latest.payload.presenters.map(item => item.id === p.presenterId ? {
              ...item, arkCertification: item.arkCertification?.status === 'active' && item.arkCertification.assetUri === certification.assetUri ? item.arkCertification : certification,
              assetVersion: item.arkCertification?.status === 'active' && item.arkCertification.assetUri === certification.assetUri
                ? item.assetVersion : Math.max(1, item.assetVersion || 1) + 1,
            } : item) } });
        });
        if (!bindingSaved) throw new Error('方舟认证通过，但人物绑定保存失败；请刷新原任务');
        if (!await exclusive('presenter-ark-material-library', async () => updateLocalMaterial(p.photoMaterialId, tenantId, { presenterAssetId: p.presenterId, seedanceTrustedAsset: { uri: certification.assetUri, kind: 'image', status: 'active', provider: 'volcengine_ark' } }))) throw new Error('方舟认证通过，但图片绑定保存失败；请刷新原任务');
        return publicState(await save(row, { state: 'ready' }));
      });
      res.json(result);
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : '方舟认证查询失败' }); }
  });
  return router;
}
