import { createHash } from 'node:crypto';
import type { DataStore, Record_ } from '../storage/datastore.js';
import { enterpriseAssetObjectKey } from '../storage/enterpriseAssets.js';
import { objectStorageGetObject, objectStorageHead, objectStorageUpload } from '../storage/objectStorage.js';
import { socialRequestHash } from '../starter198/socialContentValidation.js';
import { readWeeklyReviewActor } from './weeklyReviewEvidence.js';
import { readWeeklyPublicationProductSelection, type WeeklyPublicationProductSelection } from './weeklyPublicationProductSelection.js';
import { latestPackageRow } from './weeklyOperatingPackageSupport.js';
import { createSocialOperatingRepository } from '../socialOperating/repository.js';
import { organizationRoleOrNull } from '../lib/organizationRole.js';
import { readWeeklyAutomationTemplate } from './weeklyAutomationTemplate.js';
import { withExecutionPackageGate } from './weeklyExecutionGate.js';
import { readWeeklyCtaContact } from './weeklyCtaContact.js';
import { verifyPreprovisionedSignedSamplePolicy, type SignedSamplePolicy, type PreprovisionedPolicyTrustRoot } from './weeklySignedSamplePolicy.js';
import { readLiveWeeklyWhatsAppCtaProof } from '../runtime/weeklyFrozenCtaWhatsAppProof.js';
import type { TenantPlatformAppRecord } from '../lib/tenantPlatformApps.js';
import { provisionedWeeklySamplePolicyAuthority } from './weeklySamplePolicyAuthority.js';
import { readCanonicalWhatsAppAccount } from '../whatsapp/canonicalAccount.js';

/** An uploaded policy is documentary intake only. There is deliberately no
 * approved policy issuer yet, so production admission must remain closed. */
export const WEEKLY_SAMPLE_POLICY_CANDIDATES = 'social_weekly_sample_policy_candidates';
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_CANDIDATES_PER_TASK = 20;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fail(code: string): never { throw Error(`weekly_sample_policy_${code}`); }
const validTime = (value: string) => Number.isFinite(Date.parse(value));

export interface SamplePolicyScope {
  tenantId: string; programId: string; packageId: string; packageVersion: number; publicationTaskId: string;
}
export interface SamplePolicyTerms {
  sampleFeeCny: 0;
  shippingFeePayer: 'seller' | 'buyer'; customsDutyPayer: 'seller' | 'buyer';
  maximumFreeQuantity: number; eligibleMarkets: string[]; eligibleCustomerTypes: string[];
  validFrom: string; validUntil: string;
}
export interface SamplePolicyCandidate {
  schemaVersion: 'weekly-sample-policy-candidate.v1'; candidateId: string; scope: SamplePolicyScope;
  productId: string; productName: string; productSku: string | null;
  selectionHash: string; publicationHash: string; enterpriseFactContentHash: string;
  frozenCtaHash: string; terms: SamplePolicyTerms;
  sourceKey: string; sourceSha256: string; sourceSize: number; sourceMimeType: 'application/pdf';
  submittedBy: string; submittedAt: string; reviewStatus: 'pending_independent_verification';
  authorizesProduction: false; authorizesPublishing: false; authorizesCustomerMessages: false;
}

/** Server-side admission checklist for the immutable free-sample CTA. It is
 * deliberately not a grant. In particular, a PDF, an internal review, a
 * contact receipt, and a self-hash cannot establish policy source authority.
 * A future issuer must verify an external issuer identity and revocation at
 * read time, then bind its decision to every value returned here. */
export interface WeeklySamplePolicyAdmissionDiagnostic {
  scope: SamplePolicyScope;
  selectionHash: string;
  productId: string;
  enterpriseFactContentHash: string;
  frozenCtaHash: string;
  contactReceiptId: string | null;
  contactHash: string | null;
  contactValue: string | null;
  candidateIds: string[];
  requirements: {
    recordedContactReceipt: boolean;
    liveMetaNumberMembership: false;
    independentlyAuthenticatedPolicyIssuer: false;
    productAndTermsCoveredByIssuer: false;
    issuerRevocationChecked: false;
    validAtProductionAndBeforePayment: false;
  };
  authorizesProduction: false;
}

/** Inspect current immutable bindings without converting documentary intake
 * into permission. No provider I/O or paid call occurs here. A future policy
 * verifier must also re-read the live Meta number and the issuer's revocation
 * source before both content creation and every paid continuation. */
