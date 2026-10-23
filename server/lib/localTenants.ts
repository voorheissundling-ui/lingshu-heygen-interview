import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configuredPreviewStore = process.env.NODE_ENV !== 'production'
  && process.env.LINGSHU_LOCAL_PREVIEW === '1';
const LOCAL_TENANTS_FILE = (process.env.NODE_ENV === 'test' || configuredPreviewStore) && process.env.LOCAL_TENANTS_DATA_FILE
  ? path.resolve(process.env.LOCAL_TENANTS_DATA_FILE)
  : path.join(__dirname, '../../data/local-auth-tenants.json');

export interface LocalTenantRecord {
  id: string;
  name: string;
  companyName: string;
  contactName: string;
  contact: string;
  industry: string;
  notes: string;
  inviteCode: string;
  subscriptionStatus: string;
  subscriptionPlan: string;
  subscriptionExpiresAt: string | null;
  createdAt: string;
  registeredAt?: string;
  registeredEmail?: string;
  registrationInviteCode?: string;
  [key: string]: unknown;
}

type LegacyLocalTenantRecord = LocalTenantRecord & { registeredPasswordCipher?: unknown };

/** Drop the legacy recoverable credential from every in-memory/runtime view. */
export function sanitizeLocalTenantRecord(record: LegacyLocalTenantRecord): LocalTenantRecord {
  const { registeredPasswordCipher: _discarded, ...safeRecord } = record;
  return safeRecord;
}

function readStoredLocalTenants(): LegacyLocalTenantRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_TENANTS_FILE, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('registry root must be an array');
    }
    return parsed as LegacyLocalTenantRecord[];
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new Error(`Cannot read local tenant registry ${LOCAL_TENANTS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readLocalTenants(): LocalTenantRecord[] {
  return readStoredLocalTenants().map(record => sanitizeLocalTenantRecord(record));
}

function writeStoredLocalTenants(tenants: LegacyLocalTenantRecord[]): void {
  fs.mkdirSync(path.dirname(LOCAL_TENANTS_FILE), { recursive: true });
  const contents = JSON.stringify(tenants, null, 2);
  try {
    if (fs.readFileSync(LOCAL_TENANTS_FILE, 'utf8') === contents) return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const temporaryFile = `${LOCAL_TENANTS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, LOCAL_TENANTS_FILE);
    try { fs.chmodSync(LOCAL_TENANTS_FILE, 0o600); } catch { /* Some platforms ignore POSIX modes. */ }
  } finally {
    try { fs.unlinkSync(temporaryFile); } catch { /* Rename succeeded or the temporary file was never created. */ }
  }
}

/**
 * Business metadata writes must not silently perform the credential migration.
 * Preserve any historical field until an operator applies the gated migration,
 * or a verified login explicitly clears that account's exact record.
 */
function writeLocalTenants(tenants: LocalTenantRecord[]): void {
  const storedById = new Map(readStoredLocalTenants().map(record => [record.id, record]));
  const merged = tenants.map(tenant => {
    const safeTenant = sanitizeLocalTenantRecord(tenant);
    const stored = storedById.get(safeTenant.id);
    return stored && Object.hasOwn(stored, 'registeredPasswordCipher')
      ? { ...stored, ...safeTenant, registeredPasswordCipher: stored.registeredPasswordCipher }
      : { ...stored, ...safeTenant };
  });
  writeStoredLocalTenants(merged);
}

export function listLocalTenants(): LocalTenantRecord[] {
  return readLocalTenants();
}

export function getLocalTenant(tenantId: string): LocalTenantRecord | null {
  return readLocalTenants().find(tenant => tenant.id === tenantId) ?? null;
}

export function createLocalDataTenant(data: Record<string, unknown>): LocalTenantRecord {
  const companyName = String(data.companyName || data.name || '').trim();
  const contactName = String(data.contactName || data.contact || '').trim();
  const now = new Date().toISOString();
  const tenant = sanitizeLocalTenantRecord({
    ...data,
    id: String(data.id || `local_tenant_customer_${randomUUID().replaceAll('-', '')}`),
    name: String(data.name || companyName),
    companyName,
    contactName,
    contact: String(data.contact || contactName),
    industry: String(data.industry || ''),
    notes: String(data.notes || ''),
    inviteCode: String(data.inviteCode || ''),
    subscriptionStatus: String(data.subscriptionStatus || 'pending_delivery'),
    subscriptionPlan: String(data.subscriptionPlan || 'delivery'),
    subscriptionExpiresAt: typeof data.subscriptionExpiresAt === 'string' ? data.subscriptionExpiresAt : null,
    createdAt: String(data.createdAt || data.created || now),
  } as LegacyLocalTenantRecord);
  writeLocalTenants([tenant, ...readLocalTenants().filter(item => item.id !== tenant.id)]);
  return tenant;
}

