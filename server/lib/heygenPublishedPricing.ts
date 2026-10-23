import { createHash } from 'node:crypto';
import type { SocialPaidOperationIntent, SocialVerifiedAccountTariff } from './socialContentTaskBudgetAuthority.js';
export const HEYGEN_PRICE_URL = 'https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained';
export const ECB_FX_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export type HeyGenAvatarType = 'digital_twin' | 'photo_avatar' | 'studio_avatar';
export interface HeyGenPricingBinding {
  accountRef: string; credentialSha256: string; avatarType: HeyGenAvatarType;
  billingCurrency: 'USD'; billingEvidenceRef: string;
}
export interface HeyGenPublishedPricingEvidence extends HeyGenPricingBinding {
  schemaVersion: 1; basis: 'published_fx_estimate'; engine: 'avatar_iv' | 'starfish';
  nativeCurrency: 'USD'; usdPerMinute: number; estimatedCnyPerUsd: number;
  pricingSourceUrl: string; pricingSourceBody: string; pricingSourceSha256: string;
  fxSourceUrl: string; fxSourceBody: string; fxSourceSha256: string; fxDate: string;
  checkedAt: string; validUntil: string;
}
function plain(node: unknown): string {
  if (Array.isArray(node)) return node.map(plain).join('');
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  return (typeof n.text === 'string' ? n.text.replace(/<[^>]*>/g, '') : '')
    + Object.entries(n).filter(([k]) => k !== 'text').map(([, v]) => plain(v)).join('');
}
/** Parse the actual engine section and USD price column, never credits or a
 * different avatar engine. Currency conversion is an estimate, not settlement. */
