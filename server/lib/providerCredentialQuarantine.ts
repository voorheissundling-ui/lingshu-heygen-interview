import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

interface CredentialRejection {
  fingerprint: string;
  rejectedAt: string;
}

interface CredentialQuarantineFile {
  schemaVersion: 1;
  rejected: CredentialRejection[];
}

function normalizedFile(value: unknown): CredentialQuarantineFile {
  const raw = value && typeof value === 'object' ? value as Partial<CredentialQuarantineFile> : {};
  const rejected = Array.isArray(raw.rejected) ? raw.rejected.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const fingerprint = String((item as CredentialRejection).fingerprint || '');
    const rejectedAt = String((item as CredentialRejection).rejectedAt || '');
    return /^[a-f0-9]{64}$/.test(fingerprint) && !Number.isNaN(Date.parse(rejectedAt))
      ? [{ fingerprint, rejectedAt }]
      : [];
  }) : [];
  return { schemaVersion: 1, rejected };
}

function readFile(filePath: string): CredentialQuarantineFile {
  try {
    return normalizedFile(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return { schemaVersion: 1, rejected: [] };
  }
}

function writeFile(filePath: string, value: CredentialQuarantineFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cache cleanup */ }
  }
}

export function credentialFingerprint(secret: unknown): string {
  const value = String(secret || '').trim();
  return value ? createHash('sha256').update(value).digest('hex') : '';
}

/**
 * Persists only one-way credential fingerprints. A process restart therefore
 * cannot retry a credential the provider has definitively rejected. Rotating
 * the key produces a new fingerprint and re-enables the provider immediately.
 */
export class DurableCredentialQuarantine {
  private readonly memory = new Set<string>();

  constructor(
    private readonly resolveFilePath: () => string,
    private readonly now: () => Date = () => new Date(),
    private readonly maximumEntries = 16,
  ) {}

  isRejected(fingerprint: string): boolean {
    if (!fingerprint) return false;
    if (this.memory.has(fingerprint)) return true;
    try {
      const rejected = readFile(this.resolveFilePath()).rejected.some(item => item.fingerprint === fingerprint);
      if (rejected) this.memory.add(fingerprint);
      return rejected;
    } catch {
      return false;
    }
  }

  remember(fingerprint: string): void {
    if (!fingerprint) return;
    this.memory.add(fingerprint);
    try {
      const filePath = this.resolveFilePath();
      const existing = readFile(filePath).rejected.filter(item => item.fingerprint !== fingerprint);
      const rejected = [...existing, { fingerprint, rejectedAt: this.now().toISOString() }]
        .sort((left, right) => right.rejectedAt.localeCompare(left.rejectedAt))
        .slice(0, Math.max(1, this.maximumEntries));
      writeFile(filePath, { schemaVersion: 1, rejected });
    } catch {
      // In-memory quarantine still prevents repeated attempts in this process.
    }
  }

  clear(fingerprint: string): void {
    if (!fingerprint) return;
    this.memory.delete(fingerprint);
    try {
      const filePath = this.resolveFilePath();
      const current = readFile(filePath);
      const rejected = current.rejected.filter(item => item.fingerprint !== fingerprint);
      if (rejected.length !== current.rejected.length) writeFile(filePath, { schemaVersion: 1, rejected });
    } catch {
      // A successful live provider request is authoritative for this process.
    }
  }
}
