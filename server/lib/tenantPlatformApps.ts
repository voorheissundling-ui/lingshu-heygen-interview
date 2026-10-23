import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import type { DataStore } from '../storage/datastore.js';
import { store } from '../storage/index.js';
import { withLegacyExternalEffectAllowed } from '../starter198/legacyEffectGuard.js';
import { createStarter198Repository } from '../starter198/repository.js';
import { getPublicOrigin, getInstagramOAuthClient, getLinkedInOAuthClient, getMetaOAuthClient, getTikTokOAuthClient, getYouTubeOAuthClient } from './oauthConfig.js';
import { sendDingTalkMarkdown, sendDingTalkText } from '../integrations/dingtalk.js';
import { sendFeishuCard, sendFeishuText } from '../integrations/feishu.js';
import { sendWeComMarkdown } from '../integrations/wecom.js';

export type TenantPlatform = 'meta' | 'instagram' | 'google' | 'tiktok' | 'linkedin' | 'wecom';
export type TenantTokenType = 'user_60d' | 'system_user_permanent';
export type TenantPlatformStatus =
  | 'pending'
  | 'configuring'
  | 'waiting_customer'
  | 'importing_history'
  | 'verifying'
  | 'active'
  | 'needs_permanent_token'
  | 'token_expired'
  | 'error';

export interface TenantPlatformAppRecord {
  id: string;
  tenant_id: string;
  platform: TenantPlatform;
  app_id?: string;
  app_secret?: string;
  wa_config_id?: string;
  business_id?: string;
  waba_id?: string;
  phone_number_id?: string;
  wa_public_number?: string;
  page_id?: string;
  ig_user_id?: string;
  youtube_channel_id?: string;
  webhook_verify_token?: string;
  wecom_encoding_aes_key?: string;
  token_type?: TenantTokenType;
  access_token?: string;
  token_expires_at?: string;
  status?: TenantPlatformStatus;
  last_checklist?: string;
  notes?: string;
}

export interface PublicTenantPlatformApp {
  id: string;
  tenantId: string;
  platform: TenantPlatform;
  appId: string;
  appSecretSet: boolean;
  appSecretLength: number;
  waConfigId: string;
  businessId: string;
  wabaId: string;
  phoneNumberId: string;
  waPublicNumber: string;
  pageId: string;
  igUserId: string;
  youtubeChannelId: string;
  webhookVerifyToken: string;
  webhookVerifyTokenSet: boolean;
  webhookVerifyTokenLength: number;
  wecomEncodingAesKeySet: boolean;
  wecomEncodingAesKeyLength: number;
  webhookUrl: string;
  oauthRedirectUri: string;
  tokenType: TenantTokenType;
  accessTokenSet: boolean;
  accessTokenLength: number;
  tokenExpiresAt: string;
  status: TenantPlatformStatus;
  checklist: Record<string, boolean>;
  notes: string;
}

const COL = 'tenant_platform_apps';
const STATE_TTL_MS = 10 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const ENTERPRISE_FILE = path.join(DATA_DIR, 'enterprise.json');
const DAILY_BRIEFING_QUEUE_FILE = path.join(DATA_DIR, 'daily-briefing-queue.json');
const MISSING_TENANT_PLATFORM_APP_KEY =
  'TENANT_PLATFORM_APP_KEY is required in production. Generate one with `openssl rand -base64 32` and set it in the server environment before starting LingShu.';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function assertTenantPlatformAppKey(): void {
  if (process.env.NODE_ENV === 'production' && !text(process.env.TENANT_PLATFORM_APP_KEY)) {
    throw new Error(MISSING_TENANT_PLATFORM_APP_KEY);
  }
}

assertTenantPlatformAppKey();

