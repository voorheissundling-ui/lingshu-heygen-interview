import type { Request, Response, NextFunction } from 'express';
import { auth } from '../storage/index.js';
import { assetIdentity, verifyAssetToken } from '../lib/assetAccess.js';
import { browserReadIdentity, isBrowserReadToken } from '../digitalEmployees/browserReadSession.js';
import { enforceStarter198LegacyMutationBoundary } from '../starter198/legacyBoundary.js';
import { isSideEffectingReadPath } from '../security/readOnlyHttp.js';
import { bindDataAuthority } from '../storage/dataAuthority.js';
import type { DataAuthority } from '../storage/dataAuthority.js';

export interface AuthLocals {
  userId: string;
  tenantId: string;
  dataAuthority?: DataAuthority;
  browserReadRole?: 'social_operator' | 'customer_service' | 'admin';
  starter198SocialContext?: {
    taskId: string;
    page: string;
    accessKind: 'read' | 'edit' | 'generate';
  };
  supportAccess?: {
    requestId: string;
    adminEmail: string;
    tenantName: string;
    expiresAt?: string;
  };
}

const SUPPORT_READ_ONLY_METHODS = new Set(['GET', 'HEAD']);
/**
 * Support access is an observation session, never a customer-decision actor.
 * Keep this as a router-level fail-closed gate so newly added mutation routes
 * cannot accidentally inherit the internal support user's authority.
 */
export function enforceSupportSessionReadOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { supportAccess } = res.locals as AuthLocals;
  if (!supportAccess) {
    next();
    return;
  }

  const method = req.method.toUpperCase();
  if (SUPPORT_READ_ONLY_METHODS.has(method) && !isSideEffectingReadPath(req)) {
    next();
    return;
  }

  res.status(403).json({
    error: 'support_access_read_only',
    message: '技术支持会话仅可查看，不能代替客户执行操作。',
  });
}

/** Attach userId + tenantId to res.locals; return 401 if token is missing/invalid */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (isBrowserReadToken(req.headers.authorization)) {
    const identity = browserReadIdentity(req);
    if (!identity || isSideEffectingReadPath(req)) {
      res.status(403).json({ error: 'agent_browser_read_only' });
      return;
    }
    // The browser credential is derived from an already authenticated task
    // session. Restore that exact authority before any route can read data.
    bindDataAuthority(identity.dataAuthority);
    Object.assign(res.locals, {
      userId: identity.userId,
      tenantId: identity.tenantId,
      dataAuthority: identity.dataAuthority,
      browserReadRole: identity.role,
    });
    // Browser-read credentials are a transport restriction, not an authority
    // to bypass the customer's product profile. Starter tenants must still use
    // the whitelisted production projections instead of arbitrary legacy GETs.
    await enforceStarter198LegacyMutationBoundary(req, res, next);
    return;
  }
  // Media elements cannot attach the localStorage bearer header. The API call
  // that loads the studio first synchronizes the same token into an HttpOnly,
  // same-site asset session cookie, so proxied video/audio routes can use it.
  let result;
  try {
    result = await auth.verifyToken(req.headers.authorization) || await assetIdentity(req);
  } catch (error) {
    console.error('[auth] identity verification unavailable', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({
      error: 'auth_provider_unavailable',
      message: '登录验证服务暂时不可用，请稍后重试。',
    });
    return;
  }
  const authenticated = result
    && typeof result.userId === 'string'
    && typeof result.tenantId === 'string'
    && result.userId
    && result.tenantId
    && result.userId === result.userId.trim()
    && result.tenantId === result.tenantId.trim()
    ? result
    : null;
  // Browser media elements cannot attach an Authorization header. A signed URL
  // is already scoped to the exact request path, tenant and expiry by HMAC, so
  // accept a valid token for any GET/HEAD asset route instead of coupling auth
  // to Express' mount-relative req.path shape.
  const originalPath = new URL(req.originalUrl || req.url, 'http://local').pathname;
  const signedMedia = (req.method === 'GET' || req.method === 'HEAD')
    ? verifyAssetToken(req.query.assetToken, originalPath)
    : null;
  if (!authenticated && !signedMedia) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const locals = res.locals as AuthLocals;
  locals.userId = authenticated?.userId || 'signed-media';
  locals.tenantId = authenticated?.tenantId || signedMedia!.tenantId;
  locals.dataAuthority = authenticated?.dataAuthority || signedMedia?.dataAuthority;
  locals.supportAccess = authenticated?.supportAccess;
  if (locals.supportAccess) { enforceSupportSessionReadOnly(req, res, next); return; }
  // A signed media URL is already bound to one tenant, one exact path and a
  // short expiry. Let the media handler enforce record ownership without
  // requiring browser media elements to reproduce the page's task headers.
  if (signedMedia) {
    if (authenticated && authenticated.tenantId !== signedMedia.tenantId) {
      res.status(403).json({ error: 'asset_tenant_mismatch' });
      return;
    }
    if (signedMedia.dataAuthority) bindDataAuthority(signedMedia.dataAuthority);
    next();
    return;
  }
  await enforceStarter198LegacyMutationBoundary(req, res, next);
}
