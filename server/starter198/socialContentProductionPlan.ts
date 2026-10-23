import type {GeneratedAssetArchiveInput} from '../../shared/contracts/generatedMaterial.js';
import { editorialEvidenceScore, visualEvidenceScore } from '../digitalEmployees/sceneEvidence.js';
import type { SocialContentThemeId } from '../../shared/contracts/socialContentWorkflow.js';
import { socialContentMaterialPolicy } from '../../shared/socialContentMaterialPolicy.js';
import type { StoredSocialScriptBaseline } from './socialContentScriptBaseline.js';
import { socialText } from './socialContentValidation.js';
import type { MaterialScriptAnalysis, MaterialScriptRole } from '../../shared/materialScriptAnalysis.js';
import {
  inferMaterialRoles,
  normalizeSceneVisualContract,
  resolveProductCompatibility,
  scoreSceneVisualCompatibility,
  type SocialMaterialRole,
  type SocialSceneVisualContract,
} from '../../shared/sceneVisualContract.js';
import {
  buildMaterialSceneReview,
  materialReviewBundle,
  type MaterialReviewBundle,
  type MaterialSceneReview,
} from '../videoProduction/materialQualityLearning.js';

export { buildPlannedSceneTimingCues, buildPlannedTimeline } from './socialContentProductionTimeline.js';

export type SocialProductionAsset = {
  automaticMaterial?:GeneratedAssetArchiveInput['automaticMaterial'];
  id: string;
  name: string;
  type: 'video' | 'image';
  sourceId: string;
  url: string;
  localPath?: string;
  objectKey?: string;
  cloudRecordId?: string;
  contentHash?: string;
  /** Concrete commercial/derivative-use evidence for authorized shared
   * inventory. It is required before stock can enter a zero-asset render. */
  authorizationRef?: string;
  /** External generation provenance. These fields are audit data, not proof
   * that a provider call succeeded; an asset only enters production after the
   * adapter has verified a completed task and a concrete output file. */
  providerId?: string;
  providerTaskId?: string;
  idempotencyKey?: string;
  duration: number;
  visualObservations: string[];
  /** Legacy display labels. They are never sufficient to authorize an
   * association-only edit because labels and filenames are not proof that the
   * tenant linked this asset to the current product. */
  userProvidedObservations?: string[];
  /** Server-derived from an exact match between the task product reference and
   * the material provenance written at upload time. This proves association,
   * not visual contents. */
  explicitProductAssociation?: {
    productRef: string;
    basis: 'tenant_task_upload';
    exactTaskProductMatch: true;
  };
  segments: Array<Record<string, unknown>>;
  scriptAnalysis?: MaterialScriptAnalysis;
  /** Auditable retrieval origin. It does not change the visual evidence score. */
  selectionOrigin?: 'task' | 'tenant_library' | 'shared_library' | 'system_graphic';
};

export type ProductionClip = {
  clipId: string;
  /** All edit windows cut from one analyzed scene share this identifier. */
  evidenceShotId: string;
  assetId: string;
  assetName: string;
  type: 'video' | 'image';
  start: number;
  end: number;
  sourceDuration: number;
  observations: string[];
  confidence: number;
  /** Association-only clips remain unreviewed visual evidence even though a
   * safe, fact-free edit may use them. */
  needsReview: boolean;
  evidenceBasis: 'visual_analysis' | 'user_product_association';
  boundaryConfidence?: number;
  cleanEntry?: boolean;
  cleanExit?: boolean;
  actionPeak?: number | null;
  actionStart?: number;
  actionEnd?: number;
  editorialTerms?: string[];
  role?: MaterialScriptRole;
  visualContract?: SocialSceneVisualContract;
  materialRoles?: SocialMaterialRole[];
};

export type PlannedProductionScene = {
  sceneId: string;
  baselineSceneIndex: number;
  shotFunction: string;
  subject: string;
  action: string;
  baselineNarration: string;
  narration: string;
  clip: ProductionClip;
  semanticScore: number;
  matchBasis?: {
    primary: 'voiceover_verbatim';
    voiceover: string;
    primaryVoiceoverScore: number;
    secondaryVisualIntent: string;
    secondaryVisualScore: number;
    productCompatibilityScore: number;
    hookHighPrecision: boolean;
    lockedSourceRange: {
      evidenceShotId: string;
      startSeconds: number;
      endSeconds: number;
    };
  };
  materialReview?: MaterialSceneReview;
};

export type SocialProductionPlan = {
  ok: boolean;
  reasonCode: 'ready' | 'no_visual_material' | 'material_analysis_required' | 'insufficient_visual_coverage';
  message: string;
  scenes: PlannedProductionScene[];
  /** Unmatched reference scenes remain in the locked script. They must be
   * supplied before rendering rather than silently dropped from the edit. */
  pendingScenes?: Array<{ sceneId: string; baselineSceneIndex: number; narration: string; reason: 'material_match_missing' }>;
  selectedAssetIds: string[];
  unusedAssets: Array<{ assetId: string; assetName: string; reason: string }>;
  narrationChanged: boolean;
  maxDuration: number;
  sourceClipSeconds: number;
  averageConfidence: number;
  notes: string[];
  materialLearning?: MaterialReviewBundle;
};

