/** Independent product-footage evidence. The tenant upload never issues its own approval. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import { currentProductFootageCandidateBytes } from './enterpriseProductFootageCandidate.js';

export const PRODUCT_FOOTAGE_REVIEWS = 'social_product_footage_reviews';
export const PRODUCT_FOOTAGE_REVOCATIONS = 'social_product_footage_revocations';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rowId = (value: unknown) => digest(value).slice(0, 15);
const fail = (reason: string): never => { throw Error(`product_footage_review_${reason}`); };

export type FootageAuthority = { keyId: string; issuerId: string; publicKeyPem: string };
export type FootageApproval = {
  kind: 'product-footage-approval.v1'; keyId: string; issuerId: string;
  tenantId: string; productId: string; materialId: string; contentSha256: string;
  objectKey: string; identityEvidenceRef: string; rightsEvidenceRef: string;
  rightsEvidenceSha256: string; observedProductId: string;
  sceneFunctions: string[]; reviewedAt: string; expiresAt: string;
};
export type FootageRevocation = {
  kind: 'product-footage-revocation.v1'; keyId: string; issuerId: string;
  tenantId: string; productId: string; materialId: string; approvalId: string;
  revokedAt: string; reason: string;
};
export type SignedFootage<T> = { statement: T; signatureBase64url: string };

/** A deployment-provisioned public key is the trust root. No private key,
 * tenant-supplied key, or same-card review toggle is accepted here. */
export function configuredFootageAuthorities(): FootageAuthority[] {
  try {
    const raw = JSON.parse(process.env.PRODUCT_FOOTAGE_REVIEW_AUTHORITIES_JSON || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(value => value && typeof value.keyId === 'string'
      && typeof value.issuerId === 'string' && typeof value.publicKeyPem === 'string');
  } catch { return []; }
}
function signatureValid<T extends { keyId: string; issuerId: string }>(
  signed: SignedFootage<T>, authorities: FootageAuthority[],
): boolean {
  const matches = authorities.filter(authority => authority.keyId === signed.statement.keyId
    && authority.issuerId === signed.statement.issuerId);
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{80,120}$/.test(signed.signatureBase64url)) return false;
  try {
    const key = createPublicKey(matches[0]!.publicKeyPem);
    return key.asymmetricKeyType === 'ed25519' && verify(null,
      Buffer.from(JSON.stringify(signed.statement)), key,
      Buffer.from(signed.signatureBase64url, 'base64url'));
  } catch { return false; }
}
function chronology(value: string, now: Date): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= now.getTime() ? time : null;
}
function candidateMatches(material: MaterialRecord, statement: FootageApproval): boolean {
  const candidate = material.provenance?.footageCandidate;
  return material.id === statement.materialId
    && String(material.tenantId || material.tenant_id || '') === statement.tenantId
    && String(material.productId || '') === statement.productId
    && String(material.contentSha256 || '').toLowerCase() === statement.contentSha256
    && String(material.objectKey || '') === statement.objectKey
    && candidate?.productId === statement.productId
    && candidate?.identityEvidenceRef === statement.identityEvidenceRef
    && candidate?.rightsEvidenceRef === statement.rightsEvidenceRef
    && typeof material.provenance?.uploadedByUserId === 'string'
    && material.provenance.uploadedByUserId.length > 0
    && material.provenance.uploadedByUserId !== statement.issuerId;
}
function validApproval(input: {
  material: MaterialRecord; signed: SignedFootage<FootageApproval>;
  authorities: FootageAuthority[]; now: Date;
}): boolean {
  const { statement } = input.signed;
  const reviewed = chronology(statement.reviewedAt, input.now);
  const expires = Date.parse(statement.expiresAt);
  return statement.kind === 'product-footage-approval.v1'
    && /^[a-f0-9]{64}$/.test(statement.contentSha256)
    && /^[a-f0-9]{64}$/.test(statement.rightsEvidenceSha256)
    && statement.observedProductId === statement.productId
    && Array.isArray(statement.sceneFunctions) && statement.sceneFunctions.length > 0
    && statement.sceneFunctions.length <= 32
    && statement.sceneFunctions.every(item => typeof item === 'string' && item.trim() === item
      && item.length >= 3 && item.length <= 120)
    && new Set(statement.sceneFunctions).size === statement.sceneFunctions.length
    && reviewed !== null && Number.isFinite(expires) && expires > reviewed
    && reviewed >= Date.parse(String(input.material.provenance?.receivedAt || ''))
    && candidateMatches(input.material, statement)
    && signatureValid(input.signed, input.authorities);
}
function storedStatement<T>(row: Record_ | null, signed: SignedFootage<T>, id: string): boolean {
  return Boolean(row && row.id === id && row.content_hash === digest(signed)
    && digest(row.payload) === digest(signed));
}
async function scopedRows(store: DataStore, collection: string, where: Record<string, string>): Promise<Record_[]> {
  const items: Record_[] = []; const ids = new Set<string>(); let count: number | null = null;
  for (let page = 1; page <= 1000; page++) {
    const batch = await store.list<Record_>(collection, { where, page, perPage: 100, sort: 'id' });
    if (!Number.isSafeInteger(batch.totalItems) || batch.totalItems < 0
      || count !== null && count !== batch.totalItems) fail('pagination_invalid');
    count = batch.totalItems;
    for (const item of batch.items) {
      if (!item.id || ids.has(item.id)) fail('pagination_invalid');
      ids.add(item.id); items.push(item);
    }
    if (items.length === count) return items;
    if (!batch.items.length) fail('pagination_invalid');
  }
  return fail('pagination_invalid');
}
const scope = (tenantId: string, materialId: string) => ({ tenant_id: tenantId, material_id: materialId });

