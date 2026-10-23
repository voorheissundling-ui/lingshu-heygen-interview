import {readAuthorizedWhatsAppCustomers} from '../whatsapp/authorizedCustomerRead.js';
import {verifyWeeklyCustomerMemberProof} from '../socialPrograms/weeklyCustomerMemberProof.js';
import {readWeeklyCustomerRelationshipScope,verifyFrozenWeeklyCustomerRelationship,verifyLatestWeeklyCustomerSegment} from '../socialPrograms/weeklyCustomerRelationshipScope.js';
import { planMobileChatMessages } from '../agents/mobileChatStyle.js';
import { resolveTenantFollowupTemplate } from '../whatsapp/templates.js';
import { followupOutcome } from './executionDiagnostics.js';
import { randomUUID } from 'node:crypto';
import { guardOutbound } from '../autonomy/outboundGuard.js';
import { store } from '../storage/index.js';
import type { DataStore } from '../storage/datastore.js';
import { isRealWhatsAppNumber } from '../whatsapp/customerVisibility.js';
import { markWhatsAppHumanReply } from '../whatsapp/historyImport.js';
import { sendTenantWhatsAppTemplateWithReceipt, sendTenantWhatsAppTextWithReceipts } from '../whatsapp/send.js';
import {
  followupItemContentHash,
  getFollowupBatch,
  getFollowupBatchItems,
  type FollowupBatchItemRecord,
  type FollowupBatchRecord,
} from './customerWorkflow.js';
import { followupWorkerIntervalMs, followupWorkerMaxAttempts, followupWorkerMode } from './followupWorkerConfig.js';
import { nextFollowupDeliveryWindow } from './followupDeliveryWindow.js';
import type { FollowupDispatchPreflight } from './followupDispatchPresentation.js';
import { customerRiskReason, jsonObject, latestInboundAt, safeError, timestamp } from './followupDispatchHelpers.js';
import { digitalEmployeeRunBlockedReason, withDigitalEmployeeRunLock, withDigitalEmployeeExternalAction, WorkflowRunBlockedError } from './runControl.js';
import {
  readCustomerMessagingAuthorization,
  type CustomerMessagingAuthorization,
} from './customerMessagingPolicy.js';
import {
  assertLegacyExternalEffectAllowed,
  Starter198LegacyEffectError,
  withLegacyExternalEffectAllowed,
} from '../starter198/legacyEffectGuard.js';

type LegacyEffectExecutor = <T>(tenantId: string, effect: () => Promise<T>) => Promise<T>;

type StoredRecord = { id: string; [key: string]: unknown };

async function persistFollowupItem(id: string, patch: Record<string, unknown>): Promise<true> {
  if (!await store.update('followup_batch_items', id, patch)) throw new Error('followup_item_persistence_failed');
  return true;
}

export interface FollowupWorkerEvent {
  tenantId: string;
  runId: string;
  taskId: string;
  batchId: string;
  itemId?: string;
  customerId?: string;
  type: 'worker.claimed' | 'worker.sent' | 'worker.partial_sent' | 'worker.retry_scheduled' | 'worker.blocked' | 'worker.failed' | 'worker.receipt';
  level: 'info' | 'success' | 'warning' | 'error';
  summary: string;
  payload: Record<string, unknown>;
}

export interface FollowupDispatchResult {
  batchId: string;
  mode: 'scheduled' | 'manual';
  claimed: number;
  sent: number;
  partial: number;
  blocked: number;
  retryScheduled: number;
  failed: number;
  future: number;
  counts: Record<string, number>;
}

export type { FollowupDispatchPreflight } from './followupDispatchPresentation.js';
export { followupDispatchPreflightFacts, followupDispatchPreflightBlockedReason } from './followupDispatchPresentation.js';

interface DispatchDependencies {
  now: () => Date;
  resolveTemplate: typeof resolveTenantFollowupTemplate;
  sendText: typeof sendTenantWhatsAppTextWithReceipts;
  sendTemplate: typeof sendTenantWhatsAppTemplateWithReceipt;
  customers: (tenantId: string) => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>;
  guard: typeof guardOutbound;
  recordOutbound: typeof markWhatsAppHumanReply;
  authorization: (tenantId: string) => Promise<CustomerMessagingAuthorization>;
  recipientDelayMs: number;
  assertLegacyAccess: (tenantId: string) => Promise<void>;
  executeLegacyEffect: LegacyEffectExecutor;
  nativeAuthorization: (tenantId: string, channel: 'messenger' | 'instagram') => Promise<CustomerMessagingAuthorization>;
  nativePreflight: (input: Parameters<NativeScheduledService['preflightScheduled']>[0]) => ReturnType<NativeScheduledService['preflightScheduled']>;
}

const listeners = new Set<(event: FollowupWorkerEvent) => void | Promise<void>>();
const batchQueues = new Map<string, Promise<void>>();
let interval: ReturnType<typeof setInterval> | null = null;
let scanRunning = false;

// Pure value parsing and customer-risk classification live outside the dispatch loop.

export { nextFollowupDeliveryWindow } from './followupDeliveryWindow.js';


