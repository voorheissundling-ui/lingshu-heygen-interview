import { Router, type Response } from 'express';
import type { AuthLocals } from '../middleware/auth.js';
import type { DataStore } from '../storage/datastore.js';
import {
  PRODUCTION_INPUT_CATEGORIES,
  type ProductionInputCategory,
} from '../../shared/contracts/productionInputRequest.js';
import {
  getProductionInputRequest,
  listProductionInputRequests,
  ProductionInputRequestError,
} from '../production/productionInputRequests.js';
import {
  getProductionCostQuote,
  listProductionCostQuotes,
  ProductionCostQuoteError,
} from '../production/productionCostQuotes.js';

function sendError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ProductionInputRequestError || error instanceof ProductionCostQuoteError) {
    res.status(error.status).json({ ok: false, code: error.code, error: error.code });
    return;
  }
  res.status(503).json({ ok: false, code: fallback, error: error instanceof Error ? error.message : fallback });
}

function internalMutationOnly(res: Response, code: string): void {
  res.status(403).json({
    ok: false,
    code,
    error: code,
    message: '该状态只能由已校验的生产工作流写入，不接受浏览器直接提交。',
  });
}

export function createProductionInputRequestsRouter(store: DataStore, options: { productOnly?: boolean } = {}) {
  const router = Router();
  router.get('/', async (req, res) => {
    try {
      const { tenantId } = res.locals as AuthLocals;
      const requestedCategory = typeof req.query.category === 'string' ? req.query.category : '';
      if (!options.productOnly && requestedCategory
        && !(PRODUCTION_INPUT_CATEGORIES as readonly string[]).includes(requestedCategory)) {
        throw new ProductionInputRequestError('production_input_category_invalid');
      }
      const category: ProductionInputCategory | undefined = options.productOnly ? 'product_asset'
        : requestedCategory ? requestedCategory as ProductionInputCategory : undefined;
      const items = await listProductionInputRequests({
        store,
        tenantId,
        category,
        productId: typeof req.query.productId === 'string' ? req.query.productId : undefined,
        taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
        includeResolved: req.query.includeResolved === 'true',
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, items });
    } catch (error) { sendError(res, error, 'production_input_list_failed'); }
  });

  router.post('/', (_req, res) => internalMutationOnly(res, 'production_input_creation_internal_only'));

  router.get('/:id', async (req, res) => {
    try {
      const { tenantId } = res.locals as AuthLocals;
      const request = await getProductionInputRequest({ store, tenantId, requestId: req.params.id });
      if (!request || (options.productOnly && request.category !== 'product_asset')) {
        res.status(404).json({ ok: false, code: 'production_input_not_found', error: 'production_input_not_found' }); return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, request });
    } catch (error) { sendError(res, error, 'production_input_read_failed'); }
  });

  router.post('/:id/fulfill', (_req, res) => internalMutationOnly(res, 'production_input_fulfillment_verified_workflow_required'));

  router.post('/:id/waive', (_req, res) => internalMutationOnly(res, 'production_input_waiver_internal_only'));
  return router;
}

export function createProductionCostQuotesRouter(store: DataStore) {
  const router = Router();
  router.get('/', async (req, res) => {
    try {
      const { tenantId } = res.locals as AuthLocals;
      const items = await listProductionCostQuotes({
        store, tenantId, taskId: typeof req.query.taskId === 'string' ? req.query.taskId : undefined,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, items });
    } catch (error) { sendError(res, error, 'production_cost_quote_list_failed'); }
  });
  router.post('/', (_req, res) => internalMutationOnly(res, 'production_cost_quote_internal_only'));
  router.get('/:id', async (req, res) => {
    try {
      const { tenantId } = res.locals as AuthLocals;
      const quote = await getProductionCostQuote({ store, tenantId, quoteId: req.params.id });
      if (!quote) { res.status(404).json({ ok: false, code: 'production_cost_quote_not_found', error: 'production_cost_quote_not_found' }); return; }
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({ ok: true, quote });
    } catch (error) { sendError(res, error, 'production_cost_quote_read_failed'); }
  });
  router.post('/:id/authorize', (_req, res) => internalMutationOnly(res, 'production_cost_authorization_internal_only'));
  router.post('/:id/reserve', (_req, res) => internalMutationOnly(res, 'production_cost_reservation_internal_only'));
  router.post('/:id/settle', (_req, res) => internalMutationOnly(res, 'production_cost_provider_receipt_required'));
  router.post('/:id/fail', (_req, res) => internalMutationOnly(res, 'production_cost_provider_receipt_required'));
  return router;
}
