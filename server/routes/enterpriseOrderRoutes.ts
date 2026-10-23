import type { Router } from 'express';
import { isBrowserReadToken } from '../digitalEmployees/browserReadSession.js';
import { readAuthorizedWhatsAppCustomers } from '../whatsapp/authorizedCustomerRead.js';
import { transitionOrder, updateAfterSales } from '../../shared/orderLifecycle.js';
import { ORDER_STATUSES, readOrders, upsertOrder, deleteOrder, normalizeOrder, importOrdersFromCsv } from './enterpriseOrders.js';
import { authenticatedTenantId } from './enterpriseTenantAuth.js';
import type { OrderRecord } from './enterpriseProfileContracts.js';

const orderMutations = new Map<string, Promise<void>>();
export function registerEnterpriseOrderRoutes(router: Router): void {
router.use('/orders', async (req, res, next) => {
  if (req.method === 'GET') { next(); return; }
  if (isBrowserReadToken(req.headers.authorization)) { res.status(403).json({ error: 'agent_browser_read_only' }); return; }
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const previous = orderMutations.get(tenantId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  orderMutations.set(tenantId, current);
  await previous;
  const finish = () => { release(); if (orderMutations.get(tenantId) === current) orderMutations.delete(tenantId); };
  res.once('finish', finish); res.once('close', finish);
  next();
});

router.get('/orders', async (req, res) => {
  try {
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  res.json({ items: await readOrders(tenantId) });
  } catch (error) { res.status(503).json({ error: '订单存储暂不可用，请使用相同请求重试' }); }
});

router.post('/orders', async (req, res) => {
  try {
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const order = normalizeOrder({ ...(req.body || {}), id: undefined, audit: [], afterSales: undefined, afterSalesHistory: [], paidAt: undefined, refundedAt: undefined, refundAmount: undefined, source: req.body?.source || '手工录入' });
  if (!order) {
    res.status(400).json({ error: 'invalid order payload' });
    return;
  }
  const existingOrders = await readOrders(tenantId);
  const repeated = order.idempotencyKey && existingOrders.find(item => item.idempotencyKey === order.idempotencyKey);
  if (repeated) {
    if (repeated.buyer !== order.buyer || repeated.product !== order.product || repeated.amount !== order.amount || repeated.customerId !== order.customerId) { res.status(409).json({ error: '相同请求标识对应不同订单内容，请重新发起录入' }); return; }
    if (repeated.customerSyncStatus !== 'done') await upsertOrder(tenantId, repeated);
    res.json(repeated); return;
  }
  if (order.customerId) {
    const customer = (await readAuthorizedWhatsAppCustomers(tenantId)).find(item => item.id === order.customerId);
    if (!customer) { res.status(422).json({ error: '客户不存在或不属于当前租户' }); return; }
    if (!order.sourcePostId) order.sourcePostId = customer.sourcePostId || '';
  }
  if (req.body?.status && !ORDER_STATUSES.includes(req.body.status)) { res.status(422).json({ error: '无效订单状态' }); return; }
  if (!['待付款', '已取消'].includes(order.status)) {
    const evidence = String(req.body?.evidence || order.sourceRef || '').trim();
    if (!evidence) { res.status(422).json({ error: '已付款/退款等历史状态需提供来源凭证' }); return; }
    order.audit = [{ at: order.importedAt, from: '导入', to: order.status, evidence, source: 'manual_record' }];
  }
  if (existingOrders.some(item => item.orderNo === order.orderNo)) { res.status(409).json({ error: '订单号已存在' }); return; }
  if (!await upsertOrder(tenantId, order)) {
    res.status(503).json({ error: 'order storage unavailable' });
    return;
  }
  res.status(201).json(order);
  } catch (error) { res.status(503).json({ error: '订单存储暂不可用，请使用相同请求重试' }); }
});

router.patch('/orders/:id/status', async (req, res) => {
  try {
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const status = req.body?.status;
  const orders = await readOrders(tenantId);
  const index = orders.findIndex(order => order.id === req.params.id);
  if (index < 0) {
    res.status(404).json({ error: 'order not found' });
    return;
  }
  try { orders[index] = transitionOrder(orders[index], status, String(req.body?.evidence || '')); }
  catch (error) { res.status(422).json({ error: (error as Error).message }); return; }
  if (!await upsertOrder(tenantId, orders[index])) {
    res.status(503).json({ error: 'order storage unavailable' });
    return;
  }
  res.json(orders[index]);
  } catch (error) { res.status(503).json({ error: '订单存储暂不可用，请使用相同请求重试' }); }
});

router.post('/orders/:id/sync-customer', async (req, res) => {
  try {
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const order = (await readOrders(tenantId)).find(item => item.id === req.params.id);
  if (!order) { res.status(404).json({ error: 'order not found' }); return; }
  if (!await upsertOrder(tenantId, order)) { res.status(503).json({ error: 'order storage unavailable' }); return; }
  res.json(order);
  } catch (error) { res.status(503).json({ error: '订单存储暂不可用，请使用相同请求重试' }); }
});

router.patch('/orders/:id/aftersales', async (req, res) => {
  try {
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const order = (await readOrders(tenantId)).find(item => item.id === req.params.id);
  if (!order) { res.status(404).json({ error: 'order not found' }); return; }
  try {
    const updated = updateAfterSales(order, req.body?.status, String(req.body?.text || ''));
    if (!await upsertOrder(tenantId, updated)) { res.status(503).json({ error: 'order storage unavailable' }); return; }
    res.json(updated);
  } catch (error) { res.status(422).json({ error: (error as Error).message }); }
  } catch (error) { res.status(503).json({ error: '订单存储暂不可用，请使用相同请求重试' }); }
});

router.delete('/orders/:id', async (req, res) => {
  try {
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const target = (await readOrders(tenantId)).find(item => item.id === req.params.id);
  if (target && (target.status !== '待付款' || target.audit?.length || target.customerId)) {
    res.status(422).json({ error: '已关联客户或已有交易记录的订单请保留审计记录，通过取消/退款维护状态' }); return;
  }
  if (!await deleteOrder(tenantId, req.params.id)) {
    res.status(404).json({ error: 'order not found' });
    return;
  }
  res.status(204).end();
  } catch (error) { res.status(503).json({ error: '订单存储暂不可用，请使用相同请求重试' }); }
});

router.post('/orders/import', async (req, res) => {
  try {
  const tenantId = authenticatedTenantId(res);
  if (!tenantId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const { csv } = req.body as { csv?: string };
  if (!csv?.trim()) {
    res.status(400).json({ error: 'csv is required' });
    return;
  }
  const result = importOrdersFromCsv(csv);
  const existing = await readOrders(tenantId);
  const merged = new Map<string, OrderRecord>();
  existing.forEach(order => merged.set(order.orderNo, order));
  const additions = result.imported.filter(order => !merged.has(order.orderNo) && Boolean(merged.set(order.orderNo, order)));
  const items = [...merged.values()].sort((a, b) => b.orderDate.localeCompare(a.orderDate));
  for (const order of additions) {
    if (!await upsertOrder(tenantId, order)) {
      res.status(503).json({ error: 'order storage unavailable' });
      return;
    }
  }
  res.json({ ok: true, imported: additions.length, skipped: result.skipped + result.imported.length - additions.length, total: items.length });
  } catch (error) { res.status(503).json({ error: '订单存储暂不可用，请使用相同请求重试' }); }
});
}