async function runtimeSafety(tenantId: string, item: FollowupBatchItemRecord, now: Date, dependencies: DispatchDependencies, rawDeliveryPolicy: unknown): Promise<{ allowed: boolean; reason: string; customer?: Record<string, unknown> }> {
  const digits = String(item.wa_number || '').replace(/\D/g, '');
  if (!isRealWhatsAppNumber(item.wa_number) || digits.length < 7 || digits.length > 15) return { allowed: false, reason: 'invalid_whatsapp_number' };
  if (item.risk_level === 'high') return { allowed: false, reason: 'high_risk_requires_individual_review' };
  const customer = (await dependencies.customers(tenantId)).find(candidate => String(candidate.id || '') === item.customer_id);
  if (!customer) return { allowed: false, reason: 'customer_no_longer_available' };
  if (String(customer.waNumber || '') !== item.wa_number) return { allowed: false, reason: 'customer_whatsapp_number_changed' };
  const customerRisk = customerRiskReason(customer);
  if (customerRisk) return { allowed: false, reason: customerRisk };
  const deliveryPolicy = jsonObject(rawDeliveryPolicy);
  const contactWindowDays = Math.max(1, Math.min(365, Number(deliveryPolicy.contactWindowDays || 7)));
  const maxContacts = Math.max(1, Math.min(20, Number(deliveryPolicy.maxContactsPerWindow || 1)));
  const priorItems = await store.list<FollowupBatchItemRecord>('followup_batch_items', {
    where: { tenant_id: tenantId, customer_id: item.customer_id }, sort: '-sent_at', page: 1, perPage: 100,
  });
  const cutoff = now.getTime() - contactWindowDays * 86_400_000;
  const recentContacts = priorItems.items.filter(prior => (
    prior.id !== item.id
    && Boolean(prior.provider_message_id || prior.sent_at)
    && timestamp(prior.sent_at) >= cutoff
  )).length;
  if (recentContacts >= maxContacts) return { allowed: false, reason: 'contact_frequency_limit' };
  const guard = await dependencies.guard(item.draft_body, { tenantId, customerId: item.customer_id, action: 'digital_employee_batch_followup' });
  if (!guard.allowed) return { allowed: false, reason: `outbound_guard:${guard.matchedRule || 'blocked'}` };
  if (item.send_mode === 'session_message') {
    const inboundAt = latestInboundAt(customer);
    if (!inboundAt || now.getTime() - inboundAt >= 24 * 60 * 60 * 1000) return { allowed: false, reason: 'whatsapp_template_required' };
  } else if (item.send_mode === 'template') {
    if (!item.template_name || item.template_status !== 'approved') return { allowed: false, reason: 'approved_whatsapp_template_required' };
    const template = await dependencies.resolveTemplate(tenantId, item.template_name, item.template_language || 'en_US');
    if (!template || template.status !== 'APPROVED') return { allowed: false, reason: 'approved_whatsapp_template_required' };
    const variables = Array.isArray(item.template_variables) ? item.template_variables : [];
    if (variables.length !== template.variableCount || template.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => String(variables[Number(n)-1] || '')) !== item.draft_body) return { allowed: false, reason: 'whatsapp_template_content_changed' };
  } else {
    return { allowed: false, reason: 'unsupported_send_mode' };
  }
  return { allowed: true, reason: '', customer };
}

async function emit(event: FollowupWorkerEvent): Promise<void> {
  await Promise.allSettled([...listeners].map(listener => listener(event)));
}

export function onFollowupWorkerEvent(listener: (event: FollowupWorkerEvent) => void | Promise<void>): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function withBatchQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = batchQueues.get(key) || Promise.resolve();
  let release = () => {};
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  batchQueues.set(key, tail);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (batchQueues.get(key) === tail) batchQueues.delete(key);
  }
}

function receiptMessages(value: unknown): Array<Record<string, unknown>> {
  const receipt = jsonObject(value);
  return Array.isArray(receipt.messages) ? receipt.messages as Array<Record<string, unknown>> : [];
}

async function refreshBatchCounts(batch: FollowupBatchRecord): Promise<Record<string, number>> {
  const items = await getFollowupBatchItems(batch.tenant_id, batch.id);
  const count = (statuses: string[]) => items.filter(item => statuses.includes(String(item.status || ''))).length;
  const counts = {
    total: items.length,
    draft: count(['draft']),
    blocked: count(['blocked']),
    approved: count(['approved']),
    sending: count(['sending']),
    retryWaiting: count(['retry_wait']),
    partial: count(['partial_sent']),
    sent: count(['sent', 'delivered', 'read']),
    delivered: count(['delivered', 'read']),
    read: count(['read']),
    failed: count(['failed']),
  };
  const outcome = followupOutcome(items);
  let status = batch.status;
  if (items.some(i => jsonObject(i.provider_receipt).localHistoryPending)) status = 'needs_attention';
  else if (outcome.complete) status = 'completed';
  else if (outcome.settled) status = outcome.blocked ? 'needs_attention' : outcome.sent || outcome.partial ? 'partial_failed' : 'failed';
  await store.update('followup_batches', batch.id, { counts, status, updated_at: new Date().toISOString() });
  return counts;
}

/** A crashed sender may already have reached the provider. Never reclaim it as a fresh send. */
export async function recoverStaleFollowupSending(batch: FollowupBatchRecord, now = new Date(), recordOutbound: typeof markWhatsAppHumanReply = markWhatsAppHumanReply): Promise<number> {
  const items = await getFollowupBatchItems(batch.tenant_id, batch.id);
  let recovered = 0;
  for (const item of items) {
    if (['messenger', 'instagram'].includes(String(item.channel))) continue;
    const receipt = jsonObject(item.provider_receipt);
    if (receipt.localHistoryPending) {
      const accepted = receiptMessages(receipt);
      if (!accepted.length || accepted.some(m => !m.messageId)) continue;
      try {
        recordOutbound({ tenantId: batch.tenant_id, customerId: item.customer_id, waNumber: item.wa_number,
          body: accepted.map(m => String(m.body || '')).join('\n'), messages: accepted.map(m => String(m.body || '')),
          providerReceipts: accepted.map(m => ({ messageId: String(m.messageId), recipientId: String(m.recipientId || ''), raw: m.raw })) }, { preserveCustomerState: true });
        await persistFollowupItem(item.id, { provider_receipt: { ...receipt, localHistoryPending: false }, last_error: item.status === 'partial_sent' ? item.last_error : '', updated_at: now.toISOString() });
        recovered += 1;
      } catch { /* Preserve pending evidence and retry only local history on the next scan. */ }
    }
    if (item.status !== 'sending') continue;
    const claimed = timestamp(jsonObject(item.provider_receipt).claimedAt || item.updated_at);
    if (claimed && now.getTime() - claimed < 10 * 60_000) continue;
    await persistFollowupItem(item.id, {
      status: 'blocked', exclusion_reason: 'send_outcome_unknown',
      last_error: '发送进程中断或超过 10 分钟未回写，需人工核对平台回执，禁止自动重发。',
      updated_at: now.toISOString(),
    });
    recovered += 1;
  }
  if (recovered) await refreshBatchCounts(batch);
  return recovered;
}

async function dispatchTaskId(batch: FollowupBatchRecord): Promise<string> {
  const tasks = await store.list<StoredRecord>('workflow_tasks', { where: { tenant_id: batch.tenant_id, run_id: batch.run_id }, perPage: 100 });
  return String(tasks.items.find(task => task.task_key === 'followup_dispatch')?.id || batch.task_id);
}

