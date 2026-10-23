import type { admitSocialContentProduction } from './socialContentProductionAdmission.js';
import { prepareSocialContentProductionDirector } from './socialContentProductionDirectorPreparation.js';
import type { runSocialContentAutoProduction } from './socialContentProductionExecution.js';
import type { prepareSocialProductionMaterialRouting } from './socialContentProductionMaterialPreparation.js';
import type { prepareSocialProductionScriptBaseline } from './socialContentProductionScriptBaseline.js';
import type { analyzeSocialProductionAssetsWithCheckpoint } from './socialContentProductionCheckpoints.js';
import type { BoundPresenterVoice } from './socialContentBoundPresenterVoice.js';
import type { SocialAssetSupplyExecution } from './socialContentAssetSupplyExecution.js';
import type { SocialProductionAsset } from './socialContentProductionPlan.js';
import type { readSocialTaskDetail } from './socialContentRecords.js';
import type { StarterRecord } from './repository.js';
import { STARTER_COLLECTIONS } from './repository.js';
import { socialProductionReferenceFidelityFailures } from './socialContentProductionCollaboration.js';
import { freezeSocialScriptBaseline } from './socialContentScriptBaseline.js';
import { buildSocialProductionPlan } from './socialContentProductionPlan.js';
import { applySocialReviewRevision, applyZeroAssetTruthSafeNarration, productionAdaptation,
  selectDirectorBgm, systemThemeGraphicAssets, socialReviewRevisionDirective, writeExecutionStage } from './socialContentAutoProduction.js';
import { socialText } from './socialContentValidation.js';

type Execution = Parameters<typeof runSocialContentAutoProduction>[0];
type Detail = NonNullable<Awaited<ReturnType<typeof readSocialTaskDetail>>>;
type Script = Awaited<ReturnType<typeof prepareSocialProductionScriptBaseline>>;
type Material = Awaited<ReturnType<typeof prepareSocialProductionMaterialRouting>>;
type Admission = Awaited<ReturnType<typeof admitSocialContentProduction>>;

