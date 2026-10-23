import type { StoryboardAigcSpendEntry, StoryboardAigcStage } from './storyboardAigcProjectBudget.js';

export type StoryboardExistingOperationResult =
  | { kind: 'none' }
  | { kind: 'existing'; entry: StoryboardAigcSpendEntry }
  | { kind: 'conflict'; code: 'STORYBOARD_OPERATION_INPUT_CONFLICT'; message: string };

/** Inspect only the original operation in an authenticated tenant/project ledger.
 * An already accepted call is a receipt lookup, not a new budget admission.
 * The caller must still validate any output material against current tenant,
 * project, shot, reference assets and QA before treating it as reusable.
 * This helper neither releases spend nor permits another provider submission. */
export function inspectStoryboardExistingOperation(input: {
  entry: StoryboardAigcSpendEntry | undefined;
  operationId: string;
  shotId: string;
  stage: StoryboardAigcStage;
  /** Expected original reservation, not remaining budget or partial occupancy. */
  estimatedCostCny: number;
  /** Both sides may omit this only for legacy operations without fingerprints. */
  inputFingerprint?: string;
}): StoryboardExistingOperationResult {
  if (!input.entry) return { kind: 'none' };
  const conflict = (message: string): StoryboardExistingOperationResult => ({
    kind: 'conflict', code: 'STORYBOARD_OPERATION_INPUT_CONFLICT', message,
  });
  const entry = input.entry;
  const expectedMicros = Math.round(input.estimatedCostCny * 1e6);
  const originalMicros = entry.originalAmountMicros ?? entry.amountMicros;
  if (!input.operationId || !input.shotId || !['first_frame', 'video'].includes(input.stage)
    || !Number.isSafeInteger(expectedMicros) || expectedMicros <= 0
    || !Number.isSafeInteger(originalMicros) || originalMicros <= 0
    || !Number.isSafeInteger(entry.amountMicros) || entry.amountMicros <= 0
    || entry.amountMicros > originalMicros
    || !['reserved', 'uncertain', 'completed'].includes(entry.status)) {
    return conflict('原制作请求的预算凭据无效，请先核账；未新增供应商调用');
  }
  if (entry.operationId !== input.operationId || entry.shotId !== input.shotId
    || entry.stage !== input.stage || originalMicros !== expectedMicros) {
    return conflict('原制作请求标识已用于不同镜头或费用输入，已保留原作业；未新增供应商调用');
  }
  if (entry.inputFingerprint !== input.inputFingerprint) {
    return conflict('原制作请求对应的参考资产或镜头输入已变化，已保留原作业；未新增供应商调用');
  }
  return { kind: 'existing', entry };
}
