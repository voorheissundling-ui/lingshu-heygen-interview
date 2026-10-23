import type { DecisionImpact, EnterpriseOperatingChange } from '../../shared/contracts/socialOperatingDecision.js';
import { deterministicFingerprint } from './businessGoalBuilder.js';

const signature = (value: unknown) => deterministicFingerprint(value);

export function analyzeEnterpriseOperatingChange(change: EnterpriseOperatingChange): DecisionImpact[] {
  if (change.previous.ref.id !== change.next.ref.id) throw new Error('enterprise_profile_identity_mismatch');
  if (change.next.ref.version <= change.previous.ref.version) throw new Error('enterprise_profile_version_must_advance');
  const impacts = new Map<DecisionImpact['area'], DecisionImpact>();
  const add = (area: DecisionImpact['area'], reason: string, handling: DecisionImpact['handling'] = 'new_work_only') => {
    impacts.set(area, { area, reason, handling });
  };
  const changed = (key: keyof EnterpriseOperatingChange['previous']) => signature(change.previous[key]) !== signature(change.next[key]);
  if (changed('products') || changed('markets') || changed('audiences') || changed('languages')) {
    add('business_goal', '产品、市场、受众或语言的企业事实已变更。');
    add('account_strategy', '账号职责需对照新的经营范围复核。');
    add('discovery_scope', '后续发现范围应从新企业版本派生。');
    add('weekly_planning', '新建周任务应引用新经营目标版本。');
  }
  if (changed('publicFacts') || changed('prohibitedClaims')) {
    add('content_facts', '可公开事实或禁止承诺已变更。', 'review_required');
    add('authorization_review', '事实边界变更需要复核尚未执行的授权工作。', 'review_required');
  }
  if (changed('salesOwnerId')) {
    add('conversion_routes', '销售承接负责人已变更。', 'review_required');
    add('authorization_review', '承接责任变更需复核尚未执行的授权工作。', 'review_required');
  }
  if (changed('weeklyBudgetCny')) {
    add('capacity_plan', '周预算已变更。');
    add('authorization_review', '预算边界变更需复核尚未执行的授权工作。', 'review_required');
  }
  return [...impacts.values()].sort((a, b) => a.area.localeCompare(b.area));
}
