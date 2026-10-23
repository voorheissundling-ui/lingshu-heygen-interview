import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'url';
import type { NextFunction, Request, Response } from 'express';
import { auth } from '../storage/index.js';
import type { Identity } from '../storage/datastore.js';
import { pbGetStrict, pbPatch } from '../storage/pb.js';
import { isLocalDemoAuthorization, verifyLocalIdentity } from '../auth/localIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = process.env.NODE_ENV === 'test' && process.env.DEMO_ACCOUNT_REGISTRY_FILE
  ? path.resolve(process.env.DEMO_ACCOUNT_REGISTRY_FILE) : path.join(__dirname, '../../data/demo-account-registry.json');
const REGISTRY_BACKUP_FILE = process.env.NODE_ENV === 'test' && process.env.DEMO_ACCOUNT_REGISTRY_BACKUP_FILE
  ? path.resolve(process.env.DEMO_ACCOUNT_REGISTRY_BACKUP_FILE) : path.join(__dirname, '../../data/demo-account-registry.backup.json');
const USAGE_FILE = path.join(__dirname, '../../data/demo-usage.json');

export interface DemoAccountRegistryEntry {
  email: string;
  userId?: string;
  tenantId?: string;
  activatedAt?: string | null;
  expiresAt?: string | null;
  rotatedAt?: string | null;
  credentialState?: DemoCredentialState;
  guidePending?: boolean;
  guideResetAt?: string | null;
  status?: 'available' | 'trialing' | 'expired' | 'customer' | 'admin';
}

export type DemoCredentialState =
  | 'active_hash_only'
  | 'external_secret'
  | 'password_reset_required'
  | 'expired_locked';

export interface AccountGuideState {
  pending: boolean;
  scope: string;
  resetAt: string | null;
}

type DemoAccountRegistry = Record<string, DemoAccountRegistryEntry>;
type StoredDemoAccountRegistry = Record<string, Record<string, unknown>>;
type DemoUsageDay = { aiChat?: number; generation?: number; render?: number; videoGeneration?: number; tokens?: number };
type DemoUsageStore = Record<string, Record<string, DemoUsageDay>>;

const LEGACY_CREDENTIAL_FIELDS = ['password', 'rotationPassword', 'registeredPasswordCipher'] as const;
type LegacyCredentialField = typeof LEGACY_CREDENTIAL_FIELDS[number];

export interface DemoAccountCredentialResetRequirement {
  email: string;
  userId: string | null;
  tenantId: string | null;
  status: DemoAccountRegistryEntry['status'] | null;
  legacyFields: LegacyCredentialField[];
  requiredAction: 'reset_or_provision_authentication_credential';
}

export interface DemoAccountCredentialMigrationPlan {
  schemaVersion: 1;
  generatedAt: string;
  sourceFingerprint: string;
  resetRequiredCount: number;
  releaseBlocked: boolean;
  accounts: DemoAccountCredentialResetRequirement[];
}

const DEMO_CREDENTIAL_STATES = new Set<DemoCredentialState>([
  'active_hash_only',
  'external_secret',
  'password_reset_required',
  'expired_locked',
]);

const DEMO_CREDENTIAL_ACTIONS: Record<DemoCredentialState, string> = {
  active_hash_only: '密码仅由认证系统哈希保存；需要变更时由用户执行密码重置。',
  external_secret: '凭据由受控部署渠道管理；后台不保存或展示。',
  password_reset_required: '必须通过受控渠道执行一次性密码重置；后台不保存或展示密码。',
  expired_locked: '账号已锁定；转正或恢复前必须执行一次性密码重置。',
};

export function demoCredentialPresentation(state?: DemoCredentialState): {
  credentialState: DemoCredentialState;
  credentialAction: string;
} {
  const credentialState = state ?? 'password_reset_required';
  return { credentialState, credentialAction: DEMO_CREDENTIAL_ACTIONS[credentialState] };
}

