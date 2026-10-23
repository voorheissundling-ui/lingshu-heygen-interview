import type { DataStore, Record_ } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { getWhatsAppCustomers } from './historyImport.js';
import { canonicalWhatsAppAccountFromRow } from './canonicalAccount.js';
import { readCustomerMessagingAuthorization } from '../digitalEmployees/customerMessagingPolicy.js';
import { decryptSecret, type TenantPlatformAppRecord } from '../lib/tenantPlatformApps.js';
import { whatsappAssetAuthorityHash } from './assetAuthority.js';
const object = (value: unknown): Record<string, unknown> => { if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } } return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; };
/** Live reads require current tenant consent and verified native inbound ownership. Offline imports keep their raw reader. */
export async function readAuthorizedWhatsAppCustomers(tenantId: string, dataStore: DataStore = store, dependencies: { customers?: typeof getWhatsAppCustomers; openSecret?: typeof decryptSecret } = {}): Promise<ReturnType<typeof getWhatsAppCustomers>> {
  if (!tenantId?.trim()) return [];
  try {
    const apps = await dataStore.list<TenantPlatformAppRecord>('tenant_platform_apps', { where: { tenant_id: tenantId, platform: 'meta' }, perPage: 2 });
    if (apps.totalItems !== 1 || apps.items.length !== 1) return [];
    const app = structuredClone(apps.items[0]!);
    const proof = canonicalWhatsAppAccountFromRow(app, tenantId, app.id, dependencies.openSecret);
    const authorization = await readCustomerMessagingAuthorization(tenantId, 'whatsapp', { dataStore, openWhatsAppSecret: dependencies.openSecret });
    if (!authorization.manualFollowupSendAllowed) return [];
    const rows: Record_[] = []; let total: number | undefined;
    for (let page = 1; page <= 1000; page++) {
      const result = await dataStore.list<Record_>('whatsapp_interactions', { where: { tenant_id: tenantId }, page, perPage: 250 });
      if (total !== undefined && total !== result.totalItems) return [];
      total = result.totalItems; rows.push(...result.items);
      if (rows.length === total) break;
      if (!result.items.length || page === 1000 || rows.length > total) return [];
    }
    const recipients = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const message = object(row.payload); const audit = object(message.audit);
      if (row.tenant_id !== tenantId || message.tenantId !== tenantId || message.type !== 'msg_in' || !/^\d{6,20}$/.test(String(message.waNumber || '')) || typeof message.metaMessageId !== 'string' || !message.metaMessageId.startsWith('wamid.') || audit.inboundSource !== 'verified_meta_webhook' || audit.providerMessageId !== message.metaMessageId || audit.providerRecipientId !== message.waNumber || audit.accountId !== proof.accountId || audit.phoneNumberId !== proof.nativeAccountId || audit.wabaId !== proof.wabaId || typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp) || message.timestamp <= 0 || message.timestamp > Date.now()) continue;
      const recipient = String(message.waNumber); const messages = recipients.get(recipient) ?? []; messages.push({ ...message, id: String(message.id || row.id) }); recipients.set(recipient, messages);
    }
    const customers = (dependencies.customers ?? getWhatsAppCustomers)(tenantId).flatMap((raw: unknown) => {
      const customer = object(raw); const recipient = String(customer.waNumber || '');
      const messages = recipients.get(recipient);
      if (!messages || typeof customer.id !== 'string' || !customer.id) return [];
      if (customer.tenantId !== undefined && customer.tenantId !== tenantId || customer.accountId !== undefined && customer.accountId !== proof.accountId || customer.phoneNumberId !== undefined && customer.phoneNumberId !== proof.nativeAccountId || customer.wabaId !== undefined && customer.wabaId !== proof.wabaId) return [];
      // Imported aggregate profiles, summaries and drafts have no current-account provenance.
      // Build the live projection from verified messages instead of copying those fields.
      const timeline = [...messages].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)).map(message => ({ id: message.id, type: 'whatsapp', actor: 'buyer', body: typeof message.body === 'string' ? message.body : '', timestamp: message.timestamp }));
      return [{ id: customer.id, tenantId, waNumber: recipient, name: recipient, isReal: true, accountId: proof.accountId, accountHash: proof.accountHash, phoneNumberId: proof.nativeAccountId, wabaId: proof.wabaId, timeline, lastActiveAt: timeline.at(-1)?.timestamp }];
    });
    const finalApp = await dataStore.getById<TenantPlatformAppRecord>('tenant_platform_apps', app.id);
    const finalProof = canonicalWhatsAppAccountFromRow(finalApp, tenantId, app.id, dependencies.openSecret);
    const finalAuthorization = await readCustomerMessagingAuthorization(tenantId, 'whatsapp', { dataStore, openWhatsAppSecret: dependencies.openSecret });
    if (!finalApp || whatsappAssetAuthorityHash(finalApp) !== whatsappAssetAuthorityHash(app) || finalProof.accountHash !== proof.accountHash || !finalAuthorization.manualFollowupSendAllowed || finalAuthorization.configVersion !== authorization.configVersion) return [];
    return customers;
  } catch { return []; }
}