function secretKey(): Buffer {
  const tenantKey = text(process.env.TENANT_PLATFORM_APP_KEY);
  if (process.env.NODE_ENV === 'production' && !tenantKey) {
    throw new Error(MISSING_TENANT_PLATFORM_APP_KEY);
  }
  const raw = tenantKey || text(process.env.OAUTH_STATE_SECRET) || 'lingshu-local-dev-tenant-platform-key';
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(value: string): string {
  const plain = text(value);
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(value?: string): string {
  const raw = text(value);
  if (!raw) return '';
  if (!raw.startsWith('v1:')) return raw;
  try {
    const [, ivRaw, tagRaw, dataRaw] = raw.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

/** Validate an OAuth app ID and secret together before any tenant app writes. */
export function validateTenantOAuthCredentialPair(input: {
  appId: string;
  appSecret: string;
  existing: TenantPlatformAppRecord | null;
}): 'oauth_app_id_clear_requires_delete' | 'oauth_app_id_required' | 'oauth_app_secret_required' | null {
  const appId = text(input.appId);
  const appSecret = text(input.appSecret);
  const existingId = text(input.existing?.app_id);
  if (existingId && !appId) return 'oauth_app_id_clear_requires_delete';
  if (appSecret && !appId) return 'oauth_app_id_required';
  if (appId && (!decryptSecret(input.existing?.app_secret) || appId !== existingId) && !appSecret) {
    return 'oauth_app_secret_required';
  }
  return null;
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

async function getTenantPlatformAppFrom(
  dataStore: DataStore,
  tenantId: string,
  platform: TenantPlatform,
): Promise<TenantPlatformAppRecord | null> {
  const result = await dataStore.list<TenantPlatformAppRecord>(COL, {
    where: { tenant_id: tenantId, platform },
    perPage: 2,
  });
  const app = result.items[0];
  return result.totalItems === 1 && result.items.length === 1 && app?.tenant_id === tenantId && app.platform === platform ? app : null;
}

export async function getTenantPlatformApp(tenantId: string, platform: TenantPlatform): Promise<TenantPlatformAppRecord | null> {
  return getTenantPlatformAppFrom(store, tenantId, platform);
}

export async function listTenantPlatformApps(): Promise<TenantPlatformAppRecord[]> {
  const result = await store.list<TenantPlatformAppRecord>(COL, { perPage: 200, sort: 'tenant_id' });
  return result.items;
}

export async function deleteTenantPlatformApp(tenantId: string, platform: TenantPlatform): Promise<boolean> {
  const app = await getTenantPlatformApp(tenantId, platform);
  if (!app) return false;
  return store.delete(COL, app.id);
}

export function tenantWebhookUrl(req: Request, tenantId: string, platform: TenantPlatform = 'meta'): string {
  const path = platform === 'wecom' ? 'wecom' : platform === 'instagram' ? 'instagram' : 'meta';
  return `${getPublicOrigin(req)}/api/webhooks/${path}/${encodeURIComponent(tenantId)}`;
}

export function publicTenantPlatformApp(req: Request, app: TenantPlatformAppRecord): PublicTenantPlatformApp {
  const checklist = (() => {
    try {
      const parsed = JSON.parse(text(app.last_checklist) || '{}');
      return parsed && typeof parsed === 'object' ? parsed as Record<string, boolean> : {};
    } catch {
      return {};
    }
  })();
  const appSecret = decryptSecret(app.app_secret);
  const accessToken = decryptSecret(app.access_token);
  const wecomEncodingAesKey = decryptSecret(app.wecom_encoding_aes_key);
  const numericAssetId = (value: unknown) => /^\d+$/.test(text(value)) ? text(value) : '';
  return {
    id: app.id,
    tenantId: app.tenant_id,
    platform: app.platform,
    appId: text(app.app_id),
    appSecretSet: Boolean(appSecret),
    appSecretLength: appSecret.length,
    waConfigId: text(app.wa_config_id),
    businessId: text(app.business_id),
    wabaId: text(app.waba_id),
    phoneNumberId: text(app.phone_number_id),
    waPublicNumber: text(app.wa_public_number),
    pageId: numericAssetId(app.page_id),
    igUserId: numericAssetId(app.ig_user_id),
    youtubeChannelId: text(app.youtube_channel_id),
    webhookVerifyToken: '',
    webhookVerifyTokenSet: Boolean(text(app.webhook_verify_token)),
    webhookVerifyTokenLength: text(app.webhook_verify_token).length,
    wecomEncodingAesKeySet: Boolean(wecomEncodingAesKey),
    wecomEncodingAesKeyLength: wecomEncodingAesKey.length,
    webhookUrl: app.platform === 'meta' || app.platform === 'instagram' || app.platform === 'wecom' ? tenantWebhookUrl(req, app.tenant_id, app.platform) : '',
    oauthRedirectUri: app.platform === 'google'
      ? `${getPublicOrigin(req)}/api/overseas/youtube/oauth/callback`
      : app.platform === 'instagram'
        ? `${getPublicOrigin(req)}/api/overseas/social/oauth/instagram/callback`
      : app.platform === 'tiktok'
        ? `${getPublicOrigin(req)}/api/overseas/social/oauth/tiktok/callback`
      : app.platform === 'linkedin'
        ? `${getPublicOrigin(req)}/api/overseas/social/oauth/linkedin/callback`
        : '',
    tokenType: app.token_type || 'user_60d',
    accessTokenSet: Boolean(accessToken),
    accessTokenLength: accessToken.length,
    tokenExpiresAt: text(app.token_expires_at),
    status: app.status || 'pending',
    checklist,
    notes: text(app.notes),
  };
}

export async function upsertTenantPlatformApp(input: {
  tenantId: string;
  platform: TenantPlatform;
  dataStore?: DataStore;
  appId?: string;
  appSecret?: string;
  waConfigId?: string;
  businessId?: string;
  wabaId?: string;
  phoneNumberId?: string;
  waPublicNumber?: string;
  pageId?: string;
  igUserId?: string;
  youtubeChannelId?: string;
  webhookVerifyToken?: string;
  wecomEncodingAesKey?: string;
  tokenType?: TenantTokenType;
  accessToken?: string;
  tokenExpiresAt?: string;
  status?: TenantPlatformStatus;
  checklist?: Record<string, boolean>;
  notes?: string;
}): Promise<TenantPlatformAppRecord> {
  const dataStore = input.dataStore ?? store;
  return withLegacyExternalEffectAllowed(input.tenantId, async transitionGuard => {
    const existing = await getTenantPlatformAppFrom(dataStore, input.tenantId, input.platform);
    const patch: Record<string, unknown> = {
      tenant_id: input.tenantId,
      platform: input.platform,
      webhook_verify_token: input.webhookVerifyToken || existing?.webhook_verify_token || randomToken(),
      token_type: input.tokenType || existing?.token_type || 'user_60d',
      status: input.status || existing?.status || 'pending',
    };
    if (input.appId !== undefined) patch.app_id = input.appId;
    if (input.appSecret) patch.app_secret = encryptSecret(input.appSecret);
    if (input.waConfigId !== undefined) patch.wa_config_id = input.waConfigId;
    if (input.businessId !== undefined) patch.business_id = input.businessId;
    if (input.wabaId !== undefined) patch.waba_id = input.wabaId;
    if (input.phoneNumberId !== undefined) patch.phone_number_id = input.phoneNumberId;
    if (input.waPublicNumber !== undefined) patch.wa_public_number = input.waPublicNumber;
    if (input.pageId !== undefined) patch.page_id = input.pageId;
    if (input.igUserId !== undefined) patch.ig_user_id = input.igUserId;
    if (input.youtubeChannelId !== undefined) patch.youtube_channel_id = input.youtubeChannelId;
    if (input.wecomEncodingAesKey) patch.wecom_encoding_aes_key = encryptSecret(input.wecomEncodingAesKey);
    if (input.accessToken) patch.access_token = encryptSecret(input.accessToken);
    if (input.tokenExpiresAt !== undefined) patch.token_expires_at = input.tokenExpiresAt;
    if (input.checklist !== undefined) patch.last_checklist = JSON.stringify(input.checklist);
    if (input.notes !== undefined) patch.notes = input.notes;

    await transitionGuard.beforeEffect();
    if (existing) {
      if (!await dataStore.update(COL, existing.id, patch)) throw new Error('tenant_platform_app_update_failed');
      return { ...existing, ...patch } as TenantPlatformAppRecord;
    }
    const created = await dataStore.create<TenantPlatformAppRecord>(COL, patch);
    if (!created) throw new Error('tenant_platform_app_create_failed');
    return created;
  }, createStarter198Repository(dataStore), dataStore);
}

export async function markTenantPlatformStatus(id: string, status: TenantPlatformStatus, notes?: string): Promise<void> {
  await store.update(COL, id, {
    status,
    ...(notes ? { notes } : {}),
  });
}

export async function getTenantMetaOAuthClient(tenantId?: string, dataStore: DataStore = store): Promise<{ appId: string; appSecret: string } | null> {
  if (tenantId) {
    const app = await getTenantPlatformAppFrom(dataStore, tenantId, 'meta');
    const appId = text(app?.app_id);
    const appSecret = decryptSecret(app?.app_secret);
    if (app?.tenant_id === tenantId && appId && appSecret) return { appId, appSecret };
    return null;
  }
  return getMetaOAuthClient();
}

export async function getTenantInstagramOAuthClient(tenantId?: string, dataStore: DataStore = store): Promise<{ appId: string; appSecret: string } | null> {
  if (tenantId) {
    const app = await getTenantPlatformAppFrom(dataStore, tenantId, 'instagram');
    const appId = text(app?.app_id);
    const appSecret = decryptSecret(app?.app_secret);
    if (app?.tenant_id === tenantId && appId && appSecret) return { appId, appSecret };
    return null;
  }
  return getInstagramOAuthClient();
}

export async function getTenantGoogleOAuthClient(tenantId?: string, dataStore: DataStore = store): Promise<{ clientId: string; clientSecret: string } | null> {
  if (tenantId) {
    const app = await getTenantPlatformAppFrom(dataStore, tenantId, 'google');
    const clientId = text(app?.app_id);
    const clientSecret = decryptSecret(app?.app_secret);
    if (app?.tenant_id === tenantId && clientId && clientSecret) return { clientId, clientSecret };
    return null;
  }
  return getYouTubeOAuthClient();
}

export async function getTenantTikTokOAuthClient(tenantId?: string, dataStore: DataStore = store): Promise<{ clientKey: string; clientSecret: string } | null> {
  if (tenantId) {
    const app = await getTenantPlatformAppFrom(dataStore, tenantId, 'tiktok');
    const clientKey = text(app?.app_id);
    const clientSecret = decryptSecret(app?.app_secret);
    if (app?.tenant_id === tenantId && clientKey && clientSecret) return { clientKey, clientSecret };
    return null;
  }
  return getTikTokOAuthClient();
}

export async function getTenantLinkedInOAuthClient(tenantId?: string, dataStore: DataStore = store): Promise<{ clientId: string; clientSecret: string } | null> {
  if (tenantId) {
    const app = await getTenantPlatformAppFrom(dataStore, tenantId, 'linkedin');
    const clientId = text(app?.app_id);
    const clientSecret = decryptSecret(app?.app_secret);
    if (app?.tenant_id === tenantId && clientId && clientSecret) return { clientId, clientSecret };
    return null;
  }
  return getLinkedInOAuthClient();
}

export function signOAuthState(input: {
  tenantId: string;
  userId: string;
  platform: string;
  returnTo: string;
  purpose?: 'messenger';
  redirectUri?: string;
  nonce?: string;
  expiresAt?: number;
}): string {
  const payload = {
    tenantId: input.tenantId,
    userId: input.userId,
    platform: input.platform,
    returnTo: input.returnTo,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
    nonce: input.nonce || crypto.randomBytes(12).toString('base64url'),
    expiresAt: input.expiresAt || Date.now() + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function parseOAuthState(state: string): null | {
  tenantId: string;
  userId: string;
  platform: string;
  returnTo: string;
  purpose?: 'messenger';
  redirectUri?: string;
  expiresAt: number;
} {
  const parts = text(state).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      tenantId?: string;
      userId?: string;
      platform?: string;
      returnTo?: string;
      purpose?: string;
      redirectUri?: string;
      expiresAt?: number;
    };
    if (typeof payload.tenantId !== 'string' || !payload.tenantId || typeof payload.userId !== 'string' || !payload.userId || typeof payload.platform !== 'string' || !payload.platform || !Number.isFinite(payload.expiresAt)) return null;
    if (typeof payload.returnTo !== 'string' || !payload.returnTo.startsWith('/') || payload.returnTo.startsWith('//') || /[\\\r\n]/.test(payload.returnTo)) return null;
    if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now() || payload.expiresAt > Date.now() + STATE_TTL_MS) return null;
    return {
      tenantId: payload.tenantId,
      userId: payload.userId,
      platform: payload.platform,
      returnTo: payload.returnTo || '/',
      ...(typeof payload.redirectUri === 'string' ? { redirectUri: payload.redirectUri } : {}),
      ...(payload.purpose === 'messenger' ? { purpose: 'messenger' as const } : {}),
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
}

export function verifyMetaSignature(appSecret: string, rawBody: Buffer, signatureHeader: unknown): boolean {
  const signature = text(Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader);
  if (!signature.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export type DeliveryNotificationSeverity = 'urgent' | 'important' | 'normal';

export interface DeliveryNotificationOptions {
  immediate?: boolean;
  tenantId?: string;
  severity?: DeliveryNotificationSeverity;
  title?: string;
  actions?: Array<{ text: string; url: string }>;
  receivers?: Array<{ name: string; channel: 'wecom' | 'dingtalk' | 'feishu' | 'sms'; target: string }>;
}

export async function notifyDeliveryTeam(message: string, options: DeliveryNotificationOptions = {}): Promise<void> {
  const enterpriseNotifications = options.tenantId
    ? await readTenantNotificationSettings(options.tenantId)
    : readEnterpriseNotificationSettings();
  const severity = options.severity ?? (options.immediate ? 'important' : 'normal');
  const immediate = options.immediate || severity === 'urgent' || severity === 'important';
  if (!immediate && enterpriseNotifications?.quietOutsideHours && !isWithinWorkHours(enterpriseNotifications.workHours)) {
    enqueueDailyBriefing(message);
    console.warn('[delivery-alert:queued-for-briefing]', message);
    return;
  }
  const tasks: Promise<unknown>[] = [];
  const selectedReceivers = options.receivers ?? enterpriseNotifications?.receivers ?? [];
  if (selectedReceivers.length) {
    for (const receiver of selectedReceivers) {
      if (receiver.channel === 'dingtalk') {
        const actionLinks = (options.actions ?? []).map(action => `[${action.text}](${action.url})`).join('　');
        tasks.push(sendDingTalkMarkdown(
          { webhookUrl: receiver.target, secret: '' },
          options.title || '灵小枢客户提醒',
          `${message.replace(/\n/g, '\n\n')}${actionLinks ? `\n\n${actionLinks}` : ''}`,
        ));
      } else if (receiver.channel === 'feishu') {
        const color = severity === 'urgent' ? 'red' : severity === 'important' ? 'yellow' : 'blue';
        tasks.push(sendFeishuCard(
          { webhookUrl: receiver.target, secret: '' },
          options.title || '灵小枢客户提醒',
          message,
          color,
          options.actions,
        ));
      } else if (receiver.channel === 'wecom' && /^https:\/\//i.test(receiver.target)) {
        const actionLinks = (options.actions ?? []).map(action => `[${action.text}](${action.url})`).join('　');
        tasks.push(sendWeComMarkdown(
          receiver.target,
          `${message}${actionLinks ? `\n${actionLinks}` : ''}`,
        ));
      } else {
        console.warn(`[delivery-alert:${receiver.channel}] ${receiver.name || receiver.target}: ${message}`);
      }
    }
    if (tasks.length) {
      const results = await Promise.allSettled(tasks);
      if (results.every(result => result.status === 'rejected')) {
        throw new Error('notification_delivery_failed');
      }
      return;
    }
    throw new Error('notification_receiver_not_deliverable');
  }
  const dingTalkWebhook = text(process.env.DELIVERY_ALERT_DINGTALK_WEBHOOK);
  if (dingTalkWebhook) {
    tasks.push(sendDingTalkText({
      webhookUrl: dingTalkWebhook,
      secret: text(process.env.DELIVERY_ALERT_DINGTALK_SECRET),
    }, message));
  }
  const feishuWebhook = text(process.env.DELIVERY_ALERT_FEISHU_WEBHOOK);
  if (feishuWebhook) {
    tasks.push(sendFeishuText({
      webhookUrl: feishuWebhook,
      secret: text(process.env.DELIVERY_ALERT_FEISHU_SECRET),
    }, message));
  }
  if (!tasks.length) {
    console.warn('[delivery-alert]', message);
    return;
  }
  const results = await Promise.allSettled(tasks);
  if (results.every(result => result.status === 'rejected')) throw new Error('notification_delivery_failed');
}

async function readTenantNotificationSettings(tenantId: string): Promise<ReturnType<typeof readEnterpriseNotificationSettings>> {
  try {
    const result = await store.list<Record<string, unknown>>('tenant_profiles', {
      where: { tenant_id: tenantId }, page: 1, perPage: 1,
    });
    const rawProfile = result.items[0]?.profile;
    const profile = typeof rawProfile === 'string' ? JSON.parse(rawProfile) : rawProfile;
    const notifications = profile && typeof profile === 'object'
      ? (profile as Record<string, any>).notifications
      : undefined;
    const receivers = Array.isArray(notifications?.receivers)
      ? notifications.receivers.map((receiver: any) => ({
          name: text(receiver?.name),
          channel: ['wecom', 'dingtalk', 'feishu', 'sms'].includes(receiver?.channel) ? receiver.channel : 'wecom',
          target: text(receiver?.target),
        })).filter((receiver: any) => receiver.target)
      : [];
    if (!receivers.length) return readEnterpriseNotificationSettings();
    return {
      receivers,
      workHours: {
        start: /^\d{2}:\d{2}$/.test(text(notifications?.workHours?.start)) ? text(notifications.workHours.start) : '09:00',
        end: /^\d{2}:\d{2}$/.test(text(notifications?.workHours?.end)) ? text(notifications.workHours.end) : '22:00',
      },
      quietOutsideHours: notifications?.quietOutsideHours !== false,
    };
  } catch {
    return readEnterpriseNotificationSettings();
  }
}

function readEnterpriseNotificationSettings(): null | {
  receivers: Array<{ name: string; channel: 'wecom' | 'dingtalk' | 'feishu' | 'sms'; target: string }>;
  workHours: { start: string; end: string };
  quietOutsideHours: boolean;
} {
  try {
    const parsed = JSON.parse(fs.readFileSync(ENTERPRISE_FILE, 'utf8'));
    const notifications = parsed?.notifications;
    const receivers = Array.isArray(notifications?.receivers)
      ? notifications.receivers.map((receiver: any) => ({
        name: text(receiver?.name),
        channel: ['wecom', 'dingtalk', 'feishu', 'sms'].includes(receiver?.channel) ? receiver.channel : 'wecom',
        target: text(receiver?.target),
      })).filter((receiver: any) => receiver.target)
      : [];
    if (!receivers.length) return null;
    return {
      receivers,
      workHours: {
        start: /^\d{2}:\d{2}$/.test(text(notifications?.workHours?.start)) ? text(notifications?.workHours?.start) : '09:00',
        end: /^\d{2}:\d{2}$/.test(text(notifications?.workHours?.end)) ? text(notifications?.workHours?.end) : '22:00',
      },
      quietOutsideHours: notifications?.quietOutsideHours !== false,
    };
  } catch {
    return null;
  }
}

function minutesOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function isWithinWorkHours(workHours: { start: string; end: string }): boolean {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesOfDay(workHours.start);
  const end = minutesOfDay(workHours.end);
  if (start === end) return true;
  if (start < end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function enqueueDailyBriefing(message: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const existing = JSON.parse(fs.existsSync(DAILY_BRIEFING_QUEUE_FILE) ? fs.readFileSync(DAILY_BRIEFING_QUEUE_FILE, 'utf8') : '[]');
    const items = Array.isArray(existing) ? existing : [];
    items.push({ id: crypto.randomUUID(), message, createdAt: new Date().toISOString(), deliverOn: nextLocalDate() });
    fs.writeFileSync(DAILY_BRIEFING_QUEUE_FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch (error) {
    console.warn('[delivery-alert:queue-failed]', error);
  }
}

function nextLocalDate(): string {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  return next.toISOString().slice(0, 10);
}
