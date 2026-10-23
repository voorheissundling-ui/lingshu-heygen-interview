import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyContextTags, vetoRevokedContextTags, type ContextTagEvidence } from '../messenger/contextTags.js';
import { assessBant, selectProgressionGoal } from '../sales/qualification.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.INSTAGRAM_CUSTOMERS_DATA_FILE
  ? path.resolve(process.env.INSTAGRAM_CUSTOMERS_DATA_FILE)
  : path.join(__dirname, '../../data/instagram-customers.json');

type TimelineEvent = {
  id: string;
  type: 'instagram';
  actor: 'buyer' | 'seller' | 'ai';
  title: string;
  body: string;
  time: string;
  timestamp: number;
  sendStatus?: 'sent' | 'delivered' | 'failed';
  audit?: { providerMessageId?: string; providerRecipientId?: string; providerReadAt?: number };
};

export type InstagramCustomer = Record<string, unknown> & {
  id: string;
  tenantId: string;
  instagramAccountId: string;
  instagramUserId: string;
  name: string;
  timeline: TimelineEvent[];
  lastActiveAt: number;
};

function readCustomers(): InstagramCustomer[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('instagram_customer_store_invalid');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function writeCustomers(items: InstagramCustomer[]) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, DATA_FILE);
}

function customerId(tenantId: string, instagramAccountId: string, userId: string) {
  return `instagram_${createHash('sha256').update(`${tenantId}:${instagramAccountId}:${userId}`).digest('hex').slice(0, 20)}`;
}

function initialCustomer(tenantId: string, instagramAccountId: string, userId: string, timestamp: number): InstagramCustomer {
  const suffix = userId.slice(-6);
  return {
    id: customerId(tenantId, instagramAccountId, userId), tenantId, instagramAccountId, instagramUserId: userId,
    name: `Instagram 用户 ${suffix}`, avatar: '', countryName: '未知', language: '待确认', languageLocked: false,
    source: 'instagram', product: '待确认', outboundProduct: '待确认', estimatedValue: '待评估',
    stage: 'inquiry', intentScore: 50, intentSignals: ['Instagram 主动私信'], handlingMode: 'ai_draft',
    handlingReason: '新消息已进入会话，等待回复', hasUnread: true, priority: 50,
    lastActive: '刚刚', lastActiveAt: timestamp, localTime: '--:--', orders: [], tags: ['Instagram'],
    summary: '来自 Instagram 的真实会话。', nextStep: '查看消息并回复', timeline: [],
  };
}

function eventTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function upsertMessage(input: {
  tenantId: string; instagramAccountId: string; userId: string; messageId: string; body: string;
  timestamp: number; actor: 'buyer' | 'seller' | 'ai'; sendStatus?: 'sent' | 'delivered';
}) {
  const items = readCustomers();
  const id = customerId(input.tenantId, input.instagramAccountId, input.userId);
  const index = items.findIndex(item => item.id === id);
  const customer = index >= 0 ? items[index] : initialCustomer(input.tenantId, input.instagramAccountId, input.userId, input.timestamp);
  if (customer.timeline.some(event => event.id === input.messageId)) return customer;
  if (!customer.timeline.some(event => event.id === input.messageId)) {
    customer.timeline.push({
      id: input.messageId, type: 'instagram', actor: input.actor,
      title: input.actor === 'buyer' ? '客户消息' : input.actor === 'ai' ? 'AI 回复' : '我的回复',
      body: input.body, time: eventTime(input.timestamp), timestamp: input.timestamp,
      ...(input.sendStatus ? { sendStatus: input.sendStatus } : {}),
      audit: { providerMessageId: input.messageId, providerRecipientId: input.userId },
    });
  }
  customer.lastActive = '刚刚';
  customer.timeline.sort((left, right) => left.timestamp - right.timestamp);
  customer.lastActiveAt = Math.max(customer.lastActiveAt, input.timestamp);
  if (input.actor === 'buyer') {
    customer.hasUnread = true;
    customer.inboxReason = '客户发来新消息，等待回复';
    customer.contextTagsRetryAt = 0;
  }
  items[index >= 0 ? index : items.length] = customer;
  writeCustomers(items);
  return customer;
}

export function upsertInstagramMessage(input: {
  tenantId: string; instagramAccountId: string; userId: string; messageId: string; body: string;
  timestamp: number; actor: 'buyer' | 'seller' | 'ai'; sendStatus?: 'sent' | 'delivered';
}): InstagramCustomer {
  return upsertMessage(input);
}

