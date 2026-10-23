import { markStyleMemoryWonForCustomer } from '../knowledge/styleMemory.js';
import { attributionSystemText, findPostById, incrementPostMetric, sourceFromPost } from '../publishing/waLink.js';
import { customers, interactions, mirrorCustomerToPocketBase, mirrorInteractionToPocketBase, whatsappInteractionProviderId, writeCustomers, writeInteractions } from './historyPersistence.js';
import { detectLanguage, inferPhoneRegion, stageByTimestamp } from './historyPolicy.js';
import type { StoredCustomer, StoredInteraction } from './historyImport.js';

export function customerId(tenantId: string, waNumber: string): string {
  return `wa_${tenantId}_${waNumber}`.replace(/[^\w-]/g, '_');
}

export function upsertCustomer(input: { tenantId: string; waNumber: string; name?: string; body?: string; lastActiveAt?: number; patch?: Partial<StoredCustomer> }): StoredCustomer {
  const list = customers();
  const id = customerId(input.tenantId, input.waNumber);
  const now = new Date().toISOString();
  const index = list.findIndex(item => item.tenantId === input.tenantId && item.id === id);
  const lastActiveAt = input.lastActiveAt ?? Date.now();
  const inferredRegion = inferPhoneRegion(input.waNumber);
  const base: StoredCustomer = index >= 0 ? list[index] : {
    id,
    tenantId: input.tenantId,
    waNumber: input.waNumber,
    name: input.name || input.waNumber,
    whatsappProfileName: input.name || undefined,
    language: detectLanguage(input.body || ''),
    countryName: inferredRegion.countryName,
    timeZone: inferredRegion.timeZone,
    timeZoneSource: inferredRegion.timeZone ? 'phone_country_default' : undefined,
    stage: stageByTimestamp(lastActiveAt),
    handlingMode: 'ai_draft',
    handlingReason: 'WhatsApp 新询盘已进入待确认',
    intentScore: 45,
    lastActiveAt,
    createdAt: now,
    updatedAt: now,
    aiAutoCount: 0,
  };
  const next: StoredCustomer = {
    ...base,
    ...input.patch,
    name: input.name || base.name,
    whatsappProfileName: input.name || base.whatsappProfileName,
    language: base.languageLocked ? base.language : (input.body ? detectLanguage(input.body) : base.language || detectLanguage('')),
    stage: stageByTimestamp(lastActiveAt),
    lastActiveAt: Math.max(base.lastActiveAt, lastActiveAt),
    updatedAt: now,
  };
  if (index >= 0) list[index] = next;
  else list.push(next);
  writeCustomers(list);
  if (next.stage === 'won' && base.stage !== 'won') {
    void markStyleMemoryWonForCustomer(next.tenantId, next.id).catch(error => console.error('[style-memory:won]', error));
    if (next.sourcePostId) {
      void incrementPostMetric(next.sourcePostId, 'deals').catch(error => console.error('[post-attribution:deal]', error));
    }
  }
  void mirrorCustomerToPocketBase(next).catch(error => console.error('[whatsapp-pb-customer]', error));
  return next;
}
export function addInteraction(item: StoredInteraction): boolean {
  const list = interactions();
  const providerId = whatsappInteractionProviderId(item);
  const exists = list.some(existing => existing.tenantId === item.tenantId && (existing.id === item.id || (providerId && String(existing.audit?.phoneNumberId||'')===String(item.audit?.phoneNumberId||'') && whatsappInteractionProviderId(existing) === providerId)));
  if (exists) return false;
  list.push(item);
  list.sort((a, b) => a.timestamp - b.timestamp);
  writeInteractions(list);
  void mirrorInteractionToPocketBase(item).catch(error => console.error('[whatsapp-pb-interaction]', error));
  return true;
}

export async function confirmCustomerSourceAttribution(input: { tenantId: string; customerId: string; postId: string }): Promise<StoredCustomer | null> {
  const post = await findPostById(input.postId);
  if (!post || post.tenant_id !== input.tenantId) return null;
  const list = customers();
  const index = list.findIndex(item => item.tenantId === input.tenantId && item.id === input.customerId);
  if (index < 0) return null;
  const existing = list[index];
  const next: StoredCustomer = {
    ...existing,
    source: sourceFromPost(post),
    sourcePostId: post.id,
    sourceTrackCode: post.track_code,
    sourcePostTitle: post.title,
    sourcePostPlatform: post.platform,
    softAttribution: undefined,
    updatedAt: new Date().toISOString(),
  };
  list[index] = next;
  writeCustomers(list);
  await mirrorCustomerToPocketBase(next).catch(error => console.error('[whatsapp-pb-customer]', error));
  await incrementPostMetric(post.id, 'inquiries').catch(error => console.error('[post-attribution:confirm]', error));
  addInteraction({
    id: `attr_${input.customerId}_${post.id}_${Date.now()}`,
    tenantId: input.tenantId,
    customerId: input.customerId,
    waNumber: next.waNumber,
    type: 'system',
    body: attributionSystemText(post),
    timestamp: Date.now(),
    audit: { sourcePostId: post.id, trackCode: post.track_code, platform: post.platform, confirmed: true },
    meta: { sourcePostId: post.id, trackCode: post.track_code, platform: post.platform, confirmed: true },
  });
  return next;
}
