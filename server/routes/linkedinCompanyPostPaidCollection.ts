import { createHash } from 'node:crypto';
import { runPaidApifyDataset, type PaidApifyDatasetPermit } from './apifyPaidTikTokTransport.js';
import { parseLinkedInCompanyPost } from './linkedinCompanyPost.js';
import { apifyTokenFingerprint, APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME } from '../socialDiscovery/apifyTokenFingerprint.js';

export interface LinkedInCompanyCollectionScope {
  tenantId: string;
  runId: string;
  companyUrl: string;
  limit: number;
  dateFrom: string;
  dateTo: string;
}

/** Must be issued by a durable budget authority, never request JSON. */
export interface LinkedInCompanyPaidPermit extends PaidApifyDatasetPermit {
  scope: LinkedInCompanyCollectionScope;
  actorInputSha256: string;
  tokenFingerprint: string;
  assertApproved(scope: LinkedInCompanyCollectionScope, actorInputSha256: string): Promise<void>;
  persistRawReceipt: NonNullable<PaidApifyDatasetPermit['persistRawReceipt']>;
}

function canonicalCompanyUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw Error('linkedin_company_collection_scope_invalid'); }
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase())
    || !/^\/company\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) || url.username || url.password
    || url.port || url.search || url.hash) throw Error('linkedin_company_collection_scope_invalid');
  return `https://www.linkedin.com${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`;
}

export function frozenLinkedInCompanyActorInput(scope: LinkedInCompanyCollectionScope): Record<string, unknown> {
  const companyUrl = canonicalCompanyUrl(scope.companyUrl);
  if (!scope.tenantId.trim() || !scope.runId.trim() || !Number.isSafeInteger(scope.limit)
    || scope.limit < 1 || scope.limit > 30 || (scope.dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(scope.dateFrom))
    || (scope.dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(scope.dateTo))
    || (scope.dateFrom && scope.dateTo && scope.dateFrom > scope.dateTo)) {
    throw Error('linkedin_company_collection_scope_invalid');
  }
  return {
    startUrls: [{ url: companyUrl }],
    maxItems: scope.limit,
    ...(scope.dateFrom ? { untilDate: scope.dateFrom } : {}),
    proxyConfiguration: { useApifyProxy: true },
  };
}

/** Validates the immutable grant before any caller-side storage or provider I/O. */
export async function assertLinkedInCompanyPaidCollection(input: {
  scope: LinkedInCompanyCollectionScope;
  actorId: string;
  permit?: LinkedInCompanyPaidPermit;
}) {
  const actorInput = frozenLinkedInCompanyActorInput(input.scope);
  const permit = input.permit;
  if (!permit) throw Error('linkedin_company_paid_collection_permit_required');
  const companyUrl = canonicalCompanyUrl(input.scope.companyUrl);
  const scope = { ...input.scope, companyUrl };
  const actorInputSha256 = createHash('sha256').update(JSON.stringify(actorInput)).digest('hex');
  if ((Object.keys(scope) as Array<keyof LinkedInCompanyCollectionScope>)
    .some(key => permit.scope[key] !== scope[key]) || permit.actorInputSha256 !== actorInputSha256
    || !permit.operationId || !input.actorId || permit.actorId !== input.actorId
    || !Number.isFinite(permit.maxTotalChargeUsd) || permit.maxTotalChargeUsd <= 0
    || typeof permit.persistRawReceipt !== 'function') {
    throw Error('linkedin_company_paid_collection_scope_mismatch');
  }
  await permit.assertApproved(scope, actorInputSha256);
  return { actorInput, permit, scope, companyUrl };
}

/** No paid request is possible without a pre-issued, exact-scope permit. */
export async function runLinkedInCompanyPaidCollection(input: {
  scope: LinkedInCompanyCollectionScope;
  actorId: string;
  token: string;
  permit?: LinkedInCompanyPaidPermit;
  timeoutMs?: number;
  settlementDelayMs?: number;
}) {
  const { actorInput, permit, scope, companyUrl } = await assertLinkedInCompanyPaidCollection(input);
  if (apifyTokenFingerprint(input.token, APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME)
    !== permit.tokenFingerprint) throw Error('linkedin_company_paid_collection_token_changed');
  const recheckingPermit: LinkedInCompanyPaidPermit = {
    operationId: permit.operationId, actorId: permit.actorId,
    maxTotalChargeUsd: permit.maxTotalChargeUsd,
    scope: permit.scope, actorInputSha256: permit.actorInputSha256,
    tokenFingerprint: permit.tokenFingerprint,
    assertApproved: (currentScope, digest) => permit.assertApproved(currentScope, digest),
    inspect: request => permit.inspect(request),
    async beforeSubmit(request) {
      await permit.assertApproved(scope, permit.actorInputSha256);
      await permit.beforeSubmit(request);
    },
    recordRun: receipt => {
      if (!receipt.rawReceiptRef?.trim()) throw Error('linkedin_company_actor_submit_receipt_required');
      return permit.recordRun(receipt);
    },
    recordTerminal: receipt => {
      if (!receipt.rawReceiptRef?.trim()) throw Error('linkedin_company_actor_poll_receipt_required');
      return permit.recordTerminal(receipt);
    },
    async persistRawReceipt(receipt) {
      const ref = await permit.persistRawReceipt(receipt);
      if (!ref?.trim()) throw Error('linkedin_company_raw_receipt_ref_required');
      return ref;
    },
    async beforeDatasetRead(request) {
      await permit.assertApproved(scope, permit.actorInputSha256);
      await permit.beforeDatasetRead(request);
    },
  };
  const rows = await runPaidApifyDataset({ actorId: input.actorId, actorInput, permit: recheckingPermit,
    token: input.token, maxItems: scope.limit, timeoutMs: input.timeoutMs,
    settlementDelayMs: input.settlementDelayMs });
  const parsed = rows.map(row => parseLinkedInCompanyPost(row, companyUrl))
    .filter((post): post is NonNullable<typeof post> => Boolean(post))
    .filter(post => (!scope.dateFrom || !!post.uploadedAt && post.uploadedAt.slice(0, 10) >= scope.dateFrom)
      && (!scope.dateTo || !!post.uploadedAt && post.uploadedAt.slice(0, 10) <= scope.dateTo));
  return {
    videos: parsed.filter(post => post.kind === 'video').map(post => post.item),
    images: parsed.filter(post => post.kind === 'image').map(post => post.item),
  };
}

export async function assertConfiguredLinkedInCompanyPaidCollection(
  scope: LinkedInCompanyCollectionScope,
  permit?: LinkedInCompanyPaidPermit,
) {
  return assertLinkedInCompanyPaidCollection({ scope,
    actorId: process.env.APIFY_LINKEDIN_ACTOR?.trim() || 'logical_scrapers/linkedin-company-posts-scraper', permit });
}

/** Server configuration is read only after the caller supplies a trusted permit. */
export async function runConfiguredLinkedInCompanyPaidCollection(
  scope: LinkedInCompanyCollectionScope,
  permit?: LinkedInCompanyPaidPermit,
) {
  if (!permit) throw Error('linkedin_company_paid_collection_permit_required');
  return runLinkedInCompanyPaidCollection({
    scope,
    actorId: process.env.APIFY_LINKEDIN_ACTOR?.trim() || 'logical_scrapers/linkedin-company-posts-scraper',
    token: process.env.APIFY_TOKEN?.trim() || '',
    permit,
    timeoutMs: Number(process.env.APIFY_TIMEOUT_MS || 120_000),
  });
}
