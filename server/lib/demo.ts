import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Request, Response } from 'express';
import { auth } from '../storage/index.js';
import { getTenantSubscription, type Subscription } from '../middleware/subscription.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USAGE_FILE = path.join(__dirname, '../../data/demo-usage.json');

export type DemoQuotaKind = 'aiChat' | 'generation' | 'render' | 'videoGeneration';

export interface DemoLimits {
  trialDays: number;
  aiChatDaily: number;
  generationDaily: number;
  renderDaily: number;
  videoGenerationDaily: number;
  tokenDaily: number;
  tokenTotal: number;
}

export interface DemoUsageDay {
  aiChat: number;
  generation: number;
  render: number;
  videoGeneration: number;
  tokens: number;
}

export interface DemoStatus {
  enabled: boolean;
  trialDays: number;
  expiresAt: string | null;
  daysRemaining: number | null;
  expired: boolean;
  limits: DemoLimits;
  usage: DemoUsageDay;
  remaining: DemoUsageDay;
  totalUsage: { tokens: number; videoGeneration: number };
  totalRemaining: { tokens: number; videoGeneration: number };
}

type UsageStore = Record<string, Record<string, DemoUsageDay>>;

const DEFAULT_USAGE: DemoUsageDay = { aiChat: 0, generation: 0, render: 0, videoGeneration: 0, tokens: 0 };

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true';
}