export async function readWeeklySamplePolicyAdmissionDiagnostic(
  store: DataStore, scope: SamplePolicyScope,
): Promise<WeeklySamplePolicyAdmissionDiagnostic> {
  const { selection, frozenCta } = await authoritativeContext(store, scope);
  const contact = await readWeeklyCtaContact(store, scope);
  const candidates = await inspectWeeklySamplePolicyCandidates(store, scope);
  return {
    scope, selectionHash: socialRequestHash(selection), productId: selection.productId,
    enterpriseFactContentHash: selection.enterpriseFactContentHash,
    frozenCtaHash: socialRequestHash(frozenCta),
    contactReceiptId: contact.receipt?.receiptId ?? null,
    contactHash: contact.receipt ? socialRequestHash(contact.receipt) : null,
    contactValue: contact.receipt?.contactValue ?? null,
    candidateIds: candidates.map(candidate => candidate.candidateId),
    requirements: {
      recordedContactReceipt: contact.status === 'recorded' && Boolean(contact.receipt),
      liveMetaNumberMembership: false,
      independentlyAuthenticatedPolicyIssuer: false,
      productAndTermsCoveredByIssuer: false,
      issuerRevocationChecked: false,
      validAtProductionAndBeforePayment: false,
    },
    authorizesProduction: false,
  };
}
const where = (scope: SamplePolicyScope) => ({
  tenant_id: scope.tenantId, program_id: scope.programId, package_id: scope.packageId,
  package_version: scope.packageVersion, publication_task_id: scope.publicationTaskId,
});
const sourceKey = (tenantId: string, sourceSha256: string) => enterpriseAssetObjectKey(tenantId, `sample-policy-${sourceSha256}.pdf`);

export async function assertWeeklySamplePolicyCandidateActor(store: DataStore, tenantId: string, actorUserId: string) {
  const actor = await readWeeklyReviewActor(store, tenantId, actorUserId);
  if (!actor || actor.tenantId !== tenantId) fail('package_missing');
  if (!['super_admin', 'admin', 'social_operator'].includes(organizationRoleOrNull(actor.role) ?? '')
    || actor.disabled === true || actor.active === false
    || ['disabled', 'suspended'].includes(String(actor.status))) fail('actor_invalid');
}

async function authoritativeContext(store: DataStore, scope: SamplePolicyScope) {
  const row = await latestPackageRow(store, scope.tenantId, scope.programId, scope.packageId);
  const pkg = row?.payload;
  if (!pkg) fail('package_missing');
  if (row.version !== scope.packageVersion || pkg.packageId !== scope.packageId
    || pkg.programId !== scope.programId || pkg.version !== scope.packageVersion) fail('package_changed');
  const publications = pkg.socialContentPackage?.publicationTasks ?? [];
  const publication = publications.find(item => item.publicationTaskId === scope.publicationTaskId);
  const goalRef = pkg.businessContentGoalRef;
  if (!publication || publications.filter(item => item.publicationTaskId === scope.publicationTaskId).length !== 1
    || goalRef?.type !== 'business_content_goal') fail('publication_or_goal_missing');
  const goal = await createSocialOperatingRepository(store).getGoal(scope.tenantId, scope.programId, goalRef.id, goalRef.version);
  if (!goal) fail('goal_missing');
  const selection = await readWeeklyPublicationProductSelection({ ...scope, store, publication, goal });
  if (!selection) fail('selection_missing');
  const adoption = await readWeeklyAutomationTemplate(store, scope);
  const frozenCta = adoption?.template.callToAction;
  if (!frozenCta || !/whats\s*app/i.test(frozenCta) || !/free\s+sample/i.test(frozenCta)) fail('frozen_claim_missing');
  return { selection, frozenCta };
}

export async function readWeeklySamplePolicyCandidateContext(store: DataStore, scope: SamplePolicyScope) {
  const context = await authoritativeContext(store, scope);
  const contextHash = socialRequestHash({ scope, selectionHash: socialRequestHash(context.selection), frozenCtaHash: socialRequestHash(context.frozenCta) });
  const candidates = await inspectWeeklySamplePolicyCandidates(store, scope);
  return {
    contextHash,
    selection: { productId: context.selection.productId, productName: context.selection.productName, productSku: context.selection.productSku },
    frozenCta: context.frozenCta,
    candidates: candidates.map(candidate => ({ candidateId: candidate.candidateId, sourceSha256: candidate.sourceSha256,
      sourceSize: candidate.sourceSize, terms: candidate.terms, submittedAt: candidate.submittedAt, reviewStatus: candidate.reviewStatus })),
    policyStatus: 'candidate_only' as const,
  };
}

