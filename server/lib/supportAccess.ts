import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Identity } from '../storage/datastore.js';

const REQUESTS_FILE = path.resolve(process.cwd(), 'data/support-access.json');
const SETTINGS_FILE = path.resolve(process.cwd(), 'data/support-access-settings.json');
const TOKEN_PREFIX = 'support-v1.';
const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 60 * 60 * 1000;
const MIN_TOKEN_TTL_MS = 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

type SupportAccessStatus = 'approved' | 'denied' | 'revoked';

interface SupportAccessRequest {
  id: string;
  tenantId: string;
  tenantName: string;
  requestedByUserId: string;
  requestedByEmail: string;
  requestedAt: string;
  status: SupportAccessStatus;
  revokedAt?: string;
}

interface SupportAccessSettings {
  [tenantId: string]: {
    defaultAuthorized: boolean;
    updatedAt: string;
    updatedByUserId: string;
  };
}

interface SupportTokenPayload {
  requestId: string;
  adminUserId: string;
  adminEmail: string;
  tenantId: string;
  tenantName: string;
  issuedAt: number;
  expiresAt: number;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Some platforms ignore POSIX file modes.
  }
}

function readRequests(): SupportAccessRequest[] {
  const value = readJson<unknown>(REQUESTS_FILE, []);
  return Array.isArray(value) ? value as SupportAccessRequest[] : [];
}

function readSettings(): SupportAccessSettings {
  const value = readJson<unknown>(SETTINGS_FILE, {});
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SupportAccessSettings
    : {};
}

function tokenSecret(): string {
  const configured = String(process.env.SUPPORT_ACCESS_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production' && !configured) {
    throw new Error('SUPPORT_ACCESS_SECRET is required in production');
  }
  return configured || 'lingshu-local-support-access-secret';
}

function signature(body: string): string {
  return createHmac('sha256', tokenSecret()).update(body).digest('base64url');
}

function supportAccessTokenTtlMs(): number {
  const configuredMinutes = Number(process.env.SUPPORT_ACCESS_TTL_MINUTES);
  if (!Number.isFinite(configuredMinutes) || configuredMinutes <= 0) return DEFAULT_TOKEN_TTL_MS;
  return Math.min(MAX_TOKEN_TTL_MS, Math.max(MIN_TOKEN_TTL_MS, Math.round(configuredMinutes * 60 * 1000)));
}

export function supportAccessDefaultAuthorized(tenantId: string): boolean {
  return readSettings()[tenantId]?.defaultAuthorized ?? false;
}

export function setSupportAccessDefaultAuthorized(
  tenantId: string,
  userId: string,
  defaultAuthorized: boolean,
): void {
  const settings = readSettings();
  settings[tenantId] = {
    defaultAuthorized,
    updatedAt: new Date().toISOString(),
    updatedByUserId: userId,
  };
  writeJson(SETTINGS_FILE, settings);

  if (defaultAuthorized) return;
  const revokedAt = new Date().toISOString();
  const requests = readRequests();
  const next = requests.map(request => (
    request.tenantId === tenantId && request.status === 'approved'
      ? { ...request, status: 'revoked' as const, revokedAt }
      : request
  ));
  writeJson(REQUESTS_FILE, next);
}

export function createSupportAccessRequest(input: {
  tenantId: string;
  tenantName: string;
  requestedByUserId: string;
  requestedByEmail: string;
}): SupportAccessRequest {
  const requests = readRequests();
  const existing = requests.find(request => (
    request.tenantId === input.tenantId &&
    request.requestedByUserId === input.requestedByUserId &&
    request.status === 'approved'
  ));
  if (existing && supportAccessDefaultAuthorized(input.tenantId)) return existing;

  const authorized = supportAccessDefaultAuthorized(input.tenantId);
  const request: SupportAccessRequest = {
    id: randomBytes(18).toString('base64url'),
    ...input,
    requestedAt: new Date().toISOString(),
    status: authorized ? 'approved' : 'denied',
  };
  writeJson(REQUESTS_FILE, [request, ...requests].slice(0, 500));
  return request;
}

export function issueSupportAccessToken(
  requestId: string,
  adminUserId: string,
): { token: string; expiresAt: string } | null {
  const request = readRequests().find(item => item.id === requestId);
  if (
    !request ||
    request.requestedByUserId !== adminUserId ||
    request.status !== 'approved' ||
    !supportAccessDefaultAuthorized(request.tenantId)
  ) {
    return null;
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + supportAccessTokenTtlMs();
  const payload: SupportTokenPayload = {
    requestId: request.id,
    adminUserId: request.requestedByUserId,
    adminEmail: request.requestedByEmail,
    tenantId: request.tenantId,
    tenantName: request.tenantName,
    issuedAt,
    expiresAt,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { token: `${TOKEN_PREFIX}${body}.${signature(body)}`, expiresAt: new Date(expiresAt).toISOString() };
}

export function verifySupportAccessToken(authHeader: string | undefined): Identity | null {
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim();
  if (!token?.startsWith(TOKEN_PREFIX)) return null;
  const [body, provided, ...extra] = token.slice(TOKEN_PREFIX.length).split('.');
  if (!body || !provided || extra.length) return null;

  let expected: string;
  try {
    expected = signature(body);
  } catch {
    return null;
  }
  const suppliedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SupportTokenPayload;
    const now = Date.now();
    if (
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt <= 0 ||
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > MAX_TOKEN_TTL_MS ||
      payload.issuedAt > now + CLOCK_SKEW_MS ||
      payload.expiresAt <= now
    ) {
      return null;
    }
    if (!supportAccessDefaultAuthorized(payload.tenantId)) return null;
    const request = readRequests().find(item => item.id === payload.requestId);
    if (
      !request ||
      request.status !== 'approved' ||
      request.tenantId !== payload.tenantId ||
      request.requestedByUserId !== payload.adminUserId
    ) {
      return null;
    }
    return {
      userId: payload.adminUserId,
      tenantId: payload.tenantId,
      supportAccess: {
        requestId: payload.requestId,
        adminEmail: payload.adminEmail,
        tenantName: payload.tenantName,
        expiresAt: new Date(payload.expiresAt).toISOString(),
      },
    };
  } catch {
    return null;
  }
}