export function demoQuotaExemptTenantIds(): ReadonlySet<string> {
  return new Set(
    String(process.env.DEMO_QUOTA_EXEMPT_TENANT_IDS ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  );
}

export function isDemoQuotaExemptTenant(tenantId: string | null | undefined): boolean {
  const normalizedTenantId = String(tenantId ?? '').trim();
  return !!normalizedTenantId && demoQuotaExemptTenantIds().has(normalizedTenantId);
}

function isTrialSubscription(sub: Subscription | null | undefined): boolean {
  const plan = String(sub?.plan ?? '').toLowerCase();
  return sub?.status === 'trialing' || plan === 'trial';
}

function isAdminSubscription(sub: Subscription | null | undefined): boolean {
  return String(sub?.plan ?? '').toLowerCase() === 'admin';
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function demoLimits(): DemoLimits {
  return {
    trialDays: 5,
    aiChatDaily: intEnv('DEMO_DAILY_AI_CHAT_LIMIT', 20),
    generationDaily: intEnv('DEMO_DAILY_GENERATION_LIMIT', 10),
    renderDaily: intEnv('DEMO_DAILY_RENDER_LIMIT', 3),
    videoGenerationDaily: intEnv('DEMO_VIDEO_GENERATION_LIMIT', intEnv('DEMO_DAILY_VIDEO_GENERATION_LIMIT', 2)),
    tokenDaily: intEnv('DEMO_DAILY_TOKEN_LIMIT', 30_000),
    tokenTotal: intEnv('DEMO_TOTAL_TOKEN_LIMIT', 30_000),
  };
}

export function demoTrialExpiresAt(from = new Date()): string {
  return new Date(from.getTime() + demoLimits().trialDays * 24 * 3600 * 1000).toISOString();
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function readUsage(): UsageStore {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) as UsageStore;
  } catch {
    return {};
  }
}

function writeUsage(store: UsageStore): void {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

async function identityKey(req: Request): Promise<string> {
  const result = await auth.verifyToken(req.headers.authorization);
  if (result?.tenantId) return `tenant:${result.tenantId}`;
  return `anon:${req.ip || 'local'}`;
}

async function accountKey(req: Request): Promise<string> {
  const result = await auth.verifyToken(req.headers.authorization);
  if (result?.userId) return `user:${result.userId}`;
  if (result?.tenantId) return `tenant:${result.tenantId}`;
  return `anon:${req.ip || 'local'}`;
}

function emptyUsage(): DemoUsageDay {
  return { ...DEFAULT_USAGE };
}

function totalVideoGenerationUsage(store: UsageStore, key: string): number {
  return Object.values(store[key] ?? {}).reduce((sum, day) => sum + (day.videoGeneration ?? 0), 0);
}

function totalTokenUsage(store: UsageStore, key: string): number {
  return Object.values(store[key] ?? {}).reduce((sum, day) => sum + (day.tokens ?? 0), 0);
}

function remaining(usage: DemoUsageDay, limits: DemoLimits, videoGenerationUsed = usage.videoGeneration ?? 0, tokenUsed = usage.tokens ?? 0): DemoUsageDay {
  return {
    aiChat: Math.max(0, limits.aiChatDaily - usage.aiChat),
    generation: Math.max(0, limits.generationDaily - usage.generation),
    render: Math.max(0, limits.renderDaily - usage.render),
    videoGeneration: Math.max(0, limits.videoGenerationDaily - videoGenerationUsed),
    tokens: Math.max(0, limits.tokenDaily - tokenUsed),
  };
}

export function isExpired(expiresAt?: string | null): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() < Date.now();
}

export async function buildDemoStatus(req: Request, tenantId?: string, expiresAt?: string | null, userId?: string): Promise<DemoStatus> {
  const limits = demoLimits();
  if (isDemoQuotaExemptTenant(tenantId)) {
    return {
      enabled: false,
      trialDays: limits.trialDays,
      expiresAt: null,
      daysRemaining: null,
      expired: false,
      limits,
      usage: emptyUsage(),
      remaining: {
        aiChat: limits.aiChatDaily,
        generation: limits.generationDaily,
        render: limits.renderDaily,
        videoGeneration: limits.videoGenerationDaily,
        tokens: limits.tokenDaily,
      },
      totalUsage: { tokens: 0, videoGeneration: 0 },
      totalRemaining: { tokens: limits.tokenTotal, videoGeneration: limits.videoGenerationDaily },
    };
  }
  let resolvedExpiresAt = expiresAt ?? null;
  let subscription: Subscription | null = null;
  if (!resolvedExpiresAt && tenantId) {
    subscription = await getTenantSubscription(tenantId);
    resolvedExpiresAt = subscription.expiresAt;
  } else if (tenantId) {
    subscription = await getTenantSubscription(tenantId);
  }

  const key = tenantId ? `tenant:${tenantId}` : await identityKey(req);
  const tokenKey = userId ? `user:${userId}` : await accountKey(req);
  const store = readUsage();
  const usage = { ...emptyUsage(), ...(store[key]?.[todayKey()] ?? {}) };
  const tokenUsage = { ...emptyUsage(), ...(store[tokenKey]?.[todayKey()] ?? {}) };
  const videoGenerationUsed = totalVideoGenerationUsage(store, key);
  const tokensUsedToday = tokenUsage.tokens ?? 0;
  const tokensUsedTotal = totalTokenUsage(store, tokenKey);
  const expired = isExpired(resolvedExpiresAt);
  const daysRemaining = resolvedExpiresAt
    ? Math.max(0, Math.ceil((new Date(resolvedExpiresAt).getTime() - Date.now()) / (24 * 3600 * 1000)))
    : null;

  return {
    enabled: isDemoMode() || isTrialSubscription(subscription),
    trialDays: limits.trialDays,
    expiresAt: resolvedExpiresAt,
    daysRemaining,
    expired,
    limits,
    usage: { ...usage, tokens: tokensUsedToday },
    remaining: remaining(usage, limits, videoGenerationUsed, tokensUsedToday),
    totalUsage: { tokens: tokensUsedTotal, videoGeneration: videoGenerationUsed },
    totalRemaining: {
      tokens: Math.max(0, limits.tokenTotal - tokensUsedTotal),
      videoGeneration: Math.max(0, limits.videoGenerationDaily - videoGenerationUsed),
    },
  };
}

function limitFor(kind: DemoQuotaKind, limits: DemoLimits): number {
  if (kind === 'aiChat') return limits.aiChatDaily;
  if (kind === 'generation') return limits.generationDaily;
  if (kind === 'videoGeneration') return limits.videoGenerationDaily;
  return limits.renderDaily;
}

function estimateTextTokens(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') {
    const ascii = (value.match(/[\x00-\x7F]/g) ?? []).length;
    const nonAscii = value.length - ascii;
    return Math.ceil(ascii / 4 + nonAscii * 0.75);
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTextTokens(item), 0);
  if (typeof value === 'object') return estimateTextTokens(JSON.stringify(value));
  return estimateTextTokens(String(value));
}

