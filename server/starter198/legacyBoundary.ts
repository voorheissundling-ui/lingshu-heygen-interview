import type { Request, Response, NextFunction } from 'express';
import type { AuthLocals } from '../middleware/auth.js';
import { Starter198RepositoryError, starter198Repository, type Starter198Repository } from './repository.js';
import { authorizeStarter198SocialLegacyRequest } from './socialLegacyAccess.js';

const EXEMPT_PATHS = [
  /^\/api\/overseas\/starter-198\/mobile\/(?:queue|snooze|transcribe)\/?$/,
  /^\/api\/overseas\/starter-198\/workspace\/?$/,
  /^\/api\/overseas\/starter-198\/commands\/?$/,
  /^\/api\/overseas\/starter-198\/publication-packages\/[^/]+\/download\/?$/,
  /^\/api\/overseas\/starter-198\/quote-artifacts\/[^/]+\/download\/?$/,
  /^\/api\/overseas\/starter-198\/social-content(?:\/|$)/,
  // Lingxiaoshu is the starter product's conversational entry.  The route
  // itself remains authenticated and maps mutations back onto the versioned
  // starter command API; exempting it here does not reopen legacy writes.
  /^\/api\/overseas\/assistant-threads(?:\/|$)/,
  // Production governance endpoints expose tenant-scoped read projections.
  // Their browser mutation routes fail closed with 403; verified workers call
  // the domain functions directly, so exempting the path does not create a
  // second Starter mutation surface.
  /^\/api\/overseas\/studio\/(?:production-input-requests|product-asset-requests|production-cost-quotes)(?:\/|$)/,
  /^(?:\/api\/overseas)?\/auth\/(?:me|change-password|employees(?:\/[^/]+(?:\/role)?)?|guide-seen|logout)\/?$/,
  /^\/api\/overseas\/admin(?:\/|$)/,
  /^\/api\/overseas\/support-access(?:\/|$)/,
];

export function isStarter198BoundaryExemptPath(path: string): boolean {
  return EXEMPT_PATHS.some(pattern => pattern.test(path));
}

/**
 * A provisioned starter_198 tenant has one customer surface: the orchestrator.
 * Deny every legacy route, including GET/HEAD projections, so a newly added
 * legacy handler cannot silently become a second product surface. Auth and the
 * starter API remain reachable; admin/support exceptions retain their stricter
 * route-local internal-admin or tenant-owner authorization checks.
 *
 * The exported function keeps its historical name to avoid weakening callers
 * during the migration from a mutation-only boundary to a full legacy boundary.
 */
export function createStarter198LegacyMutationBoundary(
  repository: Starter198Repository = starter198Repository,
  dependencies: {
    resolveRole?: (request: Request, userId: string) => Promise<unknown>;
    now?: () => Date;
  } = {},
) {
  return async function starter198LegacyMutationBoundary(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const path = new URL(req.originalUrl || req.url, 'http://local').pathname;
    if (isStarter198BoundaryExemptPath(path)) { next(); return; }
    const { tenantId, userId } = res.locals as Partial<AuthLocals>;
    if (!tenantId || !userId) { next(); return; }
    try {
      const access = await repository.access(tenantId);
      const socialAccess = await authorizeStarter198SocialLegacyRequest(req, {
        repository,
        access,
        tenantId,
        userId,
        resolveRole: dependencies.resolveRole,
        now: dependencies.now,
      });
      if (socialAccess.state === 'allowed') {
        (res.locals as AuthLocals).starter198SocialContext = {
          taskId: socialAccess.taskId,
          page: socialAccess.page,
          accessKind: socialAccess.kind,
        };
        res.setHeader('Cache-Control', 'private, no-store');
        next();
        return;
      }
      res.status(403).json({
        error: 'starter_198_orchestrator_only',
        message: '198 标准版的客户操作只能通过灵小枢发起。',
      });
    } catch (error) {
      if (error instanceof Starter198RepositoryError && error.code === 'starter_198_not_provisioned') {
        next();
        return;
      }
      res.status(503).json({
        error: 'starter_198_access_unavailable',
        message: '产品能力边界暂时无法确认，已停止访问 legacy 功能。',
      });
    }
  };
}

export const enforceStarter198LegacyMutationBoundary = createStarter198LegacyMutationBoundary();
