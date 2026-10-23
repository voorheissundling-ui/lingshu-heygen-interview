export const MATERIAL_REVIEW_SCHEMA = 'material-match-review.v1' as const;

export interface MaterialRankedCandidate {
  rank: number;
  assetId: string;
  clipId: string;
  sourceStart: number;
  sourceEnd: number;
  score: number;
  analysisConfidence: number;
  boundaryConfidence: number;
  evidenceBasis: 'visual_analysis' | 'user_product_association';
}

export interface MaterialSceneReview {
  sceneId: string;
  intent: string;
  selectedAssetId: string;
  selectedClipId: string;
  reviewPriority: 'none' | 'normal' | 'high';
  decision: 'trusted_auto_match' | 'human_review_required';
  reasonCodes: Array<'association_only' | 'low_semantic_score' | 'small_score_margin' | 'low_analysis_confidence'
    | 'unsafe_video_boundary' | 'source_marked_for_review'>;
  candidates: MaterialRankedCandidate[];
}

export interface MaterialReviewBundle {
  schemaVersion: typeof MATERIAL_REVIEW_SCHEMA;
  collectionMode: 'passive_artifact_review';
  scenes: MaterialSceneReview[];
  requiresFocusedReview: boolean;
}

type CandidateInput = Omit<MaterialRankedCandidate, 'rank'> & {
  type: 'video' | 'image';
  needsReview: boolean;
  cleanEntry?: boolean;
  cleanExit?: boolean;
};

export function buildMaterialSceneReview(input: {
  sceneId: string;
  intent: string;
  selectedClipId: string;
  candidates: CandidateInput[];
}): MaterialSceneReview {
  const ranked = input.candidates
    .slice()
    .sort((left, right) => right.score - left.score || right.analysisConfidence - left.analysisConfidence)
    .slice(0, 5);
  const selected = ranked.find(candidate => candidate.clipId === input.selectedClipId) ?? ranked[0];
  if (!selected) throw new Error('material_review_selected_candidate_missing');
  const runnerUp = ranked.find(candidate => candidate.clipId !== selected.clipId);
  const margin = runnerUp ? selected.score - runnerUp.score : Number.POSITIVE_INFINITY;
  const reasonCodes: MaterialSceneReview['reasonCodes'] = [];
  if (selected.evidenceBasis === 'user_product_association') reasonCodes.push('association_only');
  if (selected.score < 18 && selected.evidenceBasis === 'visual_analysis') reasonCodes.push('low_semantic_score');
  if (margin < 4) reasonCodes.push('small_score_margin');
  if (selected.analysisConfidence < .7) reasonCodes.push('low_analysis_confidence');
  if (selected.needsReview) reasonCodes.push('source_marked_for_review');
  if (selected.type === 'video' && (selected.boundaryConfidence < .6 || !selected.cleanEntry || !selected.cleanExit)) {
    reasonCodes.push('unsafe_video_boundary');
  }
  const highRisk = reasonCodes.some(reason => ['association_only', 'low_semantic_score', 'source_marked_for_review'].includes(reason));
  return {
    sceneId: input.sceneId,
    intent: input.intent.slice(0, 500),
    selectedAssetId: selected.assetId,
    selectedClipId: selected.clipId,
    reviewPriority: highRisk ? 'high' : reasonCodes.length ? 'normal' : 'none',
    decision: reasonCodes.length ? 'human_review_required' : 'trusted_auto_match',
    reasonCodes,
    candidates: ranked.map((candidate, index) => ({
      rank: index + 1,
      assetId: candidate.assetId,
      clipId: candidate.clipId,
      sourceStart: Number(candidate.sourceStart.toFixed(3)),
      sourceEnd: Number(candidate.sourceEnd.toFixed(3)),
      score: Number(candidate.score.toFixed(4)),
      analysisConfidence: Number(candidate.analysisConfidence.toFixed(4)),
      boundaryConfidence: Number(candidate.boundaryConfidence.toFixed(4)),
      evidenceBasis: candidate.evidenceBasis,
    })),
  };
}

