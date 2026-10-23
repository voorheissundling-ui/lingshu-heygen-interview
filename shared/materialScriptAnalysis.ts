import {
  inferMaterialRoles,
  normalizeSceneVisualContract,
  type SocialMaterialRole,
  type SocialSceneVisualContract,
} from './sceneVisualContract.js';
import type { SocialProductFootageEvidenceBinding } from './contracts/socialContentReplication.js';

export type MaterialScriptRole = 'hook' | 'demonstration' | 'proof' | 'explanation' | 'transition' | 'closing' | 'support';

export interface MaterialScriptShot {
  /** Server-projected only; never trusted from an uploaded material row. */
  footageEvidence?: SocialProductFootageEvidenceBinding;
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
  role: MaterialScriptRole;
  instruction: string;
  observedEvidence: string[];
  matchTags: string[];
  confidence: number;
  needsReview: boolean;
  /** Same visual vocabulary consumed by the Director and Content Agent. */
  visualContract: SocialSceneVisualContract;
  /** Asset roles are separate from this shot's narrative `role`. */
  materialRoles: SocialMaterialRole[];
  /** Reusable editorial facts computed once when the material is ingested. */
  editorial: {
    subjects: string[];
    actions: string[];
    environments: string[];
    shotLanguage: string[];
    motionLevel: 'static' | 'low' | 'medium' | 'high' | 'unknown';
    /** Safe source interval for later task-specific trimming. */
    trim: {
      preferredStartSeconds: number;
      preferredEndSeconds: number;
      actionPeakSeconds: number | null;
      boundaryConfidence: number;
      cleanEntry: boolean;
      cleanExit: boolean;
    };
  };
}

/**
 * A reusable, truth-preserving script view of a material. It describes what a
 * verified shot can do in a script; it never invents product claims or changes
 * the uploaded pixels.
 */
export interface MaterialScriptAnalysis {
  schemaVersion: 'material-script-analysis.v3';
  status: 'ready';
  sourceRevision: string;
  summary: string;
  hookCapability: {
    score: number;
    reasons: string[];
  };
  functions: string[];
  searchableText: string;
  /** Faceted index for fast recall; final ranking still uses the current scene. */
  directorIndex: {
    subjects: string[];
    actions: string[];
    environments: string[];
    shotLanguage: string[];
    functions: string[];
    interactions: string[];
    productUsage: string[];
    materialRoles: SocialMaterialRole[];
  };
  shots: MaterialScriptShot[];
  truthBoundary: string;
  analyzedAt: string;
}

type SegmentLike = Record<string, unknown>;

function text(value: unknown, max = 240): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function strings(value: unknown, max = 24): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => text(item, 120)).filter(Boolean).slice(0, max);
}

function unique(values: string[], max = 40): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max);
}

function roleFor(segment: SegmentLike, index: number, count: number): MaterialScriptRole {
  const source = [
    ...strings(segment.recommendedFunctions),
    text(segment.action), text(segment.observedFacts), text(segment.ocrText),
  ].join(' ').toLowerCase();
  if (/钩子|hook|开场|吸引|悬念|冲突/.test(source) || index === 0) return 'hook';
  if (/演示|使用|操作|demo|过程|步骤/.test(source)) return 'demonstration';
  if (/证明|证据|细节|特写|质检|工厂|proof/.test(source)) return 'proof';
  if (/讲解|解释|说明|卖点|explain/.test(source)) return 'explanation';
  if (/转场|过渡|transition/.test(source)) return 'transition';
  if (/收尾|结尾|行动|call.to.action|cta/.test(source) || index === count - 1) return 'closing';
  return 'support';
}

function instructionFor(role: MaterialScriptRole, evidence: string[]): string {
  const visible = evidence[0] || '已确认可见画面';
  const instructions: Record<MaterialScriptRole, string> = {
    hook: `可作为前三秒开场，用“${visible}”直接建立注意力；文案必须另写，不能把未出现的信息说成画面事实。`,
    demonstration: `可用于使用或操作演示，剪辑时保留“${visible}”对应的真实动作。`,
    proof: `可作为可见证据镜头，只能证明画面里实际出现的“${visible}”。`,
    explanation: `可承接讲解段落，用“${visible}”配合已核实的旁白信息。`,
    transition: `可作为节奏和场景过渡，不承担未经核实的产品证明。`,
    closing: `可作为收尾画面；行动号召与承诺仍须来自已核实的企业信息。`,
    support: `可作为辅助画面使用，脚本匹配以“${visible}”为边界。`,
  };
  return instructions[role];
}

