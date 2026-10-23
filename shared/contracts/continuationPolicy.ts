export interface ContinuationPolicy {
  newCustomers: 'next_cycle' | 'reopen';
  missedFollowup: 'next_slot' | 'catch_up';
  overlappingCycles: 'block' | 'allow_disjoint';
  publishingTimezone: 'legacy' | 'Asia/Shanghai' | 'account';
}
export const defaultContinuationPolicy: ContinuationPolicy = {
  newCustomers: 'next_cycle', missedFollowup: 'next_slot', overlappingCycles: 'block', publishingTimezone: 'legacy',
};
export const recommendedContinuationPolicy: ContinuationPolicy = { newCustomers: 'reopen', missedFollowup: 'catch_up', overlappingCycles: 'allow_disjoint', publishingTimezone: 'account' };
export function normalizeContinuationPolicy(value?: Partial<ContinuationPolicy>): ContinuationPolicy {
  return {
    newCustomers: value?.newCustomers === 'reopen' ? 'reopen' : 'next_cycle',
    missedFollowup: value?.missedFollowup === 'catch_up' ? 'catch_up' : 'next_slot',
    overlappingCycles: value?.overlappingCycles === 'allow_disjoint' ? 'allow_disjoint' : 'block',
    publishingTimezone: ['account', 'Asia/Shanghai'].includes(String(value?.publishingTimezone)) ? value!.publishingTimezone! : 'legacy',
  };
}
