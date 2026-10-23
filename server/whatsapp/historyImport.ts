import { readCanonicalWhatsAppAccount } from './canonicalAccount.js';
import { backupWhatsAppDataFiles, customers, dedupeWhatsAppCustomerRecords, dedupeWhatsAppInteractionRecords, importStatus, interactions, mirrorCustomerToPocketBase, mirrorInteractionToPocketBase, syncBackupsToR2, writeCustomers, writeImportStatus, writeInteractions } from './historyPersistence.js';
export { dedupeWhatsAppCustomerRecords, dedupeWhatsAppInteractionRecords, whatsappInteractionProviderId } from './historyPersistence.js';
import { currentLocalTime, inferPhoneRegion, normalizedCustomerSource, recomputeWhatsAppCustomerStages, text, timestamp } from './historyPolicy.js';
export { getNightModeMorningBriefing, recomputeWhatsAppCustomerStages } from './historyPolicy.js';
import { addInteraction, customerId, upsertCustomer } from './historyCustomerState.js';
export { confirmCustomerSourceAttribution } from './historyCustomerState.js';
import { collectChanges, contactsFromValue, messagesFromValue, type WinningStyleSample } from './historyInboundPreparation.js';
export type { WinningStyleSample } from './historyInboundPreparation.js';
import { handleInboundMessage } from './historyInbound.js';
import { createHash } from 'node:crypto';
import { prioritizeCustomer } from '../autonomy/prioritize.js';
import { distillSalesStyleProfile } from '../knowledge/styleMemory.js';
import { type BantAssessment, type ProgressionGoal } from '../sales/qualification.js';
import { type SpinState, type SpinGuidance } from '../sales/spin.js';
import { store } from '../storage/index.js';
import { isRealWhatsAppNumber } from './customerVisibility.js';


export type HandlingMode = 'ai_auto' | 'ai_draft' | 'human_needed';
export type CustomerStage = 'lead' | 'inquiry' | 'quoted' | 'won' | 'silent30' | 'silent60';

export interface StoredCustomerOrder {
  id: string;
  status: 'paid' | 'refunded' | 'cancelled' | 'pending';
  total: string;
  createdAt: string;
  items?: Array<{ name: string; qty: number }>;
}

