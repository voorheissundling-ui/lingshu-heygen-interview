/* 账号 / 登录：token 存 localStorage，注入到所有 API 请求 */

import { socialContentTaskRequestHeaders } from './socialContentContext';

const TOKEN_KEY = 'overseas_token';
const SUPPORT_ORIGINAL_TOKEN_KEY = 'overseas_support_original_token';

export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY); }
export const AUTH_TOKEN_CHANGED_EVENT = 'overseas-auth-token-changed';
export function setToken(t: string): void { localStorage.setItem(TOKEN_KEY, t); if(typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_TOKEN_CHANGED_EVENT)); }
export function clearToken(): void { localStorage.removeItem(TOKEN_KEY); if(typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_TOKEN_CHANGED_EVENT)); }
/** 给 fetch 用的鉴权头（无 token 时为空对象） */
export function authHeader(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}`, ...socialContentTaskRequestHeaders() } : {};
}

export type OrganizationRole = 'super_admin' | 'admin' | 'social_operator' | 'customer_service';
export interface AuthUser { id: string; email: string; name: string; tenantId: string; role: OrganizationRole }
export interface AuthTenant {
  id: string; name: string;
  subscriptionStatus: string;
  subscriptionPlan: string | null;
  subscriptionExpiresAt: string | null;
}
export interface AuthSession {
  user: AuthUser;
  tenant: AuthTenant | null;
  /** Server-authoritative product boundary; subscription labels do not grant access. */
  productProfile?: 'starter_198' | 'advanced_customer';
  /** Server-verified platform operator identity; subscription names are never authority. */
  platformAdmin?: boolean;
  subscription?: { status: string; plan: string | null; expiresAt: string | null };
  demo?: {
    enabled: boolean;
    trialDays: number;
    expiresAt: string | null;
    daysRemaining: number | null;
    expired: boolean;
    limits: { trialDays: number; aiChatDaily: number; generationDaily: number; renderDaily: number; videoGenerationDaily: number; tokenDaily: number; tokenTotal: number };
    usage: { aiChat: number; generation: number; render: number; videoGeneration: number; tokens: number };
    remaining: { aiChat: number; generation: number; render: number; videoGeneration: number; tokens: number };
    totalUsage?: { tokens: number; videoGeneration: number };
    totalRemaining?: { tokens: number; videoGeneration: number };
    guideTrigger?: boolean;
    guideScope?: string;
  };
  supportAccess?: {
    requestId: string;
    adminEmail: string;
    tenantName: string;
    expiresAt?: string;
  };
}

export class AuthSessionUnavailableError extends Error {
  constructor(readonly status?: number) {
    super('session_refresh_unavailable');
    this.name = 'AuthSessionUnavailableError';
  }
}

export const INITIAL_AUTH_RETRY_DELAYS_MS = [
  500,
  1_000,
  2_000,
  4_000,
  8_000,
  15_000,
  30_000,
  30_000,
  30_000,
] as const;

export function startInitialAuthSessionRefresh<TTimer>(ports: {
  refresh: () => Promise<AuthSession | null>;
  getToken: () => string | null;
  schedule: (callback: () => void, delayMs: number) => TTimer;
  cancel: (timer: TTimer) => void;
  onSuccess: (session: AuthSession | null) => void;
  onRetry?: (error: unknown, delayMs: number) => void;
  onFailure: (error: unknown) => void;
}): () => void {
  let disposed = false;
  let timer: TTimer | undefined;
  let retryIndex = 0;

  const run = () => {
    void Promise.resolve().then(async () => {
      // React StrictMode immediately disposes its first effect instance. Do not
      // let that intentionally discarded instance issue a second token.
      if (disposed) return;
      try {
        const session = await ports.refresh();
        if (!disposed) ports.onSuccess(session);
      } catch (error) {
        if (disposed) return;
        // A retained bearer is not evidence that the service is reachable.
        // Temporary backend restarts must recover without clearing credentials.
        const delay = INITIAL_AUTH_RETRY_DELAYS_MS[retryIndex];
        if (delay !== undefined) {
          retryIndex += 1;
          ports.onRetry?.(error, delay);
          timer = ports.schedule(run, delay);
          return;
        }
        ports.onFailure(error);
      }
    });
  };

  run();
  return () => {
    disposed = true;
    if (timer !== undefined) ports.cancel(timer);
  };
}

function localPreviewBootstrapEnabled(): boolean {
  const env = import.meta.env;
  if (!env?.DEV || env.VITE_LINGSHU_LOCAL_PREVIEW !== '1' || typeof window === 'undefined') return false;
  const configuredOrigin = String(env.VITE_LINGSHU_LOCAL_PREVIEW_ORIGIN || '').trim();
  return (configuredOrigin ? window.location.origin === configuredOrigin : ['5177','5183'].includes(window.location.port))
    && window.location.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(window.location.hostname);
}

async function bootstrapLocalPreviewSession(fetchImpl: typeof fetch, enabled: boolean): Promise<AuthSession | null> {
  if (!enabled) return null;
  const browserTokenBeforeBootstrap = getToken();
  try {
    const issued = await fetchImpl('/api/overseas/auth/local-preview-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    const body = await issued.json().catch(() => ({})) as { token?: unknown };
    if (!issued.ok || typeof body.token !== 'string' || !body.token.startsWith('local-demo.v1.')) {
      throw new AuthSessionUnavailableError(issued.ok ? 502 : issued.status);
    }
    const previewToken = body.token;
    const verified = await fetchImpl('/api/overseas/auth/me', {
      headers: { Authorization: `Bearer ${previewToken}`, ...socialContentTaskRequestHeaders() },
      cache: 'no-store',
    });
    if (!verified.ok) {
      throw new AuthSessionUnavailableError(verified.status);
    }
    const session = normalizeSessionIdentity((await verified.json()) as AuthSession);
    if (getToken() !== browserTokenBeforeBootstrap) throw new AuthSessionUnavailableError(409);
    setToken(previewToken);
    return session;
  } catch (error) {
    if (error instanceof AuthSessionUnavailableError) throw error;
    throw new AuthSessionUnavailableError();
  }
}

export interface EmployeeAccount { id: string; email: string; name: string; role: OrganizationRole; isCurrent: boolean; created: string }

const JIANGZHE_TEST_EMAIL = 'wenlantianxia-test@local.test';
const JIANGZHE_TEST_NAME = '灵枢测试07-江浙';

function normalizeSessionIdentity<T extends { user?: AuthUser; tenant?: AuthTenant | null }>(session: T): T {
  if (String(session.user?.email || '').trim().toLowerCase() !== JIANGZHE_TEST_EMAIL || !session.user) return session;
  return {
    ...session,
    user: { ...session.user, name: JIANGZHE_TEST_NAME },
    tenant: session.tenant ? { ...session.tenant, name: JIANGZHE_TEST_NAME } : session.tenant,
  };
}

async function authenticatedJson<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch(`/api/overseas/auth/${path}`, { ...options, headers: { ...authHeader(), ...(options?.body ? { 'Content-Type': 'application/json' } : {}), ...(options?.headers ?? {}) } });
  const j = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || '请求失败');
  return j;
}

export function startSupportSession(token: string): void {
  const current = getToken();
  if (current && !localStorage.getItem(SUPPORT_ORIGINAL_TOKEN_KEY)) {
    localStorage.setItem(SUPPORT_ORIGINAL_TOKEN_KEY, current);
  }
  setToken(token);
}

export function exitSupportSession(): boolean {
  const original = localStorage.getItem(SUPPORT_ORIGINAL_TOKEN_KEY);
  localStorage.removeItem(SUPPORT_ORIGINAL_TOKEN_KEY);
  if (!original) return false;
  setToken(original);
  return true;
}

const wait = (milliseconds: number) => new Promise(resolve => window.setTimeout(resolve, milliseconds));

async function authRequest(path: string, body: unknown): Promise<Response> {
  const attempts = path === 'login' ? 3 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(`/api/overseas/auth/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await wait(attempt === 0 ? 500 : 1200);
    }
  }

  throw new Error(lastError instanceof TypeError ? '服务正在启动，请稍后重试' : '服务暂时无法连接，请稍后重试');
}

