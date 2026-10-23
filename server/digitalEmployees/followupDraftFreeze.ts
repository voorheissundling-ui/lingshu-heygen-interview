/** Persisted in the existing delivery_policy JSON; no ordering is inferred from random record IDs. */
export function orderedFollowupItems<T extends Record<string, unknown>>(items: T[], policy: unknown): T[] {
  const object = typeof policy === 'string' ? JSON.parse(policy) : policy;
  const order = object && typeof object === 'object' ? (object as Record<string,unknown>).frozenMemberOrder : null;
  if (!Array.isArray(order)) return items;
  if (!order.every(value => typeof value === 'string' && value) || new Set(order).size !== order.length || items.length !== order.length || new Set(items.map(item => item.segment_member_id)).size !== items.length || items.some(item => !order.includes(item.segment_member_id))) throw new Error('followup_frozen_item_order_invalid');
  return [...items].sort((left,right) => order.indexOf(left.segment_member_id) - order.indexOf(right.segment_member_id));
}
export function freezeFollowupSchedules<T extends { customer: Record<string, unknown>; member: { id: string } }>(drafts: T[], schedule: (timeZone: string, capturedAt: Date) => string, capturedAt: Date) {
  if (!Number.isFinite(capturedAt.getTime()) || new Set(drafts.map(item => item.member.id)).size !== drafts.length) throw new Error('followup_freeze_input_invalid');
  return drafts.map(item => ({ ...item, scheduledAt: schedule(String(item.customer.timeZone || '').slice(0,100), new Date(capturedAt)) }));
}