function assertTerms(terms: SamplePolicyTerms) {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)
    || Object.keys(terms).some(key => !['sampleFeeCny', 'shippingFeePayer', 'customsDutyPayer', 'maximumFreeQuantity',
      'eligibleMarkets', 'eligibleCustomerTypes', 'validFrom', 'validUntil'].includes(key))
    || terms.sampleFeeCny !== 0 || !['seller', 'buyer'].includes(terms.shippingFeePayer)
    || !['seller', 'buyer'].includes(terms.customsDutyPayer)
    || !Number.isSafeInteger(terms.maximumFreeQuantity) || terms.maximumFreeQuantity < 1
    || !Array.isArray(terms.eligibleMarkets) || terms.eligibleMarkets.length === 0 || terms.eligibleMarkets.length > 100
    || !Array.isArray(terms.eligibleCustomerTypes) || terms.eligibleCustomerTypes.length === 0 || terms.eligibleCustomerTypes.length > 100
    || [...terms.eligibleMarkets, ...terms.eligibleCustomerTypes].some(value => typeof value !== 'string' || !value.trim() || value.length > 160)
    || typeof terms.validFrom !== 'string' || typeof terms.validUntil !== 'string'
    || !validTime(terms.validFrom) || !validTime(terms.validUntil)
    || Date.parse(terms.validUntil) <= Date.parse(terms.validFrom)) fail('terms_invalid');
}

async function verifySource(candidate: SamplePolicyCandidate) {
  if (candidate.sourceKey !== sourceKey(candidate.scope.tenantId, candidate.sourceSha256)
    || !/^[a-f0-9]{64}$/.test(candidate.sourceSha256)
    || !Number.isSafeInteger(candidate.sourceSize) || candidate.sourceSize < 1
    || candidate.sourceSize > MAX_SOURCE_BYTES || candidate.sourceMimeType !== 'application/pdf') fail('source_invalid');
  const object = await objectStorageGetObject(candidate.sourceKey);
  if (!object || object.contentType !== 'application/pdf' || object.size !== candidate.sourceSize) fail('source_missing');
  const digest = createHash('sha256'); let size = 0;
  for await (const chunk of object.body) {
    size += chunk.byteLength;
    if (size > MAX_SOURCE_BYTES || size > candidate.sourceSize) fail('source_changed');
    digest.update(chunk);
  }
  if (size !== candidate.sourceSize || digest.digest('hex') !== candidate.sourceSha256) fail('source_changed');
}

/** Internal intake primitive. A future HTTP route must bind actorUserId to
 * verified req identity; this function is not an authenticated endpoint. */