export function parseHeyGenPublishedPrice(body: string, avatarType: HeyGenAvatarType): number | null {
  try {
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) return null;
    const m = body.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    const article = JSON.parse(m[1]!).props.pageProps.articleContent;
    if (article.articleId !== '10060327' || !Array.isArray(article.blocks)) return null;
    const label = { digital_twin: 'Digital Twin', photo_avatar: 'Photo Avatar', studio_avatar: 'Studio Avatar' }[avatarType];
    if (!label) return null;
    const found: number[] = [];
    for (const block of article.blocks) {
      let engine = false, seconds = false;
      for (const row of block.rows || []) {
        const cells: string[] = (row.cells || []).map(plain);
        if (cells[0]?.startsWith('Video Generation with Avatar ')) {
          engine = cells[0] === 'Video Generation with Avatar IV engine';
          seconds = cells[1] === 'Price per 1 minute, charged by actual seconds generated';
          continue;
        }
        if (engine && seconds && cells[0] === label && cells.length === 3) {
          const price = cells[1]!.match(/^\$(\d+(?:\.\d+)?)$/);
          if (!price || !(Number(price[1]) > 0)) return null;
          found.push(Number(price[1]));
        }
      }
    }
    return found.length === 1 ? found[0]! : null;
  } catch { return null; }
}
export function parseHeyGenPublishedSpeechPrice(body: string): number | null {
  try {
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) return null;
    const script = body.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!script) return null;
    const article = JSON.parse(script[1]!).props.pageProps.articleContent;
    if (article.articleId !== '10060327' || !Array.isArray(article.blocks)) return null;
    const prices: number[] = [];
    for (const block of article.blocks) for (const row of block.rows || []) {
      const cells: string[] = (row.cells || []).map(plain);
      if (cells[0] !== 'Speech — Starfish' || cells.length !== 3) continue;
      const match = cells[1]?.match(/^\$(\d+(?:\.\d+)?)$/);
      if (!match || !(Number(match[1]) > 0)) return null;
      prices.push(Number(match[1]));
    }
    return prices.length === 1 ? prices[0]! : null;
  } catch { return null; }
}
export function parseEcbUsdCny(body: string, now = new Date()) {
  if (Buffer.byteLength(body) > 256 * 1024 || !body.includes('http://www.ecb.int/vocabulary/2002-08-01/eurofxref')) return null;
  const days = [...body.matchAll(/<Cube\b[^>]*time=['"](\d{4}-\d{2}-\d{2})['"][^>]*>([\s\S]*?)<\/Cube>/g)];
  if (days.length !== 1) return null;
  const date = days[0]![1]!, stamp = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || stamp > now.getTime() || now.getTime() - stamp > 7 * 86400000) return null;
  const rate = (currency: string) => {
    const rows = [...days[0]![2]!.matchAll(new RegExp(`<Cube\\b[^>]*currency=['"]${currency}['"][^>]*rate=['"](\\d+(?:\\.\\d+)?)['"][^>]*\\/?>(?:<\\/Cube>)?`, 'g'))];
    return rows.length === 1 && Number(rows[0]![1]) > 0 ? Number(rows[0]![1]) : null;
  };
  const usd = rate('USD'), cny = rate('CNY');
  return usd && cny ? { date, cnyPerUsd: cny / usd } : null;
}
export function verifyHeyGenPublishedTariff(t: SocialVerifiedAccountTariff): boolean {
  try {
    const e = t.publicPricingEvidence as HeyGenPublishedPricingEvidence;
    const fx = parseEcbUsdCny(e.fxSourceBody, new Date(e.checkedAt));
    const speech = t.model === 'starfish' && t.stage === 'tts';
    const meter = t.meters[speech ? 'audioSeconds' : 'providerSeconds'];
    return t.provider === 'heygen' && (speech || (t.model === 'avatar_iv' && t.stage === 'presenter_video'))
      && t.currency === 'CNY' && t.verifiedAccountPrice === false && t.pricingBasis === 'published_fx_estimate'
      && e.schemaVersion === 1 && e.basis === 'published_fx_estimate' && e.engine === (speech ? 'starfish' : 'avatar_iv')
      && e.nativeCurrency === 'USD' && e.billingCurrency === 'USD' && !!e.billingEvidenceRef
      && /^[a-f0-9]{64}$/.test(e.credentialSha256) && e.accountRef === t.accountRef
      && e.accountRef === 'heygen:' + sha(JSON.stringify({ baseUrl: speech ? 'https://api.heygen.com/v3/voices/speech' : 'https://api.heygen.com/v3/videos', credentialSha256: e.credentialSha256 }))
      && e.pricingSourceUrl === HEYGEN_PRICE_URL && e.fxSourceUrl === ECB_FX_URL
      && sha(e.pricingSourceBody) === e.pricingSourceSha256 && sha(e.fxSourceBody) === e.fxSourceSha256
      && (speech ? parseHeyGenPublishedSpeechPrice(e.pricingSourceBody) : parseHeyGenPublishedPrice(e.pricingSourceBody, e.avatarType)) === e.usdPerMinute
      && fx?.date === e.fxDate && fx?.cnyPerUsd === e.estimatedCnyPerUsd
      && Object.keys(t.meters).length === 1 && meter?.priceCny === e.usdPerMinute * e.estimatedCnyPerUsd
      && meter.unitsPerPrice === 60 && meter.minimumUnits === 0 && meter.increment === 0.001
      && e.checkedAt === t.checkedAt && e.validUntil === t.validUntil
      && Date.parse(e.validUntil) > Date.parse(e.checkedAt) && Date.parse(e.validUntil) - Date.parse(e.checkedAt) <= 6 * 3600000;
  } catch { return false; }
}
export async function readHeyGenPublishedTariff(intent: SocialPaidOperationIntent, input: {
  readBinding: (intent: SocialPaidOperationIntent) => Promise<HeyGenPricingBinding | null>;
  fetchOfficial?: (url: string) => Promise<{ url: string; status: number; body: string }>;
  now?: () => Date;
}): Promise<SocialVerifiedAccountTariff | null> {
  const speech = intent.model === 'starfish' && intent.stage === 'tts';
  if (intent.provider !== 'heygen' || (!speech && (intent.model !== 'avatar_iv' || intent.stage !== 'presenter_video'))
    || Object.keys(intent.maximumUnits).join() !== (speech ? 'audioSeconds' : 'providerSeconds')) return null;
  const binding = await input.readBinding(intent); if (!binding || binding.accountRef !== intent.accountRef) return null;
  const fetchOfficial = input.fetchOfficial || (async (url: string) => {
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    const reader = r.body?.getReader(); if (!reader) throw Error('heygen_public_price_empty');
    const chunks: Buffer[] = []; let size = 0;
    for (;;) { const v = await reader.read(); if (v.done) break; size += v.value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw Error('heygen_public_price_too_large'); }
      chunks.push(Buffer.from(v.value)); }
    return { url: r.url, status: r.status, body: Buffer.concat(chunks).toString('utf8') };
  });
  let price, rates;
  try { [price, rates] = await Promise.all([fetchOfficial(HEYGEN_PRICE_URL), fetchOfficial(ECB_FX_URL)]); } catch { return null; }
  if (price.url !== HEYGEN_PRICE_URL || rates.url !== ECB_FX_URL || price.status !== 200 || rates.status !== 200) return null;
  const now = input.now?.() || new Date(), usdPerMinute = speech ? parseHeyGenPublishedSpeechPrice(price.body) : parseHeyGenPublishedPrice(price.body, binding.avatarType), fx = parseEcbUsdCny(rates.body, now);
  if (!usdPerMinute || !fx) return null;
  const checkedAt = now.toISOString(), validUntil = new Date(now.getTime() + 6 * 3600000).toISOString();
  const e: HeyGenPublishedPricingEvidence = { ...binding, schemaVersion: 1, basis: 'published_fx_estimate', engine: speech ? 'starfish' : 'avatar_iv', nativeCurrency: 'USD',
    usdPerMinute, estimatedCnyPerUsd: fx.cnyPerUsd, fxDate: fx.date, pricingSourceUrl: price.url, pricingSourceBody: price.body,
    pricingSourceSha256: sha(price.body), fxSourceUrl: rates.url, fxSourceBody: rates.body, fxSourceSha256: sha(rates.body), checkedAt, validUntil };
  const tariff: SocialVerifiedAccountTariff = { provider: 'heygen', model: intent.model, accountRef: intent.accountRef, stage: intent.stage,
    currency: 'CNY', verifiedAccountPrice: false, pricingBasis: 'published_fx_estimate', publicPricingEvidence: e,
    evidenceRef: 'heygen-usd-fx-estimate:' + sha(JSON.stringify(e)), checkedAt, validUntil,
    meters: { [speech ? 'audioSeconds' : 'providerSeconds']: { priceCny: usdPerMinute * fx.cnyPerUsd, unitsPerPrice: 60, minimumUnits: 0, increment: 0.001 } } };
  return verifyHeyGenPublishedTariff(tariff) ? tariff : null;
}
