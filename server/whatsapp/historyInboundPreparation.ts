import { evaluateHandoff } from '../sales/handoff.js';
import type { RetrievedContext } from '../knowledge/retrieve.js';
import type { ProgressionGoal } from '../sales/qualification.js';
import type { SpinGuidance } from '../sales/spin.js';
import type { EnterpriseProfile } from '../routes/enterprise.js';
import { interactions } from './historyPersistence.js';
import { currentLocalTime, inferPhoneRegion, text, timestamp } from './historyPolicy.js';
import type { IncomingContact, IncomingMessage, StoredCustomer } from './historyImport.js';

export function collectChanges(payload: any): any[] {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  return entries.flatMap((entry: any) => Array.isArray(entry?.changes) ? entry.changes : []);
}

function contactFromMeta(raw: any): IncomingContact | null {
  const waNumber = text(raw?.wa_id || raw?.waNumber || raw?.phone_number || raw?.phone || raw?.id);
  if (!waNumber) return null;
  const name = text(raw?.profile?.name || raw?.name || raw?.first_name);
  return { waNumber, name };
}

export function messagesFromValue(value: any): IncomingMessage[] {
  const contacts = new Map<string, string>();
  for (const raw of Array.isArray(value?.contacts) ? value.contacts : []) {
    const contact = contactFromMeta(raw);
    if (contact) contacts.set(contact.waNumber, contact.name || contact.waNumber);
  }

  const rawMessages = [
    ...(Array.isArray(value?.messages) ? value.messages : []),
    ...(Array.isArray(value?.history?.messages) ? value.history.messages : []),
    ...(Array.isArray(value?.history) ? value.history.flatMap((chunk: any) => Array.isArray(chunk?.messages) ? chunk.messages : []) : []),
  ];

  return rawMessages.map((message: any) => {
    const waNumber = text(message.from || message.to || message.wa_id || message.recipient_id);
    const media = message.audio || message.voice || message.image || message.video || message.document || message.sticker;
    const mediaType = message.audio || message.voice
      ? '\u8bed\u97f3\u6d88\u606f'
      : message.image
        ? '\u56fe\u7247\u6d88\u606f'
        : message.video
          ? '\u89c6\u9891\u6d88\u606f'
          : message.document
            ? '\u6587\u4ef6\u6d88\u606f'
            : message.sticker
              ? '\u8868\u60c5\u6d88\u606f'
              : '';
    const mediaId = text(media?.id);
    const mediaLink = mediaId ? `https://graph.facebook.com/v19.0/${mediaId}` : '';
    const body = text(message?.text?.body || message?.body || message?.message?.text)
      || (mediaType ? `[${mediaType}]${mediaLink ? ` ${mediaLink}` : ''}` : '');
    if (!waNumber || !body) return null;
    return {
      id: text(message.id) || `${waNumber}-${timestamp(message.timestamp)}`,
      waNumber,
      name: contacts.get(waNumber),
      fromBusiness: Boolean(message.from_me || message.direction === 'outbound' || message.from_business),
      body,
      timestamp: timestamp(message.timestamp),
    } as IncomingMessage;
  }).filter(Boolean) as IncomingMessage[];
}

export function contactsFromValue(value: any): IncomingContact[] {
  const direct = Array.isArray(value?.contacts) ? value.contacts : [];
  const nested = Array.isArray(value?.smb_app_state_sync?.contacts) ? value.smb_app_state_sync.contacts : [];
  return [...direct, ...nested].map(contactFromMeta).filter(Boolean) as IncomingContact[];
}

export function inferActionFromText(body: string): string {
  if (/\b(can we (talk|call)|call me|phone call|voice call|speak to|talk with|talk to manager)\b|电话|通话|语音|加个微信聊|找经理聊/i.test(body)) return 'call_request';
  if (/\b(price|quote|quotation|discount|payment|deposit|delivery time|lead time)\b|报价|价格|付款|定金|交期|折扣/i.test(body)) return 'formal_quote';
  if (/\b(catalog|catalogue|brochure|collections?)\b|目录|产品册/i.test(body)) return 'auto_send_catalog';
  if (/\b(track|tracking|ship|shipping|logistics)\b|物流|运单|发货/i.test(body)) return 'auto_logistics_update';
  if (/\b(sample|after.?sale|warranty)\b|样品|售后|质保/i.test(body)) return 'auto_aftersale_confirm';
  return 'auto_faq_reply';
}

