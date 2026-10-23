import type { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import os from 'node:os';
import { objectStorageEnabled, objectStorageGetObject, objectStorageUpload } from '../storage/objectStorage.js';
import {
  enterpriseAssetContentType,
  enterpriseAssetObjectKey,
  enterpriseAssetTenantKey,
  enterpriseAssetTypeAllowed,
} from '../storage/enterpriseAssets.js';
import { currentDataAuthority } from '../storage/dataAuthority.js';
import { upsertTenantUploadCloudMaterial } from '../lib/cloudMaterials.js';
import { normalizeTenantMedia } from '../lib/tenantMediaNormalization.js';
import { downloadAndNormalizeExternalImage, ExternalImageImportError } from '../lib/externalProductImageImport.js';
import { readLocalMaterials } from '../lib/materialLibrary.js';
import { productFootageCandidateEvidence } from './enterpriseProductFootageCandidate.js';
import { upsertLocalEnterpriseMaterial } from './enterpriseLocalMaterial.js';
import { readTenantProfile } from './enterpriseProfileStore.js';
import type { AuthLocals } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '../../data/enterprise-assets');

function ensureAssetsDir(): void {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

function safeStoredName(originalName: string): string {
  const ext = path.extname(originalName).slice(0, 16).replace(/[^a-zA-Z0-9.]/g, '');
  return `${Date.now()}-${randomUUID()}${ext}`;
}

export function registerEnterpriseAssetRoutes(router: Router): void {
router.post('/assets', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const { name, type, dataUrl } = req.body as { name?: string; type?: string; dataUrl?: string };
  const productId = String(req.body?.productId || '').trim();
  if (productId) {
    const profile = await readTenantProfile(tenantId);
    if (!(profile.products.items || []).some(item => item.id === productId)) {
      res.status(422).json({ error: 'enterprise_product_image_product_not_found' }); return;
    }
  }
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!name || !match) {
    res.status(400).json({ error: 'invalid asset payload' });
    return;
  }
  let storedName = safeStoredName(name);
  let buffer = Buffer.from(match[2], 'base64');
  let contentType = enterpriseAssetContentType(name, type || match[1]);
  const footageEvidence = productId && contentType.startsWith('video/')
    ? productFootageCandidateEvidence({ productId, mediaType: contentType,
      identityEvidenceRef: req.body?.productIdentityEvidenceRef,
      rightsEvidenceRef: req.body?.rightsEvidenceRef }) : null;
  if (productId && !contentType.startsWith('image/') && !footageEvidence) {
    res.status(422).json({ error: contentType.startsWith('video/')
      ? 'enterprise_product_footage_evidence_required' : 'enterprise_product_image_or_video_required' }); return;
  }
  if (!enterpriseAssetTypeAllowed(contentType)) {
    res.status(415).json({ error: 'only image, video and PDF enterprise assets are supported' });
    return;
  }
  if (buffer.length === 0 || buffer.length > 110 * 1024 * 1024) {
    res.status(413).json({ error: 'enterprise asset must be between 1 byte and 110 MB' });
    return;
  }

  let material: Record<string, unknown> | undefined;
  let normalized: Awaited<ReturnType<typeof normalizeTenantMedia>> | undefined;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-enterprise-upload-'));
  try {
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
      normalized = await normalizeTenantMedia({
        buffer, originalName: name, declaredMimeType: contentType,
        kind: contentType.startsWith('image/') ? 'image' : contentType.startsWith('audio/') ? 'audio' : 'video',
        temporaryDirectory: tempDir,
      });
      buffer = normalized.buffer;
      storedName = safeStoredName(normalized.filename);
      contentType = normalized.mimeType;
    }
    if (productId && (contentType.startsWith('image/') || contentType.startsWith('video/')) && currentDataAuthority() === 'local') {
      const prior = readLocalMaterials().find(item => String(item.tenantId || item.tenant_id || '') === tenantId
        && String(item.contentSha256 || item.sha256 || '').toLowerCase() === (normalized?.sha256 || createHash('sha256').update(buffer).digest('hex')).toLowerCase());
      if (prior) {
        if (String(prior.productId || '') !== productId) {
          res.status(409).json({ error: 'enterprise_product_image_hash_product_conflict' }); return;
        }
        res.json({ name, type: contentType, size: buffer.length, updatedAt: prior.updatedAt,
          url: prior.sourceUrl || prior.url, material: prior, reused: true }); return;
      }
    }
    if (objectStorageEnabled()) {
      await objectStorageUpload({
        key: enterpriseAssetObjectKey(tenantId, storedName),
        body: buffer,
        contentType,
      });
    } else {
      ensureAssetsDir();
      const tenantDir = path.join(ASSETS_DIR, enterpriseAssetTenantKey(tenantId));
      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(path.join(tenantDir, storedName), buffer);
    }
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
      const materialInput: Parameters<typeof upsertTenantUploadCloudMaterial>[0] = {
        tenantId,
        title: name,
        folder: 'enterprise-upload',
        type: contentType.startsWith('image/') ? 'image' : contentType.startsWith('audio/') ? 'audio' : 'video',
        sizeBytes: buffer.length,
        duration: normalized?.duration,
        width: normalized?.width,
        height: normalized?.height,
        sha256: normalized?.sha256 || createHash('sha256').update(buffer).digest('hex'),
        scope: 'own',
        usage: 'editable',
        sourceType: 'enterprise_upload',
        sourceName: name,
        ...(productId ? { productId } : {}),
        sourceProvider: 'tenant',
        sourceUrl: `/api/overseas/enterprise/assets/${storedName}`,
        sourceEntry: 'enterprise_knowledge',
        provenance: {
          uploadMethod: 'enterprise_knowledge',
          sourceEntry: 'enterprise_knowledge',
          originalName: name,
          mimeType: contentType,
          receivedAt: new Date().toISOString(),
          uploadedByUserId: userId,
          knowledgeEligible: true,
          normalization: normalized?.normalization,
          ...(footageEvidence ? { footageCandidate: {
            productId: footageEvidence.productId,
            identityEvidenceRef: footageEvidence.identityEvidenceRef,
            rightsEvidenceRef: footageEvidence.rightsEvidenceRef,
            status: 'pending_independent_review',
          } } : {}),
        },
        media: { name: storedName, buf: buffer, contentType },
        ...(normalized?.poster ? { poster: { name: normalized.poster.filename, buf: normalized.poster.buffer, contentType: normalized.poster.mimeType } } : {}),
      };
      material = currentDataAuthority() === 'local'
        ? upsertLocalEnterpriseMaterial({
          tenantId, title: name, type: materialInput.type, sizeBytes: buffer.length,
          duration: normalized?.duration, width: normalized?.width, height: normalized?.height,
          sha256: materialInput.sha256, sourceUrl: String(materialInput.sourceUrl || ''), sourceName: name,
          objectKey: footageEvidence ? enterpriseAssetObjectKey(tenantId, storedName) : undefined,
          productId: productId || undefined,
          provenance: materialInput.provenance || {},
        })
        : await upsertTenantUploadCloudMaterial(materialInput);
      const materialId = String(material.id || '');
      if (materialId && !footageEvidence) void import('../lib/materialLibraryAnalysis.js')
        .then(module => module.requestMaterialAnalysis(tenantId, materialId))
        .catch(error => console.warn('[enterprise-assets] material analysis start failed', error instanceof Error ? error.message : error));
    }
  } catch (error) {
    console.error('[enterprise-assets] upload failed', error instanceof Error ? error.message : error);
    res.status(503).json({ error: 'enterprise asset storage unavailable' });
    return;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  res.json({
    name,
    type: contentType,
    size: buffer.length,
    updatedAt: new Date().toISOString(),
    url: `/api/overseas/enterprise/assets/${storedName}`,
    material,
  });
});

