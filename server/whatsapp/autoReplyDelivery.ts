import { sendTenantWhatsAppTextWithReceipts } from './send.js';

type Sender = typeof sendTenantWhatsAppTextWithReceipts;
type Progress = Parameters<NonNullable<Parameters<Sender>[3]>>[0];

/** Persist every accepted bubble before attempting the next one. Never resend here. */
export async function deliverAutoReply(input: {
  tenantId: string; to: string; body: string;
  recordAccepted: (progress: Progress) => void | Promise<void>;
}, send: Sender = sendTenantWhatsAppTextWithReceipts) {
  const accepted: Progress[] = [];
  try {
    const result = await send(input.tenantId, input.to, input.body, async progress => {
      if (!progress.receipt.messageId) throw new Error('whatsapp_provider_message_id_missing');
      accepted.push(progress);
      await input.recordAccepted(progress);
    });
    if (!result.receipts.length || result.receipts.length !== result.messages.length
      || accepted.length !== result.messages.length || result.receipts.some(receipt => !receipt.messageId)) {
      throw new Error('whatsapp_provider_message_id_missing');
    }
    return { complete: true, accepted, error: '', pendingDraft: undefined, reason: '' };
  } catch (error) {
    // An interrupted call may already have reached the provider, even with no
    // receipt. Do not put the full reply back into the sendable draft field.
    return { complete: false, accepted, error: error instanceof Error ? error.message : String(error),
      pendingDraft: undefined, reason: accepted.length ? 'auto_reply_partial_or_writeback_failed' : 'auto_reply_send_outcome_unconfirmed' };
  }
}