export interface StoredInteraction {
  id: string;
  tenantId: string;
  customerId: string;
  waNumber: string;
  metaMessageId?: string;
  type: 'msg_in' | 'msg_out_human' | 'msg_out_ai' | 'system';
  body: string;
  timestamp: number;
  autoSent?: boolean;
  audit?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface StoredCustomer {
  id: string;
  tenantId: string;
  waNumber: string;
  name: string;
  whatsappProfileName?: string;
  language: string;
  languageLocked?: boolean;
  countryName?: string;
  timeZone?: string;
  timeZoneSource?: 'customer_profile' | 'phone_country_default';
  stage: CustomerStage;
  handlingMode: HandlingMode;
  handlingReason: string;
  intentScore: number;
  lastActiveAt: number;
  createdAt: string;
  updatedAt: string;
  aiAutoCount?: number;
  blockedAutoReplyReason?: string;
  pendingDraft?: string;
  needCall?: boolean;
  knowledgeMissStreak?: number;
  fallbackCount?: number;
  handoffDueAt?: string;
  bant?: BantAssessment;
  progressionGoal?: ProgressionGoal;
  spin?: SpinState;
  spinGuidance?: SpinGuidance;
  source?: string;
  sourcePostId?: string;
  sourceTrackCode?: string;
  sourcePostTitle?: string;
  sourcePostPlatform?: string;
  softAttribution?: { candidates: Array<{ id: string; title: string; platform: string; trackCode: string }> };
  tags?: string[];
  orders?: StoredCustomerOrder[];
  todoCompletedAt?: string;
  hasUnread?: boolean;
}

export interface NightModeEvent {
  id: string;
  tenantId: string;
  customerId: string;
  kind: 'auto' | 'draft' | 'call';
  createdAt: string;
}

export interface ImportStatus {
  tenantId: string;
  status: 'idle' | 'importing' | 'done' | 'skipped';
  done: number;
  total: number;
  updatedAt: string;
  note?: string;
}

export interface IncomingContact {
  waNumber: string;
  name?: string;
}

export interface IncomingMessage {
  id: string;
  waNumber: string;
  name?: string;
  fromBusiness?: boolean;
  body: string;
  timestamp: number;
  canonicalAccount?: {accountId:string;phoneNumberId:string;wabaId:string};
}

export interface KnowledgeConversationSample {
  customerId: string;
  messages: Array<{ actor: 'buyer' | 'seller'; body: string; timestamp: number }>;
}

function storedPayload<T>(value: unknown): T | null {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

async function readAllPocketBaseRecords(collection: string): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  let page = 1;
  while (page <= 50) {
    const result = await store.list<Record<string, unknown>>(collection, { page, perPage: 100 });
    items.push(...result.items);
    if (page >= result.totalPages || result.items.length < 100) break;
    page += 1;
  }
  return items;
}

async function hydrateWhatsAppFromPocketBase(): Promise<void> {
  try {
    const [customerRecords, interactionRecords] = await Promise.all([
      readAllPocketBaseRecords('whatsapp_customers'),
      readAllPocketBaseRecords('whatsapp_interactions'),
    ]);
    const remoteCustomers = customerRecords
      .map(record => storedPayload<StoredCustomer>(record.payload))
      .filter((item): item is StoredCustomer => Boolean(item?.id && item?.tenantId));
    const remoteInteractions = interactionRecords
      .map(record => storedPayload<StoredInteraction>(record.payload))
      .filter((item): item is StoredInteraction => Boolean(item?.id && item?.tenantId));
    // Merge rather than replace: a local write may be newer than a delayed PB
    // mirror, and legacy/local fallback stores may contain duplicate rows.
    if (remoteCustomers.length) writeCustomers([...customers(), ...remoteCustomers]);
    if (remoteInteractions.length) writeInteractions([...interactions(), ...remoteInteractions]);
    if (remoteCustomers.length || remoteInteractions.length) {
      console.log(`[whatsapp] hydrated ${dedupeWhatsAppCustomerRecords(remoteCustomers).length} customers and ${dedupeWhatsAppInteractionRecords(remoteInteractions).length} interactions from PocketBase`);
    }
  } catch (error) {
    console.warn('[whatsapp] using local snapshot:', error instanceof Error ? error.message : error);
  }
}

export async function initWhatsAppCustomerMaintenance(): Promise<void> {
  await hydrateWhatsAppFromPocketBase();
  const run = () => {
    try {
      backupWhatsAppDataFiles();
      void syncBackupsToR2().catch(error => console.error('[whatsapp-backup-r2]', error));
      void distillSalesStyleProfile('local_tenant_default').catch(error => console.error('[style-memory:distill]', error));
      const changed = recomputeWhatsAppCustomerStages();
      if (changed > 0) console.log(`[whatsapp-maintenance] recomputed ${changed} customer stages`);
    } catch (error) {
      console.error('[whatsapp-maintenance]', error);
    }
  };
  setTimeout(run, 30_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}


export async function handleMetaWebhook(tenantId: string, payload: any): Promise<void> {
  const changes = collectChanges(payload);
  for (const change of changes) {
    const field = text(change?.field);
    const value = change?.value ?? {};
    if (field === 'smb_app_state_sync') {
      for (const contact of contactsFromValue(value)) {
        upsertCustomer({ tenantId, waNumber: contact.waNumber, name: contact.name, patch: { handlingReason: '已从 WhatsApp Business App 同步联系人' } });
      }
    }
    if (field === 'history') {
      const messages = messagesFromValue(value);
      writeImportStatus({ tenantId, status: 'importing', done: 0, total: messages.length, updatedAt: new Date().toISOString() });
      let done = 0;
      for (const message of messages) {
        await handleInboundMessage(tenantId, message, { skipAutonomy: true });
        done += 1;
        writeImportStatus({ tenantId, status: 'importing', done, total: messages.length, updatedAt: new Date().toISOString() });
      }
      writeImportStatus({ tenantId, status: messages.length ? 'done' : 'skipped', done, total: messages.length, updatedAt: new Date().toISOString(), note: messages.length ? undefined : '客户未授权历史聊天记录共享或本次无历史消息' });
    }
    if (field === 'messages') {
      for (const message of messagesFromValue(value)) {
        await handleInboundMessage(tenantId, message);
      }
    }
  }
}

export function getWhatsAppImportStatus(): ImportStatus {
  return importStatus();
}

export function markWhatsAppHumanReply(input: {
  tenantId: string;
  customerId: string;
  body: string;
  messages?: string[];
  waNumber?: string;
  providerReceipts?: Array<{ messageId?: string; recipientId?: string; raw?: unknown }>;
}, dependencies: { customers?: typeof customers; addInteraction?: typeof addInteraction; upsertCustomer?: typeof upsertCustomer; now?: () => number; preserveCustomerState?: boolean } = {}): void {
  const customer = (dependencies.customers || customers)().find(item => item.tenantId === input.tenantId && item.id === input.customerId);
  const waNumber = input.waNumber || customer?.waNumber;
  if (!customer || !waNumber) throw new Error('whatsapp_history_customer_missing');
  const sentMessages = input.messages?.length ? input.messages : [input.body];
  const baseTimestamp = (dependencies.now || Date.now)();
  sentMessages.forEach((body, index) => {
    const receipt = input.providerReceipts?.[index];
    const providerId = String(receipt?.messageId || '').trim();
    (dependencies.addInteraction || addInteraction)({
      id: providerId ? `wa-out-${createHash('sha256').update(JSON.stringify([input.tenantId, providerId])).digest('hex').slice(0, 40)}` : `${customer.id}-human-${baseTimestamp}-${index}`,
      ...(providerId ? { metaMessageId: providerId } : {}),
      tenantId: input.tenantId,
      customerId: customer.id,
      waNumber,
      type: 'msg_out_human',
      body,
      timestamp: baseTimestamp + index,
      audit: {
        clearsKnowledgeMissStreak: true,
        providerMessageId: receipt?.messageId,
        providerRecipientId: receipt?.recipientId,
        messageIndex: index,
        messageCount: sentMessages.length,
      },
      meta: receipt?.messageId ? {
        provider: 'whatsapp',
        providerMessageId: receipt.messageId,
        providerRecipientId: receipt.recipientId,
      } : undefined,
    });
  });
  if (dependencies.preserveCustomerState) return;
  (dependencies.upsertCustomer || upsertCustomer)({
    tenantId: input.tenantId,
    waNumber,
    patch: {
      handlingMode: 'ai_draft',
      handlingReason: '人工已回复，AI 继续辅助跟进',
      knowledgeMissStreak: 0,
      fallbackCount: 0,
      handoffDueAt: undefined,
      blockedAutoReplyReason: undefined,
      pendingDraft: undefined,
      hasUnread: false,
      todoCompletedAt: new Date().toISOString(),
    },
  });
}

export function patchWhatsAppCustomer(input: {
  tenantId: string;
  customerId: string;
  patch: Record<string, unknown>;
}): StoredCustomer | null {
  const list = customers();
  const index = list.findIndex(item => item.tenantId === input.tenantId && item.id === input.customerId && isRealWhatsAppNumber(item.waNumber));
  if (index < 0) return null;
  const current = list[index];
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  const next: StoredCustomer = { ...current };

  if (typeof patch.language === 'string' && patch.language.trim()) next.language = patch.language.trim().slice(0, 40);
  if (typeof patch.languageLocked === 'boolean') next.languageLocked = patch.languageLocked;
  if (typeof patch.timeZone === 'string' && patch.timeZone.trim()) {
    const timeZone = patch.timeZone.trim().slice(0, 100);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
      next.timeZone = timeZone;
      next.timeZoneSource = 'customer_profile';
    } catch { /* invalid IANA time zones are ignored */ }
  }
  if (patch.handlingMode === 'ai_auto' || patch.handlingMode === 'ai_draft' || patch.handlingMode === 'human_needed') next.handlingMode = patch.handlingMode;
  if (typeof patch.needCall === 'boolean') next.needCall = patch.needCall;
  if (typeof patch.aiAutoCount === 'number' && Number.isFinite(patch.aiAutoCount)) next.aiAutoCount = Math.max(0, Math.floor(patch.aiAutoCount));
  if (typeof patch.hasUnread === 'boolean') next.hasUnread = patch.hasUnread;
  if (patch.pendingDraft === null || patch.pendingDraft === '') delete next.pendingDraft;
  else if (typeof patch.pendingDraft === 'string') next.pendingDraft = patch.pendingDraft.trim().slice(0, 8_000);
  if (patch.todoCompletedAt === null || patch.todoCompletedAt === '') delete next.todoCompletedAt;
  else if (typeof patch.todoCompletedAt === 'string') next.todoCompletedAt = patch.todoCompletedAt.slice(0, 80);
  if (Array.isArray(patch.tags)) next.tags = patch.tags.map(item => String(item || '').trim()).filter(Boolean).slice(0, 20);
  if (Array.isArray(patch.orders)) {
    next.orders = patch.orders.map(item => {
      const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const status = raw.status === 'paid' || raw.status === 'refunded' || raw.status === 'cancelled' ? raw.status : 'pending';
      const items = Array.isArray(raw.items) ? raw.items.map(entry => {
        const detail = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
        return { name: String(detail.name || '').trim().slice(0, 120), qty: Math.max(1, Math.floor(Number(detail.qty) || 1)) };
      }).filter(entry => entry.name).slice(0, 50) : undefined;
      return {
        id: String(raw.id || '').trim().slice(0, 80),
        status,
        total: String(raw.total || '').trim().slice(0, 80),
        createdAt: String(raw.createdAt || '').trim().slice(0, 40),
        ...(items?.length ? { items } : {}),
      } as StoredCustomerOrder;
    }).filter(order => order.id && order.total).slice(0, 200);
  }

  next.updatedAt = new Date().toISOString();
  list[index] = next;
  writeCustomers(list);
  void mirrorCustomerToPocketBase(next).catch(error => console.error('[whatsapp-pb-customer]', error));
  return next;
}

export function getWhatsAppCustomers(tenantId?: string): any[] {
  const allCustomers = customers().filter(customer =>
    (!tenantId || customer.tenantId === tenantId) && isRealWhatsAppNumber(customer.waNumber));
  const allInteractions = interactions();
  return allCustomers.map(customer => {
    const timeline = allInteractions
      .filter(item => item.tenantId === customer.tenantId && item.customerId === customer.id)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(item => ({
        id: item.id,
        type: item.type === 'system' ? 'system' : 'whatsapp',
        actor: item.type === 'msg_in' ? 'buyer' : item.type === 'msg_out_ai' ? 'ai' : item.type === 'system' ? 'owner' : 'seller',
        title: item.type === 'msg_in' ? '客户消息' : item.type === 'msg_out_ai' ? 'AI 自动回复' : item.type === 'system' ? '系统记录' : '销售回复',
        body: item.body,
        time: new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: item.timestamp,
        autoSent: item.autoSent,
        translatedBody: typeof item.audit?.translatedDraft === 'string' ? item.audit.translatedDraft : undefined,
        audit: item.audit,
      }));
    const priority = prioritizeCustomer({
      ...customer,
      orders: customer.orders ?? [],
      estimatedValue: '$0',
    }).priorityScore;
    const inferredRegion = inferPhoneRegion(customer.waNumber);
    const timeZone = customer.timeZone || inferredRegion.timeZone;
    const timeZoneSource = customer.timeZone
      ? (customer.timeZoneSource || 'customer_profile')
      : inferredRegion.timeZone
        ? 'phone_country_default'
        : undefined;
    const lastTimelineEvent = timeline.at(-1);
    return {
      id: customer.id,
      name: customer.name,
      whatsappProfileName: customer.whatsappProfileName,
      avatar: (customer.name[0] || 'W').toUpperCase(),
      countryName: customer.countryName || inferredRegion.countryName || '未知',
      email: undefined,
      language: customer.language,
      languageLocked: Boolean(customer.languageLocked),
      source: normalizedCustomerSource(customer.source),
      sourcePostId: customer.sourcePostId,
      sourceTrackCode: customer.sourceTrackCode,
      sourcePostTitle: customer.sourcePostTitle,
      sourcePostPlatform: customer.sourcePostPlatform,
      softAttribution: customer.softAttribution,
      product: 'WhatsApp 询盘',
      outboundProduct: 'current WhatsApp inquiry',
      estimatedValue: '$0',
      stage: customer.stage,
      intentScore: customer.intentScore,
      intentSignals: [
        '真实 WhatsApp 消息',
        customer.bant?.band === 'black'
          ? '信息待核实'
          : customer.bant?.level === 'hot'
          ? '高价值商机'
          : customer.bant?.level === 'qualified'
          ? '值得重点跟进'
          : customer.bant
          ? '继续了解需求'
          : '意向待判断',
        customer.blockedAutoReplyReason ? '自动回复已拦截' : `推进：${customer.progressionGoal?.label || '待识别'}`,
      ],
      bant: customer.bant,
      progressionGoal: customer.progressionGoal,
      spinGuidance: customer.spinGuidance,
      handlingMode: customer.handlingMode,
      handlingReason: customer.handlingReason,
      aiAutoCount: customer.aiAutoCount,
      needCall: Boolean(customer.needCall),
      hasUnread: customer.hasUnread ?? lastTimelineEvent?.actor === 'buyer',
      isReal: true,
      waNumber: customer.waNumber,
      blockedAutoReplyReason: customer.blockedAutoReplyReason,
      pendingDraft: customer.pendingDraft,
      knowledgeMissStreak: customer.knowledgeMissStreak,
      fallbackCount: customer.fallbackCount,
      handoffDueAt: customer.handoffDueAt,
      priority,
      inboxReason: customer.handlingMode === 'human_needed' ? 'reply' : customer.handlingMode === 'ai_draft' ? 'draft' : 'reply',
      lastActive: '刚刚',
      lastActiveAt: customer.lastActiveAt,
      localTime: currentLocalTime(timeZone),
      timeZone,
      timeZoneSource,
      orders: customer.orders ?? [],
      tags: customer.tags ?? ['真实WhatsApp', customer.handlingMode === 'ai_auto' ? 'AI接待' : '待处理'],
      todoCompletedAt: customer.todoCompletedAt,
      summary: customer.handlingReason,
      nextStep: customer.pendingDraft || '继续跟进客户最新消息。',
      timeline,
    };
  });
}

export function getWhatsAppKnowledgeSamples(
  tenantId: string,
  options: { maxConversations?: number; maxMessages?: number; sinceDays?: number } = {},
): KnowledgeConversationSample[] {
  const maxConversations = Math.max(1, Math.min(120, options.maxConversations ?? 60));
  const maxMessages = Math.max(20, Math.min(800, options.maxMessages ?? 500));
  const since = Date.now() - Math.max(1, options.sinceDays ?? 180) * 86_400_000;
  const grouped = new Map<string, KnowledgeConversationSample['messages']>();

  interactions()
    .filter(item => item.tenantId === tenantId && item.timestamp >= since && item.type !== 'system' && item.body.trim())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxMessages)
    .forEach(item => {
      const current = grouped.get(item.customerId) ?? [];
      current.push({
        actor: item.type === 'msg_in' ? 'buyer' : 'seller',
        body: item.body
          .replace(/\+?\d[\d\s().-]{7,}\d/g, '[电话号码]')
          .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
          .replace(/\b\d{5,}\b/g, '[编号]')
          .slice(0, 800),
        timestamp: item.timestamp,
      });
      grouped.set(item.customerId, current);
    });

