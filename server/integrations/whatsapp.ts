import axios from 'axios';
import FormData from 'form-data';

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  webhookUrl?: string;
}

export interface WhatsAppSendReceipt {
  messageId: string;
  recipientId: string;
  raw: Record<string, unknown>;
}

function graphVersion(): string {
  return process.env.META_GRAPH_VERSION?.trim() || 'v25.0';
}

function sendReceipt(data: unknown, expectedRecipient: string): WhatsAppSendReceipt {
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const messages = Array.isArray(raw.messages) ? raw.messages as Array<Record<string, unknown>> : [];
  const contacts = Array.isArray(raw.contacts) ? raw.contacts as Array<Record<string, unknown>> : [];
  const recipient = expectedRecipient.trim().replace(/^\+/, '');
  if (messages.length !== 1 || contacts.length !== 1 || !String(messages[0]?.id || '').trim() || String(contacts[0]?.wa_id || '') !== recipient) throw Error('whatsapp_provider_receipt_identity_invalid');
  return {
    messageId: String(messages[0]?.id || ''),
    recipientId: String(contacts[0]?.wa_id || ''),
    raw,
  };
}

export async function sendWhatsAppText(config: WhatsAppConfig, to: string, text: string, callbackData?: string): Promise<WhatsAppSendReceipt> {
  const response = await axios.post(
    `https://graph.facebook.com/${graphVersion()}/${config.phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text }, ...(callbackData ? { biz_opaque_callback_data: callbackData } : {}) },
    { maxRedirects: 0, timeout: 15000, headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' } }
  );
  return sendReceipt(response.data, to);
}

export async function sendWhatsAppImage(
  config: WhatsAppConfig,
  to: string,
  bytes: Buffer,
  caption: string,
  filename = 'quotation.png',
  callbackData?: string,
  beforeMessage?: () => Promise<void>,
): Promise<WhatsAppSendReceipt> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/png');
  form.append('file', bytes, { filename, contentType: 'image/png', knownLength: bytes.length });
  const uploaded = await axios.post(
    `https://graph.facebook.com/${graphVersion()}/${config.phoneNumberId}/media`,
    form,
    { maxRedirects: 0, timeout: 15000, headers: { Authorization: `Bearer ${config.accessToken}`, ...form.getHeaders() }, maxBodyLength: 10 * 1024 * 1024 },
  );
  const mediaId = String(uploaded.data?.id || '');
  if (!mediaId) throw new Error('whatsapp_media_id_missing');
  await beforeMessage?.();
  const response = await axios.post(
    `https://graph.facebook.com/${graphVersion()}/${config.phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption }, ...(callbackData ? { biz_opaque_callback_data: callbackData } : {}) },
    { maxRedirects: 0, timeout: 15000, headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' } },
  );
  return sendReceipt(response.data, to);
}

export async function sendWhatsAppTemplate(
  config: WhatsAppConfig,
  to: string,
  templateName: string,
  languageCode: string,
  components: object[] = [],
  callbackData?: string
): Promise<WhatsAppSendReceipt> {
  const response = await axios.post(
    `https://graph.facebook.com/${graphVersion()}/${config.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      ...(callbackData ? { biz_opaque_callback_data: callbackData } : {}),
      template: { name: templateName, language: { code: languageCode }, components },
    },
    { maxRedirects: 0, timeout: 15000, headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' } }
  );
  return sendReceipt(response.data, to);
}

export function verifyWhatsAppWebhook(
  config: WhatsAppConfig,
  mode: string,
  token: string,
  challenge: string
): string | null {
  if (mode === 'subscribe' && token === config.verifyToken) return challenge;
  return null;
}

export async function getPhoneNumberInfo(config: WhatsAppConfig) {
  const res = await axios.get(
    `https://graph.facebook.com/${graphVersion()}/${config.phoneNumberId}`,
    { maxRedirects: 0, timeout: 15000, headers: { Authorization: `Bearer ${config.accessToken}` } }
  );
  return res.data;
}
