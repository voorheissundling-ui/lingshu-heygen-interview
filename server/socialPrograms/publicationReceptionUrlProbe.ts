import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { isPublicInternetAddress } from '../lib/externalProductImageImport.js';

type Address = { address: string; family: number };
interface ProbeResponse { status: number; location?: string; contentLength?: string; body: AsyncIterable<Uint8Array>; close(): void }
export interface ReceptionUrlProbeDependencies {
  resolve?: (hostname: string) => Promise<Address[]>;
  transport?: (url: URL, pinned: Address, signal: AbortSignal) => Promise<ProbeResponse>;
  timeoutMs?: number;
  maxBytes?: number;
}
export interface ReceptionHttpObservation {
  checkedAt: string;
  visits: Array<{ url: string; address: string; status: number }>;
  bytes: number;
}

function validated(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || isIP(url.hostname) || url.hostname.startsWith('[')) throw new Error('reception_url_unsafe');
  return url;
}

/** IPv6 transition mechanisms can embed private IPv4 destinations: admit only native global unicast. */
export function receptionPublicAddress(address: string): boolean {
  if (!isPublicInternetAddress(address)) return false;
  if (isIP(address) !== 6) return isIP(address) === 4;
  return /^[23][0-9a-f]{3}:/i.test(address) && !/^2002:/i.test(address) && !/^2001:0{0,4}:/i.test(address);
}

function httpsTransport(url: URL, pinned: Address, signal: AbortSignal): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', signal, agent: false, family: pinned.family,
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'Lingshu-Reception-Readiness/1.0' },
      // Keep the hostname for TLS SNI/certificate validation; never resolve it a second time.
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, response => resolve({
      status: response.statusCode ?? 0,
      location: response.headers.location,
      contentLength: response.headers['content-length'],
      body: response,
      close() { response.destroy(); req.destroy(); },
    }));
    req.once('error', reject); req.end();
  });
}

async function withinAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('reception_url_timeout');
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('reception_url_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** HTTPS-only GET; every redirect resolves and validates DNS, then pins the validated connection address. */
export function createReceptionPublicUrlProbe(dependencies: ReceptionUrlProbeDependencies = {}) {
  const resolve = dependencies.resolve ?? (hostname => lookup(hostname, { all: true }));
  const transport = dependencies.transport ?? httpsTransport;
  const timeoutMs = Math.min(20_000, Math.max(1, dependencies.timeoutMs ?? 10_000));
  const maxBytes = Math.min(8 * 1024 * 1024, Math.max(1, dependencies.maxBytes ?? 8 * 1024 * 1024));
  return async (raw: string): Promise<{ accessible: boolean; checkedUrl: string; evidenceId: string; observation?: ReceptionHttpObservation }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: ProbeResponse | undefined;
    try {
      let url = validated(raw);
      const visits: Array<{ url: string; address: string; status: number }> = [];
      for (let hop = 0; hop <= 3; hop++) {
        const addresses = await withinAbort(resolve(url.hostname), controller.signal);
        if (!addresses.length || addresses.some(row => !receptionPublicAddress(row.address)
          || isIP(row.address) !== row.family)) throw new Error('reception_url_private_address');
        const pinned = addresses[0];
        response = await withinAbort(transport(url, pinned, controller.signal), controller.signal);
        visits.push({ url: url.toString(), address: pinned.address, status: response.status });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.location;
          response.close(); response = undefined;
          if (hop === 3) throw new Error('reception_url_redirect_limit');
          if (!location) throw new Error('reception_url_redirect_missing');
          url = validated(new URL(location, url).toString());
          continue;
        }
        if (response.status < 200 || response.status >= 300 || response.status === 204) return { accessible: false, checkedUrl: raw, evidenceId: '' };
        if (Number(response.contentLength ?? 0) > maxBytes) throw new Error('reception_url_response_too_large');
        let bytes = 0;
        const iterator = response.body[Symbol.asyncIterator]();
        for (;;) {
          const part = await withinAbort(iterator.next(), controller.signal);
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) throw new Error('reception_url_response_too_large');
        }
        if (!bytes) return { accessible: false, checkedUrl: raw, evidenceId: '' };
        const observation = { checkedAt: new Date().toISOString(), visits, bytes };
        return { accessible: true, checkedUrl: raw, evidenceId: `reception_http_${createHash('sha256').update(JSON.stringify(observation)).digest('hex')}`, observation };
      }
      throw new Error('reception_url_redirect_limit');
    } finally { clearTimeout(timer); response?.close(); }
  };
}
