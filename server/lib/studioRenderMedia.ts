import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

/** Resolve an existing export only inside the authenticated tenant's render directory. */
export function safeStudioRenderOutputPath(root: string, tenantId: string, input: unknown): string | null {
  const filePath = typeof input === 'string' ? input : '';
  const fileName = path.basename(filePath);
  if (!/^[\w-]+$/.test(tenantId) || !path.isAbsolute(filePath) || !fileName || fileName.length > 255
    || path.extname(fileName).toLowerCase() !== '.mp4' || /[\0/\\]/.test(fileName)) return null;
  try {
    const requested = path.join(path.resolve(root), tenantId, path.basename(filePath));
    const folder = path.join(fs.realpathSync(root), tenantId);
    const target = path.join(folder, path.basename(filePath));
    if (path.resolve(filePath) !== requested || fs.realpathSync(folder) !== folder
      || fs.realpathSync(target) !== target || !fs.statSync(target).isFile()) return null;
    return target;
  } catch { return null; }
}

/** Mount after requireAuth. Only serve this tenant's local MP4 exports. */
export function studioRenderMediaRouter(root: string) {
  const router = Router();
  router.get('/:file', (req, res) => {
    const tenantId = String(res.locals.tenantId || '');
    const file = String(req.params.file || '');
    const target = safeStudioRenderOutputPath(root, tenantId, path.join(root, tenantId, file));
    if (!target) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(target);
  });
  return router;
}
