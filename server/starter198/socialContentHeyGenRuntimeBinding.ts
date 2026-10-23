import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { validateHeyGenPresenterRecord, validatePublicHeyGenPresenterRecord, type PublicPresenterEvidence } from '../lib/presenterAssetTrust.js';
import type { HeyGenAvatarType, HeyGenPricingBinding } from '../lib/heygenPublishedPricing.js';
import { paidProductionHash } from './socialContentPaidOperationPlan.js';
import { productionBillingAccountRef } from './socialContentProductionBudgetRoutes.js';
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const credentialSha = (v: string) => createHash('sha256').update(v).digest('hex');
export interface TrustedHeyGenRuntimeBinding extends HeyGenPricingBinding {
  tenantId: string; presenterAssetId: string; assetVersion: number; avatarId: string; voiceId: string;
  model: 'avatar_iv'; authorizationRef: string; consentRef: string; providerEvidenceRef: string;
}
export interface HeyGenRuntimeBindingPorts {
  store: DataStore; env?: () => NodeJS.ProcessEnv;
  /** Official GETs only. No supplied account/type flags can replace these. */
  readProvider?: (url: string, credential: string) => Promise<unknown>;
  assertCurrent?: () => Promise<void>;
}
function key(ports: HeyGenRuntimeBindingPorts) { const value = (ports.env?.() || process.env).HEYGEN_API_KEY?.trim(); if (!value) throw Error('heygen_runtime_account_missing'); return value; }
const defaultRead = async (url: string, credential: string) => {
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'error', headers: { 'x-api-key': credential }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) {if([502,503,504].includes(response.status)&&attempt<2)continue;throw Error('heygen_runtime_read_' + response.status);}
      return await response.json();
    } catch(error) {
      if(attempt===2||String(error).includes('heygen_runtime_read_'))throw error;
      await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
    }
  }
  throw Error('heygen_runtime_read_unavailable');
};
/** Tenant record + original supplier GET metadata establish actual IV price
 * class and USD wallet. This does not confer approval or call generation. */
export async function readTrustedHeyGenRuntimeBinding(input: { tenantId: string; presenterAssetId: string; expectedVersion?: number }, ports: HeyGenRuntimeBindingPorts): Promise<TrustedHeyGenRuntimeBinding | null> {
  await ports.assertCurrent?.();
  if (!input.tenantId.trim() || !input.presenterAssetId.trim()) return null;
  const rows = await ports.store.list<any>('studio_production_defaults', { where: { tenant_id: input.tenantId }, perPage: 2 });
  if (rows.items.length !== 1 || rows.totalItems !== 1 || rows.items[0]?.tenant_id !== input.tenantId) return null;
  const records = rows.items[0].payload?.presenters;
  if (!Array.isArray(records)) return null;
  const selected = records.filter((p: any) => p?.id === input.presenterAssetId);
  if (selected.length !== 1 || !Number.isSafeInteger(selected[0].assetVersion) || selected[0].assetVersion < 1 || input.expectedVersion !== undefined && input.expectedVersion !== selected[0].assetVersion) return null;
  const trusted = validateHeyGenPresenterRecord(selected[0]); if (!trusted.ok || !trusted.avatarId) return null;
  const credential = key(ports), credentialSha256 = credentialSha(credential), read = ports.readProvider || defaultRead;
  const [lookRaw, walletRaw] = await Promise.all([read('https://api.heygen.com/v3/avatars/looks/' + encodeURIComponent(trusted.avatarId), credential), read('https://api.heygen.com/v3/users/me', credential)]);
  await ports.assertCurrent?.(); if (credentialSha(key(ports)) !== credentialSha256) throw Error('heygen_runtime_account_changed');
  const look = (lookRaw as any)?.data, wallet = (walletRaw as any)?.data;
  if (look?.id !== trusted.avatarId || look.status !== 'completed' || !Array.isArray(look.supported_api_engines) || !look.supported_api_engines.includes('avatar_iv')
    || !['digital_twin', 'photo_avatar', 'studio_avatar'].includes(look.avatar_type) || wallet?.billing_type !== 'wallet' || String(wallet.wallet?.currency).toUpperCase() !== 'USD'
    || !Number.isFinite(wallet.wallet?.remaining_balance) || wallet.wallet.remaining_balance < 0) return null;
  const accountRef = productionBillingAccountRef('heygen', 'https://api.heygen.com/v3/videos', credentialSha256);
  const providerEvidenceRef = 'heygen-live-iv:' + sha({ accountRef, id: look.id, avatarType: look.avatar_type, status: look.status, engines: look.supported_api_engines });
  const billingEvidenceRef = 'heygen-live-wallet:' + sha({ accountRef, billingType: wallet.billing_type, currency: 'USD', balance: wallet.wallet.remaining_balance });
  return { tenantId: input.tenantId, presenterAssetId: trusted.presenterAssetId, assetVersion: trusted.assetVersion, avatarId: trusted.avatarId, voiceId: trusted.voiceId, model: 'avatar_iv', accountRef, credentialSha256, avatarType: look.avatar_type as HeyGenAvatarType, billingCurrency: 'USD', billingEvidenceRef, authorizationRef: trusted.rights.authorizationRef, consentRef: trusted.rights.consentRef, providerEvidenceRef };
}
/**
 * Public catalog presenters are supplier-owned stock assets, not cloned people.
 * This path keeps that distinction explicit: it returns public catalog / terms
 * evidence and never invents authorizationRef or consentRef. The clone binding
 * above is unchanged and remains the only path for a private subject.
 */
