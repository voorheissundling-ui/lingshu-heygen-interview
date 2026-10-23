import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { store } from '../storage/index.js';

const PRODUCT_API_KEY_PREFIX = 'ls_prod';
const PRODUCT_API_KEY_ID_BYTES = 12;
const PRODUCT_API_KEY_SECRET_BYTES = 32;
const PRODUCT_API_KEY_ID_LENGTH = 16;
const PRODUCT_API_KEY_SECRET_LENGTH = 43;
const PRODUCT_API_KEY_DIGEST_VERSION = 'hmac-sha256-v1';
const PRODUCT_API_KEY_PATTERN = new RegExp(
  `^${PRODUCT_API_KEY_PREFIX}_([A-Za-z0-9_-]{${PRODUCT_API_KEY_ID_LENGTH}})_([A-Za-z0-9_-]{${PRODUCT_API_KEY_SECRET_LENGTH}})$`,
);

export class ProductApiCredentialConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductApiCredentialConfigurationError';
  }
}

export interface ProductApiCredential {
  tenantId: string;
  keyId: string;
  keyPrefix: string;
  keyLast4: string;
  createdAt: string;
  lastIngestedAt?: string;
  lastProductName?: string;
  active: boolean;
  requiresRotation: boolean;
}

export interface IssuedProductApiSecret extends ProductApiCredential {
  /** Returned by create/rotate only. It is never reconstructed from storage. */
  apiKey: string;
}

type StoredCredentialState = 'active' | 'requires_rotation' | 'invalid';
type StoredProductApiCredential = ProductApiCredential & {
  recordId: string;
  digest: string;
  digestVersion: string;
  state: StoredCredentialState;
};

export type CreateProductApiCredentialResult =
  | { kind: 'created'; secret: IssuedProductApiSecret }
  | { kind: 'exists'; credential: ProductApiCredential }
  | { kind: 'unavailable' };

export type RotateProductApiCredentialResult =
  | { kind: 'rotated'; secret: IssuedProductApiSecret }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

const tenantMutationQueues = new Map<string, Promise<void>>();

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function configuredPepper(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const value = text(environment.PRODUCT_API_KEY_PEPPER);
  if (!value) {
    throw new ProductApiCredentialConfigurationError('PRODUCT_API_KEY_PEPPER is required');
  }
  if (Buffer.byteLength(value, 'utf8') < 32) {
    throw new ProductApiCredentialConfigurationError('PRODUCT_API_KEY_PEPPER must contain at least 32 bytes');
  }
  if (environment.NODE_ENV === 'production' && /^(?:change-me|generate[-_])/i.test(value)) {
    throw new ProductApiCredentialConfigurationError('PRODUCT_API_KEY_PEPPER must not use an example placeholder');
  }
  return Buffer.from(value, 'utf8');
}

/** Production imports this module during HTTP route registration, so a bad deployment stops at startup. */
export function assertProductApiCredentialEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  configuredPepper(environment);
}

if (process.env.NODE_ENV === 'production') {
  assertProductApiCredentialEnvironment();
}

function keyPrefix(keyId: string): string {
  return `${PRODUCT_API_KEY_PREFIX}_${keyId}`;
}

function productApiKeyDigest(
  tenantId: string,
  keyId: string,
  apiKey: string,
  pepper: Buffer = configuredPepper(),
): Buffer {
  return createHmac('sha256', pepper)
    .update('lingshu-product-api-key\0', 'utf8')
    .update(tenantId, 'utf8')
    .update('\0', 'utf8')
    .update(keyId, 'utf8')
    .update('\0', 'utf8')
    .update(apiKey, 'utf8')
    .digest();
}

function constantTimeDigestMatches(storedHex: string, candidate: Buffer): boolean {
  const validEncoding = /^[a-f0-9]{64}$/.test(storedHex);
  const stored = validEncoding ? Buffer.from(storedHex, 'hex') : Buffer.alloc(candidate.length);
  const equal = stored.length === candidate.length && timingSafeEqual(stored, candidate);
  return validEncoding && equal;
}