function defaultDependencies(): DispatchDependencies {
  const delay = Number(process.env.FOLLOWUP_WORKER_RECIPIENT_DELAY_MS || 1000);
  return {
    now: () => new Date(),
    resolveTemplate: resolveTenantFollowupTemplate,
    sendText: sendTenantWhatsAppTextWithReceipts,
    sendTemplate: sendTenantWhatsAppTemplateWithReceipt,
    customers: tenantId => readAuthorizedWhatsAppCustomers(tenantId),
    guard: guardOutbound,
    recordOutbound: markWhatsAppHumanReply,
    authorization: tenantId => readCustomerMessagingAuthorization(tenantId, 'whatsapp'),
    recipientDelayMs: Number.isFinite(delay) ? Math.max(0, delay) : 1000,
    assertLegacyAccess: assertLegacyExternalEffectAllowed,
    executeLegacyEffect: withLegacyExternalEffectAllowed,
    nativeAuthorization: (tenantId, channel) => readCustomerMessagingAuthorization(tenantId, channel),
    nativePreflight: async input => {
      const { createWeeklyNativeFollowupDispatchService } = await import('./weeklyNativeFollowupDispatch.js');
      return createWeeklyNativeFollowupDispatchService(store).preflightScheduled(input);
    },
  };
}

/**
 * Read-only dispatch preflight. This deliberately performs no claims, status
 * updates, audit writes or provider calls, so operators can inspect the exact
 * approval/authorization/runtime blockers before authorizing a real send.
 */
export async function preflightFollowupBatchDispatch(
  tenantId: string,
  batchId: string,
  options: { mode?: 'scheduled' | 'manual'; dependencies?: Partial<DispatchDependencies> } = {},
): Promise<FollowupDispatchPreflight> {
  const mode = options.mode || 'manual';
  const dependencies = { ...defaultDependencies(), ...(options.dependencies || {}) } as DispatchDependencies;
  const batch = await getFollowupBatch(tenantId, batchId);
  if (!batch) throw new Error('followup_batch_not_found');

  const hasApprovalEvidence = Boolean(batch.approval_id) || batch.approved_by === 'approval_policy';
  const batchApproved = batch.status === 'approved'
    && Number(batch.approved_version || 0) === Number(batch.version || 0)
    && hasApprovalEvidence;
  const items = await getFollowupBatchItems(tenantId, batch.id);
  if (items.some(item => item.tenant_id !== tenantId || item.batch_id !== batch.id)) throw new Error('followup_scan_item_scope_invalid');
  const nativeItems = items.filter(item => ['messenger', 'instagram'].includes(String(item.channel)));
  const hasWhatsApp = !items.length || items.some(item => !item.channel || item.channel === 'whatsapp');
  const authorization = mode === 'scheduled' && !hasWhatsApp && nativeItems.length
    ? await dependencies.nativeAuthorization(tenantId, nativeItems[0]!.channel as 'messenger' | 'instagram')
    : await dependencies.authorization(tenantId);
  let authorized = mode === 'scheduled'
    ? authorization.scheduledFollowupSendAllowed
    : authorization.manualFollowupSendAllowed;
  const blockers: Record<string, number> = {};
  const addBlocker = (reason: string) => { blockers[reason] = (blockers[reason] || 0) + 1; };
  let legacyAccessBlocked = false;
  try {
    if (mode !== 'scheduled' || hasWhatsApp) await dependencies.assertLegacyAccess(tenantId);
  } catch (error) {
    if (!(error instanceof Starter198LegacyEffectError)) throw error;
    legacyAccessBlocked = true;
    addBlocker(error.code);
  }
  const runBlocker = await digitalEmployeeRunBlockedReason(tenantId, batch.run_id);
  if (runBlocker) addBlocker(runBlocker);
  if (!batchApproved) addBlocker('followup_batch_not_approved_for_current_version');
  if (!authorized && (mode !== 'scheduled' || hasWhatsApp)) {
    const relevantReasons = mode === 'manual'
      ? authorization.reasons.filter(reason => reason !== 'followup_background_worker_disabled')
      : authorization.reasons;
    (relevantReasons.length ? relevantReasons : ['customer_message_send_not_authorized']).forEach(addBlocker);
  }

  let eligible = 0;
  let blocked = 0;
  let future = 0;
  let skipped = 0;
  let nativeEligible = 0;
  let whatsappEligible = 0;
  const nativeScope = mode === 'scheduled' && nativeItems.length ? await readWeeklyCustomerRelationshipScope(store, tenantId, batch.run_id) : null;
  for (const item of items) {
    if (['messenger', 'instagram'].includes(String(item.channel))) {
      if (mode !== 'scheduled') { blocked += 1; addBlocker('weekly_native_explicit_dispatch_required'); continue; }
      if (!nativeScope) { blocked += 1; addBlocker('weekly_native_dispatch_week_binding_missing'); continue; }
      const result = await dependencies.nativePreflight({ tenantId, batchId, itemId: item.id, expectedBatchVersion: batch.version, expectedItemHash: item.content_hash, expectedScope: { runId: batch.run_id, programId: nativeScope.programId, packageId: nativeScope.packageId, packageVersion: nativeScope.packageVersion } });
      if (result.status === 'eligible') { eligible += 1; nativeEligible += 1; }
      else if (result.status === 'future') future += 1;
      else { blocked += 1; addBlocker(result.code ?? 'weekly_native_dispatch_preflight_failed'); }
      continue;
    }
    if (item.channel && item.channel !== 'whatsapp') { blocked += 1; addBlocker('unsupported_customer_channel'); continue; }
    if (['blocked', 'partial_sent', 'failed', 'rejected'].includes(item.status)) { blocked += 1; addBlocker(item.exclusion_reason || `followup_item_${item.status}`); continue; }
    if (!['approved', 'retry_wait'].includes(item.status)) { skipped += 1; continue; }
    const now = dependencies.now();
    if (timestamp(item.scheduled_at) > now.getTime()) { future += 1; continue; }
    if (nextFollowupDeliveryWindow(item.time_zone, batch.delivery_policy, now).getTime() > now.getTime()) {
      future += 1;
      continue;
    }
    if (followupItemContentHash(item) !== item.content_hash) {
      blocked += 1;
      addBlocker('draft_content_hash_changed');
      continue;
    }
    const safety = await runtimeSafety(tenantId, item, now, dependencies, batch.delivery_policy);
    if (!safety.allowed) {
      blocked += 1;
      addBlocker(safety.reason);
      continue;
    }
    eligible += 1;
    whatsappEligible += 1;
  }
  const whatsappAuthorized = authorized;
  if (mode === 'scheduled' && nativeEligible > 0) authorized = true;
  if (!eligible && !future && !blocked) addBlocker('no_dispatchable_items');
  return {
    batchId,
    mode,
    ready: !runBlocker && batchApproved && (mode === 'scheduled'
      ? nativeEligible > 0 || (!legacyAccessBlocked && whatsappAuthorized && whatsappEligible > 0)
      : !legacyAccessBlocked && authorized && eligible > 0),
    batchApproved,
    authorized,
    eligible,
    blocked,
    future,
    skipped,
    blockers,
    authorization,
  };
}

