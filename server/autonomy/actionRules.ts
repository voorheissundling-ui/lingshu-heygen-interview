export type ActionRisk = 'L1' | 'L2' | 'L3' | 'L4';
export type AutonomyLevel = 'remind' | 'draft' | 'auto';

export interface ActionRule {
  action: string;
  risk: ActionRisk;
  desc: string;
}

const SALES_ACTION_RISK: Record<ActionRisk, string[]> = {
  L1: ['J03'],
  L2: ['A03', 'B02', 'D01', 'D04', 'E03', 'I02', 'I03', 'I04', 'J01', 'J02', 'K01', 'K02', 'L02', 'L05'],
  L3: ['A01', 'A02', 'A04', 'B01', 'B04', 'E01'],
  L4: ['B03', 'C01', 'C02', 'C03', 'C04', 'C05', 'D02', 'D03', 'E02', 'F01', 'F02', 'F03', 'G01', 'G02', 'H01', 'H02', 'I01', 'K03', 'L01', 'L03', 'L04'],
};

export const SALES_ACTION_RULES: ActionRule[] = (Object.entries(SALES_ACTION_RISK) as Array<[ActionRisk, string[]]>)
  .flatMap(([risk, ids]) => ids.map(id => ({ action: `sales:${id}`, risk, desc: `销售动作 ${id}` })));

export const ACTION_RULES: ActionRule[] = [
  { action: 'remind_silent_high_value', risk: 'L1', desc: '高价值客户沉默提醒' },
  { action: 'remind_local_worktime', risk: 'L1', desc: '到达对方工作时间提醒' },
  { action: 'remind_festival', risk: 'L1', desc: '客户节日/生日提醒' },
  { action: 'remind_post_delivery', risk: 'L1', desc: '订单交付后回访提醒' },
  { action: 'remind_new_product_match', risk: 'L1', desc: '新品匹配提醒' },
  { action: 'draft_greeting', risk: 'L2', desc: '日常寒暄回复' },
  { action: 'draft_catalog_recommend', risk: 'L2', desc: '新品/目录推荐' },
  { action: 'draft_order_progress', risk: 'L2', desc: '订单进度同步' },
  { action: 'draft_sample_followup', risk: 'L2', desc: '样品跟进' },
  { action: 'draft_reactivate', risk: 'L2', desc: '沉默客户唤醒' },
  // 没有订单、物流或已审批附件的实时凭证时，这些动作只能生成草稿。
  { action: 'auto_logistics_update', risk: 'L2', desc: '物流状态草稿（需核对真实运单）' },
  { action: 'auto_holiday_greeting', risk: 'L2', desc: '节假日问候草稿' },
  { action: 'auto_send_catalog', risk: 'L2', desc: '目录发送草稿（需核对已审批资料）' },
  { action: 'auto_aftersale_confirm', risk: 'L2', desc: '售后确认草稿（需核对订单）' },
  { action: 'auto_faq_reply', risk: 'L3', desc: '高置信命中的已审批标准问答' },
  { action: 'formal_quote', risk: 'L4', desc: '正式报价' },
  { action: 'discount', risk: 'L4', desc: '折扣/让利' },
  { action: 'payment_terms', risk: 'L4', desc: '付款条款' },
  { action: 'delivery_promise', risk: 'L4', desc: '交期承诺' },
  { action: 'contract_terms', risk: 'L4', desc: '合同条款' },
  { action: 'call_request', risk: 'L4', desc: '客户想通电话' },
  { action: 'proactive_call', risk: 'L4', desc: '主动约电话' },
  { action: 'complaint_compensation', risk: 'L4', desc: '客诉补偿' },
  { action: 'edit_customer_core', risk: 'L4', desc: '修改客户核心资料' },
  ...SALES_ACTION_RULES,
];

export type ActionDecision = 'remind' | 'draft' | 'auto';

export function findActionRule(action: string): ActionRule {
  return ACTION_RULES.find(rule => rule.action === action) ?? ACTION_RULES.find(rule => rule.action === 'draft_greeting')!;
}

export function salesActionRule(id: string): ActionRule {
  return findActionRule(`sales:${String(id || '').trim().toUpperCase()}`);
}

export function decideAction(action: string, autonomy: AutonomyLevel = 'draft'): { decision: ActionDecision; rule: ActionRule } {
  const rule = findActionRule(action);
  if (rule.risk === 'L1') return { decision: 'remind', rule };
  if (rule.risk === 'L4') return { decision: autonomy === 'remind' ? 'remind' : 'draft', rule };
  if (rule.risk === 'L2') {
    const safeConversationAction = action.startsWith('draft_');
    return { decision: autonomy === 'auto' && safeConversationAction ? 'auto' : autonomy === 'remind' ? 'remind' : 'draft', rule };
  }
  if (rule.risk === 'L3') {
    if (autonomy === 'remind') return { decision: 'remind', rule };
    return { decision: autonomy === 'auto' ? 'auto' : 'draft', rule };
  }
  return { decision: 'draft', rule };
}

export function l3ActionRules(): ActionRule[] {
  return ACTION_RULES.filter(rule => rule.risk === 'L3');
}