  return Array.from(grouped.entries())
    .slice(0, maxConversations)
    .map(([customerId, messages]) => ({
      customerId,
      messages: messages.sort((a, b) => a.timestamp - b.timestamp).slice(-30),
    }))
    .filter(sample => sample.messages.some(message => message.actor === 'buyer'));
}

export function getWhatsAppWinningStyleSamples(tenantId: string, maxSamples = 200): WinningStyleSample[] {
  const wonCustomerIds = new Set(customers()
    .filter(customer => customer.tenantId === tenantId && (
      customer.stage === 'won' || (customer.orders ?? []).some(order => order.status === 'paid')
    ))
    .map(customer => customer.id));
  if (!wonCustomerIds.size) return [];
  const grouped = new Map<string, StoredInteraction[]>();
  interactions()
    .filter(item => item.tenantId === tenantId && wonCustomerIds.has(item.customerId) && item.type !== 'system')
    .sort((left, right) => left.timestamp - right.timestamp)
    .forEach(item => {
      const list = grouped.get(item.customerId) ?? [];
      list.push(item);
      grouped.set(item.customerId, list);
    });

  const samples: WinningStyleSample[] = [];
  for (const [customerId, items] of grouped) {
    let latestBuyer = '';
    for (const item of items) {
      if (item.type === 'msg_in') latestBuyer = item.body;
      if (item.type === 'msg_out_human' && latestBuyer && item.body.trim()) {
        samples.push({ customerId, buyer: latestBuyer, seller: item.body });
      }
    }
  }
  return samples.slice(-Math.max(1, Math.min(500, maxSamples)));
}

