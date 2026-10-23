/** The generic legacy editor cannot execute reference shots or generate their replacements. */
export const LEGACY_REPLICATION_BRIDGE_BLOCKER = 'needs_per_shot_replication_bridge：旧通用剪辑执行器不支持逐镜复刻，请使用经营逐镜工作台执行器；必须逐镜匹配或生成数字人与非数字人素材，不能以普通素材拼接替代爆款复刻';

export function legacyReplicationBlocker(input: {
  route: string;
  creationPath?: unknown;
  stage: string;
  heygenJobId?: unknown;
}): string {
  if (input.route !== 'clone') return '';
  // This guard is called only by the legacy executor. A workbench label or
  // an old talking-head job cannot attest to per-shot replication. Existing
  // supplier polling remains available in the separate heygen stage.
  if (input.stage === 'heygen' && !(typeof input.heygenJobId === 'string' && input.heygenJobId.trim())) {
    return LEGACY_REPLICATION_BRIDGE_BLOCKER;
  }
  return ['script', 'material_match', 'voice_subtitles', 'render'].includes(input.stage)
    ? LEGACY_REPLICATION_BRIDGE_BLOCKER : '';
}
