import type { BenchmarkAnalysis, BenchmarkMaterialType, BenchmarkShotRole } from './benchmarkAnalysis.js';
import {
  defaultFixedYieldProductionMode,
  fixedYieldPathForMaterialType,
  FIXED_YIELD_CAPABILITY_MAP,
  FIXED_YIELD_PATH_IDS,
  type FixedYieldPathId,
  type FixedYieldProductionMode,
} from './fixedYieldCapabilityMap.js';
import { classifyFixedYieldArchetype, type FixedYieldArchetypeId } from './fixedYieldMaterialRegistry.js';
import { productionReferenceAdmission } from './productionReferenceAdmission.js';
import { normalizeSceneVisualContract } from './sceneVisualContract.js';

export interface FixedYieldTimelineShot {
  timelineShotId: string;
  referenceShotId: string;
  sourceStartMs: number;
  sourceEndMs: number;
  timelineStartMs: number;
  timelineEndMs: number;
  targetOutputDurationMs: number;
  /** Frozen product identity for every product-bound archetype. It is never
   * supplied by a later material candidate. */
  productRef: string | null;
  materialType: Exclude<BenchmarkMaterialType, 'unknown'>;
  narrativeRole: BenchmarkShotRole;
  pathId: FixedYieldPathId;
  archetypeId: FixedYieldArchetypeId;
  productionMode: FixedYieldProductionMode;
  classificationEvidence: string;
}

export interface FixedYieldTimelineCompilation {
  schemaVersion: 'fixed-yield-timeline-compilation.v2';
  capabilityMapVersion: 'fixed-yield-capability.v2';
  referenceVideoId: string;
  referenceEvidenceRevision: string;
  productRef: string | null;
  ready: boolean;
  blockers: string[];
  referenceDurationMs: number;
  targetDurationMs: number;
  unresolvedReferenceDurationMs: number;
  classifiedDurationMsByPath: Record<FixedYieldPathId, number>;
  requiredArchetypeIds: FixedYieldArchetypeId[];
  shots: FixedYieldTimelineShot[];
}

const FRAME_TOLERANCE_MS = 34;

function shotVisualInput(shot: BenchmarkAnalysis['shots'][number], productRef?: string | null) {
  const description = [shot.visual, shot.purpose, shot.environment, shot.framing, shot.camera,
    shot.onScreenText, ...Object.values(shot.detailedAnalysis)].filter(Boolean).join('；');
  return normalizeSceneVisualContract({
    subjects: [shot.visual],
    interaction: { description: [shot.visual, shot.dialogue].filter(Boolean).join('；') },
    environment: { description: shot.environment || shot.visual },
    action: { path: [shot.visual, shot.purpose, shot.detailedAnalysis.startState, shot.detailedAnalysis.endState].filter(Boolean).join('；') },
    camera: { shotSize: shot.framing, movement: shot.camera, composition: description },
    productRef: productRef || undefined,
    productPolicy: productRef ? 'locked' : 'open',
    evidence: shot.start === null || shot.end === null ? undefined : { sourceRange: { startSeconds: shot.start, endSeconds: shot.end } },
  });
}

/** Converts one admitted physical reference timeline into a lossless production
 * timeline. It never invents shots, alters material types or calls providers. */