export async function submitWeeklySamplePolicyCandidate(input: {
  store: DataStore; scope: SamplePolicyScope; actorUserId: string;
  expectedContextHash: string; terms: SamplePolicyTerms; pdfBytes: Buffer;
}) {
  const { store, scope } = input;
  if (!/^[a-f0-9]{64}$/.test(input.expectedContextHash)) fail('context_hash_invalid');
  return withExecutionPackageGate(store, scope, async assert => {
  const { selection, frozenCta } = await authoritativeContext(store, scope);
  const contextHash = socialRequestHash({ scope, selectionHash: socialRequestHash(selection), frozenCtaHash: socialRequestHash(frozenCta) });
  if (contextHash !== input.expectedContextHash) fail('context_changed');
  await assertWeeklySamplePolicyCandidateActor(store, scope.tenantId, input.actorUserId);
  assertTerms(input.terms);
  if (!Buffer.isBuffer(input.pdfBytes) || input.pdfBytes.length < 1 || input.pdfBytes.length > MAX_SOURCE_BYTES
    || input.pdfBytes.subarray(0, 5).toString('ascii') !== '%PDF-') fail('source_invalid');
  const sourceSha256 = sha(input.pdfBytes), key = sourceKey(scope.tenantId, sourceSha256);
  const candidateId = createHash('sha256').update(`weekly-sample-policy-candidate:${socialRequestHash({ scope, selectionHash: socialRequestHash(selection), frozenCtaHash: socialRequestHash(frozenCta), terms: input.terms, sourceSha256, submittedBy: input.actorUserId })}`).digest('hex').slice(0, 15);
  const previous = await store.getById<Record_>(WEEKLY_SAMPLE_POLICY_CANDIDATES, candidateId);
  if (previous) {
    const prior = previous.payload as SamplePolicyCandidate | undefined;
    if (!prior || previous.content_hash !== socialRequestHash(prior)
      || prior.candidateId !== candidateId || socialRequestHash(prior.scope) !== socialRequestHash(scope)
      || Object.entries(where(scope)).some(([field, value]) => previous[field] !== value)
      || prior.productId !== selection.productId || prior.productName !== selection.productName
      || prior.productSku !== selection.productSku || prior.selectionHash !== socialRequestHash(selection)
      || prior.publicationHash !== selection.publicationHash || prior.enterpriseFactContentHash !== selection.enterpriseFactContentHash
      || prior.frozenCtaHash !== socialRequestHash(frozenCta) || prior.sourceSha256 !== sourceSha256
      || socialRequestHash(prior.terms) !== socialRequestHash(input.terms) || prior.submittedBy !== input.actorUserId
      || prior.reviewStatus !== 'pending_independent_verification' || prior.authorizesProduction !== false
      || prior.authorizesPublishing !== false || prior.authorizesCustomerMessages !== false) fail('candidate_conflict');
    await verifySource(prior);
    return prior;
  }
  const existing = await inspectWeeklySamplePolicyCandidates(store, scope);
  if (existing.length >= MAX_CANDIDATES_PER_TASK) fail('candidate_limit_reached');
  await assert();
  if (!(await objectStorageHead(key))) await objectStorageUpload({ key, body: input.pdfBytes, contentType: 'application/pdf' });
  const candidate: SamplePolicyCandidate = {
    schemaVersion: 'weekly-sample-policy-candidate.v1', candidateId, scope,
    productId: selection.productId, productName: selection.productName, productSku: selection.productSku,
    selectionHash: socialRequestHash(selection), publicationHash: selection.publicationHash,
    enterpriseFactContentHash: selection.enterpriseFactContentHash, frozenCtaHash: socialRequestHash(frozenCta),
    terms: input.terms, sourceKey: key, sourceSha256, sourceSize: input.pdfBytes.length, sourceMimeType: 'application/pdf',
    submittedBy: input.actorUserId, submittedAt: new Date().toISOString(), reviewStatus: 'pending_independent_verification',
    authorizesProduction: false, authorizesPublishing: false, authorizesCustomerMessages: false,
  };
  await verifySource(candidate);
  await assert();
  const saved = await store.create(WEEKLY_SAMPLE_POLICY_CANDIDATES, { id: candidate.candidateId, ...where(scope), payload: candidate, content_hash: socialRequestHash(candidate) });
  if (!saved) {
    const raced = await store.getById<Record_>(WEEKLY_SAMPLE_POLICY_CANDIDATES, candidateId);
    const prior = raced?.payload as SamplePolicyCandidate | undefined;
    if (!prior || raced?.content_hash !== socialRequestHash(prior)
      || socialRequestHash({ ...prior, submittedAt: candidate.submittedAt }) !== socialRequestHash(candidate)) fail('candidate_save_failed');
    await verifySource(prior);
    return prior;
  }
  return candidate;
  });
}

/** Inspection can show what the user uploaded, but must never be read as a
 * verified free-sample promise. Re-check source bytes after a process restart. */
