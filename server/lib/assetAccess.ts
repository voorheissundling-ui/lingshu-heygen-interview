import type { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { auth } from '../storage/index.js';
import type { Identity } from '../storage/datastore.js';
import { materialAssetTenantKey } from '../storage/materialAssets.js';
import { bindDataAuthority, currentDataAuthority, type DataAuthority } from '../storage/dataAuthority.js';

export const ASSET_SESSION_COOKIE = 'lingshu_asset_session';

export function safeAssetTenantId(value: unknown): string {
  const tenantId = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId)) throw new Error('invalid tenant id');
  return tenantId;
}

export function tenantAssetDir(root: string, tenantId: string): string {
  return path.join(root, 'tenants', safeAssetTenantId(tenantId));
}

export function tenantAssetRelativePath(tenantId: string, file: string): string {
  return path.posix.join('tenants', safeAssetTenantId(tenantId), path.basename(file));
}

export function sharedAssetRelativePath(file: string): string {
  return path.posix.join('shared', path.basename(file));
}

export function cookieValue(req: Request, key: string): string {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === key) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function setAssetSessionCookie(req: Request, res: Response): void {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return;
  res.cookie(ASSET_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAssetSessionCookie(res: Response): void {
  res.clearCookie(ASSET_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function assetTokenSecret(): string {
  const configured = String(process.env.ASSET_ACCESS_SECRET || process.env.SUPPORT_ACCESS_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production' && !configured) throw new Error('ASSET_ACCESS_SECRET is required in production');
  return configured || 'lingshu-local-asset-access-secret';
}

function assetSignature(body: string): string {
  return createHmac('sha256', assetTokenSecret()).update(body).digest('base64url');
}

export function signAssetUrl(url: string, tenantId: string, ttlMs = 15 * 60 * 1000): string {
  const parsed = new URL(url, 'http://local');
  const dataAuthority = currentDataAuthority();
  const payload = Buffer.from(JSON.stringify({
    path: parsed.pathname,
    tenantId: safeAssetTenantId(tenantId),
    expiresAt: Date.now() + ttlMs,
    ...(dataAuthority ? { dataAuthority } : {}),
  }), 'utf8').toString('base64url');
  parsed.searchParams.set('assetToken', `${payload}.${assetSignature(payload)}`);
  return `${parsed.pathname}${parsed.search}`;
}

export function signPathAssetUrl(url: string, tenantId: string, ttlMs = 15 * 60 * 1000): string {
  const signed = new URL(signAssetUrl(url, tenantId, ttlMs), 'http://local');
  const token = signed.searchParams.get('assetToken');
  if (!token) return signed.pathname;
  const segments = signed.pathname.split('/');
  const filename = segments.pop();
  return `${segments.join('/')}/signed/${token}/${filename}`;
}

export function verifyAssetToken(token: unknown, pathname: string): { tenantId: string; dataAuthority?: DataAuthority } | null {
  const [body, supplied] = String(token || '').split('.');
  if (!body || !supplied) return null;
  const expected = assetSignature(body);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { path?: string; tenantId?: string; expiresAt?: number; dataAuthority?: unknown };
    if (payload.path !== pathname || !payload.tenantId || Number(payload.expiresAt || 0) <= Date.now()) return null;
    const dataAuthority = payload.dataAuthority === 'local' || payload.dataAuthority === 'pocketbase'
      ? payload.dataAuthority
      : undefined;
    return { tenantId: safeAssetTenantId(payload.tenantId), ...(dataAuthority ? { dataAuthority } : {}) };
  } catch {
    return null;
  }
}

export async function assetIdentity(req: Request): Promise<Identity | null> {
  const cookieToken = cookieValue(req, ASSET_SESSION_COOKIE);
  const authorization = req.headers.authorization || (cookieToken ? `Bearer ${cookieToken}` : undefined);
  return auth.verifyToken(authorization);
}

export function syncAssetSession(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.authorization) setAssetSessionCookie(req, res);
  next();
}

export async function requireScopedAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  const pathname = `${req.baseUrl}${req.path}`;
  const signed = verifyAssetToken(req.query.assetToken, pathname);
  let identity: Identity | null = null;
  try {
    identity = await assetIdentity(req);
  } catch (error) {
    if (!signed) {
      console.error('[asset-auth] identity verification unavailable', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(503).end();
      return;
    }
  }
  if (identity && signed && identity.tenantId !== signed.tenantId) {
    res.status(403).end();
    return;
  }
  const viewerTenantId = identity?.tenantId || signed?.tenantId;
  if (!viewerTenantId) {
    res.status(401).end();
    return;
  }
  if (signed?.dataAuthority) bindDataAuthority(signed.dataAuthority);
  const segments = req.path.split('/').filter(Boolean);
  // Existing pre-isolation assets have no tenant metadata. Keep them available
  // only to authenticated users as legacy shared assets; all new writes use
  // shared/ or tenants/<tenantId>/ paths.
  if ((identity || signed) && segments.length === 1) {
    next();
    return;
  }
  // Local object storage is served beneath /media. Keep supplier links scoped
  // to the exact tenant encoded in the object key, including signed requests.
  if (segments[0] === 'object-storage') {
    const namespace = segments[1];
    if (/^[a-z0-9_-]+$/i.test(namespace || '')
      && ((segments.length >= 4 && segments[2] === 'shared')
        || (segments.length >= 5 && segments[2] === 'tenants'
          && [viewerTenantId, materialAssetTenantKey(viewerTenantId)].includes(segments[3] || '')))) {
      next();
      return;
    }
    res.status(404).end();
    return;
  }
  if (segments[0] === 'shared' || (segments[0] === 'tenants' && segments[1] === viewerTenantId)) {
    next();
    return;
  }
  res.status(404).end();
}