export function compileFixedYieldTimeline(input: {
  analysis: BenchmarkAnalysis | null | undefined;
  productRef?: string | null;
}): FixedYieldTimelineCompilation {
  const analysis = input.analysis;
  const productRef = String(input.productRef ?? '').normalize('NFKC').trim() || null;
  const admission = productionReferenceAdmission(analysis);
  const blockers = [...admission.blockers];
  const byPath = Object.fromEntries(FIXED_YIELD_PATH_IDS.map(pathId => [pathId, 0])) as Record<FixedYieldPathId, number>;
  if (!analysis) return {
    schemaVersion: 'fixed-yield-timeline-compilation.v2', capabilityMapVersion: 'fixed-yield-capability.v2',
    referenceVideoId: '', referenceEvidenceRevision: '', productRef, ready: false, blockers,
    referenceDurationMs: 0, targetDurationMs: 0, unresolvedReferenceDurationMs: 0,
    classifiedDurationMsByPath: byPath, requiredArchetypeIds: [], shots: [],
  };
  const ordered = [...analysis.shots].sort((left, right) => (left.start ?? Infinity) - (right.start ?? Infinity) || left.index - right.index);
  const shots: FixedYieldTimelineShot[] = [];
  let timelineCursorMs = 0;
  let unresolvedReferenceDurationMs = 0;
  let previousSourceEndMs = 0;
  for (const shot of ordered) {
    if (shot.start === null || shot.end === null) continue;
    const sourceStartMs = Math.round(shot.start * 1000);
    const sourceEndMs = Math.round(shot.end * 1000);
    if (!shots.length && sourceStartMs > FRAME_TOLERANCE_MS) blockers.push(`第 ${shot.index} 镜之前存在 ${sourceStartMs}ms 未映射时间`);
    if (shots.length) {
      const delta = sourceStartMs - previousSourceEndMs;
      if (Math.abs(delta) > FRAME_TOLERANCE_MS) {
        blockers.push(`第 ${shot.index} 镜与上一镜存在 ${Math.abs(delta)}ms ${delta > 0 ? '空洞' : '重叠'}`);
        if (delta > 0) unresolvedReferenceDurationMs += delta;
      }
    }
    const durationMs = sourceEndMs - sourceStartMs;
    if (shot.materialType === 'unknown') {
      unresolvedReferenceDurationMs += Math.max(0, durationMs);
      previousSourceEndMs = sourceEndMs;
      continue;
    }
    const pathId = fixedYieldPathForMaterialType(shot.materialType);
    const archetypeId = pathId ? classifyFixedYieldArchetype({
      materialType: shot.materialType,
      visual: shotVisualInput(shot, input.productRef),
      description: [shot.visual, shot.purpose, shot.environment, shot.camera].filter(Boolean).join('；'),
      function: shot.narrativeRole === 'cta' ? 'call_to_action' : shot.narrativeRole === 'hook' ? 'hook' : 'proof',
    }) : null;
    if (!pathId || !archetypeId) {
      blockers.push(`第 ${shot.index} 镜无法映射到固定生产路径`);
      unresolvedReferenceDurationMs += Math.max(0, durationMs);
      previousSourceEndMs = sourceEndMs;
      continue;
    }
    const productBound = archetypeId === 'P1F_REAL_PRODUCT_CONTACT'
      || pathId === 'P2_PRODUCT_REAL' || pathId === 'P4_CONSUMER_REAL';
    if (productBound && !productRef) blockers.push(`第 ${shot.index} 镜 ${archetypeId} 缺少冻结产品身份`);
    const timelineStartMs = timelineCursorMs;
    const timelineEndMs = timelineStartMs + durationMs;
    shots.push({ timelineShotId: `timeline:${shot.shotId}`, referenceShotId: shot.shotId,
      sourceStartMs, sourceEndMs, timelineStartMs, timelineEndMs, targetOutputDurationMs: durationMs, productRef,
      materialType: shot.materialType, narrativeRole: shot.narrativeRole, pathId, archetypeId,
      productionMode: defaultFixedYieldProductionMode(archetypeId), classificationEvidence: shot.classificationEvidence });
    byPath[pathId] += durationMs;
    timelineCursorMs = timelineEndMs;
    previousSourceEndMs = sourceEndMs;
  }
  const referenceDurationMs = ordered.length && ordered.at(-1)?.end !== null
    ? Math.round(Number(ordered.at(-1)!.end) * 1000) : 0;
  if (shots.length !== ordered.length) blockers.push('并非所有参考物理镜头都已唯一映射');
  if (new Set(shots.map(shot => shot.referenceShotId)).size !== shots.length) blockers.push('参考镜头被重复映射');
  if (new Set(shots.map(shot => shot.timelineShotId)).size !== shots.length) blockers.push('时间线镜头标识重复');
  const maximumTimelineShots = Math.min(...FIXED_YIELD_PATH_IDS.map(pathId => FIXED_YIELD_CAPABILITY_MAP[pathId].maximumTimelineShots));
  if (shots.length > maximumTimelineShots) blockers.push(`时间线镜头数 ${shots.length} 超过当前上限 ${maximumTimelineShots}`);
  if (Math.abs(referenceDurationMs - timelineCursorMs) > FRAME_TOLERANCE_MS) {
    const missing = Math.abs(referenceDurationMs - timelineCursorMs);
    blockers.push(`参考时长与目标时间线相差 ${missing}ms`);
    unresolvedReferenceDurationMs += missing;
  }
  return {
    schemaVersion: 'fixed-yield-timeline-compilation.v2', capabilityMapVersion: 'fixed-yield-capability.v2',
    referenceVideoId: analysis.source.videoId, referenceEvidenceRevision: analysis.source.evidenceRevision || '', productRef,
    ready: blockers.length === 0 && unresolvedReferenceDurationMs === 0,
    blockers: [...new Set(blockers)], referenceDurationMs, targetDurationMs: timelineCursorMs,
    unresolvedReferenceDurationMs, classifiedDurationMsByPath: byPath,
    requiredArchetypeIds: [...new Set(shots.map(shot => shot.archetypeId))], shots,
  };
}
