export const orderStatuses = ['待付款', '已付款', '生产中', '已发货', '已完成', '退款', '已取消'] as const;
export type OrderStatus = typeof orderStatuses[number];
export const orderTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  待付款: ['已付款', '已取消'], 已付款: ['生产中', '已发货', '退款'],
  生产中: ['已发货', '退款'], 已发货: ['已完成', '退款'], 已完成: ['退款'], 退款: [], 已取消: [],
};
export type OrderAudit = { at: string; from: string; to: string; evidence: string; source: 'manual_record' };
export type AfterSales = { status: 'open' | 'resolved'; reason: string; resolution?: string; openedAt: string; resolvedAt?: string };
export function transitionOrder<T extends { status: OrderStatus; amount: number; audit?: OrderAudit[]; afterSales?: AfterSales }>(order: T, status: unknown, evidence = '', now = new Date().toISOString()): Omit<T, 'status'> & { status: OrderStatus; audit?: OrderAudit[]; paidAt?: string; refundedAt?: string; refundAmount?: number; updatedAt?: string } {
  if (!orderStatuses.includes(status as OrderStatus)) throw new Error('无效订单状态');
  const next = status as OrderStatus;
  if (next === order.status) return order;
  if (!orderTransitions[order.status].includes(next)) throw new Error(`不允许从${order.status}变更为${next}`);
  if (['已付款', '退款'].includes(next) && !evidence.trim()) throw new Error('请填写付款或退款凭证；此操作仅登记线下结果，不执行资金交易');
  return { ...order, status: next, updatedAt: now,
    ...(next === '已付款' ? { paidAt: now } : {}),
    ...(next === '退款' ? { refundedAt: now, refundAmount: order.amount } : {}),
    audit: [...(order.audit || []), { at: now, from: order.status, to: next, evidence: evidence.trim(), source: 'manual_record' as const }],
  };
}
export function updateAfterSales<T extends { afterSales?: AfterSales; afterSalesHistory?: AfterSales[] }>(order: T, status: unknown, text: string, now = new Date().toISOString()): Omit<T, 'afterSales'> & { afterSales: AfterSales; afterSalesHistory?: AfterSales[]; updatedAt: string } {
  if (!text.trim()) throw new Error('请填写售后原因或处理结果');
  if (status === 'open') {
    if (order.afterSales?.status === 'open') throw new Error('已有未处理售后');
    return { ...order, afterSalesHistory: [...(order.afterSalesHistory || []), ...(order.afterSales ? [order.afterSales] : [])], afterSales: { status: 'open' as const, reason: text.trim(), openedAt: now }, updatedAt: now };
  }
  if (status !== 'resolved' || order.afterSales?.status !== 'open') throw new Error('没有可关闭的售后');
  return { ...order, afterSales: { ...order.afterSales, status: 'resolved' as const, resolution: text.trim(), resolvedAt: now }, updatedAt: now };
}
export function paidOrder(order: { status: string }) { return ['已付款', '生产中', '已发货', '已完成'].includes(order.status); }
