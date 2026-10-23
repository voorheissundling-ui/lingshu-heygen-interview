import {
  applyStoryboardReplicationAutomation,
  buildStoryboardQaReport,
  storyboardQaObservationContractIssues,
  storyboardQaRequiredChecks,
  type StoryboardQaObservation,
  type StoryboardQaReport,
  type StoryboardQaScene,
} from './storyboardAigcQuality.js';

export type StoryboardFirstFrameQualityEvaluation = {
  firstFrameQualityState: 'evaluated';
  firstFrameQuality: StoryboardQaReport;
  canProceedToVideo: boolean;
  retryable: false;
  contractIssues: [];
} | {
  firstFrameQualityState: 'service_unavailable' | 'invalid_response';
  firstFrameQuality: null;
  canProceedToVideo: false;
  retryable: true;
  code: 'FIRST_FRAME_QA_SERVICE_UNAVAILABLE' | 'FIRST_FRAME_QA_RESPONSE_INVALID';
  error: string;
  contractIssues: string[];
};

/** Evaluate an already generated image without regenerating, persisting or billing.
 * Service/contract failures deliberately have NO visual report: absence of a model
 * result is not evidence that the generated product or image is defective.
 * Callers keep the image, mark it unconfirmed, and retry QA on that same image. */
export async function evaluateStoryboardFirstFrameQuality(input: {
  sceneType: StoryboardQaScene;
  hasProduct: boolean;
  hasNamedPerson: boolean;
  hasEnvironmentReference?: boolean;
  hasContact: boolean;
  hasAction: boolean;
  candidateLabels: string[];
  referenceLabels?: string[];
  applyReplicationAutomation: boolean;
  inspectVisual: () => Promise<unknown>;
  inspectTechnical: () => Promise<StoryboardQaObservation[]>;
  checkedAt?: string;
}): Promise<StoryboardFirstFrameQualityEvaluation> {
  const invalid = (contractIssues: string[]): StoryboardFirstFrameQualityEvaluation => ({
    firstFrameQualityState: 'invalid_response', firstFrameQuality: null,
    canProceedToVideo: false, retryable: true, code: 'FIRST_FRAME_QA_RESPONSE_INVALID',
    error: '首帧质检返回的数据不完整或证据标签无效，已保留生成图片；请复检原图，无需重新生成。', contractIssues,
  });
  const candidateLabels = input.candidateLabels.filter(label => typeof label === 'string' && label.trim());
  if (!candidateLabels.length || candidateLabels.length !== input.candidateLabels.length
    || new Set(candidateLabels).size !== candidateLabels.length) return invalid(['candidate_labels:missing_or_invalid']);
  const referenceLabels = input.referenceLabels || [];
  if (referenceLabels.some(label => candidateLabels.includes(label))) return invalid(['candidate_labels:ambiguous_reference_role']);
  const shape = { phase: 'first_frame' as const, sceneType: input.sceneType,
    hasProduct: input.hasProduct, hasNamedPerson: input.hasNamedPerson,
    hasEnvironmentReference: input.hasEnvironmentReference, hasContact: input.hasContact, hasAction: input.hasAction };
  let observations: unknown;
  let technical: StoryboardQaObservation[];
  try {
    technical = await input.inspectTechnical();
    observations = await input.inspectVisual();
  } catch {
    // Do not expose raw provider errors, which may contain URLs or credentials.
    return { firstFrameQualityState: 'service_unavailable', firstFrameQuality: null,
      canProceedToVideo: false, retryable: true, code: 'FIRST_FRAME_QA_SERVICE_UNAVAILABLE',
      error: '首帧质检服务暂不可用，已保留生成图片；服务恢复后复检原图，无需重新生成。', contractIssues: [] };
  }
  const raw = Array.isArray(observations) ? observations : [];
  const requiredKeys = storyboardQaRequiredChecks(shape);
  const contractIssues = storyboardQaObservationContractIssues({ observations: raw, requiredKeys,
    candidateLabels, allowedCitationLabels: [...referenceLabels, ...candidateLabels], technicalKeys: technical.map(item => item.key) });
  // Duplicate required judgments can be contradictory; never accept whichever appeared first.
  for (const key of requiredKeys) {
    if (!technical.some(item => item.key === key) && raw.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).key === key).length > 1) {
      contractIssues.push(`${key}:duplicate_observation`);
    }
  }
  if (contractIssues.length) return invalid(contractIssues);
  let report = buildStoryboardQaReport({ ...shape,
    observations: [...raw.filter(item => !technical.some(check => check.key === (item as Record<string, unknown> | null)?.key)), ...technical],
    evidenceFrameLabels: candidateLabels, checkedAt: input.checkedAt });
  // An authenticated person still uses its normal review boundary. Callers cannot
  // accidentally apply the non-person replication admission policy to that case.
  if (input.applyReplicationAutomation && !input.hasNamedPerson) report = applyStoryboardReplicationAutomation(report);
  return { firstFrameQualityState: 'evaluated', firstFrameQuality: report,
    canProceedToVideo: report.passed, retryable: false, contractIssues: [] };
}
