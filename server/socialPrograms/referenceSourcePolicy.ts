import type { WeeklyReferenceSourcePolicy } from '../../shared/contracts/socialProgram.js';
import { SocialProgramError } from './service.js';

export function referenceSourcePolicy(value: unknown, route: unknown): WeeklyReferenceSourcePolicy | null {
  if (value === undefined || value === null) {
    return route === 'cold_start' ? { profile: 'b2b_cold_start', ownedPercent: 0, externalPercent: 100, allocationUnit: 'mother_content' } : null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new SocialProgramError('reference_source_policy_invalid', 400, '参考来源配置无效。');
  const policy = value as Record<string, unknown>;
  const cold = policy.profile === 'b2b_cold_start';
  if ((!cold && policy.profile !== 'b2b_established') || policy.allocationUnit !== 'mother_content'
    || !Number.isInteger(policy.ownedPercent) || !Number.isInteger(policy.externalPercent)
    || Number(policy.ownedPercent) < 0 || Number(policy.externalPercent) < 0
    || Number(policy.ownedPercent) + Number(policy.externalPercent) !== 100
    || (cold && policy.ownedPercent !== 0)
    || (route === 'cold_start' && !cold) || (route === 'account_repair' && cold)) {
    throw new SocialProgramError('reference_source_policy_invalid', 400, '来源须按独立视频分配且合计 100%；零基础须全部外部，有基础须使用对应画像配置。');
  }
  return { profile: policy.profile as WeeklyReferenceSourcePolicy['profile'], ownedPercent: policy.ownedPercent as number, externalPercent: policy.externalPercent as number, allocationUnit: 'mother_content' };
}
