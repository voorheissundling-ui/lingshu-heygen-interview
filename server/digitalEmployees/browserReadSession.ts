import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { DataAuthority } from '../storage/dataAuthority.js';

export type ReadSession = {
  tenantId: string;
  userId: string;
  role: 'social_operator' | 'customer_service' | 'admin';
  dataAuthority: DataAuthority;
  expiresAt: number;
};
const sessions = new Map<string, ReadSession>();
const prefix = 'agent-browser-read.';

/** A server-created, memory-only credential for loading the existing business
 * pages. It cannot save, generate, approve, publish or send anything. */
export function createBrowserReadSession(identity: Omit<ReadSession, 'expiresAt'>) {
  const token = prefix + randomBytes(32).toString('hex');
  sessions.set(token, { ...identity, expiresAt: Date.now() + 30 * 60_000 });
  return { token, touch: () => { const session = sessions.get(token); if (session) session.expiresAt = Date.now() + 30 * 60_000; }, revoke: () => sessions.delete(token) };
}
export function isBrowserReadToken(authorization?: string) { return Boolean(authorization?.startsWith(`Bearer ${prefix}`)); }
export function browserReadIdentity(req: Pick<Request, 'headers' | 'method' | 'originalUrl' | 'url'>): ReadSession | null {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const identity = sessions.get(token);
  if (!identity || identity.expiresAt < Date.now()) { if (identity) sessions.delete(token); return null; }
  if (!['GET', 'HEAD'].includes(req.method)) return null;
  const path = new URL(req.originalUrl || req.url, 'http://local').pathname;
  if (!path.startsWith('/api/overseas/') || /\/browser-stream\/?$/.test(path)) return null;
  if (/^\/api\/overseas\/(admin|support-access|organization|plugins)(\/|$)/.test(path)) return null;
  if (path.startsWith('/api/overseas/auth/') && path !== '/api/overseas/auth/me') return null;
  if (identity.role === 'social_operator' && /^\/api\/overseas\/(customers|customer-service)(\/|$)/.test(path)) return null;
  return identity;
}
