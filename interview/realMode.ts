import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';

/**
 * Explicit live-provider mode.
 *
 * This module is deliberately independent from interview/bootstrap.mjs:
 * bootstrap blocks every non-local host and removes provider secrets. Real
 * mode instead loads one key from a file outside the repository, injects it as
 * HEYGEN_API_KEY, and installs a narrow network allowlist. Nothing here prints
 * the key. The offline `pnpm run dev` entry point is unchanged.
 */
export const REAL_PROVIDER_HOST = 'api.heygen.com';
export const REAL_PROVIDER_PATH_PREFIX = '/v3/';
export const REAL_KEY_FILE_ENV = 'HEYGEN_KEY_FILE';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SECRET_ENV = /(?:TOKEN|SECRET|PASSWORD|ACCESS_KEY|API_KEY|ADMIN_EMAIL|DATABASE_URL|REDIS_URL|^S3_|^AWS_|^OSS_)/;
const PRESERVED_ENV = new Set([REAL_KEY_FILE_ENV]);
const PROVIDER_MEDIA_SUFFIXES = [
  'heygen.com',
  'heygen.ai',
  'amazonaws.com',
  'cloudfront.net',
  'storage.googleapis.com',
  'blob.core.windows.net',
];

export interface LoadedRealKey {
  key: string;
  credentialHash: string;
  keyFile: string;
}

export interface PublicPresenterEvidence {
  ownership: 'public';
  publicCatalogRef: string;
  providerTermsRef: string;
  verifiedAt: string;
  accountId: string;
}

type ReadTextFile = (file: string, encoding: 'utf8') => Promise<string>;

const defaultReadFile: ReadTextFile = (file, encoding) => fs.readFile(file, encoding);

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').split(':')[0] ?? '';
}

function hostIsLocal(host: string): boolean {
  return LOCAL_HOSTS.has(normalizeHost(host));
}

/**
 * Removes inherited credentials before the real key is loaded. Only the key
 * file location is retained. Returned names are safe to log; values never are.
 */
export function sanitizeRealEnvironment(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (PRESERVED_ENV.has(name)) continue;
    if (SECRET_ENV.test(name)) {
      delete env[name];
      removed.push(name);
    }
  }
  for (const name of ['INTERVIEW_REAL_MODE', 'INTERVIEW_CREDENTIAL_SHA256']) {
    if (name in env) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Reads a single-line provider key from HEYGEN_KEY_FILE. The file must be
 * outside the repository; missing/unreadable/invalid files fail with fixed
 * error codes that cannot contain the key or the file contents.
 */
export async function loadRealProviderKey(
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadTextFile = defaultReadFile,
): Promise<LoadedRealKey> {
  const configured = String(env[REAL_KEY_FILE_ENV] ?? '').trim();
  if (!configured) throw new Error('real_mode_key_file_missing');
  const keyFile = path.resolve(configured);
  const relative = path.relative(path.resolve(process.cwd()), keyFile);
  const insideRepo = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (insideRepo) throw new Error('real_mode_key_file_must_be_outside_repo');

  let raw: string;
  try {
    raw = await readFile(keyFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') throw new Error('real_mode_key_file_not_found');
    throw new Error('real_mode_key_file_unreadable');
  }
  const key = raw.trim();
  if (!key) throw new Error('real_mode_key_empty');
  if (/\s/.test(key)) throw new Error('real_mode_key_must_be_a_single_token');
  if (key.length < 16 || key.length > 512) throw new Error('real_mode_key_length_invalid');
  return {
    key,
    credentialHash: createHash('sha256').update(key).digest('hex'),
    keyFile,
  };
}

/** Injects the file-loaded key and records only its SHA-256 fingerprint. */
export function applyRealProviderKey(env: NodeJS.ProcessEnv, loaded: LoadedRealKey): void {
  env.HEYGEN_API_KEY = loaded.key;
  env.INTERVIEW_REAL_MODE = '1';
  env.INTERVIEW_CREDENTIAL_SHA256 = loaded.credentialHash;
}

function secureUrl(input: string | URL): URL | null {
  try {
    const url = input instanceof URL ? new URL(input.href) : new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.port && url.port !== '443') return null;
    return url;
  } catch {
    return null;
  }
}

/** Only the v3 API base is admitted for authenticated provider calls. */
export function isAllowedRealProviderUrl(input: string | URL): boolean {
  const url = secureUrl(input);
  return Boolean(url
    && url.hostname.toLowerCase() === REAL_PROVIDER_HOST
    && url.pathname.startsWith(REAL_PROVIDER_PATH_PREFIX));
}

/**
 * Validates a media URL returned by the authenticated provider. Signed media
 * may live on a provider-owned or cloud-storage host; the host must still be
 * HTTPS, credential-free, on the default port and under a known suffix.
 */
export function validateProviderDownloadUrl(input: string | URL): string | null {
  const url = secureUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const allowed = PROVIDER_MEDIA_SUFFIXES.some(suffix => host === suffix || host.endsWith('.' + suffix));
  return allowed ? url.href : null;
}

/**
 * Download hosts are not trusted just because a URL exists. A caller must
 * register a provider-returned, validated HTTPS URL; only then does the real
 * network guard permit that host.
 */
export class ProviderDownloadAllowlist {
  private readonly hosts = new Set<string>();

  register(input: string | URL): string | null {
    const valid = validateProviderDownloadUrl(input);
    if (!valid) return null;
    const host = new URL(valid).hostname.toLowerCase();
    this.hosts.add(host);
    return host;
  }

  allows(input: string | URL): boolean {
    const url = secureUrl(input);
    return Boolean(url && this.hosts.has(url.hostname.toLowerCase()));
  }

  hostsSnapshot(): string[] {
    return [...this.hosts].sort();
  }
}

export function isAllowedRealNetworkTarget(
  input: string | URL | {url?: string},
  allowlist: ProviderDownloadAllowlist,
): boolean {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input && typeof input === 'object' && typeof input.url === 'string') raw = input.url;
  else return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (hostIsLocal(url.hostname)) return url.protocol === 'http:' || url.protocol === 'https:';
  return isAllowedRealProviderUrl(url) || allowlist.allows(url);
}

