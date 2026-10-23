import { createHash } from 'node:crypto';
import { readBoundedProviderResponse } from '../lib/boundedProviderResponse.js';

/** Maximum original HTTP body that a paid LinkedIn receipt can durably retain. */
export const APIFY_PAID_RAW_RECEIPT_MAX_BYTES = 8 * 1024 * 1024;

/** The authority/ledger owns these callbacks. This transport never grants itself a paid call. */
export interface PaidApifyTikTokPermit {
  operationId: string;
  actorId: string;
  maxTotalChargeUsd: number;
  inspect(input: { actorId: string; requestHash: string; maxTotalChargeUsd: number }): Promise<
    | { status: 'reserved' }
    | { status: 'submitted_unknown' }
    | { status: 'submitted_known'; runId: string; datasetId: string }
    | { status: 'completed'; runId: string; datasetId: string; usageTotalUsd: number }
  >;
  beforeSubmit(input: { actorId: string; requestHash: string; maxTotalChargeUsd: number }): Promise<void>;
  recordRun(input: { runId: string; datasetId: string; maxTotalChargeUsd: number; rawReceiptRef?: string }): Promise<void>;
  recordTerminal(input: { runId: string; status: string; usageTotalUsd: number; rawReceiptRef?: string }): Promise<void>;
  /** Separate read/transfer cost authority; the Actor cap does not prove it. */
  beforeDatasetRead(input: { runId: string; datasetId: string; maxItems: number }): Promise<void>;
  /** Persist the raw response before interpreting or settling a paid operation. */
  persistRawReceipt?(input: {
    phase: 'actor_submit' | 'actor_poll' | 'dataset_read';
    actorId: string; operationId: string; requestHash: string;
    runId?: string; datasetId?: string; httpStatus: number; responseBody: string;
  }): Promise<string>;
}

/** The transport is actor-agnostic; existing TikTok callers retain their name. */
export type PaidApifyDatasetPermit = PaidApifyTikTokPermit;

type RunRecord = Record<string, unknown>;

function object(value: unknown): RunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('apify_paid_invalid_response');
  return value as RunRecord;
}

function wrappedData(value: unknown): RunRecord {
  const outer = object(value);
  return outer.data === undefined ? outer : object(outer.data);
}

function positiveUsd(value: unknown): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number) || number <= 0) throw Error('apify_paid_invalid_cap');
  return number;
}

function nonnegativeUsd(value: unknown): number {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number) || number < 0) throw Error('apify_paid_usage_unverified');
  return number;
}

function runIdentity(run: RunRecord, expected?: { runId: string; datasetId: string }): { runId: string; datasetId: string } {
  const runId = String(run.id || '').trim();
  const datasetId = String(run.defaultDatasetId || '').trim();
  if (!runId || !datasetId || (expected && (runId !== expected.runId || datasetId !== expected.datasetId))) {
    throw Error('apify_paid_run_identity_mismatch');
  }
  return { runId, datasetId };
}

function verifyRunCap(run: RunRecord, expectedCap: number): void {
  const options = object(run.options);
  const actualCap = positiveUsd(options.maxTotalChargeUsd);
  if (actualCap !== expectedCap) throw Error('apify_paid_run_cap_mismatch');
  // The GET run schema does not guarantee this request option is echoed back.
  // Reject a contradictory value if supplied; the POST always sends false.
  if (options.restartOnError !== undefined && options.restartOnError !== false) throw Error('apify_paid_restart_option_mismatch');
}

async function jsonRequest(url: URL, token: string, deadline: number, init: RequestInit,
  persistRawReceipt?: (httpStatus: number, responseBody: string) => Promise<string>): Promise<{ body: unknown; rawReceiptRef?: string }> {
  if (Date.now() >= deadline) throw Error('apify_paid_observation_timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...init.headers },
    });
    // Provider response bodies may contain input data. Never echo them into a log or task card.
    // Persist before parsing: a malformed or non-2xx billable response must not
    // disappear behind a retryable-looking error.
    const responseBody = persistRawReceipt
      ? await readBoundedProviderResponse(response, { maxBytes: APIFY_PAID_RAW_RECEIPT_MAX_BYTES,
        errorCode: 'apify_paid_raw_receipt_too_large', controller })
      : await response.text();
    const rawReceiptRef = persistRawReceipt ? await persistRawReceipt(response.status, responseBody) : undefined;
    if (!response.ok) throw Error(`apify_paid_http_${response.status}`);
    try { return { body: JSON.parse(responseBody) as unknown, rawReceiptRef }; }
    catch { throw Error('apify_paid_invalid_response'); }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One paid Actor start at most. A crash after the POST and before recordRun is
 * deliberately unrecoverable without an external run receipt: it is never retried.
 * After recordRun, all recovery is GET-only against the same run and dataset.
 */
