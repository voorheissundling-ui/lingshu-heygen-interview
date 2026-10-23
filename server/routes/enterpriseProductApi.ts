import { Router, type Request, type Response } from 'express';
import { isBrowserReadToken } from '../digitalEmployees/browserReadSession.js';
import {
  createProductApiCredential,
  productApiSecretForTenant,
  rotateProductApiCredential,
  type IssuedProductApiSecret,
  type ProductApiCredential,
} from '../lib/productApiCredentials.js';
import { requestOrganizationRoleStrict } from '../lib/organizationRole.js';
import type { AuthLocals } from '../middleware/auth.js';
import {
  Starter198LegacyEffectError,
  withLegacyExternalEffectAllowed,
} from '../starter198/legacyEffectGuard.js';

export const enterpriseProductApiRouter = Router();

function publicProductApiInfo(tenantId: string, credential: ProductApiCredential | null) {
  return {
    tenantId,
    apiKeySet: Boolean(credential),
    apiKeyActive: credential?.active === true,
    apiKeyLast4: credential?.active ? credential.keyLast4 : '',
    keyPrefix: credential?.active ? credential.keyPrefix : '',
    requiresRotation: credential?.requiresRotation === true,
    createdAt: credential?.createdAt || '',
  };
}

function oneTimeProductApiInfo(secret: IssuedProductApiSecret) {
  return { ...publicProductApiInfo(secret.tenantId, secret), apiKey: secret.apiKey };
}

function preventCredentialCaching(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Vary', 'Authorization');
}

function respondStarterBoundary(error: unknown, res: Response): boolean {
  if (!(error instanceof Starter198LegacyEffectError)) return false;
  res.status(error.status).json({
    error: error.code,
    message: error.status === 403
      ? '198 标准版的客户操作只能通过灵小枢发起。'
      : '产品能力边界暂时无法确认，已停止访问 legacy 功能。',
  });
  return true;
}

async function managerIdentity(req: Request, res: Response): Promise<AuthLocals | null> {
  const identity = res.locals as AuthLocals;
  if (isBrowserReadToken(req.headers.authorization)) {
    res.status(403).json({ error: 'agent_browser_read_only' });
    return null;
  }
  if (identity.supportAccess) {
    res.status(403).json({ error: 'support_access_read_only' });
    return null;
  }
  if (!identity.userId || !identity.tenantId || identity.userId === 'signed-media') {
    res.status(403).json({ error: 'product_api_manager_required' });
    return null;
  }
  const role = await requestOrganizationRoleStrict(req.headers.authorization, identity.userId);
  if (role !== 'super_admin' && role !== 'admin') {
    res.status(403).json({
      error: 'product_api_manager_required',
      message: '只有企业负责人或管理员可以管理产品 API 密钥。',
    });
    return null;
  }
  return identity;
}

enterpriseProductApiRouter.use((_req, res, next) => {
  preventCredentialCaching(res);
  next();
});

enterpriseProductApiRouter.get('/', async (req, res) => {
  try {
    const identity = await managerIdentity(req, res);
    if (!identity) return;
    const secret = await withLegacyExternalEffectAllowed(
      identity.tenantId,
      () => productApiSecretForTenant(identity.tenantId),
    );
    res.json(publicProductApiInfo(identity.tenantId, secret));
  } catch (error) {
    if (respondStarterBoundary(error, res)) return;
    res.status(503).json({ error: 'tenant_api_key_storage_unavailable' });
  }
});

enterpriseProductApiRouter.post('/', async (req, res) => {
  try {
    const identity = await managerIdentity(req, res);
    if (!identity) return;
    const result = await withLegacyExternalEffectAllowed(
      identity.tenantId,
      async guard => {
        await guard.beforeEffect();
        return createProductApiCredential(identity.tenantId);
      },
    );
    if (result.kind === 'exists') {
      res.status(409).json({
        error: 'tenant_api_key_already_exists',
        ...publicProductApiInfo(identity.tenantId, result.credential),
      });
      return;
    }
    if (result.kind === 'unavailable') {
      res.status(503).json({ error: 'tenant_api_key_storage_unavailable' });
      return;
    }
    res.status(201).json(oneTimeProductApiInfo(result.secret));
  } catch (error) {
    if (respondStarterBoundary(error, res)) return;
    res.status(503).json({ error: 'tenant_api_key_storage_unavailable' });
  }
});

enterpriseProductApiRouter.post('/rotate', async (req, res) => {
  try {
    const identity = await managerIdentity(req, res);
    if (!identity) return;
    const result = await withLegacyExternalEffectAllowed(
      identity.tenantId,
      async guard => {
        await guard.beforeEffect();
        return rotateProductApiCredential(identity.tenantId);
      },
    );
    if (result.kind === 'missing') {
      res.status(404).json({ error: 'tenant_api_key_not_found' });
      return;
    }
    if (result.kind === 'unavailable') {
      res.status(503).json({ error: 'tenant_api_key_storage_unavailable' });
      return;
    }
    res.json(oneTimeProductApiInfo(result.secret));
  } catch (error) {
    if (respondStarterBoundary(error, res)) return;
    res.status(503).json({ error: 'tenant_api_key_storage_unavailable' });
  }
});