function storedProductApiCredential(
  record: Record<string, unknown> | undefined,
  expectedTenantId?: string,
): StoredProductApiCredential | null {
  if (!record?.id) return null;
  const tenantId = text(record.tenant_id);
  if (!tenantId || (expectedTenantId && tenantId !== expectedTenantId)) return null;

  const recordId = text(record.id);
  const storedKeyId = text(record.key_id);
  const storedKeyPrefix = text(record.key_prefix);
  const storedDigest = text(record.key_hmac);
  const digestVersion = text(record.key_hmac_version);
  const keyLast4 = text(record.key_last4);
  const credentialStatus = text(record.credential_status);
  const hasNoHashedCredential = !storedKeyId && !storedKeyPrefix && !storedDigest && !digestVersion;
  const explicitlyRequiresRotation = credentialStatus === 'requires_rotation' && hasNoHashedCredential;
  const preMigrationLegacyRecord = !credentialStatus && hasNoHashedCredential;
  const activeFieldsAreValid = credentialStatus === 'active'
    && /^[A-Za-z0-9_-]{16}$/.test(storedKeyId)
    && storedKeyPrefix === keyPrefix(storedKeyId)
    && /^[A-Za-z0-9_-]{4}$/.test(keyLast4)
    && digestVersion === PRODUCT_API_KEY_DIGEST_VERSION
    && /^[a-f0-9]{64}$/.test(storedDigest);
  const state: StoredCredentialState = activeFieldsAreValid
    ? 'active'
    : explicitlyRequiresRotation || preMigrationLegacyRecord
      ? 'requires_rotation'
      : 'invalid';

  return {
    recordId,
    tenantId,
    keyId: state === 'active' ? storedKeyId : '',
    keyPrefix: state === 'active' ? storedKeyPrefix : '',
    keyLast4: state === 'active' ? keyLast4 : '',
    digest: state === 'active' ? storedDigest : '',
    digestVersion: state === 'active' ? digestVersion : '',
    createdAt: text(record.created_at),
    lastIngestedAt: text(record.last_ingested_at),
    lastProductName: text(record.last_product_name),
    active: state === 'active',
    requiresRotation: state === 'requires_rotation',
    state,
  };
}

function publicCredential(credential: StoredProductApiCredential): ProductApiCredential {
  const {
    recordId: _recordId,
    digest: _digest,
    digestVersion: _digestVersion,
    state: _state,
    ...metadata
  } = credential;
  return metadata;
}

async function storedCredentialsForTenant(tenantId: string): Promise<StoredProductApiCredential[]> {
  const result = await store.list<Record<string, unknown>>('tenant_api_keys', {
    where: { tenant_id: tenantId },
    page: 1,
    perPage: 2,
  });
  if (result.items.some(record => !record?.id || text(record.tenant_id) !== tenantId)) {
    throw new Error('tenant_api_key_integrity_violation');
  }
  return result.items
    .map(record => storedProductApiCredential(record, tenantId))
    .filter((item): item is StoredProductApiCredential => Boolean(item));
}

async function serializeTenantMutation<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
  const previous = tenantMutationQueues.get(tenantId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  tenantMutationQueues.set(tenantId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tenantMutationQueues.get(tenantId) === queued) tenantMutationQueues.delete(tenantId);
  }
}

