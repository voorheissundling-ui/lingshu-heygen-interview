import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { OrganizationRole } from './organizationRole.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface LocalStoredAccount {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  accountType: 'customer' | 'trial' | 'admin';
  role?: OrganizationRole;
  salt: string;
  passwordHash: string;
  createdAt: string;
}

export class LocalAccountStoreError extends Error {
  readonly code = 'local_account_store_unavailable';

  constructor(readonly operation: 'read' | 'write', options?: { cause?: unknown }) {
    super('Local authentication account storage is unavailable', options);
    this.name = 'LocalAccountStoreError';
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isStoredAccount(value: unknown): value is LocalStoredAccount {
  if (!value || typeof value !== 'object') return false;
  const account = value as Record<string, unknown>;
  return ['customer', 'trial', 'admin'].includes(String(account.accountType))
    && ['userId', 'tenantId', 'email', 'name', 'salt', 'passwordHash', 'createdAt']
      .every(key => typeof account[key] === 'string' && String(account[key]).length > 0)
    && (account.role === undefined || ['super_admin', 'admin', 'social_operator', 'customer_service'].includes(String(account.role)));
}

export function localAccountRecordsFile(): string {
  const configuredPreviewStore = process.env.NODE_ENV !== 'production'
    && process.env.LINGSHU_LOCAL_PREVIEW === '1';
  return (process.env.NODE_ENV === 'test' || configuredPreviewStore) && process.env.LOCAL_AUTH_ACCOUNTS_FILE
    ? path.resolve(process.env.LOCAL_AUTH_ACCOUNTS_FILE)
    : path.join(__dirname, '../../data/local-auth-accounts.json');
}

/** Missing storage means an empty development registry; every other failure is fail-closed. */
export function readLocalAccountRecords(file: string): LocalStoredAccount[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw new LocalAccountStoreError('read', { cause: error });
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isStoredAccount)) {
      throw new Error('registry schema is invalid');
    }
    return parsed;
  } catch (error) {
    throw new LocalAccountStoreError('read', { cause: error });
  }
}

/** Same-directory temp + rename prevents partial JSON and always narrows permissions. */
export function writeLocalAccountRecords(file: string, accounts: LocalStoredAccount[]): void {
  const contents = JSON.stringify(accounts, null, 2);
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryFile, file);
    try { fs.chmodSync(file, 0o600); } catch { /* Some platforms ignore POSIX modes. */ }
  } catch (error) {
    throw new LocalAccountStoreError('write', { cause: error });
  } finally {
    if (descriptor !== null) try { fs.closeSync(descriptor); } catch { /* Preserve the original write failure. */ }
    try { fs.unlinkSync(temporaryFile); } catch { /* Rename succeeded or no temp file exists. */ }
  }
}

export function isLocalAccountStoreError(error: unknown): error is LocalAccountStoreError {
  return error instanceof LocalAccountStoreError;
}