function strings(value: unknown): string[] {
  return [value].flatMap(item => Array.isArray(item) ? item : [item])
    .map(socialText).filter(Boolean);
}

function segmentObservations(segment: Record<string, unknown>): string[] {
  return [segment.observedFacts, segment.action, segment.visual, segment.environment, segment.subject,
    segment.purpose, segment.recommendedFunctions, segment.shot, segment.camera]
    .flatMap(strings).map(value => value.replace(/\s+/g, ' ').slice(0, 240));
}

function identity(asset: SocialProductionAsset): string {
  return asset.contentHash || asset.localPath || asset.objectKey || asset.url || asset.id;
}

function hasExplicitProductAssociation(asset: SocialProductionAsset): boolean {
  return Boolean(asset.explicitProductAssociation?.exactTaskProductMatch
    && asset.explicitProductAssociation.basis === 'tenant_task_upload'
    && socialText(asset.explicitProductAssociation.productRef));
}

function hasTaskUploadAssociation(asset: SocialProductionAsset): boolean {
  return asset.selectionOrigin === 'task' || hasExplicitProductAssociation(asset);
}

function hasLocalTaskWindows(asset: SocialProductionAsset): boolean {
  return asset.selectionOrigin === 'task' && asset.segments.some(segment => (
    socialText(segment.analysisMode) === 'local_distinct_visual_windows'
  ));
}

function trustedClips(asset: SocialProductionAsset): ProductionClip[] {
  if (asset.type === 'image') {
    const observations = asset.visualObservations.map(socialText).filter(Boolean);
    const indexed = asset.scriptAnalysis?.shots[0];
    return observations.length ? [{
      clipId: `${asset.id}:image`, evidenceShotId: `${asset.id}:image`, assetId: asset.id, assetName: asset.name, type: 'image',
      start: 0, end: 0, sourceDuration: 2.8, observations, confidence: 0.85,
      needsReview: false, evidenceBasis: 'visual_analysis',
      ...(indexed ? {
        role: indexed.role,
        visualContract: structuredClone(indexed.visualContract),
        materialRoles: [...indexed.materialRoles],
        editorialTerms: [
          ...(indexed.matchTags || []).filter(tag => tag !== indexed.role),
          ...(indexed.editorial?.subjects || []),
          ...(indexed.editorial?.actions || []),
          ...(indexed.editorial?.environments || []),
          ...(indexed.editorial?.shotLanguage || []),
        ],
      } : {}),
    }] : [];
  }
  if (!Number.isFinite(asset.duration) || asset.duration < 1.5) return [];
  const clips: ProductionClip[] = [];
  for (const [index, segment] of asset.segments.entries()) {
    const start = Number(segment.start ?? segment.startTime);
    const end = Number(segment.end ?? segment.endTime);
    const confidence = Number(segment.confidence ?? (segment.quality !== undefined ? Number(segment.quality) / 100 : 0));
    const observations = segmentObservations(segment);
    if (segment.needsReview === true || !Number.isFinite(confidence) || confidence < 0.6
      || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > asset.duration + 0.05
      || end - start < 1.2 || !observations.length) continue;
    const evidenceShotId = `${asset.id}:${socialText(segment.id) || `segment-${index + 1}`}`;
    const indexed = asset.scriptAnalysis?.shots.find(shot => shot.segmentId === socialText(segment.id))
      || asset.scriptAnalysis?.shots[index];
    const trim = indexed?.editorial?.trim;
    const bounded = (value: unknown, fallback: number) => {
      const parsed = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
      return Number.isFinite(parsed) ? Math.max(start, Math.min(end, parsed)) : fallback;
    };
    const boundaryConfidence = Math.max(0, Math.min(1, Number(trim?.boundaryConfidence ?? segment.boundaryConfidence) || 0));
    const cleanEntry = trim?.cleanEntry ?? segment.cleanEntry === true;
    const cleanExit = trim?.cleanExit ?? segment.cleanExit === true;
    const trustedBoundary = boundaryConfidence >= .6 && cleanEntry && cleanExit;
    const safeStart = trustedBoundary ? bounded(trim?.preferredStartSeconds ?? segment.cleanStart, start) : start;
    const safeEnd = trustedBoundary ? Math.max(safeStart, bounded(trim?.preferredEndSeconds ?? segment.cleanEnd, end)) : end;
    if (safeEnd - safeStart < 1.2) continue;
    // Long analyzed sections are split into independent, non-overlapping edit
    // windows for trim-duration options. They remain one evidence shot and may
    // never satisfy more than one independent-shot requirement.
    const windowCount = Math.max(1, Math.min(4, Math.floor((safeEnd - safeStart) / 1.6)));
    const windowDuration = Math.min(3.5, (safeEnd - safeStart) / windowCount);
    const windowStride = windowCount <= 1 ? 0 : ((safeEnd - safeStart) - windowDuration) / (windowCount - 1);
    const peakValue = trim?.actionPeakSeconds ?? segment.actionPeak;
    const actionPeak = typeof peakValue === 'number' ? peakValue
      : typeof peakValue === 'string' && peakValue.trim() ? Number(peakValue) : Number.NaN;
    const actionStartValue = typeof segment.actionStart === 'number' ? segment.actionStart
      : typeof segment.actionStart === 'string' && segment.actionStart.trim() ? Number(segment.actionStart) : Number.NaN;
    const actionEndValue = typeof segment.actionEnd === 'number' ? segment.actionEnd
      : typeof segment.actionEnd === 'string' && segment.actionEnd.trim() ? Number(segment.actionEnd) : Number.NaN;
    const actionStart = Number.isFinite(actionStartValue) ? bounded(actionStartValue, safeStart) : undefined;
    const actionEnd = Number.isFinite(actionEndValue) && actionStart !== undefined
      ? Math.max(actionStart, bounded(actionEndValue, safeEnd)) : undefined;
    const completeActionStart = actionStart !== undefined && actionEnd !== undefined && actionEnd - actionStart <= windowDuration
      ? Math.max(safeStart, Math.min(actionStart, actionEnd - windowDuration)) : Number.NaN;
    const completeActionEnd = actionStart !== undefined && actionEnd !== undefined && actionEnd - actionStart <= windowDuration
      ? Math.min(actionStart, safeEnd - windowDuration) : Number.NaN;
    const peakStart = Number.isFinite(actionPeak)
      ? Math.max(Number.isFinite(completeActionStart) ? completeActionStart : safeStart,
        Math.min(Number.isFinite(completeActionEnd) ? completeActionEnd : safeEnd - windowDuration, actionPeak - windowDuration / 2))
      : null;
    const windowStarts = [...new Set([
      ...(peakStart === null ? [] : [Number(peakStart.toFixed(3))]),
      ...Array.from({ length: windowCount }, (_, window) => Number((safeStart + window * windowStride).toFixed(3))),
    ])].slice(0, 4);
    for (const [window, clipStart] of windowStarts.entries()) {
      const clipEnd = Math.min(safeEnd, clipStart + windowDuration);
      if (clipEnd - clipStart < 1.2) continue;
      clips.push({
        clipId: `${asset.id}:${index}:${window}`,
        evidenceShotId,
        assetId: asset.id,
        assetName: asset.name,
        type: 'video',
        start: clipStart,
        end: clipEnd,
        sourceDuration: clipEnd - clipStart,
        observations,
        confidence,
        needsReview: false,
        evidenceBasis: 'visual_analysis',
        boundaryConfidence,
        cleanEntry,
        cleanExit,
        actionPeak: Number.isFinite(actionPeak) ? actionPeak : null,
        ...(actionStart !== undefined && actionEnd !== undefined ? { actionStart, actionEnd } : {}),
        ...(indexed ? {
          role: indexed.role,
          visualContract: structuredClone(indexed.visualContract),
          materialRoles: [...indexed.materialRoles],
          editorialTerms: [
            ...(indexed.matchTags || []).filter(tag => tag !== indexed.role),
            ...(indexed.editorial?.subjects || []),
            ...(indexed.editorial?.actions || []),
            ...(indexed.editorial?.environments || []),
            ...(indexed.editorial?.shotLanguage || []),
          ],
        } : {}),
      });
    }
  }
  return clips;
}

