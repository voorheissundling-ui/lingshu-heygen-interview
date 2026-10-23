import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { auth } from '../storage/index.js';
import { pbGetStrict } from '../storage/pb.js';
import type { AuthLocals } from './auth.js';
import { readDemoAccountRegistry } from '../lib/demoAccounts.js';
import { getLocalTenant } from '../lib/localTenants.js';
import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import { currentDataAuthority } from '../storage/dataAuthority.js';

/* ──────────────────────────────────────────────────────────────────────────
   订阅收费墙
   - 由 SUBSCRIPTION_ENFORCED 开关控制：
       未设 / 'false' → 直通（保持接口现有开放行为，不破坏 demo / 本地开发）
       'true'         → 要求登录 + 租户有有效订阅，否则 401 / 402
   - 订阅状态挂在 PocketBase `tenants` 集合（B2B 按公司订阅），可后台手动设置，
     真实支付（Stripe 等）以后通过 webhook 回写同样的字段即可，中间件无需改动。
─────────────────────────────────────────────────────────────────────────── */

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'expired'
  | 'none';

export interface Subscription {
  status: SubscriptionStatus;
  plan: string | null;
  expiresAt: string | null; // ISO，null = 不过期
}

export interface SubscriptionLocals extends AuthLocals {
  subscription: Subscription;
}

const TENANT_COL = 'tenants';
const ENTITLED_STATUSES: SubscriptionStatus[] = ['active', 'trialing'];

/** 是否启用强制订阅校验 */
export function isSubscriptionEnforced(): boolean {
  return process.env.SUBSCRIPTION_ENFORCED === 'true';
}

/** 读取租户当前订阅；记录缺失时返回 none */
export async function getTenantSubscription(tenantId: string): Promise<Subscription> {
  // A tenant id prefix is not an authority decision. In particular, a valid
  // PocketBase account whose id happens to start with `local_tenant_` must not
  // be allowed to read the local demo registry.
  if (currentDataAuthority() !== 'pocketbase' && tenantId.startsWith('local_tenant_')) {
    if (!localFallbacksEnabled()) return { status: 'none', plan: null, expiresAt: null };
    const localTenant = getLocalTenant(tenantId);
    if (localTenant) {
      return {
        status: localTenant.subscriptionStatus === 'active' ? 'active' : 'none',
        plan: localTenant.subscriptionPlan || 'customer',
        expiresAt: localTenant.subscriptionExpiresAt,
      };
    }

    const registryEntry = Object.values(readDemoAccountRegistry()).find(entry => {
      const slug = entry.email.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'demo';
      return entry.tenantId === tenantId ||
        `local_tenant_trial_${slug}` === tenantId ||
        `local_tenant_admin_${slug}` === tenantId ||
        `local_tenant_${slug}` === tenantId;
    });
    if (registryEntry?.status === 'admin' || tenantId.startsWith('local_tenant_admin_')) {
      return { status: 'active', plan: 'admin', expiresAt: null };
    }
    if (registryEntry?.status === 'customer') {
      return { status: 'active', plan: 'customer', expiresAt: null };
    }
    if (registryEntry || tenantId.startsWith('local_tenant_trial_')) {
      return { status: 'trialing', plan: 'trial', expiresAt: registryEntry?.expiresAt ?? null };
    }
    if (tenantId.startsWith('local_tenant_customer_')) {
      return { status: 'active', plan: 'customer', expiresAt: null };
    }
    return { status: 'active', plan: 'local', expiresAt: null };
  }
  const record = await pbGetStrict(TENANT_COL, tenantId);
  if (!record) return { status: 'none', plan: null, expiresAt: null };
  return {
    status: (record.subscriptionStatus as SubscriptionStatus) ?? 'none',
    plan: (record.subscriptionPlan as string) ?? null,
    expiresAt: (record.subscriptionExpiresAt as string) ?? null,
  };
}

/** 订阅是否仍有效：状态在白名单内且未过期 */
export function isEntitled(sub: Subscription): boolean {
  if (!ENTITLED_STATUSES.includes(sub.status)) return false;
  if (sub.expiresAt && new Date(sub.expiresAt).getTime() < Date.now()) return false;
  return true;
}

/**
 * 收费墙中间件：未启用强制时直通；启用后校验登录 + 有效订阅。
 * 自带鉴权（无需在前面再挂 requireAuth），通过后在 res.locals 注入
 * userId / tenantId / subscription。
 */
export function entitlementGate(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isSubscriptionEnforced()) {
      next();
      return;
    }

    const locals = res.locals as SubscriptionLocals;
    const signedAssetTenantId = locals.userId === 'signed-media' ? locals.tenantId : '';
    let result;
    try {
      const authenticatedLocals = locals.userId && locals.tenantId && locals.userId !== 'signed-media'
        ? { userId: locals.userId, tenantId: locals.tenantId }
        : null;
      result = signedAssetTenantId ? null : authenticatedLocals || await auth.verifyToken(req.headers.authorization);
    } catch (error) {
      console.error('[subscription] identity verification unavailable', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({
        error: 'auth_provider_unavailable',
        message: '登录验证服务暂时不可用，请稍后重试。',
      });
      return;
    }
    if (!result && !signedAssetTenantId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (result) {
      locals.userId = result.userId;
      locals.tenantId = result.tenantId;
    }

    let sub: Subscription;
    try {
      sub = await getTenantSubscription(signedAssetTenantId || result!.tenantId);
    } catch (error) {
      console.error('[subscription] authority unavailable', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({
        error: 'subscription_authority_unavailable',
        message: '订阅验证服务暂时不可用，请稍后重试。',
      });
      return;
    }
    if (!isEntitled(sub)) {
      res.status(402).json({
        error: 'subscription_required',
        status: sub.status,
        plan: sub.plan,
        expiresAt: sub.expiresAt,
      });
      return;
    }

    locals.subscription = sub;
    next();
  };
}
