import { createHmac, timingSafeEqual } from 'node:crypto';

/* ──────────────────────────────────────────────────────────────────────────
   渲染令牌 —— 服务器签发的短期 HMAC 令牌，授权客户端执行一次本地合成。
   现阶段不绑定订阅；接入收费墙后只需在签发处先校验订阅、并把 entitlement 写进
   payload，验证逻辑（verifyRenderToken）无需改动。
   无外部依赖，纯 node:crypto 实现一个精简版 JWT（HS256 风格）。
─────────────────────────────────────────────────────────────────────────── */

const DEFAULT_TTL_SEC = 600; // 10 分钟

function secret(): string {
  const configured = process.env.RENDER_TOKEN_SECRET || process.env.ASSET_ACCESS_SECRET || process.env.SUPPORT_ACCESS_SECRET;
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('RENDER_TOKEN_SECRET is required in production');
  return configured || 'dev-insecure-render-secret-change-me';
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export interface RenderTokenPayload {
  jti: string;        // 任务唯一 id
  scope: 'render';
  iat: number;        // 签发时间（秒）
  exp: number;        // 过期时间（秒）
  [k: string]: unknown;
}

/** 签发渲染令牌，返回 token 与过期时间 */
export function signRenderToken(
  claims: Record<string, unknown>,
  ttlSec: number = DEFAULT_TTL_SEC,
): { token: string; payload: RenderTokenPayload } {
  const now = Math.floor(Date.now() / 1000);
  const payload: RenderTokenPayload = {
    scope: 'render',
    iat: now,
    exp: now + ttlSec,
    jti: `${now}-${Math.random().toString(36).slice(2, 10)}`,
    ...claims,
  };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(`${head}.${body}`);
  return { token: `${head}.${body}.${sig}`, payload };
}

/** 校验渲染令牌；无效或过期返回 null */
export function verifyRenderToken(token: string | undefined): RenderTokenPayload | null {
  if (!token || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;

  const expected = sign(`${head}.${body}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RenderTokenPayload;
    if (payload.scope !== 'render' || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
