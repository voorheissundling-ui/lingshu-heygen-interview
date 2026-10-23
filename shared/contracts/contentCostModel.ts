/**
 * Weekly planning uses a blended production estimate: owned/cloud assets,
 * editing and paid generation are combined. It is not the provider's
 * full-duration 1080p list price. Actual settlement is reconciled separately.
 */
export const MASTER_VIDEO_COST_MIN_CNY = 10;
export const MASTER_VIDEO_COST_MAX_CNY = 15;
export const MASTER_VIDEO_COST_POINT_CNY = 12.5;

export const masterVideoCostRange = () => ({
  minCny: MASTER_VIDEO_COST_MIN_CNY,
  maxCny: MASTER_VIDEO_COST_MAX_CNY,
  basis: 'blended_master' as const,
});

export const includedAdaptationCostRange = () => ({
  minCny: 0,
  maxCny: 0,
  basis: 'included_platform_adaptation' as const,
});