/** Signed HTTP ingress calls only this after signature validation and owned metadata filtering.
 * It persists messages and local qualification; never runs autonomy or sends a reply. */
export async function handleVerifiedWhatsAppInbound(tenantId:string,payload:any,binding:{appId:string;phoneNumberId:string;wabaId:string}):Promise<void>{
 if(!(Array.isArray(payload?.entry)?payload.entry:[]).some((entry:any)=>(Array.isArray(entry?.changes)?entry.changes:[]).some((change:any)=>change?.field==='messages'&&Array.isArray(change.value?.messages)&&change.value.messages.length)))return;
 const proof=await readCanonicalWhatsAppAccount(store,tenantId,binding.appId);
 if(proof.nativeAccountId!==binding.phoneNumberId||proof.wabaId!==binding.wabaId||payload?.object!=='whatsapp_business_account')throw Error('whatsapp_verified_ingress_scope_invalid');
 for(const entry of Array.isArray(payload.entry)?payload.entry:[]){if(String(entry?.id)!==proof.wabaId)throw Error('whatsapp_verified_ingress_waba_invalid');for(const change of Array.isArray(entry.changes)?entry.changes:[]){if(change?.field!=='messages')continue;const value=change.value;if(String(value?.metadata?.phone_number_id)!==proof.nativeAccountId)throw Error('whatsapp_verified_ingress_phone_invalid');
  for(const raw of Array.isArray(value.messages)?value.messages:[]){if(typeof raw.id!=='string'||!raw.id.startsWith('wamid.')||typeof raw.from!=='string'||!/^\d{6,20}$/.test(raw.from)||!/^\d+$/.test(String(raw.timestamp??''))||Number(raw.timestamp)<=0||raw.mock||raw.synthetic||raw.simulated||raw.from_me||raw.from_business||raw.direction==='outbound')continue;const parsed=messagesFromValue({...value,messages:[raw],history:undefined});for(const message of parsed){if(message.id!==raw.id||message.fromBusiness||!Number.isFinite(message.timestamp)||message.timestamp<=0||message.timestamp>Date.now())continue;await handleInboundMessage(tenantId,{...message,canonicalAccount:{accountId:proof.accountId,phoneNumberId:proof.nativeAccountId,wabaId:proof.wabaId}},{skipAutonomy:true});const saved=interactions().find(v=>v.tenantId===tenantId&&v.metaMessageId===message.id&&v.audit?.phoneNumberId===proof.nativeAccountId);if(!saved)throw Error('whatsapp_verified_ingress_persistence_missing');await mirrorInteractionToPocketBase(saved);const customer=customers().find(v=>v.tenantId===tenantId&&v.id===saved.customerId);if(customer)await mirrorCustomerToPocketBase(customer);}}
 }}
}
