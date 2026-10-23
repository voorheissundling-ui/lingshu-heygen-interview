import crypto from 'node:crypto';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function verifyWeComSignature(input: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
  signature: string;
}): boolean {
  const signature = text(input.signature);
  if (!signature) return false;
  const expected = [input.token, input.timestamp, input.nonce, input.encrypted]
    .map(text)
    .sort()
    .join('');
  const digest = crypto.createHash('sha1').update(expected).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function decryptWeComEcho(input: {
  encodingAesKey: string;
  encryptedEcho: string;
  corpId?: string;
}): string {
  return decryptWeComPayload(input).message;
}

export function decryptWeComPayload(input: {
  encodingAesKey: string;
  encryptedEcho: string;
  corpId?: string;
}): { message: string; receiveId: string } {
  const keyRaw = text(input.encodingAesKey);
  if (keyRaw.length !== 43 || !/^[A-Za-z0-9+/]{43}$/.test(keyRaw)) {
    throw new Error('invalid_wecom_encoding_aes_key');
  }
  const aesKey = Buffer.from(`${keyRaw}=`, 'base64');
  if (aesKey.length !== 32) {
    throw new Error('invalid_wecom_encoding_aes_key');
  }
  const cipherText = text(input.encryptedEcho);
  if (!cipherText || cipherText.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipherText)) {
    throw new Error('invalid_wecom_ciphertext');
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  let decrypted: Buffer;
  try {
    decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipherText, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new Error('invalid_wecom_ciphertext');
  }
  if (decrypted.length < 32) throw new Error('invalid_wecom_plaintext');
  const pad = decrypted[decrypted.length - 1];
  if (pad < 1 || pad > 32 || pad > decrypted.length) throw new Error('invalid_wecom_padding');
  for (let index = decrypted.length - pad; index < decrypted.length; index += 1) {
    if (decrypted[index] !== pad) throw new Error('invalid_wecom_padding');
  }
  const plain = decrypted.subarray(0, decrypted.length - pad);
  if (plain.length < 20) throw new Error('invalid_wecom_plaintext');
  const messageLength = plain.readUInt32BE(16);
  if (messageLength > plain.length - 20) throw new Error('invalid_wecom_plaintext');
  const message = plain.subarray(20, 20 + messageLength).toString('utf8');
  const receiveId = plain.subarray(20 + messageLength).toString('utf8');
  const expectedCorpId = text(input.corpId);
  if (expectedCorpId && receiveId !== expectedCorpId) {
    throw new Error('wecom_corp_id_mismatch');
  }
  return { message, receiveId };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
});