export function approvedFaqAnswer(context: RetrievedContext, message: string): string {
  if (!message || !context.faqMatch?.autoSafe) return '';
  return context.faqMatch.faq.approvedForAuto ? context.faqMatch.faq.a : '';
}

export function autoFaqLibraryReady(profile: EnterpriseProfile): boolean {
  return (profile.faq ?? []).filter(item => item.approvedForAuto && text(item.question) && text(item.answer)).length >= 5;
}

export function recentConversationForCustomer(tenantId: string, customerIdValue: string) {
  return interactions()
    .filter(item => item.tenantId === tenantId && item.customerId === customerIdValue && item.type !== 'system')
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-8)
    .map(item => ({
      role: item.type === 'msg_in' ? 'buyer' as const : 'seller' as const,
      text: item.body,
    }));
}

export function draftForMessage(message: IncomingMessage, context?: RetrievedContext, progressionGoal?: ProgressionGoal, spinGuidance?: SpinGuidance): string {
  // SPIN 陈述+提问优先于单条 BANT 推进问题，避免同一条草稿里出现两个互相竞争的问题。
  const followUpQuestion = spinGuidance ? `${spinGuidance.statement} ${spinGuidance.question}` : progressionGoal?.question;
  const product = context?.products?.[0];
  if (product) {
    const details = [
      product.sku ? `SKU ${product.sku}` : product.name,
      product.moq ? `MOQ ${product.moq}` : '',
      product.material ? `material ${product.material}` : '',
    ].filter(Boolean).join(', ');
    return `I found ${details}. ${followUpQuestion || 'What target quantity are you planning?'}`;
  }
  if (/\b(catalog|catalogue|brochure|collections?)\b|目录|产品册/i.test(message.body)) {
    return 'Which product line and target quantity are you interested in? I will use that to find the right approved information.';
  }
  if (/\b(track|tracking|ship|shipping|logistics)\b|物流|运单|发货/i.test(message.body)) {
    return 'Please send the order number and ordering account. I will pass those details to the person who can verify the real record.';
  }
  return followUpQuestion || 'Which product or model do you mean, and what detail matters most to you?';
}

export interface WinningStyleSample {
  customerId: string;
  buyer: string;
  seller: string;
}

export function handoffCustomerContext(customer: StoredCustomer) {
  const region = inferPhoneRegion(customer.waNumber);
  const timeZone = customer.timeZone || region.timeZone;
  const orderValue = (customer.orders ?? []).reduce((sum, order) => {
    const amount = Number(String(order.total || '').replace(/[^\d.]/g, ''));
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  return {
    id: customer.id,
    name: customer.name,
    waNumber: customer.waNumber,
    countryName: customer.countryName || region.countryName || '未知',
    localTime: currentLocalTime(timeZone),
    stage: customer.stage,
    estimatedValue: orderValue > 0 ? `$${Math.round(orderValue).toLocaleString('en-US')}` : '$0',
    intentScore: customer.intentScore,
    bant: customer.bant,
  };
}

export function evaluateCustomerHandoff(customer: StoredCustomer, input: Parameters<typeof evaluateHandoff>[0]) {
  const historicalOrderValue = (customer.orders ?? []).reduce((sum, order) => {
    const amount = Number(String(order.total || '').replace(/[^\d.]/g, ''));
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  return evaluateHandoff({
    ...input,
    historicalOrderValue,
    repeatCustomer: (customer.orders ?? []).some(order => order.status === 'paid'),
    bantTotal: input.bantTotal ?? customer.bant?.total ?? customer.intentScore,
  });
}
