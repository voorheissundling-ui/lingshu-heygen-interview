export type Maturity = 'starting' | 'growing' | 'established';
export const maturityLabels: Record<Maturity, string> = { starting: '起步验证', growing: '体系运营', established: '协同优化' };
export const maturityProfiles: Record<Maturity, { features: string; strategy: string; criteria: string }> = {
  starting: { features: '尚未跑通或执行零散；目标客户、制作发布流程仍不明确。', strategy: '聚焦核心产品和主要平台，完成少量内容实验，建立询盘入口与反馈记录。', criteria: '核验实际交付与客户承接入口，记录阻塞和初步反馈；发布成功不等于市场验证成功。' },
  growing: { features: '受众明确、流程可重复，连续按计划交付；效果与客户后续结果尚未充分关联。', strategy: '建立固定栏目、排期、客户跟进和周期复盘，复用有效方法。', criteria: '对照计划检查交付和跟进记录，比较内容反馈，形成下期调整安排。' },
  established: { features: '稳定运营，能关联内容与客户反馈，并有根据数据调整策略的具体实例。', strategy: '连接内容、客户与销售反馈，设置可验证的实验，根据线索质量和商机进展调整投入。', criteria: '提供来源与跟进证据、实验结果和调整依据；缺少数据时列出待补记录，不推断成交贡献。' },
};
export const assessmentQuestions = [
  { id: 'cadence', title: '过去四周是否按计划持续发布？', evidence: '填写计划与实际发布情况；低频但按计划执行也算稳定。', gap: 'unstable_publishing' },
  { id: 'audience', title: '是否明确目标客户，并能解释内容为什么适合他们？', evidence: '举例说明目标客户、产品及内容选择依据。', gap: 'unclear_audience' },
  { id: 'process', title: '从素材到发布是否有可重复的步骤和负责人？', evidence: '说明素材、制作、审核与发布步骤；负责人可以是人或 Agent。', gap: 'unclear_process' },
  { id: 'handoff', title: '收到评论、私信或询盘后，是否有记录和跟进安排？', evidence: '说明记录位置、负责人和下一步；没有询盘时说明承接机制。', gap: 'missing_handoff' },
  { id: 'review', title: '最近一次复盘是否带来了具体调整？', evidence: '说明发现了什么、改了什么及验证结果。', gap: 'missing_review' },
  { id: 'attribution', title: '能否关联某条内容、客户反应与后续跟进？', evidence: '提供一个来源与后续处理的实例；只有播放量或 CRM 不算。', gap: 'unclear_source' },
] as const;
export const gapLabels = { missing_assets: '素材不足', unstable_publishing: '发布不稳定', unclear_audience: '受众不明确', unclear_process: '流程不清晰', missing_handoff: '询盘承接缺失', unclear_source: '来源不清', missing_review: '缺少复盘' } as const;
export type Gap = keyof typeof gapLabels;
export type AssessmentId = typeof assessmentQuestions[number]['id'];
export interface OperatingAssessment { answers: Partial<Record<AssessmentId, { value: 'yes' | 'no' | 'unknown'; evidence: string }>>; gaps: Gap[] }
export function normalizeAssessment(raw: unknown): OperatingAssessment {
  const input = raw && typeof raw === 'object' ? raw as Partial<OperatingAssessment> : {};
  const answers: OperatingAssessment['answers'] = {};
  for (const q of assessmentQuestions) {
    const answer = input.answers?.[q.id];
    if (answer) answers[q.id] = { value: ['yes', 'no', 'unknown'].includes(answer.value) ? answer.value : 'unknown', evidence: String(answer.evidence || '').trim().slice(0, 500) };
  }
  return { answers, gaps: Array.isArray(input.gaps) ? [...new Set(input.gaps.filter(g => Object.hasOwn(gapLabels, g)))] : [] };
}
export function assessMaturity(raw: unknown): { maturity: Maturity | null; gaps: Gap[]; reason: string } {
  const assessment = normalizeAssessment(raw);
  const gaps = [...new Set<Gap>([...assessment.gaps, ...assessmentQuestions.filter(q => assessment.answers[q.id]?.value === 'no').map(q => q.gap)])];
  const known = (id: AssessmentId) => assessment.answers[id]?.value !== 'unknown' && Boolean(assessment.answers[id]?.value);
  const yes = (id: AssessmentId) => assessment.answers[id]?.value === 'yes';
  const foundation = ['cadence', 'audience', 'process'] as const;
  if (foundation.some(id => assessment.answers[id]?.value === 'no') || gaps.some(g => ['unstable_publishing', 'unclear_audience', 'unclear_process'].includes(g))) return { maturity: 'starting', gaps, reason: '稳定发布、明确受众或可重复流程仍有缺口，优先跑通并验证。' };
  if (!foundation.every(known)) return { maturity: null, gaps, reason: '请先补充发布、受众和流程情况，信息不足时不自动判定阶段。' };
  if (!gaps.some(g => ['missing_handoff', 'unclear_source', 'missing_review'].includes(g)) && assessmentQuestions.every(q => yes(q.id) && Boolean(assessment.answers[q.id]?.evidence))) return { maturity: 'established', gaps, reason: '稳定运营、客户承接、来源关联与复盘调整均有自述实例支持；建议核对记录后采用。' };
  return { maturity: 'growing', gaps, reason: '已有稳定运营基础；进入协同优化还需补齐客户承接、来源关联与复盘实例。' };
}
export function taskGuidance(maturity: Maturity, template: string, raw?: unknown): string {
  const stage: Record<Maturity, Record<string, string>> = {
    starting: { readiness: '确认核心产品、目标客户和询盘入口，补齐本次制作所需素材。', inspiration: '只筛选少量适合目标客户的参考，记录选择理由。', production: '围绕一个明确客户问题制作小规模验证内容，保留询盘引导。', publishing: '核验真实发布回执与询盘入口，记录首轮反馈。', customers: '记录已有客户的来源与需求；没有客户时列明待补信息。', followup: '承接已有询盘，确认需求并记录下一步。', review: '复盘流程阻塞与初步反馈，明确下一次验证方向。' },
    growing: { collection: '按固定栏目补充行业参考，避免重复采集。', inspiration: '结合上期反馈筛选固定栏目和待测试选题。', production: '按栏目与排期组织制作，复用已验证的素材与模板。', publishing: '按计划发布，核对实际交付与排期差异。', customers: '持续维护客户来源、需求和阶段记录。', followup: '按客户阶段安排跟进，记录响应与下一步。', review: '比较栏目表现、交付完成情况与客户反馈，形成下期安排。' },
    established: { collection: '围绕客户问题和待验证假设补充行业证据。', inspiration: '结合客户质量和销售反馈选择选题，说明实验假设。', production: '围绕同一目标客户设置内容对照，明确本次改变的变量。', publishing: '保留作品与渠道标识，便于关联反馈与客户来源。', customers: '核对内容来源、客户需求与商机阶段，标记未知来源。', followup: '依据互动历史与商机阶段跟进，将客户反馈回传内容复盘。', review: '比较实验结果、线索质量和商机进展，提出继续、调整或停止的依据；数据不足时先补记录。' },
  };
  const gaps = assessMaturity(raw).gaps;
  const applicable: Record<Gap, string[]> = { missing_assets: ['readiness', 'production'], unstable_publishing: ['publishing'], unclear_audience: ['readiness', 'inspiration'], unclear_process: ['readiness'], missing_handoff: ['readiness', 'customers', 'followup'], unclear_source: ['customers', 'publishing'], missing_review: ['review'] };
  const priorities = gaps.filter(g => applicable[g].includes(template));
  return [stage[maturity][template] || maturityProfiles[maturity].strategy, priorities.length ? `本周优先补齐：${priorities.map(g => gapLabels[g]).join('、')}。` : ''].filter(Boolean).join('\n');
}
