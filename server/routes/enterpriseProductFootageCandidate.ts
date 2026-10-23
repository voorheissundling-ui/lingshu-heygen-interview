/** Product footage is an enterprise material candidate, never a production match by upload alone. */
import { createHash } from 'node:crypto';
import { enterpriseAssetObjectKey } from '../storage/enterpriseAssets.js';
import { objectStorageDownload, objectStorageHead } from '../storage/objectStorage.js';

export function productFootageCandidateEvidence(input: {
  productId: string;
  mediaType: string;
  identityEvidenceRef: unknown;
  rightsEvidenceRef: unknown;
}): { productId: string; identityEvidenceRef: string; rightsEvidenceRef: string } | null {
  if (!input.productId || !input.mediaType.startsWith('video/')) return null;
  const identityEvidenceRef = typeof input.identityEvidenceRef === 'string' ? input.identityEvidenceRef.trim() : '';
  const rightsEvidenceRef = typeof input.rightsEvidenceRef === 'string' ? input.rightsEvidenceRef.trim() : '';
  // A stable document or review reference is required. A boolean self-attestation
  // is not sufficient and these references do not themselves clear rights.
  const valid = (value: string) => value.length >= 12 && value.length <= 512
    && !/[\u0000-\u001f<>]/.test(value) && !/^\s*(?:true|yes|confirmed|已确认)\s*$/i.test(value);
  return valid(identityEvidenceRef) && valid(rightsEvidenceRef)
    ? { productId: input.productId, identityEvidenceRef, rightsEvidenceRef } : null;
}

/** Re-read owned bytes before showing an intake candidate or assessing it.
 * A mutable URL, metadata hash or product tag is never proof of current media. */
export async function currentProductFootageCandidateBytes(input: {
  material: Record<string, any>; tenantId: string; productId: string;
}): Promise<boolean> {
  const record = input.material;
  const sha = String(record.contentSha256 || '').toLowerCase();
  const url = String(record.sourceUrl || '');
  const filename = /^\/api\/overseas\/enterprise\/assets\/([0-9]+-[0-9a-f-]{36}\.mp4)$/i.exec(url)?.[1];
  if (!filename || !/^[a-f0-9]{64}$/.test(sha) || record.type !== 'video'
    || String(record.tenantId || record.tenant_id || '') !== input.tenantId
    || String(record.productId || '') !== input.productId
    || String(record.objectKey || '') !== enterpriseAssetObjectKey(input.tenantId, filename)
    || !['pending_independent_review', 'approved'].includes(record.provenance?.footageCandidate?.status)) return false;
  const head = await objectStorageHead(record.objectKey);
  if (!head || head.size < 1 || head.size > 30 * 1024 * 1024 || head.contentType !== 'video/mp4') return false;
  const object = await objectStorageDownload(record.objectKey);
  return Boolean(object && object.contentType === 'video/mp4' && object.buf.length === head.size
    && createHash('sha256').update(object.buf).digest('hex') === sha);
}
