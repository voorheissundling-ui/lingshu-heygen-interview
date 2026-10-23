import {
  assertCurrentContentExecutionActive,
  currentContentProviderReceipt,
  recordCurrentContentProviderReceipt,
  type ContentProviderReceipt,
} from './context.js';

export type ProviderSubmissionDecision =
  | { action: 'submit'; receipt: null }
  | { action: 'reuse_completed'; receipt: ContentProviderReceipt }
  | { action: 'reconcile'; receipt: ContentProviderReceipt }
  | { action: 'new_request_required'; receipt: ContentProviderReceipt };

function identity(value: string, code: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || normalized !== value) throw new Error(code);
  return normalized;
}

/**
 * Single provider admission boundary. It persists the intent before the caller
 * can submit and never interprets an ambiguous receipt as permission to retry.
 */
export async function beginContentProviderOperation(input: {
  provider: string;
  requestId: string;
  metadata?: Record<string, unknown>;
}): Promise<ProviderSubmissionDecision> {
  const provider = identity(input.provider, 'content_provider_gateway_provider_invalid', 80);
  const requestId = identity(input.requestId, 'content_provider_gateway_request_invalid', 240);
  const prior = currentContentProviderReceipt({ provider, requestId });
  if (prior?.state === 'completed') return { action: 'reuse_completed', receipt: prior };
  if (prior && ['submitting', 'accepted', 'unknown'].includes(prior.state)) return { action: 'reconcile', receipt: prior };
  if (prior?.state === 'failed') return { action: 'new_request_required', receipt: prior };
  await assertCurrentContentExecutionActive();
  await recordCurrentContentProviderReceipt({ provider, requestId, state: 'submitting', metadata: input.metadata });
  return { action: 'submit', receipt: null };
}

export async function acceptContentProviderOperation(input: {
  provider: string;
  requestId: string;
  providerTaskId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  identity(input.providerTaskId, 'content_provider_gateway_task_invalid', 240);
  await recordCurrentContentProviderReceipt({ ...input, state: 'accepted' });
}

export async function completeContentProviderOperation(input: {
  provider: string;
  requestId: string;
  providerTaskId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordCurrentContentProviderReceipt({ ...input, state: 'completed' });
}

/** A thrown transport error after submission is ambiguous until reconciled. */
export async function markContentProviderOperationUnknown(input: {
  provider: string;
  requestId: string;
  providerTaskId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordCurrentContentProviderReceipt({ ...input, state: 'unknown' });
}

/** Use failed only for a canonical provider rejection, never for a timeout. */
export async function failContentProviderOperation(input: {
  provider: string;
  requestId: string;
  providerTaskId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await recordCurrentContentProviderReceipt({ ...input, state: 'failed' });
}
