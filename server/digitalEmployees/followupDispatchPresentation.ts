import type { CustomerMessagingAuthorization } from './customerMessagingPolicy.js';

export interface FollowupDispatchPreflight {
  batchId: string;
  mode: 'scheduled' | 'manual';
  ready: boolean;
  batchApproved: boolean;
  authorized: boolean;
  eligible: number;
  blocked: number;
  future: number;
  skipped: number;
  blockers: Record<string, number>;
  authorization: CustomerMessagingAuthorization;
}

const PREFLIGHT_BLOCKER_LABELS: Record<string, string> = {
  workflow_run_unavailable: '关联运行不存在或不属于当前租户',
  workflow_run_paused: '经营任务已暂停，恢复前不会发送',
  workflow_run_cancelled: '经营任务已取消，不再发送',
  workflow_run_waiting_human: '经营任务已由人工接管，不再自动发送',
  workflow_run_failed: '经营任务已失败，处理后才能发送',
  workflow_run_succeeded: '经营任务已结束，不再发送',
  followup_batch_not_approved_for_current_version: '跟进批次尚未审批，或审批版本已过期',
  digital_employee_configuration_inactive: '数字员工配置未激活',
  customer_agent_not_enabled: '客服 Agent 未启用',
  tenant_real_customer_messages_not_authorized: '租户未授权真实发送',
  whatsapp_provider_not_ready: 'WhatsApp 渠道未连接或凭证未就绪',
  followup_background_worker_disabled: '自动发送 Worker 未启用（仍可在授权后人工触发）',
  no_dispatchable_items: '当前批次没有可发送的逐客草稿',
  draft_content_hash_changed: '草稿内容已变化，需要重新审批',
  invalid_whatsapp_number: '客户 WhatsApp 号码无效',
  high_risk_requires_individual_review: '高风险客户需要逐客人工复核',
  customer_no_longer_available: '客户资料已不存在',
  customer_whatsapp_number_changed: '客户 WhatsApp 号码已变化',
  customer_opted_out_or_blacklisted: '客户已退订或进入黑名单',
  contact_frequency_limit: '客户触达频率已达上限',
  whatsapp_template_required: '已超出 24 小时会话窗口，需要获批模板',
  approved_whatsapp_template_required: 'WhatsApp 模板尚未获批',
  unsupported_send_mode: '发送模式不受支持',
  send_outcome_unknown: '发送结果不明，需要核对平台回执，禁止自动重发',
  whatsapp_template_content_changed: '平台模板正文已变化，需要重新选择并审批',
  starter_198_orchestrator_only: '198 标准版仅允许灵小枢编排，不执行旧版真实发送',
  starter_198_access_unavailable: '产品能力边界暂时无法确认，已停止真实发送',
};

export function followupDispatchPreflightFacts(preflight: FollowupDispatchPreflight): string[] {
  const facts = Object.entries(preflight.blockers)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => {
      const label = PREFLIGHT_BLOCKER_LABELS[reason]
        || (reason.startsWith('outbound_guard:') ? '草稿命中对外发送红线' : reason);
      return count > 1 ? `${label}（${count} 条）` : label;
    });
  if (preflight.future > 0) facts.push(`未来发送时段：${preflight.future} 条尚未到逐客发送时间`);
  if (preflight.blocked > 0 && !Object.keys(preflight.blockers).length) facts.push(`发送前安全复核阻断 ${preflight.blocked} 条`);
  if (preflight.ready) facts.push(`发送预检通过：${preflight.eligible} 条已到期且具备真实发送条件`);
  return [...new Set(facts)];
}

export function followupDispatchPreflightBlockedReason(preflight: FollowupDispatchPreflight): string {
  const facts = followupDispatchPreflightFacts(preflight);
  return facts.length ? `真实发送预检：${facts.join('；')}` : '真实发送预检：尚无可发送项目';
}