/** A task upload or explicit product association can authorize a generic edit
 * when semantic vision is unavailable, but it never becomes a visual
 * observation. Locally verified distinct windows may become separate edit
 * shots; all retain confidence=0 / needsReview=true. */
function associationOnlyClip(asset: SocialProductionAsset): ProductionClip[] {
  if (!hasTaskUploadAssociation(asset)) return [];
  if (asset.type === 'video' && (!Number.isFinite(asset.duration) || asset.duration < 1.5)) return [];
  const locallyDistinct = asset.type === 'video'
    ? asset.segments.flatMap((segment, index) => {
      if (socialText(segment.analysisMode) !== 'local_distinct_visual_windows') return [];
      const start = Number(segment.start ?? segment.startTime);
      const end = Number(segment.end ?? segment.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0
        || end > asset.duration + 0.05 || end - start < 1.2) return [];
      const segmentId = socialText(segment.segmentId || segment.id) || `local-${index + 1}`;
      return [{
        clipId: `${asset.id}:${segmentId}`,
        evidenceShotId: `${asset.id}:${segmentId}`,
        assetId: asset.id,
        assetName: asset.name,
        type: 'video' as const,
        start,
        end,
        sourceDuration: end - start,
        observations: ['用户为当前任务上传；本地检测确认该区间与其他候选区间画面不同；未经语义视觉模型识别'],
        confidence: 0,
        needsReview: true,
        evidenceBasis: 'user_product_association' as const,
      }];
    }).slice(0, 4)
    : [];
  if (locallyDistinct.length >= 2) return locallyDistinct;
  const sourceDuration = asset.type === 'image' ? 2.8 : Math.min(3.5, asset.duration);
  return [{
    clipId: `${asset.id}:association-only`,
    evidenceShotId: `${asset.id}:association-only`,
    assetId: asset.id,
    assetName: asset.name,
    type: asset.type,
    start: 0,
    end: asset.type === 'image' ? 0 : sourceDuration,
    sourceDuration,
    observations: ['用户明确关联到当前任务产品；未经视觉模型识别'],
    confidence: 0,
    needsReview: true,
    evidenceBasis: 'user_product_association',
  }];
}