function norm(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function localId(value: string): string {
  return norm(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'demo';
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Remove legacy cleartext credentials at the storage boundary. Entries that
 * depended on a stored password require an explicit reset instead of recovery.
 */
export function sanitizeDemoAccountRegistryEntry(record: Record<string, unknown>): DemoAccountRegistryEntry {
  const {
    password: discardedPassword,
    rotationPassword: discardedRotationPassword,
    registeredPasswordCipher: discardedRegistrationPasswordCipher,
    ...safeRecord
  } = record;
  const email = norm(String(safeRecord.email || ''));
  const status = safeRecord.status as DemoAccountRegistryEntry['status'];
  const configuredState = safeRecord.credentialState as DemoCredentialState | undefined;
  const hadLegacyCredential = Boolean(
    discardedPassword || discardedRotationPassword || discardedRegistrationPasswordCipher,
  );
  const credentialState = status === 'expired' || Boolean(safeRecord.rotatedAt)
    ? 'expired_locked'
    : hadLegacyCredential
      ? 'password_reset_required'
      : configuredState && DEMO_CREDENTIAL_STATES.has(configuredState)
        ? configuredState
        : status === 'admin'
          ? 'external_secret'
          : safeRecord.userId
            ? 'active_hash_only'
            : 'password_reset_required';
  return {
    ...safeRecord,
    email,
    status,
    credentialState,
  } as DemoAccountRegistryEntry;
}

function sanitizeRegistry(registry: StoredDemoAccountRegistry): { registry: DemoAccountRegistry; changed: boolean } {
  const safeRegistry: DemoAccountRegistry = {};
  let changed = false;
  for (const [key, value] of Object.entries(registry)) {
    if (!value || typeof value !== 'object') {
      changed = true;
      continue;
    }
    const safeEntry = sanitizeDemoAccountRegistryEntry({ ...value, email: value.email || key });
    if (!safeEntry.email) {
      changed = true;
      continue;
    }
    safeRegistry[safeEntry.email] = safeEntry;
    if (safeEntry.email !== key || JSON.stringify(value) !== JSON.stringify(safeEntry)) changed = true;
  }
  return { registry: safeRegistry, changed };
}

function readRegistryFile(file: string): StoredDemoAccountRegistry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('registry root must be an object');
    }
    return parsed as StoredDemoAccountRegistry;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error(`Cannot read demo account registry ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readStoredRegistryRaw(
  primaryFile = REGISTRY_FILE,
  backupFile = REGISTRY_BACKUP_FILE,
): StoredDemoAccountRegistry {
  const primary = readRegistryFile(primaryFile);
  const stored = primary && Object.keys(primary).length > 0
    ? primary
    : readRegistryFile(backupFile) ?? primary ?? {};
  return stored;
}

function writeSecureJson(file: string, contents: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === contents) {
      try { fs.chmodSync(file, 0o600); } catch { /* Some platforms ignore POSIX modes. */ }
      return;
    }
  } catch {
    // File may not exist yet; the atomic create below handles that case.
  }
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Some platforms ignore POSIX file modes.
  }
}

export function mergeDemoAccountRegistryMetadata(
  stored: StoredDemoAccountRegistry,
  updates: DemoAccountRegistry,
): StoredDemoAccountRegistry {
  const next: StoredDemoAccountRegistry = Object.fromEntries(
    Object.entries(stored).map(([key, value]) => [key, { ...value }]),
  );
  for (const [email, update] of Object.entries(updates)) {
    const normalizedEmail = norm(email || update.email);
    if (!normalizedEmail) continue;
    const existingKey = Object.keys(next).find(key => norm(String(next[key]?.email || key)) === normalizedEmail);
    const targetKey = existingKey || normalizedEmail;
    const safeUpdate = sanitizeDemoAccountRegistryEntry({ ...update, email: normalizedEmail });
    // Metadata writes deliberately retain historical credential fields until an
    // operator completes the explicit, fingerprinted credential migration.
    next[targetKey] = { ...(next[targetKey] || {}), ...safeUpdate };
  }
  return next;
}

function writeRegistryMetadata(registry: DemoAccountRegistry): void {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  const primary = readRegistryFile(REGISTRY_FILE);
  const backup = readRegistryFile(REGISTRY_BACKUP_FILE);
  if (primary === null && backup === null) {
    const contents = JSON.stringify(registry, null, 2);
    writeSecureJson(REGISTRY_BACKUP_FILE, contents);
    writeSecureJson(REGISTRY_FILE, contents);
    return;
  }
  const primaryIsSource = Boolean(primary && Object.keys(primary).length > 0);
  if (primaryIsSource || (primary !== null && backup === null)) {
    writeSecureJson(REGISTRY_FILE, JSON.stringify(mergeDemoAccountRegistryMetadata(primary ?? {}, registry), null, 2));
  }
  if (backup !== null) {
    writeSecureJson(REGISTRY_BACKUP_FILE, JSON.stringify(mergeDemoAccountRegistryMetadata(backup, registry), null, 2));
  }
}

function demoRegistryFingerprint(stored: StoredDemoAccountRegistry): string {
  return createHash('sha256').update(JSON.stringify(stored)).digest('hex');
}

function mergeStoredDemoRegistries(
  fallback: StoredDemoAccountRegistry,
  preferred: StoredDemoAccountRegistry,
): StoredDemoAccountRegistry {
  const combined: StoredDemoAccountRegistry = Object.fromEntries(
    Object.entries(fallback).map(([key, value]) => [key, { ...value }]),
  );
  for (const [key, value] of Object.entries(preferred)) {
    const email = norm(String(value.email || key));
    const existingKey = Object.keys(combined).find(candidate => (
      norm(String(combined[candidate]?.email || candidate)) === email
    ));
    if (existingKey && existingKey !== key) delete combined[existingKey];
    combined[key] = { ...(existingKey ? fallback[existingKey] : {}), ...value };
  }
  return combined;
}

function readDemoCredentialMigrationSource(primaryFile: string, backupFile: string): {
  primary: StoredDemoAccountRegistry;
  backup: StoredDemoAccountRegistry;
  combined: StoredDemoAccountRegistry;
  fingerprint: string;
} {
  const primary = readRegistryFile(primaryFile) ?? {};
  const backup = readRegistryFile(backupFile) ?? {};
  const combined = mergeStoredDemoRegistries(backup, primary);
  return {
    primary,
    backup,
    combined,
    fingerprint: createHash('sha256').update(JSON.stringify({ primary, backup })).digest('hex'),
  };
}

export function buildDemoAccountCredentialMigrationPlan(
  stored: StoredDemoAccountRegistry,
  generatedAt = new Date().toISOString(),
): DemoAccountCredentialMigrationPlan {
  const accounts = Object.entries(stored).flatMap(([key, value]) => {
    if (!value || typeof value !== 'object') return [];
    const legacyFields = LEGACY_CREDENTIAL_FIELDS.filter(field => (
      Object.hasOwn(value, field) && Boolean(value[field])
    ));
    if (!legacyFields.length) return [];
    const safe = sanitizeDemoAccountRegistryEntry({ ...value, email: value.email || key });
    return [{
      email: safe.email,
      userId: safe.userId || null,
      tenantId: safe.tenantId || null,
      status: safe.status ?? null,
      legacyFields,
      requiredAction: 'reset_or_provision_authentication_credential' as const,
    }];
  });
  return {
    schemaVersion: 1,
    generatedAt,
    sourceFingerprint: demoRegistryFingerprint(stored),
    resetRequiredCount: accounts.length,
    releaseBlocked: accounts.length > 0,
    accounts,
  };
}

export function readDemoAccountCredentialMigrationPlan(options: {
  primaryFile?: string;
  backupFile?: string;
  generatedAt?: string;
} = {}): DemoAccountCredentialMigrationPlan {
  const primaryFile = options.primaryFile ?? REGISTRY_FILE;
  const backupFile = options.backupFile ?? REGISTRY_BACKUP_FILE;
  const source = readDemoCredentialMigrationSource(primaryFile, backupFile);
  return {
    ...buildDemoAccountCredentialMigrationPlan(source.combined, options.generatedAt),
    sourceFingerprint: source.fingerprint,
  };
}

/**
 * Explicit two-phase migration only. Callers must first review the plan and
 * reset/provision every listed account, then supply both its fingerprint and
 * the confirmed email list. Ordinary registry reads and metadata writes never
 * call this function and never delete a legacy credential.
 */
export function applyDemoAccountCredentialMigration(options: {
  expectedSourceFingerprint: string;
  confirmedResetEmails: string[];
  primaryFile?: string;
  backupFile?: string;
}): DemoAccountCredentialMigrationPlan {
  const primaryFile = options.primaryFile ?? REGISTRY_FILE;
  const backupFile = options.backupFile ?? REGISTRY_BACKUP_FILE;
  const source = readDemoCredentialMigrationSource(primaryFile, backupFile);
  const plan = {
    ...buildDemoAccountCredentialMigrationPlan(source.combined),
    sourceFingerprint: source.fingerprint,
  };
  if (!options.expectedSourceFingerprint || options.expectedSourceFingerprint !== plan.sourceFingerprint) {
    throw new Error('Demo credential migration source changed; generate and review a fresh reset-required plan');
  }
  const confirmed = new Set(options.confirmedResetEmails.map(norm).filter(Boolean));
  const missing = plan.accounts.map(account => account.email).filter(email => !confirmed.has(email));
  if (missing.length) {
    throw new Error(`Demo credential migration requires confirmed resets for: ${missing.join(', ')}`);
  }

  const sanitized = sanitizeRegistry(source.combined).registry;
  const contents = JSON.stringify(sanitized, null, 2);
  fs.mkdirSync(path.dirname(primaryFile), { recursive: true });
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });
  writeSecureJson(backupFile, contents);
  writeSecureJson(primaryFile, contents);

  for (const file of [primaryFile, backupFile]) {
    const verified = readRegistryFile(file) ?? {};
    for (const record of Object.values(verified)) {
      if (LEGACY_CREDENTIAL_FIELDS.some(field => Object.hasOwn(record, field))) {
        throw new Error(`Demo credential migration verification failed for ${file}`);
      }
    }
  }
  return plan;
}

export function allowedDemoAccounts(): string[] {
  const envAccounts = String(process.env.DEMO_ALLOWED_ACCOUNTS ?? '')
    .split(/[\s,;]+/)
    .map(norm)
    .filter(Boolean);
  const registry = readStoredRegistryRaw();
  return Array.from(new Set([
    ...envAccounts,
    ...Object.entries(registry).map(([key, value]) => norm(String(value.email || key))).filter(Boolean),
  ]));
}

export function isAllowedDemoAccount(email: string): boolean {
  const allowed = allowedDemoAccounts();
  if (!allowed.length) return true; // no whitelist configured → open to all
  return allowed.includes(norm(email));
}

export function readDemoAccountRegistrySnapshot(options: {
  primaryFile?: string;
  backupFile?: string;
  allowedAccounts?: string[];
} = {}): DemoAccountRegistry {
  const stored = readStoredRegistryRaw(options.primaryFile, options.backupFile);
  const registry = sanitizeRegistry(stored).registry;
  for (const email of options.allowedAccounts ?? []) {
    const normalizedEmail = norm(email);
    if (!normalizedEmail) continue;
    registry[normalizedEmail] ??= { email: normalizedEmail, status: 'available', credentialState: 'password_reset_required' };
  }
  return registry;
}

export function readDemoAccountRegistry(): DemoAccountRegistry {
  const registry = readDemoAccountRegistrySnapshot();
  const configuredAccounts = String(process.env.DEMO_ALLOWED_ACCOUNTS ?? '')
    .split(/[\s,;]+/)
    .map(norm)
    .filter(Boolean);
  for (const email of configuredAccounts) {
    registry[email] ??= { email, status: 'available', credentialState: 'password_reset_required' };
  }
  return registry;
}

export function upsertDemoAccountRegistry(email: string, patch: Partial<DemoAccountRegistryEntry>): DemoAccountRegistryEntry {
  const key = norm(email);
  const registry = readDemoAccountRegistry();
  const next = sanitizeDemoAccountRegistryEntry({ status: 'available', ...registry[key], ...patch, email: key });
  registry[key] = next;
  writeRegistryMetadata(registry);
  return next;
}

export function accountGuideStateFromEntry<T extends Pick<DemoAccountRegistryEntry, 'guidePending' | 'guideResetAt'>>(
  entry: T | undefined,
  baseScope: string,
): AccountGuideState {
  const resetAt = entry?.guideResetAt || null;
  return {
    pending: entry?.guidePending === true,
    scope: resetAt ? `${baseScope}:reset:${resetAt}` : baseScope,
    resetAt,
  };
}

export function accountGuideState(email: string, baseScope: string): AccountGuideState {
  return accountGuideStateFromEntry(readDemoAccountRegistry()[norm(email)], baseScope);
}

export function resetAccountGuide(
  email: string,
  identity: Pick<DemoAccountRegistryEntry, 'userId' | 'tenantId' | 'status'> = {},
): DemoAccountRegistryEntry {
  return upsertDemoAccountRegistry(email, {
    ...identity,
    guidePending: true,
    guideResetAt: new Date().toISOString(),
  });
}

export function isTrialAccount(subscription: { status?: string; plan?: string | null } | null | undefined): boolean {
  return subscription?.status === 'trialing' || String(subscription?.plan ?? '').toLowerCase() === 'trial';
}

export function trialExpiresAt(from = new Date()): string {
  return new Date(from.getTime() + 5 * 24 * 3600 * 1000).toISOString();
}

export async function activateTrialAccount(email: string, userId: string, tenantId: string, currentExpiresAt?: string | null): Promise<{ expiresAt: string; activatedNow: boolean }> {
  const registryEntry = readDemoAccountRegistry()[norm(email)];
  const activatedNow = !currentExpiresAt && !registryEntry?.activatedAt;
  const expiresAt = currentExpiresAt || registryEntry?.expiresAt || trialExpiresAt();
  const activatedAt = registryEntry?.activatedAt || new Date().toISOString();
  upsertDemoAccountRegistry(email, {
    userId,
    tenantId,
    activatedAt,
    expiresAt,
    status: 'trialing',
    credentialState: 'active_hash_only',
    ...(activatedNow ? {
      guidePending: true,
      guideResetAt: activatedAt,
    } : {}),
  });
  await pbPatch('tenants', tenantId, {
    subscriptionStatus: 'trialing',
    subscriptionPlan: 'trial',
    subscriptionExpiresAt: expiresAt,
  });
  return { expiresAt, activatedNow };
}

export function consumeDemoGuide(email: string): void {
  const key = norm(email);
  const registry = readDemoAccountRegistry();
  if (!registry[key]) return;
  if (registry[key].guidePending === false) return;
  upsertDemoAccountRegistry(key, { guidePending: false });
}

export async function rotateExpiredTrialPassword(user: { id?: string; email?: string } | null, reason = 'trial_expired'): Promise<void> {
  if (!user?.id || !user.email) return;
  const entry = readDemoAccountRegistry()[norm(user.email)];
  if (entry?.rotatedAt) return;

  // Invalidate the old login with a high-entropy secret that is never stored or returned.
  // Reactivation requires an explicit, one-time password reset through a controlled channel.
  const invalidationSecret = randomBytes(32).toString('base64url');
  const ok = await pbPatch('users', user.id, {
    password: invalidationSecret,
    passwordConfirm: invalidationSecret,
  });
  if (!ok) return;
  upsertDemoAccountRegistry(user.email, {
    userId: user.id,
    rotatedAt: new Date().toISOString(),
    status: 'expired',
    credentialState: 'expired_locked',
  });
  void reason;
}

function isConfiguredAdminEmail(normalized: string): boolean {
  const localAdminEmail = norm(process.env.LOCAL_ADMIN_EMAIL ?? '');
  if (localAdminEmail && normalized === localAdminEmail) return true;
  const workbenchAdminEmail = norm(process.env.WORKBENCH_ADMIN_EMAIL ?? '');
  if (workbenchAdminEmail && normalized === workbenchAdminEmail) return true;
  const allowed = String(process.env.ADMIN_DASHBOARD_EMAILS ?? '')
    .split(/[\s,;]+/)
    .map(norm)
    .filter(Boolean);
  return allowed.includes(normalized);
}

export function isAdminEmail(email?: string): boolean {
  const normalized = norm(email ?? '');
  if (!normalized) return false;
  return isConfiguredAdminEmail(normalized) || readDemoAccountRegistry()[normalized]?.status === 'admin';
}

function hasPlatformAdminClaim(user: Record<string, unknown>): boolean {
  const role = norm(String(user.platformRole || user.platform_role || ''));
  return user.platformAdmin === true || user.platform_admin === true
    || user.isPlatformAdmin === true || user.is_platform_admin === true
    || role === 'admin' || role === 'super_admin';
}

interface AdminIdentityDependencies {
  getUser(userId: string): Promise<Record<string, unknown> | null>;
  readRegistry(): DemoAccountRegistry;
}

const defaultAdminIdentityDependencies: AdminIdentityDependencies = {
  getUser: userId => pbGetStrict('users', userId),
  readRegistry: readDemoAccountRegistry,
};
let adminIdentityDependencies = defaultAdminIdentityDependencies;

export function setAdminIdentityDependenciesForTests(overrides: Partial<AdminIdentityDependencies> | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('admin_identity_test_dependencies_forbidden');
  adminIdentityDependencies = overrides ? { ...defaultAdminIdentityDependencies, ...overrides } : defaultAdminIdentityDependencies;
}

export interface AdminIdentity {
  userId: string;
  tenantId: string;
  email: string;
}

export class AdminIdentityUnavailableError extends Error {
  constructor(readonly reason: unknown) {
    super('admin_identity_provider_unavailable');
    this.name = 'AdminIdentityUnavailableError';
  }
}

const adminIdentityByRequest = new WeakMap<Request, Promise<AdminIdentity | null>>();

async function resolveAdminUser(req: Request, verifiedIdentity?: Identity): Promise<AdminIdentity | null> {
  let id;
  if (verifiedIdentity) {
    id = verifiedIdentity;
  } else {
    try {
      id = await auth.verifyToken(req.headers.authorization);
    } catch (error) {
      throw new AdminIdentityUnavailableError(error);
    }
  }
  if (!id || id.supportAccess || typeof id.userId !== 'string' || typeof id.tenantId !== 'string') return null;
  const userId = id.userId;
  const tenantId = id.tenantId;
  if (!userId || !tenantId || userId !== userId.trim() || tenantId !== tenantId.trim()) return null;
  const local = isLocalDemoAuthorization(req.headers.authorization)
    ? verifyLocalIdentity(req.headers.authorization)
    : null;
  if (isLocalDemoAuthorization(req.headers.authorization) && !local) return null;
  let user: Record<string, unknown> | null = local ? {
    id: local.userId,
    tenantId: local.tenantId,
    email: local.email,
    role: local.role,
  } : null;
  if (!local) {
    try {
      user = await adminIdentityDependencies.getUser(userId);
    } catch (error) {
      throw new AdminIdentityUnavailableError(error);
    }
  }
  const claims = local;
  if (claims && (claims.userId !== userId || claims.tenantId !== tenantId)) return null;
  let userEmail = '';
  if (user) {
    if (String(user.id || '') !== userId || String(user.tenantId || '') !== tenantId) return null;
    userEmail = norm(String(user.email || ''));
    if (!userEmail || (claims && claims.email !== userEmail)) return null;
  }
  const registry = adminIdentityDependencies.readRegistry();
  const entries = Object.values(registry).filter(entry => norm(entry.email));
  const userEntries = entries.filter(entry => entry.userId === userId);
  if (userEntries.length > 1) return null;
  const adminUserEntries = userEntries.filter(entry => entry.status === 'admin');
  const email = userEmail || claims?.email || norm(adminUserEntries[0]?.email || '');
  if (!email) return null;
  const emailEntries = entries.filter(entry => norm(entry.email) === email);
  if (emailEntries.length > 1) return null;
  const matchingEntries = [...new Set([...userEntries, ...emailEntries])];
  if (matchingEntries.some(entry =>
    norm(entry.email) !== email
    || Boolean(entry.userId && entry.userId !== userId)
    || Boolean(entry.tenantId && entry.tenantId !== tenantId)
  )) return null;
  const explicitLocalAdmin = Boolean(local
    && local.accountType === 'admin'
    && local.userId === `local_user_admin_${localId(email)}`
    && local.tenantId === `local_tenant_admin_${localId(email)}`);
  const allowed = Boolean(adminUserEntries.length || emailEntries.some(entry => entry.status === 'admin')
    || (user && hasPlatformAdminClaim(user) && (!local || local.accountType === 'admin'))
    || (isConfiguredAdminEmail(email) && (local ? explicitLocalAdmin : Boolean(user))));
  if (!allowed) return null;
  return { userId, tenantId, email };
}

export function requireAdminUser(req: Request, verifiedIdentity?: Identity): Promise<AdminIdentity | null> {
  const cached = adminIdentityByRequest.get(req);
  if (cached) return cached;
  const pending = resolveAdminUser(req, verifiedIdentity);
  adminIdentityByRequest.set(req, pending);
  return pending;
}

function respondAdminIdentityUnavailable(res: Response, error: unknown): void {
  console.error('[admin-auth] identity verification unavailable', {
    errorType: error instanceof Error ? error.name : 'UnknownError',
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({
    error: 'auth_provider_unavailable',
    message: '登录验证服务暂时不可用，请稍后重试。',
  });
}

/**
 * Resolve optional platform-admin authority for an HTTP response. `undefined`
 * means an authority outage has already been rendered as a fail-closed 503;
 * `null` remains an ordinary authenticated non-admin.
 */
export async function adminUserForHttp(
  req: Request,
  res: Response,
): Promise<AdminIdentity | null | undefined> {
  try {
    const locals = res.locals as Partial<Identity>;
    const verifiedIdentity = typeof locals.userId === 'string' && typeof locals.tenantId === 'string'
      && Boolean(locals.userId && locals.tenantId)
      ? { userId: locals.userId, tenantId: locals.tenantId, supportAccess: locals.supportAccess }
      : undefined;
    return await requireAdminUser(req, verifiedIdentity);
  } catch (error) {
    respondAdminIdentityUnavailable(res, error);
    return undefined;
  }
}

/** Express 4-safe internal-admin guard: its promise never escapes the middleware. */
export function requireInternalAdmin(req: Request, res: Response, next: NextFunction): void {
  void adminUserForHttp(req, res).then(admin => {
    if (admin === undefined) return;
    if (!admin) {
      res.status(403).json({ error: 'admin_required' });
      return;
    }
    res.locals.internalAdmin = admin;
    next();
  }, next);
}

export interface AccountUsageSummary {
  todayTokens: number;
  totalTokens: number;
  aiChat: number;
  generation: number;
  render: number;
  videoGeneration: number;
}

const EMPTY_ACCOUNT_USAGE: AccountUsageSummary = {
  todayTokens: 0,
  totalTokens: 0,
  aiChat: 0,
  generation: 0,
  render: 0,
  videoGeneration: 0,
};

export function demoUsageForTenant(tenantId?: string, userIds: string[] = []): AccountUsageSummary {
  if (!tenantId && !userIds.length) return { ...EMPTY_ACCOUNT_USAGE };
  const store = readJson<DemoUsageStore>(USAGE_FILE, {});
  const today = new Date().toISOString().slice(0, 10);
  const tenantDays = tenantId ? store[`tenant:${tenantId}`] ?? {} : {};
  const todayTenantUsage = tenantDays[today] ?? {};
  const tokenKeys = Array.from(new Set([
    ...userIds.filter(Boolean).map(userId => `user:${userId}`),
    ...(!userIds.length && tenantId ? [`tenant:${tenantId}`] : []),
  ]));
  let todayTokens = 0;
  let totalTokens = 0;
  for (const key of tokenKeys) {
    const days = store[key] ?? {};
    todayTokens += Number(days[today]?.tokens ?? 0);
    totalTokens += Object.values(days).reduce((sum, day) => sum + Number(day.tokens ?? 0), 0);
  }
  return {
    todayTokens,
    totalTokens,
    aiChat: Number(todayTenantUsage.aiChat ?? 0),
    generation: Number(todayTenantUsage.generation ?? 0),
    render: Number(todayTenantUsage.render ?? 0),
    videoGeneration: Number(todayTenantUsage.videoGeneration ?? 0),
  };
}