async function call(path: string, body: unknown): Promise<{ token: string; user: AuthUser; tenant: AuthTenant | null; demo?: AuthSession['demo'] }> {
  const r = await authRequest(path, body);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '请求失败');
  return normalizeSessionIdentity(j);
}

export interface AuthSessionRefreshOptions {
  /** Deterministic test seam; normal callers use the Vite + loopback runtime gate. */
  localPreviewBootstrap?: boolean;
}

export async function refreshAuthSession(
  fetchImpl: typeof fetch = fetch,
  options: AuthSessionRefreshOptions = {},
): Promise<AuthSession | null> {
  const localPreviewBootstrap = options.localPreviewBootstrap ?? localPreviewBootstrapEnabled();
  if (!getToken()) return bootstrapLocalPreviewSession(fetchImpl, localPreviewBootstrap);
  try {
    const r = await fetchImpl('/api/overseas/auth/me', { headers: authHeader() });
    if (!r.ok) {
      const original = (r.status === 401 || r.status === 402)
        ? localStorage.getItem(SUPPORT_ORIGINAL_TOKEN_KEY)
        : null;
      if (original) {
        const restored = await fetchImpl('/api/overseas/auth/me', {
          headers: { Authorization: `Bearer ${original}`, ...socialContentTaskRequestHeaders() },
        });
        if (restored.ok) {
          localStorage.removeItem(SUPPORT_ORIGINAL_TOKEN_KEY);
          setToken(original);
          return normalizeSessionIdentity((await restored.json()) as AuthSession);
        }
        if (restored.status === 401 || restored.status === 402) {
          clearToken();
          localStorage.removeItem(SUPPORT_ORIGINAL_TOKEN_KEY);
          return bootstrapLocalPreviewSession(fetchImpl, localPreviewBootstrap);
        }
        // Do not switch tokens until the original session is verified. This
        // keeps the retained UI session and bearer credential consistent.
        throw new AuthSessionUnavailableError(restored.status);
      }
      if (r.status === 401 || r.status === 402) {
        clearToken();
        return bootstrapLocalPreviewSession(fetchImpl, localPreviewBootstrap);
      }
      throw new AuthSessionUnavailableError(r.status);
    }
    return normalizeSessionIdentity((await r.json()) as AuthSession);
  } catch (error) {
    if (error instanceof AuthSessionUnavailableError) throw error;
    // Network failures are not authentication decisions. Keep the token and
    // let the application retain its last server-verified session.
    throw new AuthSessionUnavailableError();
  }
}

