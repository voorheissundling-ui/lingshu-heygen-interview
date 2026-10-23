import { createHash } from 'node:crypto';
import type { DataStore } from '../storage/datastore.js';
import { validateHeyGenPresenterRecord } from '../lib/presenterAssetTrust.js';
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
