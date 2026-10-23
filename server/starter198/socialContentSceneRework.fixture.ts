import type { SocialContentExecutionPlan, SocialDirectorBrief, SocialExecutionPlanReview, SocialProductionResult, SocialReferenceVideoAnalysis } from '../../shared/contracts/socialContentWorkflow.js';
import { buildSocialProductionHandoff } from './socialContentProductionHandoff.js';
const analysisVersion = '3';
const analysis: SocialReferenceVideoAnalysis = {
  analysisId: 'analysis-v3', version: analysisVersion, referenceSourceId: 'captured-video-1', status: 'ready', durationSeconds: 6,
  coverage: { fullDurationSeconds: 6, precisionIntervals: [{ startSeconds: 0, endSeconds: 6, level: 'L3' }], gaps: [], overallConfidence: 0.92, fullTimelineCovered: true },
  shots: [
    { shotId: 'reference-hook', startSeconds: 0, endSeconds: 3, visualDescription: '产品进入画面', spokenText: null, captionText: null, audioDescription: '起音', rhythmDescription: '快速', purpose: 'hook', tags: { sceneTypes: [], subjects: [], subjectRelations: [], cameraLanguage: [], contentFunctions: [], soundTypes: [], onScreenInformation: [], truthRequirements: [], suggestedProductionMethods: [] }, fidelityPoints: ['结果先行'], mustDifferPoints: ['替换产品'] },
    { shotId: 'reference-cta', startSeconds: 3, endSeconds: 6, visualDescription: '行动收束', spokenText: null, captionText: null, audioDescription: '收束', rhythmDescription: '稳定', purpose: 'call_to_action', tags: { sceneTypes: [], subjects: [], subjectRelations: [], cameraLanguage: [], contentFunctions: [], soundTypes: [], onScreenInformation: [], truthRequirements: [], suggestedProductionMethods: [] }, fidelityPoints: ['行动收束'], mustDifferPoints: ['替换文案'] },
  ],
  hookAnalysis: null, rightsNotice: '仅分析结构', createdAt: '2026-09-26T00:00:00.000Z',
};

const scene = (sceneId: string, order: number, referenceShotId: string, purpose: 'hook' | 'call_to_action') => ({
  sceneId, order, referenceShotId, purpose, targetVisual: `${purpose} target`, requiredEvidence: [],
  action: { startState: '静止', path: '进入画面', endState: '稳定' },
  shotLanguage: { shotSize: 'close-up', cameraAngle: 'eye-level', movement: 'static', composition: 'center' },
  spaceAndContinuity: ['产品方向保持一致'],
  audioLayers: { voiceover: null, dialogue: null, captionIntent: null, ambient: null, music: null, soundEffects: null },
  duration: { startSeconds: order === 1 ? 0 : 3, endSeconds: order === 1 ? 3 : 6, targetSeconds: 3 },
  truthBoundary: { subject: 'none' as const, syntheticVisualAllowed: true, customerEvidenceRequired: false, customerEvidenceRefs: [], confirmedFactRefs: [], mustNotImplyCustomerReality: true, prohibitedRepresentations: [] },
  allowedVariation: ['构图微调'], acceptanceCriteria: ['时长正确'], fidelityPoints: [], mustDifferPoints: [],
});

const brief: SocialDirectorBrief = {
  directorBriefId: 'brief-v3', version: '3', status: 'ready', source: { weeklyPackageId: 'weekly-v3', adHocBusinessContextId: null },
  referenceAnalysis: { analysisId: analysis.analysisId, version: analysisVersion, fullDurationSeconds: 6, precisionIntervals: analysis.coverage!.precisionIntervals, gaps: [], overallConfidence: 0.92 },
  topic: '新品演示', audience: '采购商', platforms: ['tiktok'], accountRefs: ['account-playbook:v3'], creativeIntent: '展示差异', narrativeStructure: ['hook', 'cta'], rhythm: '快到稳', primaryHookId: null,
  coreSellingPoints: ['可验证参数'], callToAction: '询盘', totalDurationSeconds: 6, aspectRatio: '9:16', languages: ['zh'], brandRequirements: [], factSourceRefs: ['knowledge:1'], rightsConstraints: ['不使用原视频'],
  referenceEvidence: [{ analysisId: analysis.analysisId, referenceShotId: 'reference-hook', transferable: ['节奏'], mustReplace: ['产品'] }], budgetCny: 10, dueAt: null,
  scenes: [scene('scene-hook', 1, 'reference-hook', 'hook'), scene('scene-cta', 2, 'reference-cta', 'call_to_action')], createdBy: 'director_agent',
};

const executionPlan: SocialContentExecutionPlan = {
  executionPlanId: 'execution-v3', version: '3', directorBriefId: brief.directorBriefId, directorBriefVersion: brief.version,
  status: 'approved', reviewRound: 1, maxReviewRounds: 2, budgetLimitCny: 10, deadlineAt: null, estimatedTotalCostCny: 2, estimatedTotalSeconds: 30,
  scenes: brief.scenes.map(item => ({ sceneId: item.sceneId, feasibility: 'full_fidelity', feasibilityReason: 'ready', candidates: [{ candidateId: `candidate-${item.sceneId}`, kind: 'capability', label: 'motion', sourceRef: null, sourceStrategy: 'motion_graphics', evidenceStrength: 'non_evidentiary', rightsStatus: 'confirmed', enterpriseOwnershipScore: 1, semanticScore: 1, evidenceScore: 1, actionAndShotScore: 1, qualityScore: 1, durationFitScore: 1, repetitionPenalty: 0, estimatedCostCny: 1, estimatedSeconds: 15, estimatedSuccessRate: 1, dataTransfer: 'local_only', providerId: null, modelId: null, clipId: null, timeRange: null, promptRef: null, retryPolicy: { maxAttempts: 2, fallbackStrategies: [] }, provenance: { origin: 'system_capability', inputVersion: '3', authorizationRef: 'system', executionRecordId: null } }], recommendedCandidateIds: [`candidate-${item.sceneId}`], alternativeCandidateGroups: [], selectedSourceStrategy: 'motion_graphics', fallbackSourceStrategy: null, estimatedCostCny: 1, estimatedSeconds: 15, estimatedSuccessRate: 1, rightsRisks: [], dataTransferRisks: [], idempotencyKey: `execute-${item.sceneId}` })),
  createdBy: 'content_agent',
};