function tokenReserveFor(kind: DemoQuotaKind): number {
  if (kind === 'aiChat') return 1_600;
  if (kind === 'generation') return 1_200;
  if (kind === 'videoGeneration') return 2_000;
  return 0;
}

function estimateRequestTokens(req: Request, kind: DemoQuotaKind): number {
  const bodyTokens = estimateTextTokens(req.body ?? {});
  return Math.max(1, Math.ceil(bodyTokens + tokenReserveFor(kind)));
}

export async function consumeDemoQuota(req: Request, res: Response, kind: DemoQuotaKind): Promise<boolean> {
  const locals = res.locals as { userId?: unknown; tenantId?: unknown };
  const id = typeof locals.userId === 'string' && locals.userId
    && typeof locals.tenantId === 'string' && locals.tenantId
    ? { userId: locals.userId, tenantId: locals.tenantId }
    : await auth.verifyToken(req.headers.authorization);
  if (isDemoQuotaExemptTenant(id?.tenantId)) return true;
  const sub = id?.tenantId ? await getTenantSubscription(id.tenantId) : null;
  if (isAdminSubscription(sub)) return true;
  const quotaEnforced = isDemoMode() || isTrialSubscription(sub);

  if (quotaEnforced && sub?.expiresAt && isExpired(sub.expiresAt)) {
    res.status(402).json({ error: 'demo_expired', demo: await buildDemoStatus(req, id?.tenantId, sub.expiresAt) });
    return false;
  }

  const key = id?.tenantId ? `tenant:${id.tenantId}` : await identityKey(req);
  const tokenKey = id?.userId ? `user:${id.userId}` : key;
  const day = todayKey();
  const store = readUsage();
  const usage = { ...emptyUsage(), ...(store[key]?.[day] ?? {}) };
  const tokenUsage = { ...emptyUsage(), ...(store[tokenKey]?.[day] ?? {}) };
  const limits = demoLimits();
  const used = kind === 'videoGeneration' ? totalVideoGenerationUsage(store, key) : usage[kind];
  if (quotaEnforced && used >= limitFor(kind, limits)) {
    res.status(429).json({ error: 'demo_quota_exceeded', quota: kind, demo: await buildDemoStatus(req, id?.tenantId, sub?.expiresAt) });
    return false;
  }

  const tokenCost = kind === 'render' ? 0 : estimateRequestTokens(req, kind);
  const usedTokensToday = tokenUsage.tokens ?? 0;
  const usedTokensTotal = totalTokenUsage(store, tokenKey);
  if (quotaEnforced && (usedTokensToday + tokenCost > limits.tokenDaily || usedTokensTotal + tokenCost > limits.tokenTotal)) {
    res.status(429).json({
      error: 'demo_token_quota_exceeded',
      quota: 'tokens',
      tokenCost,
      demo: await buildDemoStatus(req, id?.tenantId, sub?.expiresAt),
    });
    return false;
  }

  usage[kind] += 1;
  tokenUsage.tokens = usedTokensToday + tokenCost;
  if (tokenKey === key) {
    store[key] = { ...(store[key] ?? {}), [day]: { ...usage, tokens: tokenUsage.tokens } };
  } else {
    store[key] = { ...(store[key] ?? {}), [day]: usage };
    store[tokenKey] = { ...(store[tokenKey] ?? {}), [day]: tokenUsage };
  }
  writeUsage(store);
  return true;
}

export function resetDemoUsage(): void {
  writeUsage({});
}