export async function inspectWeeklySamplePolicyCandidates(store: DataStore, scope: SamplePolicyScope) {
  const { selection, frozenCta } = await authoritativeContext(store, scope);
  const records: Record_[] = [];
  const ids = new Set<string>(); let total: number | null = null;
  for (let page = 1; page <= 1000; page++) {
    const rows = await store.list<Record_>(WEEKLY_SAMPLE_POLICY_CANDIDATES, { where: where(scope), page, perPage: 100, sort: 'id' });
    if (!Number.isSafeInteger(rows.totalItems) || rows.totalItems < 0
      || (total !== null && rows.totalItems !== total)) fail('candidates_ambiguous');
    total = rows.totalItems;
    for (const row of rows.items) {
      if (!row.id || ids.has(row.id)) fail('candidates_ambiguous');
      ids.add(row.id); records.push(row);
    }
    if (records.length === total) break;
    if (!rows.items.length || page === 1000) fail('candidates_ambiguous');
  }
  const candidates: SamplePolicyCandidate[] = [];
  for (const row of records) {
    const candidate = row.payload as SamplePolicyCandidate | undefined;
    if (!candidate || row.id !== candidate.candidateId || row.content_hash !== socialRequestHash(candidate)
      || Object.entries(where(scope)).some(([key, value]) => row[key] !== value)
      || candidate.schemaVersion !== 'weekly-sample-policy-candidate.v1'
      || socialRequestHash(candidate.scope) !== socialRequestHash(scope)
      || candidate.selectionHash !== socialRequestHash(selection)
      || candidate.productId !== selection.productId || candidate.productName !== selection.productName
      || candidate.productSku !== selection.productSku
      || candidate.enterpriseFactContentHash !== selection.enterpriseFactContentHash
      || candidate.publicationHash !== selection.publicationHash
      || candidate.frozenCtaHash !== socialRequestHash(frozenCta)
      || candidate.reviewStatus !== 'pending_independent_verification'
      || candidate.authorizesProduction !== false || candidate.authorizesPublishing !== false
      || candidate.authorizesCustomerMessages !== false) fail('candidate_unverified');
    assertTerms(candidate.terms);
    await verifySource(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

/** No authenticated independent review issuer/operation and revocation ledger
 * exists yet. Absence of authority is intentional, even if a PDF was uploaded. */
export const WEEKLY_SIGNED_SAMPLE_POLICIES = 'social_weekly_signed_sample_policies';
/** This is server provisioning, never a client or tenant-admin request field.
 * No configured issuer and live revocation source means no production grant. */
export interface WeeklySamplePolicyAuthority {
  roots: readonly PreprovisionedPolicyTrustRoot[];
  isRevoked: (issuerId: string, policyId: string, keyId: string) => Promise<boolean | null>;
  metaProvider?: Parameters<typeof readLiveWeeklyWhatsAppCtaProof>[0]['provider'];
}
export interface VerifiedWeeklySamplePolicyEvidence {
  scope: SamplePolicyScope;
  policyId: string;
  policyHash: string;
  contactReceiptId: string;
  metaProofHash: string;
  productId: string;
  checkedAt: string;
  authorizesProduction: true;
  authorizesPublishing: false;
  authorizesCustomerMessages: false;
}

/** Re-read every mutable authority at admission time. The signed row is only
 * a transport for an independently issued signature; its self-hash is never
 * accepted as authority. The trusted root and revocation port must be installed
 * by the server, not supplied by an intervention card or stored in this table. */
export async function readWeeklySamplePolicyEvidence(input: {
  store: DataStore; scope: SamplePolicyScope; selection?: WeeklyPublicationProductSelection;
  now?: Date; authority?: WeeklySamplePolicyAuthority;
}): Promise<VerifiedWeeklySamplePolicyEvidence | null> {
  const { store, scope } = input;
  const authority = input.authority ?? provisionedWeeklySamplePolicyAuthority();
  if (!authority?.roots.length || typeof authority.isRevoked !== 'function') return null;
  const { selection, frozenCta } = await authoritativeContext(store, scope);
  if (input.selection && socialRequestHash(input.selection) !== socialRequestHash(selection)) return null;
  const contact = await readWeeklyCtaContact(store, scope);
  if (contact.status !== 'recorded' || !contact.receipt) return null;
  const rows = await store.list<Record_>(WEEKLY_SIGNED_SAMPLE_POLICIES, { where: where(scope), perPage: 2 });
  if (rows.totalItems !== 1 || rows.items.length !== 1) return null;
  const row = rows.items[0]!;
  const policy = row.payload as SignedSamplePolicy | undefined;
  if (!policy || row.content_hash !== socialRequestHash(policy) || row.id !== policy.policyId
    || Object.entries(where(scope)).some(([field, value]) => row[field] !== value)) return null;
  const programs = await store.list<Record_>('social_programs', {
    where: { tenant_id: scope.tenantId, program_id: scope.programId }, perPage: 2,
  });
  const program = programs.totalItems === 1 && programs.items.length === 1 ? programs.items[0]!.payload as { market?: unknown; targetAudience?: unknown } : null;
  const targetMarket = typeof program?.market === 'string' ? program.market.trim() : '';
  const customerType = typeof program?.targetAudience === 'string' ? program.targetAudience.trim() : '';
  if (!targetMarket || !customerType) return null;
  const verified = await verifyPreprovisionedSignedSamplePolicy({ policy,
    context: { scope, selectionHash: socialRequestHash(selection), productId: selection.productId,
      productSku: selection.productSku, enterpriseFactContentHash: selection.enterpriseFactContentHash,
      frozenCtaHash: socialRequestHash(frozenCta), contactReceiptId: contact.receipt.receiptId,
      contactHash: socialRequestHash(contact.receipt), targetMarket, customerType },
    preprovisionedRoots: authority.roots, isRevoked: authority.isRevoked, now: input.now });
  if (!verified) return null;
  const candidates = await inspectWeeklySamplePolicyCandidates(store, scope);
  if (candidates.filter(candidate => candidate.sourceSha256 === verified.sourceSha256).length !== 1) return null;
  const apps = await store.list<TenantPlatformAppRecord>('tenant_platform_apps', {
    where: { tenant_id: scope.tenantId, platform: 'meta' }, perPage: 21,
  });
  if (apps.totalItems < 1 || apps.totalItems > 20 || apps.items.length !== apps.totalItems) return null;
  const matching = apps.items.filter(app => app.status === 'active'
    && app.wa_public_number?.replace(/[^0-9]/g, '') === contact.receipt!.contactValue.replace(/[^0-9]/g, ''));
  if (matching.length !== 1) return null;
  let meta;
  try { meta = await readLiveWeeklyWhatsAppCtaProof({ store, tenantId: scope.tenantId,
    accountId: matching[0]!.id, expectedPublicNumber: contact.receipt.contactValue,
    provider: authority.metaProvider, now: input.now }); } catch { return null; }
  // Meta is a remote call. Re-read the mutable local bindings and issuer
  // revocation after it returns, so a simultaneous number or policy change
  // cannot authorize a new paid submission with an obsolete snapshot.
  const finalContext = await authoritativeContext(store, scope).catch(() => null);
  const finalContact = await readWeeklyCtaContact(store, scope).catch(() => null);
  const finalRows = await store.list<Record_>(WEEKLY_SIGNED_SAMPLE_POLICIES, { where: where(scope), perPage: 2 });
  const finalApps = await store.list<TenantPlatformAppRecord>('tenant_platform_apps', {
    where: { tenant_id: scope.tenantId, platform: 'meta' }, perPage: 21,
  });
  const finalMatching = finalApps.items.filter(app => app.status === 'active'
    && app.wa_public_number?.replace(/[^0-9]/g, '') === contact.receipt!.contactValue.replace(/[^0-9]/g, ''));
  const finalAccount = await readCanonicalWhatsAppAccount(store, scope.tenantId, matching[0]!.id).catch(() => null);
  if (!finalContext || socialRequestHash(finalContext.selection) !== socialRequestHash(selection)
    || socialRequestHash(finalContext.frozenCta) !== socialRequestHash(frozenCta)
    || finalContact?.status !== 'recorded' || !finalContact.receipt
    || socialRequestHash(finalContact.receipt) !== socialRequestHash(contact.receipt)
    || finalRows.totalItems !== 1 || finalRows.items.length !== 1
    || finalRows.items[0]?.id !== row.id
    || finalRows.items[0]?.content_hash !== row.content_hash
    || socialRequestHash(finalRows.items[0]?.payload) !== socialRequestHash(policy)
    || finalApps.totalItems < 1 || finalApps.totalItems > 20 || finalApps.items.length !== finalApps.totalItems
    || finalMatching.length !== 1 || finalMatching[0]!.id !== matching[0]!.id
    || finalAccount?.accountHash !== meta.accountHash) return null;
  try { if (await authority.isRevoked(verified.issuerId, verified.policyId, verified.keyId) !== false) return null; }
  catch { return null; }
  const checkedAt = (input.now ?? new Date()).toISOString();
  return { scope, policyId: verified.policyId, policyHash: socialRequestHash(verified),
    contactReceiptId: contact.receipt.receiptId, metaProofHash: meta.proofHash,
    productId: selection.productId, checkedAt, authorizesProduction: true,
    authorizesPublishing: false, authorizesCustomerMessages: false };
}