function finiteInRange(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function motionLevel(segment: SegmentLike): MaterialScriptShot['editorial']['motionLevel'] {
  const explicit = text(segment.motionLevel, 20).toLowerCase();
  if (['static', 'low', 'medium', 'high'].includes(explicit)) return explicit as MaterialScriptShot['editorial']['motionLevel'];
  const source = [text(segment.action), text(segment.camera), ...strings(segment.observedFacts)].join(' ');
  if (!source) return 'unknown';
  if (/快速|剧烈|奔跑|旋转|抛|跌落|切换|fast|rapid|shake|spin|drop/i.test(source)) return 'high';
  if (/移动|操作|打开|关闭|拿起|放下|推进|横移|跟拍|move|open|close|pick|pan|track/i.test(source)) return 'medium';
  if (/缓慢|轻微|稳定移动|slow|subtle/i.test(source)) return 'low';
  if (/静止|固定|无明显动作|static|still/i.test(source)) return 'static';
  return 'unknown';
}

function editorialFor(segment: SegmentLike, start: number, end: number): MaterialScriptShot['editorial'] {
  const subjects = unique([...strings(segment.subject), text(segment.subject), ...strings(segment.observedFacts)], 16);
  const actions = unique([text(segment.action), ...strings(segment.actions)], 12);
  const environments = unique([text(segment.environment)], 8);
  const shotLanguage = unique([text(segment.shot), text(segment.angle), text(segment.camera), text(segment.composition)], 12);
  const preferredStartSeconds = finiteInRange(segment.cleanStart ?? segment.actionStart, start, end, start);
  const preferredEndSeconds = finiteInRange(segment.cleanEnd ?? segment.actionEnd, preferredStartSeconds, end, end);
  const rawPeak = typeof segment.actionPeak === 'number' ? segment.actionPeak
    : typeof segment.actionPeak === 'string' && segment.actionPeak.trim() ? Number(segment.actionPeak) : Number.NaN;
  const actionPeakSeconds = Number.isFinite(rawPeak) && rawPeak >= preferredStartSeconds && rawPeak <= preferredEndSeconds
    ? Number(rawPeak.toFixed(2)) : null;
  // Factual confidence cannot prove that a sampled timestamp is a safe edit
  // boundary. Older analyses did not produce boundary evidence, so they must
  // remain conservative until the visual analyzer is run again.
  const boundaryConfidence = finiteInRange(segment.boundaryConfidence, 0, 1, 0);
  return {
    subjects,
    actions,
    environments,
    shotLanguage,
    motionLevel: motionLevel(segment),
    trim: {
      preferredStartSeconds: Number(preferredStartSeconds.toFixed(2)),
      preferredEndSeconds: Number(preferredEndSeconds.toFixed(2)),
      actionPeakSeconds,
      boundaryConfidence: Number(boundaryConfidence.toFixed(3)),
      cleanEntry: segment.cleanEntry === true && boundaryConfidence >= .6,
      cleanExit: segment.cleanExit === true && boundaryConfidence >= .6,
    },
  };
}

function visualContractFor(input: {
  segment: SegmentLike;
  start: number;
  end: number;
  productId?: string | null;
  productRef?: string | null;
  productPolicy?: 'locked' | 'preferred' | 'open';
  productPolicySource?: 'user_explicit' | 'agent_inferred' | 'inventory_open';
  hook: boolean;
}): SocialSceneVisualContract {
  const segment = input.segment;
  const productId = text(segment.productId ?? input.productId, 240) || null;
  const productRef = text(segment.productRef ?? input.productRef, 240) || null;
  return normalizeSceneVisualContract({
    subjects: [...strings(segment.subject), text(segment.subject), ...strings(segment.observedFacts)].filter(Boolean),
    interaction: segment.interaction,
    subjectRelations: segment.subjectRelations,
    environment: segment.environment,
    productUsage: typeof segment.productUsage === 'object' && segment.productUsage
      ? segment.productUsage
      : { description: text(segment.productUsage), productId, productRef },
    product: {
      policy: input.productPolicy ?? (productRef ? 'preferred' : 'open'),
      requestedProductId: productId,
      requestedProductRef: productRef,
      source: input.productPolicySource ?? (productRef ? 'agent_inferred' : 'inventory_open'),
    },
    action: {
      startState: text(segment.startState),
      path: text(segment.action) || strings(segment.actions)[0] || '',
      peakState: text(segment.peakState),
      endState: text(segment.endState),
      startSeconds: segment.actionStart,
      peakSeconds: segment.actionPeak,
      endSeconds: segment.actionEnd,
    },
    camera: {
      shotSize: text(segment.shot),
      angle: text(segment.angle),
      movement: text(segment.camera),
      composition: text(segment.composition),
    },
    precision: input.hook ? 'hook_high' : 'standard',
    evidence: {
      sourceRange: { startSeconds: input.start, endSeconds: input.end },
      keyframeIds: strings(segment.keyframeIds),
      confidence: segment.confidence,
    },
  });
}

export function buildMaterialScriptAnalysis(input: {
  materialId: string;
  name: string;
  sourceRevision: string;
  duration: number;
  segments?: SegmentLike[];
  visualObservations?: string[];
  productId?: string | null;
  productRef?: string | null;
  productPolicy?: 'locked' | 'preferred' | 'open';
  productPolicySource?: 'user_explicit' | 'agent_inferred' | 'inventory_open';
  analyzedAt?: string;
}): MaterialScriptAnalysis {
  const sourceSegments = Array.isArray(input.segments) ? input.segments : [];
  const fallbackEvidence = unique((input.visualObservations || []).map(value => text(value)).filter(Boolean));
  const normalizedSegments = sourceSegments.length ? sourceSegments : [{
    id: `${input.materialId}-whole`, start: 0, end: Math.max(0, input.duration),
    observedFacts: fallbackEvidence,
  }];
  const shots = normalizedSegments.map((segment, index): MaterialScriptShot => {
    const role = roleFor(segment, index, normalizedSegments.length);
    const evidence = unique([
      ...strings(segment.observedFacts),
      text(segment.action), text(segment.environment),
      ...strings(segment.subject), text(segment.shot), text(segment.camera),
      text(segment.ocrText),
      ...(sourceSegments.length ? [] : fallbackEvidence),
    ]);
    const functions = strings(segment.recommendedFunctions);
    const start = Math.max(0, Number(segment.start || 0));
    const end = Math.max(start, Number(segment.end ?? input.duration ?? start));
    const confidence = Math.max(0, Math.min(1, Number(segment.confidence ?? 0.7)));
    const editorial = editorialFor(segment, start, end);
    const visualContract = visualContractFor({
      segment,
      start,
      end,
      productId: input.productId,
      productRef: input.productRef,
      productPolicy: input.productPolicy,
      productPolicySource: input.productPolicySource,
      hook: role === 'hook' || start < 3,
    });
    return {
      segmentId: text(segment.id, 160) || `${input.materialId}-segment-${index + 1}`,
      startSeconds: Number(start.toFixed(2)),
      endSeconds: Number(end.toFixed(2)),
      role,
      instruction: instructionFor(role, evidence),
      observedEvidence: evidence,
      matchTags: unique([role, ...functions, ...evidence]),
      confidence,
      needsReview: Boolean(segment.needsReview) || confidence < 0.65,
      visualContract,
      materialRoles: inferMaterialRoles(visualContract),
      editorial,
    };
  });
  const functions = unique(shots.flatMap(shot => [shot.role, ...shot.matchTags.slice(0, 6)]));
  const first = shots[0];
  const hookScore = Math.max(0, Math.min(100, Math.round(
    (first?.observedEvidence.length ? 35 : 0)
    + (first?.confidence || 0) * 35
    + (first?.role === 'hook' ? 20 : 0)
    + (first && first.endSeconds - first.startSeconds <= 3.5 ? 10 : 0),
  )));
  const hookReasons = unique([
    first?.observedEvidence.length ? '前三秒存在可描述的真实画面' : '前三秒缺少明确视觉证据',
    first?.role === 'hook' ? '首段具备开场钩子功能' : '首段需要通过剪辑或文案补强钩子',
    first?.needsReview ? '首段仍需人工复核' : '首段识别置信度可用',
  ]);
  const searchableText = unique([
    input.name,
    ...shots.flatMap(shot => [shot.role, ...shot.matchTags, ...shot.observedEvidence]),
  ], 120).join(' ').slice(0, 8_000);
  return {
    schemaVersion: 'material-script-analysis.v3',
    status: 'ready',
    sourceRevision: input.sourceRevision,
    summary: `已将${shots.length}个真实画面区间整理为可匹配的脚本镜头；前三秒钩子能力 ${hookScore}/100。`,
    hookCapability: { score: hookScore, reasons: hookReasons },
    functions,
    searchableText,
    directorIndex: {
      subjects: unique(shots.flatMap(shot => shot.editorial.subjects), 80),
      actions: unique(shots.flatMap(shot => shot.editorial.actions), 80),
      environments: unique(shots.flatMap(shot => shot.editorial.environments), 60),
      shotLanguage: unique(shots.flatMap(shot => shot.editorial.shotLanguage), 60),
      functions,
      interactions: unique(shots.map(shot => shot.visualContract.interaction.kind), 40),
      productUsage: unique(shots.map(shot => shot.visualContract.productUsage.kind), 40),
      materialRoles: [...new Set(shots.flatMap(shot => shot.materialRoles))],
    },
    shots,
    truthBoundary: '分析只描述原素材中可见、可确认的内容；不会改写客户原片，也不会生成未核实的产品功效、工厂或人物事实。',
    analyzedAt: input.analyzedAt || new Date().toISOString(),
  };
}

export function reusableMaterialScriptAnalysis(value: unknown, sourceRevision: string): MaterialScriptAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const analysis = value as Partial<MaterialScriptAnalysis> & Record<string, unknown>;
  const schemaVersion = analysis.schemaVersion as string | undefined;
  if (schemaVersion === 'material-script-analysis.v3'
    && analysis.status === 'ready'
    && analysis.sourceRevision === sourceRevision
    && Array.isArray(analysis.shots)
    && analysis.shots.every(shot => Boolean(shot?.editorial?.trim && shot.visualContract && shot.materialRoles))
    && Boolean(analysis.directorIndex)
  ) return analysis as MaterialScriptAnalysis;
  // v2 records are read-compatible. Project their factual editorial fields to
  // the shared contract; callers can persist the returned v3 value lazily.
  if (schemaVersion !== 'material-script-analysis.v2'
    || analysis.status !== 'ready'
    || analysis.sourceRevision !== sourceRevision
    || !Array.isArray(analysis.shots)) return null;
  const legacy = analysis as unknown as {
    status: 'ready'; sourceRevision: string; summary: string;
    hookCapability: { score: number; reasons: string[] }; functions: string[];
    searchableText: string; truthBoundary: string; analyzedAt: string;
    directorIndex?: { subjects?: string[]; actions?: string[]; environments?: string[]; shotLanguage?: string[]; functions?: string[] };
    shots: Array<Omit<MaterialScriptShot, 'visualContract' | 'materialRoles'>>;
  };
  const shots = legacy.shots.flatMap((shot, index): MaterialScriptShot[] => {
    if (!shot?.editorial?.trim) return [];
    const visualContract = normalizeSceneVisualContract({
      subjects: shot.editorial.subjects,
      actions: shot.editorial.actions,
      environments: shot.editorial.environments,
      shotLanguage: {
        shotSize: shot.editorial.shotLanguage[0] || '',
        cameraAngle: shot.editorial.shotLanguage[1] || '',
        movement: shot.editorial.shotLanguage[2] || '',
        composition: shot.editorial.shotLanguage[3] || '',
      },
      precision: index === 0 || shot.startSeconds < 3 ? 'hook_high' : 'standard',
      evidence: {
        sourceRange: { startSeconds: shot.startSeconds, endSeconds: shot.endSeconds },
        confidence: shot.confidence,
      },
    });
    return [{ ...shot, visualContract, materialRoles: inferMaterialRoles(visualContract) }];
  });
  if (shots.length !== legacy.shots.length) return null;
  return {
    schemaVersion: 'material-script-analysis.v3',
    status: 'ready',
    sourceRevision: legacy.sourceRevision,
    summary: legacy.summary,
    hookCapability: legacy.hookCapability,
    functions: legacy.functions,
    searchableText: legacy.searchableText,
    directorIndex: {
      subjects: legacy.directorIndex?.subjects ?? unique(shots.flatMap(shot => shot.editorial.subjects), 80),
      actions: legacy.directorIndex?.actions ?? unique(shots.flatMap(shot => shot.editorial.actions), 80),
      environments: legacy.directorIndex?.environments ?? unique(shots.flatMap(shot => shot.editorial.environments), 60),
      shotLanguage: legacy.directorIndex?.shotLanguage ?? unique(shots.flatMap(shot => shot.editorial.shotLanguage), 60),
      functions: legacy.directorIndex?.functions ?? legacy.functions,
      interactions: unique(shots.map(shot => shot.visualContract.interaction.kind), 40),
      productUsage: unique(shots.map(shot => shot.visualContract.productUsage.kind), 40),
      materialRoles: [...new Set(shots.flatMap(shot => shot.materialRoles))],
    },
    shots,
    truthBoundary: legacy.truthBoundary,
    analyzedAt: legacy.analyzedAt,
  };
}
