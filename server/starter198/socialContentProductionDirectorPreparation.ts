import { contentTemplateOutputMatches } from '../../shared/socialContentTemplateStructure.js';
import { readCurrentContentExecutionCheckpoint, recordCurrentContentExecutionCheckpoint } from '../contentExecution/context.js';
import type { BoundPresenterVoice } from './socialContentBoundPresenterVoice.js';
import { buildSocialDirectorPlan, parseStoredSocialDirectorPlan, publicSocialDirectorPlanSummary,
  socialDirectorContentHandoff, socialDirectorHandoffWithBoundVoice } from './socialContentDirectorPlan.js';
import { latestSocialDirectorPlanVersion, persistSocialDirectorPlanVersion } from './socialContentDirectorPlanVersions.js';
import type { SocialProductionAsset, SocialProductionPlan } from './socialContentProductionPlan.js';
import type { selectDirectorBgm } from './socialContentProductionRuntimeSupport.js';
import type { readSocialTaskDetail } from './socialContentRecords.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import { SocialContentWorkflowError, socialRequestHash, socialText } from './socialContentValidation.js';

type Detail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;

/** Restore the exact Director checkpoint before considering a new soundtrack or plan. */
export async function prepareSocialContentProductionDirector(input: {
  repository: Starter198Repository;
  tenantId: string;
  taskId: string;
  detail: Detail;
  taskRecord: StarterRecord;
  baseline: Parameters<typeof buildSocialDirectorPlan>[0]['baseline'];
  plan: SocialProductionPlan;
  assets: SocialProductionAsset[];
  agentWorkflow: NonNullable<Detail['agentWorkflow']>;
  formula: Parameters<typeof buildSocialDirectorPlan>[0]['formula'];
  contentTemplateStructure?: Parameters<typeof contentTemplateOutputMatches>[0];
  verifiedContext: Parameters<typeof persistSocialDirectorPlanVersion>[0]['verifiedContext'];
  selectedVoice: BoundPresenterVoice | null;
  reviewMusicMood?: string;
  selectBgm: typeof selectDirectorBgm;
}) {
  const { repository, tenantId, taskId, detail, taskRecord, baseline, plan, assets,
    agentWorkflow, formula, contentTemplateStructure, verifiedContext, selectedVoice } = input;
  const checkpointInputHash = socialRequestHash({
    taskId,
    taskVersion: detail.version,
    baselineVersion: baseline.version,
    baselineLockedAt: baseline.lockedAt,
    enterpriseFactVersion: baseline.enterpriseFactVersion ?? null,
    executionPlanId: agentWorkflow.executionPlan.executionPlanId,
    executionPlanVersion: agentWorkflow.executionPlan.version,
    productionPlan: plan,
    assets: assets.map(asset => ({ id: asset.id, sourceId: asset.sourceId,
      contentHash: asset.contentHash ?? null, providerTaskId: asset.providerTaskId ?? null })),
    sourceVersions: Object.fromEntries(detail.sources.map(source => [source.sourceId, source.sourceVersion ?? ''])),
  });
  const checkpoint = readCurrentContentExecutionCheckpoint<{ directorPlan: unknown }>({
    stage: 'social.director_storyboard', version: '1', inputHash: checkpointInputHash,
  });
  const checkpointDirectorPlan = parseStoredSocialDirectorPlan(checkpoint?.directorPlan);
  const taskDirectorPlan = parseStoredSocialDirectorPlan(taskRecord.director_plan);
  const recovered = taskDirectorPlan || checkpointDirectorPlan ? null : await latestSocialDirectorPlanVersion({
    repository, tenantId, taskId,
  });
  const previous = taskDirectorPlan ?? checkpointDirectorPlan ?? recovered?.plan ?? null;
  if (previous) {
    // Older tasks may predate the immutable version collection. The existing
    // version writer preserves their original evidence rather than relabeling it.
    await persistSocialDirectorPlanVersion({ repository, tenantId, taskId, plan: previous });
  }
  const defaultMood = detail.theme?.themeId === 'supplier_capability' ? '稳重、可信、商务'
    : detail.theme?.themeId === 'customer_case' ? '温暖、克制、可信' : '清晰、轻快、专业';
  let directorPlan = checkpointDirectorPlan;
  if (!directorPlan) {
    const bgmSelection = await input.selectBgm({
      tenantId, themeId: detail.theme?.themeId ?? null,
      directorMood: input.reviewMusicMood || socialText(formula?.direction?.music?.mood) || defaultMood,
      volume: Number(formula?.direction?.music?.volume ?? 18),
    });
    directorPlan = buildSocialDirectorPlan({
      taskId, baseline, productionPlan: plan, productionAssets: assets,
      sourceVersions: Object.fromEntries(detail.sources.map(source => [source.sourceId, source.sourceVersion ?? ''])),
      outputSpec: { aspectRatio: detail.brief.aspectRatio, resolution: '720p',
        platform: detail.brief.platforms[0] ?? 'douyin' },
      bgmSelection, formula, createdAt: new Date().toISOString(), previous,
      collaboration: {
        schemaVersion: 'social-agent-collaboration.v1',
        directorBrief: { id: agentWorkflow.directorBrief.directorBriefId, version: agentWorkflow.directorBrief.version },
        contentExecutionPlan: { id: agentWorkflow.executionPlan.executionPlanId,
          version: agentWorkflow.executionPlan.version, selectedBy: 'content_agent' },
        directorReview: { id: agentWorkflow.executionPlanReview.reviewId,
          version: agentWorkflow.executionPlanReview.version, approvedBy: 'director_agent' },
      },
    });
  }
  if (contentTemplateStructure && !contentTemplateOutputMatches(contentTemplateStructure, baseline, directorPlan)) {
    throw new SocialContentWorkflowError('content_template_output_mismatch', 409);
  }
  const persistedDirectorPlan = await persistSocialDirectorPlanVersion({
    repository, tenantId, taskId, plan: directorPlan, baseline, verifiedContext,
  });
  const directorSummary = publicSocialDirectorPlanSummary(directorPlan)!;
  await repository.update(STARTER_COLLECTIONS.socialContentTasks, tenantId, taskRecord.id, {
    director_plan: directorPlan, updated_at: directorPlan.createdAt,
  });
  let contentHandoff = socialDirectorContentHandoff(directorPlan);
  if (selectedVoice) contentHandoff = socialDirectorHandoffWithBoundVoice(contentHandoff, selectedVoice.logicalVoice);
  await recordCurrentContentExecutionCheckpoint({
    stage: 'social.director_storyboard', version: '1', inputHash: checkpointInputHash,
    payload: { directorPlan, directorPlanReference: persistedDirectorPlan.reference,
      narration: contentHandoff.narration,
      scenes: contentHandoff.scenes.map(scene => ({ sceneId: scene.sceneId,
        source: structuredClone(scene.source), voiceover: scene.voiceover, caption: scene.caption })) },
  });
  return { directorPlan, persistedDirectorPlan, directorSummary, contentHandoff,
    checkpointInputHash, checkpointReused: Boolean(checkpointDirectorPlan) };
}