const executionPlanReview: SocialExecutionPlanReview = {
  reviewId: 'execution-review-v3', version: '3', executionPlanId: executionPlan.executionPlanId,
  executionPlanVersion: executionPlan.version, directorBriefId: brief.directorBriefId,
  directorBriefVersion: brief.version, approved: true,
  sceneResults: brief.scenes.map(item => ({ sceneId: item.sceneId, approved: true, feasibility: 'full_fidelity', failedCriteria: [], requiredRevision: [], goalImpact: 'none', reasonCodes: [] })),
  failedCriteria: [], requiredRevision: [], goalImpact: 'none', reasonCodes: [], createdBy: 'director_agent',
};

export const productionResult: SocialProductionResult = {
  productionResultId: 'production-v3', version: '3', executionPlanId: executionPlan.executionPlanId,
  executionPlanVersion: executionPlan.version, executionPlanReviewId: executionPlanReview.reviewId,
  artifactId: 'artifact-v3', creativeReviewId: 'creative-review-v3', publishAssignmentId: null,
  status: 'technical_review_passed',
  sceneResults: executionPlan.scenes.map(item => ({ sceneId: item.sceneId, idempotencyKey: item.idempotencyKey, sourceStrategy: item.selectedSourceStrategy, feasibility: item.feasibility, provenanceCandidateIds: item.recommendedCandidateIds })),
  technicalReview: { approved: true, checkedScenes: 2, failures: [] },
  creativeReview: { approved: true, failedCriteria: [], reviewedBy: 'director_agent' },
  artifactResourceRef: 'artifact:production-v3', createdAt: '2026-09-26T02:00:00.000Z',
};

const surfaceHashes = {
  firstThreeSeconds: { baseline: 'hook-a', current: 'hook-b' },
  caption: { baseline: 'caption-a', current: 'caption-b' },
  cover: { baseline: 'cover-a', current: 'cover-b' },
  cta: { baseline: 'cta-a', current: 'cta-b' },
  copy: { baseline: 'copy-a', current: 'copy-b' },
  render: { baseline: 'render-a', current: 'render-b' },
};

export const checks = (gate: 'G4' | 'G5' | 'G6') => ({
  G4: ['format', 'duration', 'audio_visual_sync', 'caption', 'linked_assets', 'render', 'sensitive_data'],
  G5: ['hook', 'evidence_order', 'account_tone', 'cta', 'truth_boundary', 'variant_difference'],
  G6: ['account', 'platform_format', 'conversion_route', 'sales_owner', 'weekly_authorization'],
}[gate].map(code => ({ code, passed: true, message: 'ok' })));


export function sceneReworkHandoff(taskId='content') {return buildSocialProductionHandoff({taskId,version:'3',sourceAnalysis:analysis,directorBrief:brief,executionPlan,executionPlanReview,variantDifference:{variantId:'variant-b',baselineVariantId:'variant-a',changedSceneIds:['scene-hook'],dimensions:['visual'],hypothesis:'新视觉提高停留',unchangedConstraints:['产品事实','CTA'],surfaceHashes},now:new Date('2026-09-26T01:00:00Z')});}

export function sceneReworkThreeSceneFixture(){const b=structuredClone(brief),a=structuredClone(analysis),e=structuredClone(executionPlan),r=structuredClone(executionPlanReview);const middle=structuredClone(b.scenes[1]!);middle.sceneId='scene-transition';middle.order=2;middle.purpose='transition';b.scenes.splice(1,0,middle);b.scenes[2]!.order=3;const middlePlan=structuredClone(e.scenes[1]!);middlePlan.sceneId=middle.sceneId;middlePlan.idempotencyKey='execute-scene-transition';e.scenes.splice(1,0,middlePlan);const middleReview=structuredClone(r.sceneResults[1]!);middleReview.sceneId=middle.sceneId;r.sceneResults.splice(1,0,middleReview);const handoff=buildSocialProductionHandoff({taskId:'content',version:'3',sourceAnalysis:a,directorBrief:b,executionPlan:e,executionPlanReview:r,variantDifference:{variantId:'variant-b',baselineVariantId:'variant-a',changedSceneIds:['scene-hook'],dimensions:['visual'],hypothesis:'新视觉',unchangedConstraints:['事实'],surfaceHashes},now:new Date('2026-09-26T01:00:00Z')});const result=structuredClone(productionResult);const middleResult=structuredClone(result.sceneResults[1]!);middleResult.sceneId=middle.sceneId;middleResult.idempotencyKey=middlePlan.idempotencyKey;result.sceneResults.splice(1,0,middleResult);return{handoff,result};}