function requestTarget(input: unknown): string | null {
  if (typeof input === 'string' || input instanceof URL) {
    const raw = String(input);
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).href;
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const protocol = String(value.protocol || 'https:');
  const host = String(value.hostname || value.host || '').trim();
  if (!host) return null;
  const port = value.port ? `:${String(value.port)}` : '';
  const requestPath = String(value.path || '/');
  try {
    return new URL(`${protocol}//${host}${port}${requestPath}`).href;
  } catch {
    return null;
  }
}

function socketHost(args: unknown[]): string | null {
  const first = args[0];
  if (first && typeof first === 'object') {
    const value = first as Record<string, unknown>;
    return String(value.host ?? 'localhost');
  }
  if (typeof args[1] === 'string') return args[1];
  return null;
}

export interface RealNetworkGuard {
  dispose(): void;
}

/**
 * Replaces fetch/http(s)/net entry points with a fail-closed allowlist. API
 * calls may target only https://api.heygen.com/v3/; localhost remains available
 * for the interview UI, and media hosts must be registered explicitly.
 */
export function installRealNetworkGuard(options: {
  allowlist: ProviderDownloadAllowlist;
  fetchImpl?: typeof fetch;
  syncExports?: boolean;
}): RealNetworkGuard {
  const {allowlist} = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const blocked = () => new Error('interview_real_network_blocked');
  const originalFetch = globalThis.fetch;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;
  const originalConnect = net.Socket.prototype.connect;

  globalThis.fetch = ((input: any, init?: any) => {
    if (!isAllowedRealNetworkTarget(input, allowlist)) return Promise.reject(blocked());
    return fetchImpl(input, init);
  }) as typeof fetch;

  const wrap = (original: (...args: any[]) => any) => function(this: any, ...args: any[]) {
    const target = requestTarget(args[0]);
    if (!target || !isAllowedRealNetworkTarget(target, allowlist)) throw blocked();
    return original.apply(this, args);
  };
  (http as any).request = wrap(originalHttpRequest);
  (http as any).get = wrap(originalHttpGet);
  (https as any).request = wrap(originalHttpsRequest);
  (https as any).get = wrap(originalHttpsGet);

  net.Socket.prototype.connect = function(this: any, ...args: any[]) {
    const host = socketHost(args);
    if (host && !hostIsLocal(host)
      && normalizeHost(host) !== REAL_PROVIDER_HOST
      && !allowlist.hostsSnapshot().includes(normalizeHost(host))) throw blocked();
    return originalConnect.apply(this, args as any);
  } as typeof originalConnect;

  if (options.syncExports !== false) syncBuiltinESMExports();

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      globalThis.fetch = originalFetch;
      (http as any).request = originalHttpRequest;
      (http as any).get = originalHttpGet;
      (https as any).request = originalHttpsRequest;
      (https as any).get = originalHttpsGet;
      net.Socket.prototype.connect = originalConnect;
      if (options.syncExports !== false) syncBuiltinESMExports();
    },
  };
}

let activeRuntime: {allowlist: ProviderDownloadAllowlist; guard: RealNetworkGuard} | null = null;

/** Installs the process-wide real-mode guard and exposes the download allowlist. */
export function installRealModeRuntime(allowlist = new ProviderDownloadAllowlist()): RealNetworkGuard {
  activeRuntime?.guard.dispose();
  const guard = installRealNetworkGuard({allowlist});
  activeRuntime = {allowlist, guard};
  return guard;
}

/** Provider download code must register validated URLs here; null means offline mode. */
export function activeProviderDownloadAllowlist(): ProviderDownloadAllowlist | null {
  return activeRuntime?.allowlist ?? null;
}
