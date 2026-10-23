import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, randomUUID } from 'crypto';
import { orderStatuses, type OrderStatus } from '../../shared/orderLifecycle.js';
import { readAuthorizedWhatsAppCustomers } from '../whatsapp/authorizedCustomerRead.js';
import { store } from '../storage/index.js';
import { localFallbacksEnabled } from '../lib/localFallbackPolicy.js';
import { currentDataAuthority } from '../storage/dataAuthority.js';
import type { OrderRecord } from './enterpriseProfileContracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TENANT_ORDERS_DIR = path.join(__dirname, '../../data/tenant-orders');
export const ORDER_STATUSES: readonly OrderStatus[] = orderStatuses;

function localTenantOrdersFile(tenantId: string): string {
  const key = Buffer.from(tenantId, 'utf8').toString('base64url');
  return path.join(TENANT_ORDERS_DIR, `${key}.json`);
}

function readLocalTenantOrders(tenantId: string): OrderRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(localTenantOrdersFile(tenantId), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('订单台账格式无效');
    return parsed.map(normalizeOrder).filter(Boolean) as OrderRecord[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function writeLocalTenantOrders(tenantId: string, orders: OrderRecord[]): void {
  fs.mkdirSync(TENANT_ORDERS_DIR, { recursive: true });
  const destination = localTenantOrdersFile(tenantId);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(orders, null, 2), 'utf8');
  fs.renameSync(temporary, destination);
}

function storedOrder(value: unknown): OrderRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  let order = raw.order;
  if (typeof order === 'string') {
    try { order = JSON.parse(order); } catch { return null; }
  }
  return order && typeof order === 'object' ? normalizeOrder(order as Partial<OrderRecord>) : null;
}

async function listStoredTenantOrders(tenantId: string): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = await store.list<Record<string, unknown>>('tenant_orders', {
      where: { tenant_id: tenantId },
      page,
      perPage: 200,
    });
    records.push(...result.items);
    totalPages = result.totalPages || 1;
    page += 1;
  } while (page <= totalPages);
  return records;
}

export async function readOrders(tenantId: string): Promise<OrderRecord[]> {
  if (usesLocalOrderAuthority(tenantId)) return readLocalTenantOrders(tenantId);
  const records = await listStoredTenantOrders(tenantId);
  const orders = records.map(storedOrder).filter(Boolean) as OrderRecord[];
  return orders;
}

async function persistOrder(tenantId: string, order: OrderRecord): Promise<boolean> {
  if (usesLocalOrderAuthority(tenantId)) {
    const orders = readLocalTenantOrders(tenantId);
    writeLocalTenantOrders(tenantId, [order, ...orders.filter(item => item.orderNo !== order.orderNo)]);
    return true;
  }
  const result = await store.list<Record<string, unknown>>('tenant_orders', {
    where: { tenant_id: tenantId, order_no: order.orderNo },
    page: 1,
    perPage: 1,
  });
  const existing = result.items[0];
  if (existing?.id) return store.update('tenant_orders', String(existing.id), { order });
  return Boolean(await store.create('tenant_orders', { tenant_id: tenantId, order_no: order.orderNo, order }));
}

export async function upsertOrder(tenantId: string, order: OrderRecord): Promise<boolean> {
  if (order.customerId) { order.customerSyncStatus = 'pending'; order.customerSyncError = ''; }
  const stored = await persistOrder(tenantId, order);
  if (!stored) return false;
  if (!order.customerId) return true;
  try {
    const customer = (await readAuthorizedWhatsAppCustomers(tenantId)).find(item => item.id === order.customerId);
    if (!customer) throw new Error('客户已不存在');
    const canonical = (await readOrders(tenantId)).filter(item => item.customerId === order.customerId);
    const orderNumbers = new Set(canonical.map(item => item.orderNo));
    const { patchWhatsAppCustomer } = await import('../whatsapp/historyImport.js');
    const projected = patchWhatsAppCustomer({ tenantId, customerId: order.customerId, patch: { orders: [
      ...canonical.map(item => ({ id: item.orderNo, status: item.status === '退款' ? 'refunded' : item.status === '已取消' ? 'cancelled' : item.status === '待付款' ? 'pending' : 'paid', total: `$${item.amount}`, createdAt: item.orderDate, items: [{ name: item.product, qty: item.quantity }] })),
      ...(customer.orders || []).filter((item: { id: string }) => !orderNumbers.has(item.id)),
    ] } });
    if (!projected) throw new Error('客户摘要补写失败');
    order.customerSyncStatus = 'done';
  } catch (error) {
    order.customerSyncStatus = 'failed'; order.customerSyncError = (error as Error).message;
  }
  // The canonical order already exists. A failed projection must never make a
  // caller create another order; pending is durable before projection begins.
  try { await persistOrder(tenantId, order); } catch { /* pending record can be retried idempotently */ }
  return true;
}

