import {assertMessengerCapabilityAuthority} from '../messenger/capabilityAuthority.js';
import { socialAccessToken } from '../lib/accountCredentials.js';
import { resolveTenantWhatsAppConfig } from '../whatsapp/send.js';
import { decryptSecret, type TenantPlatformAppRecord } from '../lib/tenantPlatformApps.js';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';

type ConfigRecord = {
  id: string;
  tenant_id: string;
  status?: string;
  config_version?: number;
  config?: unknown;
};

export interface CustomerMessagingAuthorization {
  tenantId: string;
  channel?: 'whatsapp' | 'messenger' | 'instagram';
  configVersion: number;
  configActive: boolean;
  customerAgentEnabled: boolean;
  tenantAuthorized: boolean;
  providerReady: boolean;
  backgroundWorkerEnabled: boolean;
  inboundAutoSendAllowed: boolean;
  manualFollowupSendAllowed: boolean;
  scheduledFollowupSendAllowed: boolean;
  reasons: string[];
}

export interface CustomerMessagingAuthorizationInput {
  tenantId: string;
  channel?: 'whatsapp' | 'messenger' | 'instagram';
  configVersion?: number;
  configActive: boolean;
  customerAgentEnabled: boolean;
  allowRealCustomerMessages: boolean;
  providerReady: boolean;
  backgroundWorkerEnabled: boolean;
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Pure policy resolver. Tenant consent and a usable provider connection are
 * mandatory for every real message. The background flag is only a kill switch
 * for scheduled outreach; it never grants consent by itself.
 */
export function resolveCustomerMessagingAuthorization(
  input: CustomerMessagingAuthorizationInput,
): CustomerMessagingAuthorization {
  const tenantAuthorized = input.configActive && input.customerAgentEnabled && input.allowRealCustomerMessages;
  const realSendReady = tenantAuthorized && input.providerReady;
  const reasons: string[] = [];
  if (!input.configActive) reasons.push('digital_employee_configuration_inactive');
  if (!input.customerAgentEnabled) reasons.push('customer_agent_not_enabled');
  if (!input.allowRealCustomerMessages) reasons.push('tenant_real_customer_messages_not_authorized');
  if (!input.providerReady) reasons.push(`${input.channel ?? 'whatsapp'}_provider_not_ready`);
  if (!input.backgroundWorkerEnabled) reasons.push('followup_background_worker_disabled');
  return {
    tenantId: input.tenantId,
    channel: input.channel ?? 'whatsapp',
    configVersion: Math.max(0, Math.trunc(Number(input.configVersion) || 0)),
    configActive: input.configActive,
    customerAgentEnabled: input.customerAgentEnabled,
    tenantAuthorized,
    providerReady: input.providerReady,
    backgroundWorkerEnabled: input.backgroundWorkerEnabled,
    inboundAutoSendAllowed: realSendReady,
    manualFollowupSendAllowed: realSendReady,
    scheduledFollowupSendAllowed: realSendReady && input.backgroundWorkerEnabled,
    reasons,
  };
}

export function followupBackgroundWorkerEnabled(): boolean {
  return process.env.FOLLOWUP_WORKER_ENABLED === 'true';
}

/** Authorize the transport that will actually send; one channel never grants another. */
export async function readCustomerMessagingAuthorization(
  tenantId: string,
  channel: 'whatsapp' | 'messenger' | 'instagram' = 'whatsapp',
  dependencies: { dataStore?: DataStore; openWhatsAppSecret?: typeof decryptSecret; openMessengerToken?: typeof socialAccessToken; now?: Date } = {},
): Promise<CustomerMessagingAuthorization> {
  const dataStore = dependencies.dataStore ?? store;
  try {
    const [configs, channelAccounts] = await Promise.all([
      dataStore.list<ConfigRecord>('digital_employee_configs', {
        where: { tenant_id: tenantId },
        sort: '-config_version',
        page: 1,
        perPage: 1,
      }),
      channel !== 'whatsapp' ? dataStore.list<Record<string, unknown>>('social_accounts', {
        where: { tenantId, platform: channel === 'instagram' ? 'instagram' : 'facebook', status: 'connected' },
        page: 1,
        perPage: 100,
      }) : dataStore.list<TenantPlatformAppRecord>('tenant_platform_apps', { where: { tenant_id: tenantId, platform: 'meta' }, page: 1, perPage: 2 }),
    ]);
    const configRecord = configs.items[0];
    const config = jsonObject(configRecord?.config);
    const enabledWorkflows = Array.isArray(config.enabledWorkflows)
      ? config.enabledWorkflows.map(item => String(item || ''))
      : [];
    const providerReady = channel === 'whatsapp'
      ? channelAccounts.totalItems === 1 && channelAccounts.items.length === 1 && (() => {
          try { resolveTenantWhatsAppConfig(tenantId, channelAccounts.items[0] as TenantPlatformAppRecord, dependencies.openWhatsAppSecret ?? decryptSecret, dependencies.now); return true; } catch { return false; }
        })()
      : channelAccounts.items.some(rawAccount => {
          const account = rawAccount as unknown as Record<string, unknown>;
          if (account.tenantId !== tenantId || account.platform !== (channel === 'instagram' ? 'instagram' : 'facebook') || account.status !== 'connected' || !String(account.providerAccountId || '').trim()) return false;
          if (channel === 'messenger') { try { assertMessengerCapabilityAuthority(account,dependencies.openMessengerToken ?? socialAccessToken); } catch { return false; } }
          if (channel === 'instagram') {
            const isInstagramLogin = account.oauthProvider === 'instagram_login';
            const scope = isInstagramLogin ? 'instagram_business_manage_messages' : 'instagram_manage_messages';
            if (!new Set(String(account.scope || '').split(/[\s,]+/)).has(scope)) return false;
            if (isInstagramLogin && account.instagramWebhookSubscribed !== true) return false;
            if (!isInstagramLogin && !String(account.parentPageId || '').trim()) return false;
          }
          const expiresAt = String(account.tokenExpiresAt || account.expiresAt || '').trim();
          if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= (dependencies.now ?? new Date()).getTime())) return false;
          try { return Boolean((dependencies.openMessengerToken ?? socialAccessToken)(account)); } catch { return false; }
        });
    return resolveCustomerMessagingAuthorization({
      tenantId, channel,
      configVersion: configRecord?.config_version,
      configActive: Boolean(configRecord && configRecord.tenant_id === tenantId && configRecord.status === 'active' && Number.isSafeInteger(configRecord.config_version) && Number(configRecord.config_version) > 0),
      customerAgentEnabled: enabledWorkflows.includes('customer_segmentation') || enabledWorkflows.includes('batch_followup'),
      allowRealCustomerMessages: config.allowRealCustomerMessages === true,
      providerReady,
      backgroundWorkerEnabled: followupBackgroundWorkerEnabled(),
    });
  } catch {
    return resolveCustomerMessagingAuthorization({
      tenantId, channel,
      configVersion: 0,
      configActive: false,
      customerAgentEnabled: false,
      allowRealCustomerMessages: false,
      providerReady: false,
      backgroundWorkerEnabled: followupBackgroundWorkerEnabled(),
    });
  }
}