export async function runPaidApifyTikTokDataset(input: {
  actorId: string;
  actorInput: Record<string, unknown>;
  permit: PaidApifyTikTokPermit;
  token: string;
  maxItems: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Apify advises a second cost read about 10 s after terminal status. */
  settlementDelayMs?: number;
}): Promise<Record<string, unknown>[]> {
  const { actorId, actorInput, permit, token } = input;
  if (!token.trim()) throw Error('apify_paid_credentials_required');
  if (!actorId || actorId !== permit.actorId) throw Error('apify_paid_actor_mismatch');
  const cap = positiveUsd(permit.maxTotalChargeUsd);
  const maxItems = input.maxItems;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 30) throw Error('apify_paid_dataset_limit_invalid');
  const requestHash = createHash('sha256').update(JSON.stringify({
    actorId, actorInput, maxTotalChargeUsd: cap, restartOnError: false,
  })).digest('hex');
  const rawReceipt = (phase: 'actor_submit' | 'actor_poll' | 'dataset_read', known?: { runId: string; datasetId: string }) =>
    permit.persistRawReceipt && ((httpStatus: number, responseBody: string) => permit.persistRawReceipt!({
      phase, actorId, operationId: permit.operationId, requestHash,
      ...(known ? { runId: known.runId, datasetId: known.datasetId } : {}),
      httpStatus, responseBody,
    }));
  const deadline = Date.now() + Math.max(1, input.timeoutMs ?? 120_000);
  const base = 'https://api.apify.com/v2';
  const state = await permit.inspect({ actorId, requestHash, maxTotalChargeUsd: cap });
  let known: { runId: string; datasetId: string };
  if (state.status === 'reserved') {
    // This durable transition happens before the network call. If it rejects,
    // there is zero provider POST. If the POST times out, the operation remains
    // submitted_unknown and another attempt cannot spend again.
    await permit.beforeSubmit({ actorId, requestHash, maxTotalChargeUsd: cap });
    const url = new URL(`${base}/acts/${encodeURIComponent(actorId)}/runs`);
    url.searchParams.set('maxTotalChargeUsd', String(cap));
    url.searchParams.set('restartOnError', 'false');
    const submitted = await jsonRequest(url, token, deadline, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(actorInput),
    }, rawReceipt('actor_submit'));
    const started = wrappedData(submitted.body);
    known = runIdentity(started);
    await permit.recordRun({ ...known, maxTotalChargeUsd: cap, rawReceiptRef: submitted.rawReceiptRef });
  } else if (state.status === 'submitted_known' || state.status === 'completed') {
    known = { runId: state.runId, datasetId: state.datasetId };
    if (!known.runId || !known.datasetId) throw Error('apify_paid_run_identity_mismatch');
  } else {
    throw Error('apify_paid_submission_unknown_no_replay');
  }

  const pollInterval = Math.max(1, input.pollIntervalMs ?? 5_000);
  for (;;) {
    const runUrl = new URL(`${base}/actor-runs/${encodeURIComponent(known.runId)}`);
    let observed = await jsonRequest(runUrl, token, deadline, { method: 'GET' }, rawReceipt('actor_poll', known));
    let run = wrappedData(observed.body);
    runIdentity(run, known);
    verifyRunCap(run, cap);
    const status = String(run.status || '').toUpperCase();
    if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      const settleDelay = Math.max(0, input.settlementDelayMs ?? 10_000);
      const finishedAt = Date.parse(String(run.finishedAt || ''));
      const remainingDelay = Number.isFinite(finishedAt)
        ? Math.max(0, settleDelay - (Date.now() - finishedAt)) : settleDelay;
      if (remainingDelay > 0) {
        if (Date.now() + remainingDelay >= deadline) throw Error('apify_paid_observation_timeout');
        await new Promise(resolve => setTimeout(resolve, remainingDelay));
        observed = await jsonRequest(runUrl, token, deadline, { method: 'GET' }, rawReceipt('actor_poll', known));
        run = wrappedData(observed.body);
        runIdentity(run, known);
        verifyRunCap(run, cap);
        if (String(run.status || '').toUpperCase() !== status) throw Error('apify_paid_terminal_status_changed');
      }
      const usageTotalUsd = nonnegativeUsd(run.usageTotalUsd);
      if (usageTotalUsd > cap) throw Error('apify_paid_usage_exceeds_cap');
      await permit.recordTerminal({ runId: known.runId, status, usageTotalUsd, rawReceiptRef: observed.rawReceiptRef });
      if (status !== 'SUCCEEDED') throw Error(`apify_paid_run_${status.toLowerCase()}`);
      // Dataset reads/transfers may be billed outside the Actor run cap.
      // In the absence of a separately verified reservation, stay closed even
      // though the paid Actor has succeeded.
      await permit.beforeDatasetRead({ ...known, maxItems });
      const datasetUrl = new URL(`${base}/datasets/${encodeURIComponent(known.datasetId)}/items`);
      datasetUrl.searchParams.set('clean', 'true');
      datasetUrl.searchParams.set('limit', String(maxItems));
      const { body: rows } = await jsonRequest(datasetUrl, token, deadline, { method: 'GET' }, rawReceipt('dataset_read', known));
      if (!Array.isArray(rows) || rows.length > maxItems || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw Error('apify_paid_dataset_invalid');
      }
      return rows as Record<string, unknown>[];
    }
    if (!['READY', 'RUNNING'].includes(status)) throw Error('apify_paid_run_status_unverified');
    if (Date.now() + pollInterval >= deadline) throw Error('apify_paid_observation_timeout');
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

export const runPaidApifyDataset = runPaidApifyTikTokDataset;