function generateProductApiSecret(
  tenantId: string,
  previous?: ProductApiCredential,
): { secret: IssuedProductApiSecret; persisted: Record<string, unknown> } {
  const generatedKeyId = randomBytes(PRODUCT_API_KEY_ID_BYTES).toString('base64url');
  const generatedSecret = randomBytes(PRODUCT_API_KEY_SECRET_BYTES).toString('base64url');
  const apiKey = `${keyPrefix(generatedKeyId)}_${generatedSecret}`;
  const createdAt = new Date().toISOString();
  const secret: IssuedProductApiSecret = {
    tenantId,
    keyId: generatedKeyId,
    keyPrefix: keyPrefix(generatedKeyId),
    keyLast4: apiKey.slice(-4),
    apiKey,
    createdAt,
    lastIngestedAt: previous?.lastIngestedAt,
    lastProductName: previous?.lastProductName,
    active: true,
    requiresRotation: false,
  };
  return {
    secret,
    persisted: {
      tenant_id: tenantId,
      key_id: secret.keyId,
      key_prefix: secret.keyPrefix,
      key_last4: secret.keyLast4,
      key_hmac: productApiKeyDigest(tenantId, secret.keyId, apiKey).toString('hex'),
      key_hmac_version: PRODUCT_API_KEY_DIGEST_VERSION,
      credential_status: 'active',
      created_at: createdAt,
      last_ingested_at: secret.lastIngestedAt || '',
      last_product_name: secret.lastProductName || '',
    },
  };
}

export async function productApiSecretForTenant(tenantId: string): Promise<ProductApiCredential | null> {
  const credentials = await storedCredentialsForTenant(tenantId);
  if (credentials.length > 1 || credentials.some(credential => credential.state === 'invalid')) {
    throw new Error('tenant_api_key_integrity_violation');
  }
  return credentials[0] ? publicCredential(credentials[0]) : null;
}

export async function productApiSecretForKey(apiKey: string): Promise<ProductApiCredential | null> {
  const parsed = PRODUCT_API_KEY_PATTERN.exec(apiKey);
  if (!parsed) return null;
  const [, providedKeyId] = parsed;
  const result = await store.list<Record<string, unknown>>('tenant_api_keys', {
    where: { key_id: providedKeyId },
    page: 1,
    perPage: 2,
  });
  if (result.items.length !== 1) return null;
  const match = storedProductApiCredential(result.items[0]);
  if (!match || match.state !== 'active' || match.keyId !== providedKeyId) return null;

  const candidate = productApiKeyDigest(match.tenantId, providedKeyId, apiKey);
  if (!constantTimeDigestMatches(match.digest, candidate) || match.keyLast4 !== apiKey.slice(-4)) return null;

  const tenantCredentials = await storedCredentialsForTenant(match.tenantId);
  return tenantCredentials.length === 1
    && tenantCredentials[0].recordId === match.recordId
    && tenantCredentials[0].state === 'active'
    ? publicCredential(match)
    : null;
}

export async function createProductApiCredential(tenantId: string): Promise<CreateProductApiCredentialResult> {
  return serializeTenantMutation(tenantId, async () => {
    const current = await storedCredentialsForTenant(tenantId);
    if (current.length > 1 || current.some(credential => credential.state === 'invalid')) {
      return { kind: 'unavailable' };
    }
    if (current[0]) return { kind: 'exists', credential: publicCredential(current[0]) };

    const next = generateProductApiSecret(tenantId);
    const created = await store.create('tenant_api_keys', next.persisted);
    return created ? { kind: 'created', secret: next.secret } : { kind: 'unavailable' };
  });
}

export async function rotateProductApiCredential(tenantId: string): Promise<RotateProductApiCredentialResult> {
  return serializeTenantMutation(tenantId, async () => {
    const current = await storedCredentialsForTenant(tenantId);
    if (current.length > 1 || current.some(credential => credential.state === 'invalid')) {
      return { kind: 'unavailable' };
    }
    if (!current[0]) return { kind: 'missing' };

    const next = generateProductApiSecret(tenantId, publicCredential(current[0]));
    const updated = await store.update('tenant_api_keys', current[0].recordId, next.persisted);
    return updated ? { kind: 'rotated', secret: next.secret } : { kind: 'unavailable' };
  });
}
