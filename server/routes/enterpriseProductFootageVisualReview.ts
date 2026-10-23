/** Independent, signed observations of bounded windows in an owned product video.
 * Uploader metadata is never a visual observation. The base rights approval and
 * its revocation remain authoritative for every projected window. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import type { DataStore, Record_ } from '../storage/datastore.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import { objectStorageDownload } from '../storage/objectStorage.js';
import { normalizeSceneVisualContract, type SocialSceneVisualContract } from '../../shared/sceneVisualContract.js';
import { readApprovedProductFootage, type FootageAuthority, type SignedFootage } from './enterpriseProductFootageReview.js';

export const PRODUCT_FOOTAGE_VISUAL_REVIEWS = 'social_product_footage_visual_reviews';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const idFor = (value: unknown) => hash(value).slice(0, 15);
const fail = (reason: string): never => { throw Error(`product_footage_visual_${reason}`); };

export type FootageVisualAuthority = FootageAuthority;
export type FootageVisualFinding = {
  kind: 'product-footage-visual.v1'; keyId: string; issuerId: string;
  tenantId: string; productId: string; materialId: string; contentSha256: string;
  baseApprovalId: string; segmentId: string; startMs: number; endMs: number;
  observedProductId: string; sceneFunction: string;
  visualContract: SocialSceneVisualContract; cleanEntry: boolean; cleanExit: boolean;
  reviewedAt: string; expiresAt: string;
};

export function configuredFootageVisualAuthorities(): FootageVisualAuthority[] {
  try {
    const raw = JSON.parse(process.env.PRODUCT_FOOTAGE_VISUAL_AUTHORITIES_JSON || '[]');
    return Array.isArray(raw) ? raw.filter(value => value && typeof value.keyId === 'string'
      && typeof value.issuerId === 'string' && typeof value.publicKeyPem === 'string') : [];
  } catch { return []; }
}

function signatureValid(signed: SignedFootage<FootageVisualFinding>, authorities: FootageVisualAuthority[]): boolean {
  const matches = authorities.filter(key => key.keyId === signed.statement.keyId
    && key.issuerId === signed.statement.issuerId);
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{80,120}$/.test(signed.signatureBase64url)) return false;
  try {
    const key = createPublicKey(matches[0]!.publicKeyPem);
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(JSON.stringify(signed.statement)), key,
      Buffer.from(signed.signatureBase64url, 'base64url'));
  } catch { return false; }
}

function statementValid(input: {
  signed: SignedFootage<FootageVisualFinding>; material: MaterialRecord;
  authorities: FootageVisualAuthority[]; now: Date; durationMs: number;
  allowExpired?: boolean;
}): boolean {
  const s = input.signed.statement;
  const received = Date.parse(String(input.material.provenance?.receivedAt || ''));
  const reviewed = Date.parse(s.reviewedAt), expires = Date.parse(s.expiresAt);
  if (s.kind !== 'product-footage-visual.v1' || !/^[a-f0-9]{64}$/.test(s.contentSha256)
    || !/^[A-Za-z0-9_-]{1,80}$/.test(s.segmentId) || !/^[a-f0-9]{15}$/.test(s.baseApprovalId)
    || !Number.isSafeInteger(s.startMs) || !Number.isSafeInteger(s.endMs)
    || s.startMs < 0 || s.endMs - s.startMs < 500 || s.endMs - s.startMs > 60_000
    || s.endMs > input.durationMs + 40 || !Number.isFinite(received)
    || !Number.isFinite(reviewed) || reviewed < received || reviewed > input.now.getTime()
    || !Number.isFinite(expires) || (!input.allowExpired && expires <= input.now.getTime()) || expires <= reviewed
    || s.tenantId !== String(input.material.tenantId || input.material.tenant_id || '')
    || s.productId !== String(input.material.productId || '') || s.materialId !== input.material.id
    || s.contentSha256 !== String(input.material.contentSha256 || '').toLowerCase()
    || s.observedProductId !== s.productId
    || !['value', 'hook', 'transition', 'proof', 'd_to_c', 'problem', 'demonstration',
      'trust', 'call_to_action'].includes(s.sceneFunction)
    || s.cleanEntry !== true || s.cleanExit !== true
    || String(input.material.provenance?.uploadedByUserId || '') === s.issuerId
    || !signatureValid(input.signed, input.authorities)) return false;
  try {
    const visual = normalizeSceneVisualContract(s.visualContract);
    return visual.productUsage.productId === s.productId
      && visual.product.requestedProductId === s.productId
      && visual.subjects.some(subject => subject.kind === 'product')
      && visual.evidence.sourceRange?.startSeconds === s.startMs / 1000
      && visual.evidence.sourceRange?.endSeconds === s.endMs / 1000;
  } catch { return false; }
}

async function currentDurationMs(material: MaterialRecord): Promise<number | null> {
  const object = await objectStorageDownload(String(material.objectKey || ''));
  if (!object || object.contentType !== 'video/mp4' || object.buf.length < 1
    || object.buf.length > 30 * 1024 * 1024
    || createHash('sha256').update(object.buf).digest('hex') !== String(material.contentSha256 || '').toLowerCase()) return null;
  if (!ffmpegStatic) return null;
  // ffmpeg-static is the project's existing bundled binary. Metadata-only
  // invocation exits nonzero without an output target, but reports duration.
  const probe = spawnSync(ffmpegStatic, ['-hide_banner', '-i', 'pipe:0'],
    { input: object.buf, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
  const match = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(probe.stderr || ''));
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
  return !probe.error && Number.isFinite(duration) && duration >= 0.5 && duration <= 3600
    ? Math.round(duration * 1000) : null;
}

async function rows(store: DataStore, tenantId: string, materialId: string): Promise<Record_[]> {
  const items: Record_[] = []; let count: number | null = null;
  for (let page = 1; page <= 1000; page++) {
    const batch = await store.list<Record_>(PRODUCT_FOOTAGE_VISUAL_REVIEWS, {
      where: { tenant_id: tenantId, material_id: materialId }, page, perPage: 100, sort: 'id',
    });
    if (!Number.isSafeInteger(batch.totalItems) || batch.totalItems < 0
      || count !== null && count !== batch.totalItems) fail('pagination_invalid');
    count = batch.totalItems;
    items.push(...batch.items);
    if (items.length === count) return items;
    if (!batch.items.length) fail('pagination_invalid');
  }
  return fail('pagination_invalid');
}

export async function recordProductFootageVisualFinding(input: {
  store: DataStore; material: MaterialRecord; signed: SignedFootage<FootageVisualFinding>;
  visualAuthorities?: FootageVisualAuthority[]; rightsAuthorities?: FootageAuthority[]; now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date(), s = input.signed.statement;
  const durationMs = await currentDurationMs(input.material).catch(() => null);
  if (durationMs === null || !statementValid({ signed: input.signed, material: input.material,
    authorities: input.visualAuthorities ?? configuredFootageVisualAuthorities(), now, durationMs })) fail('finding_invalid');
  const base = await readApprovedProductFootage({ store: input.store, material: input.material,
    tenantId: s.tenantId, productId: s.productId, sceneFunction: s.sceneFunction,
    authorities: input.rightsAuthorities, now });
  if (!base || base.approvalId !== s.baseApprovalId) fail('base_approval_invalid');
  const id = idFor(['footage-visual', input.signed]);
  const prior = await input.store.getById<Record_>(PRODUCT_FOOTAGE_VISUAL_REVIEWS, id);
  if (prior) {
    if (prior.content_hash !== hash(input.signed) || hash(prior.payload) !== hash(input.signed)) fail('finding_conflict');
    return id;
  }
  const written = await input.store.create<Record_>(PRODUCT_FOOTAGE_VISUAL_REVIEWS, {
    id, tenant_id: s.tenantId, material_id: s.materialId, product_id: s.productId,
    content_hash: hash(input.signed), payload: input.signed,
  });
  if (!written || written.id !== id || written.content_hash !== hash(input.signed)) fail('finding_write_failed');
  return id;
}

/** Returns a server-only overlay for the existing material planner. No mutable
 * uploaded `segments`, `scriptAnalysis`, rights booleans or product tags survive. */