function isAssociationSafeBaseline(baseline: StoredSocialScriptBaseline): boolean {
  return baseline.source === 'knowledge_fallback'
    && !baseline.formulaReference
    && !baseline.match?.inspirationReference
    && baseline.match?.userProductAssociation?.basis === 'tenant_task_upload';
}

function sceneOrder(count: number, available: number): number[] {
  if (count <= available) return Array.from({ length: count }, (_, index) => index);
  if (available <= 1) return [0];
  if (available === 2) return [0, count - 1];
  const middleCount = available - 2;
  return [0, ...Array.from({ length: middleCount }, (_, index) => Math.min(count - 2, index + 1)), count - 1];
}

function sceneIntent(scene: StoredSocialScriptBaseline['scenes'][number]): string {
  return `${frozenVoiceover(scene)} ${scene.shotFunction} ${scene.subject} ${scene.action}`;
}

function secondaryVisualIntent(scene: StoredSocialScriptBaseline['scenes'][number]): string {
  return `${scene.shotFunction} ${scene.subject} ${scene.action}`;
}

function frozenVoiceover(scene: StoredSocialScriptBaseline['scenes'][number]): string {
  return socialText(scene.voiceover) || socialText(scene.narration);
}

function expectedVisualContract(
  scene: StoredSocialScriptBaseline['scenes'][number],
  sceneIndex: number,
): SocialSceneVisualContract {
  const stored = (scene as typeof scene & { visualContract?: unknown }).visualContract;
  return normalizeSceneVisualContract(stored ?? {
    subjects: [scene.subject],
    interaction: scene.action,
    action: scene.action,
    shotLanguage: scene.referenceStructure ? {
      shotSize: scene.referenceStructure.shotScale,
      movement: scene.referenceStructure.cameraMovement,
    } : undefined,
    precision: isHookScene(scene, sceneIndex) ? 'hook_high' : 'standard',
  });
}

function candidateVisualContract(clip: ProductionClip): SocialSceneVisualContract {
  return clip.visualContract ?? normalizeSceneVisualContract({
    subjects: clip.observations,
    interaction: clip.editorialTerms,
    action: clip.observations.join(' '),
  });
}

function isHookScene(scene: StoredSocialScriptBaseline['scenes'][number], sceneIndex: number): boolean {
  return sceneIndex === 0 || Number(scene.referenceStructure?.sourceTiming.startSeconds) < 3;
}

function voiceoverFirstScore(
  scene: StoredSocialScriptBaseline['scenes'][number],
  sceneIndex: number,
  clip: ProductionClip,
): {
  semanticScore: number;
  primaryVoiceoverScore: number;
  secondaryVisualScore: number;
  productCompatibilityScore: number;
  compatible: boolean;
} {
  const voiceover = editorialEvidenceScore(
    frozenVoiceover(scene),
    clip,
    clip.sourceDuration,
    clip.start,
    clip.end,
  );
  const visual = editorialEvidenceScore(
    secondaryVisualIntent(scene),
    clip,
    clip.sourceDuration,
    clip.start,
    clip.end,
  );
  const hookBonus = isHookScene(scene, sceneIndex)
    && visualEvidenceScore(sceneIntent(scene), [...clip.observations, ...(clip.editorialTerms || [])]) > 0 ? 12 : 0;
  const expected = expectedVisualContract(scene, sceneIndex);
  const candidate = candidateVisualContract(clip);
  const visualContractScore = scoreSceneVisualCompatibility(expected, candidate) * 100;
  const productCompatibility = resolveProductCompatibility({
    policy: expected.product.policy,
    requestedProductId: expected.product.requestedProductId,
    requestedProductRef: expected.product.requestedProductRef,
    candidateProductId: candidate.product.requestedProductId ?? candidate.productUsage.productId,
    candidateProductRef: candidate.product.requestedProductRef ?? candidate.productUsage.productRef,
    candidateMaterialRoles: clip.materialRoles ?? inferMaterialRoles(candidate),
  });
  return {
    // Compatibility field retained for review/learning consumers. Ranking is
    // lexicographic below: exact frozen voiceover first, then scene/product.
    semanticScore: voiceover * 2 + visual + hookBonus,
    primaryVoiceoverScore: voiceover,
    secondaryVisualScore: visual + visualContractScore + productCompatibility.score * 100 + hookBonus,
    productCompatibilityScore: productCompatibility.score * 100,
    compatible: productCompatibility.compatible,
  };
}

/** Pure production gate. It never mutates/deletes the material library: low
 * quality, duplicate and unrelated uploads simply remain unused for this edit. */