export async function deleteOrder(tenantId: string, orderId: string): Promise<boolean> {
  if (usesLocalOrderAuthority(tenantId)) {
    const orders = readLocalTenantOrders(tenantId);
    const next = orders.filter(order => order.id !== orderId);
    if (next.length === orders.length) return false;
    writeLocalTenantOrders(tenantId, next);
    return true;
  }
  const records = await listStoredTenantOrders(tenantId);
  const record = records.find(item => storedOrder(item)?.id === orderId);
  return record?.id ? store.delete('tenant_orders', String(record.id)) : false;
}

function usesLocalOrderAuthority(tenantId: string): boolean {
  return localFallbacksEnabled()
    && currentDataAuthority() !== 'pocketbase'
    && tenantId.startsWith('local_tenant_');
}

function parseNumber(value: unknown): number {
  const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizeStatus(value: unknown): OrderStatus {
  const raw = String(value || '').trim();
  if (ORDER_STATUSES.includes(raw as OrderStatus)) return raw as OrderStatus;
  const lower = raw.toLowerCase();
  if (/^(paid|已付款|付款)$/.test(lower)) return '已付款';
  if (/ship|fulfilled|已发|发货/.test(lower)) return '已发货';
  if (/complete|done|完成/.test(lower)) return '已完成';
  if (/cancel|取消/.test(lower)) return '已取消';
  if (/refund|退款/.test(lower)) return '退款';
  if (/production|生产/.test(lower)) return '生产中';
  return '待付款';
}

function normalizeDate(value: unknown): string {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(raw)) {
    const [y, m, d] = raw.split('/');
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

export function normalizeOrder(input: Partial<OrderRecord>): OrderRecord | null {
  const buyer = String(input.buyer || '').trim();
  const product = String(input.product || '').trim();
  const amount = parseNumber(input.amount);
  if (!buyer || !product || amount <= 0) return null;
  const now = new Date().toISOString();
  const orderDate = normalizeDate(input.orderDate);
  return {
    id: String(input.id || randomUUID()),
    orderNo: String(input.orderNo || `LS-${orderDate.replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`),
    buyer,
    market: String(input.market || '未标注').trim(),
    channel: String(input.channel || '手工录入').trim(),
    product,
    quantity: Math.max(1, parseNumber(input.quantity) || 1),
    amount,
    cost: Math.max(0, parseNumber(input.cost)),
    status: normalizeStatus(input.status),
    orderDate,
    owner: String(input.owner || '').trim() || '未分配',
    source: String(input.source || '手工录入').trim(),
    idempotencyKey: String(input.idempotencyKey || '').trim().slice(0, 120), customerSyncStatus: input.customerSyncStatus, customerSyncError: input.customerSyncError,
    sourcePostId: String(input.sourcePostId || '').trim(),
    customerId: String(input.customerId || '').trim(),
    paidAt: input.paidAt, refundedAt: input.refundedAt, refundAmount: input.refundAmount,
    audit: input.audit, afterSales: input.afterSales, afterSalesHistory: input.afterSalesHistory,
    sourceRef: String(input.sourceRef || '').trim(),
    importedAt: input.importedAt || now,
    updatedAt: input.updatedAt || now,
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell.trim());
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

const ORDER_HEADER_MAP: Record<string, keyof OrderRecord> = {
  订单号: 'orderNo',
  orderno: 'orderNo',
  order_no: 'orderNo',
  orderid: 'orderNo',
  order_id: 'orderNo',
  客户: 'buyer',
  客户名称: 'buyer',
  buyer: 'buyer',
  customer: 'buyer',
  market: 'market',
  市场: 'market',
  国家: 'market',
  country: 'market',
  渠道: 'channel',
  channel: 'channel',
  商品: 'product',
  '商品/sku': 'product',
  '商品 / sku': 'product',
  产品: 'product',
  sku: 'product',
  product: 'product',
  数量: 'quantity',
  quantity: 'quantity',
  qty: 'quantity',
  gmv: 'amount',
  金额: 'amount',
  订单金额: 'amount',
  amount: 'amount',
  成本: 'cost',
  cost: 'cost',
  状态: 'status',
  status: 'status',
  日期: 'orderDate',
  订单日期: 'orderDate',
  date: 'orderDate',
  orderdate: 'orderDate',
  负责人: 'owner',
  owner: 'owner',
  销售: 'owner',
  来源: 'source',
  source: 'source',
  来源凭证: 'sourceRef',
  凭证: 'sourceRef',
  sourceref: 'sourceRef',
  platform_order_id: 'sourceRef',
  平台订单号: 'sourceRef',
};

export function importOrdersFromCsv(text: string): { imported: OrderRecord[]; skipped: number } {
  const rows = parseCsv(text);
  const [headers = [], ...body] = rows;
  const keys = headers.map(header => ORDER_HEADER_MAP[String(header).trim().toLowerCase()] || ORDER_HEADER_MAP[String(header).trim()]);
  const imported: OrderRecord[] = [];
  let skipped = 0;
  for (const row of body) {
    const raw: Partial<OrderRecord> = {};
    row.forEach((value, index) => {
      const key = keys[index];
      if (key) (raw as Record<string, unknown>)[key] = value;
    });
    const order = normalizeOrder({ ...raw, source: raw.source || 'CSV导入' });
    if (order) imported.push(order);
    else skipped += 1;
  }
  return { imported, skipped };
}