export function updateLocalDataTenant(tenantId: string, data: Record<string, unknown>): boolean {
  const tenants = readLocalTenants();
  const index = tenants.findIndex(tenant => tenant.id === tenantId);
  if (index < 0) return false;
  tenants[index] = sanitizeLocalTenantRecord({
    ...tenants[index],
    ...data,
    id: tenantId,
  } as LegacyLocalTenantRecord);
  writeLocalTenants(tenants);
  return true;
}

export function clearLocalTenantRegisteredCredential(tenantId: string, email: string): boolean {
  const tenants = readStoredLocalTenants();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const index = tenants.findIndex(tenant => (
    tenant.id === tenantId
    && String(tenant.registeredEmail || '').trim().toLowerCase() === normalizedEmail
  ));
  if (index < 0) return false;
  if (!Object.hasOwn(tenants[index], 'registeredPasswordCipher')) return true;
  tenants[index] = sanitizeLocalTenantRecord(tenants[index]);
  writeStoredLocalTenants(tenants);
  return true;
}

export function findLocalTenantByInvite(inviteCode: string): LocalTenantRecord | null {
  const code = String(inviteCode || '').trim();
  if (!code) return null;
  return readLocalTenants().find(tenant => {
    const status = String(tenant.subscriptionStatus || '').trim().toLowerCase();
    return tenant.inviteCode === code
      && !tenant.registeredAt
      && status !== 'provisioning_pending'
      && status !== 'provisioning_failed';
  }) ?? null;
}

export function findLocalTenantByRegistrationInvite(inviteCode: string): LocalTenantRecord | null {
  const code = String(inviteCode || '').trim();
  if (!code) return null;
  return readLocalTenants().find(tenant => tenant.registrationInviteCode === code) ?? null;
}

export function createLocalInviteTenant(input: {
  companyName: string;
  contactName?: string;
  industry?: string;
  notes?: string;
  inviteCode: string;
}): LocalTenantRecord {
  return createLocalDataTenant(input);
}

export function deleteLocalInviteTenant(tenantId: string): boolean {
  const tenants = readLocalTenants();
  const next = tenants.filter(tenant => tenant.id !== tenantId);
  if (next.length === tenants.length) return false;
  writeLocalTenants(next);
  return true;
}

export function ensureLocalIdentityTenant(input: {
  tenantId: string;
  name: string;
  accountType: 'trial' | 'admin' | 'customer';
  email: string;
  expiresAt?: string | null;
}): LocalTenantRecord {
  const current = getLocalTenant(input.tenantId);
  if (current) return current;
  const now = new Date().toISOString();
  return createLocalDataTenant({
    id: input.tenantId,
    name: input.name,
    companyName: input.name,
    inviteCode: '',
    subscriptionStatus: input.accountType === 'trial' ? 'trialing' : 'active',
    subscriptionPlan: input.accountType,
    subscriptionExpiresAt: input.expiresAt ?? null,
    createdAt: now,
    registeredAt: now,
    registeredEmail: input.email,
  });
}

export function promoteLocalTrialTenant(input: {
  tenantId: string;
  companyName: string;
  contactName?: string;
  industry?: string;
  email: string;
  registeredAt?: string;
}): LocalTenantRecord {
  const tenants = readLocalTenants();
  const index = tenants.findIndex(tenant => tenant.id === input.tenantId);
  const existing = index >= 0 ? tenants[index] : null;
  const now = new Date().toISOString();
  const next: LocalTenantRecord = {
    id: input.tenantId,
    name: input.companyName || existing?.name || input.email.split('@')[0],
    companyName: input.companyName || existing?.companyName || input.email.split('@')[0],
    contactName: input.contactName ?? existing?.contactName ?? '',
    contact: input.contactName ?? existing?.contact ?? '',
    industry: input.industry ?? existing?.industry ?? '',
    notes: existing?.notes ?? '',
    inviteCode: '',
    subscriptionStatus: 'active',
    subscriptionPlan: 'customer',
    subscriptionExpiresAt: null,
    createdAt: existing?.createdAt ?? input.registeredAt ?? now,
    registeredAt: existing?.registeredAt ?? input.registeredAt ?? now,
    registeredEmail: input.email.trim().toLowerCase(),
    registrationInviteCode: existing?.registrationInviteCode ?? '',
  };
  if (index >= 0) tenants[index] = next;
  else tenants.unshift(next);
  writeLocalTenants(tenants);
  return next;
}

export function activateLocalTenantInvite(input: {
  inviteCode: string;
  email: string;
}): LocalTenantRecord | null {
  const tenants = readLocalTenants();
  const index = tenants.findIndex(tenant => tenant.inviteCode === input.inviteCode && !tenant.registeredAt);
  if (index < 0) return null;
  const current = tenants[index];
  tenants[index] = {
    ...current,
    inviteCode: '',
    registrationInviteCode: current.inviteCode,
    subscriptionStatus: 'active',
    subscriptionPlan: 'customer',
    subscriptionExpiresAt: null,
    registeredAt: new Date().toISOString(),
    registeredEmail: String(input.email || '').trim().toLowerCase(),
  };
  writeLocalTenants(tenants);
  return tenants[index];
}