router.post('/assets/import-url', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const sourceUrl = String(req.body?.url || '').trim();
  const requestedName = String(req.body?.name || '').trim().slice(0, 160);
  const productId = String(req.body?.productId || '').trim().slice(0, 160);
  if (!sourceUrl) { res.status(400).json({ error: 'url is required' }); return; }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshu-product-image-import-'));
  try {
    const normalized = await downloadAndNormalizeExternalImage({ url: sourceUrl, temporaryDirectory: tempDir });
    const storedName = safeStoredName(normalized.filename);
    if (objectStorageEnabled()) {
      await objectStorageUpload({ key: enterpriseAssetObjectKey(tenantId, storedName), body: normalized.buffer, contentType: normalized.mimeType });
    } else {
      ensureAssetsDir();
      const tenantDir = path.join(ASSETS_DIR, enterpriseAssetTenantKey(tenantId));
      fs.mkdirSync(tenantDir, { recursive: true });
      fs.writeFileSync(path.join(tenantDir, storedName), normalized.buffer, { mode: 0o600 });
    }
    const enterpriseUrl = `/api/overseas/enterprise/assets/${storedName}`;
    const materialInput: Parameters<typeof upsertTenantUploadCloudMaterial>[0] = {
      tenantId, title: requestedName || path.basename(normalized.filename), folder: 'enterprise-upload', type: 'image',
      width: normalized.width, height: normalized.height, sizeBytes: normalized.buffer.length, sha256: normalized.sha256,
      scope: 'own', usage: 'editable', sourceType: 'enterprise_product_image_import', sourceName: requestedName || normalized.filename,
      sourceProvider: 'tenant', sourceUrl: normalized.sourceUrl, sourceEntry: 'enterprise_knowledge', productId: productId || undefined,
      provenance: { uploadMethod: 'enterprise_external_url', sourceEntry: 'enterprise_knowledge', originalUrl: normalized.sourceUrl,
        enterpriseAssetUrl: enterpriseUrl, normalization: normalized.normalization, knowledgeEligible: true, receivedAt: new Date().toISOString() },
      media: { name: storedName, buf: normalized.buffer, contentType: normalized.mimeType },
      ...(normalized.poster ? { poster: { name: normalized.poster.filename, buf: normalized.poster.buffer, contentType: normalized.poster.mimeType } } : {}),
    };
    const material = currentDataAuthority() === 'local'
      ? upsertLocalEnterpriseMaterial({
        tenantId, title: materialInput.title, type: 'image', sizeBytes: normalized.buffer.length,
        width: normalized.width, height: normalized.height, sha256: normalized.sha256,
        sourceUrl: enterpriseUrl, sourceName: String(materialInput.sourceName || materialInput.title), productId: productId || undefined,
        provenance: materialInput.provenance || {},
      })
      : await upsertTenantUploadCloudMaterial(materialInput);
    void import('../lib/materialLibraryAnalysis.js').then(module => module.requestMaterialAnalysis(tenantId, String(material.id || ''))).catch(() => {});
    res.status(201).json({ name: requestedName || normalized.filename, type: normalized.mimeType, size: normalized.buffer.length,
      width: normalized.width, height: normalized.height, sha256: normalized.sha256, sourceUrl: normalized.sourceUrl,
      url: enterpriseUrl, material });
  } catch (error) {
    const known = error instanceof ExternalImageImportError;
    res.status(known ? 422 : 503).json({ error: error instanceof Error ? error.message : 'external image import failed', ...(known ? { code: error.code } : {}) });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

router.get('/assets/:file', async (req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const file = path.basename(req.params.file);
  if (objectStorageEnabled()) {
    try {
      const requestedRange = /^bytes=\d*-\d*$/.test(String(req.headers.range || ''))
        ? String(req.headers.range)
        : undefined;
      const object = await objectStorageGetObject(enterpriseAssetObjectKey(tenantId, file), requestedRange);
      if (object) {
        res.setHeader('Content-Type', object.contentType);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Accept-Ranges', object.acceptRanges || 'bytes');
        if (object.contentLength !== undefined) res.setHeader('Content-Length', String(object.contentLength));
        if (object.contentRange) {
          res.status(206);
          res.setHeader('Content-Range', object.contentRange);
        }
        if (object.etag) res.setHeader('ETag', object.etag);
        if (object.lastModified) res.setHeader('Last-Modified', object.lastModified.toUTCString());
        for await (const chunk of object.body) res.write(chunk);
        res.end();
        return;
      }
    } catch (error) {
      console.error('[enterprise-assets] COS read failed', error instanceof Error ? error.message : error);
      res.status(503).json({ error: 'enterprise asset storage unavailable' });
      return;
    }
  }

  // Compatibility path while the resumable migration copies historical files.
  const tenantDir = path.join(ASSETS_DIR, enterpriseAssetTenantKey(tenantId));
  const filePath = path.join(tenantDir, file);
  if (!fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.sendFile(filePath);
});
}
