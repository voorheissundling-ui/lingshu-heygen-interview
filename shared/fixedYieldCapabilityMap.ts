import type { BenchmarkMaterialType } from './benchmarkAnalysis.js';
import { FIXED_YIELD_ARCHETYPE_IDS, type FixedYieldArchetypeId } from './fixedYieldMaterialRegistry.js';

export const FIXED_YIELD_PATH_IDS = [
  'P1_PRESENTER',
  'P2_PRODUCT_REAL',
  'P3_FACTORY_REAL',
  'P4_CONSUMER_REAL',
  'P5_GENERAL_EVIDENCE',
] as const;

export type FixedYieldPathId = typeof FIXED_YIELD_PATH_IDS[number];
export type FixedYieldProductionMode = 'pipeline_1' | 'pipeline_2' | 'pipeline_3' | 'local_video_match';

export interface FixedYieldCapabilityPath {
  pathId: FixedYieldPathId;
  pathVersion: 'fixed-yield-capability.v2';
  materialType: Exclude<BenchmarkMaterialType, 'unknown'>;
  archetypeIds: FixedYieldArchetypeId[];
  productionModes: FixedYieldProductionMode[];
  durationPolicy: 'exact_reference_shot_duration';
  currentSourcePolicy: 'authorized_digital_presenter' | 'tenant_authorized_local_video';
  /** Static declaration only. Availability is always supplied by a frozen,
   * server-owned runtime snapshot and is never inferred by the browser. */
  runtimeReadiness: 'requires_runtime_snapshot';
  maximumTimelineShots: number;
  maximumOperationsPerShot: number;
}

const archetypes = (prefix: string) => FIXED_YIELD_ARCHETYPE_IDS.filter(id => id.startsWith(prefix));

/** The only current production capability truth. Future I2V, generated factory,
 * generated consumer and motion-graphics routes deliberately do not appear. */
export const FIXED_YIELD_CAPABILITY_MAP: Record<FixedYieldPathId, FixedYieldCapabilityPath> = {
  P1_PRESENTER: {
    pathId: 'P1_PRESENTER', pathVersion: 'fixed-yield-capability.v2', materialType: 'talking_head',
    archetypeIds: archetypes('P1'), productionModes: ['pipeline_1', 'pipeline_2', 'pipeline_3'],
    durationPolicy: 'exact_reference_shot_duration', currentSourcePolicy: 'authorized_digital_presenter',
    runtimeReadiness: 'requires_runtime_snapshot', maximumTimelineShots: 60, maximumOperationsPerShot: 12,
  },
  P2_PRODUCT_REAL: {
    pathId: 'P2_PRODUCT_REAL', pathVersion: 'fixed-yield-capability.v2', materialType: 'product',
    archetypeIds: archetypes('P2'), productionModes: ['local_video_match'],
    durationPolicy: 'exact_reference_shot_duration', currentSourcePolicy: 'tenant_authorized_local_video',
    runtimeReadiness: 'requires_runtime_snapshot', maximumTimelineShots: 60, maximumOperationsPerShot: 3,
  },
  P3_FACTORY_REAL: {
    pathId: 'P3_FACTORY_REAL', pathVersion: 'fixed-yield-capability.v2', materialType: 'factory',
    archetypeIds: archetypes('P3'), productionModes: ['local_video_match'],
    durationPolicy: 'exact_reference_shot_duration', currentSourcePolicy: 'tenant_authorized_local_video',
    runtimeReadiness: 'requires_runtime_snapshot', maximumTimelineShots: 60, maximumOperationsPerShot: 3,
  },
  P4_CONSUMER_REAL: {
    pathId: 'P4_CONSUMER_REAL', pathVersion: 'fixed-yield-capability.v2', materialType: 'consumer_demo',
    archetypeIds: archetypes('P4'), productionModes: ['local_video_match'],
    durationPolicy: 'exact_reference_shot_duration', currentSourcePolicy: 'tenant_authorized_local_video',
    runtimeReadiness: 'requires_runtime_snapshot', maximumTimelineShots: 60, maximumOperationsPerShot: 3,
  },
  P5_GENERAL_EVIDENCE: {
    pathId: 'P5_GENERAL_EVIDENCE', pathVersion: 'fixed-yield-capability.v2', materialType: 'general',
    archetypeIds: archetypes('P5'), productionModes: ['local_video_match'],
    durationPolicy: 'exact_reference_shot_duration', currentSourcePolicy: 'tenant_authorized_local_video',
    runtimeReadiness: 'requires_runtime_snapshot', maximumTimelineShots: 60, maximumOperationsPerShot: 3,
  },
};

const PATH_BY_MATERIAL: Record<Exclude<BenchmarkMaterialType, 'unknown'>, FixedYieldPathId> = {
  talking_head: 'P1_PRESENTER', product: 'P2_PRODUCT_REAL', factory: 'P3_FACTORY_REAL',
  consumer_demo: 'P4_CONSUMER_REAL', general: 'P5_GENERAL_EVIDENCE',
};

export function fixedYieldPathForMaterialType(materialType: BenchmarkMaterialType): FixedYieldPathId | null {
  return materialType === 'unknown' ? null : PATH_BY_MATERIAL[materialType];
}

export function defaultFixedYieldProductionMode(archetypeId: FixedYieldArchetypeId): FixedYieldProductionMode {
  if (archetypeId.startsWith('P2') || archetypeId.startsWith('P3') || archetypeId.startsWith('P4') || archetypeId.startsWith('P5')) return 'local_video_match';
  if (['P1A_FACTORY_WALK_TALK', 'P1D_SHELF_ACTION_TALK', 'P1F_REAL_PRODUCT_CONTACT'].includes(archetypeId)) return 'pipeline_2';
  return 'pipeline_1';
}

export function fixedYieldCapabilityIssues(): string[] {
  const issues: string[] = [];
  const seen = new Set<FixedYieldArchetypeId>();
  for (const pathId of FIXED_YIELD_PATH_IDS) {
    const path = FIXED_YIELD_CAPABILITY_MAP[pathId];
    if (!path.productionModes.length) issues.push(`${pathId}:production_mode_missing`);
    for (const archetypeId of path.archetypeIds) {
      if (seen.has(archetypeId)) issues.push(`${archetypeId}:duplicate_path_binding`);
      seen.add(archetypeId);
    }
  }
  for (const archetypeId of FIXED_YIELD_ARCHETYPE_IDS) if (!seen.has(archetypeId)) issues.push(`${archetypeId}:path_binding_missing`);
  return issues;
}