export async function readApprovedProductFootageVisualOverlay(input: {
  store: DataStore; material: MaterialRecord; tenantId: string; productId: string;
  visualAuthorities?: FootageVisualAuthority[]; rightsAuthorities?: FootageAuthority[]; now?: Date;
}): Promise<MaterialRecord | null> {
  const now = input.now ?? new Date();
  if (!input.store || !input.tenantId || !input.productId) return null;
  const durationMs = await currentDurationMs(input.material).catch(() => null);
  if (durationMs === null) return null;
  const findings = await rows(input.store, input.tenantId, input.material.id);
  const shots = [];
  const windows: Array<{ start: number; end: number }> = [];
  for (const row of findings) {
    const signed = row.payload as SignedFootage<FootageVisualFinding>;
    const s = signed?.statement;
    if (!s || row.id !== idFor(['footage-visual', signed]) || row.content_hash !== hash(signed)
      || row.tenant_id !== input.tenantId || row.material_id !== input.material.id
      || row.product_id !== s.productId || s.productId !== input.productId
      || !statementValid({ signed, material: input.material,
        authorities: input.visualAuthorities ?? configuredFootageVisualAuthorities(), now, durationMs,
        allowExpired: true })) fail('finding_ledger_invalid');
    // An expired, still-authentic observation is history, not a corrupt row.
    // It must not poison a later independently reviewed window on the same video.
    if (Date.parse(s.expiresAt) <= now.getTime()) continue;
    const base = await readApprovedProductFootage({ store: input.store, material: input.material,
      tenantId: input.tenantId, productId: input.productId, sceneFunction: s.sceneFunction,
      authorities: input.rightsAuthorities, now });
    // A revoked or expired base approval makes the whole candidate unavailable.
    if (!base || base.approvalId !== s.baseApprovalId) continue;
    if (windows.some(window => s.startMs < window.end && s.endMs > window.start)) fail('overlapping_findings');
    windows.push({ start: s.startMs, end: s.endMs });
    const visualContract = normalizeSceneVisualContract(s.visualContract);
    shots.push({ segmentId: s.segmentId, startSeconds: s.startMs / 1000, endSeconds: s.endMs / 1000,
      footageEvidence: { contentSha256: s.contentSha256, productId: s.productId,
        sceneFunction: s.sceneFunction, approvalId: s.baseApprovalId, visualFindingId: row.id },
      role: 'demonstration' as const, instruction: s.sceneFunction,
      observedEvidence: [s.sceneFunction], matchTags: [s.sceneFunction], confidence: 1, needsReview: false,
      visualContract, materialRoles: ['product' as const], editorial: {
        subjects: ['product'], actions: [visualContract.action.path], environments: [], shotLanguage: [],
        motionLevel: 'unknown' as const, trim: {
          preferredStartSeconds: s.startMs / 1000, preferredEndSeconds: s.endMs / 1000,
          actionPeakSeconds: null, boundaryConfidence: 1, cleanEntry: true, cleanExit: true,
        },
      },
    });
  }
  if (!shots.length || new Set(shots.map(shot => shot.segmentId)).size !== shots.length) return null;
  const sha = String(input.material.contentSha256).toLowerCase();
  return { ...input.material, tenantId: input.tenantId, productId: input.productId,
    sourceRevision: sha, analysisSourceRevision: sha,
    rightsStatus: 'authorized', commercialUseApproved: true, derivativeUseAllowed: true,
    rightsEvidenceRef: `product-footage-review:${findings.map(row => row.id).join(',')}`,
    scriptAnalysis: { schemaVersion: 'material-script-analysis.v3', status: 'ready', sourceRevision: sha,
      shots },
  };
}