export async function dispatchFollowupBatch(
  tenantId: string,
  batchId: string,
  options: { mode?: 'scheduled' | 'manual'; dependencies?: Partial<DispatchDependencies> } = {},
): Promise<FollowupDispatchResult> {
  return withBatchQueue(`${tenantId}:${batchId}`, async () => {
    const dependencies = { ...defaultDependencies(), ...(options.dependencies || {}) } as DispatchDependencies;
    await dependencies.assertLegacyAccess(tenantId);
    return dependencies.executeLegacyEffect(tenantId, async () => {
    const batch = await getFollowupBatch(tenantId, batchId);
    if (!batch) throw new Error('followup_batch_not_found');
    await recoverStaleFollowupSending(batch, dependencies.now(), dependencies.recordOutbound);
    const hasApprovalEvidence = Boolean(batch.approval_id) || batch.approved_by === 'approval_policy';
    if (batch.status !== 'approved' || Number(batch.approved_version || 0) !== Number(batch.version || 0) || !hasApprovalEvidence) {
      throw new Error('followup_batch_not_approved_for_current_version');
    }
    const runBlocker = await digitalEmployeeRunBlockedReason(tenantId, batch.run_id);
    if (runBlocker) throw new WorkflowRunBlockedError(runBlocker);
    const authorization = await dependencies.authorization(tenantId);
    const authorized = options.mode === 'scheduled'
      ? authorization.scheduledFollowupSendAllowed
      : authorization.manualFollowupSendAllowed;
    if (!authorized) {
      const reason = authorization.reasons.find(item => item !== 'followup_background_worker_disabled')
        || authorization.reasons[0]
        || 'customer_message_send_not_authorized';
      throw new Error(`customer_message_send_not_authorized:${reason}`);
    }
    const eventTaskId = await dispatchTaskId(batch);
    const result: FollowupDispatchResult = {
      batchId, mode: options.mode || 'manual', claimed: 0, sent: 0, partial: 0, blocked: 0, retryScheduled: 0, failed: 0, future: 0, counts: {},
    };
    const items = await getFollowupBatchItems(tenantId, batch.id);
    for (const listedItem of items) {
      if (['messenger', 'instagram'].includes(String(listedItem.channel))) { result.blocked += 1; continue; }
      if (!['approved', 'retry_wait'].includes(listedItem.status)) continue;
      const now = dependencies.now();
      if (timestamp(listedItem.scheduled_at) > now.getTime()) { result.future += 1; continue; }
      const item = await store.getById<FollowupBatchItemRecord>('followup_batch_items', listedItem.id);
      if (!item || item.tenant_id !== tenantId || item.batch_id !== batch.id || !['approved', 'retry_wait'].includes(item.status)) continue;
      const safeWindow = nextFollowupDeliveryWindow(item.time_zone, batch.delivery_policy, now);
      if (safeWindow.getTime() > now.getTime()) {
        await persistFollowupItem(item.id, { scheduled_at: safeWindow.toISOString(), updated_at: now.toISOString() });
        result.future += 1;
        continue;
      }
      if (followupItemContentHash(item) !== item.content_hash) {
        await persistFollowupItem(item.id, { status: 'blocked', exclusion_reason: 'draft_content_hash_changed', updated_at: now.toISOString() });
        result.blocked += 1;
        continue;
      }
      try{const scope=await readWeeklyCustomerRelationshipScope(store,tenantId,batch.run_id);if(scope){const member=await store.getById<Record<string,unknown>>('customer_segment_members',item.segment_member_id);if(!member||member.tenant_id!==tenantId||member.customer_id!==item.customer_id||member.segment_id!==batch.segment_id||member.membership!=='included')throw Error('weekly_customer_relationship_member_invalid');await verifyWeeklyCustomerMemberProof(store,scope,item.customer_id,member.customer_snapshot);await verifyLatestWeeklyCustomerSegment(store,scope,batch.segment_id);}}catch(error){const reason=error instanceof Error?error.message:'weekly_customer_relationship_evidence_unverified';await persistFollowupItem(item.id,{status:'blocked',exclusion_reason:reason,updated_at:now.toISOString()});result.blocked+=1;continue;}
      const safety = await runtimeSafety(tenantId, item, now, dependencies, batch.delivery_policy);
      if (!safety.allowed) {
        await persistFollowupItem(item.id, { status: 'blocked', exclusion_reason: safety.reason, last_error: '', updated_at: now.toISOString() });
        result.blocked += 1;
        await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, customerId: item.customer_id, type: 'worker.blocked', level: 'warning', summary: `${item.customer_name || '客户'} 跟进已被发送前安全检查拦截`, payload: { reason: safety.reason } });
        continue;
      }

      const approvedContentHash = item.content_hash;
      const approvedBatchVersion = Number(batch.version);
      const attempt = Number(item.attempts || 0) + 1;
      const previousStatus = item.status;
      const previousReceipt = item.provider_receipt;
      const claimToken = randomUUID();
      const claimedAt = now.toISOString();
      const claimReceipt = { ...jsonObject(item.provider_receipt), claimToken, claimedAt, workerMode: options.mode || 'manual',
        approvedBatchVersion, approvedContentHash,
        expectedMessages: item.send_mode === 'template' ? [item.draft_body] : planMobileChatMessages(item.draft_body).messages };
      if (!await persistFollowupItem(item.id, {
        status: 'sending', attempts: attempt, last_error: '',
        provider_receipt: claimReceipt,
        updated_at: claimedAt,
      })) throw new Error('无法保存发送尝试，尚未调用 WhatsApp');
      result.claimed += 1;
      await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, customerId: item.customer_id, type: 'worker.claimed', level: 'info', summary: `${item.customer_name || '客户'} 跟进已进入真实发送`, payload: { attempt, idempotencyKey: item.idempotency_key } });

      const accepted: Array<Record<string, unknown>> = receiptMessages(item.provider_receipt);
      let providerComplete = false;
      try {
        await withDigitalEmployeeExternalAction(tenantId, batch.run_id, async () => {
        await dependencies.assertLegacyAccess(tenantId);
        const currentBatch = await getFollowupBatch(tenantId, batch.id);
        const currentItem = await store.getById<FollowupBatchItemRecord>('followup_batch_items', item.id);
        if (!currentBatch || currentBatch.status !== 'approved' || Number(currentBatch.version) !== approvedBatchVersion || Number(currentBatch.approved_version) !== approvedBatchVersion || !currentItem || currentItem.content_hash !== approvedContentHash) {
          throw new WorkflowRunBlockedError('followup_approval_changed_before_send');
        }
        const relationScope=await readWeeklyCustomerRelationshipScope(store,tenantId,batch.run_id);if(relationScope){const member=await store.getById<Record<string,unknown>>('customer_segment_members',item.segment_member_id);if(!member||member.tenant_id!==tenantId||member.customer_id!==item.customer_id||member.segment_id!==currentBatch.segment_id||member.membership!=='included')throw new WorkflowRunBlockedError('weekly_customer_relationship_member_invalid');await verifyWeeklyCustomerMemberProof(store,relationScope,item.customer_id,member.customer_snapshot);await verifyLatestWeeklyCustomerSegment(store,relationScope,currentBatch.segment_id);}
        if (item.send_mode === 'template') {
          const variables = Array.isArray(item.template_variables) ? item.template_variables.map(value => String(value || '')) : [];
          const receipt = await dependencies.sendTemplate({ tenantId, to: item.wa_number, templateName: item.template_name, languageCode: item.template_language || 'en_US', variables, callbackData: `followup:${claimToken}:0` });
          if (!receipt.messageId || String(receipt.recipientId || '').replace(/^\+/, '') !== item.wa_number.replace(/^\+/, '')) throw new Error('whatsapp_provider_receipt_identity_invalid');
          accepted.push({ index: 0, body: item.draft_body, messageId: receipt.messageId, recipientId: receipt.recipientId, raw: receipt.raw, acceptedAt: dependencies.now().toISOString() });
          providerComplete = true;
        } else {
          await dependencies.sendText(tenantId, item.wa_number, item.draft_body, async progress => {
            if (!progress.receipt.messageId || String(progress.receipt.recipientId || '').replace(/^\+/, '') !== item.wa_number.replace(/^\+/, '')) throw new Error('whatsapp_provider_receipt_identity_invalid');
            accepted.push({ index: progress.index, body: progress.message, messageId: progress.receipt.messageId, recipientId: progress.receipt.recipientId, raw: progress.receipt.raw, acceptedAt: dependencies.now().toISOString() });
            providerComplete = progress.total > 0 && progress.index + 1 === progress.total;
            await persistFollowupItem(item.id, {
              provider_message_id: String(accepted[0]?.messageId || ''),
              provider_receipt: { ...claimReceipt, status: 'accepting', messages: accepted },
              updated_at: dependencies.now().toISOString(),
            });
          }, index => `followup:${claimToken}:${index}`);
        }
        const sentAt = dependencies.now().toISOString();
        await persistFollowupItem(item.id, {
          status: 'sent', provider_message_id: String(accepted[0]?.messageId || ''),
          provider_receipt: { ...claimReceipt, status: 'accepted', messages: accepted, localHistoryPending: true },
          sent_at: sentAt, last_error: '', updated_at: sentAt,
        });
        dependencies.recordOutbound({ tenantId, customerId: item.customer_id, body: item.draft_body, messages: accepted.map(entry => String(entry.body || '')).filter(Boolean), waNumber: item.wa_number, providerReceipts: accepted.map(entry => ({ messageId: String(entry.messageId || ''), recipientId: String(entry.recipientId || ''), raw: entry.raw })) });
        await persistFollowupItem(item.id, { provider_receipt: { ...claimReceipt, status: 'accepted', messages: accepted, localHistoryPending: false } });
        result.sent += 1;
        await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, customerId: item.customer_id, type: 'worker.sent', level: 'success', summary: `${item.customer_name || '客户'} 跟进已被 WhatsApp 接受`, payload: { providerMessageIds: accepted.map(entry => entry.messageId), attempt } });
        });
      } catch (error) {
        if ((error instanceof WorkflowRunBlockedError || error instanceof Starter198LegacyEffectError) && !accepted.length) {
          // Human control won the lock before any provider call. Do not consume
          // an attempt, discard approval, or invent a failed/sent receipt.
          const reason = error instanceof WorkflowRunBlockedError ? error.reason : error.code;
          await persistFollowupItem(item.id, {
            status: reason === 'followup_approval_changed_before_send' ? 'draft' : previousStatus, attempts: attempt - 1, provider_receipt: previousReceipt,
            last_error: reason, updated_at: dependencies.now().toISOString(),
          });
          result.claimed -= 1;
          result.blocked += 1;
          await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, type: 'worker.blocked', level: 'warning', summary: '运行已停止，后续客户发送已暂停', payload: { reason } });
          break;
        }
        const failure = safeError(error);
        const failedAt = dependencies.now();
        if (providerComplete && accepted.length) {
          await persistFollowupItem(item.id, {
            status: 'sent', provider_message_id: String(accepted[0]?.messageId || ''),
            provider_receipt: { ...claimReceipt, status: 'accepted', messages: accepted, localHistoryPending: true },
            sent_at: failedAt.toISOString(), last_error: `local_followup_writeback_failed: ${failure.code}`, updated_at: failedAt.toISOString(),
          });
          result.sent += 1;
          await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, type: 'worker.receipt', level: 'warning', summary: '平台已接受全部跟进消息，本地历史回写需处理，不会重复发送', payload: { reason: 'local_followup_writeback_failed' } });
        } else if (accepted.length) {
          await persistFollowupItem(item.id, {
            status: 'partial_sent', provider_message_id: String(accepted[0]?.messageId || ''),
            provider_receipt: { ...claimReceipt, status: 'accepted_partial', messages: accepted, localHistoryPending: true },
            sent_at: failedAt.toISOString(), last_error: `${failure.code}: ${failure.message}`, updated_at: failedAt.toISOString(),
          });
          try {
          dependencies.recordOutbound({ tenantId, customerId: item.customer_id, body: accepted.map(entry => String(entry.body || '')).join('\n'), messages: accepted.map(entry => String(entry.body || '')), waNumber: item.wa_number, providerReceipts: accepted.map(entry => ({ messageId: String(entry.messageId || ''), recipientId: String(entry.recipientId || ''), raw: entry.raw })) });
            await persistFollowupItem(item.id, { provider_receipt: { ...claimReceipt, status: 'accepted_partial', messages: accepted, localHistoryPending: false } });
          } catch { /* The recorded pending flag is recovered without sending again. */ }
          result.partial += 1;
          await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, customerId: item.customer_id, type: 'worker.partial_sent', level: 'error', summary: `${item.customer_name || '客户'} 仅部分消息被 WhatsApp 接受，已停止自动重试`, payload: { providerMessageIds: accepted.map(entry => entry.messageId), errorCode: failure.code, attempt } });
        } else if (!jsonObject((error as { response?: unknown })?.response).status || Number(jsonObject((error as { response?: unknown })?.response).status) >= 500 || Number(jsonObject((error as { response?: unknown })?.response).status) === 408) {
          await persistFollowupItem(item.id, { status: 'blocked', exclusion_reason: 'send_outcome_unknown', last_error: `${failure.code}: ${failure.message}`, updated_at: failedAt.toISOString() });
          result.blocked += 1;
          await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, customerId: item.customer_id, type: 'worker.blocked', level: 'warning', summary: '发送结果不明，需核对平台回执；已停止自动重发', payload: { reason: 'send_outcome_unknown', attempt } });
        } else if (failure.retryable && attempt < followupWorkerMaxAttempts()) {
          const retryAt = new Date(failedAt.getTime() + Math.min(30 * 60_000, 30_000 * (2 ** (attempt - 1))));
          await persistFollowupItem(item.id, { status: 'retry_wait', scheduled_at: retryAt.toISOString(), last_error: `${failure.code}: ${failure.message}`, updated_at: failedAt.toISOString() });
          result.retryScheduled += 1;
          await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, customerId: item.customer_id, type: 'worker.retry_scheduled', level: 'warning', summary: `${item.customer_name || '客户'} 跟进发送失败，已安排安全重试`, payload: { errorCode: failure.code, attempt, retryAt: retryAt.toISOString() } });
        } else {
          await persistFollowupItem(item.id, { status: 'failed', last_error: `${failure.code}: ${failure.message}`, updated_at: failedAt.toISOString() });
          result.failed += 1;
          await emit({ tenantId, runId: batch.run_id, taskId: eventTaskId, batchId, itemId: item.id, customerId: item.customer_id, type: 'worker.failed', level: 'error', summary: `${item.customer_name || '客户'} 跟进发送失败`, payload: { errorCode: failure.code, attempt, retryable: failure.retryable } });
        }
      }
      if (dependencies.recipientDelayMs > 0) await new Promise(resolve => setTimeout(resolve, dependencies.recipientDelayMs));
    }
    result.counts = await refreshBatchCounts(batch);
    return result;
    });
  });
}

