import type { MaterialRecord } from '../lib/materialLibrary.js';
import type { DataStore } from '../storage/datastore.js';
import {
  readApprovedProductFootage,
  readApprovedProductFootageVisualOverlay,
  type FootageAuthority,
  type FootageVisualAuthority,
} from '../lib/productFootageAdmissionReaders.js';

/** A production read must use the current server inventory, not a frozen plan's
 * copy of an editable material row. Approval is scoped to one exact shot use. */
export async function readProductionProductFootageAdmission(input: {
  store: DataStore;
  readMaterials: (tenantId: string) => Promise<{ status: 'ready' | 'partial' | 'unavailable'; items: MaterialRecord[] }>;
  tenantId: string;
  productId: string;
  materialId: string;
  sceneFunction: string;
  expectedContentSha256: string;
  expectedApprovalId?: string;
  authorities?: FootageAuthority[];
  now?: Date;
}): Promise<{ approvalId: string; material: MaterialRecord } | null> {
  if (!input.tenantId || !input.productId || !input.materialId || !input.sceneFunction
    || !/^[a-f0-9]{64}$/.test(input.expectedContentSha256)) return null;
  const inventory = await input.readMaterials(input.tenantId);
  if (inventory.status !== 'ready') return null;
  const matches = inventory.items.filter(item => item.id === input.materialId);
  if (matches.length !== 1) return null;
  const material = matches[0]!;
  if (String(material.tenantId || material.tenant_id || '') !== input.tenantId
    || String(material.productId || '') !== input.productId
    || String(material.contentSha256 || '').toLowerCase() !== input.expectedContentSha256
    || material.type !== 'video' || !material.provenance?.footageCandidate) return null;
  const approved = await readApprovedProductFootage({ store: input.store, material,
    tenantId: input.tenantId, productId: input.productId,
    sceneFunction: input.sceneFunction, authorities: input.authorities, now: input.now });
  if (!approved || input.expectedApprovalId && approved.approvalId !== input.expectedApprovalId) return null;
  return approved;
}

/** The execution-side counterpart of the planner overlay. A frozen segment
 * reference is not an authorization: re-read current inventory, bytes, rights,
 * revocations and the independent visual finding for this exact shot window. */
export async function readProductionProductFootageSegment(input: {
  store: DataStore;
  readMaterials: (tenantId: string) => Promise<{ status: 'ready' | 'partial' | 'unavailable'; items: MaterialRecord[] }>;
  tenantId: string; productId: string; materialId: string; sceneFunction: string;
  segmentId: string; startSeconds: number; endSeconds: number;
  expectedContentSha256: string;
  expectedApprovalId: string; expectedVisualFindingId: string;
  visualAuthorities?: FootageVisualAuthority[]; rightsAuthorities?: FootageAuthority[]; now?: Date;
}): Promise<{ material: MaterialRecord; segmentId: string; startSeconds: number; endSeconds: number } | null> {
  if (!input.segmentId || !/^[a-f0-9]{15}$/.test(input.expectedApprovalId)
    || !/^[a-f0-9]{15}$/.test(input.expectedVisualFindingId)
    || !Number.isFinite(input.startSeconds) || !Number.isFinite(input.endSeconds)
    || input.startSeconds < 0 || input.endSeconds <= input.startSeconds) return null;
  const inventory = await input.readMaterials(input.tenantId);
  if (inventory.status !== 'ready') return null;
  const matches = inventory.items.filter(item => item.id === input.materialId);
  if (matches.length !== 1) return null;
  const material = matches[0]!;
  if (String(material.tenantId || material.tenant_id || '') !== input.tenantId
    || material.productId !== input.productId || material.type !== 'video'
    || !material.provenance?.footageCandidate
    || !/^[a-f0-9]{64}$/.test(input.expectedContentSha256)
    || String(material.contentSha256 || '').toLowerCase() !== input.expectedContentSha256) return null;
  const overlay = await readApprovedProductFootageVisualOverlay({ store: input.store, material,
    tenantId: input.tenantId, productId: input.productId,
    visualAuthorities: input.visualAuthorities, rightsAuthorities: input.rightsAuthorities, now: input.now });
  if (!overlay) return null;
  const shots = overlay.scriptAnalysis?.shots ?? [];
  const exact = shots.filter((shot: { segmentId?: string; startSeconds?: number;
    endSeconds?: number; instruction?: string; footageEvidence?: {
      approvalId?: string; visualFindingId?: string; contentSha256?: string;
      productId?: string; sceneFunction?: string;
    } }) => shot.segmentId === input.segmentId
    && shot.startSeconds === input.startSeconds && shot.endSeconds === input.endSeconds
    && shot.instruction === input.sceneFunction
    && shot.footageEvidence?.approvalId === input.expectedApprovalId
    && shot.footageEvidence?.visualFindingId === input.expectedVisualFindingId
    && shot.footageEvidence?.contentSha256 === input.expectedContentSha256
    && shot.footageEvidence?.productId === input.productId
    && shot.footageEvidence?.sceneFunction === input.sceneFunction);
  return exact.length === 1 ? { material: overlay, segmentId: input.segmentId,
    startSeconds: input.startSeconds, endSeconds: input.endSeconds } : null;
}
