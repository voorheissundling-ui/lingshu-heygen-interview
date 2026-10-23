import type { SocialProductionAsset } from './socialContentProductionPlan.js';

export type SocialProviderCostSettlementStatus =
  | 'estimated'
  | 'partially_settled'
  | 'settled'
  | 'unknown';

export interface SocialProviderCostSummary {
  actualCostCny: number;
  estimatedUnsettledCostCny: number;
  recordedCostCny: number;
  providerSegmentCount: number;
  settlementStatus: SocialProviderCostSettlementStatus;
}

function cost(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Aggregate only selected provider-backed segments. Actual charges always win;
 * an estimate is retained solely for a provider segment whose bill is not yet
 * known. A missing bill and estimate remains explicitly unknown.
 */
export function summarizeSelectedProviderCosts(input: {
  assets: SocialProductionAsset[];
  selectedAssetIds: ReadonlySet<string>;
}): SocialProviderCostSummary {
  let actualCostCny = 0;
  let estimatedUnsettledCostCny = 0;
  let settledCount = 0;
  let estimatedCount = 0;
  let unknownCount = 0;

  for (const asset of input.assets) {
    if (!input.selectedAssetIds.has(asset.id)) continue;
    let providerSegmentSeen = false;
    for (const segment of asset.segments ?? []) {
      if (!asset.providerId && !String(segment.providerId || '').trim()) continue;
      providerSegmentSeen = true;
      const actual = cost(segment.actualCostCny);
      const estimated = cost(segment.estimatedCostCny);
      if (actual !== null) {
        actualCostCny += actual;
        settledCount += 1;
      } else if (estimated !== null) {
        estimatedUnsettledCostCny += estimated;
        estimatedCount += 1;
      } else {
        unknownCount += 1;
      }
    }
    // A provider-backed asset without a provider cost segment is not free; its
    // bill is unknown until the adapter writes a receipt or settlement record.
    if (asset.providerId && !providerSegmentSeen) unknownCount += 1;
  }

  const providerSegmentCount = settledCount + estimatedCount + unknownCount;
  const settlementStatus: SocialProviderCostSettlementStatus = providerSegmentCount === 0 || settledCount === providerSegmentCount
    ? 'settled'
    : settledCount > 0
      ? 'partially_settled'
      : unknownCount > 0
        ? 'unknown'
        : 'estimated';

  const roundedActual = +actualCostCny.toFixed(4);
  const roundedEstimate = +estimatedUnsettledCostCny.toFixed(4);
  return {
    actualCostCny: roundedActual,
    estimatedUnsettledCostCny: roundedEstimate,
    recordedCostCny: +(roundedActual + roundedEstimate).toFixed(4),
    providerSegmentCount,
    settlementStatus,
  };
}