function metaStatuses(payload: unknown): Array<Record<string, unknown>> {
  const root = jsonObject(payload);
  const entries = Array.isArray(root.entry) ? root.entry as Array<Record<string, unknown>> : [];
  return entries.flatMap(entry => {
    const changes = Array.isArray(entry.changes) ? entry.changes as Array<Record<string, unknown>> : [];
    return changes.flatMap(change => {
      const value = jsonObject(change.value);
      return Array.isArray(value.statuses) ? value.statuses as Array<Record<string, unknown>> : [];
    });
  });
}

const RECEIPT_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export async function ingestFollowupDeliveryStatuses(tenantId: string, payload: unknown, options: { verifiedSignature?: boolean } = {}): Promise<number> {
  const statuses = metaStatuses(payload);
  if (!statuses.length) return 0;
  const allItems: { items: FollowupBatchItemRecord[] } = { items: [] };
  for (let page = 1; ; page += 1) {
    const batchPage = await store.list<FollowupBatchItemRecord>('followup_batch_items', { where: { tenant_id: tenantId }, page, perPage: 500, sort: '-updated_at' });
    allItems.items.push(...batchPage.items);
    if (!batchPage.items.length || page >= batchPage.totalPages) break;
  }
  let updated = 0;
  const touchedBatches = new Set<string>();
  for (const status of statuses) {
    const messageId = String(status.id || '');
    const nextStatus = String(status.status || '').toLowerCase();
    if (!messageId || !RECEIPT_RANK[nextStatus]) continue;
    let listed = allItems.items.find(candidate => candidate.provider_message_id === messageId || receiptMessages(candidate.provider_receipt).some(entry => entry.messageId === messageId));
    if (!listed && options.verifiedSignature) {
      const callback = String(status.biz_opaque_callback_data || '').match(/^followup:([0-9a-f-]{36}):(\d+)$/i);
      const candidate = callback && allItems.items.find(row => jsonObject(row.provider_receipt).claimToken === callback[1]);
      if (candidate) {
        const batch = await getFollowupBatch(tenantId, candidate.batch_id);
        if (batch) await withDigitalEmployeeRunLock(tenantId, batch.run_id, async () => {
          const fresh = await store.getById<FollowupBatchItemRecord>('followup_batch_items', candidate.id);
          if (!fresh || fresh.tenant_id !== tenantId) return;
          const receipt = jsonObject(fresh.provider_receipt);
          const expected = Array.isArray(receipt.expectedMessages) ? receipt.expectedMessages.map(String) : [];
          const index = Number(callback![2]);
          if (receipt.claimToken !== callback![1] || receipt.approvedContentHash !== fresh.content_hash
            || !Number.isInteger(index) || index >= expected.length || index < 0
            || String(status.recipient_id || '').replace(/\D/g, '') !== fresh.wa_number.replace(/\D/g, '')) return;
          const messages = receiptMessages(receipt);
          if (messages.some(entry => Number(entry.index) === index && entry.messageId !== messageId)) return;
          if (!messages.some(entry => entry.messageId === messageId)) messages.push({ index, messageId, body: expected[index], recipientId: status.recipient_id, acceptedAt: new Date().toISOString(), recoveredFromSignedWebhook: true });
          const complete = expected.length > 0 && expected.every((_, i) => messages.some(entry => Number(entry.index) === i));
          if (!await persistFollowupItem(fresh.id, {
            provider_message_id: String(messages[0]?.messageId || ''),
            provider_receipt: { ...receipt, messages, localHistoryPending: true },
            status: complete ? 'sent' : 'partial_sent',
            exclusion_reason: complete && fresh.exclusion_reason === 'send_outcome_unknown' ? '' : fresh.exclusion_reason,
            sent_at: fresh.sent_at || new Date().toISOString(), updated_at: new Date().toISOString(),
          })) throw new Error('无法保存恢复回执');
          listed = fresh;
        });
      }
    }
    if (!listed) continue;
    const owningBatch = await getFollowupBatch(tenantId, listed.batch_id);
    if (!owningBatch) continue;
    const listedId = listed.id;
    await withDigitalEmployeeRunLock(tenantId, owningBatch.run_id, async () => {
    const item = await store.getById<FollowupBatchItemRecord>('followup_batch_items', listedId);
    if (!item || item.tenant_id !== tenantId) return;
    const current = String(item.status || 'sent');
    const occurredAt = timestamp(status.timestamp) ? new Date(timestamp(status.timestamp)).toISOString() : new Date().toISOString();
    const receipt = jsonObject(item.provider_receipt);
    const receiptStatuses = Array.isArray(receipt.statuses) ? receipt.statuses as Array<Record<string, unknown>> : [];
    const priorMessageStatus = receiptStatuses
      .filter(entry => entry.messageId === messageId)
      .map(entry => String(entry.status || 'sent'))
      .sort((left, right) => (RECEIPT_RANK[right] || 0) - (RECEIPT_RANK[left] || 0))[0];
    if (priorMessageStatus && (RECEIPT_RANK[nextStatus] || 0) < (RECEIPT_RANK[priorMessageStatus] || 0)) return;
    const callbackIdentity = String(status.biz_opaque_callback_data || '').match(/^followup:([0-9a-f-]{36}):(\d+)$/i);
    const signedIndex = callbackIdentity ? Number(callbackIdentity[2]) : -1;
    const expectedMessages = Array.isArray(receipt.expectedMessages) ? receipt.expectedMessages.map(String) : [];
    const matchedMessage = receiptMessages(receipt).find(entry => entry.messageId === messageId && Number(entry.index) === signedIndex);
    const signedClaimEvidence = options.verifiedSignature && callbackIdentity && callbackIdentity[1] === receipt.claimToken
      && receipt.approvedContentHash === item.content_hash && signedIndex >= 0 && signedIndex < expectedMessages.length
      && matchedMessage && matchedMessage.body === expectedMessages[signedIndex]
      && String(status.recipient_id || '').replace(/\D/g, '') === item.wa_number.replace(/\D/g, '')
      ? { verifiedSignature: true, claimToken: receipt.claimToken, index: signedIndex, recipientId: String(status.recipient_id), approvedBatchVersion: receipt.approvedBatchVersion, approvedContentHash: receipt.approvedContentHash } : undefined;
    const nextStatuses = [...receiptStatuses.filter(entry => entry.messageId !== messageId), { messageId, status: nextStatus, occurredAt, conversation: status.conversation || {}, pricing: status.pricing || {}, errors: status.errors || [], ...(signedClaimEvidence ? {signedClaimEvidence} : {}) }];
    const nextReceipt = { ...receipt, statuses: nextStatuses };
    const messageIds = receiptMessages(receipt).map(entry => String(entry.messageId || '')).filter(Boolean);
    const statusByMessage = new Map(nextStatuses.map(entry => [String(entry.messageId || ''), String(entry.status || 'sent')]));
    const aggregateStatuses = messageIds.map(id => statusByMessage.get(id) || 'sent');
    const aggregateStatus = current === 'partial_sent' || item.exclusion_reason === 'send_outcome_unknown'
      ? current
      : aggregateStatuses.some(value => value === 'failed')
        ? 'failed'
        : aggregateStatuses.length && aggregateStatuses.every(value => value === 'read')
          ? 'read'
          : aggregateStatuses.length && aggregateStatuses.every(value => (RECEIPT_RANK[value] || 0) >= RECEIPT_RANK.delivered)
            ? 'delivered'
            : 'sent';
    const patch: Record<string, unknown> = { status: aggregateStatus, provider_receipt: nextReceipt, updated_at: occurredAt };
    if (aggregateStatus === 'delivered' || aggregateStatus === 'read') patch.delivered_at = item.delivered_at || occurredAt;
    if (aggregateStatus === 'failed') patch.last_error = JSON.stringify(status.errors || []).slice(0, 1000) || 'provider_delivery_failed';
    await persistFollowupItem(item.id, patch);
    const batch = await getFollowupBatch(tenantId, item.batch_id);
    if (batch) {
      touchedBatches.add(batch.id);
      await emit({ tenantId, runId: batch.run_id, taskId: await dispatchTaskId(batch), batchId: batch.id, itemId: item.id, customerId: item.customer_id, type: 'worker.receipt', level: nextStatus === 'failed' ? 'error' : 'success', summary: `${item.customer_name || '客户'} WhatsApp 回执：${nextStatus}`, payload: { providerMessageId: messageId, status: nextStatus, occurredAt } });
    }
    updated += 1;
    });
  }
  for (const batchId of touchedBatches) {
    const batch = await getFollowupBatch(tenantId, batchId);
    if (batch) await refreshBatchCounts(batch);
  }
  return updated;
}

