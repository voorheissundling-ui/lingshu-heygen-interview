import type { BusinessDestination, DigitalEmployeeOverview } from './digitalEmployees';
import { taskNeedsAttention } from './taskExecutionState';

export const reviewCategories = [
  { id: 'channel', label: '渠道表现', short: '渠道', missing: '需要至少两个平台在同一周期内的表现数据。平台询盘效率还需要可关联的询盘来源。' },
  { id: 'content', label: '内容复用', short: '内容', missing: '尚未接入逐条视频的表现、前三秒片段与结构分析，暂不能推荐可复用的钩子。' },
  { id: 'knowledge', label: '客户关注与知识补充', short: '客户知识', missing: '尚无可审核的知识候选。客户共性话题还需要会话原文与去重后的客户数量。' },
  { id: 'blocker', label: '主要卡点', short: '卡点', missing: '当前没有需要人工处理的执行卡点。客户流失原因需要进一步结合会话证据。' },
  { id: 'opportunity', label: '高意向客户跟进', short: '商机', missing: '现有客户汇总不能判断谁漏跟进了；需要逐客意向信号、最近沟通时间和跟进记录。' },
  { id: 'product', label: '产品与卖点机会', short: '产品卖点', missing: '需要把内容与询盘关联到具体产品、卖点和使用场景后再判断机会。' },
  { id: 'strategy', label: '上期策略验证', short: '策略验证', missing: '尚无关联验证结果的上期策略。需要记录采纳动作、观察周期与前后指标。' },
] as const;
export type ReviewCategory = typeof reviewCategories[number]['id'];
export interface ReviewInsight {
  id: string;
  category: ReviewCategory;
  title: string;
  summary: string;
  confidence: 'observed' | 'candidate';
  evidence: Array<{ label: string; value: string; note?: string; amount?: number }>;
  caveat: string;
  suggestion: string;
  action: { label: string; page?: BusinessDestination; taskId?: string };
  priority: number;
}
const platforms: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

// Only turn observable receipts into findings. Aggregate counts cannot establish
// customer-level opportunities, video hooks, attribution, or causal bottlenecks.
export function buildReviewInsights(data: DigitalEmployeeOverview): ReviewInsight[] {
  const snapshot = data.businessSnapshot || data.liveReview?.businessSnapshot;
  const insights: ReviewInsight[] = [];
  const measured = (snapshot?.social.platformBreakdown || [])
    .filter(p => p.status === 'available' && typeof p.views === 'number' && Number.isFinite(p.views) && p.views >= 0)
    .slice().sort((a, b) => b.views! - a.views!);
  if (measured.length >= 2 && measured[0].views! > 0) {
    const first = measured[0];
    const tied = measured.filter(p => p.views === first.views).length > 1;
    insights.push({
      id: 'channel-views', category: 'channel', priority: 50, confidence: 'observed',
      title: tied ? '多个平台曝光并列领先，投入效率仍待核对' : `${platforms[first.platform] || first.platform} 曝光最多，询盘效率仍待核对`,
      summary: `本期有 ${measured.length} 个平台取得曝光数据。先对照平台表现，再结合发布量与有效询盘决定下期投入。`,
      evidence: measured.map(p => ({ label: platforms[p.platform] || p.platform, value: `${p.views!.toLocaleString('zh-CN')} 次曝光`, amount: p.views!, note: `${p.accounts} 个账号 · 本期已回收数据` })),
      caveat: '曝光总量不代表单条内容效率或询盘质量；当前未提供平台级有效询盘与投入数据。',
      suggestion: '核对各平台发布量与询盘来源，再决定是否增加投入；暂不据此复制选题或认定视频结构有效。',
      action: { label: '查看发布记录', page: 'smartAssets' },
    });
  }
  const blocked = data.tasks.filter(taskNeedsAttention);
  // The task objects carry richer wait-state semantics than the legacy live-review list.
  blocked.forEach(task => insights.push({
    id: `blocker-${task.id}`, category: 'blocker', confidence: 'observed', priority: task.status === 'failed' ? 100 : 85,
    title: `${task.title}需要处理`,
    summary: task.blocked_reason || '任务需要人工处理，查看执行详情以确认恢复方式。',
    evidence: [{ label: '受影响任务', value: task.title }, { label: '当前状态', value: task.status === 'failed' ? '执行失败' : '需要人工处理', note: task.updated_at ? `更新于 ${new Date(task.updated_at).toLocaleString('zh-CN')}` : undefined }],
    caveat: '这是已确认的执行卡点，尚不能据此估算经营损失或判断客户流失原因。',
    suggestion: '查看任务的具体阻塞原因与所需资料，处理后在任务执行页继续推进。',
    action: { label: '处理这个卡点', taskId: task.id },
  }));
  if (data.review?.status === 'generated') {
    [...new Set(data.review.summary.knowledgeCandidates.filter(x => x.trim()))].forEach((candidate, i) => insights.push({
      id: `knowledge-${data.review!.id}-${i}`, category: 'knowledge', confidence: 'candidate', priority: 40,
      title: '有一条经营经验待核实', summary: candidate,
      evidence: [{ label: '本轮复盘提出的候选', value: candidate }],
      caveat: '该候选来自本轮工作流复盘，未附客户会话频次与事实来源，不能当作客户普遍关注的话题或直接写入知识库。',
      suggestion: '先核对事实来源与适用条件。产品事实补充到企业资料；执行经验经确认后再调整 Agent 规则。',
      action: { label: '查看企业资料', page: 'enterprise' },
    }));
  }
  return insights.sort((a, b) => b.priority - a.priority);
}
