import type { ActionRisk } from './actionRules.js';

export type SuggestionType = 'call' | 'handoff' | 'draft_review' | 'touch' | 'blocked_auto' | 'none';

export interface PriorityCustomer {
  id: string;
  name: string;
  estimatedValue?: string;
  intentScore?: number;
  handlingMode?: 'ai_auto' | 'ai_draft' | 'human_needed';
  needCall?: boolean;
  stage?: string;
  localTime?: string;
  lastActive?: string;
  orders?: Array<{ total?: string }>;
  newProductMatch?: boolean;
  blockedAutoReplyReason?: string;
}

export interface PrioritySuggestion {
  customerId: string;
  suggestionType: SuggestionType;
  headline: string;
  reason: string;
  evidence: string[];
  priorityScore: number;
  action?: string;
  risk?: ActionRisk;
}

export const PRIORITY_WEIGHTS = {
  needCallBase: 100,
  humanNeededBase: 80,
  draftBase: 60,
  intentMultiplier: 0.2,
  orderUnder1k: 10,
  order1kTo5k: 20,
  orderOver5k: 30,
  silent30: 10,
  silent60: 20,
  newProductMatch: 10,
  localWorktime: 5,
  recentTouchPenalty: -30,
} as const;

function amount(value?: string): number {
  return Number(String(value || '').replace(/[^\d.]/g, '')) || 0;
}

function orderTotal(customer: PriorityCustomer): number {
  const orders = customer.orders?.length ? customer.orders : [{ total: customer.estimatedValue }];
  return orders.reduce((sum, order) => sum + amount(order.total), 0);
}

function silentDays(customer: PriorityCustomer): number {
  if (customer.stage === 'silent60') return 60;
  if (customer.stage === 'silent30') return 30;
  const match = String(customer.lastActive || '').match(/(\d+)\s*d/i);
  return match ? Number(match[1]) : 0;
}

function localWorktime(customer: PriorityCustomer): boolean {
  const hour = Number(String(customer.localTime || '').match(/(\d{1,2})/)?.[1]);
  return Number.isFinite(hour) && hour >= 9 && hour <= 20;
}

function recentTouch(customer: PriorityCustomer): boolean {
  const active = String(customer.lastActive || '').toLowerCase();
  return active.includes('min') || active.includes('h') || active.includes('刚刚') || active.includes('今天');
}

export function baseTouchScore(customer: PriorityCustomer): { score: number; evidence: string[] } {
  let score = 0;
  const evidence: string[] = [];
  const total = orderTotal(customer);
  if (total > 5000) {
    score += PRIORITY_WEIGHTS.orderOver5k;
    evidence.push(`历史大额采购 $${Math.round(total).toLocaleString('en-US')}`);
  } else if (total >= 1000) {
    score += PRIORITY_WEIGHTS.order1kTo5k;
    evidence.push(`历史订单 $${Math.round(total).toLocaleString('en-US')}`);
  } else if (total > 0) {
    score += PRIORITY_WEIGHTS.orderUnder1k;
    evidence.push(`有历史订单 $${Math.round(total).toLocaleString('en-US')}`);
  }

  const days = silentDays(customer);
  if (days >= 60) {
    score += PRIORITY_WEIGHTS.silent60;
    evidence.push(`沉默 ${days} 天`);
  } else if (days >= 30) {
    score += PRIORITY_WEIGHTS.silent30;
    evidence.push(`沉默 ${days} 天`);
  }

  if (customer.newProductMatch) {
    score += PRIORITY_WEIGHTS.newProductMatch;
    evidence.push('本期新品匹配度高');
  }
  if (localWorktime(customer)) {
    score += PRIORITY_WEIGHTS.localWorktime;
    evidence.push(`当地时间 ${customer.localTime} 适合联系`);
  }
  if (recentTouch(customer) && days === 0) {
    score += PRIORITY_WEIGHTS.recentTouchPenalty;
    evidence.push('近 7 天已触达过');
  }
  return { score, evidence };
}

export function prioritizeCustomer(customer: PriorityCustomer): PrioritySuggestion {
  const intent = Number(customer.intentScore || 0);
  if (customer.blockedAutoReplyReason) {
    return {
      customerId: customer.id,
      suggestionType: 'blocked_auto',
      headline: '需要确认自动回复',
      reason: `AI 想回复但涉及${customer.blockedAutoReplyReason}，需要你确认`,
      evidence: ['出站红线检验已拦截', `命中：${customer.blockedAutoReplyReason}`, 'L4 动作永远由人确认'],
      priorityScore: 95 + intent * PRIORITY_WEIGHTS.intentMultiplier,
      action: 'blocked_auto_reply',
      risk: 'L4',
    };
  }
  if (customer.needCall) {
    return {
      customerId: customer.id,
      suggestionType: 'touch',
      headline: '建议今日主动触达',
      reason: customer.localTime ? `当地 ${customer.localTime}，客户高意向，适合今天触达确认细节` : '客户高意向，适合今天触达确认细节',
      evidence: ['客户表达大单或明确需求', `意向分 ${intent}`, customer.localTime ? `当地时间 ${customer.localTime}` : '当地时间未知'].filter(Boolean),
      priorityScore: PRIORITY_WEIGHTS.needCallBase + intent,
      action: 'draft_reactivate',
      risk: 'L2',
    };
  }
  if (customer.handlingMode === 'human_needed') {
    return {
      customerId: customer.id,
      suggestionType: 'handoff',
      headline: '需要你接手回复',
      reason: '客户问题涉及人工判断，AI 已暂停自动回复',
      evidence: ['当前分工为人工处理', `意向分 ${intent}`, '需避免自动承诺价格/条款'],
      priorityScore: PRIORITY_WEIGHTS.humanNeededBase + intent * PRIORITY_WEIGHTS.intentMultiplier,
      action: 'human_handoff',
      risk: 'L4',
    };
  }
  if (customer.handlingMode === 'ai_draft') {
    return {
      customerId: customer.id,
      suggestionType: 'draft_review',
      headline: '审核 AI 草稿',
      reason: 'AI 已写好草稿，等待你确认后发送',
      evidence: ['当前分工为草稿审核', `意向分 ${intent}`, '人工确认后发送'],
      priorityScore: PRIORITY_WEIGHTS.draftBase + intent * PRIORITY_WEIGHTS.intentMultiplier,
      action: 'draft_review',
      risk: 'L2',
    };
  }

  const touch = baseTouchScore(customer);
  if (touch.score > 0) {
    return {
      customerId: customer.id,
      suggestionType: 'touch',
      headline: '建议主动触达',
      reason: touch.evidence.slice(0, 2).join('，') || '客户适合做一次轻量触达',
      evidence: touch.evidence,
      priorityScore: touch.score,
      action: 'draft_reactivate',
      risk: 'L2',
    };
  }

  return {
    customerId: customer.id,
    suggestionType: 'none',
    headline: '今天没有需要你的事',
    reason: 'AI 可以继续按当前规则接待',
    evidence: ['当前无高优先级信号'],
    priorityScore: 0,
  };
}

export function sortByPriority<T extends PriorityCustomer>(customers: T[]): T[] {
  return [...customers].sort((a, b) => prioritizeCustomer(b).priorityScore - prioritizeCustomer(a).priorityScore);
}
