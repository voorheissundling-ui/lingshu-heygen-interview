import path from 'node:path';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent } from 'undici';
import { normalizeTenantMedia, type NormalizedTenantMedia } from './tenantMediaNormalization.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

type Address = { address: string; family: number };
type Resolve = (hostname: string) => Promise<Address[]>;
type Fetcher = (url: string, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>;

export class ExternalImageImportError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function isPublicInternetAddress(address: string): boolean {
  const value = address.toLowerCase().split('%', 1)[0];
  if (isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && (b === 0 || b === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0) || a >= 224);
  }
  if (isIP(value) === 6) {
    return !(value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:')
      || value.startsWith('::ffff:'));
  }
  return false;
}

function validatedUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ExternalImageImportError('INVALID_URL', '请输入有效的 HTTPS 图片地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(url.hostname)) {
    throw new ExternalImageImportError('UNSAFE_URL', '图片地址必须是无账号信息的公网 HTTPS 域名');
  }
  return url;
}

async function resolvedPublicAddresses(hostname: string, resolve: Resolve): Promise<Address[]> {
  const addresses = await resolve(hostname).catch(() => []);
  if (!addresses.length || addresses.some(item => !isPublicInternetAddress(item.address))) {
    throw new ExternalImageImportError('UNSAFE_ADDRESS', '图片域名不能解析到本地或私有网络');
  }
  return addresses;
}

function pinnedDispatcher(addresses: Address[]): Agent {
  let cursor = 0;
  return new Agent({ connect: { lookup: (_hostname, _options, callback) => {
    const selected = addresses[cursor++ % addresses.length]!;
    callback(null, selected.address, selected.family);
  } } });
}

async function boundedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new ExternalImageImportError('TOO_LARGE', '图片不能超过 10 MB');
  if (!response.body) throw new ExternalImageImportError('EMPTY_BODY', '图片响应为空');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); throw new ExternalImageImportError('TOO_LARGE', '图片不能超过 10 MB'); }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new ExternalImageImportError('EMPTY_BODY', '图片响应为空');
  return Buffer.concat(chunks, total);
}

export async function downloadAndNormalizeExternalImage(input: {
  url: string;
  temporaryDirectory: string;
  resolve?: Resolve;
  fetcher?: Fetcher;
}): Promise<NormalizedTenantMedia & { sourceUrl: string }> {
  const resolve: Resolve = input.resolve || (hostname => dnsLookup(hostname, { all: true }) as Promise<Address[]>);
  const fetcher: Fetcher = input.fetcher || ((url, init) => fetch(url, init));
  let current = validatedUrl(String(input.url || '').trim());
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const addresses = await resolvedPublicAddresses(current.hostname, resolve);
    const dispatcher = input.fetcher ? undefined : pinnedDispatcher(addresses);
    let response: Response;
    try {
      response = await fetcher(current.toString(), {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif' }, ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      await dispatcher?.close();
      throw new ExternalImageImportError('DOWNLOAD_FAILED', error instanceof Error ? error.message : '图片下载失败');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await dispatcher?.close();
      if (redirect === MAX_REDIRECTS) throw new ExternalImageImportError('TOO_MANY_REDIRECTS', '图片地址重定向次数过多');
      const location = response.headers.get('location');
      if (!location) throw new ExternalImageImportError('INVALID_REDIRECT', '图片重定向缺少目标地址');
      current = validatedUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) { await dispatcher?.close(); throw new ExternalImageImportError('DOWNLOAD_FAILED', `图片下载失败（${response.status}）`); }
    const mimeType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!IMAGE_MIMES.has(mimeType)) { await dispatcher?.close(); throw new ExternalImageImportError('INVALID_MIME', '外链返回的内容不是支持的图片格式'); }
    let buffer: Buffer;
    try { buffer = await boundedBody(response); }
    finally { await dispatcher?.close(); }
    const originalName = path.basename(decodeURIComponent(current.pathname)) || 'product-image';
    const normalized = await normalizeTenantMedia({ buffer, originalName, declaredMimeType: mimeType, kind: 'image', temporaryDirectory: input.temporaryDirectory })
      .catch(error => { throw new ExternalImageImportError('INVALID_IMAGE', error instanceof Error ? error.message : '图片无法解码'); });
    return { ...normalized, sourceUrl: current.toString() };
  }
  throw new ExternalImageImportError('DOWNLOAD_FAILED', '图片下载失败');
}