export const authApi = {
  register: (email: string, password: string, inviteCode: string) =>
    call('register', { email, password, inviteCode }),
  login: (email: string, password: string) =>
    call('login', { email, password }),
  invite: async (inviteCode: string): Promise<{ valid: boolean; companyName: string }> => {
    const r = await fetch(`/api/overseas/auth/invite/${encodeURIComponent(inviteCode)}`, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.companyName) throw new Error(j.error || '邀请码无效或已使用');
    return j;
  },
  me: refreshAuthSession,
  guideSeen: async (): Promise<void> => {
    if (!getToken()) return;
    await fetch('/api/overseas/auth/guide-seen', { method: 'POST', headers: authHeader() }).catch(() => {});
  },
  changePassword: async (currentPassword: string, newPassword: string, passwordConfirm: string): Promise<void> => {
    await authenticatedJson('change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, passwordConfirm }) });
  },
  employees: async (): Promise<EmployeeAccount[]> => (await authenticatedJson<{ employees: EmployeeAccount[] }>('employees')).employees,
  addEmployee: async (input: { email: string; name: string; password: string; role: OrganizationRole }): Promise<EmployeeAccount> => (await authenticatedJson<{ employee: EmployeeAccount }>('employees', { method: 'POST', body: JSON.stringify(input) })).employee,
  updateEmployeeRole: async (employeeId: string, role: OrganizationRole): Promise<void> => { await authenticatedJson(`employees/${encodeURIComponent(employeeId)}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }); },
  deleteEmployee: async (employeeId: string): Promise<void> => { await authenticatedJson(`employees/${encodeURIComponent(employeeId)}`, { method: 'DELETE' }); },
  logout: () => {
    void fetch('/api/overseas/auth/logout', { method: 'POST', headers: authHeader() }).catch(() => {});
    clearToken();
    localStorage.removeItem(SUPPORT_ORIGINAL_TOKEN_KEY);
  },
};