/** Ground the safe asset plan, freeze Director handoff and reject unsupported replication. */
export async function prepareSocialContentProductionPlanAndDirector(scope: {
  execution: Execution;
  detail: Detail;
  taskRecord: StarterRecord;
  agentWorkflow: NonNullable<Detail['agentWorkflow']>;
  baseline: Script['baseline'];
  assets: SocialProductionAsset[];
  rawAssets: Material['rawAssets'];
  assetSupplyExecution: SocialAssetSupplyExecution | null;
  productionApproach: Admission['productionApproach'];
  productionMode: Material['productionMode'];
  analysisFailures: Awaited<ReturnType<typeof analyzeSocialProductionAssetsWithCheckpoint>>['failures'];
  replicationContext: Parameters<typeof prepareSocialProductionScriptBaseline>[0]['replicationContext'];
  contentTemplateStructure: Parameters<typeof prepareSocialProductionScriptBaseline>[0]['contentTemplateStructure'];
  verifiedContext: Script['executionVerifiedContext'];
  formula: Script['directorFormula'];
  outputDir: string;
  selectedVoice: BoundPresenterVoice | null;
  revisionParent: Admission['revisionParent'];
  reviewDirective: ReturnType<typeof socialReviewRevisionDirective> | null;
}) {
  const input = scope.execution;
  const { detail, taskRecord, agentWorkflow, rawAssets, assetSupplyExecution,
    productionApproach, productionMode, replicationContext, contentTemplateStructure,
    selectedVoice, revisionParent, reviewDirective, outputDir } = scope;
  const executionVerifiedContext = scope.verifiedContext;
  const directorFormula = scope.formula;
  const analyzed = { failures: scope.analysisFailures };
  let activeBaseline = scope.baseline;
  let assets = scope.assets;
  if (['knowledge_fallback', 'system_theme_baseline'].includes(activeBaseline.source)
    && !activeBaseline.formulaReference
    && !activeBaseline.match?.inspirationReference) {
    const associationIdentities = new Set(assets
      .filter(asset => asset.explicitProductAssociation?.exactTaskProductMatch)
      .map(asset => asset.contentHash || asset.localPath || asset.objectKey || asset.url || asset.id));
    const requiresAssociationOnlySafety = activeBaseline.match?.verifiedKnowledgeSource === 'none';
    const materialCategoryHint = assets.flatMap(asset => asset.visualObservations).map(socialText).filter(Boolean).join(' ');
    // Exact tenant-authored product linkage is also a safe visual fallback
    // when enterprise product facts exist but no vision provider is available.
    // It authorizes using the files in an edit; it never turns filenames,
    // labels or enterprise facts into claims about what the camera saw.
    if (associationIdentities.size >= 1 && requiresAssociationOnlySafety) {
      activeBaseline = freezeSocialScriptBaseline({
        replicationContext,
        contentTemplateStructure,
        brief: detail.brief,
        theme: detail.theme ?? null,
        formula: null,
        inspiration: null,
        verifiedContext: executionVerifiedContext,
        // This is confidence in the exact tenant-authored linkage only. Visual
        // confidence remains 0 on every association-only production clip.
        userProductAssociation: { basis: 'tenant_task_upload', confidence: 0.45 },
        materialCategoryHint,
        lockedAt: new Date().toISOString(),
        previous: activeBaseline,
      });
      await input.repository.update(STARTER_COLLECTIONS.socialContentTasks, input.tenantId, taskRecord.id, {
        script_baseline: activeBaseline,
        formula_reference: '',
        updated_at: activeBaseline.lockedAt,
      });
    }
  }
  let plan = buildSocialProductionPlan({ baseline: activeBaseline, assets, themeId: detail.theme?.themeId ?? null,
    ...(assetSupplyExecution?{routedSceneAssets:assetSupplyExecution.shots.map(shot=>{
      const scene=agentWorkflow.directorBrief.scenes.find(scene=>scene.sceneId===shot.sceneId);
      return {sceneId:shot.sceneId,assetId:shot.assetId,durationSeconds:scene?scene.duration.endSeconds-scene.duration.startSeconds:undefined};
    })}:{}), });
  if(!plan.ok&&assetSupplyExecution)throw new Error(`asset_supply_scene_binding_invalid:${plan.reasonCode}:${plan.message}`);
  if (!plan.ok && productionApproach !== 'material_cut') {
    if (productionMode === 'social_ready' && rawAssets.length === 0 && !assetSupplyExecution) {
      throw new Error('production_input_required:当前没有可用于正式成片的客户画面。请上传至少一段产品视频或三张产品图片；系统不会把说明卡片冒充正式成片。');
    }
    const systemAssets = await systemThemeGraphicAssets({ outputDirectory: outputDir, baseline: activeBaseline });
    assets = [...assets, ...systemAssets];
    plan = buildSocialProductionPlan({ baseline: activeBaseline, assets, themeId: detail.theme?.themeId ?? null });
    if (plan.ok) {
      plan.notes.push(productionMode === 'social_ready'
        ? '客户素材不足，内容 Agent 按已审核的零素材路线使用可追溯系统图形、口播和字幕完成正式制作。'
        : '现有素材覆盖不足，内容 Agent 按编导真实性边界使用平台安全主题图形完成预览版。');
    }
  }
  if (!plan.ok && productionApproach === 'material_cut') {
    throw new Error(`production_input_required:纯素材方案没有找到足够的逐句匹配片段。${plan.message}`);
  }
  plan.unusedAssets.push(...analyzed.failures.map(item => ({
    assetId: item.assetId,
    assetName: item.assetName,
    reason: `素材分析未通过：${item.reason}`,
  })));
  if (!plan.ok) {
    const failureSummary = analyzed.failures.length
      ? ` 未通过分析：${analyzed.failures.map(item => `${item.assetName}（${item.reason}）`).join('；')}`
      : '';
    throw new Error(`production_input_required:系统无法建立安全的零素材画面方案，请稍后自动重试。${failureSummary}`);
  }
  const explanationOnlyRoute = assetSupplyExecution?.shots.length
    && assetSupplyExecution.shots.every(shot => ['motion_graphics', 'verified_fact_card'].includes(shot.sourceStrategy));
  if (productionMode === 'social_ready'
    && detail.brief.creationMode === 'viral_replication'
    && explanationOnlyRoute) {
    throw new Error('production_input_required:当前方案只能生成说明卡片，无法达到爆款裂变的画面预期。请补充客户产品视频/图片，或明确改为“概念样片”后再生成。');
  }
  if (explanationOnlyRoute) plan = applyZeroAssetTruthSafeNarration(plan);
  if (reviewDirective) plan = applySocialReviewRevision(plan, reviewDirective);
  const adaptation = productionAdaptation(plan, assets.length);
  const preparedDirector = await prepareSocialContentProductionDirector({
    repository: input.repository, tenantId: input.tenantId, taskId: input.taskId,
    detail, taskRecord, baseline: activeBaseline, plan, assets, agentWorkflow,
    formula: directorFormula, contentTemplateStructure, verifiedContext: executionVerifiedContext,
    selectedVoice, reviewMusicMood: reviewDirective?.musicMood ?? undefined,
    selectBgm: input.runtime?.selectDirectorBgm ?? selectDirectorBgm,
  });
  let { directorPlan, persistedDirectorPlan, directorSummary, contentHandoff } = preparedDirector;
  const directorCheckpointInputHash = preparedDirector.checkpointInputHash;
  await writeExecutionStage({
    ...input,
    stage: 'content_production',
    message: '编导方案已锁定并交给内容 Agent，正在生成配音、配乐并制作视频。',
    extra: {
      directorPlanVersion: directorPlan.version,
      directorPlanHash: directorPlan.lineageHash,
      directorPlanSummary: directorSummary,
      adaptationNotes: adaptation.notes,
      narrationChanged: adaptation.narrationChanged,
      selectedAssetCount: plan.selectedAssetIds.length,
      unusedAssetCount: plan.unusedAssets.length,
      sourceClipSeconds: plan.sourceClipSeconds,
	  directorCheckpointReused: preparedDirector.checkpointReused,
	  ...(assetSupplyExecution ? { assetSupplyExecution } : {}),
      ...(revisionParent && reviewDirective ? {
        reviewRevision: {
          parentArtifactId: revisionParent.artifactId,
          feedbackHash: reviewDirective.feedbackHash,
          categories: reviewDirective.categories,
        },
      } : {}),
    },
  });
    const referenceFidelityFailures = socialProductionReferenceFidelityFailures(agentWorkflow, contentHandoff, {
      referenceAnalysis: detail.referenceVideoAnalysis,
    });
    if (referenceFidelityFailures.length) throw new Error(`director_revision_required:${referenceFidelityFailures.join(';')}`);

  return { baseline: activeBaseline, assets, plan, adaptation, preparedDirector };
}
