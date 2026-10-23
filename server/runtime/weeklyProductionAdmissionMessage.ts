import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';

/** Explain an observed admission refusal without changing its code or execution state. */
export function weeklyProductionAdmissionMessage(code: string, detail: SocialContentTaskDetail | null, fallback: string): string {
  if (code === 'reference_person_automatic_analysis_required') {
    const shotId = /^reference_person_automatic_analysis_required:([A-Za-z0-9_-]+)$/.exec(fallback)?.[1];
    return `原参考${shotId ? `镜头 ${shotId}` : ''}尚缺独立人物分析，需完成原片人物与连续性分析并重新确认周排期；当前不能开始生产。`;
  }
  if (code === 'social_content_execution_director_review_required') {
    const review = detail?.agentWorkflow?.executionPlanReview;
    const issues = review?.requiredRevision.length ? review.requiredRevision : review?.failedCriteria ?? [];
    const observed = [...new Set(issues.filter(issue => typeof issue === 'string' && issue.trim()).map(issue => issue.trim()))];
    if (review?.reasonCodes.includes('capability_mismatch')) {
      const missingProductVideoShots = detail?.assetSupplyPlan?.shots.filter(shot =>
        shot.materialRouting?.materialType === 'product'
        && shot.materialRouting.policy === 'local_only'
        && shot.materialRouting.localMatch.state !== 'matched').map(shot => shot.shotId) ?? [];
      const sceneGaps = review.sceneResults.filter(scene => scene.reasonCodes.includes('capability_mismatch'))
        .map(scene => `${scene.sceneId}：${scene.failedCriteria.join('、')}`).filter(Boolean);
      return `机器执行能力不足，未通过执行方案核验${missingProductVideoShots.length
        ? `；产品镜头 ${missingProductVideoShots.join('、')} 缺少已核验的同品本地视频，产品图片不能代替视频`
        : ''}${sceneGaps.length ? `；${sceneGaps.join('；')}` : observed.length ? `；${observed.join('；')}` : ''}。已保留原任务，未启动生成。`;
    }
    return `编导执行方案尚未通过核验，请进入原内容任务处理${observed.length ? `：${observed.join('；')}` : '参考分镜、镜头证据与可执行方案'}。`;
  }
  const messages: Record<string, string> = {
    weekly_replication_authority_unverified: '原运行缺少已核验的复刻来源与账号规则冻结凭据。请核对原参考和规则版本；当前不能新增生产执行。已发出的原请求请只读查询回执，不要重复提交。',
    social_content_execution_rights_required: '参考或素材权利尚未核验，请在原内容任务补齐授权依据。',
    social_content_execution_facts_required: '企业事实依据尚未核验，请在原内容任务补齐对应事实。',
    social_content_execution_budget_required: '执行方案超出预算，请在原内容任务调整方案或确认预算。',
    social_content_execution_goal_degraded: '当前执行方案未达到经营目标，请由编导与经营 Agent 修订方案。',
    weekly_reference_source_missing: '冻结参考来源尚未绑定，请在原内容任务核对参考视频。',
    weekly_reference_version_changed: '参考来源版本发生变化，请核对原冻结参考并明确修订。',
  };
  return messages[code] ?? fallback;
}