export function getFollowupDispatchWorkerStatus(): { mode: 'scheduled' | 'manual_only'; running: boolean; intervalMs: number; maxAttempts: number } {
  return { mode: followupWorkerMode(), running: Boolean(interval), intervalMs: followupWorkerIntervalMs(), maxAttempts: followupWorkerMaxAttempts() };
}

export async function getTenantFollowupDispatchStatus(tenantId: string): Promise<ReturnType<typeof getFollowupDispatchWorkerStatus> & {
  authorization: CustomerMessagingAuthorization;
}> {
  return {
    ...getFollowupDispatchWorkerStatus(),
    authorization: await readCustomerMessagingAuthorization(tenantId, 'whatsapp'),
  };
}

type NativeScheduledService = Pick<ReturnType<typeof import('./weeklyNativeFollowupDispatch.js').createWeeklyNativeFollowupDispatchService>, 'preflightScheduled' | 'dispatchScheduled'>;

/** Internal driver shared by the scanner and controlled integration tests. */
export async function dispatchScheduledNativeFollowupBatch(dataStore: DataStore, input: { tenantId: string; batchId: string; runId: string }, ports: {
  serviceFactory?: (dataStore: DataStore) => NativeScheduledService;
  reconcile?: typeof import('./weeklyNativeFollowupDispatch.js').reconcileWeeklyNativeAcceptedRequest;
} = {}) {
  const native = await import('./weeklyNativeFollowupDispatch.js');
  const batch = await getFollowupBatch(input.tenantId, input.batchId, dataStore);
  if (!batch || batch.tenant_id !== input.tenantId || batch.run_id !== input.runId) throw new Error('followup_scan_batch_scope_invalid');
  const items = await getFollowupBatchItems(input.tenantId, input.batchId, dataStore);
  if (items.some(item => item.tenant_id !== input.tenantId || item.batch_id !== input.batchId)) throw new Error('followup_scan_item_scope_invalid');
  const scope = await readWeeklyCustomerRelationshipScope(dataStore, input.tenantId, input.runId);
  if (!scope) throw new Error('weekly_native_dispatch_week_binding_missing');
  const service = (ports.serviceFactory ?? native.createWeeklyNativeFollowupDispatchService)(dataStore);
  const expectedScope = { runId: input.runId, programId: scope.programId, packageId: scope.packageId, packageVersion: scope.packageVersion };
  const outcomes: Array<{ itemId: string; status: 'dispatched' | 'reconciled' | 'future' | 'blocked'; code: string | null }> = [];
  for (const item of items.filter(row => ['messenger', 'instagram'].includes(String(row.channel)))) {
    try {
      const requestId = jsonObject(item.provider_receipt).requestId;
      if (typeof requestId === 'string' && requestId) {
        // Existing attempts only reconcile the original receipt; never resubmit.
        await (ports.reconcile ?? native.reconcileWeeklyNativeAcceptedRequest)(dataStore, { tenantId: input.tenantId, channel: item.channel as 'messenger' | 'instagram', requestId, expectedScope });
        outcomes.push({ itemId: item.id, status: 'reconciled', code: null });
        continue;
      }
      const source = { tenantId: input.tenantId, batchId: input.batchId, itemId: item.id, expectedBatchVersion: batch.version, expectedItemHash: item.content_hash, expectedScope };
      const preflight = await service.preflightScheduled(source);
      if (preflight.status === 'eligible') {
        await service.dispatchScheduled(source);
        outcomes.push({ itemId: item.id, status: 'dispatched', code: null });
      } else outcomes.push({ itemId: item.id, status: preflight.status, code: preflight.code });
    } catch (error) {
      const code = safeError(error).code;
      outcomes.push({ itemId: item.id, status: 'blocked', code });
      console.error('[followup-worker:native-item]', input.batchId, item.id, code);
    }
  }
  return { batchId: input.batchId, outcomes };
}