/** Import an externally signed finding after re-reading the exact owned bytes.
 * The signature is created outside this application by the configured issuer. */
export async function recordProductFootageApproval(input: {
  store: DataStore; material: MaterialRecord; signed: SignedFootage<FootageApproval>;
  authorities?: FootageAuthority[]; now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date(), authorities = input.authorities ?? configuredFootageAuthorities();
  const signed = input.signed, statement = signed.statement;
  if (!validApproval({ material: input.material, signed, authorities, now })
    || Date.parse(statement.expiresAt) <= now.getTime()
    || !await currentProductFootageCandidateBytes({ material: input.material,
      tenantId: statement.tenantId, productId: statement.productId }).catch(() => false)) fail('approval_invalid');
  const id = rowId(['footage-approval', signed]);
  const previous = await input.store.getById<Record_>(PRODUCT_FOOTAGE_REVIEWS, id);
  if (previous) {
    if (!storedStatement(previous, signed, id)) fail('approval_conflict');
    return id;
  }
  const written = await input.store.create(PRODUCT_FOOTAGE_REVIEWS, {
    id, ...scope(statement.tenantId, statement.materialId), product_id: statement.productId,
    content_hash: digest(signed), payload: signed,
  });
  if (!written || !storedStatement(written, signed, id)) fail('approval_write_failed');
  return id;
}
/** Revocation is a separate signed immutable row, never a mutable status bit. */
export async function recordProductFootageRevocation(input: {
  store: DataStore; signed: SignedFootage<FootageRevocation>;
  authorities?: FootageAuthority[]; now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date(), signed = input.signed, statement = signed.statement;
  const approvalRow = await input.store.getById<Record_>(PRODUCT_FOOTAGE_REVIEWS, statement.approvalId);
  const approval = (approvalRow?.payload as SignedFootage<FootageApproval> | undefined)?.statement;
  if (statement.kind !== 'product-footage-revocation.v1'
    || !approvalRow || !approval || approvalRow.content_hash !== digest(approvalRow.payload)
    || statement.tenantId !== approval.tenantId || statement.productId !== approval.productId
    || statement.materialId !== approval.materialId || statement.keyId !== approval.keyId
    || statement.issuerId !== approval.issuerId || chronology(statement.revokedAt, now) === null
    || Date.parse(statement.revokedAt) < Date.parse(approval.reviewedAt)
    || !statement.reason?.trim() || statement.reason.length > 1000
    || !signatureValid(signed, input.authorities ?? configuredFootageAuthorities())) fail('revocation_invalid');
  const id = rowId(['footage-revocation', statement.approvalId]);
  const previous = await input.store.getById<Record_>(PRODUCT_FOOTAGE_REVOCATIONS, id);
  if (previous) {
    if (!storedStatement(previous, signed, id)) fail('revocation_conflict');
    return id;
  }
  const written = await input.store.create(PRODUCT_FOOTAGE_REVOCATIONS, {
    id, ...scope(statement.tenantId, statement.materialId), approval_id: statement.approvalId,
    content_hash: digest(signed), payload: signed,
  });
  if (!written || !storedStatement(written, signed, id)) fail('revocation_write_failed');
  return id;
}

/** Production read always rechecks current bytes, trust root, signed finding,
 * complete revocation index and requested scene function. */
export async function readApprovedProductFootage(input: {
  store: DataStore; material: MaterialRecord; tenantId: string; productId: string;
  sceneFunction: string; authorities?: FootageAuthority[]; now?: Date;
}): Promise<{ approvalId: string; material: MaterialRecord } | null> {
  const { store, material, tenantId, productId } = input;
  const now = input.now ?? new Date(), authorities = input.authorities ?? configuredFootageAuthorities();
  if (!authorities.length || !input.sceneFunction || !material.id
    || String(material.tenantId || material.tenant_id || '') !== tenantId
    || String(material.productId || '') !== productId
    || !await currentProductFootageCandidateBytes({ material, tenantId, productId }).catch(() => false)) return null;
  const where = scope(tenantId, material.id);
  const approvals = await scopedRows(store, PRODUCT_FOOTAGE_REVIEWS, where);
  const revocations = await scopedRows(store, PRODUCT_FOOTAGE_REVOCATIONS, where);
  if ([...approvals, ...revocations].some(row => row.tenant_id !== tenantId || row.material_id !== material.id)) fail('scope_invalid');
  const approvalIds = new Set(approvals.map(row => row.id));
  if (revocations.some(row => !approvalIds.has(String(row.approval_id)))) fail('revocation_orphan');
  const valid: string[] = [];
  for (const row of approvals) {
    const signed = row.payload as SignedFootage<FootageApproval>;
    const id = rowId(['footage-approval', signed]);
    if (row.id !== id || row.content_hash !== digest(signed)
      || row.product_id !== signed?.statement?.productId
      || !validApproval({ material, signed, authorities, now })) fail('approval_ledger_invalid');
    const revocationId = rowId(['footage-revocation', id]);
    const indexed = revocations.filter(item => item.approval_id === id);
    const direct = await store.getById<Record_>(PRODUCT_FOOTAGE_REVOCATIONS, revocationId);
    if (indexed.length > 1 || indexed.some(item => item.id !== revocationId)
      || Boolean(indexed.length) !== Boolean(direct)) fail('revocation_index_invalid');
    if (direct) {
      const revoke = direct.payload as SignedFootage<FootageRevocation>;
      if (!storedStatement(direct, revoke, revocationId)
        || revoke.statement.kind !== 'product-footage-revocation.v1'
        || revoke.statement.approvalId !== id || revoke.statement.tenantId !== tenantId
        || revoke.statement.productId !== productId || revoke.statement.materialId !== material.id
        || revoke.statement.keyId !== signed.statement.keyId
        || revoke.statement.issuerId !== signed.statement.issuerId
        || chronology(revoke.statement.revokedAt, now) === null
        || Date.parse(revoke.statement.revokedAt) < Date.parse(signed.statement.reviewedAt)
        || !signatureValid(revoke, authorities)) fail('revocation_ledger_invalid');
    } else if (Date.parse(signed.statement.expiresAt) > now.getTime()
      && signed.statement.sceneFunctions.includes(input.sceneFunction)) valid.push(id);
  }
  if (valid.length !== 1) return null;
  return { approvalId: valid[0]!, material };
}