export interface TrustedPublicHeyGenRuntimeBinding extends HeyGenPricingBinding {
  tenantId: string; presenterAssetId: string; assetVersion: number; avatarId: string; voiceId: string;
  model: 'avatar_iv'; publicEvidence: PublicPresenterEvidence; providerEvidenceRef: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en', chinese: 'zh', spanish: 'es', french: 'fr', german: 'de',
  japanese: 'ja', korean: 'ko', portuguese: 'pt', italian: 'it', arabic: 'ar',
  hindi: 'hi', russian: 'ru',
};
function languageCode(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return LANGUAGE_NAMES[raw] ?? raw.split(/[-_]/)[0];
}

/** Live GETs prove the public catalog record is still usable and the wallet is
 * still USD with auto-reload off. No paid call is made. */
export async function readTrustedPublicHeyGenRuntimeBinding(
  input: { tenantId: string; presenterAssetId: string; expectedVersion?: number; language?: string },
  ports: HeyGenRuntimeBindingPorts,
): Promise<TrustedPublicHeyGenRuntimeBinding | null> {
  await ports.assertCurrent?.();
  if (!input.tenantId.trim() || !input.presenterAssetId.trim()) return null;
  const rows = await ports.store.list<any>('studio_production_defaults', { where: { tenant_id: input.tenantId }, perPage: 2 });
  if (rows.items.length !== 1 || rows.totalItems !== 1 || rows.items[0]?.tenant_id !== input.tenantId) return null;
  const records = rows.items[0].payload?.presenters;
  if (!Array.isArray(records)) return null;
  const selected = records.filter((p: any) => p?.id === input.presenterAssetId
    && String(p?.ownership || '').trim().toLowerCase() === 'public');
  if (selected.length !== 1 || !Number.isSafeInteger(selected[0].assetVersion) || selected[0].assetVersion < 1
    || input.expectedVersion !== undefined && input.expectedVersion !== selected[0].assetVersion) return null;
  const trusted = validatePublicHeyGenPresenterRecord(selected[0]);
  if (!trusted.ok) return null;

  const credential = key(ports), credentialSha256 = credentialSha(credential), read = ports.readProvider || defaultRead;
  const [lookRaw, voiceRaw, walletRaw] = await Promise.all([
    read('https://api.heygen.com/v3/avatars/looks/' + encodeURIComponent(trusted.avatarId), credential),
    read('https://api.heygen.com/v3/voices/' + encodeURIComponent(trusted.voiceId), credential),
    read('https://api.heygen.com/v3/users/me', credential),
  ]);
  await ports.assertCurrent?.();
  if (credentialSha(key(ports)) !== credentialSha256) throw Error('heygen_runtime_account_changed');

  const look = (lookRaw as any)?.data, voice = (voiceRaw as any)?.data, wallet = (walletRaw as any)?.data;
  if (look?.id !== trusted.avatarId || look.status !== 'completed'
    || (look.ownership && String(look.ownership).toLowerCase() !== 'public')
    || !Array.isArray(look.supported_api_engines) || !look.supported_api_engines.includes('avatar_iv')
    || !['digital_twin', 'photo_avatar', 'studio_avatar'].includes(look.avatar_type)) return null;
  if (voice?.voice_id !== trusted.voiceId
    || (voice.type && String(voice.type).toLowerCase() !== 'public')
    || !['complete', 'completed', ''].includes(String(voice.status || '').toLowerCase())) return null;
  if (input.language && languageCode(voice.language) !== languageCode(input.language)) return null;
  if (wallet?.billing_type !== 'wallet' || String(wallet.wallet?.currency).toUpperCase() !== 'USD'
    || !Number.isFinite(wallet.wallet?.remaining_balance) || wallet.wallet.remaining_balance < 0
    || wallet.wallet?.auto_reload?.enabled !== false) return null;

  const accountRef = productionBillingAccountRef('heygen', 'https://api.heygen.com/v3/videos', credentialSha256);
  const publicEvidence: PublicPresenterEvidence = { ...trusted.evidence, accountId: accountRef };
  const providerEvidenceRef = 'heygen-live-public-iv:' + sha({
    accountRef, id: look.id, avatarType: look.avatar_type, status: look.status,
    engines: look.supported_api_engines, voiceId: voice.voice_id, voiceLanguage: voice.language,
    publicCatalogRef: trusted.evidence.publicCatalogRef, providerTermsRef: trusted.evidence.providerTermsRef,
  });
  return {
    tenantId: input.tenantId, presenterAssetId: trusted.presenterAssetId, assetVersion: trusted.assetVersion,
    avatarId: trusted.avatarId, voiceId: trusted.voiceId, model: 'avatar_iv',
    accountRef, credentialSha256, avatarType: look.avatar_type as HeyGenAvatarType, billingCurrency: 'USD',
    billingEvidenceRef: 'heygen-live-public-wallet:' + sha({
      accountRef, billingType: wallet.billing_type, currency: 'USD', balance: wallet.wallet.remaining_balance,
      autoReload: wallet.wallet.auto_reload.enabled,
    }),
    publicEvidence, providerEvidenceRef,
  };
}

/** Shared public route identity. Clone refs are deliberately absent. */
export function publicHeyGenRuntimeRouteEvidence(binding: TrustedPublicHeyGenRuntimeBinding): string {
  return 'heygen-approved-public-person:' + paidProductionHash({ ...binding, billingEvidenceRef: undefined });
}

/** Shared preflight/SDK identity: wallet balance is mutable billing evidence. */
export function heyGenRuntimeRouteEvidence(binding: TrustedHeyGenRuntimeBinding): string {
  return 'heygen-approved-person:' + paidProductionHash({ ...binding, billingEvidenceRef: undefined });
}
export async function assertLiveHeyGenBinding(expected: TrustedHeyGenRuntimeBinding, ports: HeyGenRuntimeBindingPorts) {
  const current = await readTrustedHeyGenRuntimeBinding({ tenantId: expected.tenantId, presenterAssetId: expected.presenterAssetId, expectedVersion: expected.assetVersion }, ports);
  // Wallet balance can legitimately decrease. Currency/account/type and original
  // authorized person must stay identical; balance is not immutable authority.
  if (!current || heyGenRuntimeRouteEvidence(current) !== heyGenRuntimeRouteEvidence(expected)) throw Error('heygen_live_presenter_binding_changed');
}
