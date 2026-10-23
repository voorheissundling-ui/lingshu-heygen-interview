/** Transport for independently signed product-footage findings. This route
 * never signs a finding or accepts a tenant-provided trust root. */
import { Router } from 'express';
import type { DataStore } from '../storage/datastore.js';
import type { MaterialRecord } from '../lib/materialLibrary.js';
import { readMaterialLibrary } from '../lib/materialLibrary.js';
import type { AuthLocals } from '../middleware/auth.js';
import { recordProductFootageApproval, recordProductFootageRevocation,
  type FootageApproval, type FootageRevocation, type SignedFootage } from './enterpriseProductFootageReview.js';
import { recordProductFootageVisualFinding, type FootageVisualFinding } from './enterpriseProductFootageVisualReview.js';

type SignedStatement = FootageApproval | FootageRevocation | FootageVisualFinding;
const own = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key)));

export function createEnterpriseProductFootageImportRouter(
  store: DataStore,
  materials: (tenantId: string) => Promise<{ status: 'ready' | 'partial' | 'unavailable'; items: MaterialRecord[] }> = readMaterialLibrary,
) {
  const router = Router();
  router.post('/signed-finding', async (req, res) => {
    const { tenantId } = res.locals as AuthLocals;
    const body = req.body;
    if (!tenantId || !own(body, ['signed']) || !own(body.signed, ['statement', 'signatureBase64url'])
      || !body.signed.statement || typeof body.signed.statement !== 'object'
      || Array.isArray(body.signed.statement)
      || typeof body.signed.signatureBase64url !== 'string'
      || JSON.stringify(body).length > 16_384) {
      res.status(400).json({ error: 'product_footage_signed_finding_invalid' }); return;
    }
    const signed = body.signed as SignedFootage<SignedStatement>;
    const statement = signed.statement;
    if (statement.tenantId !== tenantId || !statement.materialId || !statement.productId) {
      res.status(404).json({ error: 'product_footage_material_not_found' }); return;
    }
    try {
      let receiptId: string;
      if (statement.kind === 'product-footage-revocation.v1') {
        receiptId = await recordProductFootageRevocation({ store,
          signed: signed as SignedFootage<FootageRevocation> });
      } else {
        const inventory = await materials(tenantId);
        if (inventory.status !== 'ready') { res.status(503).json({ error: 'product_footage_inventory_unavailable' }); return; }
        const matches = inventory.items.filter(item => item.id === statement.materialId
          && String(item.tenantId || item.tenant_id || '') === tenantId
          && String(item.productId || '') === statement.productId);
        if (matches.length !== 1) { res.status(404).json({ error: 'product_footage_material_not_found' }); return; }
        if (statement.kind === 'product-footage-approval.v1') {
          receiptId = await recordProductFootageApproval({ store, material: matches[0]!,
            signed: signed as SignedFootage<FootageApproval> });
        } else if (statement.kind === 'product-footage-visual.v1') {
          receiptId = await recordProductFootageVisualFinding({ store, material: matches[0]!,
            signed: signed as SignedFootage<FootageVisualFinding> });
        } else { res.status(400).json({ error: 'product_footage_signed_finding_invalid' }); return; }
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ receiptId, kind: statement.kind });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/^product_footage_(?:review|visual)_[a-z_]+$/.test(message)) {
        res.status(422).json({ error: 'product_footage_signed_finding_rejected' }); return;
      }
      res.status(503).json({ error: 'product_footage_review_storage_unavailable' });
    }
  });
  return router;
}