export function getInstagramCustomers(tenantId: string): InstagramCustomer[] {
  return readCustomers()
    .filter(item => item.tenantId === tenantId)
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

export function patchInstagramCustomer(tenantId: string, id: string, patch: Record<string, unknown>): InstagramCustomer | null {
  const items = readCustomers();
  const index = items.findIndex(item => item.tenantId === tenantId && item.id === id);
  if (index < 0) return null;
  const protectedFields = new Set(['id', 'tenantId', 'instagramAccountId', 'instagramUserId', 'timeline']);
  const safePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => !protectedFields.has(key)));
  items[index] = { ...items[index], ...safePatch };
  writeCustomers(items);
  return items[index];
}

const tagAnalyses = new Map<string, Promise<InstagramCustomer | null>>();
const CONTEXT_ANALYSIS_VERSION = 5;
function buyerFingerprint(customer: InstagramCustomer): string {
  return createHash('sha256').update(JSON.stringify(customer.timeline.filter(event => event.actor === 'buyer').slice(-40).map(event => [event.id, event.body]))).digest('hex');
}

function refreshBuyerQualification(customer: InstagramCustomer): void {
  const oldEvidence = Array.isArray(customer.contextTagEvidence) ? customer.contextTagEvidence as ContextTagEvidence[] : [];
  const evidence = vetoRevokedContextTags(oldEvidence, customer.timeline);
  const removed = new Set(oldEvidence.filter(item => !evidence.some(current => current.tag === item.tag)).map(item => item.tag));
  const bant = assessBant({ turns: customer.timeline.map(event => ({ role: event.actor === 'buyer' ? 'buyer' as const : 'seller' as const, text: event.body })) });
  patchInstagramCustomer(customer.tenantId, customer.id, {
    contextTagEvidence: evidence,
    tags: Array.isArray(customer.tags) ? customer.tags.map(String).filter(tag => !removed.has(tag)) : ['Instagram'],
    bant, intentScore: bant.total, progressionGoal: selectProgressionGoal(bant, String(customer.language || 'English')),
  });
}

export function analyzeInstagramCustomerTags(tenantId: string, id: string, classify = classifyContextTags): Promise<InstagramCustomer | null> {
  const key = `${tenantId}:${id}`;
  const pending = tagAnalyses.get(key);
  if (pending) return pending;
  const analysis = (async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
    const customer = getInstagramCustomers(tenantId).find(item => item.id === id);
    if (!customer) return null;
    refreshBuyerQualification(customer);
    const snapshot = JSON.stringify(customer.timeline);
    const contextTagEvidence = await classify(customer.timeline);
    const current = getInstagramCustomers(tenantId).find(item => item.id === id);
    if (!current) return null;
    if (JSON.stringify(current.timeline) !== snapshot) continue;
    const oldTags = Array.isArray(current.contextTagEvidence) ? current.contextTagEvidence as ContextTagEvidence[] : [];
    const managed = new Set(oldTags.map(item => item.tag));
    const manualTags = Array.isArray(current.tags) ? current.tags.map(String).filter(tag => !managed.has(tag)) : [];
    const bant = assessBant({ turns: current.timeline.map(event => ({ role: event.actor === 'buyer' ? 'buyer' as const : 'seller' as const, text: event.body })) });
    return patchInstagramCustomer(tenantId, id, {
      tags: [...new Set([...manualTags, 'Instagram', ...contextTagEvidence.map(item => item.tag)])],
      contextTagEvidence, contextTagsUpdatedAt: new Date().toISOString(),
      contextTagsBuyerFingerprint: buyerFingerprint(current), contextTagsRetryAt: 0, contextTagsAttempts: 0,
      contextTagsAnalysisVersion: CONTEXT_ANALYSIS_VERSION,
      bant, intentScore: bant.total, progressionGoal: selectProgressionGoal(bant, String(current.language || 'English')),
    });
    }
    throw new Error('会话持续更新，请稍后重新分析标签');
  })().catch(error => {
    const current = getInstagramCustomers(tenantId).find(item => item.id === id);
    if (current) {
      refreshBuyerQualification(current);
      const attempts = Number(current.contextTagsAttempts || 0) + 1;
      patchInstagramCustomer(tenantId, id, {
        contextTagsAttempts: attempts,
        contextTagsRetryAt: Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 4)),
      });
    }
    throw error;
  }).finally(() => tagAnalyses.delete(key));
  tagAnalyses.set(key, analysis);
  return analysis;
}