export function materialReviewBundle(scenes: MaterialSceneReview[]): MaterialReviewBundle {
  return {
    schemaVersion: MATERIAL_REVIEW_SCHEMA,
    collectionMode: 'passive_artifact_review',
    scenes: scenes.map(scene => structuredClone(scene)),
    requiresFocusedReview: scenes.some(scene => scene.decision === 'human_review_required'),
  };
}

export function materialDecisionFeedback(input: {
  artifactContent: unknown;
  decision: 'approved' | 'changes_requested';
  note?: string | null;
  decidedAt: string;
}): Record<string, unknown> | null {
  if (!input.artifactContent || typeof input.artifactContent !== 'object' || Array.isArray(input.artifactContent)) return null;
  const bundle = (input.artifactContent as Record<string, unknown>).materialLearning;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
    || (bundle as Record<string, unknown>).schemaVersion !== MATERIAL_REVIEW_SCHEMA) return null;
  const note = String(input.note || '').trim().slice(0, 2_000);
  const materialSpecific = /素材|镜头|画面|裁切|剪辑|动作|不匹配|visual|shot|clip|material/i.test(note);
  const label = input.decision === 'approved' ? 'accepted_weak'
    : materialSpecific ? 'rejected_material_weak' : 'inconclusive';
  return {
    schemaVersion: 'material-decision-feedback.v1',
    source: 'artifact_decision',
    strength: 'weak_label',
    label,
    note,
    decidedAt: new Date(input.decidedAt).toISOString(),
    materialReview: structuredClone(bundle),
  };
}

export interface MaterialGoldQuery {
  queryId: string;
  shouldRefuse?: boolean;
  candidates: Array<{ candidateId: string; predictedScore: number; relevance: 0 | 1 | 2 }>;
}

/** Evaluation only. The labels are not used to train or mutate a model. */
export function evaluateMaterialGoldSet(queries: MaterialGoldQuery[]): {
  queryCount: number;
  recallAt5: number;
  ndcgAt10: number;
  top1AcceptRate: number;
  severeMismatchRate: number;
  refusalAccuracy: number | null;
} {
  if (!queries.length) return { queryCount: 0, recallAt5: 0, ndcgAt10: 0, top1AcceptRate: 0, severeMismatchRate: 0, refusalAccuracy: null };
  let recall = 0;
  let ndcg = 0;
  let accepted = 0;
  let severe = 0;
  let refusalCorrect = 0;
  let refusalCount = 0;
  for (const query of queries) {
    const ranked = query.candidates.slice().sort((left, right) => right.predictedScore - left.predictedScore);
    const relevant = query.candidates.filter(candidate => candidate.relevance > 0).length;
    if (relevant === 0) {
      refusalCount += 1;
      if (query.shouldRefuse && ranked.length === 0) refusalCorrect += 1;
    } else if (ranked.slice(0, 5).some(candidate => candidate.relevance > 0)) recall += 1;
    const dcg = ranked.slice(0, 10).reduce((sum, candidate, index) => sum
      + (Math.pow(2, candidate.relevance) - 1) / Math.log2(index + 2), 0);
    const ideal = query.candidates.slice().sort((left, right) => right.relevance - left.relevance).slice(0, 10)
      .reduce((sum, candidate, index) => sum + (Math.pow(2, candidate.relevance) - 1) / Math.log2(index + 2), 0);
    ndcg += ideal > 0 ? dcg / ideal : 1;
    if ((ranked[0]?.relevance ?? 0) > 0) accepted += 1;
    if (ranked[0]?.relevance === 0) severe += 1;
  }
  const denominator = queries.length;
  return {
    queryCount: denominator,
    recallAt5: Number((recall / Math.max(1, queries.filter(query => query.candidates.some(candidate => candidate.relevance > 0)).length)).toFixed(4)),
    ndcgAt10: Number((ndcg / denominator).toFixed(4)),
    top1AcceptRate: Number((accepted / denominator).toFixed(4)),
    severeMismatchRate: Number((severe / denominator).toFixed(4)),
    refusalAccuracy: refusalCount ? Number((refusalCorrect / refusalCount).toFixed(4)) : null,
  };
}

