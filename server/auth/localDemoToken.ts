import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const LOCAL_DEMO_TOKEN_PREFIX = 'local-demo.v1.';
export const LOCAL_DEMO_TOKEN_AUDIENCE = 'lingshu-local-demo';

export interface LocalDemoTokenClaims {
  sub: string;
  tenantId: string;
  aud: typeof LOCAL_DEMO_TOKEN_AUDIENCE;
  iat: number;
  exp: number;
  jti: string;
}

const ephemeralDevelopmentSecret = randomBytes(32);

function signingSecret(): Buffer {
  const configured = process.env.LOCAL_DEMO_TOKEN_SECRET?.trim();
  return configured ? Buffer.from(configured, 'utf8') : ephemeralDevelopmentSecret;
}

function signature(payload: string): string {
  return createHmac('sha256', signingSecret()).update(`v1.${payload}`).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(authorization: string | undefined): string {
  return String(authorization || '').replace(/^Bearer\s+/i, '').trim();
}

export function isLocalDemoAuthorization(authorization: string | undefined): boolean {
  return bearerToken(authorization).startsWith('local-demo.');
}

export function issueLocalDemoToken(
  identity: { userId: string; tenantId: string },
  options: { nowMs?: number; ttlSeconds?: number; jti?: string } = {},
): string {
  const now = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  const configuredTtl = Number(process.env.LOCAL_DEMO_TOKEN_TTL_SECONDS ?? 8 * 60 * 60);
  const requestedTtl = options.ttlSeconds ?? configuredTtl;
  const ttl = Number.isFinite(requestedTtl)
    ? Math.min(Math.max(Math.floor(requestedTtl), -24 * 60 * 60), 24 * 60 * 60)
    : 8 * 60 * 60;
  const claims: LocalDemoTokenClaims = {
    sub: identity.userId,
    tenantId: identity.tenantId,
    aud: LOCAL_DEMO_TOKEN_AUDIENCE,
    iat: now,
    exp: now + ttl,
    jti: options.jti || randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${LOCAL_DEMO_TOKEN_PREFIX}${payload}.${signature(payload)}`;
}

export function verifyLocalDemoToken(
  authorization: string | undefined,
  options: { nowMs?: number } = {},
): LocalDemoTokenClaims | null {
  const token = bearerToken(authorization);
  if (!token.startsWith(LOCAL_DEMO_TOKEN_PREFIX)) return null;
  const compact = token.slice(LOCAL_DEMO_TOKEN_PREFIX.length);
  const separator = compact.lastIndexOf('.');
  if (separator <= 0 || separator === compact.length - 1) return null;
  const payload = compact.slice(0, separator);
  const suppliedSignature = compact.slice(separator + 1);
  if (!safeEqual(suppliedSignature, signature(payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<LocalDemoTokenClaims>;
    const now = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    if (
      typeof claims.sub !== 'string' || !claims.sub || claims.sub !== claims.sub.trim()
      || typeof claims.tenantId !== 'string' || !claims.tenantId || claims.tenantId !== claims.tenantId.trim()
      || claims.aud !== LOCAL_DEMO_TOKEN_AUDIENCE
      || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60
      || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now
      || claims.exp <= claims.iat || claims.exp - claims.iat > 24 * 60 * 60
      || typeof claims.jti !== 'string' || claims.jti.length < 16 || claims.jti.length > 128
    ) return null;
    return claims as LocalDemoTokenClaims;
  } catch {
    return null;
  }
}