export function buildSocialProductionPlan(input: {
  baseline: StoredSocialScriptBaseline;
  assets: SocialProductionAsset[];
  themeId?: SocialContentThemeId | null;
  /** Exact per-scene outputs from the reviewed asset-supply execution. These
   * bind generated media to its frozen scene; they are not a visual-quality
   * pass and every resulting scene remains marked for independent review. */
  routedSceneAssets?: Array<{ sceneId: string; assetId: string; durationSeconds?: number }>;
}): SocialProductionPlan {
  const materialPolicy = socialContentMaterialPolicy(input.themeId ?? input.baseline.themeId ?? null);
  const fullReplication = input.baseline.source === 'inspiration_script';
  const pendingScenes = (assignedIndices: Iterable<number>) => {
    if (!fullReplication) return undefined;
    const assigned = new Set(assignedIndices);
    return input.baseline.scenes.flatMap((scene, index) => assigned.has(index) ? [] : [{
      sceneId: scene.sceneId, baselineSceneIndex: index, narration: frozenVoiceover(scene),
      reason: 'material_match_missing' as const,
    }]);
  };
  if (!input.assets.length) return {
    ok: false, reasonCode: 'no_visual_material',
    message: '没有可读取的图片或视频素材，请至少补充一段清晰实拍视频或两张相关图片。',
    scenes: [], pendingScenes: pendingScenes([]), selectedAssetIds: [], unusedAssets: [], narrationChanged: false,
    maxDuration: 0, sourceClipSeconds: 0, averageConfidence: 0, notes: [],
  };
  const seen = new Set<string>();
  const uniqueAssets: SocialProductionAsset[] = [];
  const unusedAssets: SocialProductionPlan['unusedAssets'] = [];
  for (const asset of input.assets) {
    const key = identity(asset);
    if (seen.has(key)) {
      unusedAssets.push({ assetId: asset.id, assetName: asset.name, reason: '与本次已选素材内容重复，原文件仍保留在素材库' });
      continue;
    }
    seen.add(key);
    uniqueAssets.push(asset);
  }
  if (input.routedSceneAssets) {
    const routed = new Map(input.routedSceneAssets.map(item => [item.sceneId, item.assetId]));
    if (routed.size !== input.routedSceneAssets.length || routed.size !== input.baseline.scenes.length) {
      return { ok:false,reasonCode:'insufficient_visual_coverage',message:'逐镜供应结果与冻结脚本数量不一致。',scenes:[],pendingScenes:pendingScenes([]),selectedAssetIds:[],unusedAssets,narrationChanged:false,maxDuration:0,sourceClipSeconds:0,averageConfidence:0,notes:['生成结果必须逐镜绑定，不能回退到未绑定素材。'] };
    }
    // Routed output identity is scene binding, not byte uniqueness. Two scenes
    // may intentionally reuse the same customer clip or render identical safe
    // graphic bytes under different scene-owned asset IDs. Content-hash
    // deduplication is useful for free matching below, but applying it here
    // deletes a valid route and turns full coverage into a false missing-scene
    // error.
    const assetsById = new Map(input.assets.map(asset => [asset.id, asset]));
    const routedSourceCursors = new Map<string, number>();
    const scenes = input.baseline.scenes.flatMap((scene, sceneIndex) => {
      const assetId = routed.get(scene.sceneId), asset = assetId ? assetsById.get(assetId) : null;
      const frozenDuration=Number(scene.referenceStructure?.sourceTiming.durationSeconds)
        ||(Number(scene.referenceStructure?.sourceTiming.endSeconds)-Number(scene.referenceStructure?.sourceTiming.startSeconds))
        ||input.routedSceneAssets!.find(item=>item.sceneId===scene.sceneId)?.durationSeconds||0;
      if (!asset || asset.type !== 'video' || !asset.localPath || !asset.contentHash
        ||!Number.isFinite(frozenDuration)||frozenDuration<=0
        || !Number.isFinite(asset.duration) || asset.duration+0.02<frozenDuration || !asset.visualObservations.length) return [];
      // A routed asset may cover several consecutive micro-shots. Preserve
      // continuity by consuming the source in frozen-timeline order instead
      // of restarting every scene at frame zero. When the requested windows
      // exceed a reusable local clip, wrap only after its usable range has
      // been consumed; the next scene still starts at a different frame.
      const cursor = routedSourceCursors.get(asset.id) ?? 0;
      const maxStart = Math.max(0, asset.duration - frozenDuration);
      const start = maxStart > 0 ? cursor % maxStart : 0;
      const end = Math.min(asset.duration, start + frozenDuration);
      routedSourceCursors.set(asset.id, cursor + frozenDuration);
      const clip:ProductionClip={clipId:`${asset.id}:routed:${scene.sceneId}`,evidenceShotId:`${asset.id}:routed:${scene.sceneId}`,assetId:asset.id,assetName:asset.name,type:'video',start,end,sourceDuration:end-start,observations:[...asset.visualObservations],confidence:1,needsReview:true,evidenceBasis:'visual_analysis',boundaryConfidence:1,cleanEntry:true,cleanExit:true};
      const review=buildMaterialSceneReview({sceneId:scene.sceneId,intent:sceneIntent(scene),selectedClipId:clip.clipId,candidates:[{type:'video',assetId:asset.id,clipId:clip.clipId,sourceStart:start,sourceEnd:end,score:100,analysisConfidence:1,boundaryConfidence:1,cleanEntry:true,cleanExit:true,needsReview:true,evidenceBasis:'visual_analysis'}]});
      return [{sceneId:scene.sceneId,baselineSceneIndex:sceneIndex,shotFunction:scene.shotFunction,subject:scene.subject,action:scene.action,baselineNarration:scene.narration,narration:scene.narration,clip,semanticScore:100,matchBasis:{primary:'voiceover_verbatim' as const,voiceover:frozenVoiceover(scene),primaryVoiceoverScore:100,secondaryVisualIntent:secondaryVisualIntent(scene),secondaryVisualScore:100,productCompatibilityScore:100,hookHighPrecision:isHookScene(scene,sceneIndex),lockedSourceRange:{evidenceShotId:clip.evidenceShotId,startSeconds:start,endSeconds:end}},materialReview:review}];
    });
    if(scenes.length!==input.baseline.scenes.length)return {ok:false,reasonCode:'material_analysis_required',message:'逐镜供应结果缺少可验证的视频字节、哈希、时长或场景绑定。',scenes:[],pendingScenes:pendingScenes(scenes.map(scene=>scene.baselineSceneIndex)),selectedAssetIds:[],unusedAssets,narrationChanged:false,maxDuration:0,sourceClipSeconds:0,averageConfidence:0,notes:['不能用原始产品图或系统说明图代替已承诺的生成镜头。']};
    const selectedAssetIds=[...new Set(scenes.map(scene=>scene.clip.assetId))],sourceClipSeconds=scenes.reduce((sum,scene)=>sum+scene.clip.sourceDuration,0),referenceDuration=Math.max(0,...input.baseline.scenes.map(scene=>Number(scene.referenceStructure?.sourceTiming.endSeconds)||0));
    const frozenTimelineDuration = referenceDuration > 0 ? referenceDuration : sourceClipSeconds;
    for(const asset of input.assets.filter(asset=>!selectedAssetIds.includes(asset.id)))unusedAssets.push({assetId:asset.id,assetName:asset.name,reason:'该逐镜供应结果未绑定当前冻结场景，未进入剪辑'});
    return {ok:true,reasonCode:'ready',message:'已按审核后的逐镜供应回执绑定生成视频；最终画面质量仍需独立验收。',scenes,selectedAssetIds,unusedAssets,narrationChanged:false,
      // Routed sources are trimmed into the frozen scene windows. Summing the
      // full source-file durations multiplies reused clips and can turn a
      // 38-second timeline into several minutes.
      maxDuration:frozenTimelineDuration,sourceClipSeconds,averageConfidence:1,notes:['供应回执只证明生成结果与场景身份绑定，不代表G4/G5质量检查通过。']};
  }
  const taskAssociatedAssetCount = uniqueAssets.filter(hasTaskUploadAssociation).length;
  const associationSafe = isAssociationSafeBaseline(input.baseline)
    || (['system_theme_baseline', 'knowledge_fallback'].includes(input.baseline.source)
      && (taskAssociatedAssetCount >= 2 || uniqueAssets.some(hasLocalTaskWindows)));
  const clipRows = uniqueAssets.map(asset => {
    const visuallyTrusted = trustedClips(asset);
    return {
      asset,
      clips: visuallyTrusted.length
        ? visuallyTrusted
        : associationSafe ? associationOnlyClip(asset) : [],
    };
  });
  for (const row of clipRows.filter(item => !item.clips.length)) {
    unusedAssets.push({
      assetId: row.asset.id,
      assetName: row.asset.name,
      reason: row.asset.type === 'video' && row.asset.duration < 1.5
        ? '视频有效时长不足 1.5 秒'
        : associationSafe && !hasExplicitProductAssociation(row.asset)
          ? '素材没有与当前任务产品的明确关联，不能进入知识骨架剪辑'
          : '未取得可信的画面分析结果，不能进入自动剪辑',
    });
  }
  const clips = clipRows.flatMap(item => item.clips);
  if (!clips.length) return {
    ok: false, reasonCode: 'material_analysis_required',
    message: '上传素材暂时没有可确认的清晰画面，请重新分析或补充更清晰、与主题相关的素材。',
    scenes: [], pendingScenes: pendingScenes([]), selectedAssetIds: [], unusedAssets, narrationChanged: false,
    maxDuration: 0, sourceClipSeconds: 0, averageConfidence: 0, notes: [],
  };

  const relevance = new Map(clips.map(clip => [clip.clipId, Math.max(
    0,
    ...input.baseline.scenes.map(scene => visualEvidenceScore(sceneIntent(scene), [
      ...clip.observations, ...(clip.editorialTerms || []),
    ])),
  )]));
  const associatedAssetIds = new Set(uniqueAssets.filter(hasTaskUploadAssociation).map(asset => asset.id));
  const relevantClips = clips.filter(clip => associationSafe
    ? associatedAssetIds.has(clip.assetId)
    : (relevance.get(clip.clipId) ?? 0) > 0);
  // Association-only production needs two independently evidenced visual
  // windows. They may be separate uploads or locally detected, visually
  // distinct shots inside one complete user video.
  const relevantEvidenceShots = associationSafe
    ? [...new Map(relevantClips.map(clip => [clip.evidenceShotId, clip])).values()]
    : [...new Map(relevantClips.map(clip => [clip.evidenceShotId, clip])).values()];
  for (const row of clipRows.filter(item => item.clips.length
    && item.clips.every(clip => associationSafe
      ? !associatedAssetIds.has(clip.assetId)
      : (relevance.get(clip.clipId) ?? 0) <= 0))) {
    unusedAssets.push({
      assetId: row.asset.id,
      assetName: row.asset.name,
      reason: associationSafe
        ? '素材未明确关联当前任务产品，原文件仍保留在素材库'
        : '画面分析结果与本次主题和脚本镜头不相关，原文件仍保留在素材库',
    });
  }
  if (relevantEvidenceShots.length < 2) return {
    ok: false,
    reasonCode: 'insufficient_visual_coverage',
    message: associationSafe
      ? '至少需要 2 个可区分的真实画面区间；可以来自两份素材，也可以来自一支包含多个真实镜头的完整视频。'
      : `素材中与本次主题和脚本相符的可信镜头不足 2 个，${materialPolicy.insufficientMessage}。`,
    scenes: [], pendingScenes: pendingScenes([]), selectedAssetIds: [], unusedAssets, narrationChanged: false,
    maxDuration: 0,
    sourceClipSeconds: relevantEvidenceShots.reduce((sum, clip) => sum + clip.sourceDuration, 0),
    averageConfidence: relevantEvidenceShots.reduce((sum, clip) => sum + clip.confidence, 0) / Math.max(1, relevantEvidenceShots.length),
    notes: associationSafe
      ? ['任务上传或产品关联只证明用户允许本次使用，不代表视觉模型确认了画面语义。', '本地镜头差异检测只确认画面不同；视觉语义置信度保持为 0，且继续标记待复核。']
      : ['独立镜头按真实分析片段计算；同一片段的切窗不会增加镜头数。', '不相关素材仅从本次剪辑中舍弃，不会从素材库删除。'],
  };

  const maximumScenes = fullReplication ? input.baseline.scenes.length : 4;
  const wanted = Math.min(maximumScenes, input.baseline.scenes.length, relevantEvidenceShots.length);
  const indices = fullReplication ? Array.from({ length: input.baseline.scenes.length }, (_, index) => index)
    : sceneOrder(input.baseline.scenes.length, wanted);
  const remaining = [...relevantClips];
  const assignments = indices.flatMap(sceneIndex => {
    const scene = input.baseline.scenes[sceneIndex]!;
    const ranked = remaining.map((clip, index) => {
      const scores = associationSafe ? {
        semanticScore: 0, primaryVoiceoverScore: 0, secondaryVisualScore: 0,
        productCompatibilityScore: 100, compatible: true,
      } : voiceoverFirstScore(scene, sceneIndex, clip);
      return { clip, index, ...scores };
    }).filter(candidate => associationSafe || (candidate.compatible
      && candidate.semanticScore >= (isHookScene(scene, sceneIndex) ? 25 : 10))).sort((left, right) => associationSafe
      ? left.clip.start - right.clip.start
      : right.primaryVoiceoverScore - left.primaryVoiceoverScore
        || right.secondaryVisualScore - left.secondaryVisualScore
        || right.productCompatibilityScore - left.productCompatibilityScore
        || right.clip.confidence - left.clip.confidence
        || right.clip.sourceDuration - left.clip.sourceDuration);
    const selected = ranked[0];
    if (!selected) return [];
    const materialReview = buildMaterialSceneReview({
      sceneId: scene.sceneId,
      intent: sceneIntent(scene),
      selectedClipId: selected.clip.clipId,
      candidates: ranked.slice(0, 5).map(candidate => ({
        type: candidate.clip.type,
        assetId: candidate.clip.assetId,
        clipId: candidate.clip.clipId,
        sourceStart: candidate.clip.start,
        sourceEnd: candidate.clip.end,
        score: candidate.semanticScore,
        analysisConfidence: candidate.clip.confidence,
        boundaryConfidence: candidate.clip.boundaryConfidence ?? 0,
        cleanEntry: candidate.clip.cleanEntry,
        cleanExit: candidate.clip.cleanExit,
        needsReview: candidate.clip.needsReview,
        evidenceBasis: candidate.clip.evidenceBasis,
      })),
    });
    // Evidence-shot ids, rather than asset ids, define independence here.
    // Several trim alternatives from one analyzed shot share an id and are
    // removed together, while locally detected cuts in one complete upload
    // retain separate ids and may each supply one scene.
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (remaining[index]!.evidenceShotId === selected.clip.evidenceShotId) remaining.splice(index, 1);
    }
    return [{ sceneIndex, scene, clip: selected.clip, semanticScore: selected.semanticScore,
      primaryVoiceoverScore: selected.primaryVoiceoverScore,
      secondaryVisualScore: selected.secondaryVisualScore,
      productCompatibilityScore: selected.productCompatibilityScore,
      materialReview }];
  });
  const sourceClipSeconds = assignments.reduce((sum, item) => sum + item.clip.sourceDuration, 0);
  const dynamicSeconds = assignments.filter(item => item.clip.type === 'video')
    .reduce((sum, item) => sum + item.clip.sourceDuration, 0);
  const averageConfidence = assignments.reduce((sum, item) => sum + item.clip.confidence, 0) / Math.max(1, assignments.length);
  const materialDuration = assignments.reduce((sum, item) => (
    sum + (item.clip.type === 'image' ? 2.8 : item.clip.sourceDuration / 0.82)
  ), 0);
  const referenceDuration = fullReplication ? Math.max(0, ...input.baseline.scenes.map(scene =>
    Number(scene.referenceStructure?.sourceTiming.endSeconds) || 0)) : 0;
  const maxDuration = fullReplication ? Math.max(materialDuration, referenceDuration) : Math.min(20, materialDuration);
  const pending = pendingScenes(assignments.map(item => item.sceneIndex));
  if (fullReplication && pending?.length) {
    return {
      ok: false, reasonCode: 'insufficient_visual_coverage',
      message: `全片复刻仍有 ${pending.length} 个分镜待匹配素材；已冻结的逐句口播和镜头将保留，不会删镜进入制作。`,
      scenes: [], pendingScenes: pending, selectedAssetIds: [], unusedAssets,
      narrationChanged: false, maxDuration, sourceClipSeconds, averageConfidence,
      notes: ['内容 Agent 需要为全部参考分镜匹配本地素材或完成授权生成，再按原片顺序制作。'],
    };
  }
  if (assignments.length < 2 || maxDuration < 5.5 || (!associationSafe && averageConfidence < 0.62)
    || (dynamicSeconds < 2.5 && assignments.filter(item => item.clip.type === 'image').length < 2)) {
    return {
      ok: false,
      reasonCode: 'insufficient_visual_coverage',
      message: associationSafe
        ? `当前只有 ${assignments.length} 个可区分的真实画面区间、约 ${sourceClipSeconds.toFixed(1)} 秒可用时长，达不到制作门槛。`
        : `当前只有 ${assignments.length} 个可信镜头、约 ${sourceClipSeconds.toFixed(1)} 秒有效画面，达不到可交付门槛。${materialPolicy.insufficientMessage}。`,
      scenes: [], selectedAssetIds: [], unusedAssets,
      narrationChanged: false, maxDuration, sourceClipSeconds, averageConfidence,
      notes: associationSafe
        ? ['系统不会删除已上传素材；产品关联不会被伪装成视觉识别或置信度。']
        : ['系统不会删除已上传素材，也不会用文字资料卡或重复末帧凑成品。'],
    };
  }
  const scenes = assignments.map(item => {
    return {
      sceneId: item.scene.sceneId,
      baselineSceneIndex: item.sceneIndex,
      shotFunction: item.scene.shotFunction,
      subject: item.scene.subject,
      action: item.scene.action,
      baselineNarration: item.scene.narration,
      // The Content Agent retrieves and edits against the Director's exact
      // spoken line. Only a new DirectorPlan version may rewrite it.
      narration: item.scene.narration,
      clip: item.clip,
      semanticScore: item.semanticScore,
      matchBasis: {
        primary: 'voiceover_verbatim' as const,
        voiceover: frozenVoiceover(item.scene),
        primaryVoiceoverScore: item.primaryVoiceoverScore,
        secondaryVisualIntent: secondaryVisualIntent(item.scene),
        secondaryVisualScore: item.secondaryVisualScore,
        productCompatibilityScore: item.productCompatibilityScore,
        hookHighPrecision: isHookScene(item.scene, item.sceneIndex),
        lockedSourceRange: {
          evidenceShotId: item.clip.evidenceShotId,
          startSeconds: item.clip.start,
          endSeconds: item.clip.end,
        },
      },
      materialReview: item.materialReview,
    };
  });
  const selectedAssetIds = [...new Set(scenes.map(item => item.clip.assetId))];
  for (const asset of uniqueAssets.filter(item => !selectedAssetIds.includes(item.id))) {
    if (!unusedAssets.some(item => item.assetId === asset.id)) {
      unusedAssets.push({ assetId: asset.id, assetName: asset.name, reason: '本次脚本有更清晰或更相关的镜头，素材仍保留供后续任务使用' });
    }
  }
  const narrationChanged = scenes.length !== input.baseline.scenes.length
    || scenes.some(item => item.narration !== item.baselineNarration);
  return {
    ok: true,
    reasonCode: 'ready',
    message: associationSafe
      ? '已按用户明确的当前产品关联生成安全知识骨架；画面内容仍未宣称经过视觉识别。'
      : '素材已按清晰度、重复度和脚本相关性完成筛选。',
    scenes,
    selectedAssetIds,
    unusedAssets,
    narrationChanged,
    maxDuration,
    sourceClipSeconds,
    averageConfidence,
    notes: [
      associationSafe
        ? `本次使用 ${scenes.length} 个可区分真实画面区间（来自 ${selectedAssetIds.length} 份任务素材）；关联证明不等于视觉识别，未选素材不会删除。`
        : `本次只使用 ${selectedAssetIds.length} 份素材中的 ${scenes.length} 个可信镜头，未选素材不会删除。`,
      narrationChanged ? '执行稿仅做删镜和压缩，未添加新的产品事实。' : '执行稿与锁定脚本一致。',
    ],
    materialLearning: materialReviewBundle(scenes.flatMap(scene => scene.materialReview ? [scene.materialReview] : [])),
  };
}
