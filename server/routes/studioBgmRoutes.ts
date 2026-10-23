import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { AuthLocals } from '../middleware/auth.js';
import { signAssetUrl, sharedAssetRelativePath, tenantAssetDir, tenantAssetRelativePath } from '../lib/assetAccess.js';
import { requireAdminUser } from '../lib/demoAccounts.js';
import { studioBgmMediaPath, studioBgmObjectKey } from '../lib/studioBgmAccess.js';
import { studioRenderAssetPath } from '../lib/studioRenderSecurity.js';
import { materialAssetContentType, sharedObjectKey, tenantPrivateObjectKey } from '../storage/materialAssets.js';
import { objectStorageDelete, objectStorageEnabled, objectStorageGetObject, objectStorageSignedGetUrl, objectStorageUpload } from '../storage/objectStorage.js';
import { BGM_ROOT, loadBgm, materialSignedUrlTtlSeconds, persistBgm, userBgms, withRecommendedBgmNames, type BgmTrack } from './studioBgmCatalog.js';

/** Mounted after the Studio router's authentication and tenant-context middleware. */
export function createStudioBgmRouter() {
  const router = Router();

  // Same-origin authenticated stream. Never expose object keys or signed COS URLs to ffmpeg.
  router.get('/media/:id', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const track = userBgms(tenantId).find(item => item.id === req.params.id);
    if (!studioBgmMediaPath(track, tenantId)) { res.status(404).end(); return; }
    if (track?.objectKey) {
      const key = studioBgmObjectKey(track, tenantId);
      if (!key) { res.status(404).end(); return; }
      const object = await objectStorageGetObject(key, req.headers.range);
      if (!object) { res.status(404).end(); return; }
      res.setHeader('Content-Type', object.contentType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Accept-Ranges', object.acceptRanges || 'bytes');
      if (object.contentLength !== undefined) res.setHeader('Content-Length', String(object.contentLength));
      if (object.contentRange) { res.status(206); res.setHeader('Content-Range', object.contentRange); }
      for await (const chunk of object.body) res.write(chunk);
      res.end();
      return;
    }
    let sourcePath: string;
    try { sourcePath = studioRenderAssetPath(new URL(String(track?.url || ''), 'http://local').pathname, tenantId); }
    catch { res.status(404).end(); return; }
    if (!sourcePath.startsWith('/bgm/')) { res.status(404).end(); return; }
    const file = path.resolve(BGM_ROOT, sourcePath.replace(/^\/bgm\//, ''));
    const root = path.resolve(BGM_ROOT);
    if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(file);
  });

  router.get('/', async (_req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    res.json(await Promise.all(withRecommendedBgmNames(userBgms(tenantId)).map(async track => ({
      ...track,
      url: track.objectKey ? await objectStorageSignedGetUrl(track.objectKey, materialSignedUrlTtlSeconds()) : track.url ? signAssetUrl(track.url, tenantId) : track.url,
      objectKey: undefined,
    }))));
  });

  router.post('/', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const admin = await requireAdminUser(req);
    const { name, mood = '自定义', duration = 0, dataBase64, mimeType } = req.body ?? {};
    if (!dataBase64) { res.status(400).json({ ok: false, error: 'dataBase64 required' }); return; }
    const assetDir = admin ? path.join(BGM_ROOT, 'shared') : tenantAssetDir(BGM_ROOT, tenantId);
    try { fs.mkdirSync(assetDir, { recursive: true }); } catch { /* ignore */ }
    const id = randomUUID();
    const ext = (mimeType as string | undefined)?.split('/')[1]?.replace('mpeg', 'mp3') || 'mp3';
    const file = `${id}.${ext}`;
    const buf = Buffer.from(String(dataBase64).replace(/^data:[^,]+,/, ''), 'base64');
    const objectKey = objectStorageEnabled() ? (admin ? sharedObjectKey('bgm', file) : tenantPrivateObjectKey('bgm', tenantId, file)) : undefined;
    if (objectKey) await objectStorageUpload({ key: objectKey, body: buf, contentType: materialAssetContentType(file, String(mimeType || '')) });
    else fs.writeFileSync(path.join(assetDir, file), buf);
    const list = loadBgm();
    const tenantTracks = userBgms(tenantId);
    const track: BgmTrack = {
      id,
      name: `灵枢推荐配乐${String(tenantTracks.length + 1).padStart(2, '0')}`,
      mood,
      duration: Number(duration) || 0,
      file,
      url: objectKey ? '' : admin ? `/bgm/${sharedAssetRelativePath(file)}` : signAssetUrl(`/bgm/${tenantAssetRelativePath(tenantId, file)}`, tenantId),
      objectKey,
      tenantId: admin ? undefined : tenantId,
      scope: admin ? 'shared' : 'tenant',
      uploadedBy: admin ? '灵枢管理员上传' : '客户上传',
      createdAt: new Date().toISOString(),
    };
    list.push(track);
    persistBgm(list);
    res.status(201).json({ ok: true, track });
  });

  router.delete('/:id', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const list = loadBgm();
    const candidate = list.find(x => x.id === req.params.id);
    if (candidate?.builtin) {
      res.status(403).json({ ok: false, error: '官方配乐不可删除' });
      return;
    }
    const shared = Boolean(candidate && (candidate.scope === 'shared' || !candidate.tenantId));
    const admin = shared ? await requireAdminUser(req) : null;
    const t = candidate && (candidate.tenantId === tenantId || (shared && admin)) ? candidate : undefined;
    if (!t) { res.status(404).json({ ok: false, error: 'BGM not found' }); return; }
    const assetPath = t.scope === 'shared'
      ? path.join(BGM_ROOT, 'shared', t.file)
      : !t.tenantId
        ? path.join(BGM_ROOT, t.file)
        : path.join(tenantAssetDir(BGM_ROOT, tenantId), t.file);
    if (t.objectKey) await objectStorageDelete(t.objectKey).catch(() => undefined);
    else try { fs.unlinkSync(assetPath); } catch { /* ignore */ }
    persistBgm(list.filter(x => x.id !== req.params.id));
    res.json({ ok: true });
  });

  return router;
}