function parseXml(raw: string): Record<string, unknown> {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (!source || source.length > 256 * 1024) throw new Error('invalid_wecom_xml');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('unsafe_wecom_xml');
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(source);
  } catch {
    throw new Error('invalid_wecom_xml');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_wecom_xml');
  return parsed as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Parse the outer encrypted callback envelope without trusting any other field. */
export function parseWeComEncryptedEnvelope(rawXml: string): { encrypted: string } {
  const root = record(parseXml(rawXml).xml);
  const encrypted = text(root.Encrypt);
  if (!encrypted) throw new Error('wecom_encrypt_missing');
  return { encrypted };
}

export interface WeComKfCallbackEvent {
  toUserName: string;
  createTime: string;
  event: string;
  token: string;
  openKfId: string;
}

/** Parse the authenticated/decrypted WeCom callback payload. */
export function parseWeComKfCallbackXml(rawXml: string): WeComKfCallbackEvent {
  const root = record(parseXml(rawXml).xml);
  return {
    toUserName: text(root.ToUserName),
    createTime: text(root.CreateTime),
    event: text(root.Event),
    token: text(root.Token),
    openKfId: text(root.OpenKfId),
  };
}

export interface WeComKfSyncMessage {
  msgid?: string;
  open_kfid?: string;
  external_userid?: string;
  send_time?: number;
  origin?: number;
  msgtype?: string;
  text?: { content?: string };
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WeComKfProvider {
  syncMessages(input: {
    corpId: string;
    corpSecret: string;
    cursor?: string;
    token: string;
    openKfId?: string;
    limit?: number;
  }): Promise<{ nextCursor: string; hasMore: boolean; messages: WeComKfSyncMessage[] }>;
  getServiceState(input: {
    corpId: string;
    corpSecret: string;
    openKfId: string;
    externalUserId: string;
  }): Promise<{ serviceState: number; servicerUserId: string }>;
  sendText(input: {
    corpId: string;
    corpSecret: string;
    openKfId: string;
    externalUserId: string;
    content: string;
    msgId: string;
  }): Promise<{ msgId: string }>;
  transferServiceState(input: {
    corpId: string;
    corpSecret: string;
    openKfId: string;
    externalUserId: string;
    serviceState: 2 | 3;
    servicerUserId?: string;
  }): Promise<void>;
}

export class WeComApiError extends Error {
  readonly code: number | string;
  readonly uncertain: boolean;

  constructor(message: string, code: number | string, uncertain = false) {
    super(message);
    this.name = 'WeComApiError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

type AccessTokenEntry = { token: string; expiresAt: number };

/** Official WeCom KF adapter. The host is intentionally fixed to avoid credential-bearing SSRF. */
export function createWeComKfProvider(input: {
  now?: () => number;
  request?: typeof axios.request;
} = {}): WeComKfProvider {
  const now = input.now ?? Date.now;
  const request = input.request ?? axios.request;
  const accessTokens = new Map<string, AccessTokenEntry>();

  async function apiRequest<T>(args: {
    corpId: string;
    corpSecret: string;
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    effect?: boolean;
    authRetried?: boolean;
  }): Promise<T> {
    const cacheKey = `${args.corpId}:${crypto.createHash('sha256').update(args.corpSecret).digest('hex')}`;
    let cached = accessTokens.get(cacheKey);
    if (!cached || cached.expiresAt <= now() + 60_000) {
      let response;
      try {
        response = await request({
          method: 'GET',
          url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
          params: { corpid: args.corpId, corpsecret: args.corpSecret },
          timeout: 10_000,
          validateStatus: () => true,
        });
      } catch {
        throw new WeComApiError('wecom_access_token_unavailable', 'network');
      }
      const data = record(response.data);
      if (response.status !== 200 || Number(data.errcode || 0) !== 0 || !text(data.access_token)) {
        throw new WeComApiError(text(data.errmsg) || 'wecom_access_token_rejected', Number(data.errcode || response.status));
      }
      cached = {
        token: text(data.access_token),
        expiresAt: now() + Math.max(60, Number(data.expires_in || 7200)) * 1000,
      };
      accessTokens.set(cacheKey, cached);
    }
    let response;
    try {
      response = await request({
        method: args.method,
        url: `https://qyapi.weixin.qq.com${args.path}`,
        params: { access_token: cached.token },
        data: args.body,
        timeout: 15_000,
        validateStatus: () => true,
      });
    } catch {
      throw new WeComApiError('wecom_api_network_error', 'network', Boolean(args.effect));
    }
    const data = record(response.data);
    const providerCode = Number(data.errcode || 0);
    if (!args.authRetried && [40014, 42001].includes(providerCode)) {
      accessTokens.delete(cacheKey);
      return apiRequest<T>({ ...args, authRetried: true });
    }
    if (response.status !== 200 || providerCode !== 0) {
      throw new WeComApiError(text(data.errmsg) || 'wecom_api_rejected', providerCode || response.status);
    }
    return data as T;
  }

  return {
    async syncMessages(args) {
      const data = await apiRequest<Record<string, unknown>>({
        ...args,
        method: 'POST',
        path: '/cgi-bin/kf/sync_msg',
        body: {
          cursor: text(args.cursor),
          token: args.token,
          limit: Math.min(1000, Math.max(1, args.limit ?? 1000)),
          ...(text(args.openKfId) ? { open_kfid: text(args.openKfId) } : {}),
          voice_format: 0,
        },
      });
      return {
        nextCursor: text(data.next_cursor),
        hasMore: Number(data.has_more || 0) === 1,
        messages: Array.isArray(data.msg_list) ? data.msg_list as WeComKfSyncMessage[] : [],
      };
    },
    async getServiceState(args) {
      const data = await apiRequest<Record<string, unknown>>({
        ...args,
        method: 'POST',
        path: '/cgi-bin/kf/service_state/get',
        body: { open_kfid: args.openKfId, external_userid: args.externalUserId },
      });
      return { serviceState: Number(data.service_state), servicerUserId: text(data.servicer_userid) };
    },
    async sendText(args) {
      const data = await apiRequest<Record<string, unknown>>({
        ...args,
        method: 'POST',
        path: '/cgi-bin/kf/send_msg',
        effect: true,
        body: {
          touser: args.externalUserId,
          open_kfid: args.openKfId,
          msgid: args.msgId,
          msgtype: 'text',
          text: { content: args.content },
        },
      });
      return { msgId: text(data.msgid) || args.msgId };
    },
    async transferServiceState(args) {
      await apiRequest<Record<string, unknown>>({
        ...args,
        method: 'POST',
        path: '/cgi-bin/kf/service_state/trans',
        effect: true,
        body: {
          open_kfid: args.openKfId,
          external_userid: args.externalUserId,
          service_state: args.serviceState,
          ...(args.serviceState === 3 ? { servicer_userid: text(args.servicerUserId) } : {}),
        },
      });
    },
  };
}

export async function sendWeComMarkdown(webhookUrl: string, content: string): Promise<void> {
  const target = text(webhookUrl);
  if (!/^https:\/\//i.test(target)) throw new Error('wecom_robot_webhook_required');
  await axios.post(target, {
    msgtype: 'markdown',
    markdown: { content },
  });
}