export async function runFollowupDispatchScan(scanDependencies: {
  assertLegacyAccess?: (tenantId: string) => Promise<void>;
  recover?: typeof recoverStaleFollowupSending;
  getBatch?: typeof getFollowupBatch;
  getItems?: typeof getFollowupBatchItems;
  nativeScheduled?: (input: { tenantId: string; batchId: string; runId: string }) => Promise<unknown>;
  dispatch?: typeof dispatchFollowupBatch;
} = {}): Promise<number> {
  if (scanRunning) return 0;
  scanRunning = true;
  try {
    const batches: FollowupBatchRecord[] = [];
    for (let page = 1; ; page += 1) {
      const result = await store.list<FollowupBatchRecord>('followup_batches', { sort: 'updated_at', page, perPage: 500 });
      batches.push(...result.items.filter(batch => ['approved', 'needs_attention'].includes(batch.status)));
      if (page >= result.totalPages || !result.items.length) break;
    }
    for (const batch of batches) {
      const reportFailure = (error: unknown) => {
        const failure = safeError(error);
        if (!failure.code.startsWith('customer_message_send_not_authorized:')
          && failure.code !== 'starter_198_orchestrator_only'
          && failure.code !== 'starter_198_access_unavailable') {
          console.error('[followup-worker:batch]', batch.id, failure.code);
        }
      };
      let items: FollowupBatchItemRecord[];
      try {
        items = await (scanDependencies.getItems ?? getFollowupBatchItems)(batch.tenant_id, batch.id);
        if (items.some(item => item.tenant_id !== batch.tenant_id || item.batch_id !== batch.id)) {
          throw new Error('followup_scan_item_scope_invalid');
        }
      } catch (error) { reportFailure(error); continue; }
      // Native channels own their authority, request ledger and recovery. Do not
      // pass them through WhatsApp authorization, claims or stale-send recovery.
      if (items.some(item => ['messenger', 'instagram'].includes(String(item.channel)))) {
        try {
          const dispatchNative = scanDependencies.nativeScheduled ?? (input => dispatchScheduledNativeFollowupBatch(store, input));
          await dispatchNative({ tenantId: batch.tenant_id, batchId: batch.id, runId: batch.run_id });
        } catch (error) { reportFailure(error); }
      }
      // Missing channel is the historical WhatsApp representation. Unknown
      // channels never acquire WhatsApp sending authority by falling through.
      if (items.length && !items.some(item => !item.channel || item.channel === 'whatsapp')) continue;
      try {
        await (scanDependencies.assertLegacyAccess ?? assertLegacyExternalEffectAllowed)(batch.tenant_id);
        await (scanDependencies.recover ?? recoverStaleFollowupSending)(batch);
        if ((await (scanDependencies.getBatch ?? getFollowupBatch)(batch.tenant_id, batch.id))?.status !== 'approved') continue;
        await (scanDependencies.dispatch ?? dispatchFollowupBatch)(batch.tenant_id, batch.id, { mode: 'scheduled' });
      } catch (error) {
        reportFailure(error);
      }
    }
    return batches.length;
  } finally { scanRunning = false; }
}

export function initFollowupDispatchWorker(): void {
  if (followupWorkerMode() !== 'scheduled' || interval) return;
  const tick = () => { void runFollowupDispatchScan().catch(error => console.error('[followup-worker:scan]', safeError(error).code)); };
  interval = setInterval(tick, followupWorkerIntervalMs());
  interval.unref?.();
  tick();
  console.log(`[followup-worker] scheduled mode enabled (${followupWorkerIntervalMs()}ms)`);
}