// Runs only in the HTTP writer process. The conversation file is the durable
// work list, so a process exit cannot lose an unfinished classification.
export async function recoverInstagramContextTags(now = Date.now(), analyze = analyzeInstagramCustomerTags): Promise<number> {
  const pending = readCustomers().filter(customer => customer.timeline.some(event => event.actor === 'buyer')
    && (customer.contextTagsBuyerFingerprint !== buyerFingerprint(customer) || customer.contextTagsAnalysisVersion !== CONTEXT_ANALYSIS_VERSION)
    && Number(customer.contextTagsRetryAt || 0) <= now).slice(0, 5);
  await Promise.all(pending.map(customer => analyze(customer.tenantId, customer.id).catch(error => {
    console.warn('[instagram:context-tags-recovery]', error instanceof Error ? error.message : 'analysis_failed');
  })));
  return pending.length;
}

export function startInstagramContextTagRecovery(): () => void {
  let running = false;
  let stopped = false;
  const recover = async () => {
    if (running || stopped) return;
    running = true;
    try { await recoverInstagramContextTags(); }
    catch (error) { console.warn('[instagram:context-tags-recovery]', error instanceof Error ? error.message : 'recovery_failed'); }
    finally { running = false; }
  };
  const timer = setInterval(() => void recover(), 30_000);
  timer.unref();
  void recover();
  return () => { stopped = true; clearInterval(timer); };
}

export async function handleInstagramWebhook(tenantId: string, payload: unknown, options: { analyzeTags?: boolean } = {}) {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (root.object !== 'instagram' || !Array.isArray(root.entry)) return { accepted: 0 };
  let accepted = 0;
  for (const rawEntry of root.entry) {
    const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry as Record<string, unknown> : {};
    const instagramAccountId = String(entry.id || '');
    const ownIds = new Set([instagramAccountId, String(entry.messagingAccountId || '')].filter(Boolean));
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const rawEvent of events) {
      const event = rawEvent && typeof rawEvent === 'object' ? rawEvent as Record<string, any> : {};
      const senderId = String(event.sender?.id || '');
      const recipientId = String(event.recipient?.id || '');
      if (event.delivery || event.read) {
        if (!instagramAccountId || !senderId || !ownIds.has(recipientId)) continue;
        const items = readCustomers();
        const customer = items.find(item => item.id === customerId(tenantId, instagramAccountId, senderId));
        if (!customer) continue;
        const receipt = event.read || event.delivery;
        const watermark = Number(receipt.watermark);
        const mids = new Set(Array.isArray(receipt.mids) ? receipt.mids.map(String) : []);
        let changed = false;
        for (const message of customer.timeline) {
          if (message.actor === 'buyer') continue;
          if (!mids.has(message.id) && !(Number.isFinite(watermark) && watermark > 0 && message.timestamp <= watermark)) continue;
          if (message.sendStatus !== 'delivered') { message.sendStatus = 'delivered'; changed = true; }
          if (event.read && Number.isFinite(watermark) && watermark > (message.audit?.providerReadAt || 0)) {
            message.audit = { ...message.audit, providerReadAt: watermark };
            changed = true;
          }
        }
        if (changed) writeCustomers(items);
        accepted += 1;
        continue;
      }
      const isEcho = event.message?.is_echo === true;
      // The entry Instagram account is tenant-bound by the route. Each nested
      // event must also belong to that account.
      if (isEcho ? !ownIds.has(senderId) : !ownIds.has(recipientId)) continue;
      const userId = isEcho ? recipientId : senderId;
      const attachmentLabels: Record<string, string> = { image: '图片', audio: '音频', video: '视频', file: '文件', location: '位置' };
      const attachments = Array.isArray(event.message?.attachments) ? event.message.attachments : [];
      const attachmentBody = attachments.map((attachment: unknown) => {
        const type = attachment && typeof attachment === 'object' ? String((attachment as Record<string, unknown>).type || '') : '';
        return `[${attachmentLabels[type] || '未知类型'}附件]`;
      }).join(' ');
      const body = String(event.message?.text || event.postback?.title || event.postback?.payload || attachmentBody).trim();
      if (!instagramAccountId || !userId || ownIds.has(userId) || !body) continue;
      const providerTimestamp = Number(event.timestamp);
      const timestamp = Number.isFinite(providerTimestamp) && providerTimestamp > 0 && providerTimestamp <= 8.64e15 ? providerTimestamp : Date.now();
      const messageId = String(event.message?.mid || `instagram_${timestamp}_${userId}`);
      const customer = upsertMessage({ tenantId, instagramAccountId, userId, messageId, body, timestamp, actor: isEcho ? 'seller' : 'buyer', sendStatus: isEcho ? 'sent' : undefined });
      if (!isEcho && options.analyzeTags !== false) void analyzeInstagramCustomerTags(tenantId, customer.id).catch(error => console.warn('[instagram:context-tags]', error instanceof Error ? error.message : 'analysis_failed'));
      accepted += 1;
    }
  }
  return { accepted };
}
